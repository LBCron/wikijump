/*
 * services/render/literal_regions/list_pages_protection/css/ranges/tests.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::super::super::super::LiteralRegionIndex;
use super::{
    collect_downstream_css_module_ranges, collect_wikidot_unclosed_css_yield_openers,
};

#[test]
fn wikidot_unclosed_css_yields_to_a_complete_root_list_pages_module() {
    let source = concat!(
        "[[module CSS]]\n\n",
        "[[module ListPages name=\"=\"]]\n",
        "%%title%%\n",
        "[[/module]]",
    );
    let list_pages = source.find("[[module ListPages").unwrap();

    // Anonymous Wikidot PagePreview emits an empty ListPages wrapper for this
    // shape. The provenance-backed raw HTML SHA-256 is
    // b3e8cc0484ab7b9d9291bad408d2668491e4d052edfe91e320e205cb3d31418c.
    assert!(collect_downstream_css_module_ranges(source).is_empty());
    assert_eq!(
        collect_wikidot_unclosed_css_yield_openers(source),
        vec![0.."[[module CSS]]".len()],
    );
    assert!(!LiteralRegionIndex::new_list_pages_syntax(source).contains(list_pages));
}

#[test]
fn wikidot_unclosed_css_yields_to_multiple_complete_list_pages_modules() {
    let source = concat!(
        "[[module CSS]]\n",
        "[[module ListPages name=\"missing-one\"]]\n",
        "ONE\n",
        "[[/module]]\n",
        "[[module ListPages name=\"missing-two\"]]\n",
        "TWO\n",
        "[[/module]]",
    );

    // Anonymous Wikidot PagePreview emits two ListPages wrappers. The
    // provenance-backed raw HTML SHA-256 is
    // 48a80a2dd6ca8c27d1813e82ed7e0f9a1700214d34095cb81fdefda88344365f.
    assert!(collect_downstream_css_module_ranges(source).is_empty());
    let index = LiteralRegionIndex::new_list_pages_syntax(source);
    assert!(!index.contains(source.find("missing-one").unwrap()));
    assert!(!index.contains(source.find("missing-two").unwrap()));
}

#[test]
fn wikidot_closed_css_keeps_complete_list_pages_markers_raw() {
    let source = concat!(
        "[[module CSS]]\n",
        "[[module ListPages name=\"missing-one\"]]\n",
        "ONE\n",
        "[[/module]]\n",
        "[[module ListPages name=\"missing-two\"]]\n",
        "TWO\n",
        "[[/module]]\n",
        "[[/module]]",
    );

    // Adding the true outer close makes the matching anonymous Wikidot
    // PagePreview empty. Its raw HTML SHA-256 is
    // 545c38b0922de19734fbffde62792c37c2aef6a3216cfa472449173165220f7d.
    assert_eq!(
        collect_downstream_css_module_ranges(source),
        vec![0..source.len()],
    );
    assert!(collect_wikidot_unclosed_css_yield_openers(source).is_empty());
    let index = LiteralRegionIndex::new_list_pages_syntax(source);
    assert!(index.contains(source.find("missing-one").unwrap()));
    assert!(index.contains(source.find("missing-two").unwrap()));
}

const MISSING_LIST_PAGES: &str = "[[module ListPages name=\"missing-x\"]]";

#[test]
fn wikidot_css_consumes_list_pages_heads_whose_whitespace_body_leaves_the_close_raw() {
    // A ListPages body that is only whitespace leaves its close as text, so
    // the CSS module owns that close (wikidot-css-listpages-preview-20261019.json,
    // all five render only the trailing `z`, or nothing).
    let head = MISSING_LIST_PAGES;
    for (case, source) in [
        (
            "css-empty-body-no-tail",
            format!("[[module CSS]]\n{head}\n[[/module]]"),
        ),
        (
            "css-blank-line-body-tail",
            format!("[[module CSS]]\n{head}\n\n[[/module]]\n\nz"),
        ),
        (
            "css-space-line-body-tail",
            format!("[[module CSS]]\n{head}\n \n[[/module]]\n\nz"),
        ),
        (
            "css-head-trailing-space-empty-body",
            format!("[[module CSS]]\n{head} \n[[/module]]\n\nz"),
        ),
        (
            "css-rule-then-empty-body",
            format!("[[module CSS]]\n.a{{color:red}}\n{head}\n[[/module]]\n\nz"),
        ),
    ] {
        let close_end = source.find("[[/module]]").unwrap() + "[[/module]]".len();

        assert_eq!(
            collect_downstream_css_module_ranges(&source),
            vec![0..close_end],
            "{case}",
        );
        assert!(
            collect_wikidot_unclosed_css_yield_openers(&source).is_empty(),
            "{case}",
        );
        assert!(
            LiteralRegionIndex::new_list_pages_syntax(&source)
                .contains(source.find(head).unwrap()),
            "{case}",
        );
    }
}

#[test]
fn wikidot_css_yields_to_list_pages_with_a_body_or_an_inline_close() {
    // Both render an empty list-pages-box before `z`
    // (wikidot-css-listpages-preview-20261019.json).
    let head = MISSING_LIST_PAGES;
    for (case, source) in [
        (
            "css-nonempty-body-tail",
            format!("[[module CSS]]\n{head}\nONE\n[[/module]]\n\nz"),
        ),
        (
            "css-inline-close-tail",
            format!("[[module CSS]]\n{head}[[/module]]\n\nz"),
        ),
    ] {
        assert!(
            collect_downstream_css_module_ranges(&source).is_empty(),
            "{case}",
        );
        assert!(
            !LiteralRegionIndex::new_list_pages_syntax(&source)
                .contains(source.find(head).unwrap()),
            "{case}",
        );
    }
}

#[test]
fn wikidot_css_closed_by_a_raw_list_pages_close_leaves_the_next_list_pages_live() {
    let head = MISSING_LIST_PAGES;
    let source =
        format!("[[module CSS]]\n{head}\n[[/module]]\n{head}\nTWO\n[[/module]]\n\nz");
    let first_close_end = source.find("[[/module]]").unwrap() + "[[/module]]".len();
    let index = LiteralRegionIndex::new_list_pages_syntax(&source);

    assert_eq!(
        collect_downstream_css_module_ranges(&source),
        vec![0..first_close_end],
    );
    assert!(index.contains(source.find(head).unwrap()));
    assert!(!index.contains(source.rfind(head).unwrap()));
}

#[test]
fn wikidot_unclosed_css_yields_across_a_css_comment_and_malformed_head() {
    for (source, live_sha256) in [
        (
            concat!(
                "[[module CSS]]\n",
                "/*\n",
                "[[module ListPages name=\"=\"]]\n",
                "*/\n",
                "[[/module]]",
            ),
            "1c6db6ed75b7c27d758433d4a7157af459157d4e183c342997bef5366d093853",
        ),
        (
            concat!(
                "[[module CSS]]\n",
                "[[module ListPages name=\"=\n",
                "%%title%%\n",
                "[[/module]]",
            ),
            "5884e46ecf111e5e587c9cd0a911fa7bbeefd31b1a9f74021c14141a71f8d1fd",
        ),
    ] {
        assert!(
            collect_downstream_css_module_ranges(source).is_empty(),
            "{live_sha256}: {source:?}",
        );
        assert!(
            {
                let index = LiteralRegionIndex::new_list_pages_scanner_syntax(source)
                    .expect("fixture should stay within the scanner work budget");
                !index.contains(source.find("[[module ListPages").unwrap())
            },
            "{live_sha256}: {source:?}: {:?}",
            LiteralRegionIndex::new_list_pages_scanner_syntax(source)
                .expect("fixture should stay within the scanner work budget")
                .ranges,
        );
    }
}

