/*
 * services/render/mail_form_module.rs
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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU Affero
 * General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

use std::collections::HashMap;
use std::sync::LazyLock;

use ftml::settings::WikitextSettings;
use regex::Regex;

use sha1::{Digest, Sha1};

use super::compat::CompatHtmlFragments;
use super::literal_regions::LiteralRegionIndex;
use super::module_arguments::wikidot_module_double_quoted_arguments;
use super::module_tokens::scan_source_modules;
use super::service::{escape_list_pages_html_attr, escape_list_pages_html_text};

pub(super) const MAIL_FORM_MODULE_NAMES: &[&str] = &["MailForm"];

const MAIL_FORM_DEFAULT_SIZE: u32 = 30;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) enum MailFormFieldType {
    #[default]
    Text,
    Textarea,
    Select,
    Checkbox,
}

/// The authored validation rules of one MailForm field.
///
/// Length limits are byte lengths, matching the PHP `strlen` semantics of
/// Wikidot's server-side validation.
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct MailFormRules {
    pub(crate) required: bool,
    pub(crate) min_length: Option<usize>,
    pub(crate) max_length: Option<usize>,
    pub(crate) match_pattern: Option<String>,
    pub(crate) number: bool,
    pub(crate) min_value: Option<f64>,
    pub(crate) max_value: Option<f64>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct MailFormField {
    pub(crate) name: String,
    pub(crate) title: Option<String>,
    pub(crate) field_type: MailFormFieldType,
    pub(crate) size: Option<u32>,
    pub(crate) default: Option<String>,
    pub(crate) hint: Option<String>,
    pub(crate) options: Vec<(String, String)>,
    pub(crate) rules: MailFormRules,
}

impl MailFormField {
    fn new(name: String) -> Self {
        MailFormField {
            name,
            title: None,
            field_type: MailFormFieldType::Text,
            size: None,
            default: None,
            hint: None,
            options: Vec::new(),
            rules: MailFormRules::default(),
        }
    }

    fn size(&self) -> u32 {
        self.size.unwrap_or(MAIL_FORM_DEFAULT_SIZE)
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct MailFormDefinition {
    pub(crate) recipients: Option<String>,
    pub(crate) button: Option<String>,
    pub(crate) format_csv: bool,
    pub(crate) email_title: Option<String>,
    pub(crate) success_page: Option<String>,
    pub(crate) fields: Vec<MailFormField>,
}

fn mail_form_argument<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    wikidot_module_double_quoted_arguments(head)
        .into_iter()
        .rev()
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value)
}

pub(crate) fn parse_mail_form_definition(head: &str, body: &str) -> MailFormDefinition {
    let mut definition = MailFormDefinition {
        recipients: mail_form_argument(head, "to").map(str::to_owned),
        button: mail_form_argument(head, "button").map(str::to_owned),
        format_csv: mail_form_argument(head, "format")
            .is_some_and(|value| value.trim().eq_ignore_ascii_case("csv")),
        email_title: mail_form_argument(head, "title").map(str::to_owned),
        success_page: mail_form_argument(head, "successPage").map(str::to_owned),
        fields: Vec::new(),
    };
    parse_mail_form_fields(body, &mut definition.fields);
    definition
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MailFormSubList {
    None,
    Options,
    Rules,
}

fn parse_mail_form_fields(body: &str, fields: &mut Vec<MailFormField>) {
    let mut current: Option<usize> = None;
    let mut base_indent: Option<usize> = None;
    let mut sub_list = MailFormSubList::None;

    for line in body.lines() {
        let content = line.trim_start_matches([' ', '\t']);
        let indent = line.len() - content.len();
        if content.trim().is_empty() {
            continue;
        }

        if indent == 0
            && let Some(name) = content.strip_prefix('#')
        {
            let name = name.trim();
            current = None;
            base_indent = None;
            sub_list = MailFormSubList::None;
            if valid_mail_form_field_name(name) {
                fields.push(MailFormField::new(name.to_owned()));
                current = Some(fields.len() - 1);
            }
            continue;
        }

        let Some(bullet) = content.strip_prefix('*') else {
            continue;
        };
        let Some(field_index) = current else {
            continue;
        };
        let field = &mut fields[field_index];
        let bullet = bullet.trim_start_matches([' ', '\t']);
        let Some((key, value)) = bullet.split_once(':') else {
            continue;
        };
        let key = key.trim();
        let value = value.trim_start_matches([' ', '\t']);

        let base = *base_indent.get_or_insert(indent);
        if indent > base {
            match sub_list {
                MailFormSubList::Options => {
                    field
                        .options
                        .push((key.to_owned(), value.trim().to_owned()));
                }
                MailFormSubList::Rules => {
                    apply_mail_form_rule(&mut field.rules, key, value);
                }
                MailFormSubList::None => {}
            }
            continue;
        }

        sub_list = MailFormSubList::None;
        if key.eq_ignore_ascii_case("title") {
            field.title = Some(value.trim().to_owned());
        } else if key.eq_ignore_ascii_case("type") {
            field.field_type = parse_mail_form_field_type(value);
        } else if key.eq_ignore_ascii_case("size") {
            field.size = value.trim().parse().ok();
        } else if key.eq_ignore_ascii_case("default") {
            field.default = Some(value.to_owned());
        } else if key.eq_ignore_ascii_case("hint") {
            field.hint = Some(value.trim().to_owned());
        } else if key.eq_ignore_ascii_case("options") {
            sub_list = MailFormSubList::Options;
        } else if key.eq_ignore_ascii_case("rules") {
            sub_list = MailFormSubList::Rules;
        }
    }
}

fn valid_mail_form_field_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '_' | '-')
        })
}

fn parse_mail_form_field_type(value: &str) -> MailFormFieldType {
    match value.trim().to_ascii_lowercase().as_str() {
        "textarea" => MailFormFieldType::Textarea,
        "select" => MailFormFieldType::Select,
        "checkbox" => MailFormFieldType::Checkbox,
        _ => MailFormFieldType::Text,
    }
}

fn apply_mail_form_rule(rules: &mut MailFormRules, key: &str, value: &str) {
    let value = value.trim();
    if key.eq_ignore_ascii_case("required") {
        rules.required = mail_form_rule_flag(value);
    } else if key.eq_ignore_ascii_case("minLength") {
        rules.min_length = value.parse().ok();
    } else if key.eq_ignore_ascii_case("maxLength") {
        rules.max_length = value.parse().ok();
    } else if key.eq_ignore_ascii_case("match") {
        rules.match_pattern = Some(value.to_owned());
    } else if key.eq_ignore_ascii_case("number") {
        rules.number = mail_form_rule_flag(value);
    } else if key.eq_ignore_ascii_case("minValue") {
        rules.min_value = value.parse().ok();
    } else if key.eq_ignore_ascii_case("maxValue") {
        rules.max_value = value.parse().ok();
    }
}

fn mail_form_rule_flag(value: &str) -> bool {
    !value.is_empty() && value != "0" && !value.eq_ignore_ascii_case("false")
}

/// PHP truthiness of a field default, which is what live's templates test.
fn mail_form_php_truthy(value: &str) -> bool {
    !value.is_empty() && value != "0"
}

pub(crate) fn mail_form_definition_handle(
    definition: &MailFormDefinition,
    instance: usize,
    page_id: Option<i64>,
) -> String {
    let mut canonical = String::new();
    canonical.push_str(&format!("instance={instance}\n"));
    for (key, value) in [
        ("to", &definition.recipients),
        ("button", &definition.button),
        ("title", &definition.email_title),
        ("successPage", &definition.success_page),
    ] {
        canonical.push_str(&format!("{key}={}\n", value.as_deref().unwrap_or("")));
    }
    canonical.push_str(&format!("format_csv={}\n", definition.format_csv));
    for field in &definition.fields {
        canonical.push_str(&format!(
            "field={} type={:?} title={} size={} default={} hint={}\n",
            field.name,
            field.field_type,
            field.title.as_deref().unwrap_or(""),
            field.size(),
            field.default.as_deref().unwrap_or(""),
            field.hint.as_deref().unwrap_or(""),
        ));
        for (value, label) in &field.options {
            canonical.push_str(&format!("option={value}={label}\n"));
        }
        canonical.push_str(&format!("rules={:?}\n", field.rules));
    }
    let digest = Sha1::digest(canonical.as_bytes());
    let mut hex = String::with_capacity(32);
    for byte in &digest[..16] {
        hex.push_str(&format!("{byte:02x}"));
    }
    format!("{hex}_{}", page_id.unwrap_or(0))
}

pub(crate) const MAIL_FORM_TITLE_ERROR_HTML: &str =
    r#"<div class="error-block">The title="..." attribute is not valid.</div>"#;

pub(crate) fn render_mail_form_module(
    definition: &MailFormDefinition,
    instance: usize,
    page_id: Option<i64>,
) -> String {
    if definition
        .email_title
        .as_deref()
        .is_some_and(|title| title.chars().count() > 200)
    {
        return MAIL_FORM_TITLE_ERROR_HTML.to_owned();
    }
    let button = definition
        .button
        .as_deref()
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .unwrap_or("Send");
    let handle = mail_form_definition_handle(definition, instance, page_id);

    let mut output = String::new();
    output.push_str(&format!(
        r#"<div class="mailform-box" id="mailform-box-{instance}">"#
    ));
    output.push_str(&format!(
        concat!(
            r#"<form id="mailform-{instance}" "#,
            r#"action="javascript:WIKIDOT.modules.MailFormModule.listeners.send(null, '{instance}')">"#,
        ),
        instance = instance,
    ));
    output.push_str(r#"<table class="form">"#);
    for field in &definition.fields {
        render_mail_form_field_row(&mut output, field, instance);
    }
    output.push_str("</table>");
    output.push_str(&format!(
        concat!(
            r#"<div class="buttons">"#,
            r#"<input type="button" value="{}" "#,
            r#"onclick="WIKIDOT.modules.MailFormModule.listeners.send(event, '{instance}')"/>"#,
            "</div>",
        ),
        escape_list_pages_html_attr(button),
        instance = instance,
    ));
    output.push_str("</form>");
    output.push_str(&format!(
        r#"<div id="mailformdef-{instance}" style="display: none;">{handle}</div>"#
    ));
    output.push_str("</div>");
    output
}

fn render_mail_form_field_row(
    output: &mut String,
    field: &MailFormField,
    instance: usize,
) {
    let name_attr = escape_list_pages_html_attr(&field.name);
    let title = field.title.as_deref().unwrap_or(&field.name);
    output.push_str(&format!(
        r#"<tr id="mailform-row-{instance}-{name_attr}"><td>{}</td><td><div class="field-error-message"></div>"#,
        escape_list_pages_html_text(title),
    ));
    match field.field_type {
        MailFormFieldType::Text => {
            output.push_str(&format!(
                r#"<input name="{name_attr}" class="text" type="text""#
            ));
            if let Some(default) = &field.default
                && mail_form_php_truthy(default)
            {
                output.push_str(&format!(
                    r#" value="{}""#,
                    escape_list_pages_html_attr(default)
                ));
            }
            output.push_str(&format!(r#" size="{}""#, field.size()));
            if let Some(max_length) = field.rules.max_length {
                output.push_str(&format!(r#" maxlength="{max_length}""#));
            }
            output.push_str("/>");
        }
        MailFormFieldType::Textarea => {
            output.push_str(&format!(
                r#"<textarea name="{name_attr}" cols="{}" rows="5">"#,
                field.size(),
            ));
            if let Some(default) = &field.default {
                output.push_str(&escape_list_pages_html_text(default));
            }
            output.push_str("</textarea>");
        }
        MailFormFieldType::Select => {
            output.push_str(&format!(r#"<select name="{name_attr}" class="select">"#));
            let default = field
                .default
                .as_deref()
                .filter(|default| mail_form_php_truthy(default));
            if default.is_none() {
                output.push_str(r#"<option value="">-- Please select --</option>"#);
            }
            for (value, label) in &field.options {
                output.push_str(&format!(
                    r#"<option value="{}""#,
                    escape_list_pages_html_attr(value)
                ));
                if default == Some(value.as_str()) {
                    output.push_str(r#" selected="selected""#);
                }
                output.push_str(&format!(
                    ">{}</option>",
                    escape_list_pages_html_text(label)
                ));
            }
            output.push_str("</select>");
        }
        MailFormFieldType::Checkbox => {
            output.push_str(&format!(
                r#"<input name="{name_attr}" class="checkbox" type="checkbox""#
            ));
            if field.default.as_deref().is_some_and(mail_form_php_truthy) {
                output.push_str(r#" checked="checked""#);
            }
            output.push_str("/>");
        }
    }
    output.push_str("</td></tr>");
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum MailFormRuleViolation {
    Required,
    MinLength(usize),
    MaxLength(usize),
    Match,
    Number,
    MinValue(f64),
    MaxValue(f64),
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct MailFormFieldError {
    pub(crate) field: String,
    pub(crate) violation: MailFormRuleViolation,
}

pub(crate) fn validate_mail_form_submission(
    definition: &MailFormDefinition,
    values: &HashMap<String, String>,
) -> Vec<MailFormFieldError> {
    let mut errors = Vec::new();
    for field in &definition.fields {
        let value = values.get(&field.name).map_or("", String::as_str);
        let rules = &field.rules;
        if value.is_empty() {
            if rules.required {
                errors.push(MailFormFieldError {
                    field: field.name.clone(),
                    violation: MailFormRuleViolation::Required,
                });
            }
            continue;
        }
        if let Some(min_length) = rules.min_length
            && value.len() < min_length
        {
            errors.push(MailFormFieldError {
                field: field.name.clone(),
                violation: MailFormRuleViolation::MinLength(min_length),
            });
        }
        if let Some(max_length) = rules.max_length
            && value.len() > max_length
        {
            errors.push(MailFormFieldError {
                field: field.name.clone(),
                violation: MailFormRuleViolation::MaxLength(max_length),
            });
        }
        if let Some(pattern) = &rules.match_pattern
            && !mail_form_pattern_matches(pattern, value)
        {
            errors.push(MailFormFieldError {
                field: field.name.clone(),
                violation: MailFormRuleViolation::Match,
            });
        }
        let numeric = value.parse::<f64>().ok();
        if rules.number && numeric.is_none() {
            errors.push(MailFormFieldError {
                field: field.name.clone(),
                violation: MailFormRuleViolation::Number,
            });
        }
        if let (Some(number), Some(min_value)) = (numeric, rules.min_value)
            && number < min_value
        {
            errors.push(MailFormFieldError {
                field: field.name.clone(),
                violation: MailFormRuleViolation::MinValue(min_value),
            });
        }
        if let (Some(number), Some(max_value)) = (numeric, rules.max_value)
            && number > max_value
        {
            errors.push(MailFormFieldError {
                field: field.name.clone(),
                violation: MailFormRuleViolation::MaxValue(max_value),
            });
        }
    }
    errors
}

fn mail_form_pattern_matches(pattern: &str, value: &str) -> bool {
    let Some(regex) = compile_mail_form_pattern(pattern) else {
        return true;
    };
    regex.is_match(value)
}

fn compile_mail_form_pattern(pattern: &str) -> Option<regex::Regex> {
    let pattern = pattern.trim();
    let (body, case_insensitive) = match pattern.strip_prefix('/') {
        Some(rest) => match rest.rfind('/') {
            Some(index) => (&rest[..index], rest[index + 1..].contains('i')),
            None => (pattern, false),
        },
        None => (pattern, false),
    };
    let body = if case_insensitive {
        format!("(?i){body}")
    } else {
        body.to_owned()
    };
    regex::Regex::new(&body).ok()
}

pub(crate) fn mail_form_error_message(violation: &MailFormRuleViolation) -> String {
    match violation {
        MailFormRuleViolation::Required => "This field is required.".to_owned(),
        MailFormRuleViolation::MinLength(_) => "This field is too short.".to_owned(),
        MailFormRuleViolation::MaxLength(_) => "This field is too long.".to_owned(),
        MailFormRuleViolation::Match => "This field has an invalid value.".to_owned(),
        MailFormRuleViolation::Number => "This field should be a number.".to_owned(),
        MailFormRuleViolation::MinValue(_) => "This field is too small.".to_owned(),
        MailFormRuleViolation::MaxValue(_) => "This field is too large.".to_owned(),
    }
}

static MAILFORM_MODULE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?is)\[\[module\s+MailForm\b(?P<head>(?:[^\]"]+|"[^"]*")*)\]\]"#)
        .expect("MailForm module expression is valid")
});

struct MailFormOccurrence<'a> {
    start: usize,
    end: usize,
    head: &'a str,
    body: &'a str,
}

fn mail_form_occurrences(wikitext: &str) -> Vec<MailFormOccurrence<'_>> {
    let literal_regions = LiteralRegionIndex::new_wikidot_module_recognition(wikitext);
    scan_source_modules(wikitext, &literal_regions, MAIL_FORM_MODULE_NAMES)
        .into_iter()
        .map(|module| MailFormOccurrence {
            start: module.start,
            end: module.end,
            head: module.head,
            body: module.body.unwrap_or(""),
        })
        .collect()
}

pub(crate) fn find_mail_form_definition(
    wikitext: &str,
    page_id: i64,
    handle: &str,
) -> Option<MailFormDefinition> {
    for (index, occurrence) in mail_form_occurrences(wikitext).into_iter().enumerate() {
        let definition = parse_mail_form_definition(occurrence.head, occurrence.body);
        if mail_form_definition_handle(&definition, index + 1, Some(page_id)) == handle {
            return Some(definition);
        }
    }
    None
}

pub(super) fn expand_mail_form_modules(
    wikitext: String,
    settings: &WikitextSettings,
    page_id: Option<i64>,
    compat_html: &mut CompatHtmlFragments,
) -> String {
    if !settings.enable_page_syntax || !MAILFORM_MODULE_REGEX.is_match(&wikitext) {
        return wikitext;
    }

    let occurrences = mail_form_occurrences(&wikitext);
    if occurrences.is_empty() {
        return wikitext;
    }

    let mut output = String::with_capacity(wikitext.len());
    let mut cursor = 0;
    for (index, occurrence) in occurrences.into_iter().enumerate() {
        let definition = parse_mail_form_definition(occurrence.head, occurrence.body);
        let rendered = render_mail_form_module(&definition, index + 1, page_id);
        output.push_str(&wikitext[cursor..occurrence.start]);
        output.push_str(&compat_html.push_block_html(rendered));
        cursor = occurrence.end;
    }
    output.push_str(&wikitext[cursor..]);
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    const FAKE_LOGIN_HEAD: &str = r#" to="aaaa (DUMMY)" button="""#;
    const FAKE_LOGIN_BODY: &str = concat!(
        "\n# name\n",
        " * title: ID\n",
        " * type: text\n",
        " * default: driosua\n",
        " * rules:\n",
        "  * required: true\n",
        "  * maxLength: 10\n",
        "  * minLength: 100\n",
    );

    const DOC_EXAMPLE_BODY: &str = concat!(
        "\n# name\n",
        " * title: Your name\n",
        " * type: text\n",
        " * rules:\n",
        "  * required: true\n",
        "# affiliation\n",
        " * title: Institute/Organization/Company\n",
        " * hint: leave blank in none\n",
        "# address\n",
        " * title: Address\n",
        " * rules:\n",
        "  * required: true\n",
        "  * minLength: 2\n",
        "# address2\n",
        " * title: Address (cont.)\n",
        "# country\n",
        " * title: Country\n",
        " * rules:\n",
        "  * minLength: 2\n",
        "# phone\n",
        " * title: Phone\n",
        "# email\n",
        " * title: Email\n",
        " * type: text\n",
        " * rules:\n",
        "  * match: /^[_a-zA-Z0-9-]+(\\.[_a-zA-Z0-9-]+)*@[a-zA-Z0-9-]+(\\.[a-zA-Z0-9-]+)+$/\n",
        "# payment\n",
        " * title: I will pay by\n",
        " * type: select\n",
        " * options:\n",
        "  * creditcard: Credit card\n",
        "  * banktransfer: Bank wire transfer\n",
        "  * desk: At the registration desk\n",
        "  * na: Not applicable\n",
        "# logging\n",
        " * title: Please find me a hotel\n",
        " * type: checkbox\n",
        " * hint: we will contact you via email if yes\n",
        "# comments\n",
        " * type: textarea\n",
        " * title: Extra comments\n",
        " * rules:\n",
        "  * maxLength: 500\n",
    );

    #[test]
    fn parses_fake_login_prop_definition() {
        let definition = parse_mail_form_definition(FAKE_LOGIN_HEAD, FAKE_LOGIN_BODY);
        assert_eq!(definition.recipients.as_deref(), Some("aaaa (DUMMY)"));
        assert_eq!(definition.button.as_deref(), Some(""));
        assert_eq!(definition.fields.len(), 1);
        let field = &definition.fields[0];
        assert_eq!(field.name, "name");
        assert_eq!(field.title.as_deref(), Some("ID"));
        assert_eq!(field.field_type, MailFormFieldType::Text);
        assert_eq!(field.default.as_deref(), Some("driosua"));
        assert!(field.rules.required);
        assert_eq!(field.rules.max_length, Some(10));
        assert_eq!(field.rules.min_length, Some(100));
    }

    #[test]
    fn renders_fake_login_prop_with_live_shape() {
        let definition = parse_mail_form_definition(FAKE_LOGIN_HEAD, FAKE_LOGIN_BODY);
        let html = render_mail_form_module(&definition, 1, Some(1793489522));
        for expected in [
            r#"<div class="mailform-box" id="mailform-box-1">"#,
            r#"<form id="mailform-1" action="javascript:WIKIDOT.modules.MailFormModule.listeners.send(null, '1')">"#,
            r#"<table class="form">"#,
            r#"<tr id="mailform-row-1-name"><td>ID</td>"#,
            r#"<div class="field-error-message"></div>"#,
            r#"<input name="name" class="text" type="text" value="driosua" size="30" maxlength="10"/>"#,
            r#"<div class="buttons"><input type="button" value="Send" onclick="WIKIDOT.modules.MailFormModule.listeners.send(event, '1')"/></div>"#,
            r#"<div id="mailformdef-1" style="display: none;">"#,
            "_1793489522</div>",
        ] {
            assert!(html.contains(expected), "missing {expected:?} in {html}");
        }
        let handle = mail_form_definition_handle(&definition, 1, Some(1793489522));
        let (digest, page) = handle.split_once('_').expect("handle has a page suffix");
        assert_eq!(digest.len(), 32);
        assert!(digest.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(page, "1793489522");
    }

    #[test]
    fn parses_and_renders_doc_example_field_types() {
        let definition = parse_mail_form_definition(
            r#" title="New message from MailForm documentation page""#,
            DOC_EXAMPLE_BODY,
        );
        assert_eq!(definition.fields.len(), 10);
        let payment = &definition.fields[7];
        assert_eq!(payment.field_type, MailFormFieldType::Select);
        assert_eq!(
            payment.options,
            vec![
                ("creditcard".to_owned(), "Credit card".to_owned()),
                ("banktransfer".to_owned(), "Bank wire transfer".to_owned()),
                ("desk".to_owned(), "At the registration desk".to_owned()),
                ("na".to_owned(), "Not applicable".to_owned()),
            ],
        );
        let logging = &definition.fields[8];
        assert_eq!(logging.field_type, MailFormFieldType::Checkbox);
        assert_eq!(
            logging.hint.as_deref(),
            Some("we will contact you via email if yes")
        );
        let comments = &definition.fields[9];
        assert_eq!(comments.field_type, MailFormFieldType::Textarea);
        assert_eq!(comments.title.as_deref(), Some("Extra comments"));
        assert_eq!(comments.rules.max_length, Some(500));

        let html = render_mail_form_module(&definition, 3, Some(42));
        for expected in [
            r#"<input name="name" class="text" type="text" size="30"/>"#,
            r#"<select name="payment" class="select"><option value="">-- Please select --</option>"#,
            r#"<option value="creditcard">Credit card</option>"#,
            r#"<option value="na">Not applicable</option></select>"#,
            r#"<input name="logging" class="checkbox" type="checkbox"/>"#,
            r#"<textarea name="comments" cols="30" rows="5"></textarea>"#,
        ] {
            assert!(html.contains(expected), "missing {expected:?} in {html}");
        }
        assert!(!html.contains("leave blank in none"), "{html}");
        assert!(
            !html.contains("we will contact you via email if yes"),
            "{html}"
        );
    }

    #[test]
    fn select_default_marks_the_matching_option_selected() {
        let definition = parse_mail_form_definition(
            "",
            "\n# payment\n * type: select\n * default: desk\n * options:\n  * creditcard: Credit card\n  * desk: At the registration desk\n",
        );
        let html = render_mail_form_module(&definition, 1, None);
        assert!(
            html.contains(r#"<option value="desk" selected="selected">At the registration desk</option>"#),
            "{html}"
        );
        assert!(
            html.contains(r#"<option value="creditcard">Credit card</option>"#),
            "{html}"
        );
    }

    #[test]
    fn authored_button_label_is_used_verbatim() {
        let definition = parse_mail_form_definition(
            r#" to="aaaa (DUMMY)" button="k""#,
            FAKE_LOGIN_BODY,
        );
        let html = render_mail_form_module(&definition, 2, None);
        assert!(html.contains(r#"value="k""#), "{html}");
    }

    #[test]
    fn duplicate_field_names_are_kept_as_separate_rows() {
        let definition = parse_mail_form_definition(
            "",
            concat!(
                "\n# comments\n * title: One\n * type: textarea\n * default: first\n",
                "# comments\n * title: Two\n * type: textarea\n * default: second\n",
            ),
        );
        assert_eq!(definition.fields.len(), 2);
        let html = render_mail_form_module(&definition, 1, None);
        assert!(html.contains(
            r#"<textarea name="comments" cols="30" rows="5">first</textarea>"#
        ));
        assert!(html.contains(
            r#"<textarea name="comments" cols="30" rows="5">second</textarea>"#
        ));
    }

    #[test]
    fn fake_login_rules_can_never_pass() {
        let definition = parse_mail_form_definition(FAKE_LOGIN_HEAD, FAKE_LOGIN_BODY);
        for value in ["", "abc", "0123456789", "01234567890"] {
            let values = HashMap::from([("name".to_owned(), value.to_owned())]);
            let errors = validate_mail_form_submission(&definition, &values);
            assert!(!errors.is_empty(), "value {value:?} unexpectedly passed");
        }
        let values = HashMap::from([("name".to_owned(), String::new())]);
        assert_eq!(
            validate_mail_form_submission(&definition, &values),
            vec![MailFormFieldError {
                field: "name".to_owned(),
                violation: MailFormRuleViolation::Required,
            }],
        );
        let values = HashMap::from([("name".to_owned(), "abc".to_owned())]);
        assert_eq!(
            validate_mail_form_submission(&definition, &values),
            vec![MailFormFieldError {
                field: "name".to_owned(),
                violation: MailFormRuleViolation::MinLength(100),
            }],
        );
        let values = HashMap::from([("name".to_owned(), "x".repeat(100))]);
        assert_eq!(
            validate_mail_form_submission(&definition, &values),
            vec![MailFormFieldError {
                field: "name".to_owned(),
                violation: MailFormRuleViolation::MaxLength(10),
            }],
        );
    }

    #[test]
    fn doc_example_rules_validate() {
        let definition = parse_mail_form_definition("", DOC_EXAMPLE_BODY);
        let mut values = HashMap::from([
            ("name".to_owned(), "Raz".to_owned()),
            ("address".to_owned(), "1 Main St".to_owned()),
            ("email".to_owned(), "not-an-email".to_owned()),
        ]);
        let errors = validate_mail_form_submission(&definition, &values);
        assert_eq!(
            errors,
            vec![MailFormFieldError {
                field: "email".to_owned(),
                violation: MailFormRuleViolation::Match,
            }],
            "{errors:?}"
        );
        values.insert("email".to_owned(), "a.b-c@mail.example.com".to_owned());
        assert!(validate_mail_form_submission(&definition, &values).is_empty());
    }

    #[test]
    fn numeric_rules_validate() {
        let definition = parse_mail_form_definition(
            "",
            "\n# amount\n * type: text\n * rules:\n  * number: true\n  * minValue: 2\n  * maxValue: 5\n",
        );
        let check = |value: &str| {
            validate_mail_form_submission(
                &definition,
                &HashMap::from([("amount".to_owned(), value.to_owned())]),
            )
        };
        assert_eq!(check("abc")[0].violation, MailFormRuleViolation::Number);
        assert_eq!(
            check("1")[0].violation,
            MailFormRuleViolation::MinValue(2.0)
        );
        assert_eq!(
            check("9")[0].violation,
            MailFormRuleViolation::MaxValue(5.0)
        );
        assert!(check("3.5").is_empty());
        assert!(check("").is_empty());
    }
}

#[cfg(test)]
mod mail_form_expansion_tests {
    use std::borrow::Cow;

    use super::MAIL_FORM_TITLE_ERROR_HTML;

    use crate::services::render::compat::CompatHtmlFragments;
    use crate::services::render::compat::text_fragments::CompatTextFragments;
    use ftml::data::{PageInfo, ScoreValue};
    use ftml::layout::Layout;
    use ftml::render::{Render, html::HtmlRender};
    use ftml::settings::{WikitextMode, WikitextSettings};

    const FAKE_LOGIN_SOURCE: &str = concat!(
        "[[module MailForm to=\"aaaa (DUMMY)\" button=\"\"]]\n",
        "# name\n",
        " * title: ID\n",
        " * type: text\n",
        " * default: driosua\n",
        " * rules:\n",
        "  * required: true\n",
        "  * maxLength: 10\n",
        "  * minLength: 100\n",
        "[[/module]]\n",
    );

    fn expand(source: &str) -> String {
        let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
        let mut compat_html = CompatHtmlFragments::new(source);
        let expanded = super::expand_mail_form_modules(
            source.to_owned(),
            &settings,
            Some(1793489522),
            &mut compat_html,
        );
        compat_html.restore(&expanded)
    }

    fn render_expanded(source: &str) -> String {
        let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
        let page_info = PageInfo {
            page: Cow::Borrowed("scp-4757"),
            category: None,
            site: Cow::Borrowed("scp-wiki"),
            title: Cow::Borrowed("SCP-4757"),
            alt_title: None,
            score: ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let compat_text = CompatTextFragments::new(source);
        let mut compat_html = CompatHtmlFragments::new(source);
        let mut protected = super::expand_mail_form_modules(
            source.to_owned(),
            &settings,
            Some(1793489522),
            &mut compat_html,
        );
        ftml::preprocess_for_layout(&mut protected, settings.layout);
        let tokens = ftml::tokenize(&protected);
        let (tree, _errors) = ftml::parse(&tokens, &page_info, &settings).into();
        let rendered = HtmlRender.render(&tree, &page_info, &settings).body;
        let rendered = compat_html.restore(&rendered);
        compat_text.restore(&rendered)
    }

    #[test]
    fn mail_form_expands_to_the_live_form_shape() {
        let rendered = render_expanded(FAKE_LOGIN_SOURCE);
        for expected in [
            r#"<div class="mailform-box" id="mailform-box-1">"#,
            r#"<input name="name" class="text" type="text" value="driosua" size="30" maxlength="10"/>"#,
            "_1793489522</div>",
        ] {
            assert!(
                rendered.contains(expected),
                "missing {expected:?} in {rendered}"
            );
        }
        assert!(!rendered.contains("No such module"), "{rendered}");
    }

    #[test]
    fn paired_mail_forms_get_sequential_instances() {
        let source = format!("{FAKE_LOGIN_SOURCE}\n{FAKE_LOGIN_SOURCE}");
        let expanded = expand(&source);
        assert!(expanded.contains(r#"id="mailform-box-1""#), "{expanded}");
        assert!(expanded.contains(r#"id="mailform-box-2""#), "{expanded}");
        assert!(expanded.contains(r#"id="mailformdef-2""#), "{expanded}");
    }

    #[test]
    fn mail_form_inside_a_code_block_is_not_expanded() {
        let source = format!("[[code]]\n{FAKE_LOGIN_SOURCE}[[/code]]\n");
        assert_eq!(expand(&source), source);
    }

    #[test]
    fn unclosed_mail_form_expands_without_owning_following_lines() {
        let source = "[[module MailForm to=\"aaaa (DUMMY)\"]]\n# name\n * title: ID\n";
        let expanded = expand(source);
        assert!(
            expanded.contains(r#"<div class="mailform-box" id="mailform-box-1">"#),
            "{expanded}",
        );
        assert!(
            expanded.contains("<table class=\"form\"></table>"),
            "a bodyless MailForm renders the empty live form shell:\n{expanded}",
        );
        assert!(
            expanded.contains("# name") && expanded.contains("* title: ID"),
            "text after a bodyless opener must stay ordinary page content:\n{expanded}",
        );
    }

    #[test]
    fn mail_form_title_length_and_field_defaults_match_live() {
        let title_200 = "t".repeat(200);
        let expanded = expand(&format!("[[module MailForm title=\"{title_200}\"]]\n"));
        assert!(!expanded.contains(MAIL_FORM_TITLE_ERROR_HTML), "{expanded}");

        let title_201 = "t".repeat(201);
        let expanded = expand(&format!("[[module MailForm title=\"{title_201}\"]]\n"));
        assert!(
            expanded.contains(MAIL_FORM_TITLE_ERROR_HTML),
            "live rejects titles longer than 200 characters:\n{expanded}",
        );

        let multibyte_201 = "あ".repeat(201);
        let expanded =
            expand(&format!("[[module MailForm title=\"{multibyte_201}\"]]\n"));
        assert!(
            expanded.contains(MAIL_FORM_TITLE_ERROR_HTML),
            "the title limit counts characters, not bytes:\n{expanded}",
        );

        let text_zero = expand(
            "[[module MailForm]]\n# a\n * type: text\n * default: 0\n[[/module]]\n",
        );
        assert!(!text_zero.contains("value=\"0\""), "{text_zero}");
        let text_false = expand(
            "[[module MailForm]]\n# a\n * type: text\n * default: false\n[[/module]]\n",
        );
        assert!(
            text_false.contains(r#"value="false""#),
            "live uses PHP truthiness for field defaults:\n{text_false}",
        );

        let select_default = expand(
            "[[module MailForm]]\n# a\n * type: select\n * options:\n  * one: First\n  * two: Second\n * default: two\n[[/module]]\n",
        );
        assert!(
            !select_default.contains("-- Please select --")
                && select_default.contains(r#"selected="selected""#),
            "{select_default}",
        );
        let select_zero = expand(
            "[[module MailForm]]\n# a\n * type: select\n * options:\n  * one: First\n * default: 0\n[[/module]]\n",
        );
        assert!(
            select_zero.contains("-- Please select --")
                && !select_zero.contains(r#"selected="selected""#),
            "{select_zero}",
        );

        let checkbox_false = expand(
            "[[module MailForm]]\n# a\n * type: checkbox\n * default: false\n[[/module]]\n",
        );
        assert!(
            checkbox_false.contains(r#"checked="checked""#)
                && !checkbox_false.contains(r#"value="1""#),
            "live's checkbox carries no value attribute and treats \"false\" as truthy:\n{checkbox_false}",
        );
        let checkbox_zero = expand(
            "[[module MailForm]]\n# a\n * type: checkbox\n * default: 0\n[[/module]]\n",
        );
        assert!(
            !checkbox_zero.contains(r#"checked="checked""#),
            "{checkbox_zero}"
        );
    }

    #[test]
    fn inline_mail_form_is_not_expanded() {
        let source = format!("before {FAKE_LOGIN_SOURCE}");
        assert_eq!(expand(&source), source);
    }

    #[test]
    fn a_closing_tag_with_trailing_text_still_executes_the_module() {
        let source = format!("{} after\n", FAKE_LOGIN_SOURCE.trim_end());
        let expanded = expand(&source);
        assert!(
            expanded.contains(r#"<div class="mailform-box" id="mailform-box-1">"#),
            "live executes a block module whose closing tag has trailing text:\n{expanded}",
        );
        assert!(
            expanded.contains(" after"),
            "text after the closing tag stays page content:\n{expanded}",
        );
    }
}
