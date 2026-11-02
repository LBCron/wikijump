/*
 * services/render/list_pages/scanner/legacy_recovery.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::{
    ListPagesModuleMatch, ModuleEvent, ModuleOpenKind,
    PreservedAtMarkerDocumentationOpening,
};

fn legacy_at_marker_footnote_tail_end(source: &str, lowercase: &str) -> Option<usize> {
    const PREFIX: &str = "[[module ";
    const NAME: &str = "listpages";
    const FOOTNOTE_CLOSE: &str = "[[/footnote]]";

    if !lowercase.starts_with(PREFIX) {
        return None;
    }
    let name_end = PREFIX.len() + NAME.len();
    if lowercase.get(PREFIX.len()..name_end) != Some(NAME)
        || !lowercase[name_end..].starts_with(char::is_whitespace)
    {
        return None;
    }
    let head_spacing = source[name_end..]
        .bytes()
        .take_while(|byte| matches!(byte, b' ' | b'\t'))
        .count();
    let text_start = name_end + head_spacing;
    if !source[text_start..].starts_with("@@") {
        return None;
    }
    let close_start =
        text_start + 2 + lowercase[text_start + 2..].find(FOOTNOTE_CLOSE)?;
    let text = &source[text_start + 2..close_start];
    if text.trim().is_empty()
        || text.contains("[[")
        || text.contains("]]")
        || text.contains(['\r', '\n'])
    {
        return None;
    }
    Some(close_start + FOOTNOTE_CLOSE.len())
}

pub(super) fn legacy_at_marker_footnote_default_list_pages<'a>(
    source: &'a str,
    lowercase: &str,
) -> Option<(ListPagesModuleMatch<'a>, usize)> {
    let body_start = legacy_at_marker_footnote_tail_end(source, lowercase)?;
    let end = unclosed_at_marker_collapsible_prefix_end(
        &source[..body_start],
        &source[body_start..],
    )
    .map(|tail_end| body_start + tail_end)
    .unwrap_or(body_start);
    Some((
        ListPagesModuleMatch {
            start: 0,
            body_start,
            end,
            head: &source[body_start..body_start],
            body: &source[body_start..body_start],
            original: &source[..end],
            runtime_safe: false,
            preserve_original: false,
            preserve_as_module654: false,
            consume_empty_tail: end > body_start,
        },
        end,
    ))
}

pub(super) fn unclosed_at_marker_collapsible_prefix_end(
    opener: &str,
    suffix: &str,
) -> Option<usize> {
    let starts_with_raw_line = suffix.starts_with("@@\n");
    let raw_footnote_head =
        opener.contains("@@") && opener.to_ascii_lowercase().contains("[[/footnote");
    if !starts_with_raw_line && !raw_footnote_head {
        return None;
    }
    let mut offset = if starts_with_raw_line {
        "@@\n".len()
    } else {
        0
    };
    for line_with_ending in suffix[offset..].split_inclusive('\n') {
        let line = line_with_ending
            .strip_suffix('\n')
            .unwrap_or(line_with_ending);
        let lowercase = line.to_ascii_lowercase();
        let opening = lowercase
            .strip_prefix("[[")
            .and_then(|opening| opening.split_once(' '));
        if opening.is_some_and(|(module, attributes)| {
            module == "collapsible"
                && attributes.starts_with("show=\"")
                && attributes.ends_with("\"]]")
                && attributes.contains("\" hide=\"")
        }) {
            return Some(offset + line.len());
        }
        offset += line_with_ending.len();
    }
    None
}

pub(super) fn unclosed_at_marker_requires_module654_preservation(
    head: &str,
    suffix: &str,
) -> bool {
    if !suffix.starts_with("@@") {
        return false;
    }
    let lowercase = suffix.to_ascii_lowercase();
    !lowercase.starts_with("@@[[footnote]]")
        && !lowercase.contains("@@[[%%content{")
        && trailing_at_marker_raw_row_tail_end(head, suffix).is_none()
}

pub(super) fn trailing_at_marker_raw_row_tail_end(
    head: &str,
    suffix: &str,
) -> Option<usize> {
    if !head.trim_end().ends_with("@@") {
        return None;
    }
    let mut lines = suffix.lines();
    (lines.next() == Some("@@")
        && lines
            .next()
            .is_some_and(|line| line.starts_with("@@*@@ ") && !line.contains("[["))
        && lines
            .next()
            .is_some_and(|line| line.eq_ignore_ascii_case("@@[[/module]]"))
        && lines.next().is_none())
    .then_some(suffix.len())
}

pub(super) fn unclosed_list_pages_owns_legacy_quoted_continuation(
    source: &str,
    body_start: usize,
) -> bool {
    let Some(suffix) = source.get(body_start..) else {
        return false;
    };
    list_pages_at_marker_body_is_legacy_quoted_continuation(suffix)
}

pub(super) fn unclosed_list_pages_has_immediate_raw_closer(
    source: &str,
    body_start: usize,
) -> bool {
    source
        .get(body_start..)
        .map(str::trim_start)
        .is_some_and(|suffix| suffix.as_bytes().starts_with(b"[[/module]]"))
}

pub(super) fn complete_multiline_at_marker_template_boundary(
    suffix: &str,
) -> Option<(usize, usize)> {
    const CLOSE: &str = "@@[[/module]]";
    if !suffix.starts_with("@@\n")
        || suffix.len() <= CLOSE.len()
        || !suffix[suffix.len() - CLOSE.len()..].eq_ignore_ascii_case(CLOSE)
    {
        return None;
    }
    let close_start = suffix.len() - CLOSE.len();
    let body = &suffix[..close_start];
    if body.to_ascii_lowercase().contains("[[%%content{") {
        return None;
    }
    let mut lines = body.split_terminator('\n');
    if lines.next() != Some("@@") {
        return None;
    }
    let mut row_lines = 0usize;
    for line in lines {
        if line.len() < 4 || !line.starts_with("@@") || !line.ends_with("@@") {
            return None;
        }
        row_lines += 1;
    }
    (row_lines > 0).then_some((close_start, suffix.len()))
}

pub(super) fn preserved_at_marker_documentation_opening(
    source: &str,
    lowercase: &str,
    events: &[ModuleEvent],
    allow_literal_documentation_example: bool,
) -> Option<PreservedAtMarkerDocumentationOpening> {
    for event in events {
        let ModuleEvent::Open {
            kind,
            start,
            subname_start,
            subname_end,
            opening_end,
            body_start,
            direct_candidate,
            ..
        } = *event
        else {
            continue;
        };
        if kind != ModuleOpenKind::Standard
            || !direct_candidate
            || !source[subname_start..subname_end].eq_ignore_ascii_case("listpages")
        {
            continue;
        }
        let head = source[subname_end..opening_end]
            .trim_start()
            .trim_end_matches(']');
        if head.is_empty()
            && list_pages_argumentless_documentation_body_prefix(&source[body_start..])
        {
            let suffix = &source[body_start..];
            let resume = if suffix.starts_with("@@}}") {
                body_start + "@@}}".len()
            } else if suffix.starts_with("}}") {
                body_start + "}}".len()
            } else {
                let close = b"@@[[/module]]";
                suffix
                    .as_bytes()
                    .windows(close.len())
                    .position(|window| window.eq_ignore_ascii_case(close))
                    .map_or(body_start, |offset| body_start + offset + close.len())
            };
            return Some(PreservedAtMarkerDocumentationOpening {
                start,
                body_start,
                resume,
                subname_end,
                opening_end,
            });
        }
    }
    if allow_literal_documentation_example {
        const LITERAL_EXAMPLE: &str = "[[module listpages]]}}";
        let start = lowercase.find(LITERAL_EXAMPLE)?;
        let subname_end = start + "[[module listpages".len();
        let body_start = start + "[[module listpages]]".len();
        return Some(PreservedAtMarkerDocumentationOpening {
            start,
            body_start,
            resume: body_start + "}}".len(),
            subname_end,
            opening_end: body_start,
        });
    }
    None
}

fn list_pages_at_marker_body_is_legacy_quoted_continuation(suffix: &str) -> bool {
    let mut lines = suffix.lines();
    if lines.next() != Some("@@") {
        return false;
    }
    let quoted = lines.collect::<Vec<_>>();
    let Some(last) = quoted.last() else {
        return false;
    };
    quoted.iter().all(|line| line.starts_with("> "))
        && last.starts_with("> @@")
        && last.to_ascii_lowercase().ends_with("[[/module]]")
}

fn list_pages_argumentless_documentation_body_prefix(suffix: &str) -> bool {
    let lowercase = suffix.to_ascii_lowercase();
    lowercase.starts_with("}}")
        || lowercase.starts_with("@@}}")
        || lowercase.starts_with("@@\n@@[[div")
        || lowercase.starts_with("@@")
            && lowercase.as_bytes()[..lowercase.len().min(256)]
                .windows(b"@@[[html]]".len())
                .any(|window| window == b"@@[[html]]")
}

pub(super) fn nested_module_opening_has_inert_at_marker_suffix(
    source: &str,
    opening_end: usize,
) -> bool {
    let bytes = source.as_bytes();
    if bytes.get(opening_end..opening_end + 2) != Some(&b"@@"[..]) {
        return false;
    }
    let mut cursor = opening_end + 2;
    while bytes.get(cursor) == Some(&b'@') {
        cursor += 1;
    }
    while matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
        cursor += 1;
    }
    matches!(bytes.get(cursor), None | Some(b'\r' | b'\n'))
}
