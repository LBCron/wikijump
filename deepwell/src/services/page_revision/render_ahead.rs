/*
 * services/page_revision/render_ahead.rs
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

use super::service::PageRevisionService;
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::services::ServiceContext;
use crate::services::render::RenderPageOutput;
use crate::types::PageId;
use sea_orm::{ConnectionTrait, Statement, Value};

impl PageRevisionService {
    pub(crate) async fn render_ahead(
        ctx: &ServiceContext<'_>,
        id: PageId,
    ) -> Result<i64> {
        let PageId {
            site_id,
            category_id,
            page_id,
        } = id;
        let make_error = || {
            Error::new(
                format!(
                    "failed to render ahead page ID {page_id} in category ID {category_id} on site ID {site_id}",
                ),
                ErrorType::PageRevision,
            )
        };

        let revision = Self::get_latest(ctx, site_id, page_id)
            .await
            .or_raise(make_error)?;
        let fresh_render =
            Self::render_revision(ctx, id, &revision, revision.from_wikidot, None)
                .await
                .or_raise(make_error)?;
        let rendered_revision_id = fresh_render.checked_revision_id();
        let RenderPageOutput {
            compiled_body_html_hash,
            compiled_body_styles_hash,
            compiled_top_bar_html_hash,
            compiled_side_bar_html_hash,
            compiled_at,
            compiled_generator,
            ..
        } = fresh_render.into_output();

        let txn = ctx.transaction();
        txn.execute_raw(Statement::from_sql_and_values(
            txn.get_database_backend(),
            r#"
            INSERT INTO page_revision_render_ahead (
                revision_id, site_id, page_id, wikitext_hash, source_updated_at,
                compiled_body_html_hash, compiled_body_styles_hash,
                compiled_top_bar_html_hash, compiled_side_bar_html_hash,
                compiled_at, compiled_generator, rendered_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
            ON CONFLICT (revision_id) DO UPDATE SET
                site_id = EXCLUDED.site_id,
                page_id = EXCLUDED.page_id,
                wikitext_hash = EXCLUDED.wikitext_hash,
                source_updated_at = EXCLUDED.source_updated_at,
                compiled_body_html_hash = EXCLUDED.compiled_body_html_hash,
                compiled_body_styles_hash = EXCLUDED.compiled_body_styles_hash,
                compiled_top_bar_html_hash = EXCLUDED.compiled_top_bar_html_hash,
                compiled_side_bar_html_hash = EXCLUDED.compiled_side_bar_html_hash,
                compiled_at = EXCLUDED.compiled_at,
                compiled_generator = EXCLUDED.compiled_generator,
                rendered_at = EXCLUDED.rendered_at
            "#,
            [
                Value::from(revision.revision_id),
                Value::from(site_id),
                Value::from(page_id),
                Value::from(revision.wikitext_hash.clone()),
                Value::from(revision.updated_at),
                Value::from(compiled_body_html_hash.to_vec()),
                Value::from(compiled_body_styles_hash.to_vec()),
                Value::from(compiled_top_bar_html_hash.map(Vec::from)),
                Value::from(compiled_side_bar_html_hash.map(Vec::from)),
                Value::from(compiled_at),
                Value::from(compiled_generator),
            ],
        ))
        .await
        .or_raise(make_error)?;

        Ok(rendered_revision_id)
    }
}
