/*
 * services/render/list_pages/substitution.rs
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

mod batch;
mod body;
mod date_selectors;
mod query_helpers;
mod rendered_fragments;
mod runtime;
mod selectors;
mod template_values;

pub(in crate::services::render) use self::batch::{
    CurrentPageAuthorSource, ExactNameListPagesBatchKey, ListPagesAuthorCacheKey,
    ListPagesBatchDisplayRequirements, ListPagesBatchDisplays, ListPagesRuntimeDisplay,
    ListPagesSnapshotDisplay, ResolvedListPagesAuthors, WikidotUserDisplay,
    exact_name_list_pages_batch_key, list_pages_author_cache_key,
    union_found_page_fields,
};

pub(in crate::services::render) use self::body::{
    list_pages_body_is_no_visible_tracking_markup, unsupported_list_pages_replacement,
};
#[cfg(test)]
pub(in crate::services::render) use self::body::{
    list_pages_body_uses_content_variable, list_pages_body_variables_supported,
};
pub(in crate::services::render) use self::date_selectors::parse_list_pages_date_selector;
pub(in crate::services::render) use self::query_helpers::{
    advance_literal_cursor_and_check_count_pages_capture_containment,
    count_pages_exact_count_render_diagnostics,
    count_pages_exact_count_render_evaluation, count_pages_required_tag_batch_result,
    count_pages_required_tag_batch_selector, count_pages_should_remain_literal,
    count_pages_unbounded_all_category_shape, is_current_page_tag_selector,
    is_no_tags_selector, parse_list_pages_comparison, parse_list_pages_order,
    parse_list_pages_page_type, parse_list_pages_score_selector, split_list_pages_values,
    wikidot_list_pages_name_slug,
};
use self::query_helpers::{
    exact_raw_color_list_pages_name, list_pages_comparison_value,
    nonempty_list_pages_feed_value, normalize_list_pages_feed_selector,
    parse_list_pages_false_only_boolean_argument,
};
use self::rendered_fragments::{
    collect_list_pages_html_body_ranges, collect_list_pages_html_escape_ranges,
    push_list_pages_rendered_fragment, push_list_pages_rendered_fragment_with_mode,
    render_list_pages_form_wiki_value,
};
#[cfg(test)]
use self::rendered_fragments::{
    list_pages_rendered_fragment_has_html_block, list_pages_rendered_inline_fragment,
    take_empty_paragraph_restore_scanned_bytes,
};
pub(super) use self::runtime::substitute_list_pages_variables_inner;
pub(in crate::services::render) use self::runtime::{
    ListPagesSubstitutionArgs, ListPagesSubstitutionContext,
};
use self::selectors::{ListPagesNameSelector, compose_list_pages_name_selectors};
pub(in crate::services::render) use self::selectors::{
    UrlSelector, is_dynamic_list_pages_value,
    list_pages_has_unsupported_page_type_selector,
    list_pages_has_unsupported_parent_selector, list_pages_static_category_preflight,
    list_pages_static_url_fallback_marker_range, list_pages_url_fallback,
    parse_list_pages_numeric_argument, preflight_static_list_pages_selector,
    resolve_url_selector, split_list_pages_tag_values,
    substitute_list_pages_current_data_form_variables,
};
pub(in crate::services::render) use self::template_values::{
    list_pages_first_paragraph, list_pages_unknown_link_target_slugs,
    substitute_list_pages_rating_only,
};
use self::template_values::{
    list_pages_variable_inside_quoted_attribute,
    list_pages_variable_starts_triple_link_target, protect_list_pages_content_insertion,
};

use super::template::{
    LISTPAGES_VARIABLE_REGEX, list_pages_variable_capture_has_unknown_name,
    list_pages_variable_capture_is_valid,
};
use crate::services::page_query::{
    ComparisonOperation, CountPagesExactCountEligibilityDiagnostics,
    CountPagesExactCountEligibilityInput, CountPagesExactCountEvaluation,
    DataFormSelector, DateSelector, FoundPageRow, MAX_PAGE_QUERY_SCORE_SELECTORS,
    OrderBySelector, OrderProperty, PageParentSelector, PageQueryResultMetadata,
    PageTypeSelector, RangeSelector, ScoreSelector, evaluate_count_pages_exact_count,
};
use crate::services::render::UrlArguments;
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;
use wikidot_normalize::normalize;

use super::super::compat::CompatHtmlFragments;
use super::super::compat::preparation::neutralize_authored_markers;
use super::super::compat::text_fragments::{CompatTextFragments, escape_html_text};
use super::super::ftml_render::WikidotCompatLinkTitleMap;
use super::super::literal_regions::LiteralRegionCursor;
use super::super::module_arguments::{
    WikidotModuleArgumentValueKind, wikidot_list_pages_arguments,
};
use super::super::service::{
    CountPagesRequiredTagBatchResult, MAX_LISTPAGES_RENDER_LIMIT,
    MAX_LISTPAGES_RENDER_OFFSET, MAX_LISTPAGES_RENDER_SCAN_ROWS, RenderService,
    format_list_pages_rating, native_numbered_list_content,
};
use super::content_sections::wikidot_content_section;
use super::data_forms::{
    ListPagesDataFormDefinition, substitute_list_pages_form_data,
    substitute_list_pages_form_hint, substitute_list_pages_form_label,
    substitute_list_pages_form_raw,
};
use super::delayed::{ListPagesGeneratedSlot, ListPagesRuntimeTextRange};
use super::parents::ListPagesParentDisplay;
use super::presentation::{
    format_list_pages_created_at, is_list_pages_hidden_tag, is_list_pages_visible_tag,
    list_pages_created_by_slug, list_pages_tag_target_prefix,
    protect_list_pages_generated_html, render_list_pages_snapshot_user,
    render_list_pages_snapshot_wikidot_user, render_list_pages_tags,
    render_list_pages_wikidot_user,
};
use super::preview::{
    list_pages_plain_text, list_pages_preview, list_pages_preview_length,
};
use super::scanner::list_pages_runtime_head_can_execute;
use super::titles::{
    render_list_pages_linked_title, sanitize_list_pages_title,
    wikidot_empty_imported_title_label,
};
use ftml::{self};

#[derive(Clone, Debug, PartialEq)]
pub(in crate::services::render) struct ListPagesArguments {
    pub(in crate::services::render) current_page_only: bool,
    pub(in crate::services::render) category_selector_present: bool,
    pub(in crate::services::render) category_all: bool,
    pub(in crate::services::render) include_current_category: bool,
    pub(in crate::services::render) categories: Vec<Cow<'static, str>>,
    pub(in crate::services::render) excluded_categories: Vec<Cow<'static, str>>,
    pub(in crate::services::render) any_tags: Vec<Cow<'static, str>>,
    pub(in crate::services::render) default_tags: Vec<Cow<'static, str>>,
    pub(in crate::services::render) all_tags: Vec<Cow<'static, str>>,
    pub(in crate::services::render) no_tags: Vec<Cow<'static, str>>,
    pub(in crate::services::render) untagged: bool,
    pub(in crate::services::render) same_visible_tags: bool,
    pub(in crate::services::render) exact_visible_tags: bool,
    pub(in crate::services::render) authors: Vec<Cow<'static, str>>,
    pub(in crate::services::render) author_filter_present: bool,
    pub(in crate::services::render) order: Option<OrderBySelector>,
    pub(in crate::services::render) reverse: bool,
    pub(in crate::services::render) limit: Option<u64>,
    pub(in crate::services::render) count_pages_explicit_limit: Option<u64>,
    pub(in crate::services::render) count_pages_per_page: Option<u64>,
    pub(in crate::services::render) url_attr_prefix: Option<Cow<'static, str>>,
    pub(in crate::services::render) tag_target: Option<Cow<'static, str>>,
    pub(in crate::services::render) offset: u32,
    pub(in crate::services::render) offset_origin: ListPagesOffsetOrigin,
    pub(in crate::services::render) offset_beyond_render_window: Option<u64>,
    pub(in crate::services::render) exclude_current_page: bool,
    pub(in crate::services::render) relative_range: Option<RangeSelector>,
    pub(in crate::services::render) page_type: PageTypeSelector,
    pub(in crate::services::render) page_parent: PageParentSelector<'static>,
    pub(in crate::services::render) static_parent_fullname: Option<Cow<'static, str>>,
    pub(in crate::services::render) creation_date: DateSelector,
    pub(in crate::services::render) update_date: DateSelector,
    pub(in crate::services::render) creation_date_current_page: bool,
    pub(in crate::services::render) update_date_current_page: bool,
    pub(in crate::services::render) score: Vec<ScoreSelector>,
    pub(in crate::services::render) score_equals_current_page: bool,
    pub(in crate::services::render) votes: Vec<ScoreSelector>,
    pub(in crate::services::render) votes_equals_current_page: bool,
    pub(in crate::services::render) slug: Option<Cow<'static, str>>,
    pub(in crate::services::render) name_pattern: Option<Cow<'static, str>>,
    pub(in crate::services::render) data_form_fields: Vec<DataFormSelector<'static>>,
    pub(in crate::services::render) prepend_line: Option<String>,
    pub(in crate::services::render) append_line: Option<String>,
    pub(in crate::services::render) separate: bool,
    pub(in crate::services::render) wrapper: bool,
    pub(in crate::services::render) rss_title: Option<String>,
    pub(in crate::services::render) rss_description: Option<String>,
    pub(in crate::services::render) rss_home: Option<String>,
    pub(in crate::services::render) rss_limit: Option<String>,
    pub(in crate::services::render) rss_only: bool,
    pub(in crate::services::render) rss_path: ListPagesRssPath,
    pub(in crate::services::render) exclude_current_page_author: bool,
    pub(in crate::services::render) unsupported_author_filter: bool,
    pub(in crate::services::render) unsupported_list_pages_filter: bool,
    pub(in crate::services::render) link_to: Vec<Cow<'static, str>>,
    pub(in crate::services::render) unsupported_score_filter: bool,
    pub(in crate::services::render) unsupported_count_pages_filter: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(in crate::services::render) struct ListPagesRssPath {
    pub(in crate::services::render) pagetype: Option<String>,
    pub(in crate::services::render) category: Option<String>,
    pub(in crate::services::render) tags: Option<String>,
    pub(in crate::services::render) parent: Option<String>,
    pub(in crate::services::render) created_by: Option<String>,
    pub(in crate::services::render) offset: Option<String>,
    pub(in crate::services::render) rating: Option<String>,
    pub(in crate::services::render) range: Option<String>,
    pub(in crate::services::render) order: Option<String>,
    pub(in crate::services::render) limit: Option<String>,
    pub(in crate::services::render) per_page: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::services::render) enum ListPagesOffsetOrigin {
    Static,
    Url,
    Fallback,
}

pub(in crate::services::render) fn parse_list_pages_arguments(
    head: &str,
) -> Option<ListPagesArguments> {
    parse_list_pages_arguments_with_url(head, UrlArguments::default())
}

pub(in crate::services::render) fn list_pages_recognized_static_url_fallback_ranges(
    head: &str,
    parsed: &ListPagesArguments,
) -> Vec<Range<usize>> {
    wikidot_list_pages_arguments(head)
        .into_iter()
        .filter_map(|argument| {
            let value = argument.value.trim();
            let (selector, _) = value.split_once('|')?;
            let relative_marker = list_pages_static_url_fallback_marker_range(value)?;

            let value_start = value.as_ptr() as usize - head.as_ptr() as usize;
            let value_range = value_start..value_start + value.len();
            let marker_range =
                value_start + relative_marker.start..value_start + relative_marker.end;
            let mut without_fallback =
                String::with_capacity(head.len() - (value.len() - selector.len()));
            without_fallback.push_str(&head[..value_range.start]);
            without_fallback.push_str(selector);
            without_fallback.push_str(&head[value_range.end..]);

            (parse_list_pages_arguments_with_url(
                &without_fallback,
                UrlArguments::default(),
            )
            .as_ref()
                != Some(parsed))
            .then_some(marker_range)
        })
        .collect()
}

pub(in crate::services::render) fn list_pages_static_parent_fullname(
    head: &str,
) -> Option<String> {
    list_pages_static_parent_fullname_with_url(head, UrlArguments::default())
}

pub(in crate::services::render) fn list_pages_static_parent_fullname_with_url(
    head: &str,
    url: UrlArguments<'_>,
) -> Option<String> {
    if !list_pages_runtime_head_can_execute(head) {
        return None;
    }

    let arguments = wikidot_list_pages_arguments(head);
    let url_attr_prefix = arguments
        .iter()
        .filter(|argument| {
            argument.key == "urlAttrPrefix"
                && argument.op == "="
                && argument.value_kind == WikidotModuleArgumentValueKind::DoubleQuoted
        })
        .map(|argument| argument.value)
        .rfind(|prefix| !prefix.is_empty());
    let value = arguments
        .into_iter()
        .filter(|argument| {
            argument.key == "parent"
                && argument.op == "="
                && argument.value_kind == WikidotModuleArgumentValueKind::DoubleQuoted
        })
        .map(|argument| argument.value.trim())
        .next_back()
        .and_then(|value| {
            match resolve_url_selector(
                value,
                url.value_for_list_pages_argument(url_attr_prefix, "parent"),
            ) {
                UrlSelector::Static(value) => Some(value.to_owned()),
                UrlSelector::Resolved(value) => Some(value),
                UrlSelector::Dropped => None,
            }
        })?;
    let value = value.trim();
    let value = value.split('"').next().unwrap_or(value);
    let signed_static_selector = value.get(1..).is_some_and(|remainder| remainder != "-");
    if matches!(value, "" | "." | "-" | "=" | "-=")
        || value.starts_with(['/', '\'', '"'])
        || (value.starts_with(['+', '-']) && signed_static_selector)
    {
        None
    } else {
        Some(value.to_ascii_lowercase())
    }
}

pub(in crate::services::render) fn parse_list_pages_arguments_with_url(
    head: &str,
    url: UrlArguments<'_>,
) -> Option<ListPagesArguments> {
    if !list_pages_runtime_head_can_execute(head) {
        return None;
    }
    let head_arguments = wikidot_list_pages_arguments(head);
    let url_attr_prefix = head_arguments
        .iter()
        .filter(|argument| {
            argument.key == "urlAttrPrefix"
                && argument.op == "="
                && argument.value_kind == WikidotModuleArgumentValueKind::DoubleQuoted
        })
        .map(|argument| argument.value)
        .rfind(|prefix| !prefix.is_empty())
        .map(|prefix| Cow::Owned(prefix.to_owned()));

    let mut category_all = true;
    let mut category_selector_present = false;
    let mut saw_category_argument = false;
    let mut saw_tag_argument = false;
    let mut saw_rss_argument = false;
    let mut current_page_only = false;
    let mut include_current_category = false;
    let mut categories = Vec::new();
    let mut excluded_categories = Vec::new();
    let any_tags = Vec::new();
    let mut default_tags = Vec::new();
    let mut all_tags = Vec::new();
    let mut no_tags = Vec::new();
    let mut untagged = false;
    let mut same_visible_tags = false;
    let mut exact_visible_tags = false;
    let mut authors = Vec::new();
    let mut author_filter_present = false;
    let mut order = None;
    let mut reverse = false;
    let mut limit = None;
    let mut count_pages_explicit_limit = None;
    let mut count_pages_per_page = None;
    let mut tag_target = None;
    let mut offset = 0;
    let mut offset_origin = ListPagesOffsetOrigin::Static;
    let mut offset_beyond_render_window = None;
    let mut exclude_current_page = false;
    let mut skip_current_page = false;
    let mut range_current_page_only = false;
    let mut range_exclude_current_page = false;
    let mut relative_range = None;
    let mut range_displaced_limit: Option<Option<u64>> = None;
    let mut page_type = PageTypeSelector::Normal;
    let mut page_parent = PageParentSelector::All;
    let mut static_parent_fullname = None;
    let mut creation_date = DateSelector::FromPresent {
        start: time::OffsetDateTime::UNIX_EPOCH,
    };
    let mut update_date = DateSelector::FromPresent {
        start: time::OffsetDateTime::UNIX_EPOCH,
    };
    let mut creation_date_current_page = false;
    let mut update_date_current_page = false;
    let mut score = Vec::new();
    let mut score_assignment_count = 0usize;
    let mut score_equals_current_page = false;
    let mut votes = Vec::new();
    let mut votes_assignment_count = 0usize;
    let mut votes_equals_current_page = false;
    let mut canonical_name_selector = None;
    let mut alias_name_selector = None;
    let mut data_form_fields = Vec::new();
    let mut prepend_line = None;
    let mut append_line = None;
    let mut separate = true;
    let mut wrapper = true;
    let mut rss_title = None;
    let mut rss_description = None;
    let mut rss_home = None;
    let mut rss_limit = None;
    let mut rss_only = false;
    let mut rss_path = ListPagesRssPath::default();
    let unsupported_author_filter = false;
    let mut exclude_current_page_author = false;
    let mut unsupported_list_pages_filter = false;
    let mut link_to = Vec::new();
    let mut unsupported_score_filter = false;
    let mut unsupported_count_pages_filter = false;

    for argument in head_arguments {
        let raw_key = argument.key;
        let key = raw_key.to_ascii_lowercase();
        let double_quoted_assignment = argument.op == "="
            && argument.value_kind == WikidotModuleArgumentValueKind::DoubleQuoted;
        let exact_grammar_family = matches!(
            key.as_str(),
            "category"
                | "categories"
                | "tags"
                | "tag"
                | "name"
                | "fullname"
                | "limit"
                | "offset"
                | "perpage"
                | "per_page"
                | "separate"
                | "wrapper"
                | "reverse"
                | "range"
                | "created_by"
                | "createdby"
                | "rss"
                | "rsstitle"
                | "rssdescription"
                | "rsshome"
                | "rsslimit"
                | "rssonly"
                | "prependline"
                | "prepend_line"
                | "appendline"
        );
        let exact_grammar_token = matches!(
            raw_key,
            "category"
                | "categories"
                | "tags"
                | "tag"
                | "name"
                | "fullname"
                | "limit"
                | "offset"
                | "perPage"
                | "separate"
                | "wrapper"
                | "reverse"
                | "range"
                | "created_by"
                | "createdBy"
                | "rss"
                | "rssTitle"
                | "rssDescription"
                | "rssHome"
                | "rssLimit"
                | "rssOnly"
                | "prependLine"
                | "appendLine"
        ) && double_quoted_assignment;
        if exact_grammar_family && !exact_grammar_token
            || matches!(key.as_str(), "createdat" | "updatedat")
        {
            continue;
        }
        if key == "score" {
            score_assignment_count = score_assignment_count.saturating_add(1);
            if score_assignment_count > MAX_PAGE_QUERY_SCORE_SELECTORS {
                unsupported_score_filter = true;
            }
            continue;
        }
        let comparison_value;
        let raw_value = if argument.op == "=" || raw_key.starts_with("_") {
            if raw_key.starts_with("_") && !matches!(argument.op, "=" | "!=") {
                continue;
            }
            Cow::Borrowed(argument.value)
        } else if argument.value_kind == WikidotModuleArgumentValueKind::DoubleQuoted
            && matches!(
                raw_key,
                "rating" | "votes" | "created_at" | "date" | "updated_at"
            )
        {
            comparison_value = list_pages_comparison_value(argument.op, argument.value);
            Cow::Owned(comparison_value)
        } else {
            continue;
        };
        let raw_value = raw_value.as_ref();
        let value = raw_value.trim();
        if argument.value_kind == WikidotModuleArgumentValueKind::Bare
            && value.starts_with("&quot;")
            && value.ends_with("&quot;")
        {
            continue;
        }

        match key.as_str() {
            "tags" => {
                if saw_tag_argument {
                    continue;
                }
                default_tags.clear();
                all_tags.clear();
                no_tags.clear();
                untagged = false;
                same_visible_tags = false;
                exact_visible_tags = false;
                rss_path.tags = None;

                let resolved_url_tag;
                let mut empty_url_fallback = false;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        raw_key,
                    ),
                ) {
                    UrlSelector::Static(resolved) => {
                        empty_url_fallback = is_dynamic_list_pages_value(value)
                            && resolved.trim().is_empty();
                        resolved
                    }
                    UrlSelector::Resolved(tag) => {
                        unsupported_count_pages_filter = true;
                        resolved_url_tag = tag;
                        resolved_url_tag.as_str()
                    }
                    UrlSelector::Dropped => {
                        unsupported_count_pages_filter = true;
                        if split_list_pages_tag_values(value).len() > 1 {
                            value
                        } else {
                            continue;
                        }
                    }
                };
                if empty_url_fallback {
                    all_tags.push(Cow::Borrowed(""));
                    continue;
                }
                rss_path.tags = normalize_list_pages_feed_selector(value);
                let tags = split_list_pages_tag_values(value);
                let select_untagged = tags.len() == 1
                    && tags.first().is_some_and(|tag| is_no_tags_selector(tag));
                for tag in tags {
                    if is_no_tags_selector(&tag) {
                        if select_untagged {
                            untagged = true;
                            unsupported_count_pages_filter = true;
                        }
                        continue;
                    }
                    if tag == "=" {
                        same_visible_tags = true;
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                    if tag == "==" {
                        exact_visible_tags = true;
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                    if is_current_page_tag_selector(&tag) {
                        unsupported_count_pages_filter = true;
                        unsupported_list_pages_filter = true;
                        continue;
                    }
                    if let Some(tag) = tag.strip_prefix('-') {
                        no_tags.push(Cow::Owned(tag.to_owned()));
                    } else if let Some(tag) = tag.strip_prefix('+') {
                        all_tags.push(Cow::Owned(tag.to_owned()));
                    } else {
                        default_tags.push(Cow::Owned(tag));
                    }
                }
            }
            "tag" => {
                if value.is_empty() {
                    continue;
                }
                saw_tag_argument = true;
                default_tags.clear();
                all_tags.clear();
                no_tags.clear();
                untagged = false;
                same_visible_tags = false;
                exact_visible_tags = false;
                rss_path.tags = None;

                let resolved_url_tag;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        raw_key,
                    ),
                ) {
                    UrlSelector::Static(value) => value,
                    UrlSelector::Resolved(tag) => {
                        unsupported_count_pages_filter = true;
                        resolved_url_tag = tag;
                        resolved_url_tag.as_str()
                    }
                    UrlSelector::Dropped => {
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                };
                rss_path.tags = normalize_list_pages_feed_selector(value);
                let tags = split_list_pages_tag_values(value);
                let select_untagged = tags.len() == 1
                    && tags.first().is_some_and(|tag| is_no_tags_selector(tag));
                for tag in tags {
                    if is_no_tags_selector(&tag) {
                        if select_untagged {
                            untagged = true;
                            unsupported_count_pages_filter = true;
                        }
                        continue;
                    }
                    if tag == "=" {
                        same_visible_tags = true;
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                    if tag == "==" {
                        exact_visible_tags = true;
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                    if is_current_page_tag_selector(&tag) {
                        unsupported_count_pages_filter = true;
                        unsupported_list_pages_filter = true;
                        continue;
                    }
                    if let Some(tag) = tag.strip_prefix('-') {
                        no_tags.push(Cow::Owned(tag.to_owned()));
                    } else if let Some(tag) = tag.strip_prefix('+') {
                        all_tags.push(Cow::Owned(tag.to_owned()));
                    } else {
                        default_tags.push(Cow::Owned(tag));
                    }
                }
            }
            "category" | "categories" => {
                if key == "categories" && saw_category_argument {
                    continue;
                }
                if key == "category" {
                    saw_category_argument = true;
                }
                category_all = true;
                category_selector_present = false;
                include_current_category = false;
                categories.clear();
                excluded_categories.clear();
                rss_path.category = None;

                let mut saw_included_category = false;
                let resolved_url_category;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        "category",
                    ),
                ) {
                    UrlSelector::Static(value) => value,
                    UrlSelector::Resolved(category) => {
                        unsupported_count_pages_filter = true;
                        resolved_url_category = category;
                        resolved_url_category.as_str()
                    }
                    UrlSelector::Dropped => {
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                };
                let Some(feed_category) = normalize_list_pages_feed_selector(value)
                else {
                    continue;
                };
                rss_path.category = Some(feed_category);
                category_selector_present = true;
                for category in split_list_pages_values(value) {
                    if category == "*" {
                        category_all = true;
                    } else if category == "." {
                        include_current_category = true;
                        saw_included_category = true;
                    } else if let Some(category) = category.strip_prefix('+') {
                        categories.push(Cow::Owned(category.to_lowercase()));
                        saw_included_category = true;
                    } else if let Some(category) = category.strip_prefix('-') {
                        excluded_categories.push(Cow::Owned(category.to_lowercase()));
                    } else {
                        categories.push(Cow::Owned(category.to_lowercase()));
                        saw_included_category = true;
                    }
                }
                if saw_included_category {
                    category_all = false;
                }
            }
            "limit" => {
                let resolved_url_limit;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        "limit",
                    ),
                ) {
                    UrlSelector::Static(value) => value,
                    UrlSelector::Resolved(resolved) => {
                        unsupported_count_pages_filter = true;
                        resolved_url_limit = resolved;
                        resolved_url_limit.as_str()
                    }
                    UrlSelector::Dropped => {
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                };
                rss_path.limit = nonempty_list_pages_feed_value(value);
                if let Some(parsed) = parse_list_pages_numeric_argument(value) {
                    limit = Some(parsed);
                    range_displaced_limit = None;
                    count_pages_explicit_limit = Some(parsed);
                }
            }
            "perpage" | "per_page" => {
                let resolved_url_per_page;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        raw_key,
                    ),
                ) {
                    UrlSelector::Static(_) => raw_value,
                    UrlSelector::Resolved(resolved) => {
                        unsupported_count_pages_filter = true;
                        resolved_url_per_page = resolved;
                        resolved_url_per_page.as_str()
                    }
                    UrlSelector::Dropped => {
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                };
                rss_path.per_page = nonempty_list_pages_feed_value(value);
                count_pages_per_page =
                    if value.len() > 1 && value.bytes().all(|byte| byte == b'0') {
                        Some(0)
                    } else {
                        parse_list_pages_numeric_argument(value)
                            .filter(|parsed| *parsed > 0)
                            .map(|parsed| parsed.min(MAX_LISTPAGES_RENDER_LIMIT))
                    };
            }
            "offset" => {
                let dynamic = is_dynamic_list_pages_value(value);
                let resolved_url_offset;
                let legacy_url_offset = url
                    .offset
                    .filter(|offset| {
                        url_attr_prefix.is_none()
                            && *offset <= MAX_LISTPAGES_RENDER_OFFSET
                    })
                    .map(|offset| offset.to_string());
                let value = match resolve_url_selector(
                    value,
                    if url_attr_prefix.is_some() {
                        url.value_for_list_pages_argument(
                            url_attr_prefix.as_deref(),
                            "offset",
                        )
                    } else {
                        legacy_url_offset.as_deref()
                    },
                ) {
                    UrlSelector::Static(static_value) => {
                        offset_origin = if dynamic {
                            ListPagesOffsetOrigin::Fallback
                        } else {
                            ListPagesOffsetOrigin::Static
                        };
                        if dynamic { static_value } else { raw_value }
                    }
                    UrlSelector::Resolved(resolved) => {
                        offset_origin = ListPagesOffsetOrigin::Url;
                        resolved_url_offset = resolved;
                        resolved_url_offset.as_str()
                    }
                    UrlSelector::Dropped => {
                        unsupported_count_pages_filter = true;
                        offset_origin = ListPagesOffsetOrigin::Fallback;
                        continue;
                    }
                };
                let parsed = parse_list_pages_numeric_argument(value).unwrap_or(0);
                rss_path.offset = nonempty_list_pages_feed_value(value);
                if parsed > u64::from(MAX_LISTPAGES_RENDER_OFFSET) {
                    offset_beyond_render_window = Some(parsed);
                    offset = 0;
                } else {
                    offset_beyond_render_window = None;
                    offset = parsed as u32;
                }
            }
            "pagetype" => {
                let resolved_url_page_type;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        raw_key,
                    ),
                ) {
                    UrlSelector::Static(static_value) => {
                        if is_dynamic_list_pages_value(value) {
                            static_value
                        } else {
                            raw_value
                        }
                    }
                    UrlSelector::Resolved(resolved) => {
                        unsupported_count_pages_filter = true;
                        resolved_url_page_type = resolved;
                        resolved_url_page_type.as_str()
                    }
                    UrlSelector::Dropped => {
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                };
                if key == "pagetype" {
                    rss_path.pagetype = nonempty_list_pages_feed_value(value);
                }
                page_type = parse_list_pages_page_type(value)?;
            }
            "parent" => {
                if raw_key != "parent" || !double_quoted_assignment {
                    continue;
                }
                let resolved_url_parent;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        "parent",
                    ),
                ) {
                    UrlSelector::Static(value) => value,
                    UrlSelector::Resolved(resolved) => {
                        unsupported_count_pages_filter = true;
                        resolved_url_parent = resolved;
                        resolved_url_parent.as_str()
                    }
                    UrlSelector::Dropped => {
                        unsupported_count_pages_filter = true;
                        page_parent = PageParentSelector::All;
                        static_parent_fullname = None;
                        rss_path.parent = None;
                        continue;
                    }
                };
                rss_path.parent = nonempty_list_pages_feed_value(value);
                match value {
                    "-" => page_parent = PageParentSelector::NoParent,
                    "=" => page_parent = PageParentSelector::SameParents,
                    "-=" => page_parent = PageParentSelector::DifferentParents,
                    "." => page_parent = PageParentSelector::ChildOf,
                    "" => page_parent = PageParentSelector::All,
                    _ if is_dynamic_list_pages_value(value) => return None,
                    _ => {
                        page_parent = PageParentSelector::All;
                        static_parent_fullname =
                            Some(Cow::Owned(value.trim().to_ascii_lowercase()));
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                }
                static_parent_fullname = None;
            }
            "prependline" | "prepend_line" => {
                prepend_line = Some(value.to_owned());
            }
            "appendline" => {
                append_line = Some(value.to_owned());
            }
            "order" => {
                if raw_key != "order" || !double_quoted_assignment {
                    continue;
                }
                if value.is_empty() {
                    rss_path.order = None;
                    order = None;
                    continue;
                }
                let resolved_url_order;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        "order",
                    ),
                ) {
                    UrlSelector::Static(value) => value,
                    UrlSelector::Resolved(resolved) => {
                        unsupported_count_pages_filter = true;
                        resolved_url_order = resolved;
                        resolved_url_order.as_str()
                    }
                    UrlSelector::Dropped => {
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                };
                rss_path.order = Some(value.to_owned());
                if let Some(parsed) = parse_list_pages_order(value) {
                    order = Some(parsed);
                } else {
                    unsupported_list_pages_filter = true;
                    order = None;
                }
            }
            "reverse" => {
                let resolved_url_reverse;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        "reverse",
                    ),
                ) {
                    UrlSelector::Static(value) => value,
                    UrlSelector::Resolved(resolved) => {
                        unsupported_count_pages_filter = true;
                        resolved_url_reverse = resolved;
                        resolved_url_reverse.as_str()
                    }
                    UrlSelector::Dropped => {
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                };
                reverse = matches!(value.to_ascii_lowercase().as_str(), "yes" | "true");
            }
            "name" | "fullname" => {
                let resolved_url_name;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        raw_key,
                    ),
                ) {
                    UrlSelector::Static(value) => value,
                    UrlSelector::Resolved(resolved) => {
                        unsupported_count_pages_filter = true;
                        resolved_url_name = resolved;
                        resolved_url_name.as_str()
                    }
                    UrlSelector::Dropped => {
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                };
                let value = exact_raw_color_list_pages_name(value).unwrap_or(value);
                let selector = if value == "=" {
                    limit = Some(1);
                    range_displaced_limit = None;
                    Some(ListPagesNameSelector::CurrentPage)
                } else if !value.is_empty() && !is_dynamic_list_pages_value(value) {
                    let value = wikidot_list_pages_name_slug(value);
                    if value.contains(['*', '%', '?']) {
                        Some(ListPagesNameSelector::Pattern(Cow::Owned(value)))
                    } else {
                        Some(ListPagesNameSelector::Exact(Cow::Owned(value)))
                    }
                } else {
                    None
                };
                if raw_key == "name" {
                    canonical_name_selector = selector;
                } else {
                    alias_name_selector = selector;
                }
            }
            "separate" => {
                separate = parse_list_pages_false_only_boolean_argument(raw_value);
            }
            "created_by" | "createdby" => {
                if key == "created_by" {
                    rss_path.created_by = nonempty_list_pages_feed_value(value)
                        .map(|value| value.to_ascii_lowercase());
                }
                let resolved_url_author;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        raw_key,
                    ),
                ) {
                    UrlSelector::Static(value) => value,
                    UrlSelector::Resolved(resolved) => {
                        unsupported_count_pages_filter = true;
                        resolved_url_author = resolved;
                        resolved_url_author.as_str()
                    }
                    UrlSelector::Dropped => {
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                };
                author_filter_present = false;
                authors.clear();
                exclude_current_page_author = false;
                let author = value
                    .trim()
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .trim();
                if author == "-=" {
                    author_filter_present = true;
                    exclude_current_page_author = true;
                    unsupported_count_pages_filter = true;
                    continue;
                }
                if !author.is_empty() {
                    author_filter_present = true;
                    authors.push(Cow::Owned(author.to_owned()));
                }
            }
            "range" => {
                unsupported_count_pages_filter |= is_dynamic_list_pages_value(value);
                let resolved_url_range;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        "range",
                    ),
                ) {
                    UrlSelector::Static(value) => value,
                    UrlSelector::Resolved(range) => {
                        resolved_url_range = range;
                        resolved_url_range.as_str()
                    }
                    UrlSelector::Dropped => continue,
                };
                rss_path.range = nonempty_list_pages_feed_value(value);
                if let Some(displaced_limit) = range_displaced_limit.take() {
                    limit = displaced_limit;
                }
                range_current_page_only = false;
                range_exclude_current_page = false;
                relative_range = None;
                match value {
                    "." => {
                        range_current_page_only = true;
                        range_displaced_limit = Some(limit);
                        limit = Some(1);
                    }
                    "others" | "other" => {
                        range_exclude_current_page = true;
                    }
                    "before" | "after" => {
                        unsupported_count_pages_filter = true;
                        relative_range = Some(if value == "before" {
                            RangeSelector::Before
                        } else {
                            RangeSelector::After
                        });
                    }
                    _ => {}
                }
            }
            "skipcurrent" | "skip_current" => {
                if raw_key != "skipCurrent" || !double_quoted_assignment {
                    continue;
                }
                unsupported_count_pages_filter |= is_dynamic_list_pages_value(value);
                let resolved_url_skip_current;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        raw_key,
                    ),
                ) {
                    UrlSelector::Static(value) => value,
                    UrlSelector::Resolved(resolved) => {
                        unsupported_count_pages_filter = true;
                        resolved_url_skip_current = resolved;
                        resolved_url_skip_current.as_str()
                    }
                    UrlSelector::Dropped => {
                        skip_current_page = false;
                        continue;
                    }
                };
                skip_current_page =
                    matches!(value.trim().to_ascii_lowercase().as_str(), "yes" | "true");
            }
            "wrapper" => {
                wrapper = parse_list_pages_false_only_boolean_argument(raw_value);
            }
            "rss" if !raw_value.is_empty() => {
                saw_rss_argument = true;
                rss_title = Some(raw_value.to_owned());
            }
            "rss" => {}
            "rsstitle" if !saw_rss_argument => {
                rss_title = Some(raw_value.to_owned());
            }
            "rsstitle" => {}
            "rssdescription" => {
                rss_description = Some(raw_value.to_owned());
            }
            "rsshome" => {
                rss_home = Some(raw_value.to_owned());
            }
            "rsslimit" => {
                rss_limit =
                    (!value.is_empty() && value != "0").then(|| raw_value.to_owned());
            }
            "rssonly" => {
                rss_only = matches!(value.to_ascii_lowercase().as_str(), "yes" | "true");
            }
            "rating" | "score" => {
                if key == "rating" {
                    let feed_value = list_pages_url_fallback(value).unwrap_or(value);
                    rss_path.rating = nonempty_list_pages_feed_value(feed_value);
                }
                let resolved_url_score;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        raw_key,
                    ),
                ) {
                    UrlSelector::Static(value) => value,
                    UrlSelector::Resolved(resolved) => {
                        unsupported_count_pages_filter = true;
                        resolved_url_score = resolved;
                        resolved_url_score.as_str()
                    }
                    UrlSelector::Dropped => {
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                };
                score_assignment_count = score_assignment_count.saturating_add(1);
                if score_assignment_count > MAX_PAGE_QUERY_SCORE_SELECTORS {
                    unsupported_score_filter = true;
                }
                score.clear();
                score_equals_current_page = false;
                if value.is_empty() {
                    continue;
                }
                if value == "=" {
                    score_equals_current_page = true;
                    unsupported_count_pages_filter = true;
                    continue;
                }
                if score.len() >= MAX_PAGE_QUERY_SCORE_SELECTORS {
                    unsupported_score_filter = true;
                } else {
                    if let Some(selector) = parse_list_pages_score_selector(value) {
                        score.push(selector);
                    }
                }
            }
            "votes" => {
                unsupported_count_pages_filter = true;
                let resolved_url_votes;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        "votes",
                    ),
                ) {
                    UrlSelector::Static(value) => value,
                    UrlSelector::Resolved(resolved) => {
                        resolved_url_votes = resolved;
                        resolved_url_votes.as_str()
                    }
                    UrlSelector::Dropped => continue,
                };
                votes_assignment_count = votes_assignment_count.saturating_add(1);
                if votes_assignment_count > MAX_PAGE_QUERY_SCORE_SELECTORS {
                    unsupported_score_filter = true;
                }
                votes.clear();
                votes_equals_current_page = false;
                if value.is_empty() {
                    continue;
                }
                if value == "=" {
                    votes_equals_current_page = true;
                    continue;
                }
                if votes.len() >= MAX_PAGE_QUERY_SCORE_SELECTORS {
                    unsupported_score_filter = true;
                } else {
                    if let Some(selector) = parse_list_pages_score_selector(value) {
                        votes.push(selector);
                    }
                }
            }
            "created_at" | "createdat" | "date" => {
                let resolved_url_created_at;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        raw_key,
                    ),
                ) {
                    UrlSelector::Static(value) => value,
                    UrlSelector::Resolved(resolved) => {
                        unsupported_count_pages_filter = true;
                        resolved_url_created_at = resolved;
                        resolved_url_created_at.as_str()
                    }
                    UrlSelector::Dropped => {
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                };
                if value == "=" {
                    creation_date_current_page = true;
                    unsupported_count_pages_filter = true;
                } else if let Some(date) = parse_list_pages_date_selector(value) {
                    creation_date = date;
                }
            }
            "updated_at" | "updatedat" => {
                let resolved_url_updated_at;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        raw_key,
                    ),
                ) {
                    UrlSelector::Static(value) => value,
                    UrlSelector::Resolved(resolved) => {
                        unsupported_count_pages_filter = true;
                        resolved_url_updated_at = resolved;
                        resolved_url_updated_at.as_str()
                    }
                    UrlSelector::Dropped => {
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                };
                if value == "=" {
                    update_date_current_page = true;
                    unsupported_count_pages_filter = true;
                } else if let Some(date) = parse_list_pages_date_selector(value) {
                    update_date = date;
                }
            }
            "link_to" | "linkto" => {
                if raw_key != "link_to" || !double_quoted_assignment {
                    continue;
                }
                link_to.clear();
                if value.is_empty() {
                    continue;
                }
                unsupported_count_pages_filter = true;
                let resolved_url_link;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        raw_key,
                    ),
                ) {
                    UrlSelector::Static(value) => value,
                    UrlSelector::Resolved(resolved) => {
                        resolved_url_link = resolved;
                        resolved_url_link.as_str()
                    }
                    UrlSelector::Dropped => continue,
                };
                let target = value.trim();
                if target.is_empty() || target.contains(',') {
                    unsupported_count_pages_filter = true;
                    unsupported_list_pages_filter = true;
                    continue;
                }
                if target == "." {
                    link_to.push(Cow::Borrowed("."));
                    continue;
                }
                let mut target = target.to_owned();
                normalize(&mut target);
                link_to.push(Cow::Owned(target));
            }
            "tagtarget" | "tag_target" => {
                if raw_key != "tagTarget" || !double_quoted_assignment {
                    continue;
                }
                tag_target = (!argument.value.is_empty())
                    .then(|| Cow::Owned(argument.value.to_owned()));
            }
            "urlattrprefix" => {
                if raw_key != "urlAttrPrefix" || !double_quoted_assignment {
                    continue;
                }
                unsupported_count_pages_filter = true;
            }
            "form" => {}
            _ if raw_key.starts_with('_') => {
                if argument.value_kind != WikidotModuleArgumentValueKind::DoubleQuoted
                    || !matches!(argument.op, "=" | "!=")
                {
                    continue;
                }
                if argument.value.is_empty() {
                    continue;
                }
                unsupported_count_pages_filter |= is_dynamic_list_pages_value(value);
                let resolved_url_field;
                let value = match resolve_url_selector(
                    value,
                    url.value_for_list_pages_argument(
                        url_attr_prefix.as_deref(),
                        raw_key,
                    ),
                ) {
                    UrlSelector::Static(value) => value,
                    UrlSelector::Resolved(resolved) => {
                        unsupported_count_pages_filter = true;
                        resolved_url_field = resolved;
                        resolved_url_field.as_str()
                    }
                    UrlSelector::Dropped => {
                        unsupported_count_pages_filter = true;
                        continue;
                    }
                };
                let value = preflight_static_list_pages_selector(
                    value,
                    &mut unsupported_count_pages_filter,
                )?;
                let field = raw_key
                    .strip_prefix('_')
                    .expect("data form selector should start with an underscore");
                if is_dynamic_list_pages_value(value) {
                    return None;
                }
                data_form_fields.push(DataFormSelector {
                    field: Cow::Owned(field.to_owned()),
                    value: Cow::Owned(value.to_owned()),
                    negated: argument.op == "!=",
                });
            }
            _ => {}
        }
    }

    let composed_name_selector =
        compose_list_pages_name_selectors(canonical_name_selector, alias_name_selector);
    current_page_only |= composed_name_selector.current_page_only;
    let slug = composed_name_selector.slug;
    let name_pattern = composed_name_selector.name_pattern;
    unsupported_count_pages_filter |= composed_name_selector.unsupported;
    unsupported_list_pages_filter |= composed_name_selector.unsupported;

    if score_equals_current_page && score.len() == MAX_PAGE_QUERY_SCORE_SELECTORS {
        unsupported_score_filter = true;
    }
    if votes_equals_current_page && votes.len() == MAX_PAGE_QUERY_SCORE_SELECTORS {
        unsupported_score_filter = true;
    }
    current_page_only |= range_current_page_only;
    exclude_current_page |= range_exclude_current_page;
    exclude_current_page |= skip_current_page;
    if same_visible_tags
        && default_tags.is_empty()
        && all_tags.is_empty()
        && no_tags.is_empty()
        && !untagged
        && !exact_visible_tags
    {
        exclude_current_page = true;
    }

    Some(ListPagesArguments {
        current_page_only,
        category_selector_present,
        category_all,
        include_current_category,
        categories,
        excluded_categories,
        any_tags,
        default_tags,
        all_tags,
        no_tags,
        untagged,
        same_visible_tags,
        exact_visible_tags,
        authors,
        author_filter_present,
        order,
        reverse,
        limit,
        count_pages_explicit_limit,
        count_pages_per_page,
        url_attr_prefix,
        tag_target,
        offset,
        offset_origin,
        offset_beyond_render_window,
        exclude_current_page,
        relative_range,
        page_type,
        page_parent,
        static_parent_fullname,
        creation_date,
        update_date,
        creation_date_current_page,
        update_date_current_page,
        score,
        score_equals_current_page,
        votes,
        votes_equals_current_page,
        slug,
        name_pattern,
        data_form_fields,
        prepend_line,
        append_line,
        separate,
        wrapper,
        rss_title,
        rss_description,
        rss_home,
        rss_limit,
        rss_only,
        rss_path,
        exclude_current_page_author,
        unsupported_author_filter,
        unsupported_list_pages_filter,
        link_to,
        unsupported_score_filter,
        unsupported_count_pages_filter,
    })
}
