/*
 * services/authentication/service.rs
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

use super::structs::{
    AuthenticateUser, AuthenticateUserOutput, MultiFactorAuthenticateOutput,
    MultiFactorAuthenticateUser, UserAuthInfo,
};
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::user::{self, Entity as User};
use crate::services::ServiceContext;
use crate::services::{
    AuthenticationAttemptService, MfaService, PasswordService, SessionService,
};
use crate::types::UserType;
use sea_orm::sea_query::Expr;
use sea_orm::{ColumnTrait, Condition, EntityTrait, ExprTrait, QueryFilter, QueryOrder};
use std::net::IpAddr;

#[derive(Debug)]
pub struct AuthenticationService;

const LOGIN_IP_MAX_ATTEMPTS: i64 = 30;
const LOGIN_IP_WINDOW_SECONDS: i64 = 60;
const LOGIN_ACCOUNT_IP_MAX_ATTEMPTS: i64 = 10;
const LOGIN_ACCOUNT_IP_WINDOW_SECONDS: i64 = 600;
const LOGIN_ACCOUNT_MAX_ATTEMPTS: i64 = 100;
const LOGIN_ACCOUNT_WINDOW_SECONDS: i64 = 600;

#[derive(Debug)]
struct LoginAttemptBuckets {
    ip_bucket: String,
    account_ip_bucket: Option<String>,
    account_bucket: Option<String>,
}

impl LoginAttemptBuckets {
    fn for_auth(auth: &UserAuthInfo, ip_address: &IpAddr) -> Self {
        let ip_address = ip_address.to_string();

        LoginAttemptBuckets {
            ip_bucket: AuthenticationAttemptService::login_ip_bucket(&ip_address),
            account_ip_bucket: auth.valid.then(|| {
                AuthenticationAttemptService::login_user_ip_bucket(
                    auth.user_id,
                    &ip_address,
                )
            }),
            account_bucket: auth
                .valid
                .then(|| AuthenticationAttemptService::login_user_bucket(auth.user_id)),
        }
    }

    #[cfg(test)]
    fn all_buckets(&self) -> Vec<String> {
        let mut buckets = vec![self.ip_bucket.clone()];
        if let Some(account_ip_bucket) = &self.account_ip_bucket {
            buckets.push(account_ip_bucket.clone());
        }
        if let Some(account_bucket) = &self.account_bucket {
            buckets.push(account_bucket.clone());
        }

        buckets
    }

    async fn reserve_account_buckets(&self, ctx: &ServiceContext<'_>) -> Result<bool> {
        if let Some(account_ip_bucket) = &self.account_ip_bucket {
            let allowed = AuthenticationAttemptService::reserve(
                ctx,
                account_ip_bucket,
                LOGIN_ACCOUNT_IP_MAX_ATTEMPTS,
                LOGIN_ACCOUNT_IP_WINDOW_SECONDS,
            )
            .await?;
            if !allowed {
                return Ok(false);
            }
        }

        if let Some(account_bucket) = &self.account_bucket {
            let allowed = AuthenticationAttemptService::reserve(
                ctx,
                account_bucket,
                LOGIN_ACCOUNT_MAX_ATTEMPTS,
                LOGIN_ACCOUNT_WINDOW_SECONDS,
            )
            .await?;
            if !allowed {
                return Ok(false);
            }
        }

        Ok(true)
    }

    async fn settle_after_verified_password(
        &self,
        ctx: &ServiceContext<'_>,
    ) -> Result<()> {
        if let Some(account_ip_bucket) = &self.account_ip_bucket {
            AuthenticationAttemptService::clear(
                ctx,
                std::slice::from_ref(account_ip_bucket),
            )
            .await?;
        }

        if let Some(account_bucket) = &self.account_bucket {
            AuthenticationAttemptService::release(ctx, account_bucket).await?;
        }
        AuthenticationAttemptService::release(ctx, &self.ip_bucket).await
    }
}

impl AuthenticationService {
    pub async fn auth_password(
        ctx: &ServiceContext<'_>,
        AuthenticateUser {
            name_or_email,
            password,
        }: AuthenticateUser,
        ip_address: IpAddr,
    ) -> Result<AuthenticateUserOutput> {
        let make_error = || {
            Error::new(
                "failed to authenticate user",
                ErrorType::InvalidAuthentication,
            )
        };

        let auth = Self::get_user_auth(ctx, &name_or_email)
            .await
            .or_raise(make_error)?;
        let buckets = LoginAttemptBuckets::for_auth(&auth, &ip_address);

        if !AuthenticationAttemptService::reserve(
            ctx,
            &buckets.ip_bucket,
            LOGIN_IP_MAX_ATTEMPTS,
            LOGIN_IP_WINDOW_SECONDS,
        )
        .await?
        {
            ctx.commit_expected_authentication_rejection();
            bail!(make_error());
        }

        if !buckets.reserve_account_buckets(ctx).await? {
            ctx.commit_expected_authentication_rejection();
            bail!(make_error());
        }

        if let Err(error) =
            Self::verify_password_before_account_bucket(ctx, &password, &auth).await
        {
            if error.error_type == ErrorType::InvalidAuthentication {
                ctx.commit_expected_authentication_rejection();
            }
            return Err(error.raise(make_error()));
        }

        if !auth.valid {
            ctx.commit_expected_authentication_rejection();
            bail!(make_error());
        }

        buckets.settle_after_verified_password(ctx).await?;

        Ok(AuthenticateUserOutput {
            needs_mfa: auth.multi_factor_secret.is_some(),
            user_id: auth.user_id,
        })
    }

    async fn verify_password_before_account_bucket(
        ctx: &ServiceContext<'_>,
        password: &str,
        auth: &UserAuthInfo,
    ) -> Result<()> {
        PasswordService::verify_no_sleep(ctx, password, &auth.password_hash).await
    }

    pub async fn auth_mfa(
        ctx: &ServiceContext<'_>,
        MultiFactorAuthenticateUser {
            session_token,
            totp_or_code,
        }: MultiFactorAuthenticateUser<'_>,
    ) -> Result<MultiFactorAuthenticateOutput> {
        let make_error =
            || Error::new("failed to authenticate MFA code", ErrorType::UserMfa);

        let user = SessionService::get_user_for_mfa_attempt(ctx, session_token)
            .await
            .or_raise(make_error)?;
        let Some(user) = user else {
            return Ok(MultiFactorAuthenticateOutput::Rejected);
        };

        let mfa_bucket = AuthenticationAttemptService::mfa_user_bucket(user.user_id);
        if !AuthenticationAttemptService::reserve(ctx, &mfa_bucket, 5, 600).await? {
            return Ok(MultiFactorAuthenticateOutput::Rejected);
        }

        let verification = match totp_or_code.parse() {
            Ok(totp) => MfaService::verify(ctx, &user, totp).await,

            Err(_) => MfaService::verify_recovery(ctx, &user, totp_or_code).await,
        };

        match verification {
            Ok(()) => {
                AuthenticationAttemptService::clear(ctx, &[mfa_bucket]).await?;
                Ok(MultiFactorAuthenticateOutput::Authenticated(user))
            }
            Err(error) if error.error_type == ErrorType::InvalidAuthentication => {
                SessionService::record_failed_mfa_attempt(ctx, session_token)
                    .await
                    .or_raise(make_error)?;
                Ok(MultiFactorAuthenticateOutput::Rejected)
            }
            Err(error) => Err(error.raise(make_error())),
        }
    }

    async fn get_user_auth(
        ctx: &ServiceContext<'_>,
        name_or_email: &str,
    ) -> Result<UserAuthInfo> {
        let txn = ctx.transaction();
        let verified_email_match = Expr::col(user::Column::Email)
            .eq(name_or_email)
            .and(Expr::col(user::Column::EmailVerifiedAt).is_not_null());
        let result = User::find()
            .filter(
                Condition::all()
                    .add(user::Column::UserType.eq(UserType::Regular))
                    .add(user::Column::DeletedAt.is_null())
                    .add(
                        Condition::any()
                            .add(user::Column::Name.eq(name_or_email))
                            .add(user::Column::Slug.eq(name_or_email))
                            .add(verified_email_match.clone()),
                    ),
            )
            .order_by_desc(verified_email_match)
            .one(txn)
            .await
            .or_raise(|| {
                Error::new(
                    "unable to get user auth information",
                    ErrorType::DatabaseQuery,
                )
            })?;

        match result {
            Some(user) => Ok(UserAuthInfo::valid(user)),

            None => Ok(UserAuthInfo::invalid()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth(valid: bool) -> UserAuthInfo {
        UserAuthInfo {
            user_id: 42,
            password_hash: str!("hash"),
            multi_factor_secret: None,
            valid,
        }
    }

    #[test]
    fn login_buckets_include_account_bucket_only_for_valid_auth() {
        let ip_address = IpAddr::from([127, 0, 0, 1]);

        let buckets = LoginAttemptBuckets::for_auth(&auth(true), &ip_address);
        assert_eq!(
            buckets.all_buckets(),
            vec![
                AuthenticationAttemptService::login_ip_bucket("127.0.0.1"),
                AuthenticationAttemptService::login_user_ip_bucket(42, "127.0.0.1"),
                AuthenticationAttemptService::login_user_bucket(42),
            ],
        );

        let buckets = LoginAttemptBuckets::for_auth(&auth(false), &ip_address);
        assert_eq!(
            buckets.all_buckets(),
            vec![AuthenticationAttemptService::login_ip_bucket("127.0.0.1")],
        );
        assert!(buckets.account_ip_bucket.is_none());
        assert!(buckets.account_bucket.is_none());
    }
}
