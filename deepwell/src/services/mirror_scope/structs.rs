/*
 * services/mirror_scope/structs.rs
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

use crate::types::Reference;
use serde::{Deserialize, Serialize};
use std::net::IpAddr;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct MirrorScope {
    pub site_id: i64,
    pub scope: String,
    pub source_pin: Option<String>,
    pub inventoried_source_count: i64,
    pub declared_extras: Vec<String>,
    pub consumed_slugs: Vec<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct SetMirrorScope {
    pub site_id: i64,
    pub scope: String,
    pub source_pin: Option<String>,
    pub inventoried_source_count: i64,
    pub declared_extras: Vec<String>,
    pub consumed_slugs: Vec<String>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct ReconcilePageDelete<'a> {
    pub page: Reference<'a>,
    pub last_revision_id: i64,
    pub revision_comments: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct ReconcilePageRename<'a> {
    pub page: Reference<'a>,
    pub new_slug: String,
    pub last_revision_id: i64,
    pub revision_comments: String,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct ReconcileMirrorPages<'a> {
    pub site_id: i64,
    pub deletes: Vec<ReconcilePageDelete<'a>>,
    pub renames: Vec<ReconcilePageRename<'a>>,
    pub ip_address: IpAddr,
}

#[derive(Serialize, Debug, Clone)]
pub struct ReconcileItemResult {
    pub slug: String,
    pub op: String,
    pub ok: bool,
    pub revision_number: Option<i32>,
    pub error: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct ReconcileMirrorOutput {
    pub site_id: i64,
    pub applied_deletes: usize,
    pub applied_renames: usize,
    pub failed: usize,
    pub items: Vec<ReconcileItemResult>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct SourceFileExpectation {
    pub name: String,
    pub s3_hash_hex: Option<String>,
    pub size: Option<i64>,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(deny_unknown_fields)]
pub struct ReconcileMirrorFiles<'a> {
    pub site_id: i64,
    pub page: Reference<'a>,
    pub files: Vec<SourceFileExpectation>,
    pub ip_address: IpAddr,
}

#[derive(Serialize, Debug, Clone)]
pub struct ReconcileFileItemResult {
    pub name: String,
    pub op: String,
    pub ok: bool,
    pub revision_number: Option<i32>,
    pub error: Option<String>,
}

#[derive(Serialize, Debug, Clone)]
pub struct ReconcileMirrorFilesOutput {
    pub site_id: i64,
    pub page_id: i64,
    pub tombstoned: usize,
    pub kept: usize,
    pub changed: Vec<String>,
    pub missing: Vec<String>,
    pub failed: usize,
    pub items: Vec<ReconcileFileItemResult>,
}
