/*
 * services/page_edit_lock/service.rs
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

use super::structs::{
    AcquirePageEditLock, AcquirePageEditLockOutput, PageEditLockConflictInfo,
    PageEditLockGrant, ReleasePageEditLock, RenewPageEditLock, RenewPageEditLockOutput,
};
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::page_edit_lock::{
    self, Entity as PageEditLock, Model as PageEditLockModel,
};
use crate::services::{PageService, ServiceContext};
use crate::types::PageEditLockMode;
use crate::utils::{assert_is_csprng, now};
use rand::distr::{Alphanumeric, SampleString};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use time::{Duration, OffsetDateTime};

pub const PAGE_EDIT_LOCK_DURATION: Duration = Duration::seconds(900);

const LOCK_SECRET_LENGTH: usize = 32;

#[derive(Debug, Clone)]
pub struct PageEditLockService;

impl PageEditLockService {
    pub async fn acquire(
        ctx: &ServiceContext<'_>,
        input: AcquirePageEditLock<'_>,
    ) -> Result<AcquirePageEditLockOutput> {
        Self::acquire_impl(ctx, input, false).await
    }

    pub async fn force_acquire(
        ctx: &ServiceContext<'_>,
        input: AcquirePageEditLock<'_>,
    ) -> Result<AcquirePageEditLockOutput> {
        Self::acquire_impl(ctx, input, true).await
    }

    async fn acquire_impl(
        ctx: &ServiceContext<'_>,
        input: AcquirePageEditLock<'_>,
        force: bool,
    ) -> Result<AcquirePageEditLockOutput> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to acquire page edit lock in site ID {} for user ID {}",
                    input.site_id, input.user_id,
                ),
                ErrorType::Page,
            )
        };

        check_mode_section(input.mode, input.section_index).or_raise(make_error)?;

        let page_id = PageService::get(ctx, input.site_id, input.page.borrow())
            .await
            .or_raise(make_error)?
            .page_id;

        let locked_page = Self::lock_page(ctx, page_id).await.or_raise(make_error)?;
        let base_revision_id = locked_page.latest_revision_id;

        let rows = Self::rows_for_page(ctx, page_id)
            .await
            .or_raise(make_error)?;
        let now = now();
        let conflicting: Vec<&PageEditLockModel> = rows
            .iter()
            .filter(|row| {
                modes_conflict(
                    input.mode,
                    input.section_index,
                    row.mode,
                    row.section_index,
                )
            })
            .collect();

        if force {
            for row in &conflicting {
                Self::delete_by_id(ctx, row.page_edit_lock_id)
                    .await
                    .or_raise(make_error)?;
            }
        }

        let live_conflicts: Vec<&PageEditLockModel> = conflicting
            .into_iter()
            .filter(|row| !force && is_live(row, now))
            .collect();

        if !live_conflicts.is_empty() {
            return Ok(AcquirePageEditLockOutput {
                grant: None,
                conflicts: live_conflicts
                    .iter()
                    .map(|row| PageEditLockConflictInfo {
                        user_id: row.user_id,
                        mode: row.mode,
                        section_index: row.section_index,
                        seconds_remaining: (row.expires_at - now).whole_seconds().max(0),
                    })
                    .collect(),
            });
        }

        let model = Self::insert_row(
            ctx,
            page_id,
            input.user_id,
            input.mode,
            input.section_index,
            base_revision_id,
        )
        .await
        .or_raise(make_error)?;

        Ok(AcquirePageEditLockOutput {
            grant: Some(PageEditLockGrant {
                lock_id: model.lock_id,
                lock_secret: model.lock_secret,
                base_revision_id: model.base_revision_id,
                expires_at: model.expires_at,
            }),
            conflicts: Vec::new(),
        })
    }

    pub async fn renew(
        ctx: &ServiceContext<'_>,
        input: RenewPageEditLock<'_>,
    ) -> Result<RenewPageEditLockOutput> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to renew page edit lock in site ID {} for user ID {}",
                    input.site_id, input.user_id,
                ),
                ErrorType::Page,
            )
        };
        let make_conflict_error = || {
            Error::new(
                format!(
                    "page edit lock {} is superseded by a conflicting live lock",
                    input.lock_id,
                ),
                ErrorType::PageEditLockConflict,
            )
        };

        check_mode_section(input.mode, input.section_index).or_raise(make_error)?;

        let page_id = PageService::get(ctx, input.site_id, input.page.borrow())
            .await
            .or_raise(make_error)?
            .page_id;

        let locked_page = Self::lock_page(ctx, page_id).await.or_raise(make_error)?;

        let rows = Self::rows_for_page(ctx, page_id)
            .await
            .or_raise(make_error)?;
        let now = now();
        let named = rows.iter().find(|row| row.lock_id == input.lock_id);

        if let Some(row) = named
            && row.lock_secret == input.lock_secret
            && row.user_id == input.user_id
        {
            if is_live(row, now) {
                let updated = Self::extend_row(ctx, row).await.or_raise(make_error)?;
                return Ok(RenewPageEditLockOutput {
                    lock_id: updated.lock_id,
                    lock_secret: updated.lock_secret,
                    base_revision_id: updated.base_revision_id,
                    lock_recreated: false,
                    expires_at: updated.expires_at,
                });
            }

            let blocked = rows.iter().any(|other| {
                other.page_edit_lock_id != row.page_edit_lock_id
                    && is_live(other, now)
                    && modes_conflict(
                        input.mode,
                        input.section_index,
                        other.mode,
                        other.section_index,
                    )
            });
            if blocked {
                bail!(make_conflict_error());
            }

            let updated = Self::extend_row(ctx, row).await.or_raise(make_error)?;
            return Ok(RenewPageEditLockOutput {
                lock_id: updated.lock_id,
                lock_secret: updated.lock_secret,
                base_revision_id: updated.base_revision_id,
                lock_recreated: true,
                expires_at: updated.expires_at,
            });
        }

        if let Some(row) = named
            && is_live(row, now)
        {
            bail!(make_conflict_error());
        }

        let blocked = rows.iter().any(|other| {
            is_live(other, now)
                && modes_conflict(
                    input.mode,
                    input.section_index,
                    other.mode,
                    other.section_index,
                )
        });
        if blocked {
            bail!(make_conflict_error());
        }

        let model = Self::insert_row(
            ctx,
            page_id,
            input.user_id,
            input.mode,
            input.section_index,
            locked_page.latest_revision_id,
        )
        .await
        .or_raise(make_error)?;

        Ok(RenewPageEditLockOutput {
            lock_id: model.lock_id,
            lock_secret: model.lock_secret,
            base_revision_id: model.base_revision_id,
            lock_recreated: true,
            expires_at: model.expires_at,
        })
    }

    pub async fn release(
        ctx: &ServiceContext<'_>,
        input: ReleasePageEditLock<'_>,
    ) -> Result<bool> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to release page edit lock in site ID {} for user ID {}",
                    input.site_id, input.user_id,
                ),
                ErrorType::Page,
            )
        };

        let txn = ctx.transaction();
        let page_id = PageService::get(ctx, input.site_id, input.page.borrow())
            .await
            .or_raise(make_error)?
            .page_id;

        let result = PageEditLock::delete_many()
            .filter(page_edit_lock::Column::PageId.eq(page_id))
            .filter(page_edit_lock::Column::LockId.eq(input.lock_id))
            .filter(page_edit_lock::Column::LockSecret.eq(input.lock_secret.clone()))
            .filter(page_edit_lock::Column::UserId.eq(input.user_id))
            .exec(txn)
            .await
            .or_raise(make_error)?;

        Ok(result.rows_affected > 0)
    }

    pub(crate) async fn rows_for_page(
        ctx: &ServiceContext<'_>,
        page_id: i64,
    ) -> Result<Vec<PageEditLockModel>> {
        let txn = ctx.transaction();
        let rows = PageEditLock::find()
            .filter(page_edit_lock::Column::PageId.eq(page_id))
            .order_by_asc(page_edit_lock::Column::PageEditLockId)
            .all(txn)
            .await
            .or_raise(|| {
                Error::new(
                    format!("failed to list page edit locks for page ID {page_id}"),
                    ErrorType::Page,
                )
            })?;

        Ok(rows)
    }

    pub(crate) async fn delete_by_id(
        ctx: &ServiceContext<'_>,
        page_edit_lock_id: i64,
    ) -> Result<()> {
        let txn = ctx.transaction();
        PageEditLock::delete_by_id(page_edit_lock_id)
            .exec(txn)
            .await
            .or_raise(|| {
                Error::new(
                    format!("failed to delete page edit lock ID {page_edit_lock_id}"),
                    ErrorType::Page,
                )
            })?;

        Ok(())
    }

    pub(crate) async fn conflicting_live_rows(
        ctx: &ServiceContext<'_>,
        page_id: i64,
        mode: PageEditLockMode,
        section_index: Option<i32>,
    ) -> Result<Vec<PageEditLockModel>> {
        let rows = Self::rows_for_page(ctx, page_id).await?;
        let now = now();

        Ok(rows
            .into_iter()
            .filter(|row| {
                is_live(row, now)
                    && modes_conflict(mode, section_index, row.mode, row.section_index)
            })
            .collect())
    }

    pub(crate) async fn kill_conflicting_live(
        ctx: &ServiceContext<'_>,
        page_id: i64,
        mode: PageEditLockMode,
        section_index: Option<i32>,
    ) -> Result<()> {
        let rows = Self::conflicting_live_rows(ctx, page_id, mode, section_index).await?;

        for row in rows {
            Self::delete_by_id(ctx, row.page_edit_lock_id).await?;
        }

        Ok(())
    }

    pub(crate) async fn delete_all_for_page(
        ctx: &ServiceContext<'_>,
        page_id: i64,
    ) -> Result<()> {
        let txn = ctx.transaction();

        PageEditLock::delete_many()
            .filter(page_edit_lock::Column::PageId.eq(page_id))
            .exec(txn)
            .await
            .or_raise(|| {
                Error::new(
                    format!("failed to delete page edit locks for page ID {page_id}"),
                    ErrorType::Page,
                )
            })?;

        Ok(())
    }

    async fn lock_page(
        ctx: &ServiceContext<'_>,
        page_id: i64,
    ) -> Result<crate::models::page::Model> {
        let make_error = || {
            Error::new(
                format!("failed to lock page ID {page_id} for an edit lock operation"),
                ErrorType::Page,
            )
        };

        let page = PageService::get_direct_optional_for_update(ctx, page_id, false)
            .await
            .or_raise(make_error)?;

        let Some(page) = page else {
            bail!(make_error());
        };

        Ok(page)
    }

    async fn insert_row(
        ctx: &ServiceContext<'_>,
        page_id: i64,
        user_id: i64,
        mode: PageEditLockMode,
        section_index: Option<i32>,
        base_revision_id: Option<i64>,
    ) -> Result<PageEditLockModel> {
        let txn = ctx.transaction();
        let now = now();
        let model = page_edit_lock::ActiveModel {
            created_at: Set(now),
            updated_at: Set(None),
            expires_at: Set(now + PAGE_EDIT_LOCK_DURATION),
            lock_secret: Set(new_lock_secret()),
            mode: Set(mode),
            section_index: Set(section_index),
            base_revision_id: Set(base_revision_id),
            page_id: Set(page_id),
            user_id: Set(user_id),
            ..Default::default()
        };

        model.insert(txn).await.or_raise(|| {
            Error::new(
                format!("failed to insert page edit lock for page ID {page_id}"),
                ErrorType::Page,
            )
        })
    }

    async fn extend_row(
        ctx: &ServiceContext<'_>,
        row: &PageEditLockModel,
    ) -> Result<PageEditLockModel> {
        let txn = ctx.transaction();
        let now = now();
        let model = page_edit_lock::ActiveModel {
            page_edit_lock_id: Set(row.page_edit_lock_id),
            updated_at: Set(Some(now)),
            expires_at: Set(now + PAGE_EDIT_LOCK_DURATION),
            ..Default::default()
        };

        model.update(txn).await.or_raise(|| {
            Error::new(
                format!(
                    "failed to extend page edit lock ID {}",
                    row.page_edit_lock_id,
                ),
                ErrorType::Page,
            )
        })
    }
}

fn check_mode_section(mode: PageEditLockMode, section_index: Option<i32>) -> Result<()> {
    if (mode == PageEditLockMode::Section) != section_index.is_some() {
        bail!(Error::new(
            "section_index must be present exactly for section edit locks",
            ErrorType::BadRequest,
        ));
    }

    if let Some(section_index) = section_index
        && section_index < 0
    {
        bail!(Error::new(
            "section_index cannot be negative",
            ErrorType::BadRequest,
        ));
    }

    Ok(())
}

fn new_lock_secret() -> String {
    let mut rng = rand::rng();
    assert_is_csprng(&rng);
    Alphanumeric.sample_string(&mut rng, LOCK_SECRET_LENGTH)
}

pub(crate) fn is_live(row: &PageEditLockModel, now: OffsetDateTime) -> bool {
    row.expires_at > now
}

pub(crate) fn modes_conflict(
    a_mode: PageEditLockMode,
    a_section: Option<i32>,
    b_mode: PageEditLockMode,
    b_section: Option<i32>,
) -> bool {
    use PageEditLockMode::{Append, Page, Section};

    match (a_mode, b_mode) {
        (Page, _) | (_, Page) => true,
        (Append, Append) => true,
        (Append, Section) | (Section, Append) => false,
        (Section, Section) => a_section == b_section,
    }
}

fn heading_level(line: &str) -> Option<usize> {
    let pluses = line.bytes().take_while(|byte| *byte == b'+').count();
    if pluses == 0 || pluses > 6 {
        return None;
    }

    let rest = &line[pluses..];
    let rest = rest.strip_prefix('*').unwrap_or(rest);
    if rest.is_empty() || rest.starts_with(' ') {
        Some(pluses)
    } else {
        None
    }
}

fn section_span(
    wikitext: &str,
    section_index: i32,
) -> Option<(Vec<String>, usize, usize, bool)> {
    if section_index < 0 {
        return None;
    }

    let trailing_newline = wikitext.ends_with('\n');
    let lines: Vec<String> = wikitext.lines().map(str::to_owned).collect();
    let headings: Vec<(usize, usize)> = lines
        .iter()
        .enumerate()
        .filter_map(|(line_index, line)| {
            heading_level(line).map(|level| (line_index, level))
        })
        .collect();

    let &(start, level) = headings.get(usize::try_from(section_index).ok()?)?;
    let end = headings
        .iter()
        .skip(usize::try_from(section_index).ok()? + 1)
        .find(|&&(_, other_level)| other_level <= level)
        .map(|&(line_index, _)| line_index)
        .unwrap_or(lines.len());

    Some((lines, start, end, trailing_newline))
}

pub(crate) fn extract_section(wikitext: &str, section_index: i32) -> Option<String> {
    let (lines, start, end, _) = section_span(wikitext, section_index)?;
    Some(lines[start..end].join("\n"))
}

pub(crate) fn splice_section(
    wikitext: &str,
    section_index: i32,
    replacement: &str,
) -> Option<String> {
    let (lines, start, end, trailing_newline) = section_span(wikitext, section_index)?;
    let mut out: Vec<&str> = Vec::new();
    out.extend(lines[..start].iter().map(String::as_str));
    out.extend(replacement.lines());
    out.extend(lines[end..].iter().map(String::as_str));
    let mut text = out.join("\n");
    if trailing_newline && !text.is_empty() {
        text.push('\n');
    }

    Some(text)
}

pub(crate) fn append_wikitext(wikitext: &str, addition: &str) -> String {
    if addition.is_empty() {
        return wikitext.to_owned();
    }
    if wikitext.is_empty() {
        return addition.to_owned();
    }
    if wikitext.ends_with('\n') {
        format!("{wikitext}{addition}")
    } else {
        format!("{wikitext}\n{addition}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conflict_matrix_matches_probes() {
        use PageEditLockMode::{Append, Page, Section};

        assert!(modes_conflict(Page, None, Page, None));
        assert!(modes_conflict(Page, None, Append, None));
        assert!(modes_conflict(Page, None, Section, Some(0)));
        assert!(modes_conflict(Append, None, Append, None));
        assert!(!modes_conflict(Append, None, Section, Some(0)));
        assert!(!modes_conflict(Section, Some(0), Section, Some(1)));
        assert!(modes_conflict(Section, Some(0), Section, Some(0)));
        assert!(modes_conflict(Section, Some(2), Page, None));
    }

    #[test]
    fn section_extraction_uses_heading_spans() {
        let text = "preamble\n+ One\nalpha\n++ Sub\nbeta\n+ Two\ngamma\n";
        assert_eq!(
            extract_section(text, 0).as_deref(),
            Some("+ One\nalpha\n++ Sub\nbeta"),
        );
        assert_eq!(extract_section(text, 1).as_deref(), Some("++ Sub\nbeta"),);
        assert_eq!(extract_section(text, 2).as_deref(), Some("+ Two\ngamma"));
        assert_eq!(extract_section(text, 3), None);
        assert_eq!(extract_section(text, -1), None);
    }

    #[test]
    fn section_splice_keeps_surroundings() {
        let text = "preamble\n+ One\nalpha\n+ Two\ngamma\n";
        assert_eq!(
            splice_section(text, 0, "+ One\nALPHA").as_deref(),
            Some("preamble\n+ One\nALPHA\n+ Two\ngamma\n"),
        );
        assert_eq!(
            splice_section(text, 1, "+ Two\ngamma\ndelta").as_deref(),
            Some("preamble\n+ One\nalpha\n+ Two\ngamma\ndelta\n"),
        );
        assert_eq!(splice_section(text, 5, "x"), None);
    }

    #[test]
    fn append_joins_on_a_line_boundary() {
        assert_eq!(append_wikitext("a\n", "b"), "a\nb");
        assert_eq!(append_wikitext("a", "b"), "a\nb");
        assert_eq!(append_wikitext("", "b"), "b");
        assert_eq!(append_wikitext("a", ""), "a");
    }
}
