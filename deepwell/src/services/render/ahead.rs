/*
 * services/render/ahead.rs
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

use super::corpus::{parse_boolish, parse_positive_i64, parse_positive_usize};
use super::generator::COMPILED_GENERATOR;
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::runtime::ServerState;
use crate::services::public_cache::PublicContentCache;
use crate::services::{PageRevisionService, ServiceContext};
use crate::types::PageId;
use exn::ErrorExt;
use futures::{StreamExt, stream};
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement, TransactionTrait, Value};
use std::env;
use std::fmt;
use std::time::Instant;
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

const ACTION: &str = "render-ahead";
const DEFAULT_BATCH_SIZE: i64 = 200;
const DEFAULT_CONCURRENCY: usize = 16;
const MAX_REPORTED_FAILURES: usize = 50;
const MAX_REPORTED_SLOW_RENDERS: usize = 50;
const SLOW_RENDER_MS: u64 = 1_000;

#[derive(Debug)]
struct ValidAheadRowPredicate {
    compiled_generator: String,
    rendered_at_or_after: OffsetDateTime,
}

impl ValidAheadRowPredicate {
    fn new(compiled_generator: String, rendered_at_or_after: OffsetDateTime) -> Self {
        Self {
            compiled_generator,
            rendered_at_or_after,
        }
    }

    fn bind(&self, values: &mut Vec<Value>) {
        values.push(Value::from(self.compiled_generator.clone()));
        values.push(Value::from(self.rendered_at_or_after));
    }
}

impl fmt::Display for ValidAheadRowPredicate {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "ahead.revision_id = revision.revision_id \
             AND ahead.compiled_generator = $1 \
             AND ahead.wikitext_hash = revision.wikitext_hash \
             AND ahead.source_updated_at IS NOT DISTINCT FROM revision.updated_at \
             AND ahead.rendered_at >= $2",
        )
    }
}

#[derive(Debug)]
pub struct RenderAheadService;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RenderAheadSettings {
    pub batch_size: i64,
    pub concurrency: usize,
    pub not_before: Option<OffsetDateTime>,
    pub page_ids: Option<Vec<i64>>,
    pub dry_run: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct RenderAheadSummary {
    action: &'static str,
    compiled_generator: String,
    dry_run: bool,
    batch_size: i64,
    concurrency: usize,
    candidates: usize,
    rendered: usize,
    failed: usize,
    failed_page_ids: Vec<i64>,
    link_reader_page_ids: Vec<i64>,
    stale_without_valid_ahead: i64,
    elapsed_ms: u128,
    rows_per_sec: f64,
    failures: Vec<RenderAheadFailure>,
    slow_renders: usize,
    slowest_renders: Vec<RenderAheadTiming>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RenderAheadTiming {
    site_id: i64,
    page_id: i64,
    elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RenderAheadFailure {
    site_id: i64,
    page_id: i64,
    error: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RenderAheadPromotion {
    pub compiled_generator: String,
    pub promoted: i64,
    pub discarded: i64,
    pub site_ids: Vec<i64>,
}

impl RenderAheadSettings {
    pub fn from_env() -> Result<Self> {
        Self::from_getter(|name| env::var(name).ok())
    }

    pub(crate) fn from_getter(
        mut get: impl FnMut(&str) -> Option<String>,
    ) -> Result<Self> {
        Ok(Self {
            batch_size: parse_positive_i64(
                "DEEPWELL_RENDER_AHEAD_BATCH_SIZE",
                get("DEEPWELL_RENDER_AHEAD_BATCH_SIZE"),
                DEFAULT_BATCH_SIZE,
            )?,
            concurrency: parse_positive_usize(
                "DEEPWELL_RENDER_AHEAD_CONCURRENCY",
                get("DEEPWELL_RENDER_AHEAD_CONCURRENCY"),
                DEFAULT_CONCURRENCY,
            )?,
            not_before: parse_not_before(get("DEEPWELL_RENDER_AHEAD_NOT_BEFORE"))?,
            page_ids: parse_page_ids(get("DEEPWELL_RENDER_AHEAD_PAGE_IDS"))?,
            dry_run: parse_boolish(
                "DEEPWELL_RENDER_AHEAD_DRY_RUN",
                get("DEEPWELL_RENDER_AHEAD_DRY_RUN"),
            )?
            .unwrap_or(true),
        })
    }
}

impl RenderAheadService {
    pub async fn run(
        state: &ServerState,
        settings: RenderAheadSettings,
    ) -> Result<RenderAheadSummary> {
        let started_at = Instant::now();
        let mut rendered = 0;
        let mut failures = Vec::new();
        let mut failed_page_ids = Vec::new();
        let mut link_reader_page_ids = Vec::new();
        let mut timings = Vec::new();

        let mut candidates = Vec::new();
        let mut after_page_id = 0;
        loop {
            let batch = Self::select_candidates(state, &settings, after_page_id).await?;
            let Some(last) = batch.last() else {
                break;
            };
            after_page_id = last.page_id;
            candidates.extend(batch);
        }
        let candidate_count = candidates.len();

        if !settings.dry_run {
            let mut results = stream::iter(candidates)
                .map(|id| {
                    let task = tokio::spawn({
                        let state = state.clone();
                        async move {
                            let started_at = Instant::now();
                            let result = Self::render_page(&state, id).await;
                            result.map(|rendered| (rendered, elapsed_ms(started_at)))
                        }
                    });
                    async move {
                        let result = task.await.unwrap_or_else(|error| {
                            Err(Error::new(
                                format!(
                                    "render-ahead task for page ID {} failed: {error}",
                                    id.page_id,
                                ),
                                ErrorType::Render,
                            )
                            .raise())
                        });
                        (id, result)
                    }
                })
                .buffer_unordered(settings.concurrency);

            while let Some((id, result)) = results.next().await {
                match result {
                    Ok((RenderedAhead { reads_link_graph }, elapsed_ms)) => {
                        rendered += 1;
                        timings.push(RenderAheadTiming {
                            site_id: id.site_id,
                            page_id: id.page_id,
                            elapsed_ms,
                        });
                        if reads_link_graph {
                            link_reader_page_ids.push(id.page_id);
                        }
                    }
                    Err(error) => {
                        failed_page_ids.push(id.page_id);
                        warn!(
                            "render-ahead failed for page ID {} on site ID {}: {error}",
                            id.page_id, id.site_id,
                        );
                        if failures.len() < MAX_REPORTED_FAILURES {
                            failures.push(RenderAheadFailure {
                                site_id: id.site_id,
                                page_id: id.page_id,
                                error: format!("{error:?}"),
                            });
                        }
                    }
                }
            }
        }

        let stale_without_valid_ahead =
            Self::count_stale_without_valid_ahead(state, &settings).await?;
        let elapsed = started_at.elapsed();
        let elapsed_secs = elapsed.as_secs_f64();
        failed_page_ids.sort_unstable();
        link_reader_page_ids.sort_unstable();
        let (slow_renders, slowest_renders) = slowest_renders(timings);
        Ok(RenderAheadSummary {
            action: ACTION,
            compiled_generator: COMPILED_GENERATOR.clone(),
            dry_run: settings.dry_run,
            batch_size: settings.batch_size,
            concurrency: settings.concurrency,
            candidates: candidate_count,
            rendered,
            failed: failed_page_ids.len(),
            failed_page_ids,
            link_reader_page_ids,
            stale_without_valid_ahead,
            elapsed_ms: elapsed.as_millis(),
            rows_per_sec: if elapsed_secs > 0.0 {
                rendered as f64 / elapsed_secs
            } else {
                0.0
            },
            failures,
            slow_renders,
            slowest_renders,
        })
    }

    pub async fn promote(
        state: &ServerState,
        page_ids: Option<&[i64]>,
    ) -> Result<RenderAheadPromotion> {
        let make_error =
            || Error::new("failed to promote render-ahead output", ErrorType::Render);
        let generator = COMPILED_GENERATOR.clone();
        let page_filter = page_ids.map(|ids| ids.to_vec());
        let valid_ahead_row =
            ValidAheadRowPredicate::new(generator.clone(), OffsetDateTime::UNIX_EPOCH);
        let mut values = Vec::new();
        valid_ahead_row.bind(&mut values);
        values.push(Value::from(page_filter));
        let txn = state.database.begin().await.or_raise(make_error)?;
        let row = txn
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                format!(
                    r#"
                    WITH promoted AS (
                        UPDATE page_revision AS revision SET
                            updated_at = NOW(),
                            compiled_body_html_hash = ahead.compiled_body_html_hash,
                            compiled_body_styles_hash = ahead.compiled_body_styles_hash,
                            compiled_top_bar_html_hash = ahead.compiled_top_bar_html_hash,
                            compiled_side_bar_html_hash = ahead.compiled_side_bar_html_hash,
                            compiled_at = ahead.compiled_at,
                            compiled_generator = ahead.compiled_generator
                        FROM page_revision_render_ahead AS ahead
                        JOIN page ON page.latest_revision_id = ahead.revision_id
                        WHERE {valid_ahead_row}
                        AND page.deleted_at IS NULL
                        AND revision.compiled_generator <> $1
                        AND ($3::BIGINT[] IS NULL OR ahead.page_id = ANY($3))
                        RETURNING revision.revision_id, revision.site_id
                    ),
                    discarded AS (
                        DELETE FROM page_revision_render_ahead AS ahead
                        WHERE ahead.compiled_generator = $1
                        AND ($3::BIGINT[] IS NULL OR ahead.page_id = ANY($3))
                        RETURNING ahead.revision_id
                    )
                    SELECT
                        (SELECT COUNT(*) FROM promoted) AS promoted,
                        (SELECT COUNT(*) FROM discarded) AS removed,
                        COALESCE(
                            (SELECT ARRAY_AGG(DISTINCT site_id ORDER BY site_id) FROM promoted),
                            '{{}}'::BIGINT[]
                        ) AS site_ids
                    "#,
                ),
                values,
            ))
            .await
            .or_raise(make_error)?
            .ok_or_else(make_error)?;
        let promoted: i64 = row.try_get("", "promoted").or_raise(make_error)?;
        let removed: i64 = row.try_get("", "removed").or_raise(make_error)?;
        let site_ids: Vec<i64> = row.try_get("", "site_ids").or_raise(make_error)?;
        txn.commit().await.or_raise(make_error)?;

        for &site_id in &site_ids {
            PublicContentCache::invalidate_site_for_state(state, site_id)
                .await
                .or_raise(make_error)?;
        }

        Ok(RenderAheadPromotion {
            compiled_generator: generator,
            promoted,
            discarded: removed - promoted,
            site_ids,
        })
    }

    async fn select_candidates(
        state: &ServerState,
        settings: &RenderAheadSettings,
        after_page_id: i64,
    ) -> Result<Vec<PageId>> {
        let make_error = || {
            Error::new(
                "failed to select render-ahead candidates",
                ErrorType::Render,
            )
        };
        let valid_ahead_row =
            ValidAheadRowPredicate::new(COMPILED_GENERATOR.clone(), not_before(settings));
        let mut values = Vec::new();
        valid_ahead_row.bind(&mut values);
        values.extend([
            Value::from(after_page_id),
            Value::from(settings.page_ids.clone()),
            Value::from(settings.batch_size),
        ]);
        let rows = state
            .database
            .query_all_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                format!(
                    r#"
                    SELECT page.page_id, page.site_id, page.page_category_id
                    FROM page
                    JOIN page_revision AS revision
                        ON revision.revision_id = page.latest_revision_id
                    WHERE page.deleted_at IS NULL
                    AND revision.compiled_generator <> $1
                    AND page.page_id > $3
                    AND ($4::BIGINT[] IS NULL OR page.page_id = ANY($4))
                    AND NOT EXISTS (
                        SELECT 1 FROM page_revision_render_ahead AS ahead
                        WHERE {valid_ahead_row}
                    )
                    ORDER BY page.page_id
                    LIMIT $5
                    "#,
                ),
                values,
            ))
            .await
            .or_raise(make_error)?;

        rows.iter()
            .map(|row| {
                Ok(PageId {
                    page_id: row.try_get("", "page_id").or_raise(make_error)?,
                    site_id: row.try_get("", "site_id").or_raise(make_error)?,
                    category_id: row
                        .try_get("", "page_category_id")
                        .or_raise(make_error)?,
                })
            })
            .collect()
    }

    async fn count_stale_without_valid_ahead(
        state: &ServerState,
        settings: &RenderAheadSettings,
    ) -> Result<i64> {
        let make_error =
            || Error::new("failed to count render-ahead stragglers", ErrorType::Render);
        let valid_ahead_row =
            ValidAheadRowPredicate::new(COMPILED_GENERATOR.clone(), not_before(settings));
        let mut values = Vec::new();
        valid_ahead_row.bind(&mut values);
        values.push(Value::from(settings.page_ids.clone()));
        let row = state
            .database
            .query_one_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                format!(
                    r#"
                    SELECT COUNT(*) AS stale
                    FROM page
                    JOIN page_revision AS revision
                        ON revision.revision_id = page.latest_revision_id
                    WHERE page.deleted_at IS NULL
                    AND revision.compiled_generator <> $1
                    AND ($3::BIGINT[] IS NULL OR page.page_id = ANY($3))
                    AND NOT EXISTS (
                        SELECT 1 FROM page_revision_render_ahead AS ahead
                        WHERE {valid_ahead_row}
                    )
                    "#,
                ),
                values,
            ))
            .await
            .or_raise(make_error)?
            .ok_or_else(make_error)?;
        row.try_get("", "stale").or_raise(make_error)
    }

    async fn render_page(state: &ServerState, id: PageId) -> Result<RenderedAhead> {
        let make_error = || {
            Error::new(
                format!("failed to render ahead page ID {}", id.page_id),
                ErrorType::Render,
            )
        };
        let txn = state.database.begin().await.or_raise(make_error)?;
        let result: Result<_> = async {
            let ctx = ServiceContext::new(state, &txn);
            PageRevisionService::render_ahead(&ctx, id).await?;
            let actions = ctx.drain_post_commit_actions()?;
            let rendered = RenderedAhead {
                reads_link_graph: ctx.link_graph_was_read(),
            };
            Ok((rendered, actions))
        }
        .await;

        match result {
            Ok((rendered, actions)) => {
                txn.commit().await.or_raise(make_error)?;
                ServiceContext::run_post_commit_actions_for_corpus_finalizer(
                    state, actions,
                )
                .await
                .or_raise(make_error)?;
                Ok(rendered)
            }
            Err(error) => {
                txn.rollback().await.or_raise(make_error)?;
                Err(error)
            }
        }
    }
}

#[derive(Debug, Clone, Copy)]
struct RenderedAhead {
    reads_link_graph: bool,
}

fn elapsed_ms(started_at: Instant) -> u64 {
    u64::try_from(started_at.elapsed().as_millis()).unwrap_or(u64::MAX)
}

fn slowest_renders(
    mut timings: Vec<RenderAheadTiming>,
) -> (usize, Vec<RenderAheadTiming>) {
    let slow = timings
        .iter()
        .filter(|timing| timing.elapsed_ms >= SLOW_RENDER_MS)
        .count();
    timings.sort_unstable_by(|a, b| {
        b.elapsed_ms
            .cmp(&a.elapsed_ms)
            .then(a.page_id.cmp(&b.page_id))
    });
    timings.truncate(MAX_REPORTED_SLOW_RENDERS);
    (slow, timings)
}

fn not_before(settings: &RenderAheadSettings) -> OffsetDateTime {
    settings.not_before.unwrap_or(OffsetDateTime::UNIX_EPOCH)
}

fn parse_not_before(value: Option<String>) -> Result<Option<OffsetDateTime>> {
    value
        .map(|value| {
            OffsetDateTime::parse(value.trim(), &Rfc3339).or_raise(|| {
                Error::new(
                    "DEEPWELL_RENDER_AHEAD_NOT_BEFORE must be an RFC 3339 timestamp",
                    ErrorType::ConfigSetup,
                )
            })
        })
        .transpose()
}

fn parse_page_ids(value: Option<String>) -> Result<Option<Vec<i64>>> {
    let Some(value) = value else {
        return Ok(None);
    };
    let ids = value
        .split(',')
        .map(|id| {
            parse_positive_i64("DEEPWELL_RENDER_AHEAD_PAGE_IDS", Some(id.to_owned()), 0)
        })
        .collect::<Result<Vec<_>>>()?;
    if ids.is_empty() {
        return Err(Error::new(
            "DEEPWELL_RENDER_AHEAD_PAGE_IDS must list at least one page ID",
            ErrorType::ConfigSetup,
        )
        .into());
    }
    Ok(Some(ids))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn settings(values: &[(&str, &str)]) -> Result<RenderAheadSettings> {
        let values: HashMap<_, _> = values.iter().copied().collect();
        RenderAheadSettings::from_getter(|name| values.get(name).map(|v| (*v).to_owned()))
    }

    #[test]
    fn render_ahead_settings_default_to_a_dry_run() {
        let defaults = settings(&[]).expect("defaults should parse");
        assert_eq!(
            defaults,
            RenderAheadSettings {
                batch_size: DEFAULT_BATCH_SIZE,
                concurrency: DEFAULT_CONCURRENCY,
                not_before: None,
                page_ids: None,
                dry_run: true,
            },
        );
    }

    #[test]
    fn render_ahead_settings_parse_every_option() {
        let configured = settings(&[
            ("DEEPWELL_RENDER_AHEAD_BATCH_SIZE", "50"),
            ("DEEPWELL_RENDER_AHEAD_CONCURRENCY", "4"),
            ("DEEPWELL_RENDER_AHEAD_NOT_BEFORE", "2026-10-14T12:00:00Z"),
            ("DEEPWELL_RENDER_AHEAD_PAGE_IDS", "7, 3"),
            ("DEEPWELL_RENDER_AHEAD_DRY_RUN", "false"),
        ])
        .expect("configured settings should parse");
        assert_eq!(configured.batch_size, 50);
        assert_eq!(configured.concurrency, 4);
        assert_eq!(
            configured.not_before,
            Some(OffsetDateTime::parse("2026-10-14T12:00:00Z", &Rfc3339).unwrap()),
        );
        assert_eq!(configured.page_ids, Some(vec![7, 3]));
        assert!(!configured.dry_run);
    }

    #[test]
    fn summary_counts_slow_renders_and_keeps_the_slowest_first() {
        let timing = |page_id, elapsed_ms| RenderAheadTiming {
            site_id: 1,
            page_id,
            elapsed_ms,
        };
        let mut timings: Vec<_> = (0..120).map(|page_id| timing(page_id, 10)).collect();
        timings.extend([timing(500, 999), timing(501, 1_000), timing(502, 4_200)]);

        let (slow, slowest) = slowest_renders(timings);

        assert_eq!(slow, 2);
        assert_eq!(slowest.len(), MAX_REPORTED_SLOW_RENDERS);
        assert_eq!(
            slowest[..4],
            [
                timing(502, 4_200),
                timing(501, 1_000),
                timing(500, 999),
                timing(0, 10)
            ],
        );
    }

    #[test]
    fn render_ahead_settings_reject_invalid_values() {
        for (name, value) in [
            ("DEEPWELL_RENDER_AHEAD_BATCH_SIZE", "0"),
            ("DEEPWELL_RENDER_AHEAD_CONCURRENCY", "-1"),
            ("DEEPWELL_RENDER_AHEAD_NOT_BEFORE", "yesterday"),
            ("DEEPWELL_RENDER_AHEAD_PAGE_IDS", ""),
            ("DEEPWELL_RENDER_AHEAD_PAGE_IDS", "1,x"),
            ("DEEPWELL_RENDER_AHEAD_DRY_RUN", "maybe"),
        ] {
            assert!(settings(&[(name, value)]).is_err(), "{name}={value:?}");
        }
    }
}
