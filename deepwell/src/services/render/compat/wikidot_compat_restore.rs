/*
 * services/render/wikidot_compat_restore.rs
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

use super::super::service::{
    RenderService, WIKIDOT_COMPAT_STYLE_BLOCK_REGEX, WIKIDOT_EMAIL_SPAN_REGEX,
    WIKIDOT_EMBED_PARAGRAPH_REGEX, WIKIDOT_TABVIEW_INIT_SCRIPT,
    WIKIDOT_TABVIEW_PANEL_ID_REGEX, WIKIJUMP_CODE_BLOCK_OPEN_REGEX,
    WIKIJUMP_CODE_BLOCK_PANEL_REGEX, WIKIJUMP_FOOTNOTE_DATA_ID_REGEX,
    WIKIJUMP_FOOTNOTE_MARKER_REGEX, WIKIJUMP_FOOTNOTE_REF_LEADING_SPACE_REGEX,
    WIKIJUMP_FOOTNOTE_REF_SPAN_WRAPPER_REGEX, WIKIJUMP_INLINE_MATH_REGEX,
    WIKIJUMP_SELECTED_TAB_BUTTON_REGEX, WIKIJUMP_TAB_BUTTON_LIST_REGEX,
    WIKIJUMP_TAB_BUTTON_REGEX, WIKIJUMP_TAB_PANEL_LIST_OPEN_REGEX,
    WIKIJUMP_TAB_PANEL_REGEX, decode_wikidot_email_html_entities,
    escape_list_pages_html_attr, escape_list_pages_html_text,
};
use super::footnote_dom::{
    enclose_list_pages_footnote_footer, restore_wikidot_footnote_list_dom,
};
use crate::config::Config;
use crate::models::site::Model as SiteModel;

fn valid_wikidot_tabview_id(id: &str) -> Option<&str> {
    let suffix = id.strip_prefix("wiki-tabview-")?;
    (suffix.len() == 32
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f')))
    .then_some(suffix)
}

fn find_matching_div_end(html: &str, root_start: usize) -> Option<usize> {
    let mut depth = 0usize;
    let mut cursor = root_start;
    while let Some(relative_start) = html[cursor..].find('<') {
        let start = cursor + relative_start;
        if html[start..].starts_with("<!--") {
            let end = html[start + 4..].find("-->")?;
            cursor = start + 4 + end + 3;
            continue;
        }
        let end = start + html[start..].find('>')?;
        let tag = &html[start..=end];
        let bytes = tag.as_bytes();
        if bytes.starts_with(b"<div")
            && matches!(
                bytes.get(4),
                Some(b'>' | b'/' | b' ' | b'\t' | b'\r' | b'\n')
            )
        {
            depth += 1;
        } else if bytes.starts_with(b"</div")
            && matches!(bytes.get(5), Some(b'>') | Some(b' ') | Some(b'\t'))
        {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(end + 1);
            }
        }
        cursor = end + 1;
    }
    None
}

impl RenderService {
    pub(in crate::services::render) fn restore_wikidot_render_compatibility_for_context_with_resources(
        html: &str,
        current_site: Option<&SiteModel>,
        config: &Config,
        allow_styleframe: bool,
        wikidot_tabview_ids: &[String],
    ) -> String {
        let mut html = html.to_owned();
        if html.contains("[[embed]]") {
            html = Self::restore_wikidot_rendered_embed_iframes_for_context(
                &html,
                allow_styleframe,
            );
        }
        if html.contains("wiki-email") {
            html = Self::restore_wikidot_email_obfuscation(&html);
            html = Self::remove_spurious_wikidot_email_classes(&html);
        }
        if html.contains("wj-collapsible") {
            html = Self::restore_wikidot_collapsible_compatibility(&html);
        }
        if html.contains("wj-code") {
            html = Self::restore_wikidot_code_block_dom_compatibility(&html);
        }
        if !wikidot_tabview_ids.is_empty() {
            html = Self::restore_wikidot_tabview_resource_compatibility(
                &html,
                wikidot_tabview_ids,
            );
        }
        if html.contains("wj-tabs") {
            html = Self::restore_wikidot_tabview_dom_compatibility(&html);
        }
        if html.contains("[[div") || html.contains("[[/div") {
            html = Self::restore_residual_wikidot_div_paragraph_markers(&html);
        }
        if html.contains("[[span") || html.contains("[[/span") {
            html = Self::restore_residual_wikidot_span_markers(&html);
        }
        if html.contains("[[=")
            || html.contains("[[<")
            || html.contains("[[>")
            || html.contains("[[&lt;")
            || html.contains("[[&gt;")
            || html.contains("[[/=")
            || html.contains("[[/<")
            || html.contains("[[/>")
            || html.contains("[[/&lt;")
            || html.contains("[[/&gt;")
        {
            html = Self::restore_residual_wikidot_alignment_markers(&html);
        }
        if html.starts_with("----")
            || html.contains("\n----")
            || html.contains("@@ @@")
            || html.contains("~~~~")
            || html.contains("clear:both; height: 0px; font-size: 1px")
        {
            html = Self::restore_residual_wikidot_separator_markers(&html);
        }
        if html.starts_with('+') || html.contains("\n+") || html.contains("\n====") {
            html = Self::restore_residual_wikidot_heading_markers(&html);
        }
        if html.contains("<tbody>") || html.contains("</tbody>") {
            html = Self::remove_wikijump_table_body_wrappers(&html);
        }
        if WIKIDOT_COMPAT_STYLE_BLOCK_REGEX.is_match(&html) {
            html = Self::remove_wikidot_compat_style_blocks(&html);
        }
        if html.contains("wj-math-inline") {
            html = Self::restore_wikidot_inline_math_compatibility(&html);
        }
        if html.contains("{$") {
            html = Self::restore_wikidot_ta_badge_default_compatibility(&html);
        }
        if html.contains("wj-footnote") {
            html = Self::restore_wikidot_footnote_dom_compatibility(&html);
        }
        if html.contains(r#"<div class="list-pages-box">"#)
            && html.contains(r#"<div class="footnotes-footer">"#)
        {
            html = enclose_list_pages_footnote_footer(&html);
        }
        if html.contains("<u>") || html.contains("</u>") {
            html = Self::remove_wikijump_underline_wrappers(&html);
        }
        if html.contains("/local--") {
            html = Self::localize_wikidot_local_file_urls(&html, current_site, config);
        }
        html
    }

    pub(in crate::services::render) fn restore_wikidot_include_block_break(
        html: &str,
    ) -> String {
        const MARKER: &str = r#"</div></div></div></div></div><p><iframe src="/-/wikidot-interwiki/styleFrame.html"#;
        const REPLACEMENT: &str = r#"</div></div></div></div><br></div><p><iframe src="/-/wikidot-interwiki/styleFrame.html"#;
        html.replacen(MARKER, REPLACEMENT, 1)
    }

    pub(in crate::services::render) fn restore_wikidot_tabview_resource_compatibility(
        html: &str,
        tabview_ids: &[String],
    ) -> String {
        let mut restored = html.to_owned();
        for id in tabview_ids {
            let Some(suffix) = valid_wikidot_tabview_id(id) else {
                continue;
            };
            let wikidot_opening =
                format!(r#"<div id="{id}" class="yui-navset yui-navset-top">"#);
            let legacy_opening = format!(r#"<div id="{id}" class="yui-navset">"#);
            let root_start = restored
                .find(&wikidot_opening)
                .or_else(|| restored.find(&legacy_opening));
            let Some(root_start) = root_start else {
                continue;
            };
            let Some(root_end) = find_matching_div_end(&restored, root_start) else {
                continue;
            };
            let root = restored[root_start..root_end]
                .replacen(&wikidot_opening, &legacy_opening, 1)
                .replacen(
                    r#"<li class="selected" title="active">"#,
                    r#"<li class="selected">"#,
                    1,
                );
            let root = WIKIDOT_TABVIEW_PANEL_ID_REGEX
                .replace_all(&root, |captures: &regex::Captures<'_>| {
                    let index = captures.name("index").map_or("", |value| value.as_str());
                    if index == "0" {
                        format!(
                            r#"<div id="wiki-tab-0-{index}" style="display: block;">"#
                        )
                    } else {
                        format!(r#"<div id="wiki-tab-0-{index}" style="display:none">"#)
                    }
                })
                .into_owned();
            let _ = suffix;
            let replacement = format!("{root}{WIKIDOT_TABVIEW_INIT_SCRIPT}");
            restored.replace_range(root_start..root_end, &replacement);
        }
        restored
    }

    pub(in crate::services::render) fn restore_wikidot_collapsible_compatibility(
        html: &str,
    ) -> String {
        html.replace(r#"<details class="wj-collapsible""#, r#"<details class="collapsible-block collapsible-block-folded collapsible-block-unfolded""#)
            .replace(
                r#"<summary class="wj-collapsible-button wj-collapsible-button-top">"#,
                r#"<summary class="collapsible-block-link">"#,
            )
            .replace(
                r#"<wj-collapsible-button-bottom class="wj-collapsible-button wj-collapsible-button-bottom">"#,
                r#"<div class="collapsible-block-unfolded-link"><span class="collapsible-block-link">"#,
            )
            .replace("</wj-collapsible-button-bottom>", "</span></div>")
            .replace("wj-collapsible-content", "collapsible-block-content")
            .replace("wj-collapsible-show-text", "collapsible-block-link")
            .replace(
                "wj-collapsible-hide-text",
                "collapsible-block-link collapsible-block-unfolded-link",
            )
    }

    pub(in crate::services::render) fn restore_wikidot_code_block_dom_compatibility(
        html: &str,
    ) -> String {
        let html = WIKIJUMP_CODE_BLOCK_PANEL_REGEX.replace_all(html, "");
        let html =
            WIKIJUMP_CODE_BLOCK_OPEN_REGEX.replace_all(&html, r#"<div class="code">"#);
        html.replace("</wj-code>", "</div>")
    }

    pub(in crate::services::render) fn restore_wikidot_tabview_dom_compatibility(
        html: &str,
    ) -> String {
        let html = if html.contains(WIKIDOT_TABVIEW_INIT_SCRIPT) {
            html.replace(
                r#"<wj-tabs class="wj-tabs">"#,
                r#"<div class="yui-navset">"#,
            )
        } else {
            html.replace(
                r#"<wj-tabs class="wj-tabs">"#,
                &format!(
                    r#"{WIKIDOT_TABVIEW_INIT_SCRIPT}
<div class="yui-navset">"#
                ),
            )
        };
        let html = WIKIJUMP_TAB_BUTTON_LIST_REGEX
            .replace_all(&html, r#"<ul class="yui-nav">$body</ul>"#);
        let html = Self::restore_wikidot_tab_panel_visibility(&html);
        let html = WIKIJUMP_TAB_PANEL_LIST_OPEN_REGEX
            .replace_all(&html, r#"<div class="yui-content">"#);
        let html = WIKIJUMP_SELECTED_TAB_BUTTON_REGEX
            .replace_all(&html, r#"<li class="selected"><a href="javascript:;">"#);
        let html = WIKIJUMP_TAB_BUTTON_REGEX
            .replace_all(&html, r#"<li><a href="javascript:;">"#);
        html.replace("</wj-tabs-button>", "</a></li>\n")
            .replace("</wj-tabs>", "</div>")
    }

    pub(in crate::services::render) fn restore_wikidot_tab_panel_visibility(
        html: &str,
    ) -> String {
        let mut panel_index = 0usize;
        let mut last_copied = 0usize;
        let mut group_scan_start = 0usize;
        let mut restored = String::with_capacity(html.len());

        for captures in WIKIJUMP_TAB_PANEL_REGEX.captures_iter(html) {
            let Some(panel_match) = captures.get(0) else {
                continue;
            };

            if WIKIJUMP_TAB_PANEL_LIST_OPEN_REGEX
                .is_match(&html[group_scan_start..panel_match.start()])
            {
                panel_index = 0;
            }

            restored.push_str(&html[last_copied..panel_match.start()]);
            let panel = panel_match.as_str();
            let hidden = Self::wikijump_tab_panel_is_hidden(panel);
            if panel_index == 0 && !hidden {
                restored.push_str(r#"<div style="display: block;">"#);
            } else {
                restored.push_str(r#"<div style="display:none">"#);
            }
            panel_index += 1;
            last_copied = panel_match.end();
            group_scan_start = panel_match.end();
        }

        restored.push_str(&html[last_copied..]);
        restored
    }

    pub(in crate::services::render) fn restore_wikidot_footnote_dom_compatibility(
        html: &str,
    ) -> String {
        let html = WIKIJUMP_FOOTNOTE_MARKER_REGEX
            .replace_all(html, |captures: &regex::Captures<'_>| {
                let attrs = captures.name("attrs").map_or("", |mtch| mtch.as_str());
                let label = captures.name("label").map_or("", |mtch| mtch.as_str());
                let Some(id) = WIKIJUMP_FOOTNOTE_DATA_ID_REGEX
                    .captures(attrs)
                    .and_then(|data_id| data_id.name("id"))
                    .map(|mtch| mtch.as_str())
                else {
                    return captures.get(0).unwrap().as_str().to_owned();
                };

                format!(
                    r#"<sup class="footnoteref"><a id="footnoteref-{id}" href="javascript:;" class="footnoteref" onclick="WIKIDOT.page.utils.scrollToReference('footnote-{id}')">{label}</a></sup>"#
                )
            })
            .into_owned();
        let html = WIKIJUMP_FOOTNOTE_REF_LEADING_SPACE_REGEX
            .replace_all(&html, |captures: &regex::Captures<'_>| {
                format!("{}{}", &captures["before"], &captures["footnote"])
            })
            .into_owned();
        let html = Self::remove_wikijump_footnote_ref_tooltips(&html);
        let html = WIKIJUMP_FOOTNOTE_REF_SPAN_WRAPPER_REGEX
            .replace_all(&html, |captures: &regex::Captures<'_>| {
                captures
                    .name("body")
                    .map_or("", |mtch| mtch.as_str())
                    .to_owned()
            })
            .into_owned();
        restore_wikidot_footnote_list_dom(&html)
    }

    pub(in crate::services::render) fn restore_wikidot_inline_math_compatibility(
        html: &str,
    ) -> String {
        WIKIJUMP_INLINE_MATH_REGEX
            .replace_all(html, r#"<span class="math-inline">$$${source}$$</span>"#)
            .into_owned()
    }

    pub(in crate::services::render) fn restore_wikidot_ta_badge_default_compatibility(
        html: &str,
    ) -> String {
        html.replace("bg-shadow-{$bg-shadow}", "bg-shadow-true")
            .replace("plate-shadow-{$plate-shadow}", "plate-shadow-true")
            .replace(
                "item-mobile-mode-{$item-mobile-mode}",
                "item-mobile-mode-true",
            )
            .replace("item-align-{$item-align}", "item-align-true")
            .replace("{$badge-top-link}", "empty")
            .replace("{$badge-right-link}", "empty")
            .replace("{$badge-left-link}", "empty")
            .replace("{$item-lt-link}", "empty")
            .replace("{$item-lc-link}", "empty")
            .replace("{$item-lb-link}", "empty")
            .replace("{$item-rt-link}", "empty")
            .replace("{$item-rc-link}", "empty")
            .replace("{$item-rb-link}", "empty")
    }

    pub(in crate::services::render) fn restore_wikidot_code_block_compatibility(
        code: &str,
        current_site: Option<&SiteModel>,
        config: &Config,
    ) -> String {
        Self::localize_wikidot_local_file_urls(code, current_site, config)
    }

    pub(in crate::services::render) fn restore_wikidot_rendered_embed_iframes_for_context(
        html: &str,
        allow_styleframe: bool,
    ) -> String {
        WIKIDOT_EMBED_PARAGRAPH_REGEX
            .replace_all(html, |captures: &regex::Captures<'_>| {
                let block = captures.get(1).map_or("", |m| m.as_str());
                let decoded = Self::decode_rendered_embed_block(block);

                if !allow_styleframe && decoded.contains("/styleFrame.html?") {
                    return captures.get(0).map_or("", |m| m.as_str()).to_owned();
                }

                let Some(iframe) = Self::allowed_wikidot_embed_iframe(&decoded) else {
                    return captures.get(0).map_or("", |m| m.as_str()).to_string();
                };

                format!("<p>{iframe}</p>")
            })
            .into_owned()
    }

    pub(in crate::services::render) fn restore_wikidot_email_obfuscation(
        html: &str,
    ) -> String {
        WIKIDOT_EMAIL_SPAN_REGEX
            .replace_all(html, |captures: &regex::Captures<'_>| {
                let href_email = captures.get(1).map_or("", |m| m.as_str());
                let visible_email = captures.get(2).map_or("", |m| m.as_str());
                let href_email = decode_wikidot_email_html_entities(href_email);
                let visible_email =
                    decode_wikidot_email_html_entities(visible_email);

                if href_email != visible_email {
                    return captures.get(0).map_or("", |m| m.as_str()).to_string();
                }

                let (email, trailing) =
                    Self::split_trailing_email_punctuation(&visible_email);
                if Self::wikidot_obfuscated_email(email).is_none() {
                    return captures.get(0).map_or("", |m| m.as_str()).to_string();
                }

                format!(
                    r#"<span class="wiki-email" style="visibility: visible;"><a href="mailto:{email_attr}">{email_text}</a></span>{trailing}"#,
                    email_attr = escape_list_pages_html_attr(email),
                    email_text = escape_list_pages_html_text(email),
                )
            })
            .into_owned()
    }
}
