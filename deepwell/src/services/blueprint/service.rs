/*
 * services/blueprint/service.rs
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

use super::structs::{BlueprintPageType, GetBlueprintPageOutput};
use super::template::{compose_template, exact_template_slug};
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::site::Model as SiteModel;
use crate::services::ServiceContext;
use crate::services::data_form::{
    parse_wikidot_data_form_definition,
    resolve_wikidot_data_form_pagepath_display_values,
    substitute_wikidot_data_form_layout_variables_with_display,
    wikidot_data_form_custom_layout_source,
};
use crate::services::page_query::parse_static_wikidot_data_form_values;
use crate::services::{PageRevisionService, PageService, RenderService, TextService};
use crate::types::Reference;
use crate::utils::{split_category, strip_fluent_control_chars};
use fluent::{FluentArgs, FluentValue};
use ftml::prelude::{Layout, PageInfo, WikitextMode, WikitextSettings};
use ref_map::OptionRefMap;
use std::borrow::Cow;
use unic_langid::LanguageIdentifier;

#[derive(Debug)]
pub struct BlueprintPageService;

impl BlueprintPageService {
    pub async fn get(
        ctx: &ServiceContext<'_>,
        site: &SiteModel,
        blueprint_type: BlueprintPageType,
        locales: &[LanguageIdentifier],
        layout: Layout,
        page_info: PageInfo<'_>,
    ) -> Result<GetBlueprintPageOutput> {
        info!(
            "Getting blueprint page {:?} for site ID {}",
            blueprint_type, site.site_id,
        );

        let make_error = || {
            Error::new(
                format!(
                    "failed to get blueprint page type {:?} with layout {}, info {:?}",
                    blueprint_type,
                    layout.description(),
                    page_info,
                ),
                ErrorType::BlueprintPage,
            )
        };

        let config = ctx.config();
        let (slugs, translate_key) = match blueprint_type {
            BlueprintPageType::Template => {
                let slug = exact_template_slug(
                    page_info.category.as_deref(),
                    page_info.page.as_ref(),
                    &config.blueprint_page_template,
                )
                .ok_or_else(make_error)?;

                (vec![slug], "")
            }
            BlueprintPageType::Missing => {
                let slugs = Self::slugs_with_category(
                    &config.blueprint_page_missing,
                    page_info.category.ref_map(|s| s.as_ref()),
                );

                (slugs, "wiki-page-missing")
            }
            BlueprintPageType::Private => (
                vec![cow!(config.blueprint_page_private)],
                "wiki-page-private",
            ),
            BlueprintPageType::Banned => {
                (vec![cow!(config.blueprint_page_banned)], "wiki-page-banned")
            }
            BlueprintPageType::Unauthorized => (vec![], "admin-unauthorized"),
        };

        let (wikitext, from_site_page) = Self::get_wikitext(
            ctx,
            &slugs,
            translate_key,
            site.site_id,
            locales,
            &page_info,
        )
        .await
        .or_raise(make_error)?;

        let settings = WikitextSettings::from_mode(WikitextMode::Page, layout);
        let render_output =
            RenderService::render(ctx, wikitext.clone(), &page_info, &settings)
                .await
                .or_raise(make_error)?;

        Ok(GetBlueprintPageOutput {
            wikitext,
            from_site_page,
            render_output,
        })
    }

    pub(crate) async fn apply_page_template(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        category: Option<&str>,
        page: &str,
        wikitext: String,
    ) -> Result<String> {
        let Some(template) =
            Self::get_page_template(ctx, site_id, category, page).await?
        else {
            return Ok(wikitext);
        };

        if let Some(definition) = parse_wikidot_data_form_definition(&template)
            && !definition.default_layout
            && let Some(layout) = wikidot_data_form_custom_layout_source(&template)
        {
            if !definition.supports_observed_create_edit() {
                return Ok(layout.to_owned());
            }
            let values = parse_static_wikidot_data_form_values(&wikitext);
            let display_values = resolve_wikidot_data_form_pagepath_display_values(
                ctx,
                site_id,
                &definition,
                &values,
                ctx.request().user_id,
            )
            .await?;
            return Ok(substitute_wikidot_data_form_layout_variables_with_display(
                layout,
                &definition,
                &values,
                &display_values,
            ));
        }

        Ok(compose_template(&template, &wikitext))
    }

    pub(crate) async fn get_page_template(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        category: Option<&str>,
        page: &str,
    ) -> Result<Option<String>> {
        let template_page = &ctx.config().blueprint_page_template;
        let Some(template_slug) = exact_template_slug(category, page, template_page)
        else {
            return Ok(None);
        };

        Self::get_page_wikitext_optional(ctx, site_id, template_slug.as_ref())
            .await
            .or_raise(|| {
                Error::new(
                    format!(
                        "failed to get page template '{}' on site ID {}",
                        template_slug, site_id,
                    ),
                    ErrorType::BlueprintPage,
                )
            })
    }

    fn slugs_with_category<'a>(
        base_slug: &'a str,
        page_category: Option<&'a str>,
    ) -> Vec<Cow<'a, str>> {
        match split_category(base_slug) {
            (Some(_), slug) => vec![cow!(slug)],

            (None, slug) => {
                let mut slugs = Vec::with_capacity(2);
                slugs.push(cow!(slug));

                if let Some(ref category) = page_category {
                    slugs.insert(0, Cow::Owned(format!("{category}:{slug}")));
                }

                slugs
            }
        }
    }

    async fn get_wikitext(
        ctx: &ServiceContext<'_>,
        slugs: &[Cow<'_, str>],
        translate_key: &str,
        site_id: i64,
        locales: &[LanguageIdentifier],
        page_info: &PageInfo<'_>,
    ) -> Result<(String, bool)> {
        debug!(
            "Getting wikitext for blueprint page ({} slugs)",
            slugs.len(),
        );

        let make_error = || {
            Error::new(
                format!(
                    "failed to get blueprint wikitext for translation key '{}' for site ID {}",
                    translate_key, site_id,
                ),
                ErrorType::BlueprintPage,
            )
        };

        for slug in slugs {
            if let Some(text) =
                Self::get_page_wikitext_optional(ctx, site_id, slug.as_ref())
                    .await
                    .or_raise(make_error)?
            {
                return Ok((text, true));
            }
        }

        if translate_key.is_empty() {
            return Err(make_error().into());
        }

        let page = &page_info.page;
        let (category, full_slug) = match &page_info.category {
            Some(category) => (str!(category), format!("{category}:{page}")),
            None => (str!("_default"), str!(page)),
        };

        let mut args = FluentArgs::new();
        args.set("slug", FluentValue::String(Cow::Owned(full_slug)));
        args.set("page", fluent_str!(page));
        args.set("category", fluent_str!(category));
        args.set("domain", fluent_str!(ctx.config().main_domain_no_dot));

        let mut wikitext = ctx
            .localization()
            .translate(locales, translate_key, &args)?
            .into_owned();

        strip_fluent_control_chars(&mut wikitext);

        Ok((wikitext, false))
    }

    async fn get_page_wikitext_optional(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        slug: &str,
    ) -> Result<Option<String>> {
        let Some(page) =
            PageService::get_optional(ctx, site_id, Reference::Slug(cow!(slug))).await?
        else {
            return Ok(None);
        };

        let revision =
            PageRevisionService::get_latest(ctx, site_id, page.page_id).await?;
        let text = TextService::get(ctx, &revision.wikitext_hash).await?;
        Ok(Some(text))
    }
}
