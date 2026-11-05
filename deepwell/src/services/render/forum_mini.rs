/*
 * services/render/forum_mini.rs
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

use regex::Regex;
use sea_orm::sea_query::ArrayType;
use sea_orm::{ConnectionTrait, FromQueryResult, Statement, Value};

use super::compat::CompatHtmlFragments;
use super::forum_visibility::ForumPageVisibility;
use super::literal_regions::LiteralRegionIndex;
use super::service::{
    RenderService, escape_list_pages_html_attr, escape_list_pages_html_text,
    format_wikidot_list_pages_date,
};
use super::wikidot_user_resources::WIKIDOT_USER_INFO_URL;
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::forum_category;
use crate::services::ServiceContext;
use crate::services::text::TextService;
use crate::utils::normalize_slug_without_category_separator;
use ftml::settings::WikitextSettings;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};

const DEFAULT_FORUM_MINI_LIMIT: usize = 5;
const MAX_FORUM_MINI_LIMIT: usize = 300;
const FORUM_MINI_CANDIDATE_LIMIT: usize = 1_001;
const MAX_FORUM_MINI_MODULES_PER_RENDER: usize = 32;
const FORUM_MINI_EXCERPT_CHARACTERS: usize = 100;
const PROCESSING_ERROR_HTML: &str =
    r#"<div class="error-block">An error occurred when processing your request.</div>"#;
const CATEGORY_NOT_FOUND_HTML: &str =
    r#"<div class="error-block">The category can not be found.</div>"#;

pub(super) static FORUM_MINI_MODULE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(concat!(
        r#"(?im)^[\t ]*\[\[module\s+(?P<name>"#,
        r#"(?:Forum)?MiniRecentThreads|"#,
        r#"(?:Forum)?MiniActiveThreads|"#,
        r#"(?:Forum)?MiniRecentPosts)\b"#,
        r#"(?P<head>[^\]]*)\]\][\t ]*$"#,
    ))
    .expect("mini forum module expression is valid")
});

static FORUM_MINI_PARAMETER_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"([a-zA-Z][a-zA-Z0-9\-_]*)="([^"]*)""#)
        .expect("Wikidot module parameter expression is valid")
});

static HTML_TAG_REGEX: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"<[^>]*>").expect("HTML tag expression is valid"));

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ForumMiniModuleKind {
    RecentThreads,
    ActiveThreads,
    RecentPosts,
}

#[derive(Debug, FromQueryResult)]
struct ForumMiniThreadCandidate {
    forum_thread_id: i64,
    title: String,
    created_at: time::OffsetDateTime,
    post_count: i64,
}

#[derive(Debug)]
struct ForumMiniThread {
    forum_thread_id: i64,
    title: String,
    created_at: time::OffsetDateTime,
    post_count: i64,
}

#[derive(Debug, FromQueryResult)]
struct ForumMiniPostCandidate {
    forum_post_id: i64,
    forum_thread_id: i64,
    thread_title: String,
    page_slug: Option<String>,
    user_id: i64,
    created_at: time::OffsetDateTime,
    title: String,
    compiled_html_hash: Vec<u8>,
    post_count: i64,
    wikidot_user_name: Option<String>,
    wikidot_user_slug: Option<String>,
    local_user_name: Option<String>,
    local_user_slug: Option<String>,
}

#[derive(Debug)]
struct ForumMiniPost {
    forum_post_id: i64,
    forum_thread_id: i64,
    thread_title: String,
    page_slug: Option<String>,
    user_id: i64,
    created_at: time::OffsetDateTime,
    title: String,
    excerpt: String,
    post_count: i64,
    user_name: String,
    user_slug: Option<String>,
    wikidot_profile: bool,
}

fn parse_module_kind(name: &str) -> ForumMiniModuleKind {
    let name = name.to_ascii_lowercase();
    if name.ends_with("minirecentthreads") {
        ForumMiniModuleKind::RecentThreads
    } else if name.ends_with("miniactivethreads") {
        ForumMiniModuleKind::ActiveThreads
    } else {
        ForumMiniModuleKind::RecentPosts
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ForumMiniLimit {
    Count(usize),
    ProcessingError,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ForumMiniCategoryArgument {
    Absent,
    CategoryId(i64),
    ProcessingError,
}

fn live_module_parameters(head: &str) -> Vec<(&str, &str)> {
    FORUM_MINI_PARAMETER_REGEX
        .captures_iter(head)
        .map(|captures| {
            let key = captures
                .get(1)
                .expect("module parameter capture has a key")
                .as_str();
            let value = captures
                .get(2)
                .expect("module parameter capture has a value")
                .as_str();
            (key, value)
        })
        .collect()
}

fn last_live_module_parameter<'a>(head: &'a str, key: &str) -> Option<&'a str> {
    live_module_parameters(head)
        .into_iter()
        .rev()
        .find(|(name, _)| *name == key)
        .map(|(_, value)| value)
}

fn php_integer(value: &str) -> Option<i128> {
    let value = value.trim();
    let (negative, digits) = match value.as_bytes().first() {
        Some(b'+') => (false, &value[1..]),
        Some(b'-') => (true, &value[1..]),
        _ => (false, value),
    };
    if digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    let magnitude = digits.parse::<i128>().ok()?;
    Some(if negative { -magnitude } else { magnitude })
}

fn php_is_numeric(value: &str) -> bool {
    let value = value.trim();
    let bytes = value.as_bytes();
    let mut index = 0usize;
    if matches!(bytes.first(), Some(b'+') | Some(b'-')) {
        index += 1;
    }
    let mantissa_start = index;
    while bytes.get(index).is_some_and(u8::is_ascii_digit) {
        index += 1;
    }
    let mut digits = index - mantissa_start;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let fraction_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        digits += index - fraction_start;
    }
    if digits == 0 {
        return false;
    }
    if matches!(bytes.get(index), Some(b'e') | Some(b'E')) {
        index += 1;
        if matches!(bytes.get(index), Some(b'+') | Some(b'-')) {
            index += 1;
        }
        let exponent_start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            index += 1;
        }
        if index == exponent_start {
            return false;
        }
    }
    index == bytes.len()
}

fn resolve_forum_mini_limit(head: &str) -> ForumMiniLimit {
    let Some(value) = last_live_module_parameter(head, "limit") else {
        return ForumMiniLimit::Count(DEFAULT_FORUM_MINI_LIMIT);
    };
    if let Some(limit) = php_integer(value) {
        return if (1..=MAX_FORUM_MINI_LIMIT as i128).contains(&limit) {
            ForumMiniLimit::Count(limit as usize)
        } else {
            ForumMiniLimit::Count(DEFAULT_FORUM_MINI_LIMIT)
        };
    }
    if php_is_numeric(value) {
        return match value.trim().parse::<f64>() {
            Ok(number) if number < 1.0 || number > MAX_FORUM_MINI_LIMIT as f64 => {
                ForumMiniLimit::Count(DEFAULT_FORUM_MINI_LIMIT)
            }
            _ => ForumMiniLimit::ProcessingError,
        };
    }
    ForumMiniLimit::Count(DEFAULT_FORUM_MINI_LIMIT)
}

fn parse_forum_mini_category(head: &str) -> ForumMiniCategoryArgument {
    let Some(value) = last_live_module_parameter(head, "categoryId") else {
        return ForumMiniCategoryArgument::Absent;
    };
    match php_integer(value) {
        Some(category_id) => ForumMiniCategoryArgument::CategoryId(
            i64::try_from(category_id).unwrap_or(i64::MAX),
        ),
        None => ForumMiniCategoryArgument::ProcessingError,
    }
}

async fn forum_category_exists(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    forum_category_id: i64,
) -> Result<bool> {
    forum_category::Entity::find_by_id(forum_category_id)
        .filter(forum_category::Column::SiteId.eq(site_id))
        .one(ctx.transaction())
        .await
        .or_raise(|| {
            Error::new(
                format!("failed to load forum category ID {forum_category_id}"),
                ErrorType::Render,
            )
        })
        .map(|category| category.is_some())
}

fn forum_thread_path(thread: &ForumMiniThread) -> String {
    format!(
        "/forum/t-{}/{}",
        thread.forum_thread_id,
        normalize_slug_without_category_separator(&thread.title),
    )
}

fn forum_mini_date(created_at: time::OffsetDateTime) -> String {
    let created_at = created_at.to_offset(time::UtcOffset::UTC);
    format!(
        r#"<span class="odate time_{} format_%25O%20ago">{}</span>"#,
        created_at.unix_timestamp(),
        format_wikidot_list_pages_date(created_at, "%d %b %Y %H:%M"),
    )
}

fn render_forum_mini_threads(threads: &[ForumMiniThread], active: bool) -> String {
    let mut output = String::from("<div class=\"forum-mini-stat\">\n");
    for thread in threads {
        output.push_str("<div class=\"item\">\n<div class=\"title\">\n<a href=\"");
        output.push_str(&escape_list_pages_html_attr(&forum_thread_path(thread)));
        output.push_str("\">");
        output.push_str(&escape_list_pages_html_text(&thread.title));
        output.push_str("</a>\n</div>\n<div class=\"info\">\n(Started ");
        output.push_str(&forum_mini_date(thread.created_at));
        output.push_str(if active { " , Posts: " } else { ", Posts: " });
        output.push_str(&thread.post_count.max(0).to_string());
        output.push_str(")\n</div>\n</div>\n");
    }
    output.push_str("</div>");
    output
}

fn render_forum_mini_user(post: &ForumMiniPost) -> String {
    let name = escape_list_pages_html_text(&post.user_name);
    let Some(slug) = post.user_slug.as_deref().filter(|_| post.wikidot_profile) else {
        return format!(r#"<span class="printuser">{name}</span>"#);
    };
    let slug = escape_list_pages_html_attr(slug);
    format!(
        concat!(
            r#"<span class="printuser"><a href="{user_info}{slug}" "#,
            r#"onclick="WIKIDOT.page.listeners.userInfo({user_id}); return false;" >{name}</a></span>"#,
        ),
        user_info = WIKIDOT_USER_INFO_URL,
        slug = slug,
        user_id = post.user_id,
        name = name,
    )
}

fn forum_post_path(post: &ForumMiniPost) -> String {
    match post.page_slug.as_deref() {
        Some(page_slug) => {
            format!("/{}/comments/show#post-{}", page_slug, post.forum_post_id,)
        }
        None => format!(
            "/forum/t-{}/{}#post-{}",
            post.forum_thread_id,
            normalize_slug_without_category_separator(&post.thread_title),
            post.forum_post_id,
        ),
    }
}

fn render_forum_mini_posts(posts: &[ForumMiniPost]) -> String {
    let mut output = String::from("<div class=\"forum-mini-stat\" >\n");
    for post in posts {
        output.push_str(
            "<div class=\"item\" style=\"padding-bottom: 5px\">\n<div class=\"title\">\n<a href=\"",
        );
        output.push_str(&escape_list_pages_html_attr(&forum_post_path(post)));
        output.push_str("\">");
        if post.title.is_empty() {
            output.push_str("(No title)");
        } else {
            output.push_str(&escape_list_pages_html_text(&post.title));
        }
        output.push_str("</a>\n</div>\n<div class=\"info\">\n");
        output.push_str(&escape_list_pages_html_text(&post.excerpt));
        output.push_str("\n<br/>\n(by ");
        output.push_str(&render_forum_mini_user(post));
        output.push(' ');
        output.push_str(&forum_mini_date(post.created_at));
        output.push_str(", posts: ");
        output.push_str(&post.post_count.max(0).to_string());
        output.push_str(")\n</div>\n</div>\n");
    }
    output.push_str("</div>");
    output
}

fn decode_html_entities(text: &str) -> String {
    fn named(entity: &str) -> Option<char> {
        match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some('\u{a0}'),
            _ => None,
        }
    }

    fn decode_entity(entity: &str) -> Option<char> {
        if let Some(named) = named(entity) {
            return Some(named);
        }
        let (radix, digits) = match entity
            .strip_prefix("#x")
            .or_else(|| entity.strip_prefix("#X"))
        {
            Some(digits) => (16, digits),
            None => (10, entity.strip_prefix('#')?),
        };
        u32::from_str_radix(digits, radix)
            .ok()
            .and_then(char::from_u32)
    }

    let mut output = String::with_capacity(text.len());
    let mut remaining = text;
    while let Some(ampersand) = remaining.find('&') {
        output.push_str(&remaining[..ampersand]);
        let entity_start = ampersand + 1;
        let entity_end = remaining[entity_start..]
            .find(';')
            .map(|offset| entity_start + offset);
        match entity_end {
            Some(entity_end) => match decode_entity(&remaining[entity_start..entity_end])
            {
                Some(character) => {
                    output.push(character);
                    remaining = &remaining[entity_end + 1..];
                }
                None => {
                    output.push('&');
                    remaining = &remaining[entity_start..];
                }
            },
            None => {
                output.push('&');
                remaining = &remaining[entity_start..];
            }
        }
    }
    output.push_str(remaining);
    output
}

fn forum_post_excerpt(compiled_html: &str) -> String {
    let stripped = HTML_TAG_REGEX.replace_all(compiled_html, "");
    let stripped = decode_html_entities(&stripped);
    let characters: Vec<char> = stripped.chars().collect();
    if characters.len() <= FORUM_MINI_EXCERPT_CHARACTERS {
        return stripped;
    }
    let prefix: String = characters[..FORUM_MINI_EXCERPT_CHARACTERS].iter().collect();
    let truncated = match prefix.rfind(' ') {
        Some(last_space) => prefix[..last_space].trim().to_owned(),
        None => String::new(),
    };
    format!("{truncated}...")
}

async fn load_forum_mini_threads(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    kind: ForumMiniModuleKind,
    limit: usize,
) -> Result<Option<Vec<ForumMiniThread>>> {
    let make_error =
        || Error::new("failed to load mini forum threads", ErrorType::Render);
    let mut visibility = ForumPageVisibility::new(ctx, ctx.request().user_id);
    if !visibility.site_is_viewable(site_id).await? {
        return Ok(None);
    }
    let Some(visible_threads) = visibility
        .visible_thread_ids(site_id, None, None, true)
        .await?
    else {
        return Ok(None);
    };
    let visibility_complete = visible_threads.complete;
    let visible_thread_ids = visible_threads.ids;
    if visible_thread_ids.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let visible_thread_ids = visible_thread_ids
        .into_iter()
        .map(Value::from)
        .collect::<Vec<_>>();
    let order = match kind {
        ForumMiniModuleKind::RecentThreads => "forum_thread_id DESC",
        ForumMiniModuleKind::ActiveThreads => concat!(
            "recent_post_count DESC, activity_at DESC, ",
            "thread_created_at DESC, forum_thread_id DESC",
        ),
        ForumMiniModuleKind::RecentPosts => {
            unreachable!("post modules use the post query")
        }
    };
    let active_filter = if kind == ForumMiniModuleKind::ActiveThreads {
        "WHERE recent_post_count > 0"
    } else {
        ""
    };
    let sql = format!(
        "WITH activity AS (\
         SELECT t.forum_thread_id, t.title, \
                t.created_at AS thread_created_at, \
                COALESCE(t.updated_at, t.created_at) AS activity_at, \
                COUNT(fp.forum_post_id) AS post_count, \
                COUNT(fp.forum_post_id) FILTER (\
                    WHERE fp.created_at >= NOW() - INTERVAL '7 days'\
                ) AS recent_post_count \
         FROM forum_thread t \
         JOIN forum_category c ON c.forum_category_id = t.forum_category_id \
                              AND c.site_id = t.site_id \
                              AND c.deleted_at IS NULL \
         JOIN forum_group g ON g.forum_group_id = t.forum_group_id \
                           AND g.site_id = t.site_id \
                           AND g.deleted_at IS NULL \
                           AND (g.visible = TRUE OR t.page_id IS NOT NULL) \
         LEFT JOIN page p ON p.page_id = t.page_id \
                         AND p.site_id = t.site_id \
                         AND p.deleted_at IS NULL \
         LEFT JOIN forum_post fp ON fp.forum_thread_id = t.forum_thread_id \
                                AND fp.site_id = t.site_id \
                                AND fp.deleted_at IS NULL \
         WHERE t.site_id = $1 \
           AND t.forum_thread_id = ANY($2::BIGINT[]) \
           AND t.deleted_at IS NULL \
           AND (t.page_id IS NULL OR p.page_id IS NOT NULL) \
         GROUP BY t.forum_thread_id, p.page_category_id\
         ) \
         SELECT forum_thread_id, title, \
                thread_created_at AS created_at, post_count \
         FROM activity {active_filter} \
         ORDER BY {order} \
         LIMIT {FORUM_MINI_CANDIDATE_LIMIT}",
    );
    let candidates =
        ForumMiniThreadCandidate::find_by_statement(Statement::from_sql_and_values(
            ctx.transaction().get_database_backend(),
            sql,
            [
                Value::from(site_id),
                Value::Array(ArrayType::BigInt, Some(Box::new(visible_thread_ids))),
            ],
        ))
        .all(ctx.transaction())
        .await
        .or_raise(make_error)?;
    let scan_exhausted = candidates.len() == FORUM_MINI_CANDIDATE_LIMIT;
    let mut threads = Vec::with_capacity(limit);
    for candidate in candidates {
        threads.push(ForumMiniThread {
            forum_thread_id: candidate.forum_thread_id,
            title: candidate.title,
            created_at: candidate.created_at,
            post_count: candidate.post_count,
        });
        if threads.len() == limit {
            return Ok(Some(threads));
        }
    }
    if scan_exhausted && visibility_complete {
        return Ok(None);
    }
    Ok(Some(threads))
}

async fn load_forum_mini_posts(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    limit: usize,
) -> Result<Option<Vec<ForumMiniPost>>> {
    let make_error = || Error::new("failed to load mini forum posts", ErrorType::Render);
    let mut visibility = ForumPageVisibility::new(ctx, ctx.request().user_id);
    if !visibility.site_is_viewable(site_id).await? {
        return Ok(None);
    }
    let Some(visible_threads) = visibility
        .visible_thread_ids(site_id, None, None, false)
        .await?
    else {
        return Ok(None);
    };
    let visibility_complete = visible_threads.complete;
    let visible_thread_ids = visible_threads.ids;
    if visible_thread_ids.is_empty() {
        return Ok(Some(Vec::new()));
    }
    let visible_thread_ids = visible_thread_ids
        .into_iter()
        .map(Value::from)
        .collect::<Vec<_>>();
    let sql = format!(
        "SELECT fp.forum_post_id, fp.forum_thread_id, t.title AS thread_title, \
                p.slug AS page_slug, fp.user_id, \
                fp.created_at, fpr.title, fpr.compiled_html_hash, \
                counts.post_count, wu.name AS wikidot_user_name, \
                wu.slug AS wikidot_user_slug, local_user.name AS local_user_name, \
                local_user.slug AS local_user_slug \
         FROM forum_post fp \
         JOIN forum_thread t ON t.forum_thread_id = fp.forum_thread_id \
                            AND t.site_id = fp.site_id \
                            AND t.deleted_at IS NULL \
         JOIN forum_category c ON c.forum_category_id = fp.forum_category_id \
                              AND c.site_id = fp.site_id \
                              AND c.deleted_at IS NULL \
         JOIN forum_group g ON g.forum_group_id = fp.forum_group_id \
                           AND g.site_id = fp.site_id \
                           AND g.deleted_at IS NULL \
                           AND (g.visible = TRUE OR t.page_id IS NOT NULL) \
         JOIN forum_post_revision fpr ON fpr.forum_post_revision_id = fp.latest_revision_id \
                                     AND fpr.site_id = fp.site_id \
         LEFT JOIN page p ON p.page_id = t.page_id \
                         AND p.site_id = t.site_id \
                         AND p.deleted_at IS NULL \
         LEFT JOIN wikidot_display_user wu ON wu.user_id = fp.user_id \
                                  AND wu.is_deleted = FALSE \
         LEFT JOIN \"user\" local_user ON local_user.user_id = fp.user_id \
                                     AND local_user.deleted_at IS NULL \
         JOIN LATERAL (\
             SELECT COUNT(fp0.forum_post_id) AS post_count \
             FROM forum_post fp0 \
             WHERE fp0.forum_thread_id = t.forum_thread_id \
               AND fp0.site_id = t.site_id \
               AND fp0.deleted_at IS NULL\
         ) counts ON TRUE \
         WHERE fp.site_id = $1 \
           AND t.forum_thread_id = ANY($2::BIGINT[]) \
           AND fp.deleted_at IS NULL \
           AND (t.page_id IS NULL OR p.page_id IS NOT NULL) \
         ORDER BY fp.forum_post_id DESC \
         LIMIT {FORUM_MINI_CANDIDATE_LIMIT}",
    );
    let candidates =
        ForumMiniPostCandidate::find_by_statement(Statement::from_sql_and_values(
            ctx.transaction().get_database_backend(),
            sql,
            [
                Value::from(site_id),
                Value::Array(ArrayType::BigInt, Some(Box::new(visible_thread_ids))),
            ],
        ))
        .all(ctx.transaction())
        .await
        .or_raise(make_error)?;
    let scan_exhausted = candidates.len() == FORUM_MINI_CANDIDATE_LIMIT;
    let mut posts = Vec::with_capacity(limit);
    for candidate in candidates {
        let compiled_html = TextService::get(ctx, &candidate.compiled_html_hash)
            .await
            .or_raise(make_error)?;
        let (user_name, user_slug, wikidot_profile) = if let Some(name) = candidate
            .wikidot_user_name
            .or_else(|| candidate.wikidot_user_slug.clone())
        {
            (name, candidate.wikidot_user_slug, true)
        } else if let Some(name) = candidate
            .local_user_name
            .or_else(|| candidate.local_user_slug.clone())
        {
            (name, candidate.local_user_slug, false)
        } else {
            (candidate.user_id.to_string(), None, false)
        };
        posts.push(ForumMiniPost {
            forum_post_id: candidate.forum_post_id,
            forum_thread_id: candidate.forum_thread_id,
            thread_title: candidate.thread_title,
            page_slug: candidate.page_slug,
            user_id: candidate.user_id,
            created_at: candidate.created_at,
            title: candidate.title,
            excerpt: forum_post_excerpt(&compiled_html),
            post_count: candidate.post_count,
            user_name,
            user_slug,
            wikidot_profile,
        });
        if posts.len() == limit {
            return Ok(Some(posts));
        }
    }
    if scan_exhausted && visibility_complete {
        return Ok(None);
    }
    Ok(Some(posts))
}

impl RenderService {
    pub(super) async fn expand_forum_mini_modules(
        ctx: &ServiceContext<'_>,
        wikitext: String,
        settings: &WikitextSettings,
        current_site_id: Option<i64>,
        compat_html: &mut CompatHtmlFragments,
    ) -> Result<String> {
        if !settings.enable_page_syntax || !FORUM_MINI_MODULE_REGEX.is_match(&wikitext) {
            return Ok(wikitext);
        }
        let Some(site_id) = current_site_id else {
            return Ok(wikitext);
        };
        let literal_regions =
            LiteralRegionIndex::new_wikidot_module_recognition(&wikitext);
        let mut output = String::with_capacity(wikitext.len());
        let mut cursor = 0;
        let mut expanded_count = 0;
        for captures in FORUM_MINI_MODULE_REGEX.captures_iter(&wikitext) {
            let matched = captures
                .get(0)
                .expect("a mini forum capture has a complete match");
            if literal_regions.contains(matched.start())
                || expanded_count == MAX_FORUM_MINI_MODULES_PER_RENDER
            {
                continue;
            }
            let name = captures
                .name("name")
                .expect("a mini forum capture has a module name")
                .as_str();
            let head = captures.name("head").map_or("", |mtch| mtch.as_str());
            let limit = match resolve_forum_mini_limit(head) {
                ForumMiniLimit::Count(limit) => limit,
                ForumMiniLimit::ProcessingError => {
                    output.push_str(&wikitext[cursor..matched.start()]);
                    output.push_str(
                        &compat_html.push_block_html(PROCESSING_ERROR_HTML.to_owned()),
                    );
                    cursor = matched.end();
                    expanded_count += 1;
                    continue;
                }
            };
            let kind = parse_module_kind(name);
            let rendered = match kind {
                ForumMiniModuleKind::RecentPosts => match parse_forum_mini_category(head)
                {
                    ForumMiniCategoryArgument::ProcessingError => {
                        Some(PROCESSING_ERROR_HTML.to_owned())
                    }
                    ForumMiniCategoryArgument::CategoryId(category_id) => {
                        if forum_category_exists(ctx, site_id, category_id).await? {
                            Some(PROCESSING_ERROR_HTML.to_owned())
                        } else {
                            Some(CATEGORY_NOT_FOUND_HTML.to_owned())
                        }
                    }
                    ForumMiniCategoryArgument::Absent => {
                        load_forum_mini_posts(ctx, site_id, limit)
                            .await?
                            .map(|posts| render_forum_mini_posts(&posts))
                    }
                },
                ForumMiniModuleKind::RecentThreads
                | ForumMiniModuleKind::ActiveThreads => {
                    load_forum_mini_threads(ctx, site_id, kind, limit)
                        .await?
                        .map(|threads| {
                            render_forum_mini_threads(
                                &threads,
                                kind == ForumMiniModuleKind::ActiveThreads,
                            )
                        })
                }
            };
            let Some(rendered) = rendered else {
                continue;
            };
            output.push_str(&wikitext[cursor..matched.start()]);
            output.push_str(&compat_html.push_block_html(rendered));
            cursor = matched.end();
            expanded_count += 1;
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
        FORUM_MINI_MODULE_REGEX, ForumMiniCategoryArgument, ForumMiniLimit,
        ForumMiniModuleKind, ForumMiniPost, forum_post_excerpt,
        parse_forum_mini_category, parse_module_kind, render_forum_mini_posts,
        resolve_forum_mini_limit,
    };

    fn captured_name(source: &str) -> &str {
        let captures = FORUM_MINI_MODULE_REGEX.captures(source).unwrap_or_else(|| {
            panic!("mini module source should be recognized: {source}")
        });
        captures.name("name").unwrap().as_str()
    }

    #[test]
    fn forum_mini_recognizes_registry_names_and_aliases() {
        for (source, kind) in [
            (
                "[[module ForumMiniRecentThreads]]",
                ForumMiniModuleKind::RecentThreads,
            ),
            (
                "[[module ForumMiniActiveThreads]]",
                ForumMiniModuleKind::ActiveThreads,
            ),
            (
                "[[module ForumMiniRecentPosts]]",
                ForumMiniModuleKind::RecentPosts,
            ),
            (
                "[[module MiniRecentThreads]]",
                ForumMiniModuleKind::RecentThreads,
            ),
            (
                "[[module MiniActiveThreads]]",
                ForumMiniModuleKind::ActiveThreads,
            ),
            (
                "[[module MiniRecentPosts]]",
                ForumMiniModuleKind::RecentPosts,
            ),
            (
                "[[module forumminirecentthreads]]",
                ForumMiniModuleKind::RecentThreads,
            ),
            (
                "  [[module ForumMiniRecentPosts limit=\"2\"]]  ",
                ForumMiniModuleKind::RecentPosts,
            ),
        ] {
            assert_eq!(parse_module_kind(captured_name(source)), kind, "{source}");
        }
        for source in [
            "[[module ForumMiniRecentPost]]",
            "[[module ForumMiniRecentThreadsX]]",
            "[[module MiniRecent]]",
        ] {
            assert!(!FORUM_MINI_MODULE_REGEX.is_match(source), "{source}");
        }
    }

    #[test]
    fn forum_mini_limit_matches_live_argument_rules() {
        for (head, expected) in [
            ("", ForumMiniLimit::Count(5)),
            (" nonsense", ForumMiniLimit::Count(5)),
            (" limit=\"2\"", ForumMiniLimit::Count(2)),
            (" limit=\"300\"", ForumMiniLimit::Count(300)),
            (" limit=\"301\"", ForumMiniLimit::Count(5)),
            (" limit=\"0\"", ForumMiniLimit::Count(5)),
            (" limit=\"-1\"", ForumMiniLimit::Count(5)),
            (" limit=\"abc\"", ForumMiniLimit::Count(5)),
            (" limit=\"\"", ForumMiniLimit::Count(5)),
            (" limit='2'", ForumMiniLimit::Count(5)),
            (" limit=2", ForumMiniLimit::Count(5)),
            (" limit = \"2\"", ForumMiniLimit::Count(5)),
            (" limit=\"2\" limit=\"1\"", ForumMiniLimit::Count(1)),
            (" limit=\"1\" limit='2'", ForumMiniLimit::Count(1)),
            (" limit=\"2.5\"", ForumMiniLimit::ProcessingError),
            (" limit=\"1e2\"", ForumMiniLimit::ProcessingError),
            (" limit=\"-1.5\"", ForumMiniLimit::Count(5)),
            (" limit=\"301.5\"", ForumMiniLimit::Count(5)),
            (" limit=\"", ForumMiniLimit::Count(5)),
            (" unknown=\"x\"", ForumMiniLimit::Count(5)),
        ] {
            assert_eq!(resolve_forum_mini_limit(head), expected, "{head:?}");
        }
    }

    #[test]
    fn forum_mini_category_argument_matches_live_argument_rules() {
        for (head, expected) in [
            ("", ForumMiniCategoryArgument::Absent),
            (" limit=\"2\"", ForumMiniCategoryArgument::Absent),
            (
                " categoryId=\"8503559\"",
                ForumMiniCategoryArgument::CategoryId(8503559),
            ),
            (
                " categoryId=\"-4\"",
                ForumMiniCategoryArgument::CategoryId(-4),
            ),
            (
                " categoryId=\"abc\"",
                ForumMiniCategoryArgument::ProcessingError,
            ),
            (" categoryId='12'", ForumMiniCategoryArgument::Absent),
            (" categoryid=\"12\"", ForumMiniCategoryArgument::Absent),
        ] {
            assert_eq!(parse_forum_mini_category(head), expected, "{head:?}");
        }
    }

    #[test]
    fn forum_mini_excerpt_matches_live_preview_truncation() {
        assert_eq!(
            forum_post_excerpt("<p>muse-probe root post</p>"),
            "muse-probe root post"
        );
        assert_eq!(
            forum_post_excerpt("<p><strong>bold</strong> muse-probe body</p>"),
            "bold muse-probe body"
        );
        assert_eq!(
            forum_post_excerpt(
                "<p>entity probe &lt;unsafe&gt; &amp; ampersand <strong>bold</strong></p>"
            ),
            "entity probe <unsafe> & ampersand bold"
        );
        assert_eq!(
            forum_post_excerpt("<p>numeric &#65;&#x42; entities</p>"),
            "numeric AB entities"
        );
        let long = concat!(
            "muse-probe-wjf root post for the mini-module excerpt probe. ",
            "This sentence exists to push the preview text past one hundred ",
            "characters so the truncation rule is observable.",
        );
        assert_eq!(
            forum_post_excerpt(&format!("<p>{long}</p>")),
            concat!(
                "muse-probe-wjf root post for the mini-module excerpt probe. ",
                "This sentence exists to push the...",
            )
        );
        let exactly = "a".repeat(100);
        assert_eq!(forum_post_excerpt(&exactly), exactly);
        assert_eq!(
            forum_post_excerpt(&format!("{} tail", "b".repeat(100))),
            "..."
        );
        assert_eq!(
            forum_post_excerpt(&format!("{} tail", "b".repeat(99))),
            format!("{}...", "b".repeat(99))
        );
    }

    fn post_with_title(title: &str) -> ForumMiniPost {
        ForumMiniPost {
            forum_post_id: 7,
            forum_thread_id: 11,
            thread_title: "muse-probe thread".to_owned(),
            page_slug: None,
            user_id: -1,
            created_at: time::OffsetDateTime::UNIX_EPOCH,
            title: title.to_owned(),
            excerpt: String::new(),
            post_count: 1,
            user_name: "tester".to_owned(),
            user_slug: None,
            wikidot_profile: false,
        }
    }

    #[test]
    fn forum_mini_recent_posts_renders_the_live_no_title_placeholder() {
        let untitled = render_forum_mini_posts(&[post_with_title("")]);
        assert!(untitled.contains(">(No title)</a>"), "{untitled}");
        let titled = render_forum_mini_posts(&[post_with_title("Re: probe")]);
        assert!(titled.contains(">Re: probe</a>"), "{titled}");
    }
}
