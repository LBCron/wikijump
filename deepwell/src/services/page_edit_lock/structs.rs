/*
 * services/page_edit_lock/structs.rs
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

use crate::types::{PageEditLockMode, Reference};
use serde::{Deserialize, Serialize};
use time::OffsetDateTime;

#[derive(Debug, Clone)]
pub struct AcquirePageEditLock<'a> {
    pub site_id: i64,
    pub page: Reference<'a>,
    pub user_id: i64,
    pub mode: PageEditLockMode,
    pub section_index: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct RenewPageEditLock<'a> {
    pub site_id: i64,
    pub page: Reference<'a>,
    pub user_id: i64,
    pub lock_id: i64,
    pub lock_secret: String,
    pub mode: PageEditLockMode,
    pub section_index: Option<i32>,
}

#[derive(Debug, Clone)]
pub struct ReleasePageEditLock<'a> {
    pub site_id: i64,
    pub page: Reference<'a>,
    pub user_id: i64,
    pub lock_id: i64,
    pub lock_secret: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct PageEditLockGrant {
    pub lock_id: i64,
    pub lock_secret: String,
    pub base_revision_id: Option<i64>,
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
}

#[derive(Serialize, Debug, Clone)]
pub struct PageEditLockConflictInfo {
    pub user_id: i64,
    pub mode: PageEditLockMode,
    pub section_index: Option<i32>,
    pub seconds_remaining: i64,
}

#[derive(Serialize, Debug, Clone)]
pub struct AcquirePageEditLockOutput {
    pub grant: Option<PageEditLockGrant>,
    pub conflicts: Vec<PageEditLockConflictInfo>,
}

#[derive(Serialize, Debug, Clone)]
pub struct RenewPageEditLockOutput {
    pub lock_id: i64,
    pub lock_secret: String,
    pub base_revision_id: Option<i64>,
    pub lock_recreated: bool,
    #[serde(with = "time::serde::rfc3339")]
    pub expires_at: OffsetDateTime,
}

#[derive(Deserialize, Debug, Clone)]
pub struct AcquirePageEditLockInput {
    pub page: Reference<'static>,
    pub mode: PageEditLockMode,
    #[serde(default)]
    pub section_index: Option<i32>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct RenewPageEditLockInput {
    pub page: Reference<'static>,
    pub lock_id: i64,
    pub lock_secret: String,
    pub mode: PageEditLockMode,
    #[serde(default)]
    pub section_index: Option<i32>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ReleasePageEditLockInput {
    pub page: Reference<'static>,
    pub lock_id: i64,
    pub lock_secret: String,
}
