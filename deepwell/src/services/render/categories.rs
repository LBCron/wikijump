/*
 * services/render/categories.rs
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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

use super::authorized_page_selector::AuthorizedPageSelector;
use super::compat::CompatHtmlFragments;
use super::literal_regions::LiteralRegionIndex;
use super::service::{
    MAX_LISTPAGES_RENDER_SCAN_ROWS, RenderService, escape_list_pages_html_attr,
    escape_list_pages_html_text,
};
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::page::{self, Entity as Page};
use crate::models::page_revision::{self, Entity as PageRevision};
use crate::services::permission::{CheckPermissionContext, PermissionService};
use crate::services::{CategoryService, ServiceContext};
use crate::types::{Action, Permission, Reference, Resource};
use ftml::settings::WikitextSettings;
use regex::Regex;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QuerySelect};
use std::collections::HashMap;
use std::sync::LazyLock;

static CATEGORIES_MODULE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)\[\[module\s+Categories(?P<head>(?:\s+[^\]]*)?)\]\]").unwrap()
});

static INCLUDE_HIDDEN_MODULE_ARGUMENT_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?s)(?:^|\s)includeHidden="[^"]+"(?:$|\s)"#).unwrap());

fn include_hidden_categories(head: &str) -> bool {
    INCLUDE_HIDDEN_MODULE_ARGUMENT_REGEX.is_match(head)
}

fn category_is_visible(slug: &str, include_hidden: bool) -> bool {
    slug == "_default" || include_hidden || !slug.starts_with('_')
}

pub(super) fn wikidot_category_sort_key(slug: &str) -> (String, String) {
    (slug.replace('-', ""), slug.to_owned())
}

fn render_categories_module<'a>(
    categories: impl IntoIterator<Item = (i64, &'a str)>,
    include_hidden: bool,
) -> String {
    let mut output = String::new();

    for (category_id, slug) in categories {
        if !category_is_visible(slug, include_hidden) {
            continue;
        }

        if output.is_empty() {
            output.push('\n');
        }
        let slug = escape_list_pages_html_text(slug);
        output.push_str("<div>\n<h3>");
        output.push_str(&slug);
        output.push_str("</h3>\n<a id=\"category-pages-toggler-");
        output.push_str(&category_id.to_string());
        output.push_str("\" href=\"javascript:;\" onclick=\"WIKIDOT.modules.WikiCategoriesModule.listeners.toggleListPages(event, ");
        output.push_str(&category_id.to_string());
        output.push_str(
            ")\">+ list pages</a>\n<div style=\"display: none\" id=\"category-pages-",
        );
        output.push_str(&category_id.to_string());
        output.push_str("\"></div>\n<div style=\"display: none\" id=\"category-pages-");
        output.push_str(&category_id.to_string());
        output.push_str("-options\">");
        if include_hidden {
            output.push('1');
        }
        output.push_str("</div>\n</div>\n");
    }

    output
}

fn render_category_page_list<'a>(
    pages: impl IntoIterator<Item = (&'a str, &'a str)>,
) -> String {
    let mut output = String::from("<ul>\n");
    for (slug, title) in pages {
        output.push_str("\t\t<li>\n\t\t\t<a href=\"/");
        output.push_str(&escape_list_pages_html_attr(slug));
        output.push_str("\">");
        output.push_str(&escape_list_pages_html_text(title));
        output.push_str("</a>\n\t\t</li>\n");
    }
    output.push_str("</ul>\n");
    output
}

impl RenderService {
    pub async fn render_wikidot_categories_page_list_module(
        ctx: &ServiceContext<'_>,
        site_id: i64,
        category_id: i64,
        viewer_user_id: Option<i64>,
    ) -> Result<String> {
        let make_error =
            || Error::new("failed to render Categories page list", ErrorType::Render);
        let category = CategoryService::get(ctx, site_id, Reference::Id(category_id))
            .await
            .or_raise(make_error)?;
        let can_view_category = PermissionService::check_user_can(
            ctx,
            &CheckPermissionContext {
                user_id: viewer_user_id,
                site_id,
                page_reference: None,
            },
            Permission {
                resource_type: Resource::Page,
                resource_category: Some(Reference::Id(category.category_id)),
                action: Action::View,
            },
        )
        .await?;
        if !can_view_category {
            return Err(Error::new(
                "Categories page-list category is not viewable",
                ErrorType::PermissionDenied,
            )
            .into());
        }

        let txn = ctx.transaction();
        let pages = Page::find()
            .filter(page::Column::SiteId.eq(site_id))
            .filter(page::Column::PageCategoryId.eq(category_id))
            .filter(page::Column::DeletedAt.is_null())
            .limit(u64::from(MAX_LISTPAGES_RENDER_SCAN_ROWS) + 1)
            .all(txn)
            .await
            .or_raise(make_error)?;
        if pages.len() > MAX_LISTPAGES_RENDER_SCAN_ROWS as usize {
            return Err(make_error().into());
        }
        let mut authorized = AuthorizedPageSelector::new(ctx, viewer_user_id);
        let pages = authorized.filter_models(pages).await?;
        let revision_ids = pages
            .iter()
            .filter_map(|page| page.latest_revision_id)
            .collect::<Vec<_>>();
        let revisions = PageRevision::find()
            .filter(page_revision::Column::RevisionId.is_in(revision_ids))
            .all(txn)
            .await
            .or_raise(make_error)?;
        let titles = revisions
            .into_iter()
            .map(|revision| (revision.revision_id, revision.title))
            .collect::<HashMap<_, _>>();
        let mut rows = pages
            .into_iter()
            .filter_map(|page| {
                let revision_id = page.latest_revision_id?;
                let title = titles.get(&revision_id)?.clone();
                Some((page.slug, title))
            })
            .collect::<Vec<_>>();
        rows.sort_by(|(slug_a, title_a), (slug_b, title_b)| {
            title_a.cmp(title_b).then_with(|| slug_a.cmp(slug_b))
        });
        Ok(render_category_page_list(
            rows.iter()
                .map(|(slug, title)| (slug.as_str(), title.as_str())),
        ))
    }

    pub(super) async fn expand_categories_modules(
        ctx: &ServiceContext<'_>,
        wikitext: String,
        settings: &WikitextSettings,
        current_site_id: Option<i64>,
        viewer_user_id: Option<i64>,
        compat_html: &mut CompatHtmlFragments,
    ) -> Result<String> {
        if !settings.enable_page_syntax || !CATEGORIES_MODULE_REGEX.is_match(&wikitext) {
            return Ok(wikitext);
        }

        let Some(current_site_id) = current_site_id else {
            return Ok(wikitext);
        };

        let categories = CategoryService::get_all_active(ctx, current_site_id).await?;
        let mut visible_categories = Vec::with_capacity(categories.len());
        for category in categories {
            let can_view = PermissionService::check_user_can(
                ctx,
                &CheckPermissionContext {
                    user_id: viewer_user_id,
                    site_id: current_site_id,
                    page_reference: None,
                },
                Permission {
                    resource_type: Resource::Page,
                    resource_category: Some(Reference::Id(category.category_id)),
                    action: Action::View,
                },
            )
            .await?;
            if can_view {
                visible_categories.push(category);
            }
        }
        let mut categories = visible_categories;
        categories
            .sort_by_cached_key(|category| wikidot_category_sort_key(&category.slug));
        let category_refs = categories
            .iter()
            .map(|category| (category.category_id, category.slug.as_str()))
            .collect::<Vec<_>>();
        let literal_regions =
            LiteralRegionIndex::new_wikidot_module_recognition(&wikitext);
        let mut output = String::with_capacity(wikitext.len());
        let mut cursor = 0;

        for captures in CATEGORIES_MODULE_REGEX.captures_iter(&wikitext) {
            let matched = captures
                .get(0)
                .expect("a Categories capture always has a complete match");
            if literal_regions.contains(matched.start()) {
                continue;
            }

            output.push_str(&wikitext[cursor..matched.start()]);
            let head = captures.name("head").map_or("", |mtch| mtch.as_str());
            let rendered = render_categories_module(
                category_refs.iter().copied(),
                include_hidden_categories(head),
            );
            output.push_str(&compat_html.push_block_html(rendered));
            cursor = matched.end();
        }

        if cursor == 0 {
            return Ok(wikitext);
        }
        output.push_str(&wikitext[cursor..]);
        Ok(output)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CATEGORIES_MODULE_REGEX, category_is_visible, include_hidden_categories,
        render_categories_module, render_category_page_list, wikidot_category_sort_key,
    };

    #[test]
    fn categories_name_must_end_before_arguments() {
        assert!(CATEGORIES_MODULE_REGEX.is_match("[[module Categories]]"));
        assert!(
            CATEGORIES_MODULE_REGEX
                .is_match(r#"[[module categories includeHidden="true"]]"#)
        );
        assert!(!CATEGORIES_MODULE_REGEX.is_match("[[module CategoriesExtra]]"));
    }

    #[test]
    fn include_hidden_matches_live_exact_quoted_argument() {
        assert!(!include_hidden_categories(""));
        assert!(include_hidden_categories(r#" includeHidden="true""#));
        assert!(include_hidden_categories(r#" includeHidden="TRUE""#));
        assert!(include_hidden_categories(r#" includeHidden="false""#));
        assert!(!include_hidden_categories(r#" includeHidden="""#));
        assert!(!include_hidden_categories(r#" includeHidden=true"#));
        assert!(!include_hidden_categories(r#" includeHidden = "true""#));
        assert!(!include_hidden_categories(r#" INCLUDEHIDDEN="true""#));
        assert!(!include_hidden_categories(r#" includeHidden='true'"#));
        assert!(include_hidden_categories(
            r#" includeHidden="one" includeHidden="two""#
        ));
        assert!(!include_hidden_categories(r#" v7UnknownArgument="x""#));
    }

    #[test]
    fn default_category_is_visible_even_when_hidden_categories_are_not() {
        assert!(category_is_visible("_default", false));
        assert!(!category_is_visible("_admin", false));
        assert!(category_is_visible("_admin", true));
        assert!(category_is_visible("articles", false));
    }

    #[test]
    fn category_order_ignores_hyphens_like_wikidot() {
        let mut slugs = [
            "codexdfcoldfcol04",
            "codex-rating-load-20260715",
            "codexrole1518",
            "codexrateb5t153900z",
            "_default",
        ];
        slugs.sort_by_cached_key(|slug| wikidot_category_sort_key(slug));

        assert_eq!(
            slugs,
            [
                "_default",
                "codexdfcoldfcol04",
                "codexrateb5t153900z",
                "codex-rating-load-20260715",
                "codexrole1518",
            ],
        );
    }

    #[test]
    fn category_dom_matches_wikidot_and_escapes_the_slug() {
        let html = render_categories_module(
            [(17, "_default"), (23, "a<&"), (31, "_hidden")],
            false,
        );

        assert_eq!(
            html,
            concat!(
                "\n<div>\n<h3>_default</h3>\n",
                "<a id=\"category-pages-toggler-17\" href=\"javascript:;\" onclick=\"WIKIDOT.modules.WikiCategoriesModule.listeners.toggleListPages(event, 17)\">+ list pages</a>\n",
                "<div style=\"display: none\" id=\"category-pages-17\"></div>\n",
                "<div style=\"display: none\" id=\"category-pages-17-options\"></div>\n</div>\n",
                "<div>\n<h3>a&lt;&amp;</h3>\n",
                "<a id=\"category-pages-toggler-23\" href=\"javascript:;\" onclick=\"WIKIDOT.modules.WikiCategoriesModule.listeners.toggleListPages(event, 23)\">+ list pages</a>\n",
                "<div style=\"display: none\" id=\"category-pages-23\"></div>\n",
                "<div style=\"display: none\" id=\"category-pages-23-options\"></div>\n</div>\n",
            )
        );
    }

    #[test]
    fn include_hidden_categories_emit_live_options_marker() {
        let html = render_categories_module([(17, "_default"), (31, "_hidden")], true);

        assert!(html.contains("<h3>_hidden</h3>"));
        assert!(html.contains(
            r#"<div style="display: none" id="category-pages-31-options">1</div>"#,
        ));
    }

    #[test]
    fn category_page_list_matches_wikidot_shape_and_escapes_values() {
        assert_eq!(
            render_category_page_list([("alpha", "Alpha"), ("x<&", "X <&")]),
            concat!(
                "<ul>\n",
                "\t\t<li>\n\t\t\t<a href=\"/alpha\">Alpha</a>\n\t\t</li>\n",
                "\t\t<li>\n\t\t\t<a href=\"/x&lt;&amp;\">X &lt;&amp;</a>\n\t\t</li>\n",
                "</ul>\n",
            ),
        );
    }
}
