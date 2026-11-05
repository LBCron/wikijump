/*
 * endpoints/forum_post.rs
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

use super::prelude::*;
use crate::constants::ANONYMOUS_USER_ID;
use crate::models::page::{self, Entity as Page};
use crate::services::forum_post::{
    CreateForumPost, CreateForumPostOutput, ForumPostPageSummary, ForumPostService,
    WikidotForumPost,
};
use crate::services::forum_thread::{ForumThreadService, GetForumThread};
use crate::services::permission::{CheckPermissionContext, PermissionService};
use crate::types::{Action, Permission, Reference, Resource};
use sea_orm::{ColumnTrait, Condition, EntityTrait, QueryFilter};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ForumPostCreateInput {
    site_id: i64,
    forum_thread_id: i64,
    parent_post_id: Option<i64>,
    title: String,
    wikitext: String,
    guest_name: Option<String>,
    guest_email_md5: Option<String>,
}

pub async fn forum_post_create(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<CreateForumPostOutput> {
    let input: ForumPostCreateInput = parse!(params, ForumPost);
    if ctx
        .request()
        .site_id
        .is_some_and(|request_site_id| request_site_id != input.site_id)
    {
        bail!(Error::new(
            "forum post site does not match request site",
            ErrorType::BadRequest,
        ));
    }

    let thread = ForumThreadService::get(
        ctx,
        GetForumThread {
            forum_thread_id: input.forum_thread_id,
            include_deleted: false,
        },
    )
    .await?;
    if thread.site_id != input.site_id {
        bail!(Error::new(
            "forum thread does not belong to requested site",
            ErrorType::BadRequest,
        ));
    }

    let request_user_id = ctx.request().user_id;
    let can_create = PermissionService::check_user_can(
        ctx,
        &CheckPermissionContext {
            user_id: request_user_id,
            site_id: input.site_id,
            page_reference: None,
        },
        Permission {
            resource_type: Resource::ForumCategory,
            resource_category: Some(Reference::Id(thread.forum_category_id)),
            action: Action::Create,
        },
    )
    .await?;
    if !can_create {
        bail!(Error::new(
            "user does not have permission to create a forum post",
            ErrorType::PermissionDenied,
        ));
    }

    if let Some(page_id) = thread.page_id {
        let page = Page::find_by_id(page_id)
            .filter(
                Condition::all()
                    .add(page::Column::SiteId.eq(input.site_id))
                    .add(page::Column::DeletedAt.is_null()),
            )
            .one(ctx.transaction())
            .await
            .or_raise(|| {
                Error::new("failed to load forum thread page", ErrorType::ForumPost)
            })?;
        let can_view = match page {
            Some(page) => {
                PermissionService::check_user_can(
                    ctx,
                    &CheckPermissionContext {
                        user_id: request_user_id,
                        site_id: input.site_id,
                        page_reference: Some(Reference::Id(page.page_id)),
                    },
                    Permission {
                        resource_type: Resource::Page,
                        resource_category: Some(Reference::Id(page.page_category_id)),
                        action: Action::View,
                    },
                )
                .await?
            }
            None => false,
        };
        if !can_view {
            bail!(Error::new(
                "user does not have permission to view the forum thread page",
                ErrorType::PermissionDenied,
            ));
        }
    }

    let guest_identity = if request_user_id.is_none() {
        match (input.guest_name, input.guest_email_md5) {
            (Some(name), Some(md5))
                if !name.trim().is_empty()
                    && md5.len() == 32
                    && md5.bytes().all(|byte| {
                        byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
                    }) =>
            {
                Some((name, md5))
            }
            _ => {
                bail!(Error::new(
                    "anonymous forum posts require a valid guest identity",
                    ErrorType::BadRequest,
                ));
            }
        }
    } else {
        None
    };

    let created = ForumPostService::create(
        ctx,
        CreateForumPost {
            forum_thread_id: input.forum_thread_id,
            parent_post_id: input.parent_post_id,
            user_id: request_user_id.unwrap_or(ANONYMOUS_USER_ID),
            title: input.title,
            wikitext: input.wikitext,
            comments: String::new(),
            from_wikidot: false,
        },
    )
    .await?;
    if let Some((name, md5)) = guest_identity {
        ForumPostService::set_guest_identity(ctx, created.forum_post_id, name, md5)
            .await?;
    }
    Ok(created)
}

pub async fn forum_post_select(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Vec<i64>> {
    crate::services::forum_post::forum_post_select(ctx, parse!(params, ForumPost)).await
}

pub async fn forum_post_get(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Vec<WikidotForumPost>> {
    crate::services::forum_post::forum_post_get(ctx, parse!(params, ForumPost)).await
}

pub async fn forum_post_page_summary(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<ForumPostPageSummary> {
    crate::services::forum_post::forum_post_page_summary(ctx, parse!(params, ForumPost))
        .await
}
