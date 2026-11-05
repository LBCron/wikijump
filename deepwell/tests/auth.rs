/*
 * tests/auth.rs
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
use data_encoding::BASE32_NOPAD;
use deepwell::constants::ADMIN_USER_ID;
use deepwell::error::prelude::*;
use deepwell::models::audit_log::{Column as AuditLogColumn, Entity as AuditLogTable};
use deepwell::models::authorization_token::{
    Column as AuthorizationTokenColumn, Entity as AuthorizationTokenTable,
};
use deepwell::models::session::Entity as SessionTable;
use deepwell::services::RequestContext;
use deepwell::services::password::PasswordService;
use deepwell::services::session::SessionService;
use deepwell::services::user::{CreateUser, UserService};
use deepwell::types::{Reference, UserType};
use rust_otp::{Algorithm as TotpAlgorithm, TOTP};
use sea_orm::{ActiveValue, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter};
use serde_json::json;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use str_macro::str;

static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);
const PASSWORD: &str = "password-fixture";
const RECOVERY_CODE: &str = "mfa-recovery-code";
const TEST_MFA_SECRET: &str = "ABCDEFGHIJKLMNOP";

fn next_n() -> u64 {
    FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed)
}

async fn create_auth_test_user(runner: &TestRunner, n: u64, mfa: bool) -> (String, i64) {
    let name = format!("Auth Test {n}");
    let user = UserService::create(
        runner.context(),
        CreateUser {
            user_type: UserType::Regular,
            name: name.clone(),
            email: format!("auth-test-{n}@email.com"),
            locales: vec![str!("en")],
            password: PASSWORD.to_owned(),
            bypass_filter: true,
            bypass_email_verification: true,
            override_user_id: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("auth test user should be created");

    if mfa {
        let recovery_hash =
            PasswordService::new_hash(RECOVERY_CODE).expect("recovery code should hash");
        UserService::set_mfa_secrets(
            runner.context(),
            user.user_id,
            ActiveValue::Set(Some(TEST_MFA_SECRET.to_owned())),
            ActiveValue::Set(Some(vec![recovery_hash])),
        )
        .await
        .expect("auth test user should have MFA enabled");
    }

    (name, user.user_id)
}

fn login_params(name: &str) -> serde_json::Value {
    json!({
        "name_or_email": name,
        "password": PASSWORD,
        "ip_address": common::IP_ADDRESS,
        "user_agent": "deepwell-auth-test",
    })
}

fn current_totp(secret: &str, runner: &TestRunner) -> u32 {
    let secret_bytes = BASE32_NOPAD
        .decode(secret.as_bytes())
        .expect("test TOTP secret should be valid base32");
    let totp = TOTP::builder()
        .secret(secret_bytes)
        .algorithm(TotpAlgorithm::SHA256)
        .digits(runner.config().totp_digits)
        .time_step(runner.config().totp_time_step)
        .build()
        .expect("TOTP builder should accept Deepwell configuration");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("test clock should be after the Unix epoch")
        .as_secs()
        .checked_add_signed(runner.config().totp_time_skew)
        .expect("configured TOTP time offset should produce a valid timestamp");

    totp.generate_at(timestamp)
}

fn wrong_current_totp(runner: &TestRunner) -> String {
    let code = current_totp(TEST_MFA_SECRET, runner);
    let modulus = 10_u32.pow(runner.config().totp_digits);
    ((code + 1) % modulus).to_string()
}

#[tokio::test]
async fn restricted_mfa_sessions_are_not_normal_login_sessions() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let (name, user_id) = create_auth_test_user(&runner, n, true).await;

    let restricted_login = run_endpoint!(runner, auth_login, login_params(&name));
    assert!(restricted_login.needs_mfa);

    let restricted_session = run_endpoint!(
        runner,
        auth_session_get,
        json!([restricted_login.session_token])
    );
    assert!(
        restricted_session.is_none(),
        "restricted MFA session must not be returned by normal session_get",
    );

    let renew_login = run_endpoint!(runner, auth_login, login_params(&name));
    assert!(renew_login.needs_mfa);
    let renew_error = run_endpoint_err!(
        runner,
        auth_session_renew,
        json!([{
            "old_session_token": renew_login.session_token,
            "user_id": user_id,
            "ip_address": common::IP_ADDRESS,
            "user_agent": "deepwell-auth-test-renew",
        }]),
    );
    assert_contains_error!(renew_error, ErrorType::InvalidSessionToken);

    let mfa_login = run_endpoint!(runner, auth_login, login_params(&name));
    assert!(mfa_login.needs_mfa);
    let session_token = run_endpoint!(
        runner,
        auth_mfa_verify,
        json!({
            "session_token": mfa_login.session_token,
            "totp_or_code": RECOVERY_CODE,
            "ip_address": common::IP_ADDRESS,
            "user_agent": "deepwell-auth-test-mfa",
        }),
    );
    let session = run_endpoint!(runner, auth_session_get, json!([session_token]))
        .expect("MFA-verified session should be a normal session");
    assert!(!session.restricted);

    let replay_error = run_endpoint_err!(
        runner,
        auth_mfa_verify,
        json!({
            "session_token": mfa_login.session_token,
            "totp_or_code": RECOVERY_CODE,
            "ip_address": common::IP_ADDRESS,
            "user_agent": "deepwell-auth-test-mfa-replay",
        }),
    );
    assert_contains_error!(replay_error, ErrorType::InvalidAuthentication);
}

#[tokio::test]
async fn restricted_mfa_session_has_a_shared_five_failure_budget() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let (name, _) = create_auth_test_user(&runner, n, true).await;

    let below_limit_login = run_endpoint!(runner, auth_login, login_params(&name));
    for expected_failures in 1..SessionService::MAX_MFA_FAILED_ATTEMPTS {
        let error = run_endpoint_err!(
            runner,
            auth_mfa_verify,
            json!({
                "session_token": below_limit_login.session_token,
                "totp_or_code": wrong_current_totp(&runner),
                "ip_address": common::IP_ADDRESS,
                "user_agent": "deepwell-auth-test-mfa-wrong",
            }),
        );
        assert_contains_error!(error, ErrorType::InvalidAuthentication);

        let session = SessionTable::find_by_id(&below_limit_login.session_token)
            .one(runner.context().transaction())
            .await
            .expect("restricted session lookup should succeed")
            .expect("restricted session should remain below the failure limit");
        assert_eq!(session.mfa_failed_attempts, expected_failures);
    }

    let normal_token = run_endpoint!(
        runner,
        auth_mfa_verify,
        json!({
            "session_token": below_limit_login.session_token,
            "totp_or_code": current_totp(TEST_MFA_SECRET, &runner).to_string(),
            "ip_address": common::IP_ADDRESS,
            "user_agent": "deepwell-auth-test-mfa-valid-below-limit",
        }),
    );
    let normal_session = run_endpoint!(runner, auth_session_get, json!([normal_token]))
        .expect("valid TOTP below the failure limit should complete login");
    assert!(!normal_session.restricted);
    assert_eq!(normal_session.mfa_failed_attempts, 0);
    assert!(
        SessionTable::find_by_id(&below_limit_login.session_token)
            .one(runner.context().transaction())
            .await
            .expect("consumed restricted session lookup should succeed")
            .is_none(),
        "successful MFA must consume the restricted session",
    );

    let exhausted_login = run_endpoint!(runner, auth_login, login_params(&name));
    let recovery_error = run_endpoint_err!(
        runner,
        auth_mfa_verify,
        json!({
            "session_token": exhausted_login.session_token,
            "totp_or_code": "not-a-valid-recovery-code",
            "ip_address": common::IP_ADDRESS,
            "user_agent": "deepwell-auth-test-mfa-wrong-recovery",
        }),
    );
    assert_contains_error!(recovery_error, ErrorType::InvalidAuthentication);

    for _ in 1..SessionService::MAX_MFA_FAILED_ATTEMPTS {
        let error = run_endpoint_err!(
            runner,
            auth_mfa_verify,
            json!({
                "session_token": exhausted_login.session_token,
                "totp_or_code": wrong_current_totp(&runner),
                "ip_address": common::IP_ADDRESS,
                "user_agent": "deepwell-auth-test-mfa-exhaust",
            }),
        );
        assert_contains_error!(error, ErrorType::InvalidAuthentication);
    }

    let exhausted_session = SessionTable::find_by_id(&exhausted_login.session_token)
        .one(runner.context().transaction())
        .await
        .expect("exhausted restricted session lookup should succeed")
        .expect("exhausted restricted session should remain for expiry pruning");
    assert!(exhausted_session.restricted);
    assert_eq!(
        exhausted_session.mfa_failed_attempts,
        SessionService::MAX_MFA_FAILED_ATTEMPTS,
    );

    let locked_out_error = run_endpoint_err!(
        runner,
        auth_mfa_verify,
        json!({
            "session_token": exhausted_login.session_token,
            "totp_or_code": current_totp(TEST_MFA_SECRET, &runner).to_string(),
            "ip_address": common::IP_ADDRESS,
            "user_agent": "deepwell-auth-test-mfa-after-exhaustion",
        }),
    );
    assert_contains_error!(locked_out_error, ErrorType::InvalidAuthentication);

    let fresh_login = run_endpoint!(runner, auth_login, login_params(&name));
    let fresh_session_error = run_endpoint_err!(
        runner,
        auth_mfa_verify,
        json!({
            "session_token": fresh_login.session_token,
            "totp_or_code": current_totp(TEST_MFA_SECRET, &runner).to_string(),
            "ip_address": common::IP_ADDRESS,
            "user_agent": "deepwell-auth-test-mfa-fresh-session",
        }),
    );
    assert_contains_error!(fresh_session_error, ErrorType::InvalidAuthentication);
}

#[tokio::test]
async fn unrestricted_sessions_still_get_and_renew_normally() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let (name, _) = create_auth_test_user(&runner, n, false).await;

    let login = run_endpoint!(runner, auth_login, login_params(&name));
    assert!(!login.needs_mfa);

    let session = run_endpoint!(
        runner,
        auth_session_get,
        json!([login.session_token.clone()])
    )
    .expect("normal login session should be returned by session_get");
    assert!(!session.restricted);

    let renewed = run_endpoint!(
        runner,
        auth_session_renew,
        json!([{
            "old_session_token": login.session_token,
            "user_id": session.user_id,
            "ip_address": common::IP_ADDRESS,
            "user_agent": "deepwell-auth-test-renew",
        }]),
    );
    let renewed_session = run_endpoint!(runner, auth_session_get, json!([renewed]))
        .expect("renewed normal session should be returned by session_get");
    assert!(!renewed_session.restricted);
}

#[tokio::test]
async fn logout_invalidates_only_the_named_session_and_rejects_reuse() {
    let runner = TestRunner::setup().await;
    let (name, _) = create_auth_test_user(&runner, next_n(), false).await;
    let first = run_endpoint!(runner, auth_login, login_params(&name));
    let second = run_endpoint!(runner, auth_login, login_params(&name));

    run_endpoint!(runner, auth_logout, json!([first.session_token.clone()]));
    assert!(
        run_endpoint!(
            runner,
            auth_session_get,
            json!([first.session_token.clone()])
        )
        .is_none(),
        "logout must remove the named session",
    );
    assert!(
        run_endpoint!(runner, auth_session_get, json!([second.session_token])).is_some(),
        "logout must preserve the user's other session",
    );
    for token in [first.session_token, "missing-logout-session".to_owned()] {
        let error = run_endpoint_err!(runner, auth_logout, json!([token]));
        assert_contains_error!(error, ErrorType::InvalidSessionToken);
    }
}

#[tokio::test]
async fn soft_deleted_users_cannot_authenticate_by_retained_name_or_slug() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let (name, user_id) = create_auth_test_user(&runner, n, false).await;
    let deleted = UserService::delete(
        runner.context(),
        Reference::Id(user_id),
        user_id,
        common::IP_ADDRESS,
    )
    .await
    .expect("auth test user should be deleted");

    for identifier in [name.as_str(), deleted.slug.as_str()] {
        let error = run_endpoint_err!(runner, auth_login, login_params(identifier));
        assert_contains_error!(error, ErrorType::InvalidAuthentication);
    }
}

#[tokio::test]
async fn session_other_listing_and_invalidation_keep_current_session() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let (name, user_id) = create_auth_test_user(&runner, n, false).await;

    let first = run_endpoint!(runner, auth_login, login_params(&name));
    let current = run_endpoint!(runner, auth_login, login_params(&name));
    let third = run_endpoint!(runner, auth_login, login_params(&name));

    let sessions = run_endpoint!(
        runner,
        auth_session_get_others,
        json!({
            "user_id": user_id,
            "session_token": current.session_token,
        }),
    );
    assert_eq!(sessions.current.session_token, current.session_token);
    assert_eq!(sessions.others.len(), 2);
    assert!(
        sessions
            .others
            .iter()
            .any(|session| session.session_token == first.session_token)
    );
    assert!(
        sessions
            .others
            .iter()
            .any(|session| session.session_token == third.session_token)
    );

    let invalidated = run_endpoint!(
        runner,
        auth_session_invalidate_others,
        json!({
            "user_id": user_id,
            "session_token": current.session_token,
        }),
    );
    assert_eq!(invalidated, 2);

    assert!(
        run_endpoint!(
            runner,
            auth_session_get,
            json!([current.session_token.clone()])
        )
        .is_some()
    );
    assert!(
        run_endpoint!(runner, auth_session_get, json!([first.session_token])).is_none()
    );
    assert!(
        run_endpoint!(runner, auth_session_get, json!([third.session_token])).is_none()
    );
}

#[tokio::test]
async fn session_get_others_rejects_restricted_tokens() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let (name, user_id) = create_auth_test_user(&runner, n, true).await;

    let restricted_login = run_endpoint!(runner, auth_login, login_params(&name));
    assert!(restricted_login.needs_mfa);
    let full_token = run_endpoint!(
        runner,
        auth_mfa_verify,
        json!({
            "session_token": restricted_login.session_token,
            "totp_or_code": current_totp(TEST_MFA_SECRET, &runner).to_string(),
            "ip_address": common::IP_ADDRESS,
            "user_agent": "deepwell-auth-test-totp",
        }),
    );
    let second_restricted = run_endpoint!(runner, auth_login, login_params(&name));
    assert!(second_restricted.needs_mfa);

    // A restricted (pre-MFA) token must not authenticate the listing, exactly
    // like a foreign or bogus token: uniform 3001, no disclosure.
    let error = run_endpoint_err!(
        runner,
        auth_session_get_others,
        json!({
            "user_id": user_id,
            "session_token": second_restricted.session_token,
        }),
    );
    assert_contains_error!(error, ErrorType::InvalidSessionToken);

    // And restricted rows must not appear in a full token's listing either.
    let sessions = run_endpoint!(
        runner,
        auth_session_get_others,
        json!({
            "user_id": user_id,
            "session_token": full_token,
        }),
    );
    assert_eq!(sessions.current.session_token, full_token);
    assert!(
        sessions.others.is_empty(),
        "restricted sessions must not appear in session_get_others output",
    );
}

#[tokio::test]
async fn live_session_count_per_account_is_capped_with_oldest_eviction() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let (name, user_id) = create_auth_test_user(&runner, n, false).await;

    let cap = SessionService::MAX_LIVE_SESSIONS_PER_USER as usize;
    let mut tokens = Vec::new();
    for _ in 0..cap + 2 {
        let login = run_endpoint!(runner, auth_login, login_params(&name));
        assert!(!login.needs_mfa);
        tokens.push(login.session_token);
    }

    let sessions = SessionService::get_all(runner.context(), user_id)
        .await
        .expect("session listing should succeed");
    assert_eq!(sessions.len(), cap);

    let live: Vec<&str> = sessions
        .iter()
        .map(|session| session.session_token.as_str())
        .collect();
    assert!(
        !live.contains(&tokens[0].as_str()),
        "oldest session should have been evicted",
    );
    assert!(
        !live.contains(&tokens[1].as_str()),
        "second-oldest session should have been evicted",
    );
    assert!(
        live.contains(&tokens[cap + 1].as_str()),
        "newest session must survive cap enforcement",
    );

    let fetched =
        run_endpoint!(runner, auth_session_get, json!([tokens[cap + 1].clone()]));
    assert!(
        fetched.is_some(),
        "newest session must still authenticate after eviction",
    );
    let evicted = run_endpoint!(runner, auth_session_get, json!([tokens[0].clone()]));
    assert!(evicted.is_none(), "evicted session must no longer resolve",);
}

#[tokio::test]
async fn mfa_setup_reset_disable_and_totp_login_flow() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let (name, user_id) = create_auth_test_user(&runner, n, false).await;
    let login = run_endpoint!(runner, auth_login, login_params(&name));
    assert!(!login.needs_mfa);

    let setup = run_endpoint!(
        runner,
        auth_mfa_setup,
        json!({
            "user_id": user_id,
            "session_token": login.session_token,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(
        setup.recovery_codes.len(),
        runner.config().recovery_code_count,
    );

    let user = UserService::get_real(runner.context(), Reference::Id(user_id))
        .await
        .expect("user lookup after MFA setup should succeed");
    assert_eq!(
        user.multi_factor_secret.as_deref(),
        Some(setup.totp_secret.as_str())
    );
    assert_eq!(
        user.multi_factor_recovery_codes
            .as_ref()
            .expect("recovery hashes should be stored")
            .len(),
        runner.config().recovery_code_count,
    );

    let mfa_login = run_endpoint!(runner, auth_login, login_params(&name));
    assert!(mfa_login.needs_mfa);
    let secret_bytes = BASE32_NOPAD
        .decode(setup.totp_secret.as_bytes())
        .expect("generated TOTP secret should be valid base32");
    let totp = TOTP::builder()
        .secret(secret_bytes)
        .algorithm(TotpAlgorithm::SHA256)
        .digits(runner.config().totp_digits)
        .time_step(runner.config().totp_time_step)
        .build()
        .expect("TOTP builder should accept Deepwell configuration");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("test clock should be after the Unix epoch")
        .as_secs()
        .checked_add_signed(runner.config().totp_time_skew)
        .expect("configured TOTP time offset should produce a valid timestamp");
    let session_token = run_endpoint!(
        runner,
        auth_mfa_verify,
        json!({
            "session_token": mfa_login.session_token,
            "totp_or_code": totp.generate_at(timestamp).to_string(),
            "ip_address": common::IP_ADDRESS,
            "user_agent": "deepwell-auth-test-totp",
        }),
    );
    let session = run_endpoint!(runner, auth_session_get, json!([session_token]))
        .expect("TOTP-verified session should be normal");
    assert!(!session.restricted);

    let reset = run_endpoint!(
        runner,
        auth_mfa_reset_recovery,
        json!({
            "user_id": user_id,
            "session_token": login.session_token,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(
        reset.recovery_codes.len(),
        runner.config().recovery_code_count,
    );

    run_endpoint!(
        runner,
        auth_mfa_disable,
        json!({
            "user_id": user_id,
            "session_token": login.session_token,
            "ip_address": common::IP_ADDRESS,
            "password": PASSWORD,
            "totp_or_code": reset.recovery_codes[0].clone(),
        }),
    );
    let user = UserService::get_real(runner.context(), Reference::Id(user_id))
        .await
        .expect("user lookup after MFA disable should succeed");
    assert!(user.multi_factor_secret.is_none());
    assert!(user.multi_factor_recovery_codes.is_none());
}

#[tokio::test]
async fn restricted_mfa_sessions_expire_after_repeated_failed_totp_attempts() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let (name, _) = create_auth_test_user(&runner, n, true).await;
    let login = run_endpoint!(runner, auth_login, login_params(&name));
    assert!(login.needs_mfa);

    let secret_bytes = BASE32_NOPAD
        .decode(TEST_MFA_SECRET.as_bytes())
        .expect("test TOTP secret should be valid base32");
    let totp = TOTP::builder()
        .secret(secret_bytes)
        .algorithm(TotpAlgorithm::SHA256)
        .digits(runner.config().totp_digits)
        .time_step(runner.config().totp_time_step)
        .build()
        .expect("TOTP builder should accept Deepwell configuration");
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("test clock should be after the Unix epoch")
        .as_secs()
        .checked_add_signed(runner.config().totp_time_skew)
        .expect("configured TOTP time offset should produce a valid timestamp");
    let valid_code = totp.generate_at(timestamp).to_string();
    let modulus = 10_u32.pow(runner.config().totp_digits);
    let wrong_code = (valid_code
        .parse::<u32>()
        .expect("TOTP code should be numeric")
        + 1)
    .checked_rem(modulus)
    .expect("TOTP modulus should be nonzero")
    .to_string();

    for attempt in 0..5 {
        let error = run_endpoint_err!(
            runner,
            auth_mfa_verify,
            json!({
                "session_token": login.session_token,
                "totp_or_code": wrong_code,
                "ip_address": common::IP_ADDRESS,
                "user_agent": format!("deepwell-auth-test-wrong-totp-{attempt}"),
            }),
        );
        assert_contains_error!(error, ErrorType::InvalidAuthentication);
    }

    let error = run_endpoint_err!(
        runner,
        auth_mfa_verify,
        json!({
            "session_token": login.session_token,
            "totp_or_code": valid_code,
            "ip_address": common::IP_ADDRESS,
            "user_agent": "deepwell-auth-test-after-totp-budget",
        }),
    );
    assert_contains_error!(error, ErrorType::InvalidAuthentication);
}

#[tokio::test]
async fn authorization_token_issue_requires_admin_request_context() {
    let mut runner = TestRunner::setup().await;

    let anonymous_error = run_endpoint_err!(
        runner,
        auth_token_issue,
        json!({
            "type": "bot-user",
            "description": "anonymous bot authorization token",
            "creating_user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(anonymous_error, ErrorType::PermissionDenied);

    let n = next_n();
    let (_, user_id) = create_auth_test_user(&runner, n, false).await;
    runner.set_request_context(RequestContext {
        user_id: Some(user_id),
        ..Default::default()
    });

    let non_admin_error = run_endpoint_err!(
        runner,
        auth_token_issue,
        json!({
            "type": "bot-user",
            "description": "non-admin bot authorization token",
            "creating_user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(non_admin_error, ErrorType::PermissionDenied);

    let issued_count = AuthorizationTokenTable::find()
        .filter(AuthorizationTokenColumn::Description.is_in([
            "anonymous bot authorization token",
            "non-admin bot authorization token",
        ]))
        .count(runner.context().transaction())
        .await
        .expect("authorization token count should succeed");
    assert_eq!(issued_count, 0);
}

#[tokio::test]
async fn authorization_token_issue_uses_admin_request_actor() {
    let mut runner = TestRunner::setup().await;
    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        ..Default::default()
    });

    let token = run_endpoint!(
        runner,
        auth_token_issue,
        json!({
            "type": "bot-user",
            "description": "authorized bot token from request actor",
            "creating_user_id": 12345,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert!(token.starts_with("B-"));

    let token_record = AuthorizationTokenTable::find()
        .filter(AuthorizationTokenColumn::TokenValue.eq(&token))
        .one(runner.context().transaction())
        .await
        .expect("authorization token lookup should succeed")
        .expect("authorization token should be persisted");
    assert_eq!(token_record.created_by, ADMIN_USER_ID);

    let audit_record = AuditLogTable::find()
        .filter(AuditLogColumn::EventType.eq("authorization_token.create"))
        .one(runner.context().transaction())
        .await
        .expect("authorization token audit lookup should succeed")
        .expect("authorization token issue should be audited");
    assert_eq!(audit_record.user_id, Some(ADMIN_USER_ID));
    assert_eq!(audit_record.ip_address.ip(), common::IP_ADDRESS);
    assert_eq!(audit_record.extra_string_1.as_deref(), Some("bot-user"));
    assert!(
        audit_record.extra_string_2.as_deref().is_some_and(
            |metadata| metadata.contains("authorized bot token from request actor")
        ),
        "audit metadata should include the submitted description",
    );
}

#[tokio::test]
async fn account_holders_change_their_password_with_the_current_one() {
    const NEW_PASSWORD: &str = "a-new-password-for-2026";

    let mut runner = TestRunner::setup().await;
    let n = next_n();
    let (name, user_id) = create_auth_test_user(&runner, n, false).await;
    let current = run_endpoint!(runner, auth_login, login_params(&name));
    let other = run_endpoint!(runner, auth_login, login_params(&name));
    let session = SessionService::get(runner.context(), &current.session_token)
        .await
        .expect("the login session should exist");
    runner.set_request_context(RequestContext {
        session: Some(session),
        user_id: Some(user_id),
        ..Default::default()
    });

    let edit_error = run_endpoint_err!(
        runner,
        user_edit,
        json!({
            "user": user_id,
            "password": NEW_PASSWORD,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(edit_error, ErrorType::PermissionDenied);

    let wrong_current = run_endpoint_err!(
        runner,
        user_password_change,
        json!({
            "current_password": "not-the-current-password",
            "new_password": NEW_PASSWORD,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(wrong_current, ErrorType::InvalidAuthentication);

    let too_short = run_endpoint_err!(
        runner,
        user_password_change,
        json!({
            "current_password": PASSWORD,
            "new_password": "",
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(
        too_short,
        ErrorType::UserPasswordTooShort {
            length: 0,
            minimum: 15,
        },
    );

    let changed = run_endpoint!(
        runner,
        user_password_change,
        json!({
            "current_password": PASSWORD,
            "new_password": NEW_PASSWORD,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(changed.other_sessions_revoked, 1);

    assert!(
        SessionService::get_optional(runner.context(), &current.session_token)
            .await
            .unwrap()
            .is_some()
    );
    assert!(
        SessionService::get_optional(runner.context(), &other.session_token)
            .await
            .unwrap()
            .is_none()
    );

    runner.set_request_context(RequestContext::default());
    run_endpoint_err!(runner, auth_login, login_params(&name));
    let renewed = run_endpoint!(
        runner,
        auth_login,
        json!({
            "name_or_email": name,
            "password": NEW_PASSWORD,
            "ip_address": common::IP_ADDRESS,
            "user_agent": "deepwell-auth-test",
        })
    );
    assert!(!renewed.needs_mfa);
}

#[tokio::test]
async fn saturated_account_bucket_locks_out_even_the_correct_password() {
    const LOCKOUT_TEST_IP: &str = "127.0.0.200";

    let runner = TestRunner::setup().await;
    let n = next_n();
    let (name, _) = create_auth_test_user(&runner, n, false).await;
    let (other_name, _) = create_auth_test_user(&runner, next_n(), false).await;

    let login_params_for = |name_or_email: &str, password: &str| {
        json!({
            "name_or_email": name_or_email,
            "password": password,
            "ip_address": LOCKOUT_TEST_IP,
            "user_agent": "deepwell-auth-test-lockout",
        })
    };

    for _ in 0..10 {
        let error = run_endpoint_err!(
            runner,
            auth_login,
            login_params_for(&name, "wrong-password-fixture")
        );
        assert_contains_error!(error, ErrorType::InvalidAuthentication);
    }

    // The account bucket (10 per 600 seconds) is now saturated: further
    // attempts against this account are rejected before password
    // verification, with the same uniform error as a wrong password.
    let error = run_endpoint_err!(
        runner,
        auth_login,
        login_params_for(&name, "wrong-password-fixture")
    );
    assert_contains_error!(error, ErrorType::InvalidAuthentication);

    let error = run_endpoint_err!(runner, auth_login, login_params_for(&name, PASSWORD));
    assert_contains_error!(error, ErrorType::InvalidAuthentication);

    // A different account from the same address is unaffected, and its
    // success does not clear the locked account's bucket.
    let other_login =
        run_endpoint!(runner, auth_login, login_params_for(&other_name, PASSWORD));
    assert!(!other_login.needs_mfa);

    let error = run_endpoint_err!(runner, auth_login, login_params_for(&name, PASSWORD));
    assert_contains_error!(error, ErrorType::InvalidAuthentication);
}
#[tokio::test]
async fn totp_code_cannot_be_replayed_for_a_second_login() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let (name, user_id) = create_auth_test_user(&runner, n, true).await;

    let code = current_totp(TEST_MFA_SECRET, &runner);

    let first_login = run_endpoint!(runner, auth_login, login_params(&name));
    assert!(first_login.needs_mfa);
    run_endpoint!(
        runner,
        auth_mfa_verify,
        json!({
            "session_token": first_login.session_token,
            "totp_or_code": code.to_string(),
            "ip_address": common::IP_ADDRESS,
            "user_agent": "deepwell-auth-test-totp-first",
        }),
    );

    // The same code inside the same window must not authenticate again.
    let second_login = run_endpoint!(runner, auth_login, login_params(&name));
    assert!(second_login.needs_mfa);
    let replay_error = run_endpoint_err!(
        runner,
        auth_mfa_verify,
        json!({
            "session_token": second_login.session_token,
            "totp_or_code": code.to_string(),
            "ip_address": common::IP_ADDRESS,
            "user_agent": "deepwell-auth-test-totp-replay",
        }),
    );
    assert_contains_error!(replay_error, ErrorType::InvalidAuthentication);

    // Simulate the last accepted code having come from the previous step:
    // a code for the current (later) step must still be accepted.
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("test clock should be after the Unix epoch")
        .as_secs();
    let current_step = (now as i64 + runner.config().totp_time_skew)
        / runner.config().totp_time_step as i64;
    UserService::set_mfa_last_totp_step(
        runner.context(),
        user_id,
        ActiveValue::Set(Some(current_step - 1)),
    )
    .await
    .expect("rewinding the last accepted TOTP step should succeed");

    let next_login = run_endpoint!(runner, auth_login, login_params(&name));
    assert!(next_login.needs_mfa);
    run_endpoint!(
        runner,
        auth_mfa_verify,
        json!({
            "session_token": next_login.session_token,
            "totp_or_code": current_totp(TEST_MFA_SECRET, &runner).to_string(),
            "ip_address": common::IP_ADDRESS,
            "user_agent": "deepwell-auth-test-totp-next-step",
        }),
    );
}

#[tokio::test]
async fn mfa_disable_requires_password_and_second_factor() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let (name, user_id) = create_auth_test_user(&runner, n, true).await;

    let login = run_endpoint!(runner, auth_login, login_params(&name));
    assert!(login.needs_mfa);
    let session_token = run_endpoint!(
        runner,
        auth_mfa_verify,
        json!({
            "session_token": login.session_token,
            "totp_or_code": RECOVERY_CODE,
            "ip_address": common::IP_ADDRESS,
            "user_agent": "deepwell-auth-test-disable-session",
        }),
    );

    let disable_params = |password: &str, totp_or_code: String| {
        json!({
            "user_id": user_id,
            "session_token": session_token,
            "ip_address": common::IP_ADDRESS,
            "password": password,
            "totp_or_code": totp_or_code,
        })
    };
    let assert_mfa_intact = |user: &deepwell::models::user::Model| {
        assert!(user.multi_factor_secret.is_some());
        assert!(user.multi_factor_recovery_codes.is_some());
    };

    // A valid second factor does not help with the wrong password.
    let error = run_endpoint_err!(
        runner,
        auth_mfa_disable,
        disable_params(
            "wrong-password-fixture",
            current_totp(TEST_MFA_SECRET, &runner).to_string(),
        )
    );
    assert_contains_error!(error, ErrorType::InvalidAuthentication);
    let user = UserService::get_real(runner.context(), Reference::Id(user_id))
        .await
        .expect("user lookup after failed disable should succeed");
    assert_mfa_intact(&user);

    // The correct password does not help with a wrong TOTP code.
    let error = run_endpoint_err!(
        runner,
        auth_mfa_disable,
        disable_params(PASSWORD, wrong_current_totp(&runner))
    );
    assert_contains_error!(error, ErrorType::InvalidAuthentication);
    let user = UserService::get_real(runner.context(), Reference::Id(user_id))
        .await
        .expect("user lookup after failed disable should succeed");
    assert_mfa_intact(&user);

    // Password plus the current TOTP code disables MFA.
    run_endpoint!(
        runner,
        auth_mfa_disable,
        disable_params(PASSWORD, current_totp(TEST_MFA_SECRET, &runner).to_string(),)
    );
    let user = UserService::get_real(runner.context(), Reference::Id(user_id))
        .await
        .expect("user lookup after disable should succeed");
    assert!(user.multi_factor_secret.is_none());
    assert!(user.multi_factor_recovery_codes.is_none());
    assert!(user.multi_factor_last_totp_step.is_none());

    let login = run_endpoint!(runner, auth_login, login_params(&name));
    assert!(!login.needs_mfa);
}
