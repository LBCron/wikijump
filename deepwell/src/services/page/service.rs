/*
 * services/page/service.rs
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
    CreatePage, CreatePageOutput, DeletePage, DeletePageOutput, EditPage, EditPageBody,
    EditPageOutput, MovePage, MovePageOutput, PageLifecycleIdentity, RestorePage,
    RestorePageOutput, RollbackPage, SetPageLayout,
};
use crate::error::prelude::{Error, ErrorType, ExnError, Result, ResultExt};
use crate::models::page::{self, Entity as Page, Model as PageModel};
use crate::models::page_category::Model as PageCategoryModel;
use crate::models::page_revision::Model as PageRevisionModel;
use crate::services::ServiceContext;
use crate::services::audit::{AuditEvent, AuditService, ObjectScope};
use crate::services::filter::{FilterClass, FilterType};
use crate::services::page_revision::{
    CreateFirstPageRevision, CreateFirstPageRevisionOutput, CreatePageRevision,
    CreatePageRevisionBody, CreatePageRevisionOutput, CreateResurrectionPageRevision,
    CreateTombstonePageRevision, GetPageRevision, RerenderType,
};
use crate::services::permission::{PermissionService, PermissionTarget};
use crate::services::{
    CategoryService, FilterService, PageRevisionService, TextBlockService, TextService,
};
use crate::types::Maybe;
use crate::types::{
    Action, PageId, PageOrder, PageRevisionType, Reference, RerenderDepth,
};
use crate::utils::now;
use crate::utils::{get_category_name, trim_default};
use exn::Frame;
use paste::paste;
use ref_map::OptionRefMap;
use sea_orm::ActiveValue;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait, DbErr, EntityTrait,
    FromQueryResult, IntoActiveModel, QueryFilter, QueryOrder, QuerySelect, Set, SqlErr,
    Statement, Value,
};
use sea_query::Expr;
use std::net::IpAddr;
use wikidot_normalize::normalize;

/// Largest accepted page source, in characters (Unicode scalar values).
///
/// Wikidot rejects page saves whose source is longer than this. The bound
/// was measured empirically on a Wikidot sandbox (2026-10-24, via the same
/// save path the editor uses): a source of 200,001 characters saves and
/// round-trips exactly, while 200,002 characters is rejected, for ASCII
/// and multibyte sources alike (so the unit is characters, not bytes).
/// Large real pages corroborate it: every sampled page over 190,000
/// characters on scp-wiki / scp-jp sits just below the bound (the largest
/// found was 199,898 characters).
pub const MAX_PAGE_SOURCE_LENGTH: usize = 200_001;

/// Reject a page source longer than Wikidot would accept.
fn check_page_source_length(wikitext: &str) -> Result<()> {
    let length = wikitext.chars().count();
    if length > MAX_PAGE_SOURCE_LENGTH {
        return Err(Error::new(
            format!(
                "page source is {length} characters, which exceeds the maximum of {MAX_PAGE_SOURCE_LENGTH} characters"
            ),
            ErrorType::Page,
        )
        .into());
    }
    Ok(())
}

#[derive(Debug)]
pub struct PageService;

/// SQL predicate fragment hiding foreign include-source snapshots from
/// site-page queries (issue #2690).
///
/// A snapshot page belongs to the site when its source names the site
/// itself or one of the corpus branches the site imports from; rows
/// without snapshots (locally created pages) always belong. Anything else
/// is cross-site include-source storage (for example `d3-readonly-assets`
/// pages held inside `scp-wiki` so that
/// `[[include :d3-readonly-assets:…]]` resolves) and must not be served as
/// a page of the holding site — though `fetch_imported_cross_site_source`
/// keeps resolving those rows by (`source_site`, `source_fullname`).
///
/// `page_id_ref` is the SQL reference to the outer page row (for example
/// `page.page_id`); `site_id` is inlined as a literal because it is always
/// a server-side integer, never caller input. A branch code only ever
/// matches its own corpus branch, so foreign import runs must keep using
/// dated one-off branch names (as the existing `d3-readonly-*` runs do)
/// rather than the bare source site name, or their pages would read as
/// own.
pub(in crate::services) fn foreign_snapshot_exclusion_sql(
    page_id_ref: &str,
    site_id: i64,
) -> String {
    format!(
        "NOT EXISTS (SELECT 1 FROM wikidot_page_snapshot snapshot \
         WHERE snapshot.page_id = {page_id_ref} \
         AND snapshot.source_site NOT IN (SELECT slug FROM \"site\" WHERE site_id = {site_id}) \
         AND snapshot.source_site NOT IN (SELECT DISTINCT source_branch FROM wikidot_corpus_import_run WHERE site_id = {site_id}))"
    )
}

impl PageService {
    /// Resolve display-name-only page lifecycle identities.
    ///
    /// Imported revisions use the authoritative names retained by the corpus
    /// snapshot. Native revisions use the current public display name of their
    /// revision actor. Each lifecycle endpoint follows its own provenance, so
    /// a locally edited imported page keeps its snapshot creator while naming
    /// the local updater.
    pub async fn get_lifecycle_identity(
        ctx: &ServiceContext<'_>,
        page: &PageModel,
    ) -> Result<PageLifecycleIdentity> {
        #[derive(FromQueryResult)]
        struct LifecycleIdentityRow {
            created_by: Option<String>,
            updated_by: Option<String>,
        }

        let make_error =
            || Error::new("failed to resolve page lifecycle identity", ErrorType::Page);
        let txn = ctx.transaction();
        let statement = Statement::from_sql_and_values(
            txn.get_database_backend(),
            r#"
SELECT
    CASE
        WHEN creator_revision.from_wikidot THEN
            NULLIF(BTRIM(snapshot.created_by_name), '')
        WHEN creator_user.user_id IS NOT NULL THEN
            CASE WHEN creator_user.deleted_at IS NULL
                 THEN NULLIF(BTRIM(creator_user.name), '')
                 ELSE NULL
            END
        WHEN creator_wikidot_user.user_id IS NOT NULL THEN
            CASE WHEN creator_wikidot_user.is_deleted = FALSE
                 THEN NULLIF(BTRIM(creator_wikidot_user.name), '')
                 ELSE NULL
            END
        ELSE NULL
    END AS created_by,
    CASE
        WHEN current_revision.from_wikidot THEN
            NULLIF(BTRIM(snapshot.updated_by_name), '')
        WHEN updater_user.user_id IS NOT NULL THEN
            CASE WHEN updater_user.deleted_at IS NULL
                 THEN NULLIF(BTRIM(updater_user.name), '')
                 ELSE NULL
            END
        WHEN updater_wikidot_user.user_id IS NOT NULL THEN
            CASE WHEN updater_wikidot_user.is_deleted = FALSE
                 THEN NULLIF(BTRIM(updater_wikidot_user.name), '')
                 ELSE NULL
            END
        ELSE NULL
    END AS updated_by
FROM page
LEFT JOIN LATERAL (
    SELECT revision.from_wikidot, revision.user_id
    FROM page_revision revision
    WHERE revision.site_id = page.site_id
      AND revision.page_id = page.page_id
    ORDER BY revision.revision_number ASC, revision.revision_id ASC
    LIMIT 1
) creator_revision ON TRUE
LEFT JOIN page_revision current_revision
  ON current_revision.revision_id = page.latest_revision_id
 AND current_revision.site_id = page.site_id
 AND current_revision.page_id = page.page_id
LEFT JOIN wikidot_page_snapshot snapshot ON snapshot.page_id = page.page_id
LEFT JOIN "user" creator_user
  ON creator_user.user_id = creator_revision.user_id
LEFT JOIN wikidot_user creator_wikidot_user
  ON creator_wikidot_user.user_id::bigint = creator_revision.user_id
LEFT JOIN "user" updater_user
  ON updater_user.user_id = current_revision.user_id
LEFT JOIN wikidot_user updater_wikidot_user
  ON updater_wikidot_user.user_id::bigint = current_revision.user_id
WHERE page.site_id = $1
  AND page.page_id = $2
  AND page.deleted_at IS NULL
"#,
            [Value::from(page.site_id), Value::from(page.page_id)],
        );

        let row = LifecycleIdentityRow::find_by_statement(statement)
            .one(txn)
            .await
            .or_raise(make_error)?;
        Ok(match row {
            Some(row) => PageLifecycleIdentity {
                created_by: row.created_by,
                updated_by: row.updated_by,
            },
            None => PageLifecycleIdentity {
                created_by: None,
                updated_by: None,
            },
        })
    }

    pub async fn create(
        ctx: &ServiceContext<'_>,
        CreatePage {
            site_id,
            wikitext,
            title,
            alt_title,
            tags,
            mut slug,
            layout,
            revision_comments: comments,
            user_id,
            bypass_filter,
            ip_address,
        }: CreatePage,
    ) -> Result<CreatePageOutput> {
        check_page_source_length(&wikitext)?;

        let txn = ctx.transaction();

        // Ensure slug is normalized
        normalize(&mut slug);

        let requested_slug = slug.clone();
        let make_error = || {
            Error::new(
                format!(
                    "failed to create page '{}' in site ID {}, performed by user ID {}",
                    requested_slug, site_id, user_id,
                ),
                ErrorType::Page,
            )
        };

        // Perform filter validation
        if !bypass_filter {
            Self::run_filter(
                ctx,
                site_id,
                None,
                Some(&wikitext),
                Some(&title),
                alt_title.as_ref(),
                ip_address,
            )
            .await
            .or_raise(make_error)?;
        }

        // Resolve category settings before choosing the final slug. The category
        // lock serializes conflict checks and page insertion for every create.
        let category_slug = str!(get_category_name(&slug));
        let category = CategoryService::get_or_create(ctx, site_id, &category_slug)
            .await
            .or_raise(make_error)?;
        let category = CategoryService::get_for_update(
            ctx,
            site_id,
            Reference::Id(category.category_id),
        )
        .await
        .or_raise(make_error)?;
        let category_id = category.category_id;
        if category.autonumber_enabled {
            slug = if category.slug == "_default" {
                category.autonumber_next.to_string()
            } else {
                format!("{}:{}", category.slug, category.autonumber_next)
            };
            Self::check_conflicts(ctx, site_id, &slug, "create")
                .await
                .or_raise(make_error)?;
            let next = category.autonumber_next.checked_add(1).ok_or_else(|| {
                Error::new("page autonumber allocator exhausted", ErrorType::Page)
            })?;
            let mut category = category.into_active_model();
            category.autonumber_next = Set(next);
            category.update(txn).await.or_raise(make_error)?;
        } else {
            Self::check_conflicts(ctx, site_id, &slug, "create")
                .await
                .or_raise(make_error)?;
        }

        // Insert page
        let model = page::ActiveModel {
            site_id: Set(site_id),
            page_category_id: Set(category_id),
            slug: Set(slug.clone()),
            ..Default::default()
        };
        let PageModel { page_id, .. } = model.insert(txn).await.or_raise(make_error)?;
        // Commit first revision
        let revision_input = CreateFirstPageRevision {
            user_id,
            comments,
            wikitext,
            title,
            alt_title,
            tags,
            slug: slug.clone(),
            layout,
        };

        let CreateFirstPageRevisionOutput {
            revision_id,
            parser_errors,
            followups,
        } = PageRevisionService::create_first(
            ctx,
            PageId {
                site_id,
                category_id,
                page_id,
            },
            revision_input,
        )
        .await
        .or_raise(make_error)?;

        // Update latest revision
        let model = page::ActiveModel {
            page_id: Set(page_id),
            latest_revision_id: Set(Some(revision_id)),
            ..Default::default()
        };
        let page = model.update(txn).await.or_raise(make_error)?;
        assert_latest_revision(&page);
        PageRevisionService::apply_first_followups(
            ctx,
            PageId {
                site_id,
                category_id,
                page_id,
            },
            followups,
        )
        .await
        .or_raise(make_error)?;

        // Audit log
        AuditService::log(
            ctx,
            ip_address,
            AuditEvent::PageCreate {
                site_id,
                page_id,
                user_id,
                revision_id,
                category_id,
            },
        )
        .await
        .or_raise(make_error)?;

        // Build and return
        Ok(CreatePageOutput {
            site_id,
            page_id,
            slug,
            revision_id,
            parser_errors,
        })
    }

    pub async fn edit(
        ctx: &ServiceContext<'_>,
        EditPage {
            site_id,
            page: reference,
            last_revision_id,
            revision_comments: comments,
            user_id,
            body:
                EditPageBody {
                    wikitext,
                    title,
                    alt_title,
                    tags,
                },
            ip_address,
        }: EditPage<'_>,
    ) -> Result<Option<EditPageOutput>> {
        if let Some(wikitext) = wikitext.to_option() {
            check_page_source_length(wikitext)?;
        }

        let txn = ctx.transaction();

        let PageModel {
            page_id,
            page_category_id: category_id,
            latest_revision_id,
            slug,
            ..
        } = Self::get(ctx, site_id, reference)
            .await
            .or_raise(|| Error::new("failed to edit page", ErrorType::Page))?;

        let id = PageId {
            site_id,
            category_id,
            page_id,
        };

        let make_error = || {
            Error::new(
                format!(
                    "failed to edit page '{}' (ID {}) in site ID {}, performed by user ID {}",
                    slug, page_id, site_id, user_id,
                ),
                ErrorType::Page,
            )
        };

        // Perform filter validation
        Self::run_filter(
            ctx,
            site_id,
            Some(page_id),
            wikitext.to_option(),
            title.to_option(),
            // Flatten what is essentially Option<Option<_>>
            match alt_title {
                Maybe::Set(Some(ref alt_title)) => Some(alt_title),
                _ => None,
            },
            ip_address,
        )
        .await
        .or_raise(make_error)?;

        // Get and check latest revision
        let last_revision = PageRevisionService::get_latest(ctx, site_id, page_id)
            .await
            .or_raise(make_error)?;

        check_last_revision(Some(&last_revision), latest_revision_id, last_revision_id)
            .or_raise(make_error)?;

        // Create new revision
        //
        // A response of None means no revision was created
        // because none of the data actually changed.

        let revision_input = CreatePageRevision {
            user_id,
            comments,
            revision_type: PageRevisionType::Regular,
            body: CreatePageRevisionBody {
                wikitext,
                title,
                alt_title,
                tags,
                ..Default::default()
            },
        };

        let persisted_revision =
            PageRevisionService::create(ctx, id, revision_input, last_revision)
                .await
                .map_err(|error| {
                    raise_if_revision_insert_conflict(error, last_revision_id)
                })
                .or_raise(make_error)?;

        let revision_id =
            persisted_revision.ref_map(|revision| revision.output.revision_id);

        // Set page updated_at and latest_revision_id columns.
        //
        // Previously this was conditional on whether a revision was actually created.
        // But since this rerenders regardless, we need to update the page row.
        let model = page::ActiveModel {
            page_id: Set(page_id),
            latest_revision_id: match revision_id {
                Some(revision_id) => ActiveValue::Set(Some(revision_id)),
                None => ActiveValue::NotSet,
            },
            updated_at: Set(Some(now())),
            ..Default::default()
        };

        let page = model.update(txn).await.or_raise(make_error)?;
        assert_latest_revision(&page);

        let revision_output = match persisted_revision {
            Some(revision) => Some(
                PageRevisionService::apply_followups(ctx, id, revision)
                    .await
                    .or_raise(make_error)?,
            ),
            None => None,
        };

        // Audit log
        AuditService::log(
            ctx,
            ip_address,
            AuditEvent::PageEdit {
                site_id,
                page_id,
                user_id,
                revision_id,
            },
        )
        .await
        .or_raise(make_error)?;

        // Build and return
        Ok(revision_output)
    }

    /// Record the evidenced Wikidot metadata revision created when a parent
    /// relationship is newly assigned through the legacy parent-set action.
    pub(crate) async fn record_parent_metadata_revision(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        child_reference: Reference<'_>,
        parent_reference: Reference<'_>,
        user_id: i64,
    ) -> Result<CreatePageRevisionOutput> {
        let txn = ctx.transaction();
        let make_error = || {
            Error::new(
                "failed to record parent metadata revision",
                ErrorType::PageRevision,
            )
        };

        let child = Self::get(ctx, site_id, child_reference)
            .await
            .or_raise(make_error)?;
        let parent = Self::get(ctx, site_id, parent_reference)
            .await
            .or_raise(make_error)?;
        let id = PageId::from_page_model(&child);
        let last_revision = PageRevisionService::get_latest(ctx, site_id, child.page_id)
            .await
            .or_raise(make_error)?;
        let persisted_revision = PageRevisionService::create(
            ctx,
            id,
            CreatePageRevision {
                user_id,
                comments: format!("Parent page set to: \"{}\".", parent.slug),
                revision_type: PageRevisionType::Regular,
                body: CreatePageRevisionBody {
                    parent_changed: true,
                    ..Default::default()
                },
            },
            last_revision,
        )
        .await
        .or_raise(make_error)?;
        let Some(persisted_revision) = persisted_revision else {
            bail!(Error::new(
                "parent metadata revision unexpectedly had no changes",
                ErrorType::PageRevision,
            ));
        };

        let revision_id = persisted_revision.output.revision_id;
        let model = page::ActiveModel {
            page_id: Set(child.page_id),
            latest_revision_id: Set(Some(revision_id)),
            updated_at: Set(Some(now())),
            ..Default::default()
        };
        let page = model.update(txn).await.or_raise(make_error)?;
        assert_latest_revision(&page);

        PageRevisionService::apply_followups(ctx, id, persisted_revision)
            .await
            .or_raise(make_error)
    }

    /// Moves a page from from one slug to another.
    pub async fn r#move(
        ctx: &ServiceContext<'_>,
        MovePage {
            site_id,
            page: reference,
            mut new_slug,
            last_revision_id,
            revision_comments: comments,
            user_id,
            ip_address,
        }: MovePage<'_>,
    ) -> Result<MovePageOutput> {
        let txn = ctx.transaction();
        normalize(&mut new_slug);

        let PageModel {
            page_id,
            slug: old_slug,
            latest_revision_id,
            ..
        } = Self::get(ctx, site_id, reference)
            .await
            .or_raise(|| Error::new("failed to move page", ErrorType::Page))?;

        let make_error = || {
            Error::new(
                format!(
                    "failed to move page '{}' to '{}' (ID {}) in site ID {}, performed by user ID {}",
                    old_slug, new_slug, page_id, site_id, user_id,
                ),
                ErrorType::Page,
            )
        };

        // Check last revision ID argument
        check_last_revision(None, latest_revision_id, last_revision_id)
            .or_raise(make_error)?;

        // Check that a move is actually taking place,
        // and that a page with that slug doesn't already exist.
        if old_slug == new_slug {
            bail!(Error::new(
                format!(
                    "cannot move page, source and destination slugs are the same: '{}'",
                    old_slug
                ),
                ErrorType::PageSlugExists
            ));
        }

        Self::check_conflicts(ctx, site_id, &new_slug, "move")
            .await
            .or_raise(make_error)?;

        // Create category if not already present
        let PageCategoryModel { category_id, .. } =
            CategoryService::get_or_create(ctx, site_id, get_category_name(&new_slug))
                .await
                .or_raise(make_error)?;
        let id = PageId {
            site_id,
            category_id,
            page_id,
        };

        // Get latest revision
        let last_revision = PageRevisionService::get_latest(ctx, site_id, page_id)
            .await
            .or_raise(make_error)?;

        // The move revision must render against the destination page identity. Keep
        // the existing latest revision in place until the new revision is persisted;
        // the surrounding transaction rolls this identity change back on failure.
        let model = page::ActiveModel {
            page_id: Set(page_id),
            slug: Set(new_slug.clone()),
            page_category_id: Set(category_id),
            ..Default::default()
        };
        model.update(txn).await.or_raise(make_error)?;

        // Create revision for move
        let revision_input = CreatePageRevision {
            user_id,
            comments,
            revision_type: PageRevisionType::Move,
            body: CreatePageRevisionBody {
                slug: Maybe::Set(new_slug.clone()),
                ..Default::default()
            },
        };

        let persisted_revision =
            PageRevisionService::create(ctx, id, revision_input, last_revision)
                .await
                .map_err(|error| {
                    raise_if_revision_insert_conflict(error, last_revision_id)
                })
                .or_raise(make_error)?;

        let latest_revision_id = match persisted_revision {
            Some(ref revision) => ActiveValue::Set(Some(revision.output.revision_id)),
            None => ActiveValue::NotSet,
        };

        // Finish updating the page after the move revision has been persisted.
        let model = page::ActiveModel {
            page_id: Set(page_id),
            latest_revision_id,
            updated_at: Set(Some(now())),
            ..Default::default()
        };

        let page = model.update(txn).await.or_raise(make_error)?;
        assert_latest_revision(&page);

        let revision_output = match persisted_revision {
            Some(revision) => Some(
                PageRevisionService::apply_followups(ctx, id, revision)
                    .await
                    .or_raise(make_error)?,
            ),
            None => None,
        };

        // Build and return
        match revision_output {
            Some(CreatePageRevisionOutput {
                revision_id,
                revision_number,
                parser_errors,
            }) => {
                // Audit log
                // Only in this path since the other is an error
                AuditService::log(
                    ctx,
                    ip_address,
                    AuditEvent::PageMove {
                        site_id,
                        page_id,
                        user_id,
                        revision_id,
                        old_slug: &old_slug,
                        new_slug: &new_slug,
                    },
                )
                .await
                .or_raise(make_error)?;

                Ok(MovePageOutput {
                    old_slug,
                    new_slug,
                    revision_id,
                    revision_number,
                    parser_errors,
                })
            }
            None => {
                error!("Page move did not create new revision");
                bail!(Error::new(
                    "page move did not create a new revision",
                    ErrorType::BadRequest
                ));
            }
        }
    }

    pub async fn delete(
        ctx: &ServiceContext<'_>,
        DeletePage {
            site_id,
            page: reference,
            last_revision_id,
            user_id,
            revision_comments: comments,
            ip_address,
        }: DeletePage<'_>,
    ) -> Result<DeletePageOutput> {
        let txn = ctx.transaction();

        let PageModel {
            page_id,
            latest_revision_id,
            slug,
            site_id,
            ..
        } = Self::get(ctx, site_id, reference)
            .await
            .or_raise(|| Error::new("failed to delete page", ErrorType::Page))?;

        let make_error = || {
            Error::new(
                format!(
                    "failed to delete page '{}' (ID {}) in site ID {}",
                    slug, page_id, site_id
                ),
                ErrorType::Page,
            )
        };

        // Get and check latest revision
        let last_revision = PageRevisionService::get_latest(ctx, site_id, page_id)
            .await
            .or_raise(make_error)?;

        check_last_revision(Some(&last_revision), latest_revision_id, last_revision_id)
            .or_raise(make_error)
            .or_raise(make_error)?;

        // Create tombstone revision
        // This also updates backlinks, includes, etc
        let output = PageRevisionService::create_tombstone(
            ctx,
            CreateTombstonePageRevision {
                site_id,
                page_id,
                user_id,
                comments,
            },
            last_revision,
        )
        .await
        .map_err(|error| raise_if_revision_insert_conflict(error, last_revision_id))
        .or_raise(make_error)?;

        // Set deletion flag
        let model = page::ActiveModel {
            page_id: Set(page_id),
            latest_revision_id: Set(Some(output.revision_id)),
            deleted_at: Set(Some(now())),
            ..Default::default()
        };
        let page = model.update(txn).await.or_raise(make_error)?;
        assert_latest_revision(&page);

        // Audit log
        AuditService::log(
            ctx,
            ip_address,
            AuditEvent::PageDelete {
                site_id,
                page_id,
                user_id,
                revision_id: output.revision_id,
                page_slug: &page.slug,
            },
        )
        .await
        .or_raise(make_error)?;

        // Finally, clear out any hosted text blocks.
        //
        // The rows are deleted within this transaction, and the
        // S3 objects are removed by a post-commit action once it
        // commits, so a rollback leaves both intact.
        TextBlockService::delete_blocks(ctx, page_id)
            .await
            .or_raise(make_error)?;

        // Return deletion information
        Ok((output, page_id).into())
    }

    /// Restore a deleted page, causing it to be undeleted.
    pub async fn restore(
        ctx: &ServiceContext<'_>,
        RestorePage {
            site_id,
            page_id,
            user_id,
            slug,
            revision_comments: comments,
            ip_address,
        }: RestorePage,
    ) -> Result<RestorePageOutput> {
        let txn = ctx.transaction();

        let page = Self::get_direct(ctx, page_id, true)
            .await
            .or_raise(|| Error::new("failed to restore page", ErrorType::Page))?;

        let slug = slug.unwrap_or(page.slug);

        let make_error = || {
            Error::new(
                format!(
                    "failed to restore page '{}' (ID {}) to site ID {}",
                    slug, page_id, site_id,
                ),
                ErrorType::Page,
            )
        };

        // Do page checks:
        // - Site is correct
        // - Page is deleted
        // - Slug doesn't already exist

        if page.site_id != site_id {
            warn!(
                "Page's site ID ({}) and passed site ID ({}) do not match",
                page.site_id, site_id,
            );
            bail!(Error::new(
                "cannot restore page to a different site",
                ErrorType::PageNotFound,
            ));
        }

        if page.deleted_at.is_none() {
            warn!("Page requested to be restored is not currently deleted");
            bail!(Error::new(
                "cannot restore a page that isn't deleted",
                ErrorType::PageNotDeleted,
            ));
        }

        Self::check_conflicts(ctx, site_id, &slug, "restore")
            .await
            .or_raise(make_error)?;

        // Create category if not already present
        let category =
            CategoryService::get_or_create(ctx, site_id, get_category_name(&slug))
                .await
                .or_raise(make_error)?;
        let id = PageId {
            site_id,
            category_id: category.category_id,
            page_id,
        };

        // Get latest revision
        let last_revision = PageRevisionService::get_latest(ctx, site_id, page_id)
            .await
            .or_raise(make_error)?;

        // Create resurrection revision
        // This also updates backlinks, includes, etc.
        let revision = PageRevisionService::create_resurrection(
            ctx,
            CreateResurrectionPageRevision {
                id,
                user_id,
                comments,
                new_slug: slug.clone(),
            },
            last_revision,
        )
        .await
        .or_raise(make_error)?;

        // Publish the restored identity and its resurrection revision together.
        let model = page::ActiveModel {
            page_id: Set(page_id),
            page_category_id: Set(category.category_id),
            latest_revision_id: Set(Some(revision.output.revision_id)),
            slug: Set(slug.clone()),
            deleted_at: Set(None),
            ..Default::default()
        };

        let page = model.update(txn).await.or_raise(make_error)?;
        assert_latest_revision(&page);

        // Resurrection rendering happens while the page is still deleted so
        // generic body queries do not observe a half-restored aggregate. Runtime
        // content that depends on the live latest revision needs one full pass
        // after both halves of the aggregate are published in this transaction.
        let output = PageRevisionService::apply_resurrection_followups(ctx, id, revision)
            .await
            .or_raise(make_error)?;

        // Preserve the established navigation-only followup after the restored
        // identity and latest revision are visible.
        PageRevisionService::rerender(
            ctx,
            id,
            RerenderDepth::default(),
            RerenderType::NavigationOnly,
        )
        .await
        .or_raise(make_error)?;

        // Audit log
        AuditService::log(
            ctx,
            ip_address,
            AuditEvent::PageUndelete {
                site_id,
                page_id,
                user_id,
                revision_id: output.revision_id,
                category_id: category.category_id,
                page_slug: &slug,
            },
        )
        .await
        .or_raise(make_error)?;

        Ok((output, slug).into())
    }

    /// Rolls back a page to be the same as it was in a previous revision.
    /// Also called "page reset".
    ///
    /// It changes the page to have the exact state it had in a previous
    /// revision, regardless of any changes since.
    ///
    /// This is equivalent to Wikidot's concept of a "revert".
    pub async fn rollback(
        ctx: &ServiceContext<'_>,
        RollbackPage {
            site_id,
            page: reference,
            last_revision_id,
            revision_number,
            revision_comments: comments,
            user_id,
            ip_address,
        }: RollbackPage<'_>,
    ) -> Result<Option<EditPageOutput>> {
        let txn = ctx.transaction();

        let PageModel {
            page_id,
            page_category_id: category_id,
            latest_revision_id,
            slug,
            ..
        } = Self::get(ctx, site_id, reference)
            .await
            .or_raise(|| Error::new("failed to roll back page", ErrorType::Page))?;

        let id = PageId {
            site_id,
            category_id,
            page_id,
        };

        let make_error = || {
            Error::new(
                format!(
                    "failed to roll back page '{}' (ID {}) on site ID {}, performed by user ID {}",
                    slug, page_id, site_id, user_id,
                ),
                ErrorType::Page,
            )
        };

        // Get target revision and latest revision
        let (target_revision, last_revision) = join!(
            PageRevisionService::get(
                ctx,
                GetPageRevision {
                    site_id,
                    page_id,
                    revision_number,
                },
            ),
            PageRevisionService::get_latest(ctx, site_id, page_id),
        );
        let (target_revision, last_revision) =
            raise_multiple!(target_revision, last_revision; make_error);

        // Check last revision ID
        check_last_revision(Some(&last_revision), latest_revision_id, last_revision_id)
            .or_raise(make_error)?;

        let PageRevisionModel {
            wikitext_hash,
            title,
            alt_title,
            tags,
            hidden,
            ..
        } = target_revision;

        let hide_wikitext = hidden.iter().any(|field| field == "wikitext");
        let hide_title = hidden.iter().any(|field| field == "title");
        let hide_alt_title = hidden.iter().any(|field| field == "alt_title");
        let hide_tags = hidden.iter().any(|field| field == "tags");

        // NOTE: we can't just copy the wikitext_hash because we
        //       need its actual value for rendering unless it has been hidden.
        //       This isn't run here, but in PageRevisionService::create().
        let wikitext = if hide_wikitext {
            Maybe::Unset
        } else {
            let text = TextService::get(ctx, &wikitext_hash)
                .await
                .or_raise(make_error)?;
            Maybe::Set(text)
        };

        // Create new revision
        //
        // Copy the body of the target revision

        let revision_input = CreatePageRevision {
            user_id,
            revision_type: PageRevisionType::Rollback,
            comments,
            body: CreatePageRevisionBody {
                wikitext,
                title: if hide_title {
                    Maybe::Unset
                } else {
                    Maybe::Set(title)
                },
                alt_title: if hide_alt_title {
                    Maybe::Unset
                } else {
                    Maybe::Set(alt_title)
                },
                tags: if hide_tags {
                    Maybe::Unset
                } else {
                    Maybe::Set(tags)
                },
                slug: Maybe::Unset, // rollbacks should never move a page
                parent_changed: false,
            },
        };

        let persisted_revision =
            PageRevisionService::create(ctx, id, revision_input, last_revision)
                .await
                .map_err(|error| {
                    raise_if_revision_insert_conflict(error, last_revision_id)
                })
                .or_raise(make_error)?;

        let latest_revision_id = match persisted_revision {
            Some(ref revision) => ActiveValue::Set(Some(revision.output.revision_id)),
            None => ActiveValue::NotSet,
        };

        // Set page updated_at column.
        let model = page::ActiveModel {
            page_id: Set(page_id),
            updated_at: Set(Some(now())),
            latest_revision_id,
            ..Default::default()
        };

        let page = model.update(txn).await.or_raise(make_error)?;
        assert_latest_revision(&page);

        let revision_output = match persisted_revision {
            Some(revision) => Some(
                PageRevisionService::apply_followups(ctx, id, revision)
                    .await
                    .or_raise(make_error)?,
            ),
            None => None,
        };

        // Audit log
        AuditService::log(
            ctx,
            ip_address,
            AuditEvent::PageRollback {
                site_id,
                page_id,
                user_id,
                revision_id: revision_output.ref_map(|output| output.revision_id),
                revision_number,
            },
        )
        .await
        .or_raise(make_error)?;

        // Build and return
        Ok(revision_output)
    }

    /// Sets the layout override for a page.
    pub async fn set_layout(
        ctx: &ServiceContext<'_>,
        SetPageLayout {
            site_id,
            page_id,
            layout,
            user_id,
            ip_address,
        }: SetPageLayout,
    ) -> Result<()> {
        debug!("Setting page layout for site ID {site_id} page ID {page_id}");

        let make_error = || {
            Error::new(
                format!(
                    "failed to set layout for page ID {} in site ID {}, performed by user ID {}",
                    page_id, site_id, user_id,
                ),
                ErrorType::Page,
            )
        };

        ctx.defer_public_content_cache_invalidate_site(site_id)
            .or_raise(make_error)?;

        // Update in database
        let txn = ctx.transaction();
        let model = page::ActiveModel {
            page_id: Set(page_id),
            layout: Set(layout.map(|l| str!(l.value()))),
            ..Default::default()
        };
        model.update(txn).await.or_raise(make_error)?;

        // Audit log
        AuditService::log(
            ctx,
            ip_address,
            AuditEvent::PageLayoutUpdate {
                user_id,
                site_id,
                page_id,
                layout,
            },
        )
        .await
        .or_raise(make_error)?;

        Ok(())
    }

    #[inline]
    pub async fn get(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        reference: Reference<'_>,
    ) -> Result<PageModel> {
        find_or_error!(Self::get_optional(ctx, site_id, reference), "page", Page)
    }

    pub async fn get_optional(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        reference: Reference<'_>,
    ) -> Result<Option<PageModel>> {
        Self::get_optional_impl(ctx, site_id, reference, true).await
    }

    /// Gets a page like [`Self::get_optional`], but without the foreign
    /// snapshot exclusion.
    ///
    /// This is only for callers that have already established the page's
    /// identity through the snapshot store itself: cross-site include
    /// resolution, which finds foreign include-source snapshots by
    /// (`source_site`, `source_fullname`) precisely so they can be read
    /// as include sources (issue #2690). Ordinary page surfaces must use
    /// [`Self::get_optional`] so foreign snapshots stay hidden there.
    pub async fn get_optional_including_foreign_snapshots(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        reference: Reference<'_>,
    ) -> Result<Option<PageModel>> {
        Self::get_optional_impl(ctx, site_id, reference, false).await
    }

    async fn get_optional_impl(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        reference: Reference<'_>,
        exclude_foreign_snapshots: bool,
    ) -> Result<Option<PageModel>> {
        let txn = ctx.transaction();
        let page = {
            let condition = match reference {
                Reference::Id(id) => page::Column::PageId.eq(id),
                Reference::Slug(slug) => {
                    // Trim off _default category if present
                    page::Column::Slug.eq(trim_default(&slug))
                }
            };

            let mut condition = Condition::all()
                .add(condition)
                .add(page::Column::SiteId.eq(site_id))
                .add(page::Column::DeletedAt.is_null());
            if exclude_foreign_snapshots {
                // Foreign include-source snapshots are storage, not
                // pages of this site (issue #2690).
                condition = condition.add(Expr::cust(foreign_snapshot_exclusion_sql(
                    "page.page_id",
                    site_id,
                )));
            }

            Page::find()
                .filter(condition)
                .one(txn)
                .await
                .or_raise(|| Error::new("failed to get page", ErrorType::Page))?
        };

        Ok(page)
    }

    /// Gets all deleted pages that match the provided slug.
    pub async fn get_deleted_by_slug(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        slug: &str,
    ) -> Result<Vec<PageModel>> {
        let txn = ctx.transaction();
        let pages = {
            Page::find()
                .filter(
                    Condition::all()
                        .add(page::Column::Slug.eq(trim_default(slug)))
                        .add(page::Column::SiteId.eq(site_id))
                        .add(page::Column::DeletedAt.is_not_null()),
                )
                .order_by_desc(page::Column::CreatedAt)
                .all(txn)
                .await
                .or_raise(|| {
                    Error::new(
                        format!(
                            "failed to get deleted page '{}' in site ID {}",
                            slug, site_id,
                        ),
                        ErrorType::Page,
                    )
                })?
        };

        Ok(pages)
    }

    /// Gets the page ID from a reference, looking up if necessary.
    ///
    /// Convenience method since this is much more common than the optional
    /// case, and we don't want to perform a redundant check for site existence
    /// later as part of the actual query.
    pub async fn get_id(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        reference: Reference<'_>,
    ) -> Result<i64> {
        match reference {
            Reference::Id(page_id) => Ok(page_id),
            Reference::Slug(slug) => {
                // For slugs we pass-through the call so that slug-handling is done consistently.
                let slug: &str = slug.as_ref();
                let PageModel { page_id, .. } =
                    Self::get(ctx, site_id, Reference::Slug(cow!(slug)))
                        .await
                        .or_raise(|| {
                            Error::new(
                                format!(
                                    "failed to get ID of page '{}' in site ID {}",
                                    slug, site_id,
                                ),
                                ErrorType::Page,
                            )
                        })?;

                Ok(page_id)
            }
        }
    }

    #[inline]
    pub async fn get_direct(
        ctx: &ServiceContext<'_>,
        page_id: i64,
        allow_deleted: bool,
    ) -> Result<PageModel> {
        find_or_error!(
            Self::get_direct_optional(ctx, page_id, allow_deleted),
            "page",
            Page,
        )
    }

    pub async fn get_direct_optional(
        ctx: &ServiceContext<'_>,
        page_id: i64,
        allow_deleted: bool,
    ) -> Result<Option<PageModel>> {
        let txn = ctx.transaction();
        let page = Page::find_by_id(page_id).one(txn).await.or_raise(|| {
            Error::new(
                format!(
                    "failed to get page ID {} directly (accept deleted {})",
                    page_id, allow_deleted,
                ),
                ErrorType::Page,
            )
        })?;

        if let Some(ref page) = page
            && !allow_deleted
            && page.deleted_at.is_some()
        {
            // If we're not looking for deleted pages, then
            // return nothing if the page whose ID match is.
            return Ok(None);
        }

        Ok(page)
    }

    /// Get a page directly while holding an exclusive row lock until the
    /// request transaction completes.
    ///
    /// Mutation paths that derive additional persistent state from a page
    /// must use this form so a concurrent soft delete cannot commit between
    /// the existence check and the dependent mutation.
    pub async fn get_direct_optional_for_update(
        ctx: &ServiceContext<'_>,
        page_id: i64,
        allow_deleted: bool,
    ) -> Result<Option<PageModel>> {
        let txn = ctx.transaction();
        let page = Page::find_by_id(page_id)
            .lock_exclusive()
            .one(txn)
            .await
            .or_raise(|| {
                Error::new(
                    format!(
                        "failed to lock page ID {} directly (accept deleted {})",
                        page_id, allow_deleted,
                    ),
                    ErrorType::Page,
                )
            })?;

        if let Some(ref page) = page
            && !allow_deleted
            && page.deleted_at.is_some()
        {
            return Ok(None);
        }

        Ok(page)
    }

    /// Gets all pages which match the given page references.
    ///
    /// The result list is not in the same order as the input, it
    /// is up to the caller to order it if they wish.
    pub async fn get_pages(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        references: &[Reference<'_>],
    ) -> Result<Vec<PageModel>> {
        info!(
            "Getting {} pages from references in site ID {}",
            references.len(),
            site_id,
        );

        let mut filter_ids = Vec::new();
        let mut filter_slugs = Vec::new();

        for reference in references {
            match reference {
                Reference::Id(id) => filter_ids.push(*id),
                Reference::Slug(slug) => filter_slugs.push(slug.as_ref()),
            }
        }

        let txn = ctx.transaction();
        let models = Page::find()
            .filter(
                Condition::all()
                    .add(page::Column::SiteId.eq(site_id))
                    .add(page::Column::DeletedAt.is_null())
                    .add(
                        Condition::any()
                            .add(page::Column::PageId.is_in(filter_ids))
                            .add(page::Column::Slug.is_in(filter_slugs)),
                    ),
            )
            .all(txn)
            .await
            .or_raise(|| {
                Error::new(
                    format!("failed to get a series of {} pages", references.len()),
                    ErrorType::Page,
                )
            })?;

        Ok(models)
    }

    /// Get all pages in a site, with potential conditions.
    ///
    /// The `category` argument:
    /// * If it is `Some(_)`, then it specifies a reference to the category
    ///   to select from.
    /// * If it is `None`, then all pages on the site are selected.
    ///
    /// The `deleted` argument:
    /// * If it is `Some(true)`, then it only returns pages which have been deleted.
    /// * If it is `Some(false)`, then it only returns pages which are extant.
    /// * If it is `None`, then it returns all pages regardless of deletion status.
    ///
    /// For the `order` argument, see documentation on `PageOrder`.
    // TODO add pagination
    pub async fn get_all(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        category: Option<Reference<'_>>,
        deleted: Option<bool>,
        order: PageOrder,
    ) -> Result<Vec<PageModel>> {
        let txn = ctx.transaction();

        let make_error =
            || Error::new("failed to perform an all-site pages query", ErrorType::Page);

        let category_condition = match category {
            None => None,
            Some(category_reference) => {
                let PageCategoryModel { category_id, .. } =
                    CategoryService::get(ctx, site_id, category_reference)
                        .await
                        .or_raise(make_error)?;

                Some(page::Column::PageCategoryId.eq(category_id))
            }
        };

        let deleted_condition = match deleted {
            Some(true) => Some(page::Column::DeletedAt.is_not_null()),
            Some(false) => Some(page::Column::DeletedAt.is_null()),
            None => None,
        };

        let pages = Page::find()
            .filter(
                Condition::all()
                    .add(page::Column::SiteId.eq(site_id))
                    .add_option(category_condition)
                    .add_option(deleted_condition),
            )
            .order_by(order.column.into_column(), order.direction)
            .all(txn)
            .await
            .or_raise(make_error)?;

        Ok(pages)
    }

    /// Checks to see if a page already exists at the slug specified.
    ///
    /// If so, this method fails with `ErrorType::PageExists`. Otherwise it returns nothing.
    async fn check_conflicts(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        slug: &str,
        action: &str,
    ) -> Result<()> {
        let txn = ctx.transaction();

        if slug.is_empty() {
            bail!(Error::new(
                "cannot create page with empty slug",
                ErrorType::PageSlugEmpty,
            ));
        }

        let result = Page::find()
            .filter(
                Condition::all()
                    .add(page::Column::SiteId.eq(site_id))
                    .add(page::Column::Slug.eq(slug))
                    .add(page::Column::DeletedAt.is_null()),
            )
            .one(txn)
            .await
            .or_raise(|| {
                Error::new(
                    format!(
                        "checking page conflicts for page '{}' on site ID {} failed",
                        slug, site_id,
                    ),
                    ErrorType::Page,
                )
            })?;

        match result {
            None => Ok(()),
            Some(page) => {
                error!(
                    "Page {} with slug '{}' already exists on site ID {}, cannot {}",
                    page.page_id, slug, site_id, action,
                );
                bail!(Error::new(
                    format!(
                        "cannot {} page '{}' on site ID {}, another page (ID {}) already exists",
                        action, slug, site_id, page.page_id,
                    ),
                    ErrorType::PageExists,
                ));
            }
        }
    }

    async fn run_filter<S: AsRef<str>>(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        page_id: Option<i64>,
        wikitext: Option<S>,
        title: Option<S>,
        alt_title: Option<S>,
        ip_address: IpAddr,
    ) -> Result<()> {
        info!("Checking page data against filters...");

        let make_error = || Error::new("filter verification failed", ErrorType::Page);

        let filter_matcher = FilterService::get_matcher(
            ctx,
            FilterClass::PlatformAndSite(site_id),
            FilterType::Page,
        )
        .await
        .or_raise(make_error)?;

        macro_rules! verify_optional {
            ($field:expr) => {
                async {
                    match $field {
                        None => Ok(()),
                        Some(value) => {
                            let field = stringify!($field);
                            let value = value.as_ref();
                            let object = match page_id {
                                Some(id) => ObjectScope::Page(id),
                                None => ObjectScope::Other,
                            };

                            filter_matcher
                                .verify(ctx, field, value, object, ip_address)
                                .await
                                .or_raise(make_error)
                        }
                    }
                }
            };
        }

        let (result1, result2, result3) = join!(
            verify_optional!(title),
            verify_optional!(alt_title),
            verify_optional!(wikitext),
        );
        raise_multiple!(result1, result2, result3; make_error);

        Ok(())
    }

    pub async fn check_user_permission(
        ctx: &ServiceContext<'_>,
        action: Action,
    ) -> Result<bool> {
        let make_error =
            || Error::new("failed to check user permissions for page", ErrorType::Page);

        let page_ref = ctx.request().page_reference().or_raise(make_error)?;
        let site_id = ctx.request().site_id().or_raise(make_error)?;

        Self::check_user_permission_for_page(ctx, site_id, page_ref.clone(), action)
            .await
            .or_raise(make_error)
    }

    /// Variant of `check_user_permission` for an explicit page, used when
    /// the request context carries no page reference (for example the
    /// page-edit-permission endpoint falling back to the site's default
    /// page, upstream #3155).
    pub async fn check_user_permission_for_page(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        page_ref: Reference<'_>,
        action: Action,
    ) -> Result<bool> {
        let make_error =
            || Error::new("failed to check user permissions for page", ErrorType::Page);

        info!(
            "Checking edit permission for page {:?} in site ID {:?}",
            page_ref, site_id
        );

        let page_model = Self::get(ctx, site_id, page_ref.clone())
            .await
            .or_raise(make_error)?;

        PermissionService::can_user(
            ctx,
            Some(site_id),
            action,
            PermissionTarget::Page {
                page_id: page_model.page_id,
                category_id: page_model.page_category_id,
            },
        )
        .await
        .or_raise(make_error)
    }
}

/// Verifies that a `last_revision_id` passed into this function is actually the latest.
///
/// This is to avoid issues wherein a user edits overs a more recently-updated page
/// without realizing it, since attempting to make this edit would cause the backend
/// to produce an error saying that the request had too old of a revision ID and thus
/// the page would need to be refreshed.
///
/// This check is intended for before an operation has run.
fn check_last_revision(
    last_revision_model: Option<&PageRevisionModel>,
    page_latest_revision_id: Option<i64>,
    arg_last_revision_id: i64,
) -> Result<()> {
    let latest_revision_id = match last_revision_model {
        Some(model) => model.revision_id,
        None => page_latest_revision_id.expect("Page row has NULL latest_revision_id"),
    };

    if latest_revision_id != arg_last_revision_id {
        error!(
            "Latest revision ID is {}, but user argument has ID {}",
            latest_revision_id, arg_last_revision_id,
        );
        bail!(Error::new(
            format!(
                "last revision verification failed, actual last revision ID {}, but user passed in ID {}",
                latest_revision_id, arg_last_revision_id,
            ),
            ErrorType::NotLatestRevisionId,
        ));
    }

    Ok(())
}

fn raise_if_revision_insert_conflict(
    error: ExnError,
    arg_last_revision_id: i64,
) -> ExnError {
    fn is_revision_insert_conflict(frame: &Frame) -> bool {
        frame
            .error()
            .downcast_ref::<DbErr>()
            .is_some_and(|db_error| match db_error.sql_err() {
                Some(SqlErr::UniqueConstraintViolation(message)) => {
                    message.contains("page_revision_page_id_site_id_revision_number_key")
                }
                _ => db_error.to_string().contains("deadlock detected"),
            })
            || frame.children().iter().any(is_revision_insert_conflict)
    }

    if is_revision_insert_conflict(error.frame()) {
        error.raise(Error::new(
            format!(
                "last revision verification failed, a revision newer than ID {} was created concurrently",
                arg_last_revision_id,
            ),
            ErrorType::NotLatestRevisionId,
        ))
    } else {
        error
    }
}

/// Ensure that the page has a properly-set `latest_revision_id` column.
///
/// This check is intended for after an operation has run.
fn assert_latest_revision(page: &PageModel) {
    // Even in production, we want to assert that this invariant holds.
    //
    // We cannot set the column itself to NOT NULL because of cyclic update
    // requirements. However when using PageService, at no point should a method
    // quit with this value being null.

    assert!(
        page.latest_revision_id.is_some(),
        "Page ID {} (slug '{}', site ID {}) has a NULL latest_revision_id column!",
        page.page_id,
        page.slug,
        page.site_id,
    );
}

#[cfg(test)]
mod tests {
    use super::{MAX_PAGE_SOURCE_LENGTH, check_page_source_length};

    #[test]
    fn page_source_length_at_max_is_accepted() {
        let source = "x".repeat(MAX_PAGE_SOURCE_LENGTH);
        assert!(check_page_source_length(&source).is_ok());
    }

    #[test]
    fn page_source_length_over_max_is_rejected() {
        let source = "x".repeat(MAX_PAGE_SOURCE_LENGTH + 1);
        assert!(check_page_source_length(&source).is_err());
    }

    #[test]
    fn page_source_length_counts_characters_not_bytes() {
        // Each of these characters is three bytes in UTF-8; the limit is
        // on the character count, as measured against Wikidot.
        let source = "\u{3042}".repeat(MAX_PAGE_SOURCE_LENGTH);
        assert!(check_page_source_length(&source).is_ok());
        let source = "\u{3042}".repeat(MAX_PAGE_SOURCE_LENGTH + 1);
        assert!(check_page_source_length(&source).is_err());
    }
}