#[test]
fn wikidot_inline_css_keeps_nested_list_pages_markers_raw() {
    let source = "[[module CSS]][[module ListPages name=\"=\"]]%%title%%[[/module]]";
    let list_pages = source.find("[[module ListPages").unwrap();

    // Same-line module ownership remains a fail-closed nonexecution boundary
    // pending the broader exact-literal work in FTML issue #330.
    assert_eq!(
        collect_downstream_css_module_ranges(source),
        vec![0..source.len()],
    );
    assert!(collect_wikidot_unclosed_css_yield_openers(source).is_empty());
    assert!(LiteralRegionIndex::new_list_pages_syntax(source).contains(list_pages));
}

#[test]
fn wikidot_unclosed_css_does_not_recover_list_pages_heads_in_literal_contexts() {
    for source in [
        concat!(
            "[[module CSS]]\n",
            "[!--\n",
            "[[module ListPages name=\"comment\"]]\n",
            "[[/module]]\n",
            "--]",
        ),
        concat!(
            "[[module CSS]]\n",
            "[[code]]\n",
            "[[module ListPages name=\"code\"]]\n",
            "[[/module]]\n",
            "[[/code]]",
        ),
        concat!(
            "[[module CSS]]\n",
            "[[html]]\n",
            "[[module ListPages name=\"html\"]]\n",
            "[[/module]]\n",
            "[[/html]]",
        ),
        concat!(
            "[[module CSS]]\n",
            "[[raw]]\n",
            "[[module ListPages name=\"raw\"]]\n",
            "[[/module]]\n",
            "[[/raw]]",
        ),
        concat!(
            "[[module CSS]]\n",
            "\\[[module ListPages name=\"escaped\"]]\n",
            "[[/module]]",
        ),
    ] {
        let list_pages = source.find("[[module ListPages").unwrap();
        let close_end = source.find("[[/module]]").unwrap() + "[[/module]]".len();
        let ranges = collect_downstream_css_module_ranges(source);

        assert_eq!(ranges, vec![0..close_end], "{source:?}");
        assert!(ranges[0].contains(&list_pages), "{source:?}");
    }
}

