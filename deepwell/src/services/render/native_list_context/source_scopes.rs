use std::ops::Range;

use super::super::literal_regions::{
    LiteralRegionIndex, TextTokenCursor, WikidotTagScan, scan_wikidot_tag,
};

pub(in crate::services::render) fn collect_unproven_scope_ranges(
    source: &str,
    literals: &LiteralRegionIndex,
) -> Vec<Range<usize>> {
    let bytes = source.as_bytes();
    let mut literal_cursor = literals.monotone_cursor();
    let mut text_tokens = TextTokenCursor::new(source);
    let mut open_scopes = BoundedOpenSourceScopes::new();
    let mut ranges = Vec::new();
    let mut cursor = 0usize;

    while cursor < bytes.len() {
        if let Some(end) = literal_cursor.advance_to_containing_end(cursor) {
            cursor = end;
            continue;
        }
        if bytes.get(cursor..cursor + 2) != Some(&b"[["[..]) {
            cursor += 1;
            continue;
        }

        let mut scanned_tokens = text_tokens.clone();
        match scan_wikidot_tag(
            bytes,
            cursor,
            bytes.len(),
            true,
            true,
            &mut scanned_tokens,
        ) {
            WikidotTagScan::Complete(end) => {
                match source_scope_tag(bytes, cursor, end) {
                    Some(SourceScopeTag::Open(head)) => {
                        let identity = source_scope_rule(&head.name)
                            .map(|mut rule| {
                                if !rule.accepts_open(&head) {
                                    rule.safety = SourceScopeSafety::Unproven;
                                }
                                SourceScopeIdentity::Known(rule)
                            })
                            .unwrap_or(SourceScopeIdentity::Unknown(head.name));
                        if !open_scopes.try_push(OpenSourceScope {
                            identity,
                            start: cursor,
                        }) {
                            return std::iter::once(0..source.len()).collect();
                        }
                    }
                    Some(SourceScopeTag::Close(name)) => {
                        if let Some(open) = open_scopes.take_matching_close(&name)
                            && !open.is_proven_safe()
                        {
                            ranges.push(open.start..end);
                        }
                    }
                    None => {}
                }
                text_tokens = scanned_tokens;
                cursor = end;
            }
            WikidotTagScan::Malformed { resume } => cursor = resume.max(cursor + 1),
            WikidotTagScan::Unclosed => break,
        }
    }

    for open in open_scopes {
        if open.is_known_body_owner() {
            ranges.push(open.start..source.len());
        }
    }

    ranges
}

pub(in crate::services::render) fn matching_source_scope_close(
    source: &str,
    literals: &LiteralRegionIndex,
    scope_start: usize,
) -> Option<Range<usize>> {
    let bytes = source.as_bytes();
    if bytes.get(scope_start..scope_start + 2) != Some(&b"[["[..]) {
        return None;
    }
    let mut literal_cursor = literals.monotone_cursor();
    let mut text_tokens = TextTokenCursor::new(source);
    let mut open_scopes = BoundedOpenSourceScopes::new();
    let mut cursor = scope_start;

    while cursor < bytes.len() {
        if let Some(end) = literal_cursor.advance_to_containing_end(cursor) {
            cursor = end;
            continue;
        }
        if bytes.get(cursor..cursor + 2) != Some(&b"[["[..]) {
            cursor += 1;
            continue;
        }

        let mut scanned_tokens = text_tokens.clone();
        match scan_wikidot_tag(
            bytes,
            cursor,
            bytes.len(),
            true,
            true,
            &mut scanned_tokens,
        ) {
            WikidotTagScan::Complete(end) => {
                match source_scope_tag(bytes, cursor, end) {
                    Some(SourceScopeTag::Open(head)) => {
                        let identity = source_scope_rule(&head.name)
                            .map(SourceScopeIdentity::Known)
                            .unwrap_or(SourceScopeIdentity::Unknown(head.name));
                        if !open_scopes.try_push(OpenSourceScope {
                            identity,
                            start: cursor,
                        }) {
                            return None;
                        }
                    }
                    Some(SourceScopeTag::Close(name)) => {
                        if let Some(open) = open_scopes.take_matching_close(&name)
                            && open.start == scope_start
                        {
                            return Some(cursor..end);
                        }
                    }
                    None => {}
                }
                text_tokens = scanned_tokens;
                cursor = end;
            }
            WikidotTagScan::Malformed { resume } => cursor = resume.max(cursor + 1),
            WikidotTagScan::Unclosed => return None,
        }
    }
    None
}

