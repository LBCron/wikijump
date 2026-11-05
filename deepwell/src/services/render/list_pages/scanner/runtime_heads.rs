/*
 * services/render/list_pages/scanner/runtime_heads.rs
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

use super::{
    ModuleHeadValidation, list_pages_definite_invalid_head_can_execute,
    physical_line_resume, validate_module_head,
};

pub(super) fn runtime_list_pages_key_is_supported(key: &str) -> bool {
    let mut bytes = key.bytes();
    bytes
        .next()
        .is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

pub(super) fn list_pages_bare_comparison_key_is_evidenced(key: &str) -> bool {
    matches!(
        key,
        "rating"
            | "score"
            | "votes"
            | "created_at"
            | "createdat"
            | "date"
            | "name"
            | "parent"
            | "limit"
            | "offset"
    )
}

pub(super) fn list_pages_url_quote_crossing_head_can_execute(head: &str) -> bool {
    let lower = head.to_ascii_lowercase();
    let Some(offset_start) = lower.find("offset=\"@url|") else {
        return false;
    };
    let value_start = offset_start + "offset=\"@url|".len();
    let Some(value_quote_relative) = head[value_start..].find('"') else {
        return false;
    };
    let after_value = &head[value_start + value_quote_relative + 1..];
    let after_value = after_value.trim_start_matches([' ', '\t']);
    let Some(rest) = after_value.strip_prefix("created_by=") else {
        return false;
    };
    let Some(value) = rest.strip_prefix('"') else {
        return false;
    };
    let Some(value_close) = value.find('"') else {
        return false;
    };
    !value[..value_close].is_empty() && value[value_close + 1..].trim().is_empty()
}

pub(in crate::services::render) fn runtime_regex_recognizes_entire_head(
    source: &str,
) -> bool {
    crate::services::render::module_arguments::module_arguments_are_complete(source)
}

pub(super) fn unresolved_block_conditional_prefix(source: &str) -> bool {
    const NAME: &str = "if";

    source
        .get(..NAME.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(NAME))
        && source[NAME.len()..]
            .chars()
            .next()
            .is_some_and(char::is_whitespace)
}

#[cfg(test)]
pub(in crate::services::render) fn list_pages_runtime_head_is_safe(head: &str) -> bool {
    validate_module_head(head, true) == ModuleHeadValidation::RuntimeSafe
}

pub(in crate::services::render) fn list_pages_runtime_head_can_execute(
    head: &str,
) -> bool {
    if list_pages_url_quote_crossing_head_can_execute(head) {
        return true;
    }
    match validate_module_head(head, true) {
        ModuleHeadValidation::RuntimeSafe | ModuleHeadValidation::ValidRuntimeUnsafe => {
            runtime_regex_recognizes_entire_head(head)
                || !crate::services::render::module_arguments::wikidot_list_pages_arguments(
                    head,
                )
                .is_empty()
        }
        ModuleHeadValidation::DefiniteInvalid
            if list_pages_definite_invalid_head_can_execute(head) => {
            true
        }
        _ => false,
    }
}

pub(super) fn normalize_module_head(source: &str) -> String {
    let bytes = source.as_bytes();
    let mut normalized = String::with_capacity(source.len());
    let mut cursor = 0usize;
    let mut line_leading = false;
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'\0' => {
                normalized.push(' ');
                cursor += 1;
                line_leading = false;
            }
            b'\n' | b'\r' => {
                let continued = normalized.ends_with('\\');
                if continued {
                    normalized.pop();
                } else {
                    normalized.push('\n');
                }
                cursor = physical_line_resume(bytes, cursor);
                line_leading = true;
            }
            b'\t' => {
                normalized.push_str("    ");
                cursor += 1;
                line_leading = false;
            }
            _ => {
                let character = source[cursor..]
                    .chars()
                    .next()
                    .expect("cursor is before the module head end");
                if line_leading && matches!(character, '\u{00a0}' | '\u{2007}') {
                    normalized.push(' ');
                } else {
                    normalized.push(character);
                    line_leading = false;
                }
                cursor += character.len_utf8();
            }
        }
    }
    normalized
}
