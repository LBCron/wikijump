/*
 * services/render/list_pages/titles.rs
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

use super::super::compat::text_fragments::CompatTextFragments;

pub(super) fn sanitize_list_pages_title(title: &str) -> String {
    title
        .chars()
        .filter(|character| !matches!(character, '[' | ']'))
        .collect()
}

pub(super) fn wikidot_empty_imported_title_label(full_slug: &str) -> String {
    let page_name = full_slug
        .rsplit_once(':')
        .map_or(full_slug, |(_, page_name)| page_name);
    let label = page_name.replace('-', " ");
    let mut characters = label.chars();
    let Some(first) = characters.next() else {
        return String::new();
    };
    first.to_uppercase().chain(characters).collect::<String>()
}

pub(super) fn render_list_pages_linked_title(
    full_slug: &str,
    title: &str,
    compat_text: &mut CompatTextFragments,
) -> String {
    if list_pages_title_breaks_link_after_escaped_region(title) {
        return render_list_pages_broken_linked_title(full_slug, title, compat_text);
    }
    let label = compat_text.push(&escape_list_pages_html_text(title));
    if full_slug.is_empty() {
        label
    } else {
        format!("[/{full_slug} {label}]")
    }
}

fn escape_list_pages_html_text(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len());
    for character in value.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            _ => escaped.push(character),
        }
    }
    escaped
}

fn list_pages_title_breaks_link_after_escaped_region(title: &str) -> bool {
    title.lines().any(|line| {
        let mut remainder = line;
        while let Some(start) = remainder.find("@@") {
            remainder = &remainder[start + 2..];
            if remainder.find("@@").is_some() {
                return true;
            }
        }
        false
    })
}

fn render_list_pages_broken_linked_title(
    full_slug: &str,
    title: &str,
    compat_text: &mut CompatTextFragments,
) -> String {
    let open =
        compat_text.push(&format!("[[[{} | ", escape_list_pages_html_text(full_slug),));
    let close = compat_text.push("]]]");
    format!("{open}{title}{close}")
}

#[cfg(test)]
mod tests {
    use super::list_pages_title_breaks_link_after_escaped_region;

    #[test]
    fn linked_title_escape_region_must_close_on_the_same_line() {
        assert!(list_pages_title_breaks_link_after_escaped_region(
            "before @@escaped@@ after",
        ));
        assert!(!list_pages_title_breaks_link_after_escaped_region(
            "before @@unclosed",
        ));
        assert!(!list_pages_title_breaks_link_after_escaped_region(
            "before @@\nafter @@",
        ));
    }
}
