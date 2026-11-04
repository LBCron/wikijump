/*
 * services/render/compat/hosted_code.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::fallback_code::CompatCodeBlock;
use crate::error::prelude::Result;
use crate::models::site::Model as SiteModel;
use crate::services::ServiceContext;
use crate::services::render::RenderService;
use crate::services::text_block::{TextBlock, TextBlockService, mime_for_language};
use crate::types::TextBlockType;
use ftml::tree::CodeBlock;

pub(in crate::services::render) async fn persist_hosted_code_blocks(
    ctx: &ServiceContext<'_>,
    page_id: i64,
    code_blocks: &[CodeBlock<'_>],
    hosted_code_source: Option<&[CompatCodeBlock]>,
    current_site: Option<&SiteModel>,
    include_comment_blocks: bool,
) -> Result<()> {
    let config = ctx.config();
    let localize = |code: &str| {
        RenderService::restore_wikidot_code_block_compatibility(
            code,
            current_site,
            config,
        )
    };
    let comment_source = include_comment_blocks
        .then_some(hosted_code_source)
        .flatten()
        .filter(|raw| raw.iter().any(|block| block.comment_wrapped))
        .filter(|raw| visible_scan_blocks_render_in_order(code_blocks, raw, &localize));
    let owned = match comment_source {
        Some(raw) => merged_hosted_code_blocks(code_blocks, raw, localize)
            .into_iter()
            .map(|block| OwnedHostedCodeBlock {
                text: block.text,
                language: block.language,
                name: block.name,
            })
            .collect::<Vec<_>>(),
        None => {
            let rendered = code_blocks
                .iter()
                .map(|block| block.contents.as_ref())
                .collect::<Vec<_>>();
            let hosted_texts = hosted_code_texts(&rendered, hosted_code_source, localize);
            code_blocks
                .iter()
                .zip(&hosted_texts)
                .map(
                    |(CodeBlock { language, name, .. }, text)| OwnedHostedCodeBlock {
                        text: text.clone(),
                        language: language.as_deref().map(str::to_owned),
                        name: name.as_deref().map(str::to_owned),
                    },
                )
                .collect::<Vec<_>>()
        }
    };
    let blocks = owned
        .iter()
        .map(|block| TextBlock {
            text: &block.text,
            text_type: block.language.as_deref(),
            mime: mime_for_language(&block.language),
            name: block.name.as_deref(),
        })
        .collect::<Vec<_>>();
    TextBlockService::add_blocks(ctx, page_id, TextBlockType::Code, &blocks).await
}

struct OwnedHostedCodeBlock {
    text: String,
    language: Option<String>,
    name: Option<String>,
}

fn visible_scan_blocks_render_in_order(
    rendered: &[CodeBlock<'_>],
    raw: &[CompatCodeBlock],
    localize: &impl Fn(&str) -> String,
) -> bool {
    let rendered_keys = rendered
        .iter()
        .map(|block| rendered_code_key(&block.contents))
        .collect::<Vec<_>>();
    let mut cursor = 0;
    for block in raw.iter().filter(|block| !block.comment_wrapped) {
        let key = rendered_code_key(&localize(&block.contents));
        match (cursor..rendered_keys.len()).find(|&index| rendered_keys[index] == key) {
            Some(found) => cursor = found + 1,
            None => return false,
        }
    }
    true
}

#[derive(Debug, Eq, PartialEq)]
struct MergedHostedCodeBlock {
    text: String,
    language: Option<String>,
    name: Option<String>,
}

fn merged_hosted_code_blocks<F>(
    rendered: &[CodeBlock<'_>],
    raw: &[CompatCodeBlock],
    localize: F,
) -> Vec<MergedHostedCodeBlock>
where
    F: Fn(&str) -> String,
{
    let rendered_keys = rendered
        .iter()
        .map(|block| rendered_code_key(&block.contents))
        .collect::<Vec<_>>();
    let raw_keys = raw
        .iter()
        .map(|block| rendered_code_key(&localize(&block.contents)))
        .collect::<Vec<_>>();

    let mut anchor = vec![None; raw.len()];
    let mut claimed = vec![false; rendered.len()];
    let mut cursor = 0;
    for (index, block) in raw.iter().enumerate() {
        if block.comment_wrapped {
            continue;
        }
        if let Some(found) = (cursor..rendered.len())
            .find(|&j| !claimed[j] && rendered_keys[j] == raw_keys[index])
        {
            anchor[index] = Some(found);
            claimed[found] = true;
            cursor = found + 1;
        }
    }
    for (index, block) in raw.iter().enumerate() {
        if !block.comment_wrapped {
            continue;
        }
        let lower = anchor[..index].iter().flatten().copied().max();
        let upper = anchor[index + 1..].iter().flatten().copied().min();
        if let Some(found) = (0..rendered.len()).find(|&j| {
            !claimed[j]
                && rendered_keys[j] == raw_keys[index]
                && lower.is_none_or(|low| j > low)
                && upper.is_none_or(|high| j < high)
        }) {
            anchor[index] = Some(found);
            claimed[found] = true;
        }
    }

    let visible = raw
        .iter()
        .filter(|block| !block.comment_wrapped)
        .cloned()
        .collect::<Vec<_>>();
    let rendered_contents = rendered
        .iter()
        .map(|block| block.contents.as_ref())
        .collect::<Vec<_>>();
    let rendered_texts = hosted_code_texts(&rendered_contents, Some(&visible), &localize);

    let mut merged = Vec::new();
    let mut next_rendered = 0;
    for (index, block) in raw.iter().enumerate() {
        match anchor[index] {
            Some(found) => {
                while next_rendered <= found {
                    merged.push(MergedHostedCodeBlock {
                        text: rendered_texts[next_rendered].clone(),
                        language: rendered[next_rendered]
                            .language
                            .as_deref()
                            .map(str::to_owned),
                        name: rendered[next_rendered].name.as_deref().map(str::to_owned),
                    });
                    next_rendered += 1;
                }
            }
            None if block.comment_wrapped => {
                merged.push(MergedHostedCodeBlock {
                    text: wikidot_hosted_code(&localize(&block.contents)),
                    language: block.language.clone(),
                    name: block.name.clone(),
                });
            }
            None => {}
        }
    }
    while next_rendered < rendered.len() {
        merged.push(MergedHostedCodeBlock {
            text: rendered_texts[next_rendered].clone(),
            language: rendered[next_rendered]
                .language
                .as_deref()
                .map(str::to_owned),
            name: rendered[next_rendered].name.as_deref().map(str::to_owned),
        });
        next_rendered += 1;
    }
    merged
}

pub(in crate::services::render) fn hosted_code_texts<F>(
    rendered: &[&str],
    raw: Option<&[CompatCodeBlock]>,
    localize: F,
) -> Vec<String>
where
    F: Fn(&str) -> String,
{
    let raw = raw.filter(|raw| raw.len() == rendered.len());
    rendered
        .iter()
        .enumerate()
        .map(|(index, rendered)| {
            let source = raw.and_then(|raw| {
                let localized = localize(&raw[index].contents);
                let renders_the_same =
                    rendered_code_key(&localized) == rendered_code_key(rendered);
                renders_the_same.then_some(localized)
            });
            wikidot_hosted_code(source.as_deref().unwrap_or(rendered))
        })
        .collect()
}

fn wikidot_hosted_code(body: &str) -> String {
    let mut hosted = body.trim_matches('\n').to_owned();
    hosted.push('\n');
    hosted
}

fn rendered_code_key(body: &str) -> String {
    let mut lines = Vec::new();
    let mut blank_run = false;
    for line in body.split('\n') {
        let mut normalized = String::with_capacity(line.len());
        for character in line.chars() {
            match character {
                '\t' => normalized.push_str("    "),
                '\u{00a0}' => normalized.push(' '),
                character if is_wikidot_discarded_control(character) => {}
                character => normalized.push(character),
            }
        }
        if normalized.trim_matches(' ').is_empty() {
            blank_run = !lines.is_empty();
        } else {
            if blank_run {
                lines.push(String::new());
            }
            blank_run = false;
            lines.push(normalized);
        }
    }
    lines.join("\n")
}

fn is_wikidot_discarded_control(character: char) -> bool {
    matches!(character as u32, 0x00..=0x08 | 0x0b..=0x0c | 0x0e..=0x1a | 0x1c..=0x1f)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn raw(contents: &str) -> CompatCodeBlock {
        CompatCodeBlock {
            start_line: 0,
            end_line: 0,
            language: Some("css".to_owned()),
            name: None,
            contents: contents.to_owned(),
            comment_wrapped: false,
        }
    }

    fn raw_comment(contents: &str) -> CompatCodeBlock {
        CompatCodeBlock {
            comment_wrapped: true,
            ..raw(contents)
        }
    }

    fn tree(contents: &str) -> CodeBlock<'static> {
        CodeBlock {
            contents: std::borrow::Cow::Owned(contents.to_owned()),
            language: Some(std::borrow::Cow::Owned("css".to_owned())),
            name: None,
        }
    }

    fn merged_texts(merged: &[MergedHostedCodeBlock]) -> Vec<&str> {
        merged
            .iter()
            .map(|block| block.text.as_str())
            .collect::<Vec<_>>()
    }

    fn identity(text: &str) -> String {
        text.to_owned()
    }

    #[test]
    fn hosted_code_drops_surrounding_newlines_and_ends_with_one() {
        let rendered = "\n\n#page-title {\n    display: none !important;\n}\n\n";
        assert_eq!(
            hosted_code_texts(&[rendered], None, identity),
            ["#page-title {\n    display: none !important;\n}\n"],
        );
    }

    #[test]
    fn hosted_code_keeps_source_tabs_when_the_raw_body_renders_the_same() {
        let rendered = "\n.a {\n        float: none;\n}\n";
        let source = [raw("\n.a {\n    \tfloat: none;\n}")];
        assert_eq!(
            hosted_code_texts(&[rendered], Some(&source), identity),
            [".a {\n    \tfloat: none;\n}\n"],
        );
    }

    #[test]
    fn hosted_code_localizes_the_raw_body_like_the_rendered_one() {
        let localize = |text: &str| {
            text.replace("https://x.wikidot.com/", "https://x.wjfiles.localhost/")
        };
        let source = [raw(
            "a {\tb: url('https://x.wikidot.com/local--files/t/l.svg'); }",
        )];
        let rendered =
            "a {    b: url('https://x.wjfiles.localhost/local--files/t/l.svg'); }";
        assert_eq!(
            hosted_code_texts(&[rendered], Some(&source), localize),
            ["a {\tb: url('https://x.wjfiles.localhost/local--files/t/l.svg'); }\n"],
        );
    }

    #[test]
    fn hosted_code_keeps_the_rendered_text_when_the_raw_body_differs() {
        let rendered = "expanded include\n";
        let source = [raw("[[include component:x]]")];
        assert_eq!(
            hosted_code_texts(&[rendered], Some(&source), identity),
            ["expanded include\n"],
        );
    }

    #[test]
    fn hosted_code_pairs_nothing_when_the_block_counts_differ() {
        let source = [raw("\ta"), raw("\tb")];
        assert_eq!(
            hosted_code_texts(&["    a"], Some(&source), identity),
            ["    a\n"],
        );
    }

    #[test]
    fn merged_recovers_comment_only_pages_in_source_order() {
        let source = [raw_comment("first"), raw_comment("second")];
        let merged = merged_hosted_code_blocks(&[], &source, identity);
        assert_eq!(merged_texts(&merged), ["first\n", "second\n"]);
        assert_eq!(merged[0].language.as_deref(), Some("css"));
    }

    #[test]
    fn merged_interleaves_comment_blocks_at_their_source_positions() {
        let source = [raw("a"), raw_comment("hidden"), raw("b")];
        let rendered = [tree("a"), tree("b")];
        let merged = merged_hosted_code_blocks(&rendered, &source, identity);
        assert_eq!(merged_texts(&merged), ["a\n", "hidden\n", "b\n"]);
    }

    #[test]
    fn merged_keeps_an_included_pages_block_relative_to_the_anchors() {
        let source = [raw_comment("hidden"), raw("a")];
        let rendered = [tree("foreign"), tree("a")];
        let merged = merged_hosted_code_blocks(&rendered, &source, identity);
        assert_eq!(merged_texts(&merged), ["hidden\n", "foreign\n", "a\n"]);
    }

    #[test]
    fn merged_counts_duplicate_contents_once_per_source_block() {
        let rendered = [tree("x")];
        let comment_first = [raw_comment("x"), raw("x")];
        let merged = merged_hosted_code_blocks(&rendered, &comment_first, identity);
        assert_eq!(merged_texts(&merged), ["x\n", "x\n"]);
        let visible_first = [raw("x"), raw_comment("x")];
        let merged = merged_hosted_code_blocks(&rendered, &visible_first, identity);
        assert_eq!(merged_texts(&merged), ["x\n", "x\n"]);
    }

    #[test]
    fn merged_does_not_recover_a_flagged_block_that_did_render() {
        let source = [raw_comment("x")];
        let rendered = [tree("x")];
        let merged = merged_hosted_code_blocks(&rendered, &source, identity);
        assert_eq!(merged_texts(&merged), ["x\n"]);
    }

    #[test]
    fn merged_skips_visible_scan_blocks_the_render_never_produced() {
        let source = [raw("unrendered"), raw_comment("hidden")];
        let merged = merged_hosted_code_blocks(&[], &source, identity);
        assert_eq!(merged_texts(&merged), ["hidden\n"]);
    }

    #[test]
    fn merged_localizes_recovered_blocks_like_paired_raw_bodies() {
        let localize = |text: &str| {
            text.replace("https://x.wikidot.com/", "https://x.wjfiles.localhost/")
        };
        let source = [raw_comment(
            "a { background: url('https://x.wikidot.com/local--files/t/l.svg'); }",
        )];
        let merged = merged_hosted_code_blocks(&[], &source, localize);
        assert_eq!(
            merged_texts(&merged),
            [
                "a { background: url('https://x.wjfiles.localhost/local--files/t/l.svg'); }\n"
            ],
        );
    }

    #[test]
    fn recovery_requires_every_visible_block_to_render_in_order() {
        assert!(visible_scan_blocks_render_in_order(
            &[tree("a"), tree("b")],
            &[raw("a"), raw_comment("hidden"), raw("b")],
            &identity,
        ));
        assert!(!visible_scan_blocks_render_in_order(
            &[tree("b")],
            &[raw("a"), raw_comment("hidden"), raw("b")],
            &identity,
        ));
        assert!(!visible_scan_blocks_render_in_order(
            &[tree("a")],
            &[raw("a"), raw_comment("hidden"), raw("b")],
            &identity,
        ));
        assert!(!visible_scan_blocks_render_in_order(
            &[tree("b"), tree("a")],
            &[raw("a"), raw("b")],
            &identity,
        ));
        assert!(!visible_scan_blocks_render_in_order(
            &[tree("x")],
            &[raw("x"), raw("x")],
            &identity,
        ));
        assert!(visible_scan_blocks_render_in_order(
            &[tree("x"), tree("x")],
            &[raw("x"), raw("x")],
            &identity,
        ));
        assert!(visible_scan_blocks_render_in_order(
            &[tree("foreign"), tree("a")],
            &[raw_comment("hidden"), raw("a")],
            &identity,
        ));
    }

    #[test]
    fn merged_recovers_the_evidenced_comment_pages() {
        let nav = [
            CompatCodeBlock {
                language: Some("html".to_owned()),
                ..raw_comment("<head>\n</head>")
            },
            CompatCodeBlock {
                language: Some("JavaScript".to_owned()),
                ..raw_comment(
                    "// https://shitake-crude-production.wikidot.com/abbreviation-library\nwindow._abb = {};",
                )
            },
        ];
        let merged = merged_hosted_code_blocks(&[], &nav, identity);
        assert_eq!(
            merged_texts(&merged),
            [
                "<head>\n</head>\n",
                "// https://shitake-crude-production.wikidot.com/abbreviation-library\nwindow._abb = {};\n",
            ],
        );
        assert_eq!(merged[0].language.as_deref(), Some("html"));
        assert_eq!(merged[1].language.as_deref(), Some("JavaScript"));

        let shushuin = [
            raw_comment(
                "@import url('https://fonts.googleapis.com/css?family=Noto+Serif+JP');\n/*header*/",
            ),
            raw_comment(
                "@import url('https://fonts.googleapis.com/css?family=Noto+Serif+JP');\n.shushuInner {",
            ),
            raw_comment("h1, #page-title {"),
        ];
        let merged = merged_hosted_code_blocks(&[], &shushuin, identity);
        assert_eq!(
            merged_texts(&merged),
            [
                "@import url('https://fonts.googleapis.com/css?family=Noto+Serif+JP');\n/*header*/\n",
                "@import url('https://fonts.googleapis.com/css?family=Noto+Serif+JP');\n.shushuInner {\n",
                "h1, #page-title {\n",
            ],
        );
        assert!(
            merged
                .iter()
                .all(|block| block.language.as_deref() == Some("css"))
        );
    }

    #[test]
    fn rendered_code_key_ignores_only_ftml_whitespace_normalization() {
        assert_eq!(
            rendered_code_key("\n\ta\u{00a0}b\u{0001}c\u{001b}d\n \n\n\n\te\n\n"),
            "    a bc\u{001b}d\n\n    e",
        );
        assert_ne!(rendered_code_key("a b"), rendered_code_key("a  b"));
        assert_ne!(rendered_code_key("a\nb"), rendered_code_key("a\n\nb"));
    }

    #[test]
    fn hosted_code_keeps_source_whitespace_only_lines_and_blank_runs() {
        let source = [raw("a {\n \n\tb: c;\n}\n\n\nd {}")];
        let rendered = "a {\n\n    b: c;\n}\n\nd {}";
        assert_eq!(
            hosted_code_texts(&[rendered], Some(&source), identity),
            ["a {\n \n\tb: c;\n}\n\n\nd {}\n"],
        );
    }
}
