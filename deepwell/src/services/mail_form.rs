/*
 * services/mail_form.rs
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

use serde::Serialize;

use crate::error::prelude::{Error, ErrorType, OptionExt, Result};
use crate::services::email::{EmailService, MailFormMessage};
use crate::services::render::{
    MailFormDefinition, find_mail_form_definition, mail_form_error_message,
    validate_mail_form_submission,
};
use crate::services::{
    MutationAuthorization, PageRevisionService, PageService, ServiceContext, TextService,
};
use crate::types::{Action, Permission, Reference, Resource};

const MAIL_FORM_SUCCESS_MESSAGE: &str = "<p>The form has been sent. Thank you!</p>";

const MAIL_FORM_DEFAULT_TITLE: &str = "Wikidot.com - MailForm form data";

#[derive(Debug)]
pub struct SubmitMailForm {
    pub site_id: i64,
    pub formdef: String,
    pub values: HashMap<String, String>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct MailFormSubmissionError {
    pub field: String,
    pub message: String,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct MailFormSubmitOutput {
    pub status: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub errors: Vec<MailFormSubmissionError>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success_msg: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub success_page: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delivery: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<MailFormMessage>,
}

#[derive(Debug)]
pub struct MailFormService;

impl MailFormService {
    pub async fn submit(
        ctx: &ServiceContext<'_>,
        input: SubmitMailForm,
    ) -> Result<MailFormSubmitOutput> {
        let page_id =
            parse_mail_form_handle_page_id(&input.formdef).ok_or_raise(|| {
                Error::new(
                    "malformed MailForm definition handle",
                    ErrorType::BadRequest,
                )
            })?;

        let page = PageService::get(ctx, input.site_id, Reference::Id(page_id)).await?;

        MutationAuthorization::require_permission(
            ctx,
            input.site_id,
            Some(Reference::Id(page.page_id)),
            Permission {
                resource_type: Resource::Page,
                resource_category: Some(Reference::Id(page.page_category_id)),
                action: Action::View,
            },
            "submit a MailForm form",
        )
        .await?;

        let revision =
            PageRevisionService::get_latest(ctx, input.site_id, page_id).await?;
        let wikitext = TextService::get(ctx, &revision.wikitext_hash).await?;
        let definition = find_mail_form_definition(&wikitext, page_id, &input.formdef)
            .ok_or_raise(|| {
                Error::new("unknown MailForm definition handle", ErrorType::BadRequest)
            })?;

        let violations = validate_mail_form_submission(&definition, &input.values);
        if !violations.is_empty() {
            return Ok(MailFormSubmitOutput {
                status: "form_errors".to_owned(),
                errors: violations
                    .iter()
                    .map(|violation| MailFormSubmissionError {
                        field: violation.field.clone(),
                        message: mail_form_error_message(&violation.violation),
                    })
                    .collect(),
                success_msg: None,
                success_page: None,
                delivery: None,
                message: None,
            });
        }

        let message = compose_mail_form_message(&definition, &input.values);
        EmailService::send_mail_form_message(&message).await;

        Ok(MailFormSubmitOutput {
            status: "ok".to_owned(),
            errors: Vec::new(),
            success_msg: Some(MAIL_FORM_SUCCESS_MESSAGE.to_owned()),
            success_page: definition.success_page.clone(),
            delivery: Some("not_delivered".to_owned()),
            message: Some(message),
        })
    }
}

fn parse_mail_form_handle_page_id(formdef: &str) -> Option<i64> {
    let (digest, page) = formdef.rsplit_once('_')?;
    if digest.len() != 32 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    page.parse::<i64>().ok().filter(|page_id| *page_id > 0)
}

fn compose_mail_form_message(
    definition: &MailFormDefinition,
    values: &HashMap<String, String>,
) -> MailFormMessage {
    let recipients = definition
        .recipients
        .clone()
        .unwrap_or_else(|| "site administrators".to_owned());
    let title = definition
        .email_title
        .clone()
        .unwrap_or_else(|| MAIL_FORM_DEFAULT_TITLE.to_owned());

    let body = if definition.format_csv {
        let mut body = String::new();
        let headers = definition
            .fields
            .iter()
            .map(|field| csv_cell(field.title.as_deref().unwrap_or(&field.name)))
            .collect::<Vec<_>>()
            .join(",");
        body.push_str(&headers);
        body.push('\n');
        let row = definition
            .fields
            .iter()
            .map(|field| csv_cell(values.get(&field.name).map_or("", String::as_str)))
            .collect::<Vec<_>>()
            .join(",");
        body.push_str(&row);
        body.push('\n');
        body
    } else {
        let mut body = String::new();
        for field in &definition.fields {
            body.push_str(field.title.as_deref().unwrap_or(&field.name));
            body.push_str(": ");
            body.push_str(values.get(&field.name).map_or("", String::as_str));
            body.push('\n');
        }
        body
    };

    MailFormMessage {
        recipients,
        title,
        body,
    }
}

fn csv_cell(value: &str) -> String {
    if value.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}
