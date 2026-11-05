/*
 * endpoints/auth.rs
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

use super::prelude::*;
use crate::models::session::Model as SessionModel;
use crate::services::authentication::{
    AuthenticateUserOutput, AuthenticationService, LoginOutcome, LoginUser, LoginUserMfa,
    LoginUserOutput, MultiFactorAuthenticateOutput, MultiFactorAuthenticateUser,
};
use crate::services::authorization_token::AuthorizationTokenService;
use crate::services::mfa::{
    MultiFactorConfigure, MultiFactorDisable, MultiFactorResetOutput,
    MultiFactorSetupOutput,
};
use crate::services::session::{
    CreateSession, GetOtherSessions, GetOtherSessionsOutput, InvalidateOtherSessions,
    RenewSession,
};

pub async fn auth_login(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<LoginUserOutput> {
    let LoginUser {
        authenticate,
        ip_address,
        user_agent,
    } = parse!(params, Login);

    if authenticate.password.is_empty() {
        error!("User submitted empty password in auth request");
        bail!(Error::new(
            "password cannot be empty",
            ErrorType::EmptyPassword,
        ));
    }

    let make_error = || Error::new("failed to perform login", ErrorType::Login);

    let result =
        AuthenticationService::auth_password(ctx, authenticate, ip_address).await;
    let AuthenticateUserOutput { needs_mfa, user_id } =
        match LoginOutcome::from_result(result) {
            LoginOutcome::Authenticated(output) => output,
            LoginOutcome::InvalidAuthentication(error) => bail!(error),
            LoginOutcome::Failed(error) => bail!(error),
        };

    let login_complete = !needs_mfa;
    info!(
        "Password authentication for user ID {user_id} succeeded (login complete: {login_complete})",
    );

    let session_token = SessionService::create(
        ctx,
        CreateSession {
            user_id,
            ip_address,
            user_agent,
            restricted: !login_complete,
        },
    )
    .await
    .or_raise(make_error)?;

    Ok(LoginUserOutput {
        session_token,
        needs_mfa,
    })
}

pub async fn auth_logout(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<()> {
    let session_token: String = parse_one!(params, Logout);

    SessionService::invalidate(ctx, session_token)
        .await
        .or_raise(|| Error::new("failed to perform logout", ErrorType::Logout))
}

pub async fn auth_session_get(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Option<SessionModel>> {
    let session_token: String = parse_one!(params);

    SessionService::get_optional(ctx, &session_token)
        .await
        .or_raise(|| Error::new("failed to get session data", ErrorType::Request))
}

pub async fn auth_session_renew(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<String> {
    let input: RenewSession = parse_one!(params);

    SessionService::renew(ctx, input)
        .await
        .or_raise(|| Error::new("failed to renew session data", ErrorType::Request))
}

pub async fn auth_session_get_others(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<GetOtherSessionsOutput> {
    let GetOtherSessions {
        user_id,
        session_token,
    } = parse!(params);

    let make_error = || Error::new("failed to get other sessions", ErrorType::Request);

    let mut sessions = SessionService::get_all(ctx, user_id)
        .await
        .or_raise(make_error)?;

    // Restricted (pre-MFA) sessions authenticate nothing except MFA completion,
    // so they can neither satisfy the membership check below nor appear in the
    // output. A restricted presenting token lands on the uniform 3001 with no
    // disclosure, matching session_get (restricted reads as null).
    sessions.retain(|session| !session.restricted);

    let current = match sessions
        .iter()
        .position(|session| session.session_token == session_token)
    {
        Some(index) => sessions.remove(index),
        None => {
            error!(
                "Cannot find own session token in list of all sessions, must be invalid",
            );
            bail!(Error::new(
                "failed to get session token, must be invalid",
                ErrorType::InvalidSessionToken,
            ));
        }
    };

    Ok(GetOtherSessionsOutput {
        current,
        others: sessions,
    })
}

pub async fn auth_session_invalidate_others(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<u64> {
    let InvalidateOtherSessions {
        session_token,
        user_id,
    } = parse!(params);

    SessionService::invalidate_others(ctx, &session_token, user_id)
        .await
        .or_raise(|| {
            Error::new("failed to invalidate other sessions", ErrorType::Request)
        })
}

pub async fn auth_mfa_verify(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<String> {
    let LoginUserMfa {
        session_token,
        totp_or_code,
        ip_address,
        user_agent,
    } = parse!(params, InvalidAuthentication);

    let make_error = || {
        Error::new(
            "failed to verify user MFA",
            ErrorType::InvalidAuthentication,
        )
    };

    info!("Verifying user's MFA for login");

    let authentication = AuthenticationService::auth_mfa(
        ctx,
        MultiFactorAuthenticateUser {
            session_token: &session_token,
            totp_or_code: &totp_or_code,
        },
    )
    .await
    .or_raise(make_error)?;
    let user = match authentication {
        MultiFactorAuthenticateOutput::Authenticated(user) => user,
        MultiFactorAuthenticateOutput::Rejected => {
            ctx.commit_expected_authentication_rejection();
            bail!(make_error());
        }
    };

    SessionService::renew_restricted(
        ctx,
        RenewSession {
            old_session_token: session_token,
            user_id: user.user_id,
            ip_address,
            user_agent,
        },
    )
    .await
    .or_raise(make_error)
}

pub async fn auth_mfa_setup(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<MultiFactorSetupOutput> {
    let MultiFactorConfigure {
        user_id,
        session_token,
        ip_address,
    } = parse!(params);

    let make_error = || Error::new("failed to set up MFA", ErrorType::Request);

    let user = SessionService::get_user_with_id(ctx, &session_token, false, user_id)
        .await
        .or_raise(make_error)?;

    MfaService::setup(ctx, &user, ip_address)
        .await
        .or_raise(make_error)
}

pub async fn auth_mfa_disable(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<()> {
    let MultiFactorDisable {
        user_id,
        session_token,
        ip_address,
        password,
        totp_or_code,
    } = parse!(params);

    let make_error = || Error::new("failed to disable MFA", ErrorType::Request);

    let user = SessionService::get_user_with_id(ctx, &session_token, false, user_id)
        .await
        .or_raise(make_error)?;

    MfaService::disable(ctx, &user, &password, &totp_or_code, ip_address)
        .await
        .or_raise(make_error)
}

pub async fn auth_mfa_reset_recovery(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<MultiFactorResetOutput> {
    let MultiFactorConfigure {
        user_id,
        session_token,
        ip_address,
    } = parse!(params);

    let make_error = || Error::new("failed to reset recovery codes", ErrorType::Request);

    let user = SessionService::get_user_with_id(ctx, &session_token, false, user_id)
        .await
        .or_raise(make_error)?;

    MfaService::reset_recovery_codes(ctx, &user, ip_address)
        .await
        .or_raise(make_error)
}

pub async fn auth_token_issue(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<String> {
    let input = parse!(params, AuthorizationToken);
    let make_error = || {
        Error::new(
            "failed to issue new authorization token",
            ErrorType::Request,
        )
    };

    AuthorizationTokenService::create(ctx, input)
        .await
        .or_raise(make_error)
}
