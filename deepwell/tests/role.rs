/*
 * tests/role.rs
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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

#[macro_use]
mod common;

use deepwell::services::RequestContext;
use deepwell::services::membership::{
    JoinActorState, MembershipJoinOutcome, MembershipPolicy, MembershipService,
};
use deepwell::services::permission::PermissionService;
use deepwell::services::relation::{RelationObject, RelationService, SiteBanData};
use deepwell::services::role::{
    GetUserRolesInput, GrantUserRoleInput, InternalCreateRoleInput, RoleService,
    UpdateRolePermissionsInput,
};
use deepwell::services::session::CreateSession;
use deepwell::services::view::GetPageViewOutput;
use deepwell::utils::now;
use std::sync::atomic::{AtomicU64, Ordering};
use str_macro::str;
use time::format_description::well_known::Rfc3339;

use self::common::TestRunner;
use deepwell::constants::SYSTEM_USER_ID;
use deepwell::error::prelude::*;
use deepwell::license::License;
use deepwell::models::role::Model as RoleModel;
use deepwell::services::SessionService;
use deepwell::services::page::{CreatePage, PageService};
use deepwell::services::site::{CreateSite, SiteService};
use deepwell::services::user::{CreateUser, UserService};
use deepwell::types::{Action, Permission, Reference, RelationType, Resource, UserType};
use serde_json::json;
use std::borrow::Cow;

static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);

#[tokio::test]
async fn ordinary_user_joins_only_the_editable_site_then_creates_a_page() {
    let mut runner = TestRunner::setup().await;
    let n = next_n();
    let join_slug = format!("system:join-{n}");
    let editable = run_endpoint!(runner, site_get, json!({"site": "scpaiueouiuiuiui"}),)
        .expect("seeded editable site should exist")
        .site;
    let mirror = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded mirror site should exist")
        .site;
    if PageService::get_optional(
        runner.context(),
        editable.site_id,
        Reference::Slug(Cow::Owned(join_slug.clone())),
    )
    .await
    .expect("self-join fixture lookup should succeed")
    .is_none()
    {
        PageService::create(
            runner.context(),
            CreatePage {
                site_id: editable.site_id,
                wikitext: "[[module Join]]".to_owned(),
                title: "Join this site".to_owned(),
                alt_title: None,
                tags: Vec::new(),
                slug: join_slug.clone(),
                layout: None,
                revision_comments: "Create self-join test fixture".to_owned(),
                user_id: SYSTEM_USER_ID,
                bypass_filter: true,
                ip_address: common::IP_ADDRESS,
            },
        )
        .await
        .expect("self-join fixture should be created");
    }
    let user_id = create_test_user(&runner, n, "self-join").await;
    let pending_user_id = create_test_user(&runner, n, "pending").await;
    let banned_user_id = create_test_user(&runner, n, "banned").await;
    let user_session_token = SessionService::create(
        runner.context(),
        CreateSession {
            user_id,
            ip_address: common::IP_ADDRESS,
            user_agent: "editable-site membership vertical slice".to_owned(),
            restricted: false,
        },
    )
    .await
    .expect("ordinary user session should be created");
    RelationService::create(
        runner.context(),
        RelationType::SiteApplication,
        RelationObject::Site(editable.site_id),
        RelationObject::User(pending_user_id),
        pending_user_id,
        &json!({}),
    )
    .await
    .expect("pending actor should have an application relation");
    RelationService::create(
        runner.context(),
        RelationType::SiteBan,
        RelationObject::Site(editable.site_id),
        RelationObject::User(banned_user_id),
        SYSTEM_USER_ID,
        &SiteBanData {
            banned_until: None,
            reason: "membership actor matrix".to_owned(),
        },
    )
    .await
    .expect("banned actor should have a ban relation");

    runner.set_request_context(RequestContext {
        user_id: Some(user_id),
        site_id: Some(editable.site_id),
        ..Default::default()
    });
    let join_view = run_endpoint!(
        runner,
        page_view,
        json!({
            "site_id": editable.site_id,
            "session_token": user_session_token.clone(),
            "route": {"slug": join_slug.clone(), "extra": ""},
            "locales": ["en-US", "en"],
        }),
    );
    let GetPageViewOutput::Found {
        page: join_page,
        page_revision: join_revision,
        compiled_body_html,
        membership_actions,
        ..
    } = join_view
    else {
        panic!("editable site should serve its seeded self-join route");
    };
    assert!(compiled_body_html.contains("WIKIDOT.page.listeners.join"));
    let membership_actions = serde_json::to_value(membership_actions).unwrap();
    assert_eq!(membership_actions.as_array().unwrap().len(), 1);
    let join_action = &membership_actions[0];
    assert_eq!(join_action["type"], "join");
    assert_eq!(join_action["page_id"], join_page.page_id);
    assert_eq!(join_action["revision_id"], join_revision.revision_id);
    assert_eq!(join_action["index"], 0);
    assert_eq!(
        join_action["fingerprint"].as_str().unwrap().len(),
        32,
        "saved Join actions must carry only an opaque server registry binding",
    );

    let anonymous_join_view = run_endpoint!(
        runner,
        page_view,
        json!({
            "site_id": editable.site_id,
            "session_token": null,
            "route": {"slug": join_slug.clone(), "extra": ""},
            "locales": ["en-US", "en"],
        }),
    );
    let GetPageViewOutput::Found {
        compiled_body_html,
        membership_actions,
        ..
    } = anonymous_join_view
    else {
        panic!("anonymous viewer should receive the public self-join page");
    };
    assert!(compiled_body_html.contains("WIKIDOT.page.listeners.join"));
    assert!(
        membership_actions.is_empty(),
        "anonymous Join DOM must remain inert until an authenticated actor has a bound action",
    );

    for (actor, expected) in [
        (None, JoinActorState::Anonymous),
        (Some(user_id), JoinActorState::Eligible),
        (Some(pending_user_id), JoinActorState::Pending),
        (Some(banned_user_id), JoinActorState::Banned),
    ] {
        runner.set_request_context(RequestContext {
            user_id: actor,
            site_id: Some(editable.site_id),
            ..Default::default()
        });
        assert_eq!(
            MembershipService::actor_state(runner.context(), editable.site_id, actor,)
                .await
                .expect("membership actor state should resolve"),
            expected,
        );
        let preview = run_endpoint!(
            runner,
            wikidot_page_preview,
            json!({
                "site_id": editable.site_id,
                "title": "Membership actor state",
                "wikitext": "[[module Join]]",
            }),
        );
        assert_eq!(
            preview.body.contains("WIKIDOT.page.listeners.join"),
            matches!(
                expected,
                JoinActorState::Anonymous | JoinActorState::Eligible
            ),
            "Join visibility should match actor state {expected:?}",
        );
        assert!(
            preview.membership_actions.is_empty(),
            "PagePreview must never issue a saved-page Join action binding",
        );
    }

    runner.set_request_context(RequestContext {
        user_id: Some(user_id),
        site_id: Some(editable.site_id),
        page_reference: Some(Reference::Slug(Cow::Owned(join_slug.clone()))),
        ..Default::default()
    });
    let join_request = json!({
        "page_id": join_action["page_id"],
        "last_revision_id": join_action["revision_id"],
        "action_index": join_action["index"],
        "action_fingerprint": join_action["fingerprint"],
        "actor": SYSTEM_USER_ID,
        "site_id": mirror.site_id,
        "policy": "closed",
        "token": "not-authority",
        "ip_address": common::IP_ADDRESS,
    });
    let forged = run_endpoint_err!(
        runner,
        membership_join,
        json!({
            "page_id": join_action["page_id"],
            "last_revision_id": join_action["revision_id"],
            "action_index": join_action["index"],
            "action_fingerprint": "00000000000000000000000000000000",
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(forged, ErrorType::PermissionDenied);

    let decoy_slug = format!("system:join-decoy-{n}");
    let decoy = PageService::create(
        runner.context(),
        CreatePage {
            site_id: editable.site_id,
            wikitext: "[[module Join]]".to_owned(),
            title: "Decoy join page".to_owned(),
            alt_title: None,
            tags: Vec::new(),
            slug: decoy_slug,
            layout: None,
            revision_comments: "Create self-join decoy fixture".to_owned(),
            user_id: SYSTEM_USER_ID,
            bypass_filter: true,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("decoy join fixture should be created");
    let cross_page = run_endpoint_err!(
        runner,
        membership_join,
        json!({
            "page_id": decoy.page_id,
            "last_revision_id": decoy.revision_id,
            "action_index": join_action["index"],
            "action_fingerprint": join_action["fingerprint"],
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(cross_page, ErrorType::PermissionDenied);

    let joined = run_endpoint!(runner, membership_join, join_request.clone(),);
    assert_eq!(joined, MembershipJoinOutcome::Joined);
    assert_eq!(
        MembershipService::actor_state(
            runner.context(),
            editable.site_id,
            Some(user_id),
        )
        .await
        .expect("joined actor state should resolve"),
        JoinActorState::Member,
    );
    let repeated = run_endpoint!(runner, membership_join, join_request.clone(),);
    assert_eq!(repeated, MembershipJoinOutcome::AlreadyMember);
    for _ in 0..8 {
        let repeated = run_endpoint!(runner, membership_join, join_request.clone(),);
        assert_eq!(repeated, MembershipJoinOutcome::AlreadyMember);
    }
    let throttled = run_endpoint_err!(runner, membership_join, join_request.clone(),);
    assert_contains_error!(throttled, ErrorType::PermissionDenied);
    let throttled_again =
        run_endpoint_err!(runner, membership_join, join_request.clone(),);
    assert_contains_error!(throttled_again, ErrorType::PermissionDenied);
    let role_names = RoleService::get_all_roles_for_user_and_site(
        runner.context(),
        GetUserRolesInput {
            site_id: editable.site_id,
            user_id: Some(user_id),
            page_reference: None,
        },
    )
    .await
    .expect("joined actor roles should resolve")
    .into_iter()
    .map(|role| role.name)
    .collect::<Vec<_>>();
    assert!(role_names.iter().any(|name| name == "member"));
    assert!(!role_names.iter().any(|name| name == "admin"));

    let page_slug = format!("component:membership-vertical-{n}");
    runner.set_request_context(RequestContext {
        user_id: Some(user_id),
        site_id: Some(editable.site_id),
        page_reference: Some(Reference::Slug(Cow::Owned(page_slug.clone()))),
        ..Default::default()
    });
    let created = run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": editable.site_id,
            "wikitext": "Membership vertical slice",
            "title": "Membership vertical slice",
            "alt_title": null,
            "slug": page_slug,
            "layout": "wikidot",
            "revision_comments": "membership vertical slice",
            "user_id": user_id,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert!(created.page_id > 0);

    runner.set_request_context(RequestContext {
        user_id: Some(user_id),
        site_id: Some(editable.site_id),
        ..Default::default()
    });
    let joined_view = run_endpoint!(
        runner,
        page_view,
        json!({
            "site_id": editable.site_id,
            "session_token": user_session_token,
            "route": {"slug": join_slug.clone(), "extra": ""},
            "locales": ["en-US", "en"],
        }),
    );
    let GetPageViewOutput::Found {
        compiled_body_html,
        membership_actions,
        ..
    } = joined_view
    else {
        panic!("joined user should still be able to view the self-join route");
    };
    assert!(!compiled_body_html.contains("WIKIDOT.page.listeners.join"));
    assert!(membership_actions.is_empty());

    runner.set_request_context(RequestContext {
        user_id: Some(user_id),
        site_id: Some(mirror.site_id),
        page_reference: Some(Reference::Slug(Cow::Owned(join_slug.clone()))),
        ..Default::default()
    });
    let mirror_error = run_endpoint_err!(runner, membership_join, join_request,);
    assert_contains_error!(mirror_error, ErrorType::PermissionDenied);

    assert_eq!(
        MembershipService::policy(&editable),
        MembershipPolicy::Open,
        "the editable local-authoring site is the only open membership policy",
    );
    assert_eq!(
        MembershipService::policy(&mirror),
        MembershipPolicy::Closed,
        "imported mirror sites must remain closed",
    );
}

fn next_n() -> u64 {
    FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed)
}

struct RoleFixture {
    site_id: i64,
    user_id: i64,
    target_user_id: i64,
}

impl RoleFixture {
    async fn setup(runner: &mut TestRunner) -> Self {
        let n = next_n();

        let site = SiteService::create(
            runner.context(),
            CreateSite {
                slug: format!("role-test-{n}"),
                name: format!("Role test site {n}"),
                tagline: String::new(),
                description: format!("Role test site {n}"),
                default_page: None,
                layout: None,
                license: License::CcBySa40,
                locale: String::from("en"),
                ip_address: common::IP_ADDRESS,
            },
            None,
        )
        .await
        .expect("Failed to create test site");

        let user_id = create_test_user(runner, n, "actor").await;
        let target_user_id = create_test_user(runner, n, "target").await;
        grant_role_management(runner, site.site_id, user_id, n).await;

        runner.set_request_context(RequestContext {
            user_id: Some(user_id),
            ..Default::default()
        });

        RoleFixture {
            site_id: site.site_id,
            user_id,
            target_user_id,
        }
    }
}

async fn create_test_user(runner: &TestRunner, n: u64, label: &str) -> i64 {
    UserService::create(
        runner.context(),
        CreateUser {
            user_type: UserType::Regular,
            name: format!("Role Test User {n} {label}"),
            email: format!("role-test-{n}-{label}@email.com"),
            locales: vec![str!("en")],
            password: String::from("password-fixture"),
            bypass_filter: true,
            bypass_email_verification: true,
            override_user_id: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to create test user")
    .user_id
}

async fn grant_role_management(runner: &TestRunner, site_id: i64, user_id: i64, n: u64) {
    let role = RoleService::create(
        runner.context(),
        InternalCreateRoleInput {
            site_id,
            name: format!("Role Manager {n}"),
            description: None,
            is_virtual: false,
            parent_role_id: None,
            creating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to create role manager role");

    PermissionService::update_permissions_for_role(
        runner.context(),
        UpdateRolePermissionsInput {
            site_id,
            role_reference: Reference::Id(role.role_id),
            new_permissions: vec![
                Permission {
                    resource_type: Resource::Role,
                    resource_category: None,
                    action: Action::Edit,
                },
                Permission {
                    resource_type: Resource::Role,
                    resource_category: None,
                    action: Action::Assign,
                },
            ],
            cascade_removals: false,
            updating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to grant role manager permissions");

    RoleService::grant_role_to_user(
        runner.context(),
        GrantUserRoleInput {
            site_id,
            user_id,
            role_id: role.role_id,
            assigning_user_id: SYSTEM_USER_ID,
            expires_at: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to grant role manager role to user");
}

async fn create_role_via_service_bypassing_endpoint_validation(
    runner: &TestRunner,
    site_id: i64,
    name: &str,
    parent_role_id: Option<i64>,
) -> RoleModel {
    RoleService::create(
        runner.context(),
        InternalCreateRoleInput {
            site_id,
            name: str!(name),
            description: None,
            is_virtual: false,
            parent_role_id,
            creating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to create role")
}

async fn set_role_perms(
    runner: &TestRunner,
    site_id: i64,
    role_id: i64,
    actions: &[&str],
    cascade: bool,
) {
    let permissions: Vec<_> = actions
        .iter()
        .map(|a| json!({ "resource_type": "page", "resource_category": null, "action": a }))
        .collect();
    run_endpoint!(
        runner,
        role_update_permissions,
        json!({
            "site_id": site_id,
            "role_reference": role_id,
            "new_permissions": permissions,
            "cascade_removals": cascade,
            "updating_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
}

async fn reparent_role(
    runner: &TestRunner,
    site_id: i64,
    role_id: i64,
    new_parent_id: i64,
) {
    run_endpoint!(
        runner,
        role_reparent,
        json!({
            "site_id": site_id,
            "role_id": role_id,
            "new_parent_id": new_parent_id,
            "reparenting_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
}

#[tokio::test]
async fn role_create_and_list() {
    let mut runner = TestRunner::setup().await;
    let f = RoleFixture::setup(&mut runner).await;

    let err = run_endpoint_err!(
        runner,
        role_create,
        json!({
            "site_id": f.site_id,
            "name": "Moderator",
            "description": "A moderator role",
            "parent_role_id": -1,
            "creating_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    assert_contains_error!(err, ErrorType::RoleNotFound);

    let root_role = create_role_via_service_bypassing_endpoint_validation(
        &runner, f.site_id, "Root", None,
    )
    .await;

    let role = run_endpoint!(
        runner,
        role_create,
        json!({
            "site_id": f.site_id,
            "name": "Moderator",
            "description": "A moderator role",
            "parent_role_id": root_role.role_id,
            "creating_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    assert_eq!(role.name, "Moderator");
    assert_eq!(role.description, "A moderator role");
    assert!(!role.is_virtual);

    let roles = run_endpoint!(runner, list_site_roles, json!({ "site_id": f.site_id }));
    let get = roles
        .iter()
        .find(|r| r.role_id == role.role_id)
        .expect("Created role not found in site role listing");
    assert_eq!(get.role_id, role.role_id);
    assert_eq!(get.name, "Moderator");
}

#[tokio::test]
async fn role_update_info() {
    let mut runner = TestRunner::setup().await;
    let f = RoleFixture::setup(&mut runner).await;

    let role = create_role_via_service_bypassing_endpoint_validation(
        &runner, f.site_id, "OldName", None,
    )
    .await;

    let updated = run_endpoint!(
        runner,
        role_update_info,
        json!({
            "site_id": f.site_id,
            "role_id": role.role_id,
            "name": "NewName",
            "description": "New description",
            "updating_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    assert_eq!(updated.role_id, role.role_id);
    assert_eq!(updated.name, "NewName");
    assert_eq!(updated.description, "New description");
}

#[tokio::test]
async fn role_mutations_require_request_actor_with_role_edit_permission() {
    let mut runner = TestRunner::setup().await;
    let f = RoleFixture::setup(&mut runner).await;
    let root_role = create_role_via_service_bypassing_endpoint_validation(
        &runner, f.site_id, "Root", None,
    )
    .await;
    let other_root = create_role_via_service_bypassing_endpoint_validation(
        &runner,
        f.site_id,
        "OtherRoot",
        None,
    )
    .await;
    let child_role = create_role_via_service_bypassing_endpoint_validation(
        &runner,
        f.site_id,
        "Child",
        Some(root_role.role_id),
    )
    .await;

    runner.set_request_context(RequestContext::default());
    let err = run_endpoint_err!(
        runner,
        role_update_info,
        json!({
            "site_id": f.site_id,
            "role_id": root_role.role_id,
            "name": "AnonymousRename",
            "description": "Anonymous rename",
            "updating_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(err, ErrorType::PermissionDenied);

    let n = next_n();
    let unauthorized_user_id = create_test_user(&runner, n, "unauthorized-edit").await;
    runner.set_request_context(RequestContext {
        user_id: Some(unauthorized_user_id),
        ..Default::default()
    });

    let err = run_endpoint_err!(
        runner,
        role_create,
        json!({
            "site_id": f.site_id,
            "name": "UnauthorizedModerator",
            "description": "Should not be created",
            "parent_role_id": root_role.role_id,
            "creating_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(err, ErrorType::PermissionDenied);

    let err = run_endpoint_err!(
        runner,
        role_update_permissions,
        json!({
            "site_id": f.site_id,
            "role_reference": root_role.role_id,
            "new_permissions": [
                { "resource_type": "page", "resource_category": null, "action": "view" },
            ],
            "cascade_removals": false,
            "updating_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(err, ErrorType::PermissionDenied);

    let err = run_endpoint_err!(
        runner,
        role_reparent,
        json!({
            "site_id": f.site_id,
            "role_id": child_role.role_id,
            "new_parent_id": other_root.role_id,
            "reparenting_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(err, ErrorType::PermissionDenied);

    let err = run_endpoint_err!(
        runner,
        role_delete,
        json!({
            "site_id": f.site_id,
            "role_id": child_role.role_id,
            "deleting_user_id": SYSTEM_USER_ID,
            "reparent_children": false,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(err, ErrorType::PermissionDenied);

    let roles = run_endpoint!(runner, list_site_roles, json!({ "site_id": f.site_id }));
    assert!(
        roles
            .iter()
            .all(|role| role.name != "UnauthorizedModerator"),
        "Unauthorized role_create should not insert a role"
    );
    assert!(
        roles.iter().any(|role| role.role_id == child_role.role_id),
        "Unauthorized role_delete should not delete the child role"
    );
}

#[tokio::test]
async fn role_update_permissions_respect_hierarchy() {
    let mut runner = TestRunner::setup().await;
    let f = RoleFixture::setup(&mut runner).await;

    let parent = create_role_via_service_bypassing_endpoint_validation(
        &runner, f.site_id, "Parent", None,
    )
    .await;
    set_role_perms(&runner, f.site_id, parent.role_id, &["view", "edit"], false).await;

    let child = create_role_via_service_bypassing_endpoint_validation(
        &runner,
        f.site_id,
        "Child",
        Some(parent.role_id),
    )
    .await;
    set_role_perms(&runner, f.site_id, child.role_id, &["view"], false).await;

    let err = run_endpoint_err!(
        runner,
        role_update_permissions,
        json!({
            "site_id": f.site_id,
            "role_reference": child.role_id,
            "new_permissions": [
                { "resource_type": "page", "resource_category": null, "action": "view" },
                { "resource_type": "page", "resource_category": null, "action": "create" },
            ],
            "cascade_removals": false,
            "updating_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    assert_contains_error!(err, ErrorType::RoleHierarchyViolation { .. });

    set_role_perms(&runner, f.site_id, child.role_id, &["view", "edit"], false).await;

    let err = run_endpoint_err!(
        runner,
        role_update_permissions,
        json!({
            "site_id": f.site_id,
            "role_reference": parent.role_id,
            "new_permissions": [
                { "resource_type": "page", "resource_category": null, "action": "edit" },
            ],
            "cascade_removals": false,
            "updating_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(err, ErrorType::RoleHierarchyViolation { .. });

    set_role_perms(&runner, f.site_id, parent.role_id, &["edit"], true).await;

    let perms = run_endpoint!(
        runner,
        get_role_permissions,
        json!({
            "site_id": f.site_id,
            "role_reference": child.role_id,
            "human_readable_categories": false,
        }),
    );
    assert_eq!(
        perms.len(),
        1,
        "Expected child role to have 1 permission after cascading removal"
    );
}

#[tokio::test]
async fn role_delete() {
    let mut runner = TestRunner::setup().await;
    let f = RoleFixture::setup(&mut runner).await;

    let role_a = create_role_via_service_bypassing_endpoint_validation(
        &runner, f.site_id, "Role A", None,
    )
    .await;
    let role_b = create_role_via_service_bypassing_endpoint_validation(
        &runner,
        f.site_id,
        "Role B",
        Some(role_a.role_id),
    )
    .await;
    let _role_c = create_role_via_service_bypassing_endpoint_validation(
        &runner,
        f.site_id,
        "Role C",
        Some(role_b.role_id),
    )
    .await;

    let err = run_endpoint_err!(
        runner,
        role_delete,
        json!({
            "site_id": f.site_id,
            "role_id": role_b.role_id,
            "deleting_user_id": SYSTEM_USER_ID,
            "reparent_children": false,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    assert_contains_error!(err, ErrorType::DeleteRoleWithChildren);

    let deleted = run_endpoint!(
        runner,
        role_delete,
        json!({
            "site_id": f.site_id,
            "role_id": role_b.role_id,
            "deleting_user_id": SYSTEM_USER_ID,
            "reparent_children": true,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(deleted.role_id, role_b.role_id);
    assert!(
        deleted.deleted_at.is_some(),
        "Deleted role should have deleted_at timestamp set"
    );

    let roles = run_endpoint!(runner, list_site_roles, json!({ "site_id": f.site_id }),);
    assert!(
        roles.iter().all(|r| r.role_id != role_b.role_id),
        "Deleted role should not appear in site role listing"
    );

    let role_c = run_endpoint!(
        runner,
        role_get,
        json!({
            "site_id": f.site_id,
            "role_reference": "Role C",
        }),
    );

    assert_eq!(
        role_c.parent_role_id,
        Some(role_a.role_id),
        "Role C should now be a child of Role A after reparenting"
    );

    let err = run_endpoint_err!(
        runner,
        role_delete,
        json!({
            "site_id": f.site_id,
            "role_id": role_a.role_id,
            "deleting_user_id": SYSTEM_USER_ID,
            "reparent_children": true,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(err, ErrorType::DeleteRoleWithChildren);
}

#[tokio::test]
async fn grant_and_revoke_role() {
    let mut runner = TestRunner::setup().await;
    let f = RoleFixture::setup(&mut runner).await;

    let role = create_role_via_service_bypassing_endpoint_validation(
        &runner, f.site_id, "Member", None,
    )
    .await;

    let user_role = run_endpoint!(
        runner,
        grant_role_to_user,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
            "role_id": role.role_id,
            "assigning_user_id": SYSTEM_USER_ID,
            "expires_at": null,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    assert_eq!(user_role.user_id, f.target_user_id);
    assert_eq!(user_role.role_id, role.role_id);
    assert_eq!(user_role.assigned_by, f.user_id);

    let user_roles = run_endpoint!(
        runner,
        get_user_roles,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
        }),
    );
    assert_eq!(user_roles.len(), 1);
    assert_eq!(user_roles[0].role_id, role.role_id);

    let revoked = run_endpoint!(
        runner,
        revoke_role_from_user,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
            "role_id": role.role_id,
            "revoking_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    assert!(
        revoked.deleted_at.is_some(),
        "UserRole assignment should be deleted after revoking"
    );

    let user_roles = run_endpoint!(
        runner,
        get_user_roles,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
        }),
    );
    assert_eq!(
        user_roles.len(),
        0,
        "User should have no roles after revocation"
    );
}

#[tokio::test]
async fn role_assignment_and_membership_require_role_assign() {
    let mut runner = TestRunner::setup().await;
    let f = RoleFixture::setup(&mut runner).await;
    let role = create_role_via_service_bypassing_endpoint_validation(
        &runner, f.site_id, "Member", None,
    )
    .await;

    let membership_metadata = json!({
        "accepted": {
            "cause": "accepted",
            "user_id": f.user_id,
        },
    });

    runner.set_request_context(RequestContext::default());
    let err = run_endpoint_err!(
        runner,
        grant_role_to_user,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
            "role_id": role.role_id,
            "assigning_user_id": SYSTEM_USER_ID,
            "expires_at": null,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(err, ErrorType::PermissionDenied);

    let err = run_endpoint_err!(
        runner,
        membership_set,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
            "metadata": membership_metadata.clone(),
            "created_by": SYSTEM_USER_ID,

            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(err, ErrorType::PermissionDenied);

    let n = next_n();
    let unauthorized_user_id = create_test_user(&runner, n, "unauthorized-assign").await;
    runner.set_request_context(RequestContext {
        user_id: Some(unauthorized_user_id),
        ..Default::default()
    });

    let err = run_endpoint_err!(
        runner,
        grant_role_to_user,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
            "role_id": role.role_id,
            "assigning_user_id": SYSTEM_USER_ID,
            "expires_at": null,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(err, ErrorType::PermissionDenied);

    let err = run_endpoint_err!(
        runner,
        membership_set,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
            "metadata": membership_metadata.clone(),
            "created_by": SYSTEM_USER_ID,

            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(err, ErrorType::PermissionDenied);

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_id),
        ..Default::default()
    });

    let user_role = run_endpoint!(
        runner,
        grant_role_to_user,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
            "role_id": role.role_id,
            "assigning_user_id": SYSTEM_USER_ID,
            "expires_at": null,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(user_role.assigned_by, f.user_id);

    run_endpoint!(
        runner,
        membership_set,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
            "metadata": membership_metadata.clone(),
            "created_by": SYSTEM_USER_ID,

            "ip_address": common::IP_ADDRESS,
        }),
    );

    let membership = run_endpoint!(
        runner,
        membership_get,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
        }),
    )
    .expect("site membership should have been created");
    assert_eq!(membership.created_by, f.user_id);

    runner.set_request_context(RequestContext::default());

    let err = run_endpoint_err!(
        runner,
        revoke_role_from_user,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
            "role_id": role.role_id,
            "revoking_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(err, ErrorType::PermissionDenied);

    let err = run_endpoint_err!(
        runner,
        membership_remove,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
            "removed_by": SYSTEM_USER_ID,

            "ip_address": common::IP_ADDRESS,
            "reason": "test membership removal",
        }),
    );
    assert_contains_error!(err, ErrorType::PermissionDenied);

    runner.set_request_context(RequestContext {
        user_id: Some(unauthorized_user_id),
        ..Default::default()
    });

    let err = run_endpoint_err!(
        runner,
        revoke_role_from_user,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
            "role_id": role.role_id,
            "revoking_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(err, ErrorType::PermissionDenied);

    let err = run_endpoint_err!(
        runner,
        membership_remove,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
            "removed_by": SYSTEM_USER_ID,

            "ip_address": common::IP_ADDRESS,
            "reason": "test membership removal",
        }),
    );
    assert_contains_error!(err, ErrorType::PermissionDenied);

    let user_roles = run_endpoint!(
        runner,
        get_user_roles,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
        }),
    );
    assert!(
        user_roles
            .iter()
            .any(|user_role| user_role.role_id == role.role_id),
        "Unauthorized revoke_role_from_user should not revoke the role"
    );

    let membership = run_endpoint!(
        runner,
        membership_get,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
        }),
    );
    assert!(
        membership.is_some(),
        "Unauthorized membership_remove should not remove membership"
    );

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_id),
        ..Default::default()
    });

    let removed = run_endpoint!(
        runner,
        membership_remove,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
            "removed_by": SYSTEM_USER_ID,

            "ip_address": common::IP_ADDRESS,
            "reason": "test membership removal",
        }),
    );
    assert_eq!(removed.deleted_by, Some(f.user_id));
}

#[tokio::test]
async fn role_reparent_and_revoke_validate_role_site() {
    let mut runner = TestRunner::setup().await;
    let site_a = RoleFixture::setup(&mut runner).await;
    let site_a_role = create_role_via_service_bypassing_endpoint_validation(
        &runner,
        site_a.site_id,
        "Site A Role",
        None,
    )
    .await;

    let granted = run_endpoint!(
        runner,
        grant_role_to_user,
        json!({
            "site_id": site_a.site_id,
            "user_id": site_a.target_user_id,
            "role_id": site_a_role.role_id,
            "assigning_user_id": SYSTEM_USER_ID,
            "expires_at": null,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(granted.assigned_by, site_a.user_id);

    let site_b = RoleFixture::setup(&mut runner).await;
    let site_b_parent = create_role_via_service_bypassing_endpoint_validation(
        &runner,
        site_b.site_id,
        "Site B Parent",
        None,
    )
    .await;

    let err = run_endpoint_err!(
        runner,
        role_reparent,
        json!({
            "site_id": site_b.site_id,
            "role_id": site_a_role.role_id,
            "new_parent_id": site_b_parent.role_id,
            "reparenting_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(err, ErrorType::Role);

    let unchanged = run_endpoint!(
        runner,
        role_get,
        json!({
            "site_id": site_a.site_id,
            "role_reference": site_a_role.role_id,
        }),
    );
    assert_eq!(unchanged.parent_role_id, None);

    let err = run_endpoint_err!(
        runner,
        revoke_role_from_user,
        json!({
            "site_id": site_b.site_id,
            "user_id": site_a.target_user_id,
            "role_id": site_a_role.role_id,
            "revoking_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(err, ErrorType::RevokeUserRole);

    let user_roles = run_endpoint!(
        runner,
        get_user_roles,
        json!({
            "site_id": site_a.site_id,
            "user_id": site_a.target_user_id,
        }),
    );
    assert!(
        user_roles
            .iter()
            .any(|user_role| user_role.role_id == site_a_role.role_id),
        "Cross-site revoke_role_from_user should not revoke the role"
    );
}

#[tokio::test]
async fn role_grant_expiration() {
    let mut runner = TestRunner::setup().await;
    let f = RoleFixture::setup(&mut runner).await;

    let role = create_role_via_service_bypassing_endpoint_validation(
        &runner, f.site_id, "Member", None,
    )
    .await;

    let expired = run_endpoint!(
        runner,
        grant_role_to_user,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
            "role_id": role.role_id,
            "assigning_user_id": SYSTEM_USER_ID,
            "expires_at": now().format(&Rfc3339).unwrap(),
            "ip_address": common::IP_ADDRESS,
        }),
    );

    assert!(
        expired.expires_at.is_some(),
        "Expired role should have expires_at timestamp set"
    );

    let user_roles = run_endpoint!(
        runner,
        get_user_roles,
        json!({
            "site_id": f.site_id,
            "user_id": f.target_user_id,
        }),
    );
    assert_eq!(
        user_roles.len(),
        0,
        "Expired role should not show up in user's roles"
    );
}

#[tokio::test]
async fn role_reparent() {
    let mut runner = TestRunner::setup().await;
    let f = RoleFixture::setup(&mut runner).await;

    let parent = create_role_via_service_bypassing_endpoint_validation(
        &runner, f.site_id, "Parent", None,
    )
    .await;
    set_role_perms(&runner, f.site_id, parent.role_id, &["view", "edit"], false).await;

    let child = create_role_via_service_bypassing_endpoint_validation(
        &runner, f.site_id, "Child", None,
    )
    .await;
    set_role_perms(&runner, f.site_id, child.role_id, &["view"], false).await;

    reparent_role(&runner, f.site_id, child.role_id, parent.role_id).await;

    let roles = run_endpoint!(runner, list_site_roles, json!({ "site_id": f.site_id }),);
    let child_record = roles
        .iter()
        .find(|r| r.role_id == child.role_id)
        .expect("Child role not found in listing");
    assert_eq!(
        child_record.parent_role_id,
        Some(parent.role_id),
        "Child should now have parent set"
    );
}

#[tokio::test]
async fn role_reparent_deleted_parent_rejected() {
    let mut runner = TestRunner::setup().await;
    let f = RoleFixture::setup(&mut runner).await;

    let deleted_parent = create_role_via_service_bypassing_endpoint_validation(
        &runner,
        f.site_id,
        "Deleted Parent",
        None,
    )
    .await;
    set_role_perms(
        &runner,
        f.site_id,
        deleted_parent.role_id,
        &["view", "edit"],
        false,
    )
    .await;

    let child = create_role_via_service_bypassing_endpoint_validation(
        &runner, f.site_id, "Child", None,
    )
    .await;
    set_role_perms(&runner, f.site_id, child.role_id, &["view"], false).await;

    run_endpoint!(
        runner,
        role_delete,
        json!({
            "site_id": f.site_id,
            "role_id": deleted_parent.role_id,
            "deleting_user_id": SYSTEM_USER_ID,
            "reparent_children": false,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    let err = run_endpoint_err!(
        runner,
        role_reparent,
        json!({
            "site_id": f.site_id,
            "role_id": child.role_id,
            "new_parent_id": deleted_parent.role_id,
            "reparenting_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    assert_contains_error!(err, ErrorType::RoleNotFound);

    let roles = run_endpoint!(runner, list_site_roles, json!({ "site_id": f.site_id }),);
    let child_record = roles
        .iter()
        .find(|r| r.role_id == child.role_id)
        .expect("Child role not found in listing");
    assert_eq!(
        child_record.parent_role_id, None,
        "Child should not be parented under a deleted role"
    );
}

#[tokio::test]
async fn role_reparent_cycle_rejected() {
    let mut runner = TestRunner::setup().await;
    let f = RoleFixture::setup(&mut runner).await;

    let role_a = create_role_via_service_bypassing_endpoint_validation(
        &runner, f.site_id, "RoleA", None,
    )
    .await;
    set_role_perms(&runner, f.site_id, role_a.role_id, &["view"], false).await;

    let role_b = create_role_via_service_bypassing_endpoint_validation(
        &runner, f.site_id, "RoleB", None,
    )
    .await;
    set_role_perms(&runner, f.site_id, role_b.role_id, &["view"], false).await;

    reparent_role(&runner, f.site_id, role_a.role_id, role_b.role_id).await;

    let err = run_endpoint_err!(
        runner,
        role_reparent,
        json!({
            "site_id": f.site_id,
            "role_id": role_a.role_id,
            "new_parent_id": role_a.role_id,
            "reparenting_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    assert_contains_error!(err, ErrorType::CyclicRoleViolation { .. });

    let err = run_endpoint_err!(
        runner,
        role_reparent,
        json!({
            "site_id": f.site_id,
            "role_id": role_b.role_id,
            "new_parent_id": role_a.role_id,
            "reparenting_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    assert_contains_error!(err, ErrorType::CyclicRoleViolation { .. });
}

#[tokio::test]
async fn role_reparent_subset_violation_rejected() {
    let mut runner = TestRunner::setup().await;
    let f = RoleFixture::setup(&mut runner).await;

    let smaller = create_role_via_service_bypassing_endpoint_validation(
        &runner, f.site_id, "Parent", None,
    )
    .await;
    set_role_perms(&runner, f.site_id, smaller.role_id, &["view"], false).await;

    let bigger = create_role_via_service_bypassing_endpoint_validation(
        &runner, f.site_id, "Child", None,
    )
    .await;
    set_role_perms(&runner, f.site_id, bigger.role_id, &["view", "edit"], false).await;

    let err = run_endpoint_err!(
        runner,
        role_reparent,
        json!({
            "site_id": f.site_id,
            "role_id": bigger.role_id,
            "new_parent_id": smaller.role_id,
            "reparenting_user_id": SYSTEM_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    assert_contains_error!(err, ErrorType::RoleHierarchyViolation { .. });

    reparent_role(&runner, f.site_id, smaller.role_id, bigger.role_id).await;
}
