/*
 * tests/user_delete_sessions.rs
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
use deepwell::services::RequestContext;
use deepwell::services::session::{CreateSession, SessionService};
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};

static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_n() -> u64 {
    FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed)
}

async fn create_session(runner: &TestRunner, user_id: i64) -> String {
    SessionService::create(
        runner.context(),
        CreateSession {
            user_id,
            ip_address: common::IP_ADDRESS,
            user_agent: "user-delete-sessions-test".to_owned(),
            restricted: false,
        },
    )
    .await
    .expect("session should be created")
}

#[tokio::test]
async fn user_delete_revokes_all_existing_sessions() {
    let mut runner = TestRunner::setup().await;
    let n = next_n();

    let victim = run_endpoint!(
        runner,
        user_create,
        json!({
            "user_type": "regular",
            "name": format!("Delete Revokes Victim {n}"),
            "email": format!("delete-revokes-victim-{n}@example.invalid"),
            "locales": ["en"],
            "password": "password-fixture",
            "ip_address": common::IP_ADDRESS,
        }),
    );
    let bystander = run_endpoint!(
        runner,
        user_create,
        json!({
            "user_type": "regular",
            "name": format!("Delete Revokes Bystander {n}"),
            "email": format!("delete-revokes-bystander-{n}@example.invalid"),
            "locales": ["en"],
            "password": "password-fixture",
            "ip_address": common::IP_ADDRESS,
        }),
    );

    let victim_token_a = create_session(&runner, victim.user_id).await;
    let victim_token_b = create_session(&runner, victim.user_id).await;
    let bystander_token = create_session(&runner, bystander.user_id).await;

    for token in [&victim_token_a, &victim_token_b, &bystander_token] {
        let session = SessionService::get_optional(runner.context(), token)
            .await
            .expect("session lookup should succeed");
        assert!(session.is_some(), "session should exist before deletion");
        let fetched = run_endpoint!(runner, auth_session_get, json!([token]),);
        assert!(fetched.is_some(), "session_get should return the session");
    }

    runner.set_request_context(RequestContext {
        user_id: Some(victim.user_id),
        ..Default::default()
    });
    let deleted = run_endpoint!(
        runner,
        user_delete,
        json!({
            "user": victim.user_id,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert!(deleted.deleted_at.is_some());

    for token in [&victim_token_a, &victim_token_b] {
        let session = SessionService::get_optional(runner.context(), token)
            .await
            .expect("session lookup should succeed");
        assert!(
            session.is_none(),
            "deleted user session must not resolve after user_delete",
        );
        let fetched = run_endpoint!(runner, auth_session_get, json!([token]),);
        assert!(
            fetched.is_none(),
            "session_get must not return a deleted user session",
        );
    }

    let bystander_session =
        SessionService::get_optional(runner.context(), &bystander_token)
            .await
            .expect("session lookup should succeed");
    assert!(
        bystander_session.is_some(),
        "another user session must survive the deletion of a different user",
    );
}
