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

//! Single-use, short-lived email ownership and recovery tokens.
//!
//! One table and one service cover verification, password reset, and
//! account-deletion confirmation, distinguished only by purpose. Tokens are
//! random, stored by hash, bound to an exact account + email snapshot +
//! purpose, and consumed atomically on redemption.
//!
//! TTLs, cooldowns, and capacity bounds below are LOCAL DEPLOYMENT DEFAULTS
//! pending live Wikidot evidence (see the account lane plan). They are
//! single constants, easy to tune, and never claimed as Wikidot behavior.

use std::net::IpAddr;

use rand::distr::{Alphanumeric, SampleString};
use sea_orm::prelude::IpNetwork;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QueryOrder,
    Set,
};
use serde::{Deserialize, Serialize};
use time::Duration;

use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::hash::{TextHexHash, k12_hash, text_hash_to_hex};
use crate::models::email_token::{self, Entity as EmailToken};
use crate::services::ServiceContext;
use crate::utils::{assert_is_csprng, now};

/// How long an issued token stays redeemable.
///
/// LOCAL DEFAULT pending live Wikidot evidence.
const VERIFY_EMAIL_TTL: Duration = Duration::hours(24);
/// LOCAL DEFAULT pending live Wikidot evidence.
const RESET_PASSWORD_TTL: Duration = Duration::hours(1);
/// LOCAL DEFAULT pending live Wikidot evidence.
const RESET_GRANT_TTL: Duration = Duration::minutes(15);
/// LOCAL DEFAULT pending live Wikidot evidence.
const DELETE_CONFIRM_TTL: Duration = Duration::hours(1);
/// LOCAL DEFAULT pending live Wikidot evidence.
const DELETE_GRANT_TTL: Duration = Duration::minutes(15);

/// Minimum age of the newest live token before another may be issued.
///
/// LOCAL DEFAULT pending live Wikidot evidence. The public issue endpoints
/// answer identically whether a token was issued or suppressed, so this
/// cooldown never leaks account existence.
const RESEND_COOLDOWN: Duration = Duration::seconds(60);

/// Per-address issue bound: at most this many emailed-link issues per
/// purpose inside the window below, counted over the proxy-aware client
/// address framerail resolves.
///
/// LOCAL DEFAULT pending live Wikidot evidence. Throttled issues report
/// `Suppressed`, exactly like cooldown, so the bound never oracles.
const ISSUE_IP_MAX: u64 = 10;
/// LOCAL DEFAULT pending live Wikidot evidence.
const ISSUE_IP_WINDOW: Duration = Duration::minutes(15);

/// Plaintext token length (alphanumeric, URL-safe without encoding).
const TOKEN_LENGTH: usize = 48;

/// Purpose binding for an email token. A token issued for one purpose can
/// never redeem another; verification, recovery, and deletion confirmation
/// are mutually unintelligible by construction.
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

/// An issued token with its stored expiry, so delivery logging uses the row
/// value instead of recomputing it.
///
/// The plaintext token never appears in debug output.
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

/// What a successful redemption proves: the account and the exact email
/// snapshot the token was bound to.
#[derive(Debug, PartialEq, Eq)]
pub struct RedeemedEmailToken {
    pub user_id: i64,
    pub email: String,
}

#[derive(Debug)]
pub struct EmailTokenService;

impl EmailTokenService {
    /// Issue a token, rotating out prior live tokens for the account and
    /// purpose (a re-issue invalidates earlier links).
    ///
    /// Returns the plaintext token exactly once; only its hash is stored.
    /// Callers must deliver it to the mailbox and never log or persist it.
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

        Self::delete_expired(ctx, user_id, purpose).await?;
        Self::delete_consumed(ctx, user_id, purpose).await?;

        // Address-scoped bound, checked before the account cooldown so one
        // abusive address cannot probe many mailboxes, and answered like a
        // cooldown so the bound never oracles.
        if Self::address_over_bound(ctx, &ip_address, purpose, now).await? {
            return Ok(IssueEmailTokenOutcome::Suppressed);
        }

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

