/*
 * tests/page_edit_lock_api.rs
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
use deepwell::constants::ADMIN_USER_ID;
use deepwell::error::ErrorType;
use deepwell::services::RequestContext;
use deepwell::types::{PageEditLockMode, Reference};
use serde_json::json;
use std::borrow::Cow;

const SITE_SLUG: &str = "scpaiueouiuiuiui";
const USER: i64 = ADMIN_USER_ID;

fn set_request_context(runner: &mut TestRunner, site_id: i64, slug: &str) {
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(USER),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(Cow::Owned(slug.to_owned()))),
    });
}

async fn setup_page(runner: &mut TestRunner, slug: &str) -> (i64, i64, i64) {
    let site = run_endpoint!(runner, site_get, json!({ "site": SITE_SLUG }))
        .expect("editable authoring site should exist")
        .site;
    let site_id = site.site_id;

    set_request_context(runner, site_id, slug);
    let created = run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": site_id,
            "wikitext": format!("Edit lock API test page {slug}."),
            "title": format!("Edit lock API test {slug}"),
            "alt_title": null,
            "slug": slug,
            "layout": "wikidot",
            "revision_comments": "edit lock API test create",
            "user_id": USER,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    (site_id, created.page_id, created.revision_id)
}

#[tokio::test]
async fn page_edit_lock_endpoints_grant_conflict_renew_release() {
    const SLUG: &str = "edit-lock-api-lifecycle";

    let mut runner = TestRunner::setup().await;
    let (_site_id, page_id, revision_id) = setup_page(&mut runner, SLUG).await;

    let acquired = run_endpoint!(
        runner,
        page_edit_lock_acquire,
        json!({ "page": page_id, "mode": "page" }),
    );
    assert!(acquired.conflicts.is_empty());
    let grant = acquired.grant.expect("first acquire should grant");
    assert_eq!(grant.base_revision_id, Some(revision_id));
    let lock_id = grant.lock_id;
    let secret = grant.lock_secret.clone();

    let conflicted = run_endpoint!(
        runner,
        page_edit_lock_acquire,
        json!({ "page": page_id, "mode": "page" }),
    );
    assert!(conflicted.grant.is_none());
    assert_eq!(conflicted.conflicts.len(), 1);
    let conflict = &conflicted.conflicts[0];
    assert_eq!(conflict.user_id, USER);
    assert_eq!(conflict.mode, PageEditLockMode::Page);
    assert!(conflict.seconds_remaining > 0 && conflict.seconds_remaining <= 900);

    let renew_error = run_endpoint_err!(
        runner,
        page_edit_lock_renew,
        json!({ "page": page_id, "mode": "page", "lock_id": lock_id, "lock_secret": "wrong-secret-value" }),
    );
    assert_contains_error!(renew_error, ErrorType::PageEditLockConflict);

    let renewed = run_endpoint!(
        runner,
        page_edit_lock_renew,
        json!({ "page": page_id, "mode": "page", "lock_id": lock_id, "lock_secret": secret }),
    );
    assert!(!renewed.lock_recreated);
    assert_eq!(renewed.lock_id, lock_id);
    assert_eq!(renewed.base_revision_id, Some(revision_id));

    let forced = run_endpoint!(
        runner,
        page_edit_lock_force_acquire,
        json!({ "page": page_id, "mode": "page" }),
    );
    let forced_grant = forced.grant.expect("force acquire should grant");
    assert_ne!(forced_grant.lock_id, lock_id);
    let forced_secret = forced_grant.lock_secret.clone();

    let stale_release = run_endpoint!(
        runner,
        page_edit_lock_release,
        json!({ "page": page_id, "lock_id": lock_id, "lock_secret": secret }),
    );
    assert!(!stale_release);

    let released = run_endpoint!(
        runner,
        page_edit_lock_release,
        json!({ "page": page_id, "lock_id": forced_grant.lock_id, "lock_secret": forced_secret }),
    );
    assert!(released);

    let reacquired = run_endpoint!(
        runner,
        page_edit_lock_acquire,
        json!({ "page": page_id, "mode": "page" }),
    );
    assert!(reacquired.grant.is_some());
}

#[tokio::test]
async fn page_edit_endpoint_requires_a_lease_for_source_saves() {
    const SLUG: &str = "edit-lock-api-flip";

    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, revision_id) = setup_page(&mut runner, SLUG).await;

    let leaseless = run_endpoint_err!(
        runner,
        page_edit,
        json!({
            "site_id": site_id,
            "page": page_id,
            "last_revision_id": revision_id,
            "revision_comments": "leaseless api edit",
            "user_id": USER,
            "wikitext": "leaseless v1",
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(leaseless, ErrorType::PageEditLockConflict);

    let acquired = run_endpoint!(
        runner,
        page_edit_lock_acquire,
        json!({ "page": page_id, "mode": "page" }),
    );
    let grant = acquired.grant.expect("acquire should grant");

    let output = run_endpoint!(
        runner,
        page_edit,
        json!({
            "site_id": site_id,
            "page": page_id,
            "last_revision_id": revision_id,
            "revision_comments": "leased api edit",
            "user_id": USER,
            "wikitext": "leased v1",
            "ip_address": common::IP_ADDRESS,
            "lease": {
                "lock_id": grant.lock_id,
                "lock_secret": grant.lock_secret,
                "mode": "page",
            },
        }),
    )
    .expect("leased api edit should create a revision");
    assert_eq!(output.revision_number, 1);
}
