/*
 * handler/avatar.rs
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

use crate::{
    content::is_active_content_type, error::BasicError, fetch::fetch_blob,
    state::ServerState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    http::header::{self, HeaderMap},
    response::{IntoResponse, Response},
};

pub async fn handle_user_avatar(
    State(state): State<ServerState>,
    Path(user_id): Path<String>,
    headers: HeaderMap,
) -> Response {
    info!(user_id = user_id, "Returning user avatar");

    let Ok(user_id) = user_id.parse::<i64>() else {
        error!("Unable to parse user id into i64: {user_id}");
        return StatusCode::NOT_FOUND.into_response();
    };

    let avatar_s3_hash = match state.get_avatar_or_response(&headers, user_id).await {
        Ok(output) => output,
        Err(response) => return response,
    };

    let (file_info, body) = match fetch_blob(&state, &avatar_s3_hash).await {
        Ok(output) => output,
        Err(error) => {
            error!(s3_hash = &avatar_s3_hash, "Cannot get blob data: {error}");
            return state
                .build_basic_error_response(
                    &headers,
                    BasicError::BlobFetch {
                        s3_hash: &avatar_s3_hash,
                    },
                )
                .await;
        }
    };

    let mut builder = Response::builder()
        .header(header::CONTENT_LENGTH, file_info.size)
        .header(header::CONTENT_TYPE, &file_info.mime)
        .header(header::ETAG, format!("\"{}\"", avatar_s3_hash))
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");

    if is_active_content_type(&file_info.mime) {
        builder = builder.header(header::CONTENT_DISPOSITION, "attachment");
    }

    let result = builder.body(body);

    match result {
        Ok(response) => response,
        Err(error) => {
            error!("Unable to convert response: {error}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}
