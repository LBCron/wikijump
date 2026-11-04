/*
 * utils/slug.rs
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

use crate::utils::replace_in_place;
use wikidot_normalize::normalize;

pub fn normalize_slug_without_category_separator<S: Into<String>>(name: S) -> String {
    let mut slug = name.into();
    replace_in_place(&mut slug, ":", "-");
    normalize(&mut slug);
    slug
}

pub fn normalize_page_slug<S: Into<String>>(name: S) -> String {
    let mut slug = name.into();
    normalize(&mut slug);
    slug
}

const CONFUSABLE_SKELETON_MAP: &[(char, char)] = &[
    // Cyrillic lookalikes
    ('\u{430}', 'a'),
    ('\u{435}', 'e'),
    ('\u{43E}', 'o'),
    ('\u{440}', 'p'),
    ('\u{441}', 'c'),
    ('\u{443}', 'y'),
    ('\u{445}', 'x'),
    ('\u{456}', 'i'),
    ('\u{458}', 'j'),
    ('\u{455}', 's'),
    ('\u{4BB}', 'h'),
    ('\u{43C}', 'm'),
    ('\u{442}', 't'),
    ('\u{43A}', 'k'),
    ('\u{501}', 'd'),
    ('\u{50D}', 'g'),
    ('\u{51B}', 'q'),
    ('\u{51D}', 'w'),
    // Greek lookalikes
    ('\u{3B1}', 'a'),
    ('\u{3B2}', 'b'),
    ('\u{3B5}', 'e'),
    ('\u{3B7}', 'n'),
    ('\u{3B9}', 'i'),
    ('\u{3BA}', 'k'),
    ('\u{3BC}', 'u'),
    ('\u{3BD}', 'v'),
    ('\u{3BF}', 'o'),
    ('\u{3C0}', 'n'),
    ('\u{3C1}', 'p'),
    ('\u{3C4}', 't'),
    ('\u{3C5}', 'u'),
    ('\u{3C7}', 'x'),
    ('\u{3C9}', 'w'),
];

pub fn confusable_skeleton(value: &str) -> String {
    let mut skeleton = String::with_capacity(value.len());
    for ch in value.chars().flat_map(char::to_lowercase) {
        let mapped = CONFUSABLE_SKELETON_MAP
            .iter()
            .find_map(|&(lookalike, latin)| (lookalike == ch).then_some(latin))
            .unwrap_or(ch);
        skeleton.push(mapped);
    }
    skeleton
}

#[test]
fn confusable_skeleton_maps_cyrillic_and_greek_lookalikes() {
    assert_eq!(confusable_skeleton("sectest-\u{435}ve"), "sectest-eve");
    assert_eq!(confusable_skeleton("sectest-\u{415}ve"), "sectest-eve");
    assert_eq!(confusable_skeleton("\u{3B1}\u{3C1}\u{3C4}"), "apt");
    assert_eq!(confusable_skeleton("\u{440}\u{430}\u{441}"), "pac");
}

#[test]
fn confusable_skeleton_leaves_other_characters_alone() {
    assert_eq!(confusable_skeleton("plain-name_1"), "plain-name_1");
    assert_eq!(confusable_skeleton("PLAIN"), "plain");
    assert_eq!(confusable_skeleton("\u{434}mitry"), "\u{434}mitry");
    assert_eq!(confusable_skeleton(""), "");
}

/// Resolve only the page URL aliases observed in Wikidot's public router.
///
/// This intentionally does not use `normalize_page_slug`: that function also
/// applies Unicode compatibility normalization and rewrites arbitrary
/// punctuation, which is too broad for resolving an incoming URL to stored
/// content. The caller checks for an exact stored slug first, then looks up
/// this alias and applies the resolved page's normal permission checks.
/// Source authority: SCP-Wiki anonymous HTTP observations documented in #2168.
pub fn observed_wikidot_page_url_alias(slug: &str) -> Option<String> {
    if slug.is_empty() || !slug.is_ascii() {
        return None;
    }

    // Wikidot also accepts a *single trailing tab* after a page slug. Do
    // not apply generic control-character trimming to incoming routes; an
    // interior tab, CR/LF or a second trailing tab has no verified alias
    // behavior and must remain unresolved.
    let (without_tab, trailing_tab) = if let Some(without_tab) = slug.strip_suffix('\t') {
        if without_tab.contains('\t') || without_tab.ends_with([' ', '.', '_', '-']) {
            return None;
        }
        (without_tab, true)
    } else {
        if slug.contains('\t') {
            return None;
        }
        (slug, false)
    };
    let input = without_tab
        .trim_end_matches([' ', '.'])
        .to_ascii_lowercase();
    if input.is_empty() {
        return None;
    }
    if matches!(
        input.as_str(),
        "forum" | "local--files" | "local--code" | "_admin"
    ) {
        return None;
    }

    let chars: Vec<_> = input.chars().collect();
    let mut colon_count = 0;
    let mut canonical = String::with_capacity(input.len());
    let mut at_segment_start = true;
    let mut observed_punctuation_aliases = usize::from(trailing_tab);
    let mut index = 0;
    while index < chars.len() {
        let ch = chars[index];
        match ch {
            ':' => {
                colon_count += 1;
                at_segment_start = true;
                canonical.push(ch);
            }
            'a'..='z' | '0'..='9' => {
                canonical.push(ch);
                at_segment_start = false;
            }
            '-' => {
                let run_end = chars[index..]
                    .iter()
                    .position(|next| *next != '-')
                    .map_or(chars.len(), |offset| index + offset);
                let run_length = run_end - index;

                // Source HTTP observations confirm internal two- and three-
                // hyphen runs and one trailing hyphen. Longer, leading, and
                // trailing repeated runs remain unresolved.
                if at_segment_start
                    || run_length > 3
                    || (run_length > 1 && run_end == chars.len())
                    || (run_length > 1
                        && !matches!(chars.get(run_end), Some('a'..='z' | '0'..='9')))
                {
                    return None;
                }

                if run_length > 1 {
                    observed_punctuation_aliases += 1;
                }

                canonical.push('-');
                at_segment_start = false;
                index = run_end - 1;
            }
            '+' | '.' => {
                if at_segment_start
                    || canonical.ends_with('-')
                    || !matches!(chars.get(index + 1), Some('a'..='z' | '0'..='9'))
                {
                    return None;
                }
                observed_punctuation_aliases += 1;
                canonical.push('-');
                at_segment_start = false;
            }
            '_' => {
                // A final underscore was independently observed to behave
                // like a final hyphen. Keep leading underscores, used by
                // hidden pages, and internal underscores distinct.
                if index + 1 == chars.len()
                    && !at_segment_start
                    && matches!(
                        chars.get(index.wrapping_sub(1)),
                        Some('a'..='z' | '0'..='9')
                    )
                {
                    observed_punctuation_aliases += 1;
                } else if index + 1 == chars.len() && !at_segment_start {
                    return None;
                } else {
                    canonical.push(if at_segment_start { '_' } else { '-' });
                }
                at_segment_start = false;
            }
            ' ' => {
                // Only one internal ASCII space between ordinary slug
                // segments is observed. Do not normalize general whitespace.
                if at_segment_start
                    || !matches!(chars.get(index + 1), Some('a'..='z' | '0'..='9'))
                {
                    return None;
                }
                observed_punctuation_aliases += 1;
                canonical.push('-');
                at_segment_start = false;
            }
            _ => return None,
        }
        if colon_count > 1 {
            return None;
        }
        index += 1;
    }

    // A single trailing hyphen was observed to resolve to the unhyphenated
    // page slug. Do not trim a longer run (rejected above).
    if canonical.ends_with('-') && input.ends_with('-') {
        observed_punctuation_aliases += 1;
        canonical.pop();
    }

    if observed_punctuation_aliases > 1 {
        return None;
    }

    if matches!(
        canonical.as_str(),
        "forum" | "local--files" | "local--code" | "_admin"
    ) {
        return None;
    }

    if canonical != slug {
        Some(canonical)
    } else {
        None
    }
}

#[test]
fn regular_slug_replaces_category_separator() {
    assert_eq!(
        normalize_slug_without_category_separator("forum:staff"),
        "forum-staff"
    );
}

#[test]
fn page_slug_preserves_category_separator() {
    assert_eq!(normalize_page_slug("forum:staff"), "forum:staff");
}

#[test]
fn slug_normalization_handles_case_and_spacing() {
    assert_eq!(
        normalize_slug_without_category_separator("  Mixed Case  "),
        "mixed-case"
    );
    assert_eq!(normalize_page_slug("  Mixed Case  "), "mixed-case");
}

#[test]
fn observed_page_url_aliases_are_narrow_and_category_aware() {
    assert_eq!(
        observed_wikidot_page_url_alias("SCP-9506"),
        Some("scp-9506".to_owned())
    );
    assert_eq!(
        observed_wikidot_page_url_alias("scp_9506"),
        Some("scp-9506".to_owned())
    );
    assert_eq!(
        observed_wikidot_page_url_alias("scp-9506."),
        Some("scp-9506".to_owned())
    );
    assert_eq!(
        observed_wikidot_page_url_alias("scp+9506"),
        Some("scp-9506".to_owned())
    );
    assert_eq!(
        observed_wikidot_page_url_alias("scp.9506"),
        Some("scp-9506".to_owned())
    );
    assert_eq!(
        observed_wikidot_page_url_alias("scp--9506"),
        Some("scp-9506".to_owned())
    );
    assert_eq!(
        observed_wikidot_page_url_alias("scp-9506-"),
        Some("scp-9506".to_owned())
    );
    assert_eq!(
        observed_wikidot_page_url_alias("scp-9506 "),
        Some("scp-9506".to_owned())
    );
    assert_eq!(
        observed_wikidot_page_url_alias("scp---9506"),
        Some("scp-9506".to_owned())
    );
    assert_eq!(
        observed_wikidot_page_url_alias("scp-9506_"),
        Some("scp-9506".to_owned())
    );
    assert_eq!(
        observed_wikidot_page_url_alias("scp 9506"),
        Some("scp-9506".to_owned())
    );
    assert_eq!(
        observed_wikidot_page_url_alias("scp-9506\t"),
        Some("scp-9506".to_owned())
    );
    assert_eq!(
        observed_wikidot_page_url_alias("SYSTEM:JOIN"),
        Some("system:join".to_owned())
    );
    assert_eq!(
        observed_wikidot_page_url_alias("_TEMPLATE"),
        Some("_template".to_owned())
    );
    assert_eq!(observed_wikidot_page_url_alias("scp----9506"), None);
    assert_eq!(observed_wikidot_page_url_alias("-scp-9506"), None);
    assert_eq!(observed_wikidot_page_url_alias("scp-9506--"), None);
    assert_eq!(observed_wikidot_page_url_alias("scp-.9506"), None);
    assert_eq!(observed_wikidot_page_url_alias("scp+9506-"), None);
    assert_eq!(observed_wikidot_page_url_alias("scp-9506__"), None);
    assert_eq!(observed_wikidot_page_url_alias("scp-9506_\t"), None);
    assert_eq!(observed_wikidot_page_url_alias("scp-9506\t\t"), None);
    assert_eq!(observed_wikidot_page_url_alias("scp+9506\t"), None);
    assert_eq!(observed_wikidot_page_url_alias("scp-\t9506"), None);
    assert_eq!(observed_wikidot_page_url_alias("scp  9506"), None);
    assert_eq!(observed_wikidot_page_url_alias("scp-9506\r"), None);
    assert_eq!(observed_wikidot_page_url_alias("scp-9506\n"), None);
    assert_eq!(observed_wikidot_page_url_alias("scp---9506_"), None);
    assert_eq!(observed_wikidot_page_url_alias("local--files"), None);
    assert_eq!(observed_wikidot_page_url_alias("local--code"), None);
    assert_eq!(observed_wikidot_page_url_alias("local++files"), None);
    assert_eq!(observed_wikidot_page_url_alias("_ADMIN"), None);
    assert_eq!(observed_wikidot_page_url_alias("_admin."), None);
    assert_eq!(observed_wikidot_page_url_alias("_admin_"), None);
    assert_eq!(observed_wikidot_page_url_alias("_admin\t"), None);
    assert_eq!(observed_wikidot_page_url_alias("scp/%2fadmin"), None);
    assert_eq!(observed_wikidot_page_url_alias("ѕср-9506"), None);
}

#[test]
fn observed_page_url_aliases_preserve_category_and_reject_route_boundaries() {
    assert_eq!(
        observed_wikidot_page_url_alias("component:some---page"),
        Some("component:some-page".to_owned())
    );
    assert_eq!(
        observed_wikidot_page_url_alias("component:some page"),
        Some("component:some-page".to_owned())
    );
    assert_eq!(
        observed_wikidot_page_url_alias("component:some_page"),
        Some("component:some-page".to_owned())
    );
    for unsupported in [
        "component::page",
        "/scp-9506",
        "scp-9506/test",
        "scp-9506%2Fadmin",
        "scp-9506%09",
        "scp-9506?view=source",
        "scp-9506#anchor",
        "scp-9506\\admin",
        "scp---9506-",
        "scp----9506",
        "scp  9506",
        "scp\t9506",
        "scp-9506\0",
        "_admin-",
    ] {
        assert_eq!(
            observed_wikidot_page_url_alias(unsupported),
            None,
            "unexpected page alias for {unsupported:?}"
        );
    }
}
