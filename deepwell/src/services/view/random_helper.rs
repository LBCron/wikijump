/*
 * services/view/random_helper.rs
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

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;

use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::services::page_query::{
    AuthorSelector, CategoriesSelector, DateSelector, FoundPageFields,
    IncludedCategories, OrderBySelector, OrderProperty, PageParentSelector, PageQuery,
    PageTypeSelector, PaginationSelector, TagCondition,
};
use crate::services::render::{ViewablePageRef, view_decisions_for_scanned_pages};
use crate::services::{PageQueryService, ServiceContext};
use wikidot_normalize::normalize;

const RANDOM_HELPER_SCAN_ROWS: u64 = 50_000;

static REDIRECT_HELPER_BODY_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^\s*\[\[include\s+:snippets:redirect\s+url=%%link%%\]\]\s*$")
        .expect("random helper body expression should compile")
});

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct RandomHelperSelector {
    category_all: bool,
    categories: Vec<String>,
    excluded_categories: Vec<String>,
    any_tags: Vec<String>,
    all_tags: Vec<String>,
    none_tags: Vec<String>,
}

pub(super) fn find_random_helper_selector(
    source: &str,
    current_category: &str,
) -> Option<RandomHelperSelector> {
    use crate::services::render::LiteralRegionIndex;

    let literal_regions = LiteralRegionIndex::new_wikidot_module_recognition(source);
    let mut helper = None;
    let mut cursor = 0;
    while let Some(modu) = find_list_pages_module(source, &literal_regions, cursor) {
        cursor = modu.end;
        let Some(selector) =
            parse_random_helper_module(modu.head, modu.body, current_category)
        else {
            continue;
        };
        if helper.replace(selector).is_some() {
            return None;
        }
    }
    helper
}

pub(super) async fn resolve_random_helper_redirect(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    viewer_user_id: Option<i64>,
    current_page_id: i64,
    current_slug: &str,
    selector: &RandomHelperSelector,
) -> Result<Option<String>> {
    let make_error = || {
        Error::new(
            "failed to resolve random helper redirect target",
            ErrorType::GetView(crate::services::view::ViewType::Page),
        )
    };

    let included: Vec<Cow<'_, str>> = selector
        .categories
        .iter()
        .map(|category| Cow::Borrowed(category.as_str()))
        .collect();
    let excluded: Vec<Cow<'_, str>> = selector
        .excluded_categories
        .iter()
        .map(|category| Cow::Borrowed(category.as_str()))
        .collect();
    let any: Vec<Cow<'_, str>> = selector
        .any_tags
        .iter()
        .map(|tag| Cow::Borrowed(tag.as_str()))
        .collect();
    let all: Vec<Cow<'_, str>> = selector
        .all_tags
        .iter()
        .map(|tag| Cow::Borrowed(tag.as_str()))
        .collect();
    let none: Vec<Cow<'_, str>> = selector
        .none_tags
        .iter()
        .map(|tag| Cow::Borrowed(tag.as_str()))
        .collect();
    let empty_references: &[crate::types::Reference<'_>] = &[];
    let empty_cow: &[Cow<'_, str>] = &[];
    let empty_scores: &[crate::services::page_query::ScoreSelector] = &[];
    let empty_data_forms: &[crate::services::page_query::DataFormSelector<'_>] = &[];

    let query = PageQuery {
        current_page_id,
        current_site_id: site_id,
        queried_site_id: None,
        page_type: PageTypeSelector::Normal,
        categories: CategoriesSelector {
            included_categories: if selector.category_all {
                IncludedCategories::All
            } else {
                IncludedCategories::List(&included)
            },
            excluded_categories: &excluded,
        },
        tags: TagCondition {
            any_present: &any,
            all_present: &all,
            none_present: &none,
            untagged: false,
        },
        page_parent: PageParentSelector::All,
        contains_outgoing_links: empty_references,
        creation_date: DateSelector::FromPresent {
            start: time::OffsetDateTime::UNIX_EPOCH,
        },
        update_date: DateSelector::FromPresent {
            start: time::OffsetDateTime::UNIX_EPOCH,
        },
        author: AuthorSelector::All,
        score: empty_scores,
        votes: empty_scores,
        offset: 0,
        name: None,
        slug: None,
        slugs: empty_cow,
        data_form_fields: empty_data_forms,
        order: Some(OrderBySelector {
            property: OrderProperty::Random,
            ascending: true,
        }),
        candidate_limit: None,
        pagination: PaginationSelector {
            limit: Some(RANDOM_HELPER_SCAN_ROWS),
            ..PaginationSelector::default()
        },
        fields: FoundPageFields {
            slug: true,
            page_category_id: true,
            ..FoundPageFields::default()
        },
    };

    let found = PageQueryService::find_with_metadata(ctx, query)
        .await
        .or_raise(make_error)?;
    if found.metadata.cap_exceeded || found.metadata.unsupported_reason.is_some() {
        return Ok(None);
    }

    let refs = found
        .pages
        .pages
        .iter()
        .map(|page| ViewablePageRef {
            page_id: page.page_id,
            site_id: page.site_id,
            page_category_id: page.page_category_id,
        })
        .collect::<Vec<_>>();
    let mut permission_cache = BTreeMap::new();
    let viewable = view_decisions_for_scanned_pages(
        ctx,
        viewer_user_id,
        &refs,
        &mut permission_cache,
    )
    .await
    .or_raise(make_error)?;

    for (page, can_view) in found.pages.pages.iter().zip(viewable) {
        if !can_view {
            continue;
        }
        let Some(slug) = page.slug.as_deref() else {
            continue;
        };
        if random_helper_slugs_equal(slug, current_slug) {
            continue;
        }
        return Ok(Some(slug.to_owned()));
    }
    Ok(None)
}

fn random_helper_slugs_equal(first: &str, second: &str) -> bool {
    let mut first = first.to_owned();
    normalize(&mut first);
    let mut second = second.to_owned();
    normalize(&mut second);
    first == second
}

struct HelperModule<'a> {
    head: &'a str,
    body: &'a str,
    end: usize,
}

fn find_list_pages_module<'a>(
    source: &'a str,
    literal_regions: &crate::services::render::LiteralRegionIndex,
    from: usize,
) -> Option<HelperModule<'a>> {
    let bytes = source.as_bytes();
    let mut search = from;
    while search + 2 <= bytes.len() {
        let relative = bytes[search..].windows(2).position(|pair| pair == b"[[")?;
        let start = search + relative;
        search = start + 2;
        if literal_regions.contains(start) {
            continue;
        }
        let mut cursor = start + 2;
        while bytes
            .get(cursor)
            .is_some_and(|byte| *byte == b' ' || *byte == b'\t')
        {
            cursor += 1;
        }
        let name_start = cursor;
        while bytes.get(cursor).is_some_and(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
        }) {
            cursor += 1;
        }
        let mut name = &source[name_start..cursor];
        name = name.strip_suffix('_').unwrap_or(name);
        if !name.eq_ignore_ascii_case("module") {
            continue;
        }
        if !bytes
            .get(cursor)
            .is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\n' | b'\r'))
        {
            continue;
        }
        while bytes
            .get(cursor)
            .is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\n' | b'\r'))
        {
            cursor += 1;
        }
        let subname_start = cursor;
        while bytes.get(cursor).is_some_and(|byte| {
            !matches!(byte, b' ' | b'\t' | b'\n' | b'\r') && *byte != b']'
        }) {
            cursor += 1;
        }
        if !source[subname_start..cursor].eq_ignore_ascii_case("listpages") {
            continue;
        }
        let Some(head_end) = scan_module_head_end(source, cursor) else {
            continue;
        };
        let head = &source[cursor..head_end];
        let after_head = head_end + 2;
        let Some(close) = find_module_close(source, after_head) else {
            continue;
        };
        return Some(HelperModule {
            head,
            body: &source[after_head..close],
            end: close + "[[/module]]".len(),
        });
    }
    None
}

fn scan_module_head_end(source: &str, from: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut cursor = from;
    while cursor < bytes.len() {
        if source[cursor..].starts_with("[!--") {
            return None;
        }
        match bytes[cursor] {
            b'"' => {
                cursor = scan_double_quoted_value(source, cursor, true)?;
            }
            b'\'' => {
                let rest = &source[cursor + 1..];
                let end = rest.find('\'')?;
                cursor = cursor + 1 + end + 1;
            }
            b']' if source[cursor..].starts_with("]]") => return Some(cursor),
            _ => {
                cursor += source[cursor..]
                    .chars()
                    .next()
                    .expect("head scan stays on a character boundary")
                    .len_utf8();
            }
        }
    }
    None
}

fn scan_double_quoted_value(
    source: &str,
    quote_start: usize,
    head_terminator: bool,
) -> Option<usize> {
    let mut cursor = quote_start + 1;
    while cursor < source.len() {
        let character = source[cursor..]
            .chars()
            .next()
            .expect("quote scan stays on a character boundary");
        let next = cursor + character.len_utf8();
        if character == '"'
            && (argument_boundary_at(source, next)
                || source[next..].starts_with('@')
                || source[next..].starts_with("[!--")
                || (head_terminator && source[next..].starts_with("]]")))
        {
            return Some(next);
        }
        cursor = next;
    }
    None
}

fn argument_boundary_at(source: &str, mut cursor: usize) -> bool {
    if cursor >= source.len() {
        return true;
    }
    let first = source[cursor..]
        .chars()
        .next()
        .expect("boundary scan stays on a character boundary");
    if first.is_whitespace() {
        while cursor < source.len() {
            let character = source[cursor..]
                .chars()
                .next()
                .expect("boundary scan stays on a character boundary");
            if !character.is_whitespace() {
                break;
            }
            cursor += character.len_utf8();
        }
        return true;
    }
    argument_key_assignment_at(source, cursor)
}

fn argument_key_assignment_at(source: &str, mut cursor: usize) -> bool {
    let bytes = source.as_bytes();
    let key_start = cursor;
    while bytes
        .get(cursor)
        .is_some_and(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        cursor += 1;
    }
    if cursor == key_start {
        return false;
    }
    let first = bytes[key_start];
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return false;
    }
    while cursor < source.len() {
        let character = source[cursor..]
            .chars()
            .next()
            .expect("key scan stays on a character boundary");
        if !character.is_whitespace() {
            break;
        }
        cursor += character.len_utf8();
    }
    if bytes.get(cursor) == Some(&b'!') {
        cursor += 1;
    }
    bytes.get(cursor) == Some(&b'=')
}

fn find_module_close(source: &str, from: usize) -> Option<usize> {
    let lower = source[from..].to_ascii_lowercase();
    lower.find("[[/module]]").map(|relative| from + relative)
}

fn parse_random_helper_module(
    head: &str,
    body: &str,
    current_category: &str,
) -> Option<RandomHelperSelector> {
    if !REDIRECT_HELPER_BODY_REGEX.is_match(body) {
        return None;
    }
    let arguments = tokenize_list_pages_head(head)?;
    evaluate_helper_arguments(&arguments, current_category)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArgumentValueKind {
    DoubleQuoted,
    SingleQuoted,
    Bare,
}

#[derive(Debug, Clone, Copy)]
struct HeadArgument<'a> {
    key: &'a str,
    op: &'a str,
    value: &'a str,
    kind: ArgumentValueKind,
}

fn tokenize_list_pages_head(head: &str) -> Option<Vec<HeadArgument<'_>>> {
    let bytes = head.as_bytes();
    let mut arguments = Vec::new();
    let mut cursor = 0;
    while cursor < head.len() {
        while cursor < head.len()
            && head[cursor..]
                .chars()
                .next()
                .expect("head tokenizer stays on a character boundary")
                .is_whitespace()
        {
            cursor += head[cursor..]
                .chars()
                .next()
                .expect("head tokenizer stays on a character boundary")
                .len_utf8();
        }
        if cursor >= head.len() {
            break;
        }
        if head[cursor..].starts_with("[!--") {
            return None;
        }
        let key_start = cursor;
        while bytes.get(cursor).is_some_and(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
        }) {
            cursor += 1;
        }
        if cursor == key_start {
            cursor += head[cursor..]
                .chars()
                .next()
                .expect("head tokenizer stays on a character boundary")
                .len_utf8();
            continue;
        }
        if !bytes[key_start].is_ascii_alphabetic() && bytes[key_start] != b'_' {
            continue;
        }
        let key = &head[key_start..cursor];
        while cursor < head.len()
            && head[cursor..]
                .chars()
                .next()
                .expect("head tokenizer stays on a character boundary")
                .is_whitespace()
        {
            cursor += head[cursor..]
                .chars()
                .next()
                .expect("head tokenizer stays on a character boundary")
                .len_utf8();
        }
        let op_start = cursor;
        if matches!(bytes.get(cursor), Some(b'!' | b'<' | b'>')) {
            cursor += 1;
            if matches!(
                (bytes.get(op_start), bytes.get(cursor)),
                (Some(b'<'), Some(b'>')) | (_, Some(b'='))
            ) {
                cursor += 1;
            }
        } else if bytes.get(cursor) == Some(&b'=') {
            cursor += 1;
        } else {
            continue;
        }
        let op = &head[op_start..cursor];
        while cursor < head.len()
            && head[cursor..]
                .chars()
                .next()
                .expect("head tokenizer stays on a character boundary")
                .is_whitespace()
        {
            cursor += head[cursor..]
                .chars()
                .next()
                .expect("head tokenizer stays on a character boundary")
                .len_utf8();
        }
        if cursor >= head.len() {
            continue;
        }
        let value_start = cursor;
        let first = head[value_start..]
            .chars()
            .next()
            .expect("head tokenizer stays on a character boundary");
        if first != '"' && first != '\'' && argument_key_assignment_at(head, value_start)
        {
            continue;
        }
        let (kind, value);
        if first == '"' {
            match scan_double_quoted_value(head, value_start, false) {
                Some(next) => {
                    kind = ArgumentValueKind::DoubleQuoted;
                    value = &head[value_start + 1..next - 1];
                    cursor = next;
                }
                None => {
                    kind = ArgumentValueKind::DoubleQuoted;
                    cursor = bare_argument_end(head, value_start);
                    value = &head[value_start..cursor];
                }
            }
        } else if first == '\'' {
            match head[value_start + 1..].find('\'') {
                Some(end) => {
                    kind = ArgumentValueKind::SingleQuoted;
                    value = &head[value_start + 1..value_start + 1 + end];
                    cursor = value_start + 1 + end + 1;
                }
                None => {
                    kind = ArgumentValueKind::SingleQuoted;
                    cursor = bare_argument_end(head, value_start);
                    value = &head[value_start..cursor];
                }
            }
        } else {
            kind = ArgumentValueKind::Bare;
            cursor = bare_argument_end(head, value_start);
            if cursor == value_start {
                continue;
            }
            value = &head[value_start..cursor];
        }
        arguments.push(HeadArgument {
            key,
            op,
            value,
            kind,
        });
    }
    Some(arguments)
}

fn bare_argument_end(head: &str, mut cursor: usize) -> usize {
    while cursor < head.len() {
        let character = head[cursor..]
            .chars()
            .next()
            .expect("bare scan stays on a character boundary");
        if character.is_whitespace() || character == ']' {
            break;
        }
        cursor += character.len_utf8();
    }
    cursor
}

const EXACT_SPELLINGS: &[(&str, &str)] = &[
    ("category", "category"),
    ("categories", "categories"),
    ("tags", "tags"),
    ("tag", "tag"),
    ("name", "name"),
    ("fullname", "fullname"),
    ("limit", "limit"),
    ("offset", "offset"),
    ("perpage", "perPage"),
    ("separate", "separate"),
    ("wrapper", "wrapper"),
    ("reverse", "reverse"),
    ("range", "range"),
    ("created_by", "created_by"),
    ("createdby", "createdBy"),
    ("rss", "rss"),
    ("rsstitle", "rssTitle"),
    ("rssdescription", "rssDescription"),
    ("rsshome", "rssHome"),
    ("rsslimit", "rssLimit"),
    ("rssonly", "rssOnly"),
    ("prependline", "prependLine"),
    ("appendline", "appendLine"),
];

const DENY_KEYS: &[&str] = &[
    "pagetype",
    "parent",
    "name",
    "fullname",
    "range",
    "link_to",
    "linkto",
    "created_by",
    "createdby",
    "rating",
    "votes",
    "created_at",
    "createdat",
    "date",
    "updated_at",
    "updatedat",
];

const INERT_KEYS: &[&str] = &[
    "separate",
    "wrapper",
    "prependline",
    "prepend_line",
    "appendline",
    "perpage",
    "per_page",
    "tagtarget",
    "tag_target",
    "urlattrprefix",
    "rssdescription",
    "rsshome",
    "rsslimit",
    "form",
    "score",
];

const COMPARISON_KEYS: &[&str] = &["rating", "votes", "created_at", "date", "updated_at"];

fn evaluate_helper_arguments(
    arguments: &[HeadArgument<'_>],
    current_category: &str,
) -> Option<RandomHelperSelector> {
    let mut category_all = true;
    let mut category_present = false;
    let mut saw_category = false;
    let mut include_current_category = false;
    let mut categories: Vec<String> = Vec::new();
    let mut excluded_categories: Vec<String> = Vec::new();

    let mut any_tags: Vec<String> = Vec::new();
    let mut all_tags: Vec<String> = Vec::new();
    let mut none_tags: Vec<String> = Vec::new();
    let mut saw_tag = false;

    let mut order_values: Vec<&str> = Vec::new();
    let mut limit_values: Vec<&str> = Vec::new();
    let mut reverse_values: Vec<&str> = Vec::new();
    let mut skip_current_values: Vec<&str> = Vec::new();

    let mut rss_only = false;
    let mut rss_title: Option<&str> = None;
    let mut saw_rss = false;

    for argument in arguments {
        if argument.kind == ArgumentValueKind::Bare
            && argument.value.starts_with("&quot;")
            && argument.value.ends_with("&quot;")
        {
            continue;
        }
        let raw_value = argument.value;
        let value = raw_value.trim();
        let lower = argument.key.to_ascii_lowercase();
        let exact_spelling = EXACT_SPELLINGS
            .iter()
            .find(|(family, _)| *family == lower.as_str())
            .map(|(_, spelling)| *spelling);
        if let Some(spelling) = exact_spelling {
            let exact = argument.key == spelling
                && argument.op == "="
                && argument.kind == ArgumentValueKind::DoubleQuoted;
            if !exact {
                continue;
            }
        }

        match lower.as_str() {
            "category" | "categories" => {
                if lower == "categories" && saw_category {
                    continue;
                }
                if lower == "category" {
                    saw_category = true;
                }
                category_all = true;
                category_present = false;
                include_current_category = false;
                categories.clear();
                excluded_categories.clear();
                let selector = match static_selector_value(value) {
                    StaticSelector::Absent => continue,
                    StaticSelector::Present(selector) => selector,
                };
                if split_category_values(selector).is_empty() {
                    continue;
                }
                category_present = true;
                let mut saw_included = false;
                for category in split_category_values(selector) {
                    if category == "*" {
                        category_all = true;
                    } else if category == "." {
                        include_current_category = true;
                        saw_included = true;
                    } else if let Some(category) = category.strip_prefix('+') {
                        categories.push(category.to_lowercase());
                        saw_included = true;
                    } else if let Some(category) = category.strip_prefix('-') {
                        excluded_categories.push(category.to_lowercase());
                    } else {
                        categories.push(category.to_lowercase());
                        saw_included = true;
                    }
                }
                if saw_included {
                    category_all = false;
                }
            }
            "tags" => {
                if saw_tag {
                    continue;
                }
                any_tags.clear();
                all_tags.clear();
                none_tags.clear();
                let selector = match tags_selector_value(value) {
                    TagsSelectorValue::Absent => continue,
                    TagsSelectorValue::Present(selector) => selector,
                    TagsSelectorValue::Empty => return None,
                };
                if !collect_tag_selector(
                    selector,
                    &mut any_tags,
                    &mut all_tags,
                    &mut none_tags,
                ) {
                    return None;
                }
            }
            "tag" => {
                if value.is_empty() {
                    continue;
                }
                saw_tag = true;
                any_tags.clear();
                all_tags.clear();
                none_tags.clear();
                let selector = match static_selector_value(value) {
                    StaticSelector::Absent => continue,
                    StaticSelector::Present(selector) => selector,
                };
                if !collect_tag_selector(
                    selector,
                    &mut any_tags,
                    &mut all_tags,
                    &mut none_tags,
                ) {
                    return None;
                }
            }
            "order"
                if argument.key == "order"
                    && argument.op == "="
                    && argument.kind == ArgumentValueKind::DoubleQuoted =>
            {
                order_values.push(value);
            }
            "order" => {}
            "limit" => {
                limit_values.push(value);
            }
            "offset" if parse_numeric_argument(value).unwrap_or(0) != 0 => {
                return None;
            }
            "offset" => {}
            "reverse" => {
                reverse_values.push(value);
            }
            "skipcurrent" | "skip_current"
                if argument.key == "skipCurrent"
                    && argument.op == "="
                    && argument.kind == ArgumentValueKind::DoubleQuoted =>
            {
                skip_current_values.push(value);
            }
            "skipcurrent" | "skip_current" => {}
            "rssonly"
                if matches!(value.to_ascii_lowercase().as_str(), "yes" | "true") =>
            {
                rss_only = true;
            }
            "rssonly" => {}
            "rss" if !raw_value.is_empty() => {
                saw_rss = true;
                rss_title = Some(raw_value);
            }
            "rss" => {}
            "rsstitle" if !saw_rss => {
                rss_title = Some(raw_value);
            }
            "rsstitle" => {}
            _ if DENY_KEYS.contains(&lower.as_str()) => return None,
            _ if INERT_KEYS.contains(&lower.as_str()) => {}
            _ if argument.key.starts_with('_')
                && argument.kind == ArgumentValueKind::DoubleQuoted
                && matches!(argument.op, "=" | "!=") =>
            {
                return None;
            }
            _ if argument.key.starts_with('_') => {}
            _ if COMPARISON_KEYS.contains(&argument.key) => return None,
            _ => {}
        }

        if argument.kind == ArgumentValueKind::DoubleQuoted
            && COMPARISON_KEYS.contains(&argument.key)
        {
            return None;
        }
    }
    if rss_only && rss_title.is_some_and(|title| !title.is_empty()) {
        return None;
    }
    for value in skip_current_values {
        let effective = url_fallback_value(value).unwrap_or(value);
        if matches!(
            effective.trim().to_ascii_lowercase().as_str(),
            "yes" | "true"
        ) {
            return None;
        }
    }
    for value in reverse_values {
        let effective = url_fallback_value(value).unwrap_or(value);
        if matches!(
            effective.trim().to_ascii_lowercase().as_str(),
            "yes" | "true"
        ) {
            return None;
        }
    }

    let last_order = order_values.last()?;
    if !is_random_order(url_fallback_value(last_order).unwrap_or(last_order)) {
        return None;
    }
    let mut limit = None;
    for value in limit_values {
        if let Some(parsed) = parse_numeric_argument(value) {
            limit = Some(parsed);
        }
    }
    if limit != Some(1) {
        return None;
    }

    let (category_all, mut categories) = if category_present {
        (category_all, categories)
    } else {
        (false, Vec::new())
    };
    let include_current_category = include_current_category || !category_present;
    if !category_all && include_current_category {
        let current = current_category.to_owned();
        if !categories.contains(&current) {
            categories.push(current);
        }
    }
    Some(RandomHelperSelector {
        category_all,
        categories,
        excluded_categories,
        any_tags,
        all_tags,
        none_tags,
    })
}

fn collect_tag_selector(
    value: &str,
    any_tags: &mut Vec<String>,
    all_tags: &mut Vec<String>,
    none_tags: &mut Vec<String>,
) -> bool {
    let tags = split_tag_values(value);
    let select_untagged = tags.len() == 1 && tags.first().is_some_and(|tag| tag == "-");
    for tag in tags {
        if tag == "-" {
            if select_untagged {
                return false;
            }
            continue;
        }
        if tag == "=" || tag == "==" {
            return false;
        }
        if let Some(excluded) = tag.strip_prefix('-') {
            none_tags.push(excluded.to_owned());
        } else if let Some(required) = tag.strip_prefix('+') {
            all_tags.push(required.to_owned());
        } else {
            any_tags.push(tag);
        }
    }
    true
}

fn is_random_order(value: &str) -> bool {
    let parts: Vec<&str> = value.split_whitespace().collect();
    let property = match parts.as_slice() {
        [] => return false,
        [value] => match value.strip_prefix('-') {
            Some(rest) => rest,
            None => strip_order_direction_suffix(value)
                .map(|(property, _)| property)
                .unwrap_or(value),
        },
        [value, direction]
            if direction.eq_ignore_ascii_case("asc")
                || direction.eq_ignore_ascii_case("desc") =>
        {
            *value
        }
        [value, first, second]
            if first.eq_ignore_ascii_case("desc")
                && second.eq_ignore_ascii_case("desc") =>
        {
            *value
        }
        _ => return false,
    };
    property.eq_ignore_ascii_case("random")
}

fn strip_order_direction_suffix(value: &str) -> Option<(&str, bool)> {
    let lower = value.to_ascii_lowercase();
    for (suffix, ascending) in [
        ("ascending", true),
        ("descending", false),
        ("asc", true),
        ("desc", false),
    ] {
        if lower.ends_with(suffix) && value.len() > suffix.len() {
            return Some((&value[..value.len() - suffix.len()], ascending));
        }
    }
    None
}

fn parse_numeric_argument(value: &str) -> Option<u64> {
    let value = url_fallback_value(value).unwrap_or(value);
    (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
}

fn url_token_present(value: &str) -> bool {
    let selector = value
        .split_once('|')
        .map(|(selector, _)| selector)
        .unwrap_or(value);
    selector
        .as_bytes()
        .windows(4)
        .enumerate()
        .any(|(start, token)| {
            if !token.eq_ignore_ascii_case(b"@url") {
                return false;
            }
            let delimited = |index: usize| {
                selector.as_bytes().get(index).is_none_or(|byte| {
                    byte.is_ascii_whitespace() || matches!(byte, b',' | b';')
                })
            };
            (start == 0 || delimited(start - 1)) && delimited(start + token.len())
        })
}

fn url_fallback_value(value: &str) -> Option<&str> {
    value
        .split_once('|')
        .and_then(|(selector, fallback)| url_token_present(selector).then_some(fallback))
}

enum StaticSelector<'a> {
    Absent,
    Present(&'a str),
}

fn static_selector_value(value: &str) -> StaticSelector<'_> {
    match url_fallback_value(value) {
        Some(fallback) => StaticSelector::Present(fallback),
        None if url_token_present(value) => StaticSelector::Absent,
        None => StaticSelector::Present(value),
    }
}

enum TagsSelectorValue<'a> {
    Absent,
    Present(&'a str),
    Empty,
}

fn tags_selector_value(value: &str) -> TagsSelectorValue<'_> {
    match url_fallback_value(value) {
        Some(fallback) if fallback.trim().is_empty() => TagsSelectorValue::Empty,
        Some(fallback) => TagsSelectorValue::Present(fallback),
        None if url_token_present(value) => {
            if split_tag_values(value).len() > 1 {
                TagsSelectorValue::Present(value)
            } else {
                TagsSelectorValue::Absent
            }
        }
        None => TagsSelectorValue::Present(value),
    }
}

fn split_category_values(value: &str) -> Vec<String> {
    value
        .split(|character: char| character.is_whitespace() || character == ',')
        .filter(|part| !part.is_empty())
        .map(str::to_owned)
        .collect()
}

fn split_tag_values(value: &str) -> Vec<String> {
    value
        .split(|character: char| {
            character.is_whitespace() || matches!(character, ',' | ';')
        })
        .filter(|part| !part.is_empty())
        .map(|part| {
            part.strip_prefix('"')
                .and_then(|part| part.strip_suffix('"'))
                .unwrap_or(part)
                .to_lowercase()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const RANDOM_SCP: &str = concat!(
        "[[module ListPages category=\"_default\" order=\"random\" limit=\"1\" tag=\"scp\"]]\n",
        "Random SCP: %%title_linked%%\n",
        "[[/module]]\n",
        "\n",
        "[[module ListPages category=\"_default\" order=\"random\" limit=\"1\" tag=\"scp\"]]\n",
        "[[include :snippets:redirect url=%%link%%]]\n",
        "[[/module]]\n",
    );

    const RANDOM_PAGE: &str = concat!(
        "[[module ListPages category=\"* -unlisted\" order=\"random\" limit=\"1\"]]\n",
        "Random Page: %%title_linked%%\n",
        "[[/module]]\n",
        "\n",
        "[[module ListPages category=\"* -unlisted\" order=\"random\" limit=\"1\"]]\n",
        "[[include :snippets:redirect url=%%link%%]]\n",
        "[[/module]]\n",
    );

    const RANDOM_ART: &str = concat!(
        "[[module ListPages category=\"*\" order=\"random\" limit=\"1\" tag=\"artist artwork\"]]\n",
        "[[include :snippets:redirect url=%%link%%]]\n",
        "[[/module]]\n",
    );

    const RANDOM_TALE: &str = concat!(
        "[[module ListPages category=\"*\" order=\"random\" limit=\"1\" tag=\"tale\"]]\n",
        "Random Tale: %%title_linked%%\n",
        "[[/module]]\n",
        "\n",
        "[[module ListPages category=\"*\" order=\"random\" limit=\"1\" tag=\"tale\"]]\n",
        "[[include :snippets:redirect url=%%link%%]]\n",
        "[[/module]]\n",
    );

    const RANDOM_GOI: &str = concat!(
        "[[module ListPages category=\"*\" order=\"random\" limit=\"1\" tag=\"goi-format\"]]\n",
        "Random SCP: %%title_linked%%\n",
        "[[/module]]\n",
        "\n",
        "[[module ListPages category=\"*\" order=\"random\" limit=\"1\" tag=\"goi-format\"]]\n",
        "[[include :snippets:redirect url=%%link%%]]\n",
        "[[/module]]\n",
    );

    fn select(source: &str) -> Option<RandomHelperSelector> {
        find_random_helper_selector(source, "random")
    }

    fn helper(head: &str, body: &str) -> String {
        format!("[[module ListPages {head}]]\n{body}\n[[/module]]\n")
    }

    fn redirect_helper(head: &str) -> String {
        helper(head, "[[include :snippets:redirect url=%%link%%]]")
    }

    #[test]
    fn recognizes_the_five_source_defined_helpers() {
        let scp = select(RANDOM_SCP).expect("random-scp should resolve");
        assert!(!scp.category_all);
        assert_eq!(scp.categories, vec!["_default"]);
        assert!(scp.excluded_categories.is_empty());
        assert_eq!(scp.any_tags, vec!["scp"]);
        assert!(scp.all_tags.is_empty() && scp.none_tags.is_empty());

        let page = select(RANDOM_PAGE).expect("random-page should resolve");
        assert!(page.category_all);
        assert!(page.categories.is_empty());
        assert_eq!(page.excluded_categories, vec!["unlisted"]);
        assert!(page.any_tags.is_empty());

        let art = select(RANDOM_ART).expect("random-art should resolve");
        assert!(art.category_all);
        assert_eq!(art.any_tags, vec!["artist", "artwork"]);

        let tale = select(RANDOM_TALE).expect("random-tale should resolve");
        assert!(tale.category_all);
        assert_eq!(tale.any_tags, vec!["tale"]);

        let goi = select(RANDOM_GOI).expect("random-goi-format should resolve");
        assert!(goi.category_all);
        assert_eq!(goi.any_tags, vec!["goi-format"]);
    }

    #[test]
    fn rejects_non_helper_module_shapes() {
        assert_eq!(
            find_random_helper_selector(
                "[[module ListPages category=\"*\" order=\"random\" limit=\"1\"]]\n%%title_linked%%\n[[/module]]\n",
                "random",
            ),
            None,
        );
        for head in [
            "category=\"*\" order=\"name\" limit=\"1\"",
            "category=\"*\" order=\"random\" limit=\"2\"",
            "category=\"*\" order=\"random\"",
            "category=\"*\" order=\"random\" limit=\"0\"",
            "category=\"*\" limit=\"1\"",
        ] {
            assert_eq!(
                select(&redirect_helper(head)),
                None,
                "head should not resolve: {head}",
            );
        }
        assert_eq!(
            find_random_helper_selector(
                "ordinary content\n[[module Redirect destination=\"target\"]]\nmore content",
                "random",
            ),
            None,
        );
        let doubled = format!("{RANDOM_SCP}\n{RANDOM_SCP}");
        assert_eq!(select(&doubled), None);
        assert_eq!(
            select(&helper(
                "category=\"*\" order=\"random\" limit=\"1\"",
                "[[include component:image-block]]",
            )),
            None,
        );
    }

    #[test]
    fn literal_owned_modules_never_redirect() {
        for source in [
            "[[code]]\n[[module ListPages category=\"*\" order=\"random\" limit=\"1\"]]\n[[include :snippets:redirect url=%%link%%]]\n[[/module]]\n[[/code]]",
            "[!--\n[[module ListPages category=\"*\" order=\"random\" limit=\"1\"]]\n[[include :snippets:redirect url=%%link%%]]\n[[/module]]\n--]",
            "@@[[module ListPages category=\"*\" order=\"random\" limit=\"1\"]]@@\n[[include :snippets:redirect url=%%link%%]]\n[[/module]]",
        ] {
            assert_eq!(select(source), None, "literal source must not resolve");
        }
    }

    #[test]
    fn applies_documented_selector_defaults_and_grammar() {
        let selector = select(&redirect_helper("order=\"random\" limit=\"1\""))
            .expect("category-less helper should resolve");
        assert!(!selector.category_all);
        assert_eq!(selector.categories, vec!["random"]);

        let selector = select(&redirect_helper(
            "category=\".\" order=\"random\" limit=\"1\"",
        ))
        .expect("dot category should resolve");
        assert_eq!(selector.categories, vec!["random"]);

        for head in [
            "Category=\"*\" order=\"random\" limit=\"1\"",
            "category='*' order=\"random\" limit=\"1\"",
            "category=* order=\"random\" limit=\"1\"",
            "category=\"\" order=\"random\" limit=\"1\"",
        ] {
            let selector =
                select(&redirect_helper(head)).expect("inert category should default");
            assert_eq!(selector.categories, vec!["random"], "head: {head}");
        }

        for head in [
            "category=\"*\" ORDER=\"random\" limit=\"1\"",
            "category=\"*\" order='random' limit=\"1\"",
            "category=\"*\" order=random limit=\"1\"",
            "category=\"*\" order=\"random\" limit=1",
        ] {
            assert_eq!(select(&redirect_helper(head)), None, "head: {head}");
        }

        for order in ["RANDOM", "randomDesc", "random desc", "-random"] {
            assert!(
                select(&redirect_helper(&format!(
                    "category=\"*\" order=\"{order}\" limit=\"1\""
                )))
                .is_some(),
                "order should resolve: {order}",
            );
        }

        assert!(
            select(&redirect_helper(
                "category=\"*\" order=\"random\" limit=\"01\""
            ))
            .is_some()
        );
        assert!(
            select(&redirect_helper(
                "category=\"*\" order=\"random\" limit=\"xx\" limit=\"1\""
            ))
            .is_some()
        );
        assert!(
            select(&redirect_helper(
                "category=\"*\" order=\"random\" limit=\"1\" limit=\"xx\""
            ))
            .is_some()
        );
    }

    #[test]
    fn honors_tag_and_category_precedence() {
        let selector = select(&redirect_helper(
            "category=\"*\" order=\"random\" limit=\"1\" tags=\"scp\" tag=\"tale\"",
        ))
        .expect("tag should win");
        assert_eq!(selector.any_tags, vec!["tale"]);
        let selector = select(&redirect_helper(
            "category=\"*\" order=\"random\" limit=\"1\" tag=\"tale\" tags=\"scp\"",
        ))
        .expect("tag should win in reverse order");
        assert_eq!(selector.any_tags, vec!["tale"]);

        let selector = select(&redirect_helper(
            "categories=\"tale\" category=\"scp\" order=\"random\" limit=\"1\"",
        ))
        .expect("category should win");
        assert_eq!(selector.categories, vec!["scp"]);
        let selector = select(&redirect_helper(
            "category=\"scp\" categories=\"tale\" order=\"random\" limit=\"1\"",
        ))
        .expect("category should win in reverse order");
        assert_eq!(selector.categories, vec!["scp"]);

        let selector = select(&redirect_helper(
            "category=\"*\" order=\"random\" limit=\"1\" tag=\"+scp -tale joke\"",
        ))
        .expect("signed tags should resolve");
        assert_eq!(selector.any_tags, vec!["joke"]);
        assert_eq!(selector.all_tags, vec!["scp"]);
        assert_eq!(selector.none_tags, vec!["tale"]);
    }

    #[test]
    fn fails_closed_outside_the_narrow_selector_subset() {
        for head in [
            "category=\"*\" order=\"random\" limit=\"1\" parent=\"start\"",
            "category=\"*\" order=\"random\" limit=\"1\" range=\"others\"",
            "category=\"*\" order=\"random\" limit=\"1\" tags=\"=\"",
            "category=\"*\" order=\"random\" limit=\"1\" tags=\"-\"",
            "category=\"*\" order=\"random\" limit=\"1\" created_by=\"someone\"",
            "category=\"*\" order=\"random\" limit=\"1\" rating=\"5\"",
            "category=\"*\" order=\"random\" limit=\"1\" _field=\"value\"",
            "category=\"*\" order=\"random\" limit=\"1\" link_to=\".\"",
            "category=\"*\" order=\"random\" limit=\"1\" offset=\"3\"",
            "category=\"*\" order=\"random\" limit=\"1\" reverse=\"yes\"",
            "category=\"*\" order=\"random\" limit=\"1\" skipCurrent=\"yes\"",
            "category=\"*\" order=\"random\" limit=\"1\" rssOnly=\"yes\" rss=\"Feed\"",
        ] {
            assert_eq!(select(&redirect_helper(head)), None, "head: {head}");
        }

        for head in [
            "category=\"*\" order=\"random\" limit=\"1\" offset=\"0\"",
            "category=\"*\" order=\"random\" limit=\"1\" offset=\"@URL\"",
            "category=\"*\" order=\"random\" limit=\"1\" reverse=\"no\"",
            "category=\"*\" order=\"random\" limit=\"1\" skip_current=\"yes\"",
            "category=\"*\" order=\"random\" limit=\"1\" skipCurrent=\"no\"",
            "category=\"*\" order=\"random\" limit=\"1\" rssOnly=\"yes\"",
            "category=\"*\" order=\"random\" limit=\"1\" author=\"someone\"",
            "category=\"*\" order=\"random\" limit=\"1\" custom=\"anything\"",
            "category=\"*\" order=\"random\" limit=\"1\" separate=\"no\" perPage=\"5\"",
        ] {
            assert!(
                select(&redirect_helper(head)).is_some(),
                "head should resolve: {head}",
            );
        }

        assert!(
            select(&redirect_helper(
                "category=\"*\" order=\"random\" limit=\"@URL|1\""
            ))
            .is_some()
        );
        assert!(
            select(&redirect_helper(
                "category=\"@URL\" order=\"random\" limit=\"1\""
            ))
            .is_some()
        );
    }

    #[test]
    fn url_selectors_resolve_for_the_bare_helper_route() {
        let selector = select(&redirect_helper(
            "category=\"*\" order=\"random\" limit=\"1\" tags=\"@URL\"",
        ))
        .expect("lone dynamic tags should drop the constraint");
        assert!(selector.any_tags.is_empty());
        let selector = select(&redirect_helper(
            "category=\"*\" order=\"random\" limit=\"1\" tags=\"scp @URL\"",
        ))
        .expect("mixed dynamic tags should keep the literal member");
        assert_eq!(selector.any_tags, vec!["scp", "@url"]);

        assert_eq!(
            select(&redirect_helper(
                "category=\"*\" order=\"random\" limit=\"1\" tags=\"@URL|\""
            )),
            None,
        );
        let selector = select(&redirect_helper(
            "category=\"*\" order=\"random\" limit=\"1\" tag=\"@URL|\"",
        ))
        .expect("singular empty fallback should parse to no constraint");
        assert!(selector.any_tags.is_empty());
    }

    #[test]
    fn module_name_matching_follows_the_render_scanner() {
        assert!(
            select(
                &helper(
                    "category=\"*\" order=\"random\" limit=\"1\"",
                    "[[include :snippets:redirect url=%%link%%]]",
                )
                .replace("[[module", "[[MODULE")
            )
            .is_some()
        );
        assert_eq!(
            find_random_helper_selector(
                "[[module ListPagesExtra category=\"*\" order=\"random\" limit=\"1\"]]\n[[include :snippets:redirect url=%%link%%]]\n[[/module]]\n",
                "random",
            ),
            None,
        );
        assert_eq!(
            find_random_helper_selector(
                "[[module ListPages category=\"*\" order=\"random\" limit=\"1\"]]\n[[include :snippets:redirect url=%%link%%]]\n",
                "random",
            ),
            None,
        );
    }

    #[test]
    fn slug_equality_uses_wikidot_normalization() {
        assert!(random_helper_slugs_equal("scp-4890", "scp-4890"));
        assert!(!random_helper_slugs_equal("scp-4890", "scp-4891"));
    }
}
