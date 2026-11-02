/*
 * config/secrets.rs
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

use crate::middleware::RpcTokenDigest;
use dotenvy::dotenv;
use ref_map::*;
use s3::creds::Credentials;
use s3::region::Region;
use std::env::VarError;
use std::{env, process};

#[derive(Debug, Clone)]
pub struct Secrets {
    pub rpc_token_digest: RpcTokenDigest,

    pub database_url: String,

    pub redis_url: String,

    pub s3_files_bucket: String,

    pub s3_tblocks_bucket: String,

    pub s3_region: Region,

    pub s3_path_style: bool,

    pub s3_credentials: Credentials,

    pub mailcheck_api_key: Option<String>,
}

impl Secrets {
    pub fn load() -> Self {
        dotenv().ok();

        macro_rules! get_env {
            ($name:expr) => {
                match env::var($name) {
                    Ok(value) => value,
                    Err(error) => {
                        eprintln!(
                            "Unable to read environment variable {}: {}",
                            $name, error,
                        );
                        process::exit(1);
                    }
                }
            };
        }

        let database_url = get_env!("DATABASE_URL");
        let redis_url = get_env!("REDIS_URL");
        let rpc_token_digest =
            match RpcTokenDigest::parse(&get_env!("DEEPWELL_RPC_TOKEN")) {
                Ok(digest) => digest,
                Err(error) => {
                    eprintln!("{error}");
                    process::exit(1);
                }
            };

        let s3_files_bucket = get_env!("S3_FILES_BUCKET");
        let s3_tblocks_bucket = get_env!("S3_TEXT_BLOCKS_BUCKET");

        let s3_region = match env::var("S3_AWS_REGION") {
            Ok(value) => match value.parse() {
                Ok(region) => region,
                Err(error) => {
                    eprintln!(
                        "S3_AWS_REGION variable is not a valid AWS region ID: {error}"
                    );
                    process::exit(1);
                }
            },

            Err(_) => {
                let region = get_env!("S3_REGION_NAME");
                let endpoint = get_env!("S3_CUSTOM_ENDPOINT");

                Region::Custom { region, endpoint }
            }
        };

        let s3_path_style = match get_env!("S3_PATH_STYLE").parse() {
            Ok(path_style) => path_style,
            Err(_) => {
                eprintln!("S3_PATH_STYLE variable is not a valid boolean");
                process::exit(1);
            }
        };

        let s3_credentials = {
            let env_creds = Credentials::from_env_specific(
                Some("S3_ACCESS_KEY_ID"),
                Some("S3_SECRET_ACCESS_KEY"),
                None,
                None,
            );

            match env_creds {
                Ok(credentials) => credentials,
                Err(_) => {
                    let profile_name = env::var("AWS_PROFILE_NAME").ok();
                    let profile_name = profile_name.ref_map(|s| s.as_str());

                    match Credentials::from_profile(profile_name) {
                        Ok(credentials) => credentials,
                        Err(error) => {
                            eprintln!("Unable to read AWS credentials file: {error}");
                            process::exit(1);
                        }
                    }
                }
            }
        };

        let mailcheck_api_key = match env::var("MAILCHECK_API_KEY") {
            Ok(value) if value.is_empty() => None,
            Ok(value) => Some(value),
            Err(VarError::NotPresent) => None,
            Err(error) => {
                eprintln!(
                    "Unable to read environment variable MAILCHECK_API_KEY: {error}"
                );
                process::exit(1);
            }
        };

        Secrets {
            rpc_token_digest,
            database_url,
            redis_url,
            s3_files_bucket,
            s3_tblocks_bucket,
            s3_region,
            s3_path_style,
            s3_credentials,
            mailcheck_api_key,
        }
    }
}
