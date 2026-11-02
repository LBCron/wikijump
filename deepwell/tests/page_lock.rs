/*
 * tests/page_lock.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

#[macro_use]
mod common;

use self::common::TestRunner;
use deepwell::constants::{ADMIN_USER_ID, SYSTEM_USER_ID};
use deepwell::error::ErrorType;
use deepwell::models::audit_log::{Column as AuditLogColumn, Entity as AuditLogTable};
use deepwell::models::page::Entity as PageTable;
use deepwell::models::page_lock::{Column as PageLockColumn, Entity as PageLockTable};
use deepwell::services::category::CategoryService;
use deepwell::services::page_lock::{CreatePageLockInput, PageLockService};
use deepwell::services::permission::{PermissionCache, PermissionService};
use deepwell::services::role::{
    GrantUserRoleInput, InternalCreateRoleInput, RoleService, UpdateRolePermissionsInput,
};
use deepwell::services::{RequestContext, ServiceContext};
use deepwell::types::{Action, PageLockType, Permission, Reference, Resource};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter, QueryOrder,
    Set, TransactionTrait,
};
use serde_json::json;
use std::borrow::Cow;

async fn grant_page_lock_permissions(
    runner: &TestRunner,
    site_id: i64,
    scope: &str,
) -> i64 {
    let category_name = format!("security-page-lock-private-{scope}");
    let category_id =
        CategoryService::get_or_create(runner.context(), site_id, &category_name)
            .await
            .expect("page lock category should be created")
            .category_id;
    let role = RoleService::create(
        runner.context(),
        InternalCreateRoleInput {
            site_id,
            name: format!("security-page-lock-admin-{scope}"),
            description: None,
            is_virtual: false,
            parent_role_id: None,
            creating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("page lock role should be created");
    PermissionService::update_permissions_for_role(
        runner.context(),
        UpdateRolePermissionsInput {
            site_id,
            role_reference: Reference::Id(role.role_id),
            new_permissions: [
                Permission {
                    resource_type: Resource::Page,
                    resource_category: Some(Reference::Id(category_id)),
                    action: Action::View,
                },
                Permission {
                    resource_type: Resource::Page,
                    resource_category: Some(Reference::Id(category_id)),
                    action: Action::Create,
                },
                Permission {
                    resource_type: Resource::Page,
                    resource_category: Some(Reference::Id(category_id)),
                    action: Action::Edit,
                },
                Permission {
                    resource_type: Resource::Page,
                    resource_category: None,
                    action: Action::BypassLock,
                },
            ]
            .into_iter()
            .collect(),
            cascade_removals: false,
            updating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("page lock permissions should be assigned");
    RoleService::grant_role_to_user(
        runner.context(),
        GrantUserRoleInput {
            site_id,
            user_id: ADMIN_USER_ID,
            role_id: role.role_id,
            assigning_user_id: SYSTEM_USER_ID,
            expires_at: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("admin should receive page lock permissions");
    PermissionCache::invalidate_site(runner.context(), site_id)
        .await
        .expect("page lock permission cache should be invalidated");

    category_id
}

async fn set_page_category(runner: &TestRunner, page_id: i64, category_id: i64) {
    let page = PageTable::find_by_id(page_id)
        .one(runner.context().transaction())
        .await
        .expect("page category fixture lookup should succeed")
        .expect("page category fixture page should exist");
    let mut page = page.into_active_model();
    page.page_category_id = Set(category_id);
    page.update(runner.context().transaction())
        .await
        .expect("page category fixture update should succeed");
}

async fn create_page(runner: &mut TestRunner, site_id: i64, slug: &'static str) -> i64 {
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(Cow::Borrowed(slug))),
    });
    run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": site_id,
            "wikitext": "Page lock authorization fixture.",
            "title": slug,
            "alt_title": null,
            "slug": slug,
            "layout": "wikidot",
            "revision_comments": "create page lock authorization fixture",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    )
    .page_id
}

fn lock_input(page_id: i64, reason: &str, override_existing: bool) -> serde_json::Value {
    lock_input_with_type(page_id, reason, override_existing, "permission-only", None)
}

fn lock_input_with_type(
    page_id: i64,
    reason: &str,
    override_existing: bool,
    lock_type: &str,
    expires_at: Option<&str>,
) -> serde_json::Value {
    json!({
        "page": page_id,
        "expires_at": expires_at,
        "from_wikidot": false,
        "lock_type": lock_type,
        "reason": reason,
        "override_existing": override_existing,
        "ip_address": common::IP_ADDRESS,
    })
}

#[tokio::test]
async fn page_lock_create_override_audits_removal_before_replacement() {
    const SLUG: &str = "page-lock-override-audit-v24";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let category_id =
        grant_page_lock_permissions(&runner, site_id, "override-audit-v24").await;
    let page_id = create_page(&mut runner, site_id, SLUG).await;
    set_page_category(&runner, page_id, category_id).await;
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Id(page_id)),
    });

    run_endpoint!(
        runner,
        page_lock_create,
        lock_input(page_id, "original lock", false),
    );
    run_endpoint!(
        runner,
        page_lock_create,
        lock_input_with_type(
            page_id,
            "replacement lock",
            true,
            "author-or-permission-only",
            None,
        ),
    );

    let locks = PageLockTable::find()
        .filter(PageLockColumn::PageId.eq(page_id))
        .order_by_asc(PageLockColumn::PageLockId)
        .all(runner.context().transaction())
        .await
        .expect("page lock state lookup should succeed");
    assert_eq!(locks.len(), 2);
    assert!(locks[0].deleted_at.is_some());
    assert!(locks[1].deleted_at.is_none());

    let events = AuditLogTable::find()
        .filter(AuditLogColumn::PageId.eq(page_id))
        .filter(AuditLogColumn::EventType.is_in(["page_lock.create", "page_lock.remove"]))
        .order_by_asc(AuditLogColumn::EventId)
        .all(runner.context().transaction())
        .await
        .expect("page lock audit lookup should succeed");
    assert_eq!(events.len(), 3);
    assert_eq!(events[0].event_type, "page_lock.create");
    assert_eq!(events[1].event_type, "page_lock.remove");
    assert_eq!(events[2].event_type, "page_lock.create");
    assert_eq!(events[1].extra_id_1, Some(locks[0].page_lock_id));
    assert_eq!(events[1].extra_string_1.as_deref(), Some("permission-only"));
    assert_eq!(events[2].extra_id_1, Some(locks[1].page_lock_id));
    assert_eq!(
        events[2].extra_string_1.as_deref(),
        Some("author-or-permission-only"),
    );
    for event in &events[1..] {
        assert_eq!(event.user_id, Some(ADMIN_USER_ID));
        assert_eq!(event.ip_address.ip(), common::IP_ADDRESS);
        assert_eq!(event.page_id, Some(page_id));
        assert_eq!(event.site_id, Some(site_id));
    }
}

#[tokio::test]
async fn page_lock_create_does_not_audit_removal_without_an_active_lock() {
    const EMPTY_SLUG: &str = "page-lock-override-empty-audit-v24";
    const EXPIRED_SLUG: &str = "page-lock-override-expired-audit-v24";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let category_id =
        grant_page_lock_permissions(&runner, site_id, "inactive-audit-v24").await;

    let empty_page_id = create_page(&mut runner, site_id, EMPTY_SLUG).await;
    set_page_category(&runner, empty_page_id, category_id).await;
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Id(empty_page_id)),
    });
    run_endpoint!(
        runner,
        page_lock_create,
        lock_input(empty_page_id, "override without an old lock", true),
    );

    let expired_page_id = create_page(&mut runner, site_id, EXPIRED_SLUG).await;
    set_page_category(&runner, expired_page_id, category_id).await;
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Id(expired_page_id)),
    });
    run_endpoint!(
        runner,
        page_lock_create,
        lock_input_with_type(
            expired_page_id,
            "expired lock",
            false,
            "permission-only",
            Some("2000-01-01T00:00:00Z"),
        ),
    );
    run_endpoint!(
        runner,
        page_lock_create,
        lock_input(expired_page_id, "replacement after expiry", true),
    );

    for page_id in [empty_page_id, expired_page_id] {
        let remove_events = AuditLogTable::find()
            .filter(AuditLogColumn::EventType.eq("page_lock.remove"))
            .filter(AuditLogColumn::PageId.eq(page_id))
            .all(runner.context().transaction())
            .await
            .expect("inactive page lock removal audit lookup should succeed");
        assert!(remove_events.is_empty());
    }
    let expired_locks = PageLockTable::find()
        .filter(PageLockColumn::PageId.eq(expired_page_id))
        .order_by_asc(PageLockColumn::PageLockId)
        .all(runner.context().transaction())
        .await
        .expect("expired page lock state lookup should succeed");
    assert_eq!(expired_locks.len(), 2);
    assert!(expired_locks[0].deleted_at.is_none());
    assert!(expired_locks[1].deleted_at.is_none());
}

#[tokio::test]
async fn page_lock_create_without_override_errors_without_audit() {
    const SLUG: &str = "page-lock-no-override-audit-v24";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let category_id =
        grant_page_lock_permissions(&runner, site_id, "no-override-audit-v24").await;
    let page_id = create_page(&mut runner, site_id, SLUG).await;
    set_page_category(&runner, page_id, category_id).await;
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Id(page_id)),
    });
    run_endpoint!(
        runner,
        page_lock_create,
        lock_input(page_id, "original lock", false),
    );

    let error = run_endpoint_err!(
        runner,
        page_lock_create,
        lock_input(page_id, "rejected replacement", false),
    );
    assert_contains_error!(error, ErrorType::PageLockExists);

    let events = AuditLogTable::find()
        .filter(AuditLogColumn::PageId.eq(page_id))
        .filter(AuditLogColumn::EventType.is_in(["page_lock.create", "page_lock.remove"]))
        .all(runner.context().transaction())
        .await
        .expect("rejected page lock audit lookup should succeed");
    assert_eq!(events.len(), 1);
    assert_eq!(events[0].event_type, "page_lock.create");
    let locks = PageLockTable::find()
        .filter(PageLockColumn::PageId.eq(page_id))
        .all(runner.context().transaction())
        .await
        .expect("rejected page lock state lookup should succeed");
    assert_eq!(locks.len(), 1);
    assert!(locks[0].deleted_at.is_none());
}

#[tokio::test]
async fn page_lock_create_override_state_and_audits_roll_back_together() {
    const SLUG: &str = "page-lock-override-rollback-audit-v24";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let category_id =
        grant_page_lock_permissions(&runner, site_id, "rollback-audit-v24").await;
    let page_id = create_page(&mut runner, site_id, SLUG).await;
    set_page_category(&runner, page_id, category_id).await;
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Id(page_id)),
    });
    run_endpoint!(
        runner,
        page_lock_create,
        lock_input(page_id, "original lock", false),
    );
    let original_lock = PageLockTable::find()
        .filter(PageLockColumn::PageId.eq(page_id))
        .one(runner.context().transaction())
        .await
        .expect("original page lock lookup should succeed")
        .expect("original page lock should exist");

    let transaction = runner
        .context()
        .transaction()
        .begin()
        .await
        .expect("page lock override audit savepoint should begin");
    let ctx =
        ServiceContext::new(runner.state(), &transaction).with_request(RequestContext {
            session: None,
            user_id: Some(ADMIN_USER_ID),
            site_id: Some(site_id),
            page_reference: Some(Reference::Id(page_id)),
        });
    deepwell::endpoints::all::page_lock_create(
        &ctx,
        common::make_params(lock_input(page_id, "transactional replacement", true)),
    )
    .await
    .expect("transactional page lock override should succeed");

    let transactional_locks = PageLockTable::find()
        .filter(PageLockColumn::PageId.eq(page_id))
        .order_by_asc(PageLockColumn::PageLockId)
        .all(&transaction)
        .await
        .expect("transactional page lock lookup should succeed");
    assert_eq!(transactional_locks.len(), 2);
    assert!(transactional_locks[0].deleted_at.is_some());
    assert!(transactional_locks[1].deleted_at.is_none());
    let transactional_events = AuditLogTable::find()
        .filter(AuditLogColumn::PageId.eq(page_id))
        .filter(AuditLogColumn::EventType.is_in(["page_lock.create", "page_lock.remove"]))
        .order_by_asc(AuditLogColumn::EventId)
        .all(&transaction)
        .await
        .expect("transactional page lock audit lookup should succeed");
    assert_eq!(transactional_events.len(), 3);
    assert_eq!(transactional_events[1].event_type, "page_lock.remove");
    assert_eq!(transactional_events[2].event_type, "page_lock.create");
    let replacement_lock_id = transactional_locks[1].page_lock_id;

    drop(ctx);
    transaction
        .rollback()
        .await
        .expect("page lock override audit savepoint should roll back");

    let rolled_back_locks = PageLockTable::find()
        .filter(PageLockColumn::PageId.eq(page_id))
        .all(runner.context().transaction())
        .await
        .expect("rolled-back page lock lookup should succeed");
    assert_eq!(rolled_back_locks.len(), 1);
    assert_eq!(
        rolled_back_locks[0].page_lock_id,
        original_lock.page_lock_id
    );
    assert!(rolled_back_locks[0].deleted_at.is_none());
    assert!(
        PageLockTable::find_by_id(replacement_lock_id)
            .one(runner.context().transaction())
            .await
            .expect("rolled-back replacement page lock lookup should succeed")
            .is_none(),
    );
    let rolled_back_events = AuditLogTable::find()
        .filter(AuditLogColumn::PageId.eq(page_id))
        .filter(AuditLogColumn::EventType.is_in(["page_lock.create", "page_lock.remove"]))
        .all(runner.context().transaction())
        .await
        .expect("rolled-back page lock audit lookup should succeed");
    assert_eq!(rolled_back_events.len(), 1);
    assert_eq!(rolled_back_events[0].event_type, "page_lock.create");
}

fn lock_service_input(
    page_id: i64,
    reason: &str,
    override_existing: bool,
) -> CreatePageLockInput {
    CreatePageLockInput {
        page: Reference::Id(page_id),
        expires_at: None,
        from_wikidot: false,
        lock_type: PageLockType::PermissionOnly,
        reason: Some(reason.to_owned()),
        override_existing,
        ip_address: common::IP_ADDRESS,
    }
}

#[tokio::test]
async fn page_lock_endpoints_require_site_membership_and_page_view_history_permission() {
    const PRIVATE_SLUG: &str = "security-page-lock-private-719:target";
    const OTHER_SLUG: &str = "security-page-lock-other-719";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let other_site = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("seeded test site should exist");
    let other_site_id = other_site.site.site_id;
    let private_category_id =
        grant_page_lock_permissions(&runner, site_id, "authorization-719").await;

    let private_page = create_page(&mut runner, site_id, PRIVATE_SLUG).await;
    set_page_category(&runner, private_page, private_category_id).await;
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Id(private_page)),
    });
    run_endpoint!(
        runner,
        page_lock_create,
        lock_input(private_page, "private history", false)
    );

    let history =
        run_endpoint!(runner, page_lock_get_history, json!({"page": private_page}));
    assert_eq!(history.len(), 1);

    let other_page = create_page(&mut runner, other_site_id, OTHER_SLUG).await;
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Id(other_page)),
    });
    let cross_site_create = run_endpoint_err!(
        runner,
        page_lock_create,
        lock_input(other_page, "cross-site create", false),
    );
    assert_contains_error!(cross_site_create, ErrorType::PageLock);

    PageLockService::create(
        runner.context(),
        other_site_id,
        ADMIN_USER_ID,
        Reference::Id(other_page),
        lock_service_input(other_page, "cross-site remove", false),
    )
    .await
    .expect("other-site lock fixture should be created");
    let cross_site_remove = run_endpoint_err!(
        runner,
        page_lock_remove,
        json!({"page": other_page, "ip_address": common::IP_ADDRESS}),
    );
    assert_contains_error!(cross_site_remove, ErrorType::PageLock);

    runner.set_request_context(RequestContext {
        session: None,
        user_id: None,
        site_id: Some(site_id),
        page_reference: Some(Reference::Id(private_page)),
    });
    let anonymous_history =
        run_endpoint_err!(runner, page_lock_get_history, json!({"page": private_page}),);
    assert_contains_error!(anonymous_history, ErrorType::PermissionDenied);
}
