/*
 * services/session/service.rs
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

use super::structs::{CreateSession, RenewSession};
use crate::config::Config;
use crate::error::prelude::{Error, ErrorType, OptionExt, Result, ResultExt};
use crate::models::session::{self, Entity as Session, Model as SessionModel};
use crate::models::user::{Entity as User, Model as UserModel};
use crate::services::ServiceContext;
use crate::utils::assert_is_csprng;
use crate::utils::now;
use rand::distr::{Alphanumeric, SampleString};
use sea_orm::prelude::IpNetwork;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, DeleteResult, EntityTrait, ExprTrait,
    QueryFilter, QuerySelect, Set,
};

#[derive(Debug)]
pub struct SessionService;
#[derive(Debug)]
pub struct LockedMfaAttempt {
    session: SessionModel,
    user: UserModel,
}

impl LockedMfaAttempt {
    pub async fn lock(
        ctx: &ServiceContext<'_>,
        session_token: &str,
    ) -> Result<Option<Self>> {
        info!("Locking restricted session for MFA verification");

        let make_error = || {
            Error::new(
                "failed to lock restricted session for MFA verification",
                ErrorType::Session,
            )
        };
        let session = SessionService::mfa_attempt_session_query(session_token)
            .one(ctx.transaction())
            .await
            .or_raise(make_error)?;
        let Some(session) = session else {
            return Ok(None);
        };

        let user = SessionService::mfa_attempt_user_query(session.user_id)
            .one(ctx.transaction())
            .await
            .or_raise(make_error)?
            .ok_or_raise(|| {
                Error::new(
                    "restricted session refers to a user that does not exist",
                    ErrorType::UserNotFound,
                )
            })?;

        Ok(Some(Self { session, user }))
    }

    pub fn session(&self) -> &SessionModel {
        &self.session
    }

    pub fn user(&self) -> &UserModel {
        &self.user
    }

    pub fn into_user(self) -> UserModel {
        self.user
    }
}

impl SessionService {
    pub const MAX_MFA_FAILED_ATTEMPTS: i32 = 5;

    fn mfa_attempt_session_query(session_token: &str) -> sea_orm::Select<Session> {
        Session::find()
            .filter(
                Condition::all()
                    .add(session::Column::SessionToken.eq(session_token))
                    .add(session::Column::ExpiresAt.gt(now()))
                    .add(session::Column::Restricted.eq(true))
                    .add(
                        session::Column::MfaFailedAttempts
                            .lt(Self::MAX_MFA_FAILED_ATTEMPTS),
                    ),
            )
            .lock_exclusive()
    }

    fn mfa_attempt_user_query(user_id: i64) -> sea_orm::Select<User> {
        User::find_by_id(user_id).lock_exclusive()
    }

    pub async fn create(
        ctx: &ServiceContext<'_>,
        CreateSession {
            user_id,
            ip_address,
            user_agent,
            restricted,
        }: CreateSession,
    ) -> Result<String> {
        info!("Creating new session for user ID {user_id} (restricted: {restricted})");

        let txn = ctx.transaction();
        let config = ctx.config();
        let token = Self::new_token(config);
        let now = now();
        let expiry = if restricted {
            now + config.restricted_session_duration
        } else {
            now + config.normal_session_duration
        };

        let make_error = || {
            Error::new(
                format!(
                    "failed to create a user session for user ID {} (restricted {})",
                    user_id, restricted,
                ),
                ErrorType::CreateSession,
            )
        };

        let model = session::ActiveModel {
            session_token: Set(token),
            user_id: Set(user_id),
            created_at: Set(now),
            expires_at: Set(expiry),
            ip_address: Set(IpNetwork::from(ip_address)),
            user_agent: Set(user_agent),
            restricted: Set(restricted),
            mfa_failed_attempts: Set(0),
        };

        let SessionModel { session_token, .. } =
            model.insert(txn).await.or_raise(make_error)?;

        info!("Created new session token");
        Ok(session_token)
    }

    fn new_token(config: &Config) -> String {
        debug!("Generating a new session token");
        let mut rng = rand::rng();
        assert_is_csprng(&rng);

        let mut token = Alphanumeric.sample_string(&mut rng, config.session_token_length);
        token.insert_str(0, &config.session_token_prefix);

        token
    }

    pub async fn get(
        ctx: &ServiceContext<'_>,
        session_token: &str,
    ) -> Result<SessionModel> {
        info!("Looking up session by token");

        let make_error =
            |error_type| Error::new("failed to look up session by token", error_type);

        let session = Self::get_optional(ctx, session_token)
            .await
            .or_raise(|| make_error(ErrorType::Session))?
            .ok_or_else(|| make_error(ErrorType::InvalidSessionToken))?;

        Ok(session)
    }

    pub async fn get_optional(
        ctx: &ServiceContext<'_>,
        session_token: &str,
    ) -> Result<Option<SessionModel>> {
        Self::get_optional_matching_restricted(ctx, session_token, false).await
    }

    async fn get_optional_matching_restricted(
        ctx: &ServiceContext<'_>,
        session_token: &str,
        restricted: bool,
    ) -> Result<Option<SessionModel>> {
        let txn = ctx.transaction();
        let mut condition = Condition::all()
            .add(session::Column::SessionToken.eq(session_token))
            .add(session::Column::ExpiresAt.gt(now()))
            .add(session::Column::Restricted.eq(restricted));
        if restricted {
            condition = condition.add(
                session::Column::MfaFailedAttempts.lt(Self::MAX_MFA_FAILED_ATTEMPTS),
            );
        }

        let session =
            Session::find()
                .filter(condition)
                .one(txn)
                .await
                .or_raise(|| {
                    Error::new("failed to look up session by token", ErrorType::Session)
                })?;

        Ok(session)
    }

    pub async fn get_user_for_mfa_attempt(
        ctx: &ServiceContext<'_>,
        session_token: &str,
    ) -> Result<Option<UserModel>> {
        let locked = LockedMfaAttempt::lock(ctx, session_token).await?;
        Ok(locked.map(LockedMfaAttempt::into_user))
    }

    pub async fn record_failed_mfa_attempt(
        ctx: &ServiceContext<'_>,
        session_token: &str,
    ) -> Result<()> {
        let make_error = || {
            Error::new(
                "failed to record restricted-session MFA rejection",
                ErrorType::Session,
            )
        };
        let result = Session::update_many()
            .col_expr(
                session::Column::MfaFailedAttempts,
                Expr::col(session::Column::MfaFailedAttempts).add(1),
            )
            .filter(
                Condition::all()
                    .add(session::Column::SessionToken.eq(session_token))
                    .add(session::Column::ExpiresAt.gt(now()))
                    .add(session::Column::Restricted.eq(true))
                    .add(
                        session::Column::MfaFailedAttempts
                            .lt(Self::MAX_MFA_FAILED_ATTEMPTS),
                    ),
            )
            .exec(ctx.transaction())
            .await
            .or_raise(make_error)?;

        if result.rows_affected != 1 {
            bail!(make_error());
        }

        Ok(())
    }

    pub async fn get_user(
        ctx: &ServiceContext<'_>,
        session_token: &str,
        restricted: bool,
    ) -> Result<UserModel> {
        info!("Looking up user for session token");

        let make_error = || {
            Error::new(
                "failed to get user associated with session token",
                ErrorType::Session,
            )
        };

        let session =
            Self::get_optional_matching_restricted(ctx, session_token, restricted)
                .await
                .or_raise(make_error)?;
        let session = match session {
            Some(session) => session,
            None => {
                bail!(Error::new(
                    "cannot get user associated with session token, session does not exist",
                    ErrorType::InvalidSessionToken,
                ));
            }
        };

        let user_opt = User::find_by_id(session.user_id)
            .one(ctx.transaction())
            .await
            .or_raise(make_error)?;

        match user_opt {
            Some(user) => Ok(user),
            None => bail!(Error::new(
                "cannot get user associated with session token, user does not exist",
                ErrorType::UserNotFound
            )),
        }
    }

    pub async fn get_user_with_id(
        ctx: &ServiceContext<'_>,
        session_token: &str,
        restricted: bool,
        user_id: i64,
    ) -> Result<UserModel> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to check that user associated with a session matches user ID {} (restricted {})",
                    user_id, restricted,
                ),
                ErrorType::Session,
            )
        };

        let user = Self::get_user(ctx, session_token, restricted)
            .await
            .or_raise(make_error)?;

        if user.user_id != user_id {
            error!(
                "Passed user ID ({}) does not match session token ({})",
                user_id, user.user_id,
            );
            bail!(Error::new(
                format!(
                    "user associated with session (ID {}) does not match expected user ID {}",
                    user.user_id, user_id,
                ),
                ErrorType::SessionUserId {
                    active_user_id: user_id,
                    session_user_id: user.user_id,
                }
            ));
        }

        Ok(user)
    }

    pub async fn get_all(
        ctx: &ServiceContext<'_>,
        user_id: i64,
    ) -> Result<Vec<SessionModel>> {
        info!("Getting all sessions for user ID {user_id}");

        let make_error = || {
            Error::new(
                format!("failed to get all sessions for user ID {}", user_id),
                ErrorType::Session,
            )
        };

        let txn = ctx.transaction();
        let sessions = Session::find()
            .filter(
                Condition::all()
                    .add(session::Column::UserId.eq(user_id))
                    .add(session::Column::ExpiresAt.gt(now())),
            )
            .all(txn)
            .await
            .or_raise(make_error)?;

        Ok(sessions)
    }

    pub async fn renew(ctx: &ServiceContext<'_>, input: RenewSession) -> Result<String> {
        Self::renew_matching_restricted(ctx, input, false).await
    }

    pub async fn renew_restricted(
        ctx: &ServiceContext<'_>,
        input: RenewSession,
    ) -> Result<String> {
        Self::renew_matching_restricted(ctx, input, true).await
    }

    async fn renew_matching_restricted(
        ctx: &ServiceContext<'_>,
        RenewSession {
            old_session_token,
            user_id,
            ip_address,
            user_agent,
        }: RenewSession,
        restricted: bool,
    ) -> Result<String> {
        info!("Renewing session");

        let make_error = || {
            Error::new(
                format!("failed to renew session for user ID {}", user_id),
                ErrorType::Session,
            )
        };

        let old_session =
            Self::get_optional_matching_restricted(ctx, &old_session_token, restricted)
                .await
                .or_raise(make_error)?
                .ok_or_else(|| {
                    Error::new(
                        "failed to look up session by token",
                        ErrorType::InvalidSessionToken,
                    )
                })?;

        if old_session.user_id != user_id {
            error!(
                "Requested session renewal, user IDs do not match! (current: {}, request: {})",
                old_session.user_id, user_id,
            );
            bail!(Error::new(
                format!(
                    "cannot renew session for user ID {}, this session is for user ID {}",
                    user_id, old_session.user_id
                ),
                ErrorType::SessionUserId {
                    active_user_id: user_id,
                    session_user_id: old_session.user_id,
                }
            ));
        }

        let (result1, session_token_result) = join!(
            Self::invalidate(ctx, old_session_token),
            Self::create(
                ctx,
                CreateSession {
                    user_id,
                    ip_address,
                    user_agent,
                    restricted: false,
                }
            ),
        );
        let (_, session_token) =
            raise_multiple!(result1, session_token_result; make_error);

        Ok(session_token)
    }

    pub async fn invalidate(
        ctx: &ServiceContext<'_>,
        session_token: String,
    ) -> Result<()> {
        info!("Invalidating session");

        let make_error =
            || Error::new("failed to invalidate session", ErrorType::Session);

        let txn = ctx.transaction();
        let DeleteResult { rows_affected, .. } = Session::delete_by_id(session_token)
            .exec(txn)
            .await
            .or_raise(make_error)?;

        if rows_affected != 1 {
            error!("This session was already deleted or does not exist");
            bail!(Error::new(
                "cannot invalidate session, already deleted or does not exist",
                ErrorType::InvalidSessionToken
            ));
        }

        Ok(())
    }

    pub async fn invalidate_others(
        ctx: &ServiceContext<'_>,
        session_token: &str,
        user_id: i64,
    ) -> Result<u64> {
        info!("Invalidation all other session IDs for user ID {user_id}");

        let make_error = || {
            Error::new(
                format!(
                    "failed to invalidate all other sessions for user ID {}",
                    user_id,
                ),
                ErrorType::Session,
            )
        };

        let txn = ctx.transaction();
        let session = Self::get(ctx, session_token).await.or_raise(make_error)?;

        if session.user_id != user_id {
            error!(
                "Requested invalidation of other sessions, user IDs do not match! (current: {}, request: {})",
                session.user_id, user_id,
            );
            bail!(Error::new(
                format!(
                    "cannot invalidate all other sessions for user ID {}, but this session is for user ID {}",
                    user_id, session.user_id
                ),
                ErrorType::SessionUserId {
                    active_user_id: user_id,
                    session_user_id: session.user_id,
                }
            ));
        }

        let DeleteResult { rows_affected, .. } = Session::delete_many()
            .filter(
                Condition::all()
                    .add(session::Column::SessionToken.ne(session_token))
                    .add(session::Column::UserId.eq(user_id)),
            )
            .exec(txn)
            .await
            .or_raise(make_error)?;

        debug!("User ID {user_id}: {rows_affected} other sessions were invalidated");
        Ok(rows_affected)
    }

    pub async fn invalidate_all(ctx: &ServiceContext<'_>, user_id: i64) -> Result<u64> {
        info!("Invalidating all session IDs for user ID {user_id}");

        let make_error = || {
            Error::new(
                format!("failed to invalidate all sessions for user ID {user_id}"),
                ErrorType::Session,
            )
        };

        let DeleteResult { rows_affected, .. } = Session::delete_many()
            .filter(session::Column::UserId.eq(user_id))
            .exec(ctx.transaction())
            .await
            .or_raise(make_error)?;

        debug!("User ID {user_id}: {rows_affected} sessions were invalidated");
        Ok(rows_affected)
    }

    pub async fn prune(ctx: &ServiceContext<'_>) -> Result<u64> {
        info!("Pruning all expired sessions");

        let make_error =
            || Error::new("failed to prune all expired sessions", ErrorType::Session);

        let txn = ctx.transaction();
        let DeleteResult { rows_affected, .. } = Session::delete_many()
            .filter(session::Column::ExpiresAt.lte(now()))
            .exec(txn)
            .await
            .or_raise(make_error)?;

        debug!("{rows_affected} expired sessions were pruned");
        Ok(rows_affected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{DbBackend, QueryTrait};

    #[test]
    fn mfa_attempt_lookup_is_bounded_and_row_locked() {
        let statement = SessionService::mfa_attempt_session_query("restricted-token")
            .build(DbBackend::Postgres)
            .to_string();

        assert!(statement.contains("mfa_failed_attempts"));
        assert!(statement.contains("< 5"));
        assert!(statement.ends_with("FOR UPDATE"));
    }

    #[test]
    fn mfa_attempt_user_lookup_is_row_locked_across_sessions() {
        let statement = SessionService::mfa_attempt_user_query(42)
            .build(DbBackend::Postgres)
            .to_string();

        assert!(statement.contains("user_id"));
        assert!(statement.ends_with("FOR UPDATE"));
    }
}
