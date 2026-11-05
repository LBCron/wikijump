use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::services::ServiceContext;
use sea_orm::{ConnectionTrait, FromQueryResult, Statement, Value};
use sha2::{Digest, Sha256};

#[derive(Debug)]
pub struct AuthenticationAttemptService;

impl AuthenticationAttemptService {
    pub async fn reserve(
        ctx: &ServiceContext<'_>,
        bucket_key: &str,
        max_attempts: i64,
        window_seconds: i64,
    ) -> Result<bool> {
        #[derive(Debug, FromQueryResult)]
        struct CounterRow {
            attempts: i64,
        }

        let transaction = ctx.transaction();
        transaction
            .execute_unprepared(
                "DELETE FROM authentication_attempt WHERE window_started_at < NOW() - INTERVAL '1 day'",
            )
            .await
            .or_raise(|| {
                Error::new(
                    "failed to prune expired authentication attempt counters",
                    ErrorType::DatabaseQuery,
                )
            })?;

        let statement = Statement::from_sql_and_values(
            transaction.get_database_backend(),
            r#"
INSERT INTO authentication_attempt (bucket_key, window_started_at, attempts)
VALUES ($1, NOW(), 1)
ON CONFLICT (bucket_key)
DO UPDATE SET
    window_started_at = CASE
        WHEN authentication_attempt.window_started_at <= NOW() - ($2::bigint * INTERVAL '1 second')
            THEN NOW()
        ELSE authentication_attempt.window_started_at
    END,
    attempts = CASE
        WHEN authentication_attempt.window_started_at <= NOW() - ($2::bigint * INTERVAL '1 second')
            THEN 1
        ELSE LEAST(authentication_attempt.attempts + 1, $3::bigint + 1)
    END
RETURNING attempts
            "#,
            [
                Value::from(bucket_key.to_owned()),
                Value::from(window_seconds),
                Value::from(max_attempts),
            ],
        );
        let row = CounterRow::find_by_statement(statement)
            .one(transaction)
            .await
            .or_raise(|| {
                Error::new(
                    "failed to update authentication attempt counter",
                    ErrorType::DatabaseQuery,
                )
            })?
            .ok_or_else(|| {
                Error::new(
                    "authentication attempt counter returned no value",
                    ErrorType::DatabaseQuery,
                )
            })?;

        Ok(row.attempts <= max_attempts)
    }

    pub async fn clear(ctx: &ServiceContext<'_>, bucket_keys: &[String]) -> Result<()> {
        if bucket_keys.is_empty() {
            return Ok(());
        }
        let transaction = ctx.transaction();
        for bucket_key in bucket_keys {
            let statement = Statement::from_sql_and_values(
                transaction.get_database_backend(),
                "DELETE FROM authentication_attempt WHERE bucket_key = $1",
                [Value::from(bucket_key.clone())],
            );
            transaction.execute_raw(statement).await.or_raise(|| {
                Error::new(
                    "failed to clear authentication attempt counters",
                    ErrorType::DatabaseQuery,
                )
            })?;
        }
        Ok(())
    }

    pub async fn release(ctx: &ServiceContext<'_>, bucket_key: &str) -> Result<()> {
        let transaction = ctx.transaction();
        let delete = Statement::from_sql_and_values(
            transaction.get_database_backend(),
            "DELETE FROM authentication_attempt WHERE bucket_key = $1 AND attempts = 1",
            [Value::from(bucket_key.to_owned())],
        );
        transaction.execute_raw(delete).await.or_raise(|| {
            Error::new(
                "failed to release authentication attempt counter",
                ErrorType::DatabaseQuery,
            )
        })?;

        let decrement = Statement::from_sql_and_values(
            transaction.get_database_backend(),
            "UPDATE authentication_attempt SET attempts = attempts - 1 WHERE bucket_key = $1 AND attempts > 1",
            [Value::from(bucket_key.to_owned())],
        );
        transaction.execute_raw(decrement).await.or_raise(|| {
            Error::new(
                "failed to release authentication attempt counter",
                ErrorType::DatabaseQuery,
            )
        })?;

        Ok(())
    }

    pub fn login_ip_bucket(ip_address: &str) -> String {
        format!(
            "login:ip:{}",
            hex::encode(Sha256::digest(ip_address.as_bytes()))
        )
    }

    pub fn login_user_bucket(user_id: i64) -> String {
        format!("login:user:{user_id}")
    }

    pub fn email_issue_user_bucket(user_id: i64) -> String {
        format!("email_issue:user:{user_id}")
    }

    pub fn login_user_ip_bucket(user_id: i64, ip_address: &str) -> String {
        format!(
            "login:user:{user_id}:ip:{}",
            hex::encode(Sha256::digest(ip_address.as_bytes()))
        )
    }

    pub fn mfa_user_bucket(user_id: i64) -> String {
        format!("mfa:user:{user_id}")
    }

    pub fn register_ip_bucket(ip_address: &str) -> String {
        format!(
            "register:ip:{}",
            hex::encode(Sha256::digest(ip_address.as_bytes()))
        )
    }

    pub fn register_global_bucket() -> String {
        str!("register:global")
    }

    pub fn page_create_user_bucket(user_id: i64) -> String {
        format!("page_create:user:{user_id}")
    }

    pub fn page_create_site_bucket(site_id: i64) -> String {
        format!("page_create:site:{site_id}")
    }

    pub fn page_edit_user_bucket(user_id: i64) -> String {
        format!("page_edit:user:{user_id}")
    }
}
