/*
 * services/email/email_token.rs
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

use std::net::IpAddr;

use rand::distr::{Alphanumeric, SampleString};
use sea_orm::prelude::IpNetwork;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, DatabaseBackend, EntityTrait,
    QueryFilter, QueryOrder, Set, Statement, Value,
};
use serde::{Deserialize, Serialize};
use time::Duration;

use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::hash::{TextHexHash, k12_hash, text_hash_to_hex};
use crate::models::email_token::{self, Entity as EmailToken};
use crate::services::AuthenticationAttemptService;
use crate::services::ServiceContext;
use crate::utils::{assert_is_csprng, now};

const VERIFY_EMAIL_TTL: Duration = Duration::hours(24);
const RESET_PASSWORD_TTL: Duration = Duration::hours(1);
const RESET_GRANT_TTL: Duration = Duration::minutes(15);
const DELETE_CONFIRM_TTL: Duration = Duration::hours(1);
const DELETE_GRANT_TTL: Duration = Duration::minutes(15);

const RESEND_COOLDOWN: Duration = Duration::seconds(60);

const ISSUE_ACCOUNT_MAX: i64 = 10;
const ISSUE_ACCOUNT_WINDOW_SECONDS: i64 = 900;

const TOKEN_LENGTH: usize = 48;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EmailTokenPurpose {
    VerifyEmail,
    ResetPassword,
    ResetGrant,
    DeleteConfirm,
    DeleteGrant,
}

impl EmailTokenPurpose {
    pub fn as_str(self) -> &'static str {
        match self {
            EmailTokenPurpose::VerifyEmail => "verify_email",
            EmailTokenPurpose::ResetPassword => "reset_password",
            EmailTokenPurpose::ResetGrant => "reset_grant",
            EmailTokenPurpose::DeleteConfirm => "delete_confirm",
            EmailTokenPurpose::DeleteGrant => "delete_grant",
        }
    }

    pub(crate) fn ttl(self) -> Duration {
        match self {
            EmailTokenPurpose::VerifyEmail => VERIFY_EMAIL_TTL,
            EmailTokenPurpose::ResetPassword => RESET_PASSWORD_TTL,
            EmailTokenPurpose::ResetGrant => RESET_GRANT_TTL,
            EmailTokenPurpose::DeleteConfirm => DELETE_CONFIRM_TTL,
            EmailTokenPurpose::DeleteGrant => DELETE_GRANT_TTL,
        }
    }
}

#[derive(Debug)]
pub struct IssueEmailToken {
    pub user_id: i64,
    pub email: String,
    pub purpose: EmailTokenPurpose,
    pub ip_address: IpAddr,
}

#[derive(PartialEq, Eq)]
pub struct IssuedEmailToken {
    pub token: String,
    pub expires_at: time::OffsetDateTime,
}

impl std::fmt::Debug for IssuedEmailToken {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("IssuedEmailToken")
            .field("token", &"..")
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

/// Outcome of an issue request.
///
/// `Suppressed` means a live token is still inside its resend cooldown (or
/// the caller address is over its issue bound): the caller MUST answer
/// exactly as if a token had been issued, so the bound never becomes an
/// existence oracle.
///
/// The issued plaintext token never appears in debug output: `Issued`
/// prints only its redacted form, never the secret it carries.
#[derive(PartialEq, Eq)]
pub enum IssueEmailTokenOutcome {
    Issued(IssuedEmailToken),
    Suppressed,
}

impl std::fmt::Debug for IssueEmailTokenOutcome {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IssueEmailTokenOutcome::Issued(issued) => write!(f, "Issued({issued:?})"),
            IssueEmailTokenOutcome::Suppressed => write!(f, "Suppressed"),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LinkTokenPurpose {
    VerifyEmail,
    ResetPassword,
    DeleteConfirm,
}

impl LinkTokenPurpose {
    fn token_purpose(self) -> EmailTokenPurpose {
        match self {
            LinkTokenPurpose::VerifyEmail => EmailTokenPurpose::VerifyEmail,
            LinkTokenPurpose::ResetPassword => EmailTokenPurpose::ResetPassword,
            LinkTokenPurpose::DeleteConfirm => EmailTokenPurpose::DeleteConfirm,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantTokenPurpose {
    ResetGrant,
    DeleteGrant,
}

impl GrantTokenPurpose {
    fn token_purpose(self) -> EmailTokenPurpose {
        match self {
            GrantTokenPurpose::ResetGrant => EmailTokenPurpose::ResetGrant,
            GrantTokenPurpose::DeleteGrant => EmailTokenPurpose::DeleteGrant,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinkTokenAuthority;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GrantTokenAuthority;

#[derive(Debug, PartialEq, Eq)]
pub struct RedeemedEmailToken<A> {
    pub user_id: i64,
    pub email: String,
    authority: std::marker::PhantomData<A>,
}

pub type RedeemedLinkToken = RedeemedEmailToken<LinkTokenAuthority>;
pub type RedeemedGrantToken = RedeemedEmailToken<GrantTokenAuthority>;

#[derive(Debug)]
pub struct EmailTokenService;

impl EmailTokenService {
    pub async fn issue(
        ctx: &ServiceContext<'_>,
        IssueEmailToken {
            user_id,
            email,
            purpose,
            ip_address,
        }: IssueEmailToken,
    ) -> Result<IssueEmailTokenOutcome> {
        let make_error = || {
            Error::new(
                format!("failed to issue {} token", purpose.as_str()),
                ErrorType::Email,
            )
        };
        let transaction = ctx.transaction();
        let now = now();

        Self::lock_issuance(ctx, user_id).await?;
        Self::delete_expired(ctx, user_id, purpose).await?;
        Self::delete_consumed(ctx, user_id, purpose).await?;

        if let Some(newest) = EmailToken::find()
            .filter(email_token::Column::UserId.eq(user_id))
            .filter(email_token::Column::Purpose.eq(purpose.as_str()))
            .filter(email_token::Column::ConsumedAt.is_null())
            .order_by_desc(email_token::Column::CreatedAt)
            .one(transaction)
            .await
            .or_raise(make_error)?
        {
            if now - newest.created_at < RESEND_COOLDOWN {
                return Ok(IssueEmailTokenOutcome::Suppressed);
            }

            EmailToken::delete_many()
                .filter(email_token::Column::UserId.eq(user_id))
                .filter(email_token::Column::Purpose.eq(purpose.as_str()))
                .filter(email_token::Column::ConsumedAt.is_null())
                .exec(transaction)
                .await
                .or_raise(make_error)?;
        }

        if !AuthenticationAttemptService::reserve(
            ctx,
            &AuthenticationAttemptService::email_issue_user_bucket(user_id),
            ISSUE_ACCOUNT_MAX,
            ISSUE_ACCOUNT_WINDOW_SECONDS,
        )
        .await?
        {
            return Ok(IssueEmailTokenOutcome::Suppressed);
        }

        let issued = Self::insert_token(ctx, user_id, email, purpose, ip_address).await?;
        Ok(IssueEmailTokenOutcome::Issued(issued))
    }

    pub async fn issue_grant(
        ctx: &ServiceContext<'_>,
        link: &RedeemedLinkToken,
        grant_purpose: GrantTokenPurpose,
        ip_address: IpAddr,
    ) -> Result<IssuedEmailToken> {
        let grant_purpose = grant_purpose.token_purpose();
        let user_id = link.user_id;
        let make_error = || {
            Error::new(
                format!("failed to issue {} grant", grant_purpose.as_str()),
                ErrorType::Email,
            )
        };
        Self::delete_expired(ctx, user_id, grant_purpose).await?;
        Self::delete_consumed(ctx, user_id, grant_purpose).await?;

        EmailToken::delete_many()
            .filter(email_token::Column::UserId.eq(user_id))
            .filter(email_token::Column::Purpose.eq(grant_purpose.as_str()))
            .filter(email_token::Column::ConsumedAt.is_null())
            .exec(ctx.transaction())
            .await
            .or_raise(make_error)?;

        Self::insert_token(ctx, user_id, link.email.clone(), grant_purpose, ip_address)
            .await
    }

    pub async fn revoke_all_for_user(
        ctx: &ServiceContext<'_>,
        user_id: i64,
    ) -> Result<()> {
        EmailToken::delete_many()
            .filter(email_token::Column::UserId.eq(user_id))
            .filter(email_token::Column::ConsumedAt.is_null())
            .exec(ctx.transaction())
            .await
            .or_raise(|| {
                Error::new(
                    "failed to revoke outstanding email tokens",
                    ErrorType::Email,
                )
            })?;
        Ok(())
    }

    pub async fn redeem_link(
        ctx: &ServiceContext<'_>,
        token: &str,
        purpose: LinkTokenPurpose,
    ) -> Result<RedeemedLinkToken> {
        Self::redeem_as(ctx, token, purpose.token_purpose()).await
    }

    pub async fn redeem_grant(
        ctx: &ServiceContext<'_>,
        token: &str,
        purpose: GrantTokenPurpose,
    ) -> Result<RedeemedGrantToken> {
        Self::redeem_as(ctx, token, purpose.token_purpose()).await
    }

    async fn redeem_as<A>(
        ctx: &ServiceContext<'_>,
        token: &str,
        purpose: EmailTokenPurpose,
    ) -> Result<RedeemedEmailToken<A>> {
        let make_error =
            || Error::new("failed to redeem email token", ErrorType::InvalidEmailToken);
        let transaction = ctx.transaction();
        let now = now();

        let affected = EmailToken::update_many()
            .col_expr(email_token::Column::ConsumedAt, Expr::value(Some(now)))
            .filter(email_token::Column::TokenHash.eq(Self::hash(token).as_str()))
            .filter(email_token::Column::Purpose.eq(purpose.as_str()))
            .filter(email_token::Column::ConsumedAt.is_null())
            .filter(email_token::Column::ExpiresAt.gt(now))
            .exec(transaction)
            .await
            .or_raise(make_error)?;
        if affected.rows_affected != 1 {
            return Err(make_error().into());
        }

        let Some(model) = EmailToken::find()
            .filter(email_token::Column::TokenHash.eq(Self::hash(token).as_str()))
            .filter(email_token::Column::Purpose.eq(purpose.as_str()))
            .one(transaction)
            .await
            .or_raise(make_error)?
        else {
            return Err(make_error().into());
        };

        Ok(RedeemedEmailToken {
            user_id: model.user_id,
            email: model.email,
            authority: std::marker::PhantomData,
        })
    }

    async fn insert_token(
        ctx: &ServiceContext<'_>,
        user_id: i64,
        email: String,
        purpose: EmailTokenPurpose,
        ip_address: IpAddr,
    ) -> Result<IssuedEmailToken> {
        let make_error = || {
            Error::new(
                format!("failed to issue {} token", purpose.as_str()),
                ErrorType::Email,
            )
        };
        let token = Self::generate();
        let token_hash = Self::hash(&token);
        let expires_at = now() + purpose.ttl();
        email_token::ActiveModel {
            user_id: Set(user_id),
            email: Set(email),
            purpose: Set(str!(purpose.as_str())),
            token_hash: Set(token_hash.to_string()),
            expires_at: Set(expires_at),
            consumed_at: Set(None),
            created_ip: Set(IpNetwork::from(ip_address)),
            ..Default::default()
        }
        .insert(ctx.transaction())
        .await
        .or_raise(make_error)?;

        Ok(IssuedEmailToken { token, expires_at })
    }

    async fn delete_expired(
        ctx: &ServiceContext<'_>,
        user_id: i64,
        purpose: EmailTokenPurpose,
    ) -> Result<()> {
        EmailToken::delete_many()
            .filter(email_token::Column::UserId.eq(user_id))
            .filter(email_token::Column::Purpose.eq(purpose.as_str()))
            .filter(email_token::Column::ExpiresAt.lte(now()))
            .exec(ctx.transaction())
            .await
            .or_raise(|| {
                Error::new(
                    format!("failed to prune expired {} tokens", purpose.as_str()),
                    ErrorType::Email,
                )
            })?;
        Ok(())
    }

    async fn delete_consumed(
        ctx: &ServiceContext<'_>,
        user_id: i64,
        purpose: EmailTokenPurpose,
    ) -> Result<()> {
        EmailToken::delete_many()
            .filter(email_token::Column::UserId.eq(user_id))
            .filter(email_token::Column::Purpose.eq(purpose.as_str()))
            .filter(email_token::Column::ConsumedAt.is_not_null())
            .exec(ctx.transaction())
            .await
            .or_raise(|| {
                Error::new(
                    format!("failed to purge consumed {} tokens", purpose.as_str()),
                    ErrorType::Email,
                )
            })?;
        Ok(())
    }

    async fn lock_issuance(ctx: &ServiceContext<'_>, user_id: i64) -> Result<()> {
        ctx.transaction()
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "SELECT pg_advisory_xact_lock(hashtextextended('email-issue-user:' || $1::TEXT, 0))",
                [Value::from(user_id)],
            ))
            .await
            .or_raise(|| {
                Error::new(
                    "failed to serialize email token issuance",
                    ErrorType::Email,
                )
            })?;
        Ok(())
    }

    fn generate() -> String {
        let mut rng = rand::rng();
        assert_is_csprng(&rng);
        Alphanumeric.sample_string(&mut rng, TOKEN_LENGTH)
    }

    fn hash(token: &str) -> TextHexHash {
        text_hash_to_hex(&k12_hash(token.as_bytes()))
    }
}
