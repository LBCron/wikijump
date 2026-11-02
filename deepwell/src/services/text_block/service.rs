/*
 * services/text_block/service.rs
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

//! Manages the storage for hosted text blocks.
//!
//! This does _not_ have any methods for doing CRUD
//! on individual entries, since text blocks are only
//! updated when the underlying page is, which means
//! they all get replaced in one operation.
//!
//! The only other operation is page deletion, where
//! all the hosted text block data is removed.
//! (If a page is resurrected, then all this data gets
//! re-inserted as part of creating the new revision.)
//!
//! Additionally, WWS fetches text blocks directly from S3.

use super::structs::{TextBlock, TextBlockIndex};
use crate::error::prelude::{Error, ErrorType, Result, ResultExt, StdResult};
use crate::models::page;
use crate::models::text_block::{self, Entity as TextBlockTable};
use crate::runtime::ServerState;
use crate::services::ServiceContext;
use crate::types::TextBlockType;
use crate::utils::ConvertToI16;
use futures::{StreamExt, stream::FuturesUnordered};
use s3::bucket::Bucket;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, ConnectionTrait, DatabaseTransaction,
    DbErr, EntityTrait, JoinType, QueryFilter, QueryOrder, QuerySelect, RelationTrait,
    Set, SqlErr, Statement, TransactionTrait,
};
use sha1::{Digest, Sha1};
use std::collections::HashSet;
use uuid::Uuid;

/// Keep each SeaORM insert well below PostgreSQL's 65,535 bind-parameter limit.
const TEXT_BLOCK_INSERT_BATCH_SIZE: usize = 1_000;

/// Bound concurrent object-store writes while avoiding one network round trip per block.
const TEXT_BLOCK_UPLOAD_CONCURRENCY: usize = 16;

/// How many times `add_blocks` attempts its row replacement when a
/// concurrent replacement for the same page wins the commit race.
const TEXT_BLOCK_REPLACE_ATTEMPTS: u32 = 3;

const TEXT_BLOCK_WIKIDOT_SHA1_BACKFILL_BATCH_SIZE: u64 = 256;
const MAX_TEXT_BLOCK_OBJECT_BYTES: usize = 16 * 1024 * 1024;

/// ponytail: 32-candidate fail-closed ceiling; upgrade to permission-filtered SQL when visibility can be resolved in the query.
const MAX_WIKIDOT_SHA1_CANDIDATES: usize = 32;

async fn sha1_s3_object(bucket: &Bucket, s3_filename: &str) -> Result<Vec<u8>> {
    let s3::request::request_trait::ResponseDataStream {
        mut bytes,
        status_code,
    } = bucket
        .get_object_stream(s3_filename)
        .await
        .map_err(|error| {
            Error::new(
                format!(
                    "failed to fetch legacy HTML text block '{s3_filename}': {error}"
                ),
                ErrorType::TextBlock,
            )
        })?;
    if status_code != 200 {
        return Err(Error::new(
            format!(
                "S3 returned HTTP {status_code} for legacy HTML text block '{s3_filename}'"
            ),
            ErrorType::TextBlock,
        )
        .into());
    }

    let mut total: usize = 0;
    let mut digest = Sha1::new();
    while let Some(chunk) = bytes.next().await {
        let chunk = chunk.map_err(|error| {
            Error::new(
                format!("failed to read legacy HTML text block '{s3_filename}': {error}"),
                ErrorType::TextBlock,
            )
        })?;
        total = total.checked_add(chunk.len()).ok_or_else(|| {
            Error::new(
                format!("legacy HTML text block '{s3_filename}' is too large"),
                ErrorType::TextBlock,
            )
        })?;
        if total > MAX_TEXT_BLOCK_OBJECT_BYTES {
            return Err(Error::new(
                format!(
                    "legacy HTML text block '{s3_filename}' exceeds {MAX_TEXT_BLOCK_OBJECT_BYTES} bytes"
                ),
                ErrorType::TextBlock,
            )
            .into());
        }
        digest.update(&chunk);
    }
    Ok(digest.finalize().to_vec())
}

async fn cleanup_uploaded_text_blocks(bucket: &Bucket, filenames: &[String]) {
    for filename in filenames {
        if let Err(error) = bucket.delete_object(filename).await {
            warn!("Failed to clean up uploaded S3 text block '{filename}': {error}");
        }
    }
}

#[derive(Debug)]
pub struct TextBlockService;

impl TextBlockService {
    /// Validates both hosted text block collections for a page.
    ///
    /// Render preflights both counts together before writing either collection
    /// to S3, so an invalid later collection cannot leave objects from the
    /// earlier collection behind when the database transaction rolls back.
    pub(crate) fn validate_page_block_counts(
        html_count: usize,
        code_count: usize,
    ) -> StdResult<(), std::num::TryFromIntError> {
        max_text_block_index(html_count)?;
        max_text_block_index(code_count)?;
        Ok(())
    }

    /// Replaces the text blocks associated with this page with the ones given.
    ///
    /// This is to be run after ftml returns the lists of code and html blocks
    /// found in the source, which will replace the existing text block data
    /// to be replaced.
    pub async fn add_blocks(
        ctx: &ServiceContext<'_>,
        page_id: i64,
        block_type: TextBlockType,
        blocks: &[TextBlock<'_>],
    ) -> Result<()> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to insert {} new {} text blocks for page ID {}",
                    blocks.len(),
                    block_type_name(block_type),
                    page_id,
                ),
                ErrorType::TextBlock,
            )
        };

        info!(
            "Inserting {} {} text blocks for page ID {}",
            blocks.len(),
            block_type_name(block_type),
            page_id,
        );

        let txn = ctx.transaction();
        let bucket = ctx.s3_tblocks_bucket();

        // First, get the stored filenames for this block type.
        // After the new blocks are uploaded and the transaction commits, all
        // old filenames are removed from S3.
        let previous_filenames =
            Self::get_block_s3_filenames(ctx, page_id, Some(block_type))
                .await
                .or_raise(make_error)?;

        // If there's no additional work for us, quit early

        if blocks.is_empty() && previous_filenames.is_empty() {
            debug!("Not inserting any blocks, no prior blocks to remove");
            return Ok(());
        }

        // Validate the maximum 1-indexed block index before uploading
        // anything to S3. S3 writes are external side effects and are not
        // rolled back with the database transaction, so all deterministic
        // range errors must happen before the first upload.
        let max_index = max_text_block_index(blocks.len()).or_raise(make_error)?;

        // Prepare and validate the complete replacement before starting external
        // writes. The object-store uploads then run with bounded concurrency so a
        // page containing many hosted blocks does not pay one network round trip
        // after another.
        let mut uploads = Vec::with_capacity(blocks.len());
        let mut models = Vec::with_capacity(blocks.len());
        let mut new_filenames = Vec::with_capacity(blocks.len());
        let mut previous_block_names = HashSet::with_capacity(blocks.len());
        for (index, block) in (1..=max_index).zip(blocks.iter()) {
            let &TextBlock {
                text,
                text_type,
                mime,
                mut name,
            } = block;

            // Deny invalid block names
            if let Some(mut value) = name {
                value = value.trim();
                if !valid_block_name(&mut previous_block_names, value) {
                    name = None;
                }
            }

            let filename = format!(
                "text-blocks/{page_id}/{}/{}",
                block_type_name(block_type),
                Uuid::new_v4()
            );
            uploads.push((filename.clone(), text, mime));

            models.push(text_block::ActiveModel {
                block_type: Set(block_type),
                page_id: Set(page_id),
                block_index: Set(index),
                s3_filename: Set(filename.clone()),
                block_name: Set(name.map(String::from)),
                text_type: Set(text_type.map(String::from)),
                wikidot_sha1: Set(matches!(block_type, TextBlockType::Html)
                    .then(|| html_block_sha1(text))),
            });
            new_filenames.push(filename);
        }

        let upload_result: Result<()> = async {
            let mut pending_uploads = FuturesUnordered::new();
            for (filename, text, mime) in &uploads {
                pending_uploads.push(async move {
                    debug!("Uploading new S3 text block {filename} ({mime})");
                    bucket
                        .put_object_with_content_type(filename, text.as_bytes(), mime)
                        .await
                });
                if pending_uploads.len() == TEXT_BLOCK_UPLOAD_CONCURRENCY {
                    while let Some(result) = pending_uploads.next().await {
                        result.or_raise(make_error)?;
                    }
                }
            }
            while let Some(result) = pending_uploads.next().await {
                result.or_raise(make_error)?;
            }
            Ok(())
        }
        .await;
        if let Err(error) = upload_result {
            cleanup_uploaded_text_blocks(bucket, &new_filenames).await;
            return Err(error);
        }

        // Then, replace the blocks in the database.
        //
        // This doesn't require us to know which need to be kept
        // because we're just INSERTing over all of it.
        //
        // The replacement runs under a savepoint, with bounded retries.
        // The DELETE and the INSERTs are separate statements at READ
        // COMMITTED: if another replacement for the same page commits
        // while our DELETE is blocked on its rows, our statement
        // snapshot never sees the winner's rows, so our INSERT aborts
        // the transaction on the (block_type, page_id, block_index)
        // primary key (issue #3461). (That is also why no row-count
        // assertion belongs here: a DELETE that waited legitimately
        // deletes fewer rows than were read beforehand.) On that
        // unique violation, roll back to the savepoint and retry: the
        // retry re-reads the filenames that are actually there, and
        // those displaced objects are what the post-commit cleanup
        // below must delete. The winner's own cleanup covers the set
        // that was current when we started.
        let mut displaced_filenames = previous_filenames.clone();
        let database_result: Result<()> = async {
            let mut attempt = 0;
            loop {
                attempt += 1;
                match Self::replace_block_rows(txn, page_id, block_type, &models).await {
                    Ok(()) => break Ok(()),
                    Err(error) => {
                        let retryable = matches!(
                            error.sql_err(),
                            Some(SqlErr::UniqueConstraintViolation(_)),
                        );
                        if !retryable || attempt >= TEXT_BLOCK_REPLACE_ATTEMPTS {
                            break Err(error).or_raise(make_error);
                        }
                        debug!(
                            "Text block replacement for page ID {page_id} lost a concurrent-write race on attempt {attempt}; retrying",
                        );
                        displaced_filenames =
                            Self::get_block_s3_filenames(ctx, page_id, Some(block_type))
                                .await
                                .or_raise(make_error)?;
                    }
                }
            }
        }
        .await;
        if let Err(error) = database_result {
            cleanup_uploaded_text_blocks(bucket, &new_filenames).await;
            return Err(error);
        }

        if let Err(error) = ctx.defer_text_block_cleanup(displaced_filenames) {
            cleanup_uploaded_text_blocks(bucket, &new_filenames).await;
            return Err(error);
        }

        Ok(())
    }

    /// One attempt at replacing a page's block rows: delete the rows
    /// that are there, then insert the new ones, under a savepoint so
    /// that a failed attempt leaves the caller's transaction usable.
    async fn replace_block_rows(
        txn: &DatabaseTransaction,
        page_id: i64,
        block_type: TextBlockType,
        models: &[text_block::ActiveModel],
    ) -> StdResult<(), DbErr> {
        let nested = txn.begin().await?;
        let result: StdResult<(), DbErr> = async {
            TextBlockTable::delete_many()
                .filter(
                    Condition::all()
                        .add(text_block::Column::BlockType.eq(block_type))
                        .add(text_block::Column::PageId.eq(page_id)),
                )
                .exec(&nested)
                .await?;

            // Insert the new text block rows in bounded batches. SeaORM
            // emits one statement per insert_many call, so an unbounded batch can
            // exceed PostgreSQL's bind limit after the S3 uploads have succeeded.
            for range in text_block_insert_ranges(models.len()) {
                TextBlockTable::insert_many(models[range].iter().cloned())
                    .exec(&nested)
                    .await?;
            }
            Ok(())
        }
        .await;
        match result {
            Ok(()) => {
                nested.commit().await?;
                Ok(())
            }
            Err(error) => {
                let _ = nested.rollback().await;
                Err(error)
            }
        }
    }

    /// Populate the identity for legacy HTML rows before the server accepts requests.
    pub(crate) async fn backfill_wikidot_sha1(state: &ServerState) -> Result<()> {
        let make_error = || {
            Error::new(
                "failed to backfill Wikidot HTML block SHA-1 identities",
                ErrorType::TextBlock,
            )
        };
        let mut after = None;
        loop {
            let txn = state.database.begin().await.or_raise(make_error)?;
            let mut condition = Condition::all()
                .add(text_block::Column::BlockType.eq(TextBlockType::Html))
                .add(text_block::Column::WikidotSha1.is_null());
            if let Some((page_id, block_index)) = after {
                condition = condition.add(
                    Condition::any()
                        .add(text_block::Column::PageId.gt(page_id))
                        .add(
                            Condition::all()
                                .add(text_block::Column::PageId.eq(page_id))
                                .add(text_block::Column::BlockIndex.gt(block_index)),
                        ),
                );
            }
            let rows: Vec<(i64, i16, String)> = TextBlockTable::find()
                .select_only()
                .column(text_block::Column::PageId)
                .column(text_block::Column::BlockIndex)
                .column(text_block::Column::S3Filename)
                .filter(condition)
                .order_by_asc(text_block::Column::PageId)
                .order_by_asc(text_block::Column::BlockIndex)
                .limit(TEXT_BLOCK_WIKIDOT_SHA1_BACKFILL_BATCH_SIZE)
                .lock_with_behavior(
                    sea_orm::sea_query::LockType::Update,
                    sea_orm::sea_query::LockBehavior::SkipLocked,
                )
                .into_tuple()
                .all(&txn)
                .await
                .or_raise(make_error)?;
            if rows.is_empty() {
                txn.commit().await.or_raise(make_error)?;
                break;
            }
            after = rows
                .last()
                .map(|(page_id, block_index, _)| (*page_id, *block_index));

            for (page_id, block_index, s3_filename) in rows {
                let digest = match sha1_s3_object(&state.s3_tblocks_bucket, &s3_filename)
                    .await
                {
                    Ok(digest) => digest,
                    Err(error) => {
                        warn!(
                            "unable to backfill legacy HTML text block for page ID {page_id}, block {block_index}, object '{s3_filename}': {error}",
                        );
                        return Err(error);
                    }
                };
                text_block::ActiveModel {
                    block_type: Set(TextBlockType::Html),
                    page_id: Set(page_id),
                    block_index: Set(block_index),
                    wikidot_sha1: Set(Some(digest)),
                    ..Default::default()
                }
                .update(&txn)
                .await
                .or_raise(make_error)?;
            }
            txn.commit().await.or_raise(make_error)?;
        }

        Ok(())
    }

    pub(crate) async fn validate_wikidot_sha1_constraint(
        state: &ServerState,
    ) -> Result<()> {
        let txn = state.database.begin().await.or_raise(|| {
            Error::new(
                "failed to begin Wikidot HTML block SHA-1 constraint validation",
                ErrorType::TextBlock,
            )
        })?;
        txn
            .execute_raw(Statement::from_string(
                txn.get_database_backend(),
                "ALTER TABLE text_block VALIDATE CONSTRAINT text_block_html_wikidot_sha1_present",
            ))
            .await
            .or_raise(|| {
                Error::new(
                    "failed to validate Wikidot HTML block SHA-1 identities",
                    ErrorType::TextBlock,
                )
            })?;
        txn.commit().await.or_raise(|| {
            Error::new(
                "failed to commit Wikidot HTML block SHA-1 constraint validation",
                ErrorType::TextBlock,
            )
        })?;
        Ok(())
    }

    /// Gets the index and associated S3 name for a block accessed via name/alias.
    pub async fn get_block_index(
        ctx: &ServiceContext<'_>,
        page_id: i64,
        block_type: TextBlockType,
        name: &str,
    ) -> Result<Option<TextBlockIndex>> {
        info!(
            "Looking for a {} text block on page ID {} with name '{}'",
            block_type_name(block_type),
            page_id,
            name,
        );

        let make_error = || {
            Error::new(
                format!(
                    "failed to find a {} text block on page ID {} with name '{}'",
                    block_type_name(block_type),
                    page_id,
                    name,
                ),
                ErrorType::TextBlock,
            )
        };

        let txn = ctx.transaction();
        let block: Option<(i16, String)> = TextBlockTable::find()
            .select_only()
            .column(text_block::Column::BlockIndex)
            .column(text_block::Column::S3Filename)
            .filter(
                Condition::all()
                    .add(text_block::Column::PageId.eq(page_id))
                    .add(text_block::Column::BlockType.eq(block_type))
                    .add(text_block::Column::BlockName.eq(name)),
            )
            .into_tuple()
            .one(txn)
            .await
            .or_raise(make_error)?;

        match block {
            None => Ok(None),
            Some((index, s3_filename)) => Ok(Some(TextBlockIndex { index, s3_filename })),
        }
    }

    /// Gets the index and associated S3 name for a block accessed via numeric index.
    pub async fn get_block_by_index(
        ctx: &ServiceContext<'_>,
        page_id: i64,
        block_type: TextBlockType,
        index: i16,
    ) -> Result<Option<TextBlockIndex>> {
        info!(
            "Looking for a {} text block on page ID {} with index {}",
            block_type_name(block_type),
            page_id,
            index,
        );

        let make_error = || {
            Error::new(
                format!(
                    "failed to find a {} text block on page ID {} with index {}",
                    block_type_name(block_type),
                    page_id,
                    index,
                ),
                ErrorType::TextBlock,
            )
        };

        let txn = ctx.transaction();
        let s3_filename: Option<String> = TextBlockTable::find()
            .select_only()
            .column(text_block::Column::S3Filename)
            .filter(
                Condition::all()
                    .add(text_block::Column::PageId.eq(page_id))
                    .add(text_block::Column::BlockType.eq(block_type))
                    .add(text_block::Column::BlockIndex.eq(index)),
            )
            .into_tuple()
            .one(txn)
            .await
            .or_raise(make_error)?;

        match s3_filename {
            None => Ok(None),
            Some(s3_filename) => Ok(Some(TextBlockIndex { index, s3_filename })),
        }
    }

    /// Finds HTML blocks by their indexed raw-byte SHA-1.
    ///
    pub(crate) async fn get_blocks_by_wikidot_sha1(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        digest: &[u8],
    ) -> Result<Option<Vec<super::structs::TextBlockCandidate>>> {
        TextBlockTable::find()
            .select_only()
            .column(text_block::Column::PageId)
            .column(text_block::Column::BlockIndex)
            .column(text_block::Column::S3Filename)
            .join(JoinType::InnerJoin, text_block::Relation::Page.def())
            .filter(
                Condition::all()
                    .add(page::Column::SiteId.eq(site_id))
                    .add(page::Column::DeletedAt.is_null())
                    .add(text_block::Column::BlockType.eq(TextBlockType::Html))
                    .add(text_block::Column::WikidotSha1.eq(digest)),
            )
            .order_by_asc(text_block::Column::PageId)
            .order_by_asc(text_block::Column::BlockIndex)
            .limit((MAX_WIKIDOT_SHA1_CANDIDATES + 1) as u64)
            .into_tuple()
            .all(ctx.transaction())
            .await
            .or_raise(|| {
                Error::new(
                    format!(
                        "failed to find HTML text blocks with SHA-1 in site ID {site_id}"
                    ),
                    ErrorType::TextBlock,
                )
            })
            .map(|rows| {
                if rows.len() > MAX_WIKIDOT_SHA1_CANDIDATES {
                    return None;
                }
                Some(
                    rows.into_iter()
                        .map(|(page_id, index, s3_filename)| {
                            super::structs::TextBlockCandidate {
                                page_id,
                                index,
                                s3_filename,
                            }
                        })
                        .collect(),
                )
            })
    }

    /// Returns the S3 filenames for text blocks of a type on a page.
    async fn get_block_s3_filenames(
        ctx: &ServiceContext<'_>,
        page_id: i64,
        block_type: Option<TextBlockType>,
    ) -> Result<Vec<String>> {
        let txn = ctx.transaction();
        let mut condition = Condition::all().add(text_block::Column::PageId.eq(page_id));
        if let Some(block_type) = block_type {
            condition = condition.add(text_block::Column::BlockType.eq(block_type));
        }

        TextBlockTable::find()
            .select_only()
            .column(text_block::Column::S3Filename)
            .filter(condition)
            .into_tuple()
            .all(txn)
            .await
            .or_raise(|| {
                Error::new(
                    format!(
                        "failed to get text block S3 filenames for page ID {page_id}"
                    ),
                    ErrorType::TextBlock,
                )
            })
    }

    /// Delete all hosted text blocks stored for a page.
    ///
    /// This is run when a page is deleted, since the page
    /// becomes inaccessible and storing this redundant information
    /// becomes unnecessary.
    ///
    /// The database rows are deleted within the caller's transaction,
    /// but the S3 objects they name are only deleted after that
    /// transaction commits, via a deferred post-commit action.
    /// Deleting the objects here would be irreversible: if the
    /// transaction rolled back, the restored rows would name
    /// objects that no longer exist.
    pub async fn delete_blocks(ctx: &ServiceContext<'_>, page_id: i64) -> Result<()> {
        let txn = ctx.transaction();
        let make_error = || {
            Error::new(
                format!("failed to delete text blocks on page ID {}", page_id),
                ErrorType::TextBlock,
            )
        };

        let filenames = Self::get_block_s3_filenames(ctx, page_id, None)
            .await
            .or_raise(make_error)?;

        // Delete all the database rows in one sweep.
        TextBlockTable::delete_many()
            .filter(text_block::Column::PageId.eq(page_id))
            .exec(txn)
            .await
            .or_raise(make_error)?;

        // Queue the S3 objects for deletion once the transaction
        // commits. If it rolls back instead, the queued action is
        // discarded, nothing is deleted, and the rows remain valid.
        ctx.defer_text_block_cleanup(filenames)
            .or_raise(make_error)?;

        Ok(())
    }
}

fn block_type_name(block_type: TextBlockType) -> &'static str {
    match block_type {
        TextBlockType::Html => "html",
        TextBlockType::Code => "code",
    }
}

fn html_block_sha1(text: &str) -> Vec<u8> {
    Sha1::digest(text.as_bytes()).to_vec()
}

/// Returns the largest 1-indexed text block index for this block count.
fn max_text_block_index(count: usize) -> StdResult<i16, std::num::TryFromIntError> {
    count.try_into_i16()
}

fn text_block_insert_ranges(
    count: usize,
) -> impl Iterator<Item = std::ops::Range<usize>> {
    (0..count)
        .step_by(TEXT_BLOCK_INSERT_BATCH_SIZE)
        .map(move |start| start..(start + TEXT_BLOCK_INSERT_BATCH_SIZE).min(count))
}

/// Ensures that this name can be used to reference a block.
fn valid_block_name<'n>(previous: &mut HashSet<&'n str>, name: &'n str) -> bool {
    // To prevent shenanigans with excessively-long block aliases.
    const MAX_BLOCK_NAME_LEN: usize = 32;

    if name.is_empty() {
        warn!("Empty block name passed, rejecting");
        return false;
    }

    let char_len = name.chars().count();
    if char_len > MAX_BLOCK_NAME_LEN {
        warn!("Block name '{name}' is too long ({char_len} > {MAX_BLOCK_NAME_LEN})");
        return false;
    }

    if name.chars().all(|c| c.is_ascii_digit()) {
        warn!("Numeric block name '{name}' passed, rejecting");
        return false;
    }

    if previous.contains(name) {
        warn!("Block name '{name}' has already been used for this page, rejecting");
        return false;
    }

    // Now that all checks have passed, add this as one of the already-used names.
    previous.insert(name);
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::Iterable;

    #[test]
    fn text_block_count_and_index_range_fit_i16_boundaries() {
        assert_eq!(max_text_block_index(0).unwrap(), 0);
        assert_eq!(max_text_block_index(i16::MAX as usize).unwrap(), i16::MAX,);
        assert!(max_text_block_index(i16::MAX as usize + 1).is_err());

        for count in [0, 1, i16::MAX as usize] {
            let max_index = max_text_block_index(count).unwrap();
            let indices = 1..=max_index;
            let expected_first = (count > 0).then_some(1);
            let expected_last = (count > 0).then_some(max_index);

            assert_eq!(indices.clone().count(), count);
            assert_eq!(indices.clone().next(), expected_first);
            assert_eq!(indices.clone().next_back(), expected_last);
        }
    }

    #[test]
    fn page_block_counts_are_prevalidated_together() {
        let max = i16::MAX as usize;

        assert!(TextBlockService::validate_page_block_counts(max, max).is_ok());
        assert!(TextBlockService::validate_page_block_counts(max + 1, 1).is_err());
        assert!(TextBlockService::validate_page_block_counts(1, max + 1).is_err());
    }

    #[test]
    fn insert_batch_stays_below_postgres_bind_limit() {
        let bound_columns_per_row = text_block::Column::iter().count();
        let bound_parameters = TEXT_BLOCK_INSERT_BATCH_SIZE * bound_columns_per_row;

        assert!(bound_parameters <= u16::MAX as usize);
    }

    #[test]
    fn object_store_upload_concurrency_is_bounded() {
        assert!((1..=32).contains(&TEXT_BLOCK_UPLOAD_CONCURRENCY));
    }

    #[test]
    fn one_thousand_and_one_blocks_keep_indices_across_two_insert_batches() {
        let count = TEXT_BLOCK_INSERT_BATCH_SIZE + 1;
        let max_index = max_text_block_index(count).unwrap();
        let indices = (1..=max_index).collect::<Vec<_>>();
        let batches = text_block_insert_ranges(count).collect::<Vec<_>>();

        assert_eq!(indices.len(), count);
        assert_eq!(indices[0], 1);
        assert_eq!(indices[999], 1_000);
        assert_eq!(indices[1_000], 1_001);
        assert_eq!(batches, [0..1_000, 1_000..1_001]);
    }

    #[test]
    fn induced_second_batch_failure_stops_before_later_batches() {
        let count = TEXT_BLOCK_INSERT_BATCH_SIZE * 2 + 1;
        let mut attempted = Vec::new();
        let result: StdResult<(), &'static str> = text_block_insert_ranges(count)
            .enumerate()
            .try_for_each(|(batch, range)| {
                attempted.push(range);
                if batch == 1 {
                    return Err("induced second-batch database failure");
                }
                Ok(())
            });

        assert_eq!(result, Err("induced second-batch database failure"));
        assert_eq!(attempted, [0..1_000, 1_000..2_000]);
        assert!(!attempted.contains(&(2_000..2_001)));
    }
}
