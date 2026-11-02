/*
 * services/render/list_pages/generated_html.rs
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

use super::super::compat::CompatHtmlFragments;
use super::super::literal_regions::LiteralRegionIndex;
use super::super::service::{
    GENERATED_LISTPAGES_HTML_REGEX, WIKIDOT_COMPAT_HTML_SENTINEL_PREFIX,
};
use super::substitution::ListPagesOffsetOrigin;

pub(in crate::services::render) fn register_generated_list_pages_html(
    value: String,
    compat_html: &mut CompatHtmlFragments,
) -> String {
    if !value.contains("data-wikijump-compat-") {
        return value;
    }
    let literal_regions = LiteralRegionIndex::new(&value);
    GENERATED_LISTPAGES_HTML_REGEX
        .replace_all(&value, |captures: &regex::Captures<'_>| {
            let full_match = captures.get(0).expect("compat fragment capture exists");
            if literal_regions.contains(full_match.start()) {
                return full_match.as_str().to_owned();
            }

            let block_html = full_match
                .as_str()
                .contains(r#"data-wikijump-compat-listpages="1""#)
                || full_match
                    .as_str()
                    .contains(r#"data-wikijump-compat-listpages-feed="1""#);
            let html = strip_generated_list_pages_html_markers(
                compat_html.restore(full_match.as_str()),
            );
            if block_html {
                compat_html.push_block_html_allowing_span_parent(html)
            } else {
                compat_html.push_html(html)
            }
        })
        .into_owned()
}

pub(in crate::services::render) fn strip_generated_list_pages_html_markers(
    html: String,
) -> String {
    html.replace(r#" data-wikijump-compat-date="1""#, "")
        .replace(r#" data-wikijump-compat-listpages="1""#, "")
        .replace(r#" data-wikijump-compat-listpages-user="1""#, "")
        .replace(r#" data-wikijump-compat-listpages-feed="1""#, "")
        .replace(r#" data-wikijump-compat-listpages-rating="1""#, "")
        .replace(r#" data-wikijump-compat-listpages-preview="1""#, "")
}

pub(in crate::services::render) fn url_offset_list_pages_content_bytes(
    offset_origin: ListPagesOffsetOrigin,
    uses_content: bool,
    replacement: &str,
) -> usize {
    if offset_origin == ListPagesOffsetOrigin::Url && uses_content {
        replacement.len()
    } else {
        0
    }
}

pub(in crate::services::render) fn repair_list_pages_block_boundaries(
    replacement: &mut String,
    (prefix, suffix): (&str, &str),
) {
    preserve_list_pages_preceding_paragraph_boundary(replacement, prefix);
    let is_raw_wrapper = replacement.starts_with("[[div class=\"list-pages-box\"]]\n")
        && replacement.ends_with("[[/div]]");
    let is_registered_wrapper =
        replacement.starts_with(WIKIDOT_COMPAT_HTML_SENTINEL_PREFIX);
    if !is_raw_wrapper && !is_registered_wrapper {
        return;
    }

    let suffix = suffix
        .strip_prefix("\r\n")
        .or_else(|| suffix.strip_prefix('\n'))
        .or_else(|| suffix.strip_prefix('\r'));
    if let Some(suffix) = suffix
        && !suffix.is_empty()
        && !suffix.starts_with(['\r', '\n'])
    {
        replacement.push('\n');
    }
}

fn preserve_list_pages_preceding_paragraph_boundary(
    replacement: &mut String,
    prefix: &str,
) -> usize {
    if prefix.is_empty() || !replacement.starts_with(WIKIDOT_COMPAT_HTML_SENTINEL_PREFIX)
    {
        return 0;
    }

    let trailing = prefix.trim_end_matches([' ', '\t', '\r']);
    if let Some(before_last_newline) = trailing.strip_suffix('\n') {
        let prior_line = before_last_newline
            .rsplit_once('\n')
            .map_or(before_last_newline, |(_, line)| line)
            .trim_matches([' ', '\t', '\r']);
        if prior_line.is_empty() {
            return 0;
        }
        replacement.insert(0, '\n');
        1
    } else if trailing.is_empty() {
        0
    } else {
        replacement.insert_str(0, "\n\n");
        2
    }
}
