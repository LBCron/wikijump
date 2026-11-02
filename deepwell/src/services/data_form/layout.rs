/*
 * services/data_form/layout.rs
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
use super::scalar::{valid_wikidot_bare_url_scalar, valid_wikidot_ftp_url};
use std::collections::BTreeMap;

pub fn substitute_wikidot_data_form_layout_variables(
    layout: &str,
    definition: &DataFormDefinition,
    values: &BTreeMap<String, String>,
) -> String {
    substitute_wikidot_data_form_layout_variables_with_display(
        layout,
        definition,
        values,
        &BTreeMap::new(),
    )
}

pub fn substitute_wikidot_data_form_layout_variables_with_display(
    layout: &str,
    definition: &DataFormDefinition,
    values: &BTreeMap<String, String>,
    display_values: &BTreeMap<String, String>,
) -> String {
    let mut output = String::with_capacity(layout.len());
    let mut rest = layout;

    while let Some(relative_start) = rest.find("%%form_") {
        output.push_str(&rest[..relative_start]);
        let candidate = &rest[relative_start..];
        let (prefix, raw) = if candidate.starts_with("%%form_data{") {
            ("%%form_data{", false)
        } else if candidate.starts_with("%%form_raw{") {
            ("%%form_raw{", true)
        } else {
            output.push_str("%%form_");
            rest = &candidate["%%form_".len()..];
            continue;
        };
        let Some(relative_end) = candidate[prefix.len()..].find("}%%") else {
            output.push_str(prefix);
            rest = &candidate[prefix.len()..];
            continue;
        };
        let field_end = prefix.len() + relative_end;
        let field_name = &candidate[prefix.len()..field_end];
        let token_end = field_end + "}%%".len();
        let replacement = definition
            .field(field_name)
            .filter(|field| {
                if field.field_type.as_deref() == Some("file") {
                    return raw;
                }
                matches!(
                    field.field_type.as_deref(),
                    Some(
                        "text"
                            | "select"
                            | "checkbox"
                            | "wiki"
                            | "url"
                            | "date"
                            | "pagepath"
                    )
                )
            })
            .map(|field| {
                let value = values.get(field_name).map(String::as_str).unwrap_or("");
                if raw {
                    return (value.to_owned(), false);
                }
                let replacement = match field.field_type.as_deref() {
                    Some("select") => field
                        .value_label(value)
                        .map(str::to_owned)
                        .unwrap_or_else(|| value.to_owned()),
                    Some("url") if valid_wikidot_bare_url_scalar(value) => {
                        format!("http://{value}")
                    }
                    Some("url") if valid_wikidot_ftp_url(value) => value.to_owned(),
                    Some("pagepath") => {
                        display_values.get(field_name).cloned().unwrap_or_default()
                    }
                    _ => value.to_owned(),
                };
                let opens_url_in_new_window = field.field_type.as_deref() == Some("url")
                    && output.ends_with('*')
                    && (valid_wikidot_bare_url_scalar(value)
                        || valid_wikidot_ftp_url(value));
                if opens_url_in_new_window {
                    (format!("[*{replacement} {replacement}]"), true)
                } else {
                    (replacement, false)
                }
            });
        if let Some((replacement, strip_new_window_marker)) = replacement {
            if strip_new_window_marker {
                output.pop();
            }
            output.push_str(&replacement);
        } else {
            output.push_str(&candidate[..token_end]);
        }
        rest = &candidate[token_end..];
    }
    output.push_str(rest);
    output
}
