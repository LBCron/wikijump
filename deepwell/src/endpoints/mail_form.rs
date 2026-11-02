/*
 * endpoints/mail_form.rs
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

use super::prelude::*;
use crate::services::mail_form::{MailFormService, MailFormSubmitOutput, SubmitMailForm};
use std::collections::HashMap;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct MailFormSubmitInput {
    site_id: i64,
    formdef: String,
    values: HashMap<String, String>,
}

pub async fn mail_form_submit(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<MailFormSubmitOutput> {
    let input: MailFormSubmitInput = parse!(params);
    if ctx
        .request()
        .site_id
        .is_some_and(|request_site_id| request_site_id != input.site_id)
    {
        bail!(Error::new(
            "mail form site does not match request site",
            ErrorType::BadRequest,
        ));
    }

    MailFormService::submit(
        ctx,
        SubmitMailForm {
            site_id: input.site_id,
            formdef: input.formdef,
            values: input.values,
        },
    )
    .await
}
