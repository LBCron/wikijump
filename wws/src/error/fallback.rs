/*
 * handler/fallback_error.rs
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

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum FallbackError {
    BasicErrorCode,

    BasicErrorDirect,

    BasicErrorFetch,

    RedirectMain,

    TextBlockS3Fetch,
}

impl FallbackError {
    /// Gives a unique error code for this case.
    ///
    /// When adding new error, add to the bottom with a new number.
    /// We should generally avoid reusing prior error codes.
    pub fn error_code(self) -> u32 {
        match self {
            FallbackError::BasicErrorCode => 1000,
            FallbackError::BasicErrorFetch => 1001,
            FallbackError::BasicErrorDirect => 1002,
            FallbackError::RedirectMain => 1003,
            FallbackError::TextBlockS3Fetch => 1004,
        }
    }

    pub fn status_code(self) -> StatusCode {
        match self {
            FallbackError::BasicErrorCode => StatusCode::BAD_REQUEST,
            FallbackError::BasicErrorDirect => StatusCode::FORBIDDEN,
            FallbackError::BasicErrorFetch | FallbackError::RedirectMain => {
                StatusCode::GATEWAY_TIMEOUT
            }
            FallbackError::TextBlockS3Fetch => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for FallbackError {
    fn into_response(self) -> Response {
        let status_code = self.status_code();
        let message = format!("ERROR XF-{}", self.error_code());
        (status_code, message).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body;
    use axum::http::StatusCode;

    #[test]
    fn fallback_error_codes_are_stable() {
        assert_eq!(FallbackError::BasicErrorCode.error_code(), 1000);
        assert_eq!(FallbackError::BasicErrorFetch.error_code(), 1001);
        assert_eq!(FallbackError::BasicErrorDirect.error_code(), 1002);
        assert_eq!(FallbackError::RedirectMain.error_code(), 1003);
        assert_eq!(FallbackError::TextBlockS3Fetch.error_code(), 1004);
    }

    #[test]
    fn fallback_errors_map_to_expected_http_statuses() {
        assert_eq!(
            FallbackError::BasicErrorCode.status_code(),
            StatusCode::BAD_REQUEST,
        );
        assert_eq!(
            FallbackError::BasicErrorDirect.status_code(),
            StatusCode::FORBIDDEN,
        );
        assert_eq!(
            FallbackError::BasicErrorFetch.status_code(),
            StatusCode::GATEWAY_TIMEOUT,
        );
        assert_eq!(
            FallbackError::RedirectMain.status_code(),
            StatusCode::GATEWAY_TIMEOUT,
        );
        assert_eq!(
            FallbackError::TextBlockS3Fetch.status_code(),
            StatusCode::INTERNAL_SERVER_ERROR,
        );
    }

    #[tokio::test]
    async fn fallback_error_response_contains_xf_code() {
        let response = FallbackError::TextBlockS3Fetch.into_response();
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);

        let body = body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        assert_eq!(&body[..], b"ERROR XF-1004");
    }
}