#[test]
fn wikidot_unclosed_css_stops_before_list_pages_after_a_root_tab_close() {
    let source = concat!(
        "[[module CSS]]\n",
        "[[tabview]]\n",
        "[[tab first]]\n",
        "FIRST\n",
        "[[/tab]]\n",
        "[[tab second]]\n",
        "[[module ListPages name=\"owned\"]]BODY\n",
        "[[/module]]",
    );
    let list_pages = source.find("[[module ListPages").unwrap();

    // Three exact-source literal replays (CN, JP, and KO translations of the
    // same hub) have empty anonymous Wikidot output when a completed root tab
    // precedes the ListPages head. Their source SHA-256 values are
    // c48edee0c7d5e0d7e35d35c28d00148b1097b0a88206a355952de6a9cdff8437,
    // d9c089fd53d7c95f6b71c9d79f2583e05e63025630247d45dd1be2b5d2491f52,
    // and 809311718037764d189b63533687b8a79052ebae37b8e988e0ffa35f41d35cde.
    assert_eq!(
        collect_downstream_css_module_ranges(source),
        vec![0..source.len()],
    );
    assert!(
        LiteralRegionIndex::new_list_pages_scanner_syntax(source)
            .expect("fixture should stay within the scanner work budget")
            .contains(list_pages)
    );
}

#[test]
fn tight_quote_css_uses_original_downstream_ownership() {
    let source = concat!(
        ">[[module CSS]]\n",
        "[[module ListPages name=\"hidden\"]]B\n",
        "[[/module]]\n",
        "[[module ListPages name=\"live\"]]C[[/module]]",
    );

    assert_css_range_owns_hidden_only(source);
}

#[test]
fn unicode_casefolded_css_uses_the_downstream_regex_contract() {
    let source = concat!(
        "[[module CſS]]\n",
        "[[module ListPages name=\"hidden\"]]B\n",
        "[[/module]]\n",
        "[[module ListPages name=\"live\"]]C[[/module]]",
    );

    assert_css_range_owns_hidden_only(source);
}

#[test]
fn projection_created_quotes_do_not_erase_original_css_ownership() {
    for prefix in ["> \\\n", ">\0"] {
        let source = format!(
            "{prefix}[[module CSS]]\n\
             [[module ListPages name=\"hidden\"]]B\n\
             [[/module]]\n\
             [[module ListPages name=\"live\"]]C[[/module]]",
        );

        assert_css_range_owns_hidden_only(&source);
    }
}

#[test]
fn pinned_css_heads_with_quoted_brackets_and_spacing_own_runtime_modules() {
    for opener in [
        r#"[[module CSS note="x]y"]]"#,
        "[[ module CSS]]",
        "[[module654 CSS]]",
    ] {
        let source = format!(
            "{opener}\n\
             [[module ListPages name=\"hidden-list\"]]X\n\
             [[module CountPages category=\"hidden-count\"]]\n\
             [[/module]]\n\
             [[module ListPages name=\"live\"]]C[[/module]]",
        );
        assert_runtime_modules_are_owned_until_live(&source);
    }
}

