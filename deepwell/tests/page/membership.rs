/*
 * tests/page/membership.rs
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

//! Membership runtime module integration tests.
//!
//! Extracted from `tests/page.rs` to keep the integration-test crate root
//! focused. These cases exercise the membership-oriented runtime modules
//! (Join, MembershipApply, MembershipByPassword, and MembershipEmailInvitation)
//! and their public JSONRPC mutation/one-use contracts. Shared crate-root
//! imports and helpers are reused via `super::*`.

use super::*;

use deepwell::services::PasswordService;
use deepwell::services::membership::{
    CreateMembershipEmailInvitation, MembershipBrowserAction,
    MembershipEmailInvitationOutcome,
};
use deepwell::services::relation::{CreateSiteBan, RemoveSiteBan, SiteBanData};
use deepwell::services::user::CreateUser;
use deepwell::types::UserType;
use sea_orm::FromQueryResult;

#[tokio::test]
async fn public_membership_module_states_are_distinct_and_opaque() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded mirror site should exist")
        .site;
    // This public-state fixture combines observations captured from the
    // application-enabled sandbox with password-disabled output. Make that
    // policy explicit instead of depending on the pre-policy renderer's
    // historical unconditional MembershipApply form.
    let mut site_model = site.clone().into_active_model();
    site_model.membership_by_application = Set(true);
    site_model
        .update(runner.context().transaction())
        .await
        .expect("membership public-state fixture should enable applications");
    let source = concat!(
        "[[module Join button=\"one\" button=\"two\" class=\"membership-join-fixture\"]]\n",
        "[[module JOIN BUTTON='single-quoted-is-ignored']]\n",
        "[[module Join button=\"\"]]\n",
        "[[module MembershipApply]]\n",
        "[[module MembershipByPassword]]\n",
        "[[module MembershipEmailInvitation token=\"invitation-secret\"]]\n",
        "[[module AnonymousNotificationsUnsubscribe token=\"unsubscribe-secret\"]]\n",
        "[[module SendInvitations]]",
    );

    runner.set_request_context(RequestContext {
        site_id: Some(site.site_id),
        ..Default::default()
    });
    let anonymous = run_endpoint!(
        runner,
        wikidot_page_preview,
        json!({
            "site_id": site.site_id,
            "title": "Membership public states",
            "wikitext": source,
        }),
    );

    for expected in [
        r#"<div class="membership-join-fixture"><a href="javascript:;" onclick="WIKIDOT.page.listeners.join(event, 'unified')">two</a></div>"#,
        r#"<div class="join-box"><a href="javascript:;" onclick="WIKIDOT.page.listeners.join(event, 'unified')">Join</a></div>"#,
        "You need to have a Wikidot.com account and be signed to apply for membership.",
        "Membership via password is not enabled for this site.",
        "Sorry, the invitation could not be found.",
        "Invalid indentification token.",
        "Inviting users has been disabled due to severe abuse.",
    ] {
        assert!(
            anonymous.body.contains(expected),
            "anonymous preview should contain {expected:?}:\n{}",
            anonymous.body,
        );
    }
    for secret in ["invitation-secret", "unsubscribe-secret"] {
        assert!(
            !anonymous.body.contains(secret),
            "opaque token failures must not reflect their input tokens",
        );
    }
    assert!(
        anonymous.membership_actions.is_empty(),
        "PagePreview must render exact Join DOM without issuing a saved-page mutation binding",
    );

    RelationService::create_site_member(
        runner.context(),
        CreateSiteMember {
            site_id: site.site_id,
            user_id: SAMPLE_USER_ID,
            metadata: SiteMemberData {
                accepted: SiteMemberAccepted::SelfJoined,
            },
            created_by: SYSTEM_USER_ID,
        },
        common::IP_ADDRESS,
    )
    .await
    .expect("membership preview fixture actor should become a member");
    runner.set_request_context(RequestContext {
        user_id: Some(SAMPLE_USER_ID),
        site_id: Some(site.site_id),
        ..Default::default()
    });
    let member = run_endpoint!(
        runner,
        wikidot_page_preview,
        json!({
            "site_id": site.site_id,
            "title": "Membership member states",
            "wikitext": source,
        }),
    );
    assert!(
        member.body.contains("membership-join-fixture"),
        "a current site member must still see Join on preview:\n{}",
        member.body,
    );
    assert!(member.membership_actions.is_empty());
}

#[tokio::test]
async fn membership_by_password_module_matches_live_anonymous_and_member_output() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let source = "MBP_START\n[[module MembershipByPassword]]\nMBP_END";

    runner.set_request_context(RequestContext {
        session: None,
        user_id: None,
        site_id: Some(site_id),
        page_reference: None,
    });
    let anonymous_preview = run_endpoint!(
        runner,
        wikidot_page_preview,
        json!({
            "site_id": site_id,
            "title": "MembershipByPassword anonymous live basics",
            "wikitext": source,
        }),
    );
    assert!(
        anonymous_preview
            .body
            .contains(r#"<div id="membership-by-password-box">"#)
            && anonymous_preview
                .body
                .contains("Membership via password is not enabled for this site."),
        "anonymous MembershipByPassword should render the current disabled state:\n{}",
        anonymous_preview.body,
    );
    assert!(
        !anonymous_preview
            .body
            .contains("[[module MembershipByPassword"),
        "anonymous MembershipByPassword should be consumed:\n{}",
        anonymous_preview.body,
    );

    RelationService::create_site_member(
        runner.context(),
        CreateSiteMember {
            site_id,
            user_id: SAMPLE_USER_ID,
            metadata: SiteMemberData {
                accepted: SiteMemberAccepted::SelfJoined,
            },
            created_by: SYSTEM_USER_ID,
        },
        common::IP_ADDRESS,
    )
    .await
    .expect("sample user should become a site member for MembershipByPassword");

    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(SAMPLE_USER_ID),
        site_id: Some(site_id),
        page_reference: None,
    });
    let member_preview = run_endpoint!(
        runner,
        wikidot_page_preview,
        json!({
            "site_id": site_id,
            "title": "MembershipByPassword member live basics",
            "wikitext": source,
        }),
    );
    assert!(
        member_preview
            .body
            .contains(r#"<div id="membership-by-password-box">"#)
            && member_preview.body.contains(r#"<div class="error-block">"#)
            && member_preview.body.contains("You can not apply.<br/>")
            && member_preview
                .body
                .contains("Membership via password is not enabled for this site."),
        "member MembershipByPassword should render the current disabled state:\n{}",
        member_preview.body,
    );
    assert!(
        !member_preview
            .body
            .contains("[[module MembershipByPassword"),
        "member MembershipByPassword should be consumed:\n{}",
        member_preview.body,
    );

    create_listpages_test_page(
        &mut runner,
        site_id,
        "fixture-membership-by-password",
        "Fixture MembershipByPassword",
        source,
    )
    .await;

    let anonymous_view = run_endpoint!(
        runner,
        page_view,
        json!({
            "site_id": site_id,
            "session_token": null,
            "route": {"slug": "fixture-membership-by-password", "extra": ""},
            "locales": ["en-US", "en"],
        }),
    );
    let anonymous_body = match anonymous_view {
        GetPageViewOutput::Found {
            compiled_body_html, ..
        } => compiled_body_html,
        other => {
            panic!("expected found anonymous MembershipByPassword view, got {other:?}")
        }
    };
    assert!(
        anonymous_body.contains("MBP_START")
            && anonymous_body.contains(r#"<div id="membership-by-password-box">"#)
            && anonymous_body
                .contains("Membership via password is not enabled for this site.")
            && anonymous_body.contains("MBP_END"),
        "saved anonymous page view should render the current disabled state:\n{anonymous_body}",
    );

    let sample_session_token = SessionService::create(
        runner.context(),
        CreateSession {
            user_id: SAMPLE_USER_ID,
            ip_address: common::IP_ADDRESS,
            user_agent: "MembershipByPassword member view test".to_owned(),
            restricted: false,
        },
    )
    .await
    .expect("sample session should be created");
    let member_view = run_endpoint!(
        runner,
        page_view,
        json!({
            "site_id": site_id,
            "session_token": sample_session_token,
            "route": {"slug": "fixture-membership-by-password", "extra": ""},
            "locales": ["en-US", "en"],
        }),
    );
    let member_body = match member_view {
        GetPageViewOutput::Found {
            compiled_body_html, ..
        } => compiled_body_html,
        other => panic!("expected found member MembershipByPassword view, got {other:?}"),
    };
    assert!(
        member_body.contains("MBP_START")
            && member_body.contains(r#"<div id="membership-by-password-box">"#)
            && member_body.contains("You can not apply.<br/>")
            && member_body
                .contains("Membership via password is not enabled for this site.")
            && member_body.contains("MBP_END"),
        "saved member page view should render the current disabled state:\n{member_body}",
    );
    assert!(
        !anonymous_body.contains("[[module MembershipByPassword")
            && !member_body.contains("[[module MembershipByPassword"),
        "saved page views should consume MembershipByPassword:\nanonymous={anonymous_body}\nmember={member_body}",
    );
}

#[tokio::test]
async fn membership_application_and_password_mutations_match_disposable_live_contract() {
    let mut runner = TestRunner::setup().await;
    let site_output =
        run_endpoint!(runner, site_get, json!({"site": "scpaiueouiuiuiui"}))
            .expect("seeded editable site should exist");
    let site = site_output.site;
    let site_id = site.site_id;
    let reviewer_user_id = ADMIN_USER_ID;
    let membership_password = format!("a1033-live-contract-{}", cuid());

    let mut site_model = site.into_active_model();
    site_model.membership_by_application = Set(true);
    site_model.membership_by_password = Set(true);
    site_model.membership_password_hash = Set(Some(
        PasswordService::new_hash(&membership_password)
            .expect("membership password fixture should hash"),
    ));
    let configured_site = site_model
        .update(runner.context().transaction())
        .await
        .expect("membership policy fixture should update");
    let public_site =
        serde_json::to_value(&configured_site).expect("site should serialize");
    assert!(
        public_site.get("membership_password_hash").is_none(),
        "membership password digest must not serialize through the public site model",
    );

    async fn create_membership_actor(runner: &TestRunner, label: &str) -> i64 {
        UserService::create(
            runner.context(),
            CreateUser {
                user_type: UserType::Regular,
                name: format!("A1033 {label} {}", cuid()),
                email: format!("a1033-{label}-{}@example.invalid", cuid()),
                locales: vec!["en".to_owned()],
                password: format!("membership-fixture-{}", cuid()),
                bypass_filter: true,
                bypass_email_verification: true,
                override_user_id: None,
                ip_address: common::IP_ADDRESS,
            },
        )
        .await
        .expect("membership fixture user should be created")
        .user_id
    }

    let accept_user_id = create_membership_actor(&runner, "accept").await;
    let decline_user_id = create_membership_actor(&runner, "decline").await;
    let page_slug = format!("a1033-membership-{}", cuid());
    let page = PageService::create(
        runner.context(),
        CreatePage {
            site_id,
            wikitext: concat!(
                "[[module MembershipApply]]\n",
                "[[module MembershipByPassword]]",
            )
            .to_owned(),
            title: "A1033 membership mutation fixture".to_owned(),
            alt_title: None,
            tags: Vec::new(),
            slug: page_slug.clone(),
            layout: None,
            revision_comments: "Create A1033 membership mutation fixture".to_owned(),
            user_id: SYSTEM_USER_ID,
            bypass_filter: true,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("membership action page should be created");

    async fn membership_actions_for_actor(
        runner: &mut TestRunner,
        site_id: i64,
        page_slug: &str,
        user_id: i64,
    ) -> (String, Vec<MembershipBrowserAction>) {
        let session_token = SessionService::create(
            runner.context(),
            CreateSession {
                user_id,
                ip_address: common::IP_ADDRESS,
                user_agent: "A1033 membership mutation fixture".to_owned(),
                restricted: false,
            },
        )
        .await
        .expect("membership fixture session should be created");
        runner.set_request_context(RequestContext {
            user_id: Some(user_id),
            site_id: Some(site_id),
            page_reference: Some(Reference::Slug(page_slug.to_owned().into())),
            ..Default::default()
        });
        let view = run_endpoint!(
            runner,
            page_view,
            json!({
                "site_id": site_id,
                "session_token": session_token,
                "route": {"slug": page_slug, "extra": ""},
                "locales": ["en-US", "en"],
            }),
        );
        match view {
            GetPageViewOutput::Found {
                compiled_body_html,
                membership_actions,
                ..
            } => (compiled_body_html, membership_actions),
            other => panic!("expected membership action page, got {other:?}"),
        }
    }

    fn application_binding(
        actions: &[MembershipBrowserAction],
    ) -> (i64, i64, usize, String) {
        actions
            .iter()
            .find_map(|action| match action {
                MembershipBrowserAction::Application {
                    page_id,
                    revision_id,
                    index,
                    fingerprint,
                } => Some((*page_id, *revision_id, *index, fingerprint.clone())),
                _ => None,
            })
            .expect("registered nonmember should receive MembershipApply action binding")
    }

    fn password_binding(
        actions: &[MembershipBrowserAction],
    ) -> (i64, i64, usize, String) {
        actions
            .iter()
            .find_map(|action| match action {
                MembershipBrowserAction::Password {
                    page_id,
                    revision_id,
                    index,
                    fingerprint,
                } => Some((*page_id, *revision_id, *index, fingerprint.clone())),
                _ => None,
            })
            .expect(
                "registered nonmember should receive MembershipByPassword action binding",
            )
    }

    let (accept_body, accept_actions) =
        membership_actions_for_actor(&mut runner, site_id, &page_slug, accept_user_id)
            .await;
    assert!(
        accept_body.contains(r#"id="membership-by-apply-form""#)
            && accept_body.contains(r#"id="mba-apply""#)
            && accept_body.contains(r#"id="membership-by-password-form""#)
            && accept_body.contains(r#"id="mbp-apply""#)
            && accept_body.contains("The password is not valid."),
        "registered nonmember should receive the evidenced interactive forms:\n{accept_body}",
    );
    let application = application_binding(&accept_actions);
    let password = password_binding(&accept_actions);
    assert_eq!(application.0, page.page_id);
    assert_eq!(password.0, page.page_id);

    runner.set_request_context(RequestContext {
        user_id: Some(accept_user_id),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(page_slug.clone().into())),
        ..Default::default()
    });
    let submitted = run_endpoint!(
        runner,
        membership_application_submit,
        json!({
            "page_id": application.0,
            "last_revision_id": application.1,
            "action_index": application.2,
            "action_fingerprint": application.3,
            "comment": "A1033 live-compatible application",
        }),
    );
    assert_eq!(
        submitted,
        deepwell::services::membership::MembershipApplicationOutcome::Submitted
    );
    let duplicate = run_endpoint!(
        runner,
        membership_application_submit,
        json!({
            "page_id": application.0,
            "last_revision_id": application.1,
            "action_index": application.2,
            "action_fingerprint": application.3,
            "comment": "duplicate",
        }),
    );
    assert_eq!(
        duplicate,
        deepwell::services::membership::MembershipApplicationOutcome::AlreadyApplied
    );

    let pending = deepwell::services::membership::MembershipService::list_applications(
        runner.context(),
        site_id,
    )
    .await
    .expect("pending applications should resolve");
    assert!(
        pending.iter().any(|application| {
            application.user_id == accept_user_id
                && application.comment == "A1033 live-compatible application"
        }),
        "a submitted pending application must be listed for reviewers: {pending:?}",
    );

    for wrong in ["wrong-one", "wrong-two", "wrong-three"] {
        let outcome = run_endpoint!(
            runner,
            membership_password_submit,
            json!({
                "page_id": password.0,
                "last_revision_id": password.1,
                "action_index": password.2,
                "action_fingerprint": password.3,
                "password": wrong,
                "ip_address": common::IP_ADDRESS,
            }),
        );
        assert_eq!(
            outcome,
            deepwell::services::membership::MembershipPasswordOutcome::WrongPassword,
        );
        assert!(
            !RelationService::site_member_exists(
                runner.context(),
                deepwell::services::relation::GetSiteMember {
                    site_id,
                    user_id: accept_user_id,
                },
            )
            .await
            .expect("membership lookup should succeed"),
            "bounded wrong-password attempts must not create membership",
        );
    }
    let joined = run_endpoint!(
        runner,
        membership_password_submit,
        json!({
            "page_id": password.0,
            "last_revision_id": password.1,
            "action_index": password.2,
            "action_fingerprint": password.3,
            "password": membership_password,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(
        joined,
        deepwell::services::membership::MembershipPasswordOutcome::Joined
    );
    let joined_retry = run_endpoint!(
        runner,
        membership_password_submit,
        json!({
            "page_id": password.0,
            "last_revision_id": password.1,
            "action_index": password.2,
            "action_fingerprint": password.3,
            "password": membership_password,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(
        joined_retry,
        deepwell::services::membership::MembershipPasswordOutcome::AlreadyMember,
    );
    let application_reference = RelationReference::Relationship {
        relation_type: RelationType::SiteApplication,
        dest: RelationObject::Site(site_id),
        from: RelationObject::User(accept_user_id),
    };
    assert!(
        !RelationService::exists(runner.context(), application_reference)
            .await
            .expect("application relation lookup should succeed"),
        "password join should remove an existing application like Wikidot",
    );
    let pending_after =
        deepwell::services::membership::MembershipService::list_applications(
            runner.context(),
            site_id,
        )
        .await
        .expect("pending applications should resolve");
    assert!(
        !pending_after
            .iter()
            .any(|application| application.user_id == accept_user_id),
        "a consumed application must not remain in the reviewer list: {pending_after:?}",
    );

    RelationService::remove(
        runner.context(),
        RelationReference::Relationship {
            relation_type: RelationType::SiteMember,
            dest: RelationObject::Site(site_id),
            from: RelationObject::User(accept_user_id),
        },
        reviewer_user_id,
    )
    .await
    .expect("accepted password membership fixture should be removable");
    let resubmitted = run_endpoint!(
        runner,
        membership_application_submit,
        json!({
            "page_id": application.0,
            "last_revision_id": application.1,
            "action_index": application.2,
            "action_fingerprint": application.3,
            "comment": "A1033 accepted application",
        }),
    );
    assert_eq!(
        resubmitted,
        deepwell::services::membership::MembershipApplicationOutcome::Submitted
    );

    runner.set_request_context(RequestContext {
        user_id: Some(reviewer_user_id),
        site_id: Some(site_id),
        ..Default::default()
    });
    let accepted = run_endpoint!(
        runner,
        membership_application_review,
        json!({
            "site_id": site_id,
            "user_id": accept_user_id,
            "decision": "accept",
            "reply": "accepted",
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(
        accepted,
        deepwell::services::membership::MembershipApplicationStatus::Accepted
    );
    RelationService::remove(
        runner.context(),
        RelationReference::Relationship {
            relation_type: RelationType::SiteMember,
            dest: RelationObject::Site(site_id),
            from: RelationObject::User(accept_user_id),
        },
        reviewer_user_id,
    )
    .await
    .expect("accepted application membership fixture should be removable");
    runner.set_request_context(RequestContext {
        user_id: Some(accept_user_id),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(page_slug.clone().into())),
        ..Default::default()
    });
    let reapply_after_accept = run_endpoint!(
        runner,
        membership_application_submit,
        json!({
            "page_id": application.0,
            "last_revision_id": application.1,
            "action_index": application.2,
            "action_fingerprint": application.3,
            "comment": "should remain already applied",
        }),
    );
    assert_eq!(
        reapply_after_accept,
        deepwell::services::membership::MembershipApplicationOutcome::AlreadyApplied,
    );

    let (_decline_body, decline_actions) =
        membership_actions_for_actor(&mut runner, site_id, &page_slug, decline_user_id)
            .await;
    let decline_application = application_binding(&decline_actions);
    runner.set_request_context(RequestContext {
        user_id: Some(decline_user_id),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(page_slug.clone().into())),
        ..Default::default()
    });
    assert_eq!(
        run_endpoint!(
            runner,
            membership_application_submit,
            json!({
                "page_id": decline_application.0,
                "last_revision_id": decline_application.1,
                "action_index": decline_application.2,
                "action_fingerprint": decline_application.3,
                "comment": "A1033 declined application",
            }),
        ),
        deepwell::services::membership::MembershipApplicationOutcome::Submitted,
    );
    runner.set_request_context(RequestContext {
        user_id: Some(reviewer_user_id),
        site_id: Some(site_id),
        ..Default::default()
    });
    assert_eq!(
        run_endpoint!(
            runner,
            membership_application_review,
            json!({
                "site_id": site_id,
                "user_id": decline_user_id,
                "decision": "decline",
                "reply": "declined",
                "ip_address": common::IP_ADDRESS,
            }),
        ),
        deepwell::services::membership::MembershipApplicationStatus::Declined,
    );
    let declined_list =
        deepwell::services::membership::MembershipService::list_applications(
            runner.context(),
            site_id,
        )
        .await
        .expect("application list should resolve after a decline");
    assert!(
        declined_list.iter().any(|application| {
            application.user_id == decline_user_id
                && application.status
                    == deepwell::services::membership::MembershipApplicationStatus::Declined
                && application.comment == "A1033 declined application"
        }),
        "a declined application must stay visible to reviewers with its status: {declined_list:?}",
    );

    let (reapply_body, reapply_actions) =
        membership_actions_for_actor(&mut runner, site_id, &page_slug, decline_user_id)
            .await;
    assert!(
        reapply_body.contains(r#"id="membership-by-apply-form""#),
        "a declined applicant must be offered the apply form again:\n{reapply_body}",
    );
    let reapply_application = application_binding(&reapply_actions);
    runner.set_request_context(RequestContext {
        user_id: Some(decline_user_id),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(page_slug.clone().into())),
        ..Default::default()
    });
    assert_eq!(
        run_endpoint!(
            runner,
            membership_application_submit,
            json!({
                "page_id": reapply_application.0,
                "last_revision_id": reapply_application.1,
                "action_index": reapply_application.2,
                "action_fingerprint": reapply_application.3,
                "comment": "A1033 reapply after decline",
            }),
        ),
        deepwell::services::membership::MembershipApplicationOutcome::Submitted,
    );
    assert_eq!(
        run_endpoint!(
            runner,
            membership_application_submit,
            json!({
                "page_id": reapply_application.0,
                "last_revision_id": reapply_application.1,
                "action_index": reapply_application.2,
                "action_fingerprint": reapply_application.3,
                "comment": "duplicate while pending again",
            }),
        ),
        deepwell::services::membership::MembershipApplicationOutcome::AlreadyApplied,
    );

    let relisted = deepwell::services::membership::MembershipService::list_applications(
        runner.context(),
        site_id,
    )
    .await
    .expect("application list should resolve after re-applying");
    assert!(
        relisted.iter().any(|application| {
            application.user_id == decline_user_id
                && application.status
                    == deepwell::services::membership::MembershipApplicationStatus::Pending
                && application.comment == "A1033 reapply after decline"
        }),
        "the fresh application must supersede the declined one as pending: {relisted:?}",
    );

    runner.set_request_context(RequestContext {
        user_id: Some(reviewer_user_id),
        site_id: Some(site_id),
        ..Default::default()
    });
    assert_eq!(
        run_endpoint!(
            runner,
            membership_application_review,
            json!({
                "site_id": site_id,
                "user_id": decline_user_id,
                "decision": "accept",
                "reply": "accepted after reapply",
                "ip_address": common::IP_ADDRESS,
            }),
        ),
        deepwell::services::membership::MembershipApplicationStatus::Accepted,
    );
    assert!(
        RelationService::site_member_exists(
            runner.context(),
            deepwell::services::relation::GetSiteMember {
                site_id,
                user_id: decline_user_id,
            },
        )
        .await
        .expect("re-applied membership lookup should succeed"),
        "a declined applicant who re-applies and is accepted must become a member",
    );
}

#[tokio::test]
async fn membership_email_invitation_matches_hash_one_use_and_cancel_contract() {
    #[derive(Debug, FromQueryResult)]
    struct InvitationStorageRow {
        token_digest: String,
        created_at: OffsetDateTime,
    }

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scpaiueouiuiuiui"}))
        .expect("seeded editable site should exist")
        .site;
    let site_id = site.site_id;
    let page_slug = format!("a1033-email-invitation-{}", cuid());
    let page = PageService::create(
        runner.context(),
        CreatePage {
            site_id,
            wikitext: "[[module MembershipEmailInvitation]]".to_owned(),
            title: "A1033 email invitation fixture".to_owned(),
            alt_title: None,
            tags: Vec::new(),
            slug: page_slug.clone(),
            layout: None,
            revision_comments: "Create A1033 email invitation fixture".to_owned(),
            user_id: SYSTEM_USER_ID,
            bypass_filter: true,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("invitation page should be created");

    let recipient_email = format!("a1033-recipient-{}@example.invalid", cuid());
    let recipient = UserService::create(
        runner.context(),
        CreateUser {
            user_type: UserType::Regular,
            name: format!("A1033 invitation recipient {}", cuid()),
            email: recipient_email.clone(),
            locales: vec!["en".to_owned()],
            password: "A1033 invitation fixture password!".to_owned(),
            bypass_filter: true,
            bypass_email_verification: true,
            override_user_id: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("invitation recipient should be created");

    let stranger = UserService::create(
        runner.context(),
        CreateUser {
            user_type: UserType::Regular,
            name: format!("A1033 invitation stranger {}", cuid()),
            email: format!("a1033-stranger-{}@example.invalid", cuid()),
            locales: vec!["en".to_owned()],
            password: "A1033 invitation fixture password!".to_owned(),
            bypass_filter: true,
            bypass_email_verification: true,
            override_user_id: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("invitation stranger should be created");

    async fn invitation_binding_for(
        runner: &mut TestRunner,
        site_id: i64,
        page_slug: &str,
        user_id: i64,
        token: &str,
    ) -> (String, (i64, i64, usize, String)) {
        let session_token = SessionService::create(
            runner.context(),
            CreateSession {
                user_id,
                ip_address: common::IP_ADDRESS,
                user_agent: "A1033 invitation fixture".to_owned(),
                restricted: false,
            },
        )
        .await
        .expect("invitation fixture session should be created");
        runner.set_request_context(RequestContext {
            user_id: Some(user_id),
            site_id: Some(site_id),
            page_reference: Some(Reference::Slug(page_slug.to_owned().into())),
            ..Default::default()
        });
        let view = run_endpoint!(
            runner,
            page_view,
            json!({
                "site_id": site_id,
                "session_token": session_token,
                "route": {"slug": page_slug, "extra": format!("/hash/{token}")},
                "locales": ["en-US", "en"],
            }),
        );
        match view {
            GetPageViewOutput::Found {
                compiled_body_html,
                membership_actions,
                ..
            } => {
                let action = membership_actions
                    .iter()
                    .find_map(|action| match action {
                        MembershipBrowserAction::Invitation {
                            page_id,
                            revision_id,
                            index,
                            fingerprint,
                        } => Some((*page_id, *revision_id, *index, fingerprint.clone())),
                        _ => None,
                    })
                    .expect(
                        "authenticated invitation viewer should receive one typed action",
                    );
                (compiled_body_html, action)
            }
            other => panic!("expected invitation page view, got {other:?}"),
        }
    }

    // An invitation must carry both a recipient email and a recipient name.
    for (email, recipient_name) in [
        ("", "Intended Recipient"),
        ("intended-recipient@example.invalid", ""),
    ] {
        let error =
            deepwell::services::membership::MembershipService::create_email_invitation(
                runner.context(),
                CreateMembershipEmailInvitation {
                    site_id,
                    sender_user_id: ADMIN_USER_ID,
                    email,
                    recipient_name,
                    message: "A1033 invitation fixture",
                    to_contacts: false,
                },
            )
            .await
            .expect_err("an invitation without a recipient identity must be rejected");
        assert_contains_error!(error, ErrorType::BadRequest);
    }

    let (invitation_id, token) =
        deepwell::services::membership::MembershipService::create_email_invitation(
            runner.context(),
            CreateMembershipEmailInvitation {
                site_id,
                sender_user_id: ADMIN_USER_ID,
                email: recipient_email.as_str(),
                recipient_name: "Intended Recipient",
                message: "A1033 invitation fixture",
                to_contacts: false,
            },
        )
        .await
        .expect("invitation should be created");

    let stored = InvitationStorageRow::find_by_statement(Statement::from_sql_and_values(
        runner.context().transaction().get_database_backend(),
        "SELECT token_digest, created_at FROM membership_email_invitation WHERE invitation_id = $1",
        [Value::from(invitation_id)],
    ))
    .one(runner.context().transaction())
    .await
    .expect("invitation storage lookup should succeed")
    .expect("invitation row should exist");
    assert_ne!(
        stored.token_digest, token,
        "raw invitation token must not be stored"
    );
    assert_eq!(
        stored.token_digest,
        hex::encode(Sha256::digest(token.as_bytes()))
    );

    runner
        .context()
        .transaction()
        .execute_raw(Statement::from_sql_and_values(
            runner.context().transaction().get_database_backend(),
            "UPDATE membership_email_invitation SET created_at = NOW() - INTERVAL '10 years' WHERE invitation_id = $1",
            [Value::from(invitation_id)],
        ))
        .await
        .expect("old invitation timestamp fixture should update");
    let aged = InvitationStorageRow::find_by_statement(Statement::from_sql_and_values(
        runner.context().transaction().get_database_backend(),
        "SELECT token_digest, created_at FROM membership_email_invitation WHERE invitation_id = $1",
        [Value::from(invitation_id)],
    ))
    .one(runner.context().transaction())
    .await
    .expect("aged invitation storage lookup should succeed")
    .expect("aged invitation row should exist");
    assert!(
        aged.created_at < stored.created_at,
        "fixture must actually age the invitation"
    );
    assert_eq!(aged.token_digest, stored.token_digest);
    assert!(
        deepwell::services::membership::MembershipService::resolve_email_invitation(
            runner.context(),
            &token,
        )
        .await
        .expect("old invitation should resolve")
        .is_some(),
        "Wikidot invitation contract has no expiry check",
    );

    runner.set_request_context(RequestContext {
        user_id: None,
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(page_slug.clone().into())),
        ..Default::default()
    });
    let anonymous_view = run_endpoint!(
        runner,
        page_view,
        json!({
            "site_id": site_id,
            "route": {"slug": page_slug, "extra": format!("/hash/{token}")},
            "locales": ["en-US", "en"],
        }),
    );
    let anonymous_body = match anonymous_view {
        GetPageViewOutput::Found {
            compiled_body_html,
            membership_actions,
            ..
        } => {
            assert!(membership_actions.is_empty());
            compiled_body_html
        }
        other => panic!("expected anonymous invitation page, got {other:?}"),
    };
    assert!(anonymous_body.contains("Hi, Intended Recipient!"));
    assert!(anonymous_body.contains("Please create an account (or log in)"));
    assert!(!anonymous_body.contains("accept invitation"));

    // An account that is not the invited recipient cannot accept, and the
    // attempt must not consume the invitation.
    let (stranger_body, stranger_action) = invitation_binding_for(
        &mut runner,
        site_id,
        &page_slug,
        stranger.user_id,
        &token,
    )
    .await;
    assert!(stranger_body.contains("accept invitation"));
    runner.set_request_context(RequestContext {
        user_id: Some(stranger.user_id),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(page_slug.clone().into())),
        ..Default::default()
    });
    let stranger_outcome = run_endpoint!(
        runner,
        membership_email_invitation_accept,
        json!({
            "page_id": stranger_action.0,
            "last_revision_id": stranger_action.1,
            "action_index": stranger_action.2,
            "action_fingerprint": stranger_action.3,
            "hash": token,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(
        stranger_outcome,
        MembershipEmailInvitationOutcome::Unavailable,
    );
    assert!(
        !RelationService::site_member_exists(
            runner.context(),
            deepwell::services::relation::GetSiteMember {
                site_id,
                user_id: stranger.user_id,
            },
        )
        .await
        .expect("stranger membership lookup should succeed"),
        "a non-recipient must not gain membership from an invitation",
    );
    assert!(
        deepwell::services::membership::MembershipService::resolve_email_invitation(
            runner.context(),
            &token,
        )
        .await
        .expect("invitation lookup after wrong-recipient attempt should succeed")
        .is_some(),
        "a wrong-recipient attempt must not consume the invitation",
    );

    // A banned recipient is refused at acceptance like on every other
    // membership path, and the invitation survives the refusal.
    RelationService::create_site_ban(
        runner.context(),
        CreateSiteBan {
            site_id,
            user_id: recipient.user_id,
            created_by: ADMIN_USER_ID,
            metadata: SiteBanData {
                banned_until: None,
                reason: "A1033 invitation ban fixture".to_owned(),
            },
        },
        common::IP_ADDRESS,
    )
    .await
    .expect("invitation recipient should be banned for the ban-gate fixture");
    assert!(
        RelationService::active_site_ban_exists(
            runner.context(),
            deepwell::services::relation::GetSiteBan {
                site_id,
                user_id: recipient.user_id,
            },
        )
        .await
        .expect("invitation recipient ban lookup should succeed"),
        "fixture must prove the recipient is banned before acceptance",
    );
    let (recipient_body, recipient_action) = invitation_binding_for(
        &mut runner,
        site_id,
        &page_slug,
        recipient.user_id,
        &token,
    )
    .await;
    assert!(recipient_body.contains("accept invitation"));
    assert!(recipient_body.contains(&token));
    assert!(
        !recipient_body.contains(&recipient_email),
        "recipient email must not be reflected by the module",
    );
    assert_eq!(recipient_action.0, page.page_id);

    runner.set_request_context(RequestContext {
        user_id: Some(recipient.user_id),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(page_slug.clone().into())),
        ..Default::default()
    });
    let ban_error = run_endpoint_err!(
        runner,
        membership_email_invitation_accept,
        json!({
            "page_id": recipient_action.0,
            "last_revision_id": recipient_action.1,
            "action_index": recipient_action.2,
            "action_fingerprint": recipient_action.3,
            "hash": token,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(ban_error, ErrorType::SiteBannedUser);
    assert!(
        !RelationService::site_member_exists(
            runner.context(),
            deepwell::services::relation::GetSiteMember {
                site_id,
                user_id: recipient.user_id,
            },
        )
        .await
        .expect("banned recipient membership lookup should succeed"),
        "a banned recipient must not become a member via an invitation",
    );
    assert!(
        deepwell::services::membership::MembershipService::resolve_email_invitation(
            runner.context(),
            &token,
        )
        .await
        .expect("invitation lookup after banned attempt should succeed")
        .is_some(),
        "a banned acceptance attempt must not consume the invitation",
    );

    RelationService::remove_site_ban(
        runner.context(),
        RemoveSiteBan {
            site_id,
            user_id: recipient.user_id,
            removed_by: ADMIN_USER_ID,
        },
        common::IP_ADDRESS,
        "A1033 invitation ban fixture lifted",
    )
    .await
    .expect("invitation recipient ban should be removable");

    // Once the ban is lifted, the invited recipient can still accept.
    runner.set_request_context(RequestContext {
        user_id: Some(recipient.user_id),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(page_slug.clone().into())),
        ..Default::default()
    });
    let accepted = run_endpoint!(
        runner,
        membership_email_invitation_accept,
        json!({
            "page_id": recipient_action.0,
            "last_revision_id": recipient_action.1,
            "action_index": recipient_action.2,
            "action_fingerprint": recipient_action.3,
            "hash": token,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(
        accepted,
        MembershipEmailInvitationOutcome::Accepted {
            site_name: site.name.clone(),
            site_slug: site.slug.clone(),
        },
    );
    assert!(
        RelationService::site_member_exists(
            runner.context(),
            deepwell::services::relation::GetSiteMember {
                site_id,
                user_id: recipient.user_id,
            },
        )
        .await
        .expect("accepted invitation membership lookup should succeed"),
    );
    assert!(
        deepwell::services::membership::MembershipService::resolve_email_invitation(
            runner.context(),
            &token,
        )
        .await
        .expect("consumed invitation lookup should succeed")
        .is_none(),
        "accepted invitation must be one-use",
    );

    let (_cancel_id_unused, cancel_token) =
        deepwell::services::membership::MembershipService::create_email_invitation(
            runner.context(),
            CreateMembershipEmailInvitation {
                site_id,
                sender_user_id: ADMIN_USER_ID,
                email: "cancel-recipient@example.invalid",
                recipient_name: "Cancel Recipient",
                message: "cancel fixture",
                to_contacts: false,
            },
        )
        .await
        .expect("cancel invitation should be created");
    let cancel_view =
        deepwell::services::membership::MembershipService::resolve_email_invitation(
            runner.context(),
            &cancel_token,
        )
        .await
        .expect("cancel invitation lookup should succeed")
        .expect("cancel invitation should exist before cancellation");
    assert!(
        deepwell::services::membership::MembershipService::cancel_email_invitation(
            runner.context(),
            site_id,
            cancel_view.invitation_id,
        )
        .await
        .expect("cancel should succeed"),
    );
    assert!(
        deepwell::services::membership::MembershipService::resolve_email_invitation(
            runner.context(),
            &cancel_token,
        )
        .await
        .expect("canceled invitation lookup should succeed")
        .is_none(),
        "canceled invitation must collapse to the same unavailable state",
    );
}

#[tokio::test]
async fn membership_password_submit_is_throttled_per_site_and_actor() {
    let mut runner = TestRunner::setup().await;
    let site_output =
        run_endpoint!(runner, site_get, json!({"site": "scpaiueouiuiuiui"}))
            .expect("seeded editable site should exist");
    let site_id = site_output.site.site_id;
    let membership_password = format!("membership-throttle-{}", cuid());

    let mut site_model = site_output.site.into_active_model();
    site_model.membership_by_password = Set(true);
    site_model.membership_password_hash = Set(Some(
        PasswordService::new_hash(&membership_password)
            .expect("membership password fixture should hash"),
    ));
    site_model
        .update(runner.context().transaction())
        .await
        .expect("membership password fixture should update");

    async fn throttle_actor(runner: &TestRunner, label: &str) -> i64 {
        UserService::create(
            runner.context(),
            CreateUser {
                user_type: UserType::Regular,
                name: format!("Throttle {label} {}", cuid()),
                email: format!("throttle-{label}-{}@example.invalid", cuid()),
                locales: vec!["en".to_owned()],
                password: format!("throttle-fixture-{}", cuid()),
                bypass_filter: true,
                bypass_email_verification: true,
                override_user_id: None,
                ip_address: common::IP_ADDRESS,
            },
        )
        .await
        .expect("throttle fixture user should be created")
        .user_id
    }

    let actor_id = throttle_actor(&runner, "limited").await;
    let other_actor_id = throttle_actor(&runner, "other").await;
    let page_slug = format!("membership-throttle-{}", cuid());
    let page = PageService::create(
        runner.context(),
        CreatePage {
            site_id,
            wikitext: "[[module MembershipByPassword]]".to_owned(),
            title: "Membership throttle fixture".to_owned(),
            alt_title: None,
            tags: Vec::new(),
            slug: page_slug.clone(),
            layout: None,
            revision_comments: "Create membership throttle fixture".to_owned(),
            user_id: SYSTEM_USER_ID,
            bypass_filter: true,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("membership throttle page should be created");

    async fn password_binding_for(
        runner: &mut TestRunner,
        site_id: i64,
        page_slug: &str,
        user_id: i64,
    ) -> (i64, i64, usize, String) {
        let session_token = SessionService::create(
            runner.context(),
            CreateSession {
                user_id,
                ip_address: common::IP_ADDRESS,
                user_agent: "membership throttle fixture".to_owned(),
                restricted: false,
            },
        )
        .await
        .expect("throttle fixture session should be created");
        runner.set_request_context(RequestContext {
            user_id: Some(user_id),
            site_id: Some(site_id),
            page_reference: Some(Reference::Slug(page_slug.to_owned().into())),
            ..Default::default()
        });
        let view = run_endpoint!(
            runner,
            page_view,
            json!({
                "site_id": site_id,
                "session_token": session_token,
                "route": {"slug": page_slug, "extra": ""},
                "locales": ["en-US", "en"],
            }),
        );
        match view {
            GetPageViewOutput::Found {
                membership_actions, ..
            } => membership_actions
                .iter()
                .find_map(|action| match action {
                    MembershipBrowserAction::Password {
                        page_id,
                        revision_id,
                        index,
                        fingerprint,
                    } => Some((*page_id, *revision_id, *index, fingerprint.clone())),
                    _ => None,
                })
                .expect("registered nonmember should receive password action binding"),
            other => panic!("expected membership action page, got {other:?}"),
        }
    }

    let binding = password_binding_for(&mut runner, site_id, &page_slug, actor_id).await;
    assert_eq!(binding.0, page.page_id);
    runner.set_request_context(RequestContext {
        user_id: Some(actor_id),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(page_slug.clone().into())),
        ..Default::default()
    });
    for attempt in 1..=10 {
        let outcome = run_endpoint!(
            runner,
            membership_password_submit,
            json!({
                "page_id": binding.0,
                "last_revision_id": binding.1,
                "action_index": binding.2,
                "action_fingerprint": binding.3,
                "password": format!("wrong-{attempt}"),
                "ip_address": common::IP_ADDRESS,
            }),
        );
        assert_eq!(
            outcome,
            deepwell::services::membership::MembershipPasswordOutcome::WrongPassword,
            "attempt {attempt} within the window must stay a plain wrong-password outcome",
        );
    }
    // The window is now exhausted for this (site, actor): even the correct
    // password is indistinguishable from every other unavailable action.
    let exhausted = run_endpoint_err!(
        runner,
        membership_password_submit,
        json!({
            "page_id": binding.0,
            "last_revision_id": binding.1,
            "action_index": binding.2,
            "action_fingerprint": binding.3,
            "password": membership_password,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(exhausted, ErrorType::PermissionDenied);
    assert!(
        !RelationService::site_member_exists(
            runner.context(),
            deepwell::services::relation::GetSiteMember {
                site_id,
                user_id: actor_id,
            },
        )
        .await
        .expect("membership lookup should succeed"),
        "an exhausted window must not create membership",
    );

    // A different actor keeps an independent partition.
    let other_binding =
        password_binding_for(&mut runner, site_id, &page_slug, other_actor_id).await;
    runner.set_request_context(RequestContext {
        user_id: Some(other_actor_id),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(page_slug.clone().into())),
        ..Default::default()
    });
    let other_outcome = run_endpoint!(
        runner,
        membership_password_submit,
        json!({
            "page_id": other_binding.0,
            "last_revision_id": other_binding.1,
            "action_index": other_binding.2,
            "action_fingerprint": other_binding.3,
            "password": "wrong-other",
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(
        other_outcome,
        deepwell::services::membership::MembershipPasswordOutcome::WrongPassword,
    );
}

fn marked_membership_section<'a>(body: &'a str, label: &str) -> &'a str {
    let start = format!("{label}_START");
    let end = format!("{label}_END");
    body.split_once(&start)
        .and_then(|(_, tail)| tail.split_once(&end))
        .map(|(section, _)| section)
        .unwrap_or_else(|| panic!("missing {label} markers in:\n{body}"))
}

#[tokio::test]
async fn membership_email_invitation_matches_live_missing_invitation_text() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let source = concat!(
        "MEIBARE_START\n[[module MembershipEmailInvitation]]\nMEIBARE_END\n",
        "MEIHASH_START\n[[module MembershipEmailInvitation hash=\"abc\"]]\nMEIHASH_END\n",
        "MEIUPPER_START\n[[module MEMBERSHIPEMAILINVITATION HASH=\"abc\"]]\nMEIUPPER_END\n",
        "MEIBODY_START\n[[module MembershipEmailInvitation]]\nBODY\n[[/module]]\nMEIBODY_END\n",
        "MEIINLINE_START\n[[module MembershipEmailInvitation]]x[[/module]]\nMEIINLINE_END",
    );

    runner.set_request_context(RequestContext {
        session: None,
        user_id: None,
        site_id: Some(site_id),
        page_reference: None,
    });
    let preview = run_endpoint!(
        runner,
        wikidot_page_preview,
        json!({
            "site_id": site_id,
            "title": "MembershipEmailInvitation live text",
            "wikitext": source,
        }),
    )
    .body;

    for label in ["MEIBARE", "MEIHASH", "MEIUPPER", "MEIBODY"] {
        let section = marked_membership_section(&preview, label);
        assert!(
            section.contains(r#"<div id="membership-email-invitation-box">"#),
            "{label} should render the invitation box:\n{section}",
        );
        assert!(
            section.contains(
                "It might have been canceled by the sender, expired, already\n\t\t\tused by someone (you?)"
            ),
            "{label} must carry live's current missing-invitation sentence:\n{section}",
        );
        assert!(
            !section.contains("aleady"),
            "{label} must not keep the fossil typo:\n{section}",
        );
    }
    let body_section = marked_membership_section(&preview, "MEIBODY");
    assert!(
        !body_section.contains("BODY"),
        "the block body is consumed by the invocation:\n{body_section}",
    );
    let inline = marked_membership_section(&preview, "MEIINLINE");
    assert!(
        inline.contains("[[module MembershipEmailInvitation]]x[[/module]]")
            && !inline.contains("membership-email-invitation-box"),
        "an inline MembershipEmailInvitation invocation must stay literal like live:\n{inline}",
    );

    create_listpages_test_page(
        &mut runner,
        site_id,
        "fixture-membership-email-invitation-text",
        "Fixture MembershipEmailInvitation Text",
        source,
    )
    .await;
    let view = run_endpoint!(
        runner,
        page_view,
        json!({
            "site_id": site_id,
            "session_token": null,
            "route": {"slug": "fixture-membership-email-invitation-text", "extra": ""},
            "locales": ["en-US", "en"],
        }),
    );
    let saved = match view {
        GetPageViewOutput::Found {
            compiled_body_html, ..
        } => compiled_body_html,
        other => panic!("expected found MembershipEmailInvitation view, got {other:?}"),
    };
    assert!(
        saved.contains("canceled by the sender, expired, already")
            && !saved.contains("aleady")
            && saved.contains("[[module MembershipEmailInvitation]]x[[/module]]"),
        "saved MembershipEmailInvitation page should match the preview text:\n{saved}",
    );
}

#[tokio::test]
async fn membership_by_password_ignores_arguments_and_module_source_boundaries() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let source = concat!(
        "MBPBARE_START\n[[module MembershipByPassword]]\nMBPBARE_END\n",
        "MBPARGS_START\n[[module MembershipByPassword foo=\"bar\"]]\nMBPARGS_END\n",
        "MBPBODY_START\n[[module MembershipByPassword]]\nBODY\n[[/module]]\nMBPBODY_END\n",
        "MBPINLINE_START\n[[module MembershipByPassword]]x[[/module]]\nMBPINLINE_END",
    );

    runner.set_request_context(RequestContext {
        session: None,
        user_id: None,
        site_id: Some(site_id),
        page_reference: None,
    });
    let preview = run_endpoint!(
        runner,
        wikidot_page_preview,
        json!({
            "site_id": site_id,
            "title": "MembershipByPassword argument boundaries",
            "wikitext": source,
        }),
    )
    .body;

    for label in ["MBPBARE", "MBPARGS", "MBPBODY"] {
        let section = marked_membership_section(&preview, label);
        assert!(
            section.contains(r#"<div id="membership-by-password-box">"#)
                && section
                    .contains("Membership via password is not enabled for this site."),
            "{label} should render the site-configured state instead of failing the module:\n{section}",
        );
        assert!(
            !section.contains("No such module"),
            "{label} must not fall through to the unknown-module error:\n{section}",
        );
    }
    let body_section = marked_membership_section(&preview, "MBPBODY");
    assert!(
        !body_section.contains("BODY"),
        "the block body is consumed by the invocation:\n{body_section}",
    );
    let inline = marked_membership_section(&preview, "MBPINLINE");
    assert!(
        inline.contains("[[module MembershipByPassword]]x[[/module]]")
            && !inline.contains("membership-by-password-box"),
        "an inline MembershipByPassword invocation must stay literal like live:\n{inline}",
    );
}
