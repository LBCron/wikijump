/*
 * services/render/compat/preparation.rs
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

use super::super::list_pages::scanner::first_list_pages_module_opening_candidate;
use super::super::literal_regions::{LiteralRegionIndex, WikidotNativeQuoteIndex};
use super::CompatHtmlFragments;
use super::text_fragments::CompatTextFragments;
use ftml::data::PageInfo;
use ftml::render::{Render, html::HtmlRender};
use ftml::settings::WikitextSettings;
use ftml::tree::{CodeBlock, Element, SyntaxTree};
use regex::Regex;
use std::borrow::Cow;
use std::collections::HashSet;
use std::ops::Range;
use std::sync::LazyLock;

static CSS_MODULE_OPEN_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)\[\[module\s+css[^\]]*\]\]").unwrap());
static CSS_MODULE_OPEN_HEAD_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)^\[\[module\s+css(?P<head>[^\]]*)\]\]$").unwrap());
static MODULE_CLOSE_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?is)\[\[/module\]\]").unwrap());
static AUTHORED_WIKIDOT_COMPAT_MARKER_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)data-wikijump-compat-(?P<kind>listpages-user|listpages|list|members|backlinks|new-page|clone|date|css-module)",
    )
    .unwrap()
});
static AUTHORED_WIKIDOT_COMPAT_OPEN_TAG_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?is)<table class="wiki-content-table" data-wikijump-compat-listpages="1">|<ol data-wikijump-compat-listpages="1">|<div class="feedinfo" data-wikijump-compat-listpages-feed="1">|<span class="printuser avatarhover" data-wikijump-compat-listpages-user="1">|<ul data-wikijump-compat-list="1">|<div id="ml-[0-9]+" data-wikijump-compat-members="1"[^>]*>|<div class="backlinks-module-box" data-wikijump-compat-backlinks="1"[^>]*>|<div class="new-page-box" data-wikijump-compat-new-page="1"[^>]*>|<a class="button" data-wikijump-compat-clone="1"[^>]*>|<span class="odate time_-?[0-9]+ format_[A-Za-z0-9%_.-]+" data-wikijump-compat-date="1">|<span data-wikijump-compat-listpages-preview="1" style="white-space: pre-wrap;">|<style data-wikijump-compat-css-module="1">"#,
    )
    .unwrap()
});
static AUTHORED_RUNTIME_MARKER_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)WIKIJUMPWIKIDOT(?:COMPAT(?:HTML|TEXT|LINK)|INLINEHTML|COLORSPAN|LISTPAGESELLIPSIS)[0-9a-f]{32}(?:I[0-9]+)?X",
    )
    .expect("the authored runtime marker regex is valid")
});

/// Whether only spaces or tabs precede `start` on its physical line.
///
/// Wikidot recognizes a `[[module CSS]]` opener only at the start of a line,
/// after optional indentation. Mid-line it is ordinary text, including inside
/// `{{ }}`, and it consumes nothing: `text {{[[module CSS]]}} more` renders
/// `text <tt>[[module CSS]]</tt> more` and a later real module still works
/// (`css-mid-line-*` and `css-indented-opener` in
/// wikidot-at-raw-preview-20261019.json). Treating a documentation mention as
/// an opener paired it with a `[[/module]]` thousands of lines later and
/// swallowed everything between, e.g. `theme:flopstyle-dark`'s code blocks.
fn opens_its_line(source: &str, start: usize) -> bool {
    let line_start = source[..start].rfind('\n').map_or(0, |newline| newline + 1);
    source[line_start..start]
        .bytes()
        .all(|byte| byte == b' ' || byte == b'\t')
}

pub(in crate::services::render) fn protect_css_modules_before_first_list_pages(
    wikitext: &mut String,
    settings: &WikitextSettings,
) -> Option<CompatTextFragments> {
    if !settings.enable_page_syntax {
        return None;
    }
    let boundary = first_list_pages_module_opening_candidate(wikitext)?;
    if boundary == 0 || !CSS_MODULE_OPEN_REGEX.is_match(&wikitext[..boundary]) {
        return None;
    }

    let mut fragments = CompatTextFragments::new(wikitext);
    let suffix = wikitext.split_off(boundary);
    let source = wikitext.as_str();
    let literal_regions = LiteralRegionIndex::new(source);
    let syntax_literal_regions = LiteralRegionIndex::new_wikidot_syntax(source);
    let native_quote_lines = WikidotNativeQuoteIndex::new(source);
    let mut output = String::with_capacity(source.len());
    let mut cursor = 0;
    let mut protected_any = false;

    while let Some(open) = CSS_MODULE_OPEN_REGEX.find_at(source, cursor) {
        if literal_regions.contains(open.start())
            || native_quote_lines.contains(open.start())
            || !opens_its_line(source, open.start())
        {
            output.push_str(&source[cursor..open.end()]);
            cursor = open.end();
            continue;
        }
        let mut close_cursor = open.end();
        let close = loop {
            let Some(candidate) = MODULE_CLOSE_REGEX.find_at(source, close_cursor) else {
                output.push_str(&source[cursor..]);
                *wikitext = output;
                wikitext.push_str(&suffix);
                return protected_any.then_some(fragments);
            };
            if !syntax_literal_regions.contains(candidate.start()) {
                break candidate;
            }
            close_cursor = candidate.end();
        };
        output.push_str(&source[cursor..open.start()]);
        output.push_str(&fragments.push(&source[open.start()..close.end()]));
        cursor = close.end();
        protected_any = true;
    }
    output.push_str(&source[cursor..]);
    *wikitext = output;
    wikitext.push_str(&suffix);
    protected_any.then_some(fragments)
}

pub(in crate::services::render) fn extract_css_modules(
    wikitext: &mut String,
    page_info: &PageInfo<'_>,
    settings: &WikitextSettings,
    compat_html: &mut CompatHtmlFragments,
) -> Vec<String> {
    if !settings.enable_page_syntax {
        return Vec::new();
    }

    let source = wikitext.as_str();
    let literal_regions = LiteralRegionIndex::new(source);
    let syntax_literal_regions = LiteralRegionIndex::new_wikidot_syntax(source);
    let native_quote_lines = WikidotNativeQuoteIndex::new(source);
    let mut output = String::with_capacity(source.len());
    let mut styles = Vec::new();
    let mut cursor = 0;

    while let Some(open) = CSS_MODULE_OPEN_REGEX.find_at(source, cursor) {
        if literal_regions.contains(open.start())
            || native_quote_lines.contains(open.start())
            || !opens_its_line(source, open.start())
        {
            output.push_str(&source[cursor..open.end()]);
            cursor = open.end();
            continue;
        }
        let mut close_cursor = open.end();
        let close = loop {
            let Some(candidate) = MODULE_CLOSE_REGEX.find_at(source, close_cursor) else {
                output.push_str(&source[cursor..]);
                *wikitext = output;
                return styles;
            };
            if !syntax_literal_regions.contains(candidate.start()) {
                break candidate;
            }
            close_cursor = candidate.end();
        };
        let body = source[open.end()..close.start()].trim_matches('\n');
        let flags = css_module_flags(open.as_str());
        output.push_str(&source[cursor..open.start()]);
        if flags.show {
            output.push_str(&compat_html.push_block_html(render_css_module_code_block(
                body, page_info, settings,
            )));
        }
        if !flags.disable {
            styles.push(escape_css_module_body(body));
        }
        cursor = close.end();
    }
    output.push_str(&source[cursor..]);
    *wikitext = output;
    styles
}

#[derive(Debug)]
pub(in crate::services::render) struct RuntimeCssInsertion {
    pub(in crate::services::render) marker: String,
    pub(in crate::services::render) styles: Vec<String>,
}

pub(in crate::services::render) fn extract_css_modules_with_runtime_insertions(
    wikitext: &mut String,
    page_info: &PageInfo<'_>,
    settings: &WikitextSettings,
    compat_html: &mut CompatHtmlFragments,
    insertions: Vec<RuntimeCssInsertion>,
) -> Vec<String> {
    if insertions.is_empty() {
        return extract_css_modules(wikitext, page_info, settings, compat_html);
    }

    for insertion in &insertions {
        if wikitext.matches(&insertion.marker).count() != 1 {
            continue;
        }
        let projected = format!("[[module CSS]]\n{}\n[[/module]]", insertion.marker,);
        *wikitext = wikitext.replacen(&insertion.marker, &projected, 1);
    }

    let extracted = extract_css_modules(wikitext, page_info, settings, compat_html);
    let mut styles = Vec::new();
    let mut matched = HashSet::<String>::new();
    for style in extracted {
        if let Some(insertion) = insertions
            .iter()
            .find(|insertion| insertion.marker == style)
        {
            matched.insert(insertion.marker.clone());
            styles.extend(insertion.styles.iter().cloned());
        } else {
            styles.push(style);
        }
    }
    for insertion in insertions {
        if !matched.contains(&insertion.marker) {
            styles.extend(insertion.styles);
        }
    }
    styles
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct CssModuleFlags {
    show: bool,
    disable: bool,
}

fn css_module_flags(open: &str) -> CssModuleFlags {
    let Some(captures) = CSS_MODULE_OPEN_HEAD_REGEX.captures(open) else {
        return CssModuleFlags::default();
    };
    let head = captures.name("head").map_or("", |head| head.as_str());
    let mut flags = CssModuleFlags::default();
    let mut cursor = 0;
    while cursor < head.len() {
        skip_css_module_whitespace(head, &mut cursor);
        if cursor >= head.len() {
            break;
        }

        if let Some((key, value, next)) = css_module_exact_argument_at(head, cursor) {
            let enabled = matches!(value, "true" | "yes");
            match key {
                "show" => flags.show = enabled,
                "disable" => flags.disable = enabled,
                _ => {}
            }
            cursor = next;
        } else {
            skip_css_module_non_whitespace(head, &mut cursor);
        }
    }
    flags
}

fn css_module_exact_argument_at(
    head: &str,
    cursor: usize,
) -> Option<(&str, &str, usize)> {
    for (key, prefix) in [("show", r#"show=""#), ("disable", r#"disable=""#)] {
        let value_start = cursor.checked_add(prefix.len())?;
        if !head[cursor..].starts_with(prefix) {
            continue;
        }
        let relative_end = head[value_start..].find('"')?;
        let value_end = value_start + relative_end;
        let next = value_end + '"'.len_utf8();
        if next < head.len()
            && !head[next..].chars().next().is_some_and(char::is_whitespace)
        {
            continue;
        }
        return Some((key, &head[value_start..value_end], next));
    }
    None
}

fn skip_css_module_whitespace(head: &str, cursor: &mut usize) {
    while *cursor < head.len()
        && head[*cursor..]
            .chars()
            .next()
            .is_some_and(char::is_whitespace)
    {
        *cursor += head[*cursor..]
            .chars()
            .next()
            .expect("cursor should point at a character")
            .len_utf8();
    }
}

fn skip_css_module_non_whitespace(head: &str, cursor: &mut usize) {
    while *cursor < head.len()
        && head[*cursor..]
            .chars()
            .next()
            .is_some_and(|character| !character.is_whitespace())
    {
        *cursor += head[*cursor..]
            .chars()
            .next()
            .expect("cursor should point at a character")
            .len_utf8();
    }
}

fn render_css_module_code_block(
    body: &str,
    page_info: &PageInfo<'_>,
    settings: &WikitextSettings,
) -> String {
    let tree = SyntaxTree {
        elements: vec![Element::Code(CodeBlock {
            contents: Cow::Borrowed(body),
            language: Some(Cow::Borrowed("css")),
            name: None,
        })],
        wikitext_len: body.len(),
        ..SyntaxTree::default()
    };
    HtmlRender.render(&tree, page_info, settings).body
}

fn escape_css_module_body(body: &str) -> String {
    body.replace('<', r"\3C ")
}

pub(in crate::services::render) fn neutralize_authored_markers(wikitext: &mut String) {
    if !AUTHORED_WIKIDOT_COMPAT_MARKER_REGEX.is_match(wikitext) {
        return;
    }
    let source = wikitext.clone();
    let literal_regions = LiteralRegionIndex::new(&source);
    let mut replacements: Vec<(Range<usize>, String)> = Vec::new();

    for candidate in AUTHORED_WIKIDOT_COMPAT_OPEN_TAG_REGEX.find_iter(&source) {
        if literal_regions.contains(candidate.start()) {
            continue;
        }
        for captures in
            AUTHORED_WIKIDOT_COMPAT_MARKER_REGEX.captures_iter(candidate.as_str())
        {
            let full_match = captures.get(0).expect("compat marker capture exists");
            let start = candidate.start() + full_match.start();
            replacements.push((
                start..candidate.start() + full_match.end(),
                format!(
                    "data-wikijump-authored-compat-{}",
                    captures["kind"].to_ascii_lowercase(),
                ),
            ));
        }
    }

    for (range, replacement) in replacements.into_iter().rev() {
        wikitext.replace_range(range, &replacement);
    }
}

pub(in crate::services::render) fn protect_authored_runtime_marker_literals(
    wikitext: &mut String,
    compat_text: &mut CompatTextFragments,
) {
    if !AUTHORED_RUNTIME_MARKER_REGEX.is_match(wikitext) {
        return;
    }

    let source = wikitext.clone();
    let module_regions = LiteralRegionIndex::new_wikidot_module_body(&source);
    let ranges = AUTHORED_RUNTIME_MARKER_REGEX
        .find_iter(&source)
        .filter(|candidate| {
            !module_regions.contains(candidate.start())
                && compat_text
                    .issued_marker_len_at(&source[candidate.start()..])
                    .is_none()
        })
        .map(|candidate| candidate.range())
        .collect::<Vec<_>>();
    let replacements = ranges
        .into_iter()
        .map(|range| {
            let marker =
                compat_text.push_authored_runtime_marker_literal(&source[range.clone()]);
            (range, marker)
        })
        .collect::<Vec<_>>();

    for (range, marker) in replacements.into_iter().rev() {
        wikitext.replace_range(range, &marker);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        RuntimeCssInsertion, extract_css_modules_with_runtime_insertions,
        neutralize_authored_markers, protect_authored_runtime_marker_literals,
        render_css_module_code_block,
    };
    use crate::services::render::compat::CompatHtmlFragments;
    use crate::services::render::compat::text_fragments::CompatTextFragments;
    use ftml::data::{PageInfo, ScoreValue};
    use ftml::layout::Layout;
    use ftml::settings::{WikitextMode, WikitextSettings};
    use std::borrow::Cow;

    #[test]
    fn authored_ordered_list_marker_cannot_enter_the_listpages_compatibility_boundary() {
        let mut source =
            r#"<ol data-wikijump-compat-listpages="1"><li>authored</li></ol>"#.to_owned();

        neutralize_authored_markers(&mut source);

        assert_eq!(
            source,
            r#"<ol data-wikijump-authored-compat-listpages="1"><li>authored</li></ol>"#,
        );
    }

    #[test]
    fn authored_runtime_markers_are_protected_in_text_and_html_attributes() {
        let marker = "WIKIJUMPWIKIDOTCOMPATTEXTffffffffffffffffffffffffffffffffI0X";
        let mut source = format!("raw {marker} <span title=\"{marker}\">text</span>");
        let mut compat_text = CompatTextFragments::new(&source);

        protect_authored_runtime_marker_literals(&mut source, &mut compat_text);
        let rendered =
            compat_text.restore_with_cleanup(&source, |text| text.replace(marker, ""));

        assert_eq!(
            rendered,
            format!("raw {marker} <span title=\"{marker}\">text</span>"),
        );
    }

    #[test]
    fn runtime_css_insertions_keep_their_listpages_cascade_position() {
        let page_info = PageInfo {
            page: Cow::Borrowed("test"),
            category: None,
            site: Cow::Borrowed("test"),
            title: Cow::Borrowed("Test"),
            alt_title: None,
            score: ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
        let mut source = concat!(
            "[[module CSS]]\n.parent-before { color: red; }\n[[/module]]\n",
            "BODY\n",
            "[[module CSS]]\n.parent-after { color: blue; }\n[[/module]]",
        )
        .to_owned();
        let mut compat_html = CompatHtmlFragments::new(&source);
        let marker = compat_html.push_html(String::new());
        source = source.replace("BODY", &marker);

        let styles = extract_css_modules_with_runtime_insertions(
            &mut source,
            &page_info,
            &settings,
            &mut compat_html,
            vec![RuntimeCssInsertion {
                marker,
                styles: vec![
                    ".child-one { color: green; }".to_owned(),
                    ".child-two { color: purple; }".to_owned(),
                ],
            }],
        );

        assert_eq!(
            styles,
            [
                ".parent-before { color: red; }",
                ".child-one { color: green; }",
                ".child-two { color: purple; }",
                ".parent-after { color: blue; }",
            ],
        );
        assert!(!source.contains("[[module CSS]]"));
    }

    #[test]
    fn visible_css_module_code_uses_wikidot_css_highlighting() {
        let page_info = PageInfo {
            page: Cow::Borrowed("test"),
            category: None,
            site: Cow::Borrowed("test"),
            title: Cow::Borrowed("Test"),
            alt_title: None,
            score: ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
        assert_eq!(
            render_css_module_code_block(
                ":root {\n     --right-1: 0%;\n}",
                &page_info,
                &settings,
            ),
            concat!(
                r#"<div class="code"><div class="hl-main"><pre>"#,
                r#"<span class="hl-special">:root</span>"#,
                r#"<span class="hl-code"> </span>"#,
                r#"<span class="hl-brackets">{</span>"#,
                "<span class=\"hl-code\">\n     --</span>",
                r#"<span class="hl-reserved">right-1:</span>"#,
                r#"<span class="hl-code"> </span>"#,
                r#"<span class="hl-number">0</span>"#,
                r#"<span class="hl-string">%</span>"#,
                "<span class=\"hl-code\">;\n</span>",
                r#"<span class="hl-brackets">}</span>"#,
                "</pre></div></div>",
            ),
        );
    }
}
