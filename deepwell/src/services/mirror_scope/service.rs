/*
 * services/mirror_scope/service.rs
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

use super::{
    MirrorScope, ReconcileFileItemResult, ReconcileItemResult, ReconcileMirrorFiles,
    ReconcileMirrorFilesOutput, ReconcileMirrorOutput, ReconcileMirrorPages,
    SetMirrorScope, SourceFileExpectation,
};
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::mirror_scope::{self, Entity as MirrorScopeTable};
use crate::services::ServiceContext;
use crate::services::file::{DeleteFile, FileService};
use crate::services::file_revision::FileRevisionService;
use crate::services::page::{DeletePage, MovePage, PageService};
use crate::services::site::SiteService;
use crate::types::{FileOrder, Reference};
use crate::utils::{normalize_page_slug, now};
use sea_orm::{ActiveModelTrait, EntityTrait, Set};
use std::collections::{BTreeSet, HashMap};

pub const MIRROR_SCOPE_FULL: &str = "full";
pub const MIRROR_SCOPE_PARTIAL: &str = "partial";

#[derive(Debug)]
pub struct MirrorScopeService;

impl MirrorScopeService {
    pub async fn get(
        ctx: &ServiceContext<'_>,
        site_id: i64,
    ) -> Result<Option<MirrorScope>> {
        let row = MirrorScopeTable::find_by_id(site_id)
            .one(ctx.transaction())
            .await
            .or_raise(Self::make_error)?;

        Ok(row.map(Self::to_output))
    }

    pub async fn set(
        ctx: &ServiceContext<'_>,
        input: SetMirrorScope,
    ) -> Result<MirrorScope> {
        Self::validate_scope(&input.scope)?;
        Self::validate_count(input.inventoried_source_count)?;
        if let Some(pin) = input.source_pin.as_deref() {
            Self::validate_pin(pin)?;
        }

        SiteService::get(ctx, Reference::Id(input.site_id))
            .await
            .or_raise(Self::make_error)?;

        let declared_extras = Self::normalize_slugs(input.declared_extras);
        let consumed_slugs = Self::normalize_slugs(input.consumed_slugs);

        let existing = MirrorScopeTable::find_by_id(input.site_id)
            .one(ctx.transaction())
            .await
            .or_raise(Self::make_error)?;

        let row = match existing {
            Some(existing) => {
                let mut model: mirror_scope::ActiveModel = existing.into();
                model.scope = Set(input.scope);
                model.source_pin = Set(input.source_pin);
                model.inventoried_source_count = Set(input.inventoried_source_count);
                model.declared_extras = Set(declared_extras);
                model.consumed_slugs = Set(consumed_slugs);
                model.updated_at = Set(now());
                model
                    .update(ctx.transaction())
                    .await
                    .or_raise(Self::make_error)?
            }
            None => mirror_scope::ActiveModel {
                site_id: Set(input.site_id),
                scope: Set(input.scope),
                source_pin: Set(input.source_pin),
                inventoried_source_count: Set(input.inventoried_source_count),
                declared_extras: Set(declared_extras),
                consumed_slugs: Set(consumed_slugs),
                ..Default::default()
            }
            .insert(ctx.transaction())
            .await
            .or_raise(Self::make_error)?,
        };

        Ok(Self::to_output(row))
    }

    pub async fn record_consumed_slug(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        slug: &str,
    ) -> Result<bool> {
        let slug = normalize_page_slug(slug);
        if slug.is_empty() {
            return Err(Error::new(
                "consumed slug normalizes to an empty slug",
                ErrorType::BadRequest,
            )
            .into());
        }

        let mut existing = MirrorScopeTable::find_by_id(site_id)
            .one(ctx.transaction())
            .await
            .or_raise(Self::make_error)?
            .ok_or_else(|| {
                Error::new(
                    "mirror scope record does not exist for consumed slug",
                    ErrorType::Site,
                )
            })?;

        if existing.consumed_slugs.iter().any(|known| known == &slug) {
            return Ok(false);
        }

        let mut consumed: BTreeSet<String> = std::mem::take(&mut existing.consumed_slugs)
            .into_iter()
            .collect();
        consumed.insert(slug);

        let mut model: mirror_scope::ActiveModel = existing.into();
        model.consumed_slugs = Set(consumed.into_iter().collect());
        model.updated_at = Set(now());
        model
            .update(ctx.transaction())
            .await
            .or_raise(Self::make_error)?;

        Ok(true)
    }

    pub async fn is_consumed(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        slug: &str,
    ) -> Result<bool> {
        let slug = normalize_page_slug(slug);
        let row = MirrorScopeTable::find_by_id(site_id)
            .one(ctx.transaction())
            .await
            .or_raise(Self::make_error)?;

        Ok(row
            .map(|row| row.consumed_slugs.iter().any(|known| known == &slug))
            .unwrap_or(false))
    }

    fn require_scope_record(exists: bool) -> Result<()> {
        if exists {
            return Ok(());
        }
        Err(Error::new(
            "mirror scope record does not exist; set the site scope before reconciling",
            ErrorType::Site,
        )
        .into())
    }

    pub async fn reconcile_files(
        ctx: &ServiceContext<'_>,
        actor_user_id: i64,
        input: ReconcileMirrorFiles<'_>,
    ) -> Result<ReconcileMirrorFilesOutput> {
        let scope_exists = MirrorScopeTable::find_by_id(input.site_id)
            .one(ctx.transaction())
            .await
            .or_raise(Self::make_error)?
            .is_some();
        Self::require_scope_record(scope_exists)?;

        let page = PageService::get(ctx, input.site_id, input.page.borrow())
            .await
            .or_raise(Self::make_error)?;
        let page_id = page.page_id;

        let expected: HashMap<&str, &SourceFileExpectation> = input
            .files
            .iter()
            .map(|file| (file.name.as_str(), file))
            .collect();
        let mut seen = BTreeSet::new();
        let mut items = Vec::new();
        let mut tombstoned = 0;
        let mut kept = 0;
        let mut changed = Vec::new();

        for row in FileService::get_all(
            ctx,
            input.site_id,
            page_id,
            Some(false),
            FileOrder::default(),
        )
        .await
        .or_raise(Self::make_error)?
        {
            seen.insert(row.name.clone());
            match expected.get(row.name.as_str()) {
                None => {
                    let latest = FileRevisionService::get_latest(
                        ctx,
                        input.site_id,
                        page_id,
                        row.file_id,
                    )
                    .await
                    .or_raise(Self::make_error)?;
                    match FileService::delete(
                        ctx,
                        DeleteFile {
                            last_revision_id: latest.revision_id,
                            revision_comments: format!(
                                "source file '{}' absent from inventory; reconciled",
                                row.name,
                            ),
                            site_id: input.site_id,
                            page_id,
                            file: Reference::Id(row.file_id),
                            user_id: actor_user_id,
                        },
                    )
                    .await
                    {
                        Ok(output) => {
                            tombstoned += 1;
                            items.push(ReconcileFileItemResult {
                                name: row.name,
                                op: String::from("tombstone"),
                                ok: true,
                                revision_number: Some(output.file_revision_number),
                                error: None,
                            });
                        }
                        Err(error) => items.push(ReconcileFileItemResult {
                            name: row.name,
                            op: String::from("tombstone"),
                            ok: false,
                            revision_number: None,
                            error: Some(error.to_string()),
                        }),
                    }
                }
                Some(expectation) => {
                    let latest = FileRevisionService::get_latest(
                        ctx,
                        input.site_id,
                        page_id,
                        row.file_id,
                    )
                    .await
                    .or_raise(Self::make_error)?;
                    if Self::bytes_differ(expectation, &latest.s3_hash, latest.size) {
                        changed.push(row.name.clone());
                        items.push(ReconcileFileItemResult {
                            name: row.name,
                            op: String::from("report-changed"),
                            ok: true,
                            revision_number: None,
                            error: None,
                        });
                    } else {
                        kept += 1;
                        items.push(ReconcileFileItemResult {
                            name: row.name,
                            op: String::from("keep"),
                            ok: true,
                            revision_number: None,
                            error: None,
                        });
                    }
                }
            }
        }

        let mut missing: Vec<String> = expected
            .keys()
            .filter(|name| !seen.contains(**name))
            .map(|name| (*name).to_string())
            .collect();
        missing.sort();

        let failed = items.iter().filter(|item| !item.ok).count();
        Ok(ReconcileMirrorFilesOutput {
            site_id: input.site_id,
            page_id,
            tombstoned,
            kept,
            changed,
            missing,
            failed,
            items,
        })
    }

    fn hash_evidence(expected_hex: &str, s3_hash: &[u8]) -> Option<bool> {
        let expected = hex::decode(expected_hex.trim()).ok()?;
        if expected.len() != s3_hash.len() {
            return None;
        }
        Some(expected != s3_hash)
    }

    fn bytes_differ(
        expectation: &SourceFileExpectation,
        s3_hash: &[u8],
        size: i64,
    ) -> bool {
        if let Some(expected_size) = expectation.size
            && expected_size != size
        {
            return true;
        }
        match &expectation.s3_hash_hex {
            Some(expected_hex) => {
                Self::hash_evidence(expected_hex, s3_hash) == Some(true)
            }
            None => false,
        }
    }

    fn to_output(row: mirror_scope::Model) -> MirrorScope {
        MirrorScope {
            site_id: row.site_id,
            scope: row.scope,
            source_pin: row.source_pin,
            inventoried_source_count: row.inventoried_source_count,
            declared_extras: row.declared_extras,
            consumed_slugs: row.consumed_slugs,
        }
    }

    fn normalize_slugs(slugs: Vec<String>) -> Vec<String> {
        slugs
            .into_iter()
            .map(normalize_page_slug)
            .filter(|slug| !slug.is_empty())
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    pub async fn reconcile(
        ctx: &ServiceContext<'_>,
        actor_user_id: i64,
        input: ReconcileMirrorPages<'_>,
    ) -> Result<ReconcileMirrorOutput> {
        MirrorScopeTable::find_by_id(input.site_id)
            .one(ctx.transaction())
            .await
            .or_raise(Self::make_error)?
            .ok_or_else(|| {
                Error::new(
                    "mirror scope record does not exist; set the site scope before reconciling",
                    ErrorType::Site,
                )
            })?;

        let mut items = Vec::new();
        let mut applied_deletes = 0;
        let mut applied_renames = 0;

        for delete in input.deletes {
            let slug = Self::reference_label(&delete.page);
            match PageService::delete(
                ctx,
                DeletePage {
                    site_id: input.site_id,
                    page: delete.page,
                    last_revision_id: delete.last_revision_id,
                    user_id: actor_user_id,
                    revision_comments: delete.revision_comments,
                    ip_address: input.ip_address,
                },
            )
            .await
            {
                Ok(output) => {
                    applied_deletes += 1;
                    items.push(ReconcileItemResult {
                        slug,
                        op: String::from("delete"),
                        ok: true,
                        revision_number: Some(output.revision_number),
                        error: None,
                    });
                }
                Err(error) => items.push(ReconcileItemResult {
                    slug,
                    op: String::from("delete"),
                    ok: false,
                    revision_number: None,
                    error: Some(error.to_string()),
                }),
            }
        }

        for rename in input.renames {
            let slug = Self::reference_label(&rename.page);
            match PageService::r#move(
                ctx,
                MovePage {
                    site_id: input.site_id,
                    page: rename.page,
                    last_revision_id: rename.last_revision_id,
                    new_slug: rename.new_slug,
                    revision_comments: rename.revision_comments,
                    user_id: actor_user_id,
                    ip_address: input.ip_address,
                },
            )
            .await
            {
                Ok(output) => {
                    Self::record_consumed_slug(ctx, input.site_id, &output.old_slug)
                        .await?;
                    applied_renames += 1;
                    items.push(ReconcileItemResult {
                        slug,
                        op: String::from("rename"),
                        ok: true,
                        revision_number: Some(output.revision_number),
                        error: None,
                    });
                }
                Err(error) => items.push(ReconcileItemResult {
                    slug,
                    op: String::from("rename"),
                    ok: false,
                    revision_number: None,
                    error: Some(error.to_string()),
                }),
            }
        }

        let failed = items.iter().filter(|item| !item.ok).count();
        Ok(ReconcileMirrorOutput {
            site_id: input.site_id,
            applied_deletes,
            applied_renames,
            failed,
            items,
        })
    }

    fn reference_label(reference: &Reference<'_>) -> String {
        match reference {
            Reference::Id(id) => id.to_string(),
            Reference::Slug(slug) => slug.to_string(),
        }
    }

    fn validate_scope(scope: &str) -> Result<()> {
        if scope != MIRROR_SCOPE_FULL && scope != MIRROR_SCOPE_PARTIAL {
            return Err(Error::new(
                "mirror scope must be 'full' or 'partial'",
                ErrorType::BadRequest,
            )
            .into());
        }
        Ok(())
    }

    fn validate_count(count: i64) -> Result<()> {
        if count < 0 {
            return Err(Error::new(
                "inventoried source count cannot be negative",
                ErrorType::BadRequest,
            )
            .into());
        }
        Ok(())
    }

    fn validate_pin(pin: &str) -> Result<()> {
        let valid = !pin.trim().is_empty() && pin.chars().all(|c| !c.is_control());
        if !valid {
            return Err(Error::new(
                "mirror source pin must be a non-blank token",
                ErrorType::BadRequest,
            )
            .into());
        }
        Ok(())
    }

    fn make_error() -> Error {
        Error::new("failed to access mirror scope", ErrorType::Site)
    }
}

#[cfg(test)]
mod tests {
    use super::MirrorScopeService;

    #[test]
    fn mirror_scope_values_accept_full_and_partial() {
        MirrorScopeService::validate_scope("full").expect("full scope");
        MirrorScopeService::validate_scope("partial").expect("partial scope");
        assert!(MirrorScopeService::validate_scope("").is_err());
        assert!(MirrorScopeService::validate_scope("Full").is_err());
        assert!(MirrorScopeService::validate_scope("complete").is_err());
    }

    #[test]
    fn mirror_scope_slug_sets_converge() {
        assert_eq!(
            MirrorScopeService::normalize_slugs(vec![
                "SCP-9506".into(),
                "scp-9506".into(),
                "  Nav:Top  ".into(),
                "".into(),
            ]),
            vec!["nav:top".to_string(), "scp-9506".to_string()],
        );
    }

    #[test]
    fn undecodable_hash_is_not_evidence() {
        use super::SourceFileExpectation;

        assert_eq!(MirrorScopeService::hash_evidence("zz", &[1, 2]), None);
        assert_eq!(MirrorScopeService::hash_evidence("010", &[1, 2]), None);
        assert_eq!(MirrorScopeService::hash_evidence("0102", &[1]), None);
        assert_eq!(
            MirrorScopeService::hash_evidence("0102", &[1, 2]),
            Some(false),
        );
        assert_eq!(
            MirrorScopeService::hash_evidence(" 0103 ", &[1, 2]),
            Some(true),
        );

        let undecodable = SourceFileExpectation {
            name: String::from("file.txt"),
            s3_hash_hex: Some(String::from("zz")),
            size: Some(2),
        };
        assert!(!MirrorScopeService::bytes_differ(&undecodable, &[1, 2], 2));
        assert!(MirrorScopeService::bytes_differ(&undecodable, &[1, 2], 3));

        let differing = SourceFileExpectation {
            s3_hash_hex: Some(String::from("0103")),
            ..undecodable.clone()
        };
        assert!(MirrorScopeService::bytes_differ(&differing, &[1, 2], 2));
    }

    #[test]
    fn mirror_scope_counts_and_pins_are_checked() {
        assert!(MirrorScopeService::validate_count(0).is_ok());
        assert!(MirrorScopeService::validate_count(-1).is_err());
        assert!(MirrorScopeService::validate_pin("abc123").is_ok());
        assert!(MirrorScopeService::validate_pin("   ").is_err());
        assert!(MirrorScopeService::validate_pin("bad\npin").is_err());
    }
}
