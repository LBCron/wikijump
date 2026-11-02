/*
 * services/site/bootstrap.rs
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
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

use std::borrow::Cow;
use std::net::IpAddr;

use crate::constants::SYSTEM_USER_ID;
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::services::ServiceContext;
use crate::services::page::{CreatePage, PageService};
use crate::services::permission::PermissionService;
use crate::services::relation::{
    PageAttributionEntry, PageAttributionKind, PageAttributionMetadata, RelationService,
    SetPageAttributions,
};
use crate::services::role::{
    GrantUserRoleInput, InternalCreateRoleInput, RoleService, UpdateRolePermissionsInput,
};
use crate::services::site::{SiteService, UpdateSiteBody};
use crate::types::{Action, Maybe, Permission, Reference, Resource};
use crate::utils::now;

#[derive(serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "kebab-case")]
struct RoleTemplate {
    name: String,
    description: String,
    is_virtual: bool,
    parent_role: Option<String>,
    permissions: Vec<String>,
}

const BASELINE_ROLES_JSON: &str = include_str!("../../../seeder/roles.json");

pub const STANDARD_TEMPLATE_PAGES: &[(&str, &str, &str)] = &[
    (
        "start",
        "You've just created a new Wikijump site!",
        include_str!("../../../seeder/template-start.ftml"),
    ),
    (
        "nav:side",
        "Sidebar",
        include_str!("../../../seeder/sidebar.ftml"),
    ),
    (
        "nav:top",
        "Topbar",
        include_str!("../../../seeder/topbar.ftml"),
    ),
    (
        "search:site",
        "Search this site",
        include_str!("../../../seeder/search-site.ftml"),
    ),
    (
        "admin:manage",
        "Site Manager",
        include_str!("../../../seeder/admin-manage.ftml"),
    ),
    (
        "_admin",
        "Admin Panel",
        include_str!("../../../seeder/_admin.ftml"),
    ),
    (
        "system:join",
        "Join this site",
        include_str!("../../../seeder/join.ftml"),
    ),
    (
        "system:members",
        "Site Members",
        include_str!("../../../seeder/members.ftml"),
    ),
    (
        "system:recent-changes",
        "Recent Changes",
        include_str!("../../../seeder/recent-changes.ftml"),
    ),
    (
        "system:page-tags",
        "Page Tags",
        include_str!("../../../seeder/page-tags.ftml"),
    ),
    (
        "system:list-all-pages",
        "List All Pages",
        include_str!("../../../seeder/list-all-pages.ftml"),
    ),
];

#[derive(Debug)]
pub struct BootstrapNewSite {
    pub site_id: i64,
    pub creator_user_id: Option<i64>,
    pub ip_address: IpAddr,
}

impl SiteService {
    pub async fn bootstrap_site(
        ctx: &ServiceContext<'_>,
        BootstrapNewSite {
            site_id,
            creator_user_id,
            ip_address,
        }: BootstrapNewSite,
    ) -> Result<()> {
        let make_error = || {
            Error::new(
                format!("failed to bootstrap site ID {site_id}"),
                ErrorType::Site,
            )
        };

        let acting_user_id = creator_user_id.unwrap_or(SYSTEM_USER_ID);

        let templates: Vec<RoleTemplate> =
            serde_json::from_str(BASELINE_ROLES_JSON).or_raise(make_error)?;

        let mut admin_role_id = None;
        for template in &templates {
            let parent_role_id = match &template.parent_role {
                Some(parent_slug) => Some(
                    RoleService::get(
                        ctx,
                        site_id,
                        Reference::Slug(Cow::Borrowed(parent_slug)),
                    )
                    .await
                    .or_raise(make_error)?
                    .role_id,
                ),
                None => None,
            };

            let role = RoleService::create(
                ctx,
                InternalCreateRoleInput {
                    site_id,
                    name: template.name.clone(),
                    description: Some(template.description.clone()),
                    is_virtual: template.is_virtual,
                    parent_role_id,
                    creating_user_id: acting_user_id,
                    ip_address,
                },
            )
            .await
            .or_raise(make_error)?;

            let mut permissions = Vec::with_capacity(template.permissions.len());
            for perm_spec in &template.permissions {
                let parts: Vec<&str> = perm_spec.split(':').collect();
                let input = match parts.as_slice() {
                    [resource, action] => Permission {
                        resource_type: parse_or_raise!(resource, Resource, make_error),
                        resource_category: None,
                        action: parse_or_raise!(action, Action, make_error),
                    },
                    [resource, category_slug, action] => Permission {
                        resource_type: parse_or_raise!(resource, Resource, make_error),
                        resource_category: Some(Reference::Slug(Cow::Borrowed(
                            category_slug,
                        ))),
                        action: parse_or_raise!(action, Action, make_error),
                    },
                    _ => {
                        return Err(Error::new(
                            format!(
                                "invalid permission '{perm_spec}' for role '{}' in site {site_id}",
                                template.name,
                            ),
                            ErrorType::Site,
                        )
                        .into());
                    }
                };
                permissions.push(input);
            }

            PermissionService::update_permissions_for_role(
                ctx,
                UpdateRolePermissionsInput {
                    site_id,
                    role_reference: Reference::Id(role.role_id),
                    new_permissions: permissions,
                    cascade_removals: false,
                    updating_user_id: acting_user_id,
                    ip_address,
                },
            )
            .await
            .or_raise(make_error)?;

            if template.name == "admin" {
                admin_role_id = Some(role.role_id);
            }
        }

        if let Some(creator) = creator_user_id {
            let Some(admin_role_id) = admin_role_id else {
                return Err(Error::new(
                    format!("no admin role in baseline roles for site ID {site_id}"),
                    ErrorType::Site,
                )
                .into());
            };
            RoleService::grant_role_to_user(
                ctx,
                GrantUserRoleInput {
                    site_id,
                    user_id: creator,
                    role_id: admin_role_id,
                    assigning_user_id: creator,
                    expires_at: None,
                    ip_address,
                },
            )
            .await
            .or_raise(make_error)?;
        }

        let site_user_id = RelationService::get_site_user_id_for_site(ctx, site_id)
            .await
            .or_raise(make_error)?;
        let author_user_id = creator_user_id.unwrap_or(site_user_id);

        for (slug, title, wikitext) in STANDARD_TEMPLATE_PAGES {
            let created = PageService::create(
                ctx,
                CreatePage {
                    site_id,
                    wikitext: str!(wikitext),
                    title: str!(title),
                    alt_title: None,
                    tags: Vec::new(),
                    slug: str!(slug),
                    layout: None,
                    revision_comments: String::new(),
                    user_id: author_user_id,
                    bypass_filter: true,
                    ip_address,
                },
            )
            .await
            .or_raise(make_error)?;

            RelationService::set_page_attributions(
                ctx,
                SetPageAttributions {
                    site_id,
                    page: Reference::Id(created.page_id),
                    updated_by: acting_user_id,
                    attributions: vec![PageAttributionEntry {
                        user_id: author_user_id,
                        metadata: PageAttributionMetadata {
                            attribution_type: PageAttributionKind::Author,
                            attribution_date: now().date(),
                        },
                    }],
                },
            )
            .await
            .or_raise(make_error)?;
        }

        SiteService::update(
            ctx,
            Reference::Id(site_id),
            UpdateSiteBody {
                default_page: Maybe::Set(str!("start")),
                ..Default::default()
            },
            None,
            acting_user_id,
            ip_address,
        )
        .await
        .or_raise(make_error)?;

        Ok(())
    }
}
