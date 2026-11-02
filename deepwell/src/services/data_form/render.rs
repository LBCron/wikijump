/*
 * services/data_form/render.rs
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

pub fn render_wikidot_data_form_table(
    definition: &DataFormDefinition,
    values: &BTreeMap<String, String>,
) -> String {
    render_wikidot_data_form_table_with_wiki_html(definition, values, &BTreeMap::new())
}

pub fn render_wikidot_data_form_table_with_wiki_html(
    definition: &DataFormDefinition,
    values: &BTreeMap<String, String>,
    rendered_wiki_values: &BTreeMap<String, String>,
) -> String {
    render_wikidot_data_form_table_with_runtime_html(
        definition,
        values,
        rendered_wiki_values,
        &BTreeMap::new(),
    )
}

pub fn render_wikidot_data_form_table_with_runtime_html(
    definition: &DataFormDefinition,
    values: &BTreeMap<String, String>,
    rendered_wiki_values: &BTreeMap<String, String>,
    display_values: &BTreeMap<String, String>,
) -> String {
    let mut html = String::from(r#"<table class="form-table"><tbody>"#);
    for (index, field) in definition.fields.iter().enumerate() {
        let joined = index > 0 && field.join;
        if !joined {
            if index > 0 {
                html.push_str("</td></tr>");
            }
            html.push_str(r#"<tr class="form-row"><td class="form-labels">"#);
            if !field.label.is_empty() {
                html.push_str(r#"<span class="form-label">"#);
                append_wikidot_data_form_display_text(&mut html, &field.label);
                html.push_str("</span>");
            }
            html.push_str(r#"</td><td class="form-values">"#);
        } else {
            html.push(' ');
            if !field.label.is_empty() {
                html.push_str(r#"<span class="form-label">"#);
                append_wikidot_data_form_display_text(&mut html, &field.label);
                html.push_str("</span>");
            }
        }
        let raw_value = values.get(&field.name).map(String::as_str).unwrap_or("");
        let display_value = match field.field_type.as_deref() {
            Some("select") => field.value_label(raw_value).unwrap_or(raw_value),
            Some("pagepath") => display_values
                .get(&field.name)
                .map(String::as_str)
                .unwrap_or(""),
            _ => raw_value,
        };
        if matches!(field.field_type.as_deref(), Some("wiki" | "static")) {
            html.push_str(r#"<div class="form-value field-"#);
            html.push_str(&field.name);
            html.push_str(r#"">"#);
            if !field.before.is_empty() {
                append_wikidot_data_form_wiki_affix(&mut html, &field.before);
            }
            if let Some(rendered) = rendered_wiki_values.get(&field.name) {
                html.push_str(rendered);
            } else {
                append_wikidot_data_form_wiki_affix(&mut html, display_value);
            }
            if !field.after.is_empty() {
                append_wikidot_data_form_wiki_affix(&mut html, &field.after);
            }
            html.push_str("</div>");
            continue;
        }
        html.push_str("<span>");
        if !field.before.is_empty() {
            append_wikidot_data_form_display_text(&mut html, field.before.trim());
            html.push(' ');
        }
        match field.field_type.as_deref() {
            Some("password") => {
                html.extend(std::iter::repeat_n('*', display_value.chars().count()))
            }
            Some("url") => append_wikidot_data_form_url(&mut html, display_value),
            _ => append_wikidot_data_form_display_text(&mut html, display_value),
        }
        if !field.after.is_empty() {
            html.push(' ');
            append_wikidot_data_form_display_text(&mut html, field.after.trim());
        }
        html.push_str("</span>");
    }
    if !definition.fields.is_empty() {
        html.push_str("</td></tr>");
    }
    html.push_str("</tbody></table>");
    html
}

fn append_wikidot_data_form_url(output: &mut String, value: &str) {
    let href = if valid_wikidot_bare_url_scalar(value) {
        Some(format!("http://{value}"))
    } else if valid_wikidot_ftp_url(value) {
        Some(value.to_owned())
    } else {
        None
    };
    let Some(href) = href else {
        append_wikidot_data_form_display_text(output, value);
        return;
    };
    output.push_str(r#"<a href="#);
    output.push('"');
    output.push_str(&escape_html_attribute(&href));
    output.push_str(r#"">"#);
    append_wikidot_data_form_display_text(output, &href);
    output.push_str("</a>");
}

fn append_wikidot_data_form_wiki_affix(output: &mut String, value: &str) {
    output.push_str(r#"<p><span style="white-space: pre-wrap;">"#);
    output.push_str(&escape_html_text(value));
    output.push_str("</span></p>");
}

fn append_wikidot_data_form_display_text(output: &mut String, value: &str) {
    if value.contains(['<', '>', '\n']) {
        for (index, line) in value.split('\n').enumerate() {
            if index > 0 {
                output.push_str("<br>\n");
            }
            output.push_str(r#"<span style="white-space: pre-wrap;">"#);
            output.push_str(&escape_html_text(line));
            output.push_str("</span>");
        }
    } else {
        output.push_str(&escape_html_text(value));
    }
}

fn escape_html_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn escape_html_attribute(value: &str) -> String {
    escape_html_text(value)
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}
