/*
 * services/password.rs
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

use crate::config::Config;
use crate::error::prelude::{Error, ErrorType, Result};
use crate::services::ServiceContext;
use argon2::{Argon2, PasswordHasher, PasswordVerifier};
use tokio::time;

#[derive(Debug)]
pub struct PasswordService;

pub const ACCOUNT_PASSWORD_MIN_CODE_POINTS: usize = 15;

impl PasswordService {
    pub fn new_account_hash(password: &str) -> Result<String> {
        let length = password.chars().count();
        if length < ACCOUNT_PASSWORD_MIN_CODE_POINTS {
            bail!(Error::new(
                "account password is too short",
                ErrorType::UserPasswordTooShort {
                    length,
                    minimum: ACCOUNT_PASSWORD_MIN_CODE_POINTS,
                },
            ));
        }

        Self::new_hash(password)
    }

    pub fn new_hash(password: &str) -> Result<String> {
        let argon2 = Argon2::default();
        let hash = argon2
            .hash_password(password.as_bytes())
            .map_err(convert_argon_error)?
            .to_string();

        Ok(hash)
    }

    pub async fn verify(
        ctx: &ServiceContext<'_>,
        password: &str,
        hash: &str,
    ) -> Result<()> {
        Self::verify_sleep(ctx, password, hash, true).await
    }

    pub async fn verify_sleep(
        ctx: &ServiceContext<'_>,
        password: &str,
        hash: &str,
        sleep: bool,
    ) -> Result<()> {
        info!("Attempting to verify password");
        let result = Self::verify_internal(password, hash);
        match result {
            Ok(()) => Ok(()),
            Err(error) => {
                match error.error_type {
                    ErrorType::InvalidAuthentication => {
                        warn!("Invalid password entered, verification failed\n{error}");
                    }

                    _ => {
                        error!("Unexpected error while verifying password:\n{error}");
                    }
                }

                if sleep {
                    Self::failure_sleep(ctx.config()).await;
                }

                bail!(Error::new(
                    "failed to verify password",
                    ErrorType::InvalidAuthentication,
                ))
            }
        }
    }

    fn verify_internal(password: &str, hash: &str) -> Result<()> {
        let argon2 = Argon2::default();
        argon2
            .verify_password(password.as_bytes(), hash)
            .map_err(convert_verify_error)?;

        Ok(())
    }

    pub async fn failure_sleep(config: &Config) {
        time::sleep(config.authentication_fail_delay).await;
    }
}

fn convert_argon_error(error: argon2::password_hash::Error) -> Error {
    Error::new(
        "failed to hash password",
        ErrorType::Cryptography(str!(error)),
    )
}

fn convert_verify_error(error: argon2::password_hash::Error) -> Error {
    match error {
        argon2::password_hash::Error::PasswordInvalid => Error::new(
            "password does not match the stored hash",
            ErrorType::InvalidAuthentication,
        ),
        _ => convert_argon_error(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    #[test]
    fn password_hashes_verify_original_password_and_reject_wrong_password() {
        let password = Uuid::new_v4().to_string();
        let wrong_password = Uuid::new_v4().to_string();
        let hash = PasswordService::new_hash(&password).unwrap();

        PasswordService::verify_internal(&password, &hash).unwrap();
        assert!(PasswordService::verify_internal(&wrong_password, &hash).is_err());
        assert!(PasswordService::verify_internal(&password, "not phc").is_err());
    }

    #[test]
    fn password_verification_distinguishes_mismatch_from_verifier_failure() {
        let password = Uuid::new_v4().to_string();
        let wrong_password = Uuid::new_v4().to_string();
        let hash = PasswordService::new_hash(&password).unwrap();

        let mismatch =
            PasswordService::verify_internal(&wrong_password, &hash).unwrap_err();
        assert!(
            matches!(mismatch.error_type, ErrorType::InvalidAuthentication),
            "wrong password must classify as InvalidAuthentication, got {:?}",
            mismatch.error_type,
        );

        let malformed =
            PasswordService::verify_internal(&password, "not phc").unwrap_err();
        assert!(
            matches!(malformed.error_type, ErrorType::Cryptography(_)),
            "malformed hash must classify as Cryptography, got {:?}",
            malformed.error_type,
        );
    }

    #[test]
    fn account_password_hash_requires_fifteen_unicode_code_points() {
        for (password, expected_length) in
            [("", 0), (" ", 1), ("a", 1), ("fourteen-chars", 14)]
        {
            let error = PasswordService::new_account_hash(password).unwrap_err();
            assert!(matches!(
                error.error_type,
                ErrorType::UserPasswordTooShort { length, minimum }
                    if length == expected_length && minimum == ACCOUNT_PASSWORD_MIN_CODE_POINTS,
            ));
        }

        let password = "ééééééééééééééé";
        let hash = PasswordService::new_account_hash(password).unwrap();
        PasswordService::verify_internal(password, &hash).unwrap();
    }

    #[test]
    fn generic_hash_still_supports_legacy_short_secrets() {
        let hash = PasswordService::new_hash("a").unwrap();
        PasswordService::verify_internal("a", &hash).unwrap();
    }
}
