/*
 * services/render/file_modules.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use std::sync::LazyLock;

use ftml::data::PageInfo;
use ftml::settings::WikitextSettings;
use rand::RngExt;
use regex::Regex;

use super::AuthorizedPageSelector;
use super::compat::CompatHtmlFragments;
use super::literal_regions::LiteralRegionIndex;
use super::percent_encoding::percent_encode_path_segment;
use super::service::{escape_list_pages_html_attr, escape_list_pages_html_text};
use crate::error::Result;
use crate::models::page::Model as PageModel;
use crate::services::file::VisibleFileRow;
use crate::services::{FileService, PageService, ServiceContext};
use crate::types::Reference;

const MAX_VISIBLE_FILE_ROWS: u64 = 15;
const MIN_EVIDENCED_FILE_SIZE: i64 = 1024;

const MIN_FILES_MODULE_SUFFIX: u32 = 1_000;
const MAX_FILES_MODULE_SUFFIX: u32 = 1_000_000;

static FILES_MODULE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?is)\[\[module[ \t]+Files\b(?P<head>(?:[^\]"'\r\n]+|"[^"]*"|'[^']*')*)\]\]"#,
    )
    .expect("Files module expression is valid")
});

static FLICKR_GALLERY_MODULE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r#"(?is)\[\[module[ \t]+FlickrGallery\b(?P<head>(?:[^\]"'\r\n]+|"[^"]*"|'[^']*')*)\]\]"#,
    )
    .expect("FlickrGallery module expression is valid")
});

#[derive(Clone, Debug)]
enum FilesModuleState {
    PreviewEmpty,
    SavedEmpty {
        page_id: i64,
    },
    Rows {
        page_id: i64,
        page_slug: String,
        rows: Vec<VisibleFileRow>,
    },
    Unsupported,
}

pub(super) struct ExpandFileModulesArgs<'a, 'b, 'c> {
    pub(super) ctx: &'a ServiceContext<'b>,
    pub(super) wikitext: String,
    pub(super) page_info: &'a PageInfo<'c>,
    pub(super) settings: &'a WikitextSettings,
    pub(super) current_site_id: Option<i64>,
    pub(super) current_page_id: Option<i64>,
    pub(super) viewer_user_id: Option<i64>,
    pub(super) compat_html: &'a mut CompatHtmlFragments,
}

pub(super) async fn expand_file_modules(
    args: ExpandFileModulesArgs<'_, '_, '_>,
) -> Result<String> {
    let ExpandFileModulesArgs {
        ctx,
        wikitext,
        page_info,
        settings,
        current_site_id,
        current_page_id,
        viewer_user_id,
        compat_html,
    } = args;
    let wikitext = expand_files_modules(
        ctx,
        wikitext,
        settings,
        current_site_id,
        current_page_id,
        viewer_user_id,
        compat_html,
    )
    .await?;
    Ok(expand_flickr_gallery_preview_modules(
        wikitext,
        page_info,
        settings,
        current_site_id,
        current_page_id,
        compat_html,
    ))
}

async fn expand_files_modules(
    ctx: &ServiceContext<'_>,
    wikitext: String,
    settings: &WikitextSettings,
    current_site_id: Option<i64>,
    current_page_id: Option<i64>,
    viewer_user_id: Option<i64>,
    compat_html: &mut CompatHtmlFragments,
) -> Result<String> {
    if !settings.enable_page_syntax || !FILES_MODULE_REGEX.is_match(&wikitext) {
        return Ok(wikitext);
    }
    let Some(site_id) = current_site_id else {
        return Ok(wikitext);
    };

    let literal_regions = LiteralRegionIndex::new_wikidot_module_recognition(&wikitext);
    let mut page_state = None;
    let mut used_suffixes = Vec::new();
    let mut output = String::with_capacity(wikitext.len());
    let mut cursor = 0;
    for captures in FILES_MODULE_REGEX.captures_iter(&wikitext) {
        let matched = captures
            .get(0)
            .expect("a Files capture always has a complete match");
        if literal_regions.contains(matched.start()) {
            continue;
        }
        let head = captures.name("head").map_or("", |head| head.as_str());
        if !head.trim().is_empty() {
            continue;
        }

        if page_state.is_none() {
            let state = match current_page_id {
                None => FilesModuleState::PreviewEmpty,
                Some(page_id) => {
                    load_files_module_state(ctx, site_id, page_id, viewer_user_id).await?
                }
            };
            page_state = Some(state);
        }
        let state = page_state
            .as_ref()
            .expect("Files module state is initialized before rendering");
        if matches!(state, FilesModuleState::Unsupported) {
            continue;
        }

        output.push_str(&wikitext[cursor..matched.start()]);
        let html = match state {
            FilesModuleState::PreviewEmpty => render_empty_files_module("", ""),
            FilesModuleState::SavedEmpty { page_id } => {
                let suffix = fresh_files_module_suffix(&mut used_suffixes, *page_id);
                render_empty_files_module(&suffix.to_string(), &page_id.to_string())
            }
            FilesModuleState::Rows {
                page_id,
                page_slug,
                rows,
            } => {
                let suffix = fresh_files_module_suffix(&mut used_suffixes, *page_id);
                render_files_module(&suffix.to_string(), *page_id, page_slug, rows)
            }
            FilesModuleState::Unsupported => unreachable!("handled above"),
        };
        output.push_str(&compat_html.push_block_html(html));
        cursor = matched.end();
    }
    if cursor == 0 {
        return Ok(wikitext);
    }
    output.push_str(&wikitext[cursor..]);
    Ok(output)
}

fn fresh_files_module_suffix(used_suffixes: &mut Vec<u32>, page_id: i64) -> u32 {
    let reserved_page_id = u32::try_from(page_id).ok();
    loop {
        let suffix: u32 =
            rand::rng().random_range(MIN_FILES_MODULE_SUFFIX..MAX_FILES_MODULE_SUFFIX);
        if Some(suffix) != reserved_page_id && !used_suffixes.contains(&suffix) {
            used_suffixes.push(suffix);
            return suffix;
        }
    }
}

enum FilesModulePageAccess {
    Viewable(PageModel),
    Unavailable,
}

async fn resolve_files_module_page(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    page_id: i64,
    viewer_user_id: Option<i64>,
) -> Result<FilesModulePageAccess> {
    let Some(page) =
        PageService::get_optional(ctx, site_id, Reference::Id(page_id)).await?
    else {
        return Ok(FilesModulePageAccess::Unavailable);
    };
    let mut authorized = AuthorizedPageSelector::new(ctx, viewer_user_id);
    if !authorized.check_page_viewability(&page).await? {
        return Ok(FilesModulePageAccess::Unavailable);
    }
    Ok(FilesModulePageAccess::Viewable(page))
}

async fn load_files_module_state(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    page_id: i64,
    viewer_user_id: Option<i64>,
) -> Result<FilesModuleState> {
    let FilesModulePageAccess::Viewable(page) =
        resolve_files_module_page(ctx, site_id, page_id, viewer_user_id).await?
    else {
        return Ok(FilesModuleState::Unsupported);
    };

    let Some(rows) =
        FileService::get_visible_rows(ctx, site_id, page_id, MAX_VISIBLE_FILE_ROWS)
            .await?
    else {
        return Ok(FilesModuleState::Unsupported);
    };
    if rows.iter().any(|row| row.size < MIN_EVIDENCED_FILE_SIZE) {
        return Ok(FilesModuleState::Unsupported);
    }
    Ok(if rows.is_empty() {
        FilesModuleState::SavedEmpty { page_id }
    } else {
        FilesModuleState::Rows {
            page_id,
            page_slug: page.slug,
            rows,
        }
    })
}

fn render_empty_files_module(suffix: &str, page_id: &str) -> String {
    format!(
        concat!(
            r#"<div id="files-{suffix}">"#,
            "\n\t<p>\n\t\tNo files attached to this page.\t\t\n\t</p>",
            "\n<script type=\"text/javascript\">",
            "\n\t\tfunction updateFileSimpleList{suffix}(pageNo){{",
            "\n\t\t\tvar p = {{}};",
            "\n\t\t\t",
            "\n\t\t\tp.page_id={page_id};",
            "\n\t\t\tvar containerElId = 'files-{suffix}';",
            "\n\t\t\t",
            "\n\t\t\tp.page = pageNo;",
            "\n\t\t\tOZONE.ajax.requestModule(\"files/PageFilesSimpleModule\", p, function(r){{",
            "\n\t\t\t\tif(!WIKIDOT.utils.handleError(r)) {{return;}}",
            "\n\t\t\t\t//alert(r.body);",
            "\n\t\t\t\tjQuery('#'+containerElId).replaceWith(r.body);",
            "\n\t\t\t}});",
            "\n\t\t}}",
            "\n\t</script>",
            "\n<p style=\"text-align: center;\" class=\"manage-attachments-link\">",
            "\n\t<a href=\"javascript:;\" onclick=\"WIKIDOT.page.listeners.filesClick(null)\">Manage attachments</a>",
            "\n</p>",
            "\n</div>",
        ),
        suffix = suffix,
        page_id = page_id,
    )
}

fn render_files_module(
    suffix: &str,
    page_id: i64,
    page_slug: &str,
    rows: &[VisibleFileRow],
) -> String {
    let mut output = format!(
        concat!(
            r#"<div id="files-{suffix}">"#,
            "\n<table class=\"page-files\"><tr><th>File name</th><th>File type</th><th>Size</th><th></th></tr>",
        ),
        suffix = suffix,
    );
    let page_slug = percent_encode_path_segment(page_slug);
    for row in rows {
        let href = format!(
            "/local--files/{}/{}",
            page_slug,
            percent_encode_path_segment(&row.name),
        );
        output.push_str(&format!(
            concat!(
                r#"<tr><td><a href="{href}">{name}</a></td>"#,
                r#"<td><span title="{description}">{label}</span></td>"#,
                r#"<td>{size}</td><td><a href="javascript:;" onclick="WIKIDOT.modules.PageFilesModule.listeners.fileMoreInfo(event,{file_id})">Info</a></td></tr>"#,
            ),
            href = escape_list_pages_html_attr(&href),
            name = escape_list_pages_html_text(&row.name),
            description = escape_list_pages_html_attr(
                &row.content_type.description,
            ),
            label = escape_list_pages_html_text(&row.content_type.label),
            size = format_file_size(row.size),
            file_id = row.file_id,
        ));
    }
    output.push_str(&format!(
        concat!(
            "</table>",
            "\n<div style=\"text-align: center\">\n\n</div>",
            "\n<script type=\"text/javascript\">",
            "\n\t\tfunction updateFileSimpleList{suffix}(pageNo){{",
            "\n\t\t\tvar p = {{}};",
            "\n\t\t\t",
            "\n\t\t\tp.page_id={page_id};",
            "\n\t\t\tvar containerElId = 'files-{suffix}';",
            "\n\t\t\t",
            "\n\t\t\tp.page = pageNo;",
            "\n\t\t\tOZONE.ajax.requestModule(\"files/PageFilesSimpleModule\", p, function(r){{",
            "\n\t\t\t\tif(!WIKIDOT.utils.handleError(r)) {{return;}}",
            "\n\t\t\t\t//alert(r.body);",
            "\n\t\t\t\tjQuery('#'+containerElId).replaceWith(r.body);",
            "\n\t\t\t}});",
            "\n\t\t}}",
            "\n\t</script>",
            "\n<p style=\"text-align: center;\" class=\"manage-attachments-link\">",
            "\n\t<a href=\"javascript:;\" onclick=\"WIKIDOT.page.listeners.filesClick(null)\">Manage attachments</a>",
            "\n</p>",
            "\n</div>",
        ),
        suffix = suffix,
        page_id = page_id,
    ));
    output
}

fn format_file_size(size: i64) -> String {
    const KIB: i64 = 1024;
    const MIB: i64 = 1024 * KIB;

    debug_assert!(size >= MIN_EVIDENCED_FILE_SIZE);
    let (divisor, unit) = if size < MIB { (KIB, "kB") } else { (MIB, "MB") };
    let mut number = format!("{:.2}", size as f64 / divisor as f64);
    while number.ends_with('0') {
        number.pop();
    }
    if number.ends_with('.') {
        number.pop();
    }
    format!("{number} {unit}")
}

fn expand_flickr_gallery_preview_modules(
    wikitext: String,
    page_info: &PageInfo<'_>,
    settings: &WikitextSettings,
    current_site_id: Option<i64>,
    current_page_id: Option<i64>,
    compat_html: &mut CompatHtmlFragments,
) -> String {
    if !settings.enable_page_syntax
        || current_site_id.is_none()
        || current_page_id.is_some()
        || !FLICKR_GALLERY_MODULE_REGEX.is_match(&wikitext)
    {
        return wikitext;
    }

    let literal_regions = LiteralRegionIndex::new_wikidot_module_recognition(&wikitext);
    let mut output = String::with_capacity(wikitext.len());
    let mut cursor = 0;
    for captures in FLICKR_GALLERY_MODULE_REGEX.captures_iter(&wikitext) {
        let matched = captures
            .get(0)
            .expect("a FlickrGallery capture always has a complete match");
        if literal_regions.contains(matched.start()) {
            continue;
        }
        let head = captures.name("head").map_or("", |head| head.as_str());
        if !head.trim().is_empty() {
            continue;
        }

        output.push_str(&wikitext[cursor..matched.start()]);
        output.push_str(&compat_html.push_block_html(render_flickr_no_photos(
            matched.as_str(),
            &page_info.title,
        )));
        cursor = matched.end();
    }
    if cursor == 0 {
        return wikitext;
    }
    output.push_str(&wikitext[cursor..]);
    output
}

fn render_flickr_no_photos(source: &str, title: &str) -> String {
    format!(
        concat!(
            r#"<div class="flickr-gallery-box makeHoverTitles">"#,
            "\n<div>\nSorry, no photos.\n</div>",
            "\n<ul style=\"display: none\">",
            "\n<li class=\"flickr-gallery-parameter\">moduleName ::: edit/PagePreviewModule</li>",
            "\n<li class=\"flickr-gallery-parameter\">mode ::: page</li>",
            "\n<li class=\"flickr-gallery-parameter\">source ::: {source}</li>",
            "\n<li class=\"flickr-gallery-parameter\">title ::: {title}</li>",
            "\n</ul>",
            "\n</div>",
        ),
        source = escape_list_pages_html_text(source),
        title = escape_list_pages_html_text(title),
    )
}

#[cfg(test)]
mod tests {
    use super::super::compat::CompatHtmlFragments;
    use super::expand_flickr_gallery_preview_modules;
    use ftml::data::{PageInfo, ScoreValue};
    use ftml::layout::Layout;
    use ftml::settings::{WikitextMode, WikitextSettings};
    use std::borrow::Cow;

    fn preview_flickr(source: &str) -> String {
        let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
        let page_info = PageInfo {
            page: Cow::Borrowed("flickr-fixture"),
            category: None,
            site: Cow::Borrowed("flickr-fixture"),
            title: Cow::Borrowed("Flickr fixture"),
            alt_title: None,
            score: ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let mut compat_html = CompatHtmlFragments::new(source);
        let expanded = expand_flickr_gallery_preview_modules(
            source.to_owned(),
            &page_info,
            &settings,
            Some(1),
            None,
            &mut compat_html,
        );
        compat_html.restore(&expanded)
    }

    #[test]
    fn flickr_gallery_with_arguments_stays_literal_without_provider_fetch() {
        for source in [
            "[[module FlickrGallery tags=\"linux,sun\" tagMode=\"all\"]]",
            "[[module FlickrGallery userName=\"fixture\" perPage=\"5\"]]",
        ] {
            let rendered = preview_flickr(source);
            assert_eq!(rendered, source, "{source}");
            assert!(!rendered.contains("flickr-gallery-box"), "{source}");
            assert!(!rendered.contains("No such module"), "{source}");
        }

        let bare = preview_flickr("[[module FlickrGallery]]");
        assert!(bare.contains("Sorry, no photos."), "{bare}");
    }

    #[test]
    fn flickr_gallery_documented_limits_stay_literal_without_provider_fetch() {
        for source in [
            "[[module FlickrGallery perPage=\"0\"]]",
            "[[module FlickrGallery perPage=\"101\"]]",
            "[[module FlickrGallery perPage=\"abc\"]]",
            "[[module FlickrGallery tagMode=\"bogus\"]]",
            "[[module FlickrGallery sort=\"bogus\"]]",
            "[[module FlickrGallery size=\"bogus\"]]",
            "[[module FlickrGallery contentType=\"bogus\"]]",
            "[[module FlickrGallery limitPages=\"0\"]]",
            "[[module FlickrGallery foo=\"bar\"]]",
        ] {
            let rendered = preview_flickr(source);
            assert_eq!(rendered, source, "{source}");
            assert!(!rendered.contains("flickr-gallery-box"), "{source}");
            assert!(!rendered.contains("No such module"), "{source}");
        }

        let bare = preview_flickr("[[module FlickrGallery]]");
        assert!(bare.contains("Sorry, no photos."), "{bare}");
    }
}
