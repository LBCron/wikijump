/*
 * services/render/runtime.rs
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

use super::include_attachment_owners::AttachmentProvenanceRegistry;
use super::runtime_page_queries::{
    ViewableCountPagesRows, ViewableListPagesRows, find_viewable_count_pages_rows,
    find_viewable_list_pages_rows,
};
use super::service::site_matches_wikidot_slug;
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::site::Model as SiteModel;
use crate::services::page_query::{PageQuery, PageQueryScoreFilterCache};
use crate::services::permission::{CheckPermissionContext, PermissionService};
use crate::services::{PageRevisionService, PageService, ServiceContext, SiteService};
use crate::types::{Action, Permission, Reference, Resource};
use crate::utils::trim_default;
use ftml::data::PageRef;
use ftml::{self};
use sea_orm::{ConnectionTrait, DatabaseBackend, Statement};
use std::collections::{BTreeMap, HashMap};
use std::future::Future;

#[derive(Debug)]
pub(super) struct RenderRuntime<'context, 'transaction> {
    ctx: &'context ServiceContext<'transaction>,
    viewer_user_id: Option<i64>,
}

impl<'context, 'transaction> RenderRuntime<'context, 'transaction> {
    pub(super) fn new(ctx: &'context ServiceContext<'transaction>) -> Self {
        Self {
            ctx,
            viewer_user_id: None,
        }
    }

    pub(super) fn for_viewer(
        ctx: &'context ServiceContext<'transaction>,
        viewer_user_id: Option<i64>,
    ) -> Self {
        Self {
            ctx,
            viewer_user_id,
        }
    }

    pub(super) async fn find_viewable_list_pages_rows(
        &self,
        query: PageQuery<'_>,
        target_count: usize,
        permission_cache: &mut BTreeMap<(i64, Option<i64>), bool>,
        score_filter_cache: Option<&mut PageQueryScoreFilterCache>,
    ) -> Result<ViewableListPagesRows> {
        find_viewable_list_pages_rows(
            self.ctx,
            self.viewer_user_id,
            query,
            target_count,
            permission_cache,
            score_filter_cache,
        )
        .await
    }

    pub(super) async fn find_viewable_count_pages_rows(
        &self,
        query: PageQuery<'_>,
        target_count: usize,
        permission_cache: &mut BTreeMap<(i64, Option<i64>), bool>,
    ) -> Result<ViewableCountPagesRows> {
        find_viewable_count_pages_rows(
            self.ctx,
            self.viewer_user_id,
            query,
            target_count,
            permission_cache,
        )
        .await
    }

    pub(super) async fn fetch_include_source(
        &self,
        current_site_id: i64,
        current_site_slug: &str,
        page_ref: &PageRef,
        imported_source_site: Option<&str>,
        cache: &mut IncludeSourceCache,
    ) -> Result<Option<AuthorizedIncludeSource>> {
        match page_ref.site() {
            Some(site_slug) if site_slug != current_site_slug => {
                let current_site = cache
                    .get_site_by_id_or_try_insert_with(current_site_id, || async {
                        SiteService::get_optional(
                            self.ctx,
                            Reference::Id(current_site_id),
                        )
                        .await
                        .or_raise(|| {
                            Error::new(
                                format!(
                                    "failed to get current include site ID {current_site_id}"
                                ),
                                ErrorType::Site,
                            )
                        })
                    })
                    .await?;
                let current_site_matches = current_site
                    .as_ref()
                    .is_some_and(|site| site_matches_wikidot_slug(site, site_slug));

                if current_site_matches
                    && let Some(source) = self
                        .fetch_include_source_from_site(
                            current_site_id,
                            current_site_slug,
                            page_ref.page(),
                            cache,
                        )
                        .await?
                {
                    return Ok(Some(source));
                }

                let Some(site) = cache
                    .get_site_by_slug_or_try_insert_with(site_slug, || async {
                        SiteService::get_optional(self.ctx, Reference::from(site_slug))
                            .await
                            .or_raise(|| {
                                Error::new(
                                    format!("failed to get include site '{site_slug}'"),
                                    ErrorType::Site,
                                )
                            })
                    })
                    .await?
                else {
                    return self
                        .fetch_imported_cross_site_source(
                            current_site_id,
                            current_site_slug,
                            site_slug,
                            page_ref.page(),
                            cache,
                        )
                        .await;
                };

                self.fetch_include_source_from_site(
                    site.site_id,
                    &site.slug,
                    page_ref.page(),
                    cache,
                )
                .await
            }
            _ => {
                if page_ref.site().is_none()
                    && let Some(source_site) = imported_source_site
                    && let Some(source) = self
                        .fetch_imported_cross_site_source(
                            current_site_id,
                            current_site_slug,
                            source_site,
                            page_ref.page(),
                            cache,
                        )
                        .await?
                {
                    return Ok(Some(source));
                }

                self.fetch_include_source_from_site(
                    current_site_id,
                    current_site_slug,
                    page_ref.page(),
                    cache,
                )
                .await
            }
        }
    }

    async fn find_imported_snapshot_match(
        &self,
        current_site_id: i64,
        source_site_slug: &str,
        source_fullname: &str,
    ) -> Result<Option<SnapshotMatchedPageId>> {
        let statement = Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            r#"
                SELECT page.page_id
                FROM wikidot_page_snapshot AS snapshot
                JOIN page ON page.page_id = snapshot.page_id
                WHERE page.site_id = $1
                  AND snapshot.source_site = $2
                  AND snapshot.source_fullname = $3
                  AND page.deleted_at IS NULL
            "#,
            [
                current_site_id.into(),
                source_site_slug.to_owned().into(),
                source_fullname.to_owned().into(),
            ],
        );
        self.ctx
            .transaction()
            .query_one_raw(statement)
            .await
            .or_raise(|| {
                Error::new(
                    format!(
                        "failed to resolve imported include {source_site_slug}:{source_fullname}"
                    ),
                    ErrorType::DatabaseQuery,
                )
            })?
            .map(|row| row.try_get::<i64>("", "page_id"))
            .transpose()
            .or_raise(|| {
                Error::new(
                    format!(
                        "failed to read imported include {source_site_slug}:{source_fullname}"
                    ),
                    ErrorType::DatabaseQuery,
                )
            })
            .map(|page_id| page_id.map(SnapshotMatchedPageId))
    }

    async fn fetch_imported_cross_site_source(
        &self,
        current_site_id: i64,
        current_site_slug: &str,
        source_site_slug: &str,
        source_page_slug: &str,
        cache: &mut IncludeSourceCache,
    ) -> Result<Option<AuthorizedIncludeSource>> {
        let source_page_slug = trim_default(source_page_slug);
        let cache_key = (
            current_site_id,
            source_site_slug.to_owned(),
            source_page_slug.to_owned(),
        );
        if let Some(cached) = cache.imported_cross_site_sources.get(&cache_key) {
            return Ok(cached.as_ref().map(|wikitext| {
                AuthorizedIncludeSource::snapshot_matched(
                    current_site_slug.to_owned(),
                    source_page_slug.to_owned(),
                    wikitext.clone(),
                    source_site_slug.to_owned(),
                )
            }));
        }

        let mut snapshot_match = self
            .find_imported_snapshot_match(
                current_site_id,
                source_site_slug,
                source_page_slug,
            )
            .await?;
        if snapshot_match.is_none() {
            for alternate in alternate_source_fullnames(source_page_slug) {
                snapshot_match = self
                    .find_imported_snapshot_match(
                        current_site_id,
                        source_site_slug,
                        &alternate,
                    )
                    .await?;
                if snapshot_match.is_some() {
                    break;
                }
            }
        }

        let Some(snapshot_match) = snapshot_match else {
            cache.imported_cross_site_sources.insert(cache_key, None);
            return Ok(None);
        };
        let page_id = snapshot_match.page_id();
        let Some(page) = PageService::get_optional_including_foreign_snapshots(
            self.ctx,
            current_site_id,
            Reference::Id(page_id),
        )
        .await?
        else {
            cache.imported_cross_site_sources.insert(cache_key, None);
            return Ok(None);
        };

        let can_view = PermissionService::check_user_can(
            self.ctx,
            &CheckPermissionContext {
                user_id: None,
                site_id: current_site_id,
                page_reference: Some(Reference::Id(page_id)),
            },
            Permission {
                resource_type: Resource::Page,
                resource_category: Some(Reference::Id(page.page_category_id)),
                action: Action::View,
            },
        )
        .await?;
        if !can_view {
            cache.imported_cross_site_sources.insert(cache_key, None);
            return Ok(None);
        }

        let wikitext = PageRevisionService::get_wikitext_optional(
            self.ctx,
            current_site_id,
            Reference::Id(page_id),
        )
        .await?;
        let Some(wikitext) = wikitext else {
            cache.imported_cross_site_sources.insert(cache_key, None);
            return Ok(None);
        };

        cache
            .imported_cross_site_sources
            .insert(cache_key, Some(wikitext.clone()));
        Ok(Some(AuthorizedIncludeSource::snapshot_matched(
            current_site_slug.to_owned(),
            source_page_slug.to_owned(),
            wikitext,
            source_site_slug.to_owned(),
        )))
    }

    async fn fetch_include_source_from_site(
        &self,
        site_id: i64,
        site_slug: &str,
        page_slug: &str,
        cache: &mut IncludeSourceCache,
    ) -> Result<Option<AuthorizedIncludeSource>> {
        let wikitext = cache
            .get_or_try_insert_with(site_id, page_slug, || async {
                let page_ref = Reference::from(page_slug);
                let Some(page) =
                    PageService::get_optional(self.ctx, site_id, page_ref.clone())
                        .await?
                else {
                    return Ok(None);
                };

                let can_view = PermissionService::check_user_can(
                    self.ctx,
                    &CheckPermissionContext {
                        user_id: None,
                        site_id,
                        page_reference: Some(page_ref),
                    },
                    Permission {
                        resource_type: Resource::Page,
                        resource_category: Some(Reference::Id(page.page_category_id)),
                        action: Action::View,
                    },
                )
                .await?;
                if !can_view {
                    return Ok(None);
                }

                PageRevisionService::get_wikitext_optional(
                    self.ctx,
                    site_id,
                    Reference::Id(page.page_id),
                )
                .await
            })
            .await?;

        Ok(wikitext.map(|wikitext| {
            AuthorizedIncludeSource::view_checked(
                site_slug.to_owned(),
                trim_default(page_slug).to_owned(),
                wikitext,
            )
        }))
    }
}

#[derive(Debug, Clone, Copy)]
struct SnapshotMatchedPageId(i64);

impl SnapshotMatchedPageId {
    fn page_id(self) -> i64 {
        self.0
    }
}

#[derive(Debug)]
pub(super) struct AuthorizedIncludeSource {
    pub(super) site_slug: String,
    pub(super) page_slug: String,
    pub(super) wikitext: String,
    pub(super) source_site: Option<String>,
}

impl AuthorizedIncludeSource {
    fn view_checked(site_slug: String, page_slug: String, wikitext: String) -> Self {
        Self {
            site_slug,
            page_slug,
            wikitext,
            source_site: None,
        }
    }

    fn snapshot_matched(
        site_slug: String,
        page_slug: String,
        wikitext: String,
        source_site: String,
    ) -> Self {
        Self {
            site_slug,
            page_slug,
            wikitext,
            source_site: Some(source_site),
        }
    }

    #[cfg(test)]
    pub(super) fn for_test(
        site_slug: String,
        page_slug: String,
        wikitext: String,
        source_site: Option<String>,
    ) -> Self {
        Self {
            site_slug,
            page_slug,
            wikitext,
            source_site,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum IncludeSourceCacheEntry {
    Available(String),
    Unavailable,
}

#[derive(Debug, Default)]
pub(super) struct IncludeSourceCache {
    sources_by_site: HashMap<i64, HashMap<String, IncludeSourceCacheEntry>>,
    imported_cross_site_sources: HashMap<(i64, String, String), Option<String>>,
    sites_by_id: HashMap<i64, Option<SiteModel>>,
    sites_by_slug: HashMap<String, Option<SiteModel>>,
    pub(super) attachment_provenance: AttachmentProvenanceRegistry,
}

impl IncludeSourceCache {
    fn get(&self, site_id: i64, page_slug: &str) -> Option<&IncludeSourceCacheEntry> {
        self.sources_by_site
            .get(&site_id)
            .and_then(|sources| sources.get(page_slug))
    }

    pub(super) async fn get_or_try_insert_with<F, Fut>(
        &mut self,
        site_id: i64,
        page_slug: &str,
        load: F,
    ) -> Result<Option<String>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Option<String>>>,
    {
        let page_slug = trim_default(page_slug);
        if let Some(entry) = self.get(site_id, page_slug) {
            return Ok(match entry {
                IncludeSourceCacheEntry::Available(wikitext) => Some(wikitext.clone()),
                IncludeSourceCacheEntry::Unavailable => None,
            });
        }

        let wikitext = load().await?;
        let entry = match &wikitext {
            Some(wikitext) => IncludeSourceCacheEntry::Available(wikitext.clone()),
            None => IncludeSourceCacheEntry::Unavailable,
        };
        self.sources_by_site
            .entry(site_id)
            .or_default()
            .insert(page_slug.to_owned(), entry);
        Ok(wikitext)
    }

    pub(super) async fn get_site_by_id_or_try_insert_with<F, Fut>(
        &mut self,
        site_id: i64,
        load: F,
    ) -> Result<Option<SiteModel>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Option<SiteModel>>>,
    {
        if let Some(site) = self.sites_by_id.get(&site_id) {
            return Ok(site.clone());
        }

        let site = load().await?;
        self.sites_by_id.insert(site_id, site.clone());
        Ok(site)
    }

    pub(super) async fn get_site_by_slug_or_try_insert_with<F, Fut>(
        &mut self,
        site_slug: &str,
        load: F,
    ) -> Result<Option<SiteModel>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Option<SiteModel>>>,
    {
        if let Some(site) = self.sites_by_slug.get(site_slug) {
            return Ok(site.clone());
        }

        let site = load().await?;
        self.sites_by_slug
            .insert(site_slug.to_owned(), site.clone());
        Ok(site)
    }
}

fn alternate_source_fullnames(page_slug: &str) -> Vec<String> {
    let Some(last_colon) = page_slug.rfind(':') else {
        return Vec::new();
    };
    let (head, tail) = page_slug.split_at(last_colon);
    let dash_count = head.bytes().filter(|byte| *byte == b'-').count();
    if dash_count == 0 || dash_count > 7 {
        return Vec::new();
    }

    let mut masks: Vec<u32> = (1..(1u32 << dash_count)).collect();
    masks.sort_by_key(|mask| (mask.count_ones(), *mask));
    masks
        .into_iter()
        .map(|mask| {
            let mut alternate = String::with_capacity(page_slug.len());
            let mut dash_ordinal = 0;
            for ch in head.chars() {
                if ch == '-' {
                    let flip = mask & (1u32 << dash_ordinal) != 0;
                    dash_ordinal += 1;
                    alternate.push(if flip { ':' } else { '-' });
                } else {
                    alternate.push(ch);
                }
            }
            alternate.push_str(tail);
            alternate
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multi_colon_include_page_ref_normalizes_away_from_the_stored_fullname() {
        let page_ref =
            PageRef::parse_include(":smlt:component:aers:classification-stuff")
                .expect("include target parses");
        assert_eq!(page_ref.site(), Some("smlt"));
        assert_eq!(page_ref.page(), "component-aers:classification-stuff");
        assert_eq!(
            alternate_source_fullnames(page_ref.page()),
            ["component:aers:classification-stuff"],
        );

        let page_ref =
            PageRef::parse_include(":scp.avn.sh:component:aers:classification-stuff")
                .expect("include target parses");
        assert_eq!(page_ref.site(), Some("scp-avn-sh"));
        assert_eq!(
            alternate_source_fullnames(page_ref.page()),
            ["component:aers:classification-stuff"],
        );
    }

    #[test]
    fn alternate_source_fullnames_only_rebuilds_pre_colon_segments() {
        assert!(alternate_source_fullnames("metodologia").is_empty());
        assert!(alternate_source_fullnames("component:license-box").is_empty());
        assert_eq!(
            alternate_source_fullnames("alpha-beta-gamma:delta"),
            [
                "alpha:beta-gamma:delta",
                "alpha-beta:gamma:delta",
                "alpha:beta:gamma:delta",
            ],
        );
        assert_eq!(
            alternate_source_fullnames("art-scp-5125:the-gourmand"),
            [
                "art:scp-5125:the-gourmand",
                "art-scp:5125:the-gourmand",
                "art:scp:5125:the-gourmand",
            ],
        );
    }
}
