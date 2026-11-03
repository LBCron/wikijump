/*
 * services/render/membership_actions.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::runtime_modules::{
    join_module_action_count, membership_apply_action_count,
    membership_by_password_action_count, membership_email_invitation_action_count,
};
use crate::hash::k12_hash;
use crate::services::membership::MembershipBrowserAction;

const JOIN_ONCLICK: &str = r#"onclick="WIKIDOT.page.listeners.join(event, 'unified')""#;
const APPLICATION_CONTROL: &str = r#"id="mba-apply""#;
const PASSWORD_CONTROL: &str = r#"id="mbp-apply""#;
const INVITATION_CONTROL: &str =
    "WIKIDOT.modules.MembershipEmailInvitationModule.listeners.accept";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MembershipActionKind {
    Join,
    Application,
    Password,
    Invitation,
}

impl MembershipActionKind {
    const fn discriminator(self) -> &'static [u8] {
        match self {
            Self::Join => b"join",
            Self::Application => b"application",
            Self::Password => b"password",
            Self::Invitation => b"invitation",
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum MembershipActionAvailability {
    #[default]
    Disabled,
    Available(usize),
}

impl MembershipActionAvailability {
    fn from_source(source: &str, count: usize, authored_marker: &str) -> Self {
        if source.contains(authored_marker) {
            Self::Disabled
        } else {
            Self::Available(count)
        }
    }

    fn count(self) -> Option<usize> {
        match self {
            Self::Disabled => None,
            Self::Available(count) => Some(count),
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct MembershipActionRegistry {
    join: MembershipActionAvailability,
    application: MembershipActionAvailability,
    password: MembershipActionAvailability,
    invitation: MembershipActionAvailability,
}

impl MembershipActionRegistry {
    pub fn from_wikidot_source(source: &str) -> Self {
        Self {
            join: MembershipActionAvailability::from_source(
                source,
                join_module_action_count(source),
                "WIKIDOT.page.listeners.join",
            ),
            application: MembershipActionAvailability::from_source(
                source,
                membership_apply_action_count(source),
                APPLICATION_CONTROL,
            ),
            password: MembershipActionAvailability::from_source(
                source,
                membership_by_password_action_count(source),
                PASSWORD_CONTROL,
            ),
            invitation: MembershipActionAvailability::from_source(
                source,
                membership_email_invitation_action_count(source),
                INVITATION_CONTROL,
            ),
        }
    }

    pub fn resolve(&self, index: usize, fingerprint: &str) -> bool {
        self.resolve_kind(MembershipActionKind::Join, index, fingerprint)
    }

    pub fn resolve_kind(
        &self,
        kind: MembershipActionKind,
        index: usize,
        fingerprint: &str,
    ) -> bool {
        self.fingerprint(kind, index).as_deref() == Some(fingerprint)
    }

    fn availability(&self, kind: MembershipActionKind) -> MembershipActionAvailability {
        match kind {
            MembershipActionKind::Join => self.join,
            MembershipActionKind::Application => self.application,
            MembershipActionKind::Password => self.password,
            MembershipActionKind::Invitation => self.invitation,
        }
    }

    fn fingerprint(&self, kind: MembershipActionKind, index: usize) -> Option<String> {
        if index >= self.availability(kind).count()? {
            return None;
        }
        let mut input = b"wikijump-membership-action\0".to_vec();
        input.extend_from_slice(kind.discriminator());
        input.push(0);
        input.extend_from_slice(&index.to_le_bytes());
        Some(hex::encode(k12_hash(&input)))
    }

    pub fn browser_actions_for_saved_wikidot_html(
        &self,
        body: &str,
        page_id: i64,
        revision_id: i64,
    ) -> Vec<MembershipBrowserAction> {
        let mut actions = Vec::new();
        for (kind, marker) in [
            (MembershipActionKind::Join, JOIN_ONCLICK),
            (MembershipActionKind::Application, APPLICATION_CONTROL),
            (MembershipActionKind::Password, PASSWORD_CONTROL),
            (MembershipActionKind::Invitation, INVITATION_CONTROL),
        ] {
            let Some(source_count) = self.availability(kind).count() else {
                continue;
            };
            let rendered_count = body.matches(marker).count();
            if rendered_count == 0 || rendered_count != source_count {
                continue;
            }
            for index in 0..rendered_count {
                let fingerprint = self.fingerprint(kind, index).expect(
                    "each rendered membership control has a registry fingerprint",
                );
                actions.push(match kind {
                    MembershipActionKind::Join => MembershipBrowserAction::Join {
                        page_id,
                        revision_id,
                        index,
                        fingerprint,
                    },
                    MembershipActionKind::Application => {
                        MembershipBrowserAction::Application {
                            page_id,
                            revision_id,
                            index,
                            fingerprint,
                        }
                    }
                    MembershipActionKind::Password => MembershipBrowserAction::Password {
                        page_id,
                        revision_id,
                        index,
                        fingerprint,
                    },
                    MembershipActionKind::Invitation => {
                        MembershipBrowserAction::Invitation {
                            page_id,
                            revision_id,
                            index,
                            fingerprint,
                        }
                    }
                });
            }
        }
        actions
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authored_join_listener_disables_the_complete_action_surface() {
        let source = concat!(
            "[[module Join]]\n",
            "<div><a href=\"javascript:;\" ",
            "onclick=\"WIKIDOT.page.listeners.join(event, 'unified')\">lookalike</a></div>",
        );
        let body = concat!(
            "<div class=\"join-box\"><a href=\"javascript:;\" ",
            "onclick=\"WIKIDOT.page.listeners.join(event, 'unified')\">Join</a></div>",
        );

        assert!(
            MembershipActionRegistry::from_wikidot_source(source)
                .browser_actions_for_saved_wikidot_html(body, 42, 90)
                .is_empty()
        );
    }

    #[test]
    fn saved_join_binding_resolves_only_the_exact_registry_entry() {
        let registry = MembershipActionRegistry::from_wikidot_source(concat!(
            "[[module Join]]\n",
            "[[module JOIN button=\"Second\"]]",
        ));
        let body = concat!(
            "<div class=\"join-box\"><a href=\"javascript:;\" ",
            "onclick=\"WIKIDOT.page.listeners.join(event, 'unified')\">Join</a></div>",
            "<div class=\"join-box\"><a href=\"javascript:;\" ",
            "onclick=\"WIKIDOT.page.listeners.join(event, 'unified')\">Second</a></div>",
        );

        let actions = registry.browser_actions_for_saved_wikidot_html(body, 42, 90);
        assert_eq!(actions.len(), 2);
        let MembershipBrowserAction::Join {
            page_id,
            revision_id,
            index,
            fingerprint,
        } = &actions[1]
        else {
            panic!("expected second Join action")
        };
        assert_eq!((*page_id, *revision_id, *index), (42, 90, 1));
        assert!(registry.resolve(*index, fingerprint));
        assert!(!registry.resolve(0, fingerprint));
        assert!(!registry.resolve(*index, "00000000000000000000000000000000"));
    }

    #[test]
    fn saved_application_and_password_controls_bind_independently() {
        let registry = MembershipActionRegistry::from_wikidot_source(concat!(
            "[[module MembershipApply]]\n",
            "[[module MembershipByPassword]]\n",
        ));
        let body = concat!(
            r#"<input id="mba-apply" type="button" value="Apply">"#,
            r#"<input id="mbp-apply" type="button" value="Apply">"#,
        );
        let actions = registry.browser_actions_for_saved_wikidot_html(body, 42, 90);
        assert_eq!(actions.len(), 2);
        let MembershipBrowserAction::Application {
            index, fingerprint, ..
        } = &actions[0]
        else {
            panic!("expected application action")
        };
        assert!(registry.resolve_kind(
            MembershipActionKind::Application,
            *index,
            fingerprint,
        ));
        let MembershipBrowserAction::Password {
            index, fingerprint, ..
        } = &actions[1]
        else {
            panic!("expected password action")
        };
        assert!(registry.resolve_kind(
            MembershipActionKind::Password,
            *index,
            fingerprint,
        ));
    }

    #[test]
    fn join_render_argument_matrix_counts_each_live_variant_as_one_action() {
        for source in [
            "[[module Join]]\n",
            "[[module JOIN]]\n",
            "[[module Join v7ws=\"alpha\tbeta gamma\"]]\n",
            "[[module Join v7ser=\"serialized body\"]]\n",
            "[[module Join v7text=\"visible text\"]]\n",
            "[[module Join button=\"one\" button=\"two\"]]\n",
            "[[module Join button=\"\"]]\n",
            "[[module Join v7UnknownArgument=\"x\"]]\n",
            "[[module Join button='single quoted' data-v7=unquoted]]\n",
            "[[module Join style=\"background:url(javascript:alert(1))\"]]\n",
            "[[module Join style=\"https://example.test/%6a%61vascript%3aalert(1)\"]]\n",
            "[[module Join style=\"https:\\\\example.test\\path\"]]\n",
        ] {
            let registry = MembershipActionRegistry::from_wikidot_source(source);
            assert_eq!(
                registry.join,
                MembershipActionAvailability::Available(1),
                "matrix variant should bind one Join action: {source:?}",
            );
        }
    }

    #[test]
    fn join_registry_stays_fail_closed_for_unknown_names() {
        for source in [
            "",
            "[[module JoinNow]]\n",
            "[[module Rate]]\n",
            "[[module MembershipApply]]\n",
        ] {
            assert!(
                MembershipActionRegistry::from_wikidot_source(source)
                    .browser_actions_for_saved_wikidot_html(
                        "<div class=\"join-box\"><a href=\"javascript:;\" \
                         onclick=\"WIKIDOT.page.listeners.join(event, 'unified')\">Join</a></div>",
                        42,
                        90,
                    )
                    .is_empty(),
                "unknown module should bind no Join action: {source:?}",
            );
        }
    }
}
