/*
 * services/render/compat/color_and_inline_protection.rs
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

use super::super::literal_regions::LiteralRegionIndex;
#[cfg(test)]
use super::super::service::WIKIDOT_COMPAT_HTML_SENTINEL_PREFIX;
use super::super::service::{
    WIKIDOT_BOLD_COLOR_SPAN_REGEX, WIKIDOT_BOLD_OUTER_COLOR_SPAN_REGEX,
    WIKIDOT_BOLD_UNDERLINE_SPAN_REGEX, WIKIDOT_COLOR_SPAN_REGEX,
    WIKIDOT_ESCAPED_NBSP_REGEX, WIKIDOT_INLINE_HTML_SENTINEL_PREFIX,
    escape_list_pages_html_attr, render_native_list_inline_html,
    render_native_list_inline_wikidot_strong,
    render_native_list_inline_wikidot_underlines,
};
use super::CompatHtmlFragments;
use ftml::settings::WikitextSettings;
use std::borrow::Cow;
use uuid::Uuid;

#[derive(Debug)]
pub(in crate::services::render) struct ProtectedWikidotColorSpans {
    pub(in crate::services::render) fragments: CompatHtmlFragments,
    #[cfg(test)]
    pub(in crate::services::render) spans: Vec<ProtectedWikidotColorSpan>,
}

impl ProtectedWikidotColorSpans {
    pub(in crate::services::render) fn new(source: &str) -> Self {
        Self {
            fragments: CompatHtmlFragments::new(source),
            #[cfg(test)]
            spans: Vec::new(),
        }
    }

    #[cfg(test)]
    pub(in crate::services::render) fn len(&self) -> usize {
        self.spans.len()
    }

    #[cfg(test)]
    pub(in crate::services::render) fn iter(
        &self,
    ) -> impl Iterator<Item = &ProtectedWikidotColorSpan> {
        self.spans.iter()
    }
}

#[cfg(test)]
impl std::ops::Index<usize> for ProtectedWikidotColorSpans {
    type Output = ProtectedWikidotColorSpan;

    fn index(&self, index: usize) -> &Self::Output {
        &self.spans[index]
    }
}

#[cfg(test)]
#[derive(Debug)]
pub(in crate::services::render) struct ProtectedWikidotColorSpan {
    pub(in crate::services::render) marker: String,
    pub(in crate::services::render) html: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::services::render) struct ProtectedWikidotInlineHtml {
    pub(in crate::services::render) marker: String,
    pub(in crate::services::render) html: String,
}

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::services::render) struct ProtectedWikidotCompatHtml {
    pub(in crate::services::render) marker: String,
    pub(in crate::services::render) html: String,
}

pub(in crate::services::render) fn protect_wikidot_color_spans(
    wikitext: &mut String,
    settings: &WikitextSettings,
) -> ProtectedWikidotColorSpans {
    let mut protected_spans = ProtectedWikidotColorSpans::new(wikitext);
    if !settings.enable_page_syntax {
        return protected_spans;
    }

    let literal_regions = LiteralRegionIndex::new_wikidot_protection(wikitext);
    let protected = WIKIDOT_COLOR_SPAN_REGEX
        .replace_all(wikitext, |captures: &regex::Captures<'_>| {
            let full_match = captures.get(0).expect("color span match should exist");
            if literal_regions.contains(full_match.start()) {
                return full_match.as_str().to_owned();
            }
            let Some(color) = parse_wikidot_compat_color_descriptor(
                &captures["hashes"],
                &captures["color"],
            ) else {
                return captures[0].to_owned();
            };
            let body = &captures["body"];
            // A raw marker in the body could pair with one beyond the span's
            // close, and FTML does not split long `@` runs the way Wikidot does
            // (`##transparent|@@@@@@@@@@##` redactions). Such bodies keep the
            // pre-rendered literal form.
            if body.contains("@@") {
                let html = render_wikidot_color_span_html(&color, body);
                let marker = protected_spans.fragments.push_html(html.clone());
                #[cfg(test)]
                protected_spans.spans.push(ProtectedWikidotColorSpan {
                    marker: marker.clone(),
                    html,
                });
                return marker;
            }
            let open_tag = format!(
                r#"<span style="color: {}">"#,
                escape_list_pages_html_attr(&color),
            );
            let open = protected_spans.fragments.push_html(open_tag.clone());
            let close = protected_spans.fragments.push_html("</span>".to_owned());
            #[cfg(test)]
            protected_spans.spans.push(ProtectedWikidotColorSpan {
                marker: open.clone(),
                html: format!("{open_tag}{body}</span>"),
            });
            format!("{open}{body}{close}")
        })
        .into_owned();
    *wikitext = protected;
    protected_spans
}

fn replace_active_inline_matches(
    source: &str,
    pattern: &regex::Regex,
    mut render: impl FnMut(&regex::Captures<'_>) -> String,
) -> String {
    let mut literals: Option<LiteralRegionIndex> = None;
    pattern
        .replace_all(source, |captures: &regex::Captures<'_>| {
            let matched = captures.get(0).expect("inline match should exist");
            if literals
                .get_or_insert_with(|| {
                    LiteralRegionIndex::new_wikidot_inline_protection(source)
                })
                .contains(matched.start())
            {
                matched.as_str().to_owned()
            } else {
                render(captures)
            }
        })
        .into_owned()
}

pub(in crate::services::render) fn protect_wikidot_inline_html_spans(
    wikitext: &mut String,
    settings: &WikitextSettings,
) -> Vec<ProtectedWikidotInlineHtml> {
    if !settings.enable_page_syntax {
        return Vec::new();
    }

    let mut spans = Vec::new();
    let protected = replace_active_inline_matches(
        wikitext,
        &WIKIDOT_ESCAPED_NBSP_REGEX,
        |captures| {
            let marker = wikidot_inline_html_marker();
            spans.push(ProtectedWikidotInlineHtml {
                marker: marker.clone(),
                html: captures["html"].to_owned(),
            });
            marker
        },
    );
    let protected = replace_active_inline_matches(
        &protected,
        &WIKIDOT_BOLD_OUTER_COLOR_SPAN_REGEX,
        |captures| {
            if captures["body"].contains("##") {
                return captures[0].to_owned();
            }
            let Some(color) = parse_wikidot_compat_color_descriptor(
                &captures["hashes"],
                &captures["color"],
            ) else {
                return captures[0].to_owned();
            };
            let marker = wikidot_inline_html_marker();
            spans.push(ProtectedWikidotInlineHtml {
                marker: marker.clone(),
                html: format!(
                    "<strong>{}</strong>",
                    render_wikidot_color_span_html(&color, &captures["body"]),
                ),
            });
            marker
        },
    );
    let protected = replace_active_inline_matches(
        &protected,
        &WIKIDOT_BOLD_COLOR_SPAN_REGEX,
        |captures| {
            if captures["body"].contains("##") {
                return captures[0].to_owned();
            }
            let Some(color) = parse_wikidot_compat_color_descriptor(
                &captures["hashes"],
                &captures["color"],
            ) else {
                return captures[0].to_owned();
            };
            let marker = wikidot_inline_html_marker();
            spans.push(ProtectedWikidotInlineHtml {
                marker: marker.clone(),
                html: format!(
                    "<strong>{}</strong>",
                    render_wikidot_color_span_html(&color, &captures["body"]),
                ),
            });
            marker
        },
    );
    let protected = replace_active_inline_matches(
        &protected,
        &WIKIDOT_BOLD_UNDERLINE_SPAN_REGEX,
        |captures| {
            let marker = wikidot_inline_html_marker();
            spans.push(ProtectedWikidotInlineHtml {
                marker: marker.clone(),
                html: format!(
                    "<strong><u>{}</u></strong>",
                    render_wikidot_protected_inline_body_html(&captures["body"]),
                ),
            });
            marker
        },
    );
    *wikitext = protected;
    spans
}

pub(in crate::services::render) fn restore_protected_wikidot_color_spans(
    html: String,
    spans: &ProtectedWikidotColorSpans,
) -> String {
    spans.fragments.restore_outside_block_html_literals(&html)
}

pub(in crate::services::render) fn restore_protected_wikidot_inline_html(
    mut html: String,
    spans: &[ProtectedWikidotInlineHtml],
) -> String {
    for span in spans {
        html = html.replace(&span.marker, &span.html);
    }
    html
}

#[cfg(test)]
pub(in crate::services::render) fn wikidot_compat_html_marker() -> String {
    format!(
        "{WIKIDOT_COMPAT_HTML_SENTINEL_PREFIX}{}X",
        Uuid::new_v4().as_simple(),
    )
}

pub(in crate::services::render) fn wikidot_inline_html_marker() -> String {
    format!(
        "{WIKIDOT_INLINE_HTML_SENTINEL_PREFIX}{}X",
        Uuid::new_v4().as_simple(),
    )
}

pub(in crate::services::render) fn parse_wikidot_compat_color_descriptor<'a>(
    hashes: &str,
    descriptor: &'a str,
) -> Option<Cow<'a, str>> {
    if !matches!(hashes.len(), 2 | 3) {
        return None;
    }

    let is_hex = matches!(descriptor.len(), 3 | 6)
        && descriptor.bytes().all(|byte| byte.is_ascii_hexdigit());
    if is_hex {
        return Some(Cow::Owned(format!("#{}", descriptor.to_ascii_lowercase())));
    }

    (hashes.len() == 2).then_some(Cow::Borrowed(descriptor))
}

pub(in crate::services::render) fn render_wikidot_color_span_html(
    color: &str,
    body: &str,
) -> String {
    format!(
        r#"<span style="color: {color}">{body}</span>"#,
        color = escape_list_pages_html_attr(color),
        body = render_wikidot_protected_inline_body_html(body),
    )
}

pub(in crate::services::render) fn render_wikidot_protected_inline_body_html(
    body: &str,
) -> String {
    let rendered = render_native_list_inline_wikidot_underlines(
        &render_native_list_inline_wikidot_strong(&render_native_list_inline_html(body)),
    );

    let rendered = render_wikidot_protected_inline_sizes(&rendered);
    substitute_wikidot_protected_inline_typography(&rendered)
}

fn render_wikidot_protected_inline_sizes(html: &str) -> String {
    let mut output = String::with_capacity(html.len());
    let mut rest = html;
    while let Some((open_offset, open_len, value)) = find_wikidot_size_open(rest) {
        output.push_str(&rest[..open_offset]);
        let after_open = &rest[open_offset + open_len..];
        match find_wikidot_size_close(after_open) {
            Some((close_offset, close_len)) => {
                let inner =
                    render_wikidot_protected_inline_sizes(&after_open[..close_offset]);
                output.push_str("<span style=\"font-size:");
                output.push_str(value);
                output.push_str(";\">");
                output.push_str(&inner);
                output.push_str("</span>");
                rest = &after_open[close_offset + close_len..];
            }
            None => {
                output.push_str(&rest[open_offset..open_offset + open_len]);
                rest = after_open;
            }
        }
    }
    output.push_str(rest);
    output
}

fn find_wikidot_size_open(text: &str) -> Option<(usize, usize, &str)> {
    let bytes = text.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'<' {
            index += text[index..].find('>')? + 1;
        } else if text[index..].starts_with("[[size") {
            match wikidot_protected_inline_size_open(&text[index..]) {
                Some((open_len, value)) => return Some((index, open_len, value)),
                None => index += "[[".len(),
            }
        } else {
            index += text[index..].chars().next().map_or(1, char::len_utf8);
        }
    }
    None
}

fn find_wikidot_size_close(text: &str) -> Option<(usize, usize)> {
    let close_marker = "[[/size]]";
    let bytes = text.as_bytes();
    let mut depth = 1usize;
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'<' {
            index += text[index..].find('>')? + 1;
        } else if text[index..].starts_with(close_marker) {
            depth -= 1;
            if depth == 0 {
                return Some((index, close_marker.len()));
            }
            index += close_marker.len();
        } else if text[index..].starts_with("[[size") {
            match wikidot_protected_inline_size_open(&text[index..]) {
                Some((open_len, _)) => {
                    depth += 1;
                    index += open_len;
                }
                None => index += "[[".len(),
            }
        } else {
            index += text[index..].chars().next().map_or(1, char::len_utf8);
        }
    }
    None
}

fn wikidot_protected_inline_size_open(text: &str) -> Option<(usize, &str)> {
    let rest = text.strip_prefix("[[size")?;
    if !rest
        .chars()
        .next()
        .is_some_and(|character| character.is_whitespace())
    {
        return None;
    }
    let close = rest.find("]]")?;
    let value = wikidot_protected_inline_size_value(&rest[..close])?;
    Some(("[[size".len() + close + "]]".len(), value))
}

fn wikidot_protected_inline_size_value(size: &str) -> Option<&str> {
    let size = size.trim_matches([' ', '\t', '\r', '\n']);
    if matches!(
        size,
        "xx-small"
            | "x-small"
            | "small"
            | "medium"
            | "large"
            | "x-large"
            | "xx-large"
            | "smaller"
            | "larger"
    ) {
        return Some(size);
    }
    for suffix in ["%", "px", "em"] {
        if let Some(number) = size.strip_suffix(suffix)
            && !number.is_empty()
            && number != "."
            && number
                .bytes()
                .all(|byte| byte.is_ascii_digit() || byte == b'.')
            && number.bytes().filter(|byte| *byte == b'.').count() <= 1
        {
            return Some(size);
        }
    }
    None
}

pub(in crate::services::render) fn substitute_wikidot_protected_inline_typography(
    html: &str,
) -> String {
    let mut output = String::with_capacity(html.len());
    let mut rest = html;

    while let Some(tag_start) = rest.find('<') {
        let (before, after_start) = rest.split_at(tag_start);
        output.push_str(&substitute_wikidot_protected_inline_text_typography(before));

        let Some(tag_end) = after_start.find('>') else {
            output.push_str(&substitute_wikidot_protected_inline_text_typography(
                after_start,
            ));
            return output;
        };
        let (tag, after_tag) = after_start.split_at(tag_end + 1);
        output.push_str(tag);
        rest = after_tag;
    }

    output.push_str(&substitute_wikidot_protected_inline_text_typography(rest));
    output
}

pub(in crate::services::render) fn substitute_wikidot_protected_inline_dashes_in_html(
    html: &str,
) -> String {
    let mut output = String::with_capacity(html.len());
    let mut rest = html;

    while let Some(tag_start) = rest.find('<') {
        let (before, after_start) = rest.split_at(tag_start);
        output.push_str(&substitute_wikidot_protected_inline_dashes(before));

        let Some(tag_end) = after_start.find('>') else {
            output.push_str(&substitute_wikidot_protected_inline_dashes(after_start));
            return output;
        };
        let (tag, after_tag) = after_start.split_at(tag_end + 1);
        output.push_str(tag);
        rest = after_tag;
    }

    output.push_str(&substitute_wikidot_protected_inline_dashes(rest));
    output
}

pub(in crate::services::render) fn substitute_wikidot_protected_inline_text_typography(
    value: &str,
) -> String {
    let mut text = value.to_owned();
    ftml::preproc::typography::substitute(&mut text);
    substitute_wikidot_protected_inline_dashes(&text)
}

pub(in crate::services::render) fn substitute_wikidot_protected_inline_dashes(
    value: &str,
) -> String {
    substitute_wikidot_protected_inline_dashes_with_scan_count(value).0
}

pub(in crate::services::render) fn substitute_wikidot_protected_inline_dashes_with_scan_count(
    value: &str,
) -> (String, usize) {
    let mut output = String::with_capacity(value.len());
    let mut rest = value;
    let mut scanned_bytes = 0;

    while let Some(comment_start) = rest.find("[!--") {
        let (text, from_comment) = rest.split_at(comment_start);
        output.push_str(&substitute_wikidot_protected_inline_dashes_in_text(text));
        scanned_bytes += text.len();

        let Some(comment_end) = from_comment.find("--]") else {
            output.push_str(&substitute_wikidot_protected_inline_dashes_in_text(
                from_comment,
            ));
            scanned_bytes += from_comment.len();
            return (output, scanned_bytes);
        };
        let comment_end = comment_end + "--]".len();
        output.push_str(&from_comment[..comment_end]);
        scanned_bytes += comment_end;
        rest = &from_comment[comment_end..];
    }

    output.push_str(&substitute_wikidot_protected_inline_dashes_in_text(rest));
    scanned_bytes += rest.len();
    (output, scanned_bytes)
}

pub(in crate::services::render) fn substitute_wikidot_protected_inline_dashes_in_text(
    value: &str,
) -> String {
    value.replace("--", "\u{2014}")
}

pub(in crate::services::render) fn decode_numeric_html_entity(
    entity: &str,
) -> Option<char> {
    if let Some(hex) = entity
        .strip_prefix("#x")
        .or_else(|| entity.strip_prefix("#X"))
    {
        return u32::from_str_radix(hex, 16).ok().and_then(char::from_u32);
    }

    let decimal = entity.strip_prefix('#')?;
    decimal.parse::<u32>().ok().and_then(char::from_u32)
}

pub(in crate::services::render) fn sanitize_wikidot_compat_inline_tag(
    tag: &str,
) -> Option<String> {
    match tag {
        "</span>" | "</a>" => return Some(tag.to_owned()),
        "<br>" | "<br/>" | "<br />" => return Some("<br>".to_owned()),
        _ => {}
    }

    let inner = tag.strip_prefix('<')?.strip_suffix('>')?.trim();
    let inner = inner.strip_suffix('/').map_or(inner, str::trim_end);
    let name_end = inner
        .find(|character: char| character.is_ascii_whitespace())
        .unwrap_or(inner.len());
    let name = inner[..name_end].to_ascii_lowercase();
    if !matches!(name.as_str(), "span" | "a" | "img") {
        return None;
    }

    let mut output = String::new();
    output.push('<');
    output.push_str(&name);

    let mut rest = &inner[name_end..];
    while let Some((attr_name, attr_value, after_attr)) =
        parse_wikidot_compat_html_attr(rest)
    {
        rest = after_attr;
        let Some(value) = sanitize_wikidot_compat_inline_attr(
            name.as_str(),
            attr_name.as_str(),
            attr_value.as_str(),
        ) else {
            continue;
        };
        output.push(' ');
        output.push_str(&attr_name.to_ascii_lowercase());
        output.push_str(r#"=""#);
        output.push_str(&escape_list_pages_html_attr(&value));
        output.push('"');
    }

    output.push('>');
    Some(output)
}

pub(in crate::services::render) fn parse_wikidot_compat_html_attr(
    input: &str,
) -> Option<(String, String, &str)> {
    let rest = input.trim_start();
    if rest.is_empty() || rest.starts_with('/') {
        return None;
    }

    let name_end = rest.find(|character: char| {
        character.is_ascii_whitespace() || matches!(character, '=' | '/' | '>')
    })?;
    if name_end == 0 {
        return None;
    }
    let name = &rest[..name_end];
    if !name.chars().all(|character| {
        character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':')
    }) {
        return None;
    }

    let rest = rest[name_end..].trim_start();
    let rest = rest.strip_prefix('=')?.trim_start();
    let mut chars = rest.chars();
    let quote = chars.next()?;
    if matches!(quote, '"' | '\'') {
        let value_start = quote.len_utf8();
        let value_rest = &rest[value_start..];
        let value_end = value_rest.find(quote)?;
        let value = &value_rest[..value_end];
        let after = &value_rest[value_end + quote.len_utf8()..];
        return Some((name.to_owned(), value.to_owned(), after));
    }

    let value_end = rest
        .find(|character: char| {
            character.is_ascii_whitespace() || matches!(character, '/' | '>')
        })
        .unwrap_or(rest.len());
    if value_end == 0 {
        return None;
    }
    Some((
        name.to_owned(),
        rest[..value_end].to_owned(),
        &rest[value_end..],
    ))
}

pub(in crate::services::render) fn sanitize_wikidot_compat_inline_attr(
    tag_name: &str,
    attr_name: &str,
    value: &str,
) -> Option<String> {
    let attr_name = attr_name.to_ascii_lowercase();
    if attr_name.starts_with("on") {
        return None;
    }

    match (tag_name, attr_name.as_str()) {
        ("span", "class") | ("a", "class") | ("img", "class") => Some(value.to_owned()),
        ("span", "title") | ("a", "title") | ("img", "title") | ("img", "alt") => {
            Some(value.to_owned())
        }
        ("span", "style") | ("img", "style") => {
            wikidot_compat_safe_inline_style(value).then(|| value.to_owned())
        }
        ("a", "href") => {
            wikidot_compat_safe_inline_url(value, true).then(|| value.to_owned())
        }
        ("a", "rel") => Some(value.to_owned()),
        ("a", "target") if matches!(value, "_blank" | "_self" | "_parent" | "_top") => {
            Some(value.to_owned())
        }
        ("img", "src") => {
            wikidot_compat_safe_inline_url(value, false).then(|| value.to_owned())
        }
        ("img", "width") | ("img", "height") => value
            .chars()
            .all(|character| character.is_ascii_digit() || character == '%')
            .then(|| value.to_owned()),
        _ => None,
    }
}

pub(in crate::services::render) fn wikidot_compat_safe_inline_url(
    value: &str,
    allow_mailto: bool,
) -> bool {
    let value =
        value.trim_start_matches(|character: char| character.is_ascii_whitespace());
    if value.is_empty()
        || value
            .chars()
            .any(|character| matches!(character, '\0'..='\u{1f}' | '\u{7f}'))
    {
        return false;
    }

    let lower = value.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with('/')
        || lower.starts_with('#')
        || (allow_mailto && lower.starts_with("mailto:"))
    {
        return true;
    }

    !lower.contains(':')
}

pub(in crate::services::render) fn wikidot_compat_safe_inline_style(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    !lower.contains("javascript:")
        && !lower.contains("expression")
        && !lower.contains("url(")
        && !lower.contains("behavior")
        && !lower.contains("-moz-binding")
        && !value.chars().any(|character| {
            matches!(
                character,
                '<' | '>' | '"' | '\'' | '\0'..='\u{1f}' | '\u{7f}'
            )
        })
}
