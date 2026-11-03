/*
 * services/render/pages_by_tag.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

use super::compat::CompatHtmlFragments;
use super::percent_encoding::percent_encode_path_segment;
use super::service::{
    RenderService, escape_list_pages_html_attr, escape_list_pages_html_text,
};
use super::url_arguments::UrlArguments;
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::services::ServiceContext;
use crate::services::permission::{CheckPermissionContext, PermissionService};
use crate::types::Reference;
use crate::types::{Action, Permission, Resource};
use ftml::data::PageInfo;
use ftml::settings::WikitextSettings;
use ftml::{self};
use regex::Regex;
use sea_orm::{ConnectionTrait, FromQueryResult, Statement};
use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock};

pub(super) static PAGES_BY_TAG_MODULE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)\[\[module\s+PagesByTag(?P<head>[^\]]*)\]\]").unwrap()
});

pub(super) const MAX_PAGES_BY_TAG_ROWS: usize = 500;
pub(super) const MAX_PAGES_BY_TAG_MODULE_QUERIES_PER_RENDER: usize = 32;

#[derive(Debug, FromQueryResult)]
pub(super) struct PagesByTagPage {
    pub page_id: i64,
    pub page_category_id: i64,
    pub slug: String,
    pub title: String,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct PagesByTagArguments {
    pub tag: Option<String>,
    pub category: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct PagesByTagCacheKey {
    tag: String,
    category: Option<String>,
}

#[derive(Default)]
struct PagesByTagPagesCache {
    pages: HashMap<PagesByTagCacheKey, Arc<Vec<PagesByTagPage>>>,
}

impl PagesByTagPagesCache {
    async fn get_or_init<F, Fut>(
        &mut self,
        key: PagesByTagCacheKey,
        load: F,
    ) -> Result<Arc<Vec<PagesByTagPage>>>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = Result<Vec<PagesByTagPage>>>,
    {
        if let Some(pages) = self.pages.get(&key) {
            return Ok(Arc::clone(pages));
        }

        let pages = Arc::new(load().await?);
        self.pages.insert(key, Arc::clone(&pages));
        Ok(pages)
    }
}

fn pages_by_tag_query_budget_exceeded(query_count: usize) -> bool {
    query_count >= MAX_PAGES_BY_TAG_MODULE_QUERIES_PER_RENDER
}

pub(super) fn parse_pages_by_tag_arguments(head: &str) -> Option<PagesByTagArguments> {
    let mut rest = head.trim();
    let mut arguments = PagesByTagArguments::default();
    while !rest.is_empty() {
        let (name, after_name) = split_pages_by_tag_token(rest)?;
        let name = name.trim();
        if !matches!(name, "tag" | "category") {
            return None;
        }
        if (name == "tag" && arguments.tag.is_some())
            || (name == "category" && arguments.category.is_some())
        {
            return None;
        }

        let after_equals = after_name.trim_start().strip_prefix('=')?.trim_start();
        let (value, after_value) = parse_pages_by_tag_value(after_equals)?;
        let value = value.trim();
        if value.is_empty() {
            return None;
        }

        match name {
            "tag" => arguments.tag = Some(value.to_owned()),
            "category" => arguments.category = Some(value.to_owned()),
            _ => unreachable!("name is checked above"),
        }
        rest = after_value.trim_start();
    }

    Some(arguments)
}

fn split_pages_by_tag_token(input: &str) -> Option<(&str, &str)> {
    let boundary = input
        .find(|character: char| character == '=' || character.is_whitespace())
        .unwrap_or(input.len());
    (boundary > 0).then_some((&input[..boundary], &input[boundary..]))
}

fn parse_pages_by_tag_value(input: &str) -> Option<(&str, &str)> {
    if let Some(rest) = input.strip_prefix('"') {
        let (value, rest) = rest.split_once('"')?;
        Some((value, rest))
    } else {
        let boundary = input
            .find(|character: char| character.is_whitespace())
            .unwrap_or(input.len());
        (boundary > 0).then_some((&input[..boundary], &input[boundary..]))
    }
}

pub(super) fn render_pages_by_tag_module(
    page_info: &PageInfo<'_>,
    tag: &str,
    category: Option<&str>,
    pages: &[PagesByTagPage],
) -> String {
    let mut output =
        String::from("<a name=\"pages\"></a>\n<h2>List of pages tagged with <em>");
    output.push_str(&escape_list_pages_html_text(tag));
    match category {
        Some(category) => {
            output.push_str("</em> from category <em>");
            output.push_str(&escape_list_pages_html_text(category));
            output.push_str("</em>:</h2>\n<span style=\"float: right\">(<a href=\"/");
            output.push_str(&escape_list_pages_html_attr(
                &RenderService::page_info_full_slug(page_info),
            ));
            output.push_str("/tag/");
            output.push_str(&escape_list_pages_html_attr(&percent_encode_path_segment(
                tag,
            )));
            output.push_str(
                "\">show from all categories</a>)</span>\n<div class=\"pages-list\" id=\"tagged-pages-list\">",
            );
        }
        None => output.push_str(
            "</em>:</h2> \n\n\n<div class=\"pages-list\" id=\"tagged-pages-list\">",
        ),
    }

    for page in pages {
        output.push_str("\n\t\t\t<div class=\"pages-list-item\">\n\t\t\t<div class=\"title\">\n\t\t\t\t<a href=\"/");
        output.push_str(&escape_list_pages_html_attr(&page.slug));
        output.push_str("\">");
        output.push_str(&escape_list_pages_html_text(&page.title));
        output.push_str("</a>\n\t\t\t</div>\n\t\t</div>");
    }

    output.push_str("\n\t</div>\n");
    output
}

pub(super) async fn expand_pages_by_tag_modules(
    ctx: &ServiceContext<'_>,
    wikitext: String,
    page_info: &PageInfo<'_>,
    settings: &WikitextSettings,
    current_site_id: Option<i64>,
    url: UrlArguments<'_>,
    compat_html: &mut CompatHtmlFragments,
) -> Result<String> {
    if !settings.enable_page_syntax || !PAGES_BY_TAG_MODULE_REGEX.is_match(&wikitext) {
        return Ok(wikitext);
    }

    let Some(current_site_id) = current_site_id else {
        return Ok(wikitext);
    };

    let mut expanded = String::with_capacity(wikitext.len());
    let mut cursor = 0;
    let mut pages_cache = PagesByTagPagesCache::default();
    let mut distinct_query_count = 0;

    for captures in PAGES_BY_TAG_MODULE_REGEX.captures_iter(&wikitext) {
        let mtch = captures.get(0).unwrap();
        expanded.push_str(&wikitext[cursor..mtch.start()]);
        cursor = mtch.end();

        if RenderService::is_inside_wikidot_literal_region(&wikitext, mtch.start()) {
            expanded.push_str(mtch.as_str());
            continue;
        }

        let head = captures.name("head").map_or("", |mtch| mtch.as_str());
        let (tag, category) = if head.trim().is_empty() {
            let Some(url_tag) = url.tag else {
                continue;
            };
            (url_tag.to_owned(), url.category.map(str::to_owned))
        } else {
            let Some(arguments) = parse_pages_by_tag_arguments(head) else {
                expanded.push_str(mtch.as_str());
                continue;
            };
            let tag = match arguments.tag {
                Some(tag) => tag,
                None => match url.tag {
                    Some(url_tag) => url_tag.to_owned(),
                    None => continue,
                },
            };
            (
                tag,
                arguments
                    .category
                    .or_else(|| url.category.map(str::to_owned)),
            )
        };

        let key = PagesByTagCacheKey {
            tag: tag.clone(),
            category: category.clone(),
        };
        let pages = if let Some(pages) = pages_cache.pages.get(&key) {
            Arc::clone(pages)
        } else {
            if pages_by_tag_query_budget_exceeded(distinct_query_count) {
                expanded.push_str(mtch.as_str());
                continue;
            }
            distinct_query_count += 1;
            pages_cache
                .get_or_init(key, || {
                    load_pages_by_tag_pages(
                        ctx,
                        current_site_id,
                        &tag,
                        category.as_deref(),
                    )
                })
                .await?
        };
        expanded.push_str(&compat_html.push_block_html(render_pages_by_tag_module(
            page_info,
            &tag,
            category.as_deref(),
            pages.as_ref(),
        )));
    }

    expanded.push_str(&wikitext[cursor..]);
    Ok(expanded)
}

pub(super) async fn load_pages_by_tag_pages(
    ctx: &ServiceContext<'_>,
    current_site_id: i64,
    tag: &str,
    category: Option<&str>,
) -> Result<Vec<PagesByTagPage>> {
    let make_error = || {
        Error::new(
            format!(
                "failed to load PagesByTag module rows for site ID {current_site_id}",
            ),
            ErrorType::Render,
        )
    };
    let txn = ctx.transaction();
    let statement = match category {
        Some(category) => Statement::from_sql_and_values(
            txn.get_database_backend(),
            "SELECT p.page_id, p.page_category_id, p.slug, pr.title \
             FROM page p \
             JOIN page_revision pr ON pr.revision_id = p.latest_revision_id \
             JOIN page_category pc ON pc.category_id = p.page_category_id \
             WHERE p.site_id = $1 \
               AND p.deleted_at IS NULL \
               AND $2 = ANY(pr.tags) \
               AND pc.slug = $3 \
             ORDER BY lower(pr.title), p.slug \
             LIMIT $4",
            [
                current_site_id.into(),
                tag.into(),
                category.into(),
                (MAX_PAGES_BY_TAG_ROWS as i64).into(),
            ],
        ),
        None => Statement::from_sql_and_values(
            txn.get_database_backend(),
            "SELECT p.page_id, p.page_category_id, p.slug, pr.title \
             FROM page p \
             JOIN page_revision pr ON pr.revision_id = p.latest_revision_id \
             WHERE p.site_id = $1 \
               AND p.deleted_at IS NULL \
               AND $2 = ANY(pr.tags) \
             ORDER BY lower(pr.title), p.slug \
             LIMIT $3",
            [
                current_site_id.into(),
                tag.into(),
                (MAX_PAGES_BY_TAG_ROWS as i64).into(),
            ],
        ),
    };

    let rows = PagesByTagPage::find_by_statement(statement)
        .all(txn)
        .await
        .or_raise(make_error)?;

    let mut viewable = Vec::with_capacity(rows.len());
    for row in rows {
        let anonymously_viewable = PermissionService::check_user_can(
            ctx,
            &CheckPermissionContext {
                user_id: None,
                site_id: current_site_id,
                page_reference: Some(Reference::Id(row.page_id)),
            },
            Permission {
                resource_type: Resource::Page,
                resource_category: Some(Reference::Id(row.page_category_id)),
                action: Action::View,
            },
        )
        .await
        .or_raise(make_error)?;

        if anonymously_viewable {
            viewable.push(row);
        }
    }

    Ok(viewable)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::borrow::Cow;

    #[test]
    fn pages_by_tag_query_budget_preserves_after_the_last_allowed_unique_query() {
        assert!(!pages_by_tag_query_budget_exceeded(
            MAX_PAGES_BY_TAG_MODULE_QUERIES_PER_RENDER - 1,
        ));
        assert!(pages_by_tag_query_budget_exceeded(
            MAX_PAGES_BY_TAG_MODULE_QUERIES_PER_RENDER,
        ));
    }

    #[tokio::test]
    async fn repeated_pages_by_tag_queries_reuse_the_same_render_result() {
        let mut cache = PagesByTagPagesCache::default();
        let key = PagesByTagCacheKey {
            tag: "example".to_owned(),
            category: None,
        };

        let first = cache
            .get_or_init(key.clone(), || async { Ok(Vec::new()) })
            .await
            .expect("the first PagesByTag load should succeed");
        let second = cache
            .get_or_init(key, || async {
                panic!("a cached PagesByTag result must not query again")
            })
            .await
            .expect("the cached PagesByTag load should succeed");

        assert!(first.is_empty());
        assert!(second.is_empty());
    }

    fn page(slug: &str, title: &str) -> PagesByTagPage {
        PagesByTagPage {
            page_id: 1,
            page_category_id: 1,
            slug: slug.to_owned(),
            title: title.to_owned(),
        }
    }

    fn page_info() -> PageInfo<'static> {
        PageInfo {
            page: Cow::Borrowed("system:page-tags"),
            category: None,
            site: Cow::Borrowed("sandbox-for-codex"),
            title: Cow::Borrowed("Page Tags"),
            alt_title: None,
            score: ftml::data::ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        }
    }

    #[test]
    fn parses_the_evidenced_quoted_tag_argument() {
        assert_eq!(
            parse_pages_by_tag_arguments(r#" tag="cgmodcat""#)
                .and_then(|arguments| arguments.tag),
            Some("cgmodcat".to_owned()),
        );
        assert_eq!(
            parse_pages_by_tag_arguments(r#"tag="cg-pbt-order-20260725""#)
                .and_then(|arguments| arguments.tag),
            Some("cg-pbt-order-20260725".to_owned()),
        );
        assert_eq!(
            parse_pages_by_tag_arguments(" tag=cgmodcat")
                .and_then(|arguments| arguments.tag),
            Some("cgmodcat".to_owned()),
        );
        assert_eq!(
            parse_pages_by_tag_arguments(r#" category="_default" tag="news""#),
            Some(PagesByTagArguments {
                tag: Some("news".to_owned()),
                category: Some("_default".to_owned()),
            }),
        );
    }

    #[test]
    fn leaves_unevidenced_argument_forms_unparsed() {
        for head in [
            r#" tag="""#,
            r#" tag="a" tag="b""#,
            r#" tag="a" limit="5""#,
            r#" limit="5""#,
            " tag=a b",
        ] {
            assert_eq!(parse_pages_by_tag_arguments(head), None, "head: {head:?}");
        }
    }

    #[test]
    fn renders_the_captured_live_dom_byte_for_byte() {
        let pages = [
            page("cg-pbt-order-alpha", "Alpha Probe"),
            page("cg-pbt-order-bravo", "Bravo Probe"),
            page("cg-pbt-order-charlie", "Charlie Probe"),
        ];
        let rendered = render_pages_by_tag_module(
            &page_info(),
            "cg-pbt-order-20260725",
            None,
            &pages,
        );

        assert_eq!(
            rendered,
            concat!(
                "<a name=\"pages\"></a>\n",
                "<h2>List of pages tagged with <em>cg-pbt-order-20260725</em>:</h2> \n",
                "\n\n<div class=\"pages-list\" id=\"tagged-pages-list\">",
                "\n\t\t\t<div class=\"pages-list-item\">\n\t\t\t<div class=\"title\">\n",
                "\t\t\t\t<a href=\"/cg-pbt-order-alpha\">Alpha Probe</a>\n\t\t\t</div>\n\t\t</div>",
                "\n\t\t\t<div class=\"pages-list-item\">\n\t\t\t<div class=\"title\">\n",
                "\t\t\t\t<a href=\"/cg-pbt-order-bravo\">Bravo Probe</a>\n\t\t\t</div>\n\t\t</div>",
                "\n\t\t\t<div class=\"pages-list-item\">\n\t\t\t<div class=\"title\">\n",
                "\t\t\t\t<a href=\"/cg-pbt-order-charlie\">Charlie Probe</a>\n\t\t\t</div>\n\t\t</div>",
                "\n\t</div>\n",
            ),
        );
    }

    #[test]
    fn escapes_tag_titles_and_slugs() {
        let pages = [page("a<b>", "T<script>alert(1)</script>")];
        let rendered = render_pages_by_tag_module(&page_info(), "x\"y<z", None, &pages);

        assert!(!rendered.contains("<script>"));
        assert!(rendered.contains("&lt;script&gt;alert(1)&lt;/script&gt;"));
        assert!(rendered.contains("<em>x\"y&lt;z</em>"));
        assert!(rendered.contains("href=\"/a&lt;b&gt;\""));
        assert!(!rendered.contains("href=\"/a<b>\""));
    }

    #[test]
    fn renders_category_heading_and_all_categories_link() {
        let rendered = render_pages_by_tag_module(
            &page_info(),
            "news",
            Some("_default"),
            &[page("news-page", "News Page")],
        );

        assert!(rendered.contains(
            "<h2>List of pages tagged with <em>news</em> from category <em>_default</em>:</h2>",
        ));
        assert!(rendered.contains(
            r#"<span style="float: right">(<a href="/system:page-tags/tag/news">show from all categories</a>)</span>"#,
        ));
        assert!(rendered.contains(r#"<a href="/news-page">News Page</a>"#));
    }
}
