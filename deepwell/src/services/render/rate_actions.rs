/*
 * services/render/rate_actions.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::LegacyActionDescriptor;
use crate::hash::k12_hash;
use crate::services::settings::PageRatingType;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case", tag = "type")]
pub enum RateBrowserAction {
    Rate {
        index: usize,
        fingerprint: String,
        value: i16,
    },
    RateCancel {
        index: usize,
        fingerprint: String,
    },
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RateBrowserActionRegistry {
    pub site_id: i64,
    pub page_id: i64,
    pub revision_id: i64,
    pub current_value: Option<i16>,
    pub actions: Vec<RateBrowserAction>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RateActionRegistry {
    rating_type: PageRatingType,
    module_count: usize,
    actions: Vec<LegacyActionDescriptor>,
}

impl RateActionRegistry {
    pub(in crate::services::render) fn for_rendered_modules(
        module_count: usize,
        rating_type: PageRatingType,
    ) -> Self {
        let mut actions = Vec::with_capacity(
            module_count
                * match rating_type {
                    PageRatingType::Plus => 2,
                    PageRatingType::PlusMinus => 3,
                    PageRatingType::Stars => 5,
                },
        );
        for _ in 0..module_count {
            match rating_type {
                PageRatingType::Plus => {
                    actions.push(LegacyActionDescriptor::Rate(1));
                    actions.push(LegacyActionDescriptor::CancelRate);
                }
                PageRatingType::PlusMinus => {
                    actions.push(LegacyActionDescriptor::Rate(1));
                    actions.push(LegacyActionDescriptor::Rate(-1));
                    actions.push(LegacyActionDescriptor::CancelRate);
                }
                PageRatingType::Stars => {
                    actions.extend((1..=5).map(LegacyActionDescriptor::Rate));
                }
            }
        }
        Self {
            rating_type,
            module_count,
            actions,
        }
    }

    pub fn resolve(
        &self,
        index: usize,
        fingerprint: &str,
    ) -> Option<&LegacyActionDescriptor> {
        (self.fingerprint(index).as_deref() == Some(fingerprint))
            .then(|| self.actions.get(index))
            .flatten()
    }

    pub fn is_empty(&self) -> bool {
        self.actions.is_empty()
    }

    fn fingerprint(&self, index: usize) -> Option<String> {
        let descriptor = self.actions.get(index)?;
        let mut input = b"wikijump-rate-action\0".to_vec();
        input.extend_from_slice(&index.to_le_bytes());
        match descriptor {
            LegacyActionDescriptor::Rate(value) => {
                input.push(b'r');
                input.extend_from_slice(&value.to_le_bytes());
            }
            LegacyActionDescriptor::CancelRate => input.push(b'c'),
            _ => return None,
        }
        Some(hex::encode(k12_hash(&input)))
    }

    fn browser_actions(&self) -> Vec<RateBrowserAction> {
        self.actions
            .iter()
            .enumerate()
            .map(|(index, descriptor)| {
                let fingerprint = self
                    .fingerprint(index)
                    .expect("Rate descriptors always have fingerprints");
                match descriptor {
                    LegacyActionDescriptor::Rate(value) => RateBrowserAction::Rate {
                        index,
                        fingerprint,
                        value: *value,
                    },
                    LegacyActionDescriptor::CancelRate => {
                        RateBrowserAction::RateCancel { index, fingerprint }
                    }
                    _ => unreachable!("Rate registries contain only Rate descriptors"),
                }
            })
            .collect()
    }

    pub fn browser_registry_for_wikidot_html(
        &self,
        body: &str,
        site_id: i64,
        page_id: i64,
        revision_id: i64,
        current_value: Option<i16>,
    ) -> Option<RateBrowserActionRegistry> {
        if self.module_count == 0 || !self.matches_rendered_html(body) {
            return None;
        }
        Some(RateBrowserActionRegistry {
            site_id,
            page_id,
            revision_id,
            current_value,
            actions: self.browser_actions(),
        })
    }

    fn matches_rendered_html(&self, body: &str) -> bool {
        let point_widgets = body.matches(r#"class="page-rate-widget-box""#).count();
        let star_widgets = body.matches(r#"class="page-rate-widget""#).count();
        let star_starts = body.matches(r#"class="page-rate-widget-start""#).count();
        let up_controls = body.matches(r#"class="rateup btn btn-default""#).count();
        let down_controls = body.matches(r#"class="ratedown btn btn-default""#).count();
        let cancel_controls = body.matches(r#"class="cancel btn btn-default""#).count();
        let up_handlers = body
            .matches(
                r#"onclick="WIKIDOT.modules.PageRateWidgetModule.listeners.rate(event, 1)""#,
            )
            .count();
        let down_handlers = body
            .matches(
                r#"onclick="WIKIDOT.modules.PageRateWidgetModule.listeners.rate(event, -1)""#,
            )
            .count();
        let cancel_handlers = body
            .matches(
                r#"onclick="WIKIDOT.modules.PageRateWidgetModule.listeners.cancelVote(event)""#,
            )
            .count();

        match self.rating_type {
            PageRatingType::Plus => {
                point_widgets == self.module_count
                    && star_widgets == 0
                    && star_starts == 0
                    && up_controls == self.module_count
                    && up_handlers == self.module_count
                    && down_controls == 0
                    && down_handlers == 0
                    && cancel_controls == self.module_count
                    && cancel_handlers == self.module_count
            }
            PageRatingType::PlusMinus => {
                point_widgets == self.module_count
                    && star_widgets == 0
                    && star_starts == 0
                    && up_controls == self.module_count
                    && up_handlers == self.module_count
                    && down_controls == self.module_count
                    && down_handlers == self.module_count
                    && cancel_controls == self.module_count
                    && cancel_handlers == self.module_count
            }
            PageRatingType::Stars => {
                point_widgets == 0
                    && star_widgets == self.module_count
                    && star_starts == self.module_count
                    && up_controls == 0
                    && down_controls == 0
                    && cancel_controls == 0
                    && up_handlers == 0
                    && down_handlers == 0
                    && cancel_handlers == 0
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn point_registry_rejects_authored_control_cardinality_drift() {
        let registry =
            RateActionRegistry::for_rendered_modules(1, PageRatingType::PlusMinus);
        let body = crate::services::render::rate_module::render_read_only_rate_module(
            ftml::data::ScoreValue::Integer(0),
            "en",
            PageRatingType::PlusMinus,
        );
        let browser = registry
            .browser_registry_for_wikidot_html(&body, 7, 42, 91, Some(-1))
            .expect("the exact renderer output should receive a sidecar");
        assert_eq!(browser.site_id, 7);
        assert_eq!(browser.page_id, 42);
        assert_eq!(browser.revision_id, 91);
        assert_eq!(browser.current_value, Some(-1));
        assert_eq!(browser.actions.len(), 3);

        let forged = format!("{body}{body}");
        assert!(
            registry
                .browser_registry_for_wikidot_html(&forged, 7, 42, 91, None)
                .is_none(),
        );
    }

    #[test]
    fn star_registry_owns_only_values_one_through_five() {
        let registry = RateActionRegistry::for_rendered_modules(1, PageRatingType::Stars);
        let body =
            crate::services::render::rate_module::render_read_only_star_rate_module(
                ftml::data::ScoreValue::Integer(0),
                Some(0),
                "",
            );
        let browser = registry
            .browser_registry_for_wikidot_html(&body, 7, 42, 91, None)
            .expect("the exact star renderer output should receive a sidecar");
        assert_eq!(
            browser
                .actions
                .iter()
                .map(|action| match action {
                    RateBrowserAction::Rate { value, .. } => *value,
                    RateBrowserAction::RateCancel { .. } => 0,
                })
                .collect::<Vec<_>>(),
            [1, 2, 3, 4, 5],
        );
        assert!(
            browser
                .actions
                .iter()
                .all(|action| matches!(action, RateBrowserAction::Rate { .. })),
            "the evidenced five-star widget has no cancel control",
        );
        for (index, action) in browser.actions.iter().enumerate() {
            let fingerprint = match action {
                RateBrowserAction::Rate { fingerprint, .. }
                | RateBrowserAction::RateCancel { fingerprint, .. } => fingerprint,
            };
            assert!(registry.resolve(index, fingerprint).is_some());
            assert!(
                registry
                    .resolve(index, "00000000000000000000000000000000")
                    .is_none()
            );
        }
    }

    #[test]
    fn star_registry_rejects_cross_index_fingerprint_reuse() {
        let registry = RateActionRegistry::for_rendered_modules(1, PageRatingType::Stars);
        let body =
            crate::services::render::rate_module::render_read_only_star_rate_module(
                ftml::data::ScoreValue::Integer(0),
                Some(0),
                "",
            );
        let browser = registry
            .browser_registry_for_wikidot_html(&body, 7, 42, 91, None)
            .expect("the exact star renderer output should receive a sidecar");
        let fingerprints: Vec<&str> = browser
            .actions
            .iter()
            .map(|action| match action {
                RateBrowserAction::Rate { fingerprint, .. }
                | RateBrowserAction::RateCancel { fingerprint, .. } => {
                    fingerprint.as_str()
                }
            })
            .collect();
        assert_eq!(fingerprints.len(), 5);
        for (index, fingerprint) in fingerprints.iter().enumerate() {
            assert!(
                registry.resolve(index, fingerprint).is_some(),
                "the exact pair at index {index} must resolve",
            );
            let other = (index + 1) % fingerprints.len();
            assert!(
                registry.resolve(other, fingerprint).is_none(),
                "the fingerprint at index {index} must not resolve at index {other}",
            );
        }
        assert!(
            registry
                .resolve(fingerprints.len(), fingerprints[0])
                .is_none(),
            "an out-of-range index must not resolve",
        );
    }
}