#[test]
fn pinned_css_closer_variants_own_runtime_modules() {
    for closer in ["[[/ module]]"] {
        let source = format!(
            "[[module CSS]]\n\
             [[module ListPages name=\"hidden-list\"]]X\n\
             [[module CountPages category=\"hidden-count\"]]\n\
             {closer}\n\
             [[module ListPages name=\"live\"]]C",
        );
        assert_runtime_modules_are_owned_until_live(&source);
    }

    for closer in [
        "[[/module ]]",
        "[[/module654]]",
        "[[/[[module]]",
        "[[/ [[ module]]",
    ] {
        let source = format!(
            "[[module CSS]]\n\
             [[module ListPages name=\"hidden-list\"]]X\n\
             [[module CountPages category=\"hidden-count\"]]\n\
             {closer}\n\
             [[module ListPages name=\"live\"]]C",
        );
        assert_runtime_modules_remain_live(&source);
    }
}

#[test]
fn downstream_regex_closers_keep_the_legacy_literal_mask() {
    let source = concat!(
        "[[module CſS]]\n",
        "[!-- [[/module]] --]\n",
        "@@[[/module]]@@\n",
        "[[module ListPages name=\"hidden-list\"]]X\n",
        "[[module CountPages category=\"hidden-count\"]]\n",
        "[[/module]]\n",
        "[[module ListPages name=\"live\"]]C",
    );

    assert_runtime_modules_are_owned_until_live(source);
}

#[test]
fn pinned_css_closers_reject_right_link_false_closers() {
    let source = concat!(
        "[[ module CSS]]\n",
        "[[/module]]]\n",
        "[[module ListPages name=\"hidden-list\"]]X\n",
        "[[module CountPages category=\"hidden-count\"]]\n",
        "[[/module654]]\n",
        "[[module ListPages name=\"live\"]]C",
    );

    assert_runtime_modules_remain_live(source);
}

#[test]
fn pinned_css_raw_body_closes_on_context_free_tokens_without_a_later_close() {
    for context in [
        "[!-- [[/module]] --]",
        "@@[[/module]]@@",
        "[[$ [[/module]] $]]",
        "[[span value=\"[[/module]]\"]]",
    ] {
        let source = format!(
            "[[ module CSS]]\n\
             [[module CountPages tags=\"+owned-count\"]]H\n\
             [[module ListPages name=\"owned-list\"]]H\n\
             {context}\n\
             [[module CountPages tags=\"+live-count\"]]H\n\
             [[module ListPages name=\"live-list\"]]H",
        );
        let ranges = collect_downstream_css_module_ranges(&source);
        let index = LiteralRegionIndex::new_list_pages_syntax(&source);
        let close_end = source.find("[[/module]]").unwrap() + "[[/module]]".len();

        assert_eq!(ranges, vec![0..close_end], "{context:?}");
        assert!(
            ranges[0].contains(&source.find("owned-count").unwrap()),
            "{context:?}"
        );
        assert!(
            ranges[0].contains(&source.find("owned-list").unwrap()),
            "{context:?}"
        );
        assert!(
            !ranges[0].contains(&source.find("live-count").unwrap()),
            "{context:?}"
        );
        assert!(
            !ranges[0].contains(&source.find("live-list").unwrap()),
            "{context:?}"
        );
        assert!(
            index.contains(source.find("owned-count").unwrap()),
            "{context:?}"
        );
        assert!(
            index.contains(source.find("owned-list").unwrap()),
            "{context:?}"
        );
        assert!(
            !index.contains(source.find("live-count").unwrap()),
            "{context:?}"
        );
        assert!(
            !index.contains(source.find("live-list").unwrap()),
            "{context:?}"
        );
    }
}

#[test]
fn pinned_css_comment_close_owns_the_preceding_count_pages_opener() {
    let source = concat!(
        "[[ module CSS]]\n",
        "[[module CountPages tags=\"+x\"]]H\n",
        "[!-- [[/module]] --]",
    );
    let ranges = collect_downstream_css_module_ranges(source);
    let index = LiteralRegionIndex::new_list_pages_syntax(source);
    let count_start = source.find("[[module CountPages").unwrap();
    let close_end = source.find("[[/module]]").unwrap() + "[[/module]]".len();

    assert_eq!(ranges, vec![0..close_end]);
    assert!(ranges[0].contains(&count_start));
    assert!(index.contains(count_start));
}

