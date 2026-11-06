/*
 * endpoints/user.rs
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
use crate::constants::ADMIN_USER_ID;
use crate::models::user::Model as UserModel;
use crate::models::wikidot_user::Entity as WikidotUser;
use crate::services::authentication::AuthenticateUser;
use crate::services::user::{
    ActivateUserFromWikidot, CreateUser, CreateUserOutput, DeleteUser, GetUser,
    GetUserOutput, UpdateUser, UpdateUserBody, User, UserOutput, WikijumpUserOutput,
};
use crate::services::{
    AuthenticationAttemptService, AuthenticationService, MutationAuthorization,
    PasswordService, SessionService,
};

const REGISTER_IP_MAX_ATTEMPTS: i64 = 20;
const REGISTER_IP_WINDOW_SECONDS: i64 = 3600;
const REGISTER_GLOBAL_MAX_ATTEMPTS: i64 = 100;
const REGISTER_GLOBAL_WINDOW_SECONDS: i64 = 3600;

use crate::types::{AliasType, Maybe, Reference, UserType};
use sea_orm::EntityTrait;
use std::net::IpAddr;

pub async fn user_create(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<CreateUserOutput> {
    info!("Creating new regular user");
    let input: CreateUser = parse!(params, User);

    let privileged_creation = input.user_type != UserType::Regular
        || input.bypass_filter
        || input.bypass_email_verification
        || input.override_user_id.is_some();
    if privileged_creation {
        MutationAuthorization::require_platform_staff(ctx, "privileged user creation")?;
    } else {
        check_registration_rate_limit(ctx, &input.ip_address.to_string()).await?;
    }

    UserService::create(ctx, input)
        .await
        .or_raise(|| Error::new("failed to create user", ErrorType::User))
}

async fn check_registration_rate_limit(
    ctx: &ServiceContext<'_>,
    ip_address: &str,
) -> Result<()> {
    let make_error =
        || Error::new("failed to check registration rate limit", ErrorType::User);
    let ip_allowed = AuthenticationAttemptService::reserve(
        ctx,
        &AuthenticationAttemptService::register_ip_bucket(ip_address),
        REGISTER_IP_MAX_ATTEMPTS,
        REGISTER_IP_WINDOW_SECONDS,
    )
    .await
    .or_raise(make_error)?;
    if !ip_allowed {
        ctx.commit_expected_authentication_rejection();
        bail!(Error::new(
            "too many account registrations, try again later",
            ErrorType::RateLimited,
        ));
    }

    let global_allowed = AuthenticationAttemptService::reserve(
        ctx,
        &AuthenticationAttemptService::register_global_bucket(),
        REGISTER_GLOBAL_MAX_ATTEMPTS,
        REGISTER_GLOBAL_WINDOW_SECONDS,
    )
    .await
    .or_raise(make_error)?;
    if !global_allowed {
        ctx.commit_expected_authentication_rejection();
        bail!(Error::new(
            "too many account registrations, try again later",
            ErrorType::RateLimited,
        ));
    }

    Ok(())
}

pub async fn user_import(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<CreateUserOutput> {
    let input: CreateUser = parse!(params, User);
    let Some(user_id) = input.override_user_id else {
        return Err(Error::new(
            "Wikidot user import requires override_user_id",
            ErrorType::BadRequest,
        )
        .into());
    };

    let wikidot_user_id = i32::try_from(user_id).map_err(|_| {
        Error::new(
            format!("Wikidot user ID {user_id} is outside the importable range"),
            ErrorType::BadRequest,
        )
    })?;

    MutationAuthorization::require_platform_staff(ctx, "Wikidot user import")?;

    let make_error = || {
        Error::new(
            format!("failed to import Wikidot user ID {user_id}"),
            ErrorType::User,
        )
    };

    match WikidotUser::find_by_id(wikidot_user_id)
        .one(ctx.transaction())
        .await
        .or_raise(make_error)?
    {
        Some(user) if !user.is_deleted => {
            info!("Importing Wikidot user ID {user_id} into a Wikijump account");
            UserService::import_wikidot(ctx, input)
                .await
                .or_raise(make_error)
        }
        Some(_) => Err(Error::new(
            format!("cannot import deleted Wikidot user ID {user_id}"),
            ErrorType::User,
        )
        .into()),
        None => Err(Error::new(
            format!("cannot import missing Wikidot user ID {user_id}"),
            ErrorType::User,
        )
        .into()),
    }
}

pub async fn user_activate_from_wikidot(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<UserModel> {
    info!("Activating a new user from a Wikidot user record");
    MutationAuthorization::require_platform_staff(ctx, "Wikidot user activation")?;
    let input: ActivateUserFromWikidot = parse!(params, User);
    UserService::activate_from_wikidot(ctx, input)
        .await
        .or_raise(|| {
            Error::new(
                "failed to create a Wikijump user by activating a Wikidot user record",
                ErrorType::User,
            )
        })
}

pub async fn user_get(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Option<GetUserOutput>> {
    let GetUser { user: reference } = parse!(params, User);

    let make_error = || Error::new("failed to get user", ErrorType::User);
    let user = UserService::get_optional(ctx, reference)
        .await
        .or_raise(make_error)?;

    let viewer_user_id = ctx.request().user_id;

    match user {
        None => Ok(None),

        Some(User::Wikijump(user)) => {
            let aliases = AliasService::get_all(ctx, AliasType::User, user.user_id)
                .await
                .or_raise(make_error)?;

            Ok(Some(GetUserOutput {
                user: UserOutput::new(User::Wikijump(user), viewer_user_id),
                aliases,
            }))
        }

        Some(user) => Ok(Some(GetUserOutput {
            user: UserOutput::new(user, viewer_user_id),
            aliases: vec![],
        })),
    }
}

pub async fn user_edit(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<WikijumpUserOutput> {
    let UpdateUser {
        user: reference,
        ip_address,
        body,
        current_password,
    } = parse!(params, User);

    let target = UserService::get_real(ctx, reference)
        .await
        .or_raise(|| Error::new("failed to authorize user update", ErrorType::User))?;
    let actor_user_id = MutationAuthorization::require_self_or_platform_staff(
        ctx,
        target.user_id,
        "update this user",
    )?;
    if actor_user_id != ADMIN_USER_ID
        && (body.email_verified.is_set() || body.bypass_filter || body.password.is_set())
    {
        return Err(Error::new(
            "only platform staff may set user verification, filter bypass or password fields",
            ErrorType::PermissionDenied,
        )
        .into());
    }

    let email_changing = match &body.email {
        Maybe::Set(new_email) => {
            !new_email.trim().eq_ignore_ascii_case(target.email.trim())
        }
        _ => false,
    };
    if email_changing && actor_user_id == target.user_id && actor_user_id != ADMIN_USER_ID
    {
        let proof = current_password
            .as_deref()
            .map(str::trim)
            .filter(|proof| !proof.is_empty())
            .ok_or_else(|| {
                Error::new(
                    "current password verification failed",
                    ErrorType::InvalidAuthentication,
                )
            })?;
        PasswordService::verify(ctx, proof, &target.password)
            .await
            .map_err(|_| {
                Error::new(
                    "current password verification failed",
                    ErrorType::InvalidAuthentication,
                )
            })?;
    }

    info!("Updating user ID {}", target.user_id);
    let updated =
        UserService::update(ctx, Reference::Id(target.user_id), ip_address, body)
            .await
            .or_raise(|| Error::new("failed to update user", ErrorType::User))?;

    Ok(WikijumpUserOutput::new(updated, ctx.request().user_id))
}

pub async fn user_delete(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<WikijumpUserOutput> {
    let DeleteUser {
        user: reference,
        ip_address,
    } = parse!(params, User);
    let target = UserService::get_real(ctx, reference)
        .await
        .or_raise(|| Error::new("failed to authorize user deletion", ErrorType::User))?;
    let deleting_user_id = MutationAuthorization::require_self_or_platform_staff(
        ctx,
        target.user_id,
        "delete this user",
    )?;

    info!("Deleting user ID {}", target.user_id);
    let deleted = UserService::delete(
        ctx,
        Reference::Id(target.user_id),
        deleting_user_id,
        ip_address,
    )
    .await
    .or_raise(|| Error::new("failed to delete user", ErrorType::User))?;

    SessionService::invalidate_all(ctx, target.user_id)
        .await
        .or_raise(|| {
            Error::new(
                "failed to revoke sessions for deleted user",
                ErrorType::Session,
            )
        })?;

    Ok(WikijumpUserOutput::new(deleted, ctx.request().user_id))
}

pub async fn user_add_name_change(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<i16> {
    let GetUser { user: reference } = parse!(params, User);
    let make_error = || Error::new("failed to add name change to user", ErrorType::User);

    MutationAuthorization::require_platform_staff(
        ctx,
        "granting a user name-change token",
    )?;

    info!("Adding user name change token to {reference:?}");

    let user = UserService::get_real(ctx, reference)
        .await
        .or_raise(make_error)?;

    UserService::add_name_change_token(ctx, &user)
        .await
        .or_raise(make_error)
}

#[derive(Deserialize, Debug)]
#[serde(deny_unknown_fields)]
struct ChangeUserPassword {
    current_password: String,
    new_password: String,
    ip_address: IpAddr,
}

#[derive(Serialize, Debug, Clone)]
pub struct ChangeUserPasswordOutput {
    pub other_sessions_revoked: u64,
}

pub async fn user_password_change(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<ChangeUserPasswordOutput> {
    let ChangeUserPassword {
        current_password,
        new_password,
        ip_address,
    } = parse!(params, User);
    let session = ctx
        .request()
        .user_session()
        .or_raise(|| {
            Error::new(
                "changing a password requires a signed-in session",
                ErrorType::PermissionDenied,
            )
        })?
        .clone();
    let user = UserService::get_real(ctx, Reference::Id(session.user_id))
        .await
        .or_raise(|| Error::new("failed to load the signed-in user", ErrorType::User))?;

    let authenticated = AuthenticationService::auth_password(
        ctx,
        AuthenticateUser {
            name_or_email: user.name.clone(),
            password: current_password,
        },
        ip_address,
    )
    .await?;
    if authenticated.user_id != user.user_id {
        bail!(Error::new(
            "the current password belongs to another account",
            ErrorType::InvalidAuthentication,
        ));
    }

    PasswordService::new_account_hash(&new_password)?;

    info!("Changing the password of user ID {}", user.user_id);
    UserService::update(
        ctx,
        Reference::Id(user.user_id),
        ip_address,
        UpdateUserBody {
            password: Maybe::Set(new_password),
            ..Default::default()
        },
    )
    .await
    .or_raise(|| Error::new("failed to change the password", ErrorType::User))?;

    let other_sessions_revoked =
        SessionService::invalidate_others(ctx, &session.session_token, user.user_id)
            .await
            .or_raise(|| {
                Error::new(
                    "failed to revoke the account's other sessions",
                    ErrorType::User,
                )
            })?;

    Ok(ChangeUserPasswordOutput {
        other_sessions_revoked,
    })
}
