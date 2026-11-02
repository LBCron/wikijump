/*
 * services/page_revision/structs.rs
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

use crate::types::Maybe;
use crate::types::{FetchDirection, PageDetails, PageId, PageRevisionType};
use ftml::data::UserInfo;
use ftml::layout::Layout;
use ftml::parsing::ParseError;
use std::net::IpAddr;
use std::num::NonZeroI32;
use time::OffsetDateTime;

#[derive(Deserialize, Debug, Clone)]
pub struct CreatePageRevision {
    pub user_id: i64,
    pub comments: String,
    pub revision_type: PageRevisionType,

    #[serde(flatten)]
    pub body: CreatePageRevisionBody,
}

#[derive(Deserialize, Debug, Default, Clone)]
#[serde(default)]
pub struct CreatePageRevisionBody {
    pub wikitext: Maybe<String>,
    pub title: Maybe<String>,
    pub alt_title: Maybe<Option<String>>,
    pub slug: Maybe<String>,
    pub tags: Maybe<Vec<String>>,
    #[serde(skip)]
    pub(crate) parent_changed: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct CreateFirstPageRevision {
    pub user_id: i64,
    pub comments: String,
    pub wikitext: String,
    pub title: String,
    pub alt_title: Option<String>,

    #[serde(default)]
    pub tags: Vec<String>,

    pub slug: String,
    pub layout: Option<Layout>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct CreateTombstonePageRevision {
    pub site_id: i64,
    pub page_id: i64,
    pub user_id: i64,
    pub comments: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct CreateResurrectionPageRevision {
    pub id: PageId,
    pub user_id: i64,
    pub comments: String,
    pub new_slug: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct CreatePageRevisionOutput {
    pub revision_id: i64,
    pub revision_number: i32,
    pub parser_errors: Option<Vec<ParseError>>,
}

#[derive(Serialize, Debug, Clone)]
pub struct CreateFirstPageRevisionOutput {
    pub revision_id: i64,
    pub parser_errors: Vec<ParseError>,
    #[serde(skip)]
    pub(crate) followups: FirstRevisionFollowups,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FirstRevisionFollowups {
    pub(crate) slug: String,
    pub(crate) rerender_after_latest_revision: bool,
}

#[derive(Deserialize, Debug, Clone)]
pub struct GetPageRevision {
    pub site_id: i64,
    pub page_id: i64,
    pub revision_number: i32,
}

#[derive(Deserialize, Debug, Clone)]
pub struct GetPageRevisionDiff {
    pub site_id: i64,
    pub page_id: i64,
    pub from_revision_number: i32,
    pub to_revision_number: i32,
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PageRevisionDiffLineKind {
    Added,
    Removed,
    Unchanged,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct PageRevisionDiffLine {
    pub kind: PageRevisionDiffLineKind,
    pub text: String,
}

#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct PageRevisionDiffOutput {
    pub site_id: i64,
    pub page_id: i64,
    pub from_revision_number: i32,
    pub to_revision_number: i32,
    pub lines: Vec<PageRevisionDiffLine>,
}

#[derive(Debug, Clone)]
pub struct CountPageRevisions {
    pub site_id: i64,
    pub page_id: i64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct GetPageRevisionDetails {
    #[serde(flatten)]
    pub input: GetPageRevision,

    #[serde(default)]
    pub details: PageDetails,
}

#[derive(Deserialize, Debug, Clone)]
pub struct GetPageRevisionByIdDetails {
    pub site_id: i64,
    pub revision_id: i64,

    #[serde(default)]
    pub details: PageDetails,
}

#[derive(Debug, Clone, Copy)]
pub struct PageRevisionCoordinate {
    pub page_id: i64,
    pub revision_number: i32,
}

#[derive(Deserialize, Debug, Clone)]
pub struct UpdatePageRevision {
    pub site_id: i64,
    pub page_id: i64,
    pub revision_id: i64,
    pub user_id: i64,
    pub ip_address: IpAddr,
    pub hidden: Vec<String>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct UpdatePageRevisionDetails {
    #[serde(flatten)]
    pub input: UpdatePageRevision,

    #[serde(default)]
    pub details: PageDetails,
}

#[derive(Deserialize, Debug, Clone)]
pub struct GetPageRevisionRange {
    pub site_id: i64,
    pub page_id: i64,
    pub revision_number: i32,
    pub revision_direction: FetchDirection,
    pub limit: u64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct GetPageRevisionRangeDetails {
    #[serde(flatten)]
    pub input: GetPageRevisionRange,

    #[serde(default)]
    pub details: PageDetails,
}

#[derive(Serialize, Debug, Clone)]
pub struct PageRevisionCountOutput {
    pub revision_count: NonZeroI32,
    pub first_revision: i32,
    pub last_revision: i32,
}

#[derive(Serialize, Debug, Clone)]
pub struct PageRevisionModelFiltered {
    pub revision_id: i64,
    pub revision_type: PageRevisionType,

    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,

    #[serde(with = "time::serde::rfc3339::option")]
    pub updated_at: Option<OffsetDateTime>,
    pub from_wikidot: bool,
    pub revision_number: i32,
    pub page_id: i64,
    pub site_id: i64,
    pub user_id: i64,
    pub author: Option<UserInfo<'static>>,
    pub changes: Vec<String>,
    pub wikitext: Option<String>,
    pub compiled_body_html: Option<String>,
    pub compiled_body_styles: Option<Vec<String>>,
    pub compiled_top_bar_html: Option<String>,
    pub compiled_side_bar_html: Option<String>,

    #[serde(with = "time::serde::rfc3339")]
    pub compiled_at: OffsetDateTime,
    pub compiled_generator: String,
    pub comments: Option<String>,
    pub hidden: Vec<String>,
    pub title: Option<String>,
    pub alt_title: Option<String>,
    pub slug: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Debug, Default, Copy, Clone, PartialEq, Eq)]
pub enum RerenderType {
    #[serde(rename = "full")]
    #[default]
    Full,

    #[serde(rename = "nav")]
    NavigationOnly,
}
