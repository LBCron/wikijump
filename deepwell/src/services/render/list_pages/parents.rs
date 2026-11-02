/*
 * services/render/list_pages/parents.rs
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

use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::services::ServiceContext;
use crate::services::page_query::FoundPageRow;
use crate::services::permission::{CheckPermissionContext, PermissionService};
use crate::types::{Action, Permission, Reference, Resource};
use sea_orm::{ConnectionTrait, FromQueryResult, Statement};
use std::collections::{BTreeMap, BTreeSet};

const MAX_LISTPAGES_CHILD_PERMISSION_SCAN_ROWS: usize = 50_000;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(in crate::services::render) struct ListPagesParentDisplay {
    pub(in crate::services::render) fullname: String,
    pub(in crate::services::render) name: String,
    pub(in crate::services::render) category: String,
    pub(in crate::services::render) title: String,
}

pub(in crate::services::render) async fn load_list_pages_child_counts(
    ctx: &ServiceContext<'_>,
    viewer_user_id: Option<i64>,
    pages: &[FoundPageRow],
) -> Result<Option<BTreeMap<i64, u64>>> {
    #[derive(FromQueryResult, Debug)]
    struct ChildRow {
        parent_page_id: i64,
        child_page_id: Option<i64>,
        child_site_id: Option<i64>,
        child_category_id: Option<i64>,
    }

    let page_ids = pages
        .iter()
        .map(|page| page.page_id)
        .collect::<BTreeSet<_>>();
    if page_ids.is_empty() {
        return Ok(Some(BTreeMap::new()));
    }

    let make_error = || {
        Error::new(
            "failed to count child pages for ListPages render",
            ErrorType::Render,
        )
    };
    let values = page_ids
        .iter()
        .map(|page_id| format!("({page_id})"))
        .collect::<Vec<_>>()
        .join(", ");
    let txn = ctx.transaction();
    let statement = Statement::from_string(
        txn.get_database_backend(),
        format!(
            "WITH input(page_id) AS (VALUES {values}) \
             SELECT input.page_id AS parent_page_id, child.page_id AS child_page_id, \
                    child.site_id AS child_site_id, \
                    child.page_category_id AS child_category_id \
             FROM input \
             LEFT JOIN page_parent ON page_parent.parent_page_id = input.page_id \
             LEFT JOIN page child ON child.page_id = page_parent.child_page_id \
                 AND child.deleted_at IS NULL \
             ORDER BY input.page_id, child.page_id \
             LIMIT {}",
            MAX_LISTPAGES_CHILD_PERMISSION_SCAN_ROWS + 1,
        ),
    );

    let rows = ChildRow::find_by_statement(statement)
        .all(txn)
        .await
        .or_raise(make_error)?;

    if rows.len() > MAX_LISTPAGES_CHILD_PERMISSION_SCAN_ROWS {
        return Ok(None);
    }

    let mut counts = BTreeMap::<i64, u64>::new();
    let mut permission_cache = BTreeMap::<(i64, i64), bool>::new();
    for row in rows {
        let (Some(child_page_id), Some(child_site_id), Some(child_category_id)) =
            (row.child_page_id, row.child_site_id, row.child_category_id)
        else {
            counts.entry(row.parent_page_id).or_insert(0);
            continue;
        };
        let can_view = if let Some(can_view) =
            permission_cache.get(&(child_site_id, child_page_id))
        {
            *can_view
        } else {
            let can_view = PermissionService::check_user_can(
                ctx,
                &CheckPermissionContext {
                    user_id: viewer_user_id,
                    site_id: child_site_id,
                    page_reference: Some(Reference::Id(child_page_id)),
                },
                Permission {
                    resource_type: Resource::Page,
                    resource_category: Some(Reference::Id(child_category_id)),
                    action: Action::View,
                },
            )
            .await?;
            permission_cache.insert((child_site_id, child_page_id), can_view);
            can_view
        };
        if can_view {
            *counts.entry(row.parent_page_id).or_insert(0) += 1;
        } else {
            counts.entry(row.parent_page_id).or_insert(0);
        }
    }

    Ok(Some(counts))
}

pub(in crate::services::render) async fn load_list_pages_parent_displays(
    ctx: &ServiceContext<'_>,
    viewer_user_id: Option<i64>,
    pages: &[FoundPageRow],
) -> Result<BTreeMap<i64, ListPagesParentDisplay>> {
    #[derive(FromQueryResult, Debug)]
    struct ParentRow {
        child_page_id: i64,
        parent_page_id: i64,
        parent_site_id: i64,
        parent_category_id: i64,
        parent_slug: String,
        parent_title: String,
    }

    let page_ids = pages
        .iter()
        .map(|page| page.page_id)
        .collect::<BTreeSet<_>>();
    if page_ids.is_empty() {
        return Ok(BTreeMap::new());
    }

    let make_error = || {
        Error::new(
            "failed to load parent page names for ListPages render",
            ErrorType::Render,
        )
    };
    let values = page_ids
        .iter()
        .map(|page_id| format!("({page_id})"))
        .collect::<Vec<_>>()
        .join(", ");
    let txn = ctx.transaction();
    let statement = Statement::from_string(
        txn.get_database_backend(),
        format!(
            "WITH input(page_id) AS (VALUES {values}) \
             SELECT page_parent.child_page_id, page.page_id AS parent_page_id, \
                    page.site_id AS parent_site_id, \
                    page.page_category_id AS parent_category_id, \
                    page.slug AS parent_slug, \
                    page_revision.title AS parent_title \
             FROM input \
             JOIN page_parent ON page_parent.child_page_id = input.page_id \
             JOIN page ON page.page_id = page_parent.parent_page_id \
             JOIN page_revision ON page_revision.revision_id = page.latest_revision_id \
             WHERE page.deleted_at IS NULL",
        ),
    );

    let rows = ParentRow::find_by_statement(statement)
        .all(txn)
        .await
        .or_raise(make_error)?;

    let mut permission_cache = BTreeMap::<(i64, i64), bool>::new();
    let mut visible_rows = Vec::new();
    let mut denied_children = BTreeSet::new();
    for row in rows {
        let can_view = if let Some(can_view) =
            permission_cache.get(&(row.parent_site_id, row.parent_page_id))
        {
            *can_view
        } else {
            let can_view = PermissionService::check_user_can(
                ctx,
                &CheckPermissionContext {
                    user_id: viewer_user_id,
                    site_id: row.parent_site_id,
                    page_reference: Some(Reference::Id(row.parent_page_id)),
                },
                Permission {
                    resource_type: Resource::Page,
                    resource_category: Some(Reference::Id(row.parent_category_id)),
                    action: Action::View,
                },
            )
            .await?;
            permission_cache.insert((row.parent_site_id, row.parent_page_id), can_view);
            can_view
        };
        if !can_view {
            denied_children.insert(row.child_page_id);
            continue;
        }
        let ParentRow {
            child_page_id,
            parent_slug,
            parent_title,
            ..
        } = row;
        let (category, name) = parent_slug
            .split_once(':')
            .map_or(("", parent_slug.as_str()), |(category, name)| {
                (category, name)
            });
        visible_rows.push((
            child_page_id,
            ListPagesParentDisplay {
                fullname: parent_slug.clone(),
                name: name.to_owned(),
                category: category.to_owned(),
                title: parent_title,
            },
        ));
    }

    visible_rows.retain(|(child_page_id, _)| !denied_children.contains(child_page_id));
    Ok(collapse_parent_rows(visible_rows.into_iter()))
}

fn collapse_parent_rows(
    rows: impl Iterator<Item = (i64, ListPagesParentDisplay)>,
) -> BTreeMap<i64, ListPagesParentDisplay> {
    let mut parents = BTreeMap::<i64, Option<ListPagesParentDisplay>>::new();
    for (child_page_id, parent) in rows {
        parents
            .entry(child_page_id)
            .and_modify(|slot| *slot = None)
            .or_insert(Some(parent));
    }

    parents
        .into_iter()
        .filter_map(|(child_page_id, parent)| Some((child_page_id, parent?)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(fullname: &str) -> ListPagesParentDisplay {
        let (category, name) = fullname
            .split_once(':')
            .map_or(("", fullname), |(category, name)| (category, name));
        ListPagesParentDisplay {
            fullname: fullname.to_owned(),
            name: name.to_owned(),
            category: category.to_owned(),
            title: format!("Title {fullname}"),
        }
    }

    fn collapse(rows: Vec<(i64, &str)>) -> BTreeMap<i64, ListPagesParentDisplay> {
        collapse_parent_rows(
            rows.into_iter().map(|(child_page_id, parent_slug)| {
                (child_page_id, display(parent_slug))
            }),
        )
    }

    #[test]
    fn resolves_only_rows_with_exactly_one_live_parent() {
        let resolved = collapse(vec![
            (1, "component:offset-timeline"),
            (2, "component:offset-timeline"),
            (3, "first:parent"),
            (3, "second:parent"),
        ]);

        assert_eq!(
            resolved,
            BTreeMap::from([
                (1, display("component:offset-timeline")),
                (2, display("component:offset-timeline")),
            ]),
        );
        assert!(!resolved.contains_key(&3));
        assert!(!resolved.contains_key(&4));
    }
}
