/*
 * config/secrets.rs
 *
 * Wilson's Web Server - Serves a zoo of user-generated content
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

use s3::creds::Credentials;
use s3::region::Region;
use std::fmt;

#[derive(Clone)]
pub struct RpcToken(String);

impl RpcToken {
    pub fn parse(value: String) -> Result<Self, &'static str> {
        if value.len() != 64
            || !value
                .as_bytes()
                .iter()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
        {
            return Err(
                "DEEPWELL_RPC_TOKEN must be exactly 64 lowercase hexadecimal characters",
            );
        }
        Ok(Self(value))
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for RpcToken {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RpcToken([REDACTED])")
    }
}

#[derive(Debug, Clone)]
pub struct Secrets {
    pub deepwell_rpc_token: RpcToken,

    pub deepwell_url: String,

    pub redis_url: String,

    pub s3_files_bucket: String,

    pub s3_tblocks_bucket: String,

    pub s3_region: Region,

    pub s3_path_style: bool,

    pub s3_credentials: Credentials,
}
