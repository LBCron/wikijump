/*
 * services/blob/service.rs
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
    BlobMetadata, ContentAnalysis, ContentTypeDescriptor, FinalizeBlobUploadOutput,
    HardDelete, HardDeleteOutput, PendingBlobOwner, StartBlobUploadOutput,
};
use crate::constants::{ADMIN_USER_ID, SYSTEM_USER_ID};
use crate::error::prelude::{Error, ErrorType, OptionExt, Result, ResultExt};
use crate::hash::{slice_to_blob_hash, try_slice_to_blob_hash};
use crate::hash::{BLOB_HASH_LENGTH, BlobHash, blob_hash_to_hex, sha512_hash};
use crate::models::blob_blacklist::{self, Entity as BlobBlacklist};
use crate::models::blob_pending::{
    self, Entity as BlobPending, Model as BlobPendingModel,
};
use crate::models::file_revision::{self, Entity as FileRevision};
use crate::models::user::{self, Entity as User};
use crate::services::ServiceContext;
use crate::services::file::{DeleteFile, FileService};
use crate::utils::assert_is_csprng;
use crate::utils::{ConvertToI64, ConvertToU64, ConvertToUsize, now};
use bytes::Bytes;
use cuid2::cuid;
use paste::paste;
use rand::distr::{Alphanumeric, SampleString};
use s3::request::request_trait::ResponseData;
use s3::serde_types::HeadObjectResult;
use sea_orm::prelude::Value;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter, QuerySelect,
    Set,
};
use sea_orm::{DatabaseBackend, FromQueryResult, Statement, TransactionTrait};
use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::str;
use std::sync::Arc;
use time::format_description::well_known::Rfc2822;
use time::{Duration, OffsetDateTime};

const SAMPLE_COUNT: u16 = 10;

pub const EMPTY_BLOB_HASH: BlobHash = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
];

pub const EMPTY_BLOB_MIME: &str = "inode/x-empty; charset=binary";

pub const EMPTY_BLOB_TIMESTAMP: i64 = 1547769600;

pub const PRESIGN_DIRECTORY: &str = "uploads";

#[derive(Debug)]
pub struct BlobService;

impl BlobService {
    pub async fn start_upload(
        ctx: &ServiceContext<'_>,
        user_id: i64,
        blob_size: u64,
        owner: PendingBlobOwner,
    ) -> Result<StartBlobUploadOutput> {
        info!("Creating upload by {user_id} with promised length {blob_size}");
        let config = ctx.config();
        let txn = ctx.transaction();

        let blob_size = i64::try_from(blob_size).or_raise(|| Error::new(
            format!(
                "failed to create pending blob upload, size integer could not be converted: {}",
                blob_size,
            ),
            ErrorType::BlobTooBig,
        ))?;

        if blob_size > config.maximum_blob_size {
            error!(
                "Blob proposed to upload is too big ({} > {})",
                blob_size, config.maximum_blob_size,
            );
            bail!(Error::new(
                format!(
                    "failed to create pending blob upload, proposed file size is too large: ({} > {} bytes)",
                    blob_size, config.maximum_blob_size,
                ),
                ErrorType::BlobTooBig,
            ));
        }

        let make_error =
            || Error::new("failed to create pending blob upload", ErrorType::Blob);

        let pending_blob_id = cuid();
        let s3_path = {
            let mut path = format!("{PRESIGN_DIRECTORY}/");

            {
                let mut rng = rand::rng();
                assert_is_csprng(&rng);
                Alphanumeric.append_string(
                    &mut rng,
                    &mut path,
                    config.presigned_path_length,
                );
            }

            path
        };

        info!("Creating presign upload URL for a pending blob");

        let bucket = ctx.s3_files_bucket();
        let presign_url = bucket
            .presign_put(&s3_path, config.presigned_expiry_secs, None, None)
            .await
            .or_raise(make_error)?;

        let created_at = now();
        let expires_at = created_at
            .checked_add(Duration::seconds(i64::from(config.presigned_expiry_secs)))
            .ok_or_raise(make_error)?;

        let (site_id, page_id) = match owner {
            PendingBlobOwner::Unscoped => (None, None),
            PendingBlobOwner::Page { site_id, page_id } => (Some(site_id), Some(page_id)),
        };
        let model = blob_pending::ActiveModel {
            external_id: Set(pending_blob_id),
            expected_length: Set(blob_size),
            s3_path: Set(s3_path),
            presign_url: Set(presign_url),
            created_by: Set(user_id),
            created_at: Set(created_at),
            expires_at: Set(expires_at),
            site_id: Set(site_id),
            page_id: Set(page_id),
            ..Default::default()
        };

        let BlobPendingModel {
            external_id: pending_blob_id,
            presign_url,
            ..
        } = model.insert(txn).await.or_raise(make_error)?;

        debug!("New presign upload URL will last until {expires_at}");

        Ok(StartBlobUploadOutput {
            pending_blob_id,
            presign_url,
            expires_at,
        })
    }

    async fn require_owned_pending_blob(
        ctx: &ServiceContext<'_>,
        user_id: i64,
        pending_blob_id: &str,
        expected_owner: Option<PendingBlobOwner>,
    ) -> Result<PendingBlob> {
        let txn = ctx.transaction();

        let make_error =
            || Error::new("failed to require owned pending blob", ErrorType::Blob);

        let row = BlobPending::find_by_id(pending_blob_id)
            .one(txn)
            .await
            .or_raise(make_error)?;

        let BlobPendingModel {
            s3_path,
            s3_hash,
            content_type_label,
            content_type_description,
            created_by,
            expected_length,
            site_id,
            page_id,
            ..
        } = match row {
            Some(pending) => pending,
            None => bail!(Error::new("blob does not exist", ErrorType::BlobNotFound)),
        };

        let owner = match (site_id, page_id) {
            (None, None) => PendingBlobOwner::Unscoped,
            (Some(site_id), Some(page_id)) => PendingBlobOwner::Page { site_id, page_id },
            _ => bail!(Error::new(
                "pending blob has an invalid ownership scope",
                ErrorType::Blob,
            )),
        };

        if user_id != created_by
            || expected_owner.is_some_and(|expected| expected != owner)
        {
            error!("Pending blob ownership does not match the requested operation");
            bail!(Error::new("blob does not exist", ErrorType::BlobNotFound));
        }

        Ok(PendingBlob {
            s3_path,
            expected_length,
            moved_hash: s3_hash,
            content_type_label,
            content_type_description,
        })
    }

    pub async fn cancel_upload(
        ctx: &ServiceContext<'_>,
        user_id: i64,
        pending_blob_id: &str,
    ) -> Result<()> {
        info!("Cancelling a pending blob upload");
        let txn = ctx.transaction();

        let make_error = || Error::new("failed to cancel pending blob", ErrorType::Blob);

        let PendingBlob { s3_path, .. } =
            Self::require_owned_pending_blob(ctx, user_id, pending_blob_id, None)
                .await
                .or_raise(make_error)?;

        BlobPending::delete_by_id(pending_blob_id)
            .exec(txn)
            .await
            .or_raise(make_error)?;

        if Self::exists(ctx, &s3_path).await.or_raise(make_error)? {
            let bucket = ctx.s3_files_bucket();
            bucket.delete_object(&s3_path).await.or_raise(make_error)?;
        }

        Ok(())
    }

    async fn move_uploaded(
        ctx: &ServiceContext<'_>,
        pending_blob_id: &str,
        pending_blob_user_id: i64,
        s3_path: &str,
        expected_length: usize,
        maximum_length: Option<usize>,
    ) -> Result<FinalizeBlobUploadOutput> {
        let state = ctx.state();
        let db_state = Arc::clone(&state);

        let make_error =
            || Error::new("failed to move uploaded blob to final", ErrorType::Blob);

        let txn = db_state.database.begin().await.or_raise(make_error)?;

        let inner_ctx = ServiceContext::new(&state, &txn);
        let result = Self::move_uploaded_inner(
            &inner_ctx,
            pending_blob_id,
            pending_blob_user_id,
            s3_path,
            expected_length,
            maximum_length,
        )
        .await;

        txn.commit().await.or_raise(make_error)?;
        result
    }

    async fn move_uploaded_inner(
        ctx: &ServiceContext<'_>,
        pending_blob_id: &str,
        pending_blob_user_id: i64,
        s3_path: &str,
        expected_length: usize,
        maximum_length: Option<usize>,
    ) -> Result<FinalizeBlobUploadOutput> {
        let bucket = ctx.s3_files_bucket();
        let txn = ctx.transaction();

        let make_error =
            || Error::new("failed to move uploaded blob to final", ErrorType::Blob);

        debug!("Download uploaded blob from S3 uploads to get metadata");
        let response = bucket.get_object(s3_path).await.or_raise(make_error)?;

        let data: Vec<u8> = match response.status_code() {
            200 => response.into(),
            404 => {
                error!("No blob uploaded at the pending presign path");
                bail!(Error::new(
                    "no blob uploaded at the pending presign path",
                    ErrorType::BlobNotUploaded,
                ));
            }
            _ => {
                error!("Unable to retrieve the pending blob from S3");
                bail!(s3_error(&response, "finalizing uploaded blob"));
            }
        };

        if maximum_length.is_some_and(|maximum_length| data.len() > maximum_length) {
            let maximum_length = maximum_length.expect("checked as present");
            error!(
                "Uploaded blob is too big for this operation ({} > {})",
                data.len(),
                maximum_length,
            );
            bail!(Error::new(
                format!(
                    "uploaded blob is too big for this operation ({} > {} bytes)",
                    data.len(),
                    maximum_length,
                ),
                ErrorType::BlobTooBig,
            ));
        }

        if expected_length != data.len() {
            error!(
                "Expected blob length of {} bytes, instead found {} uploaded. Deleting pending.",
                expected_length,
                data.len(),
            );
            bucket.delete_object(&s3_path).await.or_raise(make_error)?;
            bail!(Error::new(
                format!(
                    "expected blob length of {} bytes, instead found a blob of {} bytes uploaded",
                    expected_length,
                    data.len(),
                ),
                ErrorType::BlobSizeMismatch {
                    expected: expected_length,
                    actual: data.len()
                },
            ));
        }

        if data.is_empty() {
            debug!("File being created is empty, special case");
            let content_type = ctx
                .mime()
                .analyze(Vec::new())
                .await
                .or_raise(make_error)?
                .content_type;
            return Ok(FinalizeBlobUploadOutput {
                s3_hash: EMPTY_BLOB_HASH,
                mime: str!(EMPTY_BLOB_MIME),
                size: 0,
                content_type,
                created: false,
            });
        }

        debug!("Updating blob metadata in database and S3");

        let s3_hash = sha512_hash(&data);

        if Self::on_blacklist(ctx, s3_hash)
            .await
            .or_raise(make_error)?
        {
            let hex_hash = blob_hash_to_hex(&s3_hash);
            error!("Newly-uploaded blob is blacklisted (hash {hex_hash})");

            bucket.delete_object(&s3_path).await.or_raise(make_error)?;
            Self::cancel_upload(ctx, pending_blob_user_id, pending_blob_id)
                .await
                .or_raise(make_error)?;

            bail!(Error::new(
                "cannot upload blob, contents are blacklisted",
                ErrorType::BlobBlacklisted(s3_hash)
            ));
        }

        let result = Self::direct_upload(ctx, data).await.or_raise(make_error)?;

        bucket.delete_object(&s3_path).await.or_raise(make_error)?;

        let model = blob_pending::ActiveModel {
            external_id: Set(str!(pending_blob_id)),
            s3_hash: Set(Some(result.s3_hash.to_vec())),
            content_type_label: Set(Some(result.content_type.label.clone())),
            content_type_description: Set(Some(result.content_type.description.clone())),
            ..Default::default()
        };
        model.update(txn).await.or_raise(make_error)?;

        Ok(result)
    }

    pub(crate) async fn direct_upload(
        ctx: &ServiceContext<'_>,
        data: Vec<u8>,
    ) -> Result<FinalizeBlobUploadOutput> {
        let bucket = ctx.s3_files_bucket();

        let make_error =
            || Error::new("failed to perform direct upload", ErrorType::Blob);

        let s3_hash = sha512_hash(&data);
        let hex_hash = blob_hash_to_hex(&s3_hash);

        let size = data.len().try_into_i64().or_raise(make_error)?;

        let ContentAnalysis {
            mime: analyzed_mime,
            content_type,
        } = ctx
            .mime()
            .analyze(data.clone())
            .await
            .or_raise(make_error)?;

        match Self::head(ctx, &hex_hash).await.or_raise(make_error)? {
            Some(result) => {
                debug!("Blob with hash {hex_hash} already exists");

                let mime = result.content_type.ok_or_raise(|| {
                    Error::new(
                        format!("blob with hash {} already exists in S3", hex_hash),
                        ErrorType::BlobBackend,
                    )
                })?;

                Ok(FinalizeBlobUploadOutput {
                    s3_hash,
                    mime,
                    size,
                    content_type,
                    created: false,
                })
            }
            None => {
                debug!("Blob with hash {hex_hash} to be created");

                let mime = analyzed_mime;

                let response = bucket
                    .put_object_with_content_type(&hex_hash, &data, &mime)
                    .await
                    .or_raise(make_error)?;

                match response.status_code() {
                    200 => Ok(FinalizeBlobUploadOutput {
                        s3_hash,
                        mime,
                        size,
                        content_type,
                        created: true,
                    }),
                    _ => bail!(s3_error(&response, "creating finalized S3 blob")),
                }
            }
        }
    }

    async fn finish_upload(
        ctx: &ServiceContext<'_>,
        user_id: i64,
        pending_blob_id: &str,
        expected_owner: PendingBlobOwner,
        maximum_length: Option<i64>,
    ) -> Result<FinalizeBlobUploadOutput> {
        info!("Finishing a pending blob upload");

        let make_error = || Error::new("failed to finalize blob upload", ErrorType::Blob);

        let PendingBlob {
            s3_path,
            expected_length,
            moved_hash,
            content_type_label,
            content_type_description,
        } = Self::require_owned_pending_blob(
            ctx,
            user_id,
            pending_blob_id,
            Some(expected_owner),
        )
        .await
        .or_raise(make_error)?;

        if maximum_length.is_some_and(|maximum_length| expected_length > maximum_length) {
            let maximum_length = maximum_length.expect("checked as present");
            error!(
                "Promised blob length is too big for this operation ({} > {})",
                expected_length, maximum_length,
            );
            bail!(Error::new(
                format!(
                    "promised blob length is too big for this operation ({} > {} bytes)",
                    expected_length, maximum_length,
                ),
                ErrorType::BlobTooBig,
            ));
        }

        let output = match moved_hash {
            None => {
                let expected_length =
                    expected_length.try_into_usize().or_raise(make_error)?;
                let maximum_length = maximum_length
                    .map(|maximum_length| {
                        maximum_length.try_into_usize().or_raise(make_error)
                    })
                    .transpose()?;

                Self::move_uploaded(
                    ctx,
                    pending_blob_id,
                    user_id,
                    &s3_path,
                    expected_length,
                    maximum_length,
                )
                .await
                .or_raise(make_error)?
            }

            Some(hash_vec) => {
                let BlobMetadata { mime, size, .. } = Self::get_metadata(ctx, &hash_vec)
                    .await
                    .or_raise(make_error)?;
                if maximum_length.is_some_and(|maximum_length| size > maximum_length) {
                    let maximum_length = maximum_length.expect("checked as present");
                    error!(
                        "Finalized blob is too big for this operation ({} > {})",
                        size, maximum_length,
                    );
                    bail!(Error::new(
                        format!(
                            "finalized blob is too big for this operation ({} > {} bytes)",
                            size, maximum_length,
                        ),
                        ErrorType::BlobTooBig,
                    ));
                }
                let content_type = match (content_type_label, content_type_description) {
                    (Some(label), Some(description)) => {
                        ContentTypeDescriptor { label, description }
                    }
                    _ => bail!(Error::new(
                        "moved pending blob has no content descriptor",
                        ErrorType::Blob,
                    )),
                };

                debug_assert_eq!(expected_length, size);

                FinalizeBlobUploadOutput {
                    s3_hash: slice_to_blob_hash(&hash_vec),
                    mime,
                    size,
                    content_type,
                    created: false,
                }
            }
        };

        Ok(output)
    }

    pub async fn finish_unscoped_upload(
        ctx: &ServiceContext<'_>,
        user_id: i64,
        pending_blob_id: &str,
    ) -> Result<FinalizeBlobUploadOutput> {
        Self::finish_upload(
            ctx,
            user_id,
            pending_blob_id,
            PendingBlobOwner::Unscoped,
            None,
        )
        .await
    }

    fn is_raster_avatar_mime(mime: &str) -> bool {
        matches!(
            mime.split(';')
                .next()
                .unwrap_or("")
                .trim()
                .to_ascii_lowercase()
                .as_str(),
            "image/png" | "image/jpeg" | "image/webp" | "image/gif"
        )
    }

    pub async fn finish_avatar_upload(
        ctx: &ServiceContext<'_>,
        user_id: i64,
        pending_blob_id: &str,
    ) -> Result<FinalizeBlobUploadOutput> {
        let output = Self::finish_upload(
            ctx,
            user_id,
            pending_blob_id,
            PendingBlobOwner::Unscoped,
            Some(ctx.config().maximum_avatar_size),
        )
        .await?;

        if !Self::is_raster_avatar_mime(&output.mime) {
            return Err(Error::new(
                format!(
                    "avatar upload has non-raster content type '{}'; avatars must be PNG, JPEG, WebP, or GIF",
                    output.mime,
                ),
                ErrorType::Blob,
            )
            .into());
        }

        Ok(output)
    }

    pub async fn finish_page_upload(
        ctx: &ServiceContext<'_>,
        user_id: i64,
        site_id: i64,
        page_id: i64,
        pending_blob_id: &str,
    ) -> Result<FinalizeBlobUploadOutput> {
        Self::finish_upload(
            ctx,
            user_id,
            pending_blob_id,
            PendingBlobOwner::Page { site_id, page_id },
            None,
        )
        .await
    }

    pub async fn prune(ctx: &ServiceContext<'_>) -> Result<()> {
        let txn = ctx.transaction();
        let bucket = ctx.s3_files_bucket();
        info!("Pruning expired pending blobs from database and S3");

        let make_error =
            || Error::new("failed to prune expired pending blobs", ErrorType::Blob);

        let pending_blobs = BlobPending::find()
            .select_only()
            .column(blob_pending::Column::ExternalId)
            .column(blob_pending::Column::S3Path)
            .filter(blob_pending::Column::ExpiresAt.lte(now()))
            .into_tuple::<(String, String)>()
            .all(txn)
            .await
            .or_raise(make_error)?;

        for (_, s3_path) in &pending_blobs {
            if Self::exists(ctx, s3_path).await.or_raise(make_error)? {
                bucket.delete_object(&s3_path).await.or_raise(make_error)?;
            }
        }

        let blob_ids = pending_blobs.into_iter().map(|(id, _)| id);

        BlobPending::delete_many()
            .filter(blob_pending::Column::ExternalId.is_in(blob_ids))
            .exec(txn)
            .await
            .or_raise(make_error)?;

        Ok(())
    }

    pub async fn hard_delete_preview(
        ctx: &ServiceContext<'_>,
        s3_hash: &[u8],
    ) -> Result<HardDeleteOutput> {
        Self::require_platform_staff(ctx, "preview blob hard deletion")?;
        let s3_hash = Self::checked_blob_hash(s3_hash)?;

        Self::hard_delete_inner(ctx, HardDeleteInner::DryRun { s3_hash })
            .await
            .or_raise(|| Error::new("failed to preview hard deletion", ErrorType::Blob))
    }

    pub async fn hard_delete_all(
        ctx: &ServiceContext<'_>,
        HardDelete { s3_hash }: HardDelete,
    ) -> Result<HardDeleteOutput> {
        let user_id = Self::require_platform_staff(ctx, "confirm blob hard deletion")?;
        let s3_hash = Self::checked_blob_hash(s3_hash.as_ref())?;

        Self::hard_delete_inner(ctx, HardDeleteInner::Commit { s3_hash, user_id })
            .await
            .or_raise(|| Error::new(
                format!(
                    "failed to hard delete all instances of a blob, performed by user ID {}",
                    user_id,
                ),
                ErrorType::Blob,
            ))
    }

    fn checked_blob_hash(slice: &[u8]) -> Result<BlobHash> {
        match try_slice_to_blob_hash(slice) {
            Some(hash) => Ok(hash),
            None => Err(Error::new(
                format!(
                    "blob hash must be {BLOB_HASH_LENGTH} bytes, but got {} bytes",
                    slice.len(),
                ),
                ErrorType::BadRequest,
            )
            .into()),
        }
    }

    fn require_platform_staff(ctx: &ServiceContext<'_>, action: &str) -> Result<i64> {
        let user_id = ctx.request().user_id().or_raise(|| {
            Error::new(
                format!("{action} requires an admin request context"),
                ErrorType::PermissionDenied,
            )
        })?;

        if user_id != ADMIN_USER_ID {
            bail!(Error::new(
                format!("{action} requires an admin request context"),
                ErrorType::PermissionDenied,
            ));
        }

        Ok(user_id)
    }

    async fn hard_delete_inner(
        ctx: &ServiceContext<'_>,
        input: HardDeleteInner,
    ) -> Result<HardDeleteOutput> {
        let txn = ctx.transaction();
        let (s3_hash, deleter_user_id) = match input {
            HardDeleteInner::Commit { s3_hash, user_id } => (s3_hash, Some(user_id)),
            HardDeleteInner::DryRun { s3_hash } => (s3_hash, None),
        };

        let make_error = || {
            Error::new(
                format!(
                    "failed to perform hard deletion operation for blob '{}'",
                    blob_hash_to_hex(&s3_hash),
                ),
                ErrorType::Blob,
            )
        };

        Self::check_hash_not_empty(s3_hash).or_raise(make_error)?;

        let mut revisions = SamplerCounter::new();
        let mut files = SamplerCounter::new();
        let mut pages = SamplerCounter::new();
        let mut sites = SamplerCounter::new();
        let mut total_files_deleted = 0;

        match deleter_user_id {
            None => info!(
                "Checking result of hard deletion of all blobs matching hash {}",
                blob_hash_to_hex(&s3_hash),
            ),
            Some(user_id) => {
                info!(
                    "Hard deleting all blobs matching hash {} (done by user ID {})",
                    blob_hash_to_hex(&s3_hash),
                    user_id,
                );
            }
        }

        #[derive(Debug, FromQueryResult)]
        struct LatestFileRevision {
            site_id: i64,
            page_id: i64,
            file_id: i64,
            revision_id: i64,
        }

        let query = Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            str!("
                SELECT
                    f.site_id AS site_id,
                    f.page_id AS page_id,
                    f.file_id AS file_id,
                    r1.revision_id AS revision_id
                FROM file AS f
                JOIN file_revision AS r1
                    ON f.file_id = r1.file_id
                LEFT OUTER JOIN file_revision AS r2
                    ON (f.file_id = r2.file_id AND r1.revision_number < r2.revision_number)
                WHERE r2.revision_id IS NULL
                AND r1.s3_hash = $1
                AND f.deleted_at IS NULL
            "),
            [Value::from(s3_hash.to_vec())],
        );

        {
            let latest_revisions = FileRevision::find()
                .from_raw_sql(query)
                .into_model::<LatestFileRevision>()
                .all(txn)
                .await
                .or_raise(make_error)?;

            for LatestFileRevision {
                site_id,
                page_id,
                file_id,
                revision_id,
            } in latest_revisions
            {
                total_files_deleted += 1;

                if deleter_user_id.is_some() {
                    FileService::delete_with_erased_s3_hash(
                        ctx,
                        DeleteFile {
                            site_id,
                            page_id,
                            file: file_id.into(),
                            last_revision_id: revision_id,
                            revision_comments: format!(
                                "Hard delete {}",
                                blob_hash_to_hex(&s3_hash)
                            ),
                            user_id: SYSTEM_USER_ID,
                        },
                    )
                    .await
                    .or_raise(make_error)?;
                }
            }
        }

        {
            let mut results = FileRevision::find()
                .filter(file_revision::Column::S3Hash.eq(s3_hash.as_slice()))
                .paginate(txn, 20);

            while let Some(revs) = results.fetch_and_next().await.or_raise(make_error)? {
                for rev in revs {
                    revisions.add(rev.revision_id);
                    files.add(rev.file_id);
                    pages.add(rev.page_id);
                    sites.add(rev.site_id);

                    if deleter_user_id.is_some() {
                        let hidden = {
                            let column = str!("s3_hash");
                            let mut hidden = rev.hidden;
                            if !hidden.contains(&column) {
                                hidden.push(column);
                                hidden.sort();
                            }
                            hidden
                        };

                        let model = file_revision::ActiveModel {
                            revision_id: Set(rev.revision_id),
                            s3_hash: Set(EMPTY_BLOB_HASH.to_vec()),
                            hidden: Set(hidden),
                            ..Default::default()
                        };

                        model.update(txn).await.or_raise(make_error)?;
                    }
                }
            }
        }

        let sample_user_ids: Vec<i64> = User::find()
            .select_only()
            .column(user::Column::UserId)
            .filter(user::Column::AvatarS3Hash.eq(s3_hash.as_slice()))
            .limit(u64::from(SAMPLE_COUNT))
            .into_tuple()
            .all(txn)
            .await
            .or_raise(make_error)?;

        let total_users: u64 = match deleter_user_id {
            Some(_) => {
                let model = user::ActiveModel {
                    avatar_s3_hash: Set(None),
                    ..Default::default()
                };

                User::update_many()
                    .set(model)
                    .filter(user::Column::AvatarS3Hash.eq(s3_hash.as_slice()))
                    .exec(txn)
                    .await
                    .or_raise(make_error)?
                    .rows_affected
            }
            None => {
                User::find()
                    .select_only()
                    .column_as(user::Column::UserId.count(), "count")
                    .filter(user::Column::AvatarS3Hash.eq(s3_hash.as_slice()))
                    .into_tuple::<i64>() // Postgres cannot return u64 as a column type
                    .one(txn)
                    .await
                    .or_raise(make_error)?
                    .expect("No results from COUNT aggregate query")
                    .try_into_u64()
                    .or_raise(make_error)?
            }
        };

        if deleter_user_id.is_some() {
            let (result1, result2) = join!(
                BlobService::add_blacklist(ctx, s3_hash),
                BlobService::hard_delete(ctx, &s3_hash),
            );
            raise_multiple!(result1, result2; make_error);
        }

        let (total_revisions, sample_revision_ids) = revisions.finish();
        let (total_files, sample_file_ids) = files.finish();
        let (total_pages, sample_page_ids) = pages.finish();
        let (total_sites, sample_site_ids) = sites.finish();

        Ok(HardDeleteOutput {
            total_revisions,
            total_files,
            total_files_deleted,
            total_pages,
            total_sites,
            total_users,
            sample_revision_ids,
            sample_file_ids,
            sample_page_ids,
            sample_site_ids,
            sample_user_ids,
        })
    }

    pub(crate) fn check_hash_not_empty(hash: BlobHash) -> Result<()> {
        if hash == EMPTY_BLOB_HASH {
            error!("Cannot hard delete the empty blob");
            bail!(Error::new(
                "cannot hard delete the empty blob",
                ErrorType::BadRequest,
            ));
        }

        Ok(())
    }

    pub(crate) async fn check_hash_in_use(
        ctx: &ServiceContext<'_>,
        hash: BlobHash,
    ) -> Result<()> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to check whether blob hash '{}' is in use anywhere",
                    blob_hash_to_hex(&hash),
                ),
                ErrorType::Blob,
            )
        };

        let txn = ctx.transaction();
        let count = FileRevision::find()
            .select_only()
            .column_as(file_revision::Column::RevisionId.count(), "count")
            .filter(file_revision::Column::S3Hash.eq(hash.as_slice()))
            .into_tuple::<i64>()
            .one(txn)
            .await
            .or_raise(make_error)?
            .expect("No results from COUNT aggregate query");

        if count > 0 {
            error!(
                "Cannot blacklist a blob that is currently in use (found {count} uses)"
            );
            bail!(Error::new(
                format!(
                    "cannot blacklist a blob that is currently in use (found {} uses)",
                    count,
                ),
                ErrorType::BlobCannotBlacklistExisting
            ));
        }

        debug!("Found no current uses of blob to be blacklisted");
        Ok(())
    }

    pub async fn add_blacklist(ctx: &ServiceContext<'_>, hash: BlobHash) -> Result<()> {
        let created_by = Self::require_platform_staff(ctx, "add a blob blacklist entry")?;
        info!("Adding hash {} to blacklist", blob_hash_to_hex(&hash));

        let make_error =
            || Error::new("failed to add blob to blacklist", ErrorType::Blob);
        Self::check_hash_not_empty(hash).or_raise(make_error)?;
        Self::check_hash_in_use(ctx, hash)
            .await
            .or_raise(make_error)?;

        debug_assert_ne!(
            hash, EMPTY_BLOB_HASH,
            "Empty blob hash passed to add_blacklist()",
        );

        if Self::on_blacklist(ctx, hash).await.or_raise(make_error)? {
            debug!("Already blacklisted, skipping");
            return Ok(());
        }

        let txn = ctx.transaction();
        let model = blob_blacklist::ActiveModel {
            s3_hash: Set(hash.to_vec()),
            created_by: Set(created_by),
            ..Default::default()
        };
        model.insert(txn).await.or_raise(make_error)?;
        Ok(())
    }

    pub async fn remove_blacklist(
        ctx: &ServiceContext<'_>,
        hash: BlobHash,
    ) -> Result<()> {
        Self::require_platform_staff(ctx, "remove a blob blacklist entry")?;
        info!("Removing hash {} to blacklist", blob_hash_to_hex(&hash));

        let txn = ctx.transaction();
        BlobBlacklist::delete_by_id(hash.to_vec())
            .exec(txn)
            .await
            .or_raise(|| {
                Error::new(
                    format!(
                        "failed to remove blob '{}' from blacklist",
                        blob_hash_to_hex(&hash),
                    ),
                    ErrorType::Blob,
                )
            })?;

        Ok(())
    }

    pub async fn on_blacklist(ctx: &ServiceContext<'_>, hash: BlobHash) -> Result<bool> {
        info!(
            "Checking if hash {} is on blacklist",
            blob_hash_to_hex(&hash),
        );

        let make_error = || {
            Error::new(
                format!(
                    "failed to check if blob '{}' is on the blacklist",
                    blob_hash_to_hex(&hash),
                ),
                ErrorType::Blob,
            )
        };

        let txn = ctx.transaction();
        let exists = BlobBlacklist::find()
            .filter(blob_blacklist::Column::S3Hash.eq(hash.as_slice()))
            .one(txn)
            .await
            .or_raise(make_error)?
            .is_some();

        Ok(exists)
    }

    pub async fn get_optional(
        ctx: &ServiceContext<'_>,
        hash: &[u8],
    ) -> Result<Option<Vec<u8>>> {
        if hash == EMPTY_BLOB_HASH {
            debug!("Returning the empty blob");
            return Ok(Some(Vec::new()));
        }

        let bucket = ctx.s3_files_bucket();
        let hex_hash = blob_hash_to_hex(hash);
        let response = bucket
            .get_object(&hex_hash)
            .await
            .or_raise(|| Error::new("failed to get blob", ErrorType::Blob))?;

        match response.status_code() {
            200 => Ok(Some(response.into())),
            404 => Ok(None),
            _ => bail!(s3_error(&response, "fetching S3 blob")),
        }
    }

    #[inline]
    pub async fn get(ctx: &ServiceContext<'_>, hash: &[u8]) -> Result<Vec<u8>> {
        find_or_error!(Self::get_optional(ctx, hash), "blob", Blob)
    }

    pub async fn get_metadata_optional(
        ctx: &ServiceContext<'_>,
        hash: &[u8],
    ) -> Result<Option<BlobMetadata>> {
        let hex_hash = blob_hash_to_hex(hash);
        let make_error = || {
            Error::new(
                format!("failed to get blob metadata for '{}'", hex_hash),
                ErrorType::Blob,
            )
        };

        if hash == EMPTY_BLOB_HASH {
            return Ok(Some(BlobMetadata {
                mime: str!(EMPTY_BLOB_MIME),
                size: 0,
                created_at: OffsetDateTime::from_unix_timestamp(EMPTY_BLOB_TIMESTAMP)
                    .or_raise(make_error)?,
            }));
        }

        match Self::head(ctx, &hex_hash).await.or_raise(make_error)? {
            None => Ok(None),
            Some(result) => {
                let make_error = || {
                    let mut error = make_error();
                    error.error_type = ErrorType::BlobBackend;
                    error
                };

                let size = result.content_length.ok_or_raise(make_error)?;
                let mime = result.content_type.ok_or_raise(make_error)?;
                let created_at = {
                    let timestamp = result.last_modified.ok_or_raise(make_error)?;
                    OffsetDateTime::parse(&timestamp, &Rfc2822).or_raise(make_error)?
                };

                Ok(Some(BlobMetadata {
                    mime,
                    size,
                    created_at,
                }))
            }
        }
    }

    #[inline]
    pub async fn get_metadata(
        ctx: &ServiceContext<'_>,
        hash: &[u8],
    ) -> Result<BlobMetadata> {
        find_or_error!(Self::get_metadata_optional(ctx, hash), "blob", Blob)
    }

    pub async fn fetch_if_requested(
        ctx: &ServiceContext<'_>,
        requested: bool,
        hash: &[u8],
    ) -> Result<Option<Vec<u8>>> {
        if requested {
            let data = Self::get(ctx, hash).await.or_raise(|| {
                Error::new("failed to conditionally get blob data", ErrorType::Blob)
            })?;

            Ok(Some(data))
        } else {
            Ok(None)
        }
    }

    async fn head(
        ctx: &ServiceContext<'_>,
        path: &str,
    ) -> Result<Option<HeadObjectResult>> {
        let bucket = ctx.s3_files_bucket();
        let (result, status) = bucket.head_object(path).await.or_raise(|| {
            Error::new(
                format!("failed to HEAD existence of S3 object '{}'", path),
                ErrorType::Blob,
            )
        })?;

        match status {
            200 | 204 => Ok(Some(result)),
            404 => Ok(None),
            _ => {
                let response = ResponseData::new(Bytes::new(), status, HashMap::new());
                bail!(s3_error(&response, "heading S3 blob"));
            }
        }
    }

    async fn exists(ctx: &ServiceContext<'_>, path: &str) -> Result<bool> {
        let head = Self::head(ctx, path)
            .await
            .or_raise(|| Error::new("failed to check blob existence", ErrorType::Blob))?;

        Ok(head.is_some())
    }

    pub(crate) async fn blob_exists(
        ctx: &ServiceContext<'_>,
        hash: &[u8],
    ) -> Result<bool> {
        let hex_hash = blob_hash_to_hex(hash);
        Self::exists(ctx, &hex_hash)
            .await
            .or_raise(|| Error::new("failed to check blob existence", ErrorType::Blob))
    }

    pub async fn hard_delete(ctx: &ServiceContext<'_>, hash: &[u8]) -> Result<()> {
        if hash == EMPTY_BLOB_HASH {
            debug!("Ignoring attempt to hard delete the empty blob");
            return Ok(());
        }

        let bucket = ctx.s3_files_bucket();
        let hex_hash = blob_hash_to_hex(hash);

        let response = bucket
            .delete_object(&hex_hash)
            .await
            .or_raise(|| Error::new("failed to hard delete blob", ErrorType::Blob))?;

        match response.status_code() {
            204 => Ok(()),
            _ => bail!(s3_error(&response, "hard-deleting S3 blob")),
        }
    }
}

#[must_use]
fn s3_error(response: &ResponseData, action: &str) -> Error {
    let error_message = match str::from_utf8(response.bytes()) {
        Ok("") => match response.status_code() {
            507 => "insufficient storage",
            _ => "(no content)",
        },
        Ok(m) => m,
        Err(_) => "(invalid UTF-8)",
    };

    error!(
        "Error while {} (HTTP {}): {}",
        action,
        response.status_code(),
        error_message,
    );
    Error::new(
        format!(
            "failed {}, (HTTP {}): {}",
            action,
            response.status_code(),
            error_message,
        ),
        ErrorType::BlobBackend,
    )
}

#[derive(Debug)]
enum HardDeleteInner {
    Commit { s3_hash: BlobHash, user_id: i64 },
    DryRun { s3_hash: BlobHash },
}

#[derive(Debug)]
struct PendingBlob {
    s3_path: String,
    expected_length: i64,
    moved_hash: Option<Vec<u8>>,
    content_type_label: Option<String>,
    content_type_description: Option<String>,
}

#[derive(Debug)]
struct SamplerCounter<T: Hash + Ord + Eq> {
    items: HashSet<T>,
}

impl<T: Hash + Ord + Eq> SamplerCounter<T> {
    #[inline]
    fn new() -> Self {
        SamplerCounter {
            items: HashSet::new(),
        }
    }

    fn add(&mut self, item: T) {
        self.items.insert(item);
    }

    fn finish(self) -> (usize, Vec<T>) {
        let count = self.items.len();
        let samples = {
            let mut samples = self
                .items
                .into_iter()
                .take(usize::from(SAMPLE_COUNT))
                .collect::<Vec<_>>();

            samples.sort();
            samples
        };

        (count, samples)
    }
}
