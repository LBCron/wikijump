/*
 * services/render/list_pages/delayed.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::scanner::{
    ListPagesModuleMatch, find_list_pages_module_matches,
    find_list_pages_module_matches_with_budget,
};
use super::substitution::{
    ListPagesSubstitutionContext, substitute_list_pages_rating_only,
    substitute_list_pages_variables_inner,
};
use super::suppress_generated_list_pages_heading_toc;
use super::template::ListPagesTemplatePlan;
use super::{
    register_generated_list_pages_html, strip_generated_list_pages_html_markers,
};
use crate::error::prelude::{Error, ErrorType, Result};
use crate::services::PageExistenceSnapshot;
use crate::services::page_query::FoundPageRow;
use crate::services::render::compat::CompatHtmlFragments;
use crate::services::render::compat::preparation::neutralize_authored_markers;
use crate::services::render::compat::text_fragments::CompatTextFragments;
use crate::services::render::ftml_render::WikidotCompatLinkTitleMap;
use crate::services::render::iftags::resolve_outermost_wikidot_iftags;
use crate::services::render::literal_regions::LiteralRegionIndex;
use crate::services::render::render_budget::SharedRenderCostBudget;
use crate::services::render::service::{
    COUNTPAGES_MODULE_REGEX, RenderService, render_list_pages_numbered_rows_with_titles,
    render_list_pages_table_rows,
};
use ftml::data::PageInfo;
use ftml::delayed::{
    DelayedInput, GeneratedInput, GeneratedKind, GeneratedValue, InputSegment,
    SlotBindings, SlotId, TextOrigin, parse_delayed_list,
};
use ftml::settings::{WikitextMode, WikitextSettings};
use std::borrow::Cow;
use std::collections::BTreeSet;
use std::ops::Range;

mod nested;
mod output;
mod parser_functions;
mod sealing;

use parser_functions::{
    find_list_pages_module_matches_with_delayed_links,
    list_pages_template_requires_runtime_title, protect_row_variable_parser_functions,
    resolve_list_pages_expr_parser_functions,
    substitute_literal_advanced_table_opener_typography,
};
pub(in crate::services::render) use parser_functions::{
    find_list_pages_module_matches_with_delayed_links_budgeted,
    protect_generated_parser_function_comment_gates,
    resolve_wikidot_parser_functions_outside_list_pages,
};

#[cfg(test)]
use nested::nested_list_pages_boundary_ranges;
use nested::protect_nested_list_pages;
#[cfg(test)]
use output::protect_list_pages_delayed_output;
pub(in crate::services::render) use output::{
    finish_or_defer_list_pages_delayed_output_with_modes,
    replace_recursive_list_pages_with_error, restore_pending_nested_list_pages,
    seal_zero_row_list_pages_wrapper, wrap_pending_list_pages_delayed_output,
};
use sealing::seal_list_pages_delayed_output_with_modes;
#[cfg(test)]
use sealing::{
    seal_list_pages_delayed_output, seal_list_pages_delayed_output_with_mode,
    strip_single_list_pages_paragraph,
};
pub(in crate::services::render) use sealing::{
    seal_pending_list_pages_delayed_outputs, seal_protected_list_pages_delayed_output,
};

pub(in crate::services::render) const MAX_NESTED_LISTPAGES_DEPTH: usize = 8;
pub(in crate::services::render) const MAX_NESTED_LISTPAGES_MODULES_PER_PASS: usize = 64;

#[derive(Debug, Clone)]
pub(in crate::services::render) struct ListPagesGeneratedSlot {
    pub(in crate::services::render) source_range: Range<usize>,
    pub(in crate::services::render) value: GeneratedValue<'static>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::services::render) struct ListPagesRuntimeTextRange {
    pub(in crate::services::render) source_range: Range<usize>,
    pub(in crate::services::render) origin: TextOrigin,
}

pub(in crate::services::render) struct PreparedDelayedListPagesRow {
    pub body: String,
    pub logical_body_bytes: Option<usize>,
    pub generated_slots: Vec<ListPagesGeneratedSlot>,
    pub runtime_text_ranges: Vec<ListPagesRuntimeTextRange>,
    pub html_fragments: Option<CompatHtmlFragments>,
}

#[derive(Debug)]
pub(in crate::services::render) struct PendingDelayedListPagesOutput {
    slots: Vec<PendingDelayedListPagesSlot>,
    html_fragments: Vec<CompatHtmlFragments>,
    block_output: bool,
    list_pages_inline: bool,
    boundary_markers: Option<(String, String)>,
    page_existence: Option<PageExistenceSnapshot>,
}

#[derive(Debug)]
struct PendingDelayedListPagesSlot {
    marker: String,
    source: String,
    value: PendingDelayedListPagesSlotValue,
}

#[derive(Debug, Clone)]
enum PendingDelayedListPagesSlotValue {
    Generated(GeneratedValue<'static>),
    RuntimeText(TextOrigin),
}

#[derive(Debug)]
struct DelayedRowParserGates {
    row_parser_fragments: Option<CompatTextFragments>,
    generated_comment_gates: Option<(String, String, String)>,
}

fn protect_delayed_row_parser_gates(prepared_body: &mut String) -> DelayedRowParserGates {
    DelayedRowParserGates {
        row_parser_fragments: protect_row_variable_parser_functions(prepared_body),
        generated_comment_gates: protect_generated_parser_function_comment_gates(
            prepared_body,
        ),
    }
}

fn preprocess_delayed_row_body(prepared_body: &mut String) {
    ftml::preprocess_for_layout(prepared_body, ftml::layout::Layout::Wikidot);
    ftml::preproc::typography::substitute_wikidot(prepared_body);
    substitute_literal_advanced_table_opener_typography(prepared_body);
}

fn restore_delayed_row_parser_gates(
    mut prepared_body: String,
    gates: DelayedRowParserGates,
) -> String {
    if let Some(fragments) = gates.row_parser_fragments {
        prepared_body = fragments.restore(&prepared_body);
    }
    if let Some((opening, closing, standalone_closing)) = gates.generated_comment_gates {
        prepared_body = prepared_body
            .replace(&opening, "[!--")
            .replace(&closing, "--]")
            .replace(&standalone_closing, "[!-- --]");
    }
    prepared_body
}

#[allow(clippy::too_many_arguments)]
pub(in crate::services::render) fn prepare_delayed_list_pages_row(
    template: &ListPagesTemplatePlan,
    body: &str,
    page: &FoundPageRow,
    index: usize,
    total: usize,
    context: &ListPagesSubstitutionContext<'_>,
    outer_page_tags: &[Cow<'_, str>],
    compat_text: &mut CompatTextFragments,
    uses_star_rating: bool,
    numbered_link_titles: Option<&WikidotCompatLinkTitleMap>,
) -> PreparedDelayedListPagesRow {
    prepare_delayed_list_pages_row_with_budget(
        template,
        body,
        page,
        index,
        total,
        context,
        outer_page_tags,
        compat_text,
        uses_star_rating,
        numbered_link_titles,
        None,
    )
}

#[allow(clippy::too_many_arguments)]
pub(in crate::services::render) fn prepare_delayed_list_pages_row_with_budget(
    template: &ListPagesTemplatePlan,
    body: &str,
    page: &FoundPageRow,
    index: usize,
    total: usize,
    context: &ListPagesSubstitutionContext<'_>,
    outer_page_tags: &[Cow<'_, str>],
    compat_text: &mut CompatTextFragments,
    uses_star_rating: bool,
    numbered_link_titles: Option<&WikidotCompatLinkTitleMap>,
    render_cost_budget: Option<&SharedRenderCostBudget>,
) -> PreparedDelayedListPagesRow {
    let mut generated_slots = Vec::new();
    let mut runtime_text_ranges = Vec::new();
    let mut tracked_content_fragments = BTreeSet::new();
    let mut prepared_body = suppress_generated_list_pages_heading_toc(body).into_owned();
    let parser_gates = protect_delayed_row_parser_gates(&mut prepared_body);
    preprocess_delayed_row_body(&mut prepared_body);
    let mut prepared_body = restore_delayed_row_parser_gates(prepared_body, parser_gates);
    resolve_outermost_wikidot_iftags(&mut prepared_body, outer_page_tags, compat_text);
    neutralize_authored_markers(&mut prepared_body);
    let mut fragments = CompatHtmlFragments::new(&prepared_body);
    let runtime_title_is_delayed =
        list_pages_template_requires_runtime_title(&prepared_body);
    let mut body = if template.uses_only_rating() && !uses_star_rating {
        let mut body = substitute_list_pages_rating_only(&prepared_body, page);
        neutralize_authored_markers(&mut body);
        body
    } else {
        let mut body = substitute_list_pages_variables_delayed(
            &prepared_body,
            page,
            index,
            total,
            context,
            &mut fragments,
            compat_text,
            &mut tracked_content_fragments,
            &mut generated_slots,
            &mut runtime_text_ranges,
            runtime_title_is_delayed,
        );
        resolve_list_pages_expr_parser_functions(
            &mut body,
            &mut generated_slots,
            &mut runtime_text_ranges,
        );
        if generated_slots.is_empty() && runtime_text_ranges.is_empty() {
            RenderService::resolve_wikidot_parser_functions(&body)
        } else {
            body
        }
    };
    RenderService::protect_list_pages_wikidot_embed_iframes(&mut body, &mut fragments);
    body = protect_nested_list_pages(&body, &mut fragments, render_cost_budget);
    let mut html_fragments = (!fragments.is_empty()).then_some(fragments);
    if generated_slots.is_empty()
        && runtime_text_ranges.is_empty()
        && let Some(fragments) = html_fragments.as_ref()
    {
        let numbered =
            render_list_pages_numbered_rows_with_titles(&body, numbered_link_titles);
        if numbered != body {
            body = fragments.restore(&numbered);
            html_fragments = None;
        }
    }

    let delayed = !generated_slots.is_empty()
        || !runtime_text_ranges.is_empty()
        || html_fragments.is_some();
    let body = if delayed {
        body
    } else if let Some(table) = render_list_pages_table_rows(&body) {
        table
    } else {
        render_list_pages_numbered_rows_with_titles(&body, numbered_link_titles)
    };
    let body = if delayed {
        body
    } else {
        suppress_generated_list_pages_heading_toc(&body).into_owned()
    };
    let logical_body_bytes =
        compat_text.logical_len_for_tracked_fragments(&body, &tracked_content_fragments);
    PreparedDelayedListPagesRow {
        body,
        logical_body_bytes,
        generated_slots,
        runtime_text_ranges,
        html_fragments,
    }
}

pub(in crate::services::render) fn raw_module_close_end(
    source: &str,
    start: usize,
) -> Option<usize> {
    let close = b"[[/module]]";
    source
        .as_bytes()
        .get(start..)?
        .windows(close.len())
        .position(|candidate| candidate.eq_ignore_ascii_case(close))
        .map(|offset| start + offset + close.len())
}

pub(in crate::services::render) fn list_pages_row_markup_bytes(
    separate: bool,
    generated_row_open: &str,
    generated_row_close: &str,
) -> usize {
    if separate {
        generated_row_open.len() + generated_row_close.len()
    } else {
        1
    }
}

pub(in crate::services::render) fn list_pages_runtime_container_open(
    compat_html: &mut CompatHtmlFragments,
    class: &str,
) -> String {
    compat_html.push_list_pages_container_open(format!(r#"<div class="{class}">"#))
}

pub(in crate::services::render) fn list_pages_runtime_container_close(
    compat_html: &mut CompatHtmlFragments,
) -> String {
    compat_html.push_list_pages_container_close(false)
}

pub(in crate::services::render) fn list_pages_runtime_row_container_open(
    compat_html: &mut CompatHtmlFragments,
) -> String {
    compat_html
        .push_list_pages_container_open(r#"<div class="list-pages-item">"#.to_owned())
}

pub(in crate::services::render) fn list_pages_runtime_row_container_close(
    compat_html: &mut CompatHtmlFragments,
) -> String {
    compat_html.push_list_pages_container_close(true)
}

pub(in crate::services::render) fn append_list_pages_delayed_occurrences(
    occurrences: &mut Vec<(Range<usize>, GeneratedValue<'static>)>,
    generated_slots: Vec<ListPagesGeneratedSlot>,
    rendered_body_start: usize,
    rendered_body_len: usize,
) -> bool {
    for generated in generated_slots {
        if generated.source_range.end > rendered_body_len {
            return false;
        }
        occurrences.push((
            rendered_body_start + generated.source_range.start
                ..rendered_body_start + generated.source_range.end,
            generated.value,
        ));
    }
    true
}

pub(in crate::services::render) fn append_list_pages_runtime_text_ranges(
    ranges: &mut Vec<ListPagesRuntimeTextRange>,
    row_ranges: Vec<ListPagesRuntimeTextRange>,
    rendered_body_start: usize,
    rendered_body_len: usize,
) -> bool {
    for range in row_ranges {
        if range.source_range.end > rendered_body_len {
            return false;
        }
        ranges.push(ListPagesRuntimeTextRange {
            source_range: rendered_body_start + range.source_range.start
                ..rendered_body_start + range.source_range.end,
            origin: range.origin,
        });
    }
    true
}

#[allow(clippy::too_many_arguments)]
pub(in crate::services::render) fn substitute_list_pages_variables_delayed(
    template: &str,
    page: &FoundPageRow,
    index: usize,
    total: usize,
    context: &ListPagesSubstitutionContext<'_>,
    compat_html: &mut CompatHtmlFragments,
    compat_text: &mut CompatTextFragments,
    tracked_content_fragments: &mut BTreeSet<usize>,
    generated_slots: &mut Vec<ListPagesGeneratedSlot>,
    runtime_text_ranges: &mut Vec<ListPagesRuntimeTextRange>,
    runtime_title_is_delayed: bool,
) -> String {
    substitute_list_pages_variables_inner(
        template,
        page,
        index,
        total,
        context,
        compat_html,
        compat_text,
        Some(tracked_content_fragments),
        Some(generated_slots),
        Some(runtime_text_ranges),
        runtime_title_is_delayed,
    )
}

#[cfg(test)]
pub(in crate::services::render) fn substitute_list_pages_variables_with_fragments(
    template: &str,
    page: &FoundPageRow,
    index: usize,
    total: usize,
    context: &ListPagesSubstitutionContext<'_>,
    compat_html: &mut CompatHtmlFragments,
    compat_text: &mut CompatTextFragments,
) -> String {
    substitute_list_pages_variables_inner(
        template,
        page,
        index,
        total,
        context,
        compat_html,
        compat_text,
        None,
        None,
        None,
        false,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::render::render_budget::RenderCostBudget;
    use std::collections::BTreeMap;

    #[test]
    fn embedvideo_keeps_runtime_titles_out_of_authored_provider_syntax() {
        assert!(list_pages_template_requires_runtime_title(
            "[[embedvideo]]%%title%%[[/embedvideo]]",
        ));
        assert!(!list_pages_template_requires_runtime_title("%%title%%"));
    }

    #[test]
    fn nested_list_pages_protection_fails_closed_on_shared_budget_exhaustion() {
        let mut source = String::new();
        for depth in 0..8 {
            source.push_str(&format!("[[module ListPages name=\"nested-{depth}\"]]"));
        }
        source.push_str(&"body ".repeat(300));
        for _ in 0..8 {
            source.push_str("[[/module]]");
        }
        let budget = RenderCostBudget::new(2);

        let ranges = nested_list_pages_boundary_ranges(&source, Some(&budget));

        assert!(ranges.is_empty(), "exhaustion must preserve the row source");
        assert!(budget.is_exhausted());
    }

    fn empty_substitution_context<'a>(
        user_displays: &'a BTreeMap<i64, super::super::WikidotUserDisplay>,
        snapshot_displays: &'a BTreeMap<i64, super::super::ListPagesSnapshotDisplay>,
        runtime_displays: &'a BTreeMap<i64, super::super::ListPagesRuntimeDisplay>,
        data_form_values: &'a BTreeMap<String, String>,
    ) -> ListPagesSubstitutionContext<'a> {
        ListPagesSubstitutionContext {
            authored_limit: Some(1),
            ajax_module_response: false,
            page_preview: false,
            site: "sandbox-for-codex",
            site_title: "Sandbox",
            category: "",
            tag_target: None,
            user_displays,
            snapshot_displays,
            runtime_displays,
            page_wikitext: None,
            page_rendered_content: None,
            page_rendered_summary: None,
            page_rendered_summary_is_block: false,
            default_summary_first_paragraph: false,
            fallback_link_titles: None,
            page_rendered_first_paragraph: None,
            page_compiled_body_html: None,
            page_wikitext_scalar_count: None,
            page_parent_fullname: None,
            page_parent_display: None,
            page_child_count: None,
            page_revision_count: None,
            data_form_values,
            data_form_definition: None,
            render_generated_html: false,
        }
    }

    #[test]
    fn delayed_rows_apply_wikidot_tight_quote_boundaries() {
        let source = "BEFORE\n> quoted\n>tight\nAFTER";
        let page_info = PageInfo {
            page: Cow::Borrowed("preview"),
            category: None,
            site: Cow::Borrowed("sandbox-for-codex"),
            title: Cow::Borrowed("Preview"),
            alt_title: None,
            score: ftml::data::ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let settings = WikitextSettings::from_mode(
            WikitextMode::Page,
            ftml::layout::Layout::Wikidot,
        );
        let mut compat_html = CompatHtmlFragments::new(source);
        let sealed = seal_list_pages_delayed_output_with_mode(
            source.to_owned(),
            Vec::new(),
            Vec::new(),
            Vec::new(),
            &page_info,
            &settings,
            &mut compat_html,
            true,
        )
        .expect("delayed row should seal");
        let rendered = compat_html.restore(&sealed);

        assert!(
            rendered.contains("<blockquote><p>quoted</p></blockquote>"),
            "the valid quoted row should remain rendered: {rendered}",
        );
        assert!(
            !rendered.contains("tight"),
            "a tight quoted row should be pruned like Wikidot: {rendered}",
        );
    }

    #[test]
    fn combined_runtime_text_defers_one_paragraph_to_the_outer_page() {
        let source = "BEGIN|%%unknown%%|END";
        let page_info = PageInfo {
            page: Cow::Borrowed("preview"),
            category: None,
            site: Cow::Borrowed("sandbox-for-codex"),
            title: Cow::Borrowed("Preview"),
            alt_title: None,
            score: ftml::data::ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let settings = WikitextSettings::from_mode(
            WikitextMode::Page,
            ftml::layout::Layout::Wikidot,
        );
        let range_start = source.find("%%unknown%%").expect("unknown token fixture");
        let mut compat_html = CompatHtmlFragments::new(source);
        let sealed = seal_list_pages_delayed_output_with_mode(
            source.to_owned(),
            Vec::new(),
            vec![ListPagesRuntimeTextRange {
                source_range: range_start..range_start + "%%unknown%%".len(),
                origin: TextOrigin::RuntimeLiteral,
            }],
            Vec::new(),
            &page_info,
            &settings,
            &mut compat_html,
            false,
        )
        .expect("combined runtime-text row should seal");

        assert_eq!(
            compat_html.restore(&sealed),
            source,
            "the outer page owns the only paragraph wrapper",
        );
    }

    #[test]
    fn combined_runtime_text_keeps_multiple_paragraphs_structural() {
        let html = "<p>one</p>\n<p>two</p>".to_owned();
        assert_eq!(strip_single_list_pages_paragraph(html.clone()), html);
    }

    #[test]
    fn deferred_html_fragments_survive_without_generated_slots() {
        let mut row_fragments = CompatHtmlFragments::new("");
        let row_marker =
            row_fragments.push_html(r#"<span class="odate">DATE</span>"#.to_owned());
        let mut compat_text = CompatTextFragments::new("");

        let (protected, pending) = protect_list_pages_delayed_output(
            row_marker,
            Vec::new(),
            Vec::new(),
            vec![row_fragments],
            &mut compat_text,
        )
        .expect("generated HTML should be protectable without typed slots");

        assert_eq!(
            protected
                .matches(
                    crate::services::render::service::WIKIDOT_COMPAT_HTML_SENTINEL_PREFIX,
                )
                .count(),
            1,
        );
        assert!(
            pending.is_some(),
            "the row fragment registry must remain pending",
        );
    }

    #[test]
    fn html_block_created_at_uses_wikidot_raw_date_substitution() {
        let source = concat!(
            "[[html]]\n",
            r#"const value="%%created_at%%";"#,
            "\n[[/html]]",
        );
        let template =
            ListPagesTemplatePlan::compile(source).expect("supported template");
        let page = FoundPageRow {
            page_id: 1,
            site_id: 1,
            title: Some("Generated".to_owned()),
            alt_title: None,
            slug: Some("generated".to_owned()),
            page_category_id: None,
            page_revision_id: None,
            tags: None,
            created_at: Some(
                time::OffsetDateTime::from_unix_timestamp(1_778_581_468)
                    .expect("fixture timestamp"),
            ),
            created_by: None,
            updated_at: None,
            updated_by: None,
            score: None,
            revision_count: None,
        };
        let user_displays = BTreeMap::new();
        let snapshot_displays = BTreeMap::new();
        let runtime_displays = BTreeMap::new();
        let data_form_values = BTreeMap::new();
        let context = empty_substitution_context(
            &user_displays,
            &snapshot_displays,
            &runtime_displays,
            &data_form_values,
        );
        let mut compat_text = CompatTextFragments::new(source);
        let prepared = prepare_delayed_list_pages_row(
            &template,
            template.body(),
            &page,
            1,
            1,
            &context,
            &[],
            &mut compat_text,
            false,
            None,
        );
        assert!(
            prepared
                .body
                .contains(r#"const value="%%date|1778581468%%";"#),
            "HTML-block variables must be substituted to Wikidot's raw date marker before FTML extracts the hosted payload: {}",
            prepared.body,
        );
        let page_info = PageInfo {
            page: Cow::Borrowed("site"),
            category: Some(Cow::Borrowed("search")),
            site: Cow::Borrowed("sandbox-for-codex"),
            title: Cow::Borrowed("Preview"),
            alt_title: None,
            score: ftml::data::ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let settings = WikitextSettings::from_mode(
            WikitextMode::Page,
            ftml::layout::Layout::Wikidot,
        );
        let mut compat_html = CompatHtmlFragments::new(source);
        let sealed = seal_list_pages_delayed_output(
            prepared.body,
            Vec::new(),
            prepared.runtime_text_ranges,
            prepared.html_fragments.into_iter().collect(),
            &page_info,
            &settings,
            &mut compat_html,
        )
        .expect("authored HTML block should seal");
        let sealed = compat_html.restore(&sealed);

        assert!(
            sealed.contains(r#"src="/search:site/html/1""#),
            "the extracted HTML block must use the first resolvable numeric route: {sealed}",
        );
    }

    #[test]
    fn title_inside_html_block_is_escaped() {
        let source = "[[html]]\n<b>%%title%% tags: %%tags%%</b>\n[[/html]]";
        let template =
            ListPagesTemplatePlan::compile(source).expect("supported template");
        let page = FoundPageRow {
            page_id: 1,
            site_id: 1,
            title: Some(
                "<img src=x onerror=\"alert(1)\"><script>alert(2)</script>".to_owned(),
            ),
            alt_title: None,
            slug: Some("wj-pentest-title-host".to_owned()),
            page_category_id: None,
            page_revision_id: None,
            tags: Some(vec![r#"<img src=x onerror="alert(1)">"#.to_owned()]),
            created_at: None,
            created_by: None,
            updated_at: None,
            updated_by: None,
            score: None,
            revision_count: None,
        };
        let user_displays = BTreeMap::new();
        let snapshot_displays = BTreeMap::new();
        let runtime_displays = BTreeMap::new();
        let data_form_values = BTreeMap::new();
        let context = empty_substitution_context(
            &user_displays,
            &snapshot_displays,
            &runtime_displays,
            &data_form_values,
        );
        let mut compat_text = CompatTextFragments::new(source);
        let prepared = prepare_delayed_list_pages_row(
            &template,
            template.body(),
            &page,
            1,
            1,
            &context,
            &[],
            &mut compat_text,
            false,
            None,
        );

        let escaped_payload = "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;";
        assert!(
            prepared.body.contains(escaped_payload),
            "the title payload must be escaped at the substitution boundary: {}",
            prepared.body,
        );
        assert!(
            prepared
                .body
                .contains("&lt;script&gt;alert(2)&lt;/script&gt;"),
            "the title script must be escaped at the substitution boundary: {}",
            prepared.body,
        );
        assert!(
            !prepared.body.contains("<img src=x onerror="),
            "no raw title markup may reach the delayed body: {}",
            prepared.body,
        );
        assert!(
            prepared.body.matches(escaped_payload).count() >= 2,
            "title and tag payloads must both be escaped: {}",
            prepared.body,
        );

        let page_info = PageInfo {
            page: Cow::Borrowed("site"),
            category: Some(Cow::Borrowed("search")),
            site: Cow::Borrowed("sandbox-for-codex"),
            title: Cow::Borrowed("Preview"),
            alt_title: None,
            score: ftml::data::ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let settings = WikitextSettings::from_mode(
            WikitextMode::Page,
            ftml::layout::Layout::Wikidot,
        );

        let output = prepared.body;
        let runtime_text_ranges = prepared.runtime_text_ranges;
        let mut segments = Vec::with_capacity(runtime_text_ranges.len() * 2 + 1);
        let mut cursor = 0usize;
        for range in &runtime_text_ranges {
            if cursor < range.source_range.start {
                segments.push(InputSegment::text(
                    cursor..range.source_range.start,
                    TextOrigin::Authored,
                ));
            }
            segments.push(InputSegment::text(range.source_range.clone(), range.origin));
            cursor = range.source_range.end;
        }
        if cursor < output.len() {
            segments.push(InputSegment::text(
                cursor..output.len(),
                TextOrigin::Authored,
            ));
        }
        let delayed_input = DelayedInput::new(&output, segments)
            .expect("typed ListPages stream should be valid");
        let mut list_settings =
            WikitextSettings::from_mode(WikitextMode::List, settings.layout);
        list_settings.enable_html_blocks = true;
        let delayed_tree = parse_delayed_list(&delayed_input, &page_info, &list_settings)
            .expect("typed ListPages stream should parse");
        let bound = delayed_tree
            .bind(&SlotBindings::new(Vec::new()).expect("bindings"))
            .expect("bind");
        let sealed = bound.render_html(&page_info, &list_settings);
        let served_blocks = sealed.html_blocks().join("\n");

        assert!(
            served_blocks.contains(escaped_payload),
            "the escaped title payload must reach the served html block: {served_blocks:?}",
        );
        assert!(
            !served_blocks.contains("<img src=x onerror="),
            "raw title payload must not reach the served html block: {served_blocks:?}",
        );
        assert!(
            !served_blocks.contains("<script>alert(2)</script>"),
            "raw title script must not reach the served html block: {served_blocks:?}",
        );
    }

    #[test]
    fn authored_template_typography_precedes_generated_value_substitution() {
        let source = concat!(
            "[[row]]\n",
            "[[cell style=\"vertical-align: top; padding: 0 2px;\"]]\n",
            "[*%%link%% %%title%%]\n",
            "Literal... 24,000 km\n",
            "[[/cell]]\n",
            "[[/row]]\n",
            "[[code]]\nCode...\n[[/code]]\n",
            "[[table]]\n",
            "[[row]]\n",
            "[[cell style=\"padding: 0 2px;\"]]\n",
            "REAL CELL\n",
            "[[/cell]]\n",
            "[[/row]]\n",
            "[[/table]]",
        );
        let template =
            ListPagesTemplatePlan::compile(source).expect("supported template");
        let page = FoundPageRow {
            page_id: 1,
            site_id: 1,
            title: Some("Generated...".to_owned()),
            alt_title: None,
            slug: Some("generated".to_owned()),
            page_category_id: None,
            page_revision_id: None,
            tags: None,
            created_at: None,
            created_by: None,
            updated_at: None,
            updated_by: None,
            score: None,
            revision_count: None,
        };
        let user_displays = BTreeMap::new();
        let snapshot_displays = BTreeMap::new();
        let runtime_displays = BTreeMap::new();
        let data_form_values = BTreeMap::new();
        let context = empty_substitution_context(
            &user_displays,
            &snapshot_displays,
            &runtime_displays,
            &data_form_values,
        );
        let mut compat_text = CompatTextFragments::new(source);

        let prepared = prepare_delayed_list_pages_row(
            &template,
            template.body(),
            &page,
            1,
            1,
            &context,
            &[],
            &mut compat_text,
            false,
            None,
        );

        assert!(prepared.body.contains("Literal… 24,000\u{a0}km"));
        assert!(
            prepared.body.contains("padding: 0\u{a0}2px"),
            "literal row/cell markup must receive text typography: {}",
            prepared.body,
        );
        assert!(
            prepared.body.contains("[[cell style=\"padding: 0 2px;\"]]"),
            "an executable table cell attribute must remain CSS: {}",
            prepared.body,
        );
        assert_eq!(prepared.runtime_text_ranges.len(), 1);
        assert_eq!(
            prepared.runtime_text_ranges[0].origin,
            TextOrigin::RuntimeScalar,
        );
        assert_eq!(
            &prepared.body[prepared.runtime_text_ranges[0].source_range.clone()],
            "Generated...",
        );
        let page_info = PageInfo {
            page: Cow::Borrowed("preview"),
            category: None,
            site: Cow::Borrowed("sandbox-for-codex"),
            title: Cow::Borrowed("Preview"),
            alt_title: None,
            score: ftml::data::ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let settings = WikitextSettings::from_mode(
            WikitextMode::Page,
            ftml::layout::Layout::Wikidot,
        );
        let mut compat_html = CompatHtmlFragments::new(source);
        let sealed = seal_list_pages_delayed_output(
            prepared.body.clone(),
            Vec::new(),
            prepared.runtime_text_ranges.clone(),
            Vec::new(),
            &page_info,
            &settings,
            &mut compat_html,
        )
        .expect("runtime scalar row should seal");
        let sealed = compat_html.restore(&sealed);
        assert!(
            sealed.contains("Generated..."),
            "runtime page data must not enter outer-page typography: {sealed}",
        );
        assert!(!sealed.contains("Generated…"));
        assert!(
            prepared.body.contains("Code..."),
            "literal code must retain authored dot runs: {}",
            prepared.body,
        );
    }

    #[test]
    fn unknown_variables_are_runtime_text_inside_recovered_owners() {
        let page = FoundPageRow {
            page_id: 1,
            site_id: 1,
            title: Some("Generated".to_owned()),
            alt_title: None,
            slug: Some("generated".to_owned()),
            page_category_id: None,
            page_revision_id: None,
            tags: None,
            created_at: None,
            created_by: None,
            updated_at: None,
            updated_by: None,
            score: None,
            revision_count: None,
        };
        let user_displays = BTreeMap::new();
        let snapshot_displays = BTreeMap::new();
        let runtime_displays = BTreeMap::new();
        let data_form_values = BTreeMap::new();
        let context = empty_substitution_context(
            &user_displays,
            &snapshot_displays,
            &runtime_displays,
            &data_form_values,
        );
        let page_info = PageInfo {
            page: Cow::Borrowed("preview"),
            category: None,
            site: Cow::Borrowed("sandbox-for-codex"),
            title: Cow::Borrowed("Preview"),
            alt_title: None,
            score: ftml::data::ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let settings = WikitextSettings::from_mode(
            WikitextMode::Page,
            ftml::layout::Layout::Wikidot,
        );

        for (source, expected) in [
            (
                "BEGIN|[[code]]\n%%unknown%%\n[[/code]]\n%%title%%|END",
                concat!(
                    "<p>BEGIN|[[code]]<br>\n",
                    "%%unknown%%<br>\n",
                    "[[/code]]<br>\n",
                    "Generated|END</p>",
                ),
            ),
            (
                "BEGIN|[[div class=\"%%unknown%%\"]]X[[/div]]|%%title%%|END",
                concat!(
                    "<p>BEGIN|[[div class=&quot;%%unknown%%&quot;]]",
                    "X[[/div]]|Generated|END</p>",
                ),
            ),
        ] {
            let template = ListPagesTemplatePlan::compile(source)
                .expect("supported unknown-variable row");
            let mut compat_text = CompatTextFragments::new(source);
            let prepared = prepare_delayed_list_pages_row(
                &template,
                template.body(),
                &page,
                1,
                1,
                &context,
                &[],
                &mut compat_text,
                false,
                None,
            );
            assert_eq!(prepared.runtime_text_ranges.len(), 1, "{source}");
            assert_eq!(
                prepared.runtime_text_ranges[0].origin,
                TextOrigin::RuntimeLiteral,
                "{source}",
            );
            assert_eq!(
                &prepared.body[prepared.runtime_text_ranges[0].source_range.clone()],
                "%%unknown%%",
                "{source}",
            );

            let mut compat_html = CompatHtmlFragments::new(source);
            let sealed = seal_list_pages_delayed_output(
                prepared.body,
                Vec::new(),
                prepared.runtime_text_ranges,
                prepared.html_fragments.into_iter().collect(),
                &page_info,
                &settings,
                &mut compat_html,
            )
            .expect("unknown-variable row should seal");
            assert_eq!(compat_html.restore(&sealed), expected, "{source}");
        }
    }

    #[test]
    fn runtime_scalar_before_empty_html_boundaries_keeps_authored_content() {
        let source = concat!(
            "Before %%title%%.\n",
            "@@@@\n",
            "@@@@\n",
            "After the empty HTML boundary.",
        );
        let template =
            ListPagesTemplatePlan::compile(source).expect("supported template");
        let page = FoundPageRow {
            page_id: 1,
            site_id: 1,
            title: Some("Generated...".to_owned()),
            alt_title: None,
            slug: Some("generated".to_owned()),
            page_category_id: None,
            page_revision_id: None,
            tags: None,
            created_at: None,
            created_by: None,
            updated_at: None,
            updated_by: None,
            score: None,
            revision_count: None,
        };
        let user_displays = BTreeMap::new();
        let snapshot_displays = BTreeMap::new();
        let runtime_displays = BTreeMap::new();
        let data_form_values = BTreeMap::new();
        let context = empty_substitution_context(
            &user_displays,
            &snapshot_displays,
            &runtime_displays,
            &data_form_values,
        );
        let mut compat_text = CompatTextFragments::new(source);
        let prepared = prepare_delayed_list_pages_row(
            &template,
            template.body(),
            &page,
            1,
            1,
            &context,
            &[],
            &mut compat_text,
            false,
            None,
        );
        let page_info = PageInfo {
            page: Cow::Borrowed("preview"),
            category: None,
            site: Cow::Borrowed("sandbox-for-codex"),
            title: Cow::Borrowed("Preview"),
            alt_title: None,
            score: ftml::data::ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let settings = WikitextSettings::from_mode(
            WikitextMode::Page,
            ftml::layout::Layout::Wikidot,
        );
        let mut compat_html = CompatHtmlFragments::new(source);
        let sealed = seal_list_pages_delayed_output(
            prepared.body,
            Vec::new(),
            prepared.runtime_text_ranges,
            Vec::new(),
            &page_info,
            &settings,
            &mut compat_html,
        )
        .expect("runtime scalar row should seal");
        let sealed = compat_html.restore(&sealed);

        assert!(
            sealed.contains("Before Generated..."),
            "content before the empty HTML boundary disappeared: {sealed}",
        );
        assert!(
            sealed.contains("After the empty HTML boundary."),
            "content after the empty HTML boundary disappeared: {sealed}",
        );
    }

    #[test]
    fn runtime_size_ifexpr_prunes_inactive_includes_before_nested_comments() {
        let source = concat!(
            "[[#ifexpr %%size%%%2 != 0 | [!-- ]]\n",
            "[[include component:hidden\n",
            "|[!-- nested usage note --]\n",
            "|value=must-not-expand]]\n",
            "[[#ifexpr %%size%%%2 != 0 | --] ]]\n",
            "[[#ifexpr %%size%%%2 != 1 | [!-- ]]\n",
            "[[include component:visible]]\n",
            "[[#ifexpr %%size%%%2 != 1 | --] ]]",
        );
        let template =
            ListPagesTemplatePlan::compile(source).expect("supported template");
        let page = FoundPageRow {
            page_id: 1,
            site_id: 1,
            title: Some("Generated".to_owned()),
            alt_title: None,
            slug: Some("generated".to_owned()),
            page_category_id: None,
            page_revision_id: None,
            tags: None,
            created_at: None,
            created_by: None,
            updated_at: None,
            updated_by: None,
            score: None,
            revision_count: None,
        };
        let user_displays = BTreeMap::new();
        let snapshot_displays = BTreeMap::new();
        let runtime_displays = BTreeMap::new();
        let data_form_values = BTreeMap::new();
        let mut context = empty_substitution_context(
            &user_displays,
            &snapshot_displays,
            &runtime_displays,
            &data_form_values,
        );
        context.page_wikitext_scalar_count = Some(1);
        let mut compat_text = CompatTextFragments::new(source);

        let prepared = prepare_delayed_list_pages_row(
            &template,
            template.body(),
            &page,
            1,
            1,
            &context,
            &[],
            &mut compat_text,
            false,
            None,
        );

        assert!(
            !prepared.body.contains("component:hidden"),
            "the false branch must be pruned before nested comment syntax or includes run: {}",
            prepared.body,
        );
        assert!(
            prepared.body.contains("[[include component:visible]]"),
            "the selected branch must remain executable: {}",
            prepared.body,
        );
        assert!(
            !prepared.body.contains("[!--")
                && !prepared.body.contains("--]")
                && !prepared.body.contains('—'),
            "generated comment gates must not leak into the delayed row: {}",
            prepared.body,
        );
    }

    #[test]
    fn runtime_size_ifexpr_keeps_selected_generated_css_module() {
        let source = concat!(
            "[[#ifexpr %%size%%%2 != 0 | [!-- ]]\n",
            "[[%%content{0}%%module CSS]]\n",
            ":root { --selected: one; }\n",
            "[[%%content{0}%%/module]]\n",
            "[[#ifexpr %%size%%%2 != 0 | --] ]]\n",
            "[[#ifexpr %%size%%%2 != 1 | [!-- ]]\n",
            "[[%%content{0}%%module CSS]]\n",
            ":root { --selected: two; }\n",
            "[[%%content{0}%%/module]]\n",
            "[[#ifexpr %%size%%%2 != 1 | --] ]]",
        );
        let template =
            ListPagesTemplatePlan::compile(source).expect("supported template");
        let page = FoundPageRow {
            page_id: 1,
            site_id: 1,
            title: Some("Generated".to_owned()),
            alt_title: None,
            slug: Some("generated".to_owned()),
            page_category_id: None,
            page_revision_id: None,
            tags: None,
            created_at: None,
            created_by: None,
            updated_at: None,
            updated_by: None,
            score: None,
            revision_count: None,
        };
        let user_displays = BTreeMap::new();
        let snapshot_displays = BTreeMap::new();
        let runtime_displays = BTreeMap::new();
        let data_form_values = BTreeMap::new();
        let mut context = empty_substitution_context(
            &user_displays,
            &snapshot_displays,
            &runtime_displays,
            &data_form_values,
        );
        context.page_wikitext_scalar_count = Some(1);
        let mut compat_text = CompatTextFragments::new(source);

        let prepared = prepare_delayed_list_pages_row(
            &template,
            template.body(),
            &page,
            1,
            1,
            &context,
            &[],
            &mut compat_text,
            false,
            None,
        );

        assert!(
            prepared.body.contains("--selected: two"),
            "the selected generated CSS module must survive row substitution: {}",
            prepared.body,
        );
        assert!(
            !prepared.body.contains("--selected: one"),
            "the inactive generated CSS module must be pruned: {}",
            prepared.body,
        );
    }

    #[test]
    fn parser_functions_wait_for_listpages_row_substitution() {
        let source = concat!(
            "[[#if true | OUTER | NO]]\n",
            "[[module ListPages category=\"*\"]]\n",
            "[[#if true | %%title_linked%% | NO]] ",
            "[[#ifexpr %%rating%% < 20 | LOW | HIGH]] ",
            "[[#ifexpr %%rating_votes%%-%%rating%%>0 | [[a href=\"/%%name%%\"]]Y[[/a]] | N ]]\n",
            "[[/module]]\n",
            "[[module CountPages category=\"*\"]][[#ifexpr %%total%% >= 60 | MANY | FEW]][[/module]]\n",
            "[[#if false | NO | AFTER]]",
        );
        assert_eq!(
            resolve_wikidot_parser_functions_outside_list_pages(source),
            concat!(
                "OUTER\n",
                "[[module ListPages category=\"*\"]]\n",
                "[[#if true | %%title_linked%% | NO]] ",
                "[[#ifexpr %%rating%% < 20 | LOW | HIGH]] ",
                "[[#ifexpr %%rating_votes%%-%%rating%%>0 | [[a href=\"/%%name%%\"]]Y[[/a]] | N ]]\n",
                "[[/module]]\n",
                "[[module CountPages category=\"*\"]][[#ifexpr %%total%% >= 60 | MANY | FEW]][[/module]]\n",
                "AFTER",
            ),
        );
    }
}
