/*
 * endpoints/link.rs
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

use super::prelude::*;
use crate::models::page::Model as PageModel;
use crate::services::link::{
    GetLinksExternalFrom, GetLinksExternalFromOutput, GetLinksExternalTo,
    GetLinksExternalToOutput, GetLinksFrom, GetLinksFromOutput, GetLinksTo,
    GetLinksToMissing, GetLinksToMissingOutput, GetLinksToOutput,
};
use crate::services::permission::PermissionService;
use crate::services::render::AuthorizedPageSelector;
use crate::types::Reference;
use std::collections::HashSet;

fn not_viewable_error() -> Error {
    Error::new("page is not viewable", ErrorType::PermissionDenied)
}

async fn viewable_subject_page(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    reference: Reference<'_>,
) -> Result<PageModel> {
    let page = PageService::get_optional(ctx, site_id, reference)
        .await
        .or_raise(|| {
            Error::new("failed to resolve link subject page", ErrorType::Page)
        })?;

    match page {
        Some(page) => {
            let can_view = PermissionService::check_user_can_view_page(
                ctx,
                ctx.request().user_id,
                &page,
            )
            .await
            .or_raise(|| {
                Error::new(
                    "failed to check page view permission",
                    ErrorType::Permission,
                )
            })?;
            if can_view {
                Ok(page)
            } else {
                Err(not_viewable_error().into())
            }
        }
        None => Err(not_viewable_error().into()),
    }
}

async fn viewable_counterpart_ids(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    page_ids: impl IntoIterator<Item = i64>,
) -> Result<HashSet<i64>> {
    let references = page_ids.into_iter().map(Reference::Id).collect::<Vec<_>>();
    if references.is_empty() {
        return Ok(HashSet::new());
    }

    let mut selector = AuthorizedPageSelector::new(ctx, ctx.request().user_id);
    let pages = selector
        .resolve_models(site_id, &references)
        .await
        .or_raise(|| {
            Error::new(
                "failed to filter viewable link pages",
                ErrorType::Permission,
            )
        })?;
    Ok(pages.into_iter().map(|page| page.page_id).collect())
}

pub async fn page_links_from_get(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<GetLinksFromOutput> {
    let GetLinksFrom {
        site_id,
        page: reference,
    } = parse!(params, Page);

    let make_error = || Error::new("failed to get page links from page", ErrorType::Page);

    let page = viewable_subject_page(ctx, site_id, reference).await?;

    let mut output = LinkService::get_from(ctx, page.page_id)
        .await
        .or_raise(make_error)?;
    let viewable = viewable_counterpart_ids(
        ctx,
        site_id,
        output.present.iter().map(|row| row.to_page_id),
    )
    .await?;
    output
        .present
        .retain(|row| viewable.contains(&row.to_page_id));
    Ok(output)
}

pub async fn page_links_to_get(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<GetLinksToOutput> {
    let GetLinksTo {
        site_id,
        page: reference,
    } = parse!(params, Page);

    let make_error = || Error::new("failed to get page links to page", ErrorType::Page);

    let page = viewable_subject_page(ctx, site_id, reference).await?;

    let mut output = LinkService::get_to(ctx, page.page_id, None)
        .await
        .or_raise(make_error)?;
    let viewable = viewable_counterpart_ids(
        ctx,
        site_id,
        output.connections.iter().map(|row| row.from_page_id),
    )
    .await?;
    output
        .connections
        .retain(|row| viewable.contains(&row.from_page_id));
    Ok(output)
}

pub async fn page_links_to_missing_get(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<GetLinksToMissingOutput> {
    let GetLinksToMissing { site_id, page_slug } = parse!(params, Page);

    let make_error =
        || Error::new("failed to get links to missing page", ErrorType::Page);

    if let Some(page) =
        PageService::get_optional(ctx, site_id, Reference::from(page_slug.as_str()))
            .await
            .or_raise(make_error)?
    {
        let can_view = PermissionService::check_user_can_view_page(
            ctx,
            ctx.request().user_id,
            &page,
        )
        .await
        .or_raise(|| {
            Error::new(
                "failed to check page view permission",
                ErrorType::Permission,
            )
        })?;
        if can_view {
            return LinkService::get_to_missing(ctx, site_id, &page_slug, None)
                .await
                .or_raise(make_error);
        }
    }

    let mut output = LinkService::get_to_missing_rows(ctx, site_id, &page_slug, None)
        .await
        .or_raise(make_error)?;
    let viewable = viewable_counterpart_ids(
        ctx,
        site_id,
        output.connections.iter().map(|row| row.from_page_id),
    )
    .await?;
    output
        .connections
        .retain(|row| viewable.contains(&row.from_page_id));
    Ok(output)
}

pub async fn page_links_external_from(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<GetLinksExternalFromOutput> {
    let GetLinksExternalFrom {
        site_id,
        page: reference,
    } = parse!(params);

    let make_error =
        || Error::new("failed to get external links from page", ErrorType::Page);

    let page = viewable_subject_page(ctx, site_id, reference).await?;

    LinkService::get_external_from(ctx, page.page_id)
        .await
        .or_raise(make_error)
}

pub async fn page_links_external_to(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<GetLinksExternalToOutput> {
    let GetLinksExternalTo { site_id, url } = parse!(params);

    let make_error =
        || Error::new("failed to get external links to URL", ErrorType::Page);

    let mut output = LinkService::get_external_to(ctx, site_id, &url)
        .await
        .or_raise(make_error)?;
    let viewable = viewable_counterpart_ids(
        ctx,
        site_id,
        output.links.iter().map(|row| row.page_id),
    )
    .await?;
    output.links.retain(|row| viewable.contains(&row.page_id));
    Ok(output)
}
