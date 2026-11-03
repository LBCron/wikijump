/*
 * services/render/list_pages/batch_loading.rs
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

use super::{
    ExactNameListPagesBatchKey, ListPagesBatchDisplayRequirements, ListPagesBatchDisplays,
};
use crate::error::prelude::Result;
use crate::services::ServiceContext;
use crate::services::page_query::{
    AuthorSelector, CategoriesSelector, DateSelector, FoundPageFields, FoundPageRow,
    IncludedCategories, PageParentSelector, PageQuery, PageTypeSelector,
    PaginationSelector, TagCondition,
};
use crate::services::render::runtime::RenderRuntime;
use crate::services::render::service::{
    MAX_LISTPAGES_RENDER_LIMIT, MAX_LISTPAGES_RENDER_SCAN_ROWS, RenderService,
};
use std::borrow::Cow;
use std::collections::BTreeMap;

impl RenderService {
    pub(in crate::services::render) async fn load_exact_name_list_pages_batch(
        ctx: &ServiceContext<'_>,
        current_site_id: i64,
        current_page_id: i64,
        key: &ExactNameListPagesBatchKey,
        slugs: &[Cow<'_, str>],
        fields: FoundPageFields,
        permission_cache: &mut BTreeMap<(i64, Option<i64>), bool>,
    ) -> Result<Option<BTreeMap<String, Vec<FoundPageRow>>>> {
        let categories = key
            .categories
            .iter()
            .map(|category| Cow::Borrowed(category.as_str()))
            .collect::<Vec<_>>();
        let excluded_categories = key
            .excluded_categories
            .iter()
            .map(|category| Cow::Borrowed(category.as_str()))
            .collect::<Vec<_>>();
        let included_categories = if key.category_all {
            IncludedCategories::All
        } else {
            IncludedCategories::List(&categories)
        };
        let batch_scan_target = slugs
            .len()
            .saturating_mul(MAX_LISTPAGES_RENDER_LIMIT as usize)
            .min(MAX_LISTPAGES_RENDER_SCAN_ROWS as usize);
        let query = PageQuery {
            current_page_id,
            current_site_id,
            queried_site_id: None,
            page_type: PageTypeSelector::Normal,
            categories: CategoriesSelector {
                included_categories,
                excluded_categories: &excluded_categories,
            },
            tags: TagCondition {
                any_present: &[],
                all_present: &[],
                none_present: &[],
                untagged: false,
            },
            page_parent: PageParentSelector::All,
            contains_outgoing_links: &[],
            creation_date: DateSelector::FromPresent {
                start: time::OffsetDateTime::UNIX_EPOCH,
            },
            update_date: DateSelector::FromPresent {
                start: time::OffsetDateTime::UNIX_EPOCH,
            },
            author: AuthorSelector::All,
            score: &[],
            votes: &[],
            offset: 0,
            name: None,
            slug: None,
            slugs,
            data_form_fields: &[],
            order: None,
            candidate_limit: None,
            pagination: PaginationSelector {
                limit: Some(batch_scan_target as u64),
                per_page: PaginationSelector::default().per_page,
                reversed: false,
            },
            fields,
        };
        let found = RenderRuntime::new(ctx)
            .find_viewable_list_pages_rows(
                query,
                batch_scan_target,
                permission_cache,
                None,
            )
            .await?;
        if found.view_permission_filtering_applied {
            return Ok(None);
        }
        let mut pages_by_slug = BTreeMap::<String, Vec<FoundPageRow>>::new();
        for page in found.pages.pages {
            if let Some(slug) = page.slug.clone() {
                pages_by_slug.entry(slug).or_default().push(page);
            }
        }
        if pages_by_slug.values().any(|pages| pages.len() > 1) {
            return Ok(None);
        }
        Ok(Some(pages_by_slug))
    }

    pub(in crate::services::render) async fn load_list_pages_batch_displays(
        ctx: &ServiceContext<'_>,
        pages: &[FoundPageRow],
        requirements: ListPagesBatchDisplayRequirements,
    ) -> Result<ListPagesBatchDisplays> {
        let user_displays = if requirements.users {
            Self::load_wikidot_user_displays(ctx, pages).await?
        } else {
            BTreeMap::new()
        };
        let snapshot_displays = if requirements.snapshots {
            Self::load_list_pages_snapshot_displays(ctx, pages).await?
        } else {
            BTreeMap::new()
        };
        let runtime_displays = if requirements.runtime {
            Self::load_list_pages_runtime_displays(ctx, pages).await?
        } else {
            BTreeMap::new()
        };
        Ok(ListPagesBatchDisplays {
            user_displays,
            snapshot_displays,
            runtime_displays,
        })
    }
}
