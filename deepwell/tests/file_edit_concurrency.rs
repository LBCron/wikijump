/*
 * tests/file_edit_concurrency.rs
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
use deepwell::services::blob::{EMPTY_BLOB_HASH, EMPTY_BLOB_MIME};
use deepwell::services::session::{CreateSession, SessionService};
use deepwell::services::{PageService, ServiceContext, SiteService};
use deepwell::types::{FileRevisionType, Reference};
use futures::FutureExt;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder,
    QuerySelect, Set, Statement, TransactionTrait, Value as SqlValue,
};
use serde_json::{Value, json};
use std::env;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::panic::{AssertUnwindSafe, resume_unwind};
use std::sync::Arc;
use std::time::{Duration, Instant};
use time::{Duration as TimeDuration, OffsetDateTime};
use tokio::sync::Barrier;
use tokio::time::sleep;

#[derive(Clone)]
struct PendingUpload {
    id: String,
    temporary_path: String,
    data: Vec<u8>,
}

struct FixtureCleanup {
    file_id: Option<i64>,
    session_token: Option<String>,
    uploads: [PendingUpload; 2],
}

impl FixtureCleanup {
    fn new() -> Self {
        let uploads = ["first", "second"].map(|label| {
            let id = cuid();
            PendingUpload {
                temporary_path: format!("uploads/{id}"),
                data: format!("concurrent file edit {label} {id}").into_bytes(),
                id,
            }
        });
        Self {
            file_id: None,
            session_token: None,
            uploads,
        }
    }
}

struct Fixture {
    site_id: i64,
    page_id: i64,
    file_id: i64,
    revision_id: i64,
    revision_number: i32,
    session_token: String,
    uploads: [PendingUpload; 2],
}

async fn create_fixture(state: &ServerState, cleanup: &mut FixtureCleanup) -> Fixture {
    for upload in &cleanup.uploads {
        let response = state
            .s3_files_bucket
            .put_object(&upload.temporary_path, &upload.data)
            .await
            .expect("pending file edit upload should reach object storage");
        assert_eq!(response.status_code(), 200);
    }

    let transaction = state
        .database
        .begin()
        .await
        .expect("file edit fixture transaction should begin");
    let ctx = ServiceContext::new(state, &transaction);
    let site = SiteService::get(&ctx, Reference::from("test"))
        .await
        .expect("seeded test site should exist");
    let page = PageService::get(&ctx, site.site_id, Reference::from("home"))
        .await
        .expect("seeded test home page should exist");
    let file = file::ActiveModel {
        name: Set(format!("concurrent-edit-{}.bin", cuid())),
        page_id: Set(page.page_id),
        site_id: Set(site.site_id),
        ..Default::default()
    }
    .insert(&transaction)
    .await
    .expect("file edit fixture row should be inserted");
    cleanup.file_id = Some(file.file_id);
    let revision = file_revision::ActiveModel {
        revision_type: Set(FileRevisionType::Create),
        revision_number: Set(0),
        file_id: Set(file.file_id),
        page_id: Set(page.page_id),
        site_id: Set(site.site_id),
        user_id: Set(ADMIN_USER_ID),
        name: Set(file.name.clone()),
        s3_hash: Set(EMPTY_BLOB_HASH.to_vec()),
        mime: Set(EMPTY_BLOB_MIME.to_owned()),
        size: Set(0),
        content_type_label: Set(None),
        content_type_description: Set(None),
        changes: Set(vec![
            "page".to_owned(),
            "name".to_owned(),
            "blob".to_owned(),
            "mime".to_owned(),
        ]),
        comments: Set("concurrent file edit fixture".to_owned()),
        hidden: Set(Vec::new()),
        ..Default::default()
    }
    .insert(&transaction)
    .await
    .expect("initial file revision fixture should be inserted");

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
            presign_url: Set("https://uploads.example.test/concurrent-edit".to_owned()),
            site_id: Set(Some(site.site_id)),
            page_id: Set(Some(page.page_id)),
            content_type_label: Set(None),
            content_type_description: Set(None),
        }
        .insert(&transaction)
        .await
        .expect("pending file edit upload row should be inserted");
    }
    let session_token = SessionService::create(
        &ctx,
        CreateSession {
            user_id: ADMIN_USER_ID,
            ip_address: IpAddr::V4(Ipv4Addr::new(192, 0, 2, 80)),
            user_agent: "concurrent file edit regression".to_owned(),
            restricted: false,
        },
    )
    .await
    .expect("admin test session should be created");
    cleanup.session_token = Some(session_token.clone());
    transaction
        .commit()
        .await
        .expect("file edit fixture transaction should commit");

    Fixture {
        site_id: site.site_id,
        page_id: page.page_id,
        file_id: file.file_id,
        revision_id: revision.revision_id,
        revision_number: revision.revision_number,
        session_token,
        uploads: cleanup.uploads.clone(),
    }
}

async fn registered_file_edit(
    client: reqwest::Client,
    address: SocketAddr,
    barrier: Arc<Barrier>,
    fixture: Arc<Fixture>,
    upload_index: usize,
) -> Value {
    barrier.wait().await;
    registered_rpc(
        &client,
        address,
        &fixture,
        upload_index + 1,
        "file_edit",
        json!({
            "site_id": fixture.site_id,
            "page_id": fixture.page_id,
            "file_id": fixture.file_id,
            "user_id": ADMIN_USER_ID,
            "last_revision_id": fixture.revision_id,
            "revision_comments": format!("concurrent edit {upload_index}"),
            "uploaded_blob_id": fixture.uploads[upload_index].id,
            "ip_address": "192.0.2.80",
        }),
    )
    .await
}

async fn registered_rpc(
    client: &reqwest::Client,
    address: SocketAddr,
    fixture: &Fixture,
    request_id: usize,
    method: &str,
    params: Value,
) -> Value {
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
            "id": request_id,
            "method": method,
            "params": params,
        }))
        .send()
        .await
        .expect("registered RPC request should complete")
        .json()
        .await
        .expect("registered RPC response should be JSON")
}

async fn transaction_backend_pid(transaction: &sea_orm::DatabaseTransaction) -> i32 {
    transaction
        .query_one_raw(Statement::from_string(
            transaction.get_database_backend(),
            "SELECT pg_backend_pid() AS pid",
        ))
        .await
        .expect("gate backend PID should be readable")
        .expect("gate backend PID query should return one row")
        .try_get("", "pid")
        .expect("gate backend PID should be an i32")
}

async fn wait_for_two_file_row_waiters(state: &ServerState, gate_pid: i32) {
    let statement = Statement::from_sql_and_values(
        state.database.get_database_backend(),
        r#"
            WITH RECURSIVE gate_waiters(pid) AS (
                SELECT activity.pid
                FROM pg_stat_activity activity
                WHERE $1 = ANY(pg_blocking_pids(activity.pid))
                UNION
                SELECT activity.pid
                FROM pg_stat_activity activity
                JOIN gate_waiters blocker
                  ON blocker.pid = ANY(pg_blocking_pids(activity.pid))
            )
            SELECT COUNT(DISTINCT activity.pid)::BIGINT AS waiting
            FROM pg_stat_activity activity
            JOIN gate_waiters ON gate_waiters.pid = activity.pid
            WHERE activity.datname = current_database()
              AND activity.state = 'active'
              AND activity.wait_event_type = 'Lock'
              AND (
                  activity.query ~ '^SELECT .* FROM "file" .* FOR UPDATE$'
                  OR activity.query ~ '^UPDATE "file" SET '
              )
        "#,
        [SqlValue::from(gate_pid)],
    );
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let row = state
            .database
            .query_one_raw(statement.clone())
            .await
            .expect("file row waiters should be observable")
            .expect("file row waiter count should return one row");
        let waiting: i64 = row
            .try_get("", "waiting")
            .expect("file row waiter count should be an i64");
        if waiting == 2 {
            return;
        }
        assert!(
            waiting < 2,
            "exactly two registered file edits should wait behind the fixture row gate, found {waiting}"
        );
        assert!(
            Instant::now() < deadline,
            "both registered file edit requests should wait at the held file row"
        );
        sleep(Duration::from_millis(10)).await;
    }
}

async fn cleanup_fixture(
    state: &ServerState,
    cleanup: &FixtureCleanup,
) -> Result<(), String> {
    let mut failures = Vec::new();
    if let Some(file_id) = cleanup.file_id {
        if let Err(error) = AuditLog::delete_many()
            .filter(audit_log::Column::EventType.eq("file.edit"))
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
async fn concurrent_registered_file_edits_promote_only_the_winning_blob() {
    let state = build_server_state_without_workers(
        Config::integration_testing(),
        Secrets::load(),
    )
    .await
    .expect("test server state should build");
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
                    "partial concurrent file edit fixture cleanup after construction panic failed: {error}"
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
        let gate = state
            .database
            .begin()
            .await
            .expect("file row gate transaction should begin");
        let gate_pid = transaction_backend_pid(&gate).await;
        File::find_by_id(fixture.file_id)
            .lock_exclusive()
            .one(&gate)
            .await
            .expect("file row gate should lock")
            .expect("fixture file should exist");

        let barrier = Arc::new(Barrier::new(3));
        let client = reqwest::Client::new();
        let first = tokio::spawn(registered_file_edit(
            client.clone(),
            address,
            Arc::clone(&barrier),
            Arc::clone(&fixture),
            0,
        ));
        let second = tokio::spawn(registered_file_edit(
            client.clone(),
            address,
            Arc::clone(&barrier),
            Arc::clone(&fixture),
            1,
        ));
        barrier.wait().await;
        wait_for_two_file_row_waiters(&state, gate_pid).await;
        gate.rollback()
            .await
            .expect("file row gate should release both requests");

        let responses = [
            first.await.expect("first file edit task should join"),
            second.await.expect("second file edit task should join"),
        ];
        let winner_index = responses
            .iter()
            .position(|response| response.get("result").is_some())
            .expect("one concurrent file edit should succeed");
        assert_eq!(
            responses
                .iter()
                .filter(|response| response.get("result").is_some())
                .count(),
            1,
            "responses: {responses:?}"
        );
        let loser_index = 1 - winner_index;

        let cancel = registered_rpc(
            &client,
            address,
            &fixture,
            3,
            "blob_cancel",
            json!({
                "user_id": ADMIN_USER_ID,
                "pending_blob_id": fixture.uploads[loser_index].id,
            }),
        )
        .await;
        assert!(
            cancel.get("error").is_none(),
            "registered blob_cancel should accept the failed pending upload: {cancel}"
        );
        assert_eq!(cancel.get("result"), Some(&Value::Null));

        let revisions = FileRevision::find()
            .filter(file_revision::Column::FileId.eq(fixture.file_id))
            .order_by_asc(file_revision::Column::RevisionNumber)
            .all(&state.database)
            .await
            .expect("committed file revisions should be readable");
        assert_eq!(revisions.len(), 2, "only the winning edit should commit");
        assert_eq!(revisions[0].revision_id, fixture.revision_id);
        assert_eq!(revisions[0].revision_number, fixture.revision_number);
        assert_eq!(
            revisions
                .iter()
                .filter(|revision| {
                    revision.revision_number == fixture.revision_number + 1
                })
                .count(),
            1,
            "there must be exactly one baseline N+1 revision"
        );
        let winner_revision = &revisions[1];
        assert_eq!(
            winner_revision.revision_number,
            fixture.revision_number + 1,
            "the winner must extend the exact revision both requests supplied"
        );
        assert_eq!(
            responses[winner_index]["result"]["file_revision_id"],
            json!(winner_revision.revision_id)
        );
        assert_eq!(
            responses[winner_index]["result"]["file_revision_number"],
            json!(fixture.revision_number + 1)
        );

        let audit_events = AuditLog::find()
            .filter(audit_log::Column::EventType.eq("file.edit"))
            .filter(audit_log::Column::ExtraId1.eq(fixture.file_id))
            .all(&state.database)
            .await
            .expect("committed file-edit audit events should be readable");
        assert_eq!(
            audit_events.len(),
            1,
            "only the winning concurrent edit should be audited"
        );
        let audit_event = &audit_events[0];
        assert_eq!(audit_event.user_id, Some(ADMIN_USER_ID));
        assert_eq!(audit_event.site_id, Some(fixture.site_id));
        assert_eq!(audit_event.page_id, Some(fixture.page_id));
        assert_eq!(audit_event.extra_id_1, Some(fixture.file_id));
        assert_eq!(audit_event.extra_id_2, Some(winner_revision.revision_id));
        assert_eq!(audit_event.ip_address.ip().to_string(), "192.0.2.80");

        let winner_hash = sha512_hash(&fixture.uploads[winner_index].data);
        let loser_hash = sha512_hash(&fixture.uploads[loser_index].data);
        assert_eq!(winner_revision.s3_hash, winner_hash.to_vec());
        let winner_pending = BlobPending::find_by_id(&fixture.uploads[winner_index].id)
            .one(&state.database)
            .await
            .expect("winner pending blob state should be readable")
            .expect("winner pending blob should reference its promoted hash");
        assert_eq!(
            winner_pending.s3_hash.as_deref(),
            Some(winner_hash.as_slice())
        );
        assert!(
            BlobPending::find_by_id(&fixture.uploads[loser_index].id)
                .one(&state.database)
                .await
                .expect("loser pending blob state should be readable")
                .is_none(),
            "registered blob_cancel should remove the failed pending row"
        );

        let winner_permanent = state
            .s3_files_bucket
            .get_object(blob_hash_to_hex(&winner_hash).as_str())
            .await
            .expect("winner permanent blob state should be observable");
        let loser_permanent = state
            .s3_files_bucket
            .get_object(blob_hash_to_hex(&loser_hash).as_str())
            .await
            .expect("loser permanent blob state should be observable");
        let winner_temporary = state
            .s3_files_bucket
            .get_object(&fixture.uploads[winner_index].temporary_path)
            .await
            .expect("winner temporary blob state should be observable");
        let loser_temporary = state
            .s3_files_bucket
            .get_object(&fixture.uploads[loser_index].temporary_path)
            .await
            .expect("loser temporary blob state should be observable");
        assert_eq!(winner_permanent.status_code(), 200);
        assert_eq!(loser_permanent.status_code(), 404);
        assert_eq!(winner_temporary.status_code(), 404);
        assert_eq!(loser_temporary.status_code(), 404);
        assert_eq!(
            responses[loser_index]["error"]["code"],
            json!(ErrorType::NotLatestRevisionId.code()),
            "responses: {responses:?}"
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
            eprintln!("concurrent file edit fixture cleanup after panic failed: {error}");
        }
        resume_unwind(payload);
    }
    if let Err(payload) = shutdown {
        if let Err(error) = &cleanup {
            eprintln!(
                "concurrent file edit fixture cleanup after shutdown panic failed: {error}"
            );
        }
        resume_unwind(payload);
    }
    cleanup.expect("concurrent file edit fixture cleanup should succeed");
}
