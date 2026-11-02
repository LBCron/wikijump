/*
 * services/render/compat/wikidot_embed_video.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
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

use super::super::service::{RenderService, escape_list_pages_html_attr};
use ftml::render::html::HtmlOutput;
use quick_xml::{Reader, events::Event};
use reqwest::Url;
use std::collections::HashSet;

const WIKIDOT_EMBED_VIDEO_MARKER: &str = "wj-embed-video";
const WIKIDOT_EMBED_VIDEO_NO_MATCH: &str =
    r#"<div class="error-block">Sorry, no match for the embedded content.</div>"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaProvider {
    Acast,
    YouTube,
}

impl RenderService {
    pub(in crate::services::render) fn resolve_wikidot_embed_video_requirements(
        html_output: &mut HtmlOutput,
    ) -> bool {
        let mut requirement_ids = HashSet::new();
        let mut resolved = String::with_capacity(html_output.body.len());
        let mut cursor = 0;

        for requirement in &html_output.resource_requirements {
            let Some(requirement) = requirement.embed_video_requirement() else {
                continue;
            };
            let id = requirement.id();
            if !requirement_ids.insert(id) {
                return false;
            }

            let marker =
                format!(r#"<div class="{WIKIDOT_EMBED_VIDEO_MARKER}" id="{id}"></div>"#,);
            let Some(relative_start) = html_output.body[cursor..].find(&marker) else {
                return false;
            };
            let marker_start = cursor + relative_start;
            resolved.push_str(&html_output.body[cursor..marker_start]);
            let replacement =
                render_allowlisted_media(requirement.embed_video().payload())
                    .unwrap_or_else(|| WIKIDOT_EMBED_VIDEO_NO_MATCH.to_owned());
            resolved.push_str(&replacement);
            cursor = marker_start + marker.len();
        }

        resolved.push_str(&html_output.body[cursor..]);
        let unresolved_marker_prefix =
            format!(r#"<div class="{WIKIDOT_EMBED_VIDEO_MARKER}""#);
        if resolved.contains(&unresolved_marker_prefix) {
            return false;
        }

        html_output.body = resolved;
        true
    }
}

fn render_allowlisted_media(payload: &str) -> Option<String> {
    let attributes = parse_single_iframe(payload)?;
    let src = attributes
        .iter()
        .find_map(|(key, value)| (key == "src").then_some(value.as_str()))?;
    let url = Url::parse(src).ok()?;
    if url.as_str() != src {
        return None;
    }
    let provider = media_provider(&url)?;
    let attributes = validate_media_attributes(attributes, &url, provider)?;

    let mut iframe = String::from("<p><iframe");
    for (key, value) in attributes {
        iframe.push(' ');
        iframe.push_str(&key);
        iframe.push_str("=\"");
        iframe.push_str(&escape_list_pages_html_attr(&value));
        iframe.push('"');
    }
    iframe.push_str("></iframe></p>");
    Some(iframe)
}

fn parse_single_iframe(payload: &str) -> Option<Vec<(String, String)>> {
    let mut reader = Reader::from_str(payload.trim());
    let Event::Start(start) = reader.read_event().ok()? else {
        return None;
    };
    if !start.name().as_ref().eq_ignore_ascii_case("iframe") {
        return None;
    }

    let mut attributes = Vec::new();
    for attribute in start.html_attributes() {
        let attribute = attribute.ok()?;
        let key = attribute.key.as_ref().to_ascii_lowercase();
        if key.starts_with("on") || attributes.iter().any(|(seen, _)| seen == &key) {
            return None;
        }
        let value = attribute.value.as_ref().to_owned();
        attributes.push((key, value));
    }

    let Event::End(end) = reader.read_event().ok()? else {
        return None;
    };
    if !end.name().as_ref().eq_ignore_ascii_case("iframe") {
        return None;
    }
    if !matches!(reader.read_event().ok()?, Event::Eof) {
        return None;
    }
    Some(attributes)
}

fn media_provider(url: &Url) -> Option<MediaProvider> {
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return None;
    }

    match url.host_str()? {
        "www.youtube.com" if valid_youtube_url(url) => Some(MediaProvider::YouTube),
        "embed.acast.com" if valid_acast_url(url) => Some(MediaProvider::Acast),
        _ => None,
    }
}

fn valid_youtube_url(url: &Url) -> bool {
    let Some(id) = url.path().strip_prefix("/embed/") else {
        return false;
    };
    id.len() == 11
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        && url.query().is_none()
}

fn valid_acast_url(url: &Url) -> bool {
    let Some(path) = url.path().strip_prefix('/') else {
        return false;
    };
    let segments = path.split('/').collect::<Vec<_>>();
    if !(segments.len() == 1 || segments.len() == 2)
        || segments.iter().any(|segment| {
            segment.len() != 24
                || !segment
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        })
    {
        return false;
    }

    let query = url
        .query_pairs()
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect::<Vec<_>>();
    match query.as_slice() {
        [] => url.query().is_none(),
        [(order_key, order)] => {
            order_key == "episode-order" && matches!(order.as_str(), "asc" | "desc")
        }
        [(order_key, order), (feed_key, feed)] => {
            order_key == "episode-order"
                && matches!(order.as_str(), "asc" | "desc")
                && feed_key == "feed"
                && feed == "true"
        }
        _ => false,
    }
}

fn validate_media_attributes(
    attributes: Vec<(String, String)>,
    url: &Url,
    provider: MediaProvider,
) -> Option<Vec<(String, String)>> {
    let mut has_src = false;
    let mut has_width = false;
    let mut has_height = false;
    let mut has_frameborder = false;
    let mut has_allowfullscreen = false;
    let mut output = Vec::with_capacity(attributes.len());

    for (key, value) in attributes {
        let value = match key.as_str() {
            "src" => {
                has_src = true;
                url.as_str().to_owned()
            }
            "width" if safe_media_dimension(&value) => {
                has_width = true;
                value
            }
            "height" if safe_media_dimension(&value) => {
                has_height = true;
                value
            }
            "frameborder" if value == "0" => {
                has_frameborder = true;
                value
            }
            "allowfullscreen"
                if provider == MediaProvider::YouTube && value.is_empty() =>
            {
                has_allowfullscreen = true;
                "allowfullscreen".to_owned()
            }
            "title" => value,
            "allow" if valid_media_allow_list(&value) => value,
            "referrerpolicy" if valid_referrer_policy(&value) => value,
            _ => return None,
        };
        output.push((key, value));
    }

    if !has_src || !has_width || !has_height || !has_frameborder {
        return None;
    }
    if provider == MediaProvider::YouTube && !has_allowfullscreen {
        return None;
    }
    Some(output)
}

const MEDIA_ALLOW_FEATURES: &[&str] = &[
    "accelerometer",
    "autoplay",
    "clipboard-write",
    "encrypted-media",
    "fullscreen",
    "gyroscope",
    "modestbranding",
    "picture-in-picture",
    "rel",
    "web-share",
];

fn valid_media_allow_list(value: &str) -> bool {
    !value.is_empty()
        && value.split(';').all(|token| {
            let token = token.trim();
            let (feature, granted) = match token.split_once('=') {
                Some((feature, granted)) => (feature.trim(), Some(granted.trim())),
                None => (token, None),
            };
            !feature.is_empty()
                && MEDIA_ALLOW_FEATURES.contains(&feature)
                && granted.is_none_or(|granted| {
                    !granted.is_empty()
                        && granted.bytes().all(|byte| {
                            byte.is_ascii_alphanumeric()
                                || matches!(byte, b'.' | b'-' | b'_')
                        })
                })
        })
}

fn valid_referrer_policy(value: &str) -> bool {
    matches!(
        value,
        "no-referrer"
            | "no-referrer-when-downgrade"
            | "origin"
            | "origin-when-cross-origin"
            | "same-origin"
            | "strict-origin"
            | "strict-origin-when-cross-origin"
            | "unsafe-url"
    )
}

fn safe_media_dimension(value: &str) -> bool {
    let (digits, maximum) = if let Some(digits) = value.strip_suffix("px") {
        (digits, 4096)
    } else if let Some(digits) = value.strip_suffix('%') {
        (digits, 100)
    } else {
        (value, 4096)
    };
    !digits.is_empty()
        && digits.bytes().all(|byte| byte.is_ascii_digit())
        && digits
            .parse::<u16>()
            .is_ok_and(|dimension| (1..=maximum).contains(&dimension))
}
