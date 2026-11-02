/*
 * services/view/backlinks.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::service::ViewService;
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::page::{self, Entity as Page};
use crate::models::page_connection::{self, Entity as PageConnection};
use crate::services::page::foreign_snapshot_exclusion_sql;
use crate::services::permission::{CheckPermissionContext, PermissionService};
use crate::services::render::{ViewablePageRef, view_decisions_for_scanned_pages};
use crate::services::{PageRevisionService, PageService, ServiceContext};
use crate::types::{Action, ConnectionType, Permission, Reference, Resource};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use sea_query::Expr;
use std::collections::{BTreeMap, HashMap};

const MAX_PAGE_BACKLINKS: usize = 500;
const PAGE_BACKLINK_SCAN_BATCH: u64 = MAX_PAGE_BACKLINKS as u64 + 1;

#[derive(Deserialize, Debug, Clone)]
pub struct GetPageBacklinksView<'a> {
    pub site_id: i64,
    pub page: Reference<'a>,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct PageBacklinkView {
    pub slug: String,
    pub title: String,
}

fn backlinks_scan_saturated(visible_count: usize) -> bool {
    visible_count > MAX_PAGE_BACKLINKS
}

impl ViewService {
    pub async fn backlinks(
        ctx: &ServiceContext<'_>,
        input: GetPageBacklinksView<'_>,
    ) -> Result<Vec<PageBacklinkView>> {
        let make_error =
            || Error::new("failed to get page backlinks view", ErrorType::PageLink);
        let Some(target) = PageService::get_optional(ctx, input.site_id, input.page)
            .await
            .or_raise(make_error)?
        else {
            return Err(
                Error::new("page is not viewable", ErrorType::PermissionDenied).into(),
            );
        };
        let target_is_viewable = PermissionService::check_user_can(
            ctx,
            &CheckPermissionContext {
                user_id: ctx.request().user_id,
                site_id: input.site_id,
                page_reference: Some(Reference::Id(target.page_id)),
            },
            Permission {
                resource_type: Resource::Page,
                resource_category: Some(Reference::Id(target.page_category_id)),
                action: Action::View,
            },
        )
        .await
        .or_raise(make_error)?;
        if !target_is_viewable {
            return Err(
                Error::new("page is not viewable", ErrorType::PermissionDenied).into(),
            );
        }

        let user_id = ctx.request().user_id;
        let mut backlinks = Vec::new();
        let mut category_permissions = BTreeMap::new();
        let mut last_from_page_id: Option<i64> = None;
        loop {
            let mut query = PageConnection::find()
                .filter(page_connection::Column::ToPageId.eq(target.page_id))
                .filter(page_connection::Column::ConnectionType.eq(ConnectionType::Link))
                .order_by_asc(page_connection::Column::FromPageId)
                .limit(PAGE_BACKLINK_SCAN_BATCH);
            if let Some(last_from_page_id) = last_from_page_id {
                query = query
                    .filter(page_connection::Column::FromPageId.gt(last_from_page_id));
            }
            let connections = query.all(ctx.transaction()).await.or_raise(make_error)?;
            let scanned = connections.len() as u64;
            if scanned == 0 {
                break;
            }
            last_from_page_id = connections.last().map(|row| row.from_page_id);

            let from_page_ids = connections
                .iter()
                .map(|row| row.from_page_id)
                .collect::<Vec<_>>();
            let mut pages_by_id = Page::find()
                .filter(page::Column::SiteId.eq(input.site_id))
                .filter(page::Column::DeletedAt.is_null())
                .filter(page::Column::PageId.is_in(from_page_ids))
                .filter(Expr::cust(foreign_snapshot_exclusion_sql(
                    "page.page_id",
                    input.site_id,
                )))
                .all(ctx.transaction())
                .await
                .or_raise(make_error)?
                .into_iter()
                .map(|page| (page.page_id, page))
                .collect::<HashMap<_, _>>();
            let ordered_pages = connections
                .iter()
                .filter_map(|row| pages_by_id.remove(&row.from_page_id))
                .collect::<Vec<_>>();

            let viewable = view_decisions_for_scanned_pages(
                ctx,
                user_id,
                &ordered_pages
                    .iter()
                    .map(|page| ViewablePageRef {
                        page_id: page.page_id,
                        site_id: page.site_id,
                        page_category_id: Some(page.page_category_id),
                    })
                    .collect::<Vec<_>>(),
                &mut category_permissions,
            )
            .await
            .or_raise(make_error)?;

            for (page, can_view) in ordered_pages.iter().zip(viewable) {
                if !can_view {
                    continue;
                }

                let revision =
                    PageRevisionService::get_latest(ctx, input.site_id, page.page_id)
                        .await
                        .or_raise(make_error)?;
                if revision
                    .hidden
                    .iter()
                    .any(|field| field == "title" || field == "slug")
                {
                    continue;
                }
                backlinks.push(PageBacklinkView {
                    slug: revision.slug,
                    title: revision.title,
                });
                if backlinks_scan_saturated(backlinks.len()) {
                    return Err(Error::new(
                        "page backlinks scan exceeded its public limit",
                        ErrorType::PageLink,
                    )
                    .into());
                }
            }
            if scanned < PAGE_BACKLINK_SCAN_BATCH {
                break;
            }
        }

        backlinks.sort_by(|left, right| {
            left.title
                .to_lowercase()
                .cmp(&right.title.to_lowercase())
                .then_with(|| left.slug.cmp(&right.slug))
        });
        Ok(backlinks)
    }
}

#[cfg(test)]
mod tests {
    use super::{MAX_PAGE_BACKLINKS, backlinks_scan_saturated};

    #[test]
    fn page_backlinks_limit_counts_visible_rows() {
        assert!(!backlinks_scan_saturated(MAX_PAGE_BACKLINKS));
        assert!(backlinks_scan_saturated(MAX_PAGE_BACKLINKS + 1));
    }
}
