#[macro_use]
mod common;

use self::common::TestRunner;
use deepwell::api::ServerState;
use deepwell::error::ErrorType;
use deepwell::error::prelude::Result as ExnResult;
use deepwell::models::email_token::{self, Entity as EmailTokenTable};
use deepwell::models::user::Column as UserColumn;
use deepwell::models::user::Entity as UserTable;
use deepwell::services::RequestContext;
use deepwell::services::ServiceContext;
use deepwell::services::authentication::{AuthenticateUser, AuthenticationService};
use deepwell::services::email::{
    EmailTokenPurpose, EmailTokenService, IssueEmailToken, IssueEmailTokenOutcome,
    LinkTokenPurpose, RedeemedLinkToken,
};
use deepwell::services::import::{ImportService, ImportUser, ImportedUserType};
use deepwell::services::session::{CreateSession, SessionService};
use deepwell::services::user::{
    CreateUser, CreateUserOutput, UpdateUserBody, UserService,
};
use deepwell::types::{Maybe, Reference, UserType};
use deepwell::utils::now;
use ftml::data::KarmaLevel;
use sea_orm::{
    ActiveModelTrait, ActiveValue::Set, ColumnTrait, EntityTrait, PaginatorTrait,
    QueryFilter, TransactionTrait,
};
use serde_json::json;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::Barrier;
use tokio::time::timeout;
use uuid::Uuid;

static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

fn next_n() -> u64 {
    FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed)
}

fn token_user(n: u64, user_type: UserType, email: String) -> CreateUser {
    CreateUser {
        user_type,
        name: format!("Email Token {n}"),
        email,
        locales: vec!["en".to_owned()],
        password: "email-token-fixture-password".to_owned(),
        bypass_filter: true,
        bypass_email_verification: true,
        override_user_id: None,
        ip_address: common::IP_ADDRESS,
    }
}

async fn live_token_count(runner: &TestRunner, user_id: i64) -> u64 {
    EmailTokenTable::find()
        .filter(email_token::Column::UserId.eq(user_id))
        .filter(email_token::Column::ConsumedAt.is_null())
        .count(runner.context().transaction())
        .await
        .expect("email token count should succeed")
}

