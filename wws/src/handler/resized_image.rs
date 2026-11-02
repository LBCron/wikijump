/*
 * handler/resized_image.rs
 *
 * Wilson's Web Server - Serves a zoo of user-generated content
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::get_site_id;
use crate::deepwell::FileData;
use crate::error::{BasicError, build_basic_error_response};
use crate::fetch::fetch_file_info;
use crate::state::ServerState;
use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::header::{self, HeaderMap};
use axum::http::{Method, StatusCode};
use axum::response::{IntoResponse, Response};
use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{
    DynamicImage, ImageBuffer, ImageEncoder, ImageFormat, ImageReader, Limits, Rgba,
};
use std::io::Cursor;

const RESIZED_IMAGE_ENCODER_EPOCH: &str = "jpeg-v1";
const RESIZED_IMAGE_JPEG_QUALITY: u8 = 85;
const RESIZED_IMAGE_MAX_SOURCE_BYTES: i64 = 16 * 1024 * 1024;
const RESIZED_IMAGE_MAX_DIMENSION: u32 = 4096;
const RESIZED_IMAGE_MAX_DECODE_ALLOC: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ResizeVariant {
    Square,
    Thumbnail,
    Small,
    Medium,
}

impl ResizeVariant {
    fn from_filename(value: &str) -> Option<Self> {
        match value {
            "square.jpg" => Some(Self::Square),
            "thumbnail.jpg" => Some(Self::Thumbnail),
            "small.jpg" => Some(Self::Small),
            "medium.jpg" => Some(Self::Medium),
            _ => None,
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Square => "square",
            Self::Thumbnail => "thumbnail",
            Self::Small => "small",
            Self::Medium => "medium",
        }
    }

    fn longest_side(self) -> u32 {
        match self {
            Self::Square => 75,
            Self::Thumbnail => 100,
            Self::Small => 240,
            Self::Medium => 500,
        }
    }
}

#[derive(Debug)]
enum ResizeError {
    FormatMismatch,
    Image(image::ImageError),
    Svg(String),
}

impl From<resvg::usvg::Error> for ResizeError {
    fn from(error: resvg::usvg::Error) -> Self {
        Self::Svg(error.to_string())
    }
}

impl From<image::ImageError> for ResizeError {
    fn from(error: image::ImageError) -> Self {
        Self::Image(error)
    }
}

impl From<std::io::Error> for ResizeError {
    fn from(error: std::io::Error) -> Self {
        Self::Image(error.into())
    }
}

pub async fn handle_resized_image(
    State(state): State<ServerState>,
    method: Method,
    Path((mut page_slug, filename, variant_filename)): Path<(String, String, String)>,
    headers: HeaderMap,
) -> Response {
    let site_id = get_site_id(&headers);
    let Some(variant) = ResizeVariant::from_filename(&variant_filename) else {
        return resized_not_found(&state, &headers, site_id, &page_slug, &filename).await;
    };
    let file_info =
        match fetch_file_info(&state, &headers, site_id, &mut page_slug, &filename).await
        {
            Ok(file_info) => file_info,
            Err(response) => return response,
        };
    let etag = resized_etag(&file_info, variant);

    let Some(format) = source_format(&file_info) else {
        return resized_not_found(&state, &headers, site_id, &page_slug, &filename).await;
    };
    if file_info.size <= 0 || file_info.size > RESIZED_IMAGE_MAX_SOURCE_BYTES {
        return resized_not_found(&state, &headers, site_id, &page_slug, &filename).await;
    }
    if if_none_match(&headers, &etag) {
        return resized_headers(StatusCode::NOT_MODIFIED, &etag)
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    if headers.contains_key(header::RANGE) {
        return Response::builder()
            .status(StatusCode::RANGE_NOT_SATISFIABLE)
            .header(header::ETAG, etag)
            .header(header::ACCEPT_RANGES, "none")
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }
    if method == Method::HEAD {
        return resized_headers(StatusCode::OK, &etag)
            .body(Body::empty())
            .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    }

    let Ok(_job) = state.resized_image_jobs.try_acquire() else {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    };
    let source = match state.s3_files_bucket.get_object(&file_info.s3_hash).await {
        Ok(response) if response.status_code() == StatusCode::OK => response.to_vec(),
        Ok(response) => {
            error!(
                site_id,
                page_slug,
                filename,
                revision_id = file_info.revision_id,
                s3_hash = %file_info.s3_hash,
                status_code = response.status_code(),
                "Resized image source returned an unexpected S3 status",
            );
            return resized_file_fetch_error(
                &state, &headers, site_id, &page_slug, &filename,
            )
            .await;
        }
        Err(error) => {
            error!(
                site_id,
                page_slug,
                filename,
                revision_id = file_info.revision_id,
                s3_hash = %file_info.s3_hash,
                "Cannot fetch resized image source: {error}",
            );
            return resized_file_fetch_error(
                &state, &headers, site_id, &page_slug, &filename,
            )
            .await;
        }
    };
    if source.len() > RESIZED_IMAGE_MAX_SOURCE_BYTES as usize
        || source.len() != file_info.size as usize
    {
        error!(
            site_id,
            page_slug,
            filename,
            revision_id = file_info.revision_id,
            expected_size = file_info.size,
            actual_size = source.len(),
            "Resized image source does not match its file revision metadata",
        );
        return resized_file_fetch_error(
            &state, &headers, site_id, &page_slug, &filename,
        )
        .await;
    }

    let resized =
        tokio::task::spawn_blocking(move || resize_image(source, format, variant)).await;
    let bytes = match resized {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(error)) => {
            match error {
                ResizeError::FormatMismatch => warn!(
                    site_id,
                    page_slug,
                    filename,
                    "Resized image source format did not match its authorized MIME",
                ),
                ResizeError::Image(ref image_error) => warn!(
                    site_id,
                    page_slug,
                    filename,
                    error = %image_error,
                    "Authorized resized image source could not be decoded",
                ),
                ResizeError::Svg(ref svg_error) => warn!(
                    site_id,
                    page_slug,
                    filename,
                    error = %svg_error,
                    "Authorized resized image SVG source could not be rasterized",
                ),
            }
            return resized_not_found(&state, &headers, site_id, &page_slug, &filename)
                .await;
        }
        Err(error) => {
            error!(
                site_id,
                page_slug, filename, "Resized image worker failed: {error}",
            );
            return resized_file_fetch_error(
                &state, &headers, site_id, &page_slug, &filename,
            )
            .await;
        }
    };

    resized_headers(StatusCode::OK, &etag)
        .header(header::CONTENT_LENGTH, bytes.len())
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum SourceFormat {
    Raster(ImageFormat),
    Svg,
}

fn source_format(file_info: &FileData) -> Option<SourceFormat> {
    let media_type = file_info.mime.split(';').next()?.trim();
    match media_type {
        "image/gif" => Some(SourceFormat::Raster(ImageFormat::Gif)),
        "image/jpeg" => Some(SourceFormat::Raster(ImageFormat::Jpeg)),
        "image/png" => Some(SourceFormat::Raster(ImageFormat::Png)),
        "image/webp" => Some(SourceFormat::Raster(ImageFormat::WebP)),
        "image/svg+xml" => Some(SourceFormat::Svg),
        _ => None,
    }
}

fn resized_etag(file_info: &FileData, variant: ResizeVariant) -> String {
    format!(
        "\"wikijump-{RESIZED_IMAGE_ENCODER_EPOCH}-{}-{}-{}\"",
        file_info.revision_id,
        file_info.s3_hash,
        variant.name(),
    )
}

fn if_none_match(headers: &HeaderMap, etag: &str) -> bool {
    headers.get_all(header::IF_NONE_MATCH).iter().any(|value| {
        value.to_str().is_ok_and(|value| {
            value.split(',').any(|candidate| {
                let candidate = candidate.trim();
                candidate == "*"
                    || candidate == etag
                    || candidate.strip_prefix("W/") == Some(etag)
            })
        })
    })
}

fn resized_headers(status: StatusCode, etag: &str) -> axum::http::response::Builder {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "image/jpeg")
        .header(header::ETAG, etag)
        .header(header::ACCEPT_RANGES, "none")
        .header(header::CACHE_CONTROL, "private, no-cache")
}

fn resize_image(
    source: Vec<u8>,
    expected_format: SourceFormat,
    variant: ResizeVariant,
) -> Result<Vec<u8>, ResizeError> {
    let image = match expected_format {
        SourceFormat::Raster(format) => decode_raster(source, format)?,
        SourceFormat::Svg => rasterize_svg(&source)?,
    };
    let side = variant.longest_side();
    let resized = match variant {
        ResizeVariant::Square => image.resize_to_fill(side, side, FilterType::Lanczos3),
        _ => image.resize(side, side, FilterType::Lanczos3),
    };
    let rgb = resized.to_rgb8();
    let (width, height) = rgb.dimensions();
    let mut output = Vec::new();
    JpegEncoder::new_with_quality(&mut output, RESIZED_IMAGE_JPEG_QUALITY).write_image(
        rgb.as_raw(),
        width,
        height,
        image::ExtendedColorType::Rgb8,
    )?;
    Ok(output)
}

fn decode_raster(
    source: Vec<u8>,
    expected_format: ImageFormat,
) -> Result<DynamicImage, ResizeError> {
    let mut reader = ImageReader::new(Cursor::new(source)).with_guessed_format()?;
    if reader.format() != Some(expected_format) {
        return Err(ResizeError::FormatMismatch);
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(RESIZED_IMAGE_MAX_DIMENSION);
    limits.max_image_height = Some(RESIZED_IMAGE_MAX_DIMENSION);
    limits.max_alloc = Some(RESIZED_IMAGE_MAX_DECODE_ALLOC);
    reader.limits(limits);
    Ok(reader.decode()?)
}

fn rasterize_svg(source: &[u8]) -> Result<DynamicImage, ResizeError> {
    // The default options resolve no external resources: references to
    // files or network URLs in the SVG are dropped, only data embedded
    // in the document itself can render.
    let options = resvg::usvg::Options::default();
    let tree = resvg::usvg::Tree::from_data(source, &options)?;
    let size = tree.size().to_int_size();
    let (width, height) = (size.width(), size.height());
    if width == 0
        || height == 0
        || width > RESIZED_IMAGE_MAX_DIMENSION
        || height > RESIZED_IMAGE_MAX_DIMENSION
        || u64::from(width) * u64::from(height) * 4 > RESIZED_IMAGE_MAX_DECODE_ALLOC
    {
        return Err(ResizeError::Svg(format!(
            "SVG intrinsic size {width}x{height} is outside the resized image limits"
        )));
    }
    let mut pixmap = resvg::tiny_skia::Pixmap::new(width, height).ok_or_else(|| {
        ResizeError::Svg(format!("could not allocate a {width}x{height} pixmap"))
    })?;
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::default(),
        &mut pixmap.as_mut(),
    );
    let mut rgba = Vec::with_capacity(pixmap.pixels().len() * 4);
    for pixel in pixmap.pixels() {
        let color = pixel.demultiply();
        let alpha = u32::from(color.alpha());
        let flatten = |channel: u8| {
            ((u32::from(channel) * alpha + 255 * (255 - alpha)) / 255) as u8
        };
        rgba.extend_from_slice(&[
            flatten(color.red()),
            flatten(color.green()),
            flatten(color.blue()),
            255,
        ]);
    }
    let buffer = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(width, height, rgba)
        .ok_or_else(|| {
            ResizeError::Svg("rasterized SVG did not fill its pixmap".to_owned())
        })?;
    Ok(DynamicImage::ImageRgba8(buffer))
}

async fn resized_not_found(
    state: &ServerState,
    headers: &HeaderMap,
    site_id: i64,
    page_slug: &str,
    filename: &str,
) -> Response {
    build_basic_error_response(
        state,
        headers,
        BasicError::FileName {
            site_id,
            page_slug,
            filename,
        },
    )
    .await
}

async fn resized_file_fetch_error(
    state: &ServerState,
    headers: &HeaderMap,
    site_id: i64,
    page_slug: &str,
    filename: &str,
) -> Response {
    build_basic_error_response(
        state,
        headers,
        BasicError::FileFetch {
            site_id,
            page_slug,
            filename,
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::RESIZED_IMAGE_MAX_DIMENSION;
    use crate::config::{RpcToken, Secrets};
    use crate::handler::HEADER_SITE_ID;
    use crate::route::build_router;
    use crate::state::build_server_state;
    use axum::Router;
    use axum::body::{Body, Bytes};
    use axum::extract::{Path, State};
    use axum::http::StatusCode;
    use axum::http::header::{CONTENT_LENGTH, CONTENT_TYPE, ETAG, IF_NONE_MATCH, RANGE};
    use axum::response::Response;
    use axum::routing::{get, post};
    use image::{DynamicImage, GenericImageView, ImageBuffer, ImageFormat, Rgb};
    use s3::creds::Credentials;
    use s3::region::Region;
    use serde_json::{Value, json};
    use std::collections::HashMap;
    use std::io::Cursor;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio::sync::Semaphore;
    use tokio::task::JoinHandle;

    const SITE_ID: i64 = 42;
    const PAGE_ID: i64 = 123;
    const PAGE_SLUG: &str = "gallery-page";
    const FILE_NAME: &str = "image.png";

    #[derive(Clone, Debug)]
    enum FileReply {
        Found {
            revision_id: i64,
            mime: &'static str,
            size: i64,
            s3_hash: &'static str,
        },
        Missing,
        Denied,
    }

    #[derive(Debug)]
    struct MockState {
        page_exists: AtomicBool,
        file_reply: Mutex<FileReply>,
        blobs: Mutex<HashMap<String, Vec<u8>>>,
        rpc_requests: Mutex<Vec<Value>>,
        s3_requests: AtomicUsize,
        block_s3: AtomicBool,
        s3_gate: Semaphore,
    }

    impl MockState {
        fn set_page_exists(&self, exists: bool) {
            self.page_exists.store(exists, Ordering::SeqCst);
        }

        fn set_file_reply(&self, reply: FileReply) {
            *self.file_reply.lock().unwrap() = reply;
        }

        fn insert_blob(&self, hash: &str, bytes: Vec<u8>) {
            self.blobs.lock().unwrap().insert(hash.to_owned(), bytes);
        }
    }

    struct TestApp {
        base_url: String,
        client: reqwest::Client,
        mock: Arc<MockState>,
        wws_task: JoinHandle<()>,
        services_task: JoinHandle<()>,
    }

    impl TestApp {
        async fn spawn(source: Vec<u8>) -> Self {
            let mock = Arc::new(MockState {
                page_exists: AtomicBool::new(true),
                file_reply: Mutex::new(FileReply::Found {
                    revision_id: 11,
                    mime: "image/png",
                    size: source.len() as i64,
                    s3_hash: "blob-v1",
                }),
                blobs: Mutex::new(HashMap::from([("blob-v1".to_owned(), source)])),
                rpc_requests: Mutex::new(Vec::new()),
                s3_requests: AtomicUsize::new(0),
                block_s3: AtomicBool::new(false),
                s3_gate: Semaphore::new(0),
            });
            let services = Router::new()
                .route("/", post(mock_rpc))
                .route("/{*path}", get(mock_s3))
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
                client: reqwest::Client::builder()
                    .redirect(reqwest::redirect::Policy::none())
                    .build()
                    .unwrap(),
                mock,
                wws_task,
                services_task,
            }
        }

        fn request(
            &self,
            method: reqwest::Method,
            variant: &str,
        ) -> reqwest::RequestBuilder {
            self.client
                .request(
                    method,
                    format!(
                        "{}/local--resized-images/{PAGE_SLUG}/{FILE_NAME}/{variant}.jpg",
                        self.base_url,
                    ),
                )
                .header(HEADER_SITE_ID.as_str(), SITE_ID.to_string())
                .header("cookie", "unrelated=1; wikijump_token=actor-session")
        }

        fn original_request(&self, method: reqwest::Method) -> reqwest::RequestBuilder {
            self.client
                .request(
                    method,
                    format!("{}/-/file/{PAGE_SLUG}/{FILE_NAME}", self.base_url,),
                )
                .header(HEADER_SITE_ID.as_str(), SITE_ID.to_string())
                .header("cookie", "unrelated=1; wikijump_token=actor-session")
        }
    }

    impl Drop for TestApp {
        fn drop(&mut self) {
            self.wws_task.abort();
            self.services_task.abort();
        }
    }

    async fn mock_rpc(State(state): State<Arc<MockState>>, body: Bytes) -> Response {
        let request: Value = serde_json::from_slice(&body).unwrap();
        let id = request["id"].clone();
        let method = request["method"].as_str().unwrap();
        state.rpc_requests.lock().unwrap().push(request.clone());
        let response = match method {
            "page_get" => json!({
                "jsonrpc": "2.0",
                "result": state.page_exists.load(Ordering::SeqCst).then_some(json!({"page_id": PAGE_ID})),
                "id": id,
            }),
            "file_get" => match state.file_reply.lock().unwrap().clone() {
                FileReply::Found {
                    revision_id,
                    mime,
                    size,
                    s3_hash,
                } => json!({
                    "jsonrpc": "2.0",
                    "result": {
                        "file_id": 7,
                        "revision_id": revision_id,
                        "revision_created_at": "2020-07-23T06:38:39Z",
                        "mime": mime,
                        "size": size,
                        "s3_hash": s3_hash,
                    },
                    "id": id,
                }),
                FileReply::Missing => json!({
                    "jsonrpc": "2.0",
                    "result": null,
                    "id": id,
                }),
                FileReply::Denied => json!({
                    "jsonrpc": "2.0",
                    "error": {"code": 3106, "message": "permission denied"},
                    "id": id,
                }),
            },
            "basic_error_missing_file_name" => json!({
                "jsonrpc": "2.0",
                "result": {"title": "missing", "body": "not found"},
                "id": id,
            }),
            "basic_error_file_fetch" => json!({
                "jsonrpc": "2.0",
                "result": {"title": "fetch error", "body": "file unavailable"},
                "id": id,
            }),
            "basic_error_missing_page_slug" => json!({
                "jsonrpc": "2.0",
                "result": {"title": "missing page", "body": "not found"},
                "id": id,
            }),
            "basic_error_page_fetch" => json!({
                "jsonrpc": "2.0",
                "result": {"title": "page error", "body": "page unavailable"},
                "id": id,
            }),
            other => panic!("unexpected mock JSON-RPC method: {other}"),
        };
        Response::builder()
            .header(CONTENT_TYPE, "application/json")
            .body(Body::from(response.to_string()))
            .unwrap()
    }

    async fn mock_s3(
        State(state): State<Arc<MockState>>,
        Path(path): Path<String>,
    ) -> Response {
        state.s3_requests.fetch_add(1, Ordering::SeqCst);
        if state.block_s3.load(Ordering::SeqCst) {
            let permit = state.s3_gate.acquire().await.unwrap();
            permit.forget();
        }
        let hash = path.rsplit('/').next().unwrap();
        let bytes = state.blobs.lock().unwrap().get(hash).cloned();
        match bytes {
            Some(bytes) => Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, "application/octet-stream")
                .header(CONTENT_LENGTH, bytes.len())
                .body(Body::from(bytes))
                .unwrap(),
            None => Response::builder()
                .status(StatusCode::NOT_FOUND)
                .body(Body::empty())
                .unwrap(),
        }
    }

    fn png(width: u32, height: u32, blue: u8) -> Vec<u8> {
        let image =
            DynamicImage::ImageRgb8(ImageBuffer::from_fn(width, height, |x, y| {
                Rgb([(x % 255) as u8, (y % 255) as u8, blue])
            }));
        let mut output = Cursor::new(Vec::new());
        image.write_to(&mut output, ImageFormat::Png).unwrap();
        output.into_inner()
    }

    fn svg(width: u32, height: u32) -> Vec<u8> {
        format!(
            "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{width}\" height=\"{height}\" viewBox=\"0 0 {width} {height}\"><rect width=\"{width}\" height=\"{height}\" fill=\"#3366cc\"/></svg>"
        )
        .into_bytes()
    }

    fn file_requests(state: &MockState) -> Vec<Value> {
        state
            .rpc_requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request["method"] == "file_get")
            .cloned()
            .collect()
    }

    #[tokio::test]
    async fn public_router_serves_documented_variants_and_cheap_conditional_head() {
        let app = TestApp::spawn(png(800, 400, 17)).await;

        for (variant, dimensions) in [
            ("square", (75, 75)),
            ("thumbnail", (100, 50)),
            ("small", (240, 120)),
            ("medium", (500, 250)),
        ] {
            let response = app
                .request(reqwest::Method::GET, variant)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{variant}");
            assert_eq!(response.headers()[CONTENT_TYPE], "image/jpeg");
            let image = image::load_from_memory_with_format(
                &response.bytes().await.unwrap(),
                ImageFormat::Jpeg,
            )
            .unwrap();
            assert_eq!(image.dimensions(), dimensions, "{variant}");
        }

        let s3_before_head = app.mock.s3_requests.load(Ordering::SeqCst);
        let head = app
            .request(reqwest::Method::HEAD, "thumbnail")
            .send()
            .await
            .unwrap();
        assert_eq!(head.status(), StatusCode::OK);
        assert_eq!(head.headers()[CONTENT_TYPE], "image/jpeg");
        let etag = head.headers()[ETAG].to_str().unwrap().to_owned();
        assert!(head.bytes().await.unwrap().is_empty());
        assert_eq!(app.mock.s3_requests.load(Ordering::SeqCst), s3_before_head);

        let not_modified = app
            .request(reqwest::Method::GET, "thumbnail")
            .header(IF_NONE_MATCH.as_str(), &etag)
            .send()
            .await
            .unwrap();
        assert_eq!(not_modified.status(), StatusCode::NOT_MODIFIED);
        assert!(not_modified.bytes().await.unwrap().is_empty());
        assert_eq!(app.mock.s3_requests.load(Ordering::SeqCst), s3_before_head);

        let requests = file_requests(&app.mock);
        assert!(!requests.is_empty());
        for request in requests {
            assert_eq!(request["params"]["site_id"], SITE_ID);
            assert_eq!(request["params"]["page_id"], PAGE_ID);
            assert_eq!(request["params"]["file"], FILE_NAME);
            assert_eq!(request["params"]["data"], false);
            assert_eq!(request["params"]["session_token"], "actor-session");
        }
    }

    #[tokio::test]
    async fn public_route_accepts_parameterized_image_mime_from_upload_inventory() {
        let source = png(800, 400, 17);
        let app = TestApp::spawn(source.clone()).await;
        app.mock.set_file_reply(FileReply::Found {
            revision_id: 11,
            mime: "image/png; charset=binary",
            size: source.len() as i64,
            s3_hash: "blob-v1",
        });

        let response = app
            .request(reqwest::Method::GET, "thumbnail")
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CONTENT_TYPE], "image/jpeg");
        let image = image::load_from_memory_with_format(
            &response.bytes().await.unwrap(),
            ImageFormat::Jpeg,
        )
        .unwrap();
        assert_eq!(image.dimensions(), (100, 50));
    }

    #[tokio::test]
    async fn public_route_tracks_latest_revision_and_fails_closed_after_rename_or_delete()
    {
        let app = TestApp::spawn(png(800, 400, 17)).await;
        let first = app
            .request(reqwest::Method::GET, "thumbnail")
            .send()
            .await
            .unwrap();
        let first_etag = first.headers()[ETAG].to_str().unwrap().to_owned();
        let first_body = first.bytes().await.unwrap();

        let revised = png(400, 800, 91);
        app.mock.insert_blob("blob-v2", revised.clone());
        app.mock.set_file_reply(FileReply::Found {
            revision_id: 12,
            mime: "image/png",
            size: revised.len() as i64,
            s3_hash: "blob-v2",
        });
        let second = app
            .request(reqwest::Method::GET, "thumbnail")
            .send()
            .await
            .unwrap();
        let second_etag = second.headers()[ETAG].to_str().unwrap().to_owned();
        let second_body = second.bytes().await.unwrap();
        assert_ne!(first_etag, second_etag);
        assert_ne!(first_body, second_body);

        app.mock.set_file_reply(FileReply::Missing);
        let stale_name = app
            .request(reqwest::Method::GET, "thumbnail")
            .send()
            .await
            .unwrap();
        assert_eq!(stale_name.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn original_file_route_rechecks_page_existence_without_the_slug_cache() {
        let app = TestApp::spawn(png(800, 400, 17)).await;
        app.mock.set_page_exists(false);

        let response = app
            .original_request(reqwest::Method::GET)
            .send()
            .await
            .unwrap();

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[CONTENT_TYPE], "text/html; charset=utf-8");
        assert!(
            response
                .text()
                .await
                .unwrap()
                .contains("The file does not exist."),
        );
        let requests = app.mock.rpc_requests.lock().unwrap();
        assert_eq!(requests[0]["method"], "page_get");
        assert_eq!(requests[1]["method"], "basic_error_missing_page_slug");
        assert_eq!(requests.len(), 2);
    }

    #[tokio::test]
    async fn public_route_checks_acl_before_file_details_and_rejects_unsafe_inputs() {
        let app = TestApp::spawn(png(800, 400, 17)).await;

        app.mock.set_file_reply(FileReply::Denied);
        let private = app
            .request(reqwest::Method::GET, "thumbnail")
            .send()
            .await
            .unwrap();
        assert_eq!(private.status(), StatusCode::NOT_FOUND);
        assert_eq!(app.mock.s3_requests.load(Ordering::SeqCst), 0);

        app.mock.set_file_reply(FileReply::Found {
            revision_id: 11,
            mime: "image/bmp",
            size: 128,
            s3_hash: "blob-v1",
        });
        let unsupported_mime = app
            .request(reqwest::Method::GET, "thumbnail")
            .send()
            .await
            .unwrap();
        assert_eq!(unsupported_mime.status(), StatusCode::NOT_FOUND);
        assert_eq!(app.mock.s3_requests.load(Ordering::SeqCst), 0);

        app.mock.set_file_reply(FileReply::Found {
            revision_id: 11,
            mime: "image/png",
            size: 64 * 1024 * 1024,
            s3_hash: "blob-v1",
        });
        let oversized = app
            .request(reqwest::Method::GET, "thumbnail")
            .send()
            .await
            .unwrap();
        assert_eq!(oversized.status(), StatusCode::NOT_FOUND);
        assert_eq!(app.mock.s3_requests.load(Ordering::SeqCst), 0);

        app.mock.insert_blob("malformed", b"not an image".to_vec());
        app.mock.set_file_reply(FileReply::Found {
            revision_id: 12,
            mime: "image/png",
            size: 12,
            s3_hash: "malformed",
        });
        let malformed = app
            .request(reqwest::Method::GET, "thumbnail")
            .send()
            .await
            .unwrap();
        assert_eq!(malformed.status(), StatusCode::NOT_FOUND);

        let over_dimension = png(RESIZED_IMAGE_MAX_DIMENSION + 1, 1, 23);
        app.mock
            .insert_blob("over-dimension", over_dimension.clone());
        app.mock.set_file_reply(FileReply::Found {
            revision_id: 13,
            mime: "image/png",
            size: over_dimension.len() as i64,
            s3_hash: "over-dimension",
        });
        let over_dimension = app
            .request(reqwest::Method::GET, "thumbnail")
            .send()
            .await
            .unwrap();
        assert_eq!(over_dimension.status(), StatusCode::NOT_FOUND);

        let unsupported_variant = app
            .request(reqwest::Method::GET, "giant")
            .send()
            .await
            .unwrap();
        assert_eq!(unsupported_variant.status(), StatusCode::NOT_FOUND);

        let valid = png(800, 400, 17);
        app.mock.insert_blob("blob-v1", valid.clone());
        app.mock.set_file_reply(FileReply::Found {
            revision_id: 11,
            mime: "image/png",
            size: valid.len() as i64,
            s3_hash: "blob-v1",
        });
        let ranged = app
            .request(reqwest::Method::GET, "thumbnail")
            .header(RANGE.as_str(), "bytes=0-9")
            .send()
            .await
            .unwrap();
        assert_eq!(ranged.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    }

    #[tokio::test]
    async fn public_route_rasterizes_svg_sources_to_jpeg_variants() {
        let source = svg(800, 400);
        let app = TestApp::spawn(source.clone()).await;
        app.mock.set_file_reply(FileReply::Found {
            revision_id: 11,
            mime: "image/svg+xml",
            size: source.len() as i64,
            s3_hash: "blob-v1",
        });

        for (variant, dimensions) in [
            ("square", (75, 75)),
            ("thumbnail", (100, 50)),
            ("small", (240, 120)),
            ("medium", (500, 250)),
        ] {
            let response = app
                .request(reqwest::Method::GET, variant)
                .send()
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK, "{variant}");
            assert_eq!(response.headers()[CONTENT_TYPE], "image/jpeg");
            let image = image::load_from_memory_with_format(
                &response.bytes().await.unwrap(),
                ImageFormat::Jpeg,
            )
            .unwrap();
            assert_eq!(image.dimensions(), dimensions, "{variant}");
            let center = image.get_pixel(dimensions.0 / 2, dimensions.1 / 2);
            assert!(
                center[0] < 110 && center[2] > 150,
                "{variant} center pixel should be the SVG fill: {center:?}",
            );
        }
    }

    #[tokio::test]
    async fn public_route_rejects_malformed_and_mismatched_svg_sources() {
        let malformed = b"<svg xmlns=\"http://www.w3.org/2000/svg\"><rect".to_vec();
        let app = TestApp::spawn(malformed.clone()).await;
        app.mock.set_file_reply(FileReply::Found {
            revision_id: 11,
            mime: "image/svg+xml",
            size: malformed.len() as i64,
            s3_hash: "blob-v1",
        });
        let malformed = app
            .request(reqwest::Method::GET, "thumbnail")
            .send()
            .await
            .unwrap();
        assert_eq!(malformed.status(), StatusCode::NOT_FOUND);

        let raster = png(800, 400, 17);
        let app = TestApp::spawn(raster.clone()).await;
        app.mock.set_file_reply(FileReply::Found {
            revision_id: 11,
            mime: "image/svg+xml",
            size: raster.len() as i64,
            s3_hash: "blob-v1",
        });
        let mismatched_mime = app
            .request(reqwest::Method::GET, "thumbnail")
            .send()
            .await
            .unwrap();
        assert_eq!(mismatched_mime.status(), StatusCode::NOT_FOUND);

        let app = TestApp::spawn(svg(800, 400)).await;
        let mismatched_bytes = app
            .request(reqwest::Method::GET, "thumbnail")
            .send()
            .await
            .unwrap();
        assert_eq!(mismatched_bytes.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn rasterize_svg_uses_view_box_size_and_enforces_dimension_limits() {
        let view_box_only = b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 300 150\"><rect width=\"300\" height=\"150\" fill=\"#3366cc\"/></svg>";
        let image = super::rasterize_svg(view_box_only).unwrap();
        assert_eq!(image.dimensions(), (300, 150));

        let oversized = svg(RESIZED_IMAGE_MAX_DIMENSION + 1, 10);
        assert!(super::rasterize_svg(&oversized).is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn public_route_caps_concurrent_decode_work() {
        let app = Arc::new(TestApp::spawn(png(800, 400, 17)).await);
        app.mock.block_s3.store(true, Ordering::SeqCst);

        let first = {
            let app = Arc::clone(&app);
            tokio::spawn(async move {
                app.request(reqwest::Method::GET, "small")
                    .send()
                    .await
                    .unwrap()
            })
        };
        let second = {
            let app = Arc::clone(&app);
            tokio::spawn(async move {
                app.request(reqwest::Method::GET, "medium")
                    .send()
                    .await
                    .unwrap()
            })
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            while app.mock.s3_requests.load(Ordering::SeqCst) < 2 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("two resize jobs should reach the blocked source fetch");

        let saturated = tokio::time::timeout(
            Duration::from_secs(2),
            app.request(reqwest::Method::GET, "thumbnail").send(),
        )
        .await
        .expect("a saturated resize job must fail without queueing")
        .unwrap();
        assert_eq!(saturated.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(app.mock.s3_requests.load(Ordering::SeqCst), 2);

        app.mock.s3_gate.add_permits(2);
        assert_eq!(first.await.unwrap().status(), StatusCode::OK);
        assert_eq!(second.await.unwrap().status(), StatusCode::OK);
    }
}
