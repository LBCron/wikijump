/*
 * services/data_form/runtime.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::{DataFormDefinition, DataFormPagepathNode};
use crate::error::prelude::Result;
use crate::models::page::Model as PageModel;
use crate::models::page_category;
use crate::services::ServiceContext;
use crate::services::category::CategoryService;
use crate::services::page::PageService;
use crate::services::page_revision::PageRevisionService;
use crate::services::parent::ParentService;
use crate::services::permission::{CheckPermissionContext, PermissionService};
use crate::services::render::{ViewablePageRef, view_decisions_for_scanned_pages};
use crate::types::{Action, PageOrder, Permission, Reference, Resource};
use crate::utils::split_category;
use std::borrow::Cow;
use std::collections::BTreeMap;

pub async fn load_data_form_definitions(
    ctx: &ServiceContext<'_>,
    categories: &[page_category::Model],
) -> Result<BTreeMap<i64, DataFormDefinition>> {
    let mut templates_by_site = BTreeMap::<i64, Vec<i64>>::new();
    let mut category_templates = Vec::<(i64, i64, i64)>::new();
    for category in categories {
        let Some(template_page_id) = category.template_page_id else {
            continue;
        };
        templates_by_site
            .entry(category.site_id)
            .or_default()
            .push(template_page_id);
        category_templates.push((
            category.category_id,
            category.site_id,
            template_page_id,
        ));
    }
    if category_templates.is_empty() {
        return Ok(BTreeMap::new());
    }

    let mut template_wikitext = BTreeMap::<(i64, i64), Option<String>>::new();
    for (site_id, page_ids) in templates_by_site {
        let loaded =
            PageRevisionService::get_wikitext_optional_batch(ctx, site_id, &page_ids)
                .await?;
        template_wikitext.extend(
            loaded
                .into_iter()
                .map(|(page_id, wikitext)| ((site_id, page_id), wikitext)),
        );
    }

    let mut definitions = BTreeMap::new();
    for (category_id, site_id, template_page_id) in category_templates {
        if let Some(Some(wikitext)) = template_wikitext.get(&(site_id, template_page_id))
            && let Some(definition) = super::parse_wikidot_data_form_definition(wikitext)
        {
            definitions.insert(category_id, definition);
        }
    }

    Ok(definitions)
}

async fn wikidot_data_form_page_is_viewable(
    ctx: &ServiceContext<'_>,
    viewer_user_id: Option<i64>,
    page: &PageModel,
) -> Result<bool> {
    PermissionService::check_user_can(
        ctx,
        &CheckPermissionContext {
            user_id: viewer_user_id,
            site_id: page.site_id,
            page_reference: Some(Reference::Id(page.page_id)),
        },
        Permission {
            resource_type: Resource::Page,
            resource_category: Some(Reference::Id(page.page_category_id)),
            action: Action::View,
        },
    )
    .await
}

pub async fn resolve_wikidot_data_form_pagepath_display_values(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    definition: &DataFormDefinition,
    values: &BTreeMap<String, String>,
    viewer_user_id: Option<i64>,
) -> Result<BTreeMap<String, String>> {
    let mut display_values = BTreeMap::new();
    for field in definition
        .fields
        .iter()
        .filter(|field| field.field_type.as_deref() == Some("pagepath"))
    {
        let raw_value = values.get(&field.name).map(String::as_str).unwrap_or("");
        if raw_value.is_empty() {
            display_values.insert(field.name.clone(), String::new());
            continue;
        }
        let expected_category_id = match field.pagepath_category.as_deref() {
            Some(category) => CategoryService::get_optional(
                ctx,
                site_id,
                Reference::Slug(Cow::Borrowed(category)),
            )
            .await?
            .map(|category| category.category_id),
            None => None,
        };
        let page = PageService::get_optional(
            ctx,
            site_id,
            Reference::Slug(Cow::Borrowed(raw_value)),
        )
        .await?;
        let display = match page {
            Some(page)
                if expected_category_id == Some(page.page_category_id)
                    && wikidot_data_form_page_is_viewable(ctx, viewer_user_id, &page)
                        .await? =>
            {
                split_category(&page.slug).1.to_owned()
            }
            _ => String::new(),
        };
        display_values.insert(field.name.clone(), display);
    }
    Ok(display_values)
}

pub async fn load_wikidot_data_form_pagepaths(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    definition: &DataFormDefinition,
    viewer_user_id: Option<i64>,
) -> Result<BTreeMap<String, Vec<DataFormPagepathNode>>> {
    let mut pagepaths = BTreeMap::new();
    for field in definition
        .fields
        .iter()
        .filter(|field| field.field_type.as_deref() == Some("pagepath"))
    {
        let Some(category_name) = field.pagepath_category.as_deref() else {
            continue;
        };
        let Some(category) = CategoryService::get_optional(
            ctx,
            site_id,
            Reference::Slug(Cow::Borrowed(category_name)),
        )
        .await?
        else {
            pagepaths.insert(field.name.clone(), Vec::new());
            continue;
        };
        let pages = PageService::get_all(
            ctx,
            site_id,
            Some(Reference::Id(category.category_id)),
            Some(false),
            PageOrder::default(),
        )
        .await?;
        let scanned = pages
            .iter()
            .map(|page| ViewablePageRef {
                page_id: page.page_id,
                site_id: page.site_id,
                page_category_id: Some(page.page_category_id),
            })
            .collect::<Vec<_>>();
        let viewable = view_decisions_for_scanned_pages(
            ctx,
            viewer_user_id,
            &scanned,
            &mut BTreeMap::new(),
        )
        .await?;
        let visible_pages = pages
            .into_iter()
            .zip(viewable)
            .filter_map(|(page, can_view)| can_view.then_some(page))
            .collect::<Vec<_>>();

        let slug_by_id = visible_pages
            .iter()
            .map(|page| (page.page_id, page.slug.clone()))
            .collect::<BTreeMap<_, _>>();
        let visible_page_ids = visible_pages
            .iter()
            .map(|page| page.page_id)
            .collect::<Vec<_>>();
        let mut parents_by_child =
            ParentService::get_parents_batch(ctx, &visible_page_ids).await?;

        let mut nodes = Vec::with_capacity(visible_pages.len());
        for page in visible_pages {
            let relationships =
                parents_by_child.remove(&page.page_id).unwrap_or_default();
            let parent = match relationships.as_slice() {
                [relationship] => slug_by_id.get(&relationship.parent_page_id).cloned(),
                _ => None,
            };
            nodes.push(DataFormPagepathNode {
                fullname: page.slug.clone(),
                name: split_category(&page.slug).1.to_owned(),
                parent,
            });
        }
        pagepaths.insert(field.name.clone(), nodes);
    }
    Ok(pagepaths)
}
