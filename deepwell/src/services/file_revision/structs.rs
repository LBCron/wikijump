/*
 * services/file_revision/structs.rs
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
use crate::models::file_revision::Model as FileRevisionModel;
use crate::services::blob::ContentTypeDescriptor;
use crate::services::page_revision::PageRevisionCountOutput;
use crate::types::Maybe;
use crate::types::{FetchDirection, FileRevisionType};
use ftml::data::UserInfo;
use time::OffsetDateTime;

#[derive(Debug, Clone)]
pub struct CreateFileRevision {
    pub site_id: i64,
    pub page_id: i64,
    pub file_id: i64,
    pub user_id: i64,
    pub revision_comments: String,
    pub revision_type: FileRevisionType,
    pub body: CreateFileRevisionBody,
}

#[derive(Debug, Default, Clone)]
pub struct CreateFileRevisionBody {
    pub page_id: Maybe<i64>,
    pub name: Maybe<String>,
    pub blob: Maybe<FileBlob>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileBlob {
    pub s3_hash: BlobHash,
    pub size: i64,
    pub mime: String,
    pub content_type: Option<ContentTypeDescriptor>,
    pub blob_created: bool,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct CreateFileRevisionOutput {
    pub file_revision_id: i64,
    pub file_revision_number: i32,

    #[serde(default, skip_serializing_if = "Maybe::is_unset")]
    pub blob_created: Maybe<bool>,
}

#[derive(Debug, Clone)]
pub struct CreateFirstFileRevision {
    pub site_id: i64,
    pub page_id: i64,
    pub file_id: i64,
    pub user_id: i64,
    pub name: String,
    pub s3_hash: BlobHash,
    pub size: i64,
    pub mime: String,
    pub content_type: Option<ContentTypeDescriptor>,
    pub blob_created: bool,
    pub revision_comments: String,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct CreateFirstFileRevisionOutput {
    pub file_id: i64,
    pub file_revision_id: i64,
    pub blob_created: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct CreateTombstoneFileRevision {
    pub site_id: i64,
    pub page_id: i64,
    pub file_id: i64,
    pub user_id: i64,
    pub revision_comments: String,
    pub erase_s3_hash: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct CreateResurrectionFileRevision {
    pub site_id: i64,
    pub page_id: i64,
    pub file_id: i64,
    pub user_id: i64,
    pub new_page_id: i64,
    pub new_name: String,
    pub revision_comments: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct GetFileRevision {
    pub site_id: i64,
    pub page_id: i64,
    pub file_id: i64,
    pub revision_number: i32,
}

#[derive(Debug, Clone)]
pub struct CountFileRevisions {
    pub site_id: i64,
    pub page_id: i64,
    pub file_id: i64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct UpdateFileRevision {
    pub site_id: i64,
    pub page_id: i64,
    pub file_id: i64,
    pub revision_id: i64,
    pub user_id: i64,
    pub hidden: Vec<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct GetFileRevisionRange {
    pub site_id: i64,
    pub page_id: i64,
    pub file_id: i64,
    pub revision_number: i32,
    pub revision_direction: FetchDirection,
    pub limit: u64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct GetPageFileRevisionHistory {
    pub site_id: i64,
    pub page_id: i64,
    pub limit: u64,
}

#[derive(Debug)]
pub struct PageFileRevisionHistory {
    pub revision_count: u64,
    pub revisions: Vec<FileRevisionModel>,
}

#[derive(Serialize, Debug, Clone)]
pub struct FileRevisionModelFiltered {
    pub revision_id: i64,
    pub revision_type: FileRevisionType,

    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,

    pub revision_number: i32,
    pub file_id: i64,
    pub page_id: i64,
    pub site_id: i64,
    pub user_id: i64,
    pub name: Option<String>,
    pub s3_hash: Option<Vec<u8>>,
    pub mime: Option<String>,
    pub size: Option<i64>,
    pub changes: Vec<String>,
    pub comments: Option<String>,
    pub hidden: Vec<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct PageFileRevisionHistoryModelFiltered {
    #[serde(flatten)]
    pub revision: FileRevisionModelFiltered,
    pub author: Option<UserInfo<'static>>,
}

#[derive(Serialize, Debug, Clone)]
pub struct PageFileRevisionHistoryOutput {
    pub revision_count: u64,
    pub revisions: Vec<PageFileRevisionHistoryModelFiltered>,
}

pub type FileRevisionCountOutput = PageRevisionCountOutput;
