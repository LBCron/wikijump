/*
 * services/render/literal_regions/list_pages_protection/css/ranges.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::super::super::block_candidates::HeadContext;
use super::super::super::{
    LiteralRegionIndex, left_block_start_in_run, merge_sorted_ranges,
};
use super::candidates::{
    collect_all_pinned_css_module_openers,
    collect_all_pinned_css_module_openers_with_heads,
};
use super::syntax::PinnedModuleCloseIndex;
use regex::Regex;
use std::ops::Range;
use std::sync::LazyLock;

static CSS_MODULE_OPEN_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)\[\[module\s+css[^\]]*\]\]").unwrap());
static MODULE_CLOSE_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)\[\[/module\]\]").unwrap());

pub(in crate::services::render::literal_regions::list_pages_protection) fn collect_downstream_css_module_ranges(
    source: &str,
) -> Vec<Range<usize>> {
    let Some(scan) = CssLiteralScan::new(source) else {
        return Vec::new();
    };
    let native_quote_lines = collect_native_quote_ranges(source);
    collect_css_module_ranges(source, &scan, &native_quote_lines)
}

pub(in crate::services::render::literal_regions::list_pages_protection) fn collect_downstream_css_module_ranges_with_heads(
    source: &str,
    heads: &HeadContext,
) -> Vec<Range<usize>> {
    let Some(scan) = CssLiteralScan::new_with_heads(source, heads) else {
        return Vec::new();
    };
    let native_quote_lines = collect_native_quote_ranges(source);
    collect_css_module_ranges(source, &scan, &native_quote_lines)
}

pub(in crate::services::render::literal_regions::list_pages_protection) fn collect_projected_css_module_ranges(
    source: &str,
    quote_ranges: &[Range<usize>],
) -> Vec<Range<usize>> {
    let Some(scan) = CssLiteralScan::new(source) else {
        return Vec::new();
    };
    collect_css_module_ranges(source, &scan, quote_ranges)
}

pub(in crate::services::render::literal_regions::list_pages_protection) fn collect_projected_css_module_ranges_with_heads(
    source: &str,
    quote_ranges: &[Range<usize>],
    heads: &HeadContext,
) -> Vec<Range<usize>> {
    let Some(scan) = CssLiteralScan::new_with_heads(source, heads) else {
        return Vec::new();
    };
    collect_css_module_ranges(source, &scan, quote_ranges)
}

pub(in crate::services::render::literal_regions::list_pages_protection) fn collect_wikidot_unclosed_css_yield_openers(
    source: &str,
) -> Vec<Range<usize>> {
    let Some(scan) = CssLiteralScan::new(source) else {
        return Vec::new();
    };
    let quote_ranges = collect_native_quote_ranges(source);
    let mut quote_cursor = 0usize;
    let mut literal_cursor = scan.indices.open.monotone_cursor();
    let mut openers = Vec::new();

    for opener in &scan.pinned_openers {
        if literal_cursor
            .advance_to_containing_end(opener.start)
            .is_some()
            || sorted_ranges_contains(&quote_ranges, &mut quote_cursor, opener.start)
        {
            continue;
        }
        if scan.wikidot_list_pages_boundaries.boundary(source, opener)
            == WikidotCssListPagesBoundary::Yield
        {
            openers.push(opener.clone());
        }
    }
    openers
}

struct CssLiteralIndices {
    open: LiteralRegionIndex,
    regex_close: LiteralRegionIndex,
}

impl CssLiteralIndices {
    fn new(source: &str) -> Self {
        Self {
            open: LiteralRegionIndex::new(source),
            regex_close: LiteralRegionIndex::new_wikidot_syntax(source),
        }
    }
}

struct CssLiteralScan {
    regex_openers: Vec<Range<usize>>,
    pinned_openers: Vec<Range<usize>>,
    pinned_close_ends: Vec<Option<usize>>,
    wikidot_list_pages_boundaries: WikidotCssListPagesBoundaryIndex,
    indices: CssLiteralIndices,
}

impl CssLiteralScan {
    fn new(source: &str) -> Option<Self> {
        let regex_openers = CSS_MODULE_OPEN_REGEX
            .find_iter(source)
            .map(|matched| matched.start()..matched.end())
            .collect::<Vec<_>>();
        let pinned_openers = collect_all_pinned_css_module_openers(source);
        Self::from_openers(source, regex_openers, pinned_openers)
    }

    fn new_with_heads(source: &str, heads: &HeadContext) -> Option<Self> {
        let regex_openers = CSS_MODULE_OPEN_REGEX
            .find_iter(source)
            .map(|matched| matched.start()..matched.end())
            .collect::<Vec<_>>();
        let pinned_openers =
            collect_all_pinned_css_module_openers_with_heads(source, heads);
        Self::from_openers(source, regex_openers, pinned_openers)
    }

    fn from_openers(
        source: &str,
        regex_openers: Vec<Range<usize>>,
        pinned_openers: Vec<Range<usize>>,
    ) -> Option<Self> {
        let indices = CssLiteralIndices::new(source);
        let pinned_closes = PinnedModuleCloseIndex::new(source);
        let pinned_close_ends = if pinned_openers.is_empty() {
            Vec::new()
        } else {
            pinned_closes.first_ends_for_openers(&pinned_openers)
        };
        (!regex_openers.is_empty() || !pinned_openers.is_empty()).then(|| Self {
            regex_openers,
            pinned_openers,
            pinned_close_ends,
            wikidot_list_pages_boundaries: WikidotCssListPagesBoundaryIndex::new(
                source,
                pinned_closes.ranges(),
            ),
            indices,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum WikidotCssListPagesBoundary {
    Original,
    Yield,
    Closed { end: usize },
}

#[derive(Clone, Copy)]
struct WikidotCssBoundaryEvent {
    start: usize,
    end: usize,
    delta: i64,
    list_pages_head: bool,
}

pub(super) struct WikidotCssListPagesBoundaryIndex {
    events: Vec<WikidotCssBoundaryEvent>,
    module_close_prefixes: Vec<usize>,
    root_tab_closes: Vec<usize>,
    prefix_depth: Vec<i64>,
    prefix_heads: Vec<usize>,
    prefix_closes: Vec<usize>,
    next_lower_depth: Vec<Option<usize>>,
}

impl WikidotCssListPagesBoundaryIndex {
    pub(super) fn new(source: &str, module_closes: &[Range<usize>]) -> Self {
        let literal_regions = LiteralRegionIndex::new(source);
        let list_pages_heads =
            collect_root_list_pages_head_offsets(source, &literal_regions)
                .into_iter()
                .filter(|head| {
                    !list_pages_head_leaves_close_raw(source, *head, module_closes)
                })
                .collect::<Vec<_>>();
        let module_close_prefixes = collect_module_close_prefix_offsets(source);
        let root_tab_closes = collect_root_tab_close_offsets(source);
        let mut events = Vec::with_capacity(list_pages_heads.len() + module_closes.len());
        let mut heads = list_pages_heads.into_iter().peekable();
        let mut closes = module_closes.iter().peekable();

        while heads.peek().is_some() || closes.peek().is_some() {
            if closes
                .peek()
                .is_none_or(|close| heads.peek().is_some_and(|head| head < &close.start))
            {
                let start = heads.next().expect("a ListPages head remains");
                events.push(WikidotCssBoundaryEvent {
                    start,
                    end: start,
                    delta: 1,
                    list_pages_head: true,
                });
            } else {
                let close = closes.next().expect("a module close remains");
                events.push(WikidotCssBoundaryEvent {
                    start: close.start,
                    end: close.end,
                    delta: -1,
                    list_pages_head: false,
                });
            }
        }

        let mut prefix_depth = Vec::with_capacity(events.len() + 1);
        let mut prefix_heads = Vec::with_capacity(events.len() + 1);
        let mut prefix_closes = Vec::with_capacity(events.len() + 1);
        prefix_depth.push(0);
        prefix_heads.push(0);
        prefix_closes.push(0);
        for event in &events {
            prefix_depth.push(prefix_depth.last().copied().unwrap() + event.delta);
            prefix_heads.push(
                prefix_heads.last().copied().unwrap()
                    + usize::from(event.list_pages_head),
            );
            prefix_closes.push(
                prefix_closes.last().copied().unwrap()
                    + usize::from(!event.list_pages_head),
            );
        }

        let mut next_lower_depth = vec![None; prefix_depth.len()];
        let mut stack = Vec::<usize>::new();
        for index in (0..prefix_depth.len()).rev() {
            while stack
                .last()
                .is_some_and(|next| prefix_depth[*next] >= prefix_depth[index])
            {
                stack.pop();
            }
            next_lower_depth[index] = stack.last().copied();
            stack.push(index);
        }

        Self {
            events,
            module_close_prefixes,
            root_tab_closes,
            prefix_depth,
            prefix_heads,
            prefix_closes,
            next_lower_depth,
        }
    }

    pub(super) fn boundary(
        &self,
        source: &str,
        opener: &Range<usize>,
    ) -> WikidotCssListPagesBoundary {
        if !is_exact_root_multiline_css_opener(source, opener) {
            return WikidotCssListPagesBoundary::Original;
        }

        let from = self
            .events
            .partition_point(|event| event.start < opener.end);
        let Some(first_list_pages) = self.events[from..]
            .iter()
            .find(|event| event.list_pages_head)
        else {
            return WikidotCssListPagesBoundary::Original;
        };
        let close_prefix = self
            .module_close_prefixes
            .partition_point(|start| *start < opener.end);
        if self
            .module_close_prefixes
            .get(close_prefix)
            .is_some_and(|start| *start < first_list_pages.start)
        {
            return WikidotCssListPagesBoundary::Original;
        }
        let tab_close = self
            .root_tab_closes
            .partition_point(|start| *start < opener.end);
        if self
            .root_tab_closes
            .get(tab_close)
            .is_some_and(|start| *start < first_list_pages.start)
        {
            return WikidotCssListPagesBoundary::Original;
        }
        if let Some(prefix_end) = self.next_lower_depth[from] {
            if self.prefix_heads[prefix_end] == self.prefix_heads[from] {
                return WikidotCssListPagesBoundary::Original;
            }
            let outer_close = self
                .events
                .get(prefix_end - 1)
                .expect("a lower prefix follows a module close");
            debug_assert!(!outer_close.list_pages_head);
            return WikidotCssListPagesBoundary::Closed {
                end: outer_close.end,
            };
        }

        let end = self.events.len();
        let balanced = self.prefix_depth[end] == self.prefix_depth[from];
        let has_list_pages = self.prefix_heads[end] > self.prefix_heads[from];
        let has_nested_close = self.prefix_closes[end] > self.prefix_closes[from];
        if balanced && has_list_pages && has_nested_close {
            WikidotCssListPagesBoundary::Yield
        } else {
            WikidotCssListPagesBoundary::Original
        }
    }
}

fn collect_root_tab_close_offsets(source: &str) -> Vec<usize> {
    let mut offsets = Vec::new();
    let mut line_start = 0usize;
    for line in source.split_inclusive('\n') {
        let marker_len = "[[/tab]]".len();
        if line
            .get(..marker_len)
            .is_some_and(|marker| marker.eq_ignore_ascii_case("[[/tab]]"))
            && matches!(line.as_bytes().get(marker_len), None | Some(b'\n' | b'\r'),)
        {
            offsets.push(line_start);
        }
        line_start += line.len();
    }
    offsets
}

fn collect_module_close_prefix_offsets(source: &str) -> Vec<usize> {
    let bytes = source.as_bytes();
    let mut offsets = Vec::new();
    let mut cursor = 0usize;
    while let Some(relative) = source[cursor..].find("[[/") {
        let start = cursor + relative;
        cursor = start + 3;
        if left_block_start_in_run(bytes, start).0 != Some(start) {
            continue;
        }
        let mut name_start = start + 3;
        while matches!(bytes.get(name_start), Some(b' ' | b'\t')) {
            name_start += 1;
        }
        if bytes.get(name_start..name_start + 2) == Some(&b"[["[..]) {
            name_start += 2;
            while matches!(bytes.get(name_start), Some(b' ' | b'\t')) {
                name_start += 1;
            }
        }
        let module_name_end = if bytes
            .get(name_start..name_start + "module654".len())
            .is_some_and(|name| name.eq_ignore_ascii_case(b"module654"))
        {
            Some(name_start + "module654".len())
        } else if bytes
            .get(name_start..name_start + "module".len())
            .is_some_and(|name| name.eq_ignore_ascii_case(b"module"))
        {
            Some(name_start + "module".len())
        } else {
            None
        };
        if module_name_end.is_some_and(|end| {
            matches!(
                bytes.get(end),
                None | Some(b' ' | b'\t' | b'\n' | b'\r' | b']'),
            )
        }) {
            offsets.push(start);
        }
    }
    offsets
}

fn collect_css_module_ranges(
    source: &str,
    scan: &CssLiteralScan,
    quote_ranges: &[Range<usize>],
) -> Vec<Range<usize>> {
    let regex_ranges = collect_regex_css_module_ranges(
        source,
        &scan.regex_openers,
        &scan.indices,
        &scan.wikidot_list_pages_boundaries,
        quote_ranges,
    );
    let pinned_ranges = collect_pinned_css_module_ranges(
        source,
        &scan.pinned_openers,
        &scan.pinned_close_ends,
        &scan.indices,
        &scan.wikidot_list_pages_boundaries,
        quote_ranges,
    );
    merge_sorted_ranges(regex_ranges, pinned_ranges)
}

fn collect_regex_css_module_ranges(
    source: &str,
    openers: &[Range<usize>],
    indices: &CssLiteralIndices,
    wikidot_boundaries: &WikidotCssListPagesBoundaryIndex,
    quote_ranges: &[Range<usize>],
) -> Vec<Range<usize>> {
    let mut cursor = 0usize;
    let mut open_literals = indices.open.monotone_cursor();
    let mut close_literals = indices.regex_close.monotone_cursor();
    let mut quote_cursor = 0usize;
    let mut ranges = Vec::new();

    for open in openers {
        if open.start < cursor {
            continue;
        }
        if open_literals
            .advance_to_containing_end(open.start)
            .is_some()
            || sorted_ranges_contains(quote_ranges, &mut quote_cursor, open.start)
        {
            cursor = open.end;
            continue;
        }
        match wikidot_boundaries.boundary(source, open) {
            WikidotCssListPagesBoundary::Yield => continue,
            WikidotCssListPagesBoundary::Closed { end } => {
                ranges.push(open.start..end);
                cursor = end;
                continue;
            }
            WikidotCssListPagesBoundary::Original => {}
        }
        let Some(close) = find_regex_module_close(source, open.end, &mut close_literals)
        else {
            break;
        };
        ranges.push(open.start..close.end);
        cursor = close.end;
    }
    ranges
}

fn collect_pinned_css_module_ranges(
    source: &str,
    openers: &[Range<usize>],
    close_ends: &[Option<usize>],
    indices: &CssLiteralIndices,
    wikidot_boundaries: &WikidotCssListPagesBoundaryIndex,
    quote_ranges: &[Range<usize>],
) -> Vec<Range<usize>> {
    let mut cursor = 0usize;
    let mut open_literals = indices.open.monotone_cursor();
    let mut quote_cursor = 0usize;
    let mut ranges = Vec::new();

    for (open, close_end) in openers.iter().zip(close_ends) {
        if open.start < cursor {
            continue;
        }
        if open_literals
            .advance_to_containing_end(open.start)
            .is_some()
            || sorted_ranges_contains(quote_ranges, &mut quote_cursor, open.start)
        {
            continue;
        }
        match wikidot_boundaries.boundary(source, open) {
            WikidotCssListPagesBoundary::Yield => continue,
            WikidotCssListPagesBoundary::Closed { end } => {
                ranges.push(open.start..end);
                cursor = end;
                continue;
            }
            WikidotCssListPagesBoundary::Original => {}
        }
        let Some(close_end) = close_end else {
            continue;
        };
        ranges.push(open.start..*close_end);
        cursor = *close_end;
    }
    ranges
}

fn collect_root_list_pages_head_offsets(
    source: &str,
    literal_regions: &LiteralRegionIndex,
) -> Vec<usize> {
    let mut offsets = Vec::new();
    let mut line_start = 0usize;
    for line in source.split_inclusive('\n') {
        if !literal_regions.contains(line_start) && wikidot_line_starts_list_pages(line) {
            offsets.push(line_start);
        }
        line_start += line.len();
    }
    offsets
}

fn list_pages_head_leaves_close_raw(
    source: &str,
    head_start: usize,
    module_closes: &[Range<usize>],
) -> bool {
    let line = source[head_start..].split('\n').next().unwrap_or_default();
    let Some(head_end) = line.find("]]").map(|offset| head_start + offset + 2) else {
        return false;
    };
    let close = module_closes.partition_point(|close| close.start < head_end);
    module_closes.get(close).is_some_and(|close| {
        let body = &source[head_end..close.start];
        !body.is_empty() && body.trim().is_empty()
    })
}

fn wikidot_line_starts_list_pages(line: &str) -> bool {
    let Some(module) = line.get(.."[[module".len()) else {
        return false;
    };
    if !module.eq_ignore_ascii_case("[[module") {
        return false;
    }
    let rest = &line["[[module".len()..];
    if !rest.starts_with([' ', '\t']) {
        return false;
    }
    let rest = rest.trim_start_matches([' ', '\t']);
    let Some(list_pages) = rest.get(.."listpages".len()) else {
        return false;
    };
    if !list_pages.eq_ignore_ascii_case("listpages") {
        return false;
    }
    rest["listpages".len()..].starts_with([']', ' ', '\t'])
}

fn is_exact_root_multiline_css_opener(source: &str, opener: &Range<usize>) -> bool {
    let bytes = source.as_bytes();
    let root_line =
        opener.start == 0 || matches!(bytes.get(opener.start - 1), Some(b'\n' | b'\r'),);
    let mut previous_line_end = opener.start;
    if bytes.get(previous_line_end.wrapping_sub(1)) == Some(&b'\n') {
        previous_line_end -= 1;
    }
    if bytes.get(previous_line_end.wrapping_sub(1)) == Some(&b'\r') {
        previous_line_end -= 1;
    }
    let continued_from_previous_line =
        bytes.get(previous_line_end.wrapping_sub(1)) == Some(&b'\\');
    root_line
        && !continued_from_previous_line
        && source[opener.clone()].eq_ignore_ascii_case("[[module CSS]]")
        && matches!(bytes.get(opener.end), Some(b'\n' | b'\r'))
}

fn find_regex_module_close(
    source: &str,
    mut cursor: usize,
    close_literals: &mut super::super::super::LiteralRegionCursor<'_>,
) -> Option<Range<usize>> {
    loop {
        let candidate = MODULE_CLOSE_REGEX.find_at(source, cursor)?;
        if close_literals
            .advance_to_containing_end(candidate.start())
            .is_none()
        {
            return Some(candidate.start()..candidate.end());
        }
        cursor = candidate.end();
    }
}

fn collect_native_quote_ranges(source: &str) -> Vec<Range<usize>> {
    let mut ranges = Vec::new();
    let mut line_start = 0usize;
    for line in source.split_inclusive('\n') {
        let bytes = line.as_bytes();
        let mut cursor = 0usize;
        while matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
            cursor += 1;
        }
        let quote_start = cursor;
        while bytes.get(cursor) == Some(&b'>') {
            cursor += 1;
        }
        if cursor > quote_start && matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
            ranges.push(line_start + cursor + 1..line_start + line.len());
        }
        line_start += line.len();
    }
    ranges
}

fn sorted_ranges_contains(
    ranges: &[Range<usize>],
    cursor: &mut usize,
    offset: usize,
) -> bool {
    while ranges.get(*cursor).is_some_and(|range| range.end <= offset) {
        *cursor += 1;
    }
    ranges
        .get(*cursor)
        .is_some_and(|range| range.start <= offset && offset < range.end)
}

#[cfg(test)]
mod tests;
