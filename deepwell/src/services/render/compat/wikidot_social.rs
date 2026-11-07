/*
 * services/render/compat/wikidot_social.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::super::list_pages::render_wikidot_social_module;
use super::super::service::RenderService;
use crate::models::site::Model as SiteModel;
use ftml::prelude::PageInfo;
use ftml::render::html::HtmlOutput;
use std::collections::HashSet;

const WIKIDOT_SOCIAL_MARKER_CLASS: &str = "wj-social";

impl RenderService {
    pub(in crate::services::render) fn resolve_wikidot_social_requirements(
        html_output: &mut HtmlOutput,
        page_info: &PageInfo<'_>,
        current_site: Option<&SiteModel>,
        page_preview: bool,
    ) -> bool {
        let endpoint = if page_preview || page_info.page.is_empty() {
            format!(
                "http://{}.wikidot.com/ajax-module-connector.php",
                page_info.site
            )
        } else {
            let full_slug = Self::page_info_full_slug(page_info);
            format!("http://{}.wikidot.com/{full_slug}", page_info.site)
        };
        let site_name = current_site.map_or("", |site| site.name.as_str());
        let mut requirement_ids = HashSet::new();
        let mut social_ids = HashSet::new();
        let mut replacements = Vec::new();

        for requirement in &html_output.resource_requirements {
            let Some(requirement) = requirement.social_requirement() else {
                continue;
            };
            let id = requirement.id();
            if !requirement_ids.insert(id) {
                return false;
            }
            let marker = format!(
                r#"<span class="{WIKIDOT_SOCIAL_MARKER_CLASS}" id="{id}"></span>"#
            );
            if html_output.body.match_indices(&marker).count() != 1 {
                return false;
            }

            let social_id = next_social_id(id, &mut social_ids);
            let replacement = render_wikidot_social_module(
                requirement.social(),
                &endpoint,
                site_name,
                &social_id,
            );
            replacements.push((marker, replacement));
        }

        let mut resolved = html_output.body.clone();
        for (marker, replacement) in replacements {
            resolved = resolved.replacen(&marker, &replacement, 1);
        }
        if resolved.contains(&format!(r#"class="{WIKIDOT_SOCIAL_MARKER_CLASS}""#)) {
            return false;
        }
        html_output.body = resolved;
        true
    }
}

fn next_social_id(requirement_id: &str, used: &mut HashSet<u32>) -> String {
    let mut hash = requirement_id.bytes().fold(5381_u32, |hash, byte| {
        hash.wrapping_mul(33).wrapping_add(u32::from(byte))
    });
    loop {
        let nonce = 10_000 + hash % 90_000;
        if used.insert(nonce) {
            return format!("social{nonce}");
        }
        hash = hash.wrapping_add(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ftml::data::{PageInfo, ScoreValue};
    use ftml::layout::Layout;
    use ftml::render::{Render, html::HtmlRender};
    use ftml::settings::{WikitextMode, WikitextSettings};
    use std::borrow::Cow;

    fn page_info() -> PageInfo<'static> {
        PageInfo {
            page: Cow::Borrowed("scp-123"),
            category: None,
            site: Cow::Borrowed("scp-wiki"),
            title: Cow::Borrowed("SCP-123"),
            alt_title: None,
            score: ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        }
    }

    fn ftml_social_output(source: &str) -> HtmlOutput {
        let page_info = page_info();
        let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
        let tokens = ftml::tokenize(source);
        let (tree, errors) = ftml::parse(&tokens, &page_info, &settings).into();
        assert!(errors.is_empty(), "{errors:#?}");
        HtmlRender.render(&tree, &page_info, &settings)
    }

    #[test]
    fn generated_social_ids_are_legacy_shaped_and_unique() {
        let mut used = HashSet::new();
        let first =
            next_social_id("wj-social-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", &mut used);
        let second =
            next_social_id("wj-social-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", &mut used);
        assert!(first.starts_with("social"));
        assert_eq!(first.len(), 11);
        assert!(first[6..].bytes().all(|byte| byte.is_ascii_digit()));
        assert_ne!(first, second);
    }

    #[test]
    fn typed_social_requirement_renders_live_provider_shape_for_page_preview() {
        let mut output = ftml_social_output("[[social reddit,FACEBOOK,facebook]]");
        assert!(output.body.contains("wj-social"));
        assert!(RenderService::resolve_wikidot_social_requirements(
            &mut output,
            &page_info(),
            None,
            true,
        ));

        assert!(!output.body.contains("wj-social"));
        assert!(output.body.contains("title=\"Reddit\""));
        assert!(output.body.contains("title=\"Facebook\""));
        assert!(!output.body.contains("title=\"BlinkList\""));
        assert!(
            output.body.contains(
                "http%3A%2F%2Fscp-wiki.wikidot.com%2Fajax-module-connector.php"
            )
        );
        assert!(
            output
                .body
                .contains("https://d3g0gp89917ko0.cloudfront.net/v--1e049c54eb7c/common--images/social/reddit.png")
        );
        assert!(!output.body.contains("v--7690939296dc"));
        assert!(output.body.contains("encodeURIComponent(document.title)"));
    }

    #[test]
    fn saved_page_social_requirement_uses_the_page_url() {
        let mut output = ftml_social_output("[[social reddit]]");
        assert!(RenderService::resolve_wikidot_social_requirements(
            &mut output,
            &page_info(),
            None,
            false,
        ));
        assert!(
            output
                .body
                .contains("http%3A%2F%2Fscp-wiki.wikidot.com%2Fscp-123")
        );
        assert!(!output.body.contains("ajax-module-connector.php"));
    }

    #[test]
    fn invalid_only_social_selection_renders_an_empty_legacy_span() {
        let mut output = ftml_social_output("[[social Reddit,FACEBOOK]]");
        assert!(RenderService::resolve_wikidot_social_requirements(
            &mut output,
            &page_info(),
            None,
            true,
        ));
        assert!(output.body.contains("<span id=\"social"));
        assert_eq!(output.body.matches("<a href=\"\"").count(), 2);
        assert_eq!(output.body.matches("title=\"\"").count(), 2);
        assert!(output.body.contains("getElementsByTagName(\"a\")"));
    }
}