#[test]
fn pinned_css_closer_line_break_matrix_matches_block_name_consumption() {
    for closer in [
        "[[/module\n]]",
        "[[/module\r]]",
        "[[/module\r\n]]",
        "[[/module\n\n]]",
        "[[/module\n \t]]",
        "[[/module\u{00a0}\n]]",
        "[[/module\u{000b}\n]]",
        "[[/module\u{000c}\n]]",
        "[[/[[module\r\n\t ]]",
    ] {
        let source = format!(
            "[[module CSS]]\n\
             [[module ListPages name=\"owned\"]]X\n\
             {closer}\n\
             [[module ListPages name=\"live\"]]Y",
        );
        let index = LiteralRegionIndex::new_list_pages_syntax(&source);
        assert!(!index.contains(source.find("owned").unwrap()), "{source:?}");
        assert!(!index.contains(source.find("live").unwrap()), "{source:?}");
    }

    for false_closer in ["[[/module \n]]", "[[/module\t\r\n]]"] {
        let source = format!(
            "[[module CSS]]\n\
             {false_closer}\n\
             [[module ListPages name=\"owned\"]]X\n\
             [[/module]]\n\
             [[module ListPages name=\"live\"]]Y[[/module]]",
        );
        let index = LiteralRegionIndex::new_list_pages_syntax(&source);
        assert!(index.contains(source.find("owned").unwrap()), "{source:?}");
        assert!(!index.contains(source.find("live").unwrap()), "{source:?}");
    }
}

#[test]
fn same_start_regex_and_pinned_ranges_are_unioned_in_both_directions() {
    let regex_extends_farther = concat!(
        "[[module CSS]]\n",
        "[[/ module]]\n",
        "[[module ListPages name=\"owned\"]]X[[/module]]\n",
        "[[module ListPages name=\"live\"]]Y[[/module]]",
    );
    assert_css_range_owns_named_module_only(regex_extends_farther, "owned", "live");

    let pinned_extends_farther = concat!(
        "[[module CSS]]\n",
        "[[/module]]]\n",
        "[[module ListPages name=\"owned\"]]X\n",
        "[[/ module]]\n",
        "[[module ListPages name=\"live\"]]Y[[/module]]",
    );
    assert_css_range_owns_named_module_only(pinned_extends_farther, "owned", "live");
}

#[test]
fn cross_path_overlaps_are_unioned_without_skipping_inner_openers() {
    let pinned_inner_extends_farther = concat!(
        "[[module CſS]]\n",
        "[[ module CSS]]\n",
        "[[/module]]]\n",
        "[[module ListPages name=\"owned\"]]X\n",
        "[[/ module]]\n",
        "[[module ListPages name=\"live\"]]Y[[/module]]",
    );
    assert_css_range_owns_named_module_only(
        pinned_inner_extends_farther,
        "owned",
        "live",
    );

    let regex_inner_extends_farther = concat!(
        "[[ module CSS]]\n",
        "[[module CſS]]\n",
        "[[/ module]]\n",
        "[[module ListPages name=\"owned\"]]X\n",
        "[[/module]]\n",
        "[[module ListPages name=\"live\"]]Y[[/module]]",
    );
    assert_css_range_owns_named_module_only(regex_inner_extends_farther, "owned", "live");
}

#[test]
fn malformed_quoted_css_head_resurrects_inner_css_in_actual_ranges() {
    for suffix in ["", "\n"] {
        let source = format!(
            "[[ module CSS note=\"unterminated [[ module CSS]][[module CountPages]][[/module]]{suffix}",
        );
        let inner_start = source.rfind("[[ module CSS]]").unwrap();
        let count_start = source.find("[[module CountPages]]").unwrap();
        let close_end = source.find("[[/module]]").unwrap() + "[[/module]]".len();
        assert_eq!(
            collect_downstream_css_module_ranges(&source),
            vec![inner_start..close_end],
            "{suffix:?}",
        );
        assert!(
            LiteralRegionIndex::new_list_pages_syntax(&source).contains(count_start),
            "{suffix:?}",
        );
    }
}

