/*
 * endpoints/site_ban.rs
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

use super::prelude::*;
use crate::constants::ADMIN_USER_ID;
use crate::models::relation::Model as RelationModel;
use crate::services::MutationAuthorization;
use crate::services::permission::PermissionService;
use crate::services::relation::{CreateSiteBan, GetSiteBan, RemoveSiteBan, SiteBanData};
use crate::services::user::User;
use crate::types::{Action, Permission, Reference, Resource};
use std::net::IpAddr;

async fn authorize_site_ban_mutation(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    submitted_actor_user_id: i64,
    action: &str,
) -> Result<()> {
    MutationAuthorization::require_matching_actor(ctx, submitted_actor_user_id, action)?;
    let site = SiteService::get(ctx, Reference::Id(site_id))
        .await
        .or_raise(|| {
            Error::new(
                "failed to validate the site for a site-ban mutation",
                ErrorType::SiteBanRelation,
            )
        })?;
    if site.deleted_at.is_some() {
        return Err(Error::new("site does not exist", ErrorType::SiteNotFound).into());
    }
    MutationAuthorization::require_permission(
        ctx,
        site_id,
        None,
        Permission {
            resource_type: Resource::Role,
            resource_category: None,
            action: Action::Assign,
        },
        action,
    )
    .await?;
    Ok(())
}

async fn require_active_site_ban_target(
    ctx: &ServiceContext<'_>,
    target_user_id: i64,
) -> Result<()> {
    let target = UserService::get(ctx, Reference::Id(target_user_id))
        .await
        .or_raise(|| {
            Error::new(
                "failed to validate the target user for a site-ban mutation",
                ErrorType::SiteBanRelation,
            )
        })?;
    let target_is_active = match target {
        User::Wikijump(user) => user.deleted_at.is_none(),
        User::Wikidot(user) => !user.is_deleted,
    };
    if !target_is_active {
        return Err(Error::new("user does not exist", ErrorType::UserNotFound).into());
    }
    Ok(())
}

#[derive(Deserialize, Debug, Clone)]
struct CreateSiteBanInput {
    site_id: i64,
    user_id: i64,
    metadata: SiteBanData,
    created_by: i64,
    ip_address: IpAddr,
}

#[derive(Deserialize, Debug, Clone)]
struct RemoveSiteBanInput {
    site_id: i64,
    user_id: i64,
    removed_by: i64,
    reason: String,
    ip_address: IpAddr,
}

#[derive(Debug, PartialEq, Eq)]
enum SiteBanViewAccess {
    Allowed,
    NeedsSiteAdminCheck(i64),
    Denied,
}

fn site_ban_view_access(actor: Option<i64>, subject_user_id: i64) -> SiteBanViewAccess {
    match actor {
        Some(actor) if actor == subject_user_id || actor == ADMIN_USER_ID => {
            SiteBanViewAccess::Allowed
        }
        Some(actor) => SiteBanViewAccess::NeedsSiteAdminCheck(actor),
        None => SiteBanViewAccess::Denied,
    }
}

pub async fn site_ban_get(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Option<RelationModel>> {
    let input: GetSiteBan = parse!(params, SiteBanRelation);
    let user_id = input.user_id;
    let site_id = input.site_id;

    let privileged = match site_ban_view_access(ctx.request().user_id, user_id) {
        SiteBanViewAccess::Allowed => true,
        SiteBanViewAccess::Denied => false,
        SiteBanViewAccess::NeedsSiteAdminCheck(actor) => {
            PermissionService::check_user_can_access_admin(ctx, Some(actor), site_id)
                .await
                .or_raise(|| {
                    Error::new(
                        "failed to check permission to view site ban data",
                        ErrorType::SiteBanRelation,
                    )
                })?
        }
    };

    if !privileged {
        return Err(Error::new(
            "user does not have permission to view site ban data",
            ErrorType::PermissionDenied,
        )
        .into());
    }

    RelationService::get_optional_site_ban(ctx, input)
        .await
        .or_raise(|| {
            Error::new(
                format!(
                    "failed to get site ban data for user ID {} on site ID {}",
                    user_id, site_id,
                ),
                ErrorType::SiteBanRelation,
            )
        })
}

pub async fn site_ban_set(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<()> {
    let CreateSiteBanInput {
        site_id,
        user_id,
        metadata,
        created_by,
        ip_address,
    } = parse!(params, SiteBanRelation);

    authorize_site_ban_mutation(ctx, site_id, created_by, "create a site ban").await?;
    require_active_site_ban_target(ctx, user_id).await?;

    RelationService::create_site_ban(
        ctx,
        CreateSiteBan {
            site_id,
            user_id,
            metadata,
            created_by,
        },
        ip_address,
    )
    .await
    .or_raise(|| {
        Error::new(
            format!("failed to ban user ID {} from site ID {}", user_id, site_id),
            ErrorType::SiteBanRelation,
        )
    })
}

pub async fn site_ban_remove(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<RelationModel> {
    let RemoveSiteBanInput {
        site_id,
        user_id,
        removed_by,
        reason,
        ip_address,
    } = parse!(params, SiteBanRelation);

    authorize_site_ban_mutation(ctx, site_id, removed_by, "remove a site ban").await?;

    RelationService::remove_site_ban(
        ctx,
        RemoveSiteBan {
            site_id,
            user_id,
            removed_by,
        },
        ip_address,
        &reason,
    )
    .await
    .or_raise(|| {
        Error::new(
            format!(
                "failed to remove site ban for user ID {} from site ID {}",
                user_id, site_id,
            ),
            ErrorType::SiteBanRelation,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{SiteBanViewAccess, site_ban_view_access};
    use crate::constants::ADMIN_USER_ID;

    #[test]
    fn site_ban_view_access_allows_subject_and_platform_admin() {
        assert_eq!(
            site_ban_view_access(Some(42), 42),
            SiteBanViewAccess::Allowed
        );
        assert_eq!(
            site_ban_view_access(Some(ADMIN_USER_ID), 42),
            SiteBanViewAccess::Allowed,
        );
    }

    #[test]
    fn site_ban_view_access_requires_site_admin_check_for_other_users() {
        assert_eq!(
            site_ban_view_access(Some(7), 42),
            SiteBanViewAccess::NeedsSiteAdminCheck(7),
        );
    }

    #[test]
    fn site_ban_view_access_denies_anonymous() {
        assert_eq!(site_ban_view_access(None, 42), SiteBanViewAccess::Denied);
    }
}
