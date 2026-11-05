/*
 * services/render/list_pages/rendering_support.rs
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
use super::super::compat::preparation::neutralize_authored_markers;
use super::super::compat::text_fragments::CompatTextFragments;
use super::super::include_comment_branches::remove_unresolved_include_comment_branches;
use super::super::literal_regions::{ListPagesSourceProjection, LiteralRegionIndex};
use super::super::render_budget::SharedRenderCostBudget;
use super::super::runtime::IncludeSourceCache;
use super::super::service::{IncludeExpansion, IncludeExpansionBudget, RenderService};
use super::scanner::{CountPagesCloseReachabilityIndex, ListPagesModuleMatch};
use super::substitution::{
    ExactNameListPagesBatchKey, ListPagesArguments, parse_list_pages_arguments,
};
use super::template::ListPagesTemplatePlan;
use super::{
    ListPagesAuthorCacheKey, ListPagesBatchDisplays, ListPagesPagerRoute,
    ResolvedListPagesAuthors,
};
use super::{
    ListPagesExpansionBudget, PendingDelayedListPagesOutput,
    register_generated_list_pages_html, repair_list_pages_block_boundaries,
    strip_generated_list_pages_html_markers, wrap_pending_list_pages_delayed_output,
};
use crate::error::prelude::Result;
use crate::hash::TextHash;
use crate::services::ServiceContext;
use crate::services::page_query::{FoundPages, PageQueryScoreFilterCache};
use crate::services::render::UrlArguments;
use crate::services::render::service::IncludeExpansionOptions;
use ftml::data::PageInfo;
use ftml::settings::WikitextSettings;
use sea_orm::FromQueryResult;
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};

pub(in crate::services::render) enum ListPagesBlockPlan {
    Static(String),
    PreserveOriginal(&'static str),
    Render {
        arguments: ListPagesArguments,
        template: ListPagesTemplatePlan,
        batch_key: Option<ExactNameListPagesBatchKey>,
        legacy_tail: Option<String>,
    },
}

pub(in crate::services::render) struct ListPagesBlock {
    pub start: usize,
    pub end: usize,
    pub plan: ListPagesBlockPlan,
}

pub(in crate::services::render) fn push_list_pages_generated_output(
    output: &mut String,
    fragment: &str,
    expansion_budget: &mut ListPagesExpansionBudget,
) -> bool {
    let fragment = suppress_generated_list_pages_heading_toc(fragment);
    push_list_pages_generated_output_with_cost(
        output,
        &fragment,
        fragment.len(),
        expansion_budget,
    )
}

pub(in crate::services::render) fn push_list_pages_generated_output_with_cost(
    output: &mut String,
    fragment: &str,
    cost: usize,
    expansion_budget: &mut ListPagesExpansionBudget,
) -> bool {
    if !expansion_budget.try_consume_generated_output_bytes(cost) {
        return false;
    }
    output.push_str(fragment);
    true
}

pub(in crate::services::render) fn push_list_pages_block_boundary(
    output: &mut String,
    expansion_budget: &mut ListPagesExpansionBudget,
) -> bool {
    let boundary = if output.ends_with("\n\n") {
        ""
    } else if output.ends_with('\n') {
        "\n"
    } else {
        "\n\n"
    };
    if !expansion_budget.try_consume_generated_output_bytes(boundary.len()) {
        return false;
    }
    output.push_str(boundary);
    true
}

pub(in crate::services::render) fn push_list_pages_trailing_runtime_blocks(
    output: &mut String,
    pager: String,
    feed_info: Option<String>,
    wrapper: bool,
    wrapper_trailing_space: bool,
    compat_html: &mut CompatHtmlFragments,
    expansion_budget: &mut ListPagesExpansionBudget,
) -> std::result::Result<(), &'static str> {
    const WIKIDOT_LISTPAGES_PAGER_SPACE: &str = "    \n    ";
    let wrapper_pager_space = wrapper && wrapper_trailing_space && !pager.is_empty();
    let pager_bytes = pager.len()
        + if wrapper_pager_space {
            WIKIDOT_LISTPAGES_PAGER_SPACE.len()
        } else {
            0
        };
    if !pager.is_empty() {
        if !push_list_pages_block_boundary(output, expansion_budget) {
            return Err("pager boundary exceeds generated-output budget");
        }
        let pager = if wrapper_pager_space {
            format!("{WIKIDOT_LISTPAGES_PAGER_SPACE}{pager}")
        } else {
            pager
        };
        let pager = compat_html.push_block_html(pager);
        if !push_list_pages_generated_output_with_cost(
            output,
            &pager,
            pager_bytes,
            expansion_budget,
        ) {
            return Err("pager exceeds generated-output budget");
        }
    }
    if let Some(feed_info) = feed_info {
        let feed_info = strip_generated_list_pages_html_markers(feed_info);
        let feed_info_marker = compat_html.push_block_html(feed_info.clone());
        if !push_list_pages_generated_output_with_cost(
            output,
            &feed_info_marker,
            feed_info.len(),
            expansion_budget,
        ) {
            return Err("feed metadata exceeds generated-output budget");
        }
    }
    if wrapper {
        const WIKIDOT_LISTPAGES_TRAILING_SPACE: &str = "\n    \n    \n    \n    ";
        let closing = if wrapper_trailing_space {
            let whitespace = if wrapper_pager_space {
                WIKIDOT_LISTPAGES_PAGER_SPACE
            } else {
                WIKIDOT_LISTPAGES_TRAILING_SPACE
            };
            if !expansion_budget.try_consume_generated_output_bytes(whitespace.len()) {
                return Err("wrapper trailing space exceeds generated-output budget");
            }
            compat_html.push_block_html(format!("{whitespace}</div>",))
        } else {
            super::list_pages_runtime_container_close(compat_html)
        };
        let closing_cost = "[[/div]]".len();
        if !push_list_pages_block_boundary(output, expansion_budget)
            || !push_list_pages_generated_output_with_cost(
                output,
                &closing,
                closing_cost,
                expansion_budget,
            )
        {
            return Err("wrapper closing exceeds generated-output budget");
        }
    }
    Ok(())
}

pub(in crate::services::render) fn suppress_generated_list_pages_heading_toc(
    fragment: &str,
) -> Cow<'_, str> {
    let literal_regions = LiteralRegionIndex::new(fragment);
    let bytes = fragment.as_bytes();
    let mut insertions = Vec::new();
    let mut line_start = 0usize;

    while line_start < bytes.len() {
        if !literal_regions.contains(line_start) {
            let pluses = bytes[line_start..]
                .iter()
                .take_while(|byte| **byte == b'+')
                .count();
            if (1..=6).contains(&pluses)
                && matches!(bytes.get(line_start + pluses), Some(b' ' | b'\t'))
            {
                insertions.push(line_start + pluses);
            }
        }

        let Some(line_end) = bytes[line_start..].iter().position(|byte| *byte == b'\n')
        else {
            break;
        };
        line_start += line_end + 1;
    }

    if insertions.is_empty() {
        return Cow::Borrowed(fragment);
    }

    let mut protected = String::with_capacity(fragment.len() + insertions.len());
    let mut cursor = 0usize;
    for insertion in insertions {
        protected.push_str(&fragment[cursor..insertion]);
        protected.push('*');
        cursor = insertion;
    }
    protected.push_str(&fragment[cursor..]);
    Cow::Owned(protected)
}

pub(in crate::services::render) fn preserve_list_pages_module_matches(
    wikitext: &str,
    module_matches: &[ListPagesModuleMatch<'_>],
    compat_text: &mut CompatTextFragments,
) -> String {
    let mut preserved = String::with_capacity(wikitext.len());
    let mut cursor = 0;
    for module in module_matches {
        preserved.push_str(&wikitext[cursor..module.start]);
        preserved.push_str(&compat_text.push_escaped_html_text(module.original));
        cursor = module.end;
    }
    preserved.push_str(&wikitext[cursor..]);
    preserved
}

fn contains_unescaped_html_block_opener(body: &str) -> bool {
    let lowercase = body.to_ascii_lowercase();
    lowercase
        .match_indices("[[html]]")
        .any(|(start, _)| !lowercase[..start].ends_with("@@"))
}

pub(in crate::services::render) fn list_pages_body_starts_with_preparsed_block(
    body: &str,
) -> bool {
    let body = body.trim_start_matches(char::is_whitespace);
    if body
        .get(.."[[code]]".len())
        .is_some_and(|opening| opening.eq_ignore_ascii_case("[[code]]"))
    {
        return true;
    }

    if contains_unescaped_html_block_opener(body) {
        return true;
    }

    let lowercase = body.to_ascii_lowercase();
    let Some(code_start) = lowercase.find("[[code]]") else {
        return false;
    };
    let prefix = lowercase[..code_start].trim();
    if !prefix.starts_with("[[head]]") || !prefix.ends_with("[[/head]]") {
        return false;
    }
    let code_body_start = code_start + "[[code]]".len();
    let Some(relative_code_end) = lowercase[code_body_start..].find("[[/code]]") else {
        return false;
    };
    let code_body = &lowercase[code_body_start..code_body_start + relative_code_end];
    code_body.contains("[[body]]") && code_body.contains("[[/body]]")
}

pub(in crate::services::render) fn list_pages_template_has_block_section(
    template: &ListPagesTemplatePlan,
) -> bool {
    const BLOCK_OPENERS: &[&str] = &[
        "[[address",
        "[[article",
        "[[aside",
        "[[blockquote",
        "[[div",
        "[[dl",
        "[[fieldset",
        "[[figure",
        "[[footer",
        "[[form",
        "[[h1",
        "[[h2",
        "[[h3",
        "[[h4",
        "[[h5",
        "[[h6",
        "[[header",
        "[[hr",
        "[[main",
        "[[nav",
        "[[ol",
        "[[pre",
        "[[section",
        "[[table",
        "[[ul",
    ];
    [
        template.head_section(),
        Some(template.body()),
        template.foot_section(),
    ]
    .into_iter()
    .flatten()
    .any(|section| {
        let Ok(literal_regions) =
            LiteralRegionIndex::new_list_pages_scanner_syntax(section)
        else {
            return false;
        };
        let mut search = 0;
        while let Some(relative) = section[search..].find("[[") {
            let start = search + relative;
            if literal_regions.containing_range(start).is_none()
                && BLOCK_OPENERS.iter().any(|opener| {
                    section[start..]
                        .get(..opener.len())
                        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(opener))
                        && matches!(
                            section.as_bytes().get(start + opener.len()),
                            Some(b']' | b'_' | b' ' | b'\t' | b'\r' | b'\n')
                        )
                })
            {
                return true;
            }
            search = start + 2;
        }
        false
    })
}

pub(in crate::services::render) fn list_pages_template_starts_with_inline_anchor(
    template: &ListPagesTemplatePlan,
) -> bool {
    template
        .body()
        .trim_start_matches(char::is_whitespace)
        .get(.."[[a_".len())
        .is_some_and(|opening| opening.eq_ignore_ascii_case("[[a_"))
}

pub(in crate::services::render) fn list_pages_raw_footnote_prefix_end(
    head: &str,
    suffix: &str,
) -> Option<usize> {
    const OPEN: &str = "@@[[footnote]]";
    const CLOSE_AND_LINE_END: &str = "[[/footnote]]\n";

    let arguments = parse_list_pages_arguments(head)?;
    if !arguments.current_page_only
        || arguments.wrapper
        || arguments.separate
        || !suffix.starts_with(OPEN)
    {
        return None;
    }
    suffix[OPEN.len()..]
        .find(CLOSE_AND_LINE_END)
        .map(|offset| OPEN.len() + offset + CLOSE_AND_LINE_END.len())
}

pub(in crate::services::render) fn list_pages_html_encoded_head_owns_script_tail(
    head: &str,
    body: &str,
) -> bool {
    if !head.contains("=&quot;") {
        return false;
    }

    let body = body.trim_start_matches(char::is_whitespace);
    if body.starts_with("</p>") {
        return true;
    }

    body.strip_prefix('\'')
        .map(str::trim_start)
        .is_some_and(|tail| tail.starts_with("+ '<p>"))
}

#[derive(Debug)]
pub(in crate::services::render) enum ListPagesBlockRenderResult {
    Expanded(ListPagesRenderedBlock),
    PreserveOriginal(&'static str),
}

#[derive(Debug)]
pub(in crate::services::render) struct ListPagesRenderedBlock {
    pub(in crate::services::render) expansion: IncludeExpansion,
    pub(in crate::services::render) pending_delayed:
        Option<super::PendingDelayedListPagesOutput>,
    pub(in crate::services::render) runtime_css_insertions:
        Vec<super::super::compat::preparation::RuntimeCssInsertion>,
}

pub(in crate::services::render) fn list_pages_feed_only_render_result(
    feed_info: String,
    expansion_budget: &mut ListPagesExpansionBudget,
) -> ListPagesBlockRenderResult {
    if !expansion_budget.try_consume_generated_output_bytes(feed_info.len()) {
        return ListPagesBlockRenderResult::PreserveOriginal(
            "RSS output exceeds generated-output budget",
        );
    }
    ListPagesBlockRenderResult::Expanded(ListPagesRenderedBlock {
        expansion: IncludeExpansion {
            wikitext: feed_info,
            included_pages: Vec::new(),
            expanded_include_count: 0,
        },
        pending_delayed: None,
        runtime_css_insertions: Vec::new(),
    })
}

pub(in crate::services::render) fn prepare_list_pages_rendered_block(
    rendered: ListPagesRenderedBlock,
    boundaries: (&str, &str),
    expansion_budget: &mut ListPagesExpansionBudget,
    compat_html: &mut CompatHtmlFragments,
    compat_text: &mut CompatTextFragments,
    pending_delayed_outputs: &mut Vec<PendingDelayedListPagesOutput>,
    runtime_css_insertions: &mut Vec<
        super::super::compat::preparation::RuntimeCssInsertion,
    >,
) -> Option<IncludeExpansion> {
    let ListPagesRenderedBlock {
        expansion:
            IncludeExpansion {
                mut wikitext,
                included_pages,
                expanded_include_count,
            },
        pending_delayed,
        runtime_css_insertions: rendered_runtime_css_insertions,
    } = rendered;
    let generated_bytes_before_boundary_repair = wikitext.len();
    repair_list_pages_block_boundaries(&mut wikitext, boundaries);
    let boundary_repair_bytes = wikitext
        .len()
        .saturating_sub(generated_bytes_before_boundary_repair);
    if !expansion_budget.try_consume_generated_output_bytes(boundary_repair_bytes) {
        return None;
    }
    let mut runtime_css_prefix = String::new();
    for insertion in rendered_runtime_css_insertions {
        if wikitext.matches(&insertion.marker).count() == 1 {
            wikitext = wikitext.replacen(&insertion.marker, "", 1);
            runtime_css_prefix.push_str("[[module CSS]]\n");
            runtime_css_prefix.push_str(&insertion.marker);
            runtime_css_prefix.push_str("\n[[/module]]\n");
        }
        runtime_css_insertions.push(insertion);
    }
    if !runtime_css_prefix.is_empty() {
        runtime_css_prefix.push_str(&wikitext);
        wikitext = runtime_css_prefix;
    }
    if let Some(mut pending_delayed) = pending_delayed {
        wrap_pending_list_pages_delayed_output(
            &mut wikitext,
            &mut pending_delayed,
            compat_text,
        );
        pending_delayed_outputs.push(pending_delayed);
    } else {
        wikitext = register_generated_list_pages_html(wikitext, compat_html);
    }
    Some(IncludeExpansion {
        wikitext,
        included_pages,
        expanded_include_count,
    })
}

#[derive(Debug)]
pub(in crate::services::render) struct ListPagesExpansion {
    pub(in crate::services::render) wikitext: String,
    pub(in crate::services::render) included_pages: Vec<ftml::data::PageRef>,
    pub(in crate::services::render) expanded_include_count: usize,
    pub(in crate::services::render) url_offset_content_bytes: usize,
    pub(in crate::services::render) runtime_css_insertions:
        Vec<super::super::compat::preparation::RuntimeCssInsertion>,
}

pub(in crate::services::render) struct ListPagesBlockRenderArgs<'a, 'ctx, 'info, 'url> {
    pub(in crate::services::render) ctx: &'a ServiceContext<'ctx>,
    pub(in crate::services::render) page_context: ListPagesPageContext<'url>,
    pub(in crate::services::render) pager_route: ListPagesPagerRoute,
    pub(in crate::services::render) compat_html: &'a mut CompatHtmlFragments,
    pub(in crate::services::render) viewer_user_id: Option<i64>,
    pub(in crate::services::render) page_info: &'a PageInfo<'info>,
    pub(in crate::services::render) page_preview: bool,
    pub(in crate::services::render) settings: &'a WikitextSettings,
    pub(in crate::services::render) arguments: ListPagesArguments,
    pub(in crate::services::render) template: &'a ListPagesTemplatePlan,
    pub(in crate::services::render) include_budget: &'a mut IncludeExpansionBudget,
    pub(in crate::services::render) render_cost_budget: &'a SharedRenderCostBudget,
    pub(in crate::services::render) prefetched_pages: Option<FoundPages>,
    pub(in crate::services::render) prefetched_displays:
        Option<&'a ListPagesBatchDisplays>,
    pub(in crate::services::render) content_cache: &'a mut ListPagesContentCache,
    pub(in crate::services::render) expansion_budget: &'a mut ListPagesExpansionBudget,
    pub(in crate::services::render) permission_cache:
        &'a mut BTreeMap<(i64, Option<i64>), bool>,
    pub(in crate::services::render) score_filter_cache: &'a mut PageQueryScoreFilterCache,
    pub(in crate::services::render) author_resolution_cache:
        &'a mut BTreeMap<ListPagesAuthorCacheKey, ResolvedListPagesAuthors>,
    pub(in crate::services::render) compat_text: &'a mut CompatTextFragments,
}

pub(in crate::services::render) struct ListPagesExpansionArgs<'a, 'ctx, 'info, 'opts> {
    pub(in crate::services::render) ctx: &'a ServiceContext<'ctx>,
    pub(in crate::services::render) wikitext: String,
    pub(in crate::services::render) page_info: &'a PageInfo<'info>,
    pub(in crate::services::render) settings: &'a WikitextSettings,
    pub(in crate::services::render) compat_html: &'a mut CompatHtmlFragments,
    pub(in crate::services::render) include_source_cache: &'a mut IncludeSourceCache,
    pub(in crate::services::render) compat_text: &'a mut CompatTextFragments,
    pub(in crate::services::render) options: ListPagesExpansionOptions<'opts>,
}

pub(in crate::services::render) struct ListPagesNestedExpansionArgs<
    'a,
    'ctx,
    'info,
    'opts,
> {
    pub(in crate::services::render) call: ListPagesExpansionArgs<'a, 'ctx, 'info, 'opts>,
    pub(in crate::services::render) expansion_budget: &'a mut ListPagesExpansionBudget,
    pub(in crate::services::render) seen: &'a mut BTreeSet<TextHash>,
    pub(in crate::services::render) depth: usize,
}

pub(in crate::services::render) struct ListPagesGeneratedIncludesArgs<'a, 'ctx, 'info> {
    pub(in crate::services::render) ctx: &'a ServiceContext<'ctx>,
    pub(in crate::services::render) expansion: &'a mut ListPagesExpansion,
    pub(in crate::services::render) page_info: &'a PageInfo<'info>,
    pub(in crate::services::render) settings: &'a WikitextSettings,
    pub(in crate::services::render) current_site_id: i64,
    pub(in crate::services::render) page_preview: bool,
    pub(in crate::services::render) include_source_cache: &'a mut IncludeSourceCache,
    pub(in crate::services::render) compat_text: &'a mut CompatTextFragments,
    pub(in crate::services::render) include_budget: &'a mut IncludeExpansionBudget,
    pub(in crate::services::render) render_cost_budget: &'a SharedRenderCostBudget,
    pub(in crate::services::render) initial_remaining_include_expansions: usize,
}

pub(in crate::services::render) struct ListPagesSelectedContentArgs<'a, 'ctx, 'info, 'url>
{
    pub(in crate::services::render) ctx: &'a ServiceContext<'ctx>,
    pub(in crate::services::render) wikitext: &'a str,
    pub(in crate::services::render) page_info: &'a PageInfo<'info>,
    pub(in crate::services::render) settings: &'a WikitextSettings,
    pub(in crate::services::render) current_site_id: i64,
    pub(in crate::services::render) current_category_id: i64,
    pub(in crate::services::render) current_page_id: i64,
    pub(in crate::services::render) viewer_user_id: Option<i64>,
    pub(in crate::services::render) max_include_expansions: usize,
    pub(in crate::services::render) render_cost_budget: SharedRenderCostBudget,
    pub(in crate::services::render) url: UrlArguments<'url>,
}

pub(in crate::services::render) async fn expand_list_pages_generated_includes(
    args: ListPagesGeneratedIncludesArgs<'_, '_, '_>,
) -> Result<()> {
    let ListPagesGeneratedIncludesArgs {
        ctx,
        expansion,
        page_info,
        settings,
        current_site_id,
        page_preview,
        include_source_cache,
        compat_text,
        include_budget,
        render_cost_budget,
        initial_remaining_include_expansions,
    } = args;
    let IncludeExpansion {
        wikitext,
        included_pages,
        expanded_include_count,
    } = RenderService::expand_includes(
        ctx,
        std::mem::take(&mut expansion.wikitext),
        page_info,
        page_info.site.as_ref(),
        settings,
        IncludeExpansionOptions {
            current_site_id: Some(current_site_id),
            source_attachment_owner: None,
            source_cache: include_source_cache,
            compat_text,
            expand_wikidot_image_blocks: true,
            page_preview,
            budget: *include_budget,
            render_cost_budget: render_cost_budget.clone(),
        },
    )
    .await?;
    include_budget.consume(expanded_include_count);
    expansion.wikitext = wikitext;
    expansion.included_pages.extend(included_pages);
    expansion.expanded_include_count =
        initial_remaining_include_expansions.saturating_sub(include_budget.remaining);
    if expanded_include_count > 0 {
        remove_unresolved_include_comment_branches(&mut expansion.wikitext);
        RenderService::prepare_wikidot_conditionals_for_include_expansion(
            &mut expansion.wikitext,
            page_info,
            compat_text,
        );
        neutralize_authored_markers(&mut expansion.wikitext);
    }
    Ok(())
}

#[derive(Debug, Clone)]
pub(in crate::services::render) enum CountPagesBlockRenderResult {
    Expanded(String),
    PreserveOriginal,
}

#[derive(Debug, FromQueryResult)]
pub(in crate::services::render) struct CountPagesRequiredTagTotal {
    pub(in crate::services::render) tag: String,
    pub(in crate::services::render) total: i64,
}

pub(in crate::services::render) struct CountPagesRequiredTagSource<'a> {
    pub(in crate::services::render) literal_regions: &'a LiteralRegionIndex,
    pub(in crate::services::render) close_reachability:
        &'a CountPagesCloseReachabilityIndex,
    pub(in crate::services::render) source_projection:
        Option<&'a ListPagesSourceProjection>,
}

#[derive(Clone, Copy, Debug)]
pub(in crate::services::render) struct ListPagesPageContext<'a> {
    pub(in crate::services::render) site_id: i64,
    pub(in crate::services::render) page_id: Option<i64>,

    pub(in crate::services::render) url: UrlArguments<'a>,
}

#[derive(Debug, Default)]
pub(in crate::services::render) struct ListPagesContentCache {
    pub(in crate::services::render) wikitext: BTreeMap<(i64, i64), Option<String>>,
    pub(in crate::services::render) compiled_body_html:
        BTreeMap<(i64, i64), Option<String>>,
    pub(in crate::services::render) wikitext_scalar_count:
        BTreeMap<(i64, i64), Option<usize>>,
}

#[derive(Clone, Debug)]
pub(in crate::services::render) struct ListPagesExpansionOptions<'a> {
    pub(in crate::services::render) current_site_id: Option<i64>,
    pub(in crate::services::render) current_page_id: Option<i64>,
    pub(in crate::services::render) current_page_data_form_values:
        Option<BTreeMap<String, String>>,
    pub(in crate::services::render) page_preview: bool,
    pub(in crate::services::render) viewer_user_id: Option<i64>,
    pub(in crate::services::render) include_budget: IncludeExpansionBudget,
    pub(in crate::services::render) render_cost_budget: SharedRenderCostBudget,

    pub(in crate::services::render) url: UrlArguments<'a>,
    pub(in crate::services::render) pager_route: super::ListPagesPagerRoute,
}

pub(in crate::services::render) struct CountPagesExpansionOptions {
    pub(in crate::services::render) current_site_id: Option<i64>,
    pub(in crate::services::render) current_page_id: Option<i64>,
}

impl RenderService {
    pub(in crate::services::render) async fn expand_list_pages(
        args: ListPagesExpansionArgs<'_, '_, '_, '_>,
    ) -> Result<ListPagesExpansion> {
        let mut expansion_budget = ListPagesExpansionBudget::new();
        let mut seen = BTreeSet::<TextHash>::new();
        Box::pin(Self::expand_list_pages_nested(
            ListPagesNestedExpansionArgs {
                call: args,
                expansion_budget: &mut expansion_budget,
                seen: &mut seen,
                depth: 0,
            },
        ))
        .await
    }

    pub(in crate::services::render) fn categories_with_current_page_category(
        mut categories: Vec<Cow<'static, str>>,
        page_info: &PageInfo<'_>,
    ) -> Vec<Cow<'static, str>> {
        let category = page_info
            .category
            .as_ref()
            .map(Cow::as_ref)
            .unwrap_or("_default");
        if !categories.iter().any(|slug| slug.as_ref() == category) {
            categories.push(Cow::Owned(category.to_owned()));
        }
        categories
    }

    pub(in crate::services::render) fn page_info_category_slug<'a>(
        page_info: &'a PageInfo<'_>,
    ) -> Cow<'a, str> {
        page_info
            .category
            .as_ref()
            .map(|category| Cow::Borrowed(category.as_ref()))
            .unwrap_or(Cow::Borrowed("_default"))
    }

    pub(in crate::services::render) fn page_info_full_slug(
        page_info: &PageInfo<'_>,
    ) -> String {
        let page = page_info.page.as_ref();
        match Self::page_info_category_slug(page_info).as_ref() {
            "_default" => page.to_owned(),
            category => format!("{category}:{page}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ftml::data::{PageInfo, ScoreValue};
    use ftml::layout::Layout;
    use ftml::render::{Render, html::HtmlRender};
    use ftml::settings::{WikitextMode, WikitextSettings};
    use std::borrow::Cow;

    fn render_wikidot_page(source: &str) -> String {
        let page_info = PageInfo {
            page: Cow::Borrowed("test"),
            category: None,
            site: Cow::Borrowed("test"),
            title: Cow::Borrowed("Test"),
            alt_title: None,
            score: ScoreValue::Float(0.0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
        let tokens = ftml::tokenize(source);
        let (tree, _) = ftml::parse(&tokens, &page_info, &settings).into();
        HtmlRender.render(&tree, &page_info, &settings).body
    }

    #[test]
    fn preparsed_code_boundary_accepts_only_the_evidenced_section_prefix() {
        assert!(list_pages_body_starts_with_preparsed_block(concat!(
            "[[head]]H[[/head]]\n",
            "[[code]]\n",
            "[[body]]B=%%title%%[[/body]]\n",
            "[[/code]]\n",
            "[[foot]]F[[/foot]]",
        )));
        assert!(list_pages_body_starts_with_preparsed_block(
            "[[code]]literal[[/code]]",
        ));
        assert!(list_pages_body_starts_with_preparsed_block(concat!(
            "Row %%title_linked%%\n",
            "[[html]]\n<div>A</div>\n[[/html]]",
        )));
        assert!(list_pages_body_starts_with_preparsed_block(concat!(
            "Row %%title_linked%%\nSecond line\n",
            "[[html]]<div>B</div>[[/html]]\nTail line",
        )));
        assert!(!list_pages_body_starts_with_preparsed_block(concat!(
            "Row %%title_linked%% @@[[html]]@@ literal\n",
            "@@[[/html]]@@",
        )));
        assert!(!list_pages_body_starts_with_preparsed_block(
            "Row %%title_linked%%\nSecond line",
        ));
        assert!(!list_pages_body_starts_with_preparsed_block(concat!(
            "ordinary prose\n",
            "[[code]][[body]]B[[/body]][[/code]]",
        )));
        assert!(!list_pages_body_starts_with_preparsed_block(concat!(
            "[[head]]H[[/head]]\n",
            "[[code]]ordinary code[[/code]]",
        )));
    }

    #[test]
    fn generated_list_pages_headings_do_not_register_page_toc_ids() {
        let mut output = String::new();
        let mut budget = ListPagesExpansionBudget::new();
        assert!(push_list_pages_generated_output(
            &mut output,
            "+ GENERATED",
            &mut budget,
        ));

        assert_eq!(
            render_wikidot_page(&output),
            "<h1><span>GENERATED</span></h1>",
        );
    }

    #[test]
    fn generated_list_pages_heading_protection_is_literal_aware_and_idempotent() {
        let source = concat!(
            "+ ONE\n",
            "++++++ TWO\n",
            "+* ALREADY PROTECTED\n",
            "+++++++ NOT A HEADING\n",
            "[[code]]\n",
            "+ CODE\n",
            "[[/code]]\n",
            "[[html]]\n",
            "+ HTML\n",
            "[[/html]]\n",
            "[!--\n",
            "+ COMMENT\n",
            "--]\n",
        );

        assert_eq!(
            suppress_generated_list_pages_heading_toc(source),
            concat!(
                "+* ONE\n",
                "++++++* TWO\n",
                "+* ALREADY PROTECTED\n",
                "+++++++ NOT A HEADING\n",
                "[[code]]\n",
                "+ CODE\n",
                "[[/code]]\n",
                "[[html]]\n",
                "+ HTML\n",
                "[[/html]]\n",
                "[!--\n",
                "+ COMMENT\n",
                "--]\n",
            ),
        );
    }

    #[test]
    fn html_encoded_heads_only_own_evidenced_script_tail_shapes() {
        let encoded_head = concat!(
            "[[module ListPages category=&quot;fragment&quot; ",
            "parent=&quot;.&quot;]]",
        );

        assert!(list_pages_html_encoded_head_owns_script_tail(
            encoded_head,
            "</p>\n<p>%%title%%</p>\n<p>",
        ));
        assert!(list_pages_html_encoded_head_owns_script_tail(
            encoded_head,
            "'\n    + '<p>%%content%%</p>' + '<p>",
        ));
        assert!(!list_pages_html_encoded_head_owns_script_tail(
            encoded_head,
            "ordinary %%title%%",
        ));
        assert!(!list_pages_html_encoded_head_owns_script_tail(
            "[[module ListPages category=\"fragment\"]]",
            "</p>\n<p>%%title%%</p>\n<p>",
        ));
        assert!(!list_pages_html_encoded_head_owns_script_tail(
            encoded_head,
            "' + ordinary %%title%%",
        ));
    }

    #[test]
    fn combined_inline_anchor_detection_is_narrow_and_whitespace_tolerant() {
        let inline = ListPagesTemplatePlan::compile(
            "  [[a_ href=\"/%%fullname%%\"]]%%name%%[[/a]]",
        )
        .expect("inline anchor template should compile");
        let inline_without_attributes =
            ListPagesTemplatePlan::compile("[[a_]]%%name%%[[/a]]")
                .expect("inline anchor template should compile");
        let text = ListPagesTemplatePlan::compile("%%name%%")
            .expect("text template should compile");
        let block = ListPagesTemplatePlan::compile("[[div]]%%name%%[[/div]]")
            .expect("block template should compile");

        assert!(list_pages_template_starts_with_inline_anchor(&inline));
        assert!(list_pages_template_starts_with_inline_anchor(
            &inline_without_attributes
        ));
        assert!(!list_pages_template_starts_with_inline_anchor(&text));
        assert!(!list_pages_template_starts_with_inline_anchor(&block));
    }

    #[test]
    fn sectioned_combined_templates_detect_blocks_after_leading_text() {
        let delayed_block = ListPagesTemplatePlan::compile(
            "caption\n[[ul]]\n[[li]]%%name%%[[/li]]\n[[/ul]]",
        )
        .expect("delayed block template should compile");
        let literal_block =
            ListPagesTemplatePlan::compile("[[code]][[ul]]literal[[/ul]][[/code]]")
                .expect("literal block template should compile");

        assert!(list_pages_template_has_block_section(&delayed_block));
        assert!(!list_pages_template_has_block_section(&literal_block));
    }

    #[test]
    fn nonseparate_pager_keeps_wikidot_wrapper_whitespace_on_both_sides() {
        let mut compat_html = CompatHtmlFragments::new("");
        let opening = super::super::list_pages_runtime_container_open(
            &mut compat_html,
            "list-pages-box",
        );
        let table = compat_html.push_block_html("[[/table]]\n".to_owned());
        let mut output = format!("{opening}\n\n{table}");
        let mut budget = ListPagesExpansionBudget::new();

        push_list_pages_trailing_runtime_blocks(
            &mut output,
            "<div class=\"pager\">PAGER</div>\n".to_owned(),
            None,
            true,
            true,
            &mut compat_html,
            &mut budget,
        )
        .expect("pager and wrapper should fit the generated-output budget");

        let rendered = compat_html.restore(&render_wikidot_page(&output));
        assert!(
            rendered.contains("[[/table]]\n    \n    <div class=\"pager\">PAGER</div>"),
            "{rendered:?}",
        );
        assert!(
            rendered.contains("<div class=\"pager\">PAGER</div>\n    \n    </div>"),
            "{rendered:?}",
        );
    }
}
