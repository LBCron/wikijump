/*
 * services/filter/struct.rs
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

use crate::models::filter;
use sea_orm::{ColumnTrait, Condition};

#[derive(Debug, Copy, Clone, PartialEq, Eq)]
pub enum FilterClass {
    Platform,

    Site(i64),

    PlatformAndSite(i64),
}

impl FilterClass {
    #[inline]
    pub fn name(self) -> &'static str {
        match self {
            FilterClass::Platform => "platform",
            FilterClass::Site(_) => "site",
            FilterClass::PlatformAndSite(_) => "platform and site",
        }
    }

    pub fn to_condition(self) -> Condition {
        let mut condition = Condition::any();

        if matches!(
            self,
            FilterClass::Platform | FilterClass::PlatformAndSite(_),
        ) {
            condition = condition.add(filter::Column::SiteId.is_null());
        }

        if let FilterClass::Site(site_id) | FilterClass::PlatformAndSite(site_id) = self {
            condition = condition.add(filter::Column::SiteId.eq(site_id));
        }

        condition
    }
}

#[derive(Serialize, Deserialize, Debug, Copy, Clone, PartialEq, Eq)]
pub enum FilterType {
    User,

    Email,

    Page,

    File,

    Forum,
}

impl FilterType {
    #[inline]
    pub fn into_column(self) -> filter::Column {
        self.into()
    }
}

impl From<FilterType> for filter::Column {
    #[inline]
    fn from(filter_type: FilterType) -> filter::Column {
        match filter_type {
            FilterType::User => filter::Column::AffectsUser,
            FilterType::Email => filter::Column::AffectsEmail,
            FilterType::Page => filter::Column::AffectsPage,
            FilterType::File => filter::Column::AffectsFile,
            FilterType::Forum => filter::Column::AffectsForum,
        }
    }
}

#[derive(Deserialize, Debug, Clone)]
pub struct CreateFilter {
    pub affects_user: bool,
    pub affects_email: bool,
    pub affects_page: bool,
    pub affects_file: bool,
    pub affects_forum: bool,
    pub case_sensitive: bool,
    pub regex: String,
    pub description: String,
}