#[test]
fn dense_divergent_same_start_ranges_use_independent_forward_passes() {
    const PAIRS: usize = 2_048;
    let pair = concat!(
        "[[module CSS]][[/ module]]x[[/module]]",
        "[[module CSS]][[/module]]]x[[/ module]]",
    );
    let source = pair.repeat(PAIRS);
    let ranges = collect_downstream_css_module_ranges(&source);

    assert_eq!(ranges, vec![0..source.len()]);
}

#[test]
fn dense_malformed_email_heads_preserve_forward_token_cursor_progress() {
    const HEADS: usize = 4_096;
    let mut source = "a@b.example [[module CSS x=y\n".repeat(HEADS);
    let live_start = source.len();
    source.push_str("[[ module CSS note=\"x]y\"]]x[[/module]]");
    let ranges = collect_downstream_css_module_ranges(&source);

    assert_eq!(ranges, vec![live_start..source.len()]);
}

#[test]
fn dense_native_quote_checks_are_monotone() {
    const QUOTED: usize = 4_096;
    let mut source = "> [[ module CSS]]\n".repeat(QUOTED);
    let live_start = source.len();
    source.push_str("[[ module CSS]]x[[/module]]");
    let ranges = collect_downstream_css_module_ranges(&source);

    assert_eq!(ranges, vec![live_start..source.len()]);
}

#[test]
fn downstream_css_union_keeps_non_extracted_boundaries_live() {
    for opener in [
        "> [[module CSS]]",
        "[[moduleCſS]]",
        "[[module CſX]]",
        "@@[[module CſS]]@@",
    ] {
        let source = format!("{opener}\n[[module ListPages name=\"live\"]]C[[/module]]",);
        let index = LiteralRegionIndex::new_list_pages_syntax(&source);

        assert!(
            !index.contains(source.find("[[module ListPages").unwrap()),
            "{opener:?}: {:?}",
            index.ranges,
        );
    }
}

fn assert_css_range_owns_hidden_only(source: &str) {
    let index = LiteralRegionIndex::new_list_pages_syntax(source);

    assert!(index.contains(source.find("hidden").unwrap()), "{source:?}");
    assert!(!index.contains(source.find("live").unwrap()), "{source:?}");
    assert!(
        index
            .ranges
            .windows(2)
            .all(|pair| pair[0].end < pair[1].start),
        "{source:?}",
    );
}

fn assert_runtime_modules_are_owned_until_live(source: &str) {
    let index = LiteralRegionIndex::new_list_pages_syntax(source);

    assert!(
        index.contains(source.find("hidden-list").unwrap()),
        "{source:?}"
    );
    assert!(
        index.contains(source.find("hidden-count").unwrap()),
        "{source:?}"
    );
    assert!(
        !index.contains(source.find("name=\"live\"").unwrap()),
        "{source:?}"
    );
}

fn assert_runtime_modules_remain_live(source: &str) {
    let index = LiteralRegionIndex::new_list_pages_syntax(source);

    assert!(
        !index.contains(source.find("hidden-list").unwrap()),
        "{source:?}"
    );
    assert!(
        !index.contains(source.find("hidden-count").unwrap()),
        "{source:?}"
    );
    assert!(
        !index.contains(source.find("name=\"live\"").unwrap()),
        "{source:?}"
    );
}

fn assert_css_range_owns_named_module_only(source: &str, owned: &str, live: &str) {
    let index = LiteralRegionIndex::new_list_pages_syntax(source);

    assert!(index.contains(source.find(owned).unwrap()), "{source:?}");
    assert!(!index.contains(source.find(live).unwrap()), "{source:?}");
}

#[test]
fn raw_markers_on_their_own_lines_do_not_change_css_module_recognition() {
    // Wikidot's `@@` never spans lines, so a CSS module whose body holds lone
    // `@@` lines is recognized exactly like the same module without them
    // (`css-module-lone-at-lines-listpages` and `css-module-no-at-listpages` in
    // wikidot-at-raw-preview-20261019.json).
    let with_raw =
        "[[module CSS]]\n@@\n[[module ListPages name=\"inline-raw\"]]\n[[/module]]\n@@";
    let without_raw =
        "[[module CSS]]\n[[module ListPages name=\"inline-raw\"]]\n[[/module]]";

    assert_eq!(
        collect_downstream_css_module_ranges(with_raw).is_empty(),
        collect_downstream_css_module_ranges(without_raw).is_empty(),
    );
}