            // Rotation: a fresh issue invalidates earlier live links.
            EmailToken::delete_many()
                .filter(email_token::Column::UserId.eq(user_id))
                .filter(email_token::Column::Purpose.eq(purpose.as_str()))
                .filter(email_token::Column::ConsumedAt.is_null())
                .exec(transaction)
                .await
                .or_raise(make_error)?;
        }

        let issued = Self::insert_token(ctx, user_id, email, purpose, ip_address).await?;
        Ok(IssueEmailTokenOutcome::Issued(issued))
    }

    /// Issue a one-time mutation grant after a freshly consumed link.
    ///
    /// Unlike [`Self::issue`], this never suppresses: every grant spends a
    /// consumed single-use link, grants are never emailed, and outstanding
    /// live grants rotate — so there is no cooldown signal to leak and no
    /// inbox-flood vector. A link therefore always yields its grant; the
    /// link is never burned by a warm bucket.
    ///
    /// `grant_purpose` must be a grant purpose (`ResetGrant`,
    /// `DeleteGrant`): links redeem under their own purpose and the grant
    /// authorizes only the matching terminal mutation.
    pub async fn issue_grant(
        ctx: &ServiceContext<'_>,
        user_id: i64,
        email: String,
        grant_purpose: EmailTokenPurpose,
        ip_address: IpAddr,
    ) -> Result<IssuedEmailToken> {
        debug_assert!(
            matches!(
                grant_purpose,
                EmailTokenPurpose::ResetGrant | EmailTokenPurpose::DeleteGrant,
            ),
            "issue_grant requires a grant purpose",
        );
        let make_error = || {
            Error::new(
                format!("failed to issue {} grant", grant_purpose.as_str()),
                ErrorType::Email,
            )
        };
        Self::delete_expired(ctx, user_id, grant_purpose).await?;
        Self::delete_consumed(ctx, user_id, grant_purpose).await?;

        // Rotation without cooldown: at most one live grant per account.
        EmailToken::delete_many()
            .filter(email_token::Column::UserId.eq(user_id))
            .filter(email_token::Column::Purpose.eq(grant_purpose.as_str()))
            .filter(email_token::Column::ConsumedAt.is_null())
            .exec(ctx.transaction())
            .await
            .or_raise(make_error)?;

        Self::insert_token(ctx, user_id, email, grant_purpose, ip_address).await
    }

    /// Revoke every outstanding (unconsumed) email token for the account,
    /// across all purposes. Called when the account's email rotates so a
    /// link bound to the old mailbox cannot outlive the move (#2693).
    /// Runs in the caller's transaction: revocation lands atomically with
    /// whatever change triggered it. Consumed rows are left alone; they
    /// can never redeem and are purged on the next issue.
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

    /// Redeem a token with a single conditional write instead of
    /// find-then-update: exactly one concurrent redeemer can flip an
    /// unconsumed, unexpired token to consumed. Every loser observes zero
    /// affected rows and fails exactly like a bogus token, so concurrent
    /// double-redeem is impossible and redemption never oracles which
    /// property failed.
    pub async fn redeem(
        ctx: &ServiceContext<'_>,
        token: &str,
        purpose: EmailTokenPurpose,
    ) -> Result<RedeemedEmailToken> {
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

    /// Purge spent tokens for the account and purpose. Consumed rows can
    /// never redeem again, so dropping them on the next issue bounds
    /// per-account row growth to live tokens plus not-yet-reaped expiries.
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

    /// Count recent issues from one address for one purpose. The address is
    /// the proxy-aware client IP framerail resolves, so NAT-shared and
    /// proxied clients share one honest bucket.
    async fn address_over_bound(
        ctx: &ServiceContext<'_>,
        ip_address: &IpAddr,
        purpose: EmailTokenPurpose,
        now: time::OffsetDateTime,
    ) -> Result<bool> {
        let recent = EmailToken::find()
            .filter(email_token::Column::CreatedIp.eq(IpNetwork::from(*ip_address)))
            .filter(email_token::Column::Purpose.eq(purpose.as_str()))
            .filter(email_token::Column::CreatedAt.gt(now - ISSUE_IP_WINDOW))
            .count(ctx.transaction())
            .await
            .or_raise(|| {
                Error::new(
                    format!("failed to count recent {} issues", purpose.as_str()),
                    ErrorType::Email,
                )
            })?;
        Ok(recent >= ISSUE_IP_MAX)
    }

    /// Securely generate a plaintext token. Returned to the caller exactly
    /// once; never persisted or logged.
    fn generate() -> String {
        let mut rng = rand::rng();
        assert_is_csprng(&rng);
        Alphanumeric.sample_string(&mut rng, TOKEN_LENGTH)
    }

    fn hash(token: &str) -> TextHexHash {
        text_hash_to_hex(&k12_hash(token.as_bytes()))
    }
}
