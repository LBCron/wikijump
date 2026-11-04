/*
 * error/wws.rs
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

use axum::response::Response;
use jsonrpsee::core::ClientError;
use s3::error::S3Error;
use std::io;
use thiserror::Error as ThisError;

pub type StdResult<T, E> = std::result::Result<T, E>;
pub type ResponseResult<T> = StdResult<T, Response>;
pub type Result<T> = StdResult<T, Error>;

pub(crate) const DEEPWELL_PERMISSION_DENIED_CODE: i32 = 3106;

pub(crate) fn is_deepwell_permission_denied(error: &Error) -> bool {
    matches!(
        error,
        Error::Deepwell(ClientError::Call(rpc_error))
            if rpc_error.code() == DEEPWELL_PERMISSION_DENIED_CODE
    )
}

#[derive(ThisError, Debug)]
pub enum Error {
    #[error("DEEPWELL API error: {0}")]
    Deepwell(#[from] ClientError),

    #[error("DEEPWELL API error: too many requests in flight")]
    DeepwellBusy,

    #[error("blob missing from S3 for an existing file record: {s3_hash}")]
    MissingBlob { s3_hash: String },

    #[error("Redis error: {0}")]
    Redis(#[from] redis::RedisError),

    #[error("S3 service returned error: {0}")]
    S3(#[from] S3Error),

    #[error("I/O error: {0}")]
    Io(#[from] io::Error),
}
