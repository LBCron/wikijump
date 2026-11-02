/*
 * services/render/count_pages_recognition.rs
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

use std::ops::Range;

use super::UrlArguments;
use super::list_pages::{
    advance_literal_cursor_and_check_count_pages_capture_containment,
    count_pages_should_remain_literal, list_pages_has_unsupported_page_type_selector,
    list_pages_has_unsupported_parent_selector,
    list_pages_recognized_static_url_fallback_ranges,
    parse_list_pages_arguments_with_url,
    scanner::{
        CountPagesCloseReachabilityIndex, has_count_pages_module_opening_candidate,
    },
};
use super::literal_regions::{ListPagesSourceProjection, LiteralRegionIndex};
use super::service::COUNTPAGES_MODULE_REGEX;

#[derive(Debug, Default)]
pub(super) struct CountPagesModuleRecognition {
    executable_starts: Vec<usize>,
    literal_starts: Vec<usize>,
    static_fallback_marker_ranges: Vec<Range<usize>>,
}

impl CountPagesModuleRecognition {
    pub(super) fn has_executable(&self) -> bool {
        !self.executable_starts.is_empty()
    }

    pub(super) fn is_executable_at(&self, start: usize) -> bool {
        self.executable_starts.binary_search(&start).is_ok()
    }

    pub(super) fn is_literal_at(&self, start: usize) -> bool {
        self.literal_starts.binary_search(&start).is_ok()
    }

    pub(super) fn owns_static_fallback_marker(&self, marker: Range<usize>) -> bool {
        self.static_fallback_marker_ranges.contains(&marker)
    }
}

pub(super) fn wikitext_has_executable_count_pages_module(source: &str) -> bool {
    recognize_count_pages_modules(source).has_executable()
}

pub(super) fn recognize_count_pages_modules(source: &str) -> CountPagesModuleRecognition {
    if !has_count_pages_module_opening_candidate(source) {
        return CountPagesModuleRecognition::default();
    }

    let close_reachability = CountPagesCloseReachabilityIndex::new(source);
    let literal_regions = LiteralRegionIndex::new_count_pages_syntax(source);
    let source_projection = ListPagesSourceProjection::new(source);
    let mut close_reachability = close_reachability.monotone_cursor();
    let mut literal_regions = literal_regions.monotone_cursor();
    let mut source_projection_ranges = source_projection
        .as_ref()
        .map(ListPagesSourceProjection::original_range_cursor);

    let mut recognition = CountPagesModuleRecognition::default();
    for captures in COUNTPAGES_MODULE_REGEX.captures_iter(source) {
        let module = captures
            .get(0)
            .expect("a CountPages capture always has a complete match");
        if advance_literal_cursor_and_check_count_pages_capture_containment(
            &mut literal_regions,
            module.start(),
        ) {
            recognition.literal_starts.push(module.start());
            continue;
        }

        let head_match = captures
            .name("head")
            .expect("a CountPages capture always has a head");
        let head = head_match.as_str();
        if source_projection_ranges.as_mut().is_some_and(|ranges| {
            !ranges.advance_to_range_and_check_unchanged(
                source,
                head_match.start()..head_match.end(),
            )
        }) {
            continue;
        }
        if !close_reachability
            .regex_capture_close_is_reachable(module.start()..module.end())
        {
            continue;
        }

        let body = captures.name("body");
        if body.is_some_and(|body| body.as_str().is_empty()) && head.trim().is_empty() {
            recognition.literal_starts.push(module.start());
            continue;
        }
        if list_pages_has_unsupported_parent_selector(head)
            || list_pages_has_unsupported_page_type_selector(head)
        {
            continue;
        }

        if let Some(arguments) =
            parse_list_pages_arguments_with_url(head, UrlArguments::default())
            && !count_pages_should_remain_literal(&arguments)
        {
            recognition.executable_starts.push(module.start());
            recognition.static_fallback_marker_ranges.extend(
                list_pages_recognized_static_url_fallback_ranges(head, &arguments)
                    .into_iter()
                    .map(|range| {
                        head_match.start() + range.start..head_match.start() + range.end
                    }),
            );
        }
    }
    recognition
}
