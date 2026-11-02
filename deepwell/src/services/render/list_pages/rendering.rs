/*
 * services/render/list_pages/rendering.rs
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

use super::super::AuthorizedPageSelector;
use super::super::compat::CompatHtmlFragments;
use super::super::compat::preparation::neutralize_authored_markers;
use super::super::compat::text_fragments::{CompatTextFragments, escape_html_text};
use super::super::literal_regions::{
    ListPagesSourceProjection, LiteralRegionIndex, collect_list_pages_css_yield_openers,
};
use super::super::render_budget::{
    MAX_SELECTED_CONTENT_RENDER_DEPTH, SharedRenderCostBudget,
};
use super::super::render_options::{RenderContext, RenderInnerOptions};
use super::super::runtime::{IncludeSourceCache, RenderRuntime};
use super::super::runtime_page_queries::{
    CountPagesRawScanCompletion, render_page_query_uses_single_scan,
};
use super::super::service::{
    COUNTPAGES_MODULE_REGEX, CountPagesRequiredTagBatchResult,
    DEFAULT_LISTPAGES_PER_PAGE, IncludeExpansion, IncludeExpansionBudget,
    MAX_LISTPAGES_RENDER_LIMIT, MAX_LISTPAGES_RENDER_SCAN_ROWS, RenderService,
    escape_list_pages_html_attr, has_include_opening_candidate,
    native_numbered_list_content,
};
use super::super::url_arguments::UrlArguments;
use super::content_sections::wikidot_content_section;
use super::current_data_form::{
    current_data_form_list_pages_head, load_current_page_data_form_context,
};
use super::parents::{load_list_pages_child_counts, load_list_pages_parent_displays};
use super::rendering_support::{
    ListPagesBlock, ListPagesBlockPlan, list_pages_raw_footnote_prefix_end,
    list_pages_template_has_block_section, list_pages_template_starts_with_inline_anchor,
};
use super::scanner::{
    CountPagesCloseReachabilityIndex, has_count_pages_module_opening_candidate,
    has_list_pages_module_opening_candidate,
    list_pages_body_has_standalone_count_pages_opening,
    list_pages_body_inline_count_pages_legacy_tail, list_pages_runtime_head_can_execute,
};
use super::template::{ListPagesOutputShape, ListPagesTemplatePlan};
use super::{
    CountPagesBlockRenderResult, CountPagesExpansionOptions, CountPagesRequiredTagSource,
    CountPagesRequiredTagTotal, ListPagesArgumentError, ListPagesArguments,
    ListPagesAuthorCacheKey, ListPagesBatchDisplayRequirements, ListPagesBatchDisplays,
    ListPagesBlockRenderResult, ListPagesContentCache, ListPagesExpansion,
    ListPagesExpansionBudget, ListPagesExpansionOptions, ListPagesPageContext,
    ListPagesPagerRoute, ListPagesRenderedBlock, ListPagesSubstitutionContext,
    MAX_NESTED_LISTPAGES_DEPTH, MAX_NESTED_LISTPAGES_MODULES_PER_PASS,
    PendingDelayedListPagesOutput, ResolvedListPagesAuthors,
    advance_literal_cursor_and_check_count_pages_capture_containment,
    append_list_pages_delayed_occurrences, append_list_pages_runtime_text_ranges,
    count_pages_exact_count_render_diagnostics, count_pages_required_tag_batch_result,
    count_pages_required_tag_batch_selector, count_pages_scan_requires_preservation,
    count_pages_should_remain_literal, count_pages_unbounded_all_category_shape,
    count_pages_unbounded_total, exact_name_list_pages_batch_key,
    expand_list_pages_generated_includes,
    find_list_pages_module_matches_with_delayed_links_budgeted,
    finish_or_defer_list_pages_delayed_output_with_modes, is_list_pages_visible_tag,
    list_pages_argument_error_with_parent_precedence,
    list_pages_body_is_no_visible_tracking_markup,
    list_pages_body_starts_with_preparsed_block, list_pages_body_uses_first_image,
    list_pages_content_query_target, list_pages_created_by_slug,
    list_pages_feed_info_html, list_pages_feed_only_render_result,
    list_pages_first_paragraph, list_pages_has_unsupported_page_type_selector,
    list_pages_has_unsupported_parent_selector,
    list_pages_head_has_current_data_form_query_selector,
    list_pages_html_encoded_head_owns_script_tail, list_pages_parent_fullname,
    list_pages_row_markup_bytes, list_pages_row_scan_target,
    list_pages_runtime_container_open, list_pages_runtime_row_container_close,
    list_pages_runtime_row_container_open, list_pages_static_category_preflight,
    list_pages_static_parent_fullname_with_url, list_pages_unknown_link_target_slugs,
    load_list_pages_data_form_definitions, load_list_pages_first_images,
    page_query_cap_requires_original_module, parse_list_pages_arguments,
    parse_list_pages_arguments_with_url, prepare_delayed_list_pages_row_with_budget,
    prepare_list_pages_rendered_block, preserve_list_pages_module_matches,
    protect_ajax_module_literal_markers, push_list_pages_generated_output,
    push_list_pages_generated_output_with_cost, push_list_pages_pager,
    push_list_pages_trailing_runtime_blocks, raw_module_close_end,
    resolve_list_pages_first_image, restore_pending_nested_list_pages,
    seal_pending_list_pages_delayed_outputs, seal_zero_row_list_pages_wrapper,
    seed_random_list_pages_order, should_render_current_page_list_pages_row,
    substitute_count_pages_variables, union_found_page_fields,
    unsupported_list_pages_replacement, url_offset_list_pages_content_bytes,
};
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::hash::{TextHash, k12_hash};
use crate::models::page_category::{self, Entity as PageCategory};
use crate::services::ServiceContext;
use crate::services::page_query::{
    CategoriesSelector, ComparisonOperation, DateSelector, DateTimeResolution,
    FoundPageFields, FoundPageRow, FoundPages, IncludedCategories,
    ListPagesRenderDiagnosticsInput, OrderProperty, PageParentSelector, PageQuery,
    PageQueryScoreFilterCache, PaginationSelector, RangeSelector, ScoreSelector,
    TagCondition, list_pages_render_diagnostics, parse_static_wikidot_data_form_values,
};
use crate::services::permission::{CheckPermissionContext, PermissionService};
use crate::services::{
    CategoryService, PageQueryService, PageRevisionService, PageService, SiteService,
};
use crate::types::{Action, Permission, Reference, Resource};
use ftml::data::{PageInfo, PageRef, ScoreValue};
use ftml::settings::WikitextSettings;
use regex::Regex;
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, FromQueryResult, QueryFilter, Statement,
    Value,
};
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Range;
use std::sync::LazyLock;

const COUNTPAGES_DEFAULT_SHELL: &str = concat!(
    "<div class=\"list-pages-box\">\n",
    "<h1><span>%%linked_title%%</span></h1>\n",
    "<p>by %%author%% %%date|%O ago (%e %b %Y, %H:%M)%%</p>\n",
    "<p>%%short%%</p>\n",
    "</div>",
);

#[path = "rendering/block_render.rs"]
mod block_render;
#[path = "rendering/count_block.rs"]
mod count_block;
#[path = "rendering/count_expansion.rs"]
mod count_expansion;
#[path = "rendering/expansion.rs"]
mod expansion;
#[path = "rendering/selected_content.rs"]
mod selected_content;

pub(in crate::services::render) use self::selected_content::render_wikidot_social_module;
use self::selected_content::{
    SelectedContentIncludeMode, render_list_pages_default_summary_source,
    render_list_pages_selected_content_source, select_list_pages_rows,
};

fn list_pages_module654_literal(original: &str) -> String {
    const STANDARD: &str = "[[module";
    debug_assert!(
        original
            .get(..STANDARD.len())
            .is_some_and(|name| name.eq_ignore_ascii_case(STANDARD)),
    );
    let mut literal = String::with_capacity(original.len() + "654".len());
    literal.push_str(&original[..STANDARD.len()]);
    literal.push_str("654");
    literal.push_str(&original[STANDARD.len()..]);
    literal
}

fn push_source_without_css_yield_openers(
    output: &mut String,
    source: &str,
    segment: Range<usize>,
    openers: &[Range<usize>],
    opener_index: &mut usize,
) {
    let mut cursor = segment.start;
    while let Some(opener) = openers.get(*opener_index) {
        if opener.end <= cursor {
            *opener_index += 1;
            continue;
        }
        if opener.start >= segment.end {
            break;
        }
        if cursor < opener.start {
            output.push_str(&source[cursor..opener.start]);
        }
        cursor = cursor.max(opener.end);
        *opener_index += 1;
    }
    output.push_str(&source[cursor..segment.end]);
}
