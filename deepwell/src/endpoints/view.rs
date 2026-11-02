/*
 * endpoints/view.rs
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
use crate::services::page_draft::PageDraftView;
use crate::services::view::{
    GetAdminView, GetAdminViewOutput, GetArticleViewCacheMetadataOutput,
    GetArticleViewOutput, GetPageBacklinksView, GetPageView, GetPageViewOutput,
    GetPreloadView, GetPreloadViewOutput, GetSiteToolsPages, GetUserView,
    GetUserViewOutput, PageBacklinkView, SiteToolsPageView, SiteToolsWantedPageView,
    ViewType,
};

pub async fn page_backlinks_view(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Vec<PageBacklinkView>> {
    let input: GetPageBacklinksView<'_> = parse!(params, Page);
    ViewService::backlinks(ctx, input).await
}

pub async fn site_tools_orphaned_pages(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Vec<SiteToolsPageView>> {
    let input: GetSiteToolsPages = parse!(params, Page);
    ViewService::site_tools_orphaned_pages(ctx, input).await
}

pub async fn site_tools_wanted_pages(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Vec<SiteToolsWantedPageView>> {
    let input: GetSiteToolsPages = parse!(params, Page);
    ViewService::site_tools_wanted_pages(ctx, input).await
}

pub async fn site_tools_list_drafts(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Vec<PageDraftView>> {
    let input: GetSiteToolsPages = parse!(params, Page);
    ViewService::site_tools_list_drafts(ctx, input).await
}

pub async fn preload_view(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<GetPreloadViewOutput> {
    let input: GetPreloadView = parse!(params => ErrorType::GetView(ViewType::Preload));

    ViewService::preload(ctx, input).await.or_raise(|| {
        Error::new(
            "failed to get preload view",
            ErrorType::GetView(ViewType::Preload),
        )
    })
}

pub async fn article_view(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<GetArticleViewOutput> {
    let input: GetPageView = parse!(params => ErrorType::GetView(ViewType::Page));

    ViewService::article(ctx, input).await.or_raise(|| {
        Error::new(
            "failed to get article view",
            ErrorType::GetView(ViewType::Page),
        )
    })
}

pub async fn article_view_cache_metadata(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<GetArticleViewCacheMetadataOutput> {
    let input: GetPageView = parse!(params => ErrorType::GetView(ViewType::Page));

    ViewService::article_cache_metadata(ctx, input)
        .await
        .or_raise(|| {
            Error::new(
                "failed to get article view cache metadata",
                ErrorType::GetView(ViewType::Page),
            )
        })
}

pub async fn page_view(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<GetPageViewOutput> {
    let input: GetPageView = parse!(params => ErrorType::GetView(ViewType::Page));

    let mut output = ViewService::page(ctx, input).await.or_raise(|| {
        Error::new(
            "failed to get page view",
            ErrorType::GetView(ViewType::Page),
        )
    })?;
    ViewService::refresh_rate_widget_score(ctx, &mut output)
        .await
        .or_raise(|| {
            Error::new(
                "failed to refresh page view rate widget score",
                ErrorType::GetView(ViewType::Page),
            )
        })?;
    Ok(output)
}

pub async fn user_view(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<GetUserViewOutput> {
    let input: GetUserView = parse!(params => ErrorType::GetView(ViewType::User));

    ViewService::user(ctx, input).await.or_raise(|| {
        Error::new(
            "failed to get user view",
            ErrorType::GetView(ViewType::User),
        )
    })
}

pub async fn admin_view(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<GetAdminViewOutput> {
    let input: GetAdminView = parse!(params => ErrorType::GetView(ViewType::Admin));

    ViewService::admin(ctx, input).await.or_raise(|| {
        Error::new(
            "failed to get admin view",
            ErrorType::GetView(ViewType::Admin),
        )
    })
}
