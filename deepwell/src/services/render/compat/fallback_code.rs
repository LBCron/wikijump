/*
 * services/render/compat/fallback_code.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use ftml::tree::CodeBlock;
use std::borrow::Cow;

const MAX_COMPAT_CODE_BLOCKS: usize = 4_096;
const MAX_CODE_LANGUAGE_BYTES: usize = 64;
const MAX_CODE_NAME_BYTES: usize = 255;

#[derive(Debug)]
pub(in crate::services::render) struct WikidotCompatibilityFallbackOutput {
    pub(in crate::services::render) body: String,
    pub(in crate::services::render) html_block_texts: Vec<String>,
    pub(in crate::services::render) code_blocks: Vec<CodeBlock<'static>>,
}

impl WikidotCompatibilityFallbackOutput {
    pub(in crate::services::render) fn body(body: String) -> Self {
        Self {
            body,
            html_block_texts: Vec::new(),
            code_blocks: Vec::new(),
        }
    }
}

#[derive(Clone, Copy, Default)]
pub(in crate::services::render) struct WikidotHtmlBlockEmission<'a> {
    pub owner_page_slug: Option<&'a str>,
    pub root_page_slug: Option<&'a str>,
    pub page_language: Option<&'a str>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(in crate::services::render) struct CompatCodeBlock {
    pub(in crate::services::render) start_line: usize,
    pub(in crate::services::render) end_line: usize,
    pub(in crate::services::render) language: Option<String>,
    pub(in crate::services::render) name: Option<String>,
    pub(in crate::services::render) contents: String,
    pub(in crate::services::render) comment_wrapped: bool,
}

impl CompatCodeBlock {
    pub(in crate::services::render) fn into_ftml(self) -> CodeBlock<'static> {
        CodeBlock {
            contents: Cow::Owned(self.contents),
            language: self.language.map(Cow::Owned),
            name: self.name.map(Cow::Owned),
        }
    }
}

pub(in crate::services::render) fn scan_compat_code_blocks(
    wikitext: &str,
) -> Result<Vec<CompatCodeBlock>, CompatCodeScanError> {
    let mut blocks = Vec::new();
    let mut open: Option<(usize, CodeMarker, String)> = None;

    for (line_index, line) in wikitext.lines().enumerate() {
        let trimmed = line.trim_start();
        if let Some((_, _, contents)) = &mut open {
            if is_code_close(trimmed) {
                let (start_line, marker, contents) = open.take().expect("open block");
                if blocks.len() == MAX_COMPAT_CODE_BLOCKS {
                    return Err(CompatCodeScanError);
                }
                blocks.push(CompatCodeBlock {
                    start_line,
                    end_line: line_index,
                    language: marker.language,
                    name: marker.name,
                    contents: contents.trim_end_matches('\n').to_owned(),
                    comment_wrapped: false,
                });
            } else if looks_like_code_open(trimmed) {
                return Err(CompatCodeScanError);
            } else {
                contents.push_str(line);
                contents.push('\n');
            }
        } else if looks_like_code_close(trimmed) {
            return Err(CompatCodeScanError);
        } else if looks_like_code_open(trimmed) {
            let marker = parse_code_open(trimmed).ok_or(CompatCodeScanError)?;
            open = Some((line_index, marker, String::new()));
        }
    }

    if open.is_some() {
        return Err(CompatCodeScanError);
    }
    Ok(blocks)
}

pub(in crate::services::render) fn mark_comment_wrapped_code_blocks(
    wikitext: &str,
    blocks: &mut [CompatCodeBlock],
) {
    if blocks.is_empty() {
        return;
    }

    let line_count = wikitext.lines().count();
    let mut code_span_lines = vec![false; line_count];
    for block in blocks.iter() {
        code_span_lines[block.start_line..=block.end_line].fill(true);
    }

    let mut starts_in_comment = vec![false; line_count];
    let mut in_comment = false;
    for (line_index, line) in wikitext.lines().enumerate() {
        starts_in_comment[line_index] = in_comment;
        if code_span_lines[line_index] {
            continue;
        }
        let mut rest = line;
        loop {
            if in_comment {
                match rest.find("--]") {
                    Some(at) => {
                        in_comment = false;
                        rest = &rest[at + "--]".len()..];
                    }
                    None => break,
                }
            } else if let Some(at) = rest.find("[!--") {
                in_comment = true;
                rest = &rest[at + "[!--".len()..];
            } else {
                break;
            }
        }
    }

    for block in blocks.iter_mut() {
        block.comment_wrapped = starts_in_comment[block.start_line];
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(in crate::services::render) struct CompatCodeScanError;

#[derive(Clone, Debug, Eq, PartialEq)]
struct CodeMarker {
    language: Option<String>,
    name: Option<String>,
}

fn looks_like_code_open(marker: &str) -> bool {
    let Some(prefix) = marker.get(..6) else {
        return false;
    };
    if !prefix.eq_ignore_ascii_case("[[code") {
        return false;
    }
    let Some(rest) = marker.get(6..) else {
        return false;
    };
    rest.starts_with("]]") || rest.starts_with(char::is_whitespace)
}

fn looks_like_code_close(marker: &str) -> bool {
    marker
        .get(..9)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("[[/code]]"))
        && marker[9..].trim().is_empty()
}

fn is_code_close(marker: &str) -> bool {
    looks_like_code_close(marker)
}

fn parse_code_open(marker: &str) -> Option<CodeMarker> {
    let inner = marker.strip_prefix("[[")?.strip_suffix("]]")?;
    parse_code_open_inner(inner)
}

fn parse_code_open_inner(inner: &str) -> Option<CodeMarker> {
    let mut rest = inner.trim();
    if !rest.get(..4)?.eq_ignore_ascii_case("code") {
        return None;
    }
    rest = &rest[4..];
    if !rest.is_empty() && !rest.starts_with(char::is_whitespace) {
        return None;
    }

    let mut marker = CodeMarker {
        language: None,
        name: None,
    };
    while !rest.trim_start().is_empty() {
        rest = rest.trim_start();
        let equals = rest.find('=')?;
        let key = rest[..equals].trim();
        if key.is_empty() || key.chars().any(char::is_whitespace) {
            return None;
        }
        rest = &rest[equals + 1..];
        let quote = rest.as_bytes().first().copied()?;
        if quote != b'"' && quote != b'\'' {
            return None;
        }
        rest = &rest[1..];
        let end = rest.find(char::from(quote))?;
        let value = &rest[..end];
        rest = &rest[end + 1..];

        if key.eq_ignore_ascii_case("type") {
            if marker.language.is_some()
                || value.is_empty()
                || value.len() > MAX_CODE_LANGUAGE_BYTES
            {
                return None;
            }
            marker.language = Some(value.to_owned());
        } else if key.eq_ignore_ascii_case("name") {
            if marker.name.is_some()
                || value.is_empty()
                || value.len() > MAX_CODE_NAME_BYTES
            {
                return None;
            }
            marker.name = Some(value.to_owned());
        }
    }
    Some(marker)
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_COMPAT_CODE_BLOCKS, mark_comment_wrapped_code_blocks, scan_compat_code_blocks,
    };

    fn marked(source: &str) -> Vec<bool> {
        let mut blocks = scan_compat_code_blocks(source).unwrap();
        mark_comment_wrapped_code_blocks(source, &mut blocks);
        blocks
            .iter()
            .map(|block| block.comment_wrapped)
            .collect::<Vec<_>>()
    }

    #[test]
    fn preserves_multiple_blocks_and_source_order() {
        let blocks = scan_compat_code_blocks(concat!(
            "before\n[[code type=\"css\" name=\"theme\"]]\na{}\n[[/code]]\n",
            "[[html]]mixed[[/html]]\n[[CODE TYPE='JavaScript']]\nb();\n[[/CODE]]\n",
        ))
        .unwrap();
        assert_eq!(blocks.len(), 2);
        assert_eq!((blocks[0].start_line, blocks[0].end_line), (1, 3));
        assert_eq!((blocks[1].start_line, blocks[1].end_line), (5, 7));
        assert_eq!(blocks[0].name.as_deref(), Some("theme"));
        assert_eq!(blocks[1].language.as_deref(), Some("JavaScript"));
    }

    #[test]
    fn marker_text_inside_code_is_content_unless_it_is_an_exact_closer() {
        let blocks = scan_compat_code_blocks(
            "[[code]]\nconst marker = '[[/code]] trailing';\n[[/code]]\n",
        )
        .unwrap();
        assert_eq!(blocks[0].contents, "const marker = '[[/code]] trailing';");

        let blocks = scan_compat_code_blocks("[[code]]\nx\n[[/CODE]]  \t\n").unwrap();
        assert_eq!(blocks[0].contents, "x");
    }

    #[test]
    fn malformed_or_unbalanced_markers_fail_closed() {
        for source in [
            "[[code]\nbody\n[[/code]]\n",
            "[[code]]\nbody\n",
            "[[/code]]\n",
            "[[code type=css]]\nbody\n[[/code]]\n",
            "[[code]]\n[[code]]\n[[/code]]\n",
        ] {
            let original = source.to_owned();
            assert!(scan_compat_code_blocks(source).is_err(), "{source:?}");
            assert_eq!(source, original);
        }
    }

    #[test]
    fn nearby_tokens_do_not_discard_later_code_metadata() {
        let source = concat!(
            "[[codex]] is prose\n",
            "[[code-example]] is also prose\n",
            "[[code type=\"css\" name=\"theme\"]]\n",
            ".x {}\n",
            "[[/code]]\n",
        );
        let blocks = scan_compat_code_blocks(source).unwrap();
        assert_eq!(blocks.len(), 1);
        assert_eq!(blocks[0].language.as_deref(), Some("css"));
        assert_eq!(blocks[0].name.as_deref(), Some("theme"));
        assert_eq!(blocks[0].contents, ".x {}");
    }

    #[test]
    fn duplicate_invalid_and_oversized_metadata_fail_closed() {
        let long_name = "x".repeat(256);
        for source in [
            "[[code type=\"css\" TYPE=\"js\"]]\nx\n[[/code]]".to_owned(),
            "[[code name=\"\"]]\nx\n[[/code]]".to_owned(),
            format!("[[code name=\"{long_name}\"]]\nx\n[[/code]]"),
        ] {
            assert!(scan_compat_code_blocks(&source).is_err(), "{source:?}");
        }
    }

    #[test]
    fn comment_wrapped_blocks_are_flagged_in_source_order() {
        let source = concat!(
            "[!--\n[[code type=\"css\"]]\na{}\n[[/code]]\n",
            "[[code type=\"css\"]]\nb{}\n[[/code]]\n--]\n",
            "[[code]]\nvisible\n[[/code]]\n",
        );
        assert_eq!(marked(source), [true, true, false]);
    }

    #[test]
    fn comment_markers_inside_code_contents_do_not_open_comments() {
        let source = concat!(
            "[[code]]\nvar s = \"[!-- not a comment\";\n[[/code]]\n",
            "[[code]]\nvisible\n[[/code]]\n",
        );
        assert_eq!(marked(source), [false, false]);
    }

    #[test]
    fn unclosed_comment_wraps_through_the_end_of_the_source() {
        let source = concat!(
            "[[code]]\nvisible\n[[/code]]\n",
            "[!--\n[[code]]\nhidden\n[[/code]]\n",
        );
        assert_eq!(marked(source), [false, true]);
    }

    #[test]
    fn closed_comments_and_stray_closers_do_not_wrap_later_blocks() {
        let source = "[!-- note --] stray --]\n[[code]]\nvisible\n[[/code]]\n";
        assert_eq!(marked(source), [false]);
    }

    #[test]
    fn several_comments_each_wrap_their_blocks() {
        let source = concat!(
            "[!--\n[[code]]\na\n[[/code]]\n--]\nbetween\n",
            "[!--\n[[code]]\nb\n[[/code]]\n--]\n",
        );
        assert_eq!(marked(source), [true, true]);
    }

    #[test]
    fn comment_closers_inside_code_contents_do_not_close_comments() {
        let source = concat!(
            "[[code]]\nvar s = \"--]\";\n[[/code]]\n",
            "[!--\n[[code]]\nhidden\n[[/code]]\n--]\n",
        );
        assert_eq!(marked(source), [false, true]);
    }

    #[test]
    fn evidenced_comment_sources_are_flagged() {
        let nav = concat!(
            "[[iframe https://scp-jp.wdfiles.com/local--code/nav:interwiki-c404/1]]\n",
            "[!--\n",
            "[[code type=\"html\"]]\n",
            "<head>\n",
            "<!-- C-take's resizing iframe method -->\n",
            "<script src=\"https://scp-jp.wdfiles.com/local--code/nav:interwiki-c404/2\"></script>\n",
            "</head>\n",
            "[[/code]]\n",
            "\n",
            "[[code type=\"JavaScript\"]]\n",
            "// https://shitake-crude-production.wikidot.com/abbreviation-library\n",
            "window._abb = {};\n",
            "[[/code]]\n",
            "--]\n",
        );
        let mut blocks = scan_compat_code_blocks(nav).unwrap();
        mark_comment_wrapped_code_blocks(nav, &mut blocks);
        assert_eq!(
            blocks
                .iter()
                .map(|block| block.comment_wrapped)
                .collect::<Vec<_>>(),
            [true, true],
        );
        assert!(blocks[0].contents.starts_with("<head>"));
        assert_eq!(blocks[0].language.as_deref(), Some("html"));
        assert_eq!(blocks[1].language.as_deref(), Some("JavaScript"));

        let shushuin = concat!(
            "[!--\n[[code type=\"css\"]]\n",
            "@import url('https://fonts.googleapis.com/css?family=Noto+Serif+JP');\n/*header*/\n",
            "[[/code]]\n--]\n",
            "[!--\n[[code type=\"css\"]]\n",
            "@import url('https://fonts.googleapis.com/css?family=Noto+Serif+JP');\n.shushuInner {\n",
            "[[/code]]\n--]\n",
            "[!--\n[[code type=\"css\"]]\nh1, #page-title {\n[[/code]]\n--]\n",
        );
        assert_eq!(marked(shushuin), [true, true, true]);
    }

    #[test]
    fn maximum_block_count_is_bounded() {
        let at_limit = "[[code]]\nx\n[[/code]]\n".repeat(MAX_COMPAT_CODE_BLOCKS);
        assert_eq!(
            scan_compat_code_blocks(&at_limit).unwrap().len(),
            MAX_COMPAT_CODE_BLOCKS
        );
        let over_limit = format!("{at_limit}[[code]]\nx\n[[/code]]\n");
        assert!(scan_compat_code_blocks(&over_limit).is_err());
    }
}
