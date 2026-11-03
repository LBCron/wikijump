/*
 * tests/page_edit_concurrency.rs
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

use cuid2::cuid;
use deepwell::api::{build_server_at, build_server_state_without_workers};
use deepwell::config::{Config, Secrets};
use deepwell::constants::ADMIN_USER_ID;
use deepwell::services::session::{CreateSession, SessionService};
use deepwell::services::{ServiceContext, SiteService};
use deepwell::types::Reference;
use sea_orm::{ConnectionTrait, Statement, TransactionTrait};
use serde_json::{Value, json};
use std::env;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};
use tokio::time::sleep;

const IP: &str = "192.0.2.90";
const NOT_LATEST_REVISION_ID: i64 = 4303;

struct Outcome {
    status: Option<u16>,
    body: String,
}

impl Outcome {
    fn describe(&self) -> String {
        match self.status {
            Some(status) => format!("HTTP {status}: {}", self.body),
            None => format!("TRANSPORT: {}", self.body),
        }
    }

    fn error_code(&self) -> Option<i64> {
        let value: Value = serde_json::from_str(&self.body).ok()?;
        value.get("error")?.get("code")?.as_i64()
    }

    fn result_revision_id(&self) -> Option<i64> {
        let value: Value = serde_json::from_str(&self.body).ok()?;
        value.get("result")?.get("revision_id")?.as_i64()
    }

    fn result(&self) -> Value {
        let value: Value = serde_json::from_str(&self.body)
            .unwrap_or_else(|_| panic!("response should be JSON: {}", self.describe()));
        value
            .get("result")
            .unwrap_or_else(|| {
                panic!("response should carry a result: {}", self.describe())
            })
            .clone()
    }

    fn assert_typed_conflict(&self) {
        assert_eq!(
            self.status,
            Some(200),
            "conflict should be a JSON-RPC response, got: {}",
            self.describe(),
        );
        assert_eq!(
            self.error_code(),
            Some(NOT_LATEST_REVISION_ID),
            "conflict should be typed NotLatestRevisionId, got: {}",
            self.describe(),
        );
    }
}

async fn rpc(
    client: &reqwest::Client,
    address: SocketAddr,
    session: &str,
    site_id: i64,
    page_header: &str,
    (id, method, params): (usize, &str, Value),
) -> Outcome {
    let response = client
        .post(format!("http://{address}"))
        .bearer_auth(
            env::var("DEEPWELL_RPC_TOKEN").expect("test RPC token must be configured"),
        )
        .header("X-Deepwell-Session-Token", session)
        .header("X-Deepwell-Site-Id", site_id)
        .header("X-Deepwell-Page", page_header)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .send()
        .await;
    match response {
        Ok(response) => {
            let status = response.status().as_u16();
            let body = response
                .text()
                .await
                .unwrap_or_else(|error| format!("<body read error: {error}>"));
            Outcome {
                status: Some(status),
                body,
            }
        }
        Err(error) => Outcome {
            status: None,
            body: format!("{error}"),
        },
    }
}

struct Fixture {
    state: deepwell::api::ServerState,
    address: SocketAddr,
    session: String,
    site_id: i64,
    client: reqwest::Client,
}

async fn setup() -> Fixture {
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
    std::mem::forget(server);

    let transaction = state
        .database
        .begin()
        .await
        .expect("fixture transaction should begin");
    let ctx = ServiceContext::new(&state, &transaction);
    let site = SiteService::get(&ctx, Reference::from("test"))
        .await
        .expect("seeded test site should exist");
    let session = SessionService::create(
        &ctx,
        CreateSession {
            user_id: ADMIN_USER_ID,
            ip_address: IpAddr::V4(Ipv4Addr::new(192, 0, 2, 90)),
            user_agent: "page edit concurrency test".to_owned(),
            restricted: false,
        },
    )
    .await
    .expect("admin test session should be created");
    transaction
        .commit()
        .await
        .expect("fixture transaction should commit");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("HTTP client should build");

    Fixture {
        state,
        address,
        session,
        site_id: site.site_id,
        client,
    }
}

impl Fixture {
    async fn call(
        &self,
        id: usize,
        page_header: &str,
        method: &str,
        params: Value,
    ) -> Outcome {
        rpc(
            &self.client,
            self.address,
            &self.session,
            self.site_id,
            page_header,
            (id, method, params),
        )
        .await
    }

    async fn create_page(&self, id: usize, slug: &str, wikitext: &str) -> (i64, i64) {
        let outcome = self
            .call(
                id,
                slug,
                "page_create",
                json!({
                    "site_id": self.site_id,
                    "wikitext": wikitext,
                    "title": format!("Concurrency test {slug}"),
                    "alt_title": null,
                    "slug": slug,
                    "layout": "wikidot",
                    "revision_comments": "concurrency test create",
                    "user_id": ADMIN_USER_ID,
                    "ip_address": IP,
                }),
            )
            .await;
        let value: Value = serde_json::from_str(&outcome.body).unwrap_or_else(|_| {
            panic!("page_create should return JSON: {}", outcome.describe())
        });
        let result = value.get("result").unwrap_or_else(|| {
            panic!("page_create should succeed: {}", outcome.describe())
        });
        (
            result["page_id"].as_i64().expect("page_id"),
            result["revision_id"].as_i64().expect("revision_id"),
        )
    }

    async fn acquire_lease(&self, id: usize, page_id: i64) -> Value {
        let outcome = self
            .call(
                id,
                &page_id.to_string(),
                "page_edit_lock_acquire",
                json!({
                    "page": page_id,
                    "mode": "page",
                }),
            )
            .await;
        let grant = outcome
            .result()
            .get("grant")
            .unwrap_or_else(|| {
                panic!("lease acquisition should grant: {}", outcome.describe())
            })
            .clone();
        json!({
            "lock_id": grant["lock_id"],
            "lock_secret": grant["lock_secret"],
            "mode": "page",
        })
    }

    async fn edit(
        &self,
        id: usize,
        page_id: i64,
        last_revision_id: i64,
        wikitext: &str,
    ) -> Outcome {
        let lease = self.acquire_lease(id, page_id).await;
        self.leased_edit(id, page_id, last_revision_id, wikitext, &lease)
            .await
    }

    async fn leased_edit(
        &self,
        id: usize,
        page_id: i64,
        last_revision_id: i64,
        wikitext: &str,
        lease: &Value,
    ) -> Outcome {
        self.call(
            id,
            &page_id.to_string(),
            "page_edit",
            json!({
                "site_id": self.site_id,
                "page": page_id,
                "last_revision_id": last_revision_id,
                "revision_comments": "concurrency test edit",
                "user_id": ADMIN_USER_ID,
                "wikitext": wikitext,
                "ip_address": IP,
                "lease": lease,
            }),
        )
        .await
    }

    async fn wait_for_row_lock_waiter(&self, timeout: Duration) {
        let parked = self
            .wait_for_activity(
                "wait_event_type = 'Lock' AND query ILIKE '%FOR UPDATE%'",
                timeout,
            )
            .await;
        assert!(
            parked.is_some(),
            "a racing request should park on the page row lock"
        );
    }

    async fn revision_chain(&self, page_id: i64) -> Vec<(i32, i64)> {
        let rows = self
            .state
            .database
            .query_all_raw(Statement::from_string(
                self.state.database.get_database_backend(),
                format!(
                    "SELECT revision_number, revision_id FROM page_revision \
                     WHERE page_id = {page_id} ORDER BY revision_number"
                ),
            ))
            .await
            .expect("revision chain query should run");
        rows.iter()
            .map(|row| {
                (
                    row.try_get("", "revision_number").expect("revision_number"),
                    row.try_get("", "revision_id").expect("revision_id"),
                )
            })
            .collect()
    }

    async fn latest_revision_id(&self, page_id: i64) -> Option<i64> {
        let row = self
            .state
            .database
            .query_one_raw(Statement::from_string(
                self.state.database.get_database_backend(),
                format!("SELECT latest_revision_id FROM page WHERE page_id = {page_id}"),
            ))
            .await
            .expect("page row query should run")
            .expect("page row should exist");
        row.try_get("", "latest_revision_id").ok().flatten()
    }

    async fn wait_for_activity(
        &self,
        condition_sql: &str,
        timeout: Duration,
    ) -> Option<Vec<String>> {
        let deadline = Instant::now() + timeout;
        loop {
            let rows = self
                .state
                .database
                .query_all_raw(Statement::from_string(
                    self.state.database.get_database_backend(),
                    format!(
                        "SELECT query FROM pg_stat_activity \
                         WHERE datname = current_database() AND ({condition_sql})"
                    ),
                ))
                .await
                .expect("activity query should run");
            if !rows.is_empty() {
                return Some(
                    rows.iter()
                        .map(|row| row.try_get("", "query").expect("query text"))
                        .collect(),
                );
            }
            if Instant::now() >= deadline {
                return None;
            }
            sleep(Duration::from_millis(10)).await;
        }
    }

    async fn gate_lock(&self, lock_sql: &str) -> sea_orm::DatabaseTransaction {
        let gate = self
            .state
            .database
            .begin()
            .await
            .expect("gate transaction should begin");
        gate.execute_raw(Statement::from_string(
            gate.get_database_backend(),
            lock_sql,
        ))
        .await
        .expect("gate lock should be taken");
        gate
    }

    async fn wait_for_parked_inserts(&self, count: usize, timeout: Duration) {
        let deadline = Instant::now() + timeout;
        loop {
            let rows = self
                .state
                .database
                .query_all_raw(Statement::from_string(
                    self.state.database.get_database_backend(),
                    "SELECT query FROM pg_stat_activity \
                     WHERE datname = current_database() \
                       AND wait_event_type = 'Lock' \
                       AND query ILIKE 'INSERT INTO \"page_revision\"%'",
                ))
                .await
                .expect("activity query should run");
            if rows.len() >= count {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "expected {count} requests parked at the revision INSERT, found {}",
                rows.len(),
            );
            sleep(Duration::from_millis(10)).await;
        }
    }

    async fn page_at_revision_one(&self, label: &str) -> (i64, i64, i64) {
        let slug = format!("race-{label}-{}", cuid());
        let (page_id, rev0) = self
            .create_page(1, &slug, &format!("{label} version zero"))
            .await;
        let edit = self
            .edit(2, page_id, rev0, &format!("{label} version one"))
            .await;
        let rev1 = edit
            .result_revision_id()
            .expect("setup edit should create a revision");
        (page_id, rev0, rev1)
    }

    async fn assert_gapless_chain_at_tip(&self, page_id: i64, expected_tip: i64) {
        let chain = self.revision_chain(page_id).await;
        let numbers: Vec<i32> = chain.iter().map(|(number, _)| *number).collect();
        let expected: Vec<i32> = (0..numbers.len() as i32).collect();
        assert_eq!(numbers, expected, "revision chain should be gapless");
        assert_eq!(
            chain.last().map(|(_, revision_id)| *revision_id),
            Some(expected_tip),
            "chain tip should be the expected revision",
        );
        assert_eq!(
            self.latest_revision_id(page_id).await,
            Some(expected_tip),
            "page.latest_revision_id should point at the chain tip",
        );
    }
}

fn assert_one_winner_one_conflict(a: &Outcome, b: &Outcome) -> i64 {
    let a_revision = a.result_revision_id();
    let b_revision = b.result_revision_id();
    match (a_revision, b_revision) {
        (Some(revision_id), None) => {
            b.assert_typed_conflict();
            revision_id
        }
        (None, Some(revision_id)) => {
            a.assert_typed_conflict();
            revision_id
        }
        _ => panic!(
            "exactly one request should win; got a={} b={}",
            a.describe(),
            b.describe(),
        ),
    }
}

#[tokio::test]
async fn leased_edit_holding_row_lock_serializes_racing_move() {
    let fixture = setup().await;
    let (page_id, _rev0, rev1) = fixture.page_at_revision_one("rp1-edit").await;

    let lease = fixture.acquire_lease(3, page_id).await;

    let gate = fixture
        .gate_lock("LOCK TABLE filter IN ACCESS EXCLUSIVE MODE")
        .await;

    let victim_client = fixture.client.clone();
    let victim_address = fixture.address;
    let victim_session = fixture.session.clone();
    let victim_site = fixture.site_id;
    let victim = tokio::spawn(async move {
        rpc(
            &victim_client,
            victim_address,
            &victim_session,
            victim_site,
            &page_id.to_string(),
            (
                3,
                "page_edit",
                json!({
                    "site_id": victim_site,
                    "page": page_id,
                    "last_revision_id": rev1,
                    "revision_comments": "victim edit",
                    "user_id": ADMIN_USER_ID,
                    "wikitext": "victim content",
                    "ip_address": IP,
                    "lease": lease,
                }),
            ),
        )
        .await
    });

    let parked = fixture
        .wait_for_activity(
            "wait_event_type = 'Lock' AND query ILIKE '%filter%'",
            Duration::from_secs(20),
        )
        .await;
    assert!(
        parked.is_some(),
        "victim edit should park on the filter gate"
    );

    let new_slug = format!("race-rp1-edit-moved-{}", cuid());
    let move_client = fixture.client.clone();
    let move_address = fixture.address;
    let move_session = fixture.session.clone();
    let move_site = fixture.site_id;
    let mover = tokio::spawn(async move {
        rpc(
            &move_client,
            move_address,
            &move_session,
            move_site,
            &page_id.to_string(),
            (
                4,
                "page_move",
                json!({
                    "site_id": move_site,
                    "page": page_id,
                    "new_slug": new_slug,
                    "last_revision_id": rev1,
                    "revision_comments": "racing move",
                    "user_id": ADMIN_USER_ID,
                    "ip_address": IP,
                }),
            ),
        )
        .await
    });

    fixture
        .wait_for_row_lock_waiter(Duration::from_secs(20))
        .await;

    gate.commit().await.expect("filter gate should release");
    let victim_outcome = victim.await.expect("victim task should join");
    let victim_revision = victim_outcome
        .result_revision_id()
        .expect("victim edit should commit once the gate releases");
    let mover_outcome = mover.await.expect("move task should join");
    let mover_revision = mover_outcome
        .result_revision_id()
        .expect("racing move should commit after the edit finishes");

    let chain = fixture.revision_chain(page_id).await;
    assert_eq!(
        chain.iter().map(|(number, _)| *number).collect::<Vec<_>>(),
        vec![0, 1, 2, 3],
        "edit and move should serialize into a gapless chain"
    );
    assert_eq!(chain[2].1, victim_revision);
    assert_eq!(chain[3].1, mover_revision);
    fixture
        .assert_gapless_chain_at_tip(page_id, mover_revision)
        .await;
}

#[tokio::test]
async fn two_edits_passing_check_then_insert_race_loser_gets_typed_conflict() {
    let fixture = setup().await;
    let (page_id, _rev0, rev1) = fixture.page_at_revision_one("rp2-edit").await;

    let lease = fixture.acquire_lease(3, page_id).await;

    let gate = fixture
        .gate_lock("LOCK TABLE page_revision IN SHARE MODE")
        .await;

    let spawn_edit = |id: usize, label: &'static str, lease: Value| {
        let client = fixture.client.clone();
        let address = fixture.address;
        let session = fixture.session.clone();
        let site_id = fixture.site_id;
        tokio::spawn(async move {
            rpc(
                &client,
                address,
                &session,
                site_id,
                &page_id.to_string(),
                (
                    id,
                    "page_edit",
                    json!({
                        "site_id": site_id,
                        "page": page_id,
                        "last_revision_id": rev1,
                        "revision_comments": format!("saver {label}"),
                        "user_id": ADMIN_USER_ID,
                        "wikitext": format!("content from saver {label}"),
                        "ip_address": IP,
                        "lease": lease,
                    }),
                ),
            )
            .await
        })
    };
    let saver_a = spawn_edit(3, "alpha", lease.clone());
    let saver_b = spawn_edit(4, "beta", lease);

    fixture
        .wait_for_parked_inserts(1, Duration::from_secs(30))
        .await;
    fixture
        .wait_for_row_lock_waiter(Duration::from_secs(30))
        .await;

    gate.commit()
        .await
        .expect("page_revision gate should release");
    let outcome_a = saver_a.await.expect("saver alpha task should join");
    let outcome_b = saver_b.await.expect("saver beta task should join");
    let winner = assert_one_winner_one_conflict(&outcome_a, &outcome_b);

    fixture.assert_gapless_chain_at_tip(page_id, winner).await;
}

#[tokio::test]
async fn delete_racing_edit_at_insert_race_loser_gets_typed_conflict() {
    let fixture = setup().await;
    let (page_id, _rev0, rev1) = fixture.page_at_revision_one("rp2-delete").await;

    let lease = fixture.acquire_lease(3, page_id).await;

    let gate = fixture
        .gate_lock("LOCK TABLE page_revision IN SHARE MODE")
        .await;

    let edit_client = fixture.client.clone();
    let edit_address = fixture.address;
    let edit_session = fixture.session.clone();
    let edit_site = fixture.site_id;
    let editor = tokio::spawn(async move {
        rpc(
            &edit_client,
            edit_address,
            &edit_session,
            edit_site,
            &page_id.to_string(),
            (
                3,
                "page_edit",
                json!({
                    "site_id": edit_site,
                    "page": page_id,
                    "last_revision_id": rev1,
                    "revision_comments": "racing edit",
                    "user_id": ADMIN_USER_ID,
                    "wikitext": "racing edit content",
                    "ip_address": IP,
                    "lease": lease,
                }),
            ),
        )
        .await
    });

    fixture
        .wait_for_parked_inserts(1, Duration::from_secs(30))
        .await;

    let delete_client = fixture.client.clone();
    let delete_address = fixture.address;
    let delete_session = fixture.session.clone();
    let delete_site = fixture.site_id;
    let deleter = tokio::spawn(async move {
        rpc(
            &delete_client,
            delete_address,
            &delete_session,
            delete_site,
            &page_id.to_string(),
            (
                4,
                "page_delete",
                json!({
                    "site_id": delete_site,
                    "page": page_id,
                    "last_revision_id": rev1,
                    "revision_comments": "racing delete",
                    "user_id": ADMIN_USER_ID,
                    "ip_address": IP,
                }),
            ),
        )
        .await
    });

    fixture
        .wait_for_row_lock_waiter(Duration::from_secs(30))
        .await;

    gate.commit()
        .await
        .expect("page_revision gate should release");
    let delete_outcome = deleter.await.expect("delete task should join");
    let edit_outcome = editor.await.expect("edit task should join");
    let winner = assert_one_winner_one_conflict(&delete_outcome, &edit_outcome);
    assert_eq!(
        winner,
        edit_outcome
            .result_revision_id()
            .expect("the leased edit should be the winner"),
        "the edit holding the page row lock should win against the delete"
    );

    fixture.assert_gapless_chain_at_tip(page_id, winner).await;
}

#[tokio::test]
async fn move_racing_leased_edit_both_commit_serialized() {
    let fixture = setup().await;
    let (page_id, _rev0, rev1) = fixture.page_at_revision_one("rp2-move").await;

    let lease = fixture.acquire_lease(3, page_id).await;

    let gate = fixture
        .gate_lock("LOCK TABLE page_revision IN SHARE MODE")
        .await;

    let edit_client = fixture.client.clone();
    let edit_address = fixture.address;
    let edit_session = fixture.session.clone();
    let edit_site = fixture.site_id;
    let editor = tokio::spawn(async move {
        rpc(
            &edit_client,
            edit_address,
            &edit_session,
            edit_site,
            &page_id.to_string(),
            (
                3,
                "page_edit",
                json!({
                    "site_id": edit_site,
                    "page": page_id,
                    "last_revision_id": rev1,
                    "revision_comments": "racing edit",
                    "user_id": ADMIN_USER_ID,
                    "wikitext": "racing edit content",
                    "ip_address": IP,
                    "lease": lease,
                }),
            ),
        )
        .await
    });

    fixture
        .wait_for_parked_inserts(1, Duration::from_secs(30))
        .await;

    let new_slug = format!("race-rp2-move-moved-{}", cuid());
    let move_client = fixture.client.clone();
    let move_address = fixture.address;
    let move_session = fixture.session.clone();
    let move_site = fixture.site_id;
    let mover = tokio::spawn(async move {
        rpc(
            &move_client,
            move_address,
            &move_session,
            move_site,
            &page_id.to_string(),
            (
                4,
                "page_move",
                json!({
                    "site_id": move_site,
                    "page": page_id,
                    "new_slug": new_slug,
                    "last_revision_id": rev1,
                    "revision_comments": "racing move",
                    "user_id": ADMIN_USER_ID,
                    "ip_address": IP,
                }),
            ),
        )
        .await
    });

    fixture
        .wait_for_row_lock_waiter(Duration::from_secs(30))
        .await;

    gate.commit()
        .await
        .expect("page_revision gate should release");
    let move_outcome = mover.await.expect("move task should join");
    let edit_outcome = editor.await.expect("edit task should join");
    let edit_revision = edit_outcome
        .result_revision_id()
        .expect("the leased edit should commit");
    let move_revision = move_outcome
        .result_revision_id()
        .expect("the move should commit after the edit releases the page");

    let chain = fixture.revision_chain(page_id).await;
    assert_eq!(
        chain.iter().map(|(number, _)| *number).collect::<Vec<_>>(),
        vec![0, 1, 2, 3],
        "edit and move should serialize into a gapless chain"
    );
    assert_eq!(chain[2].1, edit_revision);
    assert_eq!(chain[3].1, move_revision);
    fixture
        .assert_gapless_chain_at_tip(page_id, move_revision)
        .await;
}

#[tokio::test]
async fn rollback_racing_edit_at_insert_race_loser_gets_typed_conflict() {
    let fixture = setup().await;
    let (page_id, _rev0, rev1) = fixture.page_at_revision_one("rp2-rollback").await;

    let lease = fixture.acquire_lease(3, page_id).await;

    let gate = fixture
        .gate_lock("LOCK TABLE page_revision IN SHARE MODE")
        .await;

    let edit_client = fixture.client.clone();
    let edit_address = fixture.address;
    let edit_session = fixture.session.clone();
    let edit_site = fixture.site_id;
    let editor = tokio::spawn(async move {
        rpc(
            &edit_client,
            edit_address,
            &edit_session,
            edit_site,
            &page_id.to_string(),
            (
                3,
                "page_edit",
                json!({
                    "site_id": edit_site,
                    "page": page_id,
                    "last_revision_id": rev1,
                    "revision_comments": "racing edit",
                    "user_id": ADMIN_USER_ID,
                    "wikitext": "racing edit content",
                    "ip_address": IP,
                    "lease": lease,
                }),
            ),
        )
        .await
    });

    fixture
        .wait_for_parked_inserts(1, Duration::from_secs(30))
        .await;

    let rollback_client = fixture.client.clone();
    let rollback_address = fixture.address;
    let rollback_session = fixture.session.clone();
    let rollback_site = fixture.site_id;
    let rollbacker = tokio::spawn(async move {
        rpc(
            &rollback_client,
            rollback_address,
            &rollback_session,
            rollback_site,
            &page_id.to_string(),
            (
                4,
                "page_rollback",
                json!({
                    "site_id": rollback_site,
                    "page": page_id,
                    "last_revision_id": rev1,
                    "revision_number": 0,
                    "revision_comments": "racing rollback",
                    "user_id": ADMIN_USER_ID,
                    "ip_address": IP,
                }),
            ),
        )
        .await
    });

    fixture
        .wait_for_row_lock_waiter(Duration::from_secs(30))
        .await;

    gate.commit()
        .await
        .expect("page_revision gate should release");
    let rollback_outcome = rollbacker.await.expect("rollback task should join");
    let edit_outcome = editor.await.expect("edit task should join");
    let winner = assert_one_winner_one_conflict(&rollback_outcome, &edit_outcome);
    assert_eq!(
        winner,
        edit_outcome
            .result_revision_id()
            .expect("the leased edit should be the winner"),
        "the edit holding the page row lock should win against the rollback"
    );

    fixture.assert_gapless_chain_at_tip(page_id, winner).await;
}

#[tokio::test]
async fn stale_save_without_race_is_typed_conflict() {
    let fixture = setup().await;
    let (page_id, rev0, rev1) = fixture.page_at_revision_one("rp0").await;

    let lease = fixture.acquire_lease(3, page_id).await;
    let committed = fixture
        .leased_edit(3, page_id, rev1, "fresh content", &lease)
        .await;
    let rev2 = committed
        .result_revision_id()
        .expect("leased save should commit");
    fixture.assert_gapless_chain_at_tip(page_id, rev2).await;

    let stale_edit = fixture
        .leased_edit(3, page_id, rev0, "stale content", &lease)
        .await;
    stale_edit.assert_typed_conflict();

    let stale_delete = fixture
        .call(
            4,
            &page_id.to_string(),
            "page_delete",
            json!({
                "site_id": fixture.site_id,
                "page": page_id,
                "last_revision_id": rev0,
                "revision_comments": "stale delete",
                "user_id": ADMIN_USER_ID,
                "ip_address": IP,
            }),
        )
        .await;
    stale_delete.assert_typed_conflict();

    let stale_move = fixture
        .call(
            5,
            &page_id.to_string(),
            "page_move",
            json!({
                "site_id": fixture.site_id,
                "page": page_id,
                "new_slug": format!("race-rp0-moved-{}", cuid()),
                "last_revision_id": rev0,
                "revision_comments": "stale move",
                "user_id": ADMIN_USER_ID,
                "ip_address": IP,
            }),
        )
        .await;
    stale_move.assert_typed_conflict();
}
