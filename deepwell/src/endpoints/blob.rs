/*
 * endpoints/blob.rs
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
use crate::hash::{BLOB_HASH_LENGTH, BlobHash, try_slice_to_blob_hash};
use crate::services::MutationAuthorization;
use crate::services::blob::{
    BlobMetadata, CancelBlobUpload, HardDelete, HardDeleteOutput, PendingBlobOwner,
    PublicBlobByHash, StartBlobUpload, StartBlobUploadOutput, StartBlobUploadScope,
};
use crate::types::Action;
use crate::types::Bytes;

fn parse_s3_hash(bytes: &[u8]) -> Result<BlobHash> {
    match try_slice_to_blob_hash(bytes) {
        Some(hash) => Ok(hash),
        None => Err(Error::new(
            format!(
                "blob hash must be {BLOB_HASH_LENGTH} bytes, but got {} bytes",
                bytes.len(),
            ),
            ErrorType::BadRequest,
        )
        .into()),
    }
}

pub async fn blob_get(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<PublicBlobByHash> {
    let hash: Bytes = parse!(params, Blob);

    let make_error = || Error::new("failed to get blob data", ErrorType::Blob);

    let data = BlobService::get_optional(ctx, hash.as_ref())
        .await
        .or_raise(make_error)?;

    let authorized = match data {
        Some(_) => BlobService::can_read(ctx, hash.as_ref())
            .await
            .or_raise(make_error)?,
        None => false,
    };

    let data = match data {
        Some(data) if authorized => data,
        _ => {
            return Err(Error::new("blob does not exist", ErrorType::BlobNotFound).into());
        }
    };

    let BlobMetadata {
        mime,
        size,
        created_at,
    } = BlobService::get_metadata(ctx, hash.as_ref())
        .await
        .or_raise(make_error)?;

    Ok(PublicBlobByHash {
        data,
        mime,
        size,
        created_at,
    })
}

pub async fn blob_cancel(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<()> {
    info!("Cancelling a pending blob upload");

    let CancelBlobUpload {
        user_id,
        pending_blob_id,
    } = parse!(params, Blob);
    MutationAuthorization::require_matching_actor(
        ctx,
        user_id,
        "cancel a pending blob upload",
    )?;

    BlobService::cancel_upload(ctx, user_id, &pending_blob_id)
        .await
        .or_raise(|| {
            Error::new("failed to cancel a pending blob upload", ErrorType::Blob)
        })
}

pub async fn blob_upload(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<StartBlobUploadOutput> {
    info!("Creating new pending blob upload");
    let input: StartBlobUpload = parse!(params, Blob);
    MutationAuthorization::require_matching_actor(
        ctx,
        input.user_id,
        "start a blob upload",
    )?;

    let owner = match input.scope {
        StartBlobUploadScope::Unscoped => PendingBlobOwner::Unscoped,
        StartBlobUploadScope::Page => {
            let site_id = ctx.request().site_id().or_raise(|| {
                Error::new(
                    "page upload requires a trusted site request context",
                    ErrorType::PermissionDenied,
                )
            })?;
            let page_reference = ctx.request().page_reference().or_raise(|| {
                Error::new(
                    "page upload requires a trusted page request context",
                    ErrorType::PermissionDenied,
                )
            })?;
            let page = PageService::get(ctx, site_id, page_reference.clone())
                .await
                .or_raise(|| {
                    Error::new(
                        "failed to resolve the page upload request context",
                        ErrorType::Blob,
                    )
                })?;
            if !PageService::check_user_permission(ctx, Action::Edit)
                .await
                .or_raise(|| {
                    Error::new(
                        "failed to check page upload permission",
                        ErrorType::Permission,
                    )
                })?
            {
                return Err(Error::new(
                    "user does not have permission to upload to this page",
                    ErrorType::PermissionDenied,
                )
                .into());
            }
            PendingBlobOwner::Page {
                site_id,
                page_id: page.page_id,
            }
        }
    };

    BlobService::start_upload(ctx, input.user_id, input.blob_size, owner)
        .await
        .or_raise(|| Error::new("failed to start a blob upload", ErrorType::Blob))
}

pub async fn blob_blacklist_add(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<()> {
    #[derive(Deserialize, Debug)]
    struct AddBlacklist {
        s3_hash: Bytes<'static>,
    }

    let make_error =
        || Error::new("failed to add a blob to the blacklist", ErrorType::Blob);

    let AddBlacklist { s3_hash } = params.parse().or_raise(make_error)?;
    let s3_hash = parse_s3_hash(s3_hash.as_ref())?;

    BlobService::add_blacklist(ctx, s3_hash)
        .await
        .or_raise(make_error)
}

pub async fn blob_blacklist_remove(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<()> {
    #[derive(Deserialize, Debug)]
    struct RemoveBlacklist {
        s3_hash: Bytes<'static>,
    }

    let make_error = || {
        Error::new(
            "failed to remove a blob from the blacklist",
            ErrorType::Blob,
        )
    };

    let RemoveBlacklist { s3_hash } = params.parse().or_raise(make_error)?;
    let s3_hash = parse_s3_hash(s3_hash.as_ref())?;

    BlobService::remove_blacklist(ctx, s3_hash)
        .await
        .or_raise(make_error)
}

pub async fn blob_blacklist_check(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<bool> {
    #[derive(Deserialize, Debug)]
    struct HasBlacklist {
        s3_hash: Bytes<'static>,
    }

    let HasBlacklist { s3_hash } = parse!(params, Blob);
    let s3_hash = parse_s3_hash(s3_hash.as_ref())?;

    BlobService::on_blacklist(ctx, s3_hash).await.or_raise(|| {
        Error::new(
            "failed to check a blob against the blacklist",
            ErrorType::Blob,
        )
    })
}

pub async fn blob_hard_delete_preview(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<HardDeleteOutput> {
    #[derive(Deserialize, Debug)]
    struct HardDeletePreview {
        s3_hash: Bytes<'static>,
    }

    let HardDeletePreview { s3_hash } = parse!(params, Blob);

    BlobService::hard_delete_preview(ctx, s3_hash.as_ref())
        .await
        .or_raise(|| {
            Error::new("failed to preview a blob hard deletion", ErrorType::Blob)
        })
}

pub async fn blob_hard_delete_confirm(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<HardDeleteOutput> {
    let input: HardDelete = parse!(params, Blob);

    BlobService::hard_delete_all(ctx, input)
        .await
        .or_raise(|| Error::new("failed to hard delete a blob", ErrorType::Blob))
}

#[cfg(test)]
mod tests {
    use super::parse_s3_hash;
    use crate::error::ErrorType;

    #[test]
    fn s3_hash_accepts_128_hex_char_hash() {
        let bytes = hex::decode("ab".repeat(64)).expect("valid hex");

        assert!(parse_s3_hash(&bytes).is_ok());
    }

    #[test]
    fn s3_hash_rejects_96_hex_char_hash() {
        let bytes = hex::decode("ab".repeat(48)).expect("valid hex");
        assert_eq!(bytes.len(), 48);

        let error = parse_s3_hash(&bytes).expect_err("48-byte hash must fail");

        assert_eq!(error.error_type, ErrorType::BadRequest);
    }

    #[test]
    fn s3_hash_rejects_empty_and_odd_lengths() {
        assert!(parse_s3_hash(&[]).is_err());
        assert!(parse_s3_hash(&[0x5a; 63]).is_err());
        assert!(parse_s3_hash(&[0x5a; 65]).is_err());
        assert!(parse_s3_hash(&[0x5a; 1]).is_err());
    }
}
