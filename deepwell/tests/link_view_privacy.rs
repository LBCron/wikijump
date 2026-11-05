/*
 * tests/link_view_privacy.rs
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
use deepwell::error::prelude::*;
use deepwell::license::License;
use deepwell::services::RequestContext;
use deepwell::services::category::CategoryService;
use deepwell::services::link::LinkService;
use deepwell::services::page::{CreatePage, PageService};
use deepwell::services::permission::PermissionService;
use deepwell::services::role::{
    GrantUserRoleInput, InternalCreateRoleInput, RoleService, UpdateRolePermissionsInput,
};
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
    hub_slug: String,
    hub_page_id: i64,
    peer_page_id: i64,
    secret_slug: String,
    secret_page_id: i64,
    stalker_page_id: i64,
    missing_slug: String,
    external_url: String,
    viewer_user_id: i64,
    outsider_user_id: i64,
}

async fn create_user(runner: &TestRunner, n: u64, label: &str) -> i64 {
    UserService::create(
        runner.context(),
        CreateUser {
            user_type: UserType::Regular,
            name: format!("Link View Privacy {n} {label}"),
            email: format!("link-view-privacy-{n}-{label}@example.invalid"),
            locales: vec![str!("en")],
            password: str!("password-fixture"),
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

async fn create_page(
    runner: &TestRunner,
    site_id: i64,
    slug: &str,
    wikitext: &str,
) -> i64 {
    PageService::create(
        runner.context(),
        CreatePage {
            site_id,
            wikitext: String::from(wikitext),
            title: String::from(slug),
            alt_title: None,
            tags: vec![],
            slug: String::from(slug),
            layout: Some(Layout::Wikidot),
            revision_comments: String::from("link view privacy fixture"),
            user_id: SYSTEM_USER_ID,
            bypass_filter: true,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("fixture page should be created")
    .page_id
}

async fn can_view(
    runner: &TestRunner,
    site_id: i64,
    slug: &str,
    user_id: Option<i64>,
) -> bool {
    let page = PageService::get(
        runner.context(),
        site_id,
        Reference::Slug(Cow::Borrowed(slug)),
    )
    .await
    .expect("fixture page should load");
    PermissionService::check_user_can_view_page(runner.context(), user_id, &page)
        .await
        .expect("view check should resolve")
}

async fn setup_fixture(runner: &TestRunner) -> Fixture {
    let ctx = runner.context();
    let n = next_n();

    let site = SiteService::create(
        ctx,
        CreateSite {
            slug: format!("link-view-privacy-{n}"),
            name: format!("Link view privacy site {n}"),
            tagline: String::new(),
            description: format!("Link view privacy site {n}"),
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

    let default_category_id = CategoryService::get_or_create(ctx, site_id, "_default")
        .await
        .expect("default category should exist")
        .category_id;
    let role_id = RoleService::create(
        ctx,
        InternalCreateRoleInput {
            site_id,
            name: format!("LinkViewRole{n}"),
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
                resource_category: Some(Reference::Id(default_category_id)),
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

    let hub_slug = format!("link-view-hub-{n}");
    let peer_slug = format!("link-view-peer-{n}");
    let secret_slug = format!("closed:link-view-secret-{n}");
    let stalker_slug = format!("closed:link-view-stalker-{n}");
    let external_url = format!("https://link-view-{n}.example.net/deep");

    let secret_page_id =
        create_page(runner, site_id, &secret_slug, "Secret body with no links.").await;
    let hub_page_id = create_page(
        runner,
        site_id,
        &hub_slug,
        &format!(
            "Hub body.\n[[[{secret_slug}]]]\n[[[link-view-missing-{n}]]]\n{external_url}\n",
        ),
    )
    .await;
    let peer_page_id = create_page(
        runner,
        site_id,
        &peer_slug,
        &format!("Peer body linking to [[[{hub_slug}|peer link to hub]]]."),
    )
    .await;
    let stalker_page_id = create_page(
        runner,
        site_id,
        &stalker_slug,
        &format!("Stalker body linking to [[[{hub_slug}|stalker link to hub]]]."),
    )
    .await;

    assert!(
        !can_view(runner, site_id, &hub_slug, None).await,
        "hub must not be anonymously viewable",
    );
    assert!(
        !can_view(runner, site_id, &hub_slug, Some(outsider_user_id)).await,
        "hub must not be viewable by the outsider",
    );
    assert!(
        can_view(runner, site_id, &hub_slug, Some(viewer_user_id)).await,
        "hub must be viewable by the granted viewer",
    );
    assert!(
        !can_view(runner, site_id, &secret_slug, Some(viewer_user_id)).await,
        "secret must not be viewable by the category-scoped viewer",
    );

    let missing_slug = LinkService::get_from(ctx, hub_page_id)
        .await
        .expect("hub links should load")
        .absent
        .iter()
        .find(|row| row.to_page_slug.contains("link-view-missing"))
        .expect("hub should have a missing-slug row")
        .to_page_slug
        .clone();

    Fixture {
        site_id,
        hub_slug,
        hub_page_id,
        peer_page_id,
        secret_slug,
        secret_page_id,
        stalker_page_id,
        missing_slug,
        external_url,
        viewer_user_id,
        outsider_user_id,
    }
}

fn act_as(runner: &mut TestRunner, fixture: &Fixture, user_id: Option<i64>) {
    runner.set_request_context(RequestContext {
        user_id,
        site_id: Some(fixture.site_id),
        page_reference: Some(Reference::Slug(Cow::Owned(fixture.hub_slug.clone()))),
        ..Default::default()
    });
}

#[tokio::test]
async fn link_subject_endpoints_require_view() {
    let mut runner = TestRunner::setup().await;
    let fixture = setup_fixture(&runner).await;
    let bogus_slug = format!("link-view-bogus-{}", next_n());

    for user_id in [None, Some(fixture.outsider_user_id)] {
        act_as(&mut runner, &fixture, user_id);

        let from_error = run_endpoint_err!(
            runner,
            page_links_from_get,
            json!({"site_id": fixture.site_id, "page": fixture.hub_slug}),
        );
        assert_contains_error!(from_error, ErrorType::PermissionDenied);
        let to_error = run_endpoint_err!(
            runner,
            page_links_to_get,
            json!({"site_id": fixture.site_id, "page": fixture.hub_slug}),
        );
        assert_contains_error!(to_error, ErrorType::PermissionDenied);
        let urls_error = run_endpoint_err!(
            runner,
            page_links_external_from,
            json!({"site_id": fixture.site_id, "page": fixture.hub_slug}),
        );
        assert_contains_error!(urls_error, ErrorType::PermissionDenied);

        let private_error = run_endpoint_err!(
            runner,
            page_links_from_get,
            json!({"site_id": fixture.site_id, "page": fixture.hub_slug}),
        );
        let missing_error = run_endpoint_err!(
            runner,
            page_links_from_get,
            json!({"site_id": fixture.site_id, "page": bogus_slug}),
        );
        let private = extract_error!(private_error, ErrorType::PermissionDenied)
            .expect("private subject should fail with PermissionDenied");
        let missing = extract_error!(missing_error, ErrorType::PermissionDenied)
            .expect("missing subject should fail with PermissionDenied");
        assert_eq!(
            (private.code(), private.message.clone()),
            (missing.code(), missing.message.clone()),
            "nonexistent and non-viewable subjects must be indistinguishable",
        );
    }

    act_as(&mut runner, &fixture, Some(fixture.viewer_user_id));
    run_endpoint!(
        runner,
        page_links_from_get,
        json!({"site_id": fixture.site_id, "page": fixture.hub_slug}),
    );
    run_endpoint!(
        runner,
        page_links_to_get,
        json!({"site_id": fixture.site_id, "page": fixture.hub_slug}),
    );
    run_endpoint!(
        runner,
        page_links_external_from,
        json!({"site_id": fixture.site_id, "page": fixture.hub_slug}),
    );
    let secret_error = run_endpoint_err!(
        runner,
        page_links_from_get,
        json!({"site_id": fixture.site_id, "page": fixture.secret_slug}),
    );
    assert_contains_error!(secret_error, ErrorType::PermissionDenied);
}

#[tokio::test]
async fn link_counterpart_edges_filtered_by_viewability() {
    let mut runner = TestRunner::setup().await;
    let fixture = setup_fixture(&runner).await;

    let rows = LinkService::get_from(runner.context(), fixture.hub_page_id)
        .await
        .expect("hub links should load");
    assert!(
        rows.present
            .iter()
            .any(|row| row.to_page_id == fixture.secret_page_id),
        "fixture hub must link the secret page at the service layer",
    );
    let inbound = LinkService::get_to(runner.context(), fixture.hub_page_id, None)
        .await
        .expect("hub inbound links should load")
        .connections
        .iter()
        .map(|row| row.from_page_id)
        .collect::<Vec<_>>();
    assert!(
        inbound.contains(&fixture.peer_page_id),
        "fixture peer must link the hub at the service layer",
    );
    assert!(
        inbound.contains(&fixture.stalker_page_id),
        "fixture stalker must link the hub at the service layer",
    );

    act_as(&mut runner, &fixture, Some(fixture.viewer_user_id));

    let from = run_endpoint!(
        runner,
        page_links_from_get,
        json!({"site_id": fixture.site_id, "page": fixture.hub_slug}),
    );
    assert!(
        !from
            .present
            .iter()
            .any(|row| row.to_page_id == fixture.secret_page_id),
        "outbound edges to non-viewable pages must be filtered",
    );
    assert!(
        from.absent
            .iter()
            .any(|row| row.to_page_slug == fixture.missing_slug),
        "subject-authored missing slugs must be preserved for viewers",
    );
    assert!(
        from.external
            .iter()
            .any(|row| row.url == fixture.external_url),
        "subject-authored external URLs must be preserved for viewers",
    );

    let to = run_endpoint!(
        runner,
        page_links_to_get,
        json!({"site_id": fixture.site_id, "page": fixture.hub_slug}),
    );
    let inbound = to
        .connections
        .iter()
        .map(|row| row.from_page_id)
        .collect::<Vec<_>>();
    assert!(
        inbound.contains(&fixture.peer_page_id),
        "inbound edges from viewable pages must be preserved",
    );
    assert!(
        !inbound.contains(&fixture.stalker_page_id),
        "inbound edges from non-viewable pages must be filtered",
    );

    let missing = run_endpoint!(
        runner,
        page_links_to_missing_get,
        json!({"site_id": fixture.site_id, "page_slug": fixture.missing_slug}),
    );
    assert!(
        missing
            .connections
            .iter()
            .any(|row| row.from_page_id == fixture.hub_page_id),
        "missing-slug inbound rows from viewable pages must be preserved",
    );

    let existing_viewable = run_endpoint_err!(
        runner,
        page_links_to_missing_get,
        json!({"site_id": fixture.site_id, "page_slug": fixture.hub_slug}),
    );
    assert_contains_error!(existing_viewable, ErrorType::PageLink);

    let urls = run_endpoint!(
        runner,
        page_links_external_to,
        json!({"site_id": fixture.site_id, "url": fixture.external_url}),
    );
    assert!(
        urls.links
            .iter()
            .any(|row| row.page_id == fixture.hub_page_id),
        "external-URL inbound rows from viewable pages must be preserved",
    );

    for user_id in [None, Some(fixture.outsider_user_id)] {
        act_as(&mut runner, &fixture, user_id);

        let missing = run_endpoint!(
            runner,
            page_links_to_missing_get,
            json!({"site_id": fixture.site_id, "page_slug": fixture.missing_slug}),
        );
        assert!(
            missing.connections.is_empty(),
            "missing-slug inbound rows from non-viewable pages must be filtered",
        );

        let existing_hidden = run_endpoint!(
            runner,
            page_links_to_missing_get,
            json!({"site_id": fixture.site_id, "page_slug": fixture.hub_slug}),
        );
        assert!(
            existing_hidden.connections.is_empty(),
            "existing-but-non-viewable slugs must behave like missing slugs",
        );

        let urls = run_endpoint!(
            runner,
            page_links_external_to,
            json!({"site_id": fixture.site_id, "url": fixture.external_url}),
        );
        assert!(
            urls.links.is_empty(),
            "external-URL inbound rows from non-viewable pages must be filtered",
        );

        let unknown = run_endpoint!(
            runner,
            page_links_external_to,
            json!({"site_id": fixture.site_id, "url": "https://unknown.example.invalid/"}),
        );
        assert!(unknown.links.is_empty(), "unknown URLs must stay empty");
    }
}
