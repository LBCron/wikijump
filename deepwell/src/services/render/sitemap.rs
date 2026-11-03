/*
 * services/render/sitemap.rs
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

use super::service::RenderService;
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::services::ServiceContext;
use crate::services::page::foreign_snapshot_exclusion_sql;
use crate::services::permission::{CheckPermissionContext, PermissionService};
use crate::types::{Action, Permission, Resource};
use sea_orm::{ConnectionTrait, FromQueryResult, Statement, Value};
use serde::Serialize;
use std::collections::BTreeMap;
use time::OffsetDateTime;

pub const SITEMAP_ENTRIES_PER_SHARD: u64 = 1_000;
#[derive(Debug, FromQueryResult)]
struct SitemapPageRow {
    slug: String,
    last_modified: OffsetDateTime,
}

#[derive(Debug, FromQueryResult)]
struct SitemapCategoryRow {
    page_category_id: i64,
}

#[derive(Debug, FromQueryResult)]
struct SitemapCountRow {
    eligible_count: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct WikidotSitemapEntry {
    pub slug: String,
    #[serde(with = "time::serde::rfc3339")]
    pub last_modified: OffsetDateTime,
}

#[derive(Clone, Debug, Serialize)]
pub struct WikidotSitemapOutput {
    pub entries: Vec<WikidotSitemapEntry>,
    pub shard_count: Option<u64>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AnonymousViewer;

impl AnonymousViewer {
    pub const fn user_id(self) -> Option<i64> {
        None
    }
}

impl RenderService {
    pub async fn wikidot_sitemap(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        shard: u64,
        viewer: AnonymousViewer,
    ) -> Result<Option<WikidotSitemapOutput>> {
        let start = shard
            .saturating_sub(1)
            .checked_mul(SITEMAP_ENTRIES_PER_SHARD)
            .ok_or_else(|| {
                Error::new("sitemap shard number overflow", ErrorType::Render)
            })?;
        let site_viewable = PermissionService::check_user_can(
            ctx,
            &CheckPermissionContext {
                user_id: viewer.user_id(),
                site_id,
                page_reference: None,
            },
            Permission {
                resource_type: Resource::Page,
                resource_category: None,
                action: Action::View,
            },
        )
        .await
        .or_raise(|| {
            Error::new(
                format!("failed to check sitemap visibility for site ID {site_id}"),
                ErrorType::Render,
            )
        })?;
        if !site_viewable {
            return Ok(None);
        }

        let make_error = || {
            Error::new(
                format!("failed to load sitemap entries for site ID {site_id}"),
                ErrorType::Render,
            )
        };
        let categories =
            SitemapCategoryRow::find_by_statement(Statement::from_sql_and_values(
                ctx.transaction().get_database_backend(),
                "SELECT category_id AS page_category_id FROM page_category WHERE site_id = $1",
                [Value::from(site_id)],
            ))
            .all(ctx.transaction())
            .await
            .or_raise(make_error)?;
        let candidate_ids = categories
            .iter()
            .map(|category| Some(category.page_category_id))
            .collect::<Vec<_>>();
        let mut category_permissions = BTreeMap::new();
        let decisions = PermissionService::batch_check_page_view_without_page_roles(
            ctx,
            viewer.user_id(),
            site_id,
            &candidate_ids,
            &mut category_permissions,
        )
        .await
        .or_raise(make_error)?;
        let allowed_ids = categories
            .iter()
            .zip(decisions)
            .filter_map(|(category, visible)| {
                visible.then_some(category.page_category_id)
            })
            .collect::<Vec<_>>();
        if allowed_ids.is_empty() {
            return Ok(Some(WikidotSitemapOutput {
                entries: Vec::new(),
                shard_count: (shard == 0).then_some(0),
            }));
        }

        let allowed_sql = allowed_ids
            .iter()
            .map(i64::to_string)
            .collect::<Vec<_>>()
            .join(",");
        let where_sql = format!(
            "site_id = $1 AND deleted_at IS NULL AND page_category_id IN ({allowed_sql}) AND {}",
            foreign_snapshot_exclusion_sql("page.page_id", site_id),
        );

        if shard == 0 {
            let count = SitemapCountRow::find_by_statement(Statement::from_sql_and_values(
                ctx.transaction().get_database_backend(),
                format!("SELECT COUNT(*)::BIGINT AS eligible_count FROM page WHERE {where_sql}"),
                [Value::from(site_id)],
            ))
            .one(ctx.transaction())
            .await
            .or_raise(make_error)?
            .expect("COUNT aggregate always returns one row");
            let count = u64::try_from(count.eligible_count)
                .expect("a SQL COUNT must not be negative");
            return Ok(Some(WikidotSitemapOutput {
                entries: Vec::new(),
                shard_count: Some(count.div_ceil(SITEMAP_ENTRIES_PER_SHARD)),
            }));
        }

        if start > i64::MAX as u64 {
            return Ok(Some(WikidotSitemapOutput {
                entries: Vec::new(),
                shard_count: None,
            }));
        }
        let rows = SitemapPageRow::find_by_statement(Statement::from_sql_and_values(
            ctx.transaction().get_database_backend(),
            format!(
                "SELECT slug, \
                        COALESCE(updated_at, created_at) AS last_modified \
                 FROM page WHERE {where_sql} \
                 ORDER BY page_id ASC LIMIT {SITEMAP_ENTRIES_PER_SHARD} OFFSET {start}"
            ),
            [Value::from(site_id)],
        ))
        .all(ctx.transaction())
        .await
        .or_raise(make_error)?;
        Ok(Some(WikidotSitemapOutput {
            entries: rows
                .into_iter()
                .map(|row| WikidotSitemapEntry {
                    slug: row.slug,
                    last_modified: row.last_modified,
                })
                .collect(),
            shard_count: None,
        }))
    }
}
