/*
 * types/page_order.rs
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

use crate::models::page;
use sea_orm::query::Order;

#[derive(Debug, Clone, PartialEq)]
pub struct PageOrder {
    pub column: PageOrderColumn,
    pub direction: Order,
}

impl Default for PageOrder {
    #[inline]
    fn default() -> Self {
        PageOrder {
            column: PageOrderColumn::default(),
            direction: Order::Asc,
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Default, Copy, Clone, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PageOrderColumn {
    #[default]
    Id,

    Creation,

    Update,

    Deletion,

    Slug,
}

impl PageOrderColumn {
    #[inline]
    pub fn into_column(self) -> page::Column {
        self.into()
    }
}

impl From<PageOrderColumn> for page::Column {
    fn from(order: PageOrderColumn) -> page::Column {
        match order {
            PageOrderColumn::Id => page::Column::PageId,
            PageOrderColumn::Creation => page::Column::CreatedAt,
            PageOrderColumn::Update => page::Column::UpdatedAt,
            PageOrderColumn::Deletion => page::Column::DeletedAt,
            PageOrderColumn::Slug => page::Column::Slug,
        }
    }
}

#[test]
fn default_page_order_uses_id_ascending() {
    let order = PageOrder::default();

    assert_eq!(order.column, PageOrderColumn::Id);
    assert_eq!(order.direction, Order::Asc);
}

#[test]
fn page_order_columns_map_to_database_columns() {
    assert!(matches!(
        PageOrderColumn::Id.into_column(),
        page::Column::PageId,
    ));
    assert!(matches!(
        PageOrderColumn::Creation.into_column(),
        page::Column::CreatedAt,
    ));
    assert!(matches!(
        PageOrderColumn::Update.into_column(),
        page::Column::UpdatedAt,
    ));
    assert!(matches!(
        PageOrderColumn::Deletion.into_column(),
        page::Column::DeletedAt,
    ));
    assert!(matches!(
        PageOrderColumn::Slug.into_column(),
        page::Column::Slug,
    ));
}
