/*
 * services/render/module_arguments.rs
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::services::render) enum WikidotModuleArgumentValueKind {
    DoubleQuoted,
    SingleQuoted,
    Bare,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::services::render) struct WikidotModuleArgument<'a> {
    pub(in crate::services::render) key: &'a str,
    pub(in crate::services::render) op: &'a str,
    pub(in crate::services::render) value: &'a str,
    pub(in crate::services::render) value_kind: WikidotModuleArgumentValueKind,
}

pub(in crate::services::render) fn module_arguments_are_complete(head: &str) -> bool {
    wikidot_module_arguments(head).is_some()
}

pub(in crate::services::render) fn wikidot_module_argument<'a>(
    head: &'a str,
    name: &str,
) -> Option<&'a str> {
    wikidot_module_arguments(head)?
        .into_iter()
        .rev()
        .find(|argument| argument.key.eq_ignore_ascii_case(name))
        .map(|argument| argument.value)
}

pub(in crate::services::render) fn wikidot_module_arguments(
    head: &str,
) -> Option<Vec<WikidotModuleArgument<'_>>> {
    let mut arguments = Vec::new();
    let mut cursor = 0usize;
    skip_wikidot_argument_whitespace(head, &mut cursor);

    while cursor < head.len() {
        let key_start = cursor;
        while head.as_bytes().get(cursor).is_some_and(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
        }) {
            cursor += 1;
        }
        if cursor == key_start {
            return None;
        }
        let key = &head[key_start..cursor];
        let first_key_byte = key.as_bytes()[0];
        if !(first_key_byte.is_ascii_alphabetic() || first_key_byte == b'_') {
            return None;
        }

        skip_wikidot_argument_whitespace(head, &mut cursor);
        let op_start = cursor;
        if head.as_bytes().get(cursor) == Some(&b'!') {
            cursor += 1;
        }
        if head.as_bytes().get(cursor) != Some(&b'=') {
            return None;
        }
        cursor += 1;
        let op = &head[op_start..cursor];
        skip_wikidot_argument_whitespace(head, &mut cursor);
        if cursor >= head.len() {
            return None;
        }

        let value_start = cursor;
        let first = head[value_start..].chars().next()?;
        let value_kind;
        let value = if first == '"' {
            value_kind = WikidotModuleArgumentValueKind::DoubleQuoted;
            match wikidot_double_quoted_argument_value(head, value_start) {
                Some((value, next)) => {
                    cursor = next;
                    value
                }
                None => {
                    cursor = wikidot_bare_argument_end(head, value_start);
                    &head[value_start..cursor]
                }
            }
        } else if first == '\'' {
            value_kind = WikidotModuleArgumentValueKind::SingleQuoted;
            match wikidot_single_quoted_argument_value(head, value_start) {
                Some((value, next)) => {
                    cursor = next;
                    value
                }
                None => {
                    cursor = wikidot_bare_argument_end(head, value_start);
                    &head[value_start..cursor]
                }
            }
        } else {
            value_kind = WikidotModuleArgumentValueKind::Bare;
            cursor = wikidot_bare_argument_end(head, value_start);
            if cursor == value_start {
                return None;
            }
            &head[value_start..cursor]
        };

        arguments.push(WikidotModuleArgument {
            key,
            op,
            value,
            value_kind,
        });
        skip_wikidot_argument_whitespace(head, &mut cursor);
    }

    Some(arguments)
}

pub(in crate::services::render) fn wikidot_module_arguments_ignoring_bare_flags(
    head: &str,
) -> Option<Vec<WikidotModuleArgument<'_>>> {
    let mut arguments = Vec::new();
    let mut cursor = 0usize;
    skip_wikidot_argument_whitespace(head, &mut cursor);

    while cursor < head.len() {
        let key_start = cursor;
        while head.as_bytes().get(cursor).is_some_and(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
        }) {
            cursor += 1;
        }
        if cursor == key_start {
            return None;
        }
        let key = &head[key_start..cursor];
        let first_key_byte = key.as_bytes()[0];
        if !(first_key_byte.is_ascii_alphabetic() || first_key_byte == b'_') {
            return None;
        }

        let cursor_after_key = cursor;
        skip_wikidot_argument_whitespace(head, &mut cursor);
        let op_start = cursor;
        if head.as_bytes().get(cursor) == Some(&b'!') {
            cursor += 1;
        }
        if head.as_bytes().get(cursor) != Some(&b'=') {
            if cursor > cursor_after_key || cursor >= head.len() {
                continue;
            }
            cursor = wikidot_bare_argument_end(head, cursor);
            skip_wikidot_argument_whitespace(head, &mut cursor);
            continue;
        }
        cursor += 1;
        let op = &head[op_start..cursor];
        skip_wikidot_argument_whitespace(head, &mut cursor);
        if cursor >= head.len() {
            return None;
        }

        let value_start = cursor;
        let first = head[value_start..].chars().next()?;
        let value_kind;
        let value = if first == '"' {
            value_kind = WikidotModuleArgumentValueKind::DoubleQuoted;
            match wikidot_double_quoted_argument_value(head, value_start) {
                Some((value, next)) => {
                    cursor = next;
                    value
                }
                None => {
                    cursor = wikidot_bare_argument_end(head, value_start);
                    &head[value_start..cursor]
                }
            }
        } else if first == '\'' {
            value_kind = WikidotModuleArgumentValueKind::SingleQuoted;
            match wikidot_single_quoted_argument_value(head, value_start) {
                Some((value, next)) => {
                    cursor = next;
                    value
                }
                None => {
                    cursor = wikidot_bare_argument_end(head, value_start);
                    &head[value_start..cursor]
                }
            }
        } else {
            value_kind = WikidotModuleArgumentValueKind::Bare;
            cursor = wikidot_bare_argument_end(head, value_start);
            if cursor == value_start {
                return None;
            }
            &head[value_start..cursor]
        };

        arguments.push(WikidotModuleArgument {
            key,
            op,
            value,
            value_kind,
        });
        skip_wikidot_argument_whitespace(head, &mut cursor);
    }

    Some(arguments)
}

pub(in crate::services::render) fn wikidot_list_pages_arguments(
    head: &str,
) -> Vec<WikidotModuleArgument<'_>> {
    let mut arguments = Vec::new();
    let mut cursor = 0usize;

    while cursor < head.len() {
        skip_wikidot_argument_whitespace(head, &mut cursor);
        if cursor >= head.len() {
            break;
        }

        if head.as_bytes().get(cursor..cursor.saturating_add(4)) == Some(&b"[!--"[..]) {
            cursor = wikidot_list_pages_comment_end(head, cursor).unwrap_or(head.len());
            continue;
        }

        let key_start = cursor;
        while head.as_bytes().get(cursor).is_some_and(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
        }) {
            cursor += 1;
        }
        if cursor == key_start {
            cursor += head[cursor..]
                .chars()
                .next()
                .expect("cursor is before the end of the ListPages head")
                .len_utf8();
            continue;
        }
        if !head.as_bytes()[key_start].is_ascii_alphabetic()
            && head.as_bytes()[key_start] != b'_'
        {
            continue;
        }
        let key = &head[key_start..cursor];

        skip_wikidot_argument_whitespace(head, &mut cursor);
        let op_start = cursor;
        if matches!(head.as_bytes().get(cursor), Some(b'!' | b'<' | b'>')) {
            cursor += 1;
            if matches!(
                (head.as_bytes().get(op_start), head.as_bytes().get(cursor)),
                (Some(b'<'), Some(b'>')) | (_, Some(b'='))
            ) {
                cursor += 1;
            }
        } else if head.as_bytes().get(cursor) == Some(&b'=') {
            cursor += 1;
        } else {
            continue;
        }
        let op = &head[op_start..cursor];

        skip_wikidot_argument_whitespace(head, &mut cursor);
        if cursor >= head.len() {
            continue;
        }

        let value_start = cursor;
        let first = head[value_start..]
            .chars()
            .next()
            .expect("cursor is before the end of the ListPages head");
        let value_kind;
        let value = if first != '"'
            && first != '\''
            && wikidot_argument_key_assignment_at(head, value_start)
        {
            continue;
        } else if first == '"' {
            value_kind = WikidotModuleArgumentValueKind::DoubleQuoted;
            match wikidot_list_pages_double_quoted_argument_value(head, value_start) {
                Some((value, next)) => {
                    cursor = next;
                    value
                }
                None => {
                    cursor = wikidot_bare_argument_end(head, value_start);
                    &head[value_start..cursor]
                }
            }
        } else if first == '\'' {
            value_kind = WikidotModuleArgumentValueKind::SingleQuoted;
            match wikidot_single_quoted_argument_value(head, value_start) {
                Some((value, next)) => {
                    cursor = next;
                    value
                }
                None => {
                    cursor = wikidot_bare_argument_end(head, value_start);
                    &head[value_start..cursor]
                }
            }
        } else {
            value_kind = WikidotModuleArgumentValueKind::Bare;
            cursor = wikidot_bare_argument_end(head, value_start);
            if cursor == value_start {
                continue;
            }
            &head[value_start..cursor]
        };

        arguments.push(WikidotModuleArgument {
            key,
            op,
            value,
            value_kind,
        });
    }

    arguments
}

fn wikidot_list_pages_comment_end(head: &str, start: usize) -> Option<usize> {
    const COMMENT_OPEN_LEN: usize = 4;
    const COMMENT_CLOSE: &[u8] = b"--]";

    let content_start = start.checked_add(COMMENT_OPEN_LEN)?;
    let relative_end = head
        .as_bytes()
        .get(content_start..)?
        .windows(COMMENT_CLOSE.len())
        .position(|window| window == COMMENT_CLOSE)?;
    content_start
        .checked_add(relative_end)?
        .checked_add(COMMENT_CLOSE.len())
}

fn wikidot_list_pages_double_quoted_argument_value(
    head: &str,
    quote_start: usize,
) -> Option<(&str, usize)> {
    let value_start = quote_start + '"'.len_utf8();
    let mut cursor = value_start;
    while cursor < head.len() {
        let character = head[cursor..].chars().next()?;
        let next = cursor + character.len_utf8();
        if character == '"'
            && (wikidot_argument_boundary_at(head, next)
                || head.as_bytes().get(next) == Some(&b'@')
                || head[next..].starts_with("[!--"))
        {
            return Some((&head[value_start..cursor], next));
        }
        cursor = next;
    }
    None
}

fn wikidot_double_quoted_argument_value(
    head: &str,
    quote_start: usize,
) -> Option<(&str, usize)> {
    let mut cursor = quote_start + '"'.len_utf8();
    while cursor < head.len() {
        let character = head[cursor..].chars().next()?;
        if character == '"' && wikidot_argument_boundary_at(head, cursor + 1) {
            return Some((&head[quote_start + 1..cursor], cursor + 1));
        }
        cursor += character.len_utf8();
    }
    None
}

fn wikidot_single_quoted_argument_value(
    head: &str,
    quote_start: usize,
) -> Option<(&str, usize)> {
    let mut cursor = quote_start + '\''.len_utf8();
    while cursor < head.len() {
        let character = head[cursor..].chars().next()?;
        if character == '\'' {
            return Some((&head[quote_start + 1..cursor], cursor + 1));
        }
        cursor += character.len_utf8();
    }
    None
}

fn wikidot_bare_argument_end(head: &str, mut cursor: usize) -> usize {
    while cursor < head.len() {
        let character = head[cursor..]
            .chars()
            .next()
            .expect("cursor should point at a character boundary");
        if character.is_whitespace() || character == ']' {
            break;
        }
        cursor += character.len_utf8();
    }
    cursor
}

fn wikidot_argument_boundary_at(head: &str, mut cursor: usize) -> bool {
    if cursor >= head.len() {
        return true;
    }
    let first = head[cursor..]
        .chars()
        .next()
        .expect("cursor should point at a character boundary");
    if first.is_whitespace() {
        skip_wikidot_argument_whitespace(head, &mut cursor);
        return true;
    }
    wikidot_argument_key_assignment_at(head, cursor)
}

fn wikidot_argument_key_assignment_at(head: &str, mut cursor: usize) -> bool {
    let key_start = cursor;
    while head
        .as_bytes()
        .get(cursor)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        cursor += 1;
    }
    if cursor == key_start {
        return false;
    }
    let first_key_byte = head.as_bytes()[key_start];
    if !(first_key_byte.is_ascii_alphabetic() || first_key_byte == b'_') {
        return false;
    }
    skip_wikidot_argument_whitespace(head, &mut cursor);
    if head.as_bytes().get(cursor) == Some(&b'!') {
        cursor += 1;
    }
    head.as_bytes().get(cursor) == Some(&b'=')
}

fn skip_wikidot_argument_whitespace(head: &str, cursor: &mut usize) {
    while *cursor < head.len() {
        let character = head[*cursor..]
            .chars()
            .next()
            .expect("cursor should point at a character boundary");
        if !character.is_whitespace() {
            break;
        }
        *cursor += character.len_utf8();
    }
}

#[cfg(test)]
mod tests {
    use super::{WikidotModuleArgumentValueKind, wikidot_list_pages_arguments};

    #[test]
    fn list_pages_arguments_preserve_the_scalar_source_form() {
        let arguments = wikidot_list_pages_arguments(
            r#"limit="1" offset='2' reverse=yes range = "." "#,
        );

        assert_eq!(arguments.len(), 4);
        assert_eq!(
            arguments
                .iter()
                .map(|argument| argument.value_kind)
                .collect::<Vec<_>>(),
            vec![
                WikidotModuleArgumentValueKind::DoubleQuoted,
                WikidotModuleArgumentValueKind::SingleQuoted,
                WikidotModuleArgumentValueKind::Bare,
                WikidotModuleArgumentValueKind::DoubleQuoted,
            ],
        );
        assert_eq!(arguments[3].value, ".");
    }

    #[test]
    fn list_pages_arguments_do_not_promote_inline_comment_assignments() {
        let arguments = wikidot_list_pages_arguments(concat!(
            r#"limit="1"[!-- limit="250" order="rating" --] "#,
            r#"[!-- tags="+hidden" --] order="name""#,
        ));

        assert_eq!(
            arguments
                .iter()
                .map(|argument| (argument.key, argument.value))
                .collect::<Vec<_>>(),
            vec![("limit", "1"), ("order", "name")],
        );
    }

    #[test]
    fn list_pages_arguments_stop_at_an_unclosed_inline_comment() {
        let arguments =
            wikidot_list_pages_arguments(r#"limit="1"[!-- limit="250" order="rating""#);

        assert_eq!(
            arguments
                .iter()
                .map(|argument| (argument.key, argument.value))
                .collect::<Vec<_>>(),
            vec![("limit", "1")],
        );
    }

    #[test]
    fn list_pages_comment_tokens_inside_quoted_values_remain_value_text() {
        let arguments = wikidot_list_pages_arguments(
            r#"description="[!-- visible value --]" limit="1""#,
        );

        assert_eq!(
            arguments
                .iter()
                .map(|argument| (argument.key, argument.value))
                .collect::<Vec<_>>(),
            vec![("description", "[!-- visible value --]"), ("limit", "1"),],
        );
    }
}
