/*
 * services/page/mod.rs
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

mod service;
mod structs;

pub use self::service::PageService;
pub(in crate::services) use self::service::foreign_snapshot_exclusion_sql;
pub use self::structs::{
    CreatePage, CreatePageOutput, DeletePage, DeletePageOutput, EditPage, EditPageBody,
    EditPageLease, EditPageOutput, GetDeletedPageOutput, GetPageAnyDetails,
    GetPageOutput, GetPageReference, GetPageReferenceDetails, GetPageScoreOutput,
    GetPageSlug, MovePage, MovePageOutput, PageCreatePermissionOutput,
    PageDeletePermissionOutput, PageEditPermissionOutput, PageLifecycleIdentity,
    PageMovePermissionOutput, RestorePage, RestorePageOutput, RollbackPage,
    SetPageLayout,
};
