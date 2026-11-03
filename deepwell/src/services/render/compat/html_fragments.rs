use serde::{Deserialize, Serialize};
use std::fmt::Write as _;
use uuid::Uuid;

use super::super::RenderService;
use super::super::html_text::{
    HtmlDataSegment, OPAQUE_ELEMENTS, TagKind, html_data_segments,
    html_preformatted_content_ranges, is_foreign_self_closing, opaque_element_end,
    protected_construct_end, tag_kind,
};
use super::super::literal_regions::{HtmlColorRestorationIndex, LiteralRegionIndex};
use super::text_fragments::escape_html_text;

#[cfg(test)]
use std::cell::Cell;

#[cfg(test)]
thread_local! {
    static HTML_PARENT_SCANNED_BYTES: Cell<usize> = const { Cell::new(0) };
}

#[inline]
fn record_html_parent_scanned_bytes(bytes: usize) {
    #[cfg(test)]
    HTML_PARENT_SCANNED_BYTES.with(|total| {
        total.set(total.get().saturating_add(bytes));
    });
    #[cfg(not(test))]
    let _ = bytes;
}

#[cfg(test)]
fn take_html_parent_scanned_bytes() -> usize {
    HTML_PARENT_SCANNED_BYTES.with(|total| total.replace(0))
}

