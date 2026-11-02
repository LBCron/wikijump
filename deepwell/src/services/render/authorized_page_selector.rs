use std::collections::BTreeMap;

use crate::error::Result;
use crate::models::page::Model as PageModel;
use crate::services::ServiceContext;
use crate::services::page::PageService;
use crate::services::permission::{CheckPermissionContext, PermissionService};
use crate::services::render::{ViewablePageRef, view_decisions_for_scanned_pages};
use crate::types::{Action, Permission, Reference, Resource};

pub(crate) struct AuthorizedPageSelector<'a, 'ctx> {
    ctx: &'a ServiceContext<'ctx>,
    viewer_user_id: Option<i64>,
    decisions: BTreeMap<(i64, i64, i64), bool>,
    category_permissions: BTreeMap<(i64, Option<i64>), bool>,
}

impl<'a, 'ctx> AuthorizedPageSelector<'a, 'ctx> {
    pub(crate) fn new(
        ctx: &'a ServiceContext<'ctx>,
        viewer_user_id: Option<i64>,
    ) -> Self {
        Self {
            ctx,
            viewer_user_id,
            decisions: BTreeMap::new(),
            category_permissions: BTreeMap::new(),
        }
    }

    pub(crate) async fn filter_models(
        &mut self,
        pages: impl IntoIterator<Item = PageModel>,
    ) -> Result<Vec<PageModel>> {
        let pages = pages.into_iter().collect::<Vec<_>>();
        let undecided = pages
            .iter()
            .filter(|page| !self.decisions.contains_key(&Self::key(page)))
            .collect::<Vec<_>>();
        let references = undecided
            .iter()
            .map(|page| ViewablePageRef {
                page_id: page.page_id,
                site_id: page.site_id,
                page_category_id: Some(page.page_category_id),
            })
            .collect::<Vec<_>>();
        let decisions = view_decisions_for_scanned_pages(
            self.ctx,
            self.viewer_user_id,
            &references,
            &mut self.category_permissions,
        )
        .await?;
        for (page, decision) in undecided.into_iter().zip(decisions) {
            self.decisions.insert(Self::key(page), decision);
        }
        Ok(pages
            .into_iter()
            .filter(|page| self.decisions[&Self::key(page)])
            .collect())
    }

    fn key(page: &PageModel) -> (i64, i64, i64) {
        (page.site_id, page.page_id, page.page_category_id)
    }

    pub(crate) async fn resolve_models(
        &mut self,
        site_id: i64,
        references: &[Reference<'_>],
    ) -> Result<Vec<PageModel>> {
        let pages = PageService::get_pages(self.ctx, site_id, references).await?;
        self.filter_models(pages).await
    }

    pub(crate) async fn check_page_viewability(
        &mut self,
        page: &PageModel,
    ) -> Result<bool> {
        let key = Self::key(page);
        if let Some(decision) = self.decisions.get(&key) {
            return Ok(*decision);
        }

        let decision = PermissionService::check_user_can(
            self.ctx,
            &CheckPermissionContext {
                user_id: self.viewer_user_id,
                site_id: page.site_id,
                page_reference: Some(Reference::Id(page.page_id)),
            },
            Permission {
                resource_type: Resource::Page,
                resource_category: Some(Reference::Id(page.page_category_id)),
                action: Action::View,
            },
        )
        .await?;
        self.decisions.insert(key, decision);
        Ok(decision)
    }
}
