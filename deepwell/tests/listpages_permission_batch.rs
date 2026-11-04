/*
 * tests/listpages_permission_batch.rs
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

#[macro_use]
mod common;

use self::common::TestRunner;
use deepwell::constants::SYSTEM_USER_ID;
use deepwell::license::License;
use deepwell::services::ServiceContext;
use deepwell::services::category::CategoryService;
use deepwell::services::page::{CreatePage, PageService};
use deepwell::services::permission::{CheckPermissionContext, PermissionService};
use deepwell::services::relation::{
    CreateSiteMember, PageAttributionEntry, PageAttributionKind, PageAttributionMetadata,
    RelationService, SetPageAttributions, SiteMemberAccepted, SiteMemberData,
};
use deepwell::services::render::{ViewablePageRef, view_decisions_for_scanned_pages};
use deepwell::services::role::{
    GrantUserRoleInput, InternalCreateRoleInput, RoleService, UpdateRolePermissionsInput,
};
use deepwell::services::site::{CreateSite, SiteService};
use deepwell::services::user::{CreateUser, UserService};
use deepwell::types::{Action, Permission, Reference, Resource, UserType};
use ftml::layout::Layout;
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicU64, Ordering};
use str_macro::str;
use time::{Date, Month};
use uuid::Uuid;

static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_n() -> u64 {
    FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed)
}

#[derive(Clone, Copy, Debug)]
struct ScannedPage {
    page_id: i64,
    category_id: Option<i64>,
}

async fn page_scoped_view_check(
    ctx: &ServiceContext<'_>,
    viewer_user_id: Option<i64>,
    site_id: i64,
    page: ScannedPage,
) -> bool {
    PermissionService::check_user_can(
        ctx,
        &CheckPermissionContext {
            user_id: viewer_user_id,
            site_id,
            page_reference: Some(Reference::Id(page.page_id)),
        },
        Permission {
            resource_type: Resource::Page,
            resource_category: page.category_id.map(Reference::Id),
            action: Action::View,
        },
    )
    .await
    .expect("page-scoped view check should resolve")
}

async fn reference_view_decisions(
    ctx: &ServiceContext<'_>,
    viewer_user_id: Option<i64>,
    site_id: i64,
    pages: &[ScannedPage],
) -> Vec<bool> {
    let mut decisions = Vec::with_capacity(pages.len());
    for page in pages {
        decisions.push(page_scoped_view_check(ctx, viewer_user_id, site_id, *page).await);
    }
    decisions
}

type CategoryPermissions = BTreeMap<(i64, Option<i64>), bool>;

async fn batched_view_decisions(
    ctx: &ServiceContext<'_>,
    viewer_user_id: Option<i64>,
    site_id: i64,
    pages: &[ScannedPage],
    category_permissions: &mut CategoryPermissions,
) -> Vec<bool> {
    let scanned = pages
        .iter()
        .map(|page| ViewablePageRef {
            page_id: page.page_id,
            site_id,
            page_category_id: page.category_id,
        })
        .collect::<Vec<_>>();

    view_decisions_for_scanned_pages(ctx, viewer_user_id, &scanned, category_permissions)
        .await
        .expect("batched view decisions should resolve")
}

async fn assert_batched_matches_reference(
    ctx: &ServiceContext<'_>,
    label: &str,
    viewer_user_id: Option<i64>,
    site_id: i64,
    pages: &[ScannedPage],
    category_permissions: &mut CategoryPermissions,
) -> Vec<bool> {
    let reference = reference_view_decisions(ctx, viewer_user_id, site_id, pages).await;
    let batched =
        batched_view_decisions(ctx, viewer_user_id, site_id, pages, category_permissions)
            .await;

    assert_eq!(
        reference.len(),
        batched.len(),
        "{label}: decision count differs"
    );

    for ((page, expected), actual) in pages.iter().zip(&reference).zip(&batched) {
        assert_eq!(
            expected, actual,
            "{label}: view decision differs for page {} in category {:?}",
            page.page_id, page.category_id
        );
    }

    reference
}

struct Fixture {
    site_id: i64,
    category_id: i64,
    other_category_id: i64,
    user_with_view: i64,
    user_without_view: i64,
    user_no_roles: i64,
    pages: Vec<ScannedPage>,
    authored_index: usize,
    sibling_index: usize,
}

async fn create_role(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    name: &str,
    permissions: Vec<Permission<'static>>,
) -> i64 {
    create_role_maybe_virtual(ctx, site_id, name, permissions, false).await
}

async fn create_role_maybe_virtual(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    name: &str,
    permissions: Vec<Permission<'static>>,
    is_virtual: bool,
) -> i64 {
    let role_id = RoleService::create(
        ctx,
        InternalCreateRoleInput {
            site_id,
            name: name.to_owned(),
            description: None,
            is_virtual,
            parent_role_id: None,
            creating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("role should be created")
    .role_id;

    PermissionService::update_permissions_for_role(
        ctx,
        UpdateRolePermissionsInput {
            site_id,
            role_reference: Reference::Id(role_id),
            new_permissions: permissions,
            cascade_removals: false,
            updating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("role permissions should be set");

    role_id
}

async fn grant_role(ctx: &ServiceContext<'_>, site_id: i64, user_id: i64, role_id: i64) {
    RoleService::grant_role_to_user(
        ctx,
        GrantUserRoleInput {
            site_id,
            user_id,
            role_id,
            assigning_user_id: SYSTEM_USER_ID,
            expires_at: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("role should be granted to user");
}

async fn create_user(ctx: &ServiceContext<'_>, fixture_n: u64, label: &str) -> i64 {
    UserService::create(
        ctx,
        CreateUser {
            user_type: UserType::Regular,
            name: format!("Perm Batch {fixture_n} {label}"),
            email: format!("perm-batch-{fixture_n}-{label}@email.com"),
            locales: vec![str!("en")],
            password: String::from("password-fixture"),
            bypass_filter: true,
            bypass_email_verification: true,
            override_user_id: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("test user should be created")
    .user_id
}

async fn create_page(ctx: &ServiceContext<'_>, site_id: i64, slug: &str) -> i64 {
    PageService::create(
        ctx,
        CreatePage {
            site_id,
            wikitext: String::from("differential permission fixture"),
            title: String::from(slug),
            alt_title: None,
            tags: Vec::new(),
            slug: slug.to_owned(),
            layout: Some(Layout::Wikidot),
            revision_comments: String::from("permission batch differential"),
            user_id: SYSTEM_USER_ID,
            bypass_filter: true,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("fixture page should be created")
    .page_id
}

impl Fixture {
    async fn setup(runner: &TestRunner) -> Self {
        let ctx = runner.context();
        let n = next_n();

        let site = SiteService::create(
            ctx,
            CreateSite {
                slug: format!("perm-batch-{n}"),
                name: format!("Permission batch site {n}"),
                tagline: String::new(),
                description: format!("Permission batch site {n}"),
                default_page: None,
                layout: None,
                license: License::CcBySa40,
                locale: String::from("en"),
                ip_address: common::IP_ADDRESS,
            },
            None,
        )
        .await
        .expect("test site should be created");
        let site_id = site.site_id;

        let category_id = CategoryService::get_or_create(ctx, site_id, "batch-category")
            .await
            .expect("page category should be created")
            .category_id;
        let other_category_id =
            CategoryService::get_or_create(ctx, site_id, "batch-other")
                .await
                .expect("other page category should be created")
                .category_id;

        let user_with_view = create_user(ctx, n, "with-view").await;
        let user_without_view = create_user(ctx, n, "without-view").await;
        let user_no_roles = create_user(ctx, n, "no-roles").await;

        let viewer_role = create_role(
            ctx,
            site_id,
            &format!("BatchViewRole{n}"),
            vec![Permission {
                resource_type: Resource::Page,
                resource_category: None,
                action: Action::View,
            }],
        )
        .await;
        grant_role(ctx, site_id, user_with_view, viewer_role).await;

        create_role_maybe_virtual(
            ctx,
            site_id,
            "page-author",
            vec![Permission {
                resource_type: Resource::Page,
                resource_category: None,
                action: Action::View,
            }],
            true,
        )
        .await;

        RelationService::create_site_member(
            ctx,
            CreateSiteMember {
                site_id,
                user_id: user_without_view,
                metadata: SiteMemberData {
                    accepted: SiteMemberAccepted::Accepted(SYSTEM_USER_ID),
                },
                created_by: SYSTEM_USER_ID,
            },
            common::IP_ADDRESS,
        )
        .await
        .expect("site membership should be created");

        let tag = Uuid::new_v4();
        let mut pages = Vec::new();
        for i in 0..3 {
            pages.push(ScannedPage {
                page_id: create_page(ctx, site_id, &format!("perm-batch-a-{tag}-{i}"))
                    .await,
                category_id: Some(category_id),
            });
        }
        for i in 0..3 {
            pages.push(ScannedPage {
                page_id: create_page(ctx, site_id, &format!("perm-batch-b-{tag}-{i}"))
                    .await,
                category_id: Some(other_category_id),
            });
        }
        for i in 0..3 {
            pages.push(ScannedPage {
                page_id: create_page(ctx, site_id, &format!("perm-batch-c-{tag}-{i}"))
                    .await,
                category_id: None,
            });
        }

        let authored_index = 0;
        let sibling_index = 1;
        assert_eq!(
            pages[authored_index].category_id, pages[sibling_index].category_id,
            "the leak check is only meaningful within one category"
        );

        RelationService::set_page_attributions(
            ctx,
            SetPageAttributions {
                site_id,
                page: Reference::Id(pages[authored_index].page_id),
                updated_by: SYSTEM_USER_ID,
                attributions: vec![PageAttributionEntry {
                    user_id: user_without_view,
                    metadata: PageAttributionMetadata {
                        attribution_type: PageAttributionKind::Author,
                        attribution_date: Date::from_calendar_date(
                            2026,
                            Month::January,
                            1,
                        )
                        .expect("fixture attribution date should be valid"),
                    },
                }],
            },
        )
        .await
        .expect("page attribution should be set");

        Self {
            site_id,
            category_id,
            other_category_id,
            user_with_view,
            user_without_view,
            user_no_roles,
            pages,
            authored_index,
            sibling_index,
        }
    }

    fn viewers(&self) -> Vec<(&'static str, Option<i64>)> {
        vec![
            ("anonymous", None),
            ("user_with_view", Some(self.user_with_view)),
            ("user_without_view", Some(self.user_without_view)),
            ("user_no_roles", Some(self.user_no_roles)),
        ]
    }
}

#[tokio::test]
async fn batched_view_decisions_match_the_page_scoped_reference() {
    let runner = TestRunner::setup().await;
    let f = Fixture::setup(&runner).await;
    let ctx = runner.context();

    let mut category_permissions = CategoryPermissions::new();

    for (label, viewer) in f.viewers() {
        assert_batched_matches_reference(
            ctx,
            label,
            viewer,
            f.site_id,
            &f.pages,
            &mut category_permissions,
        )
        .await;
    }
}

#[tokio::test]
async fn a_warm_category_cache_never_changes_a_decision() {
    let runner = TestRunner::setup().await;
    let f = Fixture::setup(&runner).await;
    let ctx = runner.context();

    let mut category_permissions = CategoryPermissions::new();
    let viewer = Some(f.user_with_view);
    let expected = reference_view_decisions(ctx, viewer, f.site_id, &f.pages).await;

    for round in 0..3 {
        let actual = batched_view_decisions(
            ctx,
            viewer,
            f.site_id,
            &f.pages,
            &mut category_permissions,
        )
        .await;
        assert_eq!(
            expected, actual,
            "round {round}: a warm category cache changed a decision"
        );
    }
}

#[tokio::test]
async fn an_authored_page_is_visible_without_leaking_to_its_category_siblings() {
    let runner = TestRunner::setup().await;
    let f = Fixture::setup(&runner).await;
    let ctx = runner.context();

    let viewer = Some(f.user_without_view);
    let mut category_permissions = CategoryPermissions::new();
    let decisions = batched_view_decisions(
        ctx,
        viewer,
        f.site_id,
        &f.pages,
        &mut category_permissions,
    )
    .await;

    assert!(
        decisions[f.authored_index],
        "the author must be able to view the page they authored"
    );
    assert!(
        !decisions[f.sibling_index],
        "PageAuthor must not grant view of another page in the same category"
    );

    for (index, page) in f.pages.iter().enumerate() {
        if index == f.authored_index {
            continue;
        }
        assert!(
            !decisions[index],
            "PageAuthor must not grant view of page {}",
            page.page_id
        );
    }
}

#[tokio::test]
async fn category_scoped_view_permissions_gate_the_batched_path() {
    let runner = TestRunner::setup().await;
    let f = Fixture::setup(&runner).await;
    let ctx = runner.context();

    let scoped_role = create_role(
        ctx,
        f.site_id,
        &format!("BatchScopedView{}", next_n()),
        vec![Permission {
            resource_type: Resource::Page,
            resource_category: Some(Reference::Id(f.category_id)),
            action: Action::View,
        }],
    )
    .await;
    grant_role(ctx, f.site_id, f.user_no_roles, scoped_role).await;

    let viewer = Some(f.user_no_roles);
    let mut category_permissions = CategoryPermissions::new();

    let reference = assert_batched_matches_reference(
        ctx,
        "scoped viewer",
        viewer,
        f.site_id,
        &f.pages,
        &mut category_permissions,
    )
    .await;

    let mut granted = 0;
    for (page, expected) in f.pages.iter().zip(&reference) {
        if page.category_id == Some(f.category_id) {
            assert!(*expected, "scoped view role should grant its own category");
            granted += 1;
        } else {
            assert!(
                !*expected,
                "scoped view role must not grant category {:?}",
                page.category_id
            );
        }
    }

    assert_eq!(granted, 3, "the scoped category should hold three pages");
    let _ = f.other_category_id;
}
