/*
 * services/permission/service.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

use super::structs::DecoratedPermission;
use crate::error::prelude::{ExnError, Result, ResultExt};
use crate::error::{Error, ErrorType};
use crate::models::prelude::{Role, RolePermission};
use crate::models::{role, role_permission};
use crate::services::ServiceContext;
use crate::services::audit::{AuditEvent, AuditService};
use crate::services::permission::resolvers::resolve_category_slug;
use crate::services::permission::{
    CheckPermissionContext, PermissionCache, PermissionTarget, SetUserPermissionInput,
    resolve_category_reference,
};
use crate::services::relation::{GetSiteBan, RelationService};
use crate::services::role::{
    GetRolePermissionsInput, GetUserRolesInput, RoleService, UpdateRolePermissionsInput,
};
use crate::types::{Action, Permission, Reference, Resource};
use futures::future::try_join_all;
use sea_orm::{ColumnTrait, Condition, EntityTrait, QueryFilter, QueryOrder, Set};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug)]
pub struct PermissionService;

impl PermissionService {
    pub async fn check_user_can_view_page(
        ctx: &ServiceContext<'_>,
        user_id: Option<i64>,
        page: &crate::models::page::Model,
    ) -> Result<bool> {
        let (resource_type, resource_category, action) =
            if page.slug.eq_ignore_ascii_case("_admin") {
                (Resource::Site, None, Action::Edit)
            } else {
                (
                    Resource::Page,
                    Some(Reference::Id(page.page_category_id)),
                    Action::View,
                )
            };

        Self::check_user_can(
            ctx,
            &CheckPermissionContext {
                user_id,
                site_id: page.site_id,
                page_reference: (!page.slug.eq_ignore_ascii_case("_admin"))
                    .then_some(Reference::Id(page.page_id)),
            },
            Permission {
                resource_type,
                resource_category,
                action,
            },
        )
        .await
    }

    pub async fn check_user_can_access_admin(
        ctx: &ServiceContext<'_>,
        user_id: Option<i64>,
        site_id: i64,
    ) -> Result<bool> {
        Self::check_user_can(
            ctx,
            &CheckPermissionContext {
                user_id,
                site_id,
                page_reference: None,
            },
            Permission {
                resource_type: Resource::Site,
                resource_category: None,
                action: Action::Edit,
            },
        )
        .await
    }

    pub async fn update_permissions_for_role(
        ctx: &ServiceContext<'_>,
        UpdateRolePermissionsInput {
            site_id,
            role_reference: reference,
            new_permissions,
            cascade_removals,
            updating_user_id,
            ip_address,
        }: UpdateRolePermissionsInput<'_>,
    ) -> Result<()> {
        let txn = ctx.transaction();

        let role = RoleService::get(ctx, site_id, reference)
            .await
            .or_raise(|| Error::new("failed to get role", ErrorType::RoleNotFound))?;

        let make_error = || {
            Error::new(
                format!("failed to update permissions for role ID {}", role.role_id),
                ErrorType::Role,
            )
        };

        let resolved_permissions: HashSet<Permission<'static>> =
            try_join_all(new_permissions.into_iter().map(|input| async move {
                let resource_category_id = match input.resource_category {
                    Some(cat_ref) => {
                        resolve_category_reference(
                            ctx,
                            site_id,
                            input.resource_type,
                            &cat_ref,
                        )
                        .await?
                    }
                    None => None,
                };
                Ok::<_, ExnError>(Permission {
                    resource_type: input.resource_type,
                    resource_category: resource_category_id.map(Reference::Id),
                    action: input.action,
                })
            }))
            .await
            .or_raise(make_error)?
            .into_iter()
            .collect();

        if let Some(parent_id) = role.parent_role_id {
            let parent_perms = Self::permissions_as_set(ctx, parent_id)
                .await
                .or_raise(make_error)?;
            if !resolved_permissions.is_subset(&parent_perms) {
                bail!(Error::new(
                    format!(
                        "role ID {} has permissions not present in parent role ID {}",
                        role.role_id, parent_id,
                    ),
                    ErrorType::RoleHierarchyViolation {
                        role_id: role.role_id,
                        parent_role_id: parent_id,
                    },
                ));
            }
        }

        let children = Role::find()
            .filter(
                Condition::all()
                    .add(role::Column::ParentRoleId.eq(role.role_id))
                    .add(role::Column::SiteId.eq(site_id))
                    .add(role::Column::DeletedAt.is_null()),
            )
            .all(txn)
            .await
            .or_raise(make_error)?;

        for child in &children {
            let child_perms = Self::permissions_as_set(ctx, child.role_id)
                .await
                .or_raise(make_error)?;

            if !child_perms.is_subset(&resolved_permissions) {
                if !cascade_removals {
                    bail!(Error::new(
                        format!(
                            "role ID {} has permissions not present in parent role ID {}",
                            child.role_id, role.role_id,
                        ),
                        ErrorType::RoleHierarchyViolation {
                            role_id: child.role_id,
                            parent_role_id: role.role_id,
                        },
                    ));
                } else {
                    info!(
                        "Cascading permission removals to child role ID {} to maintain hierarchy consistency",
                        child.role_id,
                    );
                    Self::cascade_permission_removals(
                        ctx,
                        site_id,
                        child.role_id,
                        &child_perms
                            .difference(&resolved_permissions)
                            .cloned()
                            .collect(),
                    )
                    .await
                    .or_raise(make_error)?;
                }
            }
        }

        let deleted_permissions = RolePermission::delete_many()
            .filter(role_permission::Column::RoleId.eq(role.role_id))
            .exec_with_returning(txn)
            .await
            .or_raise(make_error)?;

        if !resolved_permissions.is_empty() {
            let models: Vec<role_permission::ActiveModel> = resolved_permissions
                .iter()
                .map(|perm| {
                    let resource_category_id =
                        perm.resource_category.as_ref().and_then(|r| match r {
                            Reference::Id(id) => Some(*id),
                            _ => None,
                        });
                    role_permission::ActiveModel {
                        role_id: Set(role.role_id),
                        site_id: Set(site_id),
                        resource_type: Set(perm.resource_type),
                        resource_category_id: Set(resource_category_id),
                        action: Set(perm.action),
                        ..Default::default()
                    }
                })
                .collect();

            RolePermission::insert_many(models)
                .exec(txn)
                .await
                .or_raise(make_error)?;
        }

        AuditService::log(
            ctx,
            ip_address,
            AuditEvent::UpdatePermissions {
                role_id: role.role_id,
                updating_user_id,
                old_permissions: deleted_permissions
                    .into_iter()
                    .map(|p| Permission {
                        resource_type: p.resource_type,
                        resource_category: p.resource_category_id.map(Reference::Id),
                        action: p.action,
                    })
                    .collect(),
                new_permissions: resolved_permissions.into_iter().collect(),
            },
        )
        .await
        .or_raise(make_error)?;
        PermissionCache::defer_invalidate_site(ctx, site_id).or_raise(make_error)?;

        Ok(())
    }

    pub async fn get_permissions_for_role(
        ctx: &ServiceContext<'_>,
        GetRolePermissionsInput {
            site_id,
            role_reference,
            human_readable_categories,
        }: GetRolePermissionsInput<'_>,
    ) -> Result<Vec<Permission<'static>>> {
        let role_id = RoleService::get(ctx, site_id, role_reference)
            .await
            .or_raise(|| {
                Error::new("failed to get role for permissions", ErrorType::Role)
            })?
            .role_id;
        let make_error = || {
            Error::new(
                format!("failed to get permissions for role ID {}", role_id),
                ErrorType::Permission,
            )
        };
        let mut permissions = Self::fetch_permissions(ctx, role_id)
            .await
            .or_raise(make_error)?;

        if human_readable_categories {
            for perm in &mut permissions {
                if let Some(category_ref) = &perm.resource_category {
                    perm.resource_category = resolve_category_slug(
                        ctx,
                        site_id,
                        perm.resource_type,
                        category_ref,
                    )
                    .await
                    .or_raise(make_error)?
                    .map(Reference::Slug);
                }
            }
        }
        Ok(permissions)
    }

    pub async fn get_decorated_permissions_for_role(
        ctx: &ServiceContext<'_>,
        GetRolePermissionsInput {
            site_id,
            role_reference,
            human_readable_categories,
        }: GetRolePermissionsInput<'_>,
    ) -> Result<Vec<DecoratedPermission<'static>>> {
        let txn = ctx.transaction();

        let role = RoleService::get(ctx, site_id, role_reference)
            .await
            .or_raise(|| {
                Error::new(
                    "Failed to get role for decorated permissions",
                    ErrorType::Role,
                )
            })?;

        let make_error = || {
            Error::new(
                format!(
                    "failed to get decorated permissions for role ID {}",
                    role.role_id
                ),
                ErrorType::Permission,
            )
        };

        let role_permissions = Self::permissions_as_set(ctx, role.role_id)
            .await
            .or_raise(make_error)?;

        let parent_permissions = match role.parent_role_id {
            Some(parent_id) => Some(
                Self::permissions_as_set(ctx, parent_id)
                    .await
                    .or_raise(make_error)?,
            ),
            None => None,
        };

        let children_roles = Role::find()
            .filter(
                Condition::all()
                    .add(role::Column::ParentRoleId.eq(role.role_id))
                    .add(role::Column::SiteId.eq(site_id))
                    .add(role::Column::DeletedAt.is_null()),
            )
            .all(txn)
            .await
            .or_raise(make_error)?;

        let mut children_permissions = HashSet::new();
        for child in &children_roles {
            let child_perms = Self::permissions_as_set(ctx, child.role_id)
                .await
                .or_raise(make_error)?;
            children_permissions.extend(child_perms);
        }

        let active_permissions = match parent_permissions.as_ref() {
            Some(parent_perms) => parent_perms.iter().cloned(),
            None => role_permissions.iter().cloned(),
        };

        let universe: HashSet<Permission<'static>> = Permission::ALL
            .iter()
            .cloned()
            .chain(active_permissions)
            .collect();

        let mut decorated = Vec::with_capacity(universe.len());

        for mut perm in universe {
            let active = role_permissions.contains(&perm);

            let addable = !active
                && parent_permissions
                    .as_ref()
                    .is_none_or(|parent| parent.contains(&perm));

            let removable = active && !children_permissions.contains(&perm);

            if human_readable_categories
                && let Some(category_ref) = &perm.resource_category
            {
                perm.resource_category =
                    resolve_category_slug(ctx, site_id, perm.resource_type, category_ref)
                        .await
                        .or_raise(make_error)?
                        .map(Reference::Slug);
            }

            decorated.push(DecoratedPermission {
                permission: perm,
                active,
                addable,
                removable,
            });
        }

        Ok(decorated)
    }

    pub async fn check_user_can<'a>(
        ctx: &ServiceContext<'_>,
        perm_ctx: &CheckPermissionContext<'_>,
        input: Permission<'a>,
    ) -> Result<bool> {
        let [result] = Self::batch_check_user_can(ctx, perm_ctx, [input]).await?;
        Ok(result)
    }

    pub async fn can_user(
        ctx: &ServiceContext<'_>,
        site_id: Option<i64>,
        action: Action,
        target: PermissionTarget,
    ) -> Result<bool> {
        Self::can_user_as(ctx, ctx.request().user_id, site_id, action, target).await
    }

    pub async fn can_user_as(
        ctx: &ServiceContext<'_>,
        user_id: Option<i64>,
        site_id: Option<i64>,
        action: Action,
        target: PermissionTarget,
    ) -> Result<bool> {
        let Some(site_id) = site_id else {
            return Ok(false);
        };

        let (permission, page_reference) = match target {
            PermissionTarget::Site => (
                Permission {
                    resource_type: Resource::Site,
                    resource_category: None,
                    action,
                },
                None,
            ),
            PermissionTarget::Page {
                page_id,
                category_id,
            } => (
                Permission {
                    resource_type: Resource::Page,
                    resource_category: Some(Reference::Id(category_id)),
                    action,
                },
                Some(Reference::Id(page_id)),
            ),
            PermissionTarget::Lock => (
                Permission {
                    resource_type: Resource::PageLock,
                    resource_category: None,
                    action,
                },
                None,
            ),
        };

        Self::check_user_can(
            ctx,
            &CheckPermissionContext {
                user_id,
                site_id,
                page_reference,
            },
            permission,
        )
        .await
    }

    pub async fn batch_check_user_can<'a, const N: usize>(
        ctx: &ServiceContext<'_>,
        perm_ctx: &CheckPermissionContext<'_>,
        permissions: [Permission<'a>; N],
    ) -> Result<[bool; N]> {
        let user_id = perm_ctx.user_id;
        let site_id = perm_ctx.site_id;
        let page_reference = perm_ctx.page_reference.clone();
        let page_scoped_roles = page_reference.is_some();

        let make_error =
            || Error::new("failed to check permissions", ErrorType::Permission);

        let user_permissions =
            Self::get_permissions_for_user(ctx, user_id, site_id, page_reference)
                .await
                .or_raise(make_error)?;

        if user_permissions.is_empty() {
            return Ok([false; N]);
        }

        let mut results = [false; N];

        for (i, permission) in permissions.into_iter().enumerate() {
            results[i] = Self::permission_in_set_helper(
                ctx,
                user_id,
                &user_permissions,
                site_id,
                page_scoped_roles,
                permission,
            )
            .await
            .or_raise(make_error)?;
        }

        Ok(results)
    }

    pub(crate) async fn permission_in_set_helper(
        ctx: &ServiceContext<'_>,
        user_id: Option<i64>,
        user_permissions: &HashSet<Permission<'static>>,
        site_id: i64,
        page_scoped_roles: bool,
        Permission {
            resource_type: resource,
            resource_category,
            action,
        }: Permission<'_>,
    ) -> Result<bool> {
        let make_error =
            || Error::new("failed to check permission", ErrorType::Permission);

        info!(
            "Checking permission for user ID {:?} on site ID {} for resource {} of category {:?} with action {}",
            user_id, site_id, resource, resource_category, action,
        );

        let cacheable = PermissionCache::is_cacheable(resource, action)
            && !page_scoped_roles
            && !Self::active_site_ban_suppresses_cache(ctx, site_id, user_id)
                .await
                .or_raise(make_error)?;

        let resource_category_id = match &resource_category {
            Some(reference) => {
                resolve_category_reference(ctx, site_id, resource, reference).await?
            }
            None => None,
        };

        let cache_fence = if cacheable {
            Some(
                PermissionCache::cache_fence(ctx, site_id, user_id)
                    .await
                    .or_raise(make_error)?,
            )
        } else {
            None
        };

        if let Some(cache_fence) = &cache_fence {
            let has_permission = PermissionCache::check_user_permission(
                ctx,
                Some(site_id),
                user_id,
                resource,
                resource_category_id,
                action,
                cache_fence,
            )
            .await
            .or_raise(make_error)?;

            if let Some(has_permission) = has_permission {
                info!(
                    "Cache hit for user ID {:?} on site ID {} for resource {} of category {:?} with action {}",
                    user_id, site_id, resource, resource_category, action,
                );
                return Ok(has_permission);
            } else {
                info!(
                    "Cache miss for user ID {:?} on site ID {} for resource {} of category {:?} with action {}",
                    user_id, site_id, resource, resource_category, action,
                );
            }
        }

        let has_scoped_permissions = match resource_category_id {
            Some(category_id) => {
                Self::check_category_scoped(ctx, site_id, resource, category_id, action)
                    .await
                    .or_raise(make_error)?
            }
            None => false,
        };

        let has_permission = Self::evaluate_in_permission_set(
            user_permissions,
            resource,
            resource_category_id,
            action,
            has_scoped_permissions,
        );

        if let Some(cache_fence) = cache_fence {
            PermissionCache::set_user_permission_if_fence_current(
                ctx,
                SetUserPermissionInput {
                    site_id: Some(site_id),
                    user_id,
                    resource_type: resource,
                    resource_category_id,
                    action,
                    has_permission,
                },
                &cache_fence,
            )
            .await
            .or_raise(make_error)?;
        }

        Ok(has_permission)
    }

    fn evaluate_in_permission_set(
        user_permissions: &HashSet<Permission<'static>>,
        resource: Resource,
        resource_category_id: Option<i64>,
        action: Action,
        has_scoped_permissions: bool,
    ) -> bool {
        if has_scoped_permissions {
            user_permissions.contains(&Permission {
                resource_type: resource,
                resource_category: resource_category_id.map(Reference::Id),
                action,
            })
        } else {
            user_permissions.contains(&Permission {
                resource_type: resource,
                resource_category: None,
                action,
            })
        }
    }

    /// Whether a viewer may view each listed page, given that the viewer holds
    /// no page attribution on any of them.
    ///
    /// This is the batched form of `check_user_can` for a page reference. It is
    /// valid only when no listed page can gain a page-scoped virtual role: a page
    /// reference can add `PageAuthor`, and such a decision must never be reused
    /// for a different page. `PageAuthor` requires a live page attribution, so
    /// callers must exclude attributed pages, and `check_user_can` stays the
    /// fallback for those.
    ///
    /// Everything else the reference influences — the site ban probe, the
    /// explicit site roles, the virtual roles and the membership check — depends
    /// only on `(user_id, site_id)` and is therefore derived once for the whole
    /// batch. The category probe depends only on the resource category, so it is
    /// resolved once per distinct category rather than once per page. As with a
    /// page-scoped single check the permission cache is not consulted, so a batch
    /// cannot publish an entry that a page-scoped check would later read back.
    ///
    /// Results are returned in the same order as `page_category_ids`.
    pub async fn batch_check_page_view_without_page_roles(
        ctx: &ServiceContext<'_>,
        user_id: Option<i64>,
        site_id: i64,
        page_category_ids: &[Option<i64>],
        category_scoped_cache: &mut BTreeMap<(i64, Option<i64>), bool>,
    ) -> Result<Vec<bool>> {
        let make_error =
            || Error::new("failed to check permissions", ErrorType::Permission);

        if page_category_ids.is_empty() {
            return Ok(Vec::new());
        }

        let user_permissions =
            Self::get_permissions_for_user(ctx, user_id, site_id, None)
                .await
                .or_raise(make_error)?;

        if user_permissions.is_empty() {
            return Ok(vec![false; page_category_ids.len()]);
        }

        let mut results = Vec::with_capacity(page_category_ids.len());
        for category_id in page_category_ids {
            let category_id = *category_id;
            let has_scoped_permissions = match category_id {
                Some(id) => {
                    let key = (site_id, Some(id));
                    if let Some(cached) = category_scoped_cache.get(&key) {
                        *cached
                    } else {
                        let scoped = Self::check_category_scoped(
                            ctx,
                            site_id,
                            Resource::Page,
                            id,
                            Action::View,
                        )
                        .await
                        .or_raise(make_error)?;
                        category_scoped_cache.insert(key, scoped);
                        scoped
                    }
                }
                None => false,
            };

            results.push(Self::evaluate_in_permission_set(
                &user_permissions,
                Resource::Page,
                category_id,
                Action::View,
                has_scoped_permissions,
            ));
        }

        Ok(results)
    }

    async fn active_site_ban_suppresses_cache(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        user_id: Option<i64>,
    ) -> Result<bool> {
        if let Some(user_id) = user_id {
            RelationService::active_site_ban_exists(ctx, GetSiteBan { site_id, user_id })
                .await
        } else {
            Ok(false)
        }
    }

    async fn fetch_permissions(
        ctx: &ServiceContext<'_>,
        role_id: i64,
    ) -> Result<Vec<Permission<'static>>> {
        let txn = ctx.transaction();
        let make_error = || {
            Error::new(
                format!("failed to get permissions for role ID {}", role_id),
                ErrorType::Role,
            )
        };
        Ok(RolePermission::find()
            .filter(role_permission::Column::RoleId.eq(role_id))
            .order_by_asc(role_permission::Column::ResourceType)
            .order_by_asc(role_permission::Column::ResourceCategoryId)
            .order_by_asc(role_permission::Column::Action)
            .all(txn)
            .await
            .or_raise(make_error)?
            .into_iter()
            .map(|p| Permission {
                resource_type: p.resource_type,
                resource_category: p.resource_category_id.map(Reference::Id),
                action: p.action,
            })
            .collect())
    }

    pub async fn permissions_as_set(
        ctx: &ServiceContext<'_>,
        role_id: i64,
    ) -> Result<HashSet<Permission<'static>>> {
        Ok(Self::fetch_permissions(ctx, role_id)
            .await?
            .into_iter()
            .collect())
    }

    pub async fn get_permissions_for_user(
        ctx: &ServiceContext<'_>,
        user_id: Option<i64>,
        site_id: i64,
        page_reference: Option<Reference<'_>>,
    ) -> Result<HashSet<Permission<'static>>> {
        let txn = ctx.transaction();
        let make_error = || {
            Error::new(
                format!(
                    "failed to get permissions for user {:?} in site {:?}",
                    user_id, site_id
                ),
                ErrorType::Permission,
            )
        };

        let role_ids: Vec<i64> = RoleService::get_all_roles_for_user_and_site(
            ctx,
            GetUserRolesInput {
                user_id,
                site_id,
                page_reference,
            },
        )
        .await
        .or_raise(make_error)?
        .into_iter()
        .map(|r| r.role_id)
        .collect();

        Ok(RolePermission::find()
            .filter(role_permission::Column::RoleId.is_in(role_ids))
            .all(txn)
            .await
            .or_raise(make_error)?
            .into_iter()
            .map(|p| Permission {
                resource_type: p.resource_type,
                resource_category: p.resource_category_id.map(Reference::Id),
                action: p.action,
            })
            .collect())
    }

    async fn check_category_scoped(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        resource: Resource,
        resource_category_id: i64,
        action: Action,
    ) -> Result<bool> {
        let txn = ctx.transaction();
        Ok(RolePermission::find()
            .filter(
                Condition::all()
                    .add(role_permission::Column::SiteId.eq(site_id))
                    .add(role_permission::Column::ResourceType.eq(resource))
                    .add(
                        role_permission::Column::ResourceCategoryId
                            .eq(resource_category_id),
                    )
                    .add(role_permission::Column::Action.eq(action)),
            )
            .one(txn)
            .await
            .or_raise(|| {
                Error::new("error querying permissions", ErrorType::Permission)
            })?)
        .map(|p| p.is_some())
    }

    async fn cascade_permission_removals(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        child_role_id: i64,
        removed_permissions: &HashSet<Permission<'static>>,
    ) -> Result<()> {
        let txn = ctx.transaction();

        let make_error = || {
            Error::new(
                format!(
                    "failed to cascade permission removals for role ID {}",
                    child_role_id
                ),
                ErrorType::Permission,
            )
        };

        let child_perms = Self::permissions_as_set(ctx, child_role_id)
            .await
            .or_raise(make_error)?;
        let to_remove: HashSet<Permission<'static>> = child_perms
            .intersection(removed_permissions)
            .cloned()
            .collect();

        for perm in &to_remove {
            let resource_category_id =
                perm.resource_category.as_ref().and_then(|r| match r {
                    Reference::Id(id) => Some(*id),
                    _ => None,
                });
            let resource_condition = match resource_category_id {
                Some(id) => role_permission::Column::ResourceCategoryId.eq(id),
                None => role_permission::Column::ResourceCategoryId.is_null(),
            };

            RolePermission::delete_many()
                .filter(
                    Condition::all()
                        .add(role_permission::Column::RoleId.eq(child_role_id))
                        .add(role_permission::Column::ResourceType.eq(perm.resource_type))
                        .add(resource_condition)
                        .add(role_permission::Column::Action.eq(perm.action)),
                )
                .exec(txn)
                .await
                .or_raise(make_error)?;
        }

        let grandchildren = Role::find()
            .filter(
                Condition::all()
                    .add(role::Column::ParentRoleId.eq(child_role_id))
                    .add(role::Column::SiteId.eq(site_id))
                    .add(role::Column::DeletedAt.is_null()),
            )
            .all(txn)
            .await
            .or_raise(make_error)?;

        for grandchild in grandchildren {
            Box::pin(Self::cascade_permission_removals(
                ctx,
                site_id,
                grandchild.role_id,
                &to_remove,
            ))
            .await
            .or_raise(make_error)?;
        }

        Ok(())
    }
}
