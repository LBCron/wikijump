/*
 * services/render/list_pages/substitution/selectors.rs
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

use crate::services::render::module_arguments::{
    WikidotModuleArgumentValueKind, wikidot_list_pages_arguments,
};
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::ops::Range;

use super::super::data_forms::{
    ListPagesDataFormDefinition, substitute_list_pages_form_data,
    substitute_list_pages_form_hint, substitute_list_pages_form_label,
    substitute_list_pages_form_raw,
};
use super::super::template::LISTPAGES_VARIABLE_REGEX;
use super::split_list_pages_values;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum ListPagesNameSelector {
    CurrentPage,
    Exact(Cow<'static, str>),
    Pattern(Cow<'static, str>),
}

pub(super) struct ComposedListPagesNameSelector {
    pub(super) current_page_only: bool,
    pub(super) slug: Option<Cow<'static, str>>,
    pub(super) name_pattern: Option<Cow<'static, str>>,
    pub(super) unsupported: bool,
}

pub(super) fn compose_list_pages_name_selectors(
    canonical: Option<ListPagesNameSelector>,
    alias: Option<ListPagesNameSelector>,
) -> ComposedListPagesNameSelector {
    let mut selectors = [canonical, alias].into_iter().flatten();
    let first = selectors.next();
    let second = selectors.next();
    let (current_page_only, slug, name_pattern, unsupported) = match (first, second) {
        (None, None) => (false, None, None, false),
        (Some(ListPagesNameSelector::CurrentPage), None) => (true, None, None, false),
        (Some(ListPagesNameSelector::Exact(exact)), None) => {
            (false, Some(exact), None, false)
        }
        (Some(ListPagesNameSelector::Pattern(pattern)), None) => {
            (false, None, Some(pattern), false)
        }
        (Some(first), Some(second)) if first == second => match first {
            ListPagesNameSelector::CurrentPage => (true, None, None, false),
            ListPagesNameSelector::Exact(exact) => (false, Some(exact), None, false),
            ListPagesNameSelector::Pattern(pattern) => {
                (false, None, Some(pattern), false)
            }
        },
        (
            Some(ListPagesNameSelector::Exact(first)),
            Some(ListPagesNameSelector::Exact(second)),
        ) => (false, Some(first), Some(second), false),
        (
            Some(ListPagesNameSelector::Exact(exact)),
            Some(ListPagesNameSelector::Pattern(pattern)),
        )
        | (
            Some(ListPagesNameSelector::Pattern(pattern)),
            Some(ListPagesNameSelector::Exact(exact)),
        ) => (false, Some(exact), Some(pattern), false),
        (Some(_), Some(_)) => (false, None, None, true),
        (None, Some(_)) => unreachable!("the second name selector follows the first"),
    };

    ComposedListPagesNameSelector {
        current_page_only,
        slug,
        name_pattern,
        unsupported,
    }
}

fn is_list_pages_url_token_delimiter(byte: u8) -> bool {
    byte.is_ascii_whitespace() || matches!(byte, b',' | b';')
}

fn list_pages_url_token_range(value: &str) -> Option<(usize, usize)> {
    let selector = value
        .split_once('|')
        .map(|(selector, _)| selector)
        .unwrap_or(value);
    selector
        .as_bytes()
        .windows(4)
        .enumerate()
        .find_map(|(start, token)| {
            if !token.eq_ignore_ascii_case(b"@url")
                || start.checked_sub(1).is_some_and(|left| {
                    !is_list_pages_url_token_delimiter(selector.as_bytes()[left])
                })
                || selector
                    .as_bytes()
                    .get(start + token.len())
                    .is_some_and(|right| !is_list_pages_url_token_delimiter(*right))
            {
                return None;
            }
            Some((start, start + token.len()))
        })
}

pub(in crate::services::render) fn is_dynamic_list_pages_value(value: &str) -> bool {
    list_pages_url_token_range(value).is_some()
}

pub(in crate::services::render) fn list_pages_url_fallback(value: &str) -> Option<&str> {
    value.split_once('|').and_then(|(selector, fallback)| {
        list_pages_url_token_range(selector)
            .is_some()
            .then_some(fallback)
    })
}

pub(in crate::services::render) fn list_pages_static_url_fallback_marker_range(
    value: &str,
) -> Option<Range<usize>> {
    let (selector, _) = value.split_once('|')?;
    let (start, end) = list_pages_url_token_range(selector)?;
    Some(start..end)
}

pub(in crate::services::render) fn parse_list_pages_numeric_argument(
    value: &str,
) -> Option<u64> {
    let value = list_pages_url_fallback(value).unwrap_or(value);
    (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
}

pub(in crate::services::render) enum UrlSelector<'a> {
    Static(&'a str),

    Resolved(String),

    Dropped,
}

pub(in crate::services::render) fn resolve_url_selector<'a>(
    value: &'a str,
    url_value: Option<&str>,
) -> UrlSelector<'a> {
    let selector = value
        .split_once('|')
        .map(|(selector, _)| selector)
        .unwrap_or(value);
    let Some((start, end)) = list_pages_url_token_range(selector) else {
        return UrlSelector::Static(value);
    };
    match url_value {
        Some(resolved) if !resolved.is_empty() => {
            let mut value =
                String::with_capacity(selector.len() - (end - start) + resolved.len());
            value.push_str(&selector[..start]);
            value.push_str(resolved);
            value.push_str(&selector[end..]);
            UrlSelector::Resolved(value)
        }
        _ => match list_pages_url_fallback(value) {
            Some(fallback) => UrlSelector::Static(fallback),
            None => UrlSelector::Dropped,
        },
    }
}

pub(in crate::services::render) fn preflight_static_list_pages_selector<'a>(
    value: &'a str,
    unsupported_count_pages_filter: &mut bool,
) -> Option<&'a str> {
    if let Some(fallback) = list_pages_url_fallback(value) {
        Some(fallback)
    } else if is_dynamic_list_pages_value(value) {
        *unsupported_count_pages_filter = true;
        None
    } else {
        Some(value)
    }
}

pub(in crate::services::render) fn list_pages_static_category_preflight(
    head: &str,
) -> Option<(Vec<String>, bool)> {
    let arguments = wikidot_list_pages_arguments(head);
    let mut categories = arguments.iter().filter(|argument| {
        argument.key == "category"
            && argument.op == "="
            && argument.value_kind == WikidotModuleArgumentValueKind::DoubleQuoted
    });
    let category = categories.next()?;
    if categories.next().is_some() || category.op != "=" {
        return None;
    }

    let mut included = Vec::new();
    for category in split_list_pages_values(category.value.trim()) {
        if category.is_empty()
            || category == "*"
            || category == "."
            || category.starts_with('-')
            || is_dynamic_list_pages_value(&category)
        {
            return None;
        }
        let category = category.strip_prefix('+').unwrap_or(&category);
        if category.is_empty() {
            return None;
        }
        included.push(category.to_lowercase());
    }
    if included.is_empty() {
        return None;
    }

    let wrapper = arguments
        .iter()
        .filter(|argument| {
            argument.key == "wrapper"
                && argument.op == "="
                && argument.value_kind == WikidotModuleArgumentValueKind::DoubleQuoted
        })
        .map(|argument| !matches!(argument.value, "false" | "no"))
        .next_back()
        .unwrap_or(true);
    Some((included, wrapper))
}

pub(in crate::services::render) fn split_list_pages_tag_values(
    value: &str,
) -> Vec<String> {
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

pub(in crate::services::render) fn substitute_list_pages_current_data_form_variables(
    source: &str,
    values: &BTreeMap<String, String>,
    definition: &ListPagesDataFormDefinition,
) -> Option<String> {
    if !source.contains("%%form_") {
        return None;
    }

    let mut changed = false;
    let mut unsafe_replacement = false;
    let substituted = LISTPAGES_VARIABLE_REGEX
        .replace_all(source, |captures: &regex::Captures<'_>| {
            let Some(name) = captures.name("name").map(|matched| matched.as_str()) else {
                return captures[0].to_owned();
            };
            let Some(field) = captures.name("argument").map(|matched| matched.as_str())
            else {
                return captures[0].to_owned();
            };

            let value = match name.to_ascii_lowercase().as_str() {
                "form_data" => {
                    substitute_list_pages_form_data(field, values, Some(definition))
                }
                "form_raw" => {
                    substitute_list_pages_form_raw(field, values, Some(definition))
                }
                "form_label" => substitute_list_pages_form_label(field, Some(definition)),
                "form_hint" => substitute_list_pages_form_hint(field, Some(definition)),
                _ => None,
            };
            if let Some(value) = value {
                if value.contains(['"', '[', ']', '\r', '\n']) {
                    unsafe_replacement = true;
                    return captures[0].to_owned();
                }
                changed = true;
                value
            } else {
                captures[0].to_owned()
            }
        })
        .into_owned();

    if unsafe_replacement {
        None
    } else {
        changed.then_some(substituted)
    }
}

pub(in crate::services::render) fn list_pages_has_unsupported_parent_selector(
    head: &str,
) -> bool {
    wikidot_list_pages_arguments(head)
        .into_iter()
        .any(|argument| {
            if !argument.key.eq_ignore_ascii_case("parent") {
                return false;
            }

            let value = argument.value.trim();
            let value = list_pages_url_fallback(value).unwrap_or(value);
            is_dynamic_list_pages_value(value)
        })
}

pub(in crate::services::render) fn list_pages_has_unsupported_page_type_selector(
    head: &str,
) -> bool {
    let mut canonical = None;
    for argument in wikidot_list_pages_arguments(head) {
        if argument.op != "=" {
            continue;
        }
        if argument.key.eq_ignore_ascii_case("pagetype") {
            canonical = Some(argument.value);
        }
    }

    canonical.is_some_and(|value| {
        let value = list_pages_url_fallback(value).unwrap_or(value);
        value != "0" && super::parse_list_pages_page_type(value).is_none()
    })
}

#[cfg(test)]
#[path = "selectors_tests.rs"]
mod tests;
