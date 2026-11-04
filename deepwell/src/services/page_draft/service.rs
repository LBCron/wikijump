/*
 * services/page_draft/service.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::structs::{
    PageDraftIdentity, PageDraftPageType, PageDraftView, SavePageDraft,
};
use crate::constants::ADMIN_USER_ID;
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::page_draft::{self, Entity as PageDraft, Model as PageDraftModel};
use crate::services::permission::{CheckPermissionContext, PermissionService};
use crate::services::{CategoryService, PageService, ServiceContext};
use crate::types::{Action, Permission, Reference, Resource};
use crate::utils::get_category_name;
use crate::utils::now;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait, FromQueryResult,
    QueryFilter, Set, Statement, Value,
};
use std::borrow::Cow;
use wikidot_normalize::normalize;

const MAX_PAGE_DRAFTS: usize = 2_000;
const PAGE_DRAFT_SCAN_LIMIT: usize = MAX_PAGE_DRAFTS + 1;

#[derive(Debug)]
pub struct PageDraftService;

#[derive(Debug, FromQueryResult)]
struct PageDraftCandidate {
    slug: String,
    title: String,
    author_user_id: i64,
    draft_page_id: Option<i64>,
    active_page_id: Option<i64>,
    page_category_id: Option<i64>,
    active_revision_id: Option<i64>,
    hidden: Option<Vec<String>>,
}

impl PageDraftService {
    /// Persist one page editor state, or replace the state for the same exact
    /// page identity. A changed slug is intentionally not treated as a draft
    /// rename: that lifecycle is not evidenced and therefore fails closed.
    pub async fn save(
        ctx: &ServiceContext<'_>,
        mut input: SavePageDraft,
    ) -> Result<PageDraftModel> {
        let make_error = || Error::new("failed to save page draft", ErrorType::Page);
        Self::require_actor(ctx, input.site_id, input.user_id)?;

        normalize(&mut input.slug);
        if input.slug.is_empty() {
            return Err(Error::new(
                "cannot save a page draft with an empty slug",
                ErrorType::PageSlugEmpty,
            )
            .into());
        }

        if let Some(page_id) = input.page_id {
            let page = PageService::get_direct_optional(ctx, page_id, false)
                .await
                .or_raise(make_error)?
                .ok_or_else(|| {
                    Error::new(
                        "cannot save a draft for an unavailable page",
                        ErrorType::PermissionDenied,
                    )
                })?;
            if page.site_id != input.site_id || page.slug != input.slug {
                return Err(Error::new(
                    "page draft identity does not match its target page",
                    ErrorType::PermissionDenied,
                )
                .into());
            }
            Self::ensure_page_permission(
                ctx,
                input.site_id,
                Some(page.page_id),
                Some(page.page_category_id),
                input.user_id,
                Action::Edit,
            )
            .await?;
        } else {
            let target = PageService::get_optional(
                ctx,
                input.site_id,
                Reference::Slug(Cow::Borrowed(&input.slug)),
            )
            .await
            .or_raise(make_error)?;
            if target.is_some() {
                return Err(Error::new(
                    "an existing page draft must carry its page identity",
                    ErrorType::PermissionDenied,
                )
                .into());
            }

            let category_slug = get_category_name(&input.slug);
            let category = CategoryService::get_optional(
                ctx,
                input.site_id,
                Reference::Slug(Cow::Borrowed(category_slug)),
            )
            .await
            .or_raise(make_error)?;
            Self::ensure_page_permission(
                ctx,
                input.site_id,
                None,
                category.map(|category| category.category_id),
                input.user_id,
                Action::Create,
            )
            .await?;
        }

        let txn = ctx.transaction();
        let by_slug = PageDraft::find()
            .filter(page_draft::Column::SiteId.eq(input.site_id))
            .filter(page_draft::Column::UserId.eq(input.user_id))
            .filter(page_draft::Column::Slug.eq(&input.slug))
            .one(txn)
            .await
            .or_raise(make_error)?;
        let by_page = match input.page_id {
            Some(page_id) => PageDraft::find()
                .filter(page_draft::Column::SiteId.eq(input.site_id))
                .filter(page_draft::Column::UserId.eq(input.user_id))
                .filter(page_draft::Column::PageId.eq(page_id))
                .one(txn)
                .await
                .or_raise(make_error)?,
            None => None,
        };

        if let Some(ref draft) = by_slug
            && draft.page_id != input.page_id
        {
            return Err(Error::new(
                "page draft slug is already owned by another draft identity",
                ErrorType::PermissionDenied,
            )
            .into());
        }
        if let Some(ref draft) = by_page
            && draft.slug != input.slug
        {
            return Err(Error::new(
                "page draft target has an unobserved renamed identity",
                ErrorType::PermissionDenied,
            )
            .into());
        }

        let draft = by_page.or(by_slug);
        match draft {
            Some(draft) => page_draft::ActiveModel {
                page_draft_id: Set(draft.page_draft_id),
                updated_at: Set(Some(now())),
                title: Set(input.title),
                wikitext: Set(input.wikitext),
                ..Default::default()
            }
            .update(txn)
            .await
            .or_raise(make_error),
            None => page_draft::ActiveModel {
                site_id: Set(input.site_id),
                page_id: Set(input.page_id),
                user_id: Set(input.user_id),
                slug: Set(input.slug),
                title: Set(input.title),
                wikitext: Set(input.wikitext),
                created_at: Set(now()),
                updated_at: Set(None),
                ..Default::default()
            }
            .insert(txn)
            .await
            .or_raise(make_error),
        }
    }

    /// List visible drafts for a site. Only a live target with the same
    /// stored identity is considered an existing page; stale page-linked rows
    /// are omitted rather than receiving inferred rename/delete semantics.
    pub async fn list(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        page_type: PageDraftPageType,
    ) -> Result<Vec<PageDraftView>> {
        Self::list_for_viewer(ctx, site_id, page_type, ctx.request().user_id).await
    }

    pub(crate) async fn list_for_viewer(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        page_type: PageDraftPageType,
        viewer_user_id: Option<i64>,
    ) -> Result<Vec<PageDraftView>> {
        let make_error = || Error::new("failed to list page drafts", ErrorType::Page);
        if ctx
            .request()
            .site_id
            .is_some_and(|request_site_id| request_site_id != site_id)
        {
            return Err(Error::new(
                "page draft site does not match the request context",
                ErrorType::PermissionDenied,
            )
            .into());
        }
        let txn = ctx.transaction();
        let candidates =
            PageDraftCandidate::find_by_statement(Statement::from_sql_and_values(
                txn.get_database_backend(),
                format!(
                    r#"SELECT d.slug, d.title,
                              d.user_id AS author_user_id,
                              d.page_id AS draft_page_id,
                              p.page_id AS active_page_id,
                              p.page_category_id,
                              r.revision_id AS active_revision_id,
                              r.hidden
                       FROM page_draft d
                       LEFT JOIN page p
                         ON p.site_id = d.site_id
                        AND p.deleted_at IS NULL
                        AND ((d.page_id IS NOT NULL
                              AND p.page_id = d.page_id
                              AND p.slug = d.slug)
                             OR (d.page_id IS NULL AND p.slug = d.slug))
                       LEFT JOIN page_revision r ON r.revision_id = p.latest_revision_id
                       WHERE d.site_id = $1
                       ORDER BY d.created_at DESC,
                                d.page_draft_id DESC
                       LIMIT {PAGE_DRAFT_SCAN_LIMIT}"#,
                ),
                [Value::from(site_id)],
            ))
            .all(txn)
            .await
            .or_raise(make_error)?;
        if candidates.len() > MAX_PAGE_DRAFTS {
            return Err(Error::new(
                "page draft scan exceeded its public limit",
                ErrorType::Page,
            )
            .into());
        }

        let viewer_privileged = match viewer_user_id {
            Some(ADMIN_USER_ID) => true,
            Some(_) => PermissionService::check_user_can_access_admin(
                ctx,
                viewer_user_id,
                site_id,
            )
            .await
            .or_raise(make_error)?,
            None => false,
        };

        let mut drafts = Vec::new();
        for candidate in candidates {
            if !draft_visible_to_viewer(
                candidate.author_user_id,
                viewer_user_id,
                viewer_privileged,
            ) {
                continue;
            }
            let Some(active_page_id) = candidate.active_page_id else {
                if candidate.draft_page_id.is_some() {
                    continue;
                }
                if page_type == PageDraftPageType::Exists {
                    continue;
                }
                let category_slug = get_category_name(&candidate.slug);
                let category = CategoryService::get_optional(
                    ctx,
                    site_id,
                    Reference::Slug(Cow::Borrowed(category_slug)),
                )
                .await
                .or_raise(make_error)?;
                if !Self::can_view_page(
                    ctx,
                    site_id,
                    None,
                    category.map(|category| category.category_id),
                    viewer_user_id,
                )
                .await
                .or_raise(make_error)?
                {
                    continue;
                }
                drafts.push(PageDraftView {
                    slug: candidate.slug,
                    title: candidate.title,
                });
                continue;
            };
            let Some(page_category_id) = candidate.page_category_id else {
                continue;
            };
            if candidate.active_revision_id.is_none() {
                continue;
            }
            let Some(hidden) = candidate.hidden else {
                continue;
            };
            if hidden
                .iter()
                .any(|field| field == "title" || field == "slug")
            {
                continue;
            }
            if !Self::can_view_page(
                ctx,
                site_id,
                Some(active_page_id),
                Some(page_category_id),
                viewer_user_id,
            )
            .await
            .or_raise(make_error)?
            {
                continue;
            }
            drafts.push(PageDraftView {
                slug: candidate.slug,
                title: candidate.title,
            });
        }
        Ok(drafts)
    }

    async fn can_view_page(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        page_id: Option<i64>,
        page_category_id: Option<i64>,
        viewer_user_id: Option<i64>,
    ) -> Result<bool> {
        PermissionService::check_user_can(
            ctx,
            &CheckPermissionContext {
                user_id: viewer_user_id,
                site_id,
                page_reference: page_id.map(Reference::Id),
            },
            Permission {
                resource_type: Resource::Page,
                resource_category: page_category_id.map(Reference::Id),
                action: Action::View,
            },
        )
        .await
    }

    pub async fn exists(
        ctx: &ServiceContext<'_>,
        identity: PageDraftIdentity,
    ) -> Result<bool> {
        Self::require_actor(ctx, identity.site_id, identity.user_id)?;
        let make_error = || Error::new("failed to check page draft", ErrorType::Page);
        let slug = normalize_draft_slug(identity.slug);
        let mut query = PageDraft::find()
            .filter(page_draft::Column::SiteId.eq(identity.site_id))
            .filter(page_draft::Column::UserId.eq(identity.user_id))
            .filter(page_draft::Column::Slug.eq(slug));
        query = match identity.page_id {
            Some(page_id) => query.filter(page_draft::Column::PageId.eq(page_id)),
            None => query.filter(page_draft::Column::PageId.is_null()),
        };
        Ok(query
            .one(ctx.transaction())
            .await
            .or_raise(make_error)?
            .is_some())
    }

    pub async fn remove(
        ctx: &ServiceContext<'_>,
        identity: PageDraftIdentity,
    ) -> Result<bool> {
        Self::require_actor(ctx, identity.site_id, identity.user_id)?;
        let make_error = || Error::new("failed to remove page draft", ErrorType::Page);
        let slug = normalize_draft_slug(identity.slug);
        let mut query = PageDraft::find()
            .filter(page_draft::Column::SiteId.eq(identity.site_id))
            .filter(page_draft::Column::UserId.eq(identity.user_id))
            .filter(page_draft::Column::Slug.eq(slug));
        query = match identity.page_id {
            Some(page_id) => query.filter(page_draft::Column::PageId.eq(page_id)),
            None => query.filter(page_draft::Column::PageId.is_null()),
        };
        let Some(draft) = query.one(ctx.transaction()).await.or_raise(make_error)? else {
            return Ok(false);
        };
        PageDraft::delete_by_id(draft.page_draft_id)
            .exec(ctx.transaction())
            .await
            .or_raise(make_error)?;
        Ok(true)
    }

    async fn ensure_page_permission(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        page_id: Option<i64>,
        page_category_id: Option<i64>,
        user_id: i64,
        action: Action,
    ) -> Result<()> {
        let can_act = PermissionService::check_user_can(
            ctx,
            &CheckPermissionContext {
                user_id: Some(user_id),
                site_id,
                page_reference: page_id.map(Reference::Id),
            },
            Permission {
                resource_type: Resource::Page,
                resource_category: page_category_id.map(Reference::Id),
                action,
            },
        )
        .await
        .or_raise(|| {
            Error::new(
                "failed to check page draft permission",
                ErrorType::Permission,
            )
        })?;
        if can_act {
            Ok(())
        } else {
            Err(Error::new(
                "user does not have permission to save a page draft",
                ErrorType::PermissionDenied,
            )
            .into())
        }
    }

    fn require_actor(ctx: &ServiceContext<'_>, site_id: i64, user_id: i64) -> Result<()> {
        if ctx.request().site_id != Some(site_id) {
            return Err(Error::new(
                "page draft site does not match the request context",
                ErrorType::PermissionDenied,
            )
            .into());
        }
        if ctx.request().user_id != Some(user_id) {
            return Err(Error::new(
                "page draft actor does not match the request context",
                ErrorType::PermissionDenied,
            )
            .into());
        }
        Ok(())
    }
}

fn normalize_draft_slug(mut slug: String) -> String {
    normalize(&mut slug);
    slug
}

fn draft_visible_to_viewer(
    author_user_id: i64,
    viewer_user_id: Option<i64>,
    viewer_privileged: bool,
) -> bool {
    viewer_privileged || viewer_user_id == Some(author_user_id)
}

#[cfg(test)]
mod tests {
    use super::draft_visible_to_viewer;

    #[test]
    fn draft_list_shows_only_own_drafts_to_unprivileged_viewers() {
        assert!(draft_visible_to_viewer(10, Some(10), false));
        assert!(!draft_visible_to_viewer(10, Some(20), false));
        assert!(!draft_visible_to_viewer(10, None, false));
    }

    #[test]
    fn draft_list_shows_all_drafts_to_privileged_viewers() {
        assert!(draft_visible_to_viewer(10, Some(20), true));
        assert!(draft_visible_to_viewer(10, Some(10), true));
    }
}
