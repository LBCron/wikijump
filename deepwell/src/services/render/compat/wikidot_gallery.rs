/*
 * services/render/compat/wikidot_gallery.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};

use ftml::render::html::HtmlOutput;
use ftml::tree::{
    Gallery, GalleryArgument, GalleryEntry, GalleryEntrySource, GallerySelection,
};
use reqwest::Url;

use super::super::AuthorizedPageSelector;
use super::super::percent_encoding::percent_encode_path_segment;
use super::super::service::{RenderService, escape_list_pages_html_attr};
use super::super::wikidot_hosts::local_file_host_site_slug;
use crate::error::Result;
use crate::models::page::Model as PageModel;
use crate::models::site::Model as SiteModel;
use crate::services::{DomainService, FileService, PageService, ServiceContext};
use crate::types::Reference;

const WIKIDOT_GALLERY_MARKER: &str = "wj-gallery";
const WIKIDOT_GALLERY_SELECTION_ERROR: &str =
    r#"<div class="error-block">Error selecting page.</div>"#;
const WIKIDOT_GALLERY_EMPTY_ERROR: &str = r#"<div class="error-block">Sorry, we couldn't find any images attached to this page.</div>"#;
const MAX_GALLERY_FILES: u64 = 500;
const MAX_GALLERY_ENTRIES: usize = 500;
const MAX_GALLERY_REQUIREMENTS: usize = 32;
const MAX_CORPUS_GALLERY_REQUIREMENTS: usize = 128;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GallerySize {
    Square,
    Thumbnail,
    Small,
    Medium,
}

impl GallerySize {
    fn css_value(self) -> &'static str {
        match self {
            Self::Square => "square",
            Self::Thumbnail => "thumbnail",
            Self::Small => "small",
            Self::Medium => "medium",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum GalleryOrder {
    NameAsc,
    NameDesc,
    CreatedAtAsc,
    CreatedAtDesc,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct GalleryOptions {
    size: GallerySize,
    order: GalleryOrder,
    viewer: bool,
}

#[derive(Clone, Debug)]
struct VisibleGalleryFile {
    name: String,
    original_url: String,
    resized_url_prefix: String,
    created_at: time::OffsetDateTime,
}

#[derive(Clone, Debug)]
struct VisiblePageFiles {
    files: Vec<VisibleGalleryFile>,
}

#[derive(Clone, Debug)]
struct ResolvedGalleryImage {
    alt: String,
    original_url: String,
    image_url: String,
}

enum GalleryResolution {
    SelectionError,
    Empty,
    Images(Vec<ResolvedGalleryImage>),
}

struct VisibleFileLoader<'a, 'ctx> {
    ctx: &'a ServiceContext<'ctx>,
    site_id: i64,
    files_authority: String,
    authorized: AuthorizedPageSelector<'a, 'ctx>,
    page_ids_by_slug: HashMap<String, Option<i64>>,
    files_by_page_id: HashMap<i64, Option<VisiblePageFiles>>,
}

impl<'a, 'ctx> VisibleFileLoader<'a, 'ctx> {
    fn new(
        ctx: &'a ServiceContext<'ctx>,
        site_id: i64,
        site_slug: &str,
        viewer_user_id: Option<i64>,
    ) -> Self {
        Self {
            ctx,
            site_id,
            files_authority: DomainService::get_files_authority(ctx.config(), site_slug),
            authorized: AuthorizedPageSelector::new(ctx, viewer_user_id),
            page_ids_by_slug: HashMap::new(),
            files_by_page_id: HashMap::new(),
        }
    }

    async fn by_slug(&mut self, slug: &str) -> Result<Option<VisiblePageFiles>> {
        let page_id = match self.page_ids_by_slug.get(slug) {
            Some(page_id) => *page_id,
            None => {
                let page = PageService::get_optional(
                    self.ctx,
                    self.site_id,
                    Reference::Slug(slug.into()),
                )
                .await?;
                let page_id = page.as_ref().map(|page| page.page_id);
                self.page_ids_by_slug.insert(slug.to_owned(), page_id);
                if let Some(page) = page {
                    return self.load_page(page).await;
                }
                return Ok(None);
            }
        };
        match page_id {
            Some(page_id) => self.by_id(page_id).await,
            None => Ok(None),
        }
    }

    async fn by_id(&mut self, page_id: i64) -> Result<Option<VisiblePageFiles>> {
        if let Some(files) = self.files_by_page_id.get(&page_id) {
            return Ok(files.clone());
        }
        let Some(page) =
            PageService::get_optional(self.ctx, self.site_id, Reference::Id(page_id))
                .await?
        else {
            self.files_by_page_id.insert(page_id, None);
            return Ok(None);
        };
        self.load_page(page).await
    }

    async fn load_page(&mut self, page: PageModel) -> Result<Option<VisiblePageFiles>> {
        if let Some(files) = self.files_by_page_id.get(&page.page_id) {
            return Ok(files.clone());
        }
        if !self.authorized.check_page_viewability(&page).await? {
            self.files_by_page_id.insert(page.page_id, None);
            return Ok(None);
        }

        let Some(rows) = FileService::get_visible_rows(
            self.ctx,
            self.site_id,
            page.page_id,
            MAX_GALLERY_FILES,
        )
        .await?
        else {
            self.files_by_page_id.insert(page.page_id, None);
            return Ok(None);
        };
        let mut visible = Vec::with_capacity(rows.len());
        for row in rows {
            if !row.mime.to_ascii_lowercase().starts_with("image/") {
                continue;
            }
            visible.push(VisibleGalleryFile {
                name: row.name.clone(),
                original_url: format!(
                    "https://{}{}",
                    self.files_authority,
                    owned_file_path(&page.slug, &row.name),
                ),
                resized_url_prefix: format!(
                    "https://{}{}",
                    self.files_authority,
                    owned_resized_file_path_prefix(&page.slug, &row.name),
                ),
                created_at: row.created_at,
            });
        }
        let files = VisiblePageFiles { files: visible };
        self.files_by_page_id
            .insert(page.page_id, Some(files.clone()));
        self.page_ids_by_slug.insert(page.slug, Some(page.page_id));
        Ok(Some(files))
    }
}

impl RenderService {
    pub(in crate::services::render) async fn resolve_wikidot_gallery_requirements(
        ctx: &ServiceContext<'_>,
        html_output: &mut HtmlOutput,
        current_site_id: Option<i64>,
        current_page_id: Option<i64>,
        viewer_user_id: Option<i64>,
        current_site: Option<&SiteModel>,
        trusted_corpus_render: bool,
    ) -> Result<bool> {
        let mut requirement_ids = HashSet::new();
        let mut requirements = Vec::new();
        for requirement in &html_output.resource_requirements {
            let Some(requirement) = requirement.gallery_requirement() else {
                continue;
            };
            if !requirement_ids.insert(requirement.id().to_owned()) {
                return Ok(false);
            }
            let marker = format!(
                r#"<div class="{WIKIDOT_GALLERY_MARKER}" id="{}"></div>"#,
                requirement.id(),
            );
            if html_output.body.match_indices(&marker).count() != 1 {
                return Ok(false);
            }
            requirements.push((marker, requirement.gallery().clone()));
        }

        let context = current_site_id
            .zip(current_site)
            .filter(|(site_id, site)| *site_id == site.site_id);
        let max_requirements = if trusted_corpus_render {
            MAX_CORPUS_GALLERY_REQUIREMENTS
        } else {
            MAX_GALLERY_REQUIREMENTS
        };
        if requirements.len() > max_requirements {
            return Ok(false);
        }
        let mut loader = context.map(|(site_id, site)| {
            VisibleFileLoader::new(ctx, site_id, &site.slug, viewer_user_id)
        });
        let mut replacements = Vec::with_capacity(requirements.len());
        for (index, (marker, gallery)) in requirements.into_iter().enumerate() {
            let replacement = match (context, loader.as_mut()) {
                (Some((_, site)), Some(loader)) => {
                    render_gallery_requirement(
                        &gallery,
                        current_page_id,
                        site,
                        ctx,
                        loader,
                        index + 1,
                    )
                    .await?
                }
                _ => WIKIDOT_GALLERY_SELECTION_ERROR.to_owned(),
            };
            replacements.push((marker, replacement));
        }

        let mut resolved = html_output.body.clone();
        for (marker, replacement) in replacements {
            resolved = resolved.replacen(&marker, &replacement, 1);
        }
        let unresolved_marker_prefix =
            format!(r#"<div class="{WIKIDOT_GALLERY_MARKER}""#);
        if resolved.contains(&unresolved_marker_prefix) {
            return Ok(false);
        }
        html_output.body = resolved;
        Ok(true)
    }
}

async fn render_gallery_requirement(
    gallery: &Gallery<'_>,
    current_page_id: Option<i64>,
    site: &SiteModel,
    ctx: &ServiceContext<'_>,
    loader: &mut VisibleFileLoader<'_, '_>,
    box_id: usize,
) -> Result<String> {
    let Some(options) = gallery_options(gallery.arguments()) else {
        return Ok(WIKIDOT_GALLERY_SELECTION_ERROR.to_owned());
    };
    let resolution = match gallery.selection() {
        GallerySelection::CurrentPageFiles => {
            resolve_current_page_gallery(current_page_id, options, loader).await?
        }
        GallerySelection::Explicit(entries) => {
            resolve_explicit_gallery(
                entries,
                current_page_id,
                options.size,
                site,
                ctx,
                loader,
            )
            .await?
        }
    };
    Ok(match resolution {
        GalleryResolution::SelectionError => WIKIDOT_GALLERY_SELECTION_ERROR.to_owned(),
        GalleryResolution::Empty => WIKIDOT_GALLERY_EMPTY_ERROR.to_owned(),
        GalleryResolution::Images(images) => render_gallery_dom(&images, options, box_id),
    })
}

async fn resolve_current_page_gallery(
    current_page_id: Option<i64>,
    options: GalleryOptions,
    loader: &mut VisibleFileLoader<'_, '_>,
) -> Result<GalleryResolution> {
    let Some(page_id) = current_page_id else {
        return Ok(GalleryResolution::SelectionError);
    };
    let Some(mut page_files) = loader.by_id(page_id).await? else {
        return Ok(GalleryResolution::SelectionError);
    };
    sort_gallery_files(&mut page_files.files, options.order);
    if page_files.files.is_empty() {
        return Ok(GalleryResolution::Empty);
    }
    Ok(GalleryResolution::Images(
        page_files
            .files
            .into_iter()
            .map(|file| ResolvedGalleryImage {
                alt: String::new(),
                image_url: format!(
                    "{}{}.jpg",
                    file.resized_url_prefix,
                    options.size.css_value(),
                ),
                original_url: file.original_url,
            })
            .collect(),
    ))
}

async fn resolve_explicit_gallery(
    entries: &[GalleryEntry<'_>],
    current_page_id: Option<i64>,
    size: GallerySize,
    site: &SiteModel,
    ctx: &ServiceContext<'_>,
    loader: &mut VisibleFileLoader<'_, '_>,
) -> Result<GalleryResolution> {
    if entries.len() > MAX_GALLERY_ENTRIES {
        return Ok(GalleryResolution::SelectionError);
    }
    let mut images = Vec::new();
    for entry in entries {
        if gallery_argument(entry.arguments(), "link").is_some() {
            continue;
        }
        let file = match entry.image() {
            GalleryEntrySource::HttpUrl(source) => {
                let Some((page_slug, encoded_name)) =
                    owned_gallery_url(source, site, ctx)
                else {
                    continue;
                };
                let Some(page_files) = loader.by_slug(&page_slug).await? else {
                    continue;
                };
                page_files
                    .files
                    .into_iter()
                    .find(|file| percent_encode_path_segment(&file.name) == encoded_name)
            }
            GalleryEntrySource::File(source) => {
                let Some(page_id) = current_page_id else {
                    continue;
                };
                let name = unquote_gallery_token(source);
                let Some(page_files) = loader.by_id(page_id).await? else {
                    continue;
                };
                page_files.files.into_iter().find(|file| file.name == name)
            }
            GalleryEntrySource::Inert(_) => None,
        };
        let Some(file) = file else {
            continue;
        };
        let image_url = match entry.image() {
            GalleryEntrySource::HttpUrl(_) => file.original_url.clone(),
            GalleryEntrySource::File(_) => {
                format!("{}{}.jpg", file.resized_url_prefix, size.css_value(),)
            }
            GalleryEntrySource::Inert(_) => continue,
        };
        images.push(ResolvedGalleryImage {
            alt: gallery_argument(entry.arguments(), "alt")
                .unwrap_or_default()
                .to_owned(),
            image_url,
            original_url: file.original_url,
        });
    }
    Ok(if images.is_empty() {
        GalleryResolution::SelectionError
    } else {
        GalleryResolution::Images(images)
    })
}

fn owned_gallery_url(
    source: &str,
    site: &SiteModel,
    ctx: &ServiceContext<'_>,
) -> Option<(String, String)> {
    let source = unquote_gallery_token(source);
    let url = Url::parse(source).ok()?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || local_file_host_site_slug(url.host_str()?, ctx.config())?.as_str()
            != site.slug.as_str()
    {
        return None;
    }
    let path = url.path().strip_prefix("/local--files/")?;
    let (page_slug, encoded_name) = path.split_once('/')?;
    if page_slug.is_empty()
        || encoded_name.is_empty()
        || encoded_name.contains('/')
        || page_slug.contains('%')
        || !page_slug.chars().all(|character| {
            character.is_ascii_alphanumeric()
                || matches!(character, '-' | '_' | '.' | ':' | '~')
        })
    {
        return None;
    }
    Some((page_slug.to_owned(), encoded_name.to_owned()))
}

fn unquote_gallery_token(value: &str) -> &str {
    let bytes = value.as_bytes();
    match (bytes.first(), bytes.last()) {
        (Some(first @ (b'\'' | b'"')), Some(last))
            if first == last && value.len() >= 2 =>
        {
            &value[1..value.len() - 1]
        }
        _ => value,
    }
}

fn owned_file_path(page_slug: &str, file_name: &str) -> String {
    format!(
        "/local--files/{}/{}",
        percent_encode_path_segment(page_slug),
        percent_encode_path_segment(file_name),
    )
}

fn owned_resized_file_path_prefix(page_slug: &str, file_name: &str) -> String {
    format!(
        "/local--resized-images/{}/{}/",
        percent_encode_path_segment(page_slug),
        percent_encode_path_segment(file_name),
    )
}

fn gallery_options(arguments: &[GalleryArgument<'_>]) -> Option<GalleryOptions> {
    let size = match gallery_argument(arguments, "size") {
        None | Some("thumbnail") => GallerySize::Thumbnail,
        Some("square") => GallerySize::Square,
        Some("small") => GallerySize::Small,
        Some("medium") => GallerySize::Medium,
        Some(_) => return None,
    };
    let order = match gallery_argument(arguments, "order") {
        None | Some("name") => GalleryOrder::NameAsc,
        Some("name desc") | Some("nameDesc") | Some("name desc desc") => {
            GalleryOrder::NameDesc
        }
        Some("created_at") | Some("dateAdded") => GalleryOrder::CreatedAtAsc,
        Some("created_at desc")
        | Some("created_at desc desc")
        | Some("dateAddedDesc") => GalleryOrder::CreatedAtDesc,
        Some(_) => return None,
    };
    let viewer = match gallery_argument(arguments, "viewer") {
        None | Some("yes") | Some("true") => true,
        Some("no") | Some("false") => false,
        Some(_) => return None,
    };
    Some(GalleryOptions {
        size,
        order,
        viewer,
    })
}

fn gallery_argument<'a>(
    arguments: &'a [GalleryArgument<'_>],
    name: &str,
) -> Option<&'a str> {
    arguments
        .iter()
        .rev()
        .find(|argument| argument.name() == name)
        .map(|argument| argument.value())
}

fn sort_gallery_files(files: &mut [VisibleGalleryFile], order: GalleryOrder) {
    files.sort_by(|left, right| {
        let ordering = match order {
            GalleryOrder::NameAsc | GalleryOrder::NameDesc => left.name.cmp(&right.name),
            GalleryOrder::CreatedAtAsc | GalleryOrder::CreatedAtDesc => {
                left.created_at.cmp(&right.created_at)
            }
        };
        let ordering = ordering.then_with(|| left.name.cmp(&right.name));
        if matches!(order, GalleryOrder::NameDesc | GalleryOrder::CreatedAtDesc) {
            reverse_ordering(ordering)
        } else {
            ordering
        }
    });
}

fn reverse_ordering(ordering: Ordering) -> Ordering {
    match ordering {
        Ordering::Less => Ordering::Greater,
        Ordering::Equal => Ordering::Equal,
        Ordering::Greater => Ordering::Less,
    }
}

fn render_gallery_dom(
    images: &[ResolvedGalleryImage],
    options: GalleryOptions,
    box_id: usize,
) -> String {
    let size = options.size.css_value();
    let mut output = format!(r#"<div class="gallery-box" id="gallery-box-{box_id}">"#,);
    for image in images {
        let original_url = escape_list_pages_html_attr(&image.original_url);
        let image_url = escape_list_pages_html_attr(&image.image_url);
        let alt = escape_list_pages_html_attr(&image.alt);
        output.push_str("\n<div class=\"gallery-item ");
        output.push_str(size);
        output.push_str("\">\n<table>\n<tr>\n<td>");
        output.push_str("<a href=\"");
        output.push_str(&original_url);
        output.push_str("\" class=\"with-lb\">");
        output.push_str("<img src=\"");
        output.push_str(&image_url);
        output.push_str("\" alt=\"");
        output.push_str(&alt);
        output.push_str("\" class=\"gallery-image-size-");
        output.push_str(size);
        output.push_str("\" />");
        output.push_str("</a>");
        output.push_str("</td>\n</tr>\n</table>\n</div>");
    }
    output.push_str("\n</div>");
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gallery_requirement_limits_keep_ordinary_and_corpus_boundaries_separate() {
        assert_eq!(MAX_GALLERY_REQUIREMENTS, 32);
        assert_eq!(MAX_CORPUS_GALLERY_REQUIREMENTS, 128);
    }

    #[test]
    fn gallery_dom_matches_the_frozen_static_thumbnail_shape_without_scripts() {
        let html = render_gallery_dom(
            &[ResolvedGalleryImage {
                alt: "A <caption>".to_owned(),
                original_url: "https://site.wjfiles.test/local--files/page/image.png"
                    .to_owned(),
                image_url:
                    "https://site.wjfiles.test/local--resized-images/page/image.png/thumbnail.jpg"
                        .to_owned(),
            }],
            GalleryOptions {
                size: GallerySize::Thumbnail,
                order: GalleryOrder::NameAsc,
                viewer: true,
            },
            1,
        );

        assert_eq!(
            html,
            concat!(
                r#"<div class="gallery-box" id="gallery-box-1">"#,
                "\n<div class=\"gallery-item thumbnail\">",
                "\n<table>\n<tr>\n<td>",
                r#"<a href="https://site.wjfiles.test/local--files/page/image.png" class="with-lb">"#,
                r#"<img src="https://site.wjfiles.test/local--resized-images/page/image.png/thumbnail.jpg" alt="A &lt;caption&gt;" class="gallery-image-size-thumbnail" />"#,
                "</a></td>\n</tr>\n</table>\n</div>\n</div>",
            ),
        );
        assert!(!html.contains("<script"));
        assert!(!html.contains("data-wikijump"));

        let viewer_disabled = render_gallery_dom(
            &[ResolvedGalleryImage {
                alt: String::new(),
                original_url: "https://site.wjfiles.test/local--files/page/image.png"
                    .to_owned(),
                image_url:
                    "https://site.wjfiles.test/local--resized-images/page/image.png/thumbnail.jpg"
                        .to_owned(),
            }],
            GalleryOptions {
                size: GallerySize::Thumbnail,
                order: GalleryOrder::NameAsc,
                viewer: false,
            },
            2,
        );
        assert!(viewer_disabled.contains(
            r#"<a href="https://site.wjfiles.test/local--files/page/image.png" class="with-lb">"#
        ));
        assert!(!viewer_disabled.contains("<script"));
        assert!(!viewer_disabled.contains("data-wikijump"));
    }

    #[test]
    fn owned_file_path_encodes_each_identity_as_one_path_segment() {
        assert_eq!(
            owned_file_path("category:page", "資料 1/2.png"),
            "/local--files/category%3Apage/%E8%B3%87%E6%96%99%201%2F2.png",
        );
        assert_eq!(
            owned_resized_file_path_prefix("category:page", "資料 1/2.png"),
            "/local--resized-images/category%3Apage/%E8%B3%87%E6%96%99%201%2F2.png/",
        );
    }
}
