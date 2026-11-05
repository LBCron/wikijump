/*
 * state.rs
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

use crate::cache::Cache;
use crate::config::Secrets;
use crate::deepwell::{Deepwell, FileData, PageData, UserData};
use crate::error::{
    BasicError, FallbackError, ResponseResult, Result, is_deepwell_permission_denied,
};
use crate::handler::get_session_token;
use axum::http::HeaderMap;
use axum::response::IntoResponse;
use s3::bucket::Bucket;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Semaphore;

const BUCKET_REQUEST_TIMEOUT: Duration = Duration::from_millis(200);
pub const RESIZED_IMAGE_MAX_CONCURRENT_JOBS: usize = 2;

pub type ServerState = Arc<ServerStateInner>;

#[derive(Debug)]
pub struct ServerStateInner {
    pub deepwell: Deepwell,
    pub cache: Cache,
    pub s3_files_bucket: Box<Bucket>,
    pub s3_tblocks_bucket: Box<Bucket>,
    pub resized_image_jobs: Semaphore,
}

pub async fn build_server_state(
    check_deepwell: bool,
    Secrets {
        deepwell_url,
        deepwell_rpc_token,
        redis_url,
        s3_files_bucket,
        s3_tblocks_bucket,
        s3_region,
        s3_credentials,
        s3_path_style,
    }: Secrets,
) -> Result<ServerState> {
    let deepwell = Deepwell::connect(&deepwell_url, &deepwell_rpc_token)?;
    if check_deepwell {
        deepwell.check().await;
    }

    let cache = Cache::connect(&redis_url)?;

    let (s3_files_bucket, s3_tblocks_bucket) = {
        let mut files_bucket =
            Bucket::new(&s3_files_bucket, s3_region.clone(), s3_credentials.clone())?;

        let mut tblocks_bucket = Bucket::new(
            &s3_tblocks_bucket,
            s3_region.clone(),
            s3_credentials.clone(),
        )?;

        if s3_path_style {
            files_bucket = files_bucket.with_path_style();
            tblocks_bucket = tblocks_bucket.with_path_style();
        }

        files_bucket.request_timeout = Some(BUCKET_REQUEST_TIMEOUT);
        tblocks_bucket.request_timeout = Some(BUCKET_REQUEST_TIMEOUT);
        (files_bucket, tblocks_bucket)
    };

    Ok(Arc::new(ServerStateInner {
        deepwell,
        cache,
        s3_files_bucket,
        s3_tblocks_bucket,
        resized_image_jobs: Semaphore::new(RESIZED_IMAGE_MAX_CONCURRENT_JOBS),
    }))
}

impl ServerStateInner {
    pub async fn get_or_cache_site_domain(&self, site_id: i64) -> Result<String> {
        self.cache
            .get_or_fetch_site_domain(site_id, || self.deepwell.get_site_domain(site_id))
            .await
    }

    pub async fn get_site_domain_or_response(
        &self,
        site_id: i64,
    ) -> ResponseResult<String> {
        match self.get_or_cache_site_domain(site_id).await {
            Ok(domain) => Ok(domain),
            Err(error) => {
                error!(
                    site_id = site_id,
                    "Could not fetch preferred site domain: {error}",
                );
                Err(FallbackError::RedirectMain.into_response())
            }
        }
    }

    pub async fn get_page_fresh_or_response(
        &self,
        headers: &HeaderMap,
        site_id: i64,
        page_slug: &str,
    ) -> ResponseResult<i64> {
        match self
            .deepwell
            .get_page(site_id, page_slug, get_session_token(headers))
            .await
        {
            Ok(Some(PageData { page_id, .. })) => Ok(page_id),
            Ok(None) => {
                error!(
                    site_id = site_id,
                    page_slug = page_slug,
                    "Cannot complete request, no such page",
                );
                Err(self
                    .build_basic_error_response(
                        headers,
                        BasicError::PageSlug { site_id, page_slug },
                    )
                    .await)
            }
            Err(error) => {
                error!(
                    site_id = site_id,
                    page_slug = page_slug,
                    "Cannot freshly resolve page info: {error}",
                );
                Err(self
                    .build_basic_error_response(
                        headers,
                        BasicError::PageFetch { site_id, page_slug },
                    )
                    .await)
            }
        }
    }

    pub async fn get_file(
        &self,
        site_id: i64,
        page_id: i64,
        filename: &str,
        session_token: Option<&str>,
    ) -> Result<Option<FileData>> {
        self.deepwell
            .get_file(site_id, page_id, filename, session_token)
            .await
    }

    pub async fn get_file_or_response(
        &self,
        headers: &HeaderMap,
        site_id: i64,
        page_id: i64,
        page_slug: &str,
        filename: &str,
        session_token: Option<&str>,
    ) -> ResponseResult<FileData> {
        match self
            .get_file(site_id, page_id, filename, session_token)
            .await
        {
            Ok(Some(file_info)) => Ok(file_info),
            Ok(None) => {
                error!(
                    site_id = site_id,
                    page_id = page_id,
                    filename = filename,
                    "Cannot complete request, none with filename",
                );

                let response = self
                    .build_basic_error_response(
                        headers,
                        BasicError::FileName {
                            site_id,
                            page_slug,
                            filename,
                        },
                    )
                    .await;

                Err(response)
            }
            Err(error) => {
                error!(
                    site_id = site_id,
                    page_id = page_id,
                    filename = filename,
                    "Cannot get file info: {error}",
                );

                let error_kind = if is_deepwell_permission_denied(&error) {
                    BasicError::FileName {
                        site_id,
                        page_slug,
                        filename,
                    }
                } else {
                    BasicError::FileFetch {
                        site_id,
                        page_slug,
                        filename,
                    }
                };
                let response = self.build_basic_error_response(headers, error_kind).await;

                Err(response)
            }
        }
    }

    pub async fn get_or_cache_avatar(&self, user_id: i64) -> Result<Option<String>> {
        match self.cache.get_avatar(user_id).await? {
            Some(avatar_s3_hash) => Ok(Some(avatar_s3_hash)),
            None => match self.deepwell.get_user(user_id).await? {
                None => Ok(None),
                Some(UserData { avatar_s3_hash }) => {
                    let s3_hash: String = avatar_s3_hash
                        .iter()
                        .map(|b| format!("{:02x}", b).to_string())
                        .collect();
                    self.cache.set_avatar(user_id, &s3_hash).await?;
                    Ok(Some(s3_hash))
                }
            },
        }
    }

    pub async fn get_avatar_or_response(
        &self,
        headers: &HeaderMap,
        user_id: i64,
    ) -> ResponseResult<String> {
        match self.get_or_cache_avatar(user_id).await {
            Ok(Some(avatar_s3_hash)) => Ok(avatar_s3_hash),
            Ok(None) => {
                error!(
                    user_id = user_id,
                    "Cannot complete request, no such user or no avatar set",
                );

                let response = self
                    .build_basic_error_response(
                        headers,
                        BasicError::UserAvatar { user_id },
                    )
                    .await;

                Err(response)
            }
            Err(error) => {
                error!(user_id = user_id, "Cannot get user info: {error}");

                let response = self
                    .build_basic_error_response(
                        headers,
                        BasicError::UserFetch { user_id },
                    )
                    .await;

                Err(response)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::body::Bytes;
    use axum::extract::State as AxumState;
    use axum::http::HeaderMap;
    use axum::response::{IntoResponse, Response};
    use axum::routing::post;
    use s3::creds::Credentials;
    use s3::region::Region;
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    type Requests = Arc<Mutex<Vec<Value>>>;

    fn test_secrets(path_style: bool) -> Secrets {
        Secrets {
            deepwell_url: str!("http://127.0.0.1:2747"),
            deepwell_rpc_token: crate::config::RpcToken::parse("0".repeat(64)).unwrap(),
            redis_url: str!("redis://127.0.0.1/"),
            s3_files_bucket: str!("files"),
            s3_tblocks_bucket: str!("text-blocks"),
            s3_region: Region::Custom {
                region: str!("test"),
                endpoint: str!("http://127.0.0.1:9000"),
            },
            s3_credentials: Credentials::new(
                Some("access-key"),
                Some("secret-key"),
                None,
                None,
                None,
            )
            .unwrap(),
            s3_path_style: path_style,
        }
    }

    async fn file_rpc(AxumState(requests): AxumState<Requests>, body: Bytes) -> Response {
        let request: Value = serde_json::from_slice(&body).unwrap();
        let id = request["id"].clone();
        assert_eq!(request["method"], "file_get");
        requests.lock().unwrap().push(request);

        (
            [("content-type", "application/json")],
            json!({
                "jsonrpc": "2.0",
                "result": {
                    "file_id": 7,
                    "revision_id": 17,
                    "revision_created_at": "2020-07-23T06:38:39Z",
                    "mime": "text/plain",
                    "size": 42,
                    "s3_hash": "private-blob"
                },
                "id": id
            })
            .to_string(),
        )
            .into_response()
    }

    async fn denied_file_rpc(
        AxumState(requests): AxumState<Requests>,
        body: Bytes,
    ) -> Response {
        let request: Value = serde_json::from_slice(&body).unwrap();
        let method = request["method"].as_str().unwrap().to_owned();
        let id = request["id"].clone();
        requests.lock().unwrap().push(request);
        let body = match method.as_str() {
            "file_get" => json!({
                "jsonrpc": "2.0",
                "error": {
                    "code": 3106,
                    "message": "permission denied"
                },
                "id": id
            }),
            "basic_error_missing_file_name" => json!({
                "jsonrpc": "2.0",
                "result": {"title": "missing", "body": "not found"},
                "id": id
            }),
            "basic_error_file_fetch" => json!({
                "jsonrpc": "2.0",
                "result": {"title": "fetch", "body": "fetch failed"},
                "id": id
            }),
            other => panic!("unexpected JSON-RPC method: {other}"),
        };

        ([("content-type", "application/json")], body.to_string()).into_response()
    }

    async fn spawn_file_rpc() -> (String, Requests, tokio::task::JoinHandle<()>) {
        let requests = Requests::default();
        let app = Router::new()
            .route("/", post(file_rpc))
            .with_state(Arc::clone(&requests));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), requests, task)
    }

    async fn spawn_denied_file_rpc() -> (String, Requests, tokio::task::JoinHandle<()>) {
        let requests = Requests::default();
        let app = Router::new()
            .route("/", post(denied_file_rpc))
            .with_state(Arc::clone(&requests));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), requests, task)
    }

    #[tokio::test]
    async fn build_server_state_initializes_clients_and_buckets_without_check() {
        let state = build_server_state(false, test_secrets(true)).await.unwrap();

        assert_eq!(state.s3_files_bucket.name, "files");
        assert_eq!(state.s3_tblocks_bucket.name, "text-blocks");
        assert_eq!(
            state.s3_files_bucket.request_timeout,
            Some(BUCKET_REQUEST_TIMEOUT),
        );
        assert_eq!(
            state.s3_tblocks_bucket.request_timeout,
            Some(BUCKET_REQUEST_TIMEOUT),
        );
    }

    #[tokio::test]
    async fn file_metadata_rechecks_deepwell_authorization_instead_of_using_cache() {
        let (deepwell_url, requests, server) = spawn_file_rpc().await;
        let mut secrets = test_secrets(true);
        secrets.deepwell_url = deepwell_url;
        secrets.redis_url = str!("redis://127.0.0.1:1/");
        let state = build_server_state(false, secrets).await.unwrap();

        let file = state
            .get_file(42, 123, "secret.png", Some("actor-session"))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(file.s3_hash, "private-blob");
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(requests[0]["params"]["session_token"], "actor-session");
        server.abort();
    }

    #[tokio::test]
    async fn permission_denied_file_metadata_uses_the_non_disclosing_not_found_response()
    {
        let (deepwell_url, requests, server) = spawn_denied_file_rpc().await;
        let mut secrets = test_secrets(true);
        secrets.deepwell_url = deepwell_url;
        secrets.redis_url = str!("redis://127.0.0.1:1/");
        let state = build_server_state(false, secrets).await.unwrap();

        let response = state
            .get_file_or_response(
                &HeaderMap::new(),
                42,
                123,
                "private-page",
                "secret.png",
                None,
            )
            .await
            .unwrap_err();

        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);
        let requests = requests.lock().unwrap();
        assert_eq!(requests[0]["method"], "file_get");
        assert_eq!(requests[1]["method"], "basic_error_missing_file_name");
        server.abort();
    }

    async fn page_rpc(AxumState(requests): AxumState<Requests>, body: Bytes) -> Response {
        let request: Value = serde_json::from_slice(&body).unwrap();
        let id = request["id"].clone();
        let method = request["method"].as_str().unwrap().to_owned();
        let is_viewer = request["params"]["session_token"] == "viewer-token";
        requests.lock().unwrap().push(request);

        let result = match method.as_str() {
            "page_get" => {
                if is_viewer {
                    json!({ "page_id": 123 })
                } else {
                    Value::Null
                }
            }
            "basic_error_missing_page_slug" => {
                json!({ "title": "missing", "body": "not found" })
            }
            other => panic!("unexpected JSON-RPC method: {other}"),
        };

        (
            [("content-type", "application/json")],
            json!({
                "jsonrpc": "2.0",
                "result": result,
                "id": id
            })
            .to_string(),
        )
            .into_response()
    }

    async fn spawn_page_rpc() -> (String, Requests, tokio::task::JoinHandle<()>) {
        let requests = Requests::default();
        let app = Router::new()
            .route("/", post(page_rpc))
            .with_state(Arc::clone(&requests));
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://{address}"), requests, task)
    }

    #[tokio::test]
    async fn page_lookup_forwards_the_cookie_session_token() {
        let (deepwell_url, requests, server) = spawn_page_rpc().await;
        let mut secrets = test_secrets(true);
        secrets.deepwell_url = deepwell_url;
        secrets.redis_url = str!("redis://127.0.0.1:1/");
        let state = build_server_state(false, secrets).await.unwrap();

        let mut headers = HeaderMap::new();
        headers.insert(
            axum::http::header::COOKIE,
            "theme=dark; wikijump_token=viewer-token".parse().unwrap(),
        );
        let page_id = state
            .get_page_fresh_or_response(&headers, 42, "private-page")
            .await
            .unwrap();
        assert_eq!(page_id, 123);

        let response = state
            .get_page_fresh_or_response(&HeaderMap::new(), 42, "private-page")
            .await
            .unwrap_err();
        assert_eq!(response.status(), axum::http::StatusCode::NOT_FOUND);

        let requests = requests.lock().unwrap();
        let page_gets: Vec<&Value> = requests
            .iter()
            .filter(|request| request["method"] == "page_get")
            .collect();
        assert_eq!(page_gets.len(), 2);
        assert_eq!(page_gets[0]["params"]["session_token"], "viewer-token");
        assert!(page_gets[1]["params"]["session_token"].is_null());
        server.abort();
    }
}
