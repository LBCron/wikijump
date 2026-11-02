use super::compat::text_fragments::CompatTextFragments;
use super::literal_regions::LiteralRegionIndex;
use regex::Regex;
use std::borrow::Cow;
use std::collections::HashMap;
use std::ops::Range;
use std::sync::LazyLock;

static IFTAGS_TOKEN_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?i)(?P<open>\[\[iftags(?P<spec>[^\]\r\n]*)\]\])|(?P<close>\[\[/iftags\]\])"#,
    )
    .unwrap()
});

#[derive(Debug)]
struct OpenGate {
    start: usize,
    end: usize,
    spec: String,
    nested_tokens: Vec<Range<usize>>,
    last_nested_closer: Option<Range<usize>>,
}

#[derive(Debug)]
struct Replacement {
    range: Range<usize>,
    text: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum UnmatchedBoundaryMode {
    Defer,
    Preserve,
}

pub(super) fn resolve_outermost_wikidot_iftags(
    wikitext: &mut String,
    tags: &[Cow<'_, str>],
    preserved: &mut CompatTextFragments,
) {
    resolve_outermost_wikidot_iftags_with_mode(
        wikitext,
        tags,
        preserved,
        UnmatchedBoundaryMode::Preserve,
        false,
    );
    strip_wikidot_generated_spec_markers(wikitext);
}

pub(super) fn resolve_outermost_wikidot_iftags_before_include_expansion(
    wikitext: &mut String,
    tags: &[Cow<'_, str>],
    preserved: &mut CompatTextFragments,
) {
    resolve_outermost_wikidot_iftags_with_mode(
        wikitext,
        tags,
        preserved,
        UnmatchedBoundaryMode::Defer,
        false,
    );
}

pub(super) fn resolve_outermost_wikidot_iftags_before_include_expansion_for_page_preview(
    wikitext: &mut String,
    preserved: &mut CompatTextFragments,
) {
    resolve_outermost_wikidot_iftags_with_mode(
        wikitext,
        &[],
        preserved,
        UnmatchedBoundaryMode::Defer,
        true,
    );
}

fn resolve_outermost_wikidot_iftags_with_mode(
    wikitext: &mut String,
    tags: &[Cow<'_, str>],
    preserved: &mut CompatTextFragments,
    unmatched_mode: UnmatchedBoundaryMode,
    force_inactive: bool,
) {
    let literal_regions = LiteralRegionIndex::new_wikidot_conditional_syntax(wikitext);
    let mut stack = Vec::<OpenGate>::new();
    let mut replacements = Vec::<Replacement>::new();
    let mut inactive_literal_scopes =
        HashMap::<(usize, usize), InactiveLiteralScope>::new();
    let mut seen_skipped_opener = false;

    for captures in IFTAGS_TOKEN_REGEX.captures_iter(wikitext) {
        let token = captures.get(0).expect("iftags token");
        let literal = literal_regions.containing_range(token.start());
        let closes_inactive_root = captures.name("close").is_some()
            && stack.first().is_some_and(|outer| {
                force_inactive || !wikidot_tag_conditions_match(&outer.spec, tags)
            })
            && literal.is_some_and(|range| {
                let key = (range.start, range.end);
                let scope = *inactive_literal_scopes
                    .entry(key)
                    .or_insert_with(|| classify_inactive_literal_scope(wikitext, range));
                inactive_gate_closes_inside_literal(scope, token.end())
            });
        if literal.is_some() && !closes_inactive_root {
            if captures.name("open").is_some() {
                seen_skipped_opener = true;
            }
            continue;
        }

        if captures.name("open").is_some() {
            if let Some(outer) = stack.first_mut() {
                outer.nested_tokens.push(token.start()..token.end());
            }
            stack.push(OpenGate {
                start: token.start(),
                end: token.end(),
                spec: captures
                    .name("spec")
                    .map_or("", |value| value.as_str())
                    .to_owned(),
                nested_tokens: Vec::new(),
                last_nested_closer: None,
            });
            continue;
        }

        if stack.len() > 1 {
            let range = token.start()..token.end();
            let outer = stack.first_mut().expect("nested iftags has outer gate");
            outer.nested_tokens.push(range.clone());
            outer.last_nested_closer = Some(range);
            stack.pop();
            continue;
        }

        let Some(outer) = stack.pop() else {
            if unmatched_mode == UnmatchedBoundaryMode::Preserve && !seen_skipped_opener {
                replacements.push(Replacement {
                    range: token.start()..token.end(),
                    text: preserved.push_escaped_html_text(token.as_str()),
                });
            }
            continue;
        };
        let text = if !force_inactive && wikidot_tag_conditions_match(&outer.spec, tags) {
            preserve_nested_tokens(
                wikitext,
                outer.end..token.start(),
                &outer.nested_tokens,
                preserved,
            )
        } else {
            String::new()
        };
        replacements.push(Replacement {
            range: outer.start..token.end(),
            text,
        });
    }

    if !stack.is_empty() && unmatched_mode == UnmatchedBoundaryMode::Preserve {
        let root = stack.remove(0);
        if let Some(recovery_closer) = root.last_nested_closer {
            let nested_tokens = root
                .nested_tokens
                .iter()
                .filter(|token| token.start < recovery_closer.start)
                .cloned()
                .collect::<Vec<_>>();
            let text =
                if !force_inactive && wikidot_tag_conditions_match(&root.spec, tags) {
                    preserve_nested_tokens(
                        wikitext,
                        root.end..recovery_closer.start,
                        &nested_tokens,
                        preserved,
                    )
                } else {
                    String::new()
                };
            replacements.push(Replacement {
                range: root.start..recovery_closer.end,
                text,
            });
            stack.retain(|unclosed| unclosed.start >= recovery_closer.end);
        } else {
            stack.insert(0, root);
        }

        for unclosed in stack {
            replacements.push(Replacement {
                range: unclosed.start..unclosed.end,
                text: preserved
                    .push_escaped_html_text(&wikitext[unclosed.start..unclosed.end]),
            });
        }
    }

    if replacements.is_empty() {
        return;
    }
    replacements.sort_unstable_by_key(|replacement| replacement.range.start);
    let mut output = String::with_capacity(wikitext.len());
    let mut cursor = 0;
    for replacement in replacements {
        debug_assert!(cursor <= replacement.range.start);
        output.push_str(&wikitext[cursor..replacement.range.start]);
        output.push_str(&replacement.text);
        cursor = replacement.range.end;
    }
    output.push_str(&wikitext[cursor..]);
    *wikitext = output;
}

#[derive(Clone, Copy)]
enum InactiveLiteralScope {
    Never,
    Always,
    AfterClose { close_end: usize },
}

fn classify_inactive_literal_scope(
    source: &str,
    literal: &Range<usize>,
) -> InactiveLiteralScope {
    let literal_source = source[literal.clone()].trim_start_matches([' ', '\t']);
    if starts_with_ascii_case_insensitive(literal_source, "[[raw")
        || starts_with_ascii_case_insensitive(literal_source, "[!--")
    {
        return InactiveLiteralScope::Always;
    }

    for (open, close) in [
        ("[[code", "[[/code]]"),
        ("[[html", "[[/html]]"),
        ("[[module", "[[/module]]"),
    ] {
        if starts_with_ascii_case_insensitive(literal_source, open) {
            let close_end =
                find_last_ascii_case_insensitive(&source[literal.clone()], close)
                    .map(|offset| literal.start + offset + close.len());
            return close_end.map_or(InactiveLiteralScope::Always, |close_end| {
                InactiveLiteralScope::AfterClose { close_end }
            });
        }
    }
    InactiveLiteralScope::Never
}

fn inactive_gate_closes_inside_literal(
    scope: InactiveLiteralScope,
    closer_end: usize,
) -> bool {
    match scope {
        InactiveLiteralScope::Never => false,
        InactiveLiteralScope::Always => true,
        InactiveLiteralScope::AfterClose { close_end } => closer_end > close_end,
    }
}

fn starts_with_ascii_case_insensitive(source: &str, prefix: &str) -> bool {
    source
        .get(..prefix.len())
        .is_some_and(|head| head.as_bytes().eq_ignore_ascii_case(prefix.as_bytes()))
}

fn find_last_ascii_case_insensitive(source: &str, needle: &str) -> Option<usize> {
    source
        .as_bytes()
        .windows(needle.len())
        .rposition(|window| window.eq_ignore_ascii_case(needle.as_bytes()))
}

fn preserve_nested_tokens(
    source: &str,
    body: Range<usize>,
    tokens: &[Range<usize>],
    preserved: &mut CompatTextFragments,
) -> String {
    let mut output = String::with_capacity(body.len());
    let mut cursor = body.start;
    for token in tokens {
        debug_assert!(body.start <= token.start && token.end <= body.end);
        output.push_str(&source[cursor..token.start]);
        output.push_str(&preserved.push_escaped_html_text(&source[token.clone()]));
        cursor = token.end;
    }
    output.push_str(&source[cursor..body.end]);
    output
}

pub(super) const WIKIDOT_GENERATED_SPEC_MARKER: &str = "+wikijump:generated-spec";

pub(super) fn mark_wikidot_generated_iftags_specs(wikitext: &mut String) {
    if !wikitext.contains("[[#")
        || !wikitext
            .as_bytes()
            .windows("[[iftags".len())
            .any(|window| window.eq_ignore_ascii_case(b"[[iftags"))
    {
        return;
    }

    let literal_regions = LiteralRegionIndex::new_wikidot_conditional_syntax(wikitext);
    let mut insertions = Vec::new();
    let mut search = 0usize;
    while search < wikitext.len() {
        let Some(open) = wikitext.as_bytes()[search..]
            .windows("[[iftags".len())
            .position(|window| window.eq_ignore_ascii_case(b"[[iftags"))
        else {
            break;
        };
        let start = search + open;
        search = start + "[[iftags".len();
        if literal_regions.contains(start) {
            continue;
        }
        let Some(head_len) = wikidot_iftags_head_len(&wikitext[start..]) else {
            continue;
        };
        let head_end = start + head_len;
        if wikitext[start..head_end].contains("[[#") {
            insertions.push(head_end - "]]".len());
        }
        search = search.max(head_end);
    }

    for position in insertions.into_iter().rev() {
        wikitext.insert_str(position, WIKIDOT_GENERATED_SPEC_MARKER);
        wikitext.insert(position, ' ');
    }
}

fn wikidot_iftags_head_len(source: &str) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut depth = 0usize;
    let mut index = 0usize;
    while index < bytes.len() {
        if depth <= 1 && matches!(bytes[index], b'\n' | b'\r') {
            return None;
        }
        if bytes[index..].starts_with(b"[[") {
            depth += 1;
            index += 2;
            continue;
        }
        if bytes[index..].starts_with(b"]]") {
            depth = depth.checked_sub(1)?;
            index += 2;
            if depth == 0 {
                return Some(index);
            }
            continue;
        }
        index += 1;
        if index > 16_384 {
            return None;
        }
    }
    None
}

fn strip_wikidot_generated_spec_markers(wikitext: &mut String) {
    if !wikitext.contains(WIKIDOT_GENERATED_SPEC_MARKER) {
        return;
    }
    let suffix = format!(" {WIKIDOT_GENERATED_SPEC_MARKER}]]");
    let stripped =
        IFTAGS_TOKEN_REGEX.replace_all(wikitext, |captures: &regex::Captures<'_>| {
            let Some(open) = captures.name("open") else {
                return captures[0].to_owned();
            };
            let open = open.as_str();
            match open.strip_suffix(&suffix) {
                Some(head) => format!("{head}]]"),
                None => open.to_owned(),
            }
        });
    if let std::borrow::Cow::Owned(stripped) = stripped {
        *wikitext = stripped;
    }
}

pub(super) fn wikidot_tag_conditions_match(spec: &str, tags: &[Cow<'_, str>]) -> bool {
    if spec.trim().is_empty() {
        return !tags.is_empty();
    }

    let mut required = true;
    let mut prohibited = true;
    let mut present = false;
    let mut had_present = false;
    let mut had_condition = false;
    let mut saw_generated_marker = false;

    for raw_condition in spec.split_whitespace() {
        if raw_condition == WIKIDOT_GENERATED_SPEC_MARKER {
            saw_generated_marker = true;
            continue;
        }
        had_condition = true;
        let (operator, tag) = raw_condition.split_at(usize::from(
            raw_condition.starts_with('+') || raw_condition.starts_with('-'),
        ));
        if tag.is_empty() {
            continue;
        }

        let has_tag = tags.iter().any(|value| value.as_ref() == tag);
        match operator {
            "+" => required &= has_tag,
            "-" => prohibited &= !has_tag,
            _ => {
                had_present = true;
                present |= has_tag;
            }
        }
    }

    if saw_generated_marker && !had_condition {
        return false;
    }

    if !had_present {
        present = true;
    }

    required && prohibited && present
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::render::compat::text_fragments;
    use std::time::{Duration, Instant};

    fn resolve(source: &str, tags: &[&str], passes: usize) -> String {
        let mut source = source.to_owned();
        let tags = tags
            .iter()
            .map(|tag| Cow::Borrowed(*tag))
            .collect::<Vec<_>>();
        let mut preserved = CompatTextFragments::new(&source);
        for _ in 0..passes {
            resolve_outermost_wikidot_iftags(&mut source, &tags, &mut preserved);
        }
        preserved.restore(&source)
    }

    #[test]
    fn bare_gate_follows_whether_the_page_carries_tags() {
        let source = "before\n[[iftags]]shown[[/iftags]]\nafter\n";
        assert_eq!(resolve(source, &["alpha"], 1), "before\nshown\nafter\n");
        assert_eq!(resolve(source, &[], 1), "before\n\nafter\n");
    }

    #[test]
    fn empty_spec_matches_only_when_the_page_carries_tags() {
        let tags = [Cow::Borrowed("alpha")];
        assert!(wikidot_tag_conditions_match("", &tags));
        assert!(wikidot_tag_conditions_match("  ", &tags));
        assert!(!wikidot_tag_conditions_match("", &[]));
        assert!(!wikidot_tag_conditions_match("  ", &[]));
    }

    #[test]
    fn generated_spec_marker_only_matches_when_real_conditions_pass() {
        let tags = [Cow::Borrowed("alpha")];
        assert!(!wikidot_tag_conditions_match(
            WIKIDOT_GENERATED_SPEC_MARKER,
            &tags
        ));
        assert!(wikidot_tag_conditions_match(
            &format!("- {WIKIDOT_GENERATED_SPEC_MARKER}"),
            &tags
        ));
        assert!(wikidot_tag_conditions_match(
            &format!("+alpha {WIKIDOT_GENERATED_SPEC_MARKER}"),
            &tags
        ));
        assert!(!wikidot_tag_conditions_match(
            &format!("+beta {WIKIDOT_GENERATED_SPEC_MARKER}"),
            &tags
        ));
    }

    #[test]
    fn marking_generated_heads_leaves_authored_heads_untouched() {
        let mut source = concat!(
            "[[iftags]]bare[[/iftags]]\n",
            "[[iftags +alpha]]plain[[/iftags]]\n",
            "[[iftags [[#ifexpr 1 == 0 | - ]]]]generated[[/iftags]]\n",
        )
        .to_owned();
        mark_wikidot_generated_iftags_specs(&mut source);
        assert!(source.contains("[[iftags]]bare"), "{source}");
        assert!(source.contains("[[iftags +alpha]]plain"), "{source}");
        assert_eq!(
            source.matches(WIKIDOT_GENERATED_SPEC_MARKER).count(),
            1,
            "{source}"
        );
        assert!(
            source.contains(&format!("- ]] {WIKIDOT_GENERATED_SPEC_MARKER}]]")),
            "{source}"
        );
    }

    #[test]
    fn marking_heads_with_multibyte_first_tag_does_not_panic() {
        for spec in [
            "+\u{d15c}\u{d50c}\u{b9bf}",
            "+\u{ad6c}\u{c131}\u{c694}\u{c18c}",
            "+_\u{6e90}\u{4ee3}\u{7801}",
            "+\u{7248}\u{5f0f}",
        ] {
            let mut source = format!(
                "[[iftags {spec}]]authored[[/iftags]]\n[[iftags [[#ifexpr 1 == 0 | - ]]]]generated[[/iftags]]\n"
            );
            mark_wikidot_generated_iftags_specs(&mut source);
            assert!(
                source.contains(&format!("[[iftags {spec}]]authored")),
                "{source}"
            );
            assert_eq!(
                source.matches(WIKIDOT_GENERATED_SPEC_MARKER).count(),
                1,
                "{source}"
            );
        }
    }

    #[test]
    fn marking_heads_with_mixed_and_later_multibyte_tags_does_not_panic() {
        let mut source = concat!(
            "[[iftags +alpha +\u{d15c}\u{d50c}\u{b9bf} -\u{7248}\u{5f0f}]]mixed[[/iftags]]\n",
            "[[iftags +alpha \u{ad6c}\u{c131}\u{c694}\u{c18c}]]later[[/iftags]]\n",
            "[[iftags [[#ifexpr 1 == 0 | - ]]]]generated[[/iftags]]\n",
        )
        .to_owned();
        mark_wikidot_generated_iftags_specs(&mut source);
        assert!(
            source.contains(
                "[[iftags +alpha +\u{d15c}\u{d50c}\u{b9bf} -\u{7248}\u{5f0f}]]mixed"
            ),
            "{source}"
        );
        assert!(
            source.contains("[[iftags +alpha \u{ad6c}\u{c131}\u{c694}\u{c18c}]]later"),
            "{source}"
        );
        assert_eq!(
            source.matches(WIKIDOT_GENERATED_SPEC_MARKER).count(),
            1,
            "{source}"
        );
    }

    #[test]
    fn multibyte_tag_conditions_keep_ascii_semantics() {
        let tags = [
            Cow::Borrowed("\u{ad6c}\u{c131}\u{c694}\u{c18c}"),
            Cow::Borrowed("alpha"),
        ];
        assert!(wikidot_tag_conditions_match(
            "+\u{ad6c}\u{c131}\u{c694}\u{c18c}",
            &tags
        ));
        assert!(!wikidot_tag_conditions_match(
            "+\u{d15c}\u{d50c}\u{b9bf}",
            &tags
        ));
        assert!(wikidot_tag_conditions_match("-\u{7248}\u{5f0f}", &tags));
        assert!(!wikidot_tag_conditions_match(
            "-\u{ad6c}\u{c131}\u{c694}\u{c18c}",
            &tags
        ));
        assert!(wikidot_tag_conditions_match(
            "\u{ad6c}\u{c131}\u{c694}\u{c18c}",
            &tags
        ));
        assert!(!wikidot_tag_conditions_match(
            "\u{6e90}\u{4ee3}\u{7801}",
            &tags
        ));
        assert!(wikidot_tag_conditions_match(
            "+alpha +\u{ad6c}\u{c131}\u{c694}\u{c18c} -\u{7248}\u{5f0f}",
            &tags
        ));
    }

    #[test]
    fn resolves_gates_with_multibyte_tags() {
        let source = concat!(
            "[[iftags +\u{ad6c}\u{c131}\u{c694}\u{c18c}]]yes[[/iftags]]\n",
            "[[iftags +\u{d15c}\u{d50c}\u{b9bf}]]no[[/iftags]]\n",
            "[[iftags -\u{7248}\u{5f0f}]]kept[[/iftags]]\n",
        );
        assert_eq!(
            resolve(source, &["\u{ad6c}\u{c131}\u{c694}\u{c18c}"], 1),
            "yes\n\nkept\n"
        );
    }

    #[test]
    fn resolves_root_siblings_and_preserves_following_text() {
        let source = concat!(
            "before\n",
            "[[iftags +alpha]]yes[[/iftags]]\n",
            "[[iftags -alpha]]no[[/iftags]]\n",
            "after\n",
        );
        assert_eq!(resolve(source, &["alpha"], 1), "before\nyes\n\nafter\n");
    }

    #[test]
    fn active_outer_preserves_nested_tokens_across_repeated_passes() {
        let source = concat!(
            "[[iftags +alpha]]\n",
            "outer-before\n",
            "[[iftags +beta]]\n",
            "inner\n",
            "[[/iftags]]\n",
            "outer-after\n",
            "[[/iftags]]\n",
            "root-after\n",
        );
        assert_eq!(
            resolve(source, &["alpha"], 3),
            concat!(
                "\nouter-before\n",
                "[[iftags +beta]]\n",
                "inner\n",
                "[[/iftags]]\n",
                "outer-after\n\n",
                "root-after\n",
            ),
        );
    }

    #[test]
    fn inactive_outer_removes_nested_body_without_consuming_root_text() {
        let source = concat!(
            "[[iftags +alpha]]\n",
            "outer\n",
            "[[iftags +beta]]inner[[/iftags]]\n",
            "[[/iftags]]\n",
            "root-after\n",
        );
        assert_eq!(resolve(source, &["beta"], 3), "\nroot-after\n");
    }

    #[test]
    fn partially_balanced_outer_recovers_the_final_closer() {
        let source = "[[iftags +alpha]]outer [[iftags +beta]]inner[[/iftags]]";
        assert_eq!(
            resolve(source, &["alpha", "beta"], 3),
            "outer [[iftags +beta]]inner",
        );
        assert_eq!(resolve(source, &["beta"], 3), "");
    }

    #[test]
    fn partially_balanced_outer_consumes_only_the_final_available_closer() {
        let source = concat!(
            "[[iftags +alpha]]outer\n",
            "[[iftags +beta]]inner[[/iftags]]\n",
            "between\n",
            "[[iftags -beta]]following[[/iftags]]\n",
            "root-after\n",
        );
        assert_eq!(
            resolve(source, &["alpha", "beta"], 3),
            concat!(
                "outer\n",
                "[[iftags +beta]]inner[[/iftags]]\n",
                "between\n",
                "[[iftags -beta]]following\n",
                "root-after\n",
            ),
        );
        assert_eq!(resolve(source, &["beta"], 3), "\nroot-after\n");
    }

    #[test]
    fn include_prepass_defers_openers_and_closer_until_the_sources_are_joined() {
        let tags = [Cow::Borrowed("alpha")];
        let mut preserved = CompatTextFragments::new("");
        let mut target = concat!(
            "target-before\n",
            "[[iftags +alpha]]outer\n",
            "[[iftags +beta]]inner\n",
            "target-end\n",
        )
        .to_owned();
        let mut caller_suffix = "caller-between\n[[/iftags]]\ncaller-after\n".to_owned();

        resolve_outermost_wikidot_iftags_before_include_expansion(
            &mut target,
            &tags,
            &mut preserved,
        );
        resolve_outermost_wikidot_iftags_before_include_expansion(
            &mut caller_suffix,
            &tags,
            &mut preserved,
        );
        assert!(target.contains("[[iftags +alpha]]"));
        assert!(caller_suffix.contains("[[/iftags]]"));

        let mut expanded = format!("{target}{caller_suffix}");
        resolve_outermost_wikidot_iftags(&mut expanded, &tags, &mut preserved);
        let expanded = preserved.restore(&expanded);
        assert_eq!(
            expanded,
            concat!(
                "target-before\n",
                "outer\n",
                "[[iftags +beta]]inner\n",
                "target-end\n",
                "caller-between\n\n",
                "caller-after\n",
            ),
        );
    }

    #[test]
    fn include_prepass_defers_eof_recovery_when_a_caller_closer_can_balance_the_root() {
        let tags = [Cow::Borrowed("alpha")];
        let mut preserved = CompatTextFragments::new("");
        let mut target =
            "[[iftags +alpha]]outer [[iftags +beta]]inner[[/iftags]]".to_owned();

        resolve_outermost_wikidot_iftags_before_include_expansion(
            &mut target,
            &tags,
            &mut preserved,
        );
        assert_eq!(
            target,
            "[[iftags +alpha]]outer [[iftags +beta]]inner[[/iftags]]",
        );

        target.push_str(" caller[[/iftags]] after");
        resolve_outermost_wikidot_iftags(&mut target, &tags, &mut preserved);
        let target = preserved.restore(&target);
        assert_eq!(
            target,
            "outer [[iftags +beta]]inner[[/iftags]] caller after",
        );
    }

    #[test]
    fn include_prepass_still_resolves_self_contained_balanced_gates() {
        let tags = [Cow::Borrowed("alpha")];
        let mut preserved = CompatTextFragments::new("");
        let mut source = concat!(
            "[[iftags -alpha]][[include hidden]][[/iftags]]\n",
            "[[include visible]]\n",
        )
        .to_owned();

        resolve_outermost_wikidot_iftags_before_include_expansion(
            &mut source,
            &tags,
            &mut preserved,
        );
        assert_eq!(source, "\n[[include visible]]\n");
    }

    #[test]
    fn unclosed_openers_and_extra_closers_remain_literal_across_passes() {
        let source = concat!(
            "[[/iftags]]\n",
            "[[iftags +alpha]]selected[[/iftags]]\n",
            "[[/iftags]]\n",
            "[[iftags -alpha]]unclosed\n",
            "[[iftags +beta]]repeated\n",
        );
        assert_eq!(
            resolve(source, &["alpha"], 3),
            concat!(
                "[[/iftags]]\n",
                "selected\n",
                "[[/iftags]]\n",
                "[[iftags -alpha]]unclosed\n",
                "[[iftags +beta]]repeated\n",
            ),
        );
    }

    #[test]
    fn skipped_opener_leaves_its_closer_raw_for_ftml_recovery() {
        // scp-744 (issues #2573/#2577, epoch 38): a backend gate whose
        // opener hides inside documentation while its closer scans. The
        // closer has no stack partner, but escaping it would freeze it as
        // authored text and blind the pinned FTML to a pair it still
        // resolves natively; with the closer raw the gate recovers and the
        // article body survives. A closer nothing opens prints literally
        // either way, so leaving it raw changes no evidenced output.
        let mut source = concat!(
            "[!-- documentation opens\n",
            "[[iftags +component-backend]]\n",
            "--]\n",
            "backend content\n",
            "[!-- documentation reopens\n",
            "[[/iftags]]\n",
            "\n",
            "article witness here\n",
        )
        .to_owned();
        let mut preserved = CompatTextFragments::new(&source);

        resolve_outermost_wikidot_iftags(&mut source, &[], &mut preserved);

        assert!(
            source.contains("[[/iftags]]"),
            "the unmatched closer must stay raw: {source:?}",
        );
        assert!(
            !source.contains(text_fragments::COMPAT_TEXT_MARKER_PREFIX),
            "no token may be escaped: {source:?}",
        );
        let restored = preserved.restore(&source);
        for witness in [
            "[[iftags +component-backend]]",
            "backend content",
            "[[/iftags]]",
            "article witness here",
        ] {
            assert!(
                restored.contains(witness),
                "shaped content must survive: {restored:?}",
            );
        }
    }

    #[test]
    fn final_pass_protects_unclosed_openers_before_ftml_recovery() {
        let mut source = concat!(
            "[[iftags +test]]\n",
            "[[div_ class=\"authorlink-wrapper\"]]\n",
            "Calibold",
        )
        .to_owned();
        let original = source.clone();
        let tags = [Cow::Borrowed("test")];
        let mut preserved = CompatTextFragments::new(&source);

        resolve_outermost_wikidot_iftags(&mut source, &tags, &mut preserved);

        assert_ne!(source, original);
        assert_eq!(preserved.restore(&source), original);
    }

    #[test]
    fn literal_region_tokens_do_not_change_pairing() {
        let source = concat!(
            "[[code]]\n[[iftags +alpha]]literal[[/iftags]]\n[[/code]]\n",
            "[[iftags +alpha]]active[[/iftags]]\n",
        );
        assert_eq!(
            resolve(source, &["alpha"], 1),
            concat!(
                "[[code]]\n[[iftags +alpha]]literal[[/iftags]]\n[[/code]]\n",
                "active\n",
            ),
        );
    }

    #[test]
    fn unmatched_inline_raw_does_not_hide_later_inactive_closer() {
        let source = concat!(
            "before\n",
            "[[iftags +component]]\n",
            "documentation\n",
            "* Escaping with @@\n",
            "[[/iftags]]\n",
            "after\n",
        );
        assert_eq!(resolve(source, &[], 1), "before\n\nafter\n");
    }

    #[test]
    fn unmatched_inline_raw_does_not_hide_later_active_closer() {
        let source = concat!(
            "[[iftags +component]]\n",
            "documentation\n",
            "* Escaping with @@\n",
            "[[/iftags]]\n",
        );
        assert_eq!(
            resolve(source, &["component"], 1),
            "\ndocumentation\n* Escaping with @@\n\n",
        );
    }

    #[test]
    fn unmatched_inline_raw_does_not_hide_same_line_inactive_closer() {
        let source =
            "before [[iftags +component]]documentation @@ prose [[/iftags]] after";
        assert_eq!(resolve(source, &[], 1), "before  after");
    }

    #[test]
    fn unmatched_inline_raw_does_not_hide_same_line_active_closer() {
        let source = "[[iftags +component]]documentation @@ prose [[/iftags]]";
        assert_eq!(
            resolve(source, &["component"], 1),
            "documentation @@ prose ",
        );
    }

    #[test]
    fn balanced_inline_raw_closer_does_not_close_active_gate() {
        let source = concat!(
            "[[iftags +component]]\n",
            "@@[[/iftags]]@@\n",
            "selected\n",
            "[[/iftags]]\n",
        );
        assert_eq!(
            resolve(source, &["component"], 1),
            "\n@@[[/iftags]]@@\nselected\n\n",
        );
    }

    #[test]
    fn block_literal_closer_does_not_close_active_gate() {
        let source = concat!(
            "[[iftags +component]]\n",
            "[[code]]\n[[/iftags]]\n[[/code]]\n",
            "selected\n",
            "[[/iftags]]\n",
        );
        assert_eq!(
            resolve(source, &["component"], 1),
            "\n[[code]]\n[[/iftags]]\n[[/code]]\nselected\n\n",
        );
    }

    #[test]
    fn inactive_gate_closes_before_unclosed_literal_blocks() {
        for (source, expected) in [
            (
                concat!(
                    "[[iftags +missing]]\n",
                    "[[code @=\"bad\"]]\n",
                    "[[/iftags]]\n",
                    "[[html]]\n",
                    "<b>malformed head</b>\n",
                    "[[/html]]",
                ),
                "\n[[html]]\n<b>malformed head</b>\n[[/html]]",
            ),
            (
                "[[iftags +missing]]\n[[raw]]\n[[/iftags]]\nunclosed raw",
                "\nunclosed raw",
            ),
            (
                concat!(
                    "[[iftags +missing]]\n",
                    "[[module Rate]]\n",
                    "[[html]]\n",
                    "<b>guarded</b>\n",
                    "[[/html]]\n",
                    "[[/iftags]]\n",
                    "visible",
                ),
                "\nvisible",
            ),
            (
                concat!(
                    "[[iftags +missing]]\n",
                    "[[module CSS]]\n",
                    "[[/iftags]]\n",
                    ".unclosed { color: red; }",
                ),
                "\n.unclosed { color: red; }",
            ),
            (
                concat!(
                    "[[iftags +missing]]\n",
                    "[[module ListPages]]\n",
                    "[[/iftags]]\n",
                    "unclosed module",
                ),
                "\nunclosed module",
            ),
        ] {
            assert_eq!(resolve(source, &[], 1), expected);
        }
    }

    #[test]
    fn inactive_gate_keeps_balanced_module_bodies_opaque() {
        for module in ["ListPages", "CSS"] {
            let source = format!(
                "[[iftags +missing]]\n[[module {module}]]\n[[/iftags]] raw-module\n[[/module]]\n[[html]]\n<b>guarded</b>\n[[/html]]\n[[/iftags]]\nvisible",
            );
            assert_eq!(resolve(&source, &[], 1), "\nvisible", "{module}");
        }
    }

    #[test]
    fn inactive_gate_closes_at_comment_and_raw_cross_boundaries() {
        let comment = concat!(
            "[[iftags +missing]]\n",
            "[!-- [[/iftags]] raw-comment --]\n",
            "[[html]]\n",
            "<b>guarded</b>\n",
            "[[/html]]\n",
            "[[/iftags]]\n",
            "visible",
        );
        assert_eq!(
            resolve(comment, &[], 1),
            concat!(
                " raw-comment --]\n",
                "[[html]]\n",
                "<b>guarded</b>\n",
                "[[/html]]\n",
                "[[/iftags]]\n",
                "visible",
            ),
        );

        let raw = concat!(
            "[[iftags +missing]]\n",
            "[[raw]]\n",
            "[[/iftags]]\n",
            "[[html]]raw-raw[[/html]]\n",
            "[[/raw]]\n",
            "[[html]]\n",
            "<b>guarded</b>\n",
            "[[/html]]\n",
            "[[/iftags]]\n",
            "visible",
        );
        assert_eq!(
            resolve(raw, &[], 1),
            concat!(
                "\n[[html]]raw-raw[[/html]]\n",
                "[[/raw]]\n",
                "[[html]]\n",
                "<b>guarded</b>\n",
                "[[/html]]\n",
                "[[/iftags]]\n",
                "visible",
            ),
        );
    }

    #[test]
    fn inactive_partially_nested_gate_leaves_following_html() {
        let source = concat!(
            "[[iftags +missing]]\n",
            "[[iftags +missing]]\n",
            "inner unclosed\n",
            "[[/iftags]]\n",
            "[[html]]\n",
            "<b>unclosed nested</b>\n",
            "[[/html]]",
        );
        assert_eq!(
            resolve(source, &[], 1),
            "\n[[html]]\n<b>unclosed nested</b>\n[[/html]]",
        );
    }

    #[test]
    fn special_inline_raw_run_does_not_hide_real_closer() {
        let source = "[[iftags +component]]@@@@@@[[/iftags]]@@";
        assert_eq!(resolve(source, &[], 1), "@@");
        assert_eq!(resolve(source, &["component"], 1), "@@@@@@@@");
    }

    #[test]
    fn pinned_url_adjacent_raw_delimiter_keeps_iftags_literal() {
        let source = "[[iftags +component]]https://e.test/a@@b[[/iftags]]@@tail";
        assert_eq!(resolve(source, &[], 1), source);
        assert_eq!(resolve(source, &["component"], 1), source);
    }

    #[test]
    fn raw_delimiter_in_tag_head_does_not_hide_real_closer() {
        let source = "[[iftags +x]][[div data=\"@@\"]]body[[/iftags]]@@tail";
        assert_eq!(resolve(source, &[], 1), "@@tail");
        assert_eq!(resolve(source, &["x"], 1), "[[div data=\"@@\"]]body@@tail",);
    }

    #[test]
    fn inactive_gate_closes_inside_comment_while_active_gate_preserves_it() {
        let source = "[[iftags +x]][!-- https://e.test/a--] [[/iftags]] --]";
        assert_eq!(resolve(source, &[], 1), " --]");
        assert_eq!(resolve(source, &["x"], 1), source);
    }

    #[test]
    fn malformed_block_closer_does_not_expose_conditional_closer() {
        let source = concat!(
            "[[iftags +x]][[code]]\n",
            "[[/code]]]\n[[/iftags]]\n",
            "[[/code]]\n[[/iftags]]",
        );
        assert_eq!(resolve(source, &[], 1), "");
        assert_eq!(
            resolve(source, &["x"], 1),
            "[[code]]\n[[/code]]]\n[[/iftags]]\n[[/code]]\n",
        );
    }

    #[test]
    fn preserved_nested_spec_is_html_escaped_for_late_restoration() {
        let source = "[[iftags +alpha]][[iftags \"<unsafe>&]]body[[/iftags]][[/iftags]]";
        assert_eq!(
            resolve(source, &["alpha"], 1),
            "[[iftags &quot;&lt;unsafe&gt;&amp;]]body[[/iftags]]",
        );
    }

    #[test]
    fn repeated_siblings_and_unclosed_openers_stay_within_linear_budget() {
        let mut source = String::new();
        for index in 0..10_000 {
            source.push_str(&format!("[[iftags +alpha]]selected-{index}[[/iftags]]\n"));
        }
        for _ in 0..10_000 {
            source.push_str("[[iftags +alpha]]");
        }
        let tags = [Cow::Borrowed("alpha")];
        let mut preserved = CompatTextFragments::new(&source);
        let started = Instant::now();
        resolve_outermost_wikidot_iftags(&mut source, &tags, &mut preserved);
        assert!(started.elapsed() < Duration::from_secs(2));
        source = preserved.restore(&source);
        assert_eq!(source.matches("selected-").count(), 10_000);
        assert_eq!(source.matches("[[iftags +alpha]]").count(), 10_000);

        let mut source = String::from("[[iftags +alpha]]");
        for _ in 0..10_000 {
            source.push_str("[[iftags +beta]]");
        }
        for _ in 0..9_999 {
            source.push_str("[[/iftags]]");
        }
        let mut preserved = CompatTextFragments::new(&source);
        let started = Instant::now();
        resolve_outermost_wikidot_iftags(&mut source, &tags, &mut preserved);
        assert!(started.elapsed() < Duration::from_secs(2));
        source = preserved.restore(&source);
        assert_eq!(source.matches("[[iftags +beta]]").count(), 10_000);
        assert_eq!(source.matches("[[/iftags]]").count(), 9_998);
    }

    #[test]
    fn inactive_literal_recovery_stays_within_linear_budget() {
        let mut source = String::from("[[iftags +missing]]");
        for _ in 0..20_000 {
            source.push_str("[[iftags +missing]]");
        }
        source.push_str("\n[!--");
        for _ in 0..20_000 {
            source.push_str("[[/iftags]]");
        }
        source.push_str("--]");

        let started = Instant::now();
        let resolved = resolve(&source, &[], 1);
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(resolved, "--]");
    }
}
