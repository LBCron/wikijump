/*
 * services/render/include_comment_branches.rs
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

use super::compat::text_fragments::CompatTextFragments;

const UNRESOLVED_BRANCH_OPEN_PREFIX: &str = "[!-- {$";
const COMMENT_BOUNDARY_MARKER: &str = "[!----]";
const SELECTED_BRANCH_MARKER: &str = "[!-- --]";
const PAIRED_BRANCH_CLOSE_PREFIX: &str = "[!{$";
const PAIRED_BRANCH_CLOSE_SUFFIX: &str = "} --]";

pub(super) fn remove_unresolved_include_comment_branches(wikitext: &mut String) {
    remove_unresolved_include_comment_branches_inner(wikitext, None);
}

pub(super) fn remove_nested_include_boundaries(wikitext: &mut String) {
    let mut output = String::with_capacity(wikitext.len());
    let mut plain_comment_open = false;
    for line in wikitext.split_inclusive('\n') {
        let marker = line.trim();
        if plain_comment_open {
            output.push_str(line);
            if marker.contains("--]") {
                plain_comment_open = false;
            }
            continue;
        }
        if !is_boundary(marker) && !is_unresolved_branch_open(marker) {
            output.push_str(line);
            plain_comment_open = opens_plain_comment(line);
        }
    }
    *wikitext = output;
}

pub(super) fn remove_unresolved_include_comment_branches_source_local(
    wikitext: &mut String,
    fragments: &mut CompatTextFragments,
) {
    remove_unresolved_include_comment_branches_inner(wikitext, Some(fragments));
}

fn remove_unresolved_include_comment_branches_inner(
    wikitext: &mut String,
    mut fragments: Option<&mut CompatTextFragments>,
) {
    let mut output = String::with_capacity(wikitext.len());
    let mut unresolved_branch = None::<UnresolvedBranch>;
    let mut plain_comment_open = false;

    for line in wikitext.split_inclusive('\n') {
        let marker = line.trim();

        if let Some(branch) = unresolved_branch.as_mut() {
            branch.source.push_str(line);
            let paired_close = branch
                .variable
                .as_deref()
                .zip(paired_branch_close_variable(marker))
                .is_some_and(|(variable, closed_by)| variable == closed_by);
            if paired_close {
                unresolved_branch = None;
            } else if is_unresolved_branch_open(marker) {
                branch.nested_opener = true;
            } else if !branch.nested_opener && is_boundary(marker) {
                unresolved_branch = None;
            }
            continue;
        }

        if plain_comment_open {
            output.push_str(line);
            if marker.contains("--]") {
                plain_comment_open = false;
            }
            continue;
        }

        if is_unresolved_branch_open(marker) {
            unresolved_branch = Some(UnresolvedBranch {
                source: line.to_owned(),
                nested_opener: false,
                variable: unresolved_branch_variable(marker),
            });
        } else if !is_boundary(marker) {
            output.push_str(line);
            plain_comment_open = opens_plain_comment(line);
        }
    }

    if let Some(branch) = unresolved_branch {
        if let Some(fragments) = fragments.as_mut() {
            protect_unbounded_branch(&mut output, &branch.source, fragments);
        } else {
            output.push_str(&branch.source);
        }
    }

    *wikitext = output;
}

fn protect_unbounded_branch(
    output: &mut String,
    source: &str,
    fragments: &mut CompatTextFragments,
) {
    let (body, ending) = split_line_ending(source);
    output.push_str(&fragments.push_escaped_html_text(body));
    output.push_str(ending);
}

fn split_line_ending(line: &str) -> (&str, &str) {
    if let Some(body) = line.strip_suffix("\r\n") {
        (body, "\r\n")
    } else if let Some(body) = line.strip_suffix('\n') {
        (body, "\n")
    } else if let Some(body) = line.strip_suffix('\r') {
        (body, "\r")
    } else {
        (line, "")
    }
}

struct UnresolvedBranch {
    source: String,
    nested_opener: bool,
    variable: Option<String>,
}

fn is_unresolved_branch_open(line: &str) -> bool {
    line.starts_with(UNRESOLVED_BRANCH_OPEN_PREFIX)
}

fn unresolved_branch_variable(line: &str) -> Option<String> {
    let rest = line.strip_prefix(UNRESOLVED_BRANCH_OPEN_PREFIX)?;
    let name = &rest[..rest.find('}')?];
    is_valid_branch_variable(name).then(|| name.to_owned())
}

fn paired_branch_close_variable(line: &str) -> Option<&str> {
    let name = line
        .strip_prefix(PAIRED_BRANCH_CLOSE_PREFIX)?
        .strip_suffix(PAIRED_BRANCH_CLOSE_SUFFIX)?;
    is_valid_branch_variable(name).then_some(name)
}

fn is_valid_branch_variable(name: &str) -> bool {
    !name.is_empty()
        && !name
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '{' | '}'))
}

fn opens_plain_comment(line: &str) -> bool {
    match line.rfind("[!--") {
        Some(open) => !line[open + "[!--".len()..].contains("--]"),
        None => false,
    }
}

fn is_boundary(line: &str) -> bool {
    matches!(line, COMMENT_BOUNDARY_MARKER | SELECTED_BRANCH_MARKER)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ftml::data::{PageInfo, ScoreValue};
    use ftml::layout::Layout;
    use ftml::render::Render;
    use ftml::render::html::HtmlRender;
    use ftml::settings::{WikitextMode, WikitextSettings};
    use std::borrow::Cow;

    #[test]
    fn removes_compact_unselected_include_comment_branches() {
        let mut wikitext = concat!(
            "Before\n",
            "[!----]\n",
            "[!-- {$inc-hidden}\n",
            "Hidden branch %%title%%\n",
            "[!----]\n",
            "[!-- --]\n",
            "Selected branch body\n",
            "[!----]\n",
            "[!-- {$inc-other}\n",
            "Other hidden branch\n",
            "[!----]\n",
            "After\n",
        )
        .to_owned();

        remove_unresolved_include_comment_branches(&mut wikitext);

        assert_eq!(wikitext, "Before\nSelected branch body\nAfter\n");
    }

    #[test]
    fn empty_comment_boundaries_preserve_split_author_label_divs() {
        let mut wikitext = concat!(
            "[!-- --]\n",
            "[[div_ class=\"authorlink-wrapper\"]]\n",
            "[# Ecronak]\n",
            "[[div class=\"authorbox\"]]\n",
            "[[div class=\"authorcontent\"]]\n",
            "[!-- {$end}]\n",
            "[[/div]]\n",
            "[[/div]]\n",
            "[[/div]]\n",
            "[!-- --]\n",
            "Enjoyed the skip? Give some of my other works a look!\n",
            "[!-- {$start}]\n",
            "[[div_ class=\"authorlink-wrapper\"]]\n",
            "[# {$name}]\n",
            "[[div class=\"authorbox\"]]\n",
            "[[div class=\"authorcontent\"]]\n",
            "[!-- --]\n",
            "[[/div]]\n",
            "[[/div]]\n",
            "[[/div]]\n",
            "[!-- --]\n",
        )
        .to_owned();

        remove_unresolved_include_comment_branches(&mut wikitext);

        assert!(!wikitext.contains("[!-- {$start}]"), "{wikitext}");
        assert!(!wikitext.contains("[!-- {$end}]"), "{wikitext}");
        assert!(!wikitext.contains("[!-- --]"), "{wikitext}");
        assert!(!wikitext.contains("[!----]"), "{wikitext}");

        let page_info = PageInfo {
            page: Cow::Borrowed("scp-6670"),
            category: None,
            site: Cow::Borrowed("scp-wiki"),
            title: Cow::Borrowed("SCP-6670"),
            alt_title: None,
            score: ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
        ftml::preprocess_for_layout(&mut wikitext, settings.layout);
        let tokens = ftml::tokenize(&wikitext);
        let result = ftml::parse(&tokens, &page_info, &settings);
        let (tree, errors) = result.into();
        assert!(errors.is_empty(), "{errors:?}\n{wikitext}");
        let html = HtmlRender.render(&tree, &page_info, &settings).body;

        assert!(
            html.contains(
                "<div class=\"authorlink-wrapper\"><a href=\"javascript:;\">Ecronak</a>\n<div class=\"authorbox\"><div class=\"authorcontent\">",
            ),
            "{html}",
        );
        assert!(html.contains("Enjoyed the skip?"), "{html}");
        assert!(!html.contains("[[div"), "{html}");
        assert!(!html.contains("[[/div]]"), "{html}");
    }

    #[test]
    fn preserves_plain_comment_closer_lines_for_later_passes() {
        let original = concat!(
            "Before\n",
            "[!-- -draft\n",
            "Commented branch body\n",
            "[!-- --]\n",
            "After\n",
        );
        let mut wikitext = original.to_owned();

        remove_unresolved_include_comment_branches(&mut wikitext);

        assert_eq!(wikitext, original);
    }

    #[test]
    fn preserves_unresolved_branch_without_a_boundary() {
        let original = concat!("Before\n", "[!-- {$end}]\n", "[[/div]]\n", "After\n",);
        let mut wikitext = original.to_owned();

        remove_unresolved_include_comment_branches(&mut wikitext);

        assert_eq!(wikitext, original);
    }

    #[test]
    fn preserves_inline_marker_like_text() {
        let original =
            concat!("Before [!-- {$end}] inline\n", "After [!-- --] inline\n",);
        let mut wikitext = original.to_owned();

        remove_unresolved_include_comment_branches(&mut wikitext);

        assert_eq!(wikitext, original);
    }

    #[test]
    fn removes_nested_boundaries_but_preserves_content() {
        let mut wikitext = concat!(
            "Before\n",
            "[!-- {$normal}\n",
            "Nested content\n",
            "[!----]\n",
            "After\n",
        )
        .to_owned();

        remove_nested_include_boundaries(&mut wikitext);

        assert_eq!(wikitext, "Before\nNested content\nAfter\n");
    }

    #[test]
    fn nested_boundary_pruning_preserves_plain_comment_closers() {
        let original = concat!(
            "Before\n",
            "[!-- -draft\n",
            "Commented branch body\n",
            "[!-- --]\n",
            "[[module Rate]]\n",
        );
        let mut wikitext = original.to_owned();

        remove_nested_include_boundaries(&mut wikitext);

        assert_eq!(wikitext, original);
        let literal_regions =
            crate::services::render::literal_regions::LiteralRegionIndex::new_wikidot_module_recognition(
                &wikitext,
            );
        let rate_start = wikitext
            .find("[[module Rate]]")
            .expect("rate module present");
        assert!(
            !literal_regions.contains(rate_start),
            "a module after a closed plain comment must stay recognizable",
        );
    }

    #[test]
    fn inline_boundary_text_does_not_close_an_unresolved_branch() {
        let original = concat!(
            "Before\n",
            "[!-- {$end}]\n",
            "This mentions [!-- --] inline.\n",
            "After\n",
        );
        let mut wikitext = original.to_owned();

        remove_unresolved_include_comment_branches(&mut wikitext);

        assert_eq!(wikitext, original);
    }

    #[test]
    fn removes_consecutive_unresolved_branches_independently() {
        let mut wikitext = concat!(
            "Before\n",
            "[!-- {$first}]\n",
            "First hidden branch\n",
            "[!-- --]\n",
            "[!-- {$second}]\n",
            "Second hidden branch\n",
            "[!----]\n",
            "After\n",
        )
        .to_owned();

        remove_unresolved_include_comment_branches(&mut wikitext);

        assert_eq!(wikitext, "Before\nAfter\n");
    }

    #[test]
    fn preserves_nested_unresolved_branches_as_malformed_input() {
        let original = concat!(
            "Before\n",
            "[!-- {$outer}]\n",
            "Outer body\n",
            "[!-- {$inner}]\n",
            "Inner body\n",
            "[!-- --]\n",
            "After first boundary\n",
            "[!----]\n",
        );
        let mut wikitext = original.to_owned();

        remove_unresolved_include_comment_branches(&mut wikitext);

        assert_eq!(wikitext, original);
    }

    #[test]
    fn source_local_cleanup_protects_the_complete_unbounded_branch() {
        let original = concat!(
            "CHILD_BEFORE\n",
            "[!-- {$outer}\n",
            "OUTER_BODY\n",
            "[!-- {$inner}\n",
            "INNER_BODY\n",
            "[[include component:must-not-expand]]\n",
            "[!----]\n",
        );
        let mut wikitext = original.to_owned();
        let mut fragments = CompatTextFragments::new(original);

        remove_unresolved_include_comment_branches_source_local(
            &mut wikitext,
            &mut fragments,
        );
        assert!(!wikitext.contains("[!-- {$outer}"), "{wikitext}");
        assert!(!wikitext.contains("[!-- {$inner}"), "{wikitext}");
        assert!(!wikitext.contains("OUTER_BODY"), "{wikitext}");
        assert!(!wikitext.contains("INNER_BODY"), "{wikitext}");
        assert!(!wikitext.contains("must-not-expand"), "{wikitext}");

        wikitext.push_str("ROOT_BEFORE\n[!-- --]\nROOT_AFTER\n");
        remove_unresolved_include_comment_branches(&mut wikitext);
        let restored = fragments.restore(&wikitext);

        assert!(restored.contains("[!-- {$outer}\n"), "{restored}");
        assert!(restored.contains("[!-- {$inner}\n"), "{restored}");
        assert!(restored.contains("OUTER_BODY\n"), "{restored}");
        assert!(restored.contains("INNER_BODY\n"), "{restored}");
        assert!(restored.contains("component:must-not-expand"), "{restored}");
        assert!(restored.contains("ROOT_BEFORE\n"), "{restored}");
        assert!(restored.contains("ROOT_AFTER\n"), "{restored}");
        assert!(!restored.contains("[!-- --]"), "{restored}");
    }

    #[test]
    fn drops_paired_comment_gates_with_unresolved_variables() {
        let mut wikitext = concat!(
            "Component styles\n",
            "[!-- {$inc-animation}]\n",
            "[[div class=\"sacs-v4_animation\"]]\n",
            "Animation body\n",
            "[[/div]]\n",
            "[!{$inc-animation} --]\n",
            "Bar body\n",
            "[!-- {$inc-darkmode}]\n",
            "Dark body\n",
            "[!{$inc-darkmode} --]\n",
            "Tail\n",
        )
        .to_owned();

        remove_unresolved_include_comment_branches(&mut wikitext);

        assert_eq!(wikitext, "Component styles\nBar body\nTail\n");

        let page_info = PageInfo {
            page: Cow::Borrowed("scp-8790"),
            category: None,
            site: Cow::Borrowed("scp-wiki"),
            title: Cow::Borrowed("SCP-8790"),
            alt_title: None,
            score: ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
        ftml::preprocess_for_layout(&mut wikitext, settings.layout);
        let tokens = ftml::tokenize(&wikitext);
        let result = ftml::parse(&tokens, &page_info, &settings);
        let (tree, errors) = result.into();
        assert!(errors.is_empty(), "{errors:?}\n{wikitext}");
        let html = HtmlRender.render(&tree, &page_info, &settings).body;

        assert!(html.contains("Bar body"), "{html}");
        assert!(html.contains("Tail"), "{html}");
        assert!(!html.contains("sacs-v4_animation"), "{html}");
        assert!(!html.contains("Animation body"), "{html}");
        assert!(!html.contains("Dark body"), "{html}");
        assert!(!html.contains("{$inc-"), "{html}");
    }

    #[test]
    fn paired_comment_gate_with_dashes_value_keeps_the_block() {
        let mut wikitext = concat!(
            "Before\n",
            "[!-- --]\n",
            "Shown body\n",
            "[!--- --]\n",
            "After\n",
        )
        .to_owned();

        remove_unresolved_include_comment_branches(&mut wikitext);

        assert!(wikitext.contains("Shown body\n"), "{wikitext}");
        assert!(!wikitext.contains("[!-- {$"), "{wikitext}");

        let page_info = PageInfo {
            page: Cow::Borrowed("scp-8790"),
            category: None,
            site: Cow::Borrowed("scp-wiki"),
            title: Cow::Borrowed("SCP-8790"),
            alt_title: None,
            score: ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
        ftml::preprocess_for_layout(&mut wikitext, settings.layout);
        let tokens = ftml::tokenize(&wikitext);
        let result = ftml::parse(&tokens, &page_info, &settings);
        let (tree, errors) = result.into();
        assert!(errors.is_empty(), "{errors:?}\n{wikitext}");
        let html = HtmlRender.render(&tree, &page_info, &settings).body;

        assert!(html.contains("Shown body"), "{html}");
        assert!(!html.contains("[!---"), "{html}");
    }

    #[test]
    fn paired_closer_terminates_a_branch_despite_a_sibling_opener() {
        let mut wikitext = concat!(
            "Before\n",
            "[!-- {$inc-first}]\n",
            "First body\n",
            "[!-- {$inc-second}]\n",
            "Second body\n",
            "[!{$inc-first} --]\n",
            "After\n",
        )
        .to_owned();

        remove_unresolved_include_comment_branches(&mut wikitext);

        assert_eq!(wikitext, "Before\nAfter\n");
    }

    #[test]
    fn paired_closer_for_another_variable_does_not_close_the_branch() {
        let original = concat!(
            "Before\n",
            "[!-- {$inc-first}]\n",
            "Body\n",
            "[!{$inc-second} --]\n",
            "After\n",
        );
        let mut wikitext = original.to_owned();

        remove_unresolved_include_comment_branches(&mut wikitext);

        assert_eq!(wikitext, original);
    }

    #[test]
    fn source_local_cleanup_protects_a_paired_gate_without_its_closer() {
        let original = concat!(
            "CHILD_BEFORE\n",
            "[!-- {$inc-animation}]\n",
            "[[div class=\"sacs-v4_animation\"]]\n",
            "Gated body\n",
        );
        let mut wikitext = original.to_owned();
        let mut fragments = CompatTextFragments::new(original);

        remove_unresolved_include_comment_branches_source_local(
            &mut wikitext,
            &mut fragments,
        );
        assert!(wikitext.contains("CHILD_BEFORE"), "{wikitext}");
        assert!(!wikitext.contains("[!-- {$inc-animation}"), "{wikitext}");
        assert!(!wikitext.contains("sacs-v4_animation"), "{wikitext}");
        assert!(!wikitext.contains("Gated body"), "{wikitext}");

        wikitext.push_str("ROOT_AFTER\n");
        remove_unresolved_include_comment_branches(&mut wikitext);
        let restored = fragments.restore(&wikitext);

        assert!(restored.contains("[!-- {$inc-animation}]"), "{restored}");
        assert!(restored.contains("Gated body"), "{restored}");
        assert!(restored.contains("ROOT_AFTER\n"), "{restored}");
    }
}
