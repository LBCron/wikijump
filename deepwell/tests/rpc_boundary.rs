/*
 * tests/rpc_boundary.rs
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

use data_encoding::BASE32_NOPAD;
use deepwell::api::{build_server_at, build_server_state_without_workers};
use deepwell::config::{Config, Secrets};
use deepwell::constants::ADMIN_USER_ID;
use deepwell::error::ErrorType;
use deepwell::models::known_user::Entity as KnownUser;
use deepwell::models::session::Entity as SessionTable;
use deepwell::services::session::CreateSession;
use deepwell::services::{AuthenticationAttemptService, ServiceContext, SessionService};
use rust_otp::{Algorithm as TotpAlgorithm, TOTP};
use sea_orm::{
    ConnectionTrait, EntityTrait, Statement, TransactionTrait, Value as SqlValue,
};
use serde_json::{Value, json};
use std::env;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{SystemTime, UNIX_EPOCH};

async fn rpc_request(method: &str, params: Value) -> Value {
    let state = build_server_state_without_workers(
        Config::integration_testing(),
        Secrets::load(),
    )
    .await
    .expect("Unable to set up server state");
    let (address, handle) =
        build_server_at(state, SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("Unable to start RPC server");

    let response = reqwest::Client::new()
        .post(format!("http://{address}"))
        .bearer_auth(
            env::var("DEEPWELL_RPC_TOKEN").expect("test RPC token must be configured"),
        )
        .header("X-Deepwell-Site-Id", "42")
        .header("X-Deepwell-Page", "category:page")
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        }))
        .send()
        .await
        .expect("RPC request should complete")
        .json()
        .await
        .expect("RPC response should be JSON");

    handle.stop().expect("RPC server should stop");
    handle.stopped().await;
    response
}

async fn authentication_bucket_attempts(
    database: &sea_orm::DatabaseConnection,
    bucket_key: &str,
) -> Option<i64> {
    let row = database
        .query_one_raw(Statement::from_sql_and_values(
            database.get_database_backend(),
            "SELECT attempts FROM authentication_attempt WHERE bucket_key = $1",
            [SqlValue::from(bucket_key.to_owned())],
        ))
        .await
        .expect("authentication attempt query should succeed");
    row.map(|row| {
        row.try_get("", "attempts")
            .expect("attempt count should be an integer")
    })
}

async fn local_authoring_request(
    client: &reqwest::Client,
    address: SocketAddr,
    site_id: i64,
    marker: bool,
    id: u64,
    params: Value,
) -> Value {
    let mut request = client
        .post(format!("http://{address}"))
        .bearer_auth(
            env::var("DEEPWELL_RPC_TOKEN").expect("test RPC token must be configured"),
        )
        .header("X-Deepwell-Site-Id", site_id.to_string());
    if marker {
        request = request.header("X-Deepwell-Local-Page-Mutation-Actor", "-1");
    }
    request
        .json(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "page_create",
            "params": params,
        }))
        .send()
        .await
        .expect("local-authoring RPC request should complete")
        .json()
        .await
        .expect("local-authoring RPC response should be JSON")
}

#[tokio::test]
async fn production_rpc_binds_local_page_actor_only_to_the_editable_site() {
    let mut config = Config::integration_testing();
    config.main_domain_no_dot = "wikijump.localhost".to_owned();
    let state = build_server_state_without_workers(config, Secrets::load())
        .await
        .expect("local-authoring RPC state should build");
    let (address, handle) =
        build_server_at(state, SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("local-authoring RPC server should start");
    let client = reqwest::Client::new();

    let local_site = rpc_request("site_get", json!({"site": "scpaiueouiuiuiui"})).await;
    let local_site_id = local_site["result"]["site_id"]
        .as_i64()
        .expect("seeded editable local site should exist");
    let mirror = rpc_request("site_get", json!({"site": "scp-wiki"})).await;
    let mirror_site_id = mirror["result"]["site_id"]
        .as_i64()
        .expect("seeded SCP-Wiki mirror should exist");
    let slug = format!(
        "local-actor-boundary-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system clock should be after UNIX epoch")
            .as_nanos()
    );
    let page_params = |site_id| {
        json!({
            "site_id": site_id,
            "wikitext": "Local authoring actor RPC boundary fixture.",
            "title": "Local authoring actor RPC boundary fixture",
            "alt_title": null,
            "tags": [],
            "slug": slug,
            "layout": "wikidot",
            "revision_comments": "Exercise the local authoring RPC actor boundary",
            "user_id": -1,
            "ip_address": "127.0.0.1",
        })
    };

    let accepted = local_authoring_request(
        &client,
        address,
        local_site_id,
        true,
        1,
        page_params(local_site_id),
    )
    .await;
    assert!(
        accepted.get("result").is_some(),
        "the trusted local-site marker should bind the local actor: {accepted}"
    );

    let mirror_denied = local_authoring_request(
        &client,
        address,
        mirror_site_id,
        true,
        2,
        page_params(mirror_site_id),
    )
    .await;
    assert!(
        mirror_denied.get("error").is_some(),
        "the local actor must not bind to the mirror request site: {mirror_denied}"
    );

    let cross_site_denied = local_authoring_request(
        &client,
        address,
        mirror_site_id,
        true,
        3,
        page_params(local_site_id),
    )
    .await;
    assert!(
        cross_site_denied.get("error").is_some(),
        "a cross-site target must not bind the local actor: {cross_site_denied}"
    );

    let missing_marker_denied = local_authoring_request(
        &client,
        address,
        local_site_id,
        false,
        4,
        page_params(local_site_id),
    )
    .await;
    assert!(
        missing_marker_denied.get("error").is_some(),
        "ordinary anonymous requests must remain unauthenticated: {missing_marker_denied}"
    );

    handle
        .stop()
        .expect("local-authoring RPC server should stop");
    handle.stopped().await;
}

#[tokio::test]
async fn production_rpc_stack_dispatches_registered_method() {
    let response = rpc_request("echo", json!({"value": 42})).await;
    assert_eq!(response["result"], json!({"value": 42}));
    assert_eq!(response["id"], 1);
}

#[tokio::test]
async fn production_rpc_stack_converts_endpoint_errors() {
    let response = rpc_request("error", json!([])).await;
    assert!(response.get("result").is_none());
    assert_eq!(response["error"]["code"], ErrorType::BadRequest.code());
    assert_eq!(
        response["error"]["message"],
        ErrorType::BadRequest.summary(),
    );
    assert!(
        response["error"]["data"]["call_trace"]
            .as_str()
            .is_some_and(|trace| trace.contains("always fails")),
    );
}

#[tokio::test]
async fn production_rpc_stack_registers_page_watchers() {
    let response =
        rpc_request("page_watchers", json!({"site_id": 42, "page_id": 42})).await;

    assert_eq!(response["error"]["code"], ErrorType::PageNotFound.code());
    assert_ne!(response["error"]["code"], -32601);
}

#[tokio::test]
async fn production_rpc_stack_registers_page_who_rated() {
    let response =
        rpc_request("page_who_rated", json!({"site_id": 42, "page_id": 42})).await;

    assert_eq!(
        response["error"]["code"],
        ErrorType::PermissionDenied.code()
    );
    assert_ne!(response["error"]["code"], -32601);
}

async fn rpc_request_with_session(
    session_token: &str,
    method: &str,
    params: Value,
) -> Value {
    let state = build_server_state_without_workers(
        Config::integration_testing(),
        Secrets::load(),
    )
    .await
    .expect("Unable to set up server state");
    let (address, handle) =
        build_server_at(state, SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
            .await
            .expect("Unable to start RPC server");

    let response = reqwest::Client::new()
        .post(format!("http://{address}"))
        .bearer_auth(
            env::var("DEEPWELL_RPC_TOKEN").expect("test RPC token must be configured"),
        )
        .header("X-Deepwell-Site-Id", "42")
        .header("X-Deepwell-Page", "category:page")
        .header("X-Deepwell-Session-Token", session_token)
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": method,
            "params": params,
        }))
        .send()
        .await
        .expect("RPC request should complete")
        .json()
        .await
        .expect("RPC response should be JSON");

    handle.stop().expect("RPC server should stop");
    handle.stopped().await;
    response
}

#[tokio::test]
async fn production_rpc_stack_rolls_back_internal_failure_writes() {
    let state = build_server_state_without_workers(
        Config::integration_testing(),
        Secrets::load(),
    )
    .await
    .expect("Unable to set up server state");

    let session_token = {
        let txn = state
            .database
            .begin()
            .await
            .expect("Unable to start session transaction");
        let ctx = ServiceContext::new(&state, &txn);
        let token = SessionService::create(
            &ctx,
            CreateSession {
                user_id: ADMIN_USER_ID,
                ip_address: IpAddr::V4(Ipv4Addr::LOCALHOST),
                user_agent: "rpc-boundary-rollback-probe".to_owned(),
                restricted: false,
            },
        )
        .await
        .expect("admin session should be created");
        txn.commit()
            .await
            .expect("session transaction should commit");
        token
    };

    let probe_id = 1_000_000_000_i64
        + (SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .subsec_nanos() as i64)
            .rem_euclid(500_000_000);

    let response = rpc_request_with_session(
        &session_token,
        "user_create",
        json!({
            "user_type": "regular",
            "name": "rpc-boundary-rollback-probe",
            "email": "rpc-boundary-rollback-probe@example.com",
            "locales": ["en", "en"],
            "password": "password",
            "bypass_filter": true,
            "bypass_email_verification": true,
            "override_user_id": probe_id,
            "ip_address": "192.0.2.1",
        }),
    )
    .await;

    assert!(
        response.get("result").is_none(),
        "duplicate locales must be rejected: {response}",
    );
    assert_eq!(
        response["error"]["code"],
        ErrorType::BadRequest.code(),
        "the probe must reach locale validation after its placeholder write: {response}",
    );

    let txn = state
        .database
        .begin()
        .await
        .expect("Unable to start verification transaction");
    let placeholder = KnownUser::find_by_id(probe_id)
        .one(&txn)
        .await
        .expect("known_user lookup should succeed");
    txn.rollback()
        .await
        .expect("verification transaction should roll back");

    assert!(
        placeholder.is_none(),
        "an internal failure must roll back the known_user placeholder insert",
    );

    state
        .database
        .execute_unprepared(&format!(
            "DELETE FROM known_user WHERE user_id = {probe_id}"
        ))
        .await
        .ok();
    state
        .database
        .execute_unprepared(&format!(
            "DELETE FROM session WHERE session_token = '{}'",
            session_token.replace('\'', "''"),
        ))
        .await
        .ok();
}

#[tokio::test]
async fn production_rpc_stack_commits_terminal_mfa_rejection_state() {
    let state = build_server_state_without_workers(
        Config::integration_testing(),
        Secrets::load(),
    )
    .await
    .expect("Unable to set up server state");

    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after the Unix epoch")
        .as_nanos();
    let name = format!("Rpc Boundary Mfa {suffix}");
    let email = format!("rpc-boundary-mfa-{suffix}@example.com");
    let password = "rpc-boundary-mfa-password";

    let created = rpc_request(
        "user_create",
        json!({
            "user_type": "regular",
            "name": name,
            "email": email,
            "locales": ["en"],
            "password": password,
            "ip_address": "192.0.2.1",
        }),
    )
    .await;
    let user_id = created["result"]["user_id"]
        .as_i64()
        .unwrap_or_else(|| panic!("user_create should return a user id: {created}"));

    let login = rpc_request(
        "login",
        json!({
            "name_or_email": name,
            "password": password,
            "ip_address": "192.0.2.1",
            "user_agent": "rpc-boundary-mfa",
        }),
    )
    .await;
    assert_eq!(
        login["result"]["needs_mfa"],
        json!(false),
        "first login should not require MFA: {login}",
    );
    let session_token = login["result"]["session_token"]
        .as_str()
        .expect("login should return a session token")
        .to_owned();

    let setup = rpc_request(
        "mfa_setup",
        json!({
            "user_id": user_id,
            "session_token": session_token,
            "ip_address": "192.0.2.1",
        }),
    )
    .await;
    let secret = setup["result"]["totp_secret"]
        .as_str()
        .unwrap_or_else(|| panic!("mfa_setup should return a TOTP secret: {setup}"))
        .to_owned();

    let mfa_login = rpc_request(
        "login",
        json!({
            "name_or_email": name,
            "password": password,
            "ip_address": "192.0.2.1",
            "user_agent": "rpc-boundary-mfa",
        }),
    )
    .await;
    assert_eq!(
        mfa_login["result"]["needs_mfa"],
        json!(true),
        "second login should require MFA: {mfa_login}",
    );
    let restricted_token = mfa_login["result"]["session_token"]
        .as_str()
        .expect("MFA login should return a restricted session token")
        .to_owned();

    let secret_bytes = BASE32_NOPAD
        .decode(secret.as_bytes())
        .expect("generated TOTP secret should be valid base32");
    let totp = TOTP::builder()
        .secret(secret_bytes)
        .algorithm(TotpAlgorithm::SHA256)
        .digits(state.config.totp_digits)
        .time_step(state.config.totp_time_step)
        .build()
        .expect("TOTP builder should accept Deepwell configuration");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after the Unix epoch")
        .as_secs()
        .checked_add_signed(state.config.totp_time_skew)
        .expect("configured TOTP time offset should produce a valid timestamp");
    let valid_code = totp.generate_at(timestamp).to_string();
    let modulus = 10_u32.pow(state.config.totp_digits);
    let wrong_code = (valid_code
        .parse::<u32>()
        .expect("TOTP code should be numeric")
        + 1)
    .checked_rem(modulus)
    .expect("TOTP modulus should be nonzero")
    .to_string();

    let rejected = rpc_request(
        "mfa_verify",
        json!({
            "session_token": restricted_token,
            "totp_or_code": wrong_code,
            "ip_address": "192.0.2.1",
            "user_agent": "rpc-boundary-mfa",
        }),
    )
    .await;
    assert_eq!(
        rejected["error"]["code"],
        ErrorType::InvalidAuthentication.code(),
        "a wrong TOTP must be rejected: {rejected}",
    );

    let txn = state
        .database
        .begin()
        .await
        .expect("Unable to start verification transaction");
    let session = SessionTable::find_by_id(restricted_token.clone())
        .one(&txn)
        .await
        .expect("session lookup should succeed");
    txn.rollback()
        .await
        .expect("verification transaction should roll back");

    assert_eq!(
        session
            .expect("restricted session should exist")
            .mfa_failed_attempts,
        1,
        "a terminal MFA rejection must persist the failed-attempt counter",
    );

    for _ in 0..4 {
        let rejected = rpc_request(
            "mfa_verify",
            json!({
                "session_token": restricted_token,
                "totp_or_code": wrong_code,
                "ip_address": "192.0.2.1",
                "user_agent": "rpc-boundary-mfa",
            }),
        )
        .await;
        assert_eq!(
            rejected["error"]["code"],
            ErrorType::InvalidAuthentication.code(),
            "a wrong TOTP must be rejected: {rejected}",
        );
    }

    let fresh_login = rpc_request(
        "login",
        json!({
            "name_or_email": name,
            "password": password,
            "ip_address": "192.0.2.1",
            "user_agent": "rpc-boundary-mfa-fresh-session",
        }),
    )
    .await;
    let fresh_token = fresh_login["result"]["session_token"]
        .as_str()
        .expect("fresh login should return a restricted session token")
        .to_owned();
    let fresh_rejected = rpc_request(
        "mfa_verify",
        json!({
            "session_token": fresh_token,
            "totp_or_code": valid_code,
            "ip_address": "192.0.2.1",
            "user_agent": "rpc-boundary-mfa-fresh-session",
        }),
    )
    .await;
    assert_eq!(
        fresh_rejected["error"]["code"],
        ErrorType::InvalidAuthentication.code(),
        "a new restricted session must not restore the MFA guess budget: {fresh_rejected}",
    );

    let login_ip_bucket = AuthenticationAttemptService::login_ip_bucket("192.0.2.1");
    for statement in [
        format!("DELETE FROM session WHERE user_id = {user_id}"),
        format!(
            "DELETE FROM authentication_attempt WHERE bucket_key IN ('mfa:user:{user_id}', 'login:user:{user_id}', '{login_ip_bucket}')"
        ),
        format!("DELETE FROM \"user\" WHERE user_id = {user_id}"),
        format!("DELETE FROM known_user WHERE user_id = {user_id}"),
    ] {
        state.database.execute_unprepared(&statement).await.ok();
    }
}

#[tokio::test]
async fn production_rpc_stack_commits_password_failure_buckets() {
    let state = build_server_state_without_workers(
        Config::integration_testing(),
        Secrets::load(),
    )
    .await
    .expect("Unable to set up server state");
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after the Unix epoch")
        .as_nanos();
    let name = format!("Rpc Boundary Login {suffix}");
    let ip_address = "198.51.100.17";

    let created = rpc_request(
        "user_create",
        json!({
            "user_type": "regular",
            "name": name,
            "email": format!("rpc-boundary-login-{suffix}@example.com"),
            "locales": ["en"],
            "password": "rpc-boundary-login-password",
            "ip_address": ip_address,
        }),
    )
    .await;
    let user_id = created["result"]["user_id"]
        .as_i64()
        .unwrap_or_else(|| panic!("user_create should return a user id: {created}"));

    let mut rejection_code = None;
    for _ in 0..2 {
        let rejected = rpc_request(
            "login",
            json!({
                "name_or_email": name,
                "password": "wrong-rpc-boundary-login-password",
                "ip_address": ip_address,
                "user_agent": "rpc-boundary-login",
            }),
        )
        .await;
        let code = rejected["error"]["code"]
            .as_i64()
            .unwrap_or_else(|| panic!("bad password should be rejected: {rejected}"));
        assert_eq!(code, i64::from(ErrorType::InvalidAuthentication.code()));
        if let Some(previous_code) = rejection_code {
            assert_eq!(code, previous_code, "bad login responses stay generic");
        } else {
            rejection_code = Some(code);
        }
    }

    let login_ip_bucket = AuthenticationAttemptService::login_ip_bucket(ip_address);
    let login_pair_bucket =
        AuthenticationAttemptService::login_user_ip_bucket(user_id, ip_address);
    for (bucket_key, expected) in [
        (format!("login:user:{user_id}"), 2_i64),
        (login_pair_bucket.clone(), 2_i64),
        (login_ip_bucket.clone(), 2_i64),
    ] {
        let row = state
            .database
            .query_one_raw(Statement::from_sql_and_values(
                state.database.get_database_backend(),
                "SELECT attempts FROM authentication_attempt WHERE bucket_key = $1",
                [SqlValue::from(bucket_key.clone())],
            ))
            .await
            .expect("authentication attempt query should succeed")
            .unwrap_or_else(|| panic!("expected persisted auth bucket {bucket_key}"));
        let attempts: i64 = row
            .try_get("", "attempts")
            .expect("attempt count should be an integer");
        assert_eq!(attempts, expected, "bucket {bucket_key} should persist");
    }

    let successful_login = rpc_request(
        "login",
        json!({
            "name_or_email": name,
            "password": "rpc-boundary-login-password",
            "ip_address": ip_address,
            "user_agent": "rpc-boundary-login-success",
        }),
    )
    .await;
    assert!(
        successful_login["result"]["session_token"].is_string(),
        "a valid password should log in and clear prior failure buckets: {successful_login}",
    );
    assert_eq!(
        authentication_bucket_attempts(&state.database, &login_pair_bucket).await,
        None,
        "successful login should clear its own (account, IP) bucket",
    );
    for bucket_key in [format!("login:user:{user_id}"), login_ip_bucket.clone()] {
        assert_eq!(
            authentication_bucket_attempts(&state.database, &bucket_key).await,
            Some(2),
            "successful login must only release its own reservation from the \
             shared bucket {bucket_key}, leaving the failure count intact",
        );
    }

    for statement in [
        format!(
            "DELETE FROM authentication_attempt WHERE bucket_key IN ('login:user:{user_id}', '{login_pair_bucket}', '{login_ip_bucket}')"
        ),
        format!("DELETE FROM session WHERE user_id = {user_id}"),
        format!("DELETE FROM \"user\" WHERE user_id = {user_id}"),
        format!("DELETE FROM known_user WHERE user_id = {user_id}"),
    ] {
        state.database.execute_unprepared(&statement).await.ok();
    }
}

#[tokio::test]
async fn production_rpc_login_lockout_is_scoped_to_the_source_ip() {
    let state = build_server_state_without_workers(
        Config::integration_testing(),
        Secrets::load(),
    )
    .await
    .expect("Unable to set up server state");
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after the Unix epoch")
        .as_nanos();
    let name = format!("Rpc Boundary Lockout {suffix}");
    let password = "rpc-boundary-lockout-password";
    let attacker_ip = "203.0.113.9";
    let owner_ip = "192.0.2.77";

    let created = rpc_request(
        "user_create",
        json!({
            "user_type": "regular",
            "name": name,
            "email": format!("rpc-boundary-lockout-{suffix}@example.com"),
            "locales": ["en"],
            "password": password,
            "ip_address": attacker_ip,
        }),
    )
    .await;
    let user_id = created["result"]["user_id"]
        .as_i64()
        .unwrap_or_else(|| panic!("user_create should return a user id: {created}"));

    for _ in 0..11 {
        let rejected = rpc_request(
            "login",
            json!({
                "name_or_email": name,
                "password": "wrong-rpc-boundary-lockout-password",
                "ip_address": attacker_ip,
                "user_agent": "rpc-boundary-lockout-attacker",
            }),
        )
        .await;
        assert_eq!(
            rejected["error"]["code"].as_i64(),
            Some(i64::from(ErrorType::InvalidAuthentication.code())),
            "bad password should be rejected: {rejected}",
        );
    }

    let pair_bucket =
        AuthenticationAttemptService::login_user_ip_bucket(user_id, attacker_ip);
    assert_eq!(
        authentication_bucket_attempts(&state.database, &pair_bucket).await,
        Some(11),
        "the (account, IP) bucket should saturate from the attacking source",
    );
    assert_eq!(
        authentication_bucket_attempts(
            &state.database,
            &format!("login:user:{user_id}"),
        )
        .await,
        Some(10),
        "the account-global bucket should only count attempts that passed the pair reserve",
    );

    let refused = rpc_request(
        "login",
        json!({
            "name_or_email": name,
            "password": password,
            "ip_address": attacker_ip,
            "user_agent": "rpc-boundary-lockout-owner-same-ip",
        }),
    )
    .await;
    assert_eq!(
        refused["error"]["code"].as_i64(),
        Some(i64::from(ErrorType::InvalidAuthentication.code())),
        "the strict lockout must still refuse even the correct password from the saturated source: {refused}",
    );

    let login = rpc_request(
        "login",
        json!({
            "name_or_email": name,
            "password": password,
            "ip_address": owner_ip,
            "user_agent": "rpc-boundary-lockout-owner",
        }),
    )
    .await;
    assert!(
        login["result"]["session_token"].is_string(),
        "a lockout earned from one source IP must not refuse the owner logging in from another IP: {login}",
    );
    assert_eq!(
        authentication_bucket_attempts(
            &state.database,
            &format!("login:user:{user_id}"),
        )
        .await,
        Some(10),
        "the owner's success must not erase failures recorded against the account-global bucket",
    );

    let attacker_ip_bucket = AuthenticationAttemptService::login_ip_bucket(attacker_ip);
    let owner_ip_bucket = AuthenticationAttemptService::login_ip_bucket(owner_ip);
    for statement in [
        format!(
            "DELETE FROM authentication_attempt WHERE bucket_key LIKE 'login:user:{user_id}%' OR bucket_key IN ('{attacker_ip_bucket}', '{owner_ip_bucket}')"
        ),
        format!("DELETE FROM session WHERE user_id = {user_id}"),
        format!("DELETE FROM \"user\" WHERE user_id = {user_id}"),
        format!("DELETE FROM known_user WHERE user_id = {user_id}"),
    ] {
        state.database.execute_unprepared(&statement).await.ok();
    }
}

#[tokio::test]
async fn production_rpc_successful_login_keeps_shared_ip_bucket() {
    let state = build_server_state_without_workers(
        Config::integration_testing(),
        Secrets::load(),
    )
    .await
    .expect("Unable to set up server state");
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after the Unix epoch")
        .as_nanos();
    let ip_address = "198.51.100.23";
    let own_password = "rpc-boundary-spray-own-password";

    let mut user_ids = Vec::new();
    let create_user = |label: &str, user_password: &str| {
        let name = format!("Rpc Boundary Spray {label} {suffix}");
        let email = format!("rpc-boundary-spray-{label}-{suffix}@example.com");
        let password = user_password.to_owned();
        async move {
            let created = rpc_request(
                "user_create",
                json!({
                    "user_type": "regular",
                    "name": name,
                    "email": email,
                    "locales": ["en"],
                    "password": password,
                    "ip_address": ip_address,
                }),
            )
            .await;
            let user_id = created["result"]["user_id"].as_i64().unwrap_or_else(|| {
                panic!("user_create should return a user id: {created}")
            });
            (name, user_id)
        }
    };

    let mut target_names = Vec::new();
    for label in ["one", "two", "three"] {
        let (target_name, target_id) =
            create_user(label, "rpc-boundary-spray-target-password").await;
        target_names.push(target_name);
        user_ids.push(target_id);
    }
    let (own_name, own_id) = create_user("own", own_password).await;
    user_ids.push(own_id);

    for target_name in &target_names {
        for _ in 0..4 {
            let rejected = rpc_request(
                "login",
                json!({
                    "name_or_email": target_name,
                    "password": "wrong-rpc-boundary-spray-password",
                    "ip_address": ip_address,
                    "user_agent": "rpc-boundary-spray",
                }),
            )
            .await;
            assert_eq!(
                rejected["error"]["code"].as_i64(),
                Some(i64::from(ErrorType::InvalidAuthentication.code())),
                "bad password should be rejected: {rejected}",
            );
        }
    }

    let ip_bucket = AuthenticationAttemptService::login_ip_bucket(ip_address);
    assert_eq!(
        authentication_bucket_attempts(&state.database, &ip_bucket).await,
        Some(12),
        "failures spread across accounts should accumulate in the shared IP bucket",
    );

    let login = rpc_request(
        "login",
        json!({
            "name_or_email": own_name,
            "password": own_password,
            "ip_address": ip_address,
            "user_agent": "rpc-boundary-spray-own",
        }),
    )
    .await;
    assert!(
        login["result"]["session_token"].is_string(),
        "the attacker's own login should succeed: {login}",
    );
    assert_eq!(
        authentication_bucket_attempts(&state.database, &ip_bucket).await,
        Some(12),
        "one successful login must not clear the shared IP bucket that other accounts' failures filled",
    );

    for user_id in user_ids {
        for statement in [
            format!(
                "DELETE FROM authentication_attempt WHERE bucket_key LIKE 'login:user:{user_id}%'"
            ),
            format!("DELETE FROM session WHERE user_id = {user_id}"),
            format!("DELETE FROM \"user\" WHERE user_id = {user_id}"),
            format!("DELETE FROM known_user WHERE user_id = {user_id}"),
        ] {
            state.database.execute_unprepared(&statement).await.ok();
        }
    }
    state
        .database
        .execute_unprepared(&format!(
            "DELETE FROM authentication_attempt WHERE bucket_key = '{ip_bucket}'"
        ))
        .await
        .ok();
}

#[tokio::test]
async fn production_rpc_mfa_disable_attempts_persist_and_lock_out() {
    let state = build_server_state_without_workers(
        Config::integration_testing(),
        Secrets::load(),
    )
    .await
    .expect("Unable to set up server state");
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after the Unix epoch")
        .as_nanos();
    let ip_address = "192.0.2.14";
    let password = "rpc-boundary-mfa-disable-password";

    let valid_code = |secret: &str| -> String {
        let secret_bytes = BASE32_NOPAD
            .decode(secret.as_bytes())
            .expect("generated TOTP secret should be valid base32");
        let totp = TOTP::builder()
            .secret(secret_bytes)
            .algorithm(TotpAlgorithm::SHA256)
            .digits(state.config.totp_digits)
            .time_step(state.config.totp_time_step)
            .build()
            .expect("TOTP builder should accept Deepwell configuration");
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after the Unix epoch")
            .as_secs()
            .checked_add_signed(state.config.totp_time_skew)
            .expect("configured TOTP time offset should produce a valid timestamp");
        totp.generate_at(timestamp).to_string()
    };
    let wrong_code = |secret: &str| -> String {
        let modulus = 10_u32.pow(state.config.totp_digits);
        (valid_code(secret)
            .parse::<u32>()
            .expect("TOTP code should be numeric")
            + 1)
        .checked_rem(modulus)
        .expect("TOTP modulus should be nonzero")
        .to_string()
    };

    let setup_user = |label: &str| {
        let name = format!("Rpc Boundary Mfa Disable {label} {suffix}");
        let email = format!("rpc-boundary-mfa-disable-{label}-{suffix}@example.com");
        async move {
            let created = rpc_request(
                "user_create",
                json!({
                    "user_type": "regular",
                    "name": name,
                    "email": email,
                    "locales": ["en"],
                    "password": password,
                    "ip_address": ip_address,
                }),
            )
            .await;
            let user_id = created["result"]["user_id"].as_i64().unwrap_or_else(|| {
                panic!("user_create should return a user id: {created}")
            });

            let login = rpc_request(
                "login",
                json!({
                    "name_or_email": name,
                    "password": password,
                    "ip_address": ip_address,
                    "user_agent": "rpc-boundary-mfa-disable",
                }),
            )
            .await;
            let session_token = login["result"]["session_token"]
                .as_str()
                .unwrap_or_else(|| panic!("login should return a session token: {login}"))
                .to_owned();

            let setup = rpc_request(
                "mfa_setup",
                json!({
                    "user_id": user_id,
                    "session_token": session_token,
                    "ip_address": ip_address,
                }),
            )
            .await;
            let secret = setup["result"]["totp_secret"]
                .as_str()
                .unwrap_or_else(|| {
                    panic!("mfa_setup should return a TOTP secret: {setup}")
                })
                .to_owned();

            (user_id, session_token, secret)
        }
    };

    let disable = |user_id: i64, session_token: String, code: String| async move {
        rpc_request(
            "mfa_disable",
            json!({
                "user_id": user_id,
                "session_token": session_token,
                "ip_address": ip_address,
                "password": password,
                "totp_or_code": code,
            }),
        )
        .await
    };

    let (user_id, session_token, secret) = setup_user("first").await;
    let mfa_bucket = format!("mfa:user:{user_id}");
    for _ in 0..3 {
        let rejected = disable(user_id, session_token.clone(), wrong_code(&secret)).await;
        assert!(
            rejected.get("error").is_some(),
            "a wrong second factor must reject the disable: {rejected}",
        );
    }
    assert_eq!(
        authentication_bucket_attempts(&state.database, &mfa_bucket).await,
        Some(3),
        "failed mfa_disable attempts must persist their throttle reservation",
    );

    let disabled = disable(user_id, session_token.clone(), valid_code(&secret)).await;
    assert!(
        disabled.get("error").is_none(),
        "a correct disable before the cap should succeed: {disabled}",
    );
    assert_eq!(
        authentication_bucket_attempts(&state.database, &mfa_bucket).await,
        None,
        "a successful disable should clear the MFA bucket",
    );

    let (user_id_2, session_token_2, secret_2) = setup_user("second").await;
    let mfa_bucket_2 = format!("mfa:user:{user_id_2}");
    for _ in 0..5 {
        let rejected =
            disable(user_id_2, session_token_2.clone(), wrong_code(&secret_2)).await;
        assert!(
            rejected.get("error").is_some(),
            "a wrong second factor must reject the disable: {rejected}",
        );
    }
    assert_eq!(
        authentication_bucket_attempts(&state.database, &mfa_bucket_2).await,
        Some(5),
        "failed mfa_disable attempts should accumulate to the cap",
    );

    let refused =
        disable(user_id_2, session_token_2.clone(), valid_code(&secret_2)).await;
    assert!(
        refused.get("error").is_some(),
        "once the MFA bucket is saturated, even a correct disable must be refused: {refused}",
    );

    let ip_bucket = AuthenticationAttemptService::login_ip_bucket(ip_address);
    for user_id in [user_id, user_id_2] {
        for statement in [
            format!(
                "DELETE FROM authentication_attempt WHERE bucket_key LIKE 'login:user:{user_id}%' OR bucket_key = 'mfa:user:{user_id}'"
            ),
            format!("DELETE FROM session WHERE user_id = {user_id}"),
            format!("DELETE FROM \"user\" WHERE user_id = {user_id}"),
            format!("DELETE FROM known_user WHERE user_id = {user_id}"),
        ] {
            state.database.execute_unprepared(&statement).await.ok();
        }
    }
    state
        .database
        .execute_unprepared(&format!(
            "DELETE FROM authentication_attempt WHERE bucket_key = '{ip_bucket}'"
        ))
        .await
        .ok();
}

#[tokio::test]
async fn production_rpc_serializes_recovery_code_use_across_sessions() {
    let state = build_server_state_without_workers(
        Config::integration_testing(),
        Secrets::load(),
    )
    .await
    .expect("Unable to set up server state");
    let suffix = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock should be after the Unix epoch")
        .as_nanos();
    let name = format!("Rpc Boundary Recovery {suffix}");
    let email = format!("rpc-boundary-recovery-{suffix}@example.com");
    let password = "rpc-boundary-recovery-password";
    let ip_address = "203.0.113.29";

    let created = rpc_request(
        "user_create",
        json!({
            "user_type": "regular",
            "name": name,
            "email": email,
            "locales": ["en"],
            "password": password,
            "ip_address": ip_address,
        }),
    )
    .await;
    let user_id = created["result"]["user_id"]
        .as_i64()
        .unwrap_or_else(|| panic!("user_create should return a user id: {created}"));
    let initial_login = rpc_request(
        "login",
        json!({
            "name_or_email": name,
            "password": password,
            "ip_address": ip_address,
            "user_agent": "rpc-boundary-recovery-setup",
        }),
    )
    .await;
    let session_token = initial_login["result"]["session_token"]
        .as_str()
        .expect("initial login should return a session token")
        .to_owned();
    let setup = rpc_request(
        "mfa_setup",
        json!({
            "user_id": user_id,
            "session_token": session_token,
            "ip_address": ip_address,
        }),
    )
    .await;
    let recovery_code = setup["result"]["recovery_codes"][0]
        .as_str()
        .expect("MFA setup should return a recovery code")
        .to_owned();

    let login_attempt = |label: &'static str| {
        let name = name.clone();
        let password = password.to_owned();
        let ip_address = ip_address.to_owned();
        async move {
            let login = rpc_request(
                "login",
                json!({
                    "name_or_email": name,
                    "password": password,
                    "ip_address": ip_address,
                    "user_agent": format!("rpc-boundary-recovery-{label}"),
                }),
            )
            .await;
            login["result"]["session_token"]
                .as_str()
                .unwrap_or_else(|| {
                    panic!("MFA login should return a restricted session: {login}")
                })
                .to_owned()
        }
    };
    let (first_token, second_token) =
        tokio::join!(login_attempt("first"), login_attempt("second"),);

    let make_attempt = |token: String| {
        let recovery_code = recovery_code.clone();
        let ip_address = ip_address.to_owned();
        async move {
            rpc_request(
                "mfa_verify",
                json!({
                    "session_token": token,
                    "totp_or_code": recovery_code,
                    "ip_address": ip_address,
                    "user_agent": "rpc-boundary-recovery-race",
                }),
            )
            .await
        }
    };
    let (first, second) =
        tokio::join!(make_attempt(first_token), make_attempt(second_token));
    let first_succeeded = first.get("result").and_then(Value::as_str).is_some();
    let second_succeeded = second.get("result").and_then(Value::as_str).is_some();
    assert_ne!(
        first_succeeded, second_succeeded,
        "a recovery code must authenticate exactly one concurrent session: {first}, {second}",
    );

    let login_ip_bucket = AuthenticationAttemptService::login_ip_bucket(ip_address);
    for statement in [
        format!(
            "DELETE FROM authentication_attempt WHERE bucket_key IN ('mfa:user:{user_id}', 'login:user:{user_id}', '{login_ip_bucket}')"
        ),
        format!("DELETE FROM session WHERE user_id = {user_id}"),
        format!("DELETE FROM \"user\" WHERE user_id = {user_id}"),
        format!("DELETE FROM known_user WHERE user_id = {user_id}"),
    ] {
        state.database.execute_unprepared(&statement).await.ok();
    }
}
