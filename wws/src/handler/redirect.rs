/*
 * handler/redirect.rs
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

use super::get_site_id;
use crate::path::get_path;
use crate::state::ServerState;
use axum::extract::{Path, State};
use axum::http::Uri;
use axum::http::header::HeaderMap;
use axum::response::{IntoResponse, Redirect, Response};

pub async fn redirect_to_main(
    State(state): State<ServerState>,
    headers: HeaderMap,
    uri: Uri,
) -> Response {
    if let Some(destination) = local_code_underscore_redirect(uri.path()) {
        return Redirect::permanent(&destination).into_response();
    }
    let site_id = get_site_id(&headers);
    let path = get_path(&uri);
    let domain = try_response!(state.get_site_domain_or_response(site_id));
    let destination = format!("https://{domain}{path}");
    Redirect::permanent(&destination).into_response()
}

/// Wikidot serves hosted code blocks under two spellings of the same
/// route: `/local--code/<page>/<n>`, which the router registers, and
/// `/local--code_/<page>/<n>`, the spelling theme stylesheets use in
/// `@import` rules and page scripts use in `fetch()` calls (observed live
/// 2026-11-01: `GET https://scp-jp.wdfiles.com/local--code_/credit%3Astyle/1`
/// answers 200 with the block's CSS).
///
/// Maps the underscore spelling onto the internal code route the plain
/// spelling's handler redirects to, preserving both path segments
/// verbatim; the code route decodes them the same way for either
/// spelling, so both spellings resolve to the same block. Only the exact
/// two-segment shape is mapped, mirroring the registered route. No other
/// `local--*_` spelling is mapped: the Standing corpora contain no
/// authored use of one (the only `local--files_` occurrences are
/// percent-encoding artifacts), so there is nothing to map them to.
fn local_code_underscore_redirect(path: &str) -> Option<String> {
    let rest = path.strip_prefix("/local--code_/")?;
    let (page_slug, index) = rest.split_once('/')?;
    if page_slug.is_empty() || index.is_empty() || index.contains('/') {
        return None;
    }
    Some(format!("/-/code/{page_slug}/{index}"))
}

pub async fn handle_code_redirect(
    Path((page_slug, index)): Path<(String, String)>,
) -> Redirect {
    let destination = format!("/-/code/{page_slug}/{index}");
    Redirect::permanent(&destination)
}

pub async fn handle_default_code_redirect(Path(page_slug): Path<String>) -> Redirect {
    let destination = format!("/-/code/{page_slug}/1");
    Redirect::permanent(&destination)
}

pub async fn handle_html_redirect(
    Path((page_slug, id)): Path<(String, String)>,
) -> Redirect {
    let destination = format!("/-/html/{page_slug}/{id}");
    Redirect::permanent(&destination)
}

pub async fn handle_file_redirect(
    Path((page_slug, filename)): Path<(String, String)>,
) -> Redirect {
    let destination = format!("/-/file/{page_slug}/{filename}");
    Redirect::permanent(&destination)
}

pub async fn handle_download_redirect(
    Path((page_slug, filename)): Path<(String, String)>,
) -> Redirect {
    let destination = format!("/-/download/{page_slug}/{filename}");
    Redirect::permanent(&destination)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::StatusCode;
    use axum::http::header::LOCATION;

    fn assert_permanent_redirect(response: Response, destination: &str) {
        assert_eq!(response.status(), StatusCode::PERMANENT_REDIRECT);
        assert_eq!(response.headers().get(LOCATION).unwrap(), destination);
    }

    #[tokio::test]
    async fn code_redirect_targets_internal_code_route() {
        assert_permanent_redirect(
            handle_code_redirect(Path(("scp-173".into(), "2".into())))
                .await
                .into_response(),
            "/-/code/scp-173/2",
        );
    }

    #[tokio::test]
    async fn html_redirect_targets_internal_html_route() {
        assert_permanent_redirect(
            handle_html_redirect(Path(("scp-173".into(), "4".into())))
                .await
                .into_response(),
            "/-/html/scp-173/4",
        );
    }

    #[tokio::test]
    async fn file_redirect_targets_internal_file_route() {
        assert_permanent_redirect(
            handle_file_redirect(Path(("scp-173".into(), "image.png".into())))
                .await
                .into_response(),
            "/-/file/scp-173/image.png",
        );
    }

    #[test]
    fn local_code_underscore_redirect_maps_the_underscore_spelling() {
        assert_eq!(
            local_code_underscore_redirect("/local--code_/credit%3Astyle/1").as_deref(),
            Some("/-/code/credit%3Astyle/1"),
        );
        assert_eq!(
            local_code_underscore_redirect("/local--code_/scp-173/2").as_deref(),
            Some("/-/code/scp-173/2"),
        );
    }

    #[test]
    fn local_code_underscore_redirect_leaves_other_paths_to_the_main_redirect() {
        assert_eq!(
            local_code_underscore_redirect("/local--code/scp-173/2"),
            None
        );
        assert_eq!(
            local_code_underscore_redirect("/local--files_/scp-173/a.png"),
            None
        );
        assert_eq!(
            local_code_underscore_redirect("/local--html_/scp-173/1"),
            None
        );
        assert_eq!(
            local_code_underscore_redirect("/local--code_/scp-173"),
            None
        );
        assert_eq!(
            local_code_underscore_redirect("/local--code_/scp-173/"),
            None
        );
        assert_eq!(local_code_underscore_redirect("/local--code_//1"), None);
        assert_eq!(
            local_code_underscore_redirect("/local--code_/scp-173/1/extra"),
            None
        );
        assert_eq!(local_code_underscore_redirect("/scp-173"), None);
    }

    #[tokio::test]
    async fn download_redirect_targets_internal_download_route() {
        assert_permanent_redirect(
            handle_download_redirect(Path(("scp-173".into(), "image.png".into())))
                .await
                .into_response(),
            "/-/download/scp-173/image.png",
        );
    }
}
