/*
 * services/forum_thread/service.rs
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

#![allow(dead_code)] // TEMP

use super::structs::{
    CreateForumThread, DeleteForumThread, ForumThreadListOrder, GetForumThread,
    GetForumThreads, TouchForumThread, UpdateForumThread, UpdateForumThreadBody,
};
use crate::constants::ANONYMOUS_USER_ID;
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::forum_category::{
    self, Entity as ForumCategory, Model as ForumCategoryModel,
};
use crate::models::forum_group::{self, Entity as ForumGroup};
use crate::models::forum_thread::{
    self, Entity as ForumThread, Model as ForumThreadModel,
};
use crate::models::page::Model as PageModel;
use crate::models::{forum_post, forum_post_revision};
use crate::services::forum::{CreateForumCategory, CreateForumGroup};
use crate::services::{ForumService, ServiceContext};
use crate::types::Maybe;
use crate::utils::now;
use paste::paste;
use sea_orm::sea_query::OnConflict;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, EntityTrait, IntoActiveModel, QueryFilter,
    QueryOrder, QuerySelect, Set,
};
use sea_query::Expr;

#[derive(Debug)]
pub struct ForumThreadService;

impl ForumThreadService {
    pub async fn get_or_create_page_discussion(
        ctx: &ServiceContext<'_>,
        page: &PageModel,
        user_id: i64,
        title: &str,
    ) -> Result<ForumThreadModel> {
        let make_error = || {
            Error::new(
                format!(
                    "failed to get or create page discussion for page ID {}",
                    page.page_id,
                ),
                ErrorType::ForumThread,
            )
        };
        let txn = ctx.transaction();

        let pointed_thread = match page.discussion_thread_id {
            Some(thread_id) => ForumThread::find_by_id(thread_id)
                .lock_exclusive()
                .one(txn)
                .await
                .or_raise(make_error)?,
            None => None,
        };
        let associated_thread = ForumThread::find()
            .filter(forum_thread::Column::PageId.eq(page.page_id))
            .lock_exclusive()
            .one(txn)
            .await
            .or_raise(make_error)?;

        if let Some(mut thread) = pointed_thread {
            Self::ensure_page_discussion_site(&thread, page)?;
            if thread.page_id.is_some() && thread.page_id != Some(page.page_id) {
                bail!(Error::new(
                    format!(
                        "page discussion thread ID {} points to page ID {:?}, not page ID {}",
                        thread.forum_thread_id, thread.page_id, page.page_id,
                    ),
                    ErrorType::ForumThread,
                ));
            }

            if thread.deleted_at.is_some() {
                bail!(Error::new(
                    format!(
                        "page discussion thread ID {} has been deleted",
                        thread.forum_thread_id,
                    ),
                    ErrorType::ForumThread,
                ));
            }
            Self::ensure_page_discussion_container_active(ctx, &thread, page).await?;

            if let Some(associated) = associated_thread.as_ref() {
                Self::ensure_page_discussion_site(associated, page)?;
                if associated.forum_thread_id != thread.forum_thread_id {
                    bail!(Error::new(
                        format!(
                            "page ID {} has conflicting discussion thread IDs {} and {}",
                            page.page_id,
                            thread.forum_thread_id,
                            associated.forum_thread_id,
                        ),
                        ErrorType::ForumThread,
                    ));
                }
            }
            if thread.page_id != Some(page.page_id) {
                let claim = ForumThread::update_many()
                    .set(forum_thread::ActiveModel {
                        page_id: Set(Some(page.page_id)),
                        ..Default::default()
                    })
                    .filter(
                        Condition::all()
                            .add(
                                forum_thread::Column::ForumThreadId
                                    .eq(thread.forum_thread_id),
                            )
                            .add(forum_thread::Column::PageId.is_null()),
                    )
                    .exec(txn)
                    .await
                    .or_raise(make_error)?;
                if claim.rows_affected != 1 {
                    bail!(Error::new(
                        format!(
                            "page discussion thread ID {} could not be claimed by page ID {}",
                            thread.forum_thread_id, page.page_id,
                        ),
                        ErrorType::ForumThread,
                    ));
                }
                thread.page_id = Some(page.page_id);
            }
            return Ok(thread);
        }

        if let Some(thread) = associated_thread {
            Self::ensure_page_discussion_site(&thread, page)?;
            if thread.deleted_at.is_some() {
                bail!(Error::new(
                    format!(
                        "page discussion thread ID {} has been deleted",
                        thread.forum_thread_id,
                    ),
                    ErrorType::ForumThread,
                ));
            }
            Self::ensure_page_discussion_container_active(ctx, &thread, page).await?;
            if page.discussion_thread_id != Some(thread.forum_thread_id) {
                let mut page = page.clone().into_active_model();
                page.discussion_thread_id = Set(Some(thread.forum_thread_id));
                page.update(txn).await.or_raise(make_error)?;
            }
            return Ok(thread);
        }

        let category = Self::active_page_discussion_category(ctx, page.site_id)
            .await?
            .ok_or_else(|| {
                Error::new(
                    format!(
                        "site ID {} has no active per-page discussion forum category in an active group",
                        page.site_id,
                    ),
                    ErrorType::ForumCategory,
                )
            })?;

        ForumThread::insert(forum_thread::ActiveModel {
            forum_category_id: Set(category.forum_category_id),
            forum_group_id: Set(category.forum_group_id),
            site_id: Set(category.site_id),
            page_id: Set(Some(page.page_id)),
            created_by: Set(user_id),
            title: Set(title.to_owned()),
            description: Set(format!(
                "This is the discussion related to the wiki page {title} .",
            )),
            sticky: Set(false),
            from_wikidot: Set(true),
            ..Default::default()
        })
        .on_conflict(
            OnConflict::column(forum_thread::Column::PageId)
                .do_nothing()
                .to_owned(),
        )
        .exec_without_returning(txn)
        .await
        .or_raise(make_error)?;

        let thread = ForumThread::find()
            .filter(forum_thread::Column::PageId.eq(page.page_id))
            .filter(forum_thread::Column::DeletedAt.is_null())
            .lock_exclusive()
            .one(txn)
            .await
            .or_raise(make_error)?
            .ok_or_else(make_error)?;

        let mut page = page.clone().into_active_model();
        page.discussion_thread_id = Set(Some(thread.forum_thread_id));
        page.update(txn).await.or_raise(make_error)?;
        Ok(thread)
    }

    pub async fn ensure_page_discussion_category(
        ctx: &ServiceContext<'_>,
        site_id: i64,
    ) -> Result<ForumCategoryModel> {
        if let Some(category) =
            Self::active_page_discussion_category(ctx, site_id).await?
        {
            return Ok(category);
        }

        let txn = ctx.transaction();
        let group =
            ForumGroup::find()
                .filter(forum_group::Column::SiteId.eq(site_id))
                .filter(forum_group::Column::Name.eq("Hidden"))
                .filter(forum_group::Column::DeletedAt.is_null())
                .order_by_asc(forum_group::Column::SortIndex)
                .lock_exclusive()
                .one(txn)
                .await
                .or_raise(|| {
                    Error::new(
                        format!(
                            "failed to find the hidden forum group in site ID {site_id}",
                        ),
                        ErrorType::ForumGroup,
                    )
                })?;
        let group = match group {
            Some(group) => group,
            None => ForumService::create_group(
                ctx,
                CreateForumGroup {
                    site_id,
                    user_id: ANONYMOUS_USER_ID,
                    name: "Hidden".to_owned(),
                    description: "Hidden group used for storing some discussion threads."
                        .to_owned(),
                    visible: false,
                    sort_index: None,
                    from_wikidot: true,
                },
            )
            .await
            .or_raise(|| {
                Error::new(
                    format!(
                        "failed to create the hidden forum group in site ID {site_id}",
                    ),
                    ErrorType::ForumGroup,
                )
            })?,
        };

        ForumService::create_category(
            ctx,
            CreateForumCategory {
                forum_group_id: group.forum_group_id,
                user_id: ANONYMOUS_USER_ID,
                name: "Per page discussions".to_owned(),
                description: concat!(
                    "This category groups discussions related to particular pages ",
                    "within this site.",
                )
                .to_owned(),
                sort_index: None,
                max_nest_level: None,
                per_page_discussion: Some(true),
                layout: None,
                from_wikidot: true,
            },
        )
        .await
        .or_raise(|| {
            Error::new(
                format!(
                    "failed to create the per-page discussion forum category in site ID {site_id}",
                ),
                ErrorType::ForumCategory,
            )
        })
    }

    async fn active_page_discussion_category(
        ctx: &ServiceContext<'_>,
        site_id: i64,
    ) -> Result<Option<ForumCategoryModel>> {
        let txn = ctx.transaction();
        let categories = ForumCategory::find()
            .filter(forum_category::Column::SiteId.eq(site_id))
            .filter(forum_category::Column::DeletedAt.is_null())
            .filter(forum_category::Column::PerPageDiscussion.eq(true))
            .order_by_asc(forum_category::Column::SortIndex)
            .order_by_asc(forum_category::Column::ForumCategoryId)
            .lock_exclusive()
            .all(txn)
            .await
            .or_raise(|| {
                Error::new(
                    format!(
                        "failed to find active per-page discussion categories in site ID {}",
                        site_id,
                    ),
                    ErrorType::ForumCategory,
                )
            })?;

        for category in categories {
            let group = ForumGroup::find_by_id(category.forum_group_id)
                .lock_exclusive()
                .one(txn)
                .await
                .or_raise(|| {
                    Error::new(
                        format!(
                            "failed to load forum group ID {} for page discussion category ID {}",
                            category.forum_group_id, category.forum_category_id,
                        ),
                        ErrorType::ForumGroup,
                    )
                })?
                .ok_or_else(|| {
                    Error::new(
                        format!(
                            "page discussion category ID {} has no forum group ID {}",
                            category.forum_category_id, category.forum_group_id,
                        ),
                        ErrorType::ForumGroup,
                    )
                })?;
            if group.site_id != site_id {
                bail!(Error::new(
                    format!(
                        "page discussion category ID {} belongs to site ID {}, but group ID {} belongs to site ID {}",
                        category.forum_category_id,
                        category.site_id,
                        group.forum_group_id,
                        group.site_id,
                    ),
                    ErrorType::ForumGroup,
                ));
            }
            if group.deleted_at.is_none() {
                return Ok(Some(category));
            }
        }

        Ok(None)
    }

    fn ensure_page_discussion_site(
        thread: &ForumThreadModel,
        page: &PageModel,
    ) -> Result<()> {
        if thread.site_id == page.site_id {
            return Ok(());
        }
        bail!(Error::new(
            format!(
                "page discussion thread ID {} belongs to site ID {}, not page site ID {}",
                thread.forum_thread_id, thread.site_id, page.site_id,
            ),
            ErrorType::ForumThread,
        ));
    }

    async fn ensure_page_discussion_container_active(
        ctx: &ServiceContext<'_>,
        thread: &ForumThreadModel,
        page: &PageModel,
    ) -> Result<()> {
        let txn = ctx.transaction();
        let category = ForumCategory::find_by_id(thread.forum_category_id)
            .lock_exclusive()
            .one(txn)
            .await
            .or_raise(|| {
                Error::new(
                    format!(
                        "failed to load forum category ID {} for page discussion thread ID {}",
                        thread.forum_category_id, thread.forum_thread_id,
                    ),
                    ErrorType::ForumCategory,
                )
            })?
            .ok_or_else(|| {
                Error::new(
                    format!(
                        "page discussion thread ID {} has no forum category ID {}",
                        thread.forum_thread_id, thread.forum_category_id,
                    ),
                    ErrorType::ForumCategory,
                )
            })?;
        if category.deleted_at.is_some()
            || category.site_id != page.site_id
            || category.forum_group_id != thread.forum_group_id
        {
            bail!(Error::new(
                format!(
                    "page discussion thread ID {} belongs to an inactive or inconsistent forum category ID {}",
                    thread.forum_thread_id, category.forum_category_id,
                ),
                ErrorType::ForumCategory,
            ));
        }

        let group = ForumGroup::find_by_id(thread.forum_group_id)
            .lock_exclusive()
            .one(txn)
            .await
            .or_raise(|| {
                Error::new(
                    format!(
                        "failed to load forum group ID {} for page discussion thread ID {}",
                        thread.forum_group_id, thread.forum_thread_id,
                    ),
                    ErrorType::ForumGroup,
                )
            })?
            .ok_or_else(|| {
                Error::new(
                    format!(
                        "page discussion thread ID {} has no forum group ID {}",
                        thread.forum_thread_id, thread.forum_group_id,
                    ),
                    ErrorType::ForumGroup,
                )
            })?;
        if group.deleted_at.is_some() || group.site_id != page.site_id {
            bail!(Error::new(
                format!(
                    "page discussion thread ID {} belongs to inactive or cross-site forum group ID {}",
                    thread.forum_thread_id, group.forum_group_id,
                ),
                ErrorType::ForumGroup,
            ));
        }

        Ok(())
    }

    pub async fn create(
        ctx: &ServiceContext<'_>,
        CreateForumThread {
            forum_category_id,
            user_id,
            associated_page_id,
            title,
            description,
            sticky,
            from_wikidot,
        }: CreateForumThread,
    ) -> Result<ForumThreadModel> {
        let category = ForumService::get_category_direct(ctx, forum_category_id, false)
            .await
            .or_raise(|| {
                Error::new(
                    format!(
                        "failed to create forum thread in category ID {}",
                        forum_category_id,
                    ),
                    ErrorType::ForumThread,
                )
            })?;

        let txn = ctx.transaction();
        let model = forum_thread::ActiveModel {
            forum_category_id: Set(category.forum_category_id),
            forum_group_id: Set(category.forum_group_id),
            site_id: Set(category.site_id),
            page_id: Set(associated_page_id),
            created_by: Set(user_id),
            title: Set(title),
            description: Set(description),
            sticky: Set(sticky),
            from_wikidot: Set(from_wikidot),
            ..Default::default()
        };

        let thread = model.insert(txn).await.or_raise(|| {
            Error::new(
                format!(
                    "failed to create forum thread in category ID {} by user ID {}",
                    forum_category_id, user_id,
                ),
                ErrorType::ForumThread,
            )
        })?;

        // TODO(WJ-1340): notify people watching this category about the new thread.

        Ok(thread)
    }

    pub async fn update(
        ctx: &ServiceContext<'_>,
        UpdateForumThread {
            forum_thread_id,
            user_id,
            body:
                UpdateForumThreadBody {
                    forum_category_id,
                    title,
                    description,
                    sticky,
                },
        }: UpdateForumThread,
    ) -> Result<ForumThreadModel> {
        let txn = ctx.transaction();
        let make_error = || {
            Error::new(
                format!(
                    "failed to update forum thread ID {} by user ID {}",
                    forum_thread_id, user_id,
                ),
                ErrorType::ForumThread,
            )
        };

        let thread = Self::get(
            ctx,
            GetForumThread {
                forum_thread_id,
                include_deleted: false,
            },
        )
        .await
        .or_raise(make_error)?;

        let old_category_id = thread.forum_category_id;
        let mut new_category_id = thread.forum_category_id;
        let mut new_group_id = thread.forum_group_id;
        let mut new_site_id = thread.site_id;

        if let Maybe::Set(category_id) = forum_category_id {
            let category = ForumService::get_category_direct(ctx, category_id, false)
                .await
                .or_raise(make_error)?;

            // Threads are site-local. We keep the move constrained to the same site.
            if category.site_id != thread.site_id {
                bail!(Error::new(
                    format!(
                        "cannot move forum thread ID {} to category ID {} in a different site",
                        forum_thread_id, category_id,
                    ),
                    ErrorType::BadRequest,
                ));
            }

            new_category_id = category.forum_category_id;
            new_group_id = category.forum_group_id;
            new_site_id = category.site_id;
        }

        let moved_category = old_category_id != new_category_id;
        let mut model = forum_thread::ActiveModel {
            forum_thread_id: Set(thread.forum_thread_id),
            forum_category_id: Set(new_category_id),
            forum_group_id: Set(new_group_id),
            site_id: Set(new_site_id),
            updated_by: Set(Some(user_id)),
            updated_at: Set(Some(now())),
            ..Default::default()
        };

        if let Maybe::Set(title) = title {
            model.title = Set(title);
        }

        if let Maybe::Set(description) = description {
            model.description = Set(description);
        }

        if let Maybe::Set(sticky) = sticky {
            model.sticky = Set(sticky);
        }

        let thread = model.update(txn).await.or_raise(make_error)?;

        if moved_category {
            // Keep denormalized category/group/site fields in sync for thread descendants.
            let post_model = forum_post::ActiveModel {
                forum_category_id: Set(new_category_id),
                forum_group_id: Set(new_group_id),
                site_id: Set(new_site_id),
                ..Default::default()
            };

            forum_post::Entity::update_many()
                .set(post_model)
                .filter(forum_post::Column::ForumThreadId.eq(thread.forum_thread_id))
                .exec(txn)
                .await
                .or_raise(make_error)?;

            let revision_model = forum_post_revision::ActiveModel {
                forum_category_id: Set(new_category_id),
                forum_group_id: Set(new_group_id),
                site_id: Set(new_site_id),
                ..Default::default()
            };

            forum_post_revision::Entity::update_many()
                .set(revision_model)
                .filter(
                    forum_post_revision::Column::ForumThreadId.eq(thread.forum_thread_id),
                )
                .exec(txn)
                .await
                .or_raise(make_error)?;

            // TODO(WJ-1340): notify people watching the relevant categories that a thread was moved.
        }

        Ok(thread)
    }

    pub async fn delete(
        ctx: &ServiceContext<'_>,
        DeleteForumThread {
            forum_thread_id,
            user_id,
        }: DeleteForumThread,
    ) -> Result<ForumThreadModel> {
        let txn = ctx.transaction();
        let make_error = || {
            Error::new(
                format!(
                    "failed to delete forum thread ID {} by user ID {}",
                    forum_thread_id, user_id,
                ),
                ErrorType::ForumThread,
            )
        };

        let thread = Self::get(
            ctx,
            GetForumThread {
                forum_thread_id,
                include_deleted: false,
            },
        )
        .await
        .or_raise(make_error)?;

        let model = forum_thread::ActiveModel {
            forum_thread_id: Set(thread.forum_thread_id),
            deleted_by: Set(Some(user_id)),
            deleted_at: Set(Some(now())),
            updated_by: Set(Some(user_id)),
            updated_at: Set(Some(now())),
            ..Default::default()
        };

        let thread = model.update(txn).await.or_raise(make_error)?;
        Ok(thread)
    }

    pub async fn touch_activity(
        ctx: &ServiceContext<'_>,
        TouchForumThread {
            forum_thread_id,
            user_id,
        }: TouchForumThread,
    ) -> Result<ForumThreadModel> {
        let thread = Self::get(
            ctx,
            GetForumThread {
                forum_thread_id,
                include_deleted: false,
            },
        )
        .await
        .or_raise(|| {
            Error::new(
                format!(
                    "failed to touch activity for forum thread ID {}",
                    forum_thread_id,
                ),
                ErrorType::ForumThread,
            )
        })?;

        let txn = ctx.transaction();
        let model = forum_thread::ActiveModel {
            forum_thread_id: Set(thread.forum_thread_id),
            updated_by: Set(user_id),
            updated_at: Set(Some(now())),
            ..Default::default()
        };

        let thread = model.update(txn).await.or_raise(|| {
            Error::new(
                format!(
                    "failed to touch activity for forum thread ID {}",
                    forum_thread_id,
                ),
                ErrorType::ForumThread,
            )
        })?;

        Ok(thread)
    }

    pub async fn get_optional(
        ctx: &ServiceContext<'_>,
        GetForumThread {
            forum_thread_id,
            include_deleted,
        }: GetForumThread,
    ) -> Result<Option<ForumThreadModel>> {
        let txn = ctx.transaction();
        let thread = ForumThread::find()
            .filter(
                Condition::all()
                    .add(forum_thread::Column::ForumThreadId.eq(forum_thread_id))
                    .add_option(Self::deleted_condition(
                        include_deleted,
                        forum_thread::Column::DeletedAt,
                    )),
            )
            .one(txn)
            .await
            .or_raise(|| {
                Error::new(
                    format!("failed to get forum thread ID {}", forum_thread_id),
                    ErrorType::ForumThread,
                )
            })?;

        Ok(thread)
    }

    pub async fn get(
        ctx: &ServiceContext<'_>,
        key: GetForumThread,
    ) -> Result<ForumThreadModel> {
        find_or_error!(Self::get_optional(ctx, key), "forum thread", ForumThread)
    }

    pub async fn list(
        ctx: &ServiceContext<'_>,
        GetForumThreads {
            forum_category_id,
            include_deleted,
            start_thread_id,
            limit,
            order,
        }: GetForumThreads,
    ) -> Result<Vec<ForumThreadModel>> {
        use sea_orm::query::Order;
        use sea_query::func::Func;

        let txn = ctx.transaction();

        let mut query = ForumThread::find().filter(
            Condition::all()
                .add(forum_thread::Column::ForumCategoryId.eq(forum_category_id))
                .add_option(
                    start_thread_id.map(|id| forum_thread::Column::ForumThreadId.lt(id)),
                )
                .add_option(Self::deleted_condition(
                    include_deleted,
                    forum_thread::Column::DeletedAt,
                )),
        );

        query = query.order_by_desc(forum_thread::Column::Sticky);
        query = match order {
            ForumThreadListOrder::Activity => {
                let activity_expr = Expr::FunctionCall(Func::coalesce([
                    Expr::column(forum_thread::Column::UpdatedAt),
                    Expr::column(forum_thread::Column::CreatedAt),
                ]));

                query
                    .order_by(activity_expr, Order::Desc)
                    .order_by_desc(forum_thread::Column::CreatedAt)
            }
            ForumThreadListOrder::Created => {
                query.order_by_desc(forum_thread::Column::CreatedAt)
            }
        };

        let threads = query.limit(limit).all(txn).await.or_raise(|| {
            Error::new(
                format!(
                    "failed to list forum threads in category ID {}",
                    forum_category_id,
                ),
                ErrorType::ForumThread,
            )
        })?;

        Ok(threads)
    }

    fn deleted_condition(
        include_deleted: bool,
        column: impl ColumnTrait,
    ) -> Option<Expr> {
        if include_deleted {
            None
        } else {
            Some(column.is_null())
        }
    }
}
