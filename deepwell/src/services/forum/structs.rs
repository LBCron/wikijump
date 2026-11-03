/*
 * services/forum/structs.rs
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

use crate::models::forum_category::Model as ForumCategoryModel;
use crate::models::forum_group::Model as ForumGroupModel;

#[derive(Deserialize, Debug, Clone)]
pub struct CreateForumGroup {
    pub site_id: i64,
    pub user_id: i64,
    pub name: String,
    pub description: String,
    #[serde(default = "default_true")]
    pub visible: bool,
    pub sort_index: Option<i32>,
    #[serde(default)]
    pub from_wikidot: bool,
}

#[derive(Deserialize, Debug, Copy, Clone)]
pub struct GetForumGroups {
    pub site_id: i64,
    #[serde(default)]
    pub include_deleted: bool,
    #[serde(default)]
    pub visible_groups_only: bool,
}

#[derive(Deserialize, Debug, Copy, Clone)]
pub struct DeleteForumGroup {
    pub forum_group_id: i64,
    pub user_id: i64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct CreateForumCategory {
    pub forum_group_id: i64,
    pub user_id: i64,
    pub name: String,
    pub description: String,
    pub sort_index: Option<i32>,
    pub max_nest_level: Option<i16>,
    pub per_page_discussion: Option<bool>,
    pub layout: Option<String>,
    #[serde(default)]
    pub from_wikidot: bool,
}

#[derive(Deserialize, Debug, Copy, Clone)]
pub struct GetForumCategory {
    pub site_id: i64,
    pub forum_category_id: i64,
    #[serde(default)]
    pub include_deleted: bool,
}

#[derive(Deserialize, Debug, Copy, Clone)]
pub struct DeleteForumCategory {
    pub forum_category_id: i64,
    pub user_id: i64,
}

#[derive(Serialize, Debug, Clone)]
pub struct ForumGroupStructure {
    pub group: ForumGroupModel,
    pub categories: Vec<ForumCategoryModel>,
}

#[derive(Deserialize, Debug, Copy, Clone)]
pub struct GetForumStructure {
    pub site_id: i64,
    #[serde(default)]
    pub include_deleted: bool,
    #[serde(default)]
    pub visible_groups_only: bool,
}

#[inline]
fn default_true() -> bool {
    true
}
