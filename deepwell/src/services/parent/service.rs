/*
 * services/parent/service.rs
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

use super::structs::{ParentDescription, ParentalRelationshipType, RemoveParentOutput};
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::page::Model as PageModel;
use crate::models::page_parent::{self, Entity as PageParent, Model as PageParentModel};
use crate::services::relation::RelationObject;
use crate::services::{OutdateService, PageService, RelationService, ServiceContext};
use crate::types::{PageId, Reference, RerenderDepth};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, DeleteResult, EntityTrait, QueryFilter,
    QuerySelect, Set,
};
use std::collections::BTreeMap;
use std::collections::HashSet;

#[derive(Debug)]
pub struct ParentService;

impl ParentService {
    pub async fn create(
        ctx: &ServiceContext<'_>,
        ParentDescription {
            site_id,
            parent: parent_reference,
            child: child_reference,
        }: ParentDescription<'_>,
    ) -> Result<Option<PageParentModel>> {
        let txn = ctx.transaction();

        let ParentAndChild {
            parent_page,
            child_page,
        } = Self::get_parent_child(ctx, site_id, parent_reference, child_reference)
            .await
            .or_raise(|| {
                Error::new("failed to create page parents", ErrorType::PageParent)
            })?;

        let make_error = || {
            Error::new(
                format!(
                    "failed to create page parents for parent '{}' (ID {}) to child '{}' (ID {})",
                    parent_page.slug,
                    parent_page.page_id,
                    child_page.slug,
                    child_page.page_id,
                ),
                ErrorType::PageParent,
            )
        };

        RelationService::assert_distinct_relation_objects(
            RelationObject::Page(parent_page.page_id),
            RelationObject::Page(child_page.page_id),
        )?;

        let relationship =
            PageParent::find_by_id((parent_page.page_id, child_page.page_id))
                .one(txn)
                .await
                .or_raise(make_error)?;

        match relationship {
            None => {
                let cyclic =
                    Self::check_cycle(ctx, parent_page.page_id, child_page.page_id)
                        .await
                        .or_raise(|| {
                            Error::new(
                                "failed to check if setting page parent forms a cycle",
                                ErrorType::PageParent,
                            )
                        })?;

                if cyclic {
                    error!(
                        "Setting parent {} for page {} creates a cycle",
                        parent_page.page_id, child_page.page_id
                    );
                    bail!(Error::new(
                        format!(
                            "Setting parent {} for page {} creates a cycle",
                            parent_page.page_id, child_page.page_id
                        ),
                        ErrorType::PageParent
                    ));
                }

                let model = page_parent::ActiveModel {
                    parent_page_id: Set(parent_page.page_id),
                    child_page_id: Set(child_page.page_id),
                    ..Default::default()
                };

                let relationship = model.insert(txn).await.or_raise(make_error)?;
                ctx.defer_rerender_page(
                    PageId::from_page_model(&parent_page),
                    RerenderDepth::default(),
                )
                .or_raise(make_error)?;
                Ok(Some(relationship))
            }

            Some(_) => Ok(None),
        }
    }

    pub async fn remove(
        ctx: &ServiceContext<'_>,
        ParentDescription {
            site_id,
            parent: parent_reference,
            child: child_reference,
        }: ParentDescription<'_>,
    ) -> Result<RemoveParentOutput> {
        let txn = ctx.transaction();

        let ParentAndChild {
            parent_page,
            child_page,
        } = Self::get_parent_child(ctx, site_id, parent_reference, child_reference)
            .await
            .or_raise(|| {
                Error::new("failed to remove page parents", ErrorType::PageParent)
            })?;

        let make_error = || {
            Error::new(
                format!(
                    "failed to remove page parents for parent '{}' (ID {}) to child '{}' (ID {})",
                    parent_page.slug,
                    parent_page.page_id,
                    child_page.slug,
                    child_page.page_id,
                ),
                ErrorType::PageParent,
            )
        };

        let DeleteResult { rows_affected, .. } =
            PageParent::delete_by_id((parent_page.page_id, child_page.page_id))
                .exec(txn)
                .await
                .or_raise(make_error)?;

        debug_assert!(
            rows_affected <= 1,
            "Rows deleted using ID was more than 1: {rows_affected}",
        );

        let was_deleted = rows_affected == 1;
        if was_deleted {
            ctx.defer_rerender_page(
                PageId::from_page_model(&parent_page),
                RerenderDepth::default(),
            )
            .or_raise(make_error)?;
        }
        Ok(RemoveParentOutput { was_deleted })
    }

    pub async fn get_optional(
        ctx: &ServiceContext<'_>,
        ParentDescription {
            site_id,
            parent: parent_reference,
            child: child_reference,
        }: ParentDescription<'_>,
    ) -> Result<Option<PageParentModel>> {
        let txn = ctx.transaction();

        let ParentAndChild {
            parent_page,
            child_page,
        } = Self::get_parent_child(ctx, site_id, parent_reference, child_reference)
            .await
            .or_raise(|| {
                Error::new("failed to get page parents", ErrorType::PageParent)
            })?;

        let make_error = || {
            Error::new(
                format!(
                    "failed to get page parents for parent '{}' (ID {}) to child '{}' (ID {})",
                    parent_page.slug,
                    parent_page.page_id,
                    child_page.slug,
                    child_page.page_id,
                ),
                ErrorType::PageParent,
            )
        };

        let model = PageParent::find_by_id((parent_page.page_id, child_page.page_id))
            .one(txn)
            .await
            .or_raise(make_error)?;

        Ok(model)
    }

    pub async fn get_relationships(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        reference: Reference<'_>,
        relationship_type: ParentalRelationshipType,
    ) -> Result<Vec<PageParentModel>> {
        let txn = ctx.transaction();

        let make_error = || {
            Error::new(
                format!(
                    "failed to get page parents relations in site ID {} for {:?} {:?}",
                    site_id, reference, relationship_type,
                ),
                ErrorType::PageParent,
            )
        };

        let page_id = PageService::get_id(ctx, site_id, reference.borrow())
            .await
            .or_raise(make_error)?;

        let column = match relationship_type {
            ParentalRelationshipType::Parent => page_parent::Column::ChildPageId,
            ParentalRelationshipType::Child => page_parent::Column::ParentPageId,
        };

        let models = PageParent::find()
            .filter(column.eq(page_id))
            .all(txn)
            .await
            .or_raise(make_error)?;

        Ok(models)
    }

    pub async fn get_children(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        reference: Reference<'_>,
    ) -> Result<Vec<PageParentModel>> {
        Self::get_relationships(
            ctx,
            site_id,
            reference.borrow(),
            ParentalRelationshipType::Child,
        )
        .await
        .or_raise(|| {
            Error::new(
                format!(
                    "failed to get children of page {:?} in site ID {}",
                    reference, site_id,
                ),
                ErrorType::PageParent,
            )
        })
    }

    pub async fn get_parents(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        reference: Reference<'_>,
    ) -> Result<Vec<PageParentModel>> {
        Self::get_relationships(
            ctx,
            site_id,
            reference.borrow(),
            ParentalRelationshipType::Parent,
        )
        .await
        .or_raise(|| {
            Error::new(
                format!(
                    "failed to get parents of page {:?} in site ID {}",
                    reference, site_id,
                ),
                ErrorType::PageParent,
            )
        })
    }

    pub async fn get_parents_batch(
        ctx: &ServiceContext<'_>,
        page_ids: &[i64],
    ) -> Result<BTreeMap<i64, Vec<PageParentModel>>> {
        if page_ids.is_empty() {
            return Ok(BTreeMap::new());
        }

        let make_error = || {
            Error::new(
                format!(
                    "failed to get page parent relations for {} pages in batch",
                    page_ids.len(),
                ),
                ErrorType::PageParent,
            )
        };
        let models = PageParent::find()
            .filter(page_parent::Column::ChildPageId.is_in(page_ids.iter().copied()))
            .all(ctx.transaction())
            .await
            .or_raise(make_error)?;

        let mut grouped = page_ids
            .iter()
            .copied()
            .map(|page_id| (page_id, Vec::new()))
            .collect::<BTreeMap<_, _>>();
        for model in models {
            grouped.entry(model.child_page_id).or_default().push(model);
        }
        Ok(grouped)
    }

    pub async fn get_parents_multi(
        ctx: &ServiceContext<'_>,
        children_id: Vec<i64>,
    ) -> Result<Vec<PageParentModel>> {
        let txn = ctx.transaction();
        PageParent::find()
            .filter(page_parent::Column::ChildPageId.is_in(children_id.clone()))
            .all(txn)
            .await
            .or_raise(|| {
                Error::new(
                    format!("failed to get parents of pages {:?}", children_id,),
                    ErrorType::PageParent,
                )
            })
    }

    pub async fn remove_all(ctx: &ServiceContext<'_>, page_id: i64) -> Result<u64> {
        let txn = ctx.transaction();

        let make_error = || {
            Error::new(
                format!(
                    "failed to remove all parent/child relationships for page ID {}",
                    page_id,
                ),
                ErrorType::PageParent,
            )
        };

        let former_parent_ids = PageParent::find()
            .select_only()
            .column(page_parent::Column::ParentPageId)
            .filter(page_parent::Column::ChildPageId.eq(page_id))
            .into_tuple()
            .all(txn)
            .await
            .or_raise(make_error)?;

        let rows_deleted = PageParent::delete_many()
            .filter(
                Condition::any()
                    .add(page_parent::Column::ParentPageId.eq(page_id))
                    .add(page_parent::Column::ChildPageId.eq(page_id)),
            )
            .exec(txn)
            .await
            .or_raise(make_error)?
            .rows_affected;

        for parent_id in former_parent_ids {
            OutdateService::defer(ctx, parent_id, RerenderDepth::default())
                .await
                .or_raise(make_error)?;
        }

        Ok(rows_deleted)
    }

    pub async fn check_cycle(
        ctx: &ServiceContext<'_>,
        parent_id: i64,
        child_id: i64,
    ) -> Result<bool> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to check cycle for parent page ID {} and child page ID {}",
                    parent_id, child_id
                ),
                ErrorType::PageParent,
            )
        };

        let mut checked_pages: HashSet<i64> = HashSet::new();
        let mut current_checking: Vec<i64> = vec![parent_id];
        loop {
            let parents = Self::get_parents_multi(ctx, current_checking.clone())
                .await
                .or_raise(make_error)?;

            checked_pages.extend(current_checking.iter());

            if parents.is_empty() {
                break;
            };

            current_checking = parents
                .clone()
                .into_iter()
                .filter_map(|p| {
                    if checked_pages.contains(&p.parent_page_id) {
                        None
                    } else {
                        Some(p.parent_page_id)
                    }
                })
                .collect();

            if current_checking.contains(&child_id) {
                return Ok(true);
            }
        }

        if checked_pages.contains(&child_id) {
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

#[derive(Debug)]
struct ParentAndChild {
    parent_page: PageModel,
    child_page: PageModel,
}

impl ParentService {
    async fn get_parent_child(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        parent_reference: Reference<'_>,
        child_reference: Reference<'_>,
    ) -> Result<ParentAndChild> {
        let make_error = || {
            Error::new(
                "failed to get parent and child from reference",
                ErrorType::PageParent,
            )
        };

        let (parent_page_result, child_page_result) = join!(
            PageService::get(ctx, site_id, parent_reference),
            PageService::get(ctx, site_id, child_reference),
        );

        let (parent_page, child_page) =
            raise_multiple!(parent_page_result, child_page_result; make_error);

        Ok(ParentAndChild {
            parent_page,
            child_page,
        })
    }
}
