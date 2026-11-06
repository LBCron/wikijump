/*
 * content.rs
 *
 * Wilson's Web Server - Serves a zoo of user-generated content
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

pub fn is_active_content_type(mime: &str) -> bool {
    let essence = mime
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    matches!(
        essence.as_str(),
        "text/html"
            | "application/xhtml+xml"
            | "image/svg+xml"
            | "image/svg"
            | "text/xml"
            | "application/xml",
    ) || essence.ends_with("+xml")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_types_include_html_and_svg() {
        for mime in [
            "text/html",
            "text/html; charset=utf-8",
            "TEXT/HTML",
            "application/xhtml+xml",
            "image/svg+xml",
            "image/svg",
            "text/xml",
            "application/xml",
            "application/atom+xml",
        ] {
            assert!(is_active_content_type(mime), "should be active: {mime}");
        }
    }

    #[test]
    fn inactive_types_stay_inline() {
        for mime in [
            "text/plain",
            "image/png",
            "application/pdf",
            "",
            "text/html5",
        ] {
            assert!(!is_active_content_type(mime), "should stay inline: {mime}");
        }
    }
}
