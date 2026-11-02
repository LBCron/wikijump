/*
 * services/render/literal_regions/block_candidates/generic_heads.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::HeadContext;
use crate::services::render::literal_regions::token_boundaries::{
    TextTokenCursor, TextTokenIndex, WikidotTagScan, WikidotWholeHeadScan,
    left_block_start_in_run, right_bracket_token, scan_wikidot_tag,
    scan_wikidot_whole_head_value, wikidot_trimmed_name,
};
use std::ops::Range;

const WHOLE_HEAD_SCAN_WORK_LIMIT_MULTIPLIER: usize = 8;
#[cfg(test)]
const MAX_WHOLE_HEAD_SCAN_WORK_MULTIPLIER: usize =
    WHOLE_HEAD_SCAN_WORK_LIMIT_MULTIPLIER + 1;

const WHOLE_VALUE_BLOCK_NAMES: &[&str] = &[
    "anchortarget",
    "bibcite",
    "char",
    "character",
    "equation",
    "eqref",
    "eref",
    "ifcategory",
    "iftags",
    "lines",
    "math",
    "newlines",
    "rb",
    "ruby2",
    "size",
    "tab",
    "target",
    "user",
];

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::services::render::literal_regions) enum RuntimeModuleHeadCandidate {
    Exact(Range<usize>),
    RecoveryBarrier(Range<usize>),
}

pub(in crate::services::render::literal_regions) struct HeadCandidateStreams {
    pub(in crate::services::render::literal_regions) generic:
        Vec<RuntimeModuleHeadCandidate>,
    pub(in crate::services::render::literal_regions) runtime_modules:
        Vec<RuntimeModuleHeadCandidate>,
    pub(in crate::services::render::literal_regions) work_limit_exceeded: bool,
    pub(in crate::services::render::literal_regions) whole_head_scan_work: usize,
}

impl HeadCandidateStreams {
    fn oversized_or_exhausted(whole_head_scan_work: usize) -> Self {
        Self {
            generic: Vec::new(),
            runtime_modules: Vec::new(),
            work_limit_exceeded: true,
            whole_head_scan_work,
        }
    }
}

#[cfg(test)]
pub(in crate::services::render::literal_regions) fn collect_generic_head_candidates(
    source: &str,
) -> Vec<Range<usize>> {
    if source.len() >= u32::MAX as usize {
        return Vec::new();
    }
    let heads = HeadContext::new(source);
    collect_head_candidate_streams_with_heads(source, &heads)
        .generic
        .into_iter()
        .filter_map(|candidate| match candidate {
            RuntimeModuleHeadCandidate::Exact(range) => Some(range),
            RuntimeModuleHeadCandidate::RecoveryBarrier(_) => None,
        })
        .collect()
}

pub(in crate::services::render::literal_regions) fn collect_head_candidate_streams(
    source: &str,
) -> HeadCandidateStreams {
    if source.len() >= u32::MAX as usize {
        return HeadCandidateStreams::oversized_or_exhausted(0);
    }
    let text_tokens = TextTokenIndex::new(source);
    let heads = HeadContext::new_with_text_tokens(source, &text_tokens);
    collect_head_candidate_streams_with_context(source, &heads, &text_tokens)
}

#[cfg(test)]
pub(in crate::services::render::literal_regions) fn collect_head_candidate_streams_with_heads(
    source: &str,
    heads: &HeadContext,
) -> HeadCandidateStreams {
    let text_tokens = TextTokenIndex::new(source);
    collect_head_candidate_streams_with_context(source, heads, &text_tokens)
}

pub(in crate::services::render::literal_regions) fn collect_head_candidate_streams_with_context(
    source: &str,
    heads: &HeadContext,
    text_tokens: &TextTokenIndex,
) -> HeadCandidateStreams {
    let bytes = source.as_bytes();
    let mut text_tokens = text_tokens.cursor();
    let mut generic = Vec::new();
    let mut runtime_modules = Vec::new();
    let whole_head_scan_work_limit = source
        .len()
        .saturating_mul(WHOLE_HEAD_SCAN_WORK_LIMIT_MULTIPLIER);
    let mut whole_head_scan_work = 0usize;
    let mut cursor = 0usize;
    while let Some(relative) = source[cursor..].find("[[") {
        let candidate = cursor + relative;
        let (block_start, run_end) = left_block_start_in_run(bytes, candidate);
        cursor = candidate + 1;
        if block_start != Some(candidate)
            || text_tokens.advance_and_contains(candidate)
            || matches!(bytes.get(candidate + 2), Some(b'/' | b'#' | b'$'))
        {
            cursor = cursor.max(run_end);
            continue;
        }

        let mut name_start = candidate + 2;
        let starred = bytes.get(name_start) == Some(&b'*');
        name_start += usize::from(starred);
        name_start = skip_horizontal(bytes, name_start);
        let (Some(name), name_end) = wikidot_trimmed_name(bytes, name_start) else {
            continue;
        };
        let name = name.strip_suffix(b"_").unwrap_or(name);
        if !starred
            && (name.eq_ignore_ascii_case(b"module")
                || name.eq_ignore_ascii_case(b"module654"))
            && let Some(subname_start) = skip_name_delimiter(bytes, name_end)
        {
            let (subname, subname_end) = wikidot_trimmed_name(bytes, subname_start);
            if subname.is_some_and(|subname| {
                subname.eq_ignore_ascii_case(b"ListPages")
                    || subname.eq_ignore_ascii_case(b"CountPages")
            }) {
                if name.eq_ignore_ascii_case(b"module")
                    && subname
                        .is_some_and(|subname| subname.eq_ignore_ascii_case(b"ListPages"))
                    && let Some(end) =
                        documented_list_pages_placeholder_end(bytes, subname_end)
                {
                    runtime_modules
                        .push(RuntimeModuleHeadCandidate::Exact(candidate..end));
                    continue;
                }
                let mut target_tokens = text_tokens.clone();
                match scan_wikidot_tag(
                    bytes,
                    candidate,
                    bytes.len(),
                    true,
                    false,
                    &mut target_tokens,
                ) {
                    WikidotTagScan::Complete(end) => runtime_modules
                        .push(RuntimeModuleHeadCandidate::Exact(candidate..end)),
                    WikidotTagScan::Malformed { .. } | WikidotTagScan::Unclosed => {
                        runtime_modules.push(
                            RuntimeModuleHeadCandidate::RecoveryBarrier(
                                candidate..physical_line_resume(bytes, candidate),
                            ),
                        );
                    }
                }
                continue;
            }
        }
        let recognized = is_name_map_block(name)
            || is_whole_value_block(name)
            || is_no_head_block(name)
            || is_map_block(name);
        let end = if is_name_map_block(name) {
            name_map_end(bytes, name, name_end, heads)
        } else if is_whole_value_block(name) {
            let (end, examined) = whole_value_end(bytes, name_end, &mut text_tokens);
            whole_head_scan_work = whole_head_scan_work.saturating_add(examined);
            if whole_head_scan_work > whole_head_scan_work_limit {
                return HeadCandidateStreams::oversized_or_exhausted(
                    whole_head_scan_work,
                );
            }
            end
        } else if is_no_head_block(name) {
            no_head_end(bytes, name_end)
        } else if is_map_block(name) {
            map_end(heads, name_end)
        } else {
            None
        };
        if recognized && (!starred || accepts_star(name)) {
            if let Some(end) = end {
                generic.push(RuntimeModuleHeadCandidate::Exact(candidate..end));
            } else if !name.eq_ignore_ascii_case(b"module")
                && !name.eq_ignore_ascii_case(b"module654")
            {
                generic.push(RuntimeModuleHeadCandidate::RecoveryBarrier(
                    candidate..physical_line_resume(bytes, candidate),
                ));
            }
        }
    }
    HeadCandidateStreams {
        generic,
        runtime_modules,
        work_limit_exceeded: false,
        whole_head_scan_work,
    }
}

fn documented_list_pages_placeholder_end(
    bytes: &[u8],
    subname_end: usize,
) -> Option<usize> {
    let start = skip_horizontal(bytes, subname_end);
    if start == subname_end {
        return None;
    }
    for placeholder in ["属性..."] {
        let mut end = start + placeholder.len();
        if bytes.get(start..end) != Some(placeholder.as_bytes()) {
            continue;
        }
        end = skip_horizontal(bytes, end);
        if bytes.get(end..end + 2) == Some(&b"]]"[..]) {
            return Some(end + 2);
        }
    }
    None
}

fn physical_line_resume(bytes: &[u8], start: usize) -> usize {
    let mut cursor = start;
    while !matches!(bytes.get(cursor), None | Some(b'\n' | b'\r')) {
        cursor += 1;
    }
    match bytes.get(cursor) {
        Some(b'\r') if bytes.get(cursor + 1) == Some(&b'\n') => cursor + 2,
        Some(b'\n' | b'\r') => cursor + 1,
        _ => cursor,
    }
}

fn map_end(heads: &HeadContext, start: usize) -> Option<usize> {
    heads.map_end(start)
}

fn name_map_end(
    bytes: &[u8],
    name: &[u8],
    mut cursor: usize,
    heads: &HeadContext,
) -> Option<usize> {
    cursor = skip_name_delimiter(bytes, cursor)?;
    let (subname, subname_end) = wikidot_trimmed_name(bytes, cursor);
    let subname = subname?;
    if (name.eq_ignore_ascii_case(b"module") || name.eq_ignore_ascii_case(b"module654"))
        && (subname.eq_ignore_ascii_case(b"ListPages")
            || subname.eq_ignore_ascii_case(b"CountPages"))
    {
        return None;
    }
    map_end(heads, subname_end)
}

fn whole_value_end(
    bytes: &[u8],
    name_end: usize,
    text_tokens: &mut TextTokenCursor,
) -> (Option<usize>, usize) {
    let scan = scan_wikidot_whole_head_value(bytes, name_end, bytes.len(), text_tokens);
    let examined_end = match scan {
        WikidotWholeHeadScan::Complete { end, .. } => end,
        WikidotWholeHeadScan::Malformed { resume, .. } => resume,
        WikidotWholeHeadScan::Unclosed { .. } => bytes.len(),
    };
    let end = match scan {
        WikidotWholeHeadScan::Complete { end, .. } => Some(end),
        WikidotWholeHeadScan::Malformed { .. }
        | WikidotWholeHeadScan::Unclosed { .. } => None,
    };
    (end, examined_end.saturating_sub(name_end))
}

fn no_head_end(bytes: &[u8], mut cursor: usize) -> Option<usize> {
    cursor = skip_argument_spacing(bytes, cursor);
    let (right_block, token_len) = right_bracket_token(bytes, cursor, bytes.len());
    right_block.then_some(cursor + token_len)
}

fn skip_horizontal(bytes: &[u8], mut cursor: usize) -> usize {
    while matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
        cursor += 1;
    }
    cursor
}

fn skip_argument_spacing(bytes: &[u8], mut cursor: usize) -> usize {
    loop {
        cursor = skip_horizontal(bytes, cursor);
        match bytes.get(cursor) {
            Some(b'\r') if bytes.get(cursor + 1) == Some(&b'\n') => cursor += 2,
            Some(b'\r' | b'\n') => cursor += 1,
            _ => return cursor,
        }
    }
}

fn skip_name_delimiter(bytes: &[u8], cursor: usize) -> Option<usize> {
    match bytes.get(cursor) {
        Some(b' ' | b'\t') => Some(skip_horizontal(bytes, cursor)),
        Some(b'\r' | b'\n') => Some(skip_argument_spacing(bytes, cursor)),
        _ => None,
    }
}

fn is_name_map_block(name: &[u8]) -> bool {
    matches_name(
        name,
        &[
            "audio",
            "date",
            "embed",
            "iframe",
            "image",
            "=image",
            "<image",
            ">image",
            "f<image",
            "f>image",
            "include-elements",
            "module",
            "module654",
            "radio",
            "radio-button",
            "video",
        ],
    )
}

fn is_whole_value_block(name: &[u8]) -> bool {
    matches_name(name, WHOLE_VALUE_BLOCK_NAMES)
}

fn is_no_head_block(name: &[u8]) -> bool {
    matches_name(name, &["footnote", "later", "tabview", "tabs"])
}

fn is_map_block(name: &[u8]) -> bool {
    matches_name(
        name,
        &[
            "a",
            "anchor",
            "b",
            "bibliography",
            "blockquote",
            "bold",
            "cell",
            "checkbox",
            "code",
            "collapsible",
            "del",
            "deletion",
            "div",
            "em",
            "emphasis",
            "footnoteblock",
            "hcell",
            "hidden",
            "highlight",
            "html",
            "i",
            "include",
            "ins",
            "insertion",
            "invisible",
            "italics",
            "li",
            "mark",
            "mono",
            "monospace",
            "ol",
            "p",
            "paragraph",
            "quote",
            "raw",
            "row",
            "ruby",
            "s",
            "span",
            "strikethrough",
            "strong",
            "sub",
            "subscript",
            "sup",
            "super",
            "superscript",
            "table",
            "toc",
            "f<toc",
            "f>toc",
            "tt",
            "u",
            "ul",
            "underline",
        ],
    )
}

fn accepts_star(name: &[u8]) -> bool {
    matches_name(
        name,
        &["a", "anchor", "image", "=image", "<image", ">image"],
    )
}

fn matches_name(name: &[u8], accepted: &[&str]) -> bool {
    accepted
        .iter()
        .any(|accepted| name.eq_ignore_ascii_case(accepted.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_WHOLE_HEAD_SCAN_WORK_MULTIPLIER, RuntimeModuleHeadCandidate,
        WHOLE_VALUE_BLOCK_NAMES, collect_generic_head_candidates,
        collect_head_candidate_streams, documented_list_pages_placeholder_end,
    };

    #[test]
    fn complete_known_heads_own_only_their_head() {
        let source = "[[span title=\"[[module ListPages name='hidden']]\"]] tail";
        assert_eq!(
            collect_generic_head_candidates(source),
            vec![0..source.find(" tail").unwrap()]
        );
    }

    #[test]
    fn runtime_module_heads_do_not_mask_themselves() {
        for name in ["ListPages", "CountPages"] {
            let source = format!("[[module {name} name=\"live\"]]");
            assert!(collect_generic_head_candidates(&source).is_empty());
        }
    }

    #[test]
    fn exact_documented_list_pages_placeholder_is_a_runtime_head() {
        let source = "[[module ListPages 属性...]]";
        assert_eq!(
            collect_head_candidate_streams(source).runtime_modules,
            vec![RuntimeModuleHeadCandidate::Exact(0..source.len())],
        );
        for unsupported in [
            "[[module ListPages 属性..]]",
            "[[module ListPages 任意...]]",
            "[[module ListPages 属性... 额外]]",
        ] {
            assert!(
                documented_list_pages_placeholder_end(
                    unsupported.as_bytes(),
                    "[[module ListPages".len(),
                )
                .is_none(),
                "{unsupported:?}",
            );
        }
    }

    #[test]
    fn unknown_and_malformed_heads_roll_back() {
        for source in [
            "[[unknown value=\"x\"]]",
            "[[span title='x']]",
            "[[span title=\"unterminated]]",
        ] {
            assert!(
                collect_generic_head_candidates(source).is_empty(),
                "{source:?}"
            );
        }
    }

    #[test]
    fn repeated_unclosed_whole_heads_exhaust_a_linear_work_budget() {
        const HEADS: usize = 4_096;
        for name in WHOLE_VALUE_BLOCK_NAMES {
            let heads = format!("[[{name} listpages ").repeat(HEADS);
            let source = format!("[[module ListPages]]{heads}");
            let streams = collect_head_candidate_streams(&source);

            assert!(streams.work_limit_exceeded, "{name}");
            assert!(streams.generic.is_empty(), "{name}");
            assert!(streams.runtime_modules.is_empty(), "{name}");
            assert!(
                streams.whole_head_scan_work
                    > source.len() * super::WHOLE_HEAD_SCAN_WORK_LIMIT_MULTIPLIER,
                "{name}: work limit was not exercised",
            );
            assert!(
                streams.whole_head_scan_work
                    <= source.len() * MAX_WHOLE_HEAD_SCAN_WORK_MULTIPLIER,
                "{name}: {} work for {} source bytes",
                streams.whole_head_scan_work,
                source.len(),
            );
        }
    }

    #[test]
    fn dense_terminated_whole_heads_preserve_candidate_collection() {
        const HEADS: usize = 512;
        for name in WHOLE_VALUE_BLOCK_NAMES {
            let heads = format!("[[{name} value]]\n").repeat(HEADS);
            let source = format!("[[module ListPages]]\n{heads}");
            let streams = collect_head_candidate_streams(&source);

            assert!(!streams.work_limit_exceeded, "{name}");
            assert_eq!(streams.generic.len(), HEADS, "{name}");
            assert_eq!(streams.runtime_modules.len(), 1, "{name}");
            assert!(
                streams.whole_head_scan_work <= source.len(),
                "{name}: {} work for {} source bytes",
                streams.whole_head_scan_work,
                source.len(),
            );
        }
    }
}
