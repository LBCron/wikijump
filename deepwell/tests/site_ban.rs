/*
 * tests/site_ban.rs
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

#[macro_use]
mod common;

use self::common::TestRunner;
use deepwell::constants::{
    ADMIN_USER_ID, SAMPLE_USER_ID, SYSTEM_USER_ID, UNKNOWN_USER_ID,
};
use deepwell::error::prelude::*;
use deepwell::models::audit_log::{self, Entity as AuditLog};
use deepwell::models::relation::{self, Entity as Relation};
use deepwell::services::permission::PermissionService;
use deepwell::services::role::{
    GrantUserRoleInput, InternalCreateRoleInput, RoleService, UpdateRolePermissionsInput,
};
use deepwell::services::{RelationService, RequestContext, UserService};
use deepwell::types::{Action, Permission, Reference, RelationType, Resource};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder};
use serde_json::json;

const SITE_SLUG: &str = "test";

async fn test_site_id(runner: &TestRunner) -> i64 {
    run_endpoint!(runner, site_get, json!({ "site": SITE_SLUG }))
        .expect("Seeded test site not found")
        .site
        .site_id
}

async fn clear_site_ban(runner: &TestRunner, site_id: i64, user_id: i64) {
    let current = run_endpoint!(
        runner,
        site_ban_get,
        json!({
            "site_id": site_id,
            "user_id": user_id,
        }),
    );

    if current.is_some() {
        run_endpoint!(
            runner,
            site_ban_remove,
            json!({
                "site_id": site_id,
                "user_id": user_id,
                "removed_by": ADMIN_USER_ID,
                "reason": "Test site ban removal",
                "ip_address": common::IP_ADDRESS,
            }),
        );
    }
}

async fn clear_site_membership(runner: &TestRunner, site_id: i64, user_id: i64) {
    let current = run_endpoint!(
        runner,
        membership_get,
        json!({
            "site_id": site_id,
            "user_id": user_id,
        }),
    );

    if current.is_some() {
        run_endpoint!(
            runner,
            membership_remove,
            json!({
                "site_id": site_id,
                "user_id": user_id,
                "removed_by": ADMIN_USER_ID,

                "ip_address": common::IP_ADDRESS,
                "reason": "test membership removal",
            }),
        );
    }
}

async fn latest_audit_event(
    runner: &TestRunner,
    event_type: &str,
    site_id: i64,
    target_user_id: i64,
) -> audit_log::Model {
    AuditLog::find()
        .filter(audit_log::Column::EventType.eq(event_type))
        .filter(audit_log::Column::SiteId.eq(site_id))
        .filter(audit_log::Column::UserId.eq(target_user_id))
        .order_by_desc(audit_log::Column::EventId)
        .one(runner.context().transaction())
        .await
        .expect("Unable to query audit log")
        .expect("Expected audit event was not found")
}

fn request_actor(user_id: Option<i64>) -> RequestContext {
    RequestContext {
        user_id,
        ..Default::default()
    }
}

async fn audit_event_count(
    runner: &TestRunner,
    event_type: &str,
    site_id: i64,
    target_user_id: i64,
) -> usize {
    AuditLog::find()
        .filter(audit_log::Column::EventType.eq(event_type))
        .filter(audit_log::Column::SiteId.eq(site_id))
        .filter(audit_log::Column::UserId.eq(target_user_id))
        .all(runner.context().transaction())
        .await
        .expect("Unable to query site-ban audit events")
        .len()
}

async fn assert_site_ban_set_denied(
    runner: &mut TestRunner,
    request: RequestContext,
    site_id: i64,
    target_user_id: i64,
    created_by: i64,
) {
    runner.set_request_context(request);
    let error = run_endpoint_err!(
        runner,
        site_ban_set,
        json!({
            "site_id": site_id,
            "user_id": target_user_id,
            "metadata": {
                "banned_until": null,
                "reason": "authorization probe",
            },
            "created_by": created_by,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(error, ErrorType::PermissionDenied);
}

async fn assert_site_ban_remove_denied(
    runner: &mut TestRunner,
    request: RequestContext,
    site_id: i64,
    target_user_id: i64,
    removed_by: i64,
) {
    runner.set_request_context(request);
    let error = run_endpoint_err!(
        runner,
        site_ban_remove,
        json!({
            "site_id": site_id,
            "user_id": target_user_id,
            "removed_by": removed_by,
            "reason": "authorization probe",
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(error, ErrorType::PermissionDenied);
}

// The registered-RPC harness commits an independent transaction and cannot
// share these rollback-contained fixtures, so this exercises the endpoint seam.
#[tokio::test]
async fn lifecycle_membership_blocking_and_audit() {
    let mut runner = TestRunner::setup().await;
    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        ..Default::default()
    });
    let site_id = test_site_id(&runner).await;
    let user_id = SAMPLE_USER_ID;

    const REASON: &str = "site-ban integration test";

    clear_site_ban(&runner, site_id, user_id).await;
    clear_site_membership(&runner, site_id, user_id).await;

    let role = RoleService::create(
        runner.context(),
        InternalCreateRoleInput {
            site_id,
            name: String::from("Site Ban Test Role"),
            description: None,
            is_virtual: false,
            parent_role_id: None,
            creating_user_id: ADMIN_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to create site-ban test role");

    run_endpoint!(
        runner,
        grant_role_to_user,
        json!({
            "site_id": site_id,
            "user_id": user_id,
            "role_id": role.role_id,
            "assigning_user_id": ADMIN_USER_ID,
            "expires_at": null,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    // A malformed request must fail before creating a ban.
    let error = run_endpoint_err!(
        runner,
        site_ban_set,
        json!({
            "site_id": site_id,
            "user_id": user_id,
            "metadata": {
                "banned_until": null,
                "reason": "missing IP address",
            },
            "created_by": ADMIN_USER_ID,
        }),
    );

    assert_contains_error!(error, ErrorType::SiteBanRelation);

    let ban = run_endpoint!(
        runner,
        site_ban_get,
        json!({
            "site_id": site_id,
            "user_id": user_id,
        }),
    );
    assert!(ban.is_none(), "Malformed request created a site ban");

    // Add the user as a member before banning them.
    run_endpoint!(
        runner,
        membership_set,
        json!({
            "site_id": site_id,
            "user_id": user_id,
            "metadata": {
                "accepted": {
                    "cause": "accepted",
                    "user_id": ADMIN_USER_ID,
                },
            },
            "created_by": ADMIN_USER_ID,

            "ip_address": common::IP_ADDRESS,
        }),
    );

    let membership = run_endpoint!(
        runner,
        membership_get,
        json!({
            "site_id": site_id,
            "user_id": user_id,
        }),
    );
    assert!(membership.is_some(), "Site membership was not created");

    let create_audit_count =
        audit_event_count(&runner, "site_ban.create", site_id, user_id).await;

    // Ordinary actor on the target site.
    assert_site_ban_set_denied(
        &mut runner,
        request_actor(Some(UNKNOWN_USER_ID)),
        site_id,
        user_id,
        UNKNOWN_USER_ID,
    )
    .await;

    // Grant that actor role:assign on a different site; target-site authority
    // must remain unchanged.
    let other_site_id =
        run_endpoint!(runner, site_get, json!({"site": "scpaiueouiuiuiui"}),)
            .expect("Seeded editable site not found")
            .site
            .site_id;
    let manager_role = RoleService::create(
        runner.context(),
        InternalCreateRoleInput {
            site_id: other_site_id,
            name: String::from("Cross-site Site Ban Manager"),
            description: None,
            is_virtual: false,
            parent_role_id: None,
            creating_user_id: ADMIN_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to create cross-site manager role");
    PermissionService::update_permissions_for_role(
        runner.context(),
        UpdateRolePermissionsInput {
            site_id: other_site_id,
            role_reference: Reference::Id(manager_role.role_id),
            new_permissions: vec![Permission {
                resource_type: Resource::Role,
                resource_category: None,
                action: Action::Assign,
            }],
            cascade_removals: false,
            updating_user_id: ADMIN_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to configure cross-site manager role");
    RoleService::grant_role_to_user(
        runner.context(),
        GrantUserRoleInput {
            user_id: UNKNOWN_USER_ID,
            role_id: manager_role.role_id,
            site_id: other_site_id,
            assigning_user_id: ADMIN_USER_ID,
            expires_at: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to grant cross-site manager role");

    for (request, created_by) in [
        (request_actor(Some(UNKNOWN_USER_ID)), UNKNOWN_USER_ID),
        (request_actor(None), ADMIN_USER_ID),
        (request_actor(Some(ADMIN_USER_ID)), UNKNOWN_USER_ID),
    ] {
        assert_site_ban_set_denied(&mut runner, request, site_id, user_id, created_by)
            .await;
    }

    let ban = run_endpoint!(
        runner,
        site_ban_get,
        json!({"site_id": site_id, "user_id": user_id}),
    );
    let membership = run_endpoint!(
        runner,
        membership_get,
        json!({"site_id": site_id, "user_id": user_id}),
    );
    let roles = run_endpoint!(
        runner,
        get_user_roles,
        json!({"site_id": site_id, "user_id": user_id}),
    );
    let create_audit_count_after =
        audit_event_count(&runner, "site_ban.create", site_id, user_id).await;
    assert!(ban.is_none(), "Denied request created a site ban");
    assert!(membership.is_some(), "Denied request removed membership");
    assert!(
        roles.iter().any(|item| item.role_id == role.role_id),
        "Denied request removed the target role",
    );
    assert_eq!(create_audit_count_after, create_audit_count);

    runner.set_request_context(request_actor(Some(ADMIN_USER_ID)));

    // Creating the ban must remove the existing membership.
    run_endpoint!(
        runner,
        site_ban_set,
        json!({
            "site_id": site_id,
            "user_id": user_id,
            "metadata": {
                "banned_until": null,
                "reason": REASON,
            },
            "created_by": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    let ban = run_endpoint!(
        runner,
        site_ban_get,
        json!({
            "site_id": site_id,
            "user_id": user_id,
        }),
    )
    .expect("Site ban was not created");

    assert_eq!(ban.from_id, user_id);
    assert_eq!(ban.dest_id, site_id);
    assert_eq!(ban.metadata["banned_until"], json!(null));
    assert_eq!(ban.metadata["reason"], json!(REASON));

    let membership = run_endpoint!(
        runner,
        membership_get,
        json!({
            "site_id": site_id,
            "user_id": user_id,
        }),
    );
    assert!(
        membership.is_none(),
        "Banning the user did not remove their site membership",
    );

    let roles = run_endpoint!(
        runner,
        get_user_roles,
        json!({
            "site_id": site_id,
            "user_id": user_id,
        }),
    );

    assert!(
        roles.iter().all(|item| item.role_id != role.role_id),
        "Banning the user did not remove their site role",
    );

    // A banned user must not be able to become a member again.
    let error = run_endpoint_err!(
        runner,
        membership_set,
        json!({
            "site_id": site_id,
            "user_id": user_id,
            "metadata": {
                "accepted": {
                    "cause": "accepted",
                    "user_id": ADMIN_USER_ID,
                },
            },
            "created_by": ADMIN_USER_ID,

            "ip_address": common::IP_ADDRESS,
        }),
    );

    assert_contains_error!(error, ErrorType::SiteBannedUser);

    let membership = run_endpoint!(
        runner,
        membership_get,
        json!({
            "site_id": site_id,
            "user_id": user_id,
        }),
    );
    assert!(
        membership.is_none(),
        "Failed membership attempt left a partial relation",
    );

    // A banned user must not receive a new site role.
    let error = run_endpoint_err!(
        runner,
        grant_role_to_user,
        json!({
            "site_id": site_id,
            "user_id": user_id,
            "role_id": role.role_id,
            "assigning_user_id": ADMIN_USER_ID,
            "expires_at": null,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    assert_contains_error!(error, ErrorType::SiteBannedUser);

    let roles = run_endpoint!(
        runner,
        get_user_roles,
        json!({
            "site_id": site_id,
            "user_id": user_id,
        }),
    );

    assert!(
        roles.iter().all(|item| item.role_id != role.role_id),
        "Failed role-grant attempt restored the removed role",
    );

    // Verify the ban creation audit event.
    let create_event =
        latest_audit_event(&runner, "site_ban.create", site_id, user_id).await;

    assert_eq!(create_event.ip_address.ip(), common::IP_ADDRESS);
    assert_eq!(create_event.user_id, Some(user_id));
    assert_eq!(create_event.site_id, Some(site_id));
    assert_eq!(create_event.extra_id_1, Some(ADMIN_USER_ID));
    assert_eq!(create_event.extra_string_1.as_deref(), Some(REASON));
    assert_eq!(create_event.extra_string_2, None);

    let remove_audit_count =
        audit_event_count(&runner, "site_ban.remove", site_id, user_id).await;
    for (request, removed_by) in [
        (request_actor(Some(user_id)), user_id),
        (request_actor(Some(UNKNOWN_USER_ID)), UNKNOWN_USER_ID),
        (request_actor(None), ADMIN_USER_ID),
        (request_actor(Some(ADMIN_USER_ID)), UNKNOWN_USER_ID),
    ] {
        assert_site_ban_remove_denied(&mut runner, request, site_id, user_id, removed_by)
            .await;
    }
    let active_ban = run_endpoint!(
        runner,
        site_ban_get,
        json!({"site_id": site_id, "user_id": user_id}),
    )
    .expect("Denied request removed the site ban");
    let remove_audit_count_after =
        audit_event_count(&runner, "site_ban.remove", site_id, user_id).await;
    assert_eq!(active_ban.relation_id, ban.relation_id);
    assert_eq!(remove_audit_count_after, remove_audit_count);

    runner.set_request_context(request_actor(Some(ADMIN_USER_ID)));

    // Removing the ban must soft-delete it and add another audit event.
    let removed = run_endpoint!(
        runner,
        site_ban_remove,
        json!({
            "site_id": site_id,
            "user_id": user_id,
            "removed_by": ADMIN_USER_ID,
            "reason": "Test site ban removal",
            "ip_address": common::IP_ADDRESS,
        }),
    );

    assert_eq!(removed.deleted_by, Some(ADMIN_USER_ID));
    assert!(removed.deleted_at.is_some());

    let ban = run_endpoint!(
        runner,
        site_ban_get,
        json!({
            "site_id": site_id,
            "user_id": user_id,
        }),
    );
    assert!(ban.is_none(), "Removed site ban is still active");

    let remove_event =
        latest_audit_event(&runner, "site_ban.remove", site_id, user_id).await;

    assert_eq!(remove_event.ip_address.ip(), common::IP_ADDRESS);
    assert_eq!(remove_event.user_id, Some(user_id));
    assert_eq!(remove_event.site_id, Some(site_id));
    assert_eq!(remove_event.extra_id_1, Some(ADMIN_USER_ID));
    assert_eq!(remove_event.extra_id_2, Some(removed.relation_id));
    assert_eq!(
        remove_event.extra_string_1.as_deref(),
        Some("Test site ban removal")
    );
    assert_eq!(remove_event.extra_string_2, None);
}

#[tokio::test]
async fn authorized_manager_can_remove_ban_after_target_is_tombstoned() {
    let mut runner = TestRunner::setup().await;
    runner.set_request_context(request_actor(Some(ADMIN_USER_ID)));
    let site_id = test_site_id(&runner).await;

    let target = run_endpoint!(
        runner,
        user_create,
        json!({
            "user_type": "regular",
            "name": "Tombstoned Site Ban Target",
            "email": "tombstoned-site-ban-target@example.invalid",
            "locales": ["en"],
            "password": "password-fixture",
            "ip_address": common::IP_ADDRESS,
        }),
    );

    let manager_role = RoleService::create(
        runner.context(),
        InternalCreateRoleInput {
            site_id,
            name: String::from("Tombstoned Site Ban Manager"),
            description: None,
            is_virtual: false,
            parent_role_id: None,
            creating_user_id: ADMIN_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to create site-ban manager role");
    PermissionService::update_permissions_for_role(
        runner.context(),
        UpdateRolePermissionsInput {
            site_id,
            role_reference: Reference::Id(manager_role.role_id),
            new_permissions: vec![Permission {
                resource_type: Resource::Role,
                resource_category: None,
                action: Action::Assign,
            }],
            cascade_removals: false,
            updating_user_id: ADMIN_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to configure site-ban manager role");
    RoleService::grant_role_to_user(
        runner.context(),
        GrantUserRoleInput {
            user_id: UNKNOWN_USER_ID,
            role_id: manager_role.role_id,
            site_id,
            assigning_user_id: ADMIN_USER_ID,
            expires_at: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to grant site-ban manager role");

    run_endpoint!(
        runner,
        site_ban_set,
        json!({
            "site_id": site_id,
            "user_id": target.user_id,
            "metadata": {
                "banned_until": null,
                "reason": "tombstone removal test",
            },
            "created_by": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    let deleted = run_endpoint!(
        runner,
        user_delete,
        json!({
            "user": target.user_id,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert!(deleted.deleted_at.is_some());

    runner.set_request_context(request_actor(Some(UNKNOWN_USER_ID)));
    let error = run_endpoint_err!(
        runner,
        site_ban_set,
        json!({
            "site_id": site_id,
            "user_id": target.user_id,
            "metadata": {
                "banned_until": null,
                "reason": "must not recreate against a deleted user",
            },
            "created_by": UNKNOWN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(error, ErrorType::UserNotFound);

    assert_site_ban_remove_denied(
        &mut runner,
        request_actor(Some(UNKNOWN_USER_ID)),
        site_id,
        target.user_id,
        ADMIN_USER_ID,
    )
    .await;
    assert_site_ban_remove_denied(
        &mut runner,
        request_actor(Some(SAMPLE_USER_ID)),
        site_id,
        target.user_id,
        SAMPLE_USER_ID,
    )
    .await;

    runner.set_request_context(request_actor(Some(ADMIN_USER_ID)));
    let other_site_id =
        run_endpoint!(runner, site_get, json!({"site": "scpaiueouiuiuiui"}),)
            .expect("Seeded editable site not found")
            .site
            .site_id;
    for (candidate_site_id, candidate_user_id) in
        [(other_site_id, target.user_id), (site_id, 700_999_i64)]
    {
        let error = run_endpoint_err!(
            runner,
            site_ban_remove,
            json!({
                "site_id": candidate_site_id,
                "user_id": candidate_user_id,
                "removed_by": ADMIN_USER_ID,
                "reason": "non-matching site ban",
                "ip_address": common::IP_ADDRESS,
            }),
        );
        assert_contains_error!(error, ErrorType::SiteBanRelation);
    }
    let active = run_endpoint!(
        runner,
        site_ban_get,
        json!({"site_id": site_id, "user_id": target.user_id}),
    );
    assert!(active.is_some(), "Rejected removal removed the site ban");

    runner.set_request_context(request_actor(Some(UNKNOWN_USER_ID)));
    let removed = run_endpoint!(
        runner,
        site_ban_remove,
        json!({
            "site_id": site_id,
            "user_id": target.user_id,
            "removed_by": UNKNOWN_USER_ID,
            "reason": "target account was deleted",
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(removed.deleted_by, Some(UNKNOWN_USER_ID));
    assert!(removed.deleted_at.is_some());

    let ban = run_endpoint!(
        runner,
        site_ban_get,
        json!({"site_id": site_id, "user_id": target.user_id}),
    );
    assert!(ban.is_none(), "Removed site ban is still active");

    let tombstone =
        UserService::get_real(runner.context(), Reference::Id(target.user_id))
            .await
            .expect("Tombstoned target user was not found");
    assert!(
        tombstone.deleted_at.is_some(),
        "Removing the site ban restored the target account",
    );

    let remove_event =
        latest_audit_event(&runner, "site_ban.remove", site_id, target.user_id).await;
    assert_eq!(remove_event.extra_id_1, Some(UNKNOWN_USER_ID));
    assert_eq!(remove_event.extra_id_2, Some(removed.relation_id));
    assert_eq!(
        remove_event.extra_string_1.as_deref(),
        Some("target account was deleted"),
    );
}

#[tokio::test]
async fn expiration_cleanup_preserves_future_and_permanent_bans() {
    let mut runner = TestRunner::setup().await;
    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        ..Default::default()
    });
    let site_id = test_site_id(&runner).await;
    let user_id = UNKNOWN_USER_ID;

    clear_site_ban(&runner, site_id, user_id).await;
    clear_site_membership(&runner, site_id, user_id).await;

    // Banning a non-member must succeed.
    run_endpoint!(
        runner,
        site_ban_set,
        json!({
            "site_id": site_id,
            "user_id": user_id,
            "metadata": {
                "banned_until": "2000-01-01",
                "reason": "expired site-ban test",
            },
            "created_by": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    let lifted = RelationService::lift_expired_site_bans(runner.context())
        .await
        .expect("Failed to lift expired site bans");

    assert!(lifted >= 1, "Expired site ban was not lifted");

    let ban = run_endpoint!(
        runner,
        site_ban_get,
        json!({
            "site_id": site_id,
            "user_id": user_id,
        }),
    );
    assert!(ban.is_none(), "Expired site ban is still active");

    let expired_relation = Relation::find()
        .filter(relation::Column::RelationType.eq(RelationType::SiteBan))
        .filter(relation::Column::DestId.eq(site_id))
        .filter(relation::Column::FromId.eq(user_id))
        .order_by_desc(relation::Column::RelationId)
        .one(runner.context().transaction())
        .await
        .expect("Unable to query expired site-ban relation")
        .expect("Expired site-ban relation was not found");

    assert_eq!(expired_relation.deleted_by, Some(SYSTEM_USER_ID));
    assert!(
        expired_relation.deleted_at.is_some(),
        "Expired site ban was not soft-deleted",
    );
    let expiry_event =
        latest_audit_event(&runner, "site_ban.remove", site_id, user_id).await;

    assert_eq!(expiry_event.ip_address.ip().to_string(), "::1");
    assert_eq!(expiry_event.user_id, Some(user_id));
    assert_eq!(expiry_event.site_id, Some(site_id));
    assert_eq!(expiry_event.extra_id_1, Some(SYSTEM_USER_ID));
    assert_eq!(expiry_event.extra_id_2, Some(expired_relation.relation_id));
    assert_eq!(
        expiry_event.extra_string_1.as_deref(),
        Some("Site ban expired")
    );
    assert_eq!(expiry_event.extra_string_2, None);

    // A future ban must survive the cleanup operation.
    run_endpoint!(
        runner,
        site_ban_set,
        json!({
            "site_id": site_id,
            "user_id": user_id,
            "metadata": {
                "banned_until": "2999-01-01",
                "reason": "future site-ban test",
            },
            "created_by": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    RelationService::lift_expired_site_bans(runner.context())
        .await
        .expect("Failed to run cleanup for future site ban");

    let future_ban = run_endpoint!(
        runner,
        site_ban_get,
        json!({
            "site_id": site_id,
            "user_id": user_id,
        }),
    )
    .expect("Future site ban was incorrectly lifted");

    assert_eq!(future_ban.metadata["banned_until"], json!("2999-01-01"));

    run_endpoint!(
        runner,
        site_ban_remove,
        json!({
            "site_id": site_id,
            "user_id": user_id,
            "removed_by": ADMIN_USER_ID,
            "reason": "Test site ban removal",
            "ip_address": common::IP_ADDRESS,
        }),
    );

    // A permanent ban must also survive cleanup.
    run_endpoint!(
        runner,
        site_ban_set,
        json!({
            "site_id": site_id,
            "user_id": user_id,
            "metadata": {
                "banned_until": null,
                "reason": "permanent site-ban test",
            },
            "created_by": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    RelationService::lift_expired_site_bans(runner.context())
        .await
        .expect("Failed to run cleanup for permanent site ban");

    let permanent_ban = run_endpoint!(
        runner,
        site_ban_get,
        json!({
            "site_id": site_id,
            "user_id": user_id,
        }),
    )
    .expect("Permanent site ban was incorrectly lifted");

    assert_eq!(permanent_ban.metadata["banned_until"], json!(null));
}

#[tokio::test]
async fn expiration_cleanup_does_not_remove_a_replacement_ban() {
    let mut runner = TestRunner::setup().await;
    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        ..Default::default()
    });
    let site_id = test_site_id(&runner).await;
    let user_id = UNKNOWN_USER_ID;

    clear_site_ban(&runner, site_id, user_id).await;
    clear_site_membership(&runner, site_id, user_id).await;

    run_endpoint!(
        runner,
        site_ban_set,
        json!({
            "site_id": site_id,
            "user_id": user_id,
            "metadata": {
                "banned_until": "2000-01-01",
                "reason": "stale expired ban",
            },
            "created_by": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    let expired = run_endpoint!(
        runner,
        site_ban_get,
        json!({
            "site_id": site_id,
            "user_id": user_id,
        }),
    )
    .expect("Expired ban fixture was not created");

    run_endpoint!(
        runner,
        site_ban_set,
        json!({
            "site_id": site_id,
            "user_id": user_id,
            "metadata": {
                "banned_until": "2999-01-01",
                "reason": "replacement future ban",
            },
            "created_by": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    let replacement = run_endpoint!(
        runner,
        site_ban_get,
        json!({
            "site_id": site_id,
            "user_id": user_id,
        }),
    )
    .expect("Replacement ban fixture was not created");
    assert_ne!(expired.relation_id, replacement.relation_id);

    let lifted = RelationService::lift_expired_site_ban_if_current(
        runner.context(),
        expired.clone(),
    )
    .await
    .expect("Stale cleanup attempt failed");
    assert!(!lifted, "Stale expired relation was reported as lifted");

    let active = run_endpoint!(
        runner,
        site_ban_get,
        json!({
            "site_id": site_id,
            "user_id": user_id,
        }),
    )
    .expect("Replacement ban was incorrectly removed");
    assert_eq!(active.relation_id, replacement.relation_id);
    assert_eq!(active.metadata["banned_until"], json!("2999-01-01"));

    let stale = Relation::find_by_id(expired.relation_id)
        .one(runner.context().transaction())
        .await
        .expect("Unable to query stale ban relation")
        .expect("Stale ban relation was not found");
    assert!(stale.overwritten_at.is_some());
    assert_eq!(stale.deleted_at, None);

    let removal_events = AuditLog::find()
        .filter(audit_log::Column::EventType.eq("site_ban.remove"))
        .filter(audit_log::Column::SiteId.eq(site_id))
        .filter(audit_log::Column::UserId.eq(user_id))
        .all(runner.context().transaction())
        .await
        .expect("Unable to query ban-removal audit events");
    assert!(
        removal_events.is_empty(),
        "Stale cleanup emitted a removal audit event: {removal_events:?}",
    );
}
