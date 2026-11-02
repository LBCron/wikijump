/*
 * services/render/wikidot_embed.rs
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

use super::super::service::RenderService;
use super::CompatHtmlFragments;
use regex::Regex;
use std::sync::LazyLock;

const WIKIDOT_EMBED_IFRAME_SENTINEL_PREFIX: &str = "WIKIJUMPWIKIDOTEMBEDIFRAME";
const WIKIDOT_LOCAL_INTERWIKI_BASE: &str = "/-/wikidot-interwiki";

static WIKIDOT_RAW_EMBED_IFRAME_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?is)\[\[embed\]\]\s*(?P<iframe><iframe\b[^>]*></iframe>)\s*\[\[/embed\]\]"#,
    )
    .unwrap()
});
static WIKIDOT_NAME_ONLY_IFRAME_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"^<iframe name="[A-Za-z][A-Za-z0-9_:-]{0,127}"></iframe>$"#).unwrap()
});
static LISTPAGES_DYNAMIC_EMBED_OPENER_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
            r#"(?im)^(?P<indent>[ \t>]*)\[\[%%content(?:\{[0-9]+\})?%%(?P<block>embed|embedaudio)\]\][ \t]*$"#,
        )
        .unwrap()
});
static WIKIDOT_EMBED_BLOCK_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?is)\[\[(?P<block>embed|embedaudio)\]\](?P<payload>.*?)\[\[/(?P<close>embed|embedaudio)\]\]"#,
    )
    .unwrap()
});
const WIKIDOT_EMBED_NO_MATCH_HTML: &str =
    r#"<div class="error-block">Sorry, no match for the embedded content.</div>"#;

#[cfg(test)]
use std::cell::Cell;

#[cfg(test)]
thread_local! {
    static WIKIDOT_EMBED_RESTORE_SCANNED_BYTES: Cell<usize> = const { Cell::new(0) };
}

#[inline]
fn record_wikidot_embed_restore_scanned_bytes(bytes: usize) {
    #[cfg(test)]
    WIKIDOT_EMBED_RESTORE_SCANNED_BYTES.with(|total| {
        total.set(total.get().saturating_add(bytes));
    });
    #[cfg(not(test))]
    let _ = bytes;
}

#[cfg(test)]
fn take_wikidot_embed_restore_scanned_bytes() -> usize {
    WIKIDOT_EMBED_RESTORE_SCANNED_BYTES.with(|total| total.replace(0))
}

static WIKIDOT_RENDERED_ANCHOR_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?s)<a href="[^"]+">(.*?)</a>"#).unwrap());
static WIKIDOT_STYLEFRAME_IFRAME_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^<iframe src="(?P<src>//interwiki\.(?:scpwiki\.com|scp-jp\.org|scpwikicn\.com)/styleFrame\.html\?[^"]+)" style="display: none"></iframe>$"#,
    )
    .unwrap()
});
static WIKIDOT_INTERWIKI_FRAME_IFRAME_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^<iframe src="(?P<src>//interwiki\.(?:scpwiki\.com|scp-jp\.org|scpwikicn\.com)/interwikiFrame\.html\?[^"]+)" allowtransparency="true" class="html-block-iframe scpnet-interwiki-frame"></iframe>$"#,
    )
    .unwrap()
});
static WIKIDOT_INTERWIKI_SRC_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"^(?:https?:)?//interwiki\.(?:scpwiki\.com|scp-jp\.org|scpwikicn\.com)/(?P<file>interwikiFrame|styleFrame)\.html(?:\?(?P<query>[^"]*))?$"#,
    )
    .unwrap()
});

impl RenderService {
    pub(in crate::services::render) fn protect_list_pages_wikidot_embed_iframes(
        wikitext: &mut String,
        compat_html: &mut CompatHtmlFragments,
    ) {
        if wikitext.contains("%%content") {
            *wikitext = LISTPAGES_DYNAMIC_EMBED_OPENER_REGEX
                .replace_all(wikitext, "${indent}[[${block}]]")
                .into_owned();
        }
        let iframes = Self::protect_wikidot_embed_iframes(wikitext);
        let trusted_iframes = iframes
            .into_iter()
            .map(|iframe| {
                if iframe == WIKIDOT_EMBED_NO_MATCH_HTML {
                    compat_html.push_block_html_allowing_span_parent(iframe)
                } else {
                    compat_html.push_html(iframe)
                }
            })
            .collect::<Vec<_>>();
        *wikitext =
            replace_wikidot_embed_markers(std::mem::take(wikitext), &trusted_iframes);
    }

    pub(in crate::services::render) fn protect_wikidot_embed_iframes(
        wikitext: &mut String,
    ) -> Vec<String> {
        let mut iframes = Vec::new();
        let source = wikitext.as_str();
        let protected = WIKIDOT_EMBED_BLOCK_REGEX
            .replace_all(source, |captures: &regex::Captures<'_>| {
                let Some(matched) = captures.get(0) else {
                    return String::new();
                };
                let whole = matched.as_str();
                if Self::is_inside_wikidot_literal_region(source, matched.start()) {
                    return whole.to_owned();
                }
                let opened = captures.name("block").map(|matched| matched.as_str());
                let closed = captures.name("close").map(|matched| matched.as_str());
                if opened != closed {
                    return whole.to_owned();
                }
                let rendered = Self::allowed_wikidot_embed_iframe_block(whole)
                    .unwrap_or_else(|| WIKIDOT_EMBED_NO_MATCH_HTML.to_owned());

                let marker =
                    format!("{WIKIDOT_EMBED_IFRAME_SENTINEL_PREFIX}{}X", iframes.len());
                iframes.push(rendered);
                marker
            })
            .into_owned();
        *wikitext = protected;
        iframes
    }

    pub(in crate::services::render) fn neutralize_untrusted_wikidot_styleframe_embeds(
        wikitext: &mut String,
    ) {
        *wikitext = WIKIDOT_RAW_EMBED_IFRAME_REGEX
            .replace_all(wikitext, |captures: &regex::Captures<'_>| {
                let whole = captures.get(0).map_or("", |matched| matched.as_str());
                let Some(iframe) =
                    captures.name("iframe").map(|matched| matched.as_str())
                else {
                    return whole.to_owned();
                };
                if !WIKIDOT_STYLEFRAME_IFRAME_REGEX.is_match(iframe.trim()) {
                    return whole.to_owned();
                }

                let Some(open_end) = iframe.find('>') else {
                    return whole.to_owned();
                };
                let mut neutralized = String::with_capacity(
                    iframe.len() + r#" data-wikijump-styleframe-suppressed="1""#.len(),
                );
                neutralized.push_str(&iframe[..open_end]);
                neutralized.push_str(r#" data-wikijump-styleframe-suppressed="1""#);
                neutralized.push_str(&iframe[open_end..]);
                whole.replace(iframe, &neutralized)
            })
            .into_owned();
    }

    fn allowed_wikidot_embed_iframe_block(block: &str) -> Option<String> {
        let captures = WIKIDOT_RAW_EMBED_IFRAME_REGEX.captures(block)?;
        let iframe = captures.name("iframe")?.as_str().trim();
        Self::allowed_wikidot_embed_iframe(iframe)
    }

    pub(in crate::services::render) fn restore_protected_wikidot_embed_iframes(
        html: String,
        iframes: &[String],
    ) -> String {
        if iframes.is_empty() || !html.contains(WIKIDOT_EMBED_IFRAME_SENTINEL_PREFIX) {
            return html;
        }

        record_wikidot_embed_restore_scanned_bytes(html.len());
        let markers = collect_wikidot_embed_markers(&html, iframes.len());
        if markers.is_empty() {
            return html;
        }
        let paragraphs = collect_wikidot_embed_paragraphs(&html);
        let mut output = String::with_capacity(html.len());
        let mut source_cursor = 0;
        let mut suppressed_paragraph_end = None;

        for marker in markers {
            append_wikidot_embed_source_range(
                &html,
                &mut source_cursor,
                marker.start,
                &mut output,
                &mut suppressed_paragraph_end,
            );
            let iframe = &iframes[marker.index];
            if iframe == WIKIDOT_EMBED_NO_MATCH_HTML
                && restore_wikidot_embed_error_paragraph(
                    &mut output,
                    &marker,
                    &paragraphs,
                    &mut suppressed_paragraph_end,
                )
            {
                source_cursor = marker.end;
                continue;
            }
            output.push_str(iframe);
            source_cursor = marker.end;
        }

        append_wikidot_embed_source_range(
            &html,
            &mut source_cursor,
            html.len(),
            &mut output,
            &mut suppressed_paragraph_end,
        );
        output
    }

    pub(in crate::services::render) fn allowed_wikidot_embed_iframe(
        iframe: &str,
    ) -> Option<String> {
        if WIKIDOT_NAME_ONLY_IFRAME_REGEX.is_match(iframe) {
            return Some(iframe.to_owned());
        }
        if let Some(captures) = WIKIDOT_STYLEFRAME_IFRAME_REGEX.captures(iframe) {
            return Some(Self::rewrite_wikidot_interwiki_iframe_src(
                iframe,
                &captures["src"],
                "styleFrame.html",
            ));
        }

        if let Some(captures) = WIKIDOT_INTERWIKI_FRAME_IFRAME_REGEX.captures(iframe) {
            return Some(Self::rewrite_wikidot_interwiki_iframe_src(
                iframe,
                &captures["src"],
                "interwikiFrame.html",
            ));
        }

        None
    }

    fn rewrite_wikidot_interwiki_iframe_src(
        iframe: &str,
        original_src: &str,
        local_file_name: &str,
    ) -> String {
        let query = original_src.split_once('?').map_or("", |(_, query)| query);
        let local_src =
            format!("{WIKIDOT_LOCAL_INTERWIKI_BASE}/{local_file_name}?{query}");

        iframe.replace(original_src, &local_src)
    }

    /// The frame a saved `[[html]]` block holds when the block carries one
    /// of the SCPnet interwiki frames, emitted through the local interwiki
    /// routes instead of the hosted html-block wrapper.
    ///
    /// `[[embed]]`-carried frames are rewritten by
    /// [`Self::allowed_wikidot_embed_iframe`]. A `[[html]]`-carried frame
    /// would otherwise be served from the hosted wrapper, which cannot
    /// populate the other-languages box, and an import may have replaced
    /// the stored frame source with an empty inline document, so the box
    /// would stay empty even once it is served.
    ///
    /// Two source shapes are recognized. The live Wikidot source keeps its
    /// query, except that `pagename` binds to the page being viewed, as on
    /// Wikidot, where the sidebar frame reports the viewed page regardless
    /// of which component page carries the block. The neutralized source an
    /// import substituted — an inline `data:` document — carries nothing
    /// to recover, so the frame is identified by its surviving authored
    /// attributes and its target is rebuilt from the render's own page and
    /// language.
    pub(in crate::services::render) fn wikidot_html_block_interwiki_iframe(
        html_block: &str,
        root_page_full_slug: &str,
        page_language: &str,
    ) -> Option<String> {
        let parsed = Self::parse_wikidot_html_block_iframe(html_block)?;
        if parsed.attribute_count("src") != 1 {
            return None;
        }
        let src = parsed.attribute_value("src")?;

        if let Some(captures) = WIKIDOT_INTERWIKI_SRC_REGEX.captures(src) {
            let file = captures
                .name("file")
                .expect("interwiki source capture has file")
                .as_str();
            let local_src = if file == "interwikiFrame" {
                Self::wikidot_interwiki_frame_src(
                    captures.name("query").map(|query| query.as_str()),
                    root_page_full_slug,
                )
            } else {
                let query = captures
                    .name("query")
                    .map(|query| format!("?{}", query.as_str()))
                    .unwrap_or_default();
                format!("{WIKIDOT_LOCAL_INTERWIKI_BASE}/styleFrame.html{query}")
            };
            return Some(parsed.iframe.replace(src, &local_src));
        }

        if !src.to_ascii_lowercase().starts_with("data:") {
            return None;
        }

        // The visible frame keeps the SCPnet component's class. The SCPnet
        // component serves the SCP community's branches, so the rebuilt
        // frame addresses that community.
        let class = parsed.attribute_value("class").unwrap_or("");
        if class
            .split_whitespace()
            .any(|token| token == "scpnet-interwiki-frame")
        {
            let query = format!(
                "lang={}&community=scp&pagename={}",
                Self::wikidot_interwiki_language(page_language),
                Self::escape_wikidot_interwiki_pagename(root_page_full_slug),
            );
            let local_src =
                format!("{WIKIDOT_LOCAL_INTERWIKI_BASE}/interwikiFrame.html?{query}");
            return Some(parsed.iframe.replace(src, &local_src));
        }

        // The hidden style frame is exactly an iframe with a `src` and a
        // `display: none` style; its authored parameters went away with
        // the neutralized source, and the local style frame route serves
        // a fixed document that takes no parameters.
        let style = parsed.attribute_value("style")?;
        let compact_style: String = style
            .chars()
            .filter(|character| !character.is_whitespace())
            .collect();
        if parsed.attributes.len() == 2
            && parsed.attribute_value("class").is_none()
            && compact_style.to_ascii_lowercase().contains("display:none")
        {
            let local_src = format!("{WIKIDOT_LOCAL_INTERWIKI_BASE}/styleFrame.html");
            return Some(parsed.iframe.replace(src, &local_src));
        }

        None
    }

    fn wikidot_interwiki_frame_src(
        query: Option<&str>,
        root_page_full_slug: &str,
    ) -> String {
        let pagename = Self::escape_wikidot_interwiki_pagename(root_page_full_slug);
        let mut parameters: Vec<String> = query
            .unwrap_or("")
            .split('&')
            .filter(|parameter| !parameter.is_empty())
            .map(str::to_owned)
            .collect();
        let mut bound = false;
        for parameter in &mut parameters {
            if parameter == "pagename" || parameter.starts_with("pagename=") {
                *parameter = format!("pagename={pagename}");
                bound = true;
            }
        }
        if !bound {
            parameters.push(format!("pagename={pagename}"));
        }
        format!(
            "{WIKIDOT_LOCAL_INTERWIKI_BASE}/interwikiFrame.html?{}",
            parameters.join("&"),
        )
    }

    /// The interwiki branch code for an FTML page language. The frame
    /// routes key their language branches by Wikidot's site codes, which
    /// differ from the FTML locale codes for a few languages.
    fn wikidot_interwiki_language(page_language: &str) -> &str {
        match page_language {
            "ja" => "jp",
            "zh" => "cn",
            "vi" => "vn",
            "pt-BR" | "pt-br" => "ptbr",
            language => language,
        }
    }

    fn escape_wikidot_interwiki_pagename(slug: &str) -> String {
        let mut encoded = String::with_capacity(slug.len());
        for byte in slug.bytes() {
            match byte {
                b'A'..=b'Z'
                | b'a'..=b'z'
                | b'0'..=b'9'
                | b'-'
                | b'.'
                | b'_'
                | b'~'
                | b':' => {
                    encoded.push(byte as char);
                }
                _ => {
                    encoded.push_str(&format!("%{byte:02X}"));
                }
            }
        }
        encoded
    }

    pub(in crate::services::render) fn decode_rendered_embed_block(
        block: &str,
    ) -> String {
        let without_anchors = WIKIDOT_RENDERED_ANCHOR_REGEX.replace_all(block, "$1");
        let text = without_anchors
            .replace("<br>", "")
            .replace("<br/>", "")
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&#34;", "\"")
            .replace("&#39;", "'")
            .replace("&amp;", "&");

        text.trim().to_owned()
    }
}

/// Wikidot ends the current paragraph before its unsupported-embed error and
/// leaves any following line break and text at the surrounding block level.
/// FTML sees only the opaque marker and therefore keeps the whole source line
/// in one paragraph. Split only a plain-text paragraph containing the marker;
/// inline markup and malformed HTML retain the established literal replacement
/// path.
#[derive(Debug, Clone, Copy)]
struct WikidotEmbedMarker {
    start: usize,
    end: usize,
    index: usize,
}

#[derive(Debug)]
struct WikidotEmbedParagraph {
    body_start: usize,
    end: usize,
    disallowed_tag_starts: Vec<usize>,
}

fn collect_wikidot_embed_markers(
    html: &str,
    iframe_count: usize,
) -> Vec<WikidotEmbedMarker> {
    let mut markers = Vec::new();
    let mut cursor = 0;
    while let Some(relative_start) =
        html[cursor..].find(WIKIDOT_EMBED_IFRAME_SENTINEL_PREFIX)
    {
        let start = cursor + relative_start;
        let digits_start = start + WIKIDOT_EMBED_IFRAME_SENTINEL_PREFIX.len();
        let mut digits_end = digits_start;
        while html
            .as_bytes()
            .get(digits_end)
            .is_some_and(u8::is_ascii_digit)
        {
            digits_end += 1;
        }
        if digits_end > digits_start
            && html.as_bytes().get(digits_end) == Some(&b'X')
            && let Ok(index) = html[digits_start..digits_end].parse::<usize>()
            && index < iframe_count
        {
            let end = digits_end + 1;
            markers.push(WikidotEmbedMarker { start, end, index });
            cursor = end;
        } else {
            cursor = digits_start;
        }
    }
    markers
}

fn replace_wikidot_embed_markers(text: String, replacements: &[String]) -> String {
    if replacements.is_empty() || !text.contains(WIKIDOT_EMBED_IFRAME_SENTINEL_PREFIX) {
        return text;
    }
    let markers = collect_wikidot_embed_markers(&text, replacements.len());
    if markers.is_empty() {
        return text;
    }

    let mut output = String::with_capacity(text.len());
    let mut cursor = 0;
    for marker in markers {
        output.push_str(&text[cursor..marker.start]);
        output.push_str(&replacements[marker.index]);
        cursor = marker.end;
    }
    output.push_str(&text[cursor..]);
    output
}

fn collect_wikidot_embed_paragraphs(html: &str) -> Vec<WikidotEmbedParagraph> {
    let mut paragraphs = Vec::new();
    let mut open_paragraphs = Vec::new();
    let mut cursor = 0;
    while cursor < html.len() {
        let next_open = html[cursor..].find("<p>").map(|offset| cursor + offset);
        let next_close = html[cursor..].find("</p>").map(|offset| cursor + offset);
        let Some((position, opening)) = (match (next_open, next_close) {
            (Some(open), Some(close)) if open < close => Some((open, true)),
            (Some(open), None) => Some((open, true)),
            (_, Some(close)) => Some((close, false)),
            (None, None) => None,
        }) else {
            break;
        };

        if opening {
            open_paragraphs.push(position + "<p>".len());
            cursor = position + "<p>".len();
        } else {
            if let Some(body_start) = open_paragraphs.pop() {
                let disallowed_tag_starts =
                    collect_disallowed_embed_paragraph_tags(html, body_start, position);
                paragraphs.push(WikidotEmbedParagraph {
                    body_start,
                    end: position,
                    disallowed_tag_starts,
                });
            }
            cursor = position + "</p>".len();
        }
    }
    paragraphs.sort_unstable_by_key(|paragraph| paragraph.body_start);
    paragraphs
}

fn collect_disallowed_embed_paragraph_tags(
    html: &str,
    body_start: usize,
    body_end: usize,
) -> Vec<usize> {
    let mut disallowed = Vec::new();
    let mut cursor = body_start;
    while let Some(relative_start) = html[cursor..body_end].find('<') {
        let start = cursor + relative_start;
        let rest = &html[start..body_end];
        if let Some(after) = rest.strip_prefix("<br>") {
            cursor = body_end - after.len();
        } else if let Some(after) = rest
            .strip_prefix("<br/>")
            .or_else(|| rest.strip_prefix("<br />"))
        {
            cursor = body_end - after.len();
        } else {
            disallowed.push(start);
            cursor = start + 1;
        }
    }
    disallowed
}

fn append_wikidot_embed_source_range(
    html: &str,
    source_cursor: &mut usize,
    end: usize,
    output: &mut String,
    suppressed_paragraph_end: &mut Option<usize>,
) {
    if *source_cursor >= end {
        return;
    }
    if let Some(paragraph_end) = *suppressed_paragraph_end {
        if paragraph_end < *source_cursor {
            *suppressed_paragraph_end = None;
        } else if paragraph_end < end {
            output.push_str(&html[*source_cursor..paragraph_end]);
            *source_cursor = paragraph_end + "</p>".len();
            *suppressed_paragraph_end = None;
        } else if paragraph_end == end {
            output.push_str(&html[*source_cursor..paragraph_end]);
            *source_cursor = end;
            return;
        }
    }
    output.push_str(&html[*source_cursor..end]);
    *source_cursor = end;
}

fn restore_wikidot_embed_error_paragraph(
    output: &mut String,
    marker: &WikidotEmbedMarker,
    paragraphs: &[WikidotEmbedParagraph],
    suppressed_paragraph_end: &mut Option<usize>,
) -> bool {
    let paragraph_index =
        paragraphs.partition_point(|paragraph| paragraph.body_start <= marker.start);
    let Some(paragraph) = paragraph_index
        .checked_sub(1)
        .and_then(|index| paragraphs.get(index))
        .filter(|paragraph| marker.start < paragraph.end)
    else {
        return false;
    };
    let Some(paragraph_start) = output.rfind("<p>") else {
        return false;
    };
    let body_start = paragraph_start + "<p>".len();
    if body_start > output.len() {
        return false;
    }
    let leading = &output[body_start..];
    if leading.contains("</p>")
        || !wikidot_embed_paragraph_side_is_plain(leading)
        || paragraph
            .disallowed_tag_starts
            .partition_point(|&position| position < marker.end)
            != paragraph.disallowed_tag_starts.len()
    {
        return false;
    }

    let leading = leading.to_owned();
    output.truncate(paragraph_start);
    if !leading.trim().is_empty() {
        output.push_str("<p>");
        output.push_str(&leading);
        output.push_str("</p>");
    }
    output.push_str(WIKIDOT_EMBED_NO_MATCH_HTML);
    *suppressed_paragraph_end = Some(paragraph.end);
    true
}

fn wikidot_embed_paragraph_side_is_plain(value: &str) -> bool {
    let mut rest = value;
    while let Some(start) = rest.find('<') {
        rest = &rest[start..];
        if let Some(after) = rest
            .strip_prefix("<br>")
            .or_else(|| rest.strip_prefix("<br/>"))
            .or_else(|| rest.strip_prefix("<br />"))
        {
            rest = after;
        } else {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unsupported_embed_error_keeps_wikidot_plain_paragraph_split() {
        let marker = format!("{WIKIDOT_EMBED_IFRAME_SENTINEL_PREFIX}0X");
        let html = format!("<p>before{marker}<br>after</p>");
        let restored = RenderService::restore_protected_wikidot_embed_iframes(
            html,
            &[WIKIDOT_EMBED_NO_MATCH_HTML.to_owned()],
        );

        assert_eq!(
            restored,
            concat!(
                "<p>before</p>",
                r#"<div class="error-block">Sorry, no match for the embedded content.</div>"#,
                "<br>after",
            ),
        );
    }

    #[test]
    fn unsupported_embed_error_stays_inline_with_markup() {
        let marker = format!("{WIKIDOT_EMBED_IFRAME_SENTINEL_PREFIX}0X");
        let html = format!("<p>before <strong>{marker}</strong> after</p>");
        let restored = RenderService::restore_protected_wikidot_embed_iframes(
            html,
            &[WIKIDOT_EMBED_NO_MATCH_HTML.to_owned()],
        );

        assert_eq!(
            restored,
            format!(
                r#"<p>before <strong>{WIKIDOT_EMBED_NO_MATCH_HTML}</strong> after</p>"#,
            ),
        );
    }

    #[test]
    fn dense_unsupported_embeds_do_not_rescan_the_output_per_marker() {
        const MARKER_COUNT: usize = 1_024;

        let iframes = (0..MARKER_COUNT)
            .map(|_| WIKIDOT_EMBED_NO_MATCH_HTML.to_owned())
            .collect::<Vec<_>>();
        let html = (0..MARKER_COUNT)
            .map(|index| format!("<p>{WIKIDOT_EMBED_IFRAME_SENTINEL_PREFIX}{index}X</p>"))
            .collect::<Vec<_>>()
            .join("\n");

        let restored = RenderService::restore_protected_wikidot_embed_iframes(
            html.clone(),
            &iframes,
        );
        let scanned_bytes = take_wikidot_embed_restore_scanned_bytes();

        assert_eq!(
            restored.matches(WIKIDOT_EMBED_NO_MATCH_HTML).count(),
            MARKER_COUNT,
        );
        assert!(
            scanned_bytes <= html.len() * 4,
            "embed restoration rescanned {scanned_bytes} bytes for {} source bytes",
            html.len(),
        );
    }
}
