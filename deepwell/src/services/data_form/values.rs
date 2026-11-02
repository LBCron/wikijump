/*
 * services/data_form/values.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::DataFormDefinition;
use super::scalar::{
    parse_wikidot_stored_checkbox_scalar, parse_wikidot_stored_date_scalar,
    parse_wikidot_stored_plain_scalar, parse_wikidot_stored_text_scalar,
    parse_wikidot_stored_url_scalar, parse_wikidot_stored_wiki_scalar,
    serialize_wikidot_stored_checkbox_scalar, serialize_wikidot_stored_select_scalar,
    serialize_wikidot_stored_text_field_scalar, serialize_wikidot_stored_text_scalar,
    serialize_wikidot_stored_url_scalar, serialize_wikidot_stored_wiki_scalar,
};
use std::collections::BTreeMap;

pub fn parse_observed_wikidot_data_form_values(
    definition: &DataFormDefinition,
    wikitext: &str,
) -> Option<BTreeMap<String, String>> {
    if !definition.supports_observed_create_edit() {
        return None;
    }
    if wikitext.ends_with('\n') || wikitext.ends_with('\r') {
        return None;
    }

    if let [field] = definition.fields.as_slice()
        && field.field_type.as_deref() == Some("static")
    {
        if wikitext != "null" {
            return None;
        }
        return Some(BTreeMap::from([(
            field.name.clone(),
            field.configured_value.clone()?,
        )]));
    }

    let lines = wikitext.lines().collect::<Vec<_>>();
    if lines.len() != definition.fields.len() {
        return None;
    }

    let mut values = BTreeMap::new();
    for (line, field) in lines.into_iter().zip(&definition.fields) {
        let (name, raw_value) = line.split_once(": ")?;
        if name != field.name || values.contains_key(name) {
            return None;
        }
        let value = match field.field_type.as_deref() {
            Some("text") => parse_wikidot_stored_text_scalar(raw_value)?,
            Some("wiki") => parse_wikidot_stored_wiki_scalar(raw_value)?,
            Some("checkbox") => parse_wikidot_stored_checkbox_scalar(raw_value)?,
            Some("hidden") => {
                let value = parse_wikidot_stored_text_scalar(raw_value)?;
                (Some(value.as_str()) == field.configured_value.as_deref())
                    .then_some(value)?
            }
            Some("password") => parse_wikidot_stored_text_scalar(raw_value)?,
            Some("static") => {
                (raw_value == "null").then(|| field.configured_value.clone())??
            }
            Some("url") => parse_wikidot_stored_url_scalar(raw_value)?,
            Some("select") => {
                if raw_value == "null" {
                    String::new()
                } else {
                    let value = parse_wikidot_stored_plain_scalar(raw_value)?;
                    field.value_label(&value)?;
                    value
                }
            }
            Some("date") => parse_wikidot_stored_date_scalar(raw_value)?,
            Some("pagepath") => parse_wikidot_stored_text_scalar(raw_value)?,
            _ => return None,
        };
        let canonical = match field.field_type.as_deref() {
            Some("text") => serialize_wikidot_stored_text_field_scalar(&value),
            Some("wiki") => serialize_wikidot_stored_wiki_scalar(&value),
            Some("checkbox") => serialize_wikidot_stored_checkbox_scalar(&value),
            Some("hidden") => serialize_wikidot_stored_text_scalar(&value),
            Some("password") => serialize_wikidot_stored_text_scalar(&value),
            Some("static") => "null".to_owned(),
            Some("url") => serialize_wikidot_stored_url_scalar(&value),
            Some("select") => serialize_wikidot_stored_select_scalar(&value),
            // Wikidot stores date submissions verbatim, including malformed
            // values observed at the authenticated save boundary.
            Some("date") => raw_value.to_owned(),
            Some("pagepath") => serialize_wikidot_stored_text_scalar(&value),
            _ => return None,
        };
        if canonical != raw_value {
            return None;
        }
        values.insert(name.to_owned(), value);
    }

    Some(values)
}
