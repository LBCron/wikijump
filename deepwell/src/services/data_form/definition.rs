/*
 * services/data_form/definition.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::scalar::{
    nonempty_wikidot_data_form_text_scalar, parse_wikidot_data_form_join,
    parse_wikidot_data_form_text_scalar, quoted_wikidot_data_form_scalar,
    unquote_wikidot_data_form_scalar,
};
use super::{DataFormDefinition, DataFormFieldDefinition, DataFormValueDefinition};
use std::collections::{BTreeMap, BTreeSet};

pub fn parse_wikidot_data_form_definition(wikitext: &str) -> Option<DataFormDefinition> {
    let form_start = wikitext.find("[[form]]")?;
    let start = form_start + "[[form]]".len();
    let end = wikitext[start..].find("[[/form]]")? + start;
    let form_close_end = end + "[[/form]]".len();
    let body = &wikitext[start..end];
    let prefix = &wikitext[..form_start];
    let suffix = &wikitext[form_close_end..];
    let custom_layout = wikidot_data_form_custom_layout_source_from_prefix(prefix);
    let comment_wrapped = wikidot_data_form_comment_wrapper(prefix, suffix);
    let mut definition = DataFormDefinition {
        default_layout: !prefix.lines().any(|line| line.trim() == "===="),
        observed_create_edit_compatible: wikitext
            .lines()
            .filter(|line| line.trim() == "[[form]]")
            .count()
            == 1
            && wikitext
                .lines()
                .filter(|line| line.trim() == "[[/form]]")
                .count()
                == 1
            && (((prefix.lines().all(|line| line.trim().is_empty())
                || custom_layout.is_some())
                && suffix.lines().all(|line| line.trim().is_empty()))
                || comment_wrapped),
        ..Default::default()
    };
    let mut in_fields = false;
    let mut saw_fields = false;
    let mut current_field: Option<String> = None;
    let mut current_values_field: Option<String> = None;
    let mut current_options_field: Option<String> = None;
    let mut current_properties = BTreeSet::<String>::new();

    for line in body.lines() {
        let line = line.trim_end();
        let indent = line.bytes().take_while(|byte| *byte == b' ').count();
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if trimmed.starts_with('#') {
            definition.observed_create_edit_compatible = false;
            continue;
        }
        if indent == 0 && trimmed == "fields:" {
            if saw_fields {
                definition.observed_create_edit_compatible = false;
            }
            saw_fields = true;
            in_fields = true;
            current_field = None;
            current_values_field = None;
            current_options_field = None;
            current_properties.clear();
            continue;
        }
        if !in_fields {
            definition.observed_create_edit_compatible = false;
            continue;
        }
        if indent == 2
            && let Some(field) = trimmed.strip_suffix(':')
            && valid_wikidot_data_form_field_name(field)
        {
            if definition.field(field).is_none() {
                definition.fields.push(DataFormFieldDefinition {
                    name: field.to_owned(),
                    ..Default::default()
                });
            } else {
                definition.observed_create_edit_compatible = false;
            }
            current_field = Some(field.to_owned());
            current_values_field = None;
            current_options_field = None;
            current_properties.clear();
            continue;
        }
        if indent == 2 {
            definition.observed_create_edit_compatible = false;
            current_field = None;
            current_values_field = None;
            current_options_field = None;
            current_properties.clear();
            continue;
        }
        let Some(field_name) = current_field.as_deref() else {
            definition.observed_create_edit_compatible = false;
            continue;
        };
        if indent == 4 {
            let Some((key, value)) = trimmed.split_once(':') else {
                definition.observed_create_edit_compatible = false;
                current_values_field = None;
                continue;
            };
            let key = key.trim();
            let value = value.trim();
            if !current_properties.insert(key.to_owned()) {
                definition.observed_create_edit_compatible = false;
            }
            if let Some(field) = definition.field_mut(field_name) {
                field.authored_properties.insert(key.to_owned());
            }
            if key != "options" {
                current_options_field = None;
            }
            match key {
                "label" => {
                    if definition
                        .field(field_name)
                        .is_some_and(|field| !field.label.is_empty())
                    {
                        definition.observed_create_edit_compatible = false;
                    }
                    if let Some(field) = definition.field_mut(field_name) {
                        field.label = parse_wikidot_data_form_text_scalar(value);
                    }
                    current_values_field = None;
                }
                "hint" => {
                    if definition
                        .field(field_name)
                        .is_some_and(|field| !field.hint.is_empty())
                    {
                        definition.observed_create_edit_compatible = false;
                    }
                    if let Some(field) = definition.field_mut(field_name) {
                        field.hint = parse_wikidot_data_form_text_scalar(value);
                    }
                    current_values_field = None;
                }
                "type" => {
                    if definition
                        .field(field_name)
                        .is_some_and(|field| field.field_type.is_some())
                    {
                        definition.observed_create_edit_compatible = false;
                    }
                    if let Some(field) = definition.field_mut(field_name) {
                        field.field_type =
                            Some(unquote_wikidot_data_form_scalar(value).to_owned());
                    }
                    current_values_field = None;
                }
                "default" => {
                    if definition
                        .field(field_name)
                        .is_some_and(|field| field.default_value.is_some())
                    {
                        definition.observed_create_edit_compatible = false;
                    }
                    if let Some(field) = definition.field_mut(field_name) {
                        field.default_value =
                            Some(unquote_wikidot_data_form_scalar(value).to_owned());
                    }
                    current_values_field = None;
                }
                "value" => {
                    if definition
                        .field(field_name)
                        .is_some_and(|field| field.configured_value.is_some())
                    {
                        definition.observed_create_edit_compatible = false;
                    }
                    if let Some(field) = definition.field_mut(field_name) {
                        field.configured_value =
                            Some(unquote_wikidot_data_form_scalar(value).to_owned());
                    }
                    current_values_field = None;
                }
                "width" => {
                    if let Some(field) = definition.field_mut(field_name) {
                        field.authored_width = Some(value.to_owned());
                        field.has_text_specific_properties = true;
                    }
                    current_values_field = None;
                }
                "height" => {
                    if let Some(field) = definition.field_mut(field_name) {
                        field.authored_height = Some(value.to_owned());
                        field.has_text_specific_properties = true;
                    }
                    current_values_field = None;
                }
                "match" => {
                    if definition
                        .field(field_name)
                        .is_some_and(|field| field.match_pattern.is_some())
                    {
                        definition.observed_create_edit_compatible = false;
                    }
                    if let Some(field) = definition.field_mut(field_name) {
                        field.match_pattern =
                            nonempty_wikidot_data_form_text_scalar(value);
                        field.has_text_specific_properties = true;
                    }
                    current_values_field = None;
                }
                "match-error" => {
                    if definition
                        .field(field_name)
                        .is_some_and(|field| field.match_error.is_some())
                    {
                        definition.observed_create_edit_compatible = false;
                    }
                    if let Some(field) = definition.field_mut(field_name) {
                        field.match_error = nonempty_wikidot_data_form_text_scalar(value);
                        field.has_text_specific_properties = true;
                    }
                    current_values_field = None;
                }
                "before" => {
                    if let Some(field) = definition.field_mut(field_name) {
                        field.before = parse_wikidot_data_form_text_scalar(value);
                    }
                    current_values_field = None;
                }
                "after" => {
                    if let Some(field) = definition.field_mut(field_name) {
                        field.after = parse_wikidot_data_form_text_scalar(value);
                    }
                    current_values_field = None;
                }
                "join" => {
                    if let Some(field) = definition.field_mut(field_name) {
                        field.join = parse_wikidot_data_form_join(value);
                    }
                    current_values_field = None;
                }
                "category" => {
                    if definition
                        .field(field_name)
                        .is_some_and(|field| field.pagepath_category.is_some())
                    {
                        definition.observed_create_edit_compatible = false;
                    }
                    if let Some(field) = definition.field_mut(field_name) {
                        let category = unquote_wikidot_data_form_scalar(value).to_owned();
                        if category.is_empty() {
                            field.pagepath_options_valid = false;
                        }
                        field.pagepath_category = Some(category);
                    }
                    current_values_field = None;
                }
                "max-level" => {
                    if definition
                        .field(field_name)
                        .is_some_and(|field| field.pagepath_max_level.is_some())
                    {
                        definition.observed_create_edit_compatible = false;
                    }
                    if let Some(field) = definition.field_mut(field_name) {
                        let raw = unquote_wikidot_data_form_scalar(value);
                        match raw.parse::<usize>() {
                            Ok(level) if level > 0 => {
                                field.pagepath_max_level = Some(level)
                            }
                            _ => field.pagepath_options_valid = false,
                        }
                    }
                    current_values_field = None;
                }
                "values" if value.is_empty() => {
                    if definition
                        .field(field_name)
                        .is_some_and(|field| field.has_values_property)
                    {
                        definition.observed_create_edit_compatible = false;
                    }
                    if let Some(field) = definition.field_mut(field_name) {
                        field.has_values_property = true;
                        current_values_field = Some(field_name.to_owned());
                    } else {
                        definition.observed_create_edit_compatible = false;
                        current_values_field = None;
                    }
                }
                "options" if value.is_empty() => {
                    current_values_field = None;
                    current_options_field = Some(field_name.to_owned());
                }
                _ => {
                    definition.observed_create_edit_compatible = false;
                    current_values_field = None;
                }
            }
            continue;
        }
        if indent == 6
            && current_options_field.as_deref() == Some(field_name)
            && let Some((key, value)) = trimmed.split_once(':')
        {
            let key = key.trim();
            if key.is_empty() {
                definition.observed_create_edit_compatible = false;
                continue;
            }
            let Some(field) = definition.field_mut(field_name) else {
                definition.observed_create_edit_compatible = false;
                continue;
            };
            let value = value.trim();
            if value.is_empty() || field.options.contains_key(key) {
                field.options_valid = false;
            }
            field
                .options
                .insert(key.to_owned(), parse_wikidot_data_form_option(value));
            continue;
        }
        if indent == 6
            && current_values_field.as_deref() == Some(field_name)
            && let Some((value, label)) = trimmed.split_once(':')
        {
            let value = unquote_wikidot_data_form_scalar(value.trim()).to_owned();
            let raw_label = label.trim();
            if matches!(raw_label, "False" | "True") {
                continue;
            }
            let label = unquote_wikidot_data_form_scalar(raw_label).to_owned();
            if value.is_empty() || label.is_empty() {
                definition.observed_create_edit_compatible = false;
                continue;
            }
            let duplicate = definition.field(field_name).is_some_and(|field| {
                field
                    .values
                    .iter()
                    .any(|candidate| candidate.value == value)
            });
            if duplicate {
                definition.observed_create_edit_compatible = false;
            }
            let Some(field) = definition.field_mut(field_name) else {
                definition.observed_create_edit_compatible = false;
                continue;
            };
            if let Some(candidate) = field
                .values
                .iter_mut()
                .find(|candidate| candidate.value == value)
            {
                candidate.label = label;
            } else {
                field.values.push(DataFormValueDefinition { value, label });
            }
            continue;
        }

        definition.observed_create_edit_compatible = false;
    }

    for field in &mut definition.fields {
        if field.field_type.is_none() {
            field.field_type = Some("text".to_owned());
        }
        match field.field_type.as_deref() {
            Some("wiki") => {
                field.width = field
                    .authored_width
                    .as_deref()
                    .map(parse_wikidot_wiki_width)
                    .unwrap_or(40);
                field.height = field
                    .authored_height
                    .as_deref()
                    .map(parse_wikidot_wiki_height)
                    .unwrap_or(2);
                // Live Wikidot accepts these text-only properties on a wiki
                // field but does not validate the submitted wiki source.
                field.match_pattern = None;
                field.match_error = None;
            }
            Some("checkbox") => {
                if let Some(value) = field.default_value.as_mut() {
                    *value = if wikidot_checkbox_default_is_checked(value) {
                        "1".to_owned()
                    } else {
                        "0".to_owned()
                    };
                }
            }
            _ => {
                field.width = field
                    .authored_width
                    .as_deref()
                    .map(parse_wikidot_text_width)
                    .unwrap_or(40);
                field.height = field
                    .authored_height
                    .as_deref()
                    .map(parse_wikidot_text_height)
                    .unwrap_or(1);
            }
        }
    }
    definition.observed_create_edit_compatible &= saw_fields;
    Some(definition)
}

fn wikidot_data_form_comment_wrapper(prefix: &str, suffix: &str) -> bool {
    prefix.trim() == "[!--" && suffix.trim() == "--]"
}

pub fn wikidot_data_form_custom_layout_source(wikitext: &str) -> Option<&str> {
    let form_start = wikitext.find("[[form]]")?;
    wikidot_data_form_custom_layout_source_from_prefix(&wikitext[..form_start])
}

fn wikidot_data_form_custom_layout_source_from_prefix(prefix: &str) -> Option<&str> {
    let mut offset = 0usize;
    let mut separator_start = None;
    for segment in prefix.split_inclusive('\n') {
        let line = segment.strip_suffix('\n').unwrap_or(segment);
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.trim() == "====" {
            if separator_start.is_some() {
                return None;
            }
            separator_start = Some(offset);
        } else if separator_start.is_some() && !line.trim().is_empty() {
            return None;
        }
        offset += segment.len();
    }

    separator_start.map(|start| &prefix[..start])
}
fn valid_wikidot_data_form_field_name(value: &str) -> bool {
    !value.is_empty()
        && value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
        })
}

fn parse_wikidot_text_width(value: &str) -> usize {
    value
        .parse::<i64>()
        .ok()
        .and_then(|width| usize::try_from(width.max(1)).ok())
        .unwrap_or(40)
}

fn parse_wikidot_data_form_option(value: &str) -> serde_json::Value {
    let value = value.trim();
    if quoted_wikidot_data_form_scalar(value) {
        return serde_json::Value::String(
            unquote_wikidot_data_form_scalar(value).to_owned(),
        );
    }
    if value.starts_with('[') || value.ends_with(']') {
        let Some(items) = value
            .strip_prefix('[')
            .and_then(|value| value.strip_suffix(']'))
        else {
            return serde_json::Value::Object(serde_json::Map::new());
        };
        return serde_json::Value::Array(
            items
                .split(',')
                .map(|item| parse_wikidot_data_form_option(item.trim()))
                .collect(),
        );
    }
    if value.starts_with('{') || value.ends_with('}') {
        return serde_json::Value::Object(serde_json::Map::new());
    }
    match value.to_ascii_lowercase().as_str() {
        "true" => return serde_json::Value::Bool(true),
        "false" => return serde_json::Value::Bool(false),
        "null" | "~" => return serde_json::Value::Null,
        _ => {}
    }
    if let Ok(number) = value.parse::<i64>() {
        return serde_json::Value::Number(number.into());
    }
    serde_json::Value::String(value.to_owned())
}

pub(super) fn valid_wikidot_date_options(
    options: &BTreeMap<String, serde_json::Value>,
) -> bool {
    options.iter().all(|(name, value)| match name.as_str() {
        "altField" | "altFormat" | "appendText" | "buttonImage" | "buttonText"
        | "closeText" | "currentText" | "dateFormat" | "nextText" | "prevText"
        | "weekHeader" | "yearRange" | "yearSuffix" => value.is_string(),
        "dayNames" | "dayNamesMin" | "dayNamesShort" => {
            valid_wikidot_date_string_array(value, 7)
        }
        "monthNames" | "monthNamesShort" => valid_wikidot_date_string_array(value, 12),
        "autoSize" | "buttonImageOnly" | "changeMonth" | "changeYear"
        | "hideIfNoPrevNext" | "isRTL" | "showButtonPanel" | "showMonthAfterYear"
        | "showWeek" => value.is_boolean(),
        "firstDay" | "showCurrentAtPos" | "stepMonths" => value.as_i64().is_some(),
        "defaultDate" | "maxDate" | "minDate" => {
            value.is_null() || value.is_string() || value.as_i64().is_some()
        }
        "duration" => {
            value.as_i64().is_some()
                || matches!(value, serde_json::Value::String(value) if matches!(
                    value.as_str(),
                    "slow" | "normal" | "fast"
                ))
        }
        "numberOfMonths" => {
            value.as_i64().is_some() || valid_wikidot_date_integer_array(value, 2)
        }
        "shortYearCutoff" => value.as_i64().is_some() || value.is_string(),
        "showAnim" => matches!(
            value,
            serde_json::Value::String(value)
                if matches!(value.as_str(), "show" | "slideDown" | "fadeIn")
        ),
        "showOn" => matches!(
            value,
            serde_json::Value::String(value)
                if matches!(value.as_str(), "focus" | "button" | "both")
        ),
        _ => false,
    })
}

fn valid_wikidot_date_string_array(
    value: &serde_json::Value,
    expected_len: usize,
) -> bool {
    let serde_json::Value::Array(items) = value else {
        return false;
    };
    items.len() == expected_len
        && items
            .iter()
            .all(|item| item.as_str().is_some_and(|item| !item.is_empty()))
}

fn valid_wikidot_date_integer_array(
    value: &serde_json::Value,
    expected_len: usize,
) -> bool {
    let serde_json::Value::Array(items) = value else {
        return false;
    };
    items.len() == expected_len && items.iter().all(|item| item.as_i64().is_some())
}

fn parse_wikidot_text_height(value: &str) -> usize {
    value
        .parse::<i64>()
        .ok()
        .filter(|height| *height >= 2)
        .and_then(|height| usize::try_from(height).ok())
        .unwrap_or(1)
}

pub(super) fn parse_wikidot_wiki_width(value: &str) -> usize {
    value
        .parse::<i64>()
        .ok()
        .and_then(|width| usize::try_from(width.max(20)).ok())
        .unwrap_or(40)
}

pub(super) fn parse_wikidot_wiki_height(value: &str) -> usize {
    value
        .parse::<i64>()
        .ok()
        .and_then(|height| usize::try_from(if height < 2 { 1 } else { height }).ok())
        .unwrap_or(2)
}

pub(super) fn wikidot_checkbox_default_is_checked(value: &str) -> bool {
    value
        .parse::<f64>()
        .ok()
        .is_some_and(|numeric| numeric.is_finite() && numeric == 1.0)
}
