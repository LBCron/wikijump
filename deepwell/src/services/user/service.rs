/*
 * services/user/service.rs
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

use super::locale::validate_locales;
use super::structs::{
    ActivateUserFromWikidot, CreateUser, CreateUserOutput, UpdateUserBody, User,
};
use crate::config::Config;
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::known_user::{self, Entity as KnownUser, Model as KnownUserModel};
use crate::models::user::{self, Entity as WikijumpUser, Model as WikijumpUserModel};
use crate::models::wikidot_user::{
    self, Entity as WikidotUser, Model as WikidotUserModel,
};
use crate::services::ServiceContext;
use crate::services::alias::CreateAlias;
use crate::services::audit::{AuditEvent, AuditService, ObjectScope};
use crate::services::blob::{BlobService, FinalizeBlobUploadOutput};
use crate::services::email::{
    EmailClassification, EmailService, EmailTokenService, EmailValidationOutput,
};
use crate::services::filter::{FilterClass, FilterType};
use crate::services::{AliasService, FilterService, PasswordService};
use crate::types::{AliasType, UserType};
use crate::types::{Maybe, Reference};
use crate::utils::now;
use crate::utils::regex_replace_in_place;
use paste::paste;
use redis::AsyncCommands;
use sea_orm::sea_query::Expr;
use sea_orm::{
    ActiveModelTrait, ActiveValue, ColumnTrait, Condition, DbErr, EntityTrait, NotSet,
    QueryFilter, Set, SqlErr,
};
use serde_json::Value as JsonValue;
use std::borrow::Cow;
use std::cmp;
use std::collections::{BTreeMap, BTreeSet};
use std::net::IpAddr;

pub const DISABLED_PASSWORD_HASH: &str = "!";

const VERIFIED_EMAIL_UNIQUE_INDEX: &str = "user_verified_email_active_unique_idx";
#[derive(Debug)]
pub struct UserService;

impl UserService {
    pub async fn get_public_identities(
        ctx: &ServiceContext<'_>,
        user_ids: &BTreeSet<i64>,
    ) -> Result<BTreeMap<i64, ftml::data::UserInfo<'static>>> {
        if user_ids.is_empty() {
            return Ok(BTreeMap::new());
        }

        let txn = ctx.transaction();
        let make_error =
            || Error::new("failed to get public user identities", ErrorType::User);
        let wikijump_users = WikijumpUser::find()
            .filter(user::Column::UserId.is_in(user_ids.iter().copied()))
            .all(txn)
            .await
            .or_raise(make_error)?;
        let wikijump_user_ids = wikijump_users
            .iter()
            .map(|user| user.user_id)
            .collect::<BTreeSet<_>>();
        let mut identities = wikijump_users
            .into_iter()
            .filter_map(|user| User::Wikijump(user).into_public_identity())
            .map(|identity| (identity.user_id, identity))
            .collect::<BTreeMap<_, _>>();

        let wikidot_ids = user_ids
            .iter()
            .filter(|user_id| !wikijump_user_ids.contains(user_id))
            .filter_map(|user_id| i32::try_from(*user_id).ok())
            .collect::<BTreeSet<_>>();
        if wikidot_ids.is_empty() {
            return Ok(identities);
        }
        let wikidot_users = WikidotUser::find()
            .filter(wikidot_user::Column::UserId.is_in(wikidot_ids))
            .all(txn)
            .await
            .or_raise(make_error)?;
        identities.extend(
            wikidot_users
                .into_iter()
                .filter_map(|user| User::Wikidot(user).into_public_identity())
                .map(|identity| (identity.user_id, identity)),
        );
        Ok(identities)
    }

    pub async fn get_public_identities_or_tombstones(
        ctx: &ServiceContext<'_>,
        user_ids: &BTreeSet<i64>,
    ) -> Result<BTreeMap<i64, Option<ftml::data::UserInfo<'static>>>> {
        let identities = Self::get_public_identities(ctx, user_ids).await?;
        let missing_ids = user_ids
            .iter()
            .copied()
            .filter(|user_id| !identities.contains_key(user_id))
            .collect::<BTreeSet<_>>();
        if missing_ids.is_empty() {
            return Ok(identities
                .into_iter()
                .map(|(user_id, identity)| (user_id, Some(identity)))
                .collect());
        }

        let txn = ctx.transaction();
        let make_error =
            || Error::new("failed to get deleted user identities", ErrorType::User);
        let mut deleted = BTreeSet::new();
        let wikijump_users = WikijumpUser::find()
            .filter(user::Column::UserId.is_in(missing_ids.iter().copied()))
            .filter(user::Column::DeletedAt.is_not_null())
            .all(txn)
            .await
            .or_raise(make_error)?;
        deleted.extend(wikijump_users.iter().map(|user| user.user_id));

        let wikidot_ids = missing_ids
            .iter()
            .filter_map(|user_id| i32::try_from(*user_id).ok())
            .collect::<Vec<_>>();
        if !wikidot_ids.is_empty() {
            let wikidot_users = WikidotUser::find()
                .filter(wikidot_user::Column::UserId.is_in(wikidot_ids))
                .filter(wikidot_user::Column::IsDeleted.eq(true))
                .all(txn)
                .await
                .or_raise(make_error)?;
            deleted.extend(wikidot_users.iter().map(|user| i64::from(user.user_id)));
        }

        let mut resolved = identities
            .into_iter()
            .map(|(user_id, identity)| (user_id, Some(identity)))
            .collect::<BTreeMap<_, _>>();
        for user_id in missing_ids {
            if deleted.contains(&user_id) {
                resolved.insert(user_id, None);
            }
        }
        Ok(resolved)
    }

    pub async fn create(
        ctx: &ServiceContext<'_>,
        input: CreateUser,
    ) -> Result<CreateUserOutput> {
        Self::create_internal(ctx, input, false).await
    }

    pub async fn import_wikidot(
        ctx: &ServiceContext<'_>,
        input: CreateUser,
    ) -> Result<CreateUserOutput> {
        Self::create_internal(ctx, input, true).await
    }

    async fn create_internal(
        ctx: &ServiceContext<'_>,
        CreateUser {
            user_type,
            mut name,
            email,
            locales,
            password,
            bypass_filter,
            bypass_email_verification,
            override_user_id,
            ip_address,
        }: CreateUser,
        reuse_existing_known_user: bool,
    ) -> Result<CreateUserOutput> {
        let txn = ctx.transaction();
        let slug = get_user_slug(&name, user_type);

        debug!("Normalizing user data (name '{name}', slug '{slug}')");
        let leading_trailing_regex = regex!(r"(^[\-\s]+)|([\-\s+]$)");
        regex_replace_in_place(&mut name, leading_trailing_regex, "");

        let make_error = || {
            Error::new(
                format!("failed to create user '{}' with email '{}'", slug, email),
                ErrorType::User,
            )
        };

        let user_id = match override_user_id {
            Some(0) => {
                error!(
                    "Caller attempted to create a user with ID 0, which is reserved (never a valid user ID)",
                );
                bail!(Error::new(
                    "cannot create user with ID 0, value is reserved",
                    ErrorType::BadRequest,
                ));
            }
            Some(user_id) => {
                info!("Attempting to create user '{name}' ('{slug}', ID {user_id})");

                let known_user_exists = KnownUser::find_by_id(user_id)
                    .one(txn)
                    .await
                    .or_raise(make_error)?
                    .is_some();

                if known_user_exists {
                    if reuse_existing_known_user {
                        debug!("Reusing existing known_user entry for ID {user_id}");
                    } else {
                        bail!(Error::new(
                            format!(
                                "cannot create user with ID {user_id}, known_user entry already exists",
                            ),
                            ErrorType::BadRequest,
                        ));
                    }
                } else {
                    known_user::ActiveModel {
                        user_id: ActiveValue::Set(user_id),
                    }
                    .insert(txn)
                    .await
                    .or_raise(make_error)?;

                    debug!("Inserted foreign key entry into known_user for ID {user_id}");
                }
                user_id
            }
            None => {
                info!("Attempting to create user '{name}' ('{slug}') with sequence ID");
                Self::get_next_user_id(ctx).await.or_raise(make_error)?
            }
        };

        check_user_name(ctx.config(), &slug, &name)?;

        if should_check_filter(bypass_filter, user_type, None) {
            let object = ObjectScope::User(user_id);
            let (result1, result2) = join!(
                Self::run_name_filter(ctx, &name, &slug, object, ip_address),
                Self::run_email_filter(ctx, &email, object, ip_address),
            );
            raise_multiple!(result1, result2; make_error);
        }

        validate_locales(user_type, &locales).or_raise(make_error)?;

        match override_user_id {
            Some(user_id) => {
                let wikidot_user_id = i32::try_from(user_id).map_err(|_| {
                    Error::new(
                        format!(
                            "cannot create user with ID {user_id}, which does not fit in a Wikidot user ID"
                        ),
                        ErrorType::BadRequest,
                    )
                })?;
                let result = WikidotUser::find()
                    .filter(
                        Condition::all()
                            .add(wikidot_user::Column::UserId.eq(wikidot_user_id))
                            .add(wikidot_user::Column::IsDeleted.eq(false)),
                    )
                    .one(txn)
                    .await
                    .or_raise(make_error)?;

                if let Some(found_user) = result
                    && let Some(found_user_slug) = found_user.slug
                    && found_user_slug != slug
                    && !reuse_existing_known_user
                {
                    error!(
                        "Wikidot user exists with user ID {}, but has an incompatible user slug: {} != {}",
                        user_id, found_user_slug, slug,
                    );
                    bail!(Error::new(
                        format!(
                            "cannot create user, a wikidot user with the same ID exists and has a different slug. ID is {}, Wikidot had slug '{}', request had slug '{}'",
                            user_id, found_user_slug, slug,
                        ),
                        ErrorType::UserExists,
                    ));
                }
            }

            None => {
                let result = WikidotUser::find()
                    .filter(
                        Condition::all()
                            .add(
                                Condition::any()
                                    .add(wikidot_user::Column::Name.eq(name.as_str()))
                                    .add(wikidot_user::Column::Slug.eq(slug.as_str())),
                            )
                            .add(wikidot_user::Column::IsDeleted.eq(false)),
                    )
                    .one(txn)
                    .await
                    .or_raise(make_error)?;

                if let Some(found_user) = result {
                    error!(
                        "Wikidot user with conflicting name or slug already exists, cannot create"
                    );
                    error!("Checked name '{name}', slug '{slug}', found {found_user:#?}");
                    bail!(Error::new(
                        format!(
                            "cannot create user, a wikidot user with a conflicting name or slug exists. checked name '{}', slug '{}', found user '{}' (ID {})",
                            name,
                            slug,
                            found_user
                                .slug
                                .expect("No wikidot slug on non-deleted user"),
                            found_user.user_id,
                        ),
                        ErrorType::UserExists,
                    ));
                }
            }
        }

        let result = WikijumpUser::find()
            .filter(
                Condition::all()
                    .add(
                        Condition::any()
                            .add(user::Column::Name.eq(name.as_str()))
                            .add(user::Column::Slug.eq(slug.as_str())),
                    )
                    .add(user::Column::DeletedAt.is_null()),
            )
            .one(txn)
            .await
            .or_raise(make_error)?;

        if let Some(found_user) = result {
            error!("User with conflicting name or slug already exists, cannot create");
            error!(
                "Checked name '{name}', slug '{slug}', found existing user ID {} with slug '{}'",
                found_user.user_id, found_user.slug,
            );
            bail!(Error::new(
                format!(
                    "cannot create user, another with a conflicting name or slug already exists. checked name '{}', slug '{}', found user '{}' (ID {})",
                    name, slug, found_user.slug, found_user.user_id,
                ),
                ErrorType::UserExists,
            ));
        }

        if matches!(user_type, UserType::Regular | UserType::Bot) && email.is_empty() {
            error!("Attempting to create user with empty email");
            bail!(Error::new(
                "cannot create user, no email was specified",
                ErrorType::UserEmailEmpty
            ));
        }

        if user_type == UserType::Regular {
            let result = WikijumpUser::find()
                .filter(
                    Condition::all()
                        .add(user::Column::Email.eq(email.as_str()))
                        .add(user::Column::UserType.eq(UserType::Regular))
                        .add(user::Column::EmailVerifiedAt.is_not_null())
                        .add(user::Column::DeletedAt.is_null()),
                )
                .one(txn)
                .await
                .or_raise(make_error)?;

            if let Some(found_user) = result {
                error!("User with conflicting email already exists, cannot create");
                error!(
                    "Email conflict detected, found existing user ID {} with slug '{}'",
                    found_user.user_id, found_user.slug,
                );
                bail!(Error::new(
                    "cannot create user, another with a conflicting email already exists",
                    ErrorType::UserExists,
                ));
            }
        }

        let alias_exists = AliasService::exists(ctx, AliasType::User, &slug)
            .await
            .or_raise(make_error)?;

        if alias_exists {
            error!("User alias with conflicting slug already exists, cannot create");
            error!("Checked slug '{slug}'");
            bail!(Error::new(
                "cannot create user, another with a conflicting user slug alias already exists",
                ErrorType::UserExists,
            ));
        }

        let password = match user_type {
            UserType::Regular => {
                info!("Creating regular user '{slug}' with password");
                if password.is_empty() {
                    str!(DISABLED_PASSWORD_HASH)
                } else {
                    PasswordService::new_account_hash(&password).or_raise(make_error)?
                }
            }
            UserType::System | UserType::Site => {
                info!("Creating site or system user '{slug}'");

                if !password.is_empty() {
                    warn!("Password was specified for site or system user");
                    bail!(Error::new(
                        "password should not be specified for site or system users",
                        ErrorType::BadRequest,
                    ));
                }

                str!(DISABLED_PASSWORD_HASH)
            }
            UserType::Bot => {
                info!("Creating bot user '{slug}'");
                if password.is_empty() {
                    str!(DISABLED_PASSWORD_HASH)
                } else {
                    PasswordService::new_hash(&password).or_raise(make_error)?
                }
            }
        };

        let (email_validation_json, email_validation_at) =
            if !bypass_email_verification && !email.is_empty() {
                match EmailService::validate_when_available(ctx, &email)
                    .await
                    .or_raise(make_error)?
                {
                    Some(email_validation_output) => {
                        let email_validation_json =
                            check_email_validation(&slug, &email_validation_output)
                                .or_raise(make_error)?;

                        (Some(email_validation_json), Some(now()))
                    }
                    None => (None, None),
                }
            } else {
                (None, None)
            };

        let user = user::ActiveModel {
            user_id: Set(user_id),
            user_type: Set(user_type),
            name: Set(name),
            slug: Set(slug.clone()),
            name_changes_left: Set(ctx.config().default_name_changes),
            email: Set(email.clone()),
            email_verified_at: Set(None),
            email_validation_info: Set(email_validation_json),
            email_validation_at: Set(email_validation_at),
            password: Set(password),
            multi_factor_secret: Set(None),
            multi_factor_recovery_codes: Set(None),
            locales: Set(locales),
            avatar_s3_hash: Set(None),
            real_name: Set(None),
            gender: Set(None),
            birthday: Set(None),
            biography: Set(None),
            website: Set(None),
            user_page: Set(None),
            created_at: Set(now()),
            updated_at: Set(None),
            deleted_at: Set(None),
            ..Default::default()
        };

        let user_id = WikijumpUser::insert(user)
            .exec(txn)
            .await
            .or_raise(make_error)?
            .last_insert_id;

        AuditService::log(ctx, ip_address, AuditEvent::UserCreate { user_id })
            .await
            .or_raise(make_error)?;

        Ok(CreateUserOutput { user_id, slug })
    }

    pub async fn activate_from_wikidot(
        ctx: &ServiceContext<'_>,
        ActivateUserFromWikidot {
            user_id,
            user_type,
            email,
            locales,
            password,
            bypass_filter,
            bypass_email_verification,
            ip_address,
        }: ActivateUserFromWikidot,
    ) -> Result<WikijumpUserModel> {
        if !matches!(user_type, UserType::Regular | UserType::Bot) {
            bail!(Error::new(
                format!("illegal type for wikidot user import: {}", user_type),
                ErrorType::DatabaseImport,
            ));
        }

        let make_error = || {
            Error::new(
                format!("failed to import user ID {} from wikidot", user_id),
                ErrorType::DatabaseImport,
            )
        };

        let existing_user = Self::get(ctx, Reference::Id(user_id))
            .await
            .or_raise(make_error)?;

        let WikidotUserModel {
            user_id: _,
            created_at,
            fetched_at,
            is_deleted,
            name,
            slug,
            avatar_s3_hash,
            real_name,
            gender,
            birthday,
            location,
            biography,
            website,
            karma,
            is_pro,
        } = match existing_user {
            User::Wikidot(user) => user,
            User::Wikijump(user) => {
                bail!(Error::new(
                    format!(
                        "cannot import wikidot user ID {}, wikijump user '{}' (slug '{}') already exists",
                        user_id, user.name, user.slug,
                    ),
                    ErrorType::DatabaseImport
                ));
            }
        };

        let (name, slug) = match (name, slug) {
            (Some(name), Some(slug)) => (name, slug),
            _ => {
                bail!(Error::new(
                    format!("cannot import wikidot user ID {}, is deleted", user_id),
                    ErrorType::DatabaseImport,
                ));
            }
        };

        assert!(
            !is_deleted,
            "Wikidot user ID {} is marked as deleted after name check",
            user_id,
        );
        info!(
            "Fetched wikidot user '{}' (ID {}, slug '{}'), created at {}, fetched at {}, karma level {}, {} account",
            name,
            user_id,
            slug,
            created_at,
            fetched_at,
            karma,
            if is_pro { "pro" } else { "free" },
        );

        AuditService::log(ctx, ip_address, AuditEvent::UserActivateWikidot { user_id })
            .await
            .or_raise(make_error)?;

        Self::import_wikidot(
            ctx,
            CreateUser {
                user_type,
                name,
                email,
                locales,
                password,
                bypass_filter,
                bypass_email_verification,
                override_user_id: Some(user_id),
                ip_address,
            },
        )
        .await
        .or_raise(make_error)?;

        Self::update(
            ctx,
            Reference::Id(user_id),
            ip_address,
            UpdateUserBody {
                name: Maybe::Unset,
                email: Maybe::Unset,
                email_verified: Maybe::Unset,
                password: Maybe::Unset,
                locales: Maybe::Unset,

                avatar_uploaded_blob_id: Maybe::Unset,
                forum_signature: Maybe::Unset,

                real_name: Maybe::Set(real_name),
                gender: Maybe::Set(gender),
                birthday: Maybe::Set(birthday),
                location: Maybe::Set(location),
                biography: Maybe::Set(biography),
                website: Maybe::Set(website),

                user_page: Maybe::Unset,

                bypass_filter,
            },
        )
        .await
        .or_raise(make_error)?;

        let model = user::ActiveModel {
            user_id: Set(user_id),
            created_at: Set(created_at),
            avatar_s3_hash: Set(avatar_s3_hash),
            ..Default::default()
        };

        let txn = ctx.transaction();
        let new_user = model.update(txn).await.or_raise(make_error)?;
        Self::invalidate_avatar_cache(ctx, user_id)
            .await
            .or_raise(make_error)?;
        Ok(new_user)
    }

    /// Drops WWS's cached avatar hash for a user (`user_avatar:<id>`, see
    /// `wws/src/cache.rs`), so a changed or removed avatar stops being served
    /// (#2556). WWS also expires the entry, which bounds a re-cache that races
    /// this request's commit.
    pub async fn invalidate_avatar_cache(
        ctx: &ServiceContext<'_>,
        user_id: i64,
    ) -> Result<()> {
        let mut redis = ctx.redis();
        let _: usize =
            redis
                .del(format!("user_avatar:{user_id}"))
                .await
                .or_raise(|| {
                    Error::new(
                        format!("failed to invalidate cached avatar for user {user_id}"),
                        ErrorType::RedisQuery,
                    )
                })?;
        Ok(())
    }

    #[inline]
    pub async fn exists(
        ctx: &ServiceContext<'_>,
        reference: Reference<'_>,
    ) -> Result<bool> {
        Self::get_optional(ctx, reference)
            .await
            .map(|user| user.is_some())
    }

    pub async fn get_optional(
        ctx: &ServiceContext<'_>,
        reference: Reference<'_>,
    ) -> Result<Option<User>> {
        let txn = ctx.transaction();
        let make_error = || Error::new("failed to get user", ErrorType::User);
        let reference = Self::resolve_user_reference(ctx, reference).await?;
        let wikijump_user = Self::get_real_optional_resolved(ctx, &reference).await?;

        if let Some(user) = wikijump_user {
            if matches!(user.user_type, UserType::Regular | UserType::Bot) {
                debug!("Found Wikijump user '{}' (ID {})", user.slug, user.user_id);
                return Ok(Some(User::Wikijump(user)));
            }

            if let Reference::Slug(slug) = &reference {
                let wikidot_user = WikidotUser::find()
                    .filter(
                        Condition::all()
                            .add(wikidot_user::Column::Slug.eq(slug.as_ref()))
                            .add(wikidot_user::Column::IsDeleted.eq(false)),
                    )
                    .one(txn)
                    .await
                    .or_raise(make_error)?;
                if wikidot_user.is_some() {
                    return Ok(wikidot_user.map(User::Wikidot));
                }
            }

            debug!("Found Wikijump user '{}' (ID {})", user.slug, user.user_id);
            return Ok(Some(User::Wikijump(user)));
        }

        fn i64_to_i32(value: i64) -> Option<i32> {
            value.try_into().ok()
        }

        let wikidot_user = match &reference {
            Reference::Id(id) => match i64_to_i32(*id) {
                None => None,

                Some(id) => WikidotUser::find_by_id(id)
                    .filter(wikidot_user::Column::IsDeleted.eq(false))
                    .one(txn)
                    .await
                    .or_raise(make_error)?,
            },

            Reference::Slug(slug) => WikidotUser::find()
                .filter(
                    Condition::all()
                        .add(wikidot_user::Column::Slug.eq(slug.as_ref()))
                        .add(wikidot_user::Column::IsDeleted.eq(false)),
                )
                .one(txn)
                .await
                .or_raise(make_error)?,
        };

        Ok(wikidot_user.map(User::Wikidot))
    }

    async fn resolve_user_reference<'a>(
        ctx: &ServiceContext<'_>,
        reference: Reference<'a>,
    ) -> Result<Reference<'a>> {
        let Reference::Slug(slug) = reference else {
            return Ok(reference);
        };
        let make_error = || Error::new("failed to get user", ErrorType::User);
        match AliasService::get_optional(ctx, AliasType::User, &slug)
            .await
            .or_raise(make_error)?
        {
            Some(alias) => Ok(Reference::Id(alias.target_id)),
            None => Ok(Reference::Slug(slug)),
        }
    }

    async fn get_real_optional_resolved(
        ctx: &ServiceContext<'_>,
        reference: &Reference<'_>,
    ) -> Result<Option<WikijumpUserModel>> {
        let txn = ctx.transaction();
        let make_error = || Error::new("failed to get user", ErrorType::User);
        match reference {
            Reference::Id(id) => WikijumpUser::find_by_id(*id)
                .one(txn)
                .await
                .or_raise(make_error),
            Reference::Slug(slug) => WikijumpUser::find()
                .filter(
                    Condition::all()
                        .add(user::Column::Slug.eq(slug.as_ref()))
                        .add(user::Column::DeletedAt.is_null()),
                )
                .one(txn)
                .await
                .or_raise(make_error),
        }
    }

    #[inline]
    pub async fn get(ctx: &ServiceContext<'_>, reference: Reference<'_>) -> Result<User> {
        find_or_error!(Self::get_optional(ctx, reference), "user", User)
    }

    #[inline]
    pub async fn get_real_optional(
        ctx: &ServiceContext<'_>,
        reference: Reference<'_>,
    ) -> Result<Option<WikijumpUserModel>> {
        let reference = Self::resolve_user_reference(ctx, reference).await?;
        Self::get_real_optional_resolved(ctx, &reference).await
    }

    pub async fn get_real_optional_by_email(
        ctx: &ServiceContext<'_>,
        email: &str,
    ) -> Result<Option<WikijumpUserModel>> {
        WikijumpUser::find()
            .filter(
                Condition::all()
                    .add(user::Column::Email.eq(email))
                    .add(user::Column::UserType.eq(UserType::Regular))
                    .add(user::Column::DeletedAt.is_null()),
            )
            .one(ctx.transaction())
            .await
            .or_raise(|| Error::new("failed to look up user by email", ErrorType::User))
    }

    #[inline]
    pub async fn get_real(
        ctx: &ServiceContext<'_>,
        reference: Reference<'_>,
    ) -> Result<WikijumpUserModel> {
        find_or_error!(Self::get_real_optional(ctx, reference), "user", User)
    }

    pub async fn update(
        ctx: &ServiceContext<'_>,
        reference: Reference<'_>,
        ip_address: IpAddr,
        input: UpdateUserBody,
    ) -> Result<WikijumpUserModel> {
        use crate::services::audit::UserFields;

        let txn = ctx.transaction();
        let user = Self::get_real(ctx, reference)
            .await
            .or_raise(|| Error::new("failed to update user", ErrorType::User))?;

        let make_error = || {
            Error::new(
                format!(
                    "failed to update user '{}' (ID {})",
                    user.slug, user.user_id,
                ),
                ErrorType::User,
            )
        };

        if let Maybe::Set(Some(signature)) = &input.forum_signature {
            validate_forum_signature(signature)?;
        }

        {
            let mut previous_fields = UserFields::default();
            let mut changed_fields = UserFields::default();

            macro_rules! add_changed_field {
                ($field:ident) => {{
                    if let Maybe::Set(value) = &input.$field {
                        previous_fields.$field = Maybe::Set(&user.$field);
                        changed_fields.$field = Maybe::Set(value);
                    }
                }};
                (move $field:ident) => {{
                    if let Maybe::Set(value) = input.$field {
                        previous_fields.$field = Maybe::Set(user.$field);
                        changed_fields.$field = Maybe::Set(value);
                    }
                }};
                (ref $field:ident) => {{
                    if let Maybe::Set(value) = &input.$field {
                        previous_fields.$field = Maybe::Set(user.$field.as_deref());
                        changed_fields.$field = Maybe::Set(value.as_deref());
                    }
                }};
            }

            add_changed_field!(email);
            add_changed_field!(locales);
            add_changed_field!(ref real_name);
            add_changed_field!(ref gender);
            add_changed_field!(move birthday);
            add_changed_field!(ref location);
            add_changed_field!(ref biography);
            add_changed_field!(ref website);
            add_changed_field!(ref user_page);

            if let Maybe::Set(name) = &input.name {
                previous_fields.name = Maybe::Set(&user.name);
                changed_fields.name = Maybe::Set(name);

                let new_slug = get_user_slug(name, user.user_type);
                if user.slug != new_slug {
                    previous_fields.slug = Maybe::Set(Cow::Borrowed(&user.slug));
                    changed_fields.slug = Maybe::Set(Cow::Owned(new_slug));
                }
            }

            if let Maybe::Set(password) = &input.password {
                previous_fields.password =
                    Maybe::Set(user.password != DISABLED_PASSWORD_HASH);
                changed_fields.password = Maybe::Set(!password.is_empty());
            }

            if let Maybe::Set(blob_id) = &input.avatar_uploaded_blob_id {
                previous_fields.avatar = Maybe::Set(blob_id.is_some());
                changed_fields.avatar = Maybe::Set(blob_id.is_some());
            }
            if let Maybe::Set(signature) = &input.forum_signature {
                previous_fields.forum_signature = Maybe::Set(
                    user.forum_signature
                        .as_deref()
                        .is_some_and(|value| !value.is_empty()),
                );
                changed_fields.forum_signature = Maybe::Set(
                    signature.as_deref().is_some_and(|value| !value.is_empty()),
                );
            }

            AuditService::log(
                ctx,
                ip_address,
                AuditEvent::UserUpdate {
                    user_id: user.user_id,
                    previous_fields,
                    changed_fields,
                },
            )
            .await
            .or_raise(make_error)?;
        }

        let should_check_filter =
            should_check_filter(input.bypass_filter, user.user_type, Some(user.user_id));

        let mut model = user::ActiveModel {
            user_id: Set(user.user_id),
            ..Default::default()
        };

        if let Maybe::Set(name) = input.name {
            Self::update_name(
                ctx,
                name,
                &user,
                &mut model,
                should_check_filter,
                ip_address,
            )
            .await
            .or_raise(make_error)?;
        }

        let updated_email = match &input.email {
            Maybe::Set(email) => email.clone(),
            _ => user.email.clone(),
        };
        let email_changed = updated_email != user.email;

        if let Maybe::Set(email) = input.email {
            if should_check_filter {
                Self::run_email_filter(
                    ctx,
                    &email,
                    ObjectScope::User(user.user_id),
                    ip_address,
                )
                .await
                .or_raise(make_error)?;
            }

            let email_validation_json =
                match EmailService::validate_when_available(ctx, &email)
                    .await
                    .or_raise(make_error)?
                {
                    Some(email_validation_output) => Some(
                        check_email_validation(&user.slug, &email_validation_output)
                            .or_raise(make_error)?,
                    ),
                    None => None,
                };

            model.email = Set(email);
            model.email_validation_at =
                Set(email_validation_json.as_ref().map(|_| now()));
            model.email_validation_info = Set(email_validation_json);

            if email_changed {
                model.email_verified_at = Set(None);
            }

            if email_changed {
                EmailTokenService::revoke_all_for_user(ctx, user.user_id)
                    .await
                    .or_raise(make_error)?;
            }
        }

        if let Maybe::Set(email_verified) = input.email_verified {
            if email_verified && email_changed {
                bail!(Error::new(
                    "cannot change and verify an email in the same update",
                    ErrorType::BadRequest,
                ));
            }

            if email_verified
                && matches!(user.user_type, UserType::Regular | UserType::Bot)
                && updated_email.is_empty()
            {
                bail!(Error::new(
                    "cannot verify email, the user has no email address set",
                    ErrorType::UserEmailEmpty,
                ));
            }

            if email_verified
                && user.user_type == UserType::Regular
                && Self::verified_email_owner_exists(
                    ctx,
                    &updated_email,
                    Some(user.user_id),
                )
                .await
                .or_raise(make_error)?
            {
                bail!(Error::new(
                    "cannot verify email, another active user already owns it",
                    ErrorType::UserExists,
                ));
            }

            if email_verified && user.user_type == UserType::Regular {
                Self::displace_pending_email_claims(ctx, &updated_email, user.user_id)
                    .await
                    .or_raise(make_error)?;
            }

            let timestamp = if email_verified { Some(now()) } else { None };
            model.email_verified_at = Set(timestamp);
        }

        if let Maybe::Set(password) = input.password {
            let password_hash = match user.user_type {
                UserType::Regular if password.is_empty() => str!(DISABLED_PASSWORD_HASH),
                UserType::Regular => PasswordService::new_account_hash(&password)?,
                _ => PasswordService::new_hash(&password)?,
            };
            model.password = Set(password_hash);
        }

        if let Maybe::Set(locales) = input.locales {
            validate_locales(user.user_type, &locales)?;
            model.locales = Set(locales);
        }

        if let Maybe::Set(real_name) = input.real_name {
            model.real_name = Set(real_name);
        }

        if let Maybe::Set(gender) = input.gender {
            model.gender = Set(gender);
        }

        if let Maybe::Set(birthday) = input.birthday {
            model.birthday = Set(birthday);
        }

        if let Maybe::Set(location) = input.location {
            model.location = Set(location);
        }

        if let Maybe::Set(biography) = input.biography {
            model.biography = Set(biography);
        }

        if let Maybe::Set(website) = input.website {
            model.website = Set(website);
        }

        if let Maybe::Set(user_page) = input.user_page {
            model.user_page = Set(user_page);
        }

        let avatar_changed = matches!(input.avatar_uploaded_blob_id, Maybe::Set(_));
        if let Maybe::Set(uploaded_blob_id) = input.avatar_uploaded_blob_id {
            let s3_hash = match uploaded_blob_id {
                None => None,
                Some(uploaded_blob_id) => {
                    let FinalizeBlobUploadOutput { s3_hash, .. } =
                        BlobService::finish_avatar_upload(
                            ctx,
                            user.user_id,
                            &uploaded_blob_id,
                        )
                        .await
                        .or_raise(make_error)?;

                    Some(s3_hash.to_vec())
                }
            };

            model.avatar_s3_hash = Set(s3_hash);
        }

        if let Maybe::Set(signature) = input.forum_signature {
            model.forum_signature = Set(signature.filter(|value| !value.is_empty()));
        }

        model.updated_at = Set(Some(now()));
        let new_user = match model.update(txn).await {
            Ok(user) => user,
            Err(error) if is_verified_email_unique_violation(&error) => {
                bail!(Error::new(
                    "cannot verify email, another active user already owns it",
                    ErrorType::UserExists,
                ));
            }
            Err(error) => return Err(error).or_raise(make_error),
        };
        if avatar_changed {
            Self::invalidate_avatar_cache(ctx, new_user.user_id)
                .await
                .or_raise(make_error)?;
        }

        if user.slug != new_user.slug {
            let (result1, result2) = join!(
                AliasService::verify(ctx, AliasType::User, &user.slug),
                AliasService::verify(ctx, AliasType::User, &new_user.slug),
            );
            raise_multiple!(result1, result2; make_error);
        }

        Ok(new_user)
    }

    async fn verified_email_owner_exists(
        ctx: &ServiceContext<'_>,
        email: &str,
        exclude_user_id: Option<i64>,
    ) -> Result<bool> {
        let mut condition = Condition::all()
            .add(user::Column::Email.eq(email))
            .add(user::Column::UserType.eq(UserType::Regular))
            .add(user::Column::EmailVerifiedAt.is_not_null())
            .add(user::Column::DeletedAt.is_null());

        if let Some(user_id) = exclude_user_id {
            condition = condition.add(user::Column::UserId.ne(user_id));
        }

        WikijumpUser::find()
            .filter(condition)
            .one(ctx.transaction())
            .await
            .map(|user| user.is_some())
            .or_raise(|| {
                Error::new("failed to check verified email ownership", ErrorType::User)
            })
    }

    async fn displace_pending_email_claims(
        ctx: &ServiceContext<'_>,
        email: &str,
        keeper_user_id: i64,
    ) -> Result<()> {
        let txn = ctx.transaction();
        let displaced = WikijumpUser::find()
            .filter(
                Condition::all()
                    .add(user::Column::Email.eq(email))
                    .add(user::Column::UserType.eq(UserType::Regular))
                    .add(user::Column::DeletedAt.is_null())
                    .add(user::Column::UserId.ne(keeper_user_id)),
            )
            .all(txn)
            .await
            .or_raise(|| {
                Error::new("failed to list pending email claims", ErrorType::User)
            })?;

        for other in displaced {
            let model = user::ActiveModel {
                user_id: Set(other.user_id),
                email: Set(String::new()),
                email_verified_at: Set(None),
                email_validation_at: Set(None),
                email_validation_info: Set(None),
                updated_at: Set(Some(now())),
                ..Default::default()
            };
            model.update(txn).await.or_raise(|| {
                Error::new("failed to displace pending email claim", ErrorType::User)
            })?;
        }

        Ok(())
    }

    async fn update_name(
        ctx: &ServiceContext<'_>,
        new_name: String,
        user: &WikijumpUserModel,
        model: &mut user::ActiveModel,
        should_check_filter: bool,
        ip_address: IpAddr,
    ) -> Result<()> {
        let new_slug = get_user_slug(&new_name, user.user_type);
        let old_slug = &user.slug;

        let make_error = || {
            Error::new(
                format!("failed to update name '{}' -> '{}'", old_slug, new_slug),
                ErrorType::User,
            )
        };

        if should_check_filter {
            Self::run_name_filter(
                ctx,
                &new_name,
                &new_slug,
                ObjectScope::User(user.user_id),
                ip_address,
            )
            .await
            .or_raise(make_error)?;
        }

        if new_slug == user.slug {
            debug!("User slug is the same, rename is free");

            model.name = Set(new_name);
            return Ok(());
        }

        if let Some(alias) = AliasService::get_optional(ctx, AliasType::User, &new_slug)
            .await
            .or_raise(make_error)?
        {
            debug!("User slug is a past alias, rename is free");

            AliasService::swap(ctx, alias.alias_id, old_slug)
                .await
                .or_raise(make_error)?;

            model.name = Set(new_name);
            model.slug = Set(new_slug);

            return Ok(());
        }

        check_user_name(ctx.config(), &new_slug, &new_name)?;

        if user.name_changes_left == 0 {
            error!("User ID {} has no remaining name changes", user.user_id);
            bail!(Error::new(
                format!(
                    "failed to rename user, user '{}' (ID {}) has no remaining name changes",
                    user.slug, user.user_id,
                ),
                ErrorType::InsufficientNameChanges,
            ));
        }

        debug!(
            "Creating user alias for '{old_slug}' -> '{new_slug}', deducting name change"
        );

        model.name_changes_left = Set(user.name_changes_left - 1);
        model.name = Set(new_name.clone());
        model.slug = Set(new_slug.clone());

        AliasService::create_for_pending_target_rename(
            ctx,
            CreateAlias {
                slug: str!(old_slug),
                alias_type: AliasType::User,
                target_id: user.user_id,
                created_by: user.user_id,
                bypass_filter: !should_check_filter,
                ip_address,
            },
        )
        .await
        .or_raise(make_error)?;

        Ok(())
    }

    pub async fn refresh_name_change_tokens(ctx: &ServiceContext<'_>) -> Result<()> {
        info!("Refreshing name change tokens for all users who need one");

        let needs_token_time = match ctx.config().refill_name_change {
            Some(refill_name_change) => now() - refill_name_change,
            None => return Ok(()),
        };

        let make_error = || {
            Error::new(
                "failed to refresh name tokens for all users",
                ErrorType::User,
            )
        };

        let txn = ctx.transaction();
        let users = WikijumpUser::find()
            .filter(user::Column::LastNameChangeAddedAt.gte(needs_token_time))
            .all(txn)
            .await
            .or_raise(make_error)?;

        debug!(
            "Found {} users in need of a name refresh token",
            users.len(),
        );

        for user in users {
            Self::add_name_change_token(ctx, &user)
                .await
                .or_raise(make_error)?;
        }

        Ok(())
    }

    pub async fn add_name_change_token(
        ctx: &ServiceContext<'_>,
        user: &WikijumpUserModel,
    ) -> Result<i16> {
        let txn = ctx.transaction();
        let max_name_changes = ctx.config().maximum_name_changes;
        let name_changes = cmp::min(user.name_changes_left + 1, max_name_changes);
        let model = user::ActiveModel {
            user_id: Set(user.user_id),
            name_changes_left: Set(name_changes),
            updated_at: Set(Some(now())),
            ..Default::default()
        };

        info!(
            "Adding name change token to user ID {} (was {}, now {}, max {})",
            user.user_id, user.name_changes_left, name_changes, max_name_changes,
        );

        model.update(txn).await.or_raise(|| {
            Error::new(
                format!(
                    "failed to add name change token to user '{}' (ID {}), now {} tokens",
                    user.slug, user.user_id, name_changes,
                ),
                ErrorType::User,
            )
        })?;
        Ok(name_changes)
    }

    pub async fn set_mfa_secrets(
        ctx: &ServiceContext<'_>,
        user_id: i64,
        multi_factor_secret: ActiveValue<Option<String>>,
        multi_factor_recovery_codes: ActiveValue<Option<Vec<String>>>,
    ) -> Result<()> {
        info!("Setting MFA secret fields for user ID {user_id}");

        let txn = ctx.transaction();
        let model = user::ActiveModel {
            user_id: Set(user_id),
            multi_factor_secret,
            multi_factor_recovery_codes,
            updated_at: Set(Some(now())),
            ..Default::default()
        };
        model.update(txn).await.or_raise(|| {
            Error::new(
                format!("failed to set MFA secrets for user ID {}", user_id),
                ErrorType::UserMfa,
            )
        })?;

        Ok(())
    }

    pub async fn remove_recovery_code(
        ctx: &ServiceContext<'_>,
        user: &WikijumpUserModel,
        recovery_code: &str,
    ) -> Result<()> {
        let txn = ctx.transaction();
        info!("Removing recovery code from user ID {}", user.user_id);

        if let Some(current_codes) = &user.multi_factor_recovery_codes {
            let updated_codes = current_codes
                .iter()
                .filter(|code| code.as_str() != recovery_code)
                .map(String::from)
                .collect::<Vec<_>>();

            let model = user::ActiveModel {
                user_id: Set(user.user_id),
                multi_factor_recovery_codes: Set(Some(updated_codes)),
                updated_at: Set(Some(now())),
                ..Default::default()
            };
            model.update(txn).await.or_raise(|| {
                Error::new("failed to remove a user recovery code", ErrorType::UserMfa)
            })?;
        }

        Ok(())
    }

    pub async fn delete(
        ctx: &ServiceContext<'_>,
        reference: Reference<'_>,
        deleting_user_id: i64,
        ip_address: IpAddr,
    ) -> Result<WikijumpUserModel> {
        let txn = ctx.transaction();

        let user = Self::get_real(ctx, reference)
            .await
            .or_raise(|| Error::new("failed to delete user", ErrorType::User))?;

        info!("Deleting user with ID {}", user.user_id);

        let make_error = || {
            Error::new(
                format!(
                    "failed to delete user '{}' (ID {})",
                    user.slug, user.user_id,
                ),
                ErrorType::User,
            )
        };

        AliasService::remove_all(ctx, AliasType::User, user.user_id)
            .await
            .or_raise(make_error)?;

        let deletion = WikijumpUser::update_many()
            .col_expr(user::Column::DeletedAt, Expr::value(Some(now())))
            .filter(
                Condition::all()
                    .add(user::Column::UserId.eq(user.user_id))
                    .add(user::Column::DeletedAt.is_null()),
            )
            .exec(txn)
            .await
            .or_raise(make_error)?;

        match deletion.rows_affected {
            0 => {}
            1 => {
                AuditService::log(
                    ctx,
                    ip_address,
                    AuditEvent::UserDelete {
                        user_id: user.user_id,
                        deleting_user_id,
                    },
                )
                .await
                .or_raise(make_error)?;
            }
            rows_affected => {
                return Err(Error::new(
                    format!(
                        "user deletion updated {rows_affected} rows for user ID {}",
                        user.user_id,
                    ),
                    ErrorType::User,
                )
                .into());
            }
        }

        Self::get_real(ctx, Reference::Id(user.user_id))
            .await
            .or_raise(make_error)
    }

    async fn run_name_filter(
        ctx: &ServiceContext<'_>,
        name: &str,
        slug: &str,
        object: ObjectScope,
        ip_address: IpAddr,
    ) -> Result<()> {
        info!("Checking user name data against filters...");

        let make_error = || Error::new("user failed name filter", ErrorType::User);

        let filter_matcher =
            FilterService::get_matcher(ctx, FilterClass::Platform, FilterType::User)
                .await
                .or_raise(make_error)?;

        let (result1, result2) = join!(
            filter_matcher.verify(ctx, "name", name, object, ip_address),
            filter_matcher.verify(ctx, "slug", slug, object, ip_address),
        );
        raise_multiple!(result1, result2; make_error);

        Ok(())
    }

    async fn run_email_filter(
        ctx: &ServiceContext<'_>,
        email: &str,
        object: ObjectScope,
        ip_address: IpAddr,
    ) -> Result<()> {
        info!("Checking user email data against filters...");

        let make_error = || Error::new("user failed email filter", ErrorType::User);

        let filter_matcher =
            FilterService::get_matcher(ctx, FilterClass::Platform, FilterType::Email)
                .await
                .or_raise(make_error)?;

        filter_matcher
            .verify(ctx, "email", email, object, ip_address)
            .await
            .or_raise(make_error)?;

        Ok(())
    }
    pub(crate) async fn insert_known_user_id(
        ctx: &ServiceContext<'_>,
        user_id: i64,
    ) -> Result<()> {
        let txn = ctx.transaction();
        let model = known_user::ActiveModel {
            user_id: Set(user_id),
        };

        KnownUser::insert(model)
            .on_conflict_do_nothing()
            .exec(txn)
            .await
            .or_raise(|| {
                Error::new(
                    format!("failed to insert user ID {user_id} into known_user"),
                    ErrorType::User,
                )
            })?;

        Ok(())
    }

    async fn get_next_user_id(ctx: &ServiceContext<'_>) -> Result<i64> {
        let txn = ctx.transaction();
        let KnownUserModel { user_id } = known_user::ActiveModel { user_id: NotSet }
            .insert(txn)
            .await
            .or_raise(|| {
                Error::new(
                    "failed to insert into known_user and get next ID in sequence",
                    ErrorType::User,
                )
            })?;

        debug!("Got next user ID {user_id} in sequence from known_user");
        Ok(user_id)
    }
}

fn validate_forum_signature(signature: &str) -> Result<()> {
    if signature.chars().count() > 400 {
        bail!(Error::new(
            "forum signature cannot exceed 400 characters",
            ErrorType::BadRequest,
        ));
    }
    if signature.split('\n').count() > 4 {
        bail!(Error::new(
            "forum signature cannot exceed 4 lines",
            ErrorType::BadRequest,
        ));
    }
    Ok(())
}

fn is_verified_email_unique_violation(error: &DbErr) -> bool {
    matches!(
        error.sql_err(),
        Some(SqlErr::UniqueConstraintViolation(message))
            if message.contains(VERIFIED_EMAIL_UNIQUE_INDEX)
    )
}

fn get_user_slug(name: &str, user_type: UserType) -> String {
    use crate::utils::{normalize_page_slug, normalize_slug_without_category_separator};

    if user_type == UserType::Site {
        debug_assert!(
            name.starts_with("site:"),
            "Site user slug does not start with 'site:'",
        );

        normalize_page_slug(name)
    } else {
        normalize_slug_without_category_separator(name)
    }
}

fn check_user_name(config: &Config, slug: &str, name: &str) -> Result<()> {
    if slug.is_empty() {
        error!("Cannot create user with empty slug");
        bail!(Error::new(
            "cannot create user with empty slug",
            ErrorType::UserSlugEmpty
        ));
    }

    if name.len() < config.minimum_name_bytes {
        error!(
            "User's name is not long enough ({} < {} bytes)",
            slug.len(),
            config.minimum_name_bytes,
        );
        bail!(Error::new(
            format!(
                "cannot create user, name is not long enough ({} < {} bytes)",
                slug.len(),
                config.minimum_name_bytes,
            ),
            ErrorType::UserNameTooShort,
        ));
    }

    let char_count = name.chars().count();
    if char_count < config.minimum_name_chars {
        error!(
            "User's name is not long enough ({} < {} chars)",
            char_count, config.minimum_name_chars,
        );
        bail!(Error::new(
            format!(
                "cannot create user, name is not long enough ({} < {} chars)",
                char_count, config.minimum_name_chars,
            ),
            ErrorType::UserNameTooShort,
        ));
    }

    Ok(())
}

fn check_email_validation(
    user_slug: &str,
    validation_output: &EmailValidationOutput,
) -> Result<JsonValue> {
    let make_error = || {
        Error::new(
            format!(
                "failed to validate email for user '{}':\n{:#?}",
                user_slug, validation_output,
            ),
            ErrorType::EmailVerification,
        )
    };

    match validation_output.classification {
        EmailClassification::Normal => {
            info!("User {user_slug}'s email was validated successfully");
        }

        EmailClassification::Alias => {
            info!("User {user_slug}'s email was validated successfully (is an alias)");
        }

        EmailClassification::Role => {
            info!(
                "User {user_slug}'s email was verified successfully (is a role account)"
            );
        }

        EmailClassification::Disposable => {
            error!(
                "User {user_slug}'s email is disposable and did not pass verification",
            );
            bail!(Error::new(
                "cannot create user, disposable emails are not permitted",
                ErrorType::DisallowedEmail,
            ));
        }

        EmailClassification::Spam => {
            error!("User {user_slug}'s email is spam and did not pass verification",);
            bail!(Error::new(
                "cannot create user, email address flagged as spam",
                ErrorType::DisallowedEmail,
            ));
        }

        EmailClassification::Invalid => {
            error!("User {user_slug}'s email is invalid and did not pass verification");
            bail!(Error::new(
                "cannot create user, email appears to be invalid",
                ErrorType::InvalidEmail,
            ));
        }
    }

    let validation_json = serde_json::to_value(validation_output).or_raise(make_error)?;
    Ok(validation_json)
}

fn should_check_filter(
    bypass_filter: bool,
    user_type: UserType,
    user_id: Option<i64>,
) -> bool {
    use crate::constants::{
        ADMIN_USER_ID, ANONYMOUS_USER_ID, SAMPLE_USER_ID, SYSTEM_USER_ID,
    };

    if bypass_filter {
        return false;
    }

    if let Some(user_id) = user_id
        && matches!(
            user_id,
            ADMIN_USER_ID | SYSTEM_USER_ID | ANONYMOUS_USER_ID | SAMPLE_USER_ID,
        )
    {
        return false;
    }

    !matches!(user_type, UserType::Site | UserType::System)
}
