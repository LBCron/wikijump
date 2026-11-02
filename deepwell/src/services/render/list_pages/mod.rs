/*
 * services/render/list_pages.rs
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

mod ajax;
mod argument_errors;
pub(super) mod authors;
mod batch_loading;
mod bounded_expansion;
mod budget;
pub(super) mod content_sections;
mod current_data_form;
mod current_page;
mod data_forms;
mod delayed;
mod feed;
mod first_image;
mod generated_html;
mod pagination;
mod parents;
mod presentation;
mod preview;
mod random_cache;
mod rendering;
mod rendering_support;
pub(super) mod scanner;
pub(super) mod substitution;
pub(super) mod template;
mod titles;

#[cfg(test)]
pub(super) use self::ajax::{
    AJAX_MODULE_LITERAL_MARKER_PREFIX, build_wikidot_list_pages_module_source,
};
pub(super) use self::ajax::{
    build_wikidot_list_pages_module_request, protect_ajax_module_literal_markers,
};
pub(super) use self::argument_errors::{
    ListPagesArgumentError, list_pages_argument_error_with_parent_precedence,
};
#[cfg(test)]
pub(super) use self::argument_errors::{
    list_pages_non_range_argument_error, list_pages_range_argument_error,
};
pub(super) use self::budget::ListPagesExpansionBudget;
pub(super) use self::current_data_form::list_pages_head_has_current_data_form_query_selector;
pub(super) use self::current_page::{
    count_pages_scan_requires_preservation, count_pages_unbounded_total,
    list_pages_content_query_target, list_pages_row_scan_target,
    page_query_cap_requires_original_module, should_render_current_page_list_pages_row,
};
#[cfg(test)]
pub(super) use self::current_page::{
    current_page_info_list_pages_row, requested_page_info_score,
};
pub(super) use self::data_forms::load_list_pages_data_form_definitions;
#[cfg(test)]
pub(super) use self::delayed::substitute_list_pages_variables_with_fragments;
pub(super) use self::delayed::{
    MAX_NESTED_LISTPAGES_DEPTH, MAX_NESTED_LISTPAGES_MODULES_PER_PASS,
    PendingDelayedListPagesOutput, append_list_pages_delayed_occurrences,
    append_list_pages_runtime_text_ranges,
    find_list_pages_module_matches_with_delayed_links_budgeted,
    finish_or_defer_list_pages_delayed_output_with_modes, list_pages_row_markup_bytes,
    list_pages_runtime_container_close, list_pages_runtime_container_open,
    list_pages_runtime_row_container_close, list_pages_runtime_row_container_open,
    prepare_delayed_list_pages_row_with_budget,
    protect_generated_parser_function_comment_gates, raw_module_close_end,
    replace_recursive_list_pages_with_error,
    resolve_wikidot_parser_functions_outside_list_pages,
    restore_pending_nested_list_pages, seal_pending_list_pages_delayed_outputs,
    seal_protected_list_pages_delayed_output, seal_zero_row_list_pages_wrapper,
    wrap_pending_list_pages_delayed_output,
};

pub(super) fn wikitext_has_executable_list_pages_module(wikitext: &str) -> bool {
    scanner::find_list_pages_module_matches(wikitext)
        .iter()
        .any(|module| {
            !module.preserve_original
                && scanner::list_pages_runtime_head_can_execute(module.head)
        })
}
pub(super) use self::first_image::{
    list_pages_body_uses_first_image, load_list_pages_first_images,
    resolve_list_pages_first_image,
};
pub(super) use self::generated_html::{
    register_generated_list_pages_html, repair_list_pages_block_boundaries,
    strip_generated_list_pages_html_markers, url_offset_list_pages_content_bytes,
};
pub(super) use self::pagination::{
    ListPagesPagerRoute, list_pages_feed_info_html, push_list_pages_pager,
};
#[cfg(test)]
pub(super) use self::parents::ListPagesParentDisplay;
#[cfg(test)]
pub(super) use self::presentation::{
    format_list_pages_created_at, list_pages_tag_link_href, render_list_pages_tags,
    substitute_list_pages_variables,
};
pub(super) use self::presentation::{
    is_list_pages_visible_tag, list_pages_created_by_slug, list_pages_parent_fullname,
    render_list_pages_wikidot_user, substitute_count_pages_variables,
};
pub(super) use self::random_cache::seed_random_list_pages_order;
pub(super) use self::rendering::render_wikidot_social_module;
pub(super) use self::rendering_support::{
    CountPagesBlockRenderResult, CountPagesExpansionOptions, CountPagesRequiredTagSource,
    CountPagesRequiredTagTotal, ListPagesBlockRenderResult, ListPagesContentCache,
    ListPagesExpansion, ListPagesExpansionOptions, ListPagesPageContext,
    ListPagesRenderedBlock, expand_list_pages_generated_includes,
    list_pages_body_starts_with_preparsed_block, list_pages_feed_only_render_result,
    list_pages_html_encoded_head_owns_script_tail, prepare_list_pages_rendered_block,
    preserve_list_pages_module_matches, push_list_pages_generated_output,
    push_list_pages_generated_output_with_cost, push_list_pages_trailing_runtime_blocks,
    suppress_generated_list_pages_heading_toc,
};
pub(super) use self::substitution::{
    CurrentPageAuthorSource, ExactNameListPagesBatchKey, ListPagesArguments,
    ListPagesAuthorCacheKey, ListPagesBatchDisplayRequirements, ListPagesBatchDisplays,
    ListPagesRuntimeDisplay, ListPagesSnapshotDisplay, ListPagesSubstitutionContext,
    ResolvedListPagesAuthors, WikidotUserDisplay,
    advance_literal_cursor_and_check_count_pages_capture_containment,
    count_pages_exact_count_render_diagnostics, count_pages_required_tag_batch_result,
    count_pages_required_tag_batch_selector, count_pages_should_remain_literal,
    count_pages_unbounded_all_category_shape, exact_name_list_pages_batch_key,
    list_pages_author_cache_key, list_pages_body_is_no_visible_tracking_markup,
    list_pages_first_paragraph, list_pages_has_unsupported_page_type_selector,
    list_pages_has_unsupported_parent_selector,
    list_pages_recognized_static_url_fallback_ranges,
    list_pages_static_category_preflight, list_pages_static_parent_fullname_with_url,
    list_pages_unknown_link_target_slugs, parse_list_pages_arguments,
    parse_list_pages_arguments_with_url, union_found_page_fields,
    unsupported_list_pages_replacement,
};
#[cfg(test)]
pub(super) use self::substitution::{
    ListPagesOffsetOrigin, list_pages_body_uses_content_variable,
    list_pages_body_variables_supported, list_pages_static_parent_fullname,
    parse_list_pages_date_selector,
};

use crate::services::PageRevisionService;
use std::borrow::Cow;

#[cfg(test)]
mod tests {
    use super::template::ListPagesTemplatePlan;
    use super::*;
    use crate::services::page_query::{
        DateSelector, OrderBySelector, OrderProperty, PageParentSelector,
        PageTypeSelector, RangeSelector,
    };

    #[test]
    fn parses_explicit_ascending_order_direction() {
        let arguments =
            parse_list_pages_arguments(r#"name="fixture-*" order="name asc" limit="2""#)
                .expect("explicit ascending order should parse");

        let order = arguments.order.expect("order should be present");
        assert_eq!(order.property, OrderProperty::PageSlug);
        assert!(order.ascending);
    }

    #[test]
    fn parses_corpus_data_form_selector_and_dynamic_css_template() {
        let arguments = parse_list_pages_arguments(
            r#"category="attention-jp" limit="1" order="_date desc" _category="3" _original="1""#,
        )
        .expect("static data-form ListPages selectors should parse");
        assert!(!arguments.unsupported_list_pages_filter);
        assert!(!arguments.unsupported_score_filter);
        assert_eq!(arguments.data_form_fields.len(), 2);

        let template = ListPagesTemplatePlan::compile(concat!(
            "[[%%content{0}%%module css]]\n",
            ".numparent { counter-reset: num %%total%%; }\n",
            "[[%%content{0}%%/module]]",
        ));
        assert!(template.is_some());

        let zero_limit_head = r#"limit="@URL|0" range="." urlAttrPrefix="page5""#;
        let zero_limit = parse_list_pages_arguments(zero_limit_head)
            .expect("URL fallback should parse");
        assert_eq!(
            zero_limit.limit,
            Some(1),
            "the later current-page range owns the effective one-row limit",
        );
        let source = format!(
            "[[module ListPages {zero_limit_head}]]\n%%unsupported%%\n\
             [[%%content{{0}}%%module css]]\n.unused {{}}\n\
             [[%%content{{0}}%%/module]]\n[[/module]]",
        );
        assert_eq!(scanner::find_list_pages_module_matches(&source).len(), 1);
    }

    #[test]
    fn composite_category_url_selector_preserves_modifiers_and_fallback() {
        const HEAD: &str = concat!(
            r#"category="@URL -geheim -deleted|"#,
            r#"* -system -admin -geheim -forum -nav -search""#,
        );

        let fallback = parse_list_pages_arguments(HEAD)
            .expect("the corpus composite URL category fallback should parse");
        assert!(fallback.category_selector_present);
        assert!(fallback.category_all);
        assert!(fallback.categories.is_empty());
        assert_eq!(
            fallback.excluded_categories,
            ["system", "admin", "geheim", "forum", "nav", "search"],
        );

        let path_arguments = [crate::services::render::UrlArgumentPair {
            name: "category".to_owned(),
            value: Some("fragment".to_owned()),
        }];
        let url = crate::services::render::UrlArguments {
            path_arguments: &path_arguments,
            ..crate::services::render::UrlArguments::default()
        };
        let resolved = parse_list_pages_arguments_with_url(HEAD, url)
            .expect("the composite URL category selector should resolve");
        assert!(resolved.category_selector_present);
        assert!(!resolved.category_all);
        assert_eq!(resolved.categories, ["fragment"]);
        assert_eq!(resolved.excluded_categories, ["geheim", "deleted"]);

        let near_miss =
            parse_list_pages_arguments(r#"category="@URLish -hidden|* -system""#)
                .expect("a near-miss URL token remains a static selector");
        assert!(!near_miss.category_all);
        assert_eq!(near_miss.categories, ["@urlish"]);
        assert_eq!(near_miss.excluded_categories, ["hidden|*", "system"]);
    }

    #[test]
    fn recognizes_live_list_pages_argument_errors() {
        for (head, has_current_page, expected) in [
            (r#"range="others""#, false, Some("Invalid range argument.")),
            (r#"range="others""#, true, None),
            (
                r#"range="@URL|others""#,
                false,
                Some("Invalid range argument."),
            ),
            (r#"range="bogus""#, true, Some("Invalid range argument.")),
            (
                r#"pagetype="bogus""#,
                false,
                Some("Invalid pagetype attribute."),
            ),
            (r#"rating="bad""#, false, Some("Invalid rating argument.")),
            (r#"votes="bad""#, false, Some("Invalid votes argument.")),
        ] {
            assert_eq!(
                list_pages_non_range_argument_error(head).or_else(|| {
                    list_pages_range_argument_error(
                        head,
                        has_current_page,
                        crate::services::render::UrlArguments::default(),
                    )
                }),
                expected,
                "{head:?}",
            );
        }
        assert!(parse_list_pages_arguments(r#"rating="<>5""#).is_some());
        assert_eq!(
            list_pages_static_parent_fullname(r#"parent="system:start""#),
            Some("system:start".to_owned()),
        );
        assert_eq!(list_pages_static_parent_fullname(r#"parent=".""#), None,);
        let arguments = parse_list_pages_arguments(r#"parent="system:start""#)
            .expect("a named parent should become a query selector");
        assert_eq!(
            arguments.static_parent_fullname.as_deref(),
            Some("system:start"),
        );
        assert!(!list_pages_has_unsupported_parent_selector(
            r#"parent="system:start""#,
        ));

        let arguments =
            parse_list_pages_arguments(r#"limit="" perPage="" separate="" wrapper="""#)
                .expect("empty live defaults should parse");
        assert_eq!(arguments.limit, None);
        assert_eq!(arguments.count_pages_per_page, None);
        assert!(arguments.separate);
        assert!(arguments.wrapper);

        let arguments =
            parse_list_pages_arguments(r#"limit="999999999" perPage="999999999""#)
                .expect("large live limits should parse");
        assert_eq!(arguments.limit, Some(999_999_999));
        assert_eq!(arguments.count_pages_per_page, Some(250));

        let arguments = parse_list_pages_arguments(r#"tags="=" parent="-=""#)
            .expect("documented current-tag and parent selectors should parse");
        assert!(arguments.same_visible_tags);
        assert_eq!(arguments.page_parent, PageParentSelector::DifferentParents,);
        assert!(!arguments.unsupported_list_pages_filter);
        assert!(!list_pages_has_unsupported_parent_selector(
            r#"parent="-=""#,
        ));
        let arguments = parse_list_pages_arguments(r#"tag="==""#)
            .expect("documented exact current-tag selector should parse");
        assert!(arguments.exact_visible_tags);

        let arguments = parse_list_pages_arguments(
            r#"created_at="=" updated_at="=" rating="=" votes="=""#,
        )
        .expect("current-page date and rating selectors should parse");
        assert!(arguments.creation_date_current_page);
        assert!(arguments.update_date_current_page);
        assert!(arguments.score_equals_current_page);
        assert!(arguments.votes_equals_current_page);
        assert!(!arguments.unsupported_list_pages_filter);

        for head in [
            r#"created_at="last hour""#,
            r#"created_at="older than month""#,
            r#"created_at="older than 2""#,
            r#"updated_at="newer than week""#,
        ] {
            assert!(
                parse_list_pages_arguments(head).is_some(),
                "{head:?} should parse",
            );
        }
        assert!(
            parse_list_pages_arguments(r#"created_at="not-a-date""#).is_some(),
            "live ignores an invalid date selector",
        );

        for head in [
            r#"created_at<"2018.12.26""#,
            r#"created_at>="2021.2.16""#,
            r#"updated_at<"2017.02.04""#,
            r#"rating>="-7""#,
            r#"votes!="0""#,
        ] {
            assert!(
                parse_list_pages_arguments(head).is_some(),
                "legacy comparison operators belong to the selector rather than invalidating {head:?}",
            );
        }

        let path_arguments = vec![
            crate::services::render::UrlArgumentPair {
                name: "created_by".to_owned(),
                value: Some("administrator".to_owned()),
            },
            crate::services::render::UrlArgumentPair {
                name: "order".to_owned(),
                value: Some("name desc".to_owned()),
            },
            crate::services::render::UrlArgumentPair {
                name: "parent".to_owned(),
                value: Some("System:Start".to_owned()),
            },
        ];
        let url = crate::services::render::UrlArguments {
            path_arguments: &path_arguments,
            ..crate::services::render::UrlArguments::default()
        };
        let arguments = parse_list_pages_arguments_with_url(
            r#"created_by="@URL" order="@URL" parent="@URL" rating="@URL" name="@URL""#,
            url,
        )
        .expect("URL-backed selectors should resolve independently and absent URL values should drop");
        assert_eq!(arguments.authors, vec![Cow::Borrowed("administrator")]);
        assert_eq!(
            arguments.order,
            Some(OrderBySelector {
                property: OrderProperty::PageSlug,
                ascending: false,
            }),
        );
        assert_eq!(
            arguments.static_parent_fullname.as_deref(),
            Some("system:start"),
        );
        assert!(arguments.score.is_empty());
        assert!(arguments.slug.is_none());
        assert!(!arguments.unsupported_author_filter);
        assert!(!arguments.unsupported_list_pages_filter);

        let arguments = parse_list_pages_arguments_with_url(
            r#"parent="Definitely-Missing-ListPages-Parent" parent="@URL""#,
            crate::services::render::UrlArguments::default(),
        )
        .expect("a dropped duplicate URL parent should still parse");
        assert_eq!(
            arguments.static_parent_fullname, None,
            "a dropped URL parent must clear an earlier static parent selector",
        );

        let arguments = parse_list_pages_arguments_with_url(
            r#"pagetype="@URL" created_at="@URL" updated_at="@URL" link_to="@URL" reverse="@URL""#,
            crate::services::render::UrlArguments::default(),
        )
        .expect("unresolved URL selectors without fallbacks should be omitted like absent arguments");
        assert_eq!(arguments.page_type, PageTypeSelector::Normal);
        assert!(arguments.link_to.is_empty());
        assert!(!arguments.reverse);

        let arguments = parse_list_pages_arguments_with_url(
            "tags=\"@URL|\u{202f}\" separate=\"no\"",
            crate::services::render::UrlArguments::default(),
        )
        .expect("an explicit whitespace-only URL tag fallback should parse");
        assert_eq!(
            arguments.all_tags,
            vec![Cow::Borrowed("")],
            "live treats an explicit empty URL tag fallback as a no-row selector, \
             not as an omitted selector",
        );

        let arguments = parse_list_pages_arguments_with_url(
            r#"tags="+ko @URL" separate="no""#,
            crate::services::render::UrlArguments::default(),
        )
        .expect("a mixed unresolved URL tag selector should still parse");
        assert_eq!(arguments.all_tags, vec![Cow::Borrowed("ko")]);
        assert_eq!(
            arguments.default_tags,
            vec![Cow::Borrowed("@url")],
            "live retains @URL as a literal required-alternative tag when it is \
             only one token in a mixed tags selector",
        );

        let arguments = parse_list_pages_arguments(r#"order="created""#)
            .expect("an unsupported order alias should use the live default order");
        assert_eq!(
            arguments.order,
            Some(OrderBySelector::default()),
            "live does not recognize created as created_at and falls back to \
             the default newest-first order",
        );

        let arguments = parse_list_pages_arguments(
            r#"category="fragment" parent="." order="name"" limit="1" offset="@URL|0""#,
        )
        .expect("live-tokenized interior quote in order value should parse");
        assert_eq!(arguments.categories, vec![Cow::Borrowed("fragment")]);
        assert_eq!(arguments.page_parent, PageParentSelector::ChildOf);
        assert_eq!(arguments.order, Some(OrderBySelector::default()));
        assert_eq!(arguments.limit, Some(1));

        let arguments =
            parse_list_pages_arguments(r#"tags="+scp rating="<0" separate="no""#)
                .expect("live-tokenized interior quote in tags value should parse");
        assert_eq!(arguments.all_tags, vec![Cow::Borrowed("scp")]);
        assert_eq!(arguments.default_tags, vec![Cow::Borrowed(r#"rating="<0"#)]);
        assert!(!arguments.separate);
        assert!(!arguments.unsupported_list_pages_filter);

        let arguments = parse_list_pages_arguments(
            r#"separate="1" tags="+阿尔兹海默症 -中心" order="random"  perPage="50""#,
        )
        .expect("the corpus Unicode-tag selector should parse");
        assert_eq!(arguments.all_tags, vec![Cow::Borrowed("阿尔兹海默症")],);
        assert_eq!(arguments.no_tags, vec![Cow::Borrowed("中心")]);
        assert!(!arguments.unsupported_list_pages_filter);

        for unknown in [
            r#"seperated="no""#,
            r#"der="title""#,
            r#"sort="created_by desc""#,
            r#"hide="hidden""#,
            r#"show="shown""#,
            r#"by="someone""#,
            r#"details="true""#,
            r#"width="200px""#,
            r#"create_by="someone""#,
            r#"creat_by="someone""#,
            r#"name-="SCP Série*""#,
            r#"imit="150""#,
            r#"v="value""#,
            r#"limite="100""#,
            r#"author="someone""#,
        ] {
            let head = format!(r#"category="*" limit="1" order="name" {unknown}"#);
            let arguments = parse_list_pages_arguments(&head).unwrap_or_else(|| {
                panic!("unknown argument should be ignored: {unknown}")
            });
            assert!(arguments.category_all);
            assert_eq!(arguments.limit, Some(1));
            assert_eq!(
                arguments.order,
                Some(OrderBySelector {
                    property: OrderProperty::PageSlug,
                    ascending: true,
                }),
            );
            assert!(!arguments.unsupported_list_pages_filter);
        }

        for (inert, head) in [
            ("pipe", r#"| name="target" limit="1" order="name""#),
            ("bare flag", r#"size name="target" limit="1" order="name""#),
            (
                "empty assignment",
                r#"name="target" limit="1" order="name" prependLine="#,
            ),
            ("at markers", r#"name="target" limit="1" order="name"@@"#),
        ] {
            let arguments = parse_list_pages_arguments(head).unwrap_or_else(|| {
                panic!("live inert head token should be ignored: {inert}")
            });
            assert_eq!(arguments.slug.as_deref(), Some("target"), "{inert}");
            assert_eq!(arguments.limit, Some(1), "{inert}");
            assert_eq!(
                arguments.order,
                Some(OrderBySelector {
                    property: OrderProperty::PageSlug,
                    ascending: true,
                }),
                "{inert}",
            );
        }
    }

    #[test]
    fn url_tag_values_keep_wikidot_selector_grammar() {
        for (url_value, expected_default, expected_all, expected_none) in [
            (
                "secret",
                ["secret"].as_slice(),
                [].as_slice(),
                [].as_slice(),
            ),
            (
                "+secret",
                [].as_slice(),
                ["secret"].as_slice(),
                [].as_slice(),
            ),
            (
                "-secret",
                [].as_slice(),
                [].as_slice(),
                ["secret"].as_slice(),
            ),
        ] {
            let path_arguments = [crate::services::render::UrlArgumentPair {
                name: "tag".to_owned(),
                value: Some(url_value.to_owned()),
            }];
            let url = crate::services::render::UrlArguments {
                path_arguments: &path_arguments,
                ..crate::services::render::UrlArguments::default()
            };
            let arguments = parse_list_pages_arguments_with_url(
                r#"tags="@URL|_" separate="no""#,
                url,
            )
            .expect("a URL-backed tag selector should parse");
            assert_eq!(arguments.default_tags, expected_default, "{url_value}");
            assert_eq!(arguments.all_tags, expected_all, "{url_value}");
            assert_eq!(arguments.no_tags, expected_none, "{url_value}");
        }
    }

    #[test]
    fn html_escaped_quote_assignments_remain_inert() {
        let arguments = parse_list_pages_arguments(
            "category=&quot;fragment&quot; parent=&quot;.&quot; \
             limit=&quot;1&quot; order=&quot;name&quot; offset=&quot;@URL|0&quot;",
        )
        .expect("the structurally valid ListPages head should execute");

        assert!(arguments.category_all);
        assert!(!arguments.category_selector_present);
        assert!(arguments.categories.is_empty());
        assert_eq!(arguments.page_parent, PageParentSelector::All);
        assert_eq!(arguments.static_parent_fullname, None);
        assert_eq!(arguments.limit, None);
        assert_eq!(arguments.order, None);
        assert_eq!(arguments.offset, 0);
        assert!(!arguments.unsupported_list_pages_filter);
        assert!(!arguments.unsupported_author_filter);
        assert!(!arguments.unsupported_score_filter);
        assert_eq!(
            list_pages_static_parent_fullname("parent=&quot;.&quot; limit=&quot;1&quot;",),
            None,
        );
    }

    #[test]
    fn list_pages_argument_activation_preserves_wikidot_source_grammar() {
        let arguments = parse_list_pages_arguments(concat!(
            r#"name="target" NAME="missing" name=bare name='single' full_slug="missing" fullslug="missing" "#,
            r#"tags="component" TAGS="missing" tags=bare tags='single' "#,
            r#"limit="2" LIMIT="0" limit=0 limit='0' "#,
            r#"offset="3" OFFSET="1" offset=1 offset='1' "#,
            r#"perPage="5" perpage="1" per_page="1" perPage=1 perPage='1' "#,
            r#"wrapper="no" WRAPPER="yes" wrapper=yes wrapper='yes' "#,
            r#"separate="no" SEPARATE="yes" separate=yes separate='yes' "#,
            r#"reverse="no" REVERSE="yes" reverse=yes reverse='yes' "#,
            r#"range="." RANGE="others" range=others range='others' "#,
            r#"created_by="" createdby="missing" CREATED_BY="missing" "#,
            r#"rss="" rssTitle="Alias" RSS="Wrong" rssTitle='Wrong' "#,
            r#"prependLine="before" prependline="wrong" prependLine='wrong' "#,
            r#"appendLine="after" appendline="wrong" appendLine=wrong appendLine='wrong' "#,
            r#"score=">100000" createdat="1900" updatedat="1900" "#,
            r#"rating>100000 votes>100000 created_at>2100 date>2100 "#,
            r#"name!="ignored" range!="others""#,
        ))
        .expect("inert ListPages head forms must not abort the module");

        assert_eq!(arguments.slug.as_deref(), Some("target"));
        assert_eq!(arguments.default_tags, vec![Cow::Borrowed("component")]);
        assert_eq!(arguments.limit, Some(1), "range=\".\" owns a one-row limit");
        assert_eq!(arguments.offset, 3);
        assert_eq!(arguments.count_pages_per_page, Some(5));
        assert!(!arguments.wrapper);
        assert!(!arguments.separate);
        assert!(!arguments.reverse);
        assert!(arguments.current_page_only);
        assert!(!arguments.exclude_current_page);
        assert!(!arguments.author_filter_present);
        assert!(arguments.authors.is_empty());
        assert_eq!(arguments.rss_title.as_deref(), Some("Alias"));
        assert_eq!(arguments.prepend_line.as_deref(), Some("before"));
        assert_eq!(arguments.append_line.as_deref(), Some("after"));
        assert!(arguments.score.is_empty());
        assert!(arguments.votes.is_empty());
        assert_eq!(
            arguments.creation_date,
            DateSelector::FromPresent {
                start: time::OffsetDateTime::UNIX_EPOCH,
            },
        );
        assert_eq!(
            arguments.update_date,
            DateSelector::FromPresent {
                start: time::OffsetDateTime::UNIX_EPOCH,
            },
        );
    }

    #[test]
    fn non_data_form_form_argument_is_inert() {
        for form in [
            r#"form="""#,
            r#"form=" ""#,
            r#"form="1""#,
            r#"form="name""#,
            r#"form="*""#,
            r#"form="yes""#,
            r#"form="no""#,
            r#"FORM="name""#,
            r#"Form="name""#,
            r#"fOrM="name""#,
            "form=name",
            "form='name'",
            "form=",
            r#"form="a" form="b""#,
            r#"form="@URL""#,
            r#"form="@URL|name""#,
            r#"form="component:image-block""#,
        ] {
            let head = format!(
                r#"category="*" name="component:image-block" separate="no" wrapper="no" {form}"#,
            );
            let arguments = parse_list_pages_arguments(&head)
                .unwrap_or_else(|| panic!("inert form argument must not abort {head:?}"));

            assert!(arguments.category_all, "{head}");
            assert_eq!(
                arguments.slug.as_deref(),
                Some("component:image-block"),
                "{head}",
            );
            assert!(!arguments.separate, "{head}");
            assert!(!arguments.wrapper, "{head}");
            assert!(!arguments.unsupported_list_pages_filter, "{head}");
            assert!(!arguments.unsupported_count_pages_filter, "{head}");

            let source = format!(
                "[[module ListPages {head}]]\nBEGIN|%%fullname%%|END\n[[/module]]",
            );
            assert_eq!(
                scanner::find_list_pages_module_matches(&source).len(),
                1,
                "scanner and argument parser must agree for {head:?}",
            );
        }

        let data_form = parse_list_pages_arguments(
            r#"category="*" name="component:image-block" _form="name""#,
        )
        .expect("underscore-prefixed form remains a data-form selector");
        assert_eq!(data_form.data_form_fields.len(), 1);
        assert_eq!(data_form.data_form_fields[0].field.as_ref(), "form");
        assert_eq!(data_form.data_form_fields[0].value.as_ref(), "name");
    }

    #[test]
    fn link_to_uses_exact_canonical_grammar_and_last_occurrence() {
        for head in [
            r#"linkTo="target""#,
            r#"linkto="target""#,
            r#"LINK_TO="target""#,
            r#"Link_To="target""#,
            r#"link_To="target""#,
            r#"link_to=target"#,
            r#"link_to='target'"#,
            r#"link_to="""#,
            r#"link_to=" ""#,
        ] {
            let arguments = parse_list_pages_arguments(head)
                .unwrap_or_else(|| panic!("inert link_to form must not abort {head:?}"));
            assert!(arguments.link_to.is_empty(), "{head}");
        }

        let arguments = parse_list_pages_arguments(
            r#"link_to="first" link_to="second" linkTo="third""#,
        )
        .expect("canonical link_to duplicates should parse");
        assert_eq!(arguments.link_to, vec![Cow::Borrowed("second")]);

        let arguments =
            parse_list_pages_arguments(r#"link_to="first" linkTo="third" link_to="""#)
                .expect(
                    "an empty canonical link_to should be an omitted last occurrence",
                );
        assert!(arguments.link_to.is_empty());
    }

    #[test]
    fn skip_current_uses_exact_canonical_grammar_and_last_occurrence() {
        for head in [
            r#"skipcurrent="yes""#,
            r#"skip_current="yes""#,
            r#"SKIPCURRENT="yes""#,
            r#"SkipCurrent="yes""#,
            "skipCurrent=yes",
            "skipCurrent='yes'",
        ] {
            let arguments = parse_list_pages_arguments(head)
                .unwrap_or_else(|| panic!("inert skipCurrent form must parse {head:?}"));
            assert!(!arguments.exclude_current_page, "{head}");
        }

        for head in [
            r#"skipCurrent="yes" skipCurrent="no""#,
            r#"skipCurrent="true" skipCurrent="false""#,
            r#"skip_current="yes" skipCurrent="no""#,
        ] {
            let arguments = parse_list_pages_arguments(head).unwrap_or_else(|| {
                panic!("canonical skipCurrent reset must parse {head:?}")
            });
            assert!(!arguments.exclude_current_page, "{head}");
        }

        let arguments =
            parse_list_pages_arguments(r#"skipCurrent="no" skipCurrent="yes""#)
                .expect("the last canonical skipCurrent value should win");
        assert!(arguments.exclude_current_page);

        let arguments = parse_list_pages_arguments(r#"skipCurrent="@URL|yes""#)
            .expect("skipCurrent should resolve its URL fallback before boolean parsing");
        assert!(arguments.exclude_current_page);
    }

    #[test]
    fn order_uses_exact_canonical_grammar_and_empty_reset() {
        for head in [
            r#"ORDER="name""#,
            r#"Order="name""#,
            r#"oRdEr="name""#,
            "order=name",
            "order='name'",
        ] {
            let arguments = parse_list_pages_arguments(head)
                .unwrap_or_else(|| panic!("inert order form must parse {head:?}"));
            assert_eq!(arguments.order, None, "{head}");
        }

        let arguments = parse_list_pages_arguments(r#"order="name" order="""#)
            .expect("an empty canonical order should reset the prior state");
        assert_eq!(arguments.order, None);

        for value in ["fullslug", "full_slug", "createdat", "updatedat"] {
            let head = format!(r#"order="{value}""#);
            let arguments = parse_list_pages_arguments(&head)
                .unwrap_or_else(|| panic!("unsupported order alias must parse {value}"));
            assert_eq!(arguments.order, Some(OrderBySelector::default()), "{value}",);
        }
    }

    #[test]
    fn data_form_selector_uses_evidenced_quote_and_empty_grammar() {
        for head in [r#"_missing="""#, "_missing=x", "_missing='x'"] {
            let arguments = parse_list_pages_arguments(head)
                .unwrap_or_else(|| panic!("inert data-form form must parse {head:?}"));
            assert!(arguments.data_form_fields.is_empty(), "{head}");
        }

        let whitespace = parse_list_pages_arguments(r#"_missing=" ""#)
            .expect("a whitespace-only quoted data-form selector is active");
        assert_eq!(whitespace.data_form_fields.len(), 1);
        assert_eq!(whitespace.data_form_fields[0].field.as_ref(), "missing");
        assert_eq!(whitespace.data_form_fields[0].value.as_ref(), "");

        let empty_field = parse_list_pages_arguments(r#"_="x""#)
            .expect("the evidenced empty data-form field name should remain active");
        assert_eq!(empty_field.data_form_fields.len(), 1);
        assert_eq!(empty_field.data_form_fields[0].field.as_ref(), "");
        assert_eq!(empty_field.data_form_fields[0].value.as_ref(), "x");
    }

    #[test]
    fn url_attr_prefix_uses_exact_source_grammar_and_preserves_value_bytes() {
        for head in [
            r#"urlattrprefix="x""#,
            r#"URLATTRPREFIX="x""#,
            r#"UrlAttrPrefix="x""#,
            "urlAttrPrefix=x",
            "urlAttrPrefix='x'",
        ] {
            let arguments = parse_list_pages_arguments(head).unwrap_or_else(|| {
                panic!("inert urlAttrPrefix form must parse {head:?}")
            });
            assert_eq!(arguments.url_attr_prefix, None, "{head}");
        }

        let arguments = parse_list_pages_arguments(
            r#"urlAttrPrefix="a" urlattrprefix="ignored" urlAttrPrefix="  x/y  ""#,
        )
        .expect("canonical urlAttrPrefix duplicates should parse");
        assert_eq!(arguments.url_attr_prefix.as_deref(), Some("  x/y  "));
    }

    #[test]
    fn parent_uses_exact_canonical_grammar_and_last_occurrence() {
        for head in [
            r#"PARENT="=""#,
            r#"Parent="=""#,
            "parent==",
            "parent='='",
            "parent=-=",
            "parent='-='",
            "parent=.",
            "parent='.'",
        ] {
            let arguments = parse_list_pages_arguments(head)
                .unwrap_or_else(|| panic!("inert parent form must parse {head:?}"));
            assert_eq!(arguments.page_parent, PageParentSelector::All, "{head}");
            assert_eq!(arguments.static_parent_fullname, None, "{head}");
        }

        let arguments =
            parse_list_pages_arguments(r#"parent="system:start" parent="=" parent="-=""#)
                .expect("canonical parent duplicates should parse");
        assert_eq!(arguments.page_parent, PageParentSelector::DifferentParents,);
        assert_eq!(arguments.static_parent_fullname, None);

        let arguments =
            parse_list_pages_arguments(r#"parent="=" PARENT="." parent="system:start""#)
                .expect("inert aliases must not participate in parent precedence");
        assert_eq!(arguments.page_parent, PageParentSelector::All);
        assert_eq!(
            arguments.static_parent_fullname.as_deref(),
            Some("system:start"),
        );

        let arguments = parse_list_pages_arguments(r#"parent="@URL|-=""#)
            .expect("parent should resolve its URL fallback before mode selection");
        assert_eq!(arguments.page_parent, PageParentSelector::DifferentParents,);
    }

    #[test]
    fn tag_target_uses_exact_canonical_grammar_and_last_occurrence() {
        for head in [
            r#"tagtarget="landing""#,
            r#"TAGTARGET="landing""#,
            r#"TagTarget="landing""#,
            r#"tag_target="landing""#,
            "tagTarget=landing",
            "tagTarget='landing'",
        ] {
            let arguments = parse_list_pages_arguments(head)
                .unwrap_or_else(|| panic!("inert tagTarget form must parse {head:?}"));
            assert_eq!(arguments.tag_target, None, "{head}");
        }

        let arguments = parse_list_pages_arguments(
            r#"tagTarget="first" tagtarget="ignored" tagTarget="landing""#,
        )
        .expect("canonical tagTarget duplicates should parse");
        assert_eq!(arguments.tag_target.as_deref(), Some("landing"));

        let arguments = parse_list_pages_arguments(r#"tagTarget="landing" tagTarget="""#)
            .expect("an empty canonical tagTarget should clear the prior state");
        assert_eq!(arguments.tag_target, None);
    }

    #[test]
    fn url_selectors_use_exact_authored_path_key_identity() {
        use crate::services::render::{UrlArgumentPair, UrlArguments};

        let path_arguments = vec![
            UrlArgumentPair {
                name: "tags".to_owned(),
                value: Some("+component".to_owned()),
            },
            UrlArgumentPair {
                name: "_Missing".to_owned(),
                value: Some("x".to_owned()),
            },
            UrlArgumentPair {
                name: "pFx__Missing".to_owned(),
                value: Some("prefixed".to_owned()),
            },
        ];
        let url = UrlArguments {
            path_arguments: &path_arguments,
            ..UrlArguments::default()
        };

        let tags = parse_list_pages_arguments_with_url(r#"tags="@URL|fallback""#, url)
            .expect("unprefixed tags should accept the exact tag/tags alias set");
        assert_eq!(tags.all_tags, vec![Cow::Borrowed("component")]);

        let field = parse_list_pages_arguments_with_url(r#"_Missing="@URL""#, url)
            .expect("an exact data-form URL key should resolve");
        assert_eq!(field.data_form_fields.len(), 1);
        assert_eq!(field.data_form_fields[0].field.as_ref(), "Missing");
        assert_eq!(field.data_form_fields[0].value.as_ref(), "x");

        let prefixed = parse_list_pages_arguments_with_url(
            r#"urlAttrPrefix="pFx" _Missing="@URL""#,
            url,
        )
        .expect("a prefixed data-form URL key should retain its double underscore");
        assert_eq!(prefixed.data_form_fields.len(), 1);
        assert_eq!(prefixed.data_form_fields[0].field.as_ref(), "Missing");
        assert_eq!(prefixed.data_form_fields[0].value.as_ref(), "prefixed");

        let absent = parse_list_pages_arguments_with_url(r#"_missing="@URL""#, url)
            .expect("an absent exact data-form URL key should drop the selector");
        assert!(absent.data_form_fields.is_empty());
    }

    #[test]
    fn later_range_replaces_the_prior_range_owned_limit() {
        for (
            head,
            expected_limit,
            expected_explicit_limit,
            expected_current_page,
            expected_exclude_current,
            expected_relative,
        ) in [
            (r#"range="." range="others""#, None, None, false, true, None),
            (r#"range="." range="0""#, None, None, false, false, None),
            (
                r#"limit="5" range="." range="others""#,
                Some(5),
                Some(5),
                false,
                true,
                None,
            ),
            (
                r#"limit="5" range="." range="0""#,
                Some(5),
                Some(5),
                false,
                false,
                None,
            ),
            (
                r#"range="." limit="5" range="others""#,
                Some(5),
                Some(5),
                false,
                true,
                None,
            ),
            (
                r#"range="." range="before""#,
                None,
                None,
                false,
                false,
                Some(RangeSelector::Before),
            ),
            (
                r#"range="others" range=".""#,
                Some(1),
                None,
                true,
                false,
                None,
            ),
            (
                r#"limit="5" range=".""#,
                Some(1),
                Some(5),
                true,
                false,
                None,
            ),
            (
                r#"range="." limit="5""#,
                Some(5),
                Some(5),
                true,
                false,
                None,
            ),
            (r#"range="." range=".""#, Some(1), None, true, false, None),
        ] {
            let arguments = parse_list_pages_arguments(head)
                .unwrap_or_else(|| panic!("valid range sequence must parse: {head}"));

            assert_eq!(arguments.limit, expected_limit, "{head}");
            assert_eq!(
                arguments.count_pages_explicit_limit, expected_explicit_limit,
                "{head}",
            );
            assert_eq!(arguments.current_page_only, expected_current_page, "{head}");
            assert_eq!(
                arguments.exclude_current_page, expected_exclude_current,
                "{head}",
            );
            assert_eq!(arguments.relative_range, expected_relative, "{head}");
        }
    }

    #[test]
    fn list_pages_effective_argument_state_matches_live_errors_and_fallbacks() {
        for (head, has_current_page, expected) in [
            (r#"name!="missing""#, false, None),
            (r#"rating>100000"#, false, None),
            (r#"range!="others""#, false, None),
            (r#"RANGE="others""#, false, None),
            (r#"range="others" range=".""#, false, None),
            (
                r#"pagetype="all""#,
                false,
                Some("Invalid pagetype attribute."),
            ),
            (r#"pagetype="0""#, false, None),
            (r#"rating="""#, false, None),
            (r#"rating="bad" rating=">=-100000""#, false, None),
            (
                r#"rating=">=-100000" rating="bad""#,
                false,
                Some("Invalid rating argument."),
            ),
            (r#"rating=">=+0""#, false, Some("Invalid rating argument.")),
            (r#"rating=">=0.5""#, false, Some("Invalid rating argument.")),
            (r#"rating="!=999""#, false, Some("Invalid rating argument.")),
            (r#"score="bad""#, false, None),
            (r#"offset="9223372036855000063""#, false, None),
            (
                r#"offset="9223372036855000064""#,
                false,
                Some("An error occurred when processing your request."),
            ),
            (
                r#"offset="999999999999999999999999999999""#,
                false,
                Some("An error occurred when processing your request."),
            ),
        ] {
            assert_eq!(
                list_pages_non_range_argument_error(head).or_else(|| {
                    list_pages_range_argument_error(
                        head,
                        has_current_page,
                        crate::services::render::UrlArguments::default(),
                    )
                }),
                expected,
                "{head:?}",
            );
        }

        let arguments = parse_list_pages_arguments(
            r#"pagetype="hidden" page_type="normal" range="others" range=".""#,
        )
        .expect("valid effective enum arguments should parse");
        assert_eq!(arguments.page_type, PageTypeSelector::Hidden);
        assert!(arguments.current_page_only);
        assert!(!arguments.exclude_current_page);

        for value in ["0", "-1", "+1900", "1900.01.01", "1900.1.1"] {
            assert_eq!(
                parse_list_pages_date_selector(value),
                None,
                "{value:?} is a live date-selector fallback",
            );
        }
        assert!(parse_list_pages_date_selector("1900").is_some());
        assert!(parse_list_pages_date_selector("1900.01").is_some());

        for (head, unsupported) in [
            (r#"pagetype="normal""#, false),
            (r#"pagetype="0""#, false),
            (r#"pagetype="all""#, true),
            (r#"pagetype="NORMAL""#, true),
            (r#"pagetype=" normal""#, true),
            (r#"page_type="normal" pagetype="hidden""#, false),
            (r#"pagetype="hidden" page_type="bogus""#, false),
            (r#"pagetype>"bogus" page_type="normal""#, false),
        ] {
            assert_eq!(
                list_pages_has_unsupported_page_type_selector(head),
                unsupported,
                "{head:?}",
            );
        }

        let arguments = parse_list_pages_arguments(
            r#"rating=">100000" rating=">=-100000" votes=">100000" votes=">=0""#,
        )
        .expect("later rating and votes selectors replace earlier values");
        assert_eq!(arguments.score.len(), 1);
        assert_eq!(arguments.votes.len(), 1);

        assert_eq!(
            list_pages_static_parent_fullname(r#"parent="*""#),
            Some("*".to_owned()),
        );

        let arguments = parse_list_pages_arguments(
            r#"offset="+1" offset=" 1" offset="1 " perPage="00""#,
        )
        .expect("numeric lexical fallbacks should not abort ListPages");
        assert_eq!(arguments.offset, 0);
        assert_eq!(arguments.count_pages_per_page, Some(0));

        for (head, expected_prepend, expected_append) in [
            (r#"prependLine= prependLine="PRE2""#, Some("PRE2"), None),
            (r#"appendLine= appendLine="POST2""#, None, Some("POST2")),
            (r#"appendLine="POST1" appendLine="#, None, Some("POST1")),
        ] {
            let arguments = parse_list_pages_arguments(head)
                .expect("an inert empty line assignment must not consume its successor");
            assert_eq!(
                arguments.prepend_line.as_deref(),
                expected_prepend,
                "{head}"
            );
            assert_eq!(arguments.append_line.as_deref(), expected_append, "{head}");
        }
    }

    #[test]
    fn fresh_corpus_heads_do_not_invent_unsupported_runtime_selectors() {
        for head in [
            r#"name="*" category="-nav -system -forum -admin" tags="-管理 -" order="created_at desc desc" limit="1" offset="@URL|0""#,
            r#"limit="1" created_by="@URL" tags="-hub,-návod,-české,-autor""#,
            r#"category="_default" order="name desc desc" wrapper="no" separate="no" perPage="250""#,
            "separate=\"no\" tags=\"@URL\" created_at=\"@URL\" updated_at=\"@URL\" created_by=\"@URL\" rating=\"@URL\" offset=\"@URL|0\" perPage=\"1\"\u{3000}limit=\"1\" order=\"@URL|created_at desc\" category=\"*\"",
            r#"order="random" perPage="250" limit="250""#,
        ] {
            let arguments = parse_list_pages_arguments_with_url(
                head,
                crate::services::render::UrlArguments::default(),
            )
            .unwrap_or_else(|| {
                panic!("fresh anonymous Wikidot preview executed {head:?}")
            });
            assert!(
                !arguments.unsupported_author_filter
                    && !arguments.unsupported_list_pages_filter
                    && !arguments.unsupported_score_filter,
                "a live-executing corpus head must not be preserved: {head:?}",
            );
        }
    }

    #[test]
    fn list_pages_signed_and_legacy_tag_tokens_remain_literal_filters() {
        let arguments =
            parse_list_pages_arguments(r#"tags="Component;missing += -= +== -==""#)
                .expect("signed and semicolon-separated tag tokens are executable");

        assert_eq!(
            arguments.default_tags,
            vec![Cow::Borrowed("component"), Cow::Borrowed("missing")],
        );
        assert_eq!(
            arguments.all_tags,
            vec![Cow::Borrowed("="), Cow::Borrowed("==")],
        );
        assert_eq!(
            arguments.no_tags,
            vec![Cow::Borrowed("="), Cow::Borrowed("==")],
        );
        assert!(!arguments.same_visible_tags);
        assert!(!arguments.exact_visible_tags);
        assert!(!arguments.unsupported_list_pages_filter);

        let arguments = parse_list_pages_arguments(r#"tags=""component"""#)
            .expect("the evidenced doubled-quote tag recovery should execute");
        assert_eq!(arguments.default_tags, vec![Cow::Borrowed("component")]);
    }

    #[test]
    fn list_pages_category_local_names_fold_case_and_trim_source_values() {
        let arguments =
            parse_list_pages_arguments(r#"category="+Component" name=" Image?Block ""#)
                .expect("the evidenced category-local name selector should execute");

        assert_eq!(arguments.categories, vec![Cow::Borrowed("component")]);
        assert_eq!(arguments.name_pattern, Some(Cow::Borrowed("image?block")),);
        assert_eq!(arguments.slug, None);

        let arguments = parse_list_pages_arguments(r#"category="NAV" name=" Side ""#)
            .expect("an exact category-local name should execute");
        assert_eq!(arguments.categories, vec![Cow::Borrowed("nav")]);
        assert_eq!(arguments.slug, Some(Cow::Borrowed("side")));
    }

    #[test]
    fn list_pages_name_selector_resolves_exact_raw_color_markup() {
        let arguments = parse_list_pages_arguments(
            r#"fullname="@@##red|scp-series##@@" separate="yes" limit="250""#,
        )
        .expect("the exact live raw-color fullname selector should execute");

        assert_eq!(arguments.slug.as_deref(), Some("scp-series"));
        assert_eq!(arguments.name_pattern, None);

        for malformed in [
            r#"fullname="@@##red|scp-series@@" "#,
            r#"fullname="@@##redscp-series##@@" "#,
            r#"fullname="prefix@@##red|scp-series##@@" "#,
        ] {
            let arguments = parse_list_pages_arguments(malformed)
                .expect("malformed inline markup remains a static selector");
            assert_ne!(
                arguments.slug.as_deref(),
                Some("scp-series"),
                "{malformed:?}",
            );
        }
    }

    #[test]
    fn list_pages_late_selector_discriminators_preserve_effective_state() {
        for head in [
            r#"SCORE=">100000""#,
            r#"Score=">100000""#,
            r#"score=">100000""#,
        ] {
            let arguments = parse_list_pages_arguments(head)
                .expect("the impossible score alias must remain an inert token");
            assert!(arguments.score.is_empty(), "{head:?}");
        }

        let arguments = parse_list_pages_arguments(
            r#"rating="bad" rating=">=-100000" votes="bad" votes=">=0""#,
        )
        .expect("a valid final score selector must supersede an invalid predecessor");
        assert_eq!(arguments.score.len(), 1);
        assert_eq!(arguments.votes.len(), 1);

        let arguments = parse_list_pages_arguments(
            r#"name="definitely-missing-page" fullname="component:acs-animation""#,
        )
        .expect("canonical and alias name selectors compose");
        assert_eq!(arguments.slug.as_deref(), Some("definitely-missing-page"),);
        assert_eq!(
            arguments.name_pattern.as_deref(),
            Some("component:acs-animation"),
        );

        let arguments =
            parse_list_pages_arguments(r#"fullname="definitely-missing-page" name="""#)
                .expect("an empty canonical name does not erase the fullname selector");
        assert_eq!(arguments.slug.as_deref(), Some("definitely-missing-page"),);

        let arguments = parse_list_pages_arguments(r#"pagetype="@URL|normal""#)
            .expect("a static URL fallback pagetype should execute");
        assert_eq!(arguments.page_type, PageTypeSelector::Normal);

        for head in [r#"page_type="all""#, r#"page-type="all""#] {
            assert_eq!(
                list_pages_non_range_argument_error(head),
                None,
                "legacy pagetype aliases are inert rather than canonical errors",
            );
            assert_eq!(
                parse_list_pages_arguments(head)
                    .expect("the inert pagetype alias should execute")
                    .page_type,
                PageTypeSelector::Normal,
                "the inert pagetype alias must not change the effective selector",
            );
        }

        for head in [r#"offset="+1""#, r#"offset=" 1""#, r#"offset="1 ""#] {
            let arguments = parse_list_pages_arguments(head)
                .expect("invalid offset lexical forms fall back to zero");
            assert_eq!(arguments.offset, 0, "{head:?}");
        }

        assert_eq!(
            list_pages_static_parent_fullname(r#"parent="+-""#).as_deref(),
            Some("+-"),
        );
        assert_eq!(
            list_pages_static_parent_fullname(r#"parent="--""#).as_deref(),
            Some("--"),
        );
        assert_eq!(
            list_pages_static_parent_fullname(r#"parent="\"component:image-block\"""#)
                .as_deref(),
            Some(r"\"),
        );
    }

    #[test]
    fn missing_static_parent_precedes_range_but_not_non_range_errors() {
        let url = crate::services::render::UrlArguments::default();
        let missing_parent = Some("definitely-missing-listpages-parent".to_owned());
        assert_eq!(
            list_pages_argument_error_with_parent_precedence(
                r#"parent="definitely-missing-listpages-parent" range="bogus""#,
                false,
                url,
                missing_parent.clone(),
            ),
            Some(ListPagesArgumentError::MissingParent(
                "definitely-missing-listpages-parent".to_owned(),
            )),
        );
        assert_eq!(
            list_pages_argument_error_with_parent_precedence(
                r#"parent="definitely-missing-listpages-parent" pagetype="bogus""#,
                false,
                url,
                missing_parent,
            ),
            Some(ListPagesArgumentError::Message(
                "Invalid pagetype attribute.",
            )),
        );
    }
}
