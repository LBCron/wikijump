/*
 * endpoints/page_attribution.rs
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
use crate::services::MutationAuthorization;
use crate::services::relation::{
    ClearPageAttributions, GetPageAttributions, PageAttribution, RelationService,
    SetPageAttributions,
};
use crate::types::{Action, Permission, Reference, Resource};

async fn require_page_attribution_permission(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    page: Reference<'_>,
    submitted_user_id: i64,
    action: &str,
) -> Result<()> {
    MutationAuthorization::require_matching_actor(ctx, submitted_user_id, action)?;

    // Attributions feed the page-author virtual role, which holds every page
    // action. Writing them requires the Delete + Rename standing they grant,
    // scoped to the page's category. The check carries no page reference, so
    // the page-author role cannot authorize its own membership.
    let category_id = PageService::get(ctx, site_id, page)
        .await
        .or_raise(|| {
            Error::new(
                format!("failed to load page to {action}"),
                ErrorType::PageAttribution,
            )
        })?
        .page_category_id;

    for required in [Action::Delete, Action::Rename] {
        MutationAuthorization::require_permission(
            ctx,
            site_id,
            None,
            Permission {
                resource_type: Resource::Page,
                resource_category: Some(Reference::Id(category_id)),
                action: required,
            },
            action,
        )
        .await?;
    }
    Ok(())
}

pub async fn page_attribution_get_page(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Vec<PageAttribution>> {
    let input: GetPageAttributions<'_> = parse!(params, PageAttribution);

    RelationService::get_page_attributions(ctx, input)
        .await
        .or_raise(|| {
            Error::new(
                "failed to get page attributions",
                ErrorType::PageAttribution,
            )
        })
}

pub async fn page_attribution_update(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Vec<PageAttribution>> {
    let input: SetPageAttributions<'_> = parse!(params, PageAttribution);
    let site_id = input.site_id;
    require_page_attribution_permission(
        ctx,
        site_id,
        input.page.clone(),
        input.updated_by,
        "update page attributions",
    )
    .await?;

    info!(
        "Setting {} page attributions for page {:?} on site {} (requested by {})",
        input.attributions.len(),
        input.page,
        input.site_id,
        input.updated_by,
    );

    let attributions = RelationService::set_page_attributions(ctx, input)
        .await
        .or_raise(|| {
            Error::new(
                "failed to update page attributions",
                ErrorType::PageAttribution,
            )
        })?;
    ctx.defer_public_content_cache_invalidate_site(site_id)?;
    Ok(attributions)
}

pub async fn page_attribution_delete(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<()> {
    let input: ClearPageAttributions<'_> = parse!(params, PageAttribution);
    let site_id = input.site_id;
    require_page_attribution_permission(
        ctx,
        site_id,
        input.page.clone(),
        input.removed_by,
        "delete page attributions",
    )
    .await?;

    info!(
        "Clearing page attributions for page {:?} on site {} (requested by {})",
        input.page, input.site_id, input.removed_by,
    );

    let rows_affected = RelationService::clear_page_attributions(ctx, input)
        .await
        .or_raise(|| {
            Error::new(
                "failed to delete page attributions",
                ErrorType::PageAttribution,
            )
        })?;
    if rows_affected > 0 {
        ctx.defer_public_content_cache_invalidate_site(site_id)?;
    }
    Ok(())
}