enum SourceScopeTag {
    Open(SourceScopeOpenHead),
    Close(String),
}

struct SourceScopeOpenHead {
    name: String,
    starred: bool,
    scored: bool,
}

#[derive(Clone, Copy)]
struct SourceScopeRule {
    close_names: &'static [&'static str],
    safety: SourceScopeSafety,
    accepts_star: bool,
    accepts_score: bool,
}

impl SourceScopeRule {
    fn accepts_open(&self, head: &SourceScopeOpenHead) -> bool {
        (!head.starred || self.accepts_star) && (!head.scored || self.accepts_score)
    }
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum SourceScopeSafety {
    ProvenSafe,
    Unproven,
}

enum SourceScopeIdentity {
    Known(SourceScopeRule),
    Unknown(String),
}

struct OpenSourceScope {
    identity: SourceScopeIdentity,
    start: usize,
}

impl OpenSourceScope {
    fn accepts_close(&self, name: &str) -> bool {
        match &self.identity {
            SourceScopeIdentity::Known(rule) => rule.close_names.contains(&name),
            SourceScopeIdentity::Unknown(open_name) => open_name == name,
        }
    }

    fn is_proven_safe(&self) -> bool {
        matches!(
            &self.identity,
            SourceScopeIdentity::Known(SourceScopeRule {
                safety: SourceScopeSafety::ProvenSafe,
                ..
            })
        )
    }

    fn is_known_body_owner(&self) -> bool {
        matches!(&self.identity, SourceScopeIdentity::Known(_))
    }
}

struct BoundedOpenSourceScopes {
    scopes: Vec<OpenSourceScope>,
}

impl BoundedOpenSourceScopes {
    const MAX_DEPTH: usize = 1_024;

    fn new() -> Self {
        Self { scopes: Vec::new() }
    }

    fn try_push(&mut self, scope: OpenSourceScope) -> bool {
        if self.scopes.len() >= Self::MAX_DEPTH {
            return false;
        }
        self.scopes.push(scope);
        true
    }

    fn take_matching_close(&mut self, name: &str) -> Option<OpenSourceScope> {
        let index = self
            .scopes
            .iter()
            .rposition(|open| open.accepts_close(name))?;
        Some(self.scopes.remove(index))
    }
}

impl IntoIterator for BoundedOpenSourceScopes {
    type Item = OpenSourceScope;
    type IntoIter = std::vec::IntoIter<OpenSourceScope>;

    fn into_iter(self) -> Self::IntoIter {
        self.scopes.into_iter()
    }
}

fn source_scope_tag(bytes: &[u8], start: usize, end: usize) -> Option<SourceScopeTag> {
    let close_body_end = end.checked_sub(2)?;
    let mut cursor = start + 2;
    while matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
        cursor += 1;
    }
    let closing = bytes.get(cursor) == Some(&b'/');
    let mut starred = false;
    if closing {
        cursor += 1;
        while matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
            cursor += 1;
        }
    } else if bytes.get(cursor) == Some(&b'*') {
        starred = true;
        cursor += 1;
        while matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
            cursor += 1;
        }
    }
    let name_start = cursor;
    while cursor < close_body_end
        && !matches!(bytes[cursor], b' ' | b'\t' | b'\r' | b'\n')
    {
        cursor += 1;
    }
    let name = bytes.get(name_start..cursor)?;
    if name.is_empty() {
        return None;
    }
    if closing
        && !bytes[cursor..close_body_end]
            .iter()
            .all(|byte| matches!(*byte, b' ' | b'\t'))
    {
        return None;
    }
    let (name, scored) = normalize_source_scope_name(name);
    Some(if closing {
        SourceScopeTag::Close(name)
    } else {
        SourceScopeTag::Open(SourceScopeOpenHead {
            name,
            starred,
            scored,
        })
    })
}

