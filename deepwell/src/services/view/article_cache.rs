/*
 * services/view/article_cache.rs
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

use super::options::PageOptions;
use super::structs::{GetPageView, GetPageViewOutput, is_reserved_admin_slug};
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::services::BlueprintPageService;
use crate::services::ServiceContext;
use crate::services::blueprint::compose_template;
use crate::services::permission::PermissionCache;
use crate::services::public_cache::PublicContentCache;
use crate::services::render::{
    DEEPWELL_RENDERER_EPOCH, RenderDependencyClass,
    classify_anonymous_render_dependencies, wikitext_requires_runtime_render,
};
use crate::utils::split_category;
use redis::AsyncCommands;
use sea_orm::{DatabaseBackend, FromQueryResult, Statement, Value};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

const ARTICLE_VIEW_PAGE_CACHE_PREFIX: &str = "deepwell:article-view:page";

/// Expiry for anonymous article-view cache entries.
///
/// The key embeds the renderer epoch, the revision, the public-content fence,
/// and the permission fence, so every site write, permission change,
/// re-render, and renderer promotion makes the previous entry unreachable but
/// still resident. Without an expiry the cache grows for the life of the
/// volume. The TTL only shortens how long an entry may be served; the fence
/// keys still decide what is current, so it cannot cause stale content.
const ARTICLE_VIEW_PAGE_CACHE_TTL_SECONDS: u64 = 60 * 60;

pub(super) struct ArticlePageCache;

pub(super) struct ArticlePageCacheMetadata {
    pub cache_key: String,
    pub public_content_cache_fence: String,
    pub anonymous_permission_cache_fence: String,
}

pub(super) struct ArticlePageCacheMetadataInput<'a> {
    pub page_view: &'a GetPageView,
    pub public_content_cache_fence: Option<String>,
}

impl ArticlePageCache {
    pub(super) async fn metadata(
        ctx: &ServiceContext<'_>,
        input: ArticlePageCacheMetadataInput<'_>,
    ) -> Result<Option<ArticlePageCacheMetadata>> {
        let ArticlePageCacheMetadataInput {
            page_view: input,
            public_content_cache_fence,
        } = input;
        if !matches!(input.session_token.as_deref(), None | Some("")) {
            return Ok(None);
        }

        let page_extra = input
            .route
            .as_ref()
            .map_or("", |route| route.extra.as_str());
        if PageOptions::parse(page_extra).rerender {
            return Ok(None);
        }

        #[derive(Debug, FromQueryResult)]
        struct ArticlePageCacheKeyRow {
            page_id: i64,
            page_slug: String,
            page_updated_at: Option<OffsetDateTime>,
            latest_revision_id: Option<i64>,
            from_wikidot: bool,
            compiled_body_html_hash: Option<Vec<u8>>,
            compiled_body_styles_hash: Option<Vec<u8>>,
            compiled_top_bar_html_hash: Option<Vec<u8>>,
            compiled_side_bar_html_hash: Option<Vec<u8>>,
            source_contents: Option<String>,
        }

        let page_slug = input.route.as_ref().map(|route| route.slug.clone());
        if page_slug.as_deref().is_some_and(is_reserved_admin_slug) {
            return Ok(None);
        }
        let statement = Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            str!(
                "
                SELECT
                    page.page_id,
                    page.slug AS page_slug,
                    page.updated_at AS page_updated_at,
                    page.latest_revision_id,
                    page.from_wikidot,
                    revision.compiled_body_html_hash,
                    revision.compiled_body_styles_hash,
                    revision.compiled_top_bar_html_hash,
                    revision.compiled_side_bar_html_hash,
                    source_text.contents AS source_contents
                FROM site
                JOIN page
                    ON page.site_id = site.site_id
                    AND page.slug = COALESCE($2::text, site.default_page)
                    AND page.deleted_at IS NULL
                LEFT JOIN page_revision AS revision
                    ON revision.revision_id = page.latest_revision_id
                LEFT JOIN text AS source_text
                    ON source_text.hash = revision.wikitext_hash
                WHERE site.site_id = $1
                AND site.deleted_at IS NULL
                "
            ),
            [Value::from(input.site_id), Value::from(page_slug)],
        );

        let row = ArticlePageCacheKeyRow::find_by_statement(statement)
            .one(ctx.transaction())
            .await
            .or_raise(|| {
                Error::new(
                    "failed to load article page cache key",
                    ErrorType::DatabaseQuery,
                )
            })?;

        let Some(row) = row else {
            return Ok(None);
        };
        let ArticlePageCacheKeyRow {
            page_id,
            page_slug: row_page_slug,
            page_updated_at: row_page_updated_at,
            latest_revision_id: row_latest_revision_id,
            from_wikidot,
            compiled_body_html_hash,
            compiled_body_styles_hash,
            compiled_top_bar_html_hash,
            compiled_side_bar_html_hash,
            source_contents,
        } = row;
        let Some(latest_revision_id) = row_latest_revision_id else {
            return Ok(None);
        };
        if !from_wikidot {
            return Ok(None);
        }

        let (category, page) = split_category(&row_page_slug);
        let template_source =
            BlueprintPageService::get_page_template(ctx, input.site_id, category, page)
                .await?;

        let own_category_slug = category.unwrap_or("_default");
        let theme_statement = Statement::from_sql_and_values(
            DatabaseBackend::Postgres,
            str!(
                "
                SELECT slug, theme_kind, theme_builtin_id, theme_external_url,
                    theme_custom_css
                FROM page_category
                WHERE site_id = $1
                AND slug IN ($2, '_default')
                "
            ),
            [Value::from(input.site_id), Value::from(own_category_slug)],
        );
        let theme_rows = CategoryThemeRow::find_by_statement(theme_statement)
            .all(ctx.transaction())
            .await
            .or_raise(|| {
                Error::new(
                    "failed to load article page cache theme rows",
                    ErrorType::DatabaseQuery,
                )
            })?;
        let theme_fingerprint =
            category_theme_fingerprint(&theme_rows, own_category_slug);
        let template_source_hash = template_source
            .as_deref()
            .map(|source| Sha256::digest(source.as_bytes()).to_vec());

        let page_updated_at = row_page_updated_at
            .map(|value| value.unix_timestamp_nanos())
            .unwrap_or_default();
        let public_content_cache_fence = match public_content_cache_fence {
            Some(fence) => fence,
            None => PublicContentCache::cache_fence(ctx, input.site_id).await?,
        };
        let permission_fence =
            PermissionCache::cache_fence(ctx, input.site_id, None).await?;
        let permission_fence = permission_fence.cache_key_fragment();
        let route_slug = input.route.as_ref().map_or("", |route| route.slug.as_str());
        let locales = input.locales.join(",");

        Ok(format_article_page_cache_key_if_source_eligible(
            source_contents.as_deref(),
            template_source.as_deref(),
            ArticlePageCacheKeyParts {
                site_id: input.site_id,
                page_id,
                latest_revision_id,
                page_updated_at,
                public_content_cache_fence: &public_content_cache_fence,
                permission_fence: &permission_fence,
                template_source_hash: template_source_hash.as_deref(),
                compiled_body_html_hash: compiled_body_html_hash.as_deref(),
                compiled_body_styles_hash: compiled_body_styles_hash.as_deref(),
                compiled_top_bar_html_hash: compiled_top_bar_html_hash.as_deref(),
                compiled_side_bar_html_hash: compiled_side_bar_html_hash.as_deref(),
                route_slug,
                page_extra,
                locales: &locales,
                theme_fingerprint: &theme_fingerprint,
            },
        )
        .map(|cache_key| ArticlePageCacheMetadata {
            cache_key,
            public_content_cache_fence,
            anonymous_permission_cache_fence: permission_fence,
        }))
    }

    pub(super) async fn get(
        ctx: &ServiceContext<'_>,
        cache_key: &str,
    ) -> Result<Option<GetPageViewOutput>> {
        let mut redis = ctx.redis();
        let cached: Option<String> = redis.get(cache_key).await.or_raise(|| {
            Error::new(
                "failed to read cached article page view",
                ErrorType::RedisQuery,
            )
        })?;

        cached
            .map(|cached| {
                serde_json::from_str(&cached).or_raise(|| {
                    Error::new(
                        "failed to parse cached article page view",
                        ErrorType::RedisQuery,
                    )
                })
            })
            .transpose()
    }

    pub(super) async fn set(
        ctx: &ServiceContext<'_>,
        cache_key: &str,
        page: &GetPageViewOutput,
    ) -> Result<()> {
        let serialized = serde_json::to_string(page).or_raise(|| {
            Error::new(
                "failed to serialize article page view for cache",
                ErrorType::RedisQuery,
            )
        })?;
        let mut redis = ctx.redis();
        redis
            .set_ex::<_, _, ()>(
                cache_key,
                serialized,
                ARTICLE_VIEW_PAGE_CACHE_TTL_SECONDS,
            )
            .await
            .or_raise(|| {
                Error::new(
                    "failed to write cached article page view",
                    ErrorType::RedisQuery,
                )
            })
    }
}

fn optional_hash_hex(hash: Option<&[u8]>) -> String {
    hash.map(hex::encode).unwrap_or_default()
}

#[derive(Debug, FromQueryResult)]
struct CategoryThemeRow {
    slug: String,
    theme_kind: String,
    theme_builtin_id: Option<i64>,
    theme_external_url: Option<String>,
    theme_custom_css: Option<String>,
}

struct CategoryThemeFingerprintInput<'a> {
    theme_kind: &'a str,
    theme_builtin_id: Option<i64>,
    theme_external_url: Option<&'a str>,
    theme_custom_css: Option<&'a str>,
}

impl CategoryThemeRow {
    fn fingerprint_input(&self) -> CategoryThemeFingerprintInput<'_> {
        let Self {
            slug: _,
            theme_kind,
            theme_builtin_id,
            theme_external_url,
            theme_custom_css,
        } = self;

        CategoryThemeFingerprintInput {
            theme_kind: theme_kind.as_str(),
            theme_builtin_id: *theme_builtin_id,
            theme_external_url: theme_external_url.as_deref(),
            theme_custom_css: theme_custom_css.as_deref(),
        }
    }
}

fn category_theme_fingerprint(rows: &[CategoryThemeRow], own_slug: &str) -> Vec<u8> {
    let mut hasher = Sha256::new();
    let mut slugs = vec![own_slug];
    if own_slug != "_default" {
        slugs.push("_default");
    }
    for slug in slugs {
        hasher.update(slug.as_bytes());
        hasher.update([0]);
        match rows.iter().find(|row| row.slug == slug) {
            Some(row) => {
                let CategoryThemeFingerprintInput {
                    theme_kind,
                    theme_builtin_id,
                    theme_external_url,
                    theme_custom_css,
                } = row.fingerprint_input();
                hasher.update(theme_kind.as_bytes());
                hasher.update([0]);
                hasher.update(theme_builtin_id.unwrap_or_default().to_be_bytes());
                hasher.update(theme_external_url.unwrap_or("").as_bytes());
                hasher.update([0]);
                hasher.update(theme_custom_css.unwrap_or("").as_bytes());
                hasher.update([0]);
            }
            None => hasher.update(b"absent\0"),
        }
    }
    hasher.finalize().to_vec()
}

struct ArticlePageCacheKeyParts<'a> {
    site_id: i64,
    page_id: i64,
    latest_revision_id: i64,
    page_updated_at: i128,
    public_content_cache_fence: &'a str,
    permission_fence: &'a str,
    template_source_hash: Option<&'a [u8]>,
    compiled_body_html_hash: Option<&'a [u8]>,
    compiled_body_styles_hash: Option<&'a [u8]>,
    compiled_top_bar_html_hash: Option<&'a [u8]>,
    compiled_side_bar_html_hash: Option<&'a [u8]>,
    route_slug: &'a str,
    page_extra: &'a str,
    locales: &'a str,
    theme_fingerprint: &'a [u8],
}

fn format_article_page_cache_key(parts: ArticlePageCacheKeyParts<'_>) -> String {
    let body_hash = optional_hash_hex(parts.compiled_body_html_hash);
    let styles_hash = optional_hash_hex(parts.compiled_body_styles_hash);
    let top_bar_hash = optional_hash_hex(parts.compiled_top_bar_html_hash);
    let side_bar_hash = optional_hash_hex(parts.compiled_side_bar_html_hash);
    let template_hash = optional_hash_hex(parts.template_source_hash);
    let theme_hash = hex::encode(parts.theme_fingerprint);

    format!(
        "{ARTICLE_VIEW_PAGE_CACHE_PREFIX}:v{DEEPWELL_RENDERER_EPOCH}:site={}:page={}:rev={}:updated={}:public={}:permission={}:template={}:body={}:styles={}:top={}:side={}:slug={}:extra={}:locales={}:theme={}",
        parts.site_id,
        parts.page_id,
        parts.latest_revision_id,
        parts.page_updated_at,
        parts.public_content_cache_fence,
        parts.permission_fence,
        template_hash,
        body_hash,
        styles_hash,
        top_bar_hash,
        side_bar_hash,
        hex::encode(parts.route_slug),
        hex::encode(parts.page_extra),
        hex::encode(parts.locales),
        theme_hash,
    )
}

fn format_article_page_cache_key_if_source_eligible(
    source_contents: Option<&str>,
    template_source: Option<&str>,
    parts: ArticlePageCacheKeyParts<'_>,
) -> Option<String> {
    let source_contents = source_contents?;
    let composed_source =
        template_source.map(|template| compose_template(template, source_contents));
    let effective_source = composed_source.as_deref().unwrap_or(source_contents);
    if !anonymous_article_cache_source_eligible(effective_source) {
        return None;
    }

    Some(format_article_page_cache_key(parts))
}

pub(super) fn anonymous_article_cache_source_eligible(source: &str) -> bool {
    if wikitext_requires_runtime_render(source) {
        return false;
    }
    let classes = classify_anonymous_render_dependencies(source);
    !classes.contains(RenderDependencyClass::ViewerDependent)
        && !classes.contains(RenderDependencyClass::RequestDependent)
        && !classes.contains(RenderDependencyClass::UnsupportedUnverified)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn article_page_cache_optional_hash_hex_handles_missing_hashes() {
        assert_eq!(optional_hash_hex(None), "");
        assert_eq!(optional_hash_hex(Some(&[0x0a, 0xff])), "0aff");
    }

    #[test]
    fn article_page_cache_key_includes_compiled_body_hash() {
        let key = format_article_page_cache_key(ArticlePageCacheKeyParts {
            site_id: 7,
            page_id: 11,
            latest_revision_id: 13,
            page_updated_at: 17,
            public_content_cache_fence: "29",
            permission_fence: "site=19,user=23",
            template_source_hash: Some(&[0x89, 0xab]),
            compiled_body_html_hash: Some(&[0x01, 0x23]),
            compiled_body_styles_hash: Some(&[0x34]),
            compiled_top_bar_html_hash: Some(&[0x45]),
            compiled_side_bar_html_hash: Some(&[0x67]),
            route_slug: "start",
            page_extra: "noredirect",
            locales: "en,ja",
            theme_fingerprint: &[0xaa],
        });

        assert_eq!(
            key,
            format!(
                "deepwell:article-view:page:v{DEEPWELL_RENDERER_EPOCH}:site=7:page=11:rev=13:updated=17:public=29:permission=site=19,user=23:template=89ab:body=0123:styles=34:top=45:side=67:slug=7374617274:extra=6e6f7265646972656374:locales=656e2c6a61:theme=aa"
            ),
        );
    }

    #[test]
    fn article_page_cache_key_changes_with_assigned_template_source() {
        let key = |template_source_hash| {
            format_article_page_cache_key(ArticlePageCacheKeyParts {
                site_id: 7,
                page_id: 11,
                latest_revision_id: 13,
                page_updated_at: 17,
                public_content_cache_fence: "29",
                permission_fence: "site=19,user=23",
                template_source_hash,
                compiled_body_html_hash: Some(&[0x01, 0x23]),
                compiled_body_styles_hash: Some(&[0x34]),
                compiled_top_bar_html_hash: Some(&[0x45]),
                compiled_side_bar_html_hash: Some(&[0x67]),
                route_slug: "category:article",
                page_extra: "",
                locales: "en",
                theme_fingerprint: &[0xaa],
            })
        };

        assert_ne!(key(Some(&[0x01])), key(Some(&[0x02])));
        assert_ne!(key(Some(&[0x01])), key(None));
    }

    #[test]
    fn eligible_article_cache_key_changes_with_public_content_cache_fence() {
        let key = |public_content_cache_fence| {
            format_article_page_cache_key_if_source_eligible(
                Some("Cache-safe imported article."),
                None,
                ArticlePageCacheKeyParts {
                    site_id: 7,
                    page_id: 11,
                    latest_revision_id: 13,
                    page_updated_at: 17,
                    public_content_cache_fence,
                    permission_fence: "site=19,user=23",
                    template_source_hash: None,
                    compiled_body_html_hash: Some(&[0x01, 0x23]),
                    compiled_body_styles_hash: Some(&[0x34]),
                    compiled_top_bar_html_hash: Some(&[0x45]),
                    compiled_side_bar_html_hash: Some(&[0x67]),
                    route_slug: "category:article",
                    page_extra: "",
                    locales: "en",
                    theme_fingerprint: &[0xaa],
                },
            )
            .expect("static imported article source must remain cache-eligible")
        };

        assert_ne!(key("41"), key("42"));
    }

    #[test]
    fn article_page_cache_key_source_gate_allows_anonymous_safe_sources() {
        for source in [
            "Plain imported page text.\n\n[[div]]Static[[/div]]",
            "[[include component:license-box]]",
            "[[code]]\n[[module CountPages category=\"news\"]]%%total%%[[/module]]\n[[/code]]",
            "[[module CountPages]][[/module]]",
            "[[*user example]]",
            "[[[empty-label|]]]",
            "[[code]]\n[[module PagesByTag tag=\"alpha\"]]\n[[/code]]",
        ] {
            let key = format_article_page_cache_key_if_source_eligible(
                Some(source),
                None,
                ArticlePageCacheKeyParts {
                    site_id: 7,
                    page_id: 11,
                    latest_revision_id: 13,
                    page_updated_at: 17,
                    public_content_cache_fence: "29",
                    permission_fence: "site=19,user=23",
                    template_source_hash: None,
                    compiled_body_html_hash: Some(&[0x01, 0x23]),
                    compiled_body_styles_hash: Some(&[0x34]),
                    compiled_top_bar_html_hash: Some(&[0x45]),
                    compiled_side_bar_html_hash: Some(&[0x67]),
                    route_slug: "start",
                    page_extra: "noredirect",
                    locales: "en,ja",
                    theme_fingerprint: &[0xaa],
                },
            );

            assert_eq!(
                key.as_deref(),
                Some(
                    format!("deepwell:article-view:page:v{DEEPWELL_RENDERER_EPOCH}:site=7:page=11:rev=13:updated=17:public=29:permission=site=19,user=23:template=:body=0123:styles=34:top=45:side=67:slug=7374617274:extra=6e6f7265646972656374:locales=656e2c6a61:theme=aa")
                ).as_deref(),
                "{source}",
            );
        }
    }

    #[test]
    fn article_page_cache_key_source_gate_denies_missing_or_unsafe_source() {
        let parts = ArticlePageCacheKeyParts {
            site_id: 7,
            page_id: 11,
            latest_revision_id: 13,
            page_updated_at: 17,
            public_content_cache_fence: "29",
            permission_fence: "site=19,user=23",
            template_source_hash: None,
            compiled_body_html_hash: None,
            compiled_body_styles_hash: None,
            compiled_top_bar_html_hash: None,
            compiled_side_bar_html_hash: None,
            route_slug: "start",
            page_extra: "",
            locales: "en",
            theme_fingerprint: &[0xaa],
        };

        assert_eq!(
            format_article_page_cache_key_if_source_eligible(None, None, parts),
            None
        );

        for source in [
            "[[module CountPages category=\"news\"]]%%total%%[[/module]]",
            "[[module CountPages offset=\"@URL|1\"]][[/module]]",
            "[[module CountPages tags=\"@URL\"]]%%total%%[[/module]]",
            "[[module ListPages category=\"fragment\"]]%%content%%[[/module]]",
            "[[module ListPages order=\"random\"]]%%title%%[[/module]]",
            "Request value @URL|0",
            "[[module UnknownWidget]]",
            "[[module]]",
            "[[module ChildPages]]",
            "[[module PagesByTag tag=\"alpha\"]]",
            "[[module PagesByTag tag=\"alpha\" limit=\"5\"]]",
        ] {
            let parts = ArticlePageCacheKeyParts {
                site_id: 7,
                page_id: 11,
                latest_revision_id: 13,
                page_updated_at: 17,
                public_content_cache_fence: "29",
                permission_fence: "site=19,user=23",
                template_source_hash: None,
                compiled_body_html_hash: None,
                compiled_body_styles_hash: None,
                compiled_top_bar_html_hash: None,
                compiled_side_bar_html_hash: None,
                route_slug: "start",
                page_extra: "",
                locales: "en",
                theme_fingerprint: &[0xaa],
            };

            assert_eq!(
                format_article_page_cache_key_if_source_eligible(
                    Some(source),
                    None,
                    parts,
                ),
                None,
                "{source}",
            );
        }
    }

    #[test]
    fn article_page_cache_key_source_gate_classifies_page_and_template_sources() {
        let parts = || ArticlePageCacheKeyParts {
            site_id: 7,
            page_id: 11,
            latest_revision_id: 13,
            page_updated_at: 17,
            public_content_cache_fence: "29",
            permission_fence: "site=19,user=23",
            template_source_hash: None,
            compiled_body_html_hash: None,
            compiled_body_styles_hash: None,
            compiled_top_bar_html_hash: None,
            compiled_side_bar_html_hash: None,
            route_slug: "category:article",
            page_extra: "",
            locales: "en",
            theme_fingerprint: &[0xaa],
        };
        let request_dependent_list_pages =
            "[[module ListPages offset=\"@URL|1\"]]%%title_linked%%[[/module]]";
        let split_request_dependent_template =
            "[[module ListPages offset=\"@U%%content%%\"]]%%title_linked%%[[/module]]";

        assert!(
            format_article_page_cache_key_if_source_eligible(
                Some("cache-safe page source"),
                Some("cache-safe template\n%%content%%"),
                parts(),
            )
            .is_some(),
        );
        assert_eq!(
            format_article_page_cache_key_if_source_eligible(
                Some(request_dependent_list_pages),
                None,
                parts(),
            ),
            None,
        );
        assert_eq!(
            format_article_page_cache_key_if_source_eligible(
                Some("cache-safe page source"),
                Some(request_dependent_list_pages),
                parts(),
            ),
            None,
        );
        assert_eq!(
            format_article_page_cache_key_if_source_eligible(
                Some("RL|1"),
                Some(split_request_dependent_template),
                parts(),
            ),
            None,
        );
    }

    #[test]
    fn article_page_cache_eligibility_allows_anonymous_safe_sources() {
        for source in [
            "Plain imported page text.\n\n[[div]]Static[[/div]]",
            "[[include component:license-box]]",
            "[[code]]\n[[module CountPages category=\"news\"]]%%total%%[[/module]]\n[[/code]]",
            "[[module CountPages]][[/module]]",
            "[[*user example]]",
            "[[code]]\n[[module PagesByTag tag=\"alpha\"]]\n[[/code]]",
            "[[gallery]]",
            "[[code]]\n[[gallery]]\n[[/code]]",
            "A[[gallery]]B",
        ] {
            assert!(anonymous_article_cache_source_eligible(source), "{source}");
        }
    }

    #[test]
    fn article_page_cache_eligibility_denies_unsafe_or_unverified_sources() {
        for source in [
            "[[module CountPages category=\"news\"]]%%total%%[[/module]]",
            "[[module CountPages offset=\"@URL|1\"]][[/module]]",
            "[[module CountPages tags=\"@URL\"]]%%total%%[[/module]]",
            "[[module ListPages category=\"fragment\"]]%%content%%[[/module]]",
            "[[module ListPages order=\"random\"]]%%title%%[[/module]]",
            "Request value @URL|0",
            "[[module Members]]",
            "[[module NewPage]]",
            "[[module Clone]]",
            "[[module UnknownWidget]]",
            "[[module]]",
            "[[module ChildPages]]",
            "[[module PagesByTag tag=\"alpha\"]]",
            "[[module PagesByTag tag=\"alpha\" limit=\"5\"]]",
            "[[module NextPage by=\"title\"]]%%linked_title%%[[/module]]",
        ] {
            assert!(!anonymous_article_cache_source_eligible(source));
        }
    }

    #[test]
    fn article_page_cache_denies_random_redirect_helpers() {
        let helper = "[[module ListPages category=\"_default\" order=\"random\" limit=\"1\" tag=\"scp\"]]\n[[include :snippets:redirect url=%%link%%]]\n[[/module]]\n";
        assert!(!anonymous_article_cache_source_eligible(helper), "{helper}");
    }

    #[test]
    fn article_page_cache_allows_the_rating_widget_for_anonymous_viewers() {
        for source in ["[[module Rate]]", "Text\n\n[[module Rate]]\n\nmore text"] {
            assert!(anonymous_article_cache_source_eligible(source), "{source}");
        }
        for source in ["[[module Rate]]\n[[module NewPage]]", "[[module NewPage]]"] {
            assert!(!anonymous_article_cache_source_eligible(source), "{source}");
        }
    }

    #[test]
    fn article_page_cache_key_changes_with_theme_fingerprint() {
        let key = |theme_fingerprint: &[u8]| {
            format_article_page_cache_key(ArticlePageCacheKeyParts {
                site_id: 7,
                page_id: 11,
                latest_revision_id: 13,
                page_updated_at: 17,
                public_content_cache_fence: "29",
                permission_fence: "site=19,user=23",
                template_source_hash: None,
                compiled_body_html_hash: Some(&[0x01, 0x23]),
                compiled_body_styles_hash: Some(&[0x34]),
                compiled_top_bar_html_hash: Some(&[0x45]),
                compiled_side_bar_html_hash: Some(&[0x67]),
                route_slug: "category:article",
                page_extra: "",
                locales: "en",
                theme_fingerprint,
            })
        };

        assert_ne!(key(&[0x01]), key(&[0x02]));
    }

    #[test]
    fn category_theme_fingerprint_tracks_stored_theme_fields() {
        let row = |slug: &str, kind: &str, url: Option<&str>, css: Option<&str>| {
            CategoryThemeRow {
                slug: slug.to_owned(),
                theme_kind: kind.to_owned(),
                theme_builtin_id: None,
                theme_external_url: url.map(|v| v.to_owned()),
                theme_custom_css: css.map(|v| v.to_owned()),
            }
        };
        let base = vec![
            row("news", "inherit", None, None),
            row("_default", "built_in", None, None),
        ];
        let base_fp = category_theme_fingerprint(&base, "news");

        assert_eq!(base_fp, category_theme_fingerprint(&base, "news"));

        let kind_changed = vec![
            row(
                "news",
                "external",
                Some("https://example.com/theme.css"),
                None,
            ),
            row("_default", "built_in", None, None),
        ];
        assert_ne!(base_fp, category_theme_fingerprint(&kind_changed, "news"));

        let url_changed = vec![
            row(
                "news",
                "external",
                Some("https://example.com/other.css"),
                None,
            ),
            row("_default", "built_in", None, None),
        ];
        assert_ne!(
            category_theme_fingerprint(&kind_changed, "news"),
            category_theme_fingerprint(&url_changed, "news"),
        );

        let default_css_changed = vec![
            row("news", "inherit", None, None),
            row("_default", "custom", None, Some("body { color: red; }")),
        ];
        assert_ne!(
            base_fp,
            category_theme_fingerprint(&default_css_changed, "news"),
        );

        let default_only = vec![row("_default", "built_in", None, None)];
        assert_eq!(
            category_theme_fingerprint(&default_only, "_default"),
            category_theme_fingerprint(&base, "_default"),
        );
    }
}
