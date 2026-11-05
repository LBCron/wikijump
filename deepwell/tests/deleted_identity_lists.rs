/*
 * tests/deleted_identity_lists.rs
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
use deepwell::constants::{ADMIN_USER_ID, SAMPLE_USER_ID, SYSTEM_USER_ID};
use deepwell::services::RequestContext;
use deepwell::services::membership::{
    MembershipApplicationData, MembershipApplicationStatus, MembershipService,
};
use deepwell::services::page::{CreatePage, PageService};
use deepwell::services::relation::{CreatePageWatch, RelationObject, RelationService};
use deepwell::types::RelationType;
use serde_json::json;

fn admin_context() -> RequestContext {
    RequestContext {
        user_id: Some(ADMIN_USER_ID),
        ..Default::default()
    }
}

async fn create_user(runner: &mut TestRunner, name: &str, email: &str) -> i64 {
    runner.set_request_context(admin_context());
    let created = run_endpoint!(
        runner,
        user_create,
        json!({
            "user_type": "regular",
            "name": name,
            "email": email,
            "locales": ["en"],
            "password": "password-fixture",
            "ip_address": common::IP_ADDRESS,
        }),
    );
    created.user_id
}

async fn delete_user(runner: &mut TestRunner, user_id: i64) {
    runner.set_request_context(admin_context());
    let deleted = run_endpoint!(
        runner,
        user_delete,
        json!({
            "user": user_id,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert!(deleted.deleted_at.is_some());
}

#[tokio::test]
async fn membership_application_list_skips_deleted_applicants() {
    let mut runner = TestRunner::setup().await;
    runner.set_request_context(admin_context());
    let site_id = run_endpoint!(runner, site_get, json!({ "site": "test" }))
        .expect("seeded test site should exist")
        .site
        .site_id;

    let deleted_applicant = create_user(
        &mut runner,
        "Deleted Application Applicant",
        "deleted-application-applicant@example.invalid",
    )
    .await;
    let surviving_applicant = create_user(
        &mut runner,
        "Surviving Application Applicant",
        "surviving-application-applicant@example.invalid",
    )
    .await;

    for applicant_id in [deleted_applicant, surviving_applicant] {
        RelationService::create(
            runner.context(),
            RelationType::SiteApplication,
            RelationObject::Site(site_id),
            RelationObject::User(applicant_id),
            ADMIN_USER_ID,
            &MembershipApplicationData {
                status: MembershipApplicationStatus::Pending,
                comment: "application fixture".to_owned(),
                reply: None,
            },
        )
        .await
        .expect("application fixture should insert");
    }

    let applications = MembershipService::list_applications(runner.context(), site_id)
        .await
        .expect("application list should resolve with two live applicants");
    assert_eq!(applications.len(), 2);

    delete_user(&mut runner, deleted_applicant).await;

    let applications = MembershipService::list_applications(runner.context(), site_id)
        .await
        .expect("application list should resolve after an applicant is deleted");
    assert_eq!(applications.len(), 1);
    assert_eq!(applications[0].user_id, surviving_applicant);
    assert_eq!(applications[0].user_name, "Surviving Application Applicant");
}

#[tokio::test]
async fn page_watchers_skips_deleted_watchers() {
    let mut runner = TestRunner::setup().await;
    runner.set_request_context(admin_context());
    let site_id = run_endpoint!(runner, site_get, json!({ "site": "test" }))
        .expect("seeded test site should exist")
        .site
        .site_id;

    let page = PageService::create(
        runner.context(),
        CreatePage {
            site_id,
            wikitext: "watcher list fixture".to_owned(),
            title: "Deleted Watcher List Fixture".to_owned(),
            alt_title: None,
            tags: Vec::new(),
            slug: "fixture-deleted-watcher-list".to_owned(),
            layout: None,
            revision_comments: "Create deleted watcher list fixture".to_owned(),
            user_id: SYSTEM_USER_ID,
            bypass_filter: true,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("watcher list page should be created");

    let deleted_watcher = create_user(
        &mut runner,
        "Deleted Page Watcher",
        "deleted-page-watcher@example.invalid",
    )
    .await;

    for watcher_id in [deleted_watcher, SAMPLE_USER_ID] {
        RelationService::create_page_watch(
            runner.context(),
            CreatePageWatch {
                page_id: page.page_id,
                user_id: watcher_id,
                created_by: ADMIN_USER_ID,
            },
        )
        .await
        .expect("page watcher fixture should insert");
    }

    runner.set_request_context(RequestContext::default());
    let watchers = run_endpoint!(
        runner,
        page_watchers,
        json!({ "site_id": site_id, "page_id": page.page_id }),
    );
    assert_eq!(watchers.len(), 2);

    delete_user(&mut runner, deleted_watcher).await;

    runner.set_request_context(RequestContext::default());
    let watchers = run_endpoint!(
        runner,
        page_watchers,
        json!({ "site_id": site_id, "page_id": page.page_id }),
    );
    assert_eq!(watchers.len(), 1);
    assert_eq!(watchers[0].user_id, SAMPLE_USER_ID);
}
