/*
 * services/import/structs.rs
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

use crate::types::{License, PageRevisionType};
use ftml::data::KarmaLevel;
use std::net::IpAddr;
use time::{Date, OffsetDateTime};

#[derive(Deserialize, Debug)]
pub struct ImportUser {
    pub user_id: i32,

    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,

    #[serde(with = "time::serde::rfc3339")]
    pub fetched_at: OffsetDateTime,

    #[serde(flatten)]
    pub wikidot_user_type: ImportedUserType,

    pub avatar_uploaded_blob_id: Option<String>,

    pub real_name: Option<String>,
    pub gender: Option<String>,
    pub birthday: Option<Date>,
    pub location: Option<String>,
    pub biography: Option<String>,
    pub website: Option<String>,
    pub karma: KarmaLevel,
    pub is_pro: bool,

    #[serde(default)]
    pub upsert: bool,

    #[serde(default)]
    pub delete_old_if_same_name: bool,

    pub importing_user_id: i64,

    pub ip_address: IpAddr,
}

#[derive(Deserialize, Debug)]
#[serde(tag = "user_type", rename_all = "kebab-case")]
pub enum ImportedUserType {
    Extant { name: String, slug: String },
    Deleted,
}

#[derive(Serialize, Debug, Copy, Clone)]
pub struct ImportUserOutput {
    pub user_id: i32,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ImportMetaTag {
    pub name: String,
    pub content: String,
}

#[derive(Deserialize, Debug)]
pub struct PromoteObservedIdentity {
    pub user_id: i32,
    pub name: String,
    pub slug: String,
    #[serde(with = "time::serde::rfc3339")]
    pub observed_at: OffsetDateTime,
    pub source_reference: String,
    pub profile: Option<ObservedUserProfile>,
    pub importing_user_id: i64,
    pub ip_address: IpAddr,
}

#[derive(Deserialize, Debug)]
pub struct ObservedUserProfile {
    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    #[serde(with = "time::serde::rfc3339::option", default)]
    pub fetched_at: Option<OffsetDateTime>,
    pub avatar_uploaded_blob_id: Option<String>,
    pub real_name: Option<String>,
    pub gender: Option<String>,
    pub birthday: Option<Date>,
    pub location: Option<String>,
    pub biography: Option<String>,
    pub website: Option<String>,
    pub karma: Option<KarmaLevel>,
    pub is_pro: Option<bool>,
}

#[derive(Serialize, Debug, Clone)]
pub struct PromoteObservedIdentityOutput {
    pub user_id: i32,
    pub promoted: bool,
    pub missing_profile_fields: Vec<String>,
}

#[derive(Deserialize, Debug)]
pub struct ImportSite {
    pub site_id: i64,

    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub name: String,
    pub slug: String,
    pub tagline: String,
    pub description: String,
    pub license: License,
    pub locale: String,
    pub ip_address: IpAddr,

    #[serde(default)]
    pub meta_tags: Vec<ImportMetaTag>,
}

#[derive(Serialize, Debug, Copy, Clone)]
pub struct ImportSiteOutput {
    pub site_id: i64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ImportSiteMember {
    pub user_id: i32,
    #[serde(with = "time::serde::rfc3339")]
    pub joined_at: OffsetDateTime,
    #[serde(default)]
    pub roles: Vec<ImportedSiteRole>,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[serde(rename_all = "kebab-case")]
pub enum ImportedSiteRole {
    Moderator,
    Admin,
}

#[derive(Deserialize, Debug)]
pub struct ImportSiteRoster {
    pub site_id: i64,
    #[serde(with = "time::serde::rfc3339")]
    pub fetched_at: OffsetDateTime,
    pub master_admin_user_id: Option<i32>,
    pub members: Vec<ImportSiteMember>,

    pub importing_user_id: i64,
    pub ip_address: IpAddr,
}

#[derive(Serialize, Debug, Clone)]
pub struct ImportSiteRosterOutput {
    pub site_id: i64,
    pub members_created: u64,
    pub members_updated: u64,
    pub members_retired: u64,
    pub roles_assigned: u64,
    pub roles_removed: u64,
    pub master_admin_set: bool,
}

#[derive(Deserialize, Debug)]
pub struct ImportPage {
    pub page_id: i64,
    pub site_id: i64,

    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,
    pub slug: String,
    pub locked: bool,
    pub discussion_thread_id: Option<i64>,
    pub ip_address: IpAddr,

    #[serde(default)]
    pub meta_tags: Vec<ImportMetaTag>,
}

#[derive(Serialize, Debug, Copy, Clone)]
pub struct ImportPageOutput {
    pub site_id: i64,
    pub page_id: i64,
}

#[derive(Deserialize, Debug)]
pub struct ImportPageRevision {
    pub revision_id: i64,
    pub revision_type: PageRevisionType,
    pub created_at: OffsetDateTime,
    pub updated_at: Option<OffsetDateTime>,
    pub revision_number: i32,
    pub page_id: i64,
    pub site_id: i64,
    pub user_id: Option<i64>,
    #[serde(default)]
    pub anonymous_ip: Option<String>,
    pub wikitext: String,
    pub comments: String,
    pub title: String,
    pub slug: String,
    pub tags: Vec<String>,
}

#[derive(Serialize, Debug, Copy, Clone)]
pub struct ImportPageRevisionOutput {
    pub site_id: i64,
    pub page_id: i64,
    pub page_revision_id: i64,
    pub page_revision_number: i32,
}

#[derive(Deserialize, Debug)]
pub struct ImportFile {
    pub site_id: i64,
    pub page_id: i64,
    pub name: String,

    pub data: Vec<u8>,

    pub size: i64,

    pub s3_hash: String,

    pub user_id: i64,

    #[serde(with = "time::serde::rfc3339")]
    pub created_at: OffsetDateTime,

    pub revision_comments: String,

    pub ip_address: IpAddr,
}

#[derive(Serialize, Debug, Copy, Clone)]
pub struct ImportFileOutput {
    pub site_id: i64,
    pub page_id: i64,
    pub file_id: i64,
    pub file_revision_id: i64,
    pub file_revision_number: i32,
}

#[derive(Deserialize, Debug)]
pub struct ImportFileDelete {
    pub site_id: i64,
    pub page_id: i64,
    pub name: String,

    pub user_id: i64,

    #[serde(with = "time::serde::rfc3339")]
    pub deleted_at: OffsetDateTime,

    pub revision_comments: String,
    pub ip_address: IpAddr,
}

#[derive(Serialize, Debug, Copy, Clone)]
pub struct ImportFileDeleteOutput {
    pub site_id: i64,
    pub page_id: i64,
    pub file_id: i64,
    pub file_revision_id: i64,
    pub file_revision_number: i32,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ImportFileExpectation {
    pub name: String,
    pub size: i64,

    pub s3_hash: String,
}

#[derive(Deserialize, Debug)]
pub struct ImportPageFilesVerify {
    pub site_id: i64,
    pub page_id: i64,
    pub expected: Vec<ImportFileExpectation>,
}

#[derive(Serialize, Debug, Copy, Clone)]
pub struct ImportPageFilesVerifyOutput {
    pub site_id: i64,
    pub page_id: i64,
    pub verified_files: usize,
}

#[derive(Deserialize, Debug, Clone, Copy)]
pub struct ImportPageVote {
    pub user_id: i64,
    pub value: i16,
}

#[derive(Deserialize, Debug)]
pub struct ImportPageVotes {
    pub site_id: i64,
    pub page_id: i64,
    pub rating_system: String,
    pub votes: Vec<ImportPageVote>,
}

#[derive(Serialize, Debug, Copy, Clone)]
pub struct ImportPageVotesOutput {
    pub site_id: i64,
    pub page_id: i64,
    pub inserted: usize,
    pub unchanged: usize,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ImportPageMetaTags {
    pub site_id: i64,
    pub page_id: i64,
    pub meta_tags: Vec<ImportMetaTag>,
}

#[derive(Serialize, Debug, Copy, Clone)]
pub struct ImportPageMetaTagsOutput {
    pub site_id: i64,
    pub page_id: i64,
    pub stored: usize,
    pub removed: usize,
}
