/*
 * services/render/list_pages/data_forms.rs
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

use std::collections::BTreeMap;

use crate::error::prelude::Result;
use crate::models::page_category;
use crate::services::ServiceContext;
use crate::services::data_form::{DataFormDefinition, load_data_form_definitions};

pub(in crate::services::render) type ListPagesDataFormDefinition = DataFormDefinition;

pub(in crate::services::render) async fn load_list_pages_data_form_definitions(
    ctx: &ServiceContext<'_>,
    categories: &[page_category::Model],
) -> Result<BTreeMap<i64, ListPagesDataFormDefinition>> {
    load_data_form_definitions(ctx, categories).await
}

pub(in crate::services::render) fn substitute_list_pages_form_data(
    field: &str,
    values: &BTreeMap<String, String>,
    definition: Option<&ListPagesDataFormDefinition>,
) -> Option<String> {
    if let Some(value) = values.get(field) {
        let Some(field_definition) =
            definition.and_then(|definition| definition.field(field))
        else {
            return Some(value.clone());
        };
        if field_definition.field_type.as_deref() == Some("select") {
            return Some(
                field_definition
                    .value_label(value)
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.clone()),
            );
        }
        return Some(value.clone());
    }
    definition.map(|_| String::new())
}

pub(in crate::services::render) fn substitute_list_pages_form_raw(
    field: &str,
    values: &BTreeMap<String, String>,
    definition: Option<&ListPagesDataFormDefinition>,
) -> Option<String> {
    values
        .get(field)
        .cloned()
        .or_else(|| definition.map(|_| String::new()))
}

pub(in crate::services::render) fn substitute_list_pages_form_label(
    field: &str,
    definition: Option<&ListPagesDataFormDefinition>,
) -> Option<String> {
    definition.map(|definition| {
        definition
            .field(field)
            .map(|field| field.label.clone())
            .unwrap_or_default()
    })
}

pub(in crate::services::render) fn substitute_list_pages_form_hint(
    field: &str,
    definition: Option<&ListPagesDataFormDefinition>,
) -> Option<String> {
    definition.map(|definition| {
        definition
            .field(field)
            .filter(|field| field.field_type.as_deref() != Some("select"))
            .map(|field| field.hint.clone())
            .unwrap_or_default()
    })
}
