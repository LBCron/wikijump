/*
 * services/render/ftml_render.rs
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

use super::compat::wikidot_link_protection::ProtectedWikidotWikipediaLink;
use super::diagnostics::{
    CorpusRenderScope, CorpusRenderStage, CorpusRenderTrace, StageGuard,
};
use super::ftml_user_info::UserInfoSnapshot;
use super::service::{
    CorpusReplayStageTimings, ProtectedWikidotCompatLink, RenderProtectionBundle,
    WIKIDOT_LABELED_LINK_REGEX, WIKIDOT_QUADRUPLE_LINK_REGEX,
    WIKIDOT_UNLABELED_LINK_REGEX, native_list_page_link_slug,
};
use crate::services::PageExistenceSnapshot;
use ftml::data::PageRef;
use ftml::prelude::{PageInfo, ParseError, WikitextSettings};
use ftml::render::html::{HtmlOutput, HtmlRender};
use ftml::tree::{CodeBlock, SyntaxTree};
use std::collections::{BTreeMap, HashSet};

#[derive(Debug, Default)]
pub(super) struct WikidotCompatLinkTitleMap {
    titles: BTreeMap<String, String>,
    page_existence: Option<(String, PageExistenceSnapshot)>,
}

impl WikidotCompatLinkTitleMap {
    pub(super) fn new() -> Self {
        Self::default()
    }

    pub(super) fn insert(&mut self, slug: String, title: String) -> Option<String> {
        self.titles.insert(slug, title)
    }

    pub(super) fn title(&self, slug: &str) -> Option<&str> {
        self.titles.get(slug).map(String::as_str)
    }

    pub(super) fn set_page_existence(
        &mut self,
        site_slug: String,
        page_existence: PageExistenceSnapshot,
    ) {
        self.page_existence = Some((site_slug, page_existence));
    }

    pub(super) fn page_is_missing(&self, page_ref: &PageRef) -> bool {
        self.page_existence
            .as_ref()
            .and_then(|(source_site, pages)| {
                pages.known_page_exists(
                    page_ref.site.as_deref().unwrap_or(source_site),
                    &page_ref.page,
                )
            })
            == Some(false)
    }
}

pub(super) fn collect_fallback_page_references(wikitext: &str) -> Vec<PageRef> {
    let targets = WIKIDOT_QUADRUPLE_LINK_REGEX
        .captures_iter(wikitext)
        .chain(WIKIDOT_UNLABELED_LINK_REGEX.captures_iter(wikitext))
        .chain(WIKIDOT_LABELED_LINK_REGEX.captures_iter(wikitext))
        .filter_map(|captures| native_list_page_link_ref(&captures["target"]))
        .collect::<HashSet<_>>();
    targets.into_iter().collect()
}

pub(super) fn native_list_page_link_ref(target: &str) -> Option<PageRef> {
    let target = target.trim();
    if target.starts_with(':') {
        if target.len() > 514
            || target.contains(['?', '&', '=', '#', '/', '|', '<', '>', '"', '\''])
        {
            return None;
        }
        let page_ref = PageRef::parse(target).ok()?;
        let site = page_ref.site.as_deref()?;
        let valid = |value: &str| {
            !value.is_empty()
                && value.chars().all(|character| {
                    character.is_ascii_alphanumeric()
                        || matches!(character, '-' | '_' | ':')
                })
        };
        return (site.len() <= 256
            && page_ref.page.len() <= 256
            && valid(site)
            && valid(&page_ref.page))
        .then_some(page_ref);
    }

    native_list_page_link_slug(target).map(PageRef::page_only)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ftml::layout::Layout;
    use ftml::render::Render;
    use ftml::settings::WikitextMode;
    use std::borrow::Cow;

    fn render_wikidot(source: &str) -> String {
        let page_info = PageInfo {
            page: Cow::Borrowed("test-page"),
            category: None,
            site: Cow::Borrowed("test-site"),
            title: Cow::Borrowed("Test page"),
            alt_title: None,
            score: ftml::data::ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
        let mut source = source.to_owned();
        ftml::preprocess_for_layout(&mut source, settings.layout);
        let tokenization = ftml::tokenize(&source);
        let (tree, errors) = ftml::parse(&tokenization, &page_info, &settings).into();
        assert!(errors.is_empty(), "{errors:?}");
        HtmlRender.render(&tree, &page_info, &settings).body
    }

    #[test]
    fn pinned_ftml_keeps_newline_after_aligned_image_at_paragraph_break() {
        let html = render_wikidot(
            "[[f>image landscape.jpg]]\n\nEXTERNAL [[image https://example.com/some-image.webp]]",
        );
        assert!(html.contains("</div>\nEXTERNAL "), "{html}");
    }

    #[test]
    fn pinned_ftml_resizes_page_qualified_attachments_on_the_owning_page() {
        let html = render_wikidot("[[image other-page/photo.jpeg]]");
        assert!(
            html.contains(
                "<a href=\"https://test-site.wjfiles.com/local--files/other-page/photo.jpeg\">"
            ),
            "{html}"
        );
        assert!(
            html.contains(
                "https://test-site.wjfiles.com/local--resized-images/other-page/photo.jpeg/medium.jpg"
            ),
            "{html}"
        );

        let html = render_wikidot("[[image other-page/photo.png]]");
        assert!(
            html.contains(
                "https://test-site.wjfiles.com/local--files/other-page/photo.png"
            ),
            "{html}"
        );
        assert!(!html.contains("local--resized-images"), "{html}");

        let html = render_wikidot("[[image photo.jpeg]]");
        assert!(
            html.contains(
                "https://test-site.wjfiles.com/local--resized-images/test-page/photo.jpeg/medium.jpg"
            ),
            "{html}"
        );
    }

    #[test]
    fn pinned_ftml_reads_attachment_trees_serialized_before_the_page_field() {
        let source: ftml::tree::ImageSource = serde_json::from_str(
            r#"{"type":"implicit-attachment","data":{"file":"photo.jpeg","alt":"photo.jpeg","size":"medium"}}"#,
        )
        .expect("pre-#744 tree should deserialize");
        assert!(
            matches!(
                source,
                ftml::tree::ImageSource::ImplicitAttachment { page: None, .. }
            ),
            "{source:?}"
        );
    }

    #[test]
    fn fallback_page_references_keep_local_and_cross_site_targets() {
        let references = collect_fallback_page_references(
            "[[[local]]]\n[[[:remote:page|label]]]\n[[[https://example.com|web]]]",
        )
        .into_iter()
        .collect::<HashSet<_>>();

        assert_eq!(
            references,
            HashSet::from([
                PageRef::page_only("local"),
                PageRef::page_and_site("remote", "page"),
            ])
        );
    }
}

#[derive(Debug)]
pub(super) struct InnerPreparedRenderWikitext {
    pub(super) wikitext: String,
    pub(super) included_pages: Vec<PageRef>,
    pub(super) protection: RenderProtectionBundle,
    pub(super) wikidot_compat_links: Vec<ProtectedWikidotCompatLink>,
    pub(super) wikidot_wikipedia_links: Vec<ProtectedWikidotWikipediaLink>,
    pub(super) wikidot_embed_iframes: Vec<String>,
    pub(super) timings: CorpusReplayStageTimings,
}

#[derive(Debug)]
pub(super) struct ParsedFtmlRender {
    pub(super) prepared: InnerPreparedRenderWikitext,
    pub(super) tree: SyntaxTree<'static>,
    pub(super) errors: Vec<ParseError>,
}

impl ParsedFtmlRender {
    pub(super) fn parse(
        prepared: InnerPreparedRenderWikitext,
        page_info: &PageInfo<'_>,
        settings: &WikitextSettings,
        trace: Option<(&CorpusRenderTrace, CorpusRenderScope)>,
    ) -> Self {
        if let Some((trace, scope)) = trace {
            trace.add_us(
                scope,
                CorpusRenderStage::InnerProtect,
                prepared.timings.inner_protection_us,
            );
            trace.add_us(
                scope,
                CorpusRenderStage::Preprocess,
                prepared.timings.preprocess_us,
            );
        }
        let tokens = {
            let _stage = StageGuard::new(trace, CorpusRenderStage::Tokenize);
            ftml::tokenize(&prepared.wikitext)
        };
        let result = {
            let _stage = StageGuard::new(trace, CorpusRenderStage::Parse);
            ftml::parse(&tokens, page_info, settings)
        };
        let (tree, errors) = result.into();
        let tree = tree.to_owned();

        Self {
            prepared,
            tree,
            errors,
        }
    }

    pub(super) fn render(
        &self,
        page_info: &PageInfo<'_>,
        settings: &WikitextSettings,
        page_existence: Option<&crate::services::PageExistenceSnapshot>,
        user_info: &UserInfoSnapshot,
        trace: Option<(&CorpusRenderTrace, CorpusRenderScope)>,
    ) -> HtmlOutput {
        let _stage = StageGuard::new(trace, CorpusRenderStage::HtmlRender);
        match page_existence {
            Some(page_existence) => HtmlRender.render_with_resolvers(
                &self.tree,
                page_info,
                settings,
                page_existence,
                user_info,
            ),
            None => HtmlRender
                .render_with_user_info(&self.tree, page_info, settings, user_info),
        }
    }
}

#[derive(Debug)]
pub(super) struct FtmlRenderOutput {
    pub(super) html_output: HtmlOutput,
    pub(super) errors: Vec<ParseError>,
    pub(super) html_block_texts: Vec<String>,
    pub(super) code_blocks: Vec<CodeBlock<'static>>,
}
