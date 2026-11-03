/*
 * tests/page_lifecycle_identity.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

#[macro_use]
mod common;

use self::common::TestRunner;
use deepwell::constants::ADMIN_USER_ID;
use deepwell::services::RequestContext;
use deepwell::types::Reference;
use sea_orm::{ConnectionTrait, Statement, Value};
use serde_json::json;
use std::borrow::Cow;

struct CreatedPage {
    page_id: i64,
    revision_id: i64,
    slug: &'static str,
}

async fn create_page(
    runner: &mut TestRunner,
    site_id: i64,
    slug: &'static str,
) -> CreatedPage {
    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(Cow::Borrowed(slug))),
        ..Default::default()
    });
    let page = run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": site_id,
            "wikitext": format!("Lifecycle identity fixture for {slug}"),
            "title": format!("Lifecycle identity fixture for {slug}"),
            "alt_title": null,
            "slug": slug,
            "layout": "wikidot",
            "revision_comments": "create lifecycle identity fixture",
            "user_id": ADMIN_USER_ID,
            "bypass_filter": true,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    CreatedPage {
        page_id: page.page_id,
        revision_id: page.revision_id,
        slug,
    }
}

async fn install_imported_snapshot(
    runner: &TestRunner,
    site_id: i64,
    page: &CreatedPage,
    import_run_id: i64,
    source_uuid: &str,
    created_by: Option<&str>,
    updated_by: Option<&str>,
) {
    let txn = runner.context().transaction();
    for statement in [
        Statement::from_sql_and_values(
            txn.get_database_backend(),
            "UPDATE page SET from_wikidot = TRUE WHERE site_id = $1 AND page_id = $2",
            [Value::from(site_id), Value::from(page.page_id)],
        ),
        Statement::from_sql_and_values(
            txn.get_database_backend(),
            "UPDATE page_revision SET from_wikidot = TRUE WHERE site_id = $1 AND revision_id = $2",
            [Value::from(site_id), Value::from(page.revision_id)],
        ),
        Statement::from_sql_and_values(
            txn.get_database_backend(),
            r#"
INSERT INTO wikidot_corpus_import_run (
    import_run_id, site_id, source_branch, source_site, manifest_sha256,
    manifest_row_count, complete_inventory, state, summary
) VALUES (
    $1, $2, 'lifecycle-identity-test', $3,
    decode(repeat('7a', 32), 'hex'), 1, FALSE, 'metadata_done', '{}'::jsonb
)
"#,
            [
                Value::from(import_run_id),
                Value::from(site_id),
                Value::from("lifecycle-identity-test"),
            ],
        ),
        Statement::from_sql_and_values(
            txn.get_database_backend(),
            r#"
INSERT INTO wikidot_page_snapshot (
    page_id, source_branch, source_site, source_entity_id, source_fullname,
    source_created_at, source_updated_at, source_revision_count,
    imported_rating, created_by_name, updated_by_name, comments,
    source_sha256, meta_sha256, meta_json, last_import_run_id
) VALUES (
    $1, 'lifecycle-identity-test', $2, $3::uuid, $4, NOW(), NOW(), 1,
    0, $5, $6, 0, decode(repeat('7b', 32), 'hex'),
    decode(repeat('7c', 32), 'hex'), '{}'::jsonb, $7
)
"#,
            [
                Value::from(page.page_id),
                Value::from("lifecycle-identity-test"),
                Value::from(source_uuid.to_owned()),
                Value::from(page.slug.to_owned()),
                Value::from(created_by.map(str::to_owned)),
                Value::from(updated_by.map(str::to_owned)),
                Value::from(import_run_id),
            ],
        ),
    ] {
        txn.execute_raw(statement)
            .await
            .expect("lifecycle identity fixture SQL should succeed");
    }
}

fn view_as_anonymous(runner: &mut TestRunner, site_id: i64, slug: &'static str) {
    runner.set_request_context(RequestContext {
        user_id: None,
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(Cow::Borrowed(slug))),
        ..Default::default()
    });
}

#[tokio::test]
async fn lifecycle_identity_preserves_imported_native_and_mixed_display_names() {
    const NATIVE: &str = "lifecycle-identity-native-slug";
    const IMPORTED: &str = "lifecycle-identity-imported-slug";
    const MIXED: &str = "lifecycle-identity-mixed-slug";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;

    let native = create_page(&mut runner, site_id, NATIVE).await;
    view_as_anonymous(&mut runner, site_id, NATIVE);
    let native_identity = run_endpoint!(
        runner,
        page_lifecycle_identity,
        json!({"site_id": site_id, "page": NATIVE}),
    )
    .expect("native lifecycle identity should be available");
    assert_eq!(native_identity.created_by.as_deref(), Some("Administrator"));
    assert_eq!(native_identity.updated_by.as_deref(), Some("Administrator"));
    assert_ne!(native_identity.created_by.as_deref(), Some("administrator"));
    assert_ne!(native_identity.created_by.as_deref(), Some(native.slug));

    let imported = create_page(&mut runner, site_id, IMPORTED).await;
    install_imported_snapshot(
        &runner,
        site_id,
        &imported,
        8_130_101,
        "81301010-0000-4000-8000-000000000001",
        Some("Snapshot Creator Display"),
        Some("Snapshot Updater Display"),
    )
    .await;
    view_as_anonymous(&mut runner, site_id, IMPORTED);
    let imported_identity = run_endpoint!(
        runner,
        page_lifecycle_identity,
        json!({"site_id": site_id, "page": IMPORTED}),
    )
    .expect("imported lifecycle identity should be available");
    assert_eq!(
        imported_identity.created_by.as_deref(),
        Some("Snapshot Creator Display")
    );
    assert_eq!(
        imported_identity.updated_by.as_deref(),
        Some("Snapshot Updater Display")
    );
    assert_ne!(imported_identity.created_by.as_deref(), Some(imported.slug));

    let mixed = create_page(&mut runner, site_id, MIXED).await;
    install_imported_snapshot(
        &runner,
        site_id,
        &mixed,
        8_130_102,
        "81301020-0000-4000-8000-000000000002",
        Some("Imported Founder Display"),
        Some("Imported Prior Updater"),
    )
    .await;
    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(Cow::Borrowed(MIXED))),
        ..Default::default()
    });
    let edit_lease_14 = common::acquire_page_edit_lease(
        &runner,
        site_id,
        &serde_json::json!(MIXED),
        ADMIN_USER_ID,
    )
    .await;
    run_endpoint!(
        runner,
        page_edit,
        json!({
            "lease": edit_lease_14,
            "site_id": site_id,
            "page": MIXED,
            "last_revision_id": mixed.revision_id,
            "revision_comments": "native edit after import",
            "user_id": ADMIN_USER_ID,
            "wikitext": "Locally edited imported page",
            "ip_address": common::IP_ADDRESS,
        }),
    );
    view_as_anonymous(&mut runner, site_id, MIXED);
    let mixed_identity = run_endpoint!(
        runner,
        page_lifecycle_identity,
        json!({"site_id": site_id, "page": MIXED}),
    )
    .expect("mixed lifecycle identity should be available");
    assert_eq!(
        mixed_identity.created_by.as_deref(),
        Some("Imported Founder Display")
    );
    assert_eq!(mixed_identity.updated_by.as_deref(), Some("Administrator"));
}

#[tokio::test]
async fn lifecycle_identity_never_falls_back_for_missing_deleted_or_incomplete_people() {
    const MISSING: &str = "lifecycle-identity-missing-person";
    const INCOMPLETE: &str = "lifecycle-identity-incomplete-snapshot";
    const DELETED: &str = "lifecycle-identity-deleted-person";
    const UNKNOWN_USER_ID: i64 = 8_130_199;

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;

    let missing = create_page(&mut runner, site_id, MISSING).await;
    let txn = runner.context().transaction();
    for statement in [
        Statement::from_sql_and_values(
            txn.get_database_backend(),
            "INSERT INTO known_user (user_id) VALUES ($1)",
            [Value::from(UNKNOWN_USER_ID)],
        ),
        Statement::from_sql_and_values(
            txn.get_database_backend(),
            "UPDATE page_revision SET user_id = $1 WHERE site_id = $2 AND page_id = $3",
            [
                Value::from(UNKNOWN_USER_ID),
                Value::from(site_id),
                Value::from(missing.page_id),
            ],
        ),
    ] {
        txn.execute_raw(statement)
            .await
            .expect("missing identity fixture SQL should succeed");
    }
    view_as_anonymous(&mut runner, site_id, MISSING);
    let missing_identity = run_endpoint!(
        runner,
        page_lifecycle_identity,
        json!({"site_id": site_id, "page": MISSING}),
    )
    .expect("the page should remain viewable");
    assert_eq!(missing_identity.created_by, None);
    assert_eq!(missing_identity.updated_by, None);

    let incomplete = create_page(&mut runner, site_id, INCOMPLETE).await;
    install_imported_snapshot(
        &runner,
        site_id,
        &incomplete,
        8_130_103,
        "81301030-0000-4000-8000-000000000003",
        Some("   "),
        Some("Snapshot Updater Display"),
    )
    .await;
    view_as_anonymous(&mut runner, site_id, INCOMPLETE);
    let incomplete_identity = run_endpoint!(
        runner,
        page_lifecycle_identity,
        json!({"site_id": site_id, "page": INCOMPLETE}),
    )
    .expect("the imported page should remain viewable");
    assert_eq!(incomplete_identity.created_by, None);
    assert_eq!(
        incomplete_identity.updated_by.as_deref(),
        Some("Snapshot Updater Display")
    );

    create_page(&mut runner, site_id, DELETED).await;
    let txn = runner.context().transaction();
    txn.execute_raw(Statement::from_sql_and_values(
        txn.get_database_backend(),
        "UPDATE \"user\" SET deleted_at = NOW() WHERE user_id = $1",
        [Value::from(ADMIN_USER_ID)],
    ))
    .await
    .expect("deleted identity fixture SQL should succeed");
    view_as_anonymous(&mut runner, site_id, DELETED);
    let deleted_identity = run_endpoint!(
        runner,
        page_lifecycle_identity,
        json!({"site_id": site_id, "page": DELETED}),
    )
    .expect("the page should remain viewable after its actor is deleted");
    assert_eq!(deleted_identity.created_by, None);
    assert_eq!(deleted_identity.updated_by, None);
}

#[tokio::test]
async fn native_lifecycle_identity_uses_display_name_without_requiring_a_slug() {
    const PAGE: &str = "lifecycle-identity-display-name-only";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    create_page(&mut runner, site_id, PAGE).await;

    let txn = runner.context().transaction();
    txn.execute_raw(Statement::from_sql_and_values(
        txn.get_database_backend(),
        "UPDATE \"user\" SET slug = '' WHERE user_id = $1",
        [Value::from(ADMIN_USER_ID)],
    ))
    .await
    .expect("slugless native identity fixture SQL should succeed");

    view_as_anonymous(&mut runner, site_id, PAGE);
    let identity = run_endpoint!(
        runner,
        page_lifecycle_identity,
        json!({"site_id": site_id, "page": PAGE}),
    )
    .expect("display-name-complete identity should remain available");
    assert_eq!(identity.created_by.as_deref(), Some("Administrator"));
    assert_eq!(identity.updated_by.as_deref(), Some("Administrator"));
}

#[tokio::test]
async fn lifecycle_identity_hides_missing_pages() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    runner.set_request_context(RequestContext::default());
    assert!(
        run_endpoint!(
            runner,
            page_lifecycle_identity,
            json!({"site_id": site.site.site_id, "page": "absent-lifecycle-page"}),
        )
        .is_none()
    );
}
