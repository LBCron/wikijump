/*
 * route.rs
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

use crate::handler::*;
use crate::state::ServerState;
use axum::Router;
use axum::http::header::{ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue};
use axum::routing::{MethodFilter, any, get, on};
use tower_http::compression::CompressionLayer;
use tower_http::normalize_path::NormalizePathLayer;
use tower_http::set_header::SetResponseHeaderLayer;
use tower_http::trace::TraceLayer;

pub fn build_router(state: ServerState) -> Router {

    Router::new()
        .route(
            "/local--files/{page_slug}/{filename}",
            any(handle_local_file),
        )
        .route(
            "/local--code/{page_slug}/{index}",
            any(handle_code_redirect),
        )
        .route(
            "/local--html/{page_slug}/{id}/{domain}",
            get(handle_html_terminal),
        )
        .route(
            "/local--html/{page_slug}/{id}/{domain}",
            any(handle_invalid_method),
        )
        .route("/local--html/{page_slug}/{id}", any(handle_html_redirect))
        .route("/-/files/{page_slug}/{filename}", any(handle_file_redirect))
        .route(
            "/{page_slug}/code",
            on(MethodFilter::GET, handle_default_code_redirect)
                .fallback(redirect_to_main),
        )
        .route("/{page_slug}/code/{filename}", any(handle_code_redirect))
        .route("/{page_slug}/html/{filename}", any(handle_html_redirect))
        .route("/{page_slug}/file/{filename}", any(handle_file_redirect))
        .route(
            "/{page_slug}/download/{filename}",
            any(handle_download_redirect),
        )
        .route("/-/file/{page_slug}/{filename}", get(handle_file_fetch))
        .route("/-/file/{page_slug}/{filename}", any(handle_invalid_method))
        .route(
            "/local--resized-images/{page_slug}/{filename}/{variant}",
            get(handle_resized_image),
        )
        .route(
            "/local--resized-images/{page_slug}/{filename}/{variant}",
            any(handle_invalid_method),
        )
        .route(
            "/-/download/{page_slug}/{filename}",
            get(handle_file_download),
        )
        .route(
            "/-/download/{page_slug}/{filename}",
            any(handle_invalid_method),
        )
        .route("/-/avatar/{user_id}", get(handle_user_avatar))
        .route("/-/avatar/{user_id}", any(handle_invalid_method))
        .route("/-/code/{page_slug}/{index}", get(handle_code_block))
        .route("/-/code/{page_slug}/{index}", any(handle_invalid_method))
        .route("/-/html/{page_slug}/{id}", get(handle_html_block))
        .route("/-/html/{page_slug}/{id}", any(handle_invalid_method))
        .route("/-/health-check", any(handle_health_check))
        .route("/-/basic-error/{error_code}", get(handle_basic_error))
        .route("/-/basic-error/{error_code}", any(handle_invalid_method))
        .route("/robots.txt", get(handle_robots_txt))
        .route(
            "/common--theme/base/css/html-block.css",
            get(handle_html_block_css),
        )
        .route(
            "/common--theme/{*path}",
            get(handle_common_theme),
        )
        .route(
            "/common--javascript/html-block-iframe.js",
            get(handle_html_block_iframe_js),
        )
        .route(
            "/common--javascript/resize-iframe.html",
            get(handle_resize_iframe_html),
        )
        .route(
            "/common--javascript/{*path}",
            get(handle_common_javascript),
        )
        .route("/.well-known", any(handle_well_known))
        .route("/.well-known/{*path}", any(handle_well_known))
        .fallback(redirect_to_main)
        .layer(TraceLayer::new_for_http())
        .layer(NormalizePathLayer::trim_trailing_slash())
        .layer(SetResponseHeaderLayer::if_not_present(
            ACCESS_CONTROL_ALLOW_ORIGIN,
            Some(HeaderValue::from_static("*")),
        ))
        .layer(
            CompressionLayer::new()
                .gzip(true)
                .deflate(true)
                .br(true)
                .zstd(true),
        )
        .with_state(state)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Secrets;
    use crate::state::build_server_state;
    use axum::body::Bytes;
    use axum::extract::State;
    use axum::http::StatusCode;
    use axum::http::header::LOCATION;
    use axum::routing::post;
    use s3::creds::Credentials;
    use s3::region::Region;
    use serde_json::{Value, json};
    use std::sync::{Arc, Mutex};
    use tokio::net::TcpListener;

    fn test_secrets() -> Secrets {
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
            s3_path_style: true,
        }
    }

    #[tokio::test]
    async fn build_router_accepts_initialized_state() {
        let state = build_server_state(false, test_secrets()).await.unwrap();
        let _router = build_router(state);
    }

    async fn canonical_domain_rpc(
        State(domain): State<Arc<Mutex<String>>>,
        body: Bytes,
    ) -> ([(axum::http::HeaderName, &'static str); 1], String) {
        let request: Value = serde_json::from_slice(&body).unwrap();
        let result = match request["method"].as_str().unwrap() {
            "site_domain" => {
                assert_eq!(request["params"][0], 42);
                json!(domain.lock().unwrap().clone())
            }
            "wikidot_sitemap" => {
                assert_eq!(request["params"]["site_id"], 42);
                assert_eq!(request["params"]["shard"], 0);
                json!({ "entries": [], "shard_count": 0 })
            }
            other => panic!("unexpected JSON-RPC method: {other}"),
        };
        let response = json!({
            "jsonrpc": "2.0",
            "result": result,
            "id": request["id"],
        });
        (
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            response.to_string(),
        )
    }

    #[tokio::test]
    async fn public_robots_uses_site_domain_rpc_not_request_host() {
        let preferred_domain = Arc::new(Mutex::new("preferred.example".to_owned()));
        let preferred_domain_for_server = Arc::clone(&preferred_domain);
        let backend_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend_addr = backend_listener.local_addr().unwrap();
        let backend = tokio::spawn(async move {
            axum::serve(
                backend_listener,
                Router::new()
                    .route("/jsonrpc", post(canonical_domain_rpc))
                    .with_state(Arc::clone(&preferred_domain_for_server)),
            )
            .await
            .unwrap();
        });
        let mut secrets = test_secrets();
        secrets.deepwell_url = format!("http://{backend_addr}/jsonrpc");
        let state = build_server_state(false, secrets).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, build_router(state)).await.unwrap();
        });
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{addr}/robots.txt"))
            .header(crate::handler::HEADER_TARGET_SERVER, "main")
            .header(crate::handler::HEADER_SITE_ID, "42")
            .header("host", "host-header-spoof.example")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.text().await.unwrap(),
            "User-agent: *\nDisallow: /*/p/*/p/\nDisallow: /*/p/*_p/\nDisallow: /*_p/*/p/\nDisallow: /*_p/*_p/\n\nSitemap: https://preferred.example/sitemap.xml\nUser-agent: voltron\nDisallow: /\n"
        );

        *preferred_domain.lock().unwrap() = "changed.example".to_owned();
        let updated = client
            .get(format!("http://{addr}/robots.txt"))
            .header(crate::handler::HEADER_TARGET_SERVER, "main")
            .header(crate::handler::HEADER_SITE_ID, "42")
            .header("host", "host-header-spoof.example")
            .send()
            .await
            .unwrap();
        assert_eq!(updated.status(), StatusCode::OK);
        assert_eq!(
            updated.text().await.unwrap(),
            "User-agent: *\nDisallow: /*/p/*/p/\nDisallow: /*/p/*_p/\nDisallow: /*_p/*/p/\nDisallow: /*_p/*_p/\n\nSitemap: https://changed.example/sitemap.xml\nUser-agent: voltron\nDisallow: /\n"
        );

        let response = client
            .get(format!("http://{addr}/robots.txt"))
            .header(crate::handler::HEADER_TARGET_SERVER, "files")
            .header("host", "files.example")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.text().await.unwrap(), "User-agent: *\nAllow: /\n");
        server.abort();
        backend.abort();
    }

    async fn private_sitemap_rpc(
        body: Bytes,
    ) -> ([(axum::http::HeaderName, &'static str); 1], String) {
        let request: Value = serde_json::from_slice(&body).unwrap();
        assert_eq!(request["method"], "wikidot_sitemap");
        assert_eq!(request["params"]["site_id"], 7);
        assert_eq!(request["params"]["shard"], 0);
        let response = json!({
            "jsonrpc": "2.0",
            "result": Value::Null,
            "id": request["id"],
        });
        (
            [(axum::http::header::CONTENT_TYPE, "application/json")],
            response.to_string(),
        )
    }

    #[tokio::test]
    async fn private_site_robots_denies_indexing_without_sitemap() {
        let backend_listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let backend_addr = backend_listener.local_addr().unwrap();
        let backend = tokio::spawn(async move {
            axum::serve(
                backend_listener,
                Router::new().route("/jsonrpc", post(private_sitemap_rpc)),
            )
            .await
            .unwrap();
        });
        let mut secrets = test_secrets();
        secrets.deepwell_url = format!("http://{backend_addr}/jsonrpc");
        let state = build_server_state(false, secrets).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, build_router(state)).await.unwrap();
        });
        let client = reqwest::Client::new();
        let response = client
            .get(format!("http://{addr}/robots.txt"))
            .header(crate::handler::HEADER_TARGET_SERVER, "main")
            .header(crate::handler::HEADER_SITE_ID, "7")
            .header("host", "private.example")
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.text().await.unwrap(),
            "User-agent: *\nDisallow: /\n"
        );
        server.abort();
        backend.abort();
    }

    #[tokio::test]
    async fn public_code_routes_default_to_first_block_without_changing_indexed_route() {
        let state = build_server_state(false, test_secrets()).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, build_router(state)).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();

        for (path, location) in [
            ("/category%3Apage/code", "/-/code/category:page/1"),
            ("/category%3Apage/code/2", "/-/code/category:page/2"),
        ] {
            let response = client
                .get(format!("http://{address}{path}"))
                .header(crate::handler::HEADER_SITE_ID, "1")
                .send()
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
            assert_eq!(response.headers().get(LOCATION).unwrap(), location);
        }

        server.abort();
    }

    #[tokio::test]
    async fn underscore_local_code_route_redirects_to_the_internal_code_route() {
        let state = build_server_state(false, test_secrets()).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, build_router(state)).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();

        for (path, location) in [
            ("/local--code/category%3Apage/2", "/-/code/category:page/2"),
            (
                "/local--code_/category%3Apage/2",
                "/-/code/category%3Apage/2",
            ),
        ] {
            let response = client
                .get(format!("http://{address}{path}"))
                .header(crate::handler::HEADER_SITE_ID, "1")
                .send()
                .await
                .unwrap();

            assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
            assert_eq!(response.headers().get(LOCATION).unwrap(), location);
        }

        server.abort();
    }

    #[tokio::test]
    async fn public_basic_error_route_rejects_external_get_head_and_post() {
        let state = build_server_state(false, test_secrets()).await.unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            axum::serve(listener, build_router(state)).await.unwrap();
        });
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap();
        let url = format!("http://{address}/-/basic-error/file-root");

        let get = client.get(&url).send().await.unwrap();
        assert_eq!(get.status(), StatusCode::FORBIDDEN);
        assert_eq!(get.text().await.unwrap(), "ERROR XF-1002");

        let head = client.head(&url).send().await.unwrap();
        assert_eq!(head.status(), StatusCode::FORBIDDEN);
        assert!(head.bytes().await.unwrap().is_empty());

        let post = client.post(&url).send().await.unwrap();
        assert_eq!(post.status(), StatusCode::METHOD_NOT_ALLOWED);

        server.abort();
    }
}
