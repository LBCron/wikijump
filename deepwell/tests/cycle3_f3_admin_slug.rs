/*
 * tests/cycle3_f3_admin_slug.rs
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

// Regression tests for C3W2L2-4: the `_admin` slug is read-gated on
// Site/Edit, and the write paths must apply the same check.

#[macro_use]
mod common;

use self::common::TestRunner;
use cuid2::cuid;
use deepwell::constants::{ADMIN_USER_ID, SYSTEM_USER_ID};
use deepwell::error::ErrorType;
use deepwell::services::PageService;
use deepwell::services::RequestContext;
use deepwell::services::page::CreatePage;
use deepwell::services::relation::{
    CreateSiteMember, RelationService, SiteMemberAccepted, SiteMemberData,
};
use deepwell::services::role::{GrantUserRoleInput, RoleService};
use deepwell::services::user::{CreateUser, UserService};
use deepwell::types::{Reference, UserType};
use serde_json::json;
use str_macro::str;

async fn create_member(runner: &TestRunner, site_id: i64, tag: &str) -> i64 {
    let n = cuid();
    let user_id = UserService::create(
        runner.context(),
        CreateUser {
            user_type: UserType::Regular,
            name: format!("Admin Slug Test {tag} {n}"),
            email: format!("admin-slug-test-{tag}-{n}@email.com"),
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

async fn grant_moderator(runner: &TestRunner, site_id: i64, user_id: i64) {
    // Moderators hold page Delete but not Site/Edit: the actor that reaches
    // the delete/restore gates without admin standing.
    let role = RoleService::get(
        runner.context(),
        site_id,
        Reference::Slug("moderator".into()),
    )
    .await
    .expect("seeded moderator role should exist");
    RoleService::grant_role_to_user(
        runner.context(),
        GrantUserRoleInput {
            site_id,
            user_id,
            role_id: role.role_id,
            assigning_user_id: SYSTEM_USER_ID,
            expires_at: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("failed to grant moderator role");
}

async fn get_or_create_admin_page(runner: &TestRunner, site_id: i64) -> i64 {
    if let Some(page) = PageService::get_optional(
        runner.context(),
        site_id,
        Reference::Slug("_admin".into()),
    )
    .await
    .expect("admin page lookup should run")
    {
        return page.page_id;
    }

    PageService::create(
        runner.context(),
        CreatePage {
            site_id,
            wikitext: String::from("Admin panel fixture."),
            title: String::from("Admin Panel"),
            alt_title: None,
            tags: Vec::new(),
            slug: String::from("_admin"),
            layout: None,
            revision_comments: String::from("create admin page fixture"),
            user_id: ADMIN_USER_ID,
            bypass_filter: true,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("failed to create admin page fixture")
    .page_id
}

async fn latest_revision(runner: &TestRunner, site_id: i64, page_id: i64) -> i64 {
    PageService::get(runner.context(), site_id, Reference::Id(page_id))
        .await
        .expect("fixture page should exist")
        .latest_revision_id
        .expect("fixture page should have a revision")
}

fn as_user(runner: &mut TestRunner, user_id: i64, site_id: i64) {
    runner.set_request_context(RequestContext {
        user_id: Some(user_id),
        site_id: Some(site_id),
        ..Default::default()
    });
}

#[tokio::test]
async fn member_cannot_edit_admin_page() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("seeded test site should exist")
        .site;
    let member_id = create_member(&runner, site.site_id, "edit").await;
    let page_id = get_or_create_admin_page(&runner, site.site_id).await;
    let revision_id = latest_revision(&runner, site.site_id, page_id).await;

    as_user(&mut runner, member_id, site.site_id);
    let error = run_endpoint_err!(
        runner,
        page_edit,
        json!({
            "site_id": site.site_id,
            "page": page_id,
            "last_revision_id": revision_id,
            "revision_comments": "member overwrites admin title",
            "user_id": member_id,
            "title": "Member Wrote This",
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(error, ErrorType::PermissionDenied);
}

#[tokio::test]
async fn member_cannot_create_admin_slug() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("seeded test site should exist")
        .site;
    let member_id = create_member(&runner, site.site_id, "create").await;
    let page_id = get_or_create_admin_page(&runner, site.site_id).await;
    let revision_id = latest_revision(&runner, site.site_id, page_id).await;

    as_user(&mut runner, ADMIN_USER_ID, site.site_id);
    run_endpoint!(
        runner,
        page_delete,
        json!({
            "site_id": site.site_id,
            "page": page_id,
            "last_revision_id": revision_id,
            "revision_comments": "free the admin slug for the squat test",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    as_user(&mut runner, member_id, site.site_id);
    let error = run_endpoint_err!(
        runner,
        page_create,
        json!({
            "site_id": site.site_id,
            "wikitext": "Member squat body.",
            "title": "Member Squat",
            "alt_title": null,
            "slug": "_admin",
            "layout": null,
            "revision_comments": "squat the admin slug",
            "user_id": member_id,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(error, ErrorType::PermissionDenied);
}

#[tokio::test]
async fn moderator_cannot_delete_admin_page() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("seeded test site should exist")
        .site;
    let moderator_id = create_member(&runner, site.site_id, "delete").await;
    grant_moderator(&runner, site.site_id, moderator_id).await;
    let page_id = get_or_create_admin_page(&runner, site.site_id).await;
    let revision_id = latest_revision(&runner, site.site_id, page_id).await;

    as_user(&mut runner, moderator_id, site.site_id);
    let error = run_endpoint_err!(
        runner,
        page_delete,
        json!({
            "site_id": site.site_id,
            "page": page_id,
            "last_revision_id": revision_id,
            "revision_comments": "moderator deletes admin page",
            "user_id": moderator_id,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(error, ErrorType::PermissionDenied);
}

#[tokio::test]
async fn moderator_cannot_restore_admin_page() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("seeded test site should exist")
        .site;
    let moderator_id = create_member(&runner, site.site_id, "restore").await;
    grant_moderator(&runner, site.site_id, moderator_id).await;
    let page_id = get_or_create_admin_page(&runner, site.site_id).await;
    let revision_id = latest_revision(&runner, site.site_id, page_id).await;

    as_user(&mut runner, ADMIN_USER_ID, site.site_id);
    run_endpoint!(
        runner,
        page_delete,
        json!({
            "site_id": site.site_id,
            "page": page_id,
            "last_revision_id": revision_id,
            "revision_comments": "delete the admin page for the restore test",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    as_user(&mut runner, moderator_id, site.site_id);
    let error = run_endpoint_err!(
        runner,
        page_restore,
        json!({
            "site_id": site.site_id,
            "page_id": page_id,
            "revision_comments": "moderator restores admin page",
            "user_id": moderator_id,
            "slug": null,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(error, ErrorType::PermissionDenied);

    as_user(&mut runner, ADMIN_USER_ID, site.site_id);
    run_endpoint!(
        runner,
        page_restore,
        json!({
            "site_id": site.site_id,
            "page_id": page_id,
            "revision_comments": "admin restores admin page",
            "user_id": ADMIN_USER_ID,
            "slug": null,
            "ip_address": common::IP_ADDRESS,
        }),
    );
}

#[tokio::test]
async fn admin_can_edit_admin_page() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("seeded test site should exist")
        .site;
    let page_id = get_or_create_admin_page(&runner, site.site_id).await;
    let revision_id = latest_revision(&runner, site.site_id, page_id).await;

    as_user(&mut runner, ADMIN_USER_ID, site.site_id);
    run_endpoint!(
        runner,
        page_edit,
        json!({
            "site_id": site.site_id,
            "page": page_id,
            "last_revision_id": revision_id,
            "revision_comments": "admin updates admin title",
            "user_id": ADMIN_USER_ID,
            "title": "Admin Panel Updated",
            "ip_address": common::IP_ADDRESS,
        }),
    );
}