fn normalize_source_scope_name(name: &[u8]) -> (String, bool) {
    let name = String::from_utf8_lossy(name).to_ascii_lowercase();
    let scored = name.ends_with('_');
    (name.strip_suffix('_').unwrap_or(&name).to_owned(), scored)
}

fn source_scope_rule(name: &str) -> Option<SourceScopeRule> {
    use SourceScopeSafety::{ProvenSafe, Unproven};

    let (close_names, safety): (&[&str], SourceScopeSafety) = match name {
        "div" => (&["div"], ProvenSafe),
        "blockquote" | "quote" => (&["blockquote", "quote"], ProvenSafe),
        "<" => (&["<"], ProvenSafe),
        ">" => (&[">"], ProvenSafe),
        "=" => (&["="], ProvenSafe),
        "==" => (&["=="], ProvenSafe),
        "a" | "anchor" => (&["a", "anchor"], Unproven),
        "bibliography" => (&["bibliography"], Unproven),
        "b" | "bold" | "strong" => (&["b", "bold", "strong"], Unproven),
        "code" => (&["code"], Unproven),
        "collapsible" => (&["collapsible"], Unproven),
        "del" | "deletion" => (&["del", "deletion"], Unproven),
        "footnote" => (&["footnote"], Unproven),
        "hidden" => (&["hidden"], Unproven),
        "html" => (&["html"], Unproven),
        "ifcategory" => (&["ifcategory"], Unproven),
        "iftags" => (&["iftags"], Unproven),
        "ins" | "insertion" => (&["ins", "insertion"], Unproven),
        "invisible" => (&["invisible"], Unproven),
        "i" | "italics" | "em" | "emphasis" => {
            (&["i", "italics", "em", "emphasis"], Unproven)
        }
        "ul" => (&["ul"], Unproven),
        "ol" => (&["ol"], Unproven),
        "li" => (&["li"], Unproven),
        "mark" | "highlight" => (&["mark", "highlight"], Unproven),
        "math" => (&["math"], Unproven),
        "module" | "module654" => (&["module", "module654"], Unproven),
        "tt" | "mono" | "monospace" => (&["tt", "mono", "monospace"], Unproven),
        "p" | "paragraph" => (&["p", "paragraph"], Unproven),
        "raw" => (&["raw"], Unproven),
        "ruby" => (&["ruby"], Unproven),
        "rt" | "rubytext" => (&["rt", "rubytext"], Unproven),
        "rb" | "ruby2" => (&["rb", "ruby2"], Unproven),
        "s" | "strikethrough" => (&["s", "strikethrough"], Unproven),
        "size" => (&["size"], Unproven),
        "span" => (&["span"], Unproven),
        "sub" | "subscript" => (&["sub", "subscript"], Unproven),
        "sup" | "super" | "superscript" => (&["sup", "super", "superscript"], Unproven),
        "table" => (&["table"], Unproven),
        "row" => (&["row"], Unproven),
        "cell" => (&["cell"], Unproven),
        "hcell" => (&["hcell", "cell"], Unproven),
        "tabview" | "tabs" => (&["tabview", "tabs"], Unproven),
        "tab" => (&["tab"], Unproven),
        "u" | "underline" => (&["u", "underline"], Unproven),
        _ => return None,
    };

    Some(SourceScopeRule {
        close_names,
        safety,
        accepts_star: false,
        accepts_score: name == "div",
    })
}