async fn issue_for(
    runner: &TestRunner,
    user_id: i64,
    email: &str,
    purpose: EmailTokenPurpose,
) -> String {
    match EmailTokenService::issue(
        runner.context(),
        IssueEmailToken {
            user_id,
            email: email.to_owned(),
            purpose,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("token issue should succeed")
    {
        IssueEmailTokenOutcome::Issued(issued) => issued.token,
        IssueEmailTokenOutcome::Suppressed => {
            panic!("fresh token bucket should not be in cooldown")
        }
    }
}

#[tokio::test]
async fn verify_round_trip_marks_verified_and_consumes() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let email = format!("email-token-verify-{n}@example.invalid");
    let created = UserService::create(
        runner.context(),
        token_user(n, UserType::Regular, email.clone()),
    )
    .await
    .expect("regular user should be created");

    let token = issue_for(
        &runner,
        created.user_id,
        &email,
        EmailTokenPurpose::VerifyEmail,
    )
    .await;

    let stored = EmailTokenTable::find()
        .filter(email_token::Column::UserId.eq(created.user_id))
        .one(runner.context().transaction())
        .await
        .expect("token lookup should succeed")
        .expect("issued token row should exist");
    assert_eq!(stored.token_hash, hash_of(&token));
    assert_ne!(stored.token_hash, token);

    run_endpoint!(
        runner => email_verify_redeem,
        common::make_params(json!({
            "token": token,
            "ip_address": common::IP_ADDRESS,
        }))
    );

    let user = UserService::get_real(runner.context(), Reference::Id(created.user_id))
        .await
        .expect("verified user should load");
    assert!(user.email_verified_at.is_some());

    let error = run_endpoint_err!(
        runner => email_verify_redeem,
        common::make_params(json!({
            "token": token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidEmailToken);
    runner.teardown().await;
}

#[tokio::test]
async fn issue_is_quiet_for_unknown_imported_and_deleted_addresses() {
    let runner = TestRunner::setup().await;

    let fixture = Uuid::new_v4().to_string();
    let wikidot_id = 18_400_000 + (next_n() % 10_000) as i32;
    ImportService::add_user(
        runner.context(),
        ImportUser {
            user_id: wikidot_id,
            created_at: time::OffsetDateTime::UNIX_EPOCH,
            fetched_at: time::OffsetDateTime::UNIX_EPOCH + time::Duration::seconds(1),
            wikidot_user_type: ImportedUserType::Extant {
                name: format!("Import Token {fixture}"),
                slug: format!("import-token-{fixture}"),
            },
            avatar_uploaded_blob_id: None,
            real_name: None,
            gender: None,
            birthday: None,
            location: None,
            biography: None,
            website: None,
            karma: KarmaLevel::Three,
            is_pro: false,
            upsert: false,
            delete_old_if_same_name: false,
            importing_user_id: deepwell::constants::ADMIN_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("wikidot identity should import");

    let n = next_n();
    let regular_email = format!("email-token-regular-{n}@example.invalid");
    let regular = UserService::create(
        runner.context(),
        token_user(n, UserType::Regular, regular_email.clone()),
    )
    .await
    .expect("regular user should be created");

    let bot = UserService::create(
        runner.context(),
        token_user(
            next_n(),
            UserType::Bot,
            format!("email-token-bot-{n}@example.invalid"),
        ),
    )
    .await
    .expect("bot user should be created");

    let deleted_email = format!("email-token-deleted-{n}@example.invalid");
    let deleted = UserService::create(
        runner.context(),
        token_user(next_n(), UserType::Regular, deleted_email.clone()),
    )
    .await
    .expect("deleted user should be created");
    UserService::delete(
        runner.context(),
        Reference::Id(deleted.user_id),
        deleted.user_id,
        common::IP_ADDRESS,
    )
    .await
    .expect("user should be soft-deleted");

    for address in [
        format!("email-token-unknown-{n}@example.invalid"),
        format!("wikidot-identity-has-no-mailbox-{n}@example.invalid"),
        bot_email(&runner, bot.user_id).await,
        deleted_email,
    ] {
        run_endpoint!(
            runner => password_reset_issue,
            common::make_params(json!({
                "email": address,
                "ip_address": common::IP_ADDRESS,
            }))
        );
        run_endpoint!(
            runner => email_verify_issue,
            common::make_params(json!({
                "email": address,
                "ip_address": common::IP_ADDRESS,
            }))
        );
    }

    assert_eq!(live_token_count(&runner, regular.user_id).await, 0);
    assert_eq!(live_token_count(&runner, bot.user_id).await, 0);
    assert_eq!(live_token_count(&runner, deleted.user_id).await, 0);
    assert_eq!(
        EmailTokenTable::find()
            .count(runner.context().transaction())
            .await
            .expect("total token count should succeed"),
        0,
    );

    run_endpoint!(
        runner => password_reset_issue,
        common::make_params(json!({
            "email": regular_email,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_eq!(live_token_count(&runner, regular.user_id).await, 1);
    runner.teardown().await;
}

async fn bot_email(runner: &TestRunner, user_id: i64) -> String {
    UserTable::find_by_id(user_id)
        .one(runner.context().transaction())
        .await
        .expect("bot lookup should succeed")
        .expect("bot row should exist")
        .email
}

#[tokio::test]
async fn reset_round_trip_sets_password_and_revokes_sessions() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let email = format!("email-token-reset-{n}@example.invalid");
    let created = UserService::create(
        runner.context(),
        token_user(n, UserType::Regular, email.clone()),
    )
    .await
    .expect("regular user should be created");

    let verify_token = issue_for(
        &runner,
        created.user_id,
        &email,
        EmailTokenPurpose::VerifyEmail,
    )
    .await;
    run_endpoint!(
        runner => email_verify_redeem,
        common::make_params(json!({
            "token": verify_token,
            "ip_address": common::IP_ADDRESS,
        }))
    );

    SessionService::create(
        runner.context(),
        CreateSession {
            user_id: created.user_id,
            ip_address: common::IP_ADDRESS,
            user_agent: "email-token-test".to_owned(),
            restricted: false,
        },
    )
    .await
    .expect("session should be created");

    let token = issue_for(
        &runner,
        created.user_id,
        &email,
        EmailTokenPurpose::ResetPassword,
    )
    .await;
    let grant_output = run_endpoint!(
        runner => password_reset_redeem,
        common::make_params(json!({
            "token": token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    let grant: String = grant_output.grant;

    let error = run_endpoint_err!(
        runner => password_reset_redeem,
        common::make_params(json!({
            "token": token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidEmailToken);

    let complete = run_endpoint!(
        runner => password_reset_complete,
        common::make_params(json!({
            "grant": grant,
            "new_password": "email-token-new-password",
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert!(
        complete.sessions_revoked >= 1,
        "recovery should revoke the account sessions",
    );

    let error = run_endpoint_err!(
        runner => password_reset_complete,
        common::make_params(json!({
            "grant": grant,
            "new_password": "email-token-new-password",
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidEmailToken);

    let login = |password: &str| {
        AuthenticationService::auth_password(
            runner.context(),
            AuthenticateUser {
                name_or_email: email.clone(),
                password: password.to_owned(),
            },
            common::IP_ADDRESS,
        )
    };
    assert!(login("email-token-new-password").await.is_ok());
    assert!(login("email-token-fixture-password").await.is_err());
    runner.teardown().await;
}

#[tokio::test]
async fn cross_purpose_expired_and_mismatched_tokens_are_rejected() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let email = format!("email-token-scope-{n}@example.invalid");
    let created = UserService::create(
        runner.context(),
        token_user(n, UserType::Regular, email.clone()),
    )
    .await
    .expect("regular user should be created");

    let verify_token = issue_for(
        &runner,
        created.user_id,
        &email,
        EmailTokenPurpose::VerifyEmail,
    )
    .await;
    let error = run_endpoint_err!(
        runner => password_reset_redeem,
        common::make_params(json!({
            "token": verify_token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidEmailToken);

    let reset_token = issue_for(
        &runner,
        created.user_id,
        &email,
        EmailTokenPurpose::ResetPassword,
    )
    .await;
    let error = run_endpoint_err!(
        runner => email_verify_redeem,
        common::make_params(json!({
            "token": reset_token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidEmailToken);

    let row = EmailTokenTable::find()
        .filter(email_token::Column::TokenHash.eq(hash_of(&reset_token)))
        .filter(email_token::Column::ConsumedAt.is_null())
        .one(runner.context().transaction())
        .await
        .expect("token lookup should succeed")
        .expect("reset token row should exist");
    let mut active: email_token::ActiveModel = row.into();
    active.expires_at = Set(now() - time::Duration::hours(1));
    active
        .update(runner.context().transaction())
        .await
        .expect("expiry backdate should succeed");
    let error = run_endpoint_err!(
        runner => password_reset_redeem,
        common::make_params(json!({
            "token": reset_token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidEmailToken);

    run_endpoint!(
        runner => email_verify_redeem,
        common::make_params(json!({
            "token": verify_token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    runner.teardown().await;
}

fn hash_of(token: &str) -> String {
    deepwell::hash::text_hash_to_hex(&deepwell::hash::k12_hash(token.as_bytes()))
        .to_string()
}

#[tokio::test]
async fn resend_cooldown_suppresses_without_signaling() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let email = format!("email-token-cooldown-{n}@example.invalid");
    let created = UserService::create(
        runner.context(),
        token_user(n, UserType::Regular, email.clone()),
    )
    .await
    .expect("regular user should be created");

    let outcome = EmailTokenService::issue(
        runner.context(),
        IssueEmailToken {
            user_id: created.user_id,
            email: email.clone(),
            purpose: EmailTokenPurpose::VerifyEmail,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("first issue should succeed");
    assert!(matches!(outcome, IssueEmailTokenOutcome::Issued(_)));

    let outcome = EmailTokenService::issue(
        runner.context(),
        IssueEmailToken {
            user_id: created.user_id,
            email: email.clone(),
            purpose: EmailTokenPurpose::VerifyEmail,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("suppressed issue should not error");
    assert!(matches!(outcome, IssueEmailTokenOutcome::Suppressed));

    run_endpoint!(
        runner => email_verify_issue,
        common::make_params(json!({
            "email": email,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_eq!(live_token_count(&runner, created.user_id).await, 1);
    runner.teardown().await;
}

#[tokio::test]
async fn malformed_issue_addresses_fail_loudly() {
    let runner = TestRunner::setup().await;
    let error = run_endpoint_err!(
        runner => password_reset_issue,
        common::make_params(json!({
            "email": "not an address",
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidEmail);
    runner.teardown().await;
}

async fn redeem_in_fresh_transaction(
    state: ServerState,
    token: String,
    start: Option<Arc<Barrier>>,
) -> ExnResult<RedeemedLinkToken> {
    let txn = state
        .database
        .begin()
        .await
        .expect("email token redemption transaction should begin");

    if let Some(start) = start {
        start.wait().await;
    }

    let result = {
        let ctx = ServiceContext::new(&state, &txn);
        EmailTokenService::redeem_link(&ctx, &token, LinkTokenPurpose::VerifyEmail).await
    };

    match result {
        Ok(redeemed) => {
            txn.commit()
                .await
                .expect("winning email token redemption should commit");
            Ok(redeemed)
        }
        Err(error) => {
            txn.rollback()
                .await
                .expect("losing email token redemption should roll back");
            Err(error)
        }
    }
}

#[tokio::test]
async fn concurrent_double_redeem_leaves_exactly_one_winner() {
    let runner = TestRunner::setup().await;
    let state = Arc::clone(runner.state());
    let n = next_n();
    let email = format!("email-token-race-{n}@example.invalid");

    let setup_txn = state
        .database
        .begin()
        .await
        .expect("email token race fixture transaction should begin");
    let (user_id, token) = {
        let ctx = ServiceContext::new(&state, &setup_txn);
        let created =
            UserService::create(&ctx, token_user(n, UserType::Regular, email.clone()))
                .await
                .expect("race fixture user should be created");
        match EmailTokenService::issue(
            &ctx,
            IssueEmailToken {
                user_id: created.user_id,
                email: email.clone(),
                purpose: EmailTokenPurpose::VerifyEmail,
                ip_address: common::IP_ADDRESS,
            },
        )
        .await
        .expect("race fixture token should issue")
        {
            IssueEmailTokenOutcome::Issued(issued) => (created.user_id, issued.token),
            IssueEmailTokenOutcome::Suppressed => {
                panic!("fresh race fixture bucket should not be in cooldown")
            }
        }
    };
    setup_txn
        .commit()
        .await
        .expect("email token race fixture transaction should commit");

    let start = Arc::new(Barrier::new(2));
    let (left, right) = timeout(Duration::from_secs(30), async {
        tokio::join!(
            redeem_in_fresh_transaction(
                Arc::clone(&state),
                token.clone(),
                Some(Arc::clone(&start)),
            ),
            redeem_in_fresh_transaction(
                Arc::clone(&state),
                token.clone(),
                Some(Arc::clone(&start)),
            ),
        )
    })
    .await
    .expect("concurrent email token redemption should not deadlock");

    let concurrent_error = match (left, right) {
        (Ok(_), Err(error)) | (Err(error), Ok(_)) => error,
        (left, right) => {
            panic!(
                "exactly one concurrent redemption should succeed: {left:?}, {right:?}"
            )
        }
    };
    assert_contains_error!(concurrent_error, ErrorType::InvalidEmailToken);

    let reuse =
        redeem_in_fresh_transaction(Arc::clone(&state), token.clone(), None).await;
    let reuse_error =
        reuse.expect_err("a consumed email token must fail sequential reuse");
    assert_contains_error!(reuse_error, ErrorType::InvalidEmailToken);

    let cleanup_txn = state
        .database
        .begin()
        .await
        .expect("email token race cleanup transaction should begin");
    {
        let ctx = ServiceContext::new(&state, &cleanup_txn);
        UserService::delete(&ctx, Reference::Id(user_id), user_id, common::IP_ADDRESS)
            .await
            .expect("race fixture user should be soft-deleted");
        EmailTokenTable::delete_many()
            .filter(email_token::Column::UserId.eq(user_id))
            .exec(&cleanup_txn)
            .await
            .expect("race fixture tokens should be deleted");
    }
    cleanup_txn
        .commit()
        .await
        .expect("email token race cleanup transaction should commit");

    runner.teardown().await;
}

#[tokio::test]
async fn issue_throttle_bounds_one_address_across_accounts() {
    let runner = TestRunner::setup().await;
    let n = next_n();

    for i in 0..11_u64 {
        let email = format!("email-token-ipthrottle-{n}-{i}@example.invalid");
        let created = UserService::create(
            runner.context(),
            token_user(next_n(), UserType::Regular, email.clone()),
        )
        .await
        .expect("throttle fixture user should be created");
        let outcome = EmailTokenService::issue(
            runner.context(),
            IssueEmailToken {
                user_id: created.user_id,
                email,
                purpose: EmailTokenPurpose::VerifyEmail,
                ip_address: common::IP_ADDRESS,
            },
        )
        .await
        .expect("throttled issue should not error");
        if i < 10 {
            assert!(
                matches!(outcome, IssueEmailTokenOutcome::Issued(_)),
                "issue {i} from a fresh address should issue",
            );
        } else {
            assert!(
                matches!(outcome, IssueEmailTokenOutcome::Suppressed),
                "the eleventh issue from one address should suppress",
            );
        }
    }
    runner.teardown().await;
}

#[tokio::test]
async fn consumed_tokens_are_purged_on_next_issue() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let email = format!("email-token-purge-{n}@example.invalid");
    let created = UserService::create(
        runner.context(),
        token_user(n, UserType::Regular, email.clone()),
    )
    .await
    .expect("purge fixture user should be created");

    let first = issue_for(
        &runner,
        created.user_id,
        &email,
        EmailTokenPurpose::VerifyEmail,
    )
    .await;
    EmailTokenService::redeem_link(
        runner.context(),
        &first,
        LinkTokenPurpose::VerifyEmail,
    )
    .await
    .expect("first token should redeem");
    issue_for(
        &runner,
        created.user_id,
        &email,
        EmailTokenPurpose::VerifyEmail,
    )
    .await;

    let total = EmailTokenTable::find()
        .filter(email_token::Column::UserId.eq(created.user_id))
        .count(runner.context().transaction())
        .await
        .expect("email token count should succeed");
    assert_eq!(total, 1);
    assert_eq!(live_token_count(&runner, created.user_id).await, 1);
    runner.teardown().await;
}

async fn delete_fixture(runner: &TestRunner, n: u64) -> CreateUserOutput {
    let email = format!("email-token-delete-{n}@example.invalid");
    UserService::create(runner.context(), token_user(n, UserType::Regular, email))
        .await
        .expect("regular user should be created")
}

async fn stored_user(runner: &TestRunner, user_id: i64) -> deepwell::models::user::Model {
    UserTable::find()
        .filter(UserColumn::UserId.eq(user_id))
        .one(runner.context().transaction())
        .await
        .expect("user lookup should succeed")
        .expect("user row should exist")
}

fn as_actor(runner: &mut TestRunner, user_id: i64) {
    runner.set_request_context(RequestContext {
        user_id: Some(user_id),
        ..Default::default()
    });
}

#[tokio::test]
async fn delete_issue_requires_session_and_records_link() {
    let mut runner = TestRunner::setup().await;
    let n = next_n();
    let created = delete_fixture(&runner, n).await;

    let error = run_endpoint_err!(
        runner,
        account_delete_issue,
        json!({
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(error, ErrorType::PermissionDenied);
    assert_eq!(live_token_count(&runner, created.user_id).await, 0);

    as_actor(&mut runner, created.user_id);
    run_endpoint!(
        runner,
        account_delete_issue,
        json!({
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(live_token_count(&runner, created.user_id).await, 1);
    runner.teardown().await;
}

#[tokio::test]
async fn delete_round_trip_removes_self_and_revokes_sessions() {
    let mut runner = TestRunner::setup().await;
    let n = next_n();
    let created = delete_fixture(&runner, n).await;
    let m = next_n();
    let other = delete_fixture(&runner, m).await;

    async fn login_with(
        runner: &TestRunner,
        name_or_email: String,
        password: &str,
    ) -> bool {
        AuthenticationService::auth_password(
            runner.context(),
            AuthenticateUser {
                name_or_email,
                password: password.to_owned(),
            },
            common::IP_ADDRESS,
        )
        .await
        .is_ok()
    }
    assert!(
        login_with(
            &runner,
            format!("Email Token {n}"),
            "email-token-fixture-password",
        )
        .await
    );

    SessionService::create(
        runner.context(),
        CreateSession {
            user_id: created.user_id,
            ip_address: common::IP_ADDRESS,
            user_agent: "email-token-test".to_owned(),
            restricted: false,
        },
    )
    .await
    .expect("session should be created");

    as_actor(&mut runner, created.user_id);
    let token = issue_for(
        &runner,
        created.user_id,
        &format!("email-token-delete-{n}@example.invalid"),
        EmailTokenPurpose::DeleteConfirm,
    )
    .await;
    let grant_output = run_endpoint!(
        runner => account_delete_redeem,
        common::make_params(json!({
            "token": token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    let grant: String = grant_output.grant;

    let error = run_endpoint_err!(
        runner => account_delete_redeem,
        common::make_params(json!({
            "token": token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidEmailToken);

    let complete = run_endpoint!(
        runner => account_delete_complete,
        common::make_params(json!({
            "grant": grant,
            "password": "email-token-fixture-password",
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert!(
        complete.sessions_revoked >= 1,
        "deletion should revoke the account sessions",
    );

    assert!(
        stored_user(&runner, created.user_id)
            .await
            .deleted_at
            .is_some()
    );
    assert!(
        stored_user(&runner, other.user_id)
            .await
            .deleted_at
            .is_none()
    );

    assert!(
        !login_with(
            &runner,
            format!("Email Token {n}"),
            "email-token-fixture-password",
        )
        .await
    );
    let error = run_endpoint_err!(
        runner => account_delete_complete,
        common::make_params(json!({
            "grant": grant,
            "password": "email-token-fixture-password",
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidEmailToken);
    runner.teardown().await;
}

#[tokio::test]
async fn delete_wrong_password_keeps_account_and_burns_grant() {
    let mut runner = TestRunner::setup().await;
    let n = next_n();
    let created = delete_fixture(&runner, n).await;
    as_actor(&mut runner, created.user_id);

    let token = issue_for(
        &runner,
        created.user_id,
        &format!("email-token-delete-{n}@example.invalid"),
        EmailTokenPurpose::DeleteConfirm,
    )
    .await;
    let grant_output = run_endpoint!(
        runner => account_delete_redeem,
        common::make_params(json!({
            "token": token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    let grant: String = grant_output.grant;

    let error = run_endpoint_err!(
        runner => account_delete_complete,
        common::make_params(json!({
            "grant": grant,
            "password": "wrong-password",
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidAuthentication);
    assert!(
        stored_user(&runner, created.user_id)
            .await
            .deleted_at
            .is_none()
    );

    let error = run_endpoint_err!(
        runner => account_delete_complete,
        common::make_params(json!({
            "grant": grant,
            "password": "email-token-fixture-password",
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidEmailToken);
    assert!(
        stored_user(&runner, created.user_id)
            .await
            .deleted_at
            .is_none()
    );
    runner.teardown().await;
}

#[tokio::test]
async fn delete_cross_user_and_anonymous_links_fail_closed() {
    let mut runner = TestRunner::setup().await;
    let n = next_n();
    let created = delete_fixture(&runner, n).await;
    let m = next_n();
    let other = delete_fixture(&runner, m).await;

    let token = issue_for(
        &runner,
        created.user_id,
        &format!("email-token-delete-{n}@example.invalid"),
        EmailTokenPurpose::DeleteConfirm,
    )
    .await;

    as_actor(&mut runner, other.user_id);
    let error = run_endpoint_err!(
        runner => account_delete_redeem,
        common::make_params(json!({
            "token": token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidEmailToken);
    assert!(
        stored_user(&runner, created.user_id)
            .await
            .deleted_at
            .is_none()
    );

    runner.set_request_context(RequestContext::default());
    let error = run_endpoint_err!(
        runner => account_delete_redeem,
        common::make_params(json!({
            "token": token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::PermissionDenied);

    as_actor(&mut runner, created.user_id);
    let token = issue_for(
        &runner,
        created.user_id,
        &format!("email-token-delete-{n}@example.invalid"),
        EmailTokenPurpose::DeleteConfirm,
    )
    .await;
    let grant_output = run_endpoint!(
        runner => account_delete_redeem,
        common::make_params(json!({
            "token": token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    let grant: String = grant_output.grant;
    run_endpoint!(
        runner => account_delete_complete,
        common::make_params(json!({
            "grant": grant,
            "password": "email-token-fixture-password",
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert!(
        stored_user(&runner, created.user_id)
            .await
            .deleted_at
            .is_some()
    );
    assert!(
        stored_user(&runner, other.user_id)
            .await
            .deleted_at
            .is_none()
    );
    runner.teardown().await;
}
async fn change_email(runner: &TestRunner, user_id: i64, new_email: &str) {
    UserService::update(
        runner.context(),
        Reference::Id(user_id),
        common::IP_ADDRESS,
        UpdateUserBody {
            email: Maybe::Set(new_email.to_owned()),
            bypass_filter: true,
            ..Default::default()
        },
    )
    .await
    .expect("email change should succeed");
}

async fn user_slug(runner: &TestRunner, user_id: i64) -> String {
    UserTable::find_by_id(user_id)
        .one(runner.context().transaction())
        .await
        .expect("user lookup should succeed")
        .expect("user row should exist")
        .slug
}

#[tokio::test]
async fn reset_link_dies_with_old_email_after_rotation() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let old_email = format!("email-token-old-{n}@example.invalid");
    let new_email = format!("email-token-new-{n}@example.invalid");
    let created = UserService::create(
        runner.context(),
        token_user(n, UserType::Regular, old_email.clone()),
    )
    .await
    .expect("regular user should be created");

    let token = issue_for(
        &runner,
        created.user_id,
        &old_email,
        EmailTokenPurpose::ResetPassword,
    )
    .await;
    assert!(live_token_count(&runner, created.user_id).await >= 1);

    change_email(&runner, created.user_id, &new_email).await;

    assert_eq!(live_token_count(&runner, created.user_id).await, 0);

    let error = run_endpoint_err!(
        runner => password_reset_redeem,
        common::make_params(json!({
            "token": token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidEmailToken);

    let fresh = issue_for(
        &runner,
        created.user_id,
        &new_email,
        EmailTokenPurpose::ResetPassword,
    )
    .await;
    let grant_output = run_endpoint!(
        runner => password_reset_redeem,
        common::make_params(json!({
            "token": fresh,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert!(!grant_output.grant.is_empty());
    runner.teardown().await;
}

#[tokio::test]
async fn stale_grant_dies_with_old_email_after_rotation() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let old_email = format!("email-token-grant-old-{n}@example.invalid");
    let new_email = format!("email-token-grant-new-{n}@example.invalid");
    let created = UserService::create(
        runner.context(),
        token_user(n, UserType::Regular, old_email.clone()),
    )
    .await
    .expect("regular user should be created");

    let token = issue_for(
        &runner,
        created.user_id,
        &old_email,
        EmailTokenPurpose::ResetPassword,
    )
    .await;
    let grant_output = run_endpoint!(
        runner => password_reset_redeem,
        common::make_params(json!({
            "token": token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    let grant: String = grant_output.grant;

    change_email(&runner, created.user_id, &new_email).await;

    let error = run_endpoint_err!(
        runner => password_reset_complete,
        common::make_params(json!({
            "grant": grant,
            "new_password": "email-token-takeover-password",
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidEmailToken);

    let slug = user_slug(&runner, created.user_id).await;
    let login = |password: &str| {
        AuthenticationService::auth_password(
            runner.context(),
            AuthenticateUser {
                name_or_email: slug.clone(),
                password: password.to_owned(),
            },
            common::IP_ADDRESS,
        )
    };
    assert!(login("email-token-fixture-password").await.is_ok());
    assert!(login("email-token-takeover-password").await.is_err());
    runner.teardown().await;
}

#[tokio::test]
async fn rotated_email_kills_verify_link_but_fresh_link_works() {
    let runner = TestRunner::setup().await;
    let n = next_n();
    let old_email = format!("email-token-verify-old-{n}@example.invalid");
    let new_email = format!("email-token-verify-new-{n}@example.invalid");
    let created = UserService::create(
        runner.context(),
        token_user(n, UserType::Regular, old_email.clone()),
    )
    .await
    .expect("regular user should be created");

    let stale = issue_for(
        &runner,
        created.user_id,
        &old_email,
        EmailTokenPurpose::VerifyEmail,
    )
    .await;

    change_email(&runner, created.user_id, &new_email).await;
    assert_eq!(live_token_count(&runner, created.user_id).await, 0);

    let error = run_endpoint_err!(
        runner => email_verify_redeem,
        common::make_params(json!({
            "token": stale,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidEmailToken);

    let fresh = issue_for(
        &runner,
        created.user_id,
        &new_email,
        EmailTokenPurpose::VerifyEmail,
    )
    .await;
    run_endpoint!(
        runner => email_verify_redeem,
        common::make_params(json!({
            "token": fresh,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    let user = UserTable::find_by_id(created.user_id)
        .one(runner.context().transaction())
        .await
        .expect("user lookup should succeed")
        .expect("user row should exist");
    assert!(user.email_verified_at.is_some());
    runner.teardown().await;
}

#[tokio::test]
async fn delete_link_and_grant_die_with_old_email_after_rotation() {
    let mut runner = TestRunner::setup().await;
    let n = next_n();
    let created = delete_fixture(&runner, n).await;
    as_actor(&mut runner, created.user_id);
    let old_email = format!("email-token-delete-{n}@example.invalid");

    let token = issue_for(
        &runner,
        created.user_id,
        &old_email,
        EmailTokenPurpose::DeleteConfirm,
    )
    .await;
    change_email(
        &runner,
        created.user_id,
        &format!("email-token-delete-rotated-{n}@example.invalid"),
    )
    .await;
    let error = run_endpoint_err!(
        runner => account_delete_redeem,
        common::make_params(json!({
            "token": token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidEmailToken);

    let rotated_email = format!("email-token-delete-rotated-{n}@example.invalid");
    let token = issue_for(
        &runner,
        created.user_id,
        &rotated_email,
        EmailTokenPurpose::DeleteConfirm,
    )
    .await;
    let grant_output = run_endpoint!(
        runner => account_delete_redeem,
        common::make_params(json!({
            "token": token,
            "ip_address": common::IP_ADDRESS,
        }))
    );
    let grant: String = grant_output.grant;
    change_email(
        &runner,
        created.user_id,
        &format!("email-token-delete-rotated-again-{n}@example.invalid"),
    )
    .await;
    let error = run_endpoint_err!(
        runner => account_delete_complete,
        common::make_params(json!({
            "grant": grant,
            "password": "email-token-fixture-password",
            "ip_address": common::IP_ADDRESS,
        }))
    );
    assert_contains_error!(error, ErrorType::InvalidEmailToken);
    assert!(
        stored_user(&runner, created.user_id)
            .await
            .deleted_at
            .is_none()
    );
    runner.teardown().await;
}
