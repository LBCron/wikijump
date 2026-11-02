use super::{CompatTextFragments, Range, RenderService};

#[derive(Clone, Copy, PartialEq, Eq)]
enum WikidotAlignment {
    Center,
    Left,
    Right,
}

struct WikidotAlignmentMarker {
    range: Range<usize>,
    alignment: WikidotAlignment,
    is_closer: bool,
    trailing_whitespace: bool,
    skipped: bool,
}

impl RenderService {
    /// Trim the leading whitespace of a Wikidot page source.
    ///
    /// Wikidot trims the whitespace at the start of a page source before it
    /// parses, so an indented first block head owns its block instead of
    /// printing as authored text. The trim belongs to the page source, so
    /// included text, which lands inside the document, keeps its own leading
    /// whitespace.
    pub(super) fn trim_wikidot_document_leading_whitespace(wikitext: &mut String) {
        let trimmed = wikitext.trim_start_matches([' ', '\t', '\n', '\r']);
        if trimmed.len() == wikitext.len() {
            return;
        }
        *wikitext = trimmed.to_owned();
    }

    /// Rewrite the Wikidot alignment markers that own a block into the
    /// alignment divs they stand for.
    ///
    /// Wikidot accepts leading whitespace before a line-start marker, but a
    /// trailing space or tab means the line is not a block head. A marker
    /// only owns a block when an opener and a closer of the same alignment
    /// pair, and a pair with trailing whitespace on either side owns no
    /// block at all: both markers then print as their authored text.
    ///
    /// The pairing is decided on the whole expanded document, so an opener
    /// and its closer may live in different included sources. A comment or
    /// another literal region never splits a pair: when only one side of a
    /// pair scans inside a literal region, both sides stay raw, so the
    /// pinned FTML still pairs them exactly as it did before the
    /// expanded-document normalization.
    pub(super) fn normalize_wikidot_alignment_markers(
        wikitext: &mut String,
        preserved: &mut CompatTextFragments,
    ) {
        let source = wikitext.clone();
        let markers = Self::wikidot_alignment_markers(&source);
        if markers.is_empty() {
            return;
        }

        let mut openers: Vec<usize> = Vec::new();
        let mut pairs: Vec<(usize, usize)> = Vec::new();
        for (index, marker) in markers.iter().enumerate() {
            if marker.is_closer {
                if let Some(opener) = openers.last().copied()
                    && markers[opener].alignment == marker.alignment
                {
                    openers.pop();
                    pairs.push((opener, index));
                }
            } else {
                openers.push(index);
            }
        }

        let mut owns_block = vec![false; markers.len()];
        let mut split_raw = vec![false; markers.len()];
        for (opener, closer) in pairs {
            if markers[opener].trailing_whitespace || markers[closer].trailing_whitespace
            {
                continue;
            }
            if markers[opener].skipped || markers[closer].skipped {
                split_raw[opener] = true;
                split_raw[closer] = true;
                continue;
            }
            owns_block[opener] = true;
            owns_block[closer] = true;
        }

        let mut output = String::with_capacity(source.len());
        let mut last = 0usize;
        for (index, marker) in markers.iter().enumerate() {
            output.push_str(&source[last..marker.range.start]);
            if owns_block[index] {
                output.push_str(Self::wikidot_alignment_div(marker));
            } else if marker.skipped || split_raw[index] {
                output.push_str(&source[marker.range.clone()]);
            } else {
                output.push_str(
                    &preserved.push_escaped_html_text(&source[marker.range.clone()]),
                );
            }
            last = marker.range.end;
        }
        output.push_str(&source[last..]);
        *wikitext = output;
    }

    fn wikidot_alignment_markers(source: &str) -> Vec<WikidotAlignmentMarker> {
        let mut markers = Vec::new();

        for (start, _end, line) in Self::wikitext_line_ranges(source) {
            let line_body = line.strip_suffix('\n').unwrap_or(line);
            let trimmed = line_body.trim();
            let Some((alignment, is_closer)) =
                Self::wikidot_alignment_marker_kind(trimmed)
            else {
                continue;
            };

            let leading = line_body.len() - line_body.trim_start().len();
            let marker_start = start + leading;
            let skipped = Self::is_inside_wikidot_literal_region(source, marker_start);

            let marker_end = marker_start + trimmed.len();
            let line_body_end = start + line_body.len();
            markers.push(WikidotAlignmentMarker {
                range: marker_start..marker_end,
                alignment,
                is_closer,
                trailing_whitespace: marker_end < line_body_end,
                skipped,
            });
        }

        markers
    }

    fn wikidot_alignment_marker_kind(marker: &str) -> Option<(WikidotAlignment, bool)> {
        match marker {
            "[[=]]" => Some((WikidotAlignment::Center, false)),
            "[[<]]" | "[[&lt;]]" => Some((WikidotAlignment::Left, false)),
            "[[>]]" | "[[&gt;]]" => Some((WikidotAlignment::Right, false)),
            "[[/=]]" => Some((WikidotAlignment::Center, true)),
            "[[/<]]" | "[[/&lt;]]" => Some((WikidotAlignment::Left, true)),
            "[[/>]]" | "[[/&gt;]]" => Some((WikidotAlignment::Right, true)),
            _ => None,
        }
    }

    fn wikidot_alignment_div(marker: &WikidotAlignmentMarker) -> &'static str {
        if marker.is_closer {
            return "[[/div]]";
        }
        match marker.alignment {
            WikidotAlignment::Center => "[[div style=\"text-align: center;\"]]",
            WikidotAlignment::Left => "[[div style=\"text-align: left;\"]]",
            WikidotAlignment::Right => "[[div style=\"text-align: right;\"]]",
        }
    }
}
