/*
 * services/render/legacy_actions.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use crate::hash::k12_hash;
use ftml::data::{PageInfo, ScoreValue};
use ftml::layout::Layout;
use ftml::render::Render;
use ftml::render::html::{HtmlRender, HtmlResourceRequirement};
use ftml::settings::{WikitextMode, WikitextSettings};
use ftml::tree::{StandaloneButtonAction, TagAlteration};
use std::borrow::Cow;
use std::time::Duration;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LegacyActionDescriptor {
    Edit,
    History,
    Source,
    Print,
    SetTags(Vec<TagAlteration<'static>>),
    Rate(i16),
    CancelRate,
}

impl LegacyActionDescriptor {
    pub fn rate(value: i16) -> Option<Self> {
        (value == -1 || (1..=5).contains(&value)).then_some(Self::Rate(value))
    }

    pub const fn cancel_rate() -> Self {
        Self::CancelRate
    }

    pub fn apply_to_tags(&self, current: &[String]) -> Option<Vec<String>> {
        let Self::SetTags(alterations) = self else {
            return None;
        };
        let clear_visible = alterations
            .iter()
            .any(|item| matches!(item, TagAlteration::ClearVisible));
        let clear_hidden = alterations
            .iter()
            .any(|item| matches!(item, TagAlteration::ClearHidden));
        let removed = alterations
            .iter()
            .filter_map(|item| match item {
                TagAlteration::Remove(tag) => Some(tag.as_ref()),
                _ => None,
            })
            .collect::<Vec<_>>();
        let added = alterations
            .iter()
            .filter_map(|item| match item {
                TagAlteration::Add(tag) => Some(tag.as_ref()),
                _ => None,
            })
            .collect::<Vec<_>>();
        let mut output = current
            .iter()
            .filter(|tag| {
                !(removed.contains(&tag.as_str())
                    || added.contains(&tag.as_str())
                    || clear_visible && !tag.starts_with('_')
                    || clear_hidden && tag.starts_with('_'))
            })
            .cloned()
            .collect::<Vec<_>>();
        for tag in added {
            if !output.iter().any(|existing| existing == tag) {
                output.push(tag.to_owned());
            }
        }
        Some(output)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case", tag = "type")]
pub enum LegacyBrowserAction {
    Edit,
    History,
    Source,
    Print,
    SetTags { index: usize, fingerprint: String },
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct RegisteredLegacyAction {
    renderer_id: String,
    descriptor: LegacyActionDescriptor,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct LegacyActionRegistry {
    actions: Vec<RegisteredLegacyAction>,
}

impl LegacyActionRegistry {
    pub fn from_resource_requirements(requirements: &[HtmlResourceRequirement]) -> Self {
        let actions = requirements
            .iter()
            .filter_map(|requirement| {
                let requirement = requirement.standalone_button_requirement()?;
                let descriptor = match requirement.action() {
                    StandaloneButtonAction::Edit => LegacyActionDescriptor::Edit,
                    StandaloneButtonAction::History => LegacyActionDescriptor::History,
                    StandaloneButtonAction::Source => LegacyActionDescriptor::Source,
                    StandaloneButtonAction::Print => LegacyActionDescriptor::Print,
                    StandaloneButtonAction::SetTags(alterations) => {
                        LegacyActionDescriptor::SetTags(
                            alterations.iter().map(TagAlteration::to_owned).collect(),
                        )
                    }
                };
                Some(RegisteredLegacyAction {
                    renderer_id: requirement.id().to_owned(),
                    descriptor,
                })
            })
            .collect();
        Self { actions }
    }

    pub fn from_wikidot_source(source: &str) -> Self {
        let mut source = source.to_owned();
        let page_info = PageInfo {
            page: Cow::Borrowed("legacy-action"),
            category: None,
            site: Cow::Borrowed("legacy-action"),
            title: Cow::Borrowed("Legacy action"),
            alt_title: None,
            score: ScoreValue::Integer(0),
            tags: Vec::new(),
            language: Cow::Borrowed("en"),
        };
        let settings = WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
        ftml::preprocess_for_layout(&mut source, settings.layout);
        let tokens = ftml::tokenize(&source);
        let (tree, _) = ftml::parse(&tokens, &page_info, &settings).into();
        let output = HtmlRender.render(&tree, &page_info, &settings);
        Self::from_resource_requirements(&output.resource_requirements)
    }

    pub async fn from_wikidot_source_bounded(
        source: String,
        timeout_duration: Duration,
    ) -> Option<Self> {
        tokio::time::timeout(
            timeout_duration,
            tokio::task::spawn_blocking(move || Self::from_wikidot_source(&source)),
        )
        .await
        .ok()?
        .ok()
    }

    pub fn get(&self, index: usize) -> Option<&LegacyActionDescriptor> {
        self.actions.get(index).map(|action| &action.descriptor)
    }

    pub fn remove_renderer_ids_from_wikidot_html(&self, body: &mut String) {
        for action in &self.actions {
            let renderer_id_attribute = format!(r#" id="{}""#, action.renderer_id);
            *body = body.replacen(&renderer_id_attribute, "", 1);
        }
    }

    pub fn browser_actions(&self) -> Vec<LegacyBrowserAction> {
        self.actions
            .iter()
            .enumerate()
            .map(|(index, action)| match &action.descriptor {
                LegacyActionDescriptor::Edit => LegacyBrowserAction::Edit,
                LegacyActionDescriptor::History => LegacyBrowserAction::History,
                LegacyActionDescriptor::Source => LegacyBrowserAction::Source,
                LegacyActionDescriptor::Print => LegacyBrowserAction::Print,
                LegacyActionDescriptor::SetTags(_) => LegacyBrowserAction::SetTags {
                    index,
                    fingerprint: self
                        .fingerprint(index)
                        .expect("set-tags descriptors have fingerprints"),
                },
                LegacyActionDescriptor::Rate(_) | LegacyActionDescriptor::CancelRate => {
                    unreachable!(
                        "rate actions are not FTML standalone button requirements"
                    )
                }
            })
            .collect()
    }

    pub fn browser_actions_for_wikidot_html(
        &self,
        body: &str,
    ) -> Option<Vec<LegacyBrowserAction>> {
        let actions = self.browser_actions();
        let controls = body.matches(r#"href="javascript:;""#).count();
        (controls == actions.len()).then_some(actions)
    }

    pub fn fingerprint(&self, index: usize) -> Option<String> {
        let LegacyActionDescriptor::SetTags(alterations) = self.get(index)? else {
            return None;
        };
        let mut input = b"wikijump-legacy-set-tags\0".to_vec();
        input.extend(
            serde_json::to_vec(alterations)
                .expect("FTML tag alterations always serialize"),
        );
        Some(hex::encode(k12_hash(&input)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn source_registry_uses_the_bounded_worker_path() {
        let registry = LegacyActionRegistry::from_wikidot_source_bounded(
            "[[button Edit]]".to_owned(),
            Duration::from_secs(1),
        )
        .await
        .expect("a small source should finish within the render budget");
        assert_eq!(registry.browser_actions().len(), 1);
    }

    #[test]
    fn set_tags_removes_before_adding_and_preserves_hidden_boundaries() {
        let descriptor = LegacyActionDescriptor::SetTags(vec![
            TagAlteration::Add(Cow::Borrowed("favorite")),
            TagAlteration::ClearVisible,
            TagAlteration::Add(Cow::Borrowed("_book")),
            TagAlteration::Remove(Cow::Borrowed("_movie")),
        ]);

        let tags = descriptor
            .apply_to_tags(&[
                "favorite".to_owned(),
                "ordinary".to_owned(),
                "_movie".to_owned(),
                "_kept".to_owned(),
            ])
            .expect("set-tags descriptor should apply");
        assert_eq!(
            tags,
            vec![
                "_kept".to_owned(),
                "favorite".to_owned(),
                "_book".to_owned(),
            ],
        );
        assert_eq!(descriptor.apply_to_tags(&tags), Some(tags.clone()));
    }

    #[test]
    fn source_registry_keeps_typed_order_and_drops_authored_script() {
        let registry = LegacyActionRegistry::from_wikidot_source(concat!(
            "[[button edit onclick=\"alert(1)\"]]\n",
            "[[button set-tags -* +favorite text=\"Change\"]]\n",
            "[[button print]]",
        ));

        assert_eq!(registry.get(0), Some(&LegacyActionDescriptor::Edit));
        assert!(matches!(
            registry.get(1),
            Some(LegacyActionDescriptor::SetTags(_))
        ));
        assert_eq!(registry.get(2), Some(&LegacyActionDescriptor::Print));
        assert_eq!(registry.get(3), None);
        assert_eq!(
            registry.browser_actions(),
            [
                LegacyBrowserAction::Edit,
                LegacyBrowserAction::SetTags {
                    index: 1,
                    fingerprint: registry.fingerprint(1).unwrap(),
                },
                LegacyBrowserAction::Print,
            ],
        );
    }

    /// Live PagePreview controls for standalone buttons (sandbox-for-codex,
    /// identical for anonymous, member, and non-member actors): exact labels,
    /// classes, listener hooks, safe style passthrough, and exact error
    /// blocks for the missing-text and unknown-action shapes. The styled
    /// source row asserts attributes without order because FTML emits style
    /// after onclick while live emits it before href; order is cosmetic and
    /// owned by the FTML renderer.
    #[test]
    fn standalone_button_preview_matches_live_control_dom() {
        fn render(source: &str) -> String {
            let mut source = source.to_owned();
            let page_info = PageInfo {
                page: Cow::Borrowed("legacy-action"),
                category: None,
                site: Cow::Borrowed("legacy-action"),
                title: Cow::Borrowed("Legacy action"),
                alt_title: None,
                score: ScoreValue::Integer(0),
                tags: Vec::new(),
                language: Cow::Borrowed("en"),
            };
            let settings =
                WikitextSettings::from_mode(WikitextMode::Page, Layout::Wikidot);
            ftml::preprocess_for_layout(&mut source, settings.layout);
            let tokens = ftml::tokenize(&source);
            let (tree, _) = ftml::parse(&tokens, &page_info, &settings).into();
            HtmlRender.render(&tree, &page_info, &settings).body
        }

        assert!(render("[[button history]]").contains(
            r#"<a class="wiki-standalone-button" href="javascript:;" onclick="WIKIDOT.page.listeners.historyClick(event)">history</a>"#
        ));
        assert!(render("[[button edit text=\"Create\"]]").contains(
            r#"<a class="wiki-standalone-button" href="javascript:;" onclick="WIKIDOT.page.listeners.editClick(event)">Create</a>"#
        ));
        let styled = render("[[button source style=\"color: #444\"]]");
        for expected in [
            r#"class="wiki-standalone-button""#,
            r#"style="color: #444""#,
            r#"href="javascript:;""#,
            r#"onclick="WIKIDOT.page.listeners.viewSourceClick(event)""#,
            ">view source</a>",
        ] {
            assert!(
                styled.contains(expected),
                "styled source control should contain {expected:?}:\n{styled}",
            );
        }
        assert!(render("[[button set-tags +tag1 -tag2]]").contains(
            r#"<div class="error-block">You need to set text for set-tags button.</div>"#
        ));
        assert!(render("[[button frobnicate]]").contains(
            r#"<div class="error-block"><em>frobnicate</em> is not a valid button type</div>"#
        ));
        assert!(render("[[button edit text=\"A\" text=\"B\"]]").contains(">B</a>"));
        assert!(render("[[button print]]").contains(
            r#"<a class="wiki-standalone-button" href="javascript:;" onclick="WIKIDOT.page.listeners.printClick(event)">print</a>"#
        ));
        // Live emits raw single quotes around the alterations while FTML
        // HTML-escapes them as &#39;; both parse to the identical DOM
        // string, so the pin covers hook, order, content, label, and class
        // while the cosmetic escaping delta stays an FTML-owned residual
        // (same for the style-attribute order covered above).
        let set_tags = render("[[button set-tags +tag1 -tag2 text=\"Change tags\"]]");
        for expected in [
            r#"class="wiki-standalone-button""#,
            r#"href="javascript:;""#,
            "WIKIDOT.page.listeners.updateTagsByButton(event,",
            "+tag1 -tag2",
            ">Change tags</a>",
        ] {
            assert!(
                set_tags.contains(expected),
                "set-tags control should contain {expected:?}:\n{set_tags}",
            );
        }
    }

    #[test]
    fn wikidot_html_keeps_exact_control_shape_without_private_identifiers() {
        let mut body = r#"<p><a class="g07-print-class" id="wj-button-abc" href="javascript:;">print</a></p>"#.to_owned();
        let registry = LegacyActionRegistry {
            actions: vec![RegisteredLegacyAction {
                renderer_id: "wj-button-abc".to_owned(),
                descriptor: LegacyActionDescriptor::Print,
            }],
        };

        registry.remove_renderer_ids_from_wikidot_html(&mut body);

        assert_eq!(
            body,
            r#"<p><a class="g07-print-class" href="javascript:;">print</a></p>"#,
        );
        assert!(!body.contains("wikijump"));
        assert!(!body.contains("wj-"));
        assert_eq!(
            registry.browser_actions_for_wikidot_html(&body),
            Some(vec![LegacyBrowserAction::Print]),
        );
        assert_eq!(
            registry.browser_actions_for_wikidot_html("<p>no matching control</p>"),
            None,
        );
    }
}
