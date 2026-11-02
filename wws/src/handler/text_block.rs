/*
 * handler/text_block.rs
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

use super::{get_session_token, get_site_id};
use crate::deepwell::{TextBlockId, TextBlockIndex, TextBlockType};
use crate::error::{
    BasicError, FallbackError, TextBlockErrorReason, build_basic_error_response,
    is_deepwell_permission_denied,
};
use crate::state::ServerState;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::header::{self, HeaderMap};
use axum::http::status::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use sha1::{Digest, Sha1};

const MAX_TEXT_BLOCK_OBJECT_BYTES: usize = 16 * 1024 * 1024;

/// How many times a text block request may run the Deepwell lookup and the
/// S3 fetch before giving up.
///
/// The lookup and the fetch are separate steps, and a re-render landing
/// between them replaces the block: its row switches to a new S3 object and
/// the old object is deleted once the replacement commits. A fetch that
/// misses an object the lookup just returned is therefore retried against
/// a fresh lookup instead of surfacing as an error.
const MAX_TEXT_BLOCK_ATTEMPTS: u32 = 3;

const HTML_BLOCK_DOCUMENT_PREFIX: &[u8] = br#"<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html id="html-block-html" xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en"><head><meta http-equiv="Content-type" content="text/html; charset=utf-8"/><link rel="stylesheet" href="/common--theme/base/css/html-block.css"/></head><body>
"#;
const HTML_BLOCK_DOCUMENT_SUFFIX: &[u8] =
    br#"<script type="text/javascript" src="/common--javascript/html-block-iframe.js"></script></body></html>
"#;

pub async fn handle_html_block(
    State(state): State<ServerState>,
    Path((page_slug, index)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    info!(
        page_slug = page_slug,
        index = index,
        "Returning HTML block data",
    );

    // HTML blocks can't have named aliases
    handle_text_block(
        &state,
        &headers,
        TextBlockType::Html,
        &page_slug,
        BlockId::Index(index),
    )
    .await
}

pub async fn handle_html_terminal(
    State(state): State<ServerState>,
    Path((_page_slug, id, _domain)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    let site_id = get_site_id(&headers);
    let Some(sha1) = parse_wikidot_html_route_id(&id) else {
        return build_basic_error_response(
            &state,
            &headers,
            BasicError::TextBlock {
                site_id,
                index: &id,
                block_type: TextBlockType::Html,
                reason: TextBlockErrorReason::Invalid,
            },
        )
        .await;
    };
    // The lookup and the S3 fetch are separate steps; if the block is
    // replaced in between, the looked-up object is deleted and the fetch
    // misses. Look the block up again and serve the replacement instead
    // of returning an error.
    let mut attempt = 0;
    loop {
        attempt += 1;
        let block_info = match state
            .deepwell
            .get_text_block_by_hash(site_id, sha1, get_session_token(&headers))
            .await
        {
            Ok(Some(block_info)) => block_info,
            Ok(None) => {
                let mut response = build_basic_error_response(
                    &state,
                    &headers,
                    BasicError::TextBlock {
                        site_id,
                        index: &id,
                        block_type: TextBlockType::Html,
                        reason: TextBlockErrorReason::Missing,
                    },
                )
                .await;
                *response.status_mut() = StatusCode::OK;
                return response;
            }
            Err(error) => {
                error!("Unable to retrieve hashed HTML text block: {error}");
                return build_basic_error_response(
                    &state,
                    &headers,
                    BasicError::TextBlock {
                        site_id,
                        index: &id,
                        block_type: TextBlockType::Html,
                        reason: TextBlockErrorReason::Fetch,
                    },
                )
                .await;
            }
        };

        match serve_text_block(
            &state,
            &headers,
            TextBlockType::Html,
            None,
            block_info.index.get(),
            block_info.s3_filename,
            Some(sha1),
        )
        .await
        {
            TextBlockServeOutcome::Answered(response) => return response,
            TextBlockServeOutcome::ObjectMissing => {
                if attempt >= MAX_TEXT_BLOCK_ATTEMPTS {
                    return FallbackError::TextBlockS3Fetch.into_response();
                }
                warn!(
                    attempt,
                    "Hashed text block object vanished between lookup and fetch, re-looking up",
                );
            }
        }
    }
}

pub async fn handle_code_block(
    State(state): State<ServerState>,
    Path((page_slug, value)): Path<(String, String)>,
    headers: HeaderMap,
) -> Response {
    info!(
        page_slug = page_slug,
        index = value,
        "Returning code block data",
    );

    // Determine if it's an alias or a regular numeric index
    let index = if value.chars().all(|c| c.is_ascii_digit()) {
        BlockId::Index(value)
    } else {
        BlockId::Name(value)
    };

    handle_text_block(&state, &headers, TextBlockType::Code, &page_slug, index).await
}

async fn handle_text_block(
    state: &ServerState,
    headers: &HeaderMap,
    block_type: TextBlockType,
    page_slug: &str,
    block_id: BlockId,
) -> Response {
    let site_id = get_site_id(headers);
    let page_id =
        try_response!(state.get_page_fresh_or_response(headers, site_id, page_slug));
    let session_token = get_session_token(headers);

    let (lookup_id, display_index): (TextBlockId<'_>, &str) = match &block_id {
        BlockId::Index(value) => match value.parse() {
            Ok(index) => (TextBlockId::Index(index), value.as_str()),
            Err(_) => {
                error!(
                    index = value,
                    block_type = block_type.value(),
                    "Invalid text block index",
                );
                return build_basic_error_response(
                    state,
                    headers,
                    BasicError::TextBlock {
                        site_id,
                        index: value,
                        block_type,
                        reason: TextBlockErrorReason::Invalid,
                    },
                )
                .await;
            }
        },
        BlockId::Name(name) => (TextBlockId::Name(name.as_str()), name.as_str()),
    };

    // The Deepwell lookup and the S3 fetch are separate steps. If a
    // re-render replaces the block in between, the looked-up object is
    // deleted and the fetch misses; look the block up again and serve the
    // replacement instead of returning an error. A block the lookup does
    // not return at all is genuinely missing and is never retried.
    let mut attempt = 0;
    loop {
        attempt += 1;
        let (index, s3_filename) = match get_text_block_info(
            state,
            headers,
            TextBlockLookup {
                site_id,
                page_id,
                block_type,
                block_id: lookup_id,
                session_token,
                display_index,
            },
        )
        .await
        {
            Ok(Some(TextBlockIndex { index, s3_filename })) => (index, s3_filename),
            Ok(None) => {
                error!(
                    page_id = page_id,
                    block_type = block_type.value(),
                    index = display_index,
                    "No text block found with given index or name",
                );
                return build_basic_error_response(
                    state,
                    headers,
                    BasicError::TextBlock {
                        site_id,
                        index: display_index,
                        block_type,
                        reason: TextBlockErrorReason::Missing,
                    },
                )
                .await;
            }
            Err(response) => return response,
        };

        match serve_text_block(
            state,
            headers,
            block_type,
            Some(page_id),
            index.get(),
            s3_filename,
            None,
        )
        .await
        {
            TextBlockServeOutcome::Answered(response) => return response,
            TextBlockServeOutcome::ObjectMissing => {
                if attempt >= MAX_TEXT_BLOCK_ATTEMPTS {
                    return FallbackError::TextBlockS3Fetch.into_response();
                }
                warn!(
                    page_id = page_id,
                    block_type = block_type.value(),
                    index = display_index,
                    attempt,
                    "Text block object vanished between lookup and fetch, re-looking up",
                );
            }
        }
    }
}

/// The outcome of one attempt to serve a looked-up text block.
enum TextBlockServeOutcome {
    /// The request has been answered, successfully or with a terminal
    /// error; return the response as-is.
    Answered(Response),
    /// The S3 object named by the Deepwell lookup does not exist, because
    /// the block was replaced between the lookup and the fetch. The caller
    /// should look the block up again and serve the replacement.
    ObjectMissing,
}

async fn serve_text_block(
    state: &ServerState,
    headers: &HeaderMap,
    block_type: TextBlockType,
    page_id: Option<i64>,
    index: u16,
    s3_filename: String,
    expected_sha1: Option<&str>,
) -> TextBlockServeOutcome {
    info!(
        "Fetching {} text block from S3 object '{s3_filename}' (index {index})",
        block_type.value()
    );

    let (metadata, status_code) =
        match state.s3_tblocks_bucket.head_object(&s3_filename).await {
            Ok((metadata, status_code)) if status_code == StatusCode::OK.as_u16() => {
                (metadata, status_code)
            }
            Ok((_, status_code)) => {
                if status_code == StatusCode::NOT_FOUND.as_u16() {
                    // The object the lookup just named is already gone:
                    // the block was replaced between lookup and fetch.
                    info!(
                        page_id,
                        block_type = block_type.value(),
                        s3_filename,
                        "S3 text block object is missing",
                    );
                    return TextBlockServeOutcome::ObjectMissing;
                }
                error!(
                    page_id,
                    block_type = block_type.value(),
                    s3_filename,
                    status_code,
                    "S3 text block HEAD returned an unexpected status",
                );
                return TextBlockServeOutcome::Answered(
                    FallbackError::TextBlockS3Fetch.into_response(),
                );
            }
            Err(error) => {
                error!(
                    page_id,
                    block_type = block_type.value(),
                    s3_filename,
                    "Cannot HEAD text block data: {error}",
                );
                return TextBlockServeOutcome::Answered(
                    FallbackError::TextBlockS3Fetch.into_response(),
                );
            }
        };
    if metadata.content_length.is_some_and(|length| {
        length < 0
            || u64::try_from(length)
                .is_ok_and(|length| length > MAX_TEXT_BLOCK_OBJECT_BYTES as u64)
    }) {
        error!(
            page_id,
            block_type = block_type.value(),
            s3_filename,
            limit = MAX_TEXT_BLOCK_OBJECT_BYTES,
            "S3 text block exceeds the byte limit",
        );
        return TextBlockServeOutcome::Answered(
            FallbackError::TextBlockS3Fetch.into_response(),
        );
    }
    let content_type = match metadata.content_type {
        Some(content_type) => content_type,
        None => {
            error!(
                page_id,
                block_type = block_type.value(),
                s3_filename,
                "S3 text block has no content type"
            );
            return TextBlockServeOutcome::Answered(
                FallbackError::TextBlockS3Fetch.into_response(),
            );
        }
    };
    let etag = match metadata.e_tag {
        Some(etag) => etag,
        None => {
            error!(
                page_id,
                block_type = block_type.value(),
                s3_filename,
                "S3 text block has no ETag"
            );
            return TextBlockServeOutcome::Answered(
                FallbackError::TextBlockS3Fetch.into_response(),
            );
        }
    };

    let s3::request::request_trait::ResponseDataStream { mut bytes, .. } = match state
        .s3_tblocks_bucket
        .get_object_stream(&s3_filename)
        .await
    {
        Ok(response) if response.status_code == status_code => response,
        Ok(response) => {
            if response.status_code == StatusCode::NOT_FOUND.as_u16() {
                // Deleted between the HEAD above and this GET: the same
                // replacement race as a missing HEAD.
                info!(
                    page_id,
                    block_type = block_type.value(),
                    s3_filename,
                    "S3 text block object is missing",
                );
                return TextBlockServeOutcome::ObjectMissing;
            }
            error!(
                page_id,
                block_type = block_type.value(),
                s3_filename,
                status_code = response.status_code,
                "S3 text block returned an unexpected status",
            );
            return TextBlockServeOutcome::Answered(
                FallbackError::TextBlockS3Fetch.into_response(),
            );
        }
        Err(error) => {
            error!(
                page_id,
                block_type = block_type.value(),
                s3_filename,
                "Cannot get text block data: {error}",
            );
            return TextBlockServeOutcome::Answered(
                FallbackError::TextBlockS3Fetch.into_response(),
            );
        }
    };

    let mut raw_body = Vec::new();
    while let Some(chunk) = bytes.next().await {
        let chunk = match chunk {
            Ok(chunk) => chunk,
            Err(error) => {
                error!(
                    page_id,
                    block_type = block_type.value(),
                    s3_filename,
                    "Cannot read text block data from S3: {error}",
                );
                return TextBlockServeOutcome::Answered(
                    FallbackError::TextBlockS3Fetch.into_response(),
                );
            }
        };
        let Some(total) = raw_body.len().checked_add(chunk.len()) else {
            return TextBlockServeOutcome::Answered(
                FallbackError::TextBlockS3Fetch.into_response(),
            );
        };
        if total > MAX_TEXT_BLOCK_OBJECT_BYTES {
            error!(
                page_id,
                block_type = block_type.value(),
                s3_filename,
                limit = MAX_TEXT_BLOCK_OBJECT_BYTES,
                "S3 text block exceeds the byte limit",
            );
            return TextBlockServeOutcome::Answered(
                FallbackError::TextBlockS3Fetch.into_response(),
            );
        }
        raw_body.extend_from_slice(&chunk);
    }
    if let Some(expected_sha1) = expected_sha1 {
        let actual_sha1: String = Sha1::digest(&raw_body)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if actual_sha1 != expected_sha1 {
            error!(
                page_id,
                expected_sha1,
                actual_sha1,
                "S3 text block bytes do not match requested SHA-1",
            );
            return TextBlockServeOutcome::Answered(
                build_basic_error_response(
                    state,
                    headers,
                    BasicError::TextBlock {
                        site_id: get_site_id(headers),
                        index: expected_sha1,
                        block_type: TextBlockType::Html,
                        reason: TextBlockErrorReason::Missing,
                    },
                )
                .await,
            );
        }
    }
    if headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.trim() == etag)
    {
        return TextBlockServeOutcome::Answered(StatusCode::NOT_MODIFIED.into_response());
    }
    let body = Body::from(text_block_response_body(block_type, raw_body));
    // Every hosted text response carries `nosniff`: stylesheets, scripts,
    // HTML documents and plain text all have evidenced inline consumers
    // (theme `@import`, component `<script src>`, `[[iframe]]` gadgets), so
    // they keep the stored Content-Type exactly and stay inline.
    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, &content_type)
        .header(header::ETAG, &etag)
        .header(header::X_CONTENT_TYPE_OPTIONS, "nosniff");
    if text_block_serves_as_attachment(&content_type) {
        builder = builder.header(header::CONTENT_DISPOSITION, "attachment");
    }
    let result = builder.body(body);

    TextBlockServeOutcome::Answered(match result {
        Ok(response) => response,
        Err(error) => {
            error!("Unable to convert response: {error}");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    })
}

/// Whether a hosted text block must download instead of rendering inline.
///
/// Only XML-essence payloads take this path. The rule mirrors the file
/// lane's XML essence check without sharing it, so neither lane can change
/// the other's behavior by editing a common helper.
fn text_block_serves_as_attachment(content_type: &str) -> bool {
    let essence = content_type
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    essence == "application/xml" || essence.ends_with("+xml")
}

fn text_block_response_body(block_type: TextBlockType, bytes: Vec<u8>) -> Vec<u8> {
    match block_type {
        TextBlockType::Html => html_block_response_body(bytes),
        TextBlockType::Code => ensure_trailing_newline(bytes),
    }
}

fn html_block_response_body(bytes: Vec<u8>) -> Vec<u8> {
    let bytes = ensure_trailing_newline(bytes);
    let mut body = Vec::with_capacity(
        HTML_BLOCK_DOCUMENT_PREFIX.len() + bytes.len() + HTML_BLOCK_DOCUMENT_SUFFIX.len(),
    );
    body.extend_from_slice(HTML_BLOCK_DOCUMENT_PREFIX);
    body.extend_from_slice(&bytes);
    body.extend_from_slice(HTML_BLOCK_DOCUMENT_SUFFIX);
    body
}

fn ensure_trailing_newline(mut bytes: Vec<u8>) -> Vec<u8> {
    if !bytes.ends_with(b"\n") {
        bytes.push(b'\n');
    }
    bytes
}

fn parse_wikidot_html_route_id(value: &str) -> Option<&str> {
    let (sha1, nonce) = value.split_once('-')?;
    if sha1.len() != 40
        || nonce.is_empty()
        || !sha1
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
        || !nonce.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }

    Some(sha1)
}

async fn get_text_block_info(
    state: &ServerState,
    headers: &HeaderMap,
    lookup: TextBlockLookup<'_>,
) -> Result<Option<TextBlockIndex>, Response> {
    let TextBlockLookup {
        site_id,
        page_id,
        block_type,
        block_id,
        session_token,
        display_index,
    } = lookup;

    match state
        .deepwell
        .get_text_block_index(site_id, page_id, block_type, block_id, session_token)
        .await
    {
        Ok(block_info) => Ok(block_info),
        Err(error) => {
            let reason = if is_deepwell_permission_denied(&error) {
                TextBlockErrorReason::Missing
            } else {
                TextBlockErrorReason::Fetch
            };
            error!(
                page_id = page_id,
                block_type = block_type.value(),
                "Unable to retrieve S3 filename for text block from DEEPWELL: {error}",
            );
            Err(build_basic_error_response(
                state,
                headers,
                BasicError::TextBlock {
                    site_id,
                    index: display_index,
                    block_type,
                    reason,
                },
            )
            .await)
        }
    }
}

struct TextBlockLookup<'a> {
    site_id: i64,
    page_id: i64,
    block_type: TextBlockType,
    block_id: TextBlockId<'a>,
    session_token: Option<&'a str>,
    display_index: &'a str,
}

#[derive(Debug)]
enum BlockId {
    Index(String),
    Name(String),
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{RpcToken, Secrets};
    use crate::error::Error as WwsError;
    use crate::route::build_router;
    use crate::state::build_server_state;
    use axum::Router;
    use axum::body::Bytes;
    use axum::extract::State;
    use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
    use axum::routing::{get, post};
    use jsonrpsee::core::ClientError;
    use jsonrpsee_types::ErrorObjectOwned;
    use s3::creds::Credentials;
    use s3::region::Region;
    use serde_json::{Value, json};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;
    use tokio::task::JoinHandle;

    const SITE_ID: i64 = 10;

    #[derive(Debug)]
    struct Headers {
        content_type: String,
        etag: String,
    }

    // Since this thing isn't returning a case-insensitive map...
    fn get_headers(headers: HashMap<String, String>) -> Headers {
        let mut content_type = None;
        let mut etag = None;

        for (key, value) in headers.into_iter() {
            if key.eq_ignore_ascii_case("content-type") {
                content_type = Some(value);
            } else if key.eq_ignore_ascii_case("etag") {
                etag = Some(value);
            }
        }

        Headers {
            content_type: content_type.expect("No Content-Type header in S3 response"),
            etag: etag.expect("No ETag header in S3 response"),
        }
    }
    const PAGE_ID: i64 = 42;
    const HTML_BLOCK_BYTES: &[u8] = b"<p>moved content</p>";
    const HTML_BLOCK_SHA1: &str = "9079b854a8fdfa2328a297ff563fce21f866af0e";
    const HTML_BLOCK_S3_KEY: &str = "text-blocks/immutable-html-object";
    const CODE_BLOCK_S3_KEY: &str = "text-blocks/immutable-code-object";
    const CODE_XML_S3_KEY: &str = "text-blocks/immutable-code-xml";
    const CODE_CSS_S3_KEY: &str = "text-blocks/immutable-code-css";
    const CODE_JS_S3_KEY: &str = "text-blocks/immutable-code-js";
    const REPLACED_OLD_S3_KEY: &str = "text-blocks/replaced-old-object";
    const REPLACED_NEW_S3_KEY: &str = "text-blocks/replaced-new-object";
    const GONE_S3_KEY: &str = "text-blocks/gone-object";
    const REPLACED_INDEX: u64 = 9;
    const GONE_INDEX: u64 = 10;
    const MISMATCH_SHA1: &str = "1234567890abcdef1234567890abcdef12345678";
    const MISSING_SHA1: &str = "abcdef0123456789abcdef0123456789abcdef01";

    #[derive(Debug)]
    struct MutableTextBlockMock {
        pages: Mutex<HashMap<String, i64>>,
        block_lookups: Mutex<HashMap<u64, usize>>,
    }

    impl MutableTextBlockMock {
        fn move_page(&self) {
            let mut pages = self.pages.lock().unwrap();
            pages.remove("old-page");
            pages.insert("new-page".to_owned(), PAGE_ID);
        }

        /// Records one lookup for the given block index and returns how
        /// many lookups that index has now seen.
        fn count_block_lookup(&self, index: u64) -> usize {
            let mut lookups = self.block_lookups.lock().unwrap();
            let count = lookups.entry(index).or_insert(0);
            *count += 1;
            *count
        }

        fn block_lookup_count(&self, index: u64) -> usize {
            self.block_lookups
                .lock()
                .unwrap()
                .get(&index)
                .copied()
                .unwrap_or(0)
        }
    }

    #[derive(Debug)]
    struct TextBlockTestApp {
        base_url: String,
        client: reqwest::Client,
        mock: Arc<MutableTextBlockMock>,
        tasks: Vec<JoinHandle<()>>,
    }

    impl TextBlockTestApp {
        async fn spawn() -> Self {
            let mock = Arc::new(MutableTextBlockMock {
                pages: Mutex::new(HashMap::from([("old-page".to_owned(), PAGE_ID)])),
                block_lookups: Mutex::new(HashMap::new()),
            });
            let services = Router::new()
                .route("/", post(mock_rpc))
                .route("/{*path}", get(mock_text_block_s3).head(mock_text_block_s3))
                .with_state(Arc::clone(&mock));
            let services_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let services_address = services_listener.local_addr().unwrap();
            let services_task = tokio::spawn(async move {
                axum::serve(services_listener, services).await.unwrap();
            });
            let endpoint = format!("http://{services_address}");
            let state = build_server_state(
                false,
                Secrets {
                    deepwell_url: endpoint.clone(),
                    deepwell_rpc_token: RpcToken::parse("0".repeat(64)).unwrap(),
                    redis_url: str!("redis://127.0.0.1:1/"),
                    s3_files_bucket: str!("files"),
                    s3_tblocks_bucket: str!("text-blocks"),
                    s3_region: Region::Custom {
                        region: str!("test"),
                        endpoint,
                    },
                    s3_credentials: Credentials::new(
                        Some("access-key"),
                        Some("secret-key"),
                        None,
                        None,
                        None,
                    )
                    .unwrap(),
                    s3_path_style: true,
                },
            )
            .await
            .unwrap();
            let wws_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let wws_address = wws_listener.local_addr().unwrap();
            let wws_task = tokio::spawn(async move {
                axum::serve(wws_listener, build_router(state))
                    .await
                    .unwrap();
            });

            Self {
                base_url: format!("http://{wws_address}"),
                client: reqwest::Client::new(),
                mock,
                tasks: vec![wws_task, services_task],
            }
        }

        async fn get(&self, path: &str) -> reqwest::Response {
            self.request(Method::GET, path, &[]).await
        }

        async fn request(
            &self,
            method: Method,
            path: &str,
            headers: &[(HeaderName, &str)],
        ) -> reqwest::Response {
            let mut request = self
                .client
                .request(method, format!("{}{path}", self.base_url))
                .header(crate::handler::HEADER_SITE_ID.as_str(), SITE_ID.to_string());
            for (name, value) in headers {
                request = request.header(name, *value);
            }
            request.send().await.unwrap()
        }
    }

    impl Drop for TextBlockTestApp {
        fn drop(&mut self) {
            for task in &self.tasks {
                task.abort();
            }
        }
    }

    async fn mock_rpc(
        State(state): State<Arc<MutableTextBlockMock>>,
        body: Bytes,
    ) -> Response {
        let request: Value = serde_json::from_slice(&body).unwrap();
        let id = request["id"].clone();
        let result = match request["method"].as_str().unwrap() {
            "page_get" => {
                let page = request["params"]["page"].as_str().unwrap();
                state
                    .pages
                    .lock()
                    .unwrap()
                    .get(page)
                    .map(|page_id| json!({"page_id": page_id}))
            }
            "text_block_get_index" => {
                if request["params"]["sha1"].is_string() {
                    assert_eq!(request["params"]["site_id"], SITE_ID);
                    assert!(request["params"]["page_id"].is_null());
                    assert_eq!(request["params"]["block_type"], "html");
                    assert!(request["params"]["index"].is_null());
                    assert!(request["params"]["name"].is_null());
                    assert!(request["params"]["session_token"].is_null());
                    if !matches!(
                        request["params"]["sha1"].as_str().unwrap(),
                        HTML_BLOCK_SHA1 | MISMATCH_SHA1
                    ) {
                        return json!({
                            "jsonrpc": "2.0",
                            "result": null,
                            "id": id,
                        })
                        .to_string()
                        .into_response();
                    }
                }
                Some(json!({
                    "index": 1,
                    "s3_filename": match request["params"]["block_type"].as_str().unwrap() {
                        "html" => HTML_BLOCK_S3_KEY,
                        // Each code index stands in for one stored language:
                        // plain text, XML, CSS, JavaScript.
                        "code" => match request["params"]["index"].as_u64() {
                            Some(2) => CODE_XML_S3_KEY,
                            Some(3) => CODE_CSS_S3_KEY,
                            Some(4) => CODE_JS_S3_KEY,
                            // A block mid-replacement: the first lookup
                            // names the old object, later lookups name
                            // the replacement object.
                            Some(REPLACED_INDEX) => {
                                if state.count_block_lookup(REPLACED_INDEX) == 1 {
                                    REPLACED_OLD_S3_KEY
                                } else {
                                    REPLACED_NEW_S3_KEY
                                }
                            }
                            // A block whose object never comes back.
                            Some(GONE_INDEX) => {
                                state.count_block_lookup(GONE_INDEX);
                                GONE_S3_KEY
                            }
                            _ => CODE_BLOCK_S3_KEY,
                        },
                        block_type => panic!("unexpected text block type: {block_type}"),
                    },
                }))
            }
            "basic_error_missing_page_slug" => Some(json!({
                "title": "missing page",
                "body": "not found",
            })),
            "basic_error_text_block" => Some(json!({
                "title": "missing text block",
                "body": "not found",
            })),
            other => panic!("unexpected mock JSON-RPC method: {other}"),
        };
        json!({"jsonrpc": "2.0", "result": result, "id": id})
            .to_string()
            .into_response()
    }

    async fn mock_text_block_s3(Path(path): Path<String>) -> Response {
        // Objects deleted by a replacement (or never uploaded) are gone.
        if path.ends_with(REPLACED_OLD_S3_KEY) || path.ends_with(GONE_S3_KEY) {
            return Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .unwrap();
        }
        let (content_type, body): (&'static str, &'static [u8]) =
            if path.ends_with(HTML_BLOCK_S3_KEY) {
                ("text/html", HTML_BLOCK_BYTES)
            } else if path.ends_with(CODE_XML_S3_KEY) {
                ("application/xml", b"moved content")
            } else if path.ends_with(CODE_CSS_S3_KEY) {
                ("text/css", b"moved content")
            } else if path.ends_with(CODE_JS_S3_KEY) {
                ("text/javascript", b"moved content")
            } else if path.ends_with(REPLACED_NEW_S3_KEY) {
                ("text/plain", b"replacement content")
            } else {
                ("text/plain", b"moved content")
            };
        Response::builder()
            .status(StatusCode::OK)
            .header(header::CONTENT_TYPE, content_type)
            .header(header::ETAG, "\"text-block\"")
            .body(Body::from(body))
            .unwrap()
    }

    fn assert_html_cache_headers_omitted(headers: &HeaderMap) {
        for omitted in [
            header::LAST_MODIFIED,
            header::CACHE_CONTROL,
            header::ACCEPT_RANGES,
        ] {
            assert!(!headers.contains_key(omitted));
        }
    }

    #[test]
    fn s3_headers_are_read_case_insensitively() {
        let headers = HashMap::from([
            ("Content-Type".to_string(), "text/html".to_string()),
            ("etag".to_string(), "\"abc\"".to_string()),
        ]);

        let parsed = get_headers(headers);

        assert_eq!(parsed.content_type, "text/html");
        assert_eq!(parsed.etag, "\"abc\"");
    }

    #[tokio::test]
    async fn public_text_block_routes_follow_page_moves_after_the_old_slug_is_warm() {
        for route in ["code", "html"] {
            let app = TextBlockTestApp::spawn().await;
            let old_path = format!("/-/{route}/old-page/1");
            let new_path = format!("/-/{route}/new-page/1");

            let warm = app.get(&old_path).await;
            assert_eq!(warm.status(), StatusCode::OK, "warm {route} route");
            assert!(
                String::from_utf8_lossy(&warm.bytes().await.unwrap())
                    .contains("moved content")
            );

            app.mock.move_page();

            let stale = app.get(&old_path).await;
            assert_eq!(stale.status(), StatusCode::NOT_FOUND, "old {route} route");
            assert!(
                !String::from_utf8_lossy(&stale.bytes().await.unwrap())
                    .contains("moved content")
            );

            let moved = app.get(&new_path).await;
            assert_eq!(moved.status(), StatusCode::OK, "new {route} route");
            assert!(
                String::from_utf8_lossy(&moved.bytes().await.unwrap())
                    .contains("moved content")
            );
        }
    }

    #[tokio::test]
    async fn code_exact_if_none_match_returns_bare_not_modified() {
        let app = TextBlockTestApp::spawn().await;

        let response = app
            .request(
                Method::GET,
                "/-/code/old-page/1",
                &[(header::IF_NONE_MATCH, "\"text-block\"")],
            )
            .await;

        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert!(response.headers().get(header::ETAG).is_none());
        assert!(response.headers().get(header::CONTENT_TYPE).is_none());
        assert!(!response.headers().contains_key(header::CACHE_CONTROL));
        assert!(response.bytes().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn code_wrong_if_none_match_returns_full_response_without_cache_control() {
        let app = TextBlockTestApp::spawn().await;

        let response = app
            .request(
                Method::GET,
                "/-/code/old-page/1",
                &[(header::IF_NONE_MATCH, "\"wrong\"")],
            )
            .await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::ETAG).unwrap(),
            "\"text-block\""
        );
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/plain"
        );
        assert!(!response.headers().contains_key(header::CACHE_CONTROL));
        assert_eq!(response.bytes().await.unwrap(), &b"moved content\n"[..]);
    }

    #[tokio::test]
    async fn code_ignores_range_and_if_range() {
        let app = TextBlockTestApp::spawn().await;

        for headers in [
            vec![(header::RANGE, "bytes=0-4")],
            vec![
                (header::RANGE, "bytes=0-4"),
                (header::IF_RANGE, "\"text-block\""),
            ],
            vec![
                (header::RANGE, "bytes=0-4"),
                (header::IF_RANGE, "\"wrong\""),
            ],
        ] {
            let response = app
                .request(Method::GET, "/-/code/old-page/1", &headers)
                .await;

            assert_eq!(response.status(), StatusCode::OK);
            assert!(!response.headers().contains_key(header::CONTENT_RANGE));
            assert_eq!(response.bytes().await.unwrap(), &b"moved content\n"[..]);
        }
    }

    #[tokio::test]
    async fn code_head_returns_metadata_without_a_body() {
        let app = TextBlockTestApp::spawn().await;

        let response = app.request(Method::HEAD, "/-/code/old-page/1", &[]).await;

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers().get(header::ETAG).unwrap(),
            "\"text-block\""
        );
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/plain"
        );
        assert!(!response.headers().contains_key(header::CACHE_CONTROL));
        assert!(response.bytes().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn code_head_exact_if_none_match_returns_bare_not_modified() {
        let app = TextBlockTestApp::spawn().await;

        let response = app
            .request(
                Method::HEAD,
                "/-/code/old-page/1",
                &[(header::IF_NONE_MATCH, "\"text-block\"")],
            )
            .await;

        assert_eq!(response.status(), StatusCode::NOT_MODIFIED);
        assert!(response.headers().get(header::ETAG).is_none());
        assert!(response.headers().get(header::CONTENT_TYPE).is_none());
        assert!(!response.headers().contains_key(header::CACHE_CONTROL));
        assert!(response.bytes().await.unwrap().is_empty());
    }

    #[test]
    fn xml_essence_payloads_download_instead_of_rendering_inline() {
        for (content_type, expected) in [
            ("application/xml", true),
            ("application/xml; charset=utf-8", true),
            ("Application/Atom+XML", true),
            ("image/svg+xml", true),
            ("text/html", false),
            ("text/html; charset=utf-8", false),
            ("text/css", false),
            ("text/javascript", false),
            ("text/plain", false),
            ("text/x-python", false),
            ("application/json", false),
        ] {
            assert_eq!(
                text_block_serves_as_attachment(content_type),
                expected,
                "{content_type}",
            );
        }
    }

    #[tokio::test]
    async fn code_block_serving_policy_follows_stored_mime() {
        let app = TextBlockTestApp::spawn().await;

        // Index 1 is plain text, 2 is XML, 3 is CSS, 4 is JavaScript. Only
        // the XML essence downloads; the evidenced inline lanes keep the
        // stored Content-Type exactly, and every response carries nosniff.
        for (index, content_type, downloads) in [
            ("1", "text/plain", false),
            ("2", "application/xml", true),
            ("3", "text/css", false),
            ("4", "text/javascript", false),
        ] {
            let response = app.get(&format!("/-/code/old-page/{index}")).await;
            assert_eq!(response.status(), StatusCode::OK, "index {index}");
            assert_eq!(
                response.headers().get(header::CONTENT_TYPE).unwrap(),
                content_type,
                "index {index}",
            );
            assert_eq!(
                response
                    .headers()
                    .get(header::X_CONTENT_TYPE_OPTIONS)
                    .unwrap(),
                "nosniff",
                "index {index}",
            );
            assert_eq!(
                response.headers().contains_key(header::CONTENT_DISPOSITION),
                downloads,
                "index {index}",
            );
        }

        let xml = app.get("/-/code/old-page/2").await;
        assert_eq!(
            xml.headers().get(header::CONTENT_DISPOSITION).unwrap(),
            "attachment",
        );
    }

    #[tokio::test]
    async fn html_block_stays_inline_with_nosniff() {
        let app = TextBlockTestApp::spawn().await;

        let full = app.get("/-/html/old-page/1").await;
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(
            full.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/html",
        );
        assert_eq!(
            full.headers().get(header::X_CONTENT_TYPE_OPTIONS).unwrap(),
            "nosniff",
        );
        assert!(!full.headers().contains_key(header::CONTENT_DISPOSITION));
    }

    #[tokio::test]
    async fn code_query_string_does_not_change_serving_headers() {
        let app = TextBlockTestApp::spawn().await;

        let bare = app.get("/-/code/old-page/2").await;
        let gadget = app.get("/-/code/old-page/2?showChanges=true").await;
        for (name, response) in [("bare", bare), ("gadget", gadget)] {
            assert_eq!(response.status(), StatusCode::OK, "{name}");
            assert_eq!(
                response.headers().get(header::CONTENT_TYPE).unwrap(),
                "application/xml",
                "{name}",
            );
            assert_eq!(
                response.headers().get(header::CONTENT_DISPOSITION).unwrap(),
                "attachment",
                "{name}",
            );
        }
    }

    #[tokio::test]
    async fn local_code_redirect_path_is_unchanged() {
        let app = TextBlockTestApp::spawn().await;

        let redirect_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let redirect = redirect_client
            .get(format!("{}/local--code/old-page/1", app.base_url))
            .header(crate::handler::HEADER_SITE_ID.as_str(), SITE_ID)
            .send()
            .await
            .unwrap();
        assert_eq!(redirect.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(
            redirect.headers().get(header::LOCATION).unwrap(),
            "/-/code/old-page/1",
        );
    }

    #[tokio::test]
    async fn html_terminal_matches_evidenced_cache_and_method_behavior() {
        let app = TextBlockTestApp::spawn().await;
        let path = "/-/html/old-page/1";

        let redirect_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let redirect = redirect_client
            .get(format!("{}/local--html/old-page/1", app.base_url))
            .header(crate::handler::HEADER_SITE_ID.as_str(), SITE_ID)
            .send()
            .await
            .unwrap();
        assert_eq!(redirect.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(redirect.headers().get(header::LOCATION).unwrap(), path);

        let full = app.get(path).await;
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.headers().get(header::ETAG).unwrap(), "\"text-block\"");
        assert_eq!(
            full.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/html"
        );
        assert_html_cache_headers_omitted(full.headers());
        let full_body = full.bytes().await.unwrap();

        let head = app.request(Method::HEAD, path, &[]).await;
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers().get(header::ETAG).unwrap(), "\"text-block\"");
        assert_html_cache_headers_omitted(head.headers());
        assert!(head.bytes().await.unwrap().is_empty());

        for method in [Method::GET, Method::HEAD] {
            let exact = app
                .request(method, path, &[(header::IF_NONE_MATCH, "\"text-block\"")])
                .await;
            assert_eq!(exact.status(), StatusCode::NOT_MODIFIED);
            assert_html_cache_headers_omitted(exact.headers());
            assert!(exact.bytes().await.unwrap().is_empty());
        }

        let wrong = app
            .request(Method::GET, path, &[(header::IF_NONE_MATCH, "\"wrong\"")])
            .await;
        assert_eq!(wrong.status(), StatusCode::OK);
        assert_html_cache_headers_omitted(wrong.headers());
        assert_eq!(wrong.bytes().await.unwrap(), full_body);

        for request_headers in [
            vec![(header::RANGE, "bytes=0-4")],
            vec![
                (header::RANGE, "bytes=0-4"),
                (header::IF_RANGE, "\"text-block\""),
            ],
            vec![
                (header::RANGE, "bytes=0-4"),
                (header::IF_RANGE, "\"wrong\""),
            ],
        ] {
            let ranged = app.request(Method::GET, path, &request_headers).await;
            assert_eq!(ranged.status(), StatusCode::OK);
            assert!(!ranged.headers().contains_key(header::CONTENT_RANGE));
            assert_html_cache_headers_omitted(ranged.headers());
            assert_eq!(ranged.bytes().await.unwrap(), full_body);
        }
    }

    #[tokio::test]
    async fn html_terminal_hash_verifies_fetched_bytes() {
        let app = TextBlockTestApp::spawn().await;
        let paths = [
            format!("/local--html/old-page/{HTML_BLOCK_SHA1}-1/scp-wiki.wikidot.com"),
            format!(
                "/local--html/renamed-metadata/{HTML_BLOCK_SHA1}-999/attacker.example"
            ),
        ];

        let mut body = None;
        for path in &paths {
            let response = app.get(path).await;
            assert_eq!(response.status(), StatusCode::OK);
            let response_body = response.bytes().await.unwrap();
            assert!(String::from_utf8_lossy(&response_body).contains("moved content"));
            if let Some(expected) = &body {
                assert_eq!(&response_body, expected);
            } else {
                body = Some(response_body);
            }
        }

        let head = app.request(Method::HEAD, &paths[0], &[]).await;
        assert_eq!(head.status(), StatusCode::OK);
        assert!(head.bytes().await.unwrap().is_empty());

        let conditional = app
            .request(
                Method::GET,
                &paths[0],
                &[(header::IF_NONE_MATCH, "\"text-block\"")],
            )
            .await;
        assert_eq!(conditional.status(), StatusCode::NOT_MODIFIED);

        let mismatch = app
            .get(&format!(
                "/local--html/old-page/{MISMATCH_SHA1}-1/scp-wiki.wikidot.com"
            ))
            .await;
        assert_eq!(mismatch.status(), StatusCode::NOT_FOUND);
        assert!(
            !String::from_utf8_lossy(&mismatch.bytes().await.unwrap())
                .contains("moved content")
        );

        let missing = app
            .get(&format!(
                "/local--html/old-page/{MISSING_SHA1}-1/scp-wiki.wikidot.com"
            ))
            .await;
        assert_eq!(missing.status(), StatusCode::OK);
        let missing_body = missing.bytes().await.unwrap();
        assert!(!String::from_utf8_lossy(&missing_body).contains("moved content"));

        let post = app.request(Method::POST, &paths[0], &[]).await;
        assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);

        for id in [
            format!("0{}-1", &HTML_BLOCK_SHA1[1..]),
            format!("{}0-1", &HTML_BLOCK_SHA1[..39]),
        ] {
            let response = app
                .get(&format!("/local--html/ignored/{id}/scp-wiki.wikidot.com"))
                .await;
            assert_eq!(response.status(), StatusCode::OK);
            let response_body = response.bytes().await.unwrap();
            assert_eq!(response_body, missing_body);
            assert!(!String::from_utf8_lossy(&response_body).contains("moved content"));
        }

        for nonce in ["0", "01"] {
            let response = app
                .get(&format!(
                    "/local--html/ignored/{HTML_BLOCK_SHA1}-{nonce}/scp-wiki.wikidot.com"
                ))
                .await;
            assert_eq!(response.status(), StatusCode::OK);
            assert_eq!(response.bytes().await.unwrap(), body.as_ref().unwrap());
        }

        for nonce in ["", "x"] {
            let response = app
                .get(&format!(
                    "/local--html/ignored/{HTML_BLOCK_SHA1}-{nonce}/scp-wiki.wikidot.com"
                ))
                .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }

    #[test]
    fn html_block_response_wraps_author_bytes_in_wikidot_document() {
        let author = b"<html><head><style>body { color: red; }</style></head><body><p>Hi</p><script>run()</script></body></html>".to_vec();

        let body = text_block_response_body(TextBlockType::Html, author.clone());
        let body_text = String::from_utf8(body).unwrap();

        assert!(body_text.starts_with(
            "<!DOCTYPE html PUBLIC \"-//W3C//DTD XHTML 1.0 Transitional//EN\""
        ));
        assert!(body_text.contains("<html id=\"html-block-html\" xmlns=\"http://www.w3.org/1999/xhtml\" xml:lang=\"en\" lang=\"en\">"));
        assert!(body_text.contains(
            "<meta http-equiv=\"Content-type\" content=\"text/html; charset=utf-8\"/>"
        ));
        assert!(body_text.contains(
            "<link rel=\"stylesheet\" href=\"/common--theme/base/css/html-block.css\"/>"
        ));
        assert!(body_text.contains("<body>\n<html><head><style>body { color: red; }</style></head><body><p>Hi</p><script>run()</script></body></html>\n<script type=\"text/javascript\" src=\"/common--javascript/html-block-iframe.js\"></script></body></html>"));
        assert_eq!(body_text.matches("<p>Hi</p>").count(), 1);
        assert_eq!(body_text.matches("<script>run()</script>").count(), 1);
    }

    #[test]
    fn code_block_response_stays_unwrapped() {
        let body = text_block_response_body(TextBlockType::Code, b"let x = 1;".to_vec());

        assert_eq!(body, b"let x = 1;\n");
    }

    #[test]
    fn text_block_response_preserves_existing_trailing_newline() {
        let body =
            text_block_response_body(TextBlockType::Code, b"let x = 1;\n".to_vec());

        assert_eq!(body, b"let x = 1;\n");
    }

    #[test]
    fn session_token_is_extracted_from_cookie_header() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("theme=dark; wikijump_token=secret; other=1"),
        );

        assert_eq!(get_session_token(&headers), Some("secret"));
    }

    #[test]
    fn empty_or_missing_session_token_is_ignored() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("wikijump_token=; a=b"),
        );

        assert_eq!(get_session_token(&headers), None);
    }

    #[test]
    fn deepwell_permission_denied_is_detected_from_rpc_code() {
        let denied = WwsError::Deepwell(ClientError::Call(ErrorObjectOwned::owned(
            3106,
            "permission denied",
            None::<()>,
        )));
        let other = WwsError::Deepwell(ClientError::Call(ErrorObjectOwned::owned(
            1234,
            "other error",
            None::<()>,
        )));

        assert!(is_deepwell_permission_denied(&denied));
        assert!(!is_deepwell_permission_denied(&other));
    }

    #[tokio::test]
    async fn code_block_replaced_between_lookup_and_fetch_is_served() {
        let app = TextBlockTestApp::spawn().await;

        // The first lookup names the pre-replacement object, which the
        // replacement has already deleted. The request must look the block
        // up again and serve the replacement instead of failing.
        let response = app.get(&format!("/-/code/old-page/{REPLACED_INDEX}")).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.bytes().await.unwrap(),
            &b"replacement content\n"[..]
        );
        assert_eq!(app.mock.block_lookup_count(REPLACED_INDEX), 2);
    }

    #[tokio::test]
    async fn code_block_with_a_permanently_missing_object_still_errors() {
        let app = TextBlockTestApp::spawn().await;

        // The object never comes back, so the bounded retries run out and
        // the request ends in the same fetch error as before, after a
        // bounded number of lookups.
        let response = app.get(&format!("/-/code/old-page/{GONE_INDEX}")).await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert_eq!(
            app.mock.block_lookup_count(GONE_INDEX),
            MAX_TEXT_BLOCK_ATTEMPTS as usize
        );
    }
}
