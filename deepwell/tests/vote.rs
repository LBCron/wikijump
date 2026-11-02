/*
 * tests/vote.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

#[macro_use]
mod common;

use self::common::TestRunner;
use deepwell::constants::{ADMIN_USER_ID, SYSTEM_USER_ID};
use deepwell::error::prelude::*;
use deepwell::license::License;
use deepwell::services::RequestContext;
use deepwell::services::job::{JOB_QUEUE_NAME, Job};
use deepwell::services::page_revision::{PageRevisionService, RerenderType};
use deepwell::services::permission::PermissionService;
use deepwell::services::public_cache::PublicContentCache;
use deepwell::services::role::{
    GrantUserRoleInput, InternalCreateRoleInput, RoleService, UpdateRolePermissionsInput,
};
use deepwell::services::site::{CreateSite, SiteService};
use deepwell::services::view::GetPageViewOutput;
use deepwell::types::{Action, Permission, Reference, RerenderDepth, Resource};
use futures::FutureExt;
use redis::AsyncCommands;
use rsmq_async::RsmqConnection;
use sea_orm::{ConnectionTrait, Statement};
use serde_json::json;
use std::env;
use std::panic::{AssertUnwindSafe, resume_unwind};
use uuid::Uuid;

async fn cleanup_job_queue_namespace(namespace: &str) {
    let redis_url =
        env::var("REDIS_URL").expect("REDIS_URL must be set for integration tests");
    let client = redis::Client::open(redis_url)
        .expect("failed to construct Rate test Redis client");
    let mut connection = client
        .get_multiplexed_async_connection()
        .await
        .expect("failed to connect for Rate queue cleanup");
    let keys: Vec<String> = redis::cmd("KEYS")
        .arg(format!("{namespace}:*"))
        .query_async(&mut connection)
        .await
        .expect("failed to list Rate test queue keys");
    if !keys.is_empty() {
        let _: usize = connection
            .del(keys)
            .await
            .expect("failed to delete Rate test queue keys");
    }
}

async fn create_registered_rate_page(
    runner: &mut TestRunner,
    category: &str,
    rating_type: &str,
    source: &str,
) -> (i64, String, i64, i64) {
    let site_id = SiteService::create(
        runner.context(),
        CreateSite {
            slug: format!("rate-test-{}", Uuid::new_v4().simple()),
            name: "Rate test site".to_owned(),
            tagline: String::new(),
            description: "Rate test site".to_owned(),
            default_page: None,
            layout: None,
            license: License::CcBySa40,
            locale: "en".to_owned(),
            ip_address: common::IP_ADDRESS,
        },
        Some(ADMIN_USER_ID),
    )
    .await
    .expect("Rate test site should be created")
    .site_id;
    let role = RoleService::create(
        runner.context(),
        InternalCreateRoleInput {
            site_id,
            name: "guest".to_owned(),
            description: None,
            is_virtual: true,
            parent_role_id: None,
            creating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Rate test role should be created");
    PermissionService::update_permissions_for_role(
        runner.context(),
        UpdateRolePermissionsInput {
            site_id,
            role_reference: Reference::Id(role.role_id),
            new_permissions: vec![
                Permission {
                    resource_type: Resource::Site,
                    resource_category: None,
                    action: Action::Edit,
                },
                Permission {
                    resource_type: Resource::Page,
                    resource_category: None,
                    action: Action::Create,
                },
                Permission {
                    resource_type: Resource::Page,
                    resource_category: None,
                    action: Action::Edit,
                },
                Permission {
                    resource_type: Resource::Page,
                    resource_category: None,
                    action: Action::View,
                },
            ],
            cascade_removals: false,
            updating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Rate test role permissions should be set");
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
    .expect("Rate test administrator role should be granted");
    let slug = format!("{category}:holder");
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(slug.clone().into())),
    });
    let page = run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": site_id,
            "wikitext": source,
            "title": "Registered Rate freshness fixture",
            "alt_title": null,
            "slug": slug,
            "layout": "wikidot",
            "revision_comments": "create registered Rate freshness fixture",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    let page_category = run_endpoint!(
        runner,
        category_get,
        json!({"site": site_id, "category": category}),
    )
    .expect("Rate fixture category should exist");
    run_endpoint!(
        runner,
        category_update,
        json!({
            "site": site_id,
            "category": page_category.category_id,
            "user_id": ADMIN_USER_ID,
            "rating_enabled": true,
            "rating_permission": "registered",
            "rating_type": rating_type,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    run_endpoint!(
        runner,
        page_rerender,
        json!({
            "site_id": site_id,
            "category_id": page_category.category_id,
            "page_id": page.page_id,
        }),
    );
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("fixture setup post-commit work should succeed");
    clear_job_queue(runner).await;
    (site_id, slug, page_category.category_id, page.page_id)
}

async fn clear_job_queue(runner: &TestRunner) {
    let mut queue = runner.context().rsmq();
    while let Some(message) = queue
        .receive_message::<Vec<u8>>(JOB_QUEUE_NAME, None)
        .await
        .expect("Rate test queue should be readable")
    {
        queue
            .delete_message(JOB_QUEUE_NAME, &message.id)
            .await
            .expect("Rate setup job should be removed");
    }
}

async fn consume_rate_rerender(
    runner: &TestRunner,
    site_id: i64,
    category_id: i64,
    page_id: i64,
) {
    let mut queue = runner.context().rsmq();
    let message = queue
        .receive_message::<Vec<u8>>(JOB_QUEUE_NAME, None)
        .await
        .expect("Rate rerender queue should be readable")
        .expect("vote mutation should queue its target rerender");
    let job: Job = serde_json::from_slice(&message.message)
        .expect("queued Rate rerender should decode");
    let Job::RerenderPage { id, depth, r#type } = job else {
        panic!("expected Rate target rerender, got {job:?}");
    };
    assert_eq!(id.site_id, site_id);
    assert_eq!(id.category_id, category_id);
    assert_eq!(id.page_id, page_id);
    assert_eq!(depth, RerenderDepth::default());
    assert_eq!(r#type, RerenderType::Full);
    queue
        .delete_message(JOB_QUEUE_NAME, &message.id)
        .await
        .expect("consumed Rate rerender should be removed");

    PageRevisionService::rerender(runner.context(), id, depth, r#type)
        .await
        .expect("the consumed Rate rerender should execute");
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("Rate rerender post-commit work should succeed");
}

async fn assert_no_queued_rate_rerender(runner: &TestRunner) {
    assert!(
        runner
            .context()
            .rsmq()
            .receive_message::<Vec<u8>>(JOB_QUEUE_NAME, None)
            .await
            .expect("Rate no-op queue should be readable")
            .is_none(),
        "idempotent vote mutation must not queue a rerender",
    );
}

async fn saved_rate_html(runner: &TestRunner, site_id: i64, slug: &str) -> String {
    match run_endpoint!(
        runner,
        page_view,
        json!({
            "site_id": site_id,
            "session_token": null,
            "route": {"slug": slug, "extra": ""},
            "locales": ["en-US", "en"],
        }),
    ) {
        GetPageViewOutput::Found {
            compiled_body_html, ..
        } => compiled_body_html,
        other => panic!("expected saved Rate page, got {other:?}"),
    }
}

#[tokio::test]
async fn registered_point_vote_lifecycle_refreshes_saved_rate_page() {
    let queue_namespace = format!("rsmq-rate-points-{}", Uuid::new_v4().simple());
    let verification =
        AssertUnwindSafe(run_registered_point_vote_lifecycle(&queue_namespace))
            .catch_unwind()
            .await;
    let cleanup = AssertUnwindSafe(cleanup_job_queue_namespace(&queue_namespace))
        .catch_unwind()
        .await;
    if let Err(payload) = verification {
        resume_unwind(payload);
    }
    if let Err(payload) = cleanup {
        resume_unwind(payload);
    }
}

async fn run_registered_point_vote_lifecycle(queue_namespace: &str) {
    const CATEGORY: &str = "fixture-vote-refresh-points";

    let mut runner = TestRunner::setup_with_job_queue_namespace(queue_namespace).await;
    let (site_id, slug, category_id, page_id) = create_registered_rate_page(
        &mut runner,
        CATEGORY,
        "plus_minus",
        "[[module Rate]]",
    )
    .await;
    assert!(
        saved_rate_html(&runner, site_id, &slug)
            .await
            .contains(r#"<span class="number prw54353">0</span>"#)
    );

    let before = PublicContentCache::cache_fence(runner.context(), site_id)
        .await
        .expect("public cache fence should be readable");
    let set = run_endpoint!(runner, vote_set, json!({"page_id": page_id, "value": 1}),)
        .expect("first point vote should be stored");
    assert_eq!(set.value, 1);
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("point vote post-commit work should succeed");
    assert_ne!(
        PublicContentCache::cache_fence(runner.context(), site_id)
            .await
            .expect("invalidated public cache fence should be readable"),
        before,
    );
    consume_rate_rerender(&runner, site_id, category_id, page_id).await;
    assert!(
        saved_rate_html(&runner, site_id, &slug)
            .await
            .contains(r#"<span class="number prw54353">+1</span>"#)
    );

    let before_disable = PublicContentCache::cache_fence(runner.context(), site_id)
        .await
        .expect("public cache fence should be readable before vote moderation");
    let disabled = run_endpoint!(
        runner,
        vote_action,
        json!({
            "page_id": page_id,
            "user_id": ADMIN_USER_ID,
            "enable": false,
            "acting_user_id": ADMIN_USER_ID,
        }),
    );
    assert!(disabled.disabled_at.is_some());
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("vote disable post-commit work should succeed");
    assert_ne!(
        PublicContentCache::cache_fence(runner.context(), site_id)
            .await
            .expect("public cache fence should be readable after vote disable"),
        before_disable,
    );
    consume_rate_rerender(&runner, site_id, category_id, page_id).await;
    assert!(
        saved_rate_html(&runner, site_id, &slug)
            .await
            .contains(r#"<span class="number prw54353">0</span>"#)
    );

    let before_repeated_disable =
        PublicContentCache::cache_fence(runner.context(), site_id)
            .await
            .expect("public cache fence should be readable before repeated disable");
    let still_disabled = run_endpoint!(
        runner,
        vote_action,
        json!({
            "page_id": page_id,
            "user_id": ADMIN_USER_ID,
            "enable": false,
            "acting_user_id": ADMIN_USER_ID,
        }),
    );
    assert_eq!(still_disabled.disabled_at, disabled.disabled_at);
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("repeated vote disable should have no post-commit error");
    assert_eq!(
        PublicContentCache::cache_fence(runner.context(), site_id)
            .await
            .expect("public cache fence should be readable after repeated disable"),
        before_repeated_disable,
        "repeated vote disable must not falsely invalidate public content",
    );
    assert_no_queued_rate_rerender(&runner).await;

    let before_enable = PublicContentCache::cache_fence(runner.context(), site_id)
        .await
        .expect("public cache fence should be readable before vote enable");
    let enabled = run_endpoint!(
        runner,
        vote_action,
        json!({
            "page_id": page_id,
            "user_id": ADMIN_USER_ID,
            "enable": true,
            "acting_user_id": ADMIN_USER_ID,
        }),
    );
    assert!(enabled.disabled_at.is_none());
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("vote enable post-commit work should succeed");
    assert_ne!(
        PublicContentCache::cache_fence(runner.context(), site_id)
            .await
            .expect("public cache fence should be readable after vote enable"),
        before_enable,
    );
    consume_rate_rerender(&runner, site_id, category_id, page_id).await;
    assert!(
        saved_rate_html(&runner, site_id, &slug)
            .await
            .contains(r#"<span class="number prw54353">+1</span>"#)
    );

    let before_change = PublicContentCache::cache_fence(runner.context(), site_id)
        .await
        .expect("public cache fence should be readable before point change");
    let changed =
        run_endpoint!(runner, vote_set, json!({"page_id": page_id, "value": -1}),)
            .expect("changed point vote should be stored");
    assert_eq!(changed.value, -1);
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("changed point vote post-commit work should succeed");
    assert_ne!(
        PublicContentCache::cache_fence(runner.context(), site_id)
            .await
            .expect("public cache fence should be readable after point change"),
        before_change,
    );
    consume_rate_rerender(&runner, site_id, category_id, page_id).await;
    assert!(
        saved_rate_html(&runner, site_id, &slug)
            .await
            .contains(r#"<span class="number prw54353">-1</span>"#)
    );

    let before_same_value = PublicContentCache::cache_fence(runner.context(), site_id)
        .await
        .expect("public cache fence should be readable before idempotent set");
    assert!(
        run_endpoint!(runner, vote_set, json!({"page_id": page_id, "value": -1}),)
            .is_none(),
        "same-value point vote should remain an idempotent no-op",
    );
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("same-value point vote should have no post-commit error");
    assert_eq!(
        PublicContentCache::cache_fence(runner.context(), site_id)
            .await
            .expect("public cache fence should be readable after idempotent set"),
        before_same_value,
        "same-value point vote must not falsely invalidate public content",
    );
    assert_no_queued_rate_rerender(&runner).await;

    let before_remove = PublicContentCache::cache_fence(runner.context(), site_id)
        .await
        .expect("public cache fence should be readable before point removal");
    let removed = run_endpoint!(runner, vote_remove, json!({"page_id": page_id}),);
    assert_eq!(removed.value, -1);
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("removed point vote post-commit work should succeed");
    assert_ne!(
        PublicContentCache::cache_fence(runner.context(), site_id)
            .await
            .expect("public cache fence should be readable after point removal"),
        before_remove,
    );
    consume_rate_rerender(&runner, site_id, category_id, page_id).await;
    assert!(
        saved_rate_html(&runner, site_id, &slug)
            .await
            .contains(r#"<span class="number prw54353">0</span>"#)
    );
}

#[tokio::test]
async fn registered_star_vote_lifecycle_refreshes_saved_rate_and_vote_count() {
    let queue_namespace = format!("rsmq-rate-stars-{}", Uuid::new_v4().simple());
    let verification =
        AssertUnwindSafe(run_registered_star_vote_lifecycle(&queue_namespace))
            .catch_unwind()
            .await;
    let cleanup = AssertUnwindSafe(cleanup_job_queue_namespace(&queue_namespace))
        .catch_unwind()
        .await;
    if let Err(payload) = verification {
        resume_unwind(payload);
    }
    if let Err(payload) = cleanup {
        resume_unwind(payload);
    }
}

async fn run_registered_star_vote_lifecycle(queue_namespace: &str) {
    const CATEGORY: &str = "fixture-vote-refresh-stars";
    const SOURCE: &str = concat!(
        "[[module Rate]]\n",
        "Rating %%rating%% from %%rating_votes%% votes\n",
        "[[/module]]",
    );

    let mut runner = TestRunner::setup_with_job_queue_namespace(queue_namespace).await;
    let (site_id, slug, category_id, page_id) =
        create_registered_rate_page(&mut runner, CATEGORY, "stars", SOURCE).await;
    let initial = saved_rate_html(&runner, site_id, &slug).await;
    assert!(initial.contains(r#"class="page-rate-widget-start" data-rating="0""#));
    assert!(
        initial.contains(
            r#"<span class="page-rate-widget-start-text-rating-votes">0</span>"#
        )
    );

    let before_create = PublicContentCache::cache_fence(runner.context(), site_id)
        .await
        .expect("public cache fence should be readable before first star vote");
    let created =
        run_endpoint!(runner, vote_set, json!({"page_id": page_id, "value": 4}),)
            .expect("first star vote should be stored");
    assert_eq!(created.value, 4);
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("first star vote post-commit work should succeed");
    assert_ne!(
        PublicContentCache::cache_fence(runner.context(), site_id)
            .await
            .expect("public cache fence should be readable after first star vote"),
        before_create,
    );
    consume_rate_rerender(&runner, site_id, category_id, page_id).await;
    let first = saved_rate_html(&runner, site_id, &slug).await;
    assert!(first.contains(r#"class="page-rate-widget-start" data-rating="4""#));
    assert!(
        first.contains(
            r#"<span class="page-rate-widget-start-text-rating-votes">1</span>"#
        )
    );

    let before_change = PublicContentCache::cache_fence(runner.context(), site_id)
        .await
        .expect("public cache fence should be readable before star change");
    let changed =
        run_endpoint!(runner, vote_set, json!({"page_id": page_id, "value": 2}),)
            .expect("changed star vote should be stored");
    assert_eq!(changed.value, 2);
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("changed star vote post-commit work should succeed");
    assert_ne!(
        PublicContentCache::cache_fence(runner.context(), site_id)
            .await
            .expect("public cache fence should be readable after star change"),
        before_change,
    );
    consume_rate_rerender(&runner, site_id, category_id, page_id).await;
    let changed_html = saved_rate_html(&runner, site_id, &slug).await;
    assert!(changed_html.contains(r#"class="page-rate-widget-start" data-rating="2""#));
    assert!(
        changed_html.contains(
            r#"<span class="page-rate-widget-start-text-rating-votes">1</span>"#
        )
    );

    let before_same_value = PublicContentCache::cache_fence(runner.context(), site_id)
        .await
        .expect("public cache fence should be readable before idempotent star set");
    assert!(
        run_endpoint!(runner, vote_set, json!({"page_id": page_id, "value": 2}),)
            .is_none(),
        "same-value star vote should remain an idempotent no-op",
    );
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("same-value star vote should have no post-commit error");
    assert_eq!(
        PublicContentCache::cache_fence(runner.context(), site_id)
            .await
            .expect("public cache fence should be readable after idempotent star set"),
        before_same_value,
        "same-value star vote must not falsely invalidate public content",
    );
    assert_no_queued_rate_rerender(&runner).await;

    let before_remove = PublicContentCache::cache_fence(runner.context(), site_id)
        .await
        .expect("public cache fence should be readable before star removal");
    let removed = run_endpoint!(runner, vote_remove, json!({"page_id": page_id}),);
    assert_eq!(removed.value, 2);
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("star removal post-commit work should succeed");
    assert_ne!(
        PublicContentCache::cache_fence(runner.context(), site_id)
            .await
            .expect("public cache fence should be readable after star removal"),
        before_remove,
    );
    consume_rate_rerender(&runner, site_id, category_id, page_id).await;
    let removed_html = saved_rate_html(&runner, site_id, &slug).await;
    assert!(removed_html.contains(r#"class="page-rate-widget-start" data-rating="0""#));
    assert!(
        removed_html.contains(
            r#"<span class="page-rate-widget-start-text-rating-votes">0</span>"#
        )
    );
}

#[tokio::test]
async fn vote_set_rejects_out_of_domain_values_before_persistence() {
    const SLUG: &str = "security-vote-value-boundary-20260804";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;

    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(SLUG.into())),
    });
    let page = run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": site_id,
            "wikitext": "Vote value boundary test page.",
            "title": "Vote Value Boundary",
            "alt_title": null,
            "slug": SLUG,
            "layout": "wikidot",
            "revision_comments": "create vote value boundary test page",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    let initial = run_endpoint!(
        runner,
        vote_set,
        json!({
            "page_id": page.page_id,
            "user_id": ADMIN_USER_ID,
            "value": 1,
        }),
    )
    .expect("the supported plus-minus value should be accepted");
    assert_eq!(initial.value, 1);

    for value in [i16::MIN, -2, 0, 2, i16::MAX] {
        let error = run_endpoint_err!(
            runner,
            vote_set,
            json!({
                "page_id": page.page_id,
                "user_id": ADMIN_USER_ID,
                "value": value,
            }),
        );
        assert_contains_error!(error, ErrorType::BadRequest);

        let current = run_endpoint!(
            runner,
            vote_get,
            json!({
                "page_id": page.page_id,
                "user_id": ADMIN_USER_ID,
            }),
        )
        .expect("the rejected value must not replace the current vote");
        assert_eq!(current.value, 1);
    }
}

#[tokio::test]
async fn anonymous_rate_controls_are_exposed_and_rejected_by_the_vote_endpoint() {
    let queue_namespace = format!("rsmq-rate-anonymous-{}", Uuid::new_v4().simple());
    let verification =
        AssertUnwindSafe(run_anonymous_rate_control_exposure(&queue_namespace))
            .catch_unwind()
            .await;
    let cleanup = AssertUnwindSafe(cleanup_job_queue_namespace(&queue_namespace))
        .catch_unwind()
        .await;
    if let Err(payload) = verification {
        resume_unwind(payload);
    }
    if let Err(payload) = cleanup {
        resume_unwind(payload);
    }
}

async fn run_anonymous_rate_control_exposure(queue_namespace: &str) {
    const CATEGORY: &str = "fixture-anonymous-rate-view";

    let mut runner = TestRunner::setup_with_job_queue_namespace(queue_namespace).await;
    let (site_id, slug, _category_id, page_id) = create_registered_rate_page(
        &mut runner,
        CATEGORY,
        "plus_minus",
        "[[module Rate]]",
    )
    .await;

    runner.set_request_context(RequestContext {
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(slug.clone().into())),
        ..Default::default()
    });
    let view = run_endpoint!(
        runner,
        page_view,
        json!({
            "site_id": site_id,
            "session_token": null,
            "route": {"slug": slug, "extra": ""},
            "locales": ["en-US", "en"],
        }),
    );
    let registry = match view {
        GetPageViewOutput::Found {
            rate_actions: Some(registry),
            ..
        } => registry,
        other => panic!("anonymous view should expose the Rate sidecar, got {other:?}"),
    };
    assert_eq!(registry.page_id, page_id);
    assert_eq!(registry.current_value, None);
    let actions = serde_json::to_value(&registry.actions).unwrap();
    assert_eq!(actions.as_array().map(Vec::len), Some(3));

    let rejected = run_endpoint_err!(
        runner,
        wikidot_legacy_rate,
        json!({
            "page_id": page_id,
            "last_revision_id": registry.revision_id,
            "action_index": actions[0]["index"],
            "action_fingerprint": actions[0]["fingerprint"],
        }),
    );
    assert_contains_error!(rejected, ErrorType::PermissionDenied);
}

async fn execute_sql(runner: &TestRunner, sql: &str) {
    let transaction = runner.context().transaction();
    let statement =
        Statement::from_string(transaction.get_database_backend(), sql.to_owned());
    transaction
        .execute_raw(statement)
        .await
        .expect("failed to execute test SQL");
}

async fn insert_imported_rating_snapshot(
    runner: &TestRunner,
    site_id: i64,
    page_id: i64,
    slug: &str,
    import_run_id: i64,
    imported_rating: i64,
) {
    execute_sql(
        runner,
        &format!(
            r#"INSERT INTO wikidot_corpus_import_run (
                import_run_id,
                site_id,
                source_branch,
                source_site,
                manifest_sha256,
                manifest_row_count,
                complete_inventory,
                state,
                summary
            ) VALUES (
                {import_run_id},
                {site_id},
                'scp-wiki',
                'scp-wiki',
                decode(repeat('00', 32), 'hex'),
                1,
                false,
                'metadata_done',
                '{{}}'::jsonb
            )"#,
        ),
    )
    .await;
    execute_sql(
        runner,
        &format!(
            r#"INSERT INTO wikidot_page_snapshot (
                page_id,
                source_branch,
                source_site,
                source_entity_id,
                source_fullname,
                source_created_at,
                source_updated_at,
                source_revision_count,
                imported_rating,
                comments,
                source_sha256,
                meta_sha256,
                meta_json,
                last_import_run_id
            ) VALUES (
                {page_id},
                'scp-wiki',
                'scp-wiki',
                '{}',
                '{slug}',
                NOW(),
                NOW(),
                49,
                {imported_rating},
                95,
                decode(repeat('aa', 32), 'hex'),
                decode(repeat('bb', 32), 'hex'),
                '{{}}'::jsonb,
                {import_run_id}
            )"#,
            Uuid::new_v4(),
        ),
    )
    .await;
}

async fn imported_rating_score(runner: &TestRunner, site_id: i64, slug: &str) -> i64 {
    let output = run_endpoint!(
        runner,
        page_get_score,
        json!({"site_id": site_id, "page": slug}),
    );
    match output.score {
        deepwell::services::score::ScoreValue::Integer(value) => value,
        score => panic!("expected an integer combined score, got {score:?}"),
    }
}

#[tokio::test]
async fn imported_rating_baseline_vote_cast_change_cancel_lifecycle() {
    let queue_namespace = format!("rsmq-rate-baseline-{}", Uuid::new_v4().simple());
    let verification = AssertUnwindSafe(run_imported_rating_baseline_vote_lifecycle(
        &queue_namespace,
    ))
    .catch_unwind()
    .await;
    let cleanup = AssertUnwindSafe(cleanup_job_queue_namespace(&queue_namespace))
        .catch_unwind()
        .await;
    if let Err(payload) = verification {
        resume_unwind(payload);
    }
    if let Err(payload) = cleanup {
        resume_unwind(payload);
    }
}

async fn run_imported_rating_baseline_vote_lifecycle(queue_namespace: &str) {
    const CATEGORY: &str = "fixture-vote-baseline-lifecycle";
    const BASELINE: i64 = 461;

    let mut runner = TestRunner::setup_with_job_queue_namespace(queue_namespace).await;
    let (site_id, slug, _category_id, page_id) = create_registered_rate_page(
        &mut runner,
        CATEGORY,
        "plus_minus",
        "[[module Rate]]",
    )
    .await;
    insert_imported_rating_snapshot(
        &runner, site_id, page_id, &slug, 7_701_011, BASELINE,
    )
    .await;

    assert_eq!(
        imported_rating_score(&runner, site_id, &slug).await,
        BASELINE,
    );

    let set = run_endpoint!(runner, vote_set, json!({"page_id": page_id, "value": 1}),)
        .expect("baseline vote should be stored");
    assert_eq!(set.value, 1);
    assert_eq!(
        imported_rating_score(&runner, site_id, &slug).await,
        BASELINE + 1,
    );

    let changed =
        run_endpoint!(runner, vote_set, json!({"page_id": page_id, "value": -1}),)
            .expect("changed baseline vote should be stored");
    assert_eq!(changed.value, -1);
    assert_eq!(
        imported_rating_score(&runner, site_id, &slug).await,
        BASELINE - 1,
    );

    let removed = run_endpoint!(runner, vote_remove, json!({"page_id": page_id}),);
    assert_eq!(removed.value, -1);
    assert_eq!(
        imported_rating_score(&runner, site_id, &slug).await,
        BASELINE,
    );
}

#[tokio::test]
async fn imported_rating_baseline_refresh_shows_combined_score() {
    let queue_namespace =
        format!("rsmq-rate-baseline-refresh-{}", Uuid::new_v4().simple());
    let verification =
        AssertUnwindSafe(run_imported_rating_baseline_refresh(&queue_namespace))
            .catch_unwind()
            .await;
    let cleanup = AssertUnwindSafe(cleanup_job_queue_namespace(&queue_namespace))
        .catch_unwind()
        .await;
    if let Err(payload) = verification {
        resume_unwind(payload);
    }
    if let Err(payload) = cleanup {
        resume_unwind(payload);
    }
}

async fn run_imported_rating_baseline_refresh(queue_namespace: &str) {
    const CATEGORY: &str = "fixture-vote-baseline-refresh";
    const BASELINE: i64 = 461;

    let mut runner = TestRunner::setup_with_job_queue_namespace(queue_namespace).await;
    let (site_id, slug, category_id, page_id) = create_registered_rate_page(
        &mut runner,
        CATEGORY,
        "plus_minus",
        "[[module Rate]]",
    )
    .await;
    insert_imported_rating_snapshot(
        &runner, site_id, page_id, &slug, 7_701_012, BASELINE,
    )
    .await;

    run_endpoint!(
        runner,
        page_rerender,
        json!({
            "site_id": site_id,
            "category_id": category_id,
            "page_id": page_id,
        }),
    );
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("baseline rerender post-commit work should succeed");
    clear_job_queue(&runner).await;
    assert!(
        saved_rate_html(&runner, site_id, &slug)
            .await
            .contains(r#"<span class="number prw54353">+461</span>"#)
    );

    run_endpoint!(runner, vote_set, json!({"page_id": page_id, "value": 1}),)
        .expect("baseline refresh vote should be stored");
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("baseline vote post-commit work should succeed");
    consume_rate_rerender(&runner, site_id, category_id, page_id).await;
    assert!(
        saved_rate_html(&runner, site_id, &slug)
            .await
            .contains(r#"<span class="number prw54353">+462</span>"#)
    );
}

async fn upsert_imported_rating_snapshot(
    runner: &TestRunner,
    site_id: i64,
    page_id: i64,
    slug: &str,
    import_run_id: i64,
    imported_rating: i64,
    source_revision_count: i64,
) {
    execute_sql(
        runner,
        &format!(
            r#"INSERT INTO wikidot_corpus_import_run (import_run_id, site_id, source_branch, source_site, manifest_sha256, manifest_row_count, complete_inventory, state, summary) VALUES ({import_run_id}, {site_id}, 'scp-wiki', 'scp-wiki', decode(repeat('ab', 32), 'hex'), 1, false, 'done', '{{}}'::jsonb)"#
        ),
    )
    .await;
    execute_sql(
        runner,
        &format!(
            r#"INSERT INTO wikidot_page_snapshot (page_id, source_branch, source_site, source_entity_id, source_fullname, source_created_at, source_updated_at, source_revision_count, imported_rating, comments, source_sha256, meta_sha256, meta_json, last_import_run_id) VALUES ({page_id}, 'scp-wiki', 'scp-wiki', '{}', '{slug}', '2026-09-01T00:00:00+00:00', '2026-10-26T00:00:00+00:00', {source_revision_count}, {imported_rating}, 95, decode(repeat('cd', 32), 'hex'), decode(repeat('cd', 32), 'hex'), '{{}}', {import_run_id}) ON CONFLICT (page_id) DO UPDATE SET source_updated_at = EXCLUDED.source_updated_at, source_revision_count = EXCLUDED.source_revision_count, imported_rating = EXCLUDED.imported_rating, comments = EXCLUDED.comments, last_import_run_id = EXCLUDED.last_import_run_id"#,
            Uuid::new_v4(),
        ),
    )
    .await;
}

async fn count_rows(runner: &TestRunner, table: &str, page_id: i64) -> i64 {
    let transaction = runner.context().transaction();
    let statement = Statement::from_string(
        transaction.get_database_backend(),
        format!("SELECT count(*) AS count FROM {table} WHERE page_id = {page_id}"),
    );
    transaction
        .query_one_raw(statement)
        .await
        .expect("row count should succeed")
        .expect("row count should return a row")
        .try_get::<i64>("", "count")
        .expect("row count should parse")
}

async fn count_live_votes(runner: &TestRunner, page_id: i64) -> i64 {
    let transaction = runner.context().transaction();
    let statement = Statement::from_string(
        transaction.get_database_backend(),
        format!(
            "SELECT count(*) AS count FROM page_vote WHERE page_id = {page_id} AND deleted_at IS NULL"
        ),
    );
    transaction
        .query_one_raw(statement)
        .await
        .expect("live vote count should succeed")
        .expect("live vote count should return a row")
        .try_get::<i64>("", "count")
        .expect("live vote count should parse")
}

#[tokio::test]
async fn reimport_of_unchanged_snapshot_leaves_score_unchanged() {
    let mut runner = TestRunner::setup().await;
    let (site_id, slug, _, page_id) = create_registered_rate_page(
        &mut runner,
        "reimport",
        "plus_minus",
        "[[module Rate]]",
    )
    .await;

    upsert_imported_rating_snapshot(&runner, site_id, page_id, &slug, 7_701_101, 461, 49)
        .await;
    assert_eq!(
        imported_rating_score(&runner, site_id, &slug).await,
        461,
        "first import should serve the baseline",
    );

    upsert_imported_rating_snapshot(&runner, site_id, page_id, &slug, 7_701_102, 461, 49)
        .await;
    assert_eq!(
        imported_rating_score(&runner, site_id, &slug).await,
        461,
        "re-import must not double the baseline",
    );
    assert_eq!(
        count_rows(&runner, "wikidot_page_snapshot", page_id).await,
        1,
        "re-import must not append baseline rows",
    );
    assert_eq!(
        count_rows(&runner, "page_vote", page_id).await,
        0,
        "re-import must not fabricate vote rows",
    );
}

#[tokio::test]
async fn refresh_to_newer_aggregate_counts_local_vote_once() {
    let mut runner = TestRunner::setup().await;
    let (site_id, slug, _, page_id) = create_registered_rate_page(
        &mut runner,
        "refresh",
        "plus_minus",
        "[[module Rate]]",
    )
    .await;

    upsert_imported_rating_snapshot(&runner, site_id, page_id, &slug, 7_701_103, 461, 49)
        .await;
    run_endpoint!(runner, vote_set, json!({"page_id": page_id, "value": 1}),);
    assert_eq!(
        imported_rating_score(&runner, site_id, &slug).await,
        462,
        "local vote should add to the baseline",
    );

    upsert_imported_rating_snapshot(&runner, site_id, page_id, &slug, 7_701_104, 470, 50)
        .await;
    assert_eq!(
        imported_rating_score(&runner, site_id, &slug).await,
        471,
        "refresh must move the baseline and count the local vote once",
    );

    run_endpoint!(runner, vote_set, json!({"page_id": page_id, "value": -1}),);
    assert_eq!(
        imported_rating_score(&runner, site_id, &slug).await,
        469,
        "vote change after refresh must swap the delta",
    );
    assert_eq!(
        count_rows(&runner, "wikidot_page_snapshot", page_id).await,
        1,
        "refresh must not append baseline rows",
    );
    assert_eq!(
        count_live_votes(&runner, page_id).await,
        1,
        "one live local vote row must exist",
    );
}
