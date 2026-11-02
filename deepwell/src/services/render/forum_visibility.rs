/*
 * services/render/forum_visibility.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use std::collections::HashMap;

use sea_orm::{ConnectionTrait, FromQueryResult, Statement, Value};

use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::services::ServiceContext;
use crate::services::permission::{CheckPermissionContext, PermissionService};
use crate::types::{Action, Permission, Reference, Resource};

const FORUM_VISIBILITY_CANDIDATE_LIMIT: usize = 1_001;

#[derive(Debug, FromQueryResult)]
struct ForumThreadVisibilityCandidate {
    forum_thread_id: i64,
    page_id: Option<i64>,
    page_category_id: Option<i64>,
}

pub(super) struct VisibleForumThreadIds {
    pub(super) ids: Vec<i64>,
    pub(super) complete: bool,
}

pub(super) struct ForumPageVisibility<'a, 'ctx> {
    ctx: &'a ServiceContext<'ctx>,
    viewer_user_id: Option<i64>,
    site_decisions: HashMap<i64, bool>,
    category_decisions: HashMap<(i64, i64), bool>,
    page_decisions: HashMap<(i64, i64, i64), bool>,
}

impl<'a, 'ctx> ForumPageVisibility<'a, 'ctx> {
    pub(super) fn new(
        ctx: &'a ServiceContext<'ctx>,
        viewer_user_id: Option<i64>,
    ) -> Self {
        Self {
            ctx,
            viewer_user_id,
            site_decisions: HashMap::new(),
            category_decisions: HashMap::new(),
            page_decisions: HashMap::new(),
        }
    }

    pub(super) async fn site_is_viewable(&mut self, site_id: i64) -> Result<bool> {
        match self.site_decisions.get(&site_id) {
            Some(decision) => Ok(*decision),
            None => {
                let decision = PermissionService::check_user_can(
                    self.ctx,
                    &CheckPermissionContext {
                        user_id: self.viewer_user_id,
                        site_id,
                        page_reference: None,
                    },
                    Permission {
                        resource_type: Resource::Page,
                        resource_category: None,
                        action: Action::View,
                    },
                )
                .await
                .or_raise(|| {
                    Error::new("failed to check forum site", ErrorType::Render)
                })?;
                self.site_decisions.insert(site_id, decision);
                Ok(decision)
            }
        }
    }

    pub(super) async fn page_is_viewable(
        &mut self,
        site_id: i64,
        page_id: Option<i64>,
        page_category_id: Option<i64>,
    ) -> Result<bool> {
        if !self.site_is_viewable(site_id).await? {
            return Ok(false);
        }
        let (Some(page_id), Some(page_category_id)) = (page_id, page_category_id) else {
            return Ok(page_id.is_none());
        };

        let category_key = (site_id, page_category_id);
        let category_viewable = match self.category_decisions.get(&category_key) {
            Some(decision) => *decision,
            None => {
                let decision = self
                    .check(site_id, None, page_category_id, Action::View)
                    .await?;
                self.category_decisions.insert(category_key, decision);
                decision
            }
        };
        if category_viewable {
            return Ok(true);
        }

        if self.viewer_user_id.is_none() {
            return Ok(false);
        }
        let page_key = (site_id, page_id, page_category_id);
        match self.page_decisions.get(&page_key) {
            Some(decision) => Ok(*decision),
            None => {
                let decision = self
                    .check(site_id, Some(page_id), page_category_id, Action::View)
                    .await?;
                self.page_decisions.insert(page_key, decision);
                Ok(decision)
            }
        }
    }

    pub(super) async fn forum_category_is_postable(
        &mut self,
        site_id: i64,
        forum_category_id: i64,
    ) -> Result<bool> {
        PermissionService::check_user_can(
            self.ctx,
            &CheckPermissionContext {
                user_id: self.viewer_user_id,
                site_id,
                page_reference: None,
            },
            Permission {
                resource_type: Resource::ForumCategory,
                resource_category: Some(Reference::Id(forum_category_id)),
                action: Action::Create,
            },
        )
        .await
        .or_raise(|| {
            Error::new("failed to check forum post permission", ErrorType::Render)
        })
    }

    pub(super) async fn visible_thread_ids(
        &mut self,
        site_id: i64,
        category_id: Option<i64>,
        thread_id: Option<i64>,
        visible_groups_only: bool,
    ) -> Result<Option<VisibleForumThreadIds>> {
        if !self.site_is_viewable(site_id).await? {
            return Ok(None);
        }
        let make_error = || {
            Error::new(
                "failed to load forum visibility candidates",
                ErrorType::Render,
            )
        };
        let candidates = ForumThreadVisibilityCandidate::find_by_statement(
            Statement::from_sql_and_values(
                self.ctx.transaction().get_database_backend(),
                format!(concat!(
                    "SELECT t.forum_thread_id, t.page_id, p.page_category_id ",
                    "FROM forum_thread t ",
                    "JOIN forum_category c ON c.forum_category_id = t.forum_category_id ",
                    " AND c.site_id = t.site_id AND c.deleted_at IS NULL ",
                    "JOIN forum_group g ON g.forum_group_id = t.forum_group_id ",
                    " AND g.site_id = t.site_id AND g.deleted_at IS NULL ",
                    "LEFT JOIN page p ON p.page_id = t.page_id ",
                    " AND p.site_id = t.site_id AND p.deleted_at IS NULL ",
                    "WHERE t.site_id = $1 AND t.deleted_at IS NULL ",
                    " AND ($2::BIGINT IS NULL OR t.forum_category_id = $2) ",
                    " AND ($3::BIGINT IS NULL OR t.forum_thread_id = $3) ",
                    " AND (NOT $4::BOOLEAN OR g.visible = TRUE) ",
                    " AND (t.page_id IS NULL OR p.page_id IS NOT NULL) ",
                    "ORDER BY t.forum_thread_id LIMIT {candidate_limit}",
                ), candidate_limit = FORUM_VISIBILITY_CANDIDATE_LIMIT),
                [
                    Value::from(site_id),
                    Value::BigInt(category_id),
                    Value::BigInt(thread_id),
                    Value::from(visible_groups_only),
                ],
            ),
        )
        .all(self.ctx.transaction())
        .await
        .or_raise(make_error)?;
        let candidate_count = candidates.len();
        let mut visible = Vec::with_capacity(candidate_count);
        for candidate in candidates {
            if self
                .page_is_viewable(site_id, candidate.page_id, candidate.page_category_id)
                .await?
            {
                visible.push(candidate.forum_thread_id);
            }
        }
        Ok(Some(VisibleForumThreadIds {
            ids: visible,
            complete: candidate_count < FORUM_VISIBILITY_CANDIDATE_LIMIT,
        }))
    }

    async fn check(
        &self,
        site_id: i64,
        page_id: Option<i64>,
        page_category_id: i64,
        action: Action,
    ) -> Result<bool> {
        PermissionService::check_user_can(
            self.ctx,
            &CheckPermissionContext {
                user_id: self.viewer_user_id,
                site_id,
                page_reference: page_id.map(Reference::Id),
            },
            Permission {
                resource_type: Resource::Page,
                resource_category: Some(Reference::Id(page_category_id)),
                action,
            },
        )
        .await
        .or_raise(|| Error::new("failed to check forum activity page", ErrorType::Render))
    }
}
