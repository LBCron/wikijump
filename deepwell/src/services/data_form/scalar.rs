/*
 * services/data_form/scalar.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

pub(super) fn parse_wikidot_stored_plain_scalar(value: &str) -> Option<String> {
    if value.starts_with('\'') {
        parse_wikidot_single_quoted_scalar(value)
    } else if valid_wikidot_stored_plain_scalar(value) {
        Some(value.to_owned())
    } else {
        None
    }
}

pub(crate) fn parse_wikidot_stored_text_scalar(value: &str) -> Option<String> {
    if value.starts_with('\'') {
        parse_wikidot_single_quoted_scalar(value)
    } else if value.starts_with('"') {
        parse_wikidot_double_quoted_scalar(value).filter(|parsed| parsed.contains('\n'))
    } else if valid_wikidot_stored_plain_scalar(value) {
        Some(value.to_owned())
    } else {
        None
    }
}

pub(super) fn parse_wikidot_stored_wiki_scalar(value: &str) -> Option<String> {
    if value.starts_with('\'') {
        parse_wikidot_single_quoted_scalar(value)
    } else if value.starts_with('"') {
        parse_wikidot_double_quoted_scalar(value).filter(|parsed| parsed.contains('\n'))
    } else if valid_wikidot_stored_wiki_plain_scalar(value) {
        Some(value.to_owned())
    } else {
        None
    }
}

pub(super) fn parse_wikidot_stored_url_scalar(value: &str) -> Option<String> {
    let parsed = if value.starts_with('\'') {
        parse_wikidot_single_quoted_scalar(value)?
    } else if valid_wikidot_bare_url_scalar(value) {
        value.to_owned()
    } else {
        return None;
    };
    (serialize_wikidot_stored_url_scalar(&parsed) == value).then_some(parsed)
}

pub(super) fn parse_wikidot_stored_date_scalar(value: &str) -> Option<String> {
    if value.contains(['\n', '\r']) {
        return None;
    }
    if value.starts_with('\'') {
        parse_wikidot_single_quoted_scalar(value)
    } else if value.starts_with('"') {
        parse_wikidot_double_quoted_scalar(value)
    } else {
        Some(value.to_owned())
    }
}

pub(super) fn valid_wikidot_bare_url_scalar(value: &str) -> bool {
    let (host, path) = value.split_once('/').unwrap_or((value, ""));
    host.split('.').count() >= 2
        && host.split('.').all(|part| {
            !part.is_empty()
                && part.chars().all(|character| {
                    character.is_ascii_alphanumeric() || character == '-'
                })
        })
        && path.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '.' | '-' | '_' | '/')
        })
}

pub(super) fn valid_wikidot_ftp_url(value: &str) -> bool {
    value
        .strip_prefix("ftp://")
        .is_some_and(valid_wikidot_bare_url_scalar)
}

fn valid_wikidot_stored_wiki_plain_scalar(value: &str) -> bool {
    valid_wikidot_stored_plain_scalar(value)
        || (value.starts_with('/')
            && value.len() > 1
            && !value.chars().any(char::is_whitespace))
}

pub(super) fn parse_wikidot_stored_checkbox_scalar(value: &str) -> Option<String> {
    parse_wikidot_single_quoted_scalar(value)
        .filter(|parsed| matches!(parsed.as_str(), "0" | "1"))
}

fn valid_wikidot_stored_plain_scalar(value: &str) -> bool {
    let mut characters = value.chars();
    let Some(first) = characters.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && characters.all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-' | '.')
        })
        && !matches!(
            value.to_ascii_lowercase().as_str(),
            "false" | "no" | "null" | "off" | "on" | "true" | "yes"
        )
}

pub(super) fn serialize_wikidot_stored_text_field_scalar(value: &str) -> String {
    if value.is_empty() {
        return "''".to_owned();
    }
    serialize_wikidot_stored_text_scalar(value)
}

pub(super) fn serialize_wikidot_stored_text_scalar(value: &str) -> String {
    if value.contains('\n') {
        let mut output = String::with_capacity(value.len() + 2);
        output.push('"');
        for character in value.chars() {
            match character {
                '\\' => output.push_str(r"\\"),
                '"' => output.push_str(r#"\""#),
                '\n' => output.push_str(r"\n"),
                _ => output.push(character),
            }
        }
        output.push('"');
        output
    } else {
        serialize_wikidot_stored_select_scalar(value)
    }
}

pub(super) fn serialize_wikidot_stored_wiki_scalar(value: &str) -> String {
    if value.contains('\n') {
        serialize_wikidot_stored_text_scalar(value)
    } else if valid_wikidot_stored_wiki_plain_scalar(value) {
        value.to_owned()
    } else {
        serialize_wikidot_stored_select_scalar(value)
    }
}

pub(super) fn serialize_wikidot_stored_url_scalar(value: &str) -> String {
    if valid_wikidot_bare_url_scalar(value) {
        value.to_owned()
    } else {
        serialize_wikidot_stored_text_scalar(value)
    }
}

pub(super) fn serialize_wikidot_stored_checkbox_scalar(value: &str) -> String {
    format!("'{}'", if value == "1" { "1" } else { "0" })
}

pub(super) fn serialize_wikidot_stored_select_scalar(value: &str) -> String {
    if value.is_empty() {
        return "null".to_owned();
    }
    if valid_wikidot_stored_plain_scalar(value) {
        value.to_owned()
    } else {
        format!("'{}'", value.replace('\'', "''"))
    }
}

fn parse_wikidot_single_quoted_scalar(value: &str) -> Option<String> {
    let inner = value.strip_prefix('\'')?.strip_suffix('\'')?;
    let mut output = String::with_capacity(inner.len());
    let mut characters = inner.chars().peekable();
    while let Some(character) = characters.next() {
        if character == '\'' {
            characters.next_if_eq(&'\'')?;
            output.push('\'');
        } else {
            output.push(character);
        }
    }
    Some(output)
}

fn parse_wikidot_double_quoted_scalar(value: &str) -> Option<String> {
    let inner = value.strip_prefix('"')?.strip_suffix('"')?;
    let mut output = String::with_capacity(inner.len());
    let mut characters = inner.chars();
    while let Some(character) = characters.next() {
        if character != '\\' {
            output.push(character);
            continue;
        }
        output.push(match characters.next()? {
            '\\' => '\\',
            '"' => '"',
            'n' => '\n',
            'r' => '\r',
            't' => '\t',
            _ => return None,
        });
    }
    Some(output)
}

pub(super) fn unquote_wikidot_data_form_scalar(value: &str) -> &str {
    if value.len() >= 2 {
        let first = value.as_bytes()[0];
        let last = value.as_bytes()[value.len() - 1];
        if matches!((first, last), (b'\'', b'\'') | (b'"', b'"')) {
            return &value[1..value.len() - 1];
        }
    }

    value
}

pub(super) fn parse_wikidot_data_form_text_scalar(value: &str) -> String {
    if quoted_wikidot_data_form_scalar(value) {
        return unquote_wikidot_data_form_scalar(value).to_owned();
    }

    let value = strip_wikidot_data_form_scalar_comment(value).trim_end();
    if value.is_empty()
        || value == "~"
        || matches!(
            value.to_ascii_lowercase().as_str(),
            "false" | "null" | "true"
        )
    {
        String::new()
    } else {
        value.to_owned()
    }
}

pub(super) fn nonempty_wikidot_data_form_text_scalar(value: &str) -> Option<String> {
    let value = parse_wikidot_data_form_text_scalar(value);
    (!value.is_empty()).then_some(value)
}

pub(super) fn parse_wikidot_data_form_join(value: &str) -> bool {
    if quoted_wikidot_data_form_scalar(value) {
        return php_string_truthy(unquote_wikidot_data_form_scalar(value));
    }

    let value = strip_wikidot_data_form_scalar_comment(value).trim_end();
    if value.is_empty() || value == "~" || value.eq_ignore_ascii_case("null") {
        return false;
    }
    if value.eq_ignore_ascii_case("false") {
        return false;
    }
    if value.eq_ignore_ascii_case("true") {
        return true;
    }
    php_string_truthy(value)
}

pub(super) fn quoted_wikidot_data_form_scalar(value: &str) -> bool {
    if value.len() < 2 {
        return false;
    }
    matches!(
        (value.as_bytes()[0], value.as_bytes()[value.len() - 1]),
        (b'\'', b'\'') | (b'"', b'"')
    )
}

fn strip_wikidot_data_form_scalar_comment(value: &str) -> &str {
    let bytes = value.as_bytes();
    for (index, byte) in bytes.iter().enumerate() {
        if *byte != b'#' {
            continue;
        }
        let preceded_by_space = index == 0 || bytes[index - 1].is_ascii_whitespace();
        let escaped = index > 0 && bytes[index - 1] == b'\\';
        if preceded_by_space && !escaped {
            return &value[..index];
        }
    }
    value
}

fn php_string_truthy(value: &str) -> bool {
    !value.is_empty() && value != "0"
}
