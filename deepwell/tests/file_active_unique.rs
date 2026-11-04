/*
 * tests/file_active_unique.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use cuid2::cuid;
use deepwell::api::{ServerState, build_server_at, build_server_state_without_workers};
use deepwell::config::{Config, Secrets};
use deepwell::constants::ADMIN_USER_ID;
use deepwell::error::ErrorType;
use deepwell::hash::{blob_hash_to_hex, sha512_hash};
use deepwell::models::audit_log::{self, Entity as AuditLog};
use deepwell::models::blob_pending::{self, Entity as BlobPending};
use deepwell::models::file::{self, Entity as File};
use deepwell::models::file_revision::{self, Entity as FileRevision};
use deepwell::models::session::Entity as Session;
use deepwell::services::session::{CreateSession, SessionService};
use deepwell::services::{PageService, ServiceContext, SiteService};
use deepwell::types::Reference;
use futures::FutureExt;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, DbErr, EntityTrait, QueryFilter, Set, SqlErr,
    TransactionTrait,
};
use serde_json::{Value, json};
use std::env;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::panic::{AssertUnwindSafe, resume_unwind};
use std::sync::Arc;
use std::time::Duration;
use time::{Duration as TimeDuration, OffsetDateTime};
use tokio::sync::Barrier;
use tokio::time::sleep;

const FILE_ACTIVE_UNIQUE_INDEX: &str = "file_active_page_name_unique";

async fn test_state() -> ServerState {
    build_server_state_without_workers(Config::integration_testing(), Secrets::load())
        .await
        .expect("test server state should build")
}

async fn test_site_page_ids(state: &ServerState) -> (i64, i64) {
    let transaction = state
        .database
        .begin()
        .await
        .expect("site lookup transaction should begin");
    let ctx = ServiceContext::new(state, &transaction);
    let site = SiteService::get(&ctx, Reference::from("test"))
        .await
        .expect("seeded test site should exist");
    let page = PageService::get(&ctx, site.site_id, Reference::from("home"))
        .await
        .expect("seeded test home page should exist");
    let ids = (site.site_id, page.page_id);
    transaction
        .rollback()
        .await
        .expect("site lookup transaction should roll back");
    ids
}

fn is_active_unique_violation(error: &DbErr) -> bool {
    matches!(
        error.sql_err(),
        Some(SqlErr::UniqueConstraintViolation(message))
            if message.contains(FILE_ACTIVE_UNIQUE_INDEX)
    )
}

#[tokio::test]
async fn concurrent_file_row_inserts_reject_the_second_active_name() {
    let state = test_state().await;
    let (site_id, page_id) = test_site_page_ids(&state).await;
    let name = format!("concurrent-create-{}.bin", cuid());

    let holder = state
        .database
        .begin()
        .await
        .expect("holder transaction should begin");
    file::ActiveModel {
        name: Set(name.clone()),
        page_id: Set(page_id),
        site_id: Set(site_id),
        ..Default::default()
    }
    .insert(&holder)
    .await
    .expect("holder file row should insert");

    let contender = async {
        let transaction = state
            .database
            .begin()
            .await
            .expect("contender transaction should begin");
        let result = file::ActiveModel {
            name: Set(name.clone()),
            page_id: Set(page_id),
            site_id: Set(site_id),
            ..Default::default()
        }
        .insert(&transaction)
        .await;
        transaction
            .rollback()
            .await
            .expect("contender transaction should roll back");
        result
    };
    let release = async {
        sleep(Duration::from_millis(300)).await;
        holder
            .commit()
            .await
            .expect("holder transaction should commit");
    };
    let (contender_result, _) = tokio::join!(contender, release);
    let error = contender_result.expect_err("second concurrent file insert should fail");
    assert!(
        is_active_unique_violation(&error),
        "loser should hit {FILE_ACTIVE_UNIQUE_INDEX}, got: {error:?}",
    );

    let actives = File::find()
        .filter(file::Column::PageId.eq(page_id))
        .filter(file::Column::Name.eq(&name))
        .filter(file::Column::DeletedAt.is_null())
        .all(&state.database)
        .await
        .expect("active file rows should be readable");
    assert_eq!(
        actives.len(),
        1,
        "exactly one active file row should survive the race",
    );

    File::delete_many()
        .filter(file::Column::PageId.eq(page_id))
        .filter(file::Column::Name.eq(&name))
        .exec(&state.database)
        .await
        .expect("race file row cleanup should succeed");
}

#[derive(Clone)]
struct PendingUpload {
    id: String,
    temporary_path: String,
    data: Vec<u8>,
}

struct FixtureCleanup {
    session_token: Option<String>,
    file_id: Option<i64>,
    uploads: [PendingUpload; 2],
}

impl FixtureCleanup {
    fn new() -> Self {
        let uploads = ["first", "second"].map(|label| {
            let id = cuid();
            PendingUpload {
                temporary_path: format!("uploads/{id}"),
                data: format!("concurrent file create {label} {id}").into_bytes(),
                id,
            }
        });
        Self {
            session_token: None,
            file_id: None,
            uploads,
        }
    }
}

struct Fixture {
    site_id: i64,
    page_id: i64,
    name: String,
    session_token: String,
    uploads: [PendingUpload; 2],
}

async fn create_fixture(state: &ServerState, cleanup: &mut FixtureCleanup) -> Fixture {
    for upload in &cleanup.uploads {
        let response = state
            .s3_files_bucket
            .put_object(&upload.temporary_path, &upload.data)
            .await
            .expect("pending file create upload should reach object storage");
        assert_eq!(response.status_code(), 200);
    }

    let transaction = state
        .database
        .begin()
        .await
        .expect("file create fixture transaction should begin");
    let ctx = ServiceContext::new(state, &transaction);
    let site = SiteService::get(&ctx, Reference::from("test"))
        .await
        .expect("seeded test site should exist");
    let page = PageService::get(&ctx, site.site_id, Reference::from("home"))
        .await
        .expect("seeded test home page should exist");

    let now = OffsetDateTime::now_utc();
    for upload in &cleanup.uploads {
        blob_pending::ActiveModel {
            external_id: Set(upload.id.clone()),
            created_by: Set(ADMIN_USER_ID),
            created_at: Set(now),
            expires_at: Set(now + TimeDuration::minutes(5)),
            expected_length: Set(upload
                .data
                .len()
                .try_into()
                .expect("test upload length should fit in i64")),
            s3_path: Set(upload.temporary_path.clone()),
            s3_hash: Set(None),
            presign_url: Set("https://uploads.example.test/concurrent-create".to_owned()),
            site_id: Set(Some(site.site_id)),
            page_id: Set(Some(page.page_id)),
            content_type_label: Set(None),
            content_type_description: Set(None),
        }
        .insert(&transaction)
        .await
        .expect("pending file create upload row should be inserted");
    }
    let session_token = SessionService::create(
        &ctx,
        CreateSession {
            user_id: ADMIN_USER_ID,
            ip_address: IpAddr::V4(Ipv4Addr::new(192, 0, 2, 81)),
            user_agent: "concurrent file create regression".to_owned(),
            restricted: false,
        },
    )
    .await
    .expect("admin test session should be created");
    cleanup.session_token = Some(session_token.clone());
    transaction
        .commit()
        .await
        .expect("file create fixture transaction should commit");

    Fixture {
        site_id: site.site_id,
        page_id: page.page_id,
        name: format!("concurrent-create-{}.bin", cuid()),
        session_token,
        uploads: cleanup.uploads.clone(),
    }
}

async fn registered_file_create(
    client: &reqwest::Client,
    address: SocketAddr,
    barrier: &Arc<Barrier>,
    fixture: &Fixture,
    upload_index: usize,
) -> Value {
    barrier.wait().await;
    client
        .post(format!("http://{address}"))
        .bearer_auth(
            env::var("DEEPWELL_RPC_TOKEN").expect("test RPC token must be configured"),
        )
        .header("X-Deepwell-Session-Token", &fixture.session_token)
        .header("X-Deepwell-Site-Id", fixture.site_id)
        .header("X-Deepwell-Page", "home")
        .json(&json!({
            "jsonrpc": "2.0",
            "id": upload_index + 1,
            "method": "file_create",
            "params": {
                "site_id": fixture.site_id,
                "page_id": fixture.page_id,
                "user_id": ADMIN_USER_ID,
                "name": fixture.name,
                "uploaded_blob_id": fixture.uploads[upload_index].id,
                "revision_comments": format!("concurrent create {upload_index}"),
                "bypass_filter": true,
                "ip_address": "192.0.2.81",
            },
        }))
        .send()
        .await
        .expect("file create RPC request should complete")
        .json()
        .await
        .expect("file create RPC response should be JSON")
}

async fn cleanup_fixture(
    state: &ServerState,
    cleanup: &FixtureCleanup,
) -> Result<(), String> {
    let mut failures = Vec::new();
    if let Some(file_id) = cleanup.file_id {
        if let Err(error) = AuditLog::delete_many()
            .filter(audit_log::Column::EventType.eq("file.create"))
            .filter(audit_log::Column::ExtraId1.eq(file_id))
            .exec(&state.database)
            .await
        {
            failures.push(format!("fixture audit cleanup failed: {error:?}"));
        }
        if let Err(error) = FileRevision::delete_many()
            .filter(file_revision::Column::FileId.eq(file_id))
            .exec(&state.database)
            .await
        {
            failures.push(format!("fixture revision cleanup failed: {error:?}"));
        }
        if let Err(error) = File::delete_by_id(file_id).exec(&state.database).await {
            failures.push(format!("fixture file cleanup failed: {error:?}"));
        }
    }
    for upload in &cleanup.uploads {
        if let Err(error) = BlobPending::delete_by_id(&upload.id)
            .exec(&state.database)
            .await
        {
            failures.push(format!(
                "fixture pending upload {} cleanup failed: {error:?}",
                upload.id
            ));
        }
    }
    if let Some(session_token) = &cleanup.session_token
        && let Err(error) = Session::delete_by_id(session_token)
            .exec(&state.database)
            .await
    {
        failures.push(format!("fixture session cleanup failed: {error:?}"));
    }
    for upload in &cleanup.uploads {
        for (label, path) in [
            ("temporary", upload.temporary_path.clone()),
            (
                "permanent",
                blob_hash_to_hex(&sha512_hash(&upload.data)).to_string(),
            ),
        ] {
            match state.s3_files_bucket.delete_object(&path).await {
                Ok(response) if matches!(response.status_code(), 204 | 404) => {}
                Ok(response) => failures.push(format!(
                    "fixture {label} object cleanup returned HTTP {} for {path}",
                    response.status_code()
                )),
                Err(error) => failures.push(format!(
                    "fixture {label} object cleanup failed for {path}: {error:?}"
                )),
            }
        }
    }
    if failures.is_empty() {
        Ok(())
    } else {
        Err(failures.join("; "))
    }
}

#[tokio::test]
async fn concurrent_file_creates_leave_exactly_one_active_row() {
    let state = test_state().await;
    let (address, server) = build_server_at(
        state.clone(),
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
    )
    .await
    .expect("test RPC server should start");
    let mut fixture_cleanup = FixtureCleanup::new();
    let construction = AssertUnwindSafe(create_fixture(&state, &mut fixture_cleanup))
        .catch_unwind()
        .await;
    let fixture = match construction {
        Ok(fixture) => Arc::new(fixture),
        Err(payload) => {
            let cleanup = cleanup_fixture(&state, &fixture_cleanup).await;
            let shutdown = AssertUnwindSafe(async {
                server.stop().expect("test RPC server should stop");
                server.stopped().await;
            })
            .catch_unwind()
            .await;
            if let Err(error) = cleanup {
                eprintln!(
                    "partial concurrent file create fixture cleanup after construction panic failed: {error}"
                );
            }
            if shutdown.is_err() {
                eprintln!(
                    "test RPC server shutdown after fixture construction panic failed"
                );
            }
            resume_unwind(payload);
        }
    };

    let verification = AssertUnwindSafe(async {
        let barrier = Arc::new(Barrier::new(2));
        let client = reqwest::Client::new();
        let (first, second) = tokio::join!(
            registered_file_create(&client, address, &barrier, &fixture, 0),
            registered_file_create(&client, address, &barrier, &fixture, 1),
        );
        let responses = [first, second];
        let winner_index = responses
            .iter()
            .position(|response| response.get("result").is_some())
            .expect("one concurrent file create should succeed");
        assert_eq!(
            responses
                .iter()
                .filter(|response| response.get("result").is_some())
                .count(),
            1,
            "exactly one concurrent file create should succeed, responses: {responses:?}"
        );
        let loser_index = 1 - winner_index;
        assert_eq!(
            responses[loser_index]["error"]["code"],
            json!(ErrorType::FileExists.code()),
            "the losing create should report the existing conflict error, responses: {responses:?}",
        );

        let winner_file_id = responses[winner_index]["result"]["file_id"]
            .as_i64()
            .expect("winning create should report its file ID");
        fixture_cleanup.file_id = Some(winner_file_id);

        let actives = File::find()
            .filter(file::Column::PageId.eq(fixture.page_id))
            .filter(file::Column::Name.eq(&fixture.name))
            .filter(file::Column::DeletedAt.is_null())
            .all(&state.database)
            .await
            .expect("active file rows should be readable");
        assert_eq!(
            actives.len(),
            1,
            "exactly one active file row should survive the race"
        );
        assert_eq!(actives[0].file_id, winner_file_id);

        let revisions = FileRevision::find()
            .filter(file_revision::Column::FileId.eq(winner_file_id))
            .all(&state.database)
            .await
            .expect("committed file revisions should be readable");
        assert_eq!(
            revisions.len(),
            1,
            "only the winning create should commit a revision"
        );
        assert_eq!(revisions[0].revision_number, 0);

        let audit_events = AuditLog::find()
            .filter(audit_log::Column::EventType.eq("file.create"))
            .filter(audit_log::Column::ExtraId1.eq(winner_file_id))
            .all(&state.database)
            .await
            .expect("committed file-create audit events should be readable");
        assert_eq!(
            audit_events.len(),
            1,
            "only the winning concurrent create should be audited"
        );

        let winner_hash = sha512_hash(&fixture.uploads[winner_index].data);
        let winner_permanent = state
            .s3_files_bucket
            .get_object(blob_hash_to_hex(&winner_hash).as_str())
            .await
            .expect("winner permanent blob state should be observable");
        let winner_temporary = state
            .s3_files_bucket
            .get_object(&fixture.uploads[winner_index].temporary_path)
            .await
            .expect("winner temporary blob state should be observable");
        assert_eq!(winner_permanent.status_code(), 200);
        assert_eq!(winner_temporary.status_code(), 404);

        let loser_upload = &fixture.uploads[loser_index];
        let loser_hash = sha512_hash(&loser_upload.data);
        let loser_permanent = state
            .s3_files_bucket
            .get_object(blob_hash_to_hex(&loser_hash).as_str())
            .await
            .expect("loser permanent blob state should be observable");
        assert_eq!(
            loser_permanent.status_code(),
            404,
            "the losing create must not promote its blob into the permanent pool"
        );
        let loser_temporary = state
            .s3_files_bucket
            .get_object(&loser_upload.temporary_path)
            .await
            .expect("loser temporary blob state should be observable");
        assert_eq!(
            loser_temporary.status_code(),
            200,
            "the losing create must leave its pending upload object in place"
        );
        let loser_pending = BlobPending::find_by_id(&loser_upload.id)
            .one(&state.database)
            .await
            .expect("loser pending upload row should be readable");
        assert!(
            loser_pending.is_some(),
            "the losing create must not consume its pending upload row"
        );
    })
    .catch_unwind()
    .await;

    let shutdown = AssertUnwindSafe(async {
        server.stop().expect("test RPC server should stop");
        server.stopped().await;
    })
    .catch_unwind()
    .await;
    let cleanup = cleanup_fixture(&state, &fixture_cleanup).await;
    if let Err(payload) = verification {
        if let Err(error) = &cleanup {
            eprintln!(
                "concurrent file create fixture cleanup after panic failed: {error}"
            );
        }
        resume_unwind(payload);
    }
    if let Err(payload) = shutdown {
        if let Err(error) = &cleanup {
            eprintln!(
                "concurrent file create fixture cleanup after shutdown panic failed: {error}"
            );
        }
        resume_unwind(payload);
    }
    cleanup.expect("concurrent file create fixture cleanup should succeed");
}
