/*
 * tests/user_uniqueness_races.rs
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
use deepwell::api::{ServerState, build_server_state_without_workers};
use deepwell::config::{Config, Secrets};
use deepwell::error::prelude::*;
use deepwell::models::alias::{self, Entity as Alias};
use deepwell::models::audit_log::{self, Entity as AuditLog};
use deepwell::models::known_user::{self, Entity as KnownUser};
use deepwell::models::user::{self, Entity as WikijumpUser};
use deepwell::services::user::{CreateUser, UpdateUserBody};
use deepwell::services::{MfaService, ServiceContext, UserService};
use deepwell::types::{Maybe, Reference, UserType};
use exn::{Exn, Frame};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait, Database,
    DatabaseConnection, DbBackend, DbErr, EntityTrait, NotSet, QueryFilter, Set, SqlErr,
    Statement, TransactionTrait,
};
use std::fs;
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tokio::time::sleep;

const IP_ADDRESS: IpAddr = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 10));

fn assert_error_code(error: &Exn<Error>, expected: ErrorType) {
    fn walk(frame: &Frame, code: i32) -> bool {
        match frame.error().downcast_ref::<Error>() {
            Some(found) if found.code() == code => true,
            _ => frame.children().iter().any(|frame| walk(frame, code)),
        }
    }

    assert!(
        walk(error.frame(), expected.code()),
        "expected error {expected:?} in the raised error: {error:?}",
    );
}

const SLUG_UNIQUE_INDEX: &str = "user_slug_active_unique_idx";
const EMAIL_UNIQUE_INDEX: &str = "user_email_active_unique_idx";
const SLUG_MIGRATION: &str = "20261105010000_user_slug_active_unique.sql";
const EMAIL_MIGRATION: &str = "20261105020000_user_email_active_unique.sql";

async fn test_state() -> ServerState {
    build_server_state_without_workers(Config::integration_testing(), Secrets::load())
        .await
        .expect("test server state should build")
}

fn is_index_violation(error: &DbErr, index: &str) -> bool {
    matches!(
        error.sql_err(),
        Some(SqlErr::UniqueConstraintViolation(message)) if message.contains(index)
    )
}

fn raw_user(user_id: i64, name: &str, slug: &str, email: &str) -> user::ActiveModel {
    user::ActiveModel {
        user_id: Set(user_id),
        name: Set(name.to_owned()),
        slug: Set(slug.to_owned()),
        name_changes_left: Set(2),
        email: Set(email.to_owned()),
        password: Set("!".to_owned()),
        locales: Set(vec!["en".to_owned()]),
        ..Default::default()
    }
}

async fn next_user_id<C: ConnectionTrait>(db: &C) -> i64 {
    known_user::ActiveModel { user_id: NotSet }
        .insert(db)
        .await
        .expect("known_user fixture row should insert")
        .user_id
}

async fn cleanup_users(state: &ServerState, user_ids: &[i64]) {
    for &user_id in user_ids {
        Alias::delete_many()
            .filter(alias::Column::TargetId.eq(user_id))
            .exec(&state.database)
            .await
            .expect("alias cleanup should succeed");
        AuditLog::delete_many()
            .filter(
                Condition::any()
                    .add(audit_log::Column::UserId.eq(user_id))
                    .add(audit_log::Column::ExtraId1.eq(user_id)),
            )
            .exec(&state.database)
            .await
            .expect("audit cleanup should succeed");
        WikijumpUser::delete_many()
            .filter(user::Column::UserId.eq(user_id))
            .exec(&state.database)
            .await
            .expect("user cleanup should succeed");
        KnownUser::delete_many()
            .filter(known_user::Column::UserId.eq(user_id))
            .exec(&state.database)
            .await
            .expect("known_user cleanup should succeed");
    }
}

fn create_input(name: &str, email: &str) -> CreateUser {
    CreateUser {
        user_type: UserType::Regular,
        name: name.to_owned(),
        email: email.to_owned(),
        locales: vec!["en".to_owned()],
        password: "password-fixture".to_owned(),
        bypass_filter: true,
        bypass_email_verification: true,
        override_user_id: None,
        ip_address: IP_ADDRESS,
    }
}

fn update_body() -> UpdateUserBody {
    UpdateUserBody {
        name: Maybe::Unset,
        email: Maybe::Unset,
        email_verified: Maybe::Unset,
        password: Maybe::Unset,
        locales: Maybe::Unset,
        avatar_uploaded_blob_id: Maybe::Unset,
        forum_signature: Maybe::Unset,
        real_name: Maybe::Unset,
        gender: Maybe::Unset,
        birthday: Maybe::Unset,
        location: Maybe::Unset,
        biography: Maybe::Unset,
        website: Maybe::Unset,
        user_page: Maybe::Unset,
        bypass_filter: true,
    }
}

async fn create_committed_user(state: &ServerState, name: &str, email: &str) -> i64 {
    let txn = state
        .database
        .begin()
        .await
        .expect("user creation transaction should begin");
    let ctx = ServiceContext::new(state, &txn);
    let output = UserService::create(&ctx, create_input(name, email))
        .await
        .expect("fixture user creation should succeed");
    txn.commit()
        .await
        .expect("user creation transaction should commit");
    output.user_id
}

async fn live_users_with_slug(state: &ServerState, slug: &str) -> Vec<user::Model> {
    WikijumpUser::find()
        .filter(user::Column::Slug.eq(slug))
        .filter(user::Column::DeletedAt.is_null())
        .all(&state.database)
        .await
        .expect("live slug holders should be readable")
}

async fn live_users_with_email(state: &ServerState, email: &str) -> Vec<user::Model> {
    WikijumpUser::find()
        .filter(user::Column::Email.eq(email))
        .filter(user::Column::DeletedAt.is_null())
        .all(&state.database)
        .await
        .expect("live email holders should be readable")
}

#[tokio::test]
async fn concurrent_raw_inserts_reject_the_second_live_slug() {
    let state = test_state().await;
    let tag = cuid();
    let slug = format!("race-raw-slug-{tag}");
    let holder_email = format!("race-raw-holder-{tag}@example.invalid");
    let contender_email = format!("race-raw-contender-{tag}@example.invalid");

    let holder = state
        .database
        .begin()
        .await
        .expect("holder transaction should begin");
    let holder_id = next_user_id(&holder).await;
    raw_user(holder_id, "Race Raw Holder", &slug, &holder_email)
        .insert(&holder)
        .await
        .expect("holder user row should insert");

    let contender = async {
        let transaction = state
            .database
            .begin()
            .await
            .expect("contender transaction should begin");
        let contender_id = next_user_id(&transaction).await;
        let result =
            raw_user(contender_id, "Race Raw Contender", &slug, &contender_email)
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
    let error = contender_result.expect_err("second concurrent slug insert should fail");
    assert!(
        is_index_violation(&error, SLUG_UNIQUE_INDEX),
        "loser should hit {SLUG_UNIQUE_INDEX}, got: {error:?}",
    );

    let holders = live_users_with_slug(&state, &slug).await;
    assert_eq!(
        holders.len(),
        1,
        "exactly one live slug holder should survive"
    );
    assert_eq!(holders[0].user_id, holder_id);

    cleanup_users(&state, &[holder_id]).await;
}

#[tokio::test]
async fn concurrent_raw_inserts_reject_the_second_live_email_any_case() {
    let state = test_state().await;
    let tag = cuid();
    let holder_slug = format!("race-raw-mail-holder-{tag}");
    let contender_slug = format!("race-raw-mail-contender-{tag}");
    let holder_email = format!("Race-Raw-Dupe-{tag}@Example.invalid");
    let contender_email = format!("race-raw-dupe-{tag}@example.invalid");

    let holder = state
        .database
        .begin()
        .await
        .expect("holder transaction should begin");
    let holder_id = next_user_id(&holder).await;
    raw_user(
        holder_id,
        "Race Raw Mail Holder",
        &holder_slug,
        &holder_email,
    )
    .insert(&holder)
    .await
    .expect("holder user row should insert");

    let contender = async {
        let transaction = state
            .database
            .begin()
            .await
            .expect("contender transaction should begin");
        let contender_id = next_user_id(&transaction).await;
        let result = raw_user(
            contender_id,
            "Race Raw Mail Contender",
            &contender_slug,
            &contender_email,
        )
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
    let error = contender_result.expect_err("second concurrent email insert should fail");
    assert!(
        is_index_violation(&error, EMAIL_UNIQUE_INDEX),
        "loser should hit {EMAIL_UNIQUE_INDEX}, got: {error:?}",
    );

    let holders = live_users_with_email(&state, &holder_email).await;
    assert_eq!(
        holders.len(),
        1,
        "exactly one live email holder should survive"
    );
    assert_eq!(holders[0].user_id, holder_id);

    cleanup_users(&state, &[holder_id]).await;
}

#[tokio::test]
async fn concurrent_user_create_rejects_the_duplicate_with_user_exists() {
    let state = test_state().await;
    let tag = cuid();
    let name = format!("Race Create {tag}");
    let slug = format!("race-create-{tag}");
    let email = format!("race-create-{tag}@example.invalid");

    let create_racer = async || {
        let txn = state
            .database
            .begin()
            .await
            .expect("create transaction should begin");
        let ctx = ServiceContext::new(&state, &txn);
        let result = UserService::create(&ctx, create_input(&name, &email)).await;
        match &result {
            Ok(_) => txn
                .commit()
                .await
                .expect("winning create transaction should commit"),
            Err(_) => txn
                .rollback()
                .await
                .expect("losing create transaction should roll back"),
        }
        result
    };
    let (first, second) = tokio::join!(create_racer(), create_racer());

    let mut outputs = Vec::new();
    let mut errors = Vec::new();
    for result in [first, second] {
        match result {
            Ok(output) => outputs.push(output),
            Err(error) => errors.push(error),
        }
    }
    assert_eq!(
        outputs.len(),
        1,
        "exactly one concurrent create should succeed"
    );
    assert_eq!(errors.len(), 1, "exactly one concurrent create should fail");
    assert_error_code(&errors[0], ErrorType::UserExists);

    let slug_holders = live_users_with_slug(&state, &slug).await;
    assert_eq!(slug_holders.len(), 1);
    assert_eq!(slug_holders[0].user_id, outputs[0].user_id);
    let email_holders = live_users_with_email(&state, &email).await;
    assert_eq!(email_holders.len(), 1);

    cleanup_users(&state, &[outputs[0].user_id]).await;
}

#[tokio::test]
async fn concurrent_rename_rejects_the_duplicate_slug_with_user_exists() {
    let state = test_state().await;
    let tag = cuid();
    let target_name = format!("Race Rename Target {tag}");
    let target_slug = format!("race-rename-target-{tag}");

    let first_id = create_committed_user(
        &state,
        &format!("Race Renamer One {tag}"),
        &format!("race-renamer-one-{tag}@example.invalid"),
    )
    .await;
    let second_id = create_committed_user(
        &state,
        &format!("Race Renamer Two {tag}"),
        &format!("race-renamer-two-{tag}@example.invalid"),
    )
    .await;

    let rename_racer = async |user_id: i64| {
        let txn = state
            .database
            .begin()
            .await
            .expect("rename transaction should begin");
        let ctx = ServiceContext::new(&state, &txn);
        let mut body = update_body();
        body.name = Maybe::Set(target_name.clone());
        let result =
            UserService::update(&ctx, Reference::Id(user_id), IP_ADDRESS, body).await;
        match &result {
            Ok(_) => txn
                .commit()
                .await
                .expect("winning rename transaction should commit"),
            Err(_) => txn
                .rollback()
                .await
                .expect("losing rename transaction should roll back"),
        }
        result
    };
    let (first, second) = tokio::join!(rename_racer(first_id), rename_racer(second_id));

    let mut successes = 0;
    let mut errors = Vec::new();
    for result in [first, second] {
        match result {
            Ok(_) => successes += 1,
            Err(error) => errors.push(error),
        }
    }
    assert_eq!(successes, 1, "exactly one concurrent rename should succeed");
    assert_eq!(errors.len(), 1, "exactly one concurrent rename should fail");
    assert_error_code(&errors[0], ErrorType::UserExists);

    let holders = live_users_with_slug(&state, &target_slug).await;
    assert_eq!(
        holders.len(),
        1,
        "exactly one live user should hold the target slug"
    );

    cleanup_users(&state, &[first_id, second_id]).await;
}

#[tokio::test]
async fn concurrent_email_change_rejects_the_duplicate_with_user_exists() {
    let state = test_state().await;
    let tag = cuid();
    let target_email = format!("race-mail-target-{tag}@example.invalid");

    let first_id = create_committed_user(
        &state,
        &format!("Race Mailer One {tag}"),
        &format!("race-mailer-one-{tag}@example.invalid"),
    )
    .await;
    let second_id = create_committed_user(
        &state,
        &format!("Race Mailer Two {tag}"),
        &format!("race-mailer-two-{tag}@example.invalid"),
    )
    .await;

    let email_racer = async |user_id: i64| {
        let txn = state
            .database
            .begin()
            .await
            .expect("email change transaction should begin");
        let ctx = ServiceContext::new(&state, &txn);
        let mut body = update_body();
        body.email = Maybe::Set(target_email.clone());
        let result =
            UserService::update(&ctx, Reference::Id(user_id), IP_ADDRESS, body).await;
        match &result {
            Ok(_) => txn
                .commit()
                .await
                .expect("winning email change transaction should commit"),
            Err(_) => txn
                .rollback()
                .await
                .expect("losing email change transaction should roll back"),
        }
        result
    };
    let (first, second) = tokio::join!(email_racer(first_id), email_racer(second_id));

    let mut successes = 0;
    let mut errors = Vec::new();
    for result in [first, second] {
        match result {
            Ok(_) => successes += 1,
            Err(error) => errors.push(error),
        }
    }
    assert_eq!(
        successes, 1,
        "exactly one concurrent email change should succeed"
    );
    assert_eq!(
        errors.len(),
        1,
        "exactly one concurrent email change should fail"
    );
    assert_error_code(&errors[0], ErrorType::UserExists);

    let holders = live_users_with_email(&state, &target_email).await;
    assert_eq!(
        holders.len(),
        1,
        "exactly one live user should hold the target email"
    );

    cleanup_users(&state, &[first_id, second_id]).await;
}

#[tokio::test]
async fn concurrent_mfa_setup_enrolls_exactly_one_secret() {
    let state = test_state().await;
    let tag = cuid();
    let user_id = create_committed_user(
        &state,
        &format!("Race Mfa {tag}"),
        &format!("race-mfa-{tag}@example.invalid"),
    )
    .await;

    let setup_racer = async || {
        let txn = state
            .database
            .begin()
            .await
            .expect("mfa transaction should begin");
        let ctx = ServiceContext::new(&state, &txn);
        let user = UserService::get_real(&ctx, Reference::Id(user_id))
            .await
            .expect("mfa fixture user should load");
        let result = MfaService::setup(&ctx, &user, IP_ADDRESS).await;
        match &result {
            Ok(_) => txn
                .commit()
                .await
                .expect("winning mfa transaction should commit"),
            Err(_) => txn
                .rollback()
                .await
                .expect("losing mfa transaction should roll back"),
        }
        result
    };
    let (first, second) = tokio::join!(setup_racer(), setup_racer());

    let mut outputs = Vec::new();
    let mut errors = Vec::new();
    for result in [first, second] {
        match result {
            Ok(output) => outputs.push(output),
            Err(error) => errors.push(error),
        }
    }
    assert_eq!(
        outputs.len(),
        1,
        "exactly one concurrent setup should succeed"
    );
    assert_eq!(errors.len(), 1, "exactly one concurrent setup should fail");
    assert_error_code(&errors[0], ErrorType::UserMfaExists);

    let stored = WikijumpUser::find_by_id(user_id)
        .one(&state.database)
        .await
        .expect("stored user should be readable")
        .expect("stored user should exist");
    assert_eq!(
        stored.multi_factor_secret.as_deref(),
        Some(outputs[0].totp_secret.as_str()),
        "the stored secret must be the one returned to the winning setup",
    );
    assert!(stored.multi_factor_recovery_codes.is_some());

    cleanup_users(&state, &[user_id]).await;
}

const MIGRATION_SEED: &str = r#"
INSERT INTO known_user (user_id) VALUES
    (910001), (910002), (910003), (910004), (910005),
    (910006), (910007), (910008), (910009);

INSERT INTO "user" (
    user_id, user_type, name, slug, name_changes_left,
    email, email_verified_at, password, locales, deleted_at
) VALUES
    (910001, 'regular', 'Slug Keeper', 'g3-dupe-slug', 2,
     'slug-keeper@example.invalid', NULL, '!', ARRAY['en'], NULL),
    (910002, 'regular', 'Slug Loser', 'g3-dupe-slug', 2,
     'slug-loser@example.invalid', NULL, '!', ARRAY['en'], NULL),
    (910003, 'regular', 'Slug Deleted', 'g3-dupe-slug', 2,
     'slug-deleted@example.invalid', NULL, '!', ARRAY['en'], '2026-01-01T00:00:00Z'),
    (910009, 'regular', 'Slug Suffixed', 'g3-dupe-slug-910002', 2,
     'slug-suffixed@example.invalid', NULL, '!', ARRAY['en'], NULL),
    (910004, 'regular', 'Mail Keeper', 'g3-mail-keeper', 2,
     'G3-Dupe@Example.invalid', '2026-01-01T00:00:00Z', '!', ARRAY['en'], NULL),
    (910005, 'regular', 'Mail Loser', 'g3-mail-loser', 2,
     'g3-dupe@example.invalid', '2026-01-01T00:00:00Z', '!', ARRAY['en'], NULL),
    (910006, 'bot', 'Mail Bot', 'g3-mail-bot', 2,
     'g3-dupe@example.invalid', NULL, '!', ARRAY['en'], NULL),
    (910007, 'regular', 'Empty One', 'g3-empty-one', 2,
     '', NULL, '!', ARRAY['en'], NULL),
    (910008, 'regular', 'Empty Two', 'g3-empty-two', 2,
     '', NULL, '!', ARRAY['en'], NULL);
"#;

fn migration_files() -> Vec<PathBuf> {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("migrations");
    let mut files: Vec<PathBuf> = fs::read_dir(&dir)
        .expect("migrations directory should be readable")
        .map(|entry| {
            entry
                .expect("migration directory entry should be readable")
                .path()
        })
        .filter(|path| path.extension().is_some_and(|ext| ext == "sql"))
        .collect();
    files.sort();
    files
}

fn replace_database_name(url: &str, name: &str) -> String {
    let (head, query) = match url.split_once('?') {
        Some((head, query)) => (head, Some(query)),
        None => (url, None),
    };
    let (prefix, _) = head
        .rsplit_once('/')
        .expect("database URL should contain a database name");
    let mut replaced = format!("{prefix}/{name}");
    if let Some(query) = query {
        replaced.push('?');
        replaced.push_str(query);
    }
    replaced
}

async fn scratch_user(db: &DatabaseConnection, user_id: i64) -> user::Model {
    WikijumpUser::find_by_id(user_id)
        .one(db)
        .await
        .expect("scratch user should be readable")
        .expect("scratch user should exist")
}

async fn run_migration_scenario(database_url: &str, scratch_name: &str) {
    let scratch = Database::connect(replace_database_name(database_url, scratch_name))
        .await
        .expect("scratch database connection should open");

    let new_migrations = [SLUG_MIGRATION, EMAIL_MIGRATION];
    for file in migration_files() {
        let name = file
            .file_name()
            .expect("migration file should have a name")
            .to_str()
            .expect("migration file name should be UTF-8");
        if new_migrations.contains(&name) {
            continue;
        }
        let sql = fs::read_to_string(&file).expect("migration file should be readable");
        scratch
            .execute_unprepared(&sql)
            .await
            .unwrap_or_else(|error| panic!("migration {name} should apply: {error:?}"));
    }

    scratch
        .execute_unprepared(MIGRATION_SEED)
        .await
        .expect("duplicate seed should apply");

    for name in new_migrations {
        let file = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("migrations")
            .join(name);
        let sql = fs::read_to_string(&file).expect("new migration should be readable");
        scratch
            .execute_unprepared(&sql)
            .await
            .unwrap_or_else(|error| panic!("migration {name} should apply: {error:?}"));
    }

    for index in [SLUG_UNIQUE_INDEX, EMAIL_UNIQUE_INDEX] {
        let row = scratch
            .query_one_raw(Statement::from_string(
                DbBackend::Postgres,
                format!(
                    "SELECT indexname FROM pg_indexes \
                     WHERE tablename = 'user' AND indexname = '{index}'"
                ),
            ))
            .await
            .expect("index lookup should run");
        assert!(row.is_some(), "index {index} should exist after migration");
    }

    let keeper = scratch_user(&scratch, 910001).await;
    assert_eq!(
        keeper.slug, "g3-dupe-slug",
        "earliest slug holder keeps the slug"
    );
    let loser = scratch_user(&scratch, 910002).await;
    assert_eq!(
        loser.slug, "g3-dupe-slug-910002",
        "later slug holder is displaced"
    );
    let suffixed = scratch_user(&scratch, 910009).await;
    assert_eq!(
        suffixed.slug, "g3-dupe-slug-910002-910009",
        "a displaced slug that lands on a taken slug is displaced again",
    );
    let deleted = scratch_user(&scratch, 910003).await;
    assert_eq!(
        deleted.slug, "g3-dupe-slug",
        "deleted rows are not reconciled"
    );
    assert!(deleted.deleted_at.is_some());

    let mail_keeper = scratch_user(&scratch, 910004).await;
    assert_eq!(mail_keeper.email, "G3-Dupe@Example.invalid");
    assert!(mail_keeper.email_verified_at.is_some());
    let mail_loser = scratch_user(&scratch, 910005).await;
    assert_eq!(mail_loser.email, "duplicate-910005@invalid");
    assert!(
        mail_loser.email_verified_at.is_none(),
        "displaced email claims lose verification",
    );
    let mail_bot = scratch_user(&scratch, 910006).await;
    assert_eq!(
        mail_bot.email, "g3-dupe@example.invalid",
        "non-regular users are outside the email claim scope",
    );
    assert_eq!(scratch_user(&scratch, 910007).await.email, "");
    assert_eq!(scratch_user(&scratch, 910008).await.email, "");

    let duplicate_groups = scratch
        .query_one_raw(Statement::from_string(
            DbBackend::Postgres,
            "SELECT count(*) AS n FROM (\
                 SELECT slug FROM \"user\" WHERE deleted_at IS NULL \
                 GROUP BY slug HAVING count(*) > 1\
             ) AS duplicates"
                .to_owned(),
        ))
        .await
        .expect("duplicate group count should run")
        .expect("duplicate group count should return a row");
    let duplicate_groups: i64 = duplicate_groups
        .try_get_by("n")
        .expect("duplicate group count should decode");
    assert_eq!(duplicate_groups, 0, "no live slug may have two holders");

    let slug_user_id = next_user_id(&scratch).await;
    let slug_error = raw_user(
        slug_user_id,
        "Post Migration Slug",
        "g3-dupe-slug",
        "post-slug@example.invalid",
    )
    .insert(&scratch)
    .await
    .expect_err("a duplicate live slug insert should fail after migration");
    assert!(
        is_index_violation(&slug_error, SLUG_UNIQUE_INDEX),
        "post-migration slug insert should hit {SLUG_UNIQUE_INDEX}, got: {slug_error:?}",
    );

    let email_user_id = next_user_id(&scratch).await;
    let email_error = raw_user(
        email_user_id,
        "Post Migration Mail",
        "g3-post-mail",
        "g3-DUPE@example.invalid",
    )
    .insert(&scratch)
    .await
    .expect_err("a duplicate live email insert should fail after migration");
    assert!(
        is_index_violation(&email_error, EMAIL_UNIQUE_INDEX),
        "post-migration email insert should hit {EMAIL_UNIQUE_INDEX}, got: {email_error:?}",
    );
}

#[tokio::test]
async fn user_uniqueness_migrations_reconcile_live_duplicates() {
    use futures::FutureExt;
    use std::panic::{AssertUnwindSafe, resume_unwind};

    let database_url = Secrets::load().database_url;
    let scratch_name = format!("deepwell_g3_{}", cuid());
    let server = Database::connect(replace_database_name(&database_url, "postgres"))
        .await
        .expect("scratch server connection should open");
    server
        .execute_unprepared(&format!("CREATE DATABASE \"{scratch_name}\""))
        .await
        .expect("scratch database should be created");

    let outcome = AssertUnwindSafe(run_migration_scenario(&database_url, &scratch_name))
        .catch_unwind()
        .await;

    server
        .execute_unprepared(&format!(
            "DROP DATABASE IF EXISTS \"{scratch_name}\" WITH (FORCE)"
        ))
        .await
        .expect("scratch database should be dropped");

    if let Err(panic) = outcome {
        resume_unwind(panic);
    }
}
