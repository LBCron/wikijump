/*
 * services/file_revision/service.rs
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
    CountFileRevisions, CreateFileRevision, CreateFileRevisionOutput,
    CreateFirstFileRevision, CreateFirstFileRevisionOutput,
    CreateResurrectionFileRevision, CreateTombstoneFileRevision, GetFileRevision,
    GetFileRevisionRange, GetPageFileRevisionHistory, PageFileRevisionHistory,
    UpdateFileRevision,
};
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::file_revision::{
    self, Entity as FileRevision, Model as FileRevisionModel,
};
use crate::services::ServiceContext;
use crate::services::blob::EMPTY_BLOB_HASH;
use crate::services::{OutdateService, PageService};
use crate::types::{FetchDirection, RerenderDepth};
use crate::types::{FileRevisionType, Maybe, Reference};
use paste::paste;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, EntityTrait, PaginatorTrait, QueryFilter,
    QueryOrder, QuerySelect, Set,
};
use std::num::NonZeroI32;
use std::sync::LazyLock;

static ALL_CHANGES: LazyLock<Vec<String>> =
    LazyLock::new(|| vec![str!("page"), str!("name"), str!("blob"), str!("mime")]);

#[derive(Debug)]
pub struct FileRevisionService;

impl FileRevisionService {
    pub async fn create(
        ctx: &ServiceContext<'_>,
        CreateFileRevision {
            site_id,
            mut page_id,
            file_id,
            user_id,
            revision_comments,
            revision_type,
            body,
        }: CreateFileRevision,
        previous: FileRevisionModel,
    ) -> Result<Option<CreateFileRevisionOutput>> {
        let txn = ctx.transaction();
        let revision_number = next_revision_number(&previous, page_id, file_id);

        let original_page_id = page_id;
        let make_error = || {
            Error::new(
                format!(
                    "failed to create new file revision on file ID {} on page ID {} in site ID {} by user ID {}",
                    file_id, original_page_id, site_id, user_id,
                ),
                ErrorType::FileRevision,
            )
        };

        debug_assert!(
            matches!(
                revision_type,
                FileRevisionType::Regular
                    | FileRevisionType::Move
                    | FileRevisionType::Rollback,
            ),
            "Invalid revision type for standard revision creation",
        );

        let mut changes = Vec::new();
        let mut blob_created = Maybe::Unset;
        let FileRevisionModel {
            mut name,
            mut s3_hash,
            mut mime,
            mut size,
            mut content_type_label,
            mut content_type_description,
            ..
        } = previous;

        if let Maybe::Set(new_page_id) = body.page_id
            && page_id != new_page_id
        {
            changes.push(str!("page"));
            page_id = new_page_id;
        }

        if let Maybe::Set(new_name) = body.name
            && name != new_name
        {
            changes.push(str!("name"));
            name = new_name;
        }

        if let Maybe::Set(new_blob) = body.blob
            && (s3_hash != new_blob.s3_hash
                || size != new_blob.size
                || mime != new_blob.mime
                || content_type_label.as_deref()
                    != new_blob
                        .content_type
                        .as_ref()
                        .map(|descriptor| descriptor.label.as_str())
                || content_type_description.as_deref()
                    != new_blob
                        .content_type
                        .as_ref()
                        .map(|descriptor| descriptor.description.as_str()))
        {
            changes.push(str!("blob"));
            s3_hash = new_blob.s3_hash.to_vec();
            size = new_blob.size;
            mime = new_blob.mime;
            content_type_label = new_blob
                .content_type
                .as_ref()
                .map(|descriptor| descriptor.label.clone());
            content_type_description = new_blob
                .content_type
                .map(|descriptor| descriptor.description);
            blob_created = Maybe::Set(new_blob.blob_created);
        }

        if changes.is_empty() {
            debug!("No changes in file, performing no action");
            return Ok(None);
        }

        if mime.is_empty() {
            error!("MIME type is empty");
            bail!(Error::new(
                "cannot create file revision, no MIME type specified",
                ErrorType::FileMimeEmpty
            ));
        }

        let page_slug = Self::get_page_slug(ctx, site_id, page_id)
            .await
            .or_raise(make_error)?;

        OutdateService::process_page_edit(
            ctx,
            site_id,
            page_id,
            &page_slug,
            RerenderDepth::default(),
        )
        .await
        .or_raise(make_error)?;

        let model = file_revision::ActiveModel {
            revision_type: Set(revision_type),
            revision_number: Set(revision_number),
            file_id: Set(file_id),
            page_id: Set(page_id),
            site_id: Set(site_id),
            user_id: Set(user_id),
            name: Set(name),
            s3_hash: Set(s3_hash.to_vec()),
            size: Set(size),
            mime: Set(mime),
            content_type_label: Set(content_type_label),
            content_type_description: Set(content_type_description),
            changes: Set(changes),
            comments: Set(revision_comments),
            hidden: Set(vec![]),
            ..Default::default()
        };

        let FileRevisionModel { revision_id, .. } =
            model.insert(txn).await.or_raise(make_error)?;
        ctx.defer_public_content_cache_invalidate_site(site_id)
            .or_raise(make_error)?;
        OutdateService::outdate(ctx, page_id, RerenderDepth::default())
            .await
            .or_raise(make_error)?;
        if original_page_id != page_id {
            OutdateService::outdate(ctx, original_page_id, RerenderDepth::default())
                .await
                .or_raise(make_error)?;
        }
        Ok(Some(CreateFileRevisionOutput {
            file_revision_id: revision_id,
            file_revision_number: revision_number,
            blob_created,
        }))
    }

    pub async fn create_first(
        ctx: &ServiceContext<'_>,
        CreateFirstFileRevision {
            page_id,
            site_id,
            file_id,
            user_id,
            name,
            s3_hash,
            size,
            mime,
            content_type,
            blob_created,
            revision_comments,
        }: CreateFirstFileRevision,
    ) -> Result<CreateFirstFileRevisionOutput> {
        let txn = ctx.transaction();

        let make_error = || {
            Error::new(
                format!(
                    "failed to create first file revision on file ID {} on page ID {} in site ID {} by user ID {}",
                    file_id, page_id, site_id, user_id,
                ),
                ErrorType::FileRevision,
            )
        };

        let page_slug = Self::get_page_slug(ctx, site_id, page_id)
            .await
            .or_raise(make_error)?;

        OutdateService::process_page_displace(
            ctx,
            site_id,
            page_id,
            &page_slug,
            RerenderDepth::default(),
        )
        .await
        .or_raise(make_error)?;

        let model = file_revision::ActiveModel {
            revision_type: Set(FileRevisionType::Create),
            revision_number: Set(0),
            file_id: Set(file_id),
            page_id: Set(page_id),
            site_id: Set(site_id),
            user_id: Set(user_id),
            name: Set(name),
            s3_hash: Set(s3_hash.to_vec()),
            mime: Set(mime),
            size: Set(size),
            content_type_label: Set(content_type
                .as_ref()
                .map(|descriptor| descriptor.label.clone())),
            content_type_description: Set(
                content_type.map(|descriptor| descriptor.description)
            ),
            changes: Set(ALL_CHANGES.clone()),
            comments: Set(revision_comments),
            hidden: Set(vec![]),
            ..Default::default()
        };

        let FileRevisionModel { revision_id, .. } =
            model.insert(txn).await.or_raise(make_error)?;
        ctx.defer_public_content_cache_invalidate_site(site_id)
            .or_raise(make_error)?;
        OutdateService::outdate(ctx, page_id, RerenderDepth::default())
            .await
            .or_raise(make_error)?;

        Ok(CreateFirstFileRevisionOutput {
            file_id,
            file_revision_id: revision_id,
            blob_created,
        })
    }

    pub async fn create_tombstone(
        ctx: &ServiceContext<'_>,
        CreateTombstoneFileRevision {
            site_id,
            page_id,
            file_id,
            user_id,
            revision_comments,
            erase_s3_hash,
        }: CreateTombstoneFileRevision,
        previous: FileRevisionModel,
    ) -> Result<CreateFileRevisionOutput> {
        let txn = ctx.transaction();
        let revision_number = next_revision_number(&previous, page_id, file_id);

        let make_error = || {
            Error::new(
                format!(
                    "failed to create tombstone file revision on file ID {} on page ID {} in site ID {} by user ID {} (erase S3 hash {})",
                    file_id, page_id, site_id, user_id, erase_s3_hash,
                ),
                ErrorType::FileRevision,
            )
        };

        let mut hidden = Vec::new();
        let FileRevisionModel {
            name,
            mut s3_hash,
            mime,
            size,
            content_type_label,
            content_type_description,
            ..
        } = previous;

        if erase_s3_hash {
            s3_hash.copy_from_slice(&EMPTY_BLOB_HASH);

            hidden.push(str!("s3_hash"));
        }

        let page_slug = Self::get_page_slug(ctx, site_id, page_id)
            .await
            .or_raise(make_error)?;

        OutdateService::process_page_edit(
            ctx,
            site_id,
            page_id,
            &page_slug,
            RerenderDepth::default(),
        )
        .await
        .or_raise(make_error)?;

        let model = file_revision::ActiveModel {
            revision_type: Set(FileRevisionType::Delete),
            revision_number: Set(revision_number),
            file_id: Set(file_id),
            page_id: Set(page_id),
            site_id: Set(site_id),
            user_id: Set(user_id),
            name: Set(name),
            s3_hash: Set(s3_hash),
            mime: Set(mime),
            size: Set(size),
            content_type_label: Set(content_type_label),
            content_type_description: Set(content_type_description),
            changes: Set(vec![]),
            comments: Set(revision_comments),
            hidden: Set(hidden),
            ..Default::default()
        };

        let FileRevisionModel { revision_id, .. } =
            model.insert(txn).await.or_raise(make_error)?;
        ctx.defer_public_content_cache_invalidate_site(site_id)
            .or_raise(make_error)?;
        OutdateService::outdate(ctx, page_id, RerenderDepth::default())
            .await
            .or_raise(make_error)?;

        Ok(CreateFileRevisionOutput {
            file_revision_id: revision_id,
            file_revision_number: revision_number,
            blob_created: Maybe::Unset,
        })
    }

    pub async fn create_resurrection(
        ctx: &ServiceContext<'_>,
        CreateResurrectionFileRevision {
            site_id,
            page_id: old_page_id,
            file_id,
            user_id,
            new_page_id,
            new_name,
            revision_comments,
        }: CreateResurrectionFileRevision,
        previous: FileRevisionModel,
    ) -> Result<CreateFileRevisionOutput> {
        let txn = ctx.transaction();
        let revision_number = next_revision_number(&previous, old_page_id, file_id);

        let make_error = || {
            Error::new(
                format!(
                    "failed to create resurrection file revision on file ID {} on old page ID {} in site ID {} to new page ID {} by user ID {}",
                    file_id, old_page_id, site_id, new_page_id, user_id,
                ),
                ErrorType::FileRevision,
            )
        };

        let FileRevisionModel {
            name: old_name,
            s3_hash,
            mime,
            size,
            content_type_label,
            content_type_description,
            ..
        } = previous;

        let changes = {
            let mut changes = vec![];

            if old_page_id != new_page_id {
                changes.push(str!("page"));
            }

            if old_name != new_name {
                changes.push(str!("name"));
            }

            changes
        };

        let new_page_slug = Self::get_page_slug(ctx, site_id, new_page_id)
            .await
            .or_raise(make_error)?;

        OutdateService::process_page_edit(
            ctx,
            site_id,
            new_page_id,
            &new_page_slug,
            RerenderDepth::default(),
        )
        .await
        .or_raise(make_error)?;

        let model = file_revision::ActiveModel {
            revision_type: Set(FileRevisionType::Undelete),
            revision_number: Set(revision_number),
            file_id: Set(file_id),
            page_id: Set(new_page_id),
            site_id: Set(site_id),
            user_id: Set(user_id),
            name: Set(new_name),
            s3_hash: Set(s3_hash),
            mime: Set(mime),
            size: Set(size),
            content_type_label: Set(content_type_label),
            content_type_description: Set(content_type_description),
            changes: Set(changes),
            comments: Set(revision_comments),
            hidden: Set(vec![]),
            ..Default::default()
        };

        let FileRevisionModel { revision_id, .. } =
            model.insert(txn).await.or_raise(make_error)?;
        ctx.defer_public_content_cache_invalidate_site(site_id)
            .or_raise(make_error)?;
        OutdateService::outdate(ctx, new_page_id, RerenderDepth::default())
            .await
            .or_raise(make_error)?;

        Ok(CreateFileRevisionOutput {
            file_revision_id: revision_id,
            file_revision_number: revision_number,
            blob_created: Maybe::Unset,
        })
    }

    pub async fn update(
        ctx: &ServiceContext<'_>,
        UpdateFileRevision {
            site_id,
            page_id,
            file_id,
            revision_id,
            user_id,
            hidden,
        }: UpdateFileRevision,
    ) -> Result<FileRevisionModel> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to update file revision ID {} on file ID {} on page ID {} in site ID {} by user ID {}",
                    revision_id, file_id, page_id, site_id, user_id,
                ),
                ErrorType::FileRevision,
            )
        };

        let txn = ctx.transaction();
        let latest = Self::get_latest(ctx, site_id, page_id, file_id)
            .await
            .or_raise(make_error)?;

        if revision_id == latest.revision_id {
            warn!("Attempting to edit latest revision, denying request");
            bail!(Error::new(
                "cannot edit latest file revision",
                ErrorType::CannotHideLatestRevision,
            ));
        }

        let _ = user_id;

        let model = file_revision::ActiveModel {
            revision_id: Set(revision_id),
            hidden: Set(hidden),
            ..Default::default()
        };

        let revision = model.update(txn).await.or_raise(make_error)?;
        Ok(revision)
    }

    pub async fn get_latest(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        page_id: i64,
        file_id: i64,
    ) -> Result<FileRevisionModel> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to get latest file revision for file ID {} on page ID {} in site ID {}",
                    file_id, page_id, site_id,
                ),
                ErrorType::FileRevision,
            )
        };

        let txn = ctx.transaction();
        let revision_opt = FileRevision::find()
            .filter(
                Condition::all()
                    .add(file_revision::Column::SiteId.eq(site_id))
                    .add(file_revision::Column::PageId.eq(page_id))
                    .add(file_revision::Column::FileId.eq(file_id)),
            )
            .order_by_desc(file_revision::Column::RevisionNumber)
            .one(txn)
            .await
            .or_raise(make_error)?;

        match revision_opt {
            Some(revision) => Ok(revision),
            None => bail!(Error::new(
                format!(
                    "no latest file revision for file ID {} on page ID {} in site ID {}",
                    file_id, page_id, site_id,
                ),
                ErrorType::FileRevisionNotFound,
            )),
        }
    }

    pub async fn get_optional(
        ctx: &ServiceContext<'_>,
        GetFileRevision {
            site_id,
            page_id,
            file_id,
            revision_number,
        }: GetFileRevision,
    ) -> Result<Option<FileRevisionModel>> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to get file revision number {} on file ID {} in page ID {} on site ID {}",
                    revision_number, file_id, page_id, site_id,
                ),
                ErrorType::FileRevision,
            )
        };

        let txn = ctx.transaction();
        let revision = FileRevision::find()
            .filter(
                Condition::all()
                    .add(file_revision::Column::SiteId.eq(site_id))
                    .add(file_revision::Column::PageId.eq(page_id))
                    .add(file_revision::Column::FileId.eq(file_id))
                    .add(file_revision::Column::RevisionNumber.eq(revision_number)),
            )
            .one(txn)
            .await
            .or_raise(make_error)?;

        Ok(revision)
    }

    #[inline]
    pub async fn get(
        ctx: &ServiceContext<'_>,
        input: GetFileRevision,
    ) -> Result<FileRevisionModel> {
        find_or_error!(
            Self::get_optional(ctx, input),
            "file revision",
            FileRevision
        )
    }

    pub async fn count(
        ctx: &ServiceContext<'_>,
        CountFileRevisions {
            site_id,
            page_id,
            file_id,
        }: CountFileRevisions,
    ) -> Result<NonZeroI32> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to get file revision count on file ID {} in page ID {} on site ID {}",
                    file_id, page_id, site_id,
                ),
                ErrorType::FileRevision,
            )
        };

        let txn = ctx.transaction();
        let row_count = FileRevision::find()
            .filter(
                Condition::all()
                    .add(file_revision::Column::SiteId.eq(site_id))
                    .add(file_revision::Column::PageId.eq(page_id))
                    .add(file_revision::Column::FileId.eq(file_id)),
            )
            .count(txn)
            .await
            .or_raise(make_error)?;

        let row_count = i32::try_from(row_count)
            .expect("Revision row count greater than revision_number integer size");

        match NonZeroI32::new(row_count) {
            Some(count) => Ok(count),
            None => bail!(Error::new(
                format!(
                    "cannot get file revision count for file ID {} in page ID {} on site ID {}",
                    file_id, page_id, site_id,
                ),
                ErrorType::FileNotFound
            )),
        }
    }

    pub async fn get_range(
        ctx: &ServiceContext<'_>,
        GetFileRevisionRange {
            site_id,
            page_id,
            file_id,
            revision_number,
            revision_direction,
            limit,
        }: GetFileRevisionRange,
    ) -> Result<Vec<FileRevisionModel>> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to get {} file revisions from number {} for file ID {} on page ID {} in site ID {} (max {})",
                    revision_direction.name(),
                    revision_number,
                    file_id,
                    page_id,
                    site_id,
                    limit,
                ),
                ErrorType::FileRevision,
            )
        };

        let revision_condition = {
            use file_revision::Column::RevisionNumber;

            let revision_number = if revision_number >= 0 {
                revision_number
            } else {
                i32::MAX
            };

            match revision_direction {
                FetchDirection::Before => RevisionNumber.lte(revision_number),
                FetchDirection::After => RevisionNumber.gte(revision_number),
            }
        };

        let txn = ctx.transaction();
        let mut query = FileRevision::find().filter(
            Condition::all()
                .add(file_revision::Column::SiteId.eq(site_id))
                .add(file_revision::Column::PageId.eq(page_id))
                .add(file_revision::Column::FileId.eq(file_id))
                .add(revision_condition),
        );

        query = match revision_direction {
            FetchDirection::Before => {
                query.order_by_desc(file_revision::Column::RevisionNumber)
            }
            FetchDirection::After => {
                query.order_by_asc(file_revision::Column::RevisionNumber)
            }
        };

        let revisions = query.limit(limit).all(txn).await.or_raise(make_error)?;

        Ok(revisions)
    }

    pub async fn get_page_history(
        ctx: &ServiceContext<'_>,
        GetPageFileRevisionHistory {
            site_id,
            page_id,
            limit,
        }: GetPageFileRevisionHistory,
    ) -> Result<PageFileRevisionHistory> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to get file revision history for page ID {} in site ID {}",
                    page_id, site_id,
                ),
                ErrorType::FileRevision,
            )
        };

        let txn = ctx.transaction();
        let filter = Condition::all()
            .add(file_revision::Column::SiteId.eq(site_id))
            .add(file_revision::Column::PageId.eq(page_id));
        let revision_count = FileRevision::find()
            .filter(filter.clone())
            .count(txn)
            .await
            .or_raise(make_error)?;
        let revisions = FileRevision::find()
            .filter(filter)
            .order_by_desc(file_revision::Column::CreatedAt)
            .order_by_desc(file_revision::Column::RevisionId)
            .limit(limit)
            .all(txn)
            .await
            .or_raise(make_error)?;

        Ok(PageFileRevisionHistory {
            revision_count,
            revisions,
        })
    }

    async fn get_page_slug(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        page_id: i64,
    ) -> Result<String> {
        let page = PageService::get(ctx, site_id, Reference::Id(page_id))
            .await
            .or_raise(|| {
                Error::new(
                    format!(
                        "failed to get page slug for page ID {} in site ID {}",
                        page_id, site_id,
                    ),
                    ErrorType::FileRevision,
                )
            })?;

        Ok(page.slug)
    }
}

fn next_revision_number(previous: &FileRevisionModel, page_id: i64, file_id: i64) -> i32 {
    assert_eq!(
        previous.file_id, file_id,
        "Previous revision has an inconsistent file ID",
    );
    assert_eq!(
        previous.page_id, page_id,
        "Previous revision has an inconsistent page ID",
    );

    previous.revision_number + 1
}