pub(in crate::services::render) const COMPAT_HTML_MARKER_PREFIX: &str =
    "WIKIJUMPWIKIDOTCOMPATHTML";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(in crate::services::render) struct CompatHtmlFragments {
    namespace: String,
    fragments: Vec<CompatFragment>,
    #[serde(default)]
    exact_fragments: Vec<(String, String)>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
enum CompatFragment {
    Html(String),
    BlockHtml {
        html: String,
        trim_preceding_space: bool,
        allow_span_parent: bool,
        allow_rate_inline_parent: bool,
        unwrap_residual_div_paragraph_prefix: bool,
        list_pages_row_boundary: Option<ListPagesContainerBoundary>,
    },
    Plain {
        plain: String,
        html: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
enum ListPagesContainerBoundary {
    Open,
    Close,
}

impl CompatHtmlFragments {
    pub(in crate::services::render) fn new(untrusted_source: &str) -> Self {
        let namespace = loop {
            let candidate =
                format!("{COMPAT_HTML_MARKER_PREFIX}{}I", Uuid::new_v4().as_simple(),);
            if !untrusted_source.contains(&candidate) {
                break candidate;
            }
        };
        Self {
            namespace,
            fragments: Vec::new(),
            exact_fragments: Vec::new(),
        }
    }

    pub(in crate::services::render) fn push_html(&mut self, html: String) -> String {
        self.push_fragment(CompatFragment::Html(html))
    }

    pub(in crate::services::render) fn push_block_html(
        &mut self,
        html: String,
    ) -> String {
        self.push_fragment(CompatFragment::BlockHtml {
            html,
            trim_preceding_space: false,
            allow_span_parent: false,
            allow_rate_inline_parent: false,
            unwrap_residual_div_paragraph_prefix: false,
            list_pages_row_boundary: None,
        })
    }

    pub(in crate::services::render) fn push_block_html_allowing_span_parent(
        &mut self,
        html: String,
    ) -> String {
        self.push_fragment(CompatFragment::BlockHtml {
            html,
            trim_preceding_space: false,
            allow_span_parent: true,
            allow_rate_inline_parent: false,
            unwrap_residual_div_paragraph_prefix: false,
            list_pages_row_boundary: None,
        })
    }

    pub(in crate::services::render) fn push_rate_block_html(
        &mut self,
        html: String,
    ) -> String {
        self.push_fragment(CompatFragment::BlockHtml {
            html,
            trim_preceding_space: false,
            allow_span_parent: false,
            allow_rate_inline_parent: true,
            unwrap_residual_div_paragraph_prefix: false,
            list_pages_row_boundary: None,
        })
    }

    #[cfg(test)]
    pub(in crate::services::render) fn push_block_html_trimming_preceding_space(
        &mut self,
        html: String,
    ) -> String {
        self.push_fragment(CompatFragment::BlockHtml {
            html,
            trim_preceding_space: true,
            allow_span_parent: false,
            allow_rate_inline_parent: false,
            unwrap_residual_div_paragraph_prefix: false,
            list_pages_row_boundary: None,
        })
    }

    pub(in crate::services::render) fn push_list_pages_container_open(
        &mut self,
        html: String,
    ) -> String {
        self.push_fragment(CompatFragment::BlockHtml {
            html,
            trim_preceding_space: false,
            allow_span_parent: false,
            allow_rate_inline_parent: false,
            unwrap_residual_div_paragraph_prefix: false,
            list_pages_row_boundary: Some(ListPagesContainerBoundary::Open),
        })
    }

    pub(in crate::services::render) fn push_list_pages_container_close(
        &mut self,
        trim_preceding_space: bool,
    ) -> String {
        self.push_fragment(CompatFragment::BlockHtml {
            html: "</div>".to_owned(),
            trim_preceding_space,
            allow_span_parent: false,
            allow_rate_inline_parent: false,
            unwrap_residual_div_paragraph_prefix: false,
            list_pages_row_boundary: Some(ListPagesContainerBoundary::Close),
        })
    }

    pub(in crate::services::render) fn push_block_html_unwrapping_residual_div_prefix(
        &mut self,
        html: String,
    ) -> String {
        self.push_fragment(CompatFragment::BlockHtml {
            html,
            trim_preceding_space: false,
            allow_span_parent: false,
            allow_rate_inline_parent: false,
            unwrap_residual_div_paragraph_prefix: true,
            list_pages_row_boundary: None,
        })
    }

    pub(in crate::services::render) fn push_plain(&mut self, plain: &str) -> String {
        self.push_fragment(CompatFragment::Plain {
            plain: plain.to_owned(),
            html: escape_in_any_html_context(plain),
        })
    }

    pub(in crate::services::render) fn is_empty(&self) -> bool {
        self.fragments.is_empty() && self.exact_fragments.is_empty()
    }

    pub(in crate::services::render) fn has_exact_fragments(&self) -> bool {
        !self.exact_fragments.is_empty()
    }

    pub(in crate::services::render) fn push_exact_html(
        &mut self,
        marker: String,
        html: String,
    ) -> String {
        debug_assert_eq!(marker.len(), html.len());
        self.exact_fragments.push((marker.clone(), html));
        marker
    }

    fn push_fragment(&mut self, fragment: CompatFragment) -> String {
        let index = self.fragments.len();
        self.fragments.push(fragment);
        format!("{}{index}X", self.namespace)
    }

    pub(in crate::services::render) fn restore_in_order(
        sets: &[Self],
        text: &str,
    ) -> String {
        match sets {
            [] => text.to_owned(),
            [set] => set.restore(text),
            sets => {
                let (merged, text) = Self::merge(sets, text);
                merged.restore(&text)
            }
        }
    }

    fn merge(sets: &[Self], text: &str) -> (Self, String) {
        let mut merged = Self::new(text);
        let mut offsets = std::collections::HashMap::with_capacity(sets.len());
        for set in sets {
            offsets.insert(
                set.namespace.as_str(),
                (merged.fragments.len(), set.fragments.len()),
            );
            merged.fragments.extend(set.fragments.iter().cloned());
            merged
                .exact_fragments
                .extend(set.exact_fragments.iter().cloned());
        }

        let mut output = String::with_capacity(text.len());
        let mut cursor = 0;
        while let Some(offset) = text[cursor..].find(COMPAT_HTML_MARKER_PREFIX) {
            let start = cursor + offset;
            let renamed = text
                .get(start..start + merged.namespace.len())
                .and_then(|namespace| offsets.get(namespace))
                .and_then(|&(base, len)| {
                    let suffix = &text[start + merged.namespace.len()..];
                    let digits = suffix.bytes().take_while(u8::is_ascii_digit).count();
                    if digits == 0 || suffix.as_bytes().get(digits) != Some(&b'X') {
                        return None;
                    }
                    let index = suffix[..digits].parse::<usize>().ok()?;
                    (index < len)
                        .then_some((base + index, merged.namespace.len() + digits + 1))
                });
            output.push_str(&text[cursor..start]);
            match renamed {
                Some((index, marker_len)) => {
                    write!(&mut output, "{}{index}X", merged.namespace)
                        .expect("writing to a String cannot fail");
                    cursor = start + marker_len;
                }
                None => {
                    output.push_str(COMPAT_HTML_MARKER_PREFIX);
                    cursor = start + COMPAT_HTML_MARKER_PREFIX.len();
                }
            }
        }
        output.push_str(&text[cursor..]);
        (merged, output)
    }

    pub(in crate::services::render) fn restore(&self, text: &str) -> String {
        let text = self.restore_exact_fragments(text);
        let text = self.restore_block_marker_paragraphs(&text);
        let text = self.restore_preformatted_markers_as_text(&text);
        let data_segments = html_data_segments(&text);
        self.restore_with(&text, None, Some(&data_segments), true, |fragment| {
            match fragment {
                CompatFragment::Html(html) | CompatFragment::BlockHtml { html, .. } => {
                    Some(html.as_str())
                }
                CompatFragment::Plain { html, .. } => Some(html.as_str()),
            }
        })
    }

    fn restore_preformatted_markers_as_text(&self, text: &str) -> String {
        self.restore_markers_as_text_in_ranges(
            text,
            html_preformatted_content_ranges(text),
        )
    }

    pub(in crate::services::render) fn restore_remaining_markers_as_text(
        &self,
        text: &str,
    ) -> String {
        let mut ranges = html_data_segments(text)
            .into_iter()
            .map(|segment| segment.range)
            .collect::<Vec<_>>();
        ranges.extend(html_preformatted_content_ranges(text));
        ranges.sort_by_key(|range| range.start);
        self.restore_markers_as_text_in_ranges(text, ranges)
    }

    fn restore_markers_as_text_in_ranges(
        &self,
        text: &str,
        ranges: Vec<std::ops::Range<usize>>,
    ) -> String {
        if self.fragments.is_empty() || !text.contains(&self.namespace) {
            return text.to_owned();
        }
        if ranges.is_empty() {
            return text.to_owned();
        }
        let mut output = String::with_capacity(text.len());
        let mut copied = 0;
        for range in ranges {
            if range.start < copied {
                continue;
            }
            output.push_str(&text[copied..range.start]);
            let content = &text[range.clone()];
            let mut cursor = 0;
            while let Some(offset) = content[cursor..].find(&self.namespace) {
                let start = cursor + offset;
                output.push_str(&content[cursor..start]);
                if let Some((index, marker_len)) = self.marker_at(&content[start..]) {
                    let fragment = match &self.fragments[index] {
                        CompatFragment::Html(html)
                        | CompatFragment::BlockHtml { html, .. }
                        | CompatFragment::Plain { html, .. } => html,
                    };
                    output.push_str(&escape_html_text(fragment));
                    cursor = start + marker_len;
                } else {
                    output.push_str(&self.namespace);
                    cursor = start + self.namespace.len();
                }
            }
            output.push_str(&content[cursor..]);
            copied = range.end;
        }
        output.push_str(&text[copied..]);
        output
    }

    pub(in crate::services::render) fn restore_exact_fragments(
        &self,
        text: &str,
    ) -> String {
        self.exact_fragments
            .iter()
            .fold(text.to_owned(), |text, (marker, html)| {
                text.replace(marker, html)
            })
    }

    fn restore_block_marker_paragraphs(&self, text: &str) -> String {
        if self.fragments.is_empty() || !text.contains(&self.namespace) {
            return text.to_owned();
        }

        let mut output = String::with_capacity(text.len());
        let mut cursor = 0;
        let mut parent_stack = IncrementalHtmlElementStack::default();
        while let Some(relative_start) = text[cursor..].find("<p>") {
            let start = cursor + relative_start;
            let body_start = start + "<p>".len();
            let Some(relative_end) = text[body_start..].find("</p>") else {
                break;
            };
            let body_end = body_start + relative_end;
            output.push_str(&text[cursor..start]);
            let body = &text[body_start..body_end];
            if parent_stack.advance_and_check_parent_is_safe(&output)
                && let Some((restored, trim_preceding_space)) =
                    self.block_marker_paragraph(body)
            {
                if trim_preceding_space
                    && output
                        .as_bytes()
                        .last()
                        .is_some_and(u8::is_ascii_whitespace)
                {
                    output.pop();
                }
                output.push_str(&restored);
                cursor = body_end + "</p>".len();
                continue;
            }
            output.push_str(&text[start..body_end + "</p>".len()]);
            cursor = body_end + "</p>".len();
        }
        output.push_str(&text[cursor..]);
        output
    }

    fn block_marker_paragraph(&self, body: &str) -> Option<(String, bool)> {
        let mut output = String::new();
        let mut cursor = 0;
        let mut count = 0;
        let mut trim_preceding_space = false;
        while cursor < body.len() {
            let rest = &body[cursor..];
            if let Some(stripped) = rest.strip_prefix("<br>") {
                cursor = body.len() - stripped.len();
                continue;
            }
            if let Some(stripped) = rest.strip_prefix("<br/>") {
                cursor = body.len() - stripped.len();
                continue;
            }
            let whitespace = rest
                .bytes()
                .take_while(|byte| byte.is_ascii_whitespace())
                .count();
            if whitespace > 0 {
                cursor += whitespace;
                continue;
            }
            let (index, len) = self.marker_at(rest)?;
            let CompatFragment::BlockHtml {
                html,
                trim_preceding_space: trim,
                list_pages_row_boundary: None,
                ..
            } = &self.fragments[index]
            else {
                return None;
            };
            trim_preceding_space |= count == 0 && *trim;
            output.push_str(html);
            count += 1;
            cursor += len;
        }
        (count > 0).then_some((output, trim_preceding_space))
    }

    #[cfg(test)]
    pub(in crate::services::render) fn restore_outside_html_literals(
        &self,
        text: &str,
    ) -> String {
        let data_segments = html_data_segments(text);
        self.restore_with(text, None, Some(&data_segments), true, |fragment| {
            match fragment {
                CompatFragment::Html(html) | CompatFragment::BlockHtml { html, .. } => {
                    Some(html.as_str())
                }
                CompatFragment::Plain { html, .. } => Some(html.as_str()),
            }
        })
    }

    pub(in crate::services::render) fn restore_outside_block_html_literals(
        &self,
        text: &str,
    ) -> String {
        let literal_regions = LiteralRegionIndex::new_html_color_restoration(text);
        self.restore_with(text, Some(&literal_regions), None, true, |fragment| {
            match fragment {
                CompatFragment::Html(html) | CompatFragment::BlockHtml { html, .. } => {
                    Some(html.as_str())
                }
                CompatFragment::Plain { html, .. } => Some(html.as_str()),
            }
        })
    }

    pub(in crate::services::render) fn restore_plain(&self, text: &str) -> String {
        self.restore_with(text, None, None, false, |fragment| match fragment {
            CompatFragment::Plain { plain, .. } => Some(plain.as_str()),
            CompatFragment::Html(_) | CompatFragment::BlockHtml { .. } => None,
        })
    }

    fn restore_with<'a>(
        &'a self,
        text: &str,
        literal_regions: Option<&HtmlColorRestorationIndex>,
        html_data_segments: Option<&[HtmlDataSegment]>,
        unwrap_block_paragraphs: bool,
        value: impl Fn(&'a CompatFragment) -> Option<&'a str>,
    ) -> String {
        if self.fragments.is_empty() || !text.contains(&self.namespace) {
            return text.to_owned();
        }
        let mut output = String::with_capacity(text.len());
        let mut cursor = 0;
        let mut parent_stack = IncrementalHtmlElementStack::default();
        while let Some(offset) = text[cursor..].find(&self.namespace) {
            let start = cursor + offset;
            output.push_str(&text[cursor..start]);
            if let Some((index, len)) = self.marker_at(&text[start..]) {
                let marker_end = start + len;
                let inside_literal =
                    literal_regions.is_some_and(|regions| regions.contains(start));
                let inside_html_data = html_data_segments.is_none_or(|segments| {
                    let insertion =
                        segments.partition_point(|segment| segment.range.start <= start);
                    insertion > 0 && marker_end <= segments[insertion - 1].range.end
                });
                if inside_literal || !inside_html_data {
                    output.push_str(&text[start..marker_end]);
                    cursor = marker_end;
                    continue;
                }
                if let Some(fragment) = value(&self.fragments[index]) {
                    let row_boundary = match &self.fragments[index] {
                        CompatFragment::BlockHtml {
                            list_pages_row_boundary,
                            ..
                        } => *list_pages_row_boundary,
                        CompatFragment::Html(_) | CompatFragment::Plain { .. } => None,
                    };
                    if row_boundary == Some(ListPagesContainerBoundary::Close)
                        && !parent_stack.has_list_pages_row_boundary()
                    {
                        output.push_str(&text[start..marker_end]);
                        cursor = marker_end;
                        continue;
                    }
                    if matches!(
                        &self.fragments[index],
                        CompatFragment::BlockHtml {
                            trim_preceding_space: true,
                            ..
                        }
                    ) && output
                        .as_bytes()
                        .last()
                        .is_some_and(u8::is_ascii_whitespace)
                    {
                        output.pop();
                        parent_stack.clamp_parsed_len(output.len());
                    }
                    let (allow_span_parent, rate_inline_scope) =
                        match &self.fragments[index] {
                            CompatFragment::BlockHtml {
                                allow_span_parent,
                                allow_rate_inline_parent,
                                ..
                            } => (*allow_span_parent, *allow_rate_inline_parent),
                            CompatFragment::Html(_) | CompatFragment::Plain { .. } => {
                                (false, false)
                            }
                        };
                    let unwrap_residual_div_paragraph_prefix = matches!(
                        &self.fragments[index],
                        CompatFragment::BlockHtml {
                            unwrap_residual_div_paragraph_prefix: true,
                            ..
                        },
                    );
                    let trim_preceding_space = matches!(
                        &self.fragments[index],
                        CompatFragment::BlockHtml {
                            trim_preceding_space: true,
                            ..
                        },
                    );
                    let known_container_close =
                        row_boundary == Some(ListPagesContainerBoundary::Close);
                    let restored_fragment_start = if unwrap_block_paragraphs
                        && matches!(
                            &self.fragments[index],
                            CompatFragment::BlockHtml { .. },
                        ) {
                        let options = BlockParagraphRestoreOptions {
                            known_container_close,
                            unwrap_residual_div_paragraph_prefix,
                            trim_preceding_space,
                        };
                        let restored = if rate_inline_scope {
                            restore_rate_block_from_inline_paragraph(
                                &mut output,
                                text,
                                marker_end,
                                fragment,
                                &mut cursor,
                                &mut parent_stack,
                            )
                        } else {
                            restore_block_html_from_paragraph(
                                &mut output,
                                text,
                                marker_end,
                                fragment,
                                &mut cursor,
                                &mut parent_stack,
                                options,
                            )
                        };
                        if let Some(fragment_start) = restored {
                            Some(fragment_start)
                        } else {
                            let parent_accepts_block = parent_stack
                                .advance_and_check_parent_accepts_block_fragment(
                                    &output,
                                    allow_span_parent,
                                )
                                || (rate_inline_scope
                                    && parent_stack
                                        .advance_and_check_parent_is_rate_inline(
                                            &output,
                                        ));
                            if !known_container_close && !parent_accepts_block {
                                output.push_str(&text[start..marker_end]);
                                cursor = marker_end;
                                continue;
                            }
                            None
                        }
                    } else {
                        None
                    };
                    let fragment_start = restored_fragment_start.unwrap_or_else(|| {
                        let fragment_start = output.len();
                        output.push_str(fragment);
                        cursor = start + len;
                        fragment_start
                    });
                    match row_boundary {
                        Some(ListPagesContainerBoundary::Open) => {
                            parent_stack.record_list_pages_row_boundary(
                                &output,
                                fragment_start + fragment.len(),
                            );
                        }
                        Some(ListPagesContainerBoundary::Close) => {
                            parent_stack.close_list_pages_row_boundary(
                                &mut output,
                                fragment_start,
                            );
                        }
                        None => {}
                    }
                } else {
                    output.push_str(&text[start..start + len]);
                    cursor = start + len;
                }
            } else {
                output.push_str(&self.namespace);
                cursor = start + self.namespace.len();
            }
        }
        output.push_str(&text[cursor..]);
        output
    }

    fn marker_at(&self, text: &str) -> Option<(usize, usize)> {
        let suffix = text.strip_prefix(&self.namespace)?;
        let digits = suffix.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 || suffix.as_bytes().get(digits) != Some(&b'X') {
            return None;
        }
        let index = suffix[..digits].parse::<usize>().ok()?;
        (index < self.fragments.len())
            .then_some((index, self.namespace.len() + digits + 1))
    }
}

#[derive(Clone, Copy, Debug)]
struct BlockParagraphRestoreOptions {
    known_container_close: bool,
    unwrap_residual_div_paragraph_prefix: bool,
    trim_preceding_space: bool,
}

fn restore_rate_block_from_inline_paragraph(
    output: &mut String,
    text: &str,
    marker_end: usize,
    fragment: &str,
    cursor: &mut usize,
    parent_stack: &mut IncrementalHtmlElementStack,
) -> Option<usize> {
    let paragraph_start = output.rfind("<p>")?;
    if !parent_stack.advance_and_check_parent_is_safe(&output[..paragraph_start]) {
        return None;
    }
    let leading = &output[paragraph_start + 3..];
    let wrappers = active_rate_inline_scope_tags(leading)?;
    if wrappers.is_empty() {
        return None;
    }

    let paragraph_end = text[marker_end..].find("</p>")?;
    let trailing_end = marker_end + paragraph_end;
    let trailing = &text[marker_end..trailing_end];
    let mut trailing_content_end = trailing.len();
    for (_, name) in wrappers.iter().rev() {
        let closing = format!("</{name}>");
        trailing_content_end = trailing[..trailing_content_end]
            .strip_suffix(&closing)?
            .len();
    }
    let trailing_content = &trailing[..trailing_content_end];
    if !contains_only_text_breaks_and_balanced_inline_elements(trailing_content) {
        return None;
    }

    for (_, name) in wrappers.iter().rev() {
        write!(output, "</{name}>").expect("writing to a String cannot fail");
    }
    output.push_str("</p>");

    let block_start = output.len();
    for (opening, _) in &wrappers {
        output.push_str(opening);
    }
    output.push_str(fragment);
    for (_, name) in wrappers.iter().rev() {
        write!(output, "</{name}>").expect("writing to a String cannot fail");
    }

    output.push_str("<p>");
    for (opening, _) in &wrappers {
        output.push_str(opening);
    }
    output.push_str(trailing_content);
    for (_, name) in wrappers.iter().rev() {
        write!(output, "</{name}>").expect("writing to a String cannot fail");
    }
    output.push_str("</p>");
    *cursor = trailing_end + "</p>".len();
    Some(block_start)
}

fn active_rate_inline_scope_tags(value: &str) -> Option<Vec<(String, String)>> {
    let mut cursor = 0;
    let mut stack = Vec::new();
    while let Some(relative_start) = value[cursor..].find('<') {
        let start = cursor + relative_start;
        let Some(TagKind::Element { closing }) = tag_kind(&value[start..]) else {
            return None;
        };
        let end = html_tag_end(value, start)?;
        let raw_tag = &value[start..end];
        let tag = raw_tag.strip_prefix('<')?.strip_suffix('>')?.trim();
        let name = tag
            .strip_prefix('/')
            .map_or(tag, str::trim_start)
            .split(|character: char| character.is_ascii_whitespace() || character == '/')
            .next()?
            .to_ascii_lowercase();
        if closing {
            if stack.last().is_none_or(|(_, open_name)| open_name != &name) {
                return None;
            }
            stack.pop();
        } else if !is_void_html_element(&name) {
            if tag.trim_end().ends_with('/') {
                return None;
            }
            stack.push((raw_tag.to_owned(), name));
        }
        cursor = end;
    }
    stack
        .iter()
        .all(|(_, name)| matches!(name.as_str(), "a" | "span"))
        .then_some(stack)
}

fn restore_block_html_from_paragraph(
    output: &mut String,
    text: &str,
    marker_end: usize,
    fragment: &str,
    cursor: &mut usize,
    parent_stack: &mut IncrementalHtmlElementStack,
    options: BlockParagraphRestoreOptions,
) -> Option<usize> {
    let paragraph_start = output.rfind("<p>")?;
    let leading = &output[paragraph_start + 3..];
    if !contains_only_text_breaks_and_balanced_inline_elements(leading) {
        return None;
    }
    let paragraph_end = text[marker_end..].find("</p>")?;
    let trailing_end = marker_end + paragraph_end;
    let trailing = &text[marker_end..trailing_end];
    if !contains_only_text_breaks_and_balanced_inline_elements(trailing) {
        return None;
    }
    if !options.known_container_close
        && !parent_stack.advance_and_check_parent_is_safe(&output[..paragraph_start])
    {
        return None;
    }

    let leading_end = trailing_break_start(leading).unwrap_or(leading.len());
    let trailing_start = leading_break_end(trailing).unwrap_or(0);
    let unwrap_leading = options.unwrap_residual_div_paragraph_prefix
        && starts_with_unmatched_residual_wikidot_div(&leading[..leading_end]);
    output.truncate(paragraph_start + 3 + leading_end);
    let leading_is_empty = output[paragraph_start + 3..].trim().is_empty();
    let trailing_is_empty = trailing[trailing_start..].trim().is_empty();
    if leading_is_empty {
        output.truncate(paragraph_start);
    } else if unwrap_leading {
        let flow_break = if output[..paragraph_start].ends_with('\n') {
            ""
        } else {
            "\n"
        };
        output.replace_range(paragraph_start..paragraph_start + 3, flow_break);
    } else {
        output.push_str("</p>");
    }
    if options.trim_preceding_space
        && output
            .as_bytes()
            .last()
            .is_some_and(u8::is_ascii_whitespace)
    {
        output.pop();
        parent_stack.clamp_parsed_len(output.len());
    }
    let fragment_start = output.len();
    output.push_str(fragment);
    if trailing_is_empty {
        *cursor = trailing_end + "</p>".len();
    } else {
        output.push_str("<p>");
        *cursor = marker_end + trailing_start;
    }
    Some(fragment_start)
}

fn starts_with_unmatched_residual_wikidot_div(value: &str) -> bool {
    let value = value.trim_start();
    let Some(marker_end) = value.find("]]") else {
        return false;
    };
    let marker_end = marker_end + 2;
    let marker =
        RenderService::decode_residual_wikidot_marker_quotes(&value[..marker_end]);
    if RenderService::wikidot_residual_div_attributes(&marker).is_none() {
        return false;
    }

    !value.to_ascii_lowercase().contains("[[/div]]")
}

fn contains_only_text_breaks_and_balanced_inline_elements(value: &str) -> bool {
    let mut cursor = 0;
    let mut stack = Vec::new();
    while let Some(relative_start) = value[cursor..].find('<') {
        let start = cursor + relative_start;
        let Some(TagKind::Element { .. }) = tag_kind(&value[start..]) else {
            return false;
        };
        let Some(end) = html_tag_end(value, start) else {
            return false;
        };
        let Some(tag) = value[start..end]
            .strip_prefix('<')
            .and_then(|tag| tag.strip_suffix('>'))
        else {
            return false;
        };
        let tag = tag.trim();
        let closing = tag.starts_with('/');
        let tag = if closing { tag[1..].trim_start() } else { tag };
        let name_end = tag
            .find(|character: char| character.is_ascii_whitespace() || character == '/')
            .unwrap_or(tag.len());
        let name = tag[..name_end].to_ascii_lowercase();
        if !is_safe_paragraph_inline_element(&name) {
            return false;
        }
        if closing {
            if stack.last().is_none_or(|open| open != &name) {
                return false;
            }
            stack.pop();
        } else if is_void_html_element(&name) {
            // HTML void elements are balanced by definition.
        } else {
            if tag.trim_end().ends_with('/') {
                return false;
            }
            stack.push(name);
        }
        cursor = end;
    }
    stack.is_empty()
}

fn is_safe_paragraph_inline_element(name: &str) -> bool {
    matches!(
        name,
        "a" | "abbr"
            | "b"
            | "bdi"
            | "bdo"
            | "br"
            | "cite"
            | "code"
            | "del"
            | "em"
            | "font"
            | "i"
            | "img"
            | "ins"
            | "kbd"
            | "mark"
            | "q"
            | "s"
            | "samp"
            | "small"
            | "span"
            | "strike"
            | "strong"
            | "sub"
            | "sup"
            | "time"
            | "tt"
            | "u"
            | "var"
            | "wbr"
    )
}

fn trailing_break_start(value: &str) -> Option<usize> {
    let trimmed_end = value.trim_end().len();
    ["<br>", "<br/>", "<br />"]
        .into_iter()
        .find_map(|tag| value[..trimmed_end].strip_suffix(tag).map(str::len))
}

fn leading_break_end(value: &str) -> Option<usize> {
    let leading_whitespace = value.len() - value.trim_start().len();
    let rest = &value[leading_whitespace..];
    ["<br>", "<br/>", "<br />"].into_iter().find_map(|tag| {
        rest.strip_prefix(tag).map(|after| {
            let trailing_whitespace = after.len() - after.trim_start().len();
            leading_whitespace + tag.len() + trailing_whitespace
        })
    })
}

#[derive(Debug)]
struct IncrementalHtmlElementStack {
    parsed: usize,
    stack: Vec<String>,
    list_pages_row_stacks: Vec<Vec<String>>,
    valid: bool,
}

impl Default for IncrementalHtmlElementStack {
    fn default() -> Self {
        Self {
            parsed: 0,
            stack: Vec::new(),
            list_pages_row_stacks: Vec::new(),
            valid: true,
        }
    }
}

impl IncrementalHtmlElementStack {
    fn clamp_parsed_len(&mut self, new_len: usize) {
        self.parsed = self.parsed.min(new_len);
    }

    fn has_list_pages_row_boundary(&self) -> bool {
        !self.list_pages_row_stacks.is_empty()
    }

    fn record_list_pages_row_boundary(&mut self, html: &str, end: usize) {
        if self.advance(&html[..end]) {
            self.list_pages_row_stacks.push(self.stack.clone());
        }
    }

    fn close_list_pages_row_boundary(&mut self, html: &mut String, start: usize) {
        let structurally_valid = self.advance(&html[..start]);
        let Some(boundary_stack) = self.list_pages_row_stacks.pop() else {
            return;
        };
        let depth = boundary_stack.len();
        if !structurally_valid || self.stack.len() < depth {
            self.stack = boundary_stack;
            self.parsed = start;
            self.valid = true;
            return;
        }
        let mut closing = String::new();
        while self.stack.len() > depth {
            let element = self
                .stack
                .pop()
                .expect("row depth is below the current element stack");
            write!(&mut closing, "</{element}>")
                .expect("writing to a String cannot fail");
        }
        html.insert_str(start, &closing);
        self.parsed = start + closing.len();
    }

    fn advance_and_check_parent_is_safe(&mut self, html: &str) -> bool {
        self.advance_and_check_parent_accepts_block_fragment(html, false)
    }

    fn advance_and_check_parent_is_rate_inline(&mut self, html: &str) -> bool {
        self.advance(html)
            && !self.stack.iter().any(|element| element == "p")
            && self
                .stack
                .last()
                .is_some_and(|parent| matches!(parent.as_str(), "a" | "span"))
    }

    fn advance_and_check_parent_accepts_block_fragment(
        &mut self,
        html: &str,
        allow_span_parent: bool,
    ) -> bool {
        if self.parsed > html.len() {
            *self = Self::default();
        }
        self.advance(html)
            && self.stack.last().is_none_or(|parent| {
                is_safe_block_html_container(parent)
                    || (allow_span_parent && parent == "span")
            })
    }

    fn advance(&mut self, html: &str) -> bool {
        if self.parsed > html.len() {
            *self = Self::default();
        }
        if self.valid {
            record_html_parent_scanned_bytes(html.len().saturating_sub(self.parsed));
            self.valid =
                advance_open_html_element_stack(html, &mut self.parsed, &mut self.stack);
        }
        self.valid
    }
}

fn advance_open_html_element_stack(
    html: &str,
    cursor: &mut usize,
    stack: &mut Vec<String>,
) -> bool {
    while let Some(relative) = html[*cursor..].find('<') {
        let start = *cursor + relative;
        match tag_kind(&html[start..]) {
            Some(kind @ (TagKind::Comment | TagKind::BogusComment)) => {
                let Some(end) = protected_construct_end(html, start, kind) else {
                    return false;
                };
                *cursor = end;
                continue;
            }
            Some(TagKind::Cdata | TagKind::Declaration) => return false,
            Some(TagKind::Element { .. }) => {}
            None => return false,
        }
        let Some(end) = html_tag_end(html, start) else {
            return false;
        };
        let raw_tag = &html[start..end];
        let Some(tag) = raw_tag
            .strip_prefix('<')
            .and_then(|tag| tag.strip_suffix('>'))
        else {
            return false;
        };
        let tag = tag.trim();
        if tag.starts_with('!') || tag.starts_with('?') {
            *cursor = end;
            continue;
        }
        let closing = tag.starts_with('/');
        let tag = if closing { tag[1..].trim_start() } else { tag };
        let name_end = tag
            .find(|character: char| character.is_ascii_whitespace() || character == '/')
            .unwrap_or(tag.len());
        let name = tag[..name_end].to_ascii_lowercase();
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
        {
            return false;
        }
        if closing {
            // Match the browser tree builder's recovery for crossed tags:
            // close the named ancestor and discard open descendants. A stray
            // closing tag with no matching open element has no effect. This
            // lets a later trusted fragment use the actual surviving parent
            // while malformed tag text still fails closed above.
            if let Some(open_index) = stack.iter().rposition(|open| open == &name) {
                stack.truncate(open_index);
            }
        } else if is_foreign_self_closing(&name, raw_tag) {
            *cursor = end;
            continue;
        } else if OPAQUE_ELEMENTS.contains(&name.as_str()) {
            let Some(opaque_end) = opaque_element_end(html, end, &name) else {
                return false;
            };
            *cursor = opaque_end;
            continue;
        } else if !is_void_html_element(&name) {
            if tag.trim_end().ends_with('/') {
                return false;
            }
            if name == "div" && stack.last().is_some_and(|open| open == "p") {
                stack.pop();
            }
            stack.push(name);
        }
        *cursor = end;
    }
    *cursor = html.len();
    true
}

fn html_tag_end(html: &str, start: usize) -> Option<usize> {
    let bytes = html.as_bytes();
    let mut cursor = start + 1;
    let mut quote = None;
    while let Some(&byte) = bytes.get(cursor) {
        match byte {
            b'\'' | b'"' if quote.is_none() => quote = Some(byte),
            byte if quote == Some(byte) => quote = None,
            b'>' if quote.is_none() => return Some(cursor + 1),
            _ => {}
        }
        cursor += 1;
    }
    None
}

fn is_void_html_element(name: &str) -> bool {
    matches!(
        name,
        "area"
            | "base"
            | "br"
            | "col"
            | "embed"
            | "hr"
            | "img"
            | "input"
            | "link"
            | "meta"
            | "param"
            | "source"
            | "track"
            | "wbr"
    )
}

/// Parents that may directly contain a restored block fragment. Table cells
/// and list items are included because Wikidot places block module output
/// (ListPages, Rate) directly in `<td>`, `<th>`, and `<li>`.
fn is_safe_block_html_container(name: &str) -> bool {
    matches!(
        name,
        "article"
            | "aside"
            | "blockquote"
            | "body"
            | "div"
            | "footer"
            | "header"
            | "li"
            | "main"
            | "section"
            | "td"
            | "th"
    )
}

fn escape_in_any_html_context(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        if character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.') {
            escaped.push(character);
        } else {
            write!(&mut escaped, "&#x{:X};", character as u32)
                .expect("writing to a String cannot fail");
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_only_registered_in_range_fragments_without_recursion() {
        let mut fragments = CompatHtmlFragments::new("authored source");
        let marker_shaped = format!("{COMPAT_HTML_MARKER_PREFIX}deadbeefI0X");
        let first = fragments.push_html(format!("<b>{marker_shaped}</b>"));
        let second = fragments.push_html("<i>second</i>".to_owned());
        let foreign =
            format!("{COMPAT_HTML_MARKER_PREFIX}ffffffffffffffffffffffffffffffffI0X");
        assert_eq!(
            fragments.restore(&format!("{first}|{second}|{foreign}")),
            format!("<b>{marker_shaped}</b>|<i>second</i>|{foreign}"),
        );
    }

    #[test]
    fn malformed_and_out_of_range_markers_remain_literal() {
        let mut fragments = CompatHtmlFragments::new("");
        let valid = fragments.push_html("<b>trusted</b>".to_owned());
        let malformed = format!("{}nopeX", fragments.namespace);
        let out_of_range = format!("{}9X", fragments.namespace);
        assert_eq!(fragments.restore(&valid), "<b>trusted</b>");
        assert_eq!(fragments.restore(&malformed), malformed);
        assert_eq!(fragments.restore(&out_of_range), out_of_range);
    }

    #[test]
    fn block_html_replaces_only_the_paragraph_created_for_its_marker() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_block_html("<div>trusted block</div>".to_owned());

        assert_eq!(
            fragments.restore(&format!("<section><p>{marker}</p></section>")),
            "<section><div>trusted block</div></section>",
        );
        assert_eq!(
            fragments.restore(&format!("<section>{marker}</section>")),
            "<section><div>trusted block</div></section>",
        );
        assert_eq!(
            fragments.restore(&format!("<p>before {marker} after</p>")),
            "<p>before </p><div>trusted block</div><p> after</p>",
        );
        assert_eq!(
            fragments.restore(&format!("<p> \n{marker}\n </p>")),
            "<div>trusted block</div>",
        );
        assert!(
            !fragments
                .restore(&format!("<p>before {marker} after</p>"))
                .contains("<p><div")
        );
        assert_eq!(
            fragments.restore(&format!("<p>before<br>\n{marker}<br>\nafter</p>")),
            "<p>before</p><div>trusted block</div><p>after</p>",
        );
        assert_eq!(
            fragments.restore(&format!(
                concat!(
                    "<p>{}<br>\n",
                    r#"<span style="white-space: pre-wrap;"> </span>"#,
                    "<br>\nafter</p>",
                ),
                marker,
            )),
            concat!(
                "<div>trusted block</div><p>",
                r#"<span style="white-space: pre-wrap;"> </span>"#,
                "<br>\nafter</p>",
            ),
        );
    }

    #[test]
    fn block_html_splits_a_paragraph_after_balanced_inline_content() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_block_html("<div>trusted block</div>".to_owned());

        assert_eq!(
            fragments.restore(&format!(
                r#"<p><span><a href="/safe">row</a></span><br>{marker}</p>"#,
            )),
            concat!(
                r#"<p><span><a href="/safe">row</a></span></p>"#,
                "<div>trusted block</div>",
            ),
        );
        assert_eq!(
            fragments.restore(&format!(
                r#"<p>before<br>{marker}<br>after <a href="/safe">link</a></p>"#,
            )),
            concat!(
                "<p>before</p>",
                "<div>trusted block</div>",
                r#"<p>after <a href="/safe">link</a></p>"#,
            ),
        );
        assert_eq!(
            fragments.restore(&format!("<p><span>unclosed<br>{marker}</p>")),
            format!("<p><span>unclosed<br>{marker}</p>"),
        );
        assert_eq!(
            fragments.restore(&format!("<p><script>unsafe</script><br>{marker}</p>")),
            format!("<p><script>unsafe</script><br>{marker}</p>"),
        );
    }

    #[test]
    fn opted_in_block_html_unwraps_only_an_unmatched_residual_div_prefix() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_block_html_unwrapping_residual_div_prefix(
            "<div>trusted block</div>".to_owned(),
        );

        assert_eq!(
            fragments.restore(&format!(
                "<p>[[div class=&quot;licensebox&quot;]]<br>prefix{marker}</p>",
            )),
            concat!(
                "\n[[div class=&quot;licensebox&quot;]]<br>prefix",
                "<div>trusted block</div>",
            ),
        );
        assert_eq!(
            fragments.restore(&format!(
                "<div>preceding block</div><p>[[div class=&quot;licensebox&quot;]]{marker}</p>",
            )),
            concat!(
                "<div>preceding block</div>\n",
                "[[div class=&quot;licensebox&quot;]]",
                "<div>trusted block</div>",
            ),
        );
        for leading in [
            "plain prefix",
            "[[div class=&quot;licensebox&quot;]][[/div]]",
            "[[div onclick=&quot;unsafe()&quot;]]",
        ] {
            assert_eq!(
                fragments.restore(&format!("<p>{leading}{marker}</p>")),
                format!("<p>{leading}</p><div>trusted block</div>"),
            );
        }
    }

    #[test]
    fn block_html_preserves_an_empty_paragraph_fragment_between_text() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_block_html("<p>\n\n</p>".to_owned());

        assert_eq!(
            fragments.restore(&format!("<p>before<br>\n{marker}<br>\nafter</p>")),
            "<p>before</p><p>\n\n</p><p>after</p>",
        );
    }

    #[test]
    fn opted_in_flow_html_restores_only_beneath_a_span_parent() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_block_html_allowing_span_parent(
            "<div>trusted ListPages</div>".to_owned(),
        );

        assert_eq!(
            fragments.restore(&format!("<span>{marker}</span>")),
            "<span><div>trusted ListPages</div></span>",
        );
        assert_eq!(
            fragments.restore(&format!("<a href=\"/safe\">{marker}</a>")),
            format!("<a href=\"/safe\">{marker}</a>"),
        );
        assert_eq!(
            fragments.restore(&format!("<script>{marker}</script>")),
            format!("<script>{marker}</script>"),
        );
    }

    #[test]
    fn opted_in_block_html_trims_exactly_one_preceding_ascii_whitespace() {
        let mut fragments = CompatHtmlFragments::new("");
        let ordinary = fragments.push_block_html("</div>".to_owned());
        let trimming =
            fragments.push_block_html_trimming_preceding_space("</div>".to_owned());

        assert_eq!(
            fragments.restore(&format!("after <p>{ordinary}</p>")),
            "after </div>",
        );
        assert_eq!(
            fragments.restore(&format!("after <p>{trimming}</p>")),
            "after</div>",
        );
        assert_eq!(
            fragments.restore(&format!("after  <p>{trimming}</p>")),
            "after </div>",
        );
        assert_eq!(
            fragments.restore(&format!("after\n<p>{trimming}</p>")),
            "after</div>",
        );
        assert_eq!(
            fragments.restore(&format!("after\n\n<p>{trimming}</p>")),
            "after\n</div>",
        );
        assert_eq!(
            fragments.restore(&format!("after<p>{trimming}</p>")),
            "after</div>",
        );
    }

    fn restore_one_by_one(sets: &[CompatHtmlFragments], text: &str) -> String {
        sets.iter()
            .fold(text.to_owned(), |text, set| set.restore(&text))
    }

    #[test]
    fn restoring_row_sets_in_one_pass_matches_restoring_them_one_by_one() {
        let mut outer = CompatHtmlFragments::new("");
        let foreign = outer.push_html("<em>outer</em>".to_owned());
        let mut sets = Vec::new();
        let mut table = String::from("<table class=\"wiki-content-table\">");
        let mut blocks = String::new();
        for row in 0..40 {
            let mut set = CompatHtmlFragments::new("");
            let title = set.push_html(format!("<a href=\"/page-{row}\">Page {row}</a>"));
            let author = set.push_plain(&format!("author {row}"));
            let block = set.push_block_html(format!("<div class=\"row-{row}\">x</div>"));
            let trimmed = set
                .push_block_html_trimming_preceding_space(format!("<div>t{row}</div>"));
            write!(&mut table, "<tr><td>{title}</td><td>{author}</td></tr>").unwrap();
            write!(
                &mut blocks,
                "<p>{block}</p>\n<p>text {foreign}</p> <p>{trimmed}</p>\n"
            )
            .unwrap();
            sets.push(set);
        }
        table.push_str("</table>");

        for (text, has_foreign) in [(table, false), (blocks, true)] {
            let merged = CompatHtmlFragments::restore_in_order(&sets, &text);
            assert_eq!(merged, restore_one_by_one(&sets, &text));
            assert_eq!(
                merged.contains(&foreign),
                has_foreign,
                "a foreign set's marker stays"
            );
            assert_eq!(
                merged.matches(COMPAT_HTML_MARKER_PREFIX).count(),
                usize::from(has_foreign) * 40
            );
        }
    }

    #[test]
    fn row_sets_sharing_a_paragraph_restore_as_they_do_one_by_one() {
        let mut first = CompatHtmlFragments::new("");
        let mut second = CompatHtmlFragments::new("");
        let first_block = first.push_block_html("<div>first</div>".to_owned());
        let second_block = second.push_block_html("<div>second</div>".to_owned());
        let sets = [first, second];
        let text = format!("<p>{first_block}<br>\n{second_block}</p>");

        assert_eq!(
            CompatHtmlFragments::restore_in_order(&sets, &text),
            restore_one_by_one(&sets, &text),
        );
    }

    #[test]
    fn list_pages_row_boundary_closes_unmatched_summary_html() {
        let mut fragments = CompatHtmlFragments::new("");
        let row_open = fragments.push_list_pages_container_open(
            r#"<div class="list-pages-item">"#.to_owned(),
        );
        let row_close = fragments.push_list_pages_container_close(true);

        assert_eq!(
            fragments.restore(&format!(
                "<p>{row_open}</p><div class=\"summary-owner\"><p>FIRST</p><p>{row_close}</p>",
            )),
            concat!(
                r#"<div class="list-pages-item">"#,
                r#"<div class="summary-owner"><p>FIRST</p></div>"#,
                "</div>",
            ),
        );
    }

    #[test]
    fn list_pages_row_boundary_preserves_balanced_summary_html() {
        let mut fragments = CompatHtmlFragments::new("");
        let row_open = fragments.push_list_pages_container_open(
            r#"<div class="list-pages-item">"#.to_owned(),
        );
        let row_close = fragments.push_list_pages_container_close(true);

        assert_eq!(
            fragments.restore(&format!(
                "<p>{row_open}</p><div class=\"summary-owner\">FIRST</div>\n<p>{row_close}</p>",
            )),
            concat!(
                r#"<div class="list-pages-item">"#,
                r#"<div class="summary-owner">FIRST</div>"#,
                "</div>",
            ),
        );
    }

    #[test]
    fn adjacent_list_pages_row_boundaries_restore_after_unmatched_summary_html() {
        let mut fragments = CompatHtmlFragments::new("");
        let wrapper_open =
            fragments.push_block_html(r#"<div class="list-pages-box">"#.to_owned());
        let first_open = fragments.push_list_pages_container_open(
            r#"<div class="list-pages-item">"#.to_owned(),
        );
        let first_close = fragments.push_list_pages_container_close(true);
        let second_open = fragments.push_list_pages_container_open(
            r#"<div class="list-pages-item">"#.to_owned(),
        );
        let second_close = fragments.push_list_pages_container_close(true);
        let wrapper_close = fragments.push_block_html("</div>".to_owned());
        let parsed = format!(
            "<p>{wrapper_open}</p><p>{first_open}</p><h1>FIRST</h1><p><div style=\"text-align: right;\"></p><p>{first_close}<br>\n{second_open}</p><h1>SECOND</h1><p>{second_close}</p><p>{wrapper_close}</p>",
        );

        let restored = fragments.restore(&parsed);
        assert!(!restored.contains(COMPAT_HTML_MARKER_PREFIX), "{restored}");
        assert_eq!(
            restored.matches(r#"<div class="list-pages-item">"#).count(),
            2
        );
        assert!(restored.ends_with("</div></div>"), "{restored}");
    }

    #[test]
    fn list_pages_row_close_without_its_open_boundary_remains_literal() {
        let mut fragments = CompatHtmlFragments::new("");
        let row_close = fragments.push_list_pages_container_close(true);
        let html = format!("<p>{row_close}</p>");

        assert_eq!(fragments.restore(&html), html);
    }

    #[test]
    fn paired_container_closers_survive_crossed_selected_content_tags() {
        let mut fragments = CompatHtmlFragments::new("");
        let wrapper = fragments
            .push_list_pages_container_open(r#"<div class="list-pages-box">"#.to_owned());
        let row = fragments.push_list_pages_container_open(
            r#"<div class="list-pages-item">"#.to_owned(),
        );
        let row_close = fragments.push_list_pages_container_close(true);
        let wrapper_close = fragments.push_list_pages_container_close(false);
        let ordinary = fragments.push_block_html("<div>unsafe context</div>".to_owned());
        let crossed = "<p><span></p><div><p>FIRST<br>\n</span></p></div>";
        let html = format!(
            "<p>{wrapper}</p><p>{row}</p>{crossed}<p>{row_close}</p><p>{wrapper_close}</p><span>{ordinary}</span>"
        );
        assert_eq!(
            fragments.restore(&html),
            format!(
                "<div class=\"list-pages-box\"><div class=\"list-pages-item\">{crossed}</div></div><span>{ordinary}</span>",
            )
        );
    }

    #[test]
    fn block_html_restores_after_preceding_siblings_at_root_and_in_safe_parents() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_block_html("<ul><li>trusted</li></ul>".to_owned());

        assert_eq!(
            fragments.restore(&format!("<p>before</p><p>{marker}</p>")),
            "<p>before</p><ul><li>trusted</li></ul>",
        );
        assert_eq!(
            fragments.restore(&format!("<div><p>before</p><p>{marker}</p></div>")),
            "<div><p>before</p><ul><li>trusted</li></ul></div>",
        );
        assert_eq!(
            fragments.restore(&format!("<p>before</p>{marker}")),
            "<p>before</p><ul><li>trusted</li></ul>",
        );
        assert_eq!(
            fragments.restore(&format!("<div><p>before</p>{marker}</div>")),
            "<div><p>before</p><ul><li>trusted</li></ul></div>",
        );
    }

    #[test]
    fn block_html_restores_as_a_direct_child_of_header_cells_and_list_items() {
        // Anonymous Wikidot PagePreviewModule (scp-wiki, 2026-10-11): ListPages
        // and Rate output inside [[hcell]] and [[li]] is a direct child of
        // <th>/<li>, exactly like the [[cell]] (<td>) and [[div]] controls.
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_block_html(
            r#"<div class="list-pages-box"><p>row</p></div>"#.to_owned(),
        );
        let block = r#"<div class="list-pages-box"><p>row</p></div>"#;

        for (open, close) in [
            ("<table>\n<tr>\n<th>", "</th>\n</tr>\n</table>"),
            (
                r#"<table><tr><th class="namerow" colspan="2">"#,
                "</th></tr></table>",
            ),
            ("<table><tr><td>", "</td></tr></table>"),
            ("<ul>\n<li>", "</li>\n</ul>"),
            ("<ol><li>", "</li></ol>"),
        ] {
            for body in [format!("<p>{marker}</p>"), marker.clone()] {
                let restored = fragments.restore(&format!("{open}{body}{close}"));
                assert_eq!(restored, format!("{open}{block}{close}"));
                assert!(!restored.contains(COMPAT_HTML_MARKER_PREFIX), "{restored}");
            }
        }
    }

    #[test]
    fn block_html_parent_stack_ignores_closed_siblings_and_opaque_predecessors() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_block_html("<ul><li>trusted</li></ul>".to_owned());

        assert_eq!(
            fragments.restore(&format!("<!-- <span> --> <p>before</p><p>{marker}</p>")),
            "<!-- <span> --> <p>before</p><ul><li>trusted</li></ul>",
        );
        assert_eq!(
            fragments.restore(&format!("<pre><span>source</span></pre><p>{marker}</p>")),
            "<pre><span>source</span></pre><ul><li>trusted</li></ul>",
        );
    }

    #[test]
    fn block_html_parent_stack_recovers_at_crossed_and_stray_closing_tags() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_block_html("<ul><li>trusted</li></ul>".to_owned());

        let crossed = format!("<div><span><strong>before</div><p>{marker}</p>");
        assert_eq!(
            fragments.restore(&crossed),
            "<div><span><strong>before</div><ul><li>trusted</li></ul>",
        );

        let stray = format!("</strong><div><p>{marker}</p></div>");
        assert_eq!(
            fragments.restore(&stray),
            "</strong><div><ul><li>trusted</li></ul></div>",
        );
    }

    #[test]
    fn block_html_parent_stack_accepts_abrupt_html_comment_endings() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_block_html("<ul><li>trusted</li></ul>".to_owned());

        for comment in ["<!-->", "<!--->", "</ bogus hidden>", "</1hidden>"] {
            let restored = fragments.restore(&format!("{comment}<p>{marker}</p>"));
            assert_eq!(restored, format!("{comment}<ul><li>trusted</li></ul>"));
            assert!(!restored.contains(&marker));
        }
    }

    #[test]
    fn block_html_parent_stack_fails_closed_on_malformed_tag_text() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_block_html("<ul><li>trusted</li></ul>".to_owned());

        for html in [
            format!("<span>< div><p>{marker}</p></span>"),
            format!("<x:foo><p>{marker}</p></x:foo>"),
            format!("<x:foo>{marker}</x:foo>"),
        ] {
            assert_eq!(fragments.restore(&html), html);
        }
    }

    #[test]
    fn block_html_parent_stack_follows_html_and_foreign_self_closing_rules() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_block_html("<ul><li>trusted</li></ul>".to_owned());

        for html in [
            format!("<span/><p>{marker}</p>"),
            format!("<span/>{marker}"),
        ] {
            assert_eq!(fragments.restore(&html), html);
        }
        assert_eq!(
            fragments.restore(&format!("<svg/><p>{marker}</p>")),
            "<svg/><ul><li>trusted</li></ul>",
        );
    }

    #[test]
    fn context_aware_restore_only_expands_markers_in_html_text_nodes() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_html("<b>trusted</b>".to_owned());
        let html = format!(
            "{marker}<a title=\"quoted > {marker}\">{marker}</a><!-- {marker} --><code>{marker}</code>",
        );
        assert_eq!(
            fragments.restore_outside_html_literals(&html),
            format!(
                "<b>trusted</b><a title=\"quoted > {marker}\"><b>trusted</b></a><!-- {marker} --><code>{marker}</code>",
            ),
        );
    }

    #[test]
    fn compatibility_markers_inside_pre_are_escaped_as_visible_text() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker =
            fragments.push_html("<strong>runtime fragment & text</strong>".to_owned());

        assert_eq!(
            fragments.restore(&format!("<pre>{marker}</pre>")),
            "<pre>&lt;strong&gt;runtime fragment &amp; text&lt;/strong&gt;</pre>",
        );
        assert_eq!(
            fragments.restore(&format!("<code>{marker}</code>")),
            format!("<code>{marker}</code>"),
        );
    }

    #[test]
    fn fallback_restores_registered_residual_markers_as_escaped_data_text() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_block_html("<div>trusted block</div>".to_owned());
        let html = format!(
            r#"<p>{marker}</p><a title="{marker}">{marker}</a><code>{marker}</code><pre>{marker}</pre>"#,
        );

        assert_eq!(
            fragments.restore_remaining_markers_as_text(&html),
            format!(
                r#"<p>&lt;div&gt;trusted block&lt;/div&gt;</p><a title="{marker}">&lt;div&gt;trusted block&lt;/div&gt;</a><code>{marker}</code><pre>&lt;div&gt;trusted block&lt;/div&gt;</pre>"#,
            ),
        );
    }

    #[test]
    fn block_html_never_restores_in_attributes_comments_or_opaque_elements() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_block_html("<div>trusted block</div>".to_owned());
        let html = format!(
            r#"<a title="{marker}">{marker}</a><span>{marker}</span><button>{marker}</button><h2>{marker}</h2><!-- {marker} --><code>{marker}</code><pre>{marker}</pre>"#,
        );
        assert_eq!(
            fragments.restore(&html),
            format!(
                r#"<a title="{marker}">{marker}</a><span>{marker}</span><button>{marker}</button><h2>{marker}</h2><!-- {marker} --><code>{marker}</code><pre>&lt;div&gt;trusted block&lt;/div&gt;</pre>"#,
            ),
        );
    }

    #[test]
    fn opaque_marker_does_not_poison_a_later_safe_block_parent() {
        let mut fragments = CompatHtmlFragments::new("");
        let opaque = fragments.push_block_html("<div>opaque</div>".to_owned());
        let safe = fragments.push_block_html("<div>safe</div>".to_owned());
        let html = format!(r#"<script>const marker = "{opaque}";</script><p>{safe}</p>"#);

        assert_eq!(
            fragments.restore(&html),
            format!(r#"<script>const marker = "{opaque}";</script><div>safe</div>"#,),
        );
    }

    #[test]
    fn block_html_never_uses_paragraph_unwrapping_inside_unsafe_parents() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_block_html("<div>trusted block</div>".to_owned());

        for parent in ["span", "a", "button", "h2", "code"] {
            let html = format!("<{parent}><p>{marker}</p></{parent}>");
            assert_eq!(fragments.restore(&html), html, "parent: {parent}");
        }
        assert_eq!(
            fragments.restore(&format!("<pre><p>{marker}</p></pre>")),
            "<pre><p>&lt;div&gt;trusted block&lt;/div&gt;</p></pre>",
        );
    }

    #[test]
    fn rate_blocks_follow_only_live_cross_tree_inline_parents() {
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_rate_block_html("<div>rate</div>".to_owned());

        for parent in ["span", "a"] {
            let flow = format!("<{parent}>{marker}</{parent}>");
            assert_eq!(
                fragments.restore(&flow),
                format!("<{parent}><div>rate</div></{parent}>"),
            );

            let paragraph = format!("<{parent}><p>{marker}</p></{parent}>");
            assert_eq!(fragments.restore(&paragraph), paragraph);
        }

        for parent in ["button", "h2", "code"] {
            let html = format!("<{parent}>{marker}</{parent}>");
            assert_eq!(fragments.restore(&html), html);
        }
        assert_eq!(
            fragments.restore(&format!("<pre>{marker}</pre>")),
            "<pre>&lt;div&gt;rate&lt;/div&gt;</pre>",
        );
    }

    #[test]
    fn adjacent_block_markers_split_the_paragraph_ftml_puts_around_them() {
        let mut fragments = CompatHtmlFragments::new("");
        let first = fragments.push_block_html("<div>first</div>".to_owned());
        let second = fragments.push_block_html("<div>second</div>".to_owned());

        assert_eq!(
            fragments.restore(&format!("<p>{first}<br>{second}</p>")),
            "<div>first</div><div>second</div>",
        );
    }

    #[test]
    fn block_parent_validation_scans_many_runtime_rows_linearly() {
        const ROWS: usize = 500;
        let mut fragments = CompatHtmlFragments::new("");
        let mut html = String::new();
        for index in 0..ROWS {
            let marker = fragments.push_block_html(format!("<div>row {index}</div>"));
            html.push_str(&format!("<p>{marker}</p>"));
        }

        take_html_parent_scanned_bytes();
        let restored = fragments.restore(&html);
        let scanned = take_html_parent_scanned_bytes();

        assert_eq!(restored.matches("<div>row ").count(), ROWS);
        assert!(
            scanned <= html.len().saturating_mul(3),
            "parent validation rescanned {scanned} bytes for {} input bytes",
            html.len(),
        );
    }

    #[test]
    fn block_parent_validation_scans_split_runtime_rows_linearly() {
        const ROWS: usize = 500;
        let mut fragments = CompatHtmlFragments::new("");
        let mut html = String::new();
        for index in 0..ROWS {
            let marker = fragments.push_block_html(format!("<div>row {index}</div>"));
            html.push_str(&format!("<p>before {marker} after</p>"));
        }

        take_html_parent_scanned_bytes();
        let restored = fragments.restore(&html);
        let scanned = take_html_parent_scanned_bytes();

        assert_eq!(restored.matches("<div>row ").count(), ROWS);
        assert!(
            scanned <= html.len().saturating_mul(3),
            "split-paragraph validation rescanned {scanned} bytes for {} input bytes",
            html.len(),
        );
    }

    #[test]
    fn color_restore_expands_inline_code_and_authored_code_div() {
        // An authored `<div class="code">` is an ordinary div: live Wikidot
        // renders color spans inside `[[div class="code"]]` (see
        // `component:coltop`). Only `<pre>`/`<script>`-style block literals
        // keep markers unrestored here; real `[[code]]` output is `<wj-code>`
        // at this pipeline stage.
        let mut fragments = CompatHtmlFragments::new("");
        let marker = fragments.push_html("<span>trusted</span>".to_owned());
        let html = format!(
            "<code class=\"wj-monospace\">{marker}</code><pre><code>{marker}</code></pre><div class=\"code\"><code>{marker}</code></div><script>{marker}</script>",
        );

        assert_eq!(
            fragments.restore_outside_block_html_literals(&html),
            format!(
                "<code class=\"wj-monospace\"><span>trusted</span></code><pre><code>{marker}</code></pre><div class=\"code\"><code><span>trusted</span></code></div><script>{marker}</script>",
            ),
        );
    }

    #[test]
    fn restores_plain_fragments_by_destination_without_recursion() {
        let mut fragments = CompatHtmlFragments::new("");
        let forged = format!("{COMPAT_HTML_MARKER_PREFIX}deadbeefI0X");
        let marker =
            fragments.push_plain(&format!(r#"tag ] <img onerror='x'> {forged}"#));

        assert_eq!(
            fragments.restore(&marker),
            format!(
                "tag&#x20;&#x5D;&#x20;&#x3C;img&#x20;onerror&#x3D;&#x27;x&#x27;&#x3E;&#x20;{forged}"
            ),
        );
        assert_eq!(
            fragments.restore_plain(&marker),
            format!(r#"tag ] <img onerror='x'> {forged}"#),
        );
    }
}
