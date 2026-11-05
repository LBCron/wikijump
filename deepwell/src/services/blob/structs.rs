/*
 * services/blob/structs.rs
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

use crate::hash::BlobHash;
use crate::types::Bytes;
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

#[derive(Deserialize, Debug, Clone)]
pub struct StartBlobUpload {
    pub user_id: i64,
    pub blob_size: u64,
    pub scope: StartBlobUploadScope,
}

#[derive(Deserialize, Debug, Copy, Clone, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StartBlobUploadScope {
    Unscoped,
    Page,
}

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum PendingBlobOwner {
    Unscoped,
    Page { site_id: i64, page_id: i64 },
}

#[derive(Serialize, Debug, Clone)]
pub struct StartBlobUploadOutput {
    pub pending_blob_id: String,
    pub presign_url: String,

    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
}

#[derive(Deserialize, Debug, Clone)]
pub struct CancelBlobUpload {
    pub user_id: i64,
    pub pending_blob_id: String,
}

#[derive(Debug)]
pub struct FinalizeBlobUploadOutput {
    pub s3_hash: BlobHash,
    pub mime: String,
    pub size: i64,
    pub content_type: ContentTypeDescriptor,
    // Internal only: never return to callers (dedup existence oracle).
    pub created: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ContentTypeDescriptor {
    pub label: String,
    pub description: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ContentAnalysis {
    pub mime: String,
    pub content_type: ContentTypeDescriptor,
}

#[derive(Deserialize, Debug, Clone)]
pub struct HardDelete {
    pub s3_hash: Bytes<'static>,
}

#[derive(Serialize, Debug, Clone)]
pub struct HardDeleteOutput {
    pub total_revisions: usize,
    pub total_files: usize,
    pub total_files_deleted: usize,
    pub total_pages: usize,
    pub total_sites: usize,
    pub total_users: u64,
    pub sample_revision_ids: Vec<i64>,
    pub sample_file_ids: Vec<i64>,
    pub sample_page_ids: Vec<i64>,
    pub sample_site_ids: Vec<i64>,
    pub sample_user_ids: Vec<i64>,
}

#[derive(Debug)]
pub struct BlobMetadata {
    pub mime: String,
    pub size: i64,
    pub created_at: OffsetDateTime,
}

#[derive(Serialize, Debug, Clone)]
pub struct PublicBlobByHash {
    pub data: Vec<u8>,
    pub mime: String,
    pub size: i64,

    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
}
