/*
 * tests/cycle3_f3_attribution.rs
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

// Regression tests for C3W2L2-1: page attributions feed the page-author
// virtual role (all five page actions), so writing them must require the
// Delete + Rename standing they grant, scoped to the page's category.

#[macro_use]
mod common;

use self::common::TestRunner;
use cuid2::cuid;
use deepwell::constants::{ADMIN_USER_ID, SYSTEM_USER_ID};
use deepwell::error::ErrorType;
use deepwell::services::RequestContext;
use deepwell::services::page::CreatePage;
use deepwell::services::relation::{
    CreateSiteMember, PageAttributionEntry, PageAttributionKind, PageAttributionMetadata,
    RelationService, SetPageAttributions, SiteMemberAccepted, SiteMemberData,
};
use deepwell::services::user::{CreateUser, UserService};
use deepwell::services::{PageService, ServiceContext};
use deepwell::types::{Reference, UserType};
use serde_json::json;
use str_macro::str;

async fn create_member(runner: &TestRunner, site_id: i64, tag: &str) -> i64 {
    let n = cuid();
    let user_id = UserService::create(
        runner.context(),
        CreateUser {
            user_type: UserType::Regular,
            name: format!("Attribution Test {tag} {n}"),
            email: format!("attribution-test-{tag}-{n}@email.com"),
            locales: vec![str!("en")],
            password: String::from("password-fixture"),
            bypass_filter: true,
            bypass_email_verification: true,
            override_user_id: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("failed to create test user")
    .user_id;

    RelationService::create_site_member(
        runner.context(),
        CreateSiteMember {
            site_id,
            user_id,
            metadata: SiteMemberData {
                accepted: SiteMemberAccepted::SelfJoined,
            },
            created_by: SYSTEM_USER_ID,
        },
        common::IP_ADDRESS,
    )
    .await
    .expect("failed to make test user a member");

    user_id
}

async fn create_page(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    slug: String,
    user_id: i64,
) -> i64 {
    PageService::create(
        ctx,
        CreatePage {
            site_id,
            wikitext: String::from("Attribution gate fixture."),
            title: String::from("Attribution Gate Fixture"),
            alt_title: None,
            tags: Vec::new(),
            slug,
            layout: None,
            revision_comments: String::from("create attribution gate fixture"),
            user_id,
            bypass_filter: true,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("failed to create fixture page")
    .page_id
}

fn attribution_params(
    site_id: i64,
    page_id: i64,
    updated_by: i64,
    user_id: i64,
) -> serde_json::Value {
    json!({
        "site_id": site_id,
        "page": page_id,
        "updated_by": updated_by,
        "attributions": [{
            "user_id": user_id,
            "metadata": {
                "attribution_type": "author",
                "attribution_date": "2026-08-13",
            },
        }],
    })
}

#[tokio::test]
async fn member_cannot_self_attribute_on_editable_page() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("seeded test site should exist")
        .site;
    let member_id = create_member(&runner, site.site_id, "self").await;
    let page_id = create_page(
        runner.context(),
        site.site_id,
        format!("attribution-gate-{}", cuid()),
        ADMIN_USER_ID,
    )
    .await;

    runner.set_request_context(RequestContext {
        user_id: Some(member_id),
        site_id: Some(site.site_id),
        ..Default::default()
    });
    let error = run_endpoint_err!(
        runner,
        page_attribution_update,
        attribution_params(site.site_id, page_id, member_id, member_id),
    );
    assert_contains_error!(error, ErrorType::PermissionDenied);
}

#[tokio::test]
async fn admin_can_update_page_attributions() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("seeded test site should exist")
        .site;
    let member_id = create_member(&runner, site.site_id, "admin").await;
    let page_id = create_page(
        runner.context(),
        site.site_id,
        format!("attribution-gate-{}", cuid()),
        ADMIN_USER_ID,
    )
    .await;

    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site.site_id),
        ..Default::default()
    });
    let attributions = run_endpoint!(
        runner,
        page_attribution_update,
        attribution_params(site.site_id, page_id, ADMIN_USER_ID, member_id),
    );
    assert_eq!(attributions.len(), 1);
    assert_eq!(attributions[0].user_id, member_id);
}

#[tokio::test]
async fn page_author_cannot_rewrite_attributions() {
    // The gate must not count the page-author role itself: otherwise the
    // role sustains its own membership and any author mints new holders
    // of Delete + Rename.
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("seeded test site should exist")
        .site;
    let author_id = create_member(&runner, site.site_id, "author").await;
    let other_id = create_member(&runner, site.site_id, "other").await;
    let page_id = create_page(
        runner.context(),
        site.site_id,
        format!("attribution-gate-{}", cuid()),
        ADMIN_USER_ID,
    )
    .await;

    RelationService::set_page_attributions(
        runner.context(),
        SetPageAttributions {
            site_id: site.site_id,
            page: Reference::Id(page_id),
            updated_by: SYSTEM_USER_ID,
            attributions: vec![PageAttributionEntry {
                user_id: author_id,
                metadata: PageAttributionMetadata {
                    attribution_type: PageAttributionKind::Author,
                    attribution_date: time::Date::from_calendar_date(
                        2026,
                        time::Month::August,
                        13,
                    )
                    .expect("fixture attribution date should be valid"),
                },
            }],
        },
    )
    .await
    .expect("fixture attribution should be set");

    // The seeded authorship must actually grant page powers, or the test
    // below would pass vacuously.
    let can_delete = deepwell::services::permission::PermissionService::check_user_can(
        runner.context(),
        &deepwell::services::permission::CheckPermissionContext {
            user_id: Some(author_id),
            site_id: site.site_id,
            page_reference: Some(Reference::Id(page_id)),
        },
        deepwell::types::Permission {
            resource_type: deepwell::types::Resource::Page,
            resource_category: None,
            action: deepwell::types::Action::Delete,
        },
    )
    .await
    .expect("permission check should run");
    assert!(
        can_delete,
        "seeded author should hold Delete via page-author"
    );

    runner.set_request_context(RequestContext {
        user_id: Some(author_id),
        site_id: Some(site.site_id),
        ..Default::default()
    });
    let error = run_endpoint_err!(
        runner,
        page_attribution_update,
        attribution_params(site.site_id, page_id, author_id, other_id),
    );
    assert_contains_error!(error, ErrorType::PermissionDenied);
}
