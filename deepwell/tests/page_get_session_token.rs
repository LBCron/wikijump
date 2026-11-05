/*
 * tests/page_get_session_token.rs
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
use deepwell::services::RequestContext;
use deepwell::services::page::{CreatePage, PageService};
use deepwell::services::permission::PermissionService;
use deepwell::services::role::{
    GrantUserRoleInput, InternalCreateRoleInput, RoleService, UpdateRolePermissionsInput,
};
use deepwell::services::session::{CreateSession, SessionService};
use deepwell::services::site::{CreateSite, SiteService};
use deepwell::services::user::{CreateUser, UserService};
use deepwell::types::{Action, Permission, Reference, Resource, UserType};
use ftml::layout::Layout;
use serde_json::json;
use std::borrow::Cow;
use std::sync::atomic::{AtomicU64, Ordering};
use str_macro::str;

static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_n() -> u64 {
    FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed)
}

struct Fixture {
    site_id: i64,
    page_id: i64,
    slug: String,
    viewer_user_id: i64,
    outsider_user_id: i64,
    viewer_token: String,
    outsider_token: String,
}

async fn create_user(runner: &TestRunner, n: u64, label: &str) -> i64 {
    UserService::create(
        runner.context(),
        CreateUser {
            user_type: UserType::Regular,
            name: format!("Page Get Session Token {n} {label}"),
            email: format!("page-get-session-token-{n}-{label}@example.invalid"),
            locales: vec![str!("en")],
            password: String::from("page-get-session-token-test-password"),
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

async fn create_session(runner: &TestRunner, user_id: i64) -> String {
    SessionService::create(
        runner.context(),
        CreateSession {
            user_id,
            ip_address: common::IP_ADDRESS,
            user_agent: str!("page-get-session-token-test"),
            restricted: false,
        },
    )
    .await
    .expect("test session should be created")
}

async fn setup_fixture(runner: &TestRunner) -> Fixture {
    let ctx = runner.context();
    let n = next_n();

    let site = SiteService::create(
        ctx,
        CreateSite {
            slug: format!("page-get-session-token-{n}"),
            name: format!("Page get session token site {n}"),
            tagline: String::new(),
            description: format!("Page get session token site {n}"),
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

    let viewer_user_id = create_user(runner, n, "viewer").await;
    let outsider_user_id = create_user(runner, n, "outsider").await;

    let role_id = RoleService::create(
        ctx,
        InternalCreateRoleInput {
            site_id,
            name: format!("PageGetSessionViewRole{n}"),
            description: None,
            is_virtual: false,
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
            new_permissions: vec![Permission {
                resource_type: Resource::Page,
                resource_category: None,
                action: Action::View,
            }],
            cascade_removals: false,
            updating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("role permissions should be set");
    RoleService::grant_role_to_user(
        ctx,
        GrantUserRoleInput {
            site_id,
            user_id: viewer_user_id,
            role_id,
            assigning_user_id: SYSTEM_USER_ID,
            expires_at: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("role should be granted to the viewer");

    let slug = format!("page-get-session-token-secret-{n}");
    let page = PageService::create(
        ctx,
        CreatePage {
            site_id,
            wikitext: String::from("page get session token fixture body"),
            title: String::from("Page Get Session Token Secret"),
            alt_title: None,
            tags: vec![String::from("privacy-fixture")],
            slug: slug.clone(),
            layout: Some(Layout::Wikidot),
            revision_comments: String::from("page get session token fixture"),
            user_id: SYSTEM_USER_ID,
            bypass_filter: true,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("fixture page should be created");

    let page_model =
        PageService::get(ctx, site_id, Reference::Slug(Cow::Borrowed(slug.as_str())))
            .await
            .expect("fixture page should load");
    assert!(
        !PermissionService::check_user_can_view_page(ctx, None, &page_model)
            .await
            .expect("anonymous view check should resolve"),
        "fixture page must not be anonymously viewable",
    );
    assert!(
        !PermissionService::check_user_can_view_page(
            ctx,
            Some(outsider_user_id),
            &page_model,
        )
        .await
        .expect("outsider view check should resolve"),
        "fixture page must not be viewable by the outsider",
    );
    assert!(
        PermissionService::check_user_can_view_page(
            ctx,
            Some(viewer_user_id),
            &page_model
        )
        .await
        .expect("viewer view check should resolve"),
        "fixture page must be viewable by the granted viewer",
    );

    let viewer_token = create_session(runner, viewer_user_id).await;
    let outsider_token = create_session(runner, outsider_user_id).await;

    Fixture {
        site_id,
        page_id: page.page_id,
        slug,
        viewer_user_id,
        outsider_user_id,
        viewer_token,
        outsider_token,
    }
}

fn request_as(runner: &mut TestRunner, fixture: &Fixture, user_id: Option<i64>) {
    runner.set_request_context(RequestContext {
        user_id,
        site_id: Some(fixture.site_id),
        page_reference: Some(Reference::Slug(Cow::Owned(fixture.slug.clone()))),
        ..Default::default()
    });
}

#[tokio::test]
async fn page_get_resolves_the_page_for_a_forwarded_viewer_session() {
    let mut runner = TestRunner::setup().await;
    let fixture = setup_fixture(&runner).await;

    request_as(&mut runner, &fixture, None);
    let anonymous = run_endpoint!(
        runner,
        page_get,
        json!({
            "site_id": fixture.site_id,
            "page": fixture.slug,
        }),
    );
    assert!(
        anonymous.is_none(),
        "page_get without a session must not return a page the caller cannot view",
    );

    let viewer = run_endpoint!(
        runner,
        page_get,
        json!({
            "site_id": fixture.site_id,
            "page": fixture.slug,
            "session_token": fixture.viewer_token,
        }),
    )
    .expect("page_get should return the page for the granted viewer's session");
    assert_eq!(viewer.page_id, fixture.page_id);

    let outsider = run_endpoint!(
        runner,
        page_get,
        json!({
            "site_id": fixture.site_id,
            "page": fixture.slug,
            "session_token": fixture.outsider_token,
        }),
    );
    assert!(
        outsider.is_none(),
        "page_get must not return the page for an unauthorized session",
    );

    let bogus = run_endpoint!(
        runner,
        page_get,
        json!({
            "site_id": fixture.site_id,
            "page": fixture.slug,
            "session_token": "wj:token-that-does-not-resolve",
        }),
    );
    assert!(
        bogus.is_none(),
        "page_get must not return the page for an unresolvable session token",
    );
}

#[tokio::test]
async fn page_get_keeps_request_context_identity_without_a_forwarded_token() {
    let mut runner = TestRunner::setup().await;
    let fixture = setup_fixture(&runner).await;

    request_as(&mut runner, &fixture, Some(fixture.viewer_user_id));
    let viewer = run_endpoint!(
        runner,
        page_get,
        json!({
            "site_id": fixture.site_id,
            "page": fixture.slug,
        }),
    );
    assert!(
        viewer.is_some(),
        "page_get should keep honoring the request-context identity",
    );

    request_as(&mut runner, &fixture, Some(fixture.outsider_user_id));
    let forwarded = run_endpoint!(
        runner,
        page_get,
        json!({
            "site_id": fixture.site_id,
            "page": fixture.slug,
            "session_token": fixture.viewer_token,
        }),
    );
    assert!(
        forwarded.is_some(),
        "a forwarded session token takes precedence, matching file_get",
    );
}
