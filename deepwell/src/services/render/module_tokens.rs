/*
 * services/render/module_tokens.rs
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

//! Wikidot source-level module tokens.
//!
//! Wikidot's text parser recognizes a module only when its opener starts a
//! line and the opener's `]]` is followed by the end of that line. A module
//! written inline, or a bare opener followed by same-line text, stays literal
//! text instead of executing. An optional body between the opener line and a
//! `[[/module]]` closing line belongs to the module; our host-side expanders
//! must consume it so it does not leak into the rendered page.
//!
//! This scanner reproduces those boundaries for the modules the host expands
//! itself, and it also reproduces Wikidot's argument-absorption quirk: an
//! opener that already carries arguments may swallow a same-line body and its
//! closing tag into its argument text, which live discards as unparsed trailing
//! junk.

use super::literal_regions::LiteralRegionIndex;

const MODULE_OPENER: &str = "[[module";
const MODULE_CLOSER: &str = "[[/module]]";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct WikidotSourceModule<'a> {
    /// The module name exactly as authored.
    pub(super) name: &'a str,
    /// The authored argument text between the name and the opener's `]]`.
    pub(super) head: &'a str,
    /// The authored body between the opener line and the closing tag.
    pub(super) body: Option<&'a str>,
    /// Byte offset of the opener.
    pub(super) start: usize,
    /// Byte offset one past everything the module owns in the source.
    pub(super) end: usize,
}

pub(super) fn scan_source_modules<'a>(
    source: &'a str,
    literals: &LiteralRegionIndex,
    names: &[&str],
) -> Vec<WikidotSourceModule<'a>> {
    let bytes = source.as_bytes();
    let mut modules = Vec::new();
    let mut line_start = 0usize;
    while line_start < bytes.len() {
        let next_line = source[line_start..]
            .find('\n')
            .map_or(bytes.len(), |offset| line_start + offset + 1);
        if source[line_start..].starts_with(MODULE_OPENER)
            && !literals.contains(line_start)
            && let Some(module) =
                scan_module_at(source, bytes, literals, line_start, names)
        {
            let end = module.end;
            modules.push(module);
            line_start = end.max(next_line);
            continue;
        }
        line_start = next_line;
    }
    modules
}

pub(super) fn wikitext_has_source_module(
    source: &str,
    literals: &LiteralRegionIndex,
    names: &[&str],
) -> bool {
    !scan_source_modules(source, literals, names).is_empty()
}

fn scan_module_at<'a>(
    source: &'a str,
    bytes: &[u8],
    literals: &LiteralRegionIndex,
    start: usize,
    names: &[&str],
) -> Option<WikidotSourceModule<'a>> {
    let mut cursor = start + MODULE_OPENER.len();
    if !matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
        return None;
    }
    while matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
        cursor += 1;
    }

    let name_start = cursor;
    while bytes.get(cursor).is_some_and(|byte| {
        byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'/')
    }) {
        cursor += 1;
    }
    if cursor == name_start {
        return None;
    }
    let name = &source[name_start..cursor];
    if !names
        .iter()
        .any(|candidate| candidate.eq_ignore_ascii_case(name))
    {
        return None;
    }

    let (head, terminator, body_start) = if bytes.get(cursor) == Some(&b']') {
        if !source[cursor..].starts_with("]]") {
            return None;
        }
        let terminator = cursor + 2;
        let body_start = line_end_after(source, bytes, terminator)?;
        ("", terminator, body_start)
    } else if matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
        let terminator_start = find_opener_terminator(source, bytes, cursor)?;
        let terminator = terminator_start + 2;
        let head_source = &source[cursor..terminator_start];
        let head = match head_source.find("]]") {
            Some(index) => &head_source[..index],
            None => head_source,
        };
        let body_start = line_end_after(source, bytes, terminator)?;
        (head, terminator, body_start)
    } else {
        return None;
    };

    let (body, end) = module_body(source, literals, body_start, terminator);
    Some(WikidotSourceModule {
        name,
        head,
        body,
        start,
        end,
    })
}

/// Finds the first `]]` after an argument-bearing module name whose remaining
/// line consists only of horizontal whitespace, mirroring Wikidot's opener
/// expression (which lets `.*?` absorb a same-line body into the arguments).
fn find_opener_terminator(_source: &str, bytes: &[u8], from: usize) -> Option<usize> {
    let mut cursor = from;
    while cursor + 1 < bytes.len() {
        if bytes[cursor] == b']' && bytes[cursor + 1] == b']' {
            let mut after = cursor + 2;
            while matches!(bytes.get(after), Some(b' ' | b'\t')) {
                after += 1;
            }
            if after == bytes.len()
                || bytes[after] == b'\n'
                || (bytes[after] == b'\r' && bytes.get(after + 1) == Some(&b'\n'))
            {
                return Some(cursor);
            }
        }
        cursor += 1;
    }
    None
}

/// Returns the offset of the first byte after the opener line, or `None` when
/// the opener is not followed by the end of its line.
fn line_end_after(_source: &str, bytes: &[u8], after: usize) -> Option<usize> {
    let mut cursor = after;
    while matches!(bytes.get(cursor), Some(b' ' | b'\t')) {
        cursor += 1;
    }
    if cursor == bytes.len() {
        return Some(cursor);
    }
    match bytes[cursor] {
        b'\n' => Some(cursor + 1),
        b'\r' if bytes.get(cursor + 1) == Some(&b'\n') => Some(cursor + 2),
        _ => None,
    }
}

fn module_body<'a>(
    source: &'a str,
    literals: &LiteralRegionIndex,
    body_start: usize,
    terminator: usize,
) -> (Option<&'a str>, usize) {
    if body_start >= source.len() {
        return (None, terminator);
    }
    let Some((close_start, close_end)) = find_module_close(source, literals, body_start)
    else {
        return (None, terminator);
    };
    let body = &source[body_start..close_start];
    if body.trim().is_empty() {
        return (None, terminator);
    }
    if contains_nested_module_opener(source, literals, body_start, close_start) {
        return (None, terminator);
    }
    (Some(body), close_end)
}

fn find_module_close(
    source: &str,
    literals: &LiteralRegionIndex,
    from: usize,
) -> Option<(usize, usize)> {
    let bytes = source.as_bytes();
    let mut cursor = from;
    while let Some(offset) = source[cursor..].find("[[") {
        let position = cursor + offset;
        let end = position + MODULE_CLOSER.len();
        if end <= bytes.len()
            && source[position..end].eq_ignore_ascii_case(MODULE_CLOSER)
            && !literals.contains(position)
        {
            return Some((position, end));
        }
        cursor = position + 2;
    }
    None
}

fn contains_nested_module_opener(
    source: &str,
    literals: &LiteralRegionIndex,
    body_start: usize,
    body_end: usize,
) -> bool {
    let bytes = source.as_bytes();
    let mut cursor = body_start;
    while let Some(offset) = source[cursor..body_end].find(MODULE_OPENER) {
        let position = cursor + offset;
        let after = position + MODULE_OPENER.len();
        if matches!(bytes.get(after), Some(b' ' | b'\t')) && !literals.contains(position)
        {
            return true;
        }
        cursor = after;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tokens(
        source: &str,
        names: &[&str],
    ) -> Vec<(String, String, Option<String>, usize, usize)> {
        let literals = LiteralRegionIndex::new_wikidot_module_recognition(source);
        scan_source_modules(source, &literals, names)
            .into_iter()
            .map(|module| {
                (
                    module.name.to_owned(),
                    module.head.to_owned(),
                    module.body.map(str::to_owned),
                    module.start,
                    module.end,
                )
            })
            .collect()
    }

    #[test]
    fn own_line_openers_execute_with_arguments() {
        let found = tokens(
            "before\n[[module Members group=\"admins\"]]\nafter",
            &["Members"],
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "Members");
        assert_eq!(found[0].1, " group=\"admins\"");
        assert_eq!(found[0].2, None);

        let bare = tokens("[[module Members]]", &["Members"]);
        assert_eq!(bare.len(), 1);
        assert_eq!(bare[0].1, "");
    }

    #[test]
    fn inline_and_indented_openers_stay_literal() {
        for source in [
            "[[module Members]]x",
            "[[module Members]]x[[/module]]",
            " [[module Members]]",
            "text [[module Members]]",
        ] {
            assert!(
                tokens(source, &["Members"]).is_empty(),
                "must stay literal: {source:?}",
            );
        }
    }

    #[test]
    fn block_bodies_are_owned_and_consumed() {
        let found = tokens("[[module Members]]\nBODY\n[[/module]]\nafter", &["Members"]);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].2.as_deref(), Some("BODY\n"));
        assert_eq!(found[0].4, 35);

        let blank = tokens("[[module Members]]\n\n[[/module]]", &["Members"]);
        assert_eq!(blank.len(), 1);
        assert_eq!(blank[0].2, None, "a blank body leaves the closer literal");
    }

    #[test]
    fn argument_absorption_matches_wikidot() {
        let found = tokens(
            "[[module Members group=\"admins\"]]x[[/module]]\nafter",
            &["Members"],
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].1, " group=\"admins\"");
        assert_eq!(found[0].2, None);
        assert_eq!(found[0].4, 45);
    }

    #[test]
    fn nested_openers_are_left_to_their_own_token() {
        let found = tokens(
            "[[module Members]]\n[[module Members group=\"admins\"]]x[[/module]]",
            &["Members"],
        );
        assert_eq!(found.len(), 2, "{found:?}");
        assert_eq!(found[0].2, None);
        assert_eq!(found[1].1, " group=\"admins\"");
    }

    #[test]
    fn literal_regions_and_other_module_names_are_ignored() {
        assert!(
            tokens("[[code]]\n[[module Members]]\n[[/code]]", &["Members"]).is_empty()
        );
        assert!(tokens("[[module EmailListSubscribe]]", &["Members"]).is_empty());
        assert!(tokens("[!-- [[module Members]] --]", &["Members"]).is_empty());
    }

    #[test]
    fn module_names_match_case_insensitively() {
        let found = tokens(
            "[[module MEMBERSHIPEMAILINVITATION]]",
            &["MembershipEmailInvitation"],
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].0, "MEMBERSHIPEMAILINVITATION");
    }
}
