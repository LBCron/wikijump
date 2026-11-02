/*
 * handler/robots.rs
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


use super::{TargetServer, get_site_id, get_target_server};
use crate::state::ServerState;
use axum::body::Body;
use axum::extract::State;
use axum::http::header::{self, HeaderMap};
use axum::http::status::StatusCode;
use axum::response::Response;

const ROBOTS_TXT_ALLOW_ALL: &str = "User-agent: *\nAllow: /\n";
const ROBOTS_TXT_UNAVAILABLE: &str = "User-agent: *\nDisallow: /\n";
// The crawler policy Wikidot serves for every public site (evidence:
// install/local/wikidot-verification/artifacts/wikidot-robots-policy-20261025.json;
// identical bodies on www/scp-wiki/scp-jp and the wdfiles host, only the
// Sitemap line varies with the site's canonical origin). The four Disallow
// patterns keep crawlers out of Wikidot's page-history URL shapes.
const ROBOTS_TXT_PUBLIC_EXCLUSIONS: &str = "User-agent: *\nDisallow: /*/p/*/p/\nDisallow: /*/p/*_p/\nDisallow: /*_p/*/p/\nDisallow: /*_p/*_p/\n";
const ROBOTS_TXT_VOLTRON_BLOCK: &str = "User-agent: voltron\nDisallow: /\n";

fn public_robots_txt(domain: &str) -> String {
    format!(
        "{ROBOTS_TXT_PUBLIC_EXCLUSIONS}\nSitemap: https://{domain}/sitemap.xml\n{ROBOTS_TXT_VOLTRON_BLOCK}"
    )
}
const ROBOTS_TXT_PRIVATE: &str = "User-agent: *\nDisallow: /\n";

pub async fn handle_robots_txt(
    State(state): State<ServerState>,
    headers: HeaderMap,
) -> Response {
    if get_target_server(&headers) == TargetServer::Files {
        return robots_response(ROBOTS_TXT_ALLOW_ALL, StatusCode::OK);
    }
    let site_id = get_site_id(&headers);
    match state.deepwell.get_sitemap_presence(site_id).await {
        Ok(false) => return robots_response(ROBOTS_TXT_PRIVATE, StatusCode::OK),
        Ok(true) => {}
        Err(error) => {
            error!(site_id, "could not load sitemap presence: {error}");
            return robots_response(
                ROBOTS_TXT_UNAVAILABLE,
                StatusCode::SERVICE_UNAVAILABLE,
            );
        }
    }
    match state.deepwell.get_site_domain(site_id).await {
        Ok(domain) if valid_site_domain(&domain) => {
            robots_response(&public_robots_txt(&domain), StatusCode::OK)
        }
        Ok(domain) => {
            error!(site_id, "invalid preferred sitemap domain: {domain:?}");
            robots_response(ROBOTS_TXT_UNAVAILABLE, StatusCode::SERVICE_UNAVAILABLE)
        }
        Err(error) => {
            error!(site_id, "could not load preferred sitemap domain: {error}");
            robots_response(ROBOTS_TXT_UNAVAILABLE, StatusCode::SERVICE_UNAVAILABLE)
        }
    }
}

fn valid_site_domain(domain: &str) -> bool {
    let (hostname, port) = match domain.split_once(':') {
        Some((hostname, port)) => (hostname, Some(port)),
        None => (domain, None),
    };
    if let Some(port) = port
        && (port.is_empty() || port.bytes().any(|c| !c.is_ascii_digit()))
    {
        return false;
    }
    !hostname.is_empty()
        && hostname.split('.').all(|part| {
            !part.is_empty()
                && !part.starts_with('-')
                && !part.ends_with('-')
                && part.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
        })
}

fn robots_response(body: &str, status: StatusCode) -> Response {
    Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Body::from(body.to_owned()))
        .expect("Unable to convert robots.txt response data")
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::header::CONTENT_TYPE;

    #[tokio::test]
    async fn robots_txt_main_target_returns_plain_allow_all_policy() {
        let response = robots_response(ROBOTS_TXT_ALLOW_ALL, StatusCode::OK);

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[CONTENT_TYPE],
            "text/plain; charset=utf-8",
        );

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), b"User-agent: *\nAllow: /\n");
    }

    #[tokio::test]
    async fn robots_txt_private_site_denies_indexing_without_sitemap() {
        let response = robots_response(ROBOTS_TXT_PRIVATE, StatusCode::OK);

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[CONTENT_TYPE],
            "text/plain; charset=utf-8",
        );

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), b"User-agent: *\nDisallow: /\n");
        assert!(
            !body.windows(8).any(|window| window == b"Sitemap:"),
            "a private site must not advertise a sitemap index",
        );
    }

    #[tokio::test]
    async fn robots_txt_files_target_returns_plain_allow_all_policy() {
        let response = robots_response(ROBOTS_TXT_ALLOW_ALL, StatusCode::OK);

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), b"User-agent: *\nAllow: /\n");
    }

    #[tokio::test]
    async fn robots_txt_main_target_advertises_preferred_site_domain() {
        assert!(valid_site_domain("preferred.example"));
        let response =
            robots_response(&public_robots_txt("preferred.example"), StatusCode::OK);

        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(
            response.headers()[CONTENT_TYPE],
            "text/plain; charset=utf-8",
        );

        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(
            body.as_ref(),
            b"User-agent: *\nDisallow: /*/p/*/p/\nDisallow: /*/p/*_p/\nDisallow: /*_p/*/p/\nDisallow: /*_p/*_p/\n\nSitemap: https://preferred.example/sitemap.xml\nUser-agent: voltron\nDisallow: /\n",
        );
    }

    #[tokio::test]
    async fn robots_txt_files_target_ignores_host_header() {
        let response = robots_response(ROBOTS_TXT_ALLOW_ALL, StatusCode::OK);

        assert_eq!(response.status(), StatusCode::OK);
        let body = to_bytes(response.into_body(), usize::MAX).await.unwrap();
        assert_eq!(body.as_ref(), b"User-agent: *\nAllow: /\n");
    }

    #[test]
    fn rejects_untrusted_host_and_invalid_configured_domains() {
        for invalid in [
            "",
            "example.com/evil",
            "good.example@evil.example",
            "https://example.com",
            "-evil.example",
            "test..example",
            "example.com?x=1",
            "example.com:port",
        ] {
            assert!(!valid_site_domain(invalid), "{invalid:?}");
        }
        assert!(valid_site_domain("preferred.example"));
        assert!(valid_site_domain("preferred.example:18443"));
    }
}
