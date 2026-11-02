/*
 * tests/permission.rs
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

use self::common::TestRunner;
use deepwell::constants::SYSTEM_USER_ID;
use deepwell::error::ErrorType;
use deepwell::license::License;
use deepwell::services::category::CategoryService;
use deepwell::services::forum::{CreateForumCategory, CreateForumGroup, ForumService};
use deepwell::services::page::{CreatePage, PageService};
use deepwell::services::permission::{
    CheckPermissionContext, DecoratedPermission, PERMISSION_CACHE_FENCE_TTL_SECONDS,
    PERMISSION_CACHE_INVALIDATION_CHANNEL, PERMISSION_CACHE_TTL_SECONDS, PermissionCache,
    PermissionService, PermissionTarget, SetUserPermissionInput,
};
use deepwell::services::relation::{
    CreateSiteBan, CreateSiteMember, RelationService, RemoveSiteMember, SiteBanData,
    SiteMemberAccepted, SiteMemberData,
};
use deepwell::services::role::{
    GetRolePermissionsInput, GetUserRolesInput, GrantUserRoleInput,
    InternalCreateRoleInput, RevokeUserRoleInput, RoleService,
    UpdateRolePermissionsInput,
};
use deepwell::services::site::{CreateSite, SiteService};
use deepwell::services::user::{CreateUser, UserService};
use deepwell::services::{RequestContext, ServiceContext};
use deepwell::types::{Action, Permission, Reference, Resource, UserType};
use futures::StreamExt;
use redis::AsyncCommands;
use serde_json::json;
use std::{
    env,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use str_macro::str;
use time::{Date, Month};

static FIXTURE_COUNTER: AtomicU64 = AtomicU64::new(0);
const TEST_CATEGORY_NAME: &str = "test-category";
const OTHER_CATEGORY_NAME: &str = "other-category";

fn next_n() -> u64 {
    FIXTURE_COUNTER.fetch_add(1, Ordering::Relaxed)
}

async fn subscribed_permission_invalidation_stream() -> redis::aio::PubSub {
    let redis_url =
        env::var("REDIS_URL").expect("REDIS_URL must be set for integration tests");
    let client = redis::Client::open(redis_url).expect("failed to build Redis client");
    let mut pubsub = client
        .get_async_pubsub()
        .await
        .expect("failed to open Redis pub/sub connection");
    pubsub
        .subscribe(PERMISSION_CACHE_INVALIDATION_CHANNEL)
        .await
        .expect("failed to subscribe to permission cache invalidations");
    pubsub
}

struct PermissionFixture {
    site_id: i64,
    category_id: i64,
    other_category_id: i64,
    role_a: i64,
    user_a: i64,
    user_b: i64,
    user_c: i64,
    user_d: i64,
    test_page_id: i64,
    other_page_id: i64,
}

impl PermissionFixture {
    async fn setup(runner: &TestRunner) -> Self {
        let ctx = runner.context();
        let n = next_n();

        let site = SiteService::create(
            ctx,
            CreateSite {
                slug: format!("perm-test-{n}"),
                name: format!("Permission test site {n}"),
                tagline: String::new(),
                description: format!("Permission test site {n}"),
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
        let site_id = site.site_id;

        let category_id =
            CategoryService::get_or_create(ctx, site_id, TEST_CATEGORY_NAME)
                .await
                .expect("Failed to create page category")
                .category_id;

        let other_category_id =
            CategoryService::get_or_create(ctx, site_id, OTHER_CATEGORY_NAME)
                .await
                .expect("Failed to create other page category")
                .category_id;

        let role_a = create_role(ctx, site_id, "RoleA", None).await;
        add_perms_to_role(
            ctx,
            site_id,
            role_a,
            vec![
                Permission {
                    resource_type: Resource::Page,
                    resource_category: None,
                    action: Action::View,
                },
                Permission {
                    resource_type: Resource::Page,
                    resource_category: None,
                    action: Action::Edit,
                },
            ],
        )
        .await;

        let role_b = create_role(ctx, site_id, "RoleB", None).await;
        add_perms_to_role(
            ctx,
            site_id,
            role_b,
            vec![
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
            ],
        )
        .await;

        let role_d = create_role(ctx, site_id, "RoleD", None).await;
        add_perms_to_role(
            ctx,
            site_id,
            role_d,
            vec![
                Permission {
                    resource_type: Resource::Site,
                    resource_category: None,
                    action: Action::Edit,
                },
                Permission {
                    resource_type: Resource::PageLock,
                    resource_category: None,
                    action: Action::BypassLock,
                },
            ],
        )
        .await;

        let user_a = create_user(ctx, n, "a").await;
        let user_b = create_user(ctx, n, "b").await;
        let user_c = create_user(ctx, n, "c").await;
        let user_d = create_user(ctx, n, "d").await;

        grant_role(ctx, site_id, user_a, role_a).await;
        grant_role(ctx, site_id, user_b, role_b).await;
        grant_role(ctx, site_id, user_d, role_d).await;

        let test_page = PageService::create(
            ctx,
            CreatePage {
                site_id,
                wikitext: String::new(),
                title: String::from("Test Category Permission Page"),
                alt_title: None,
                tags: Vec::new(),
                slug: format!("{TEST_CATEGORY_NAME}:permission-test-{n}"),
                layout: None,
                revision_comments: String::new(),
                user_id: SYSTEM_USER_ID,
                bypass_filter: true,
                ip_address: common::IP_ADDRESS,
            },
        )
        .await
        .expect("Failed to create test-category page");

        let other_page = PageService::create(
            ctx,
            CreatePage {
                site_id,
                wikitext: String::new(),
                title: String::from("Other Category Permission Page"),
                alt_title: None,
                tags: Vec::new(),
                slug: format!("{OTHER_CATEGORY_NAME}:permission-test-{n}"),
                layout: None,
                revision_comments: String::new(),
                user_id: SYSTEM_USER_ID,
                bypass_filter: true,
                ip_address: common::IP_ADDRESS,
            },
        )
        .await
        .expect("Failed to create other-category page");

        PermissionFixture {
            site_id,
            category_id,
            other_category_id,
            role_a,
            user_a,
            user_b,
            user_c,
            user_d,
            test_page_id: test_page.page_id,
            other_page_id: other_page.page_id,
        }
    }
}

async fn create_role(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    name: &str,
    parent_role_id: Option<i64>,
) -> i64 {
    RoleService::create(
        ctx,
        InternalCreateRoleInput {
            site_id,
            name: name.to_owned(),
            description: None,
            is_virtual: false,
            parent_role_id,
            creating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to create role")
    .role_id
}

async fn add_perms_to_role(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    role_id: i64,
    permissions: Vec<Permission<'static>>,
) {
    PermissionService::update_permissions_for_role(
        ctx,
        UpdateRolePermissionsInput {
            site_id,
            role_reference: Reference::Id(role_id),
            new_permissions: permissions,
            cascade_removals: false,
            updating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to add permissions to role");
}

async fn grant_role(ctx: &ServiceContext<'_>, site_id: i64, user_id: i64, role_id: i64) {
    RoleService::grant_role_to_user(
        ctx,
        GrantUserRoleInput {
            site_id,
            user_id,
            role_id,
            assigning_user_id: SYSTEM_USER_ID,
            expires_at: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to grant role to user");
}

async fn revoke_role(ctx: &ServiceContext<'_>, site_id: i64, user_id: i64, role_id: i64) {
    RoleService::revoke_role_from_user(
        ctx,
        RevokeUserRoleInput {
            site_id,
            user_id,
            role_id,
            revoking_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to revoke role from user");
}

async fn cached_page_view(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    user_id: i64,
) -> Option<bool> {
    let fence = PermissionCache::cache_fence(ctx, site_id, Some(user_id))
        .await
        .expect("Failed to read permission cache fence");
    PermissionCache::check_user_permission(
        ctx,
        Some(site_id),
        Some(user_id),
        Resource::Page,
        None,
        Action::View,
        &fence,
    )
    .await
    .expect("Failed to read permission cache")
}

async fn permission_cache_key(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    user_id: i64,
    resource: Resource,
    category_id: Option<i64>,
    action: Action,
) -> String {
    let category = category_id
        .map(|id| id.to_string())
        .unwrap_or_else(|| "_default".to_owned());
    let pattern = format!(
        "permission:site:{site_id}:user:{user_id}:*:permission:{resource}:{category}:{action}"
    );
    let mut redis = ctx.redis();
    let keys: Vec<String> = redis
        .keys(&pattern)
        .await
        .expect("Failed to list permission cache keys");
    assert_eq!(
        keys.len(),
        1,
        "expected one permission cache key for pattern {pattern}, got {keys:?}"
    );
    keys.into_iter()
        .next()
        .expect("permission cache key should exist")
}

async fn page_view_permission_cache_key(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    user_id: i64,
) -> String {
    permission_cache_key(ctx, site_id, user_id, Resource::Page, None, Action::View).await
}

async fn run_queued_cache_invalidations(ctx: &ServiceContext<'_>) {
    ctx.run_post_commit_actions()
        .await
        .expect("Failed to run queued post-commit actions");
}

async fn create_site_member(ctx: &ServiceContext<'_>, site_id: i64, user_id: i64) {
    RelationService::create_site_member(
        ctx,
        CreateSiteMember {
            site_id,
            user_id,
            metadata: SiteMemberData {
                accepted: SiteMemberAccepted::Accepted(SYSTEM_USER_ID),
            },
            created_by: SYSTEM_USER_ID,
        },
        common::IP_ADDRESS,
    )
    .await
    .expect("Failed to create site member");
}

async fn remove_site_member(ctx: &ServiceContext<'_>, site_id: i64, user_id: i64) {
    RelationService::remove_site_member(
        ctx,
        RemoveSiteMember {
            site_id,
            user_id,
            removed_by: SYSTEM_USER_ID,
        },
        common::IP_ADDRESS,
        "test membership removal",
    )
    .await
    .expect("Failed to remove site member");
}

async fn ban_site_user(ctx: &ServiceContext<'_>, site_id: i64, user_id: i64) {
    ban_site_user_until(ctx, site_id, user_id, None).await;
}

async fn ban_site_user_until(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    user_id: i64,
    banned_until: Option<Date>,
) {
    RelationService::create_site_ban(
        ctx,
        CreateSiteBan {
            site_id,
            user_id,
            metadata: SiteBanData {
                banned_until,
                reason: str!("test ban"),
            },
            created_by: SYSTEM_USER_ID,
        },
        common::IP_ADDRESS,
    )
    .await
    .expect("Failed to create site ban");
}

async fn create_user(ctx: &ServiceContext<'_>, fixture_n: u64, label: &str) -> i64 {
    UserService::create(
        ctx,
        CreateUser {
            user_type: UserType::Regular,
            name: format!("Perm Test {fixture_n} {label}"),
            email: format!("perm-{fixture_n}-{label}@email.com"),
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

#[must_use]
async fn check(
    runner: &TestRunner,
    user_id: Option<i64>,
    site_id: i64,
    resource: Resource,
    category_id: Option<i64>,
    action: Action,
) -> bool {
    PermissionService::check_user_can(
        runner.context(),
        &CheckPermissionContext {
            user_id,
            site_id,
            page_reference: None,
        },
        Permission {
            resource_type: resource,
            resource_category: category_id.map(Reference::Id),
            action,
        },
    )
    .await
    .expect("Permission check returned an error")
}

#[must_use]
async fn batch_check<const N: usize>(
    runner: &TestRunner,
    user_id: Option<i64>,
    site_id: i64,
    perms: [(Resource, Option<i64>, Action); N],
) -> [bool; N] {
    let inputs = perms.map(|(resource, category_id, action)| Permission {
        resource_type: resource,
        resource_category: category_id.map(Reference::Id),
        action,
    });
    PermissionService::batch_check_user_can(
        runner.context(),
        &CheckPermissionContext {
            user_id,
            site_id,
            page_reference: None,
        },
        inputs,
    )
    .await
    .expect("Batch permission check returned an error")
}

#[tokio::test]
async fn check_user_can() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;

    let a = Some(f.user_a);
    let b = Some(f.user_b);
    let c = Some(f.user_c);
    let cat = Some(f.category_id);

    assert!(
        check(&runner, a, f.site_id, Resource::Page, None, Action::View).await,
        "user_a should pass page:view check"
    );
    assert!(
        check(&runner, a, f.site_id, Resource::Page, None, Action::Edit).await,
        "user_a should pass page:edit check"
    );

    assert!(
        !check(&runner, c, f.site_id, Resource::Page, None, Action::View).await,
        "user_c should fail page:view check"
    );
    assert!(
        !check(&runner, c, f.site_id, Resource::Page, None, Action::Edit).await,
        "user_c should fail page:edit check"
    );

    assert!(
        !check(&runner, b, f.site_id, Resource::Page, None, Action::View).await,
        "user_b should fail page:view check"
    );

    assert!(
        check(&runner, b, f.site_id, Resource::Page, cat, Action::Edit).await,
        "user_b: should pass page:edit check in test-category"
    );
    assert!(
        !check(&runner, b, f.site_id, Resource::Page, None, Action::Edit).await,
        "user_b: should fail page:edit without category"
    );
    let other_cat = Some(f.other_category_id);
    assert!(
        !check(
            &runner,
            b,
            f.site_id,
            Resource::Page,
            other_cat,
            Action::Edit
        )
        .await,
        "user_b: should fail page:edit in other category"
    );

    assert!(
        !check(&runner, a, f.site_id, Resource::Page, cat, Action::Edit).await,
        "user_a: should fail page:edit check in test-category"
    );
}

async fn check_target(
    runner: &TestRunner,
    user_id: Option<i64>,
    site_id: i64,
    target: PermissionTarget,
    action: Action,
) -> bool {
    PermissionService::can_user_as(
        runner.context(),
        user_id,
        Some(site_id),
        action,
        target,
    )
    .await
    .expect("Permission check returned an error")
}

#[tokio::test]
async fn can_user() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;

    let a = Some(f.user_a);
    let b = Some(f.user_b);
    let c = Some(f.user_c);
    let d = Some(f.user_d);
    let test_page = PermissionTarget::Page {
        page_id: f.test_page_id,
        category_id: f.category_id,
    };
    let other_page = PermissionTarget::Page {
        page_id: f.other_page_id,
        category_id: f.other_category_id,
    };

    assert!(
        check_target(&runner, a, f.site_id, test_page, Action::View).await,
        "user_a should pass page:view check"
    );
    assert!(
        check_target(&runner, a, f.site_id, other_page, Action::Edit).await,
        "user_a should pass page:edit check"
    );

    assert!(
        !check_target(&runner, c, f.site_id, test_page, Action::View).await,
        "user_c should fail page:view check"
    );
    assert!(
        !check_target(&runner, c, f.site_id, test_page, Action::Edit).await,
        "user_c should fail page:edit check"
    );

    assert!(
        !check_target(&runner, b, f.site_id, test_page, Action::View).await,
        "user_b should fail page:view check"
    );

    assert!(
        check_target(&runner, b, f.site_id, test_page, Action::Edit).await,
        "user_b: should pass page:edit check in test-category"
    );
    assert!(
        !check_target(&runner, b, f.site_id, other_page, Action::Edit).await,
        "user_b: should fail page:edit in other category"
    );

    assert!(
        !check_target(&runner, a, f.site_id, test_page, Action::Edit).await,
        "user_a: should fail page:edit check in test-category"
    );

    assert!(
        check_target(&runner, d, f.site_id, PermissionTarget::Site, Action::Edit).await,
        "user_d should pass site:edit check"
    );
    assert!(
        !check_target(&runner, a, f.site_id, PermissionTarget::Site, Action::Edit).await,
        "user_a should fail site:edit check"
    );
    assert!(
        !check_target(
            &runner,
            None,
            f.site_id,
            PermissionTarget::Site,
            Action::Edit
        )
        .await,
        "anonymous should fail site:edit check"
    );

    assert!(
        check_target(
            &runner,
            d,
            f.site_id,
            PermissionTarget::Lock,
            Action::BypassLock
        )
        .await,
        "user_d should pass page-lock:bypass-lock check"
    );
    assert!(
        !check_target(
            &runner,
            a,
            f.site_id,
            PermissionTarget::Lock,
            Action::BypassLock
        )
        .await,
        "user_a should fail page-lock:bypass-lock check"
    );

    assert!(
        !check_target(&runner, d, f.site_id, other_page, Action::Edit).await,
        "user_d: site:edit should not grant page:edit"
    );
}

#[tokio::test]
async fn check_category_scoping() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;

    assert!(
        PermissionService::can_user_as(
            runner.context(),
            Some(f.user_b),
            Some(f.site_id),
            Action::Edit,
            PermissionTarget::Page {
                page_id: f.test_page_id,
                category_id: f.category_id,
            }
        )
        .await
        .expect("Permission check returned an error"),
        "user_b should have page:edit permission for the page in test-category"
    )
}

#[tokio::test]
async fn cached_view_permissions_have_ttl() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();

    assert!(
        check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::View,
        )
        .await,
        "precondition: user_a should initially have RoleA page:view"
    );
    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        Some(true),
        "precondition: page:view should be cached"
    );

    let mut redis = ctx.redis();
    let ttl: i64 = redis
        .ttl(page_view_permission_cache_key(ctx, f.site_id, f.user_a).await)
        .await
        .expect("Failed to read permission cache TTL");

    assert!(
        (1..=PERMISSION_CACHE_TTL_SECONDS).contains(&ttl),
        "permission cache key TTL should be between 1 and {PERMISSION_CACHE_TTL_SECONDS} seconds, but was {ttl}"
    );
}

#[tokio::test]
async fn writing_one_cached_permission_does_not_extend_unrelated_permission_ttl() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();

    PermissionCache::set_user_permission(
        ctx,
        Some(f.site_id),
        Some(f.user_a),
        Resource::Page,
        None,
        Action::View,
        true,
    )
    .await
    .expect("Failed to seed page:view permission cache");

    let view_key = page_view_permission_cache_key(ctx, f.site_id, f.user_a).await;
    let mut redis = ctx.redis();
    let expire_set: bool = redis
        .expire(&view_key, 1)
        .await
        .expect("Failed to shorten page:view permission cache TTL");
    assert!(expire_set, "precondition: page:view cache key should exist");

    PermissionCache::set_user_permission(
        ctx,
        Some(f.site_id),
        Some(f.user_a),
        Resource::Page,
        None,
        Action::Edit,
        true,
    )
    .await
    .expect("Failed to write page:edit permission cache");

    let edit_key = permission_cache_key(
        ctx,
        f.site_id,
        f.user_a,
        Resource::Page,
        None,
        Action::Edit,
    )
    .await;
    let view_ttl: i64 = redis
        .ttl(&view_key)
        .await
        .expect("Failed to read page:view permission cache TTL");
    let edit_ttl: i64 = redis
        .ttl(&edit_key)
        .await
        .expect("Failed to read page:edit permission cache TTL");

    assert!(
        view_ttl == -2 || (0..=1).contains(&view_ttl),
        "writing page:edit must not refresh page:view TTL, but page:view TTL was {view_ttl}"
    );
    assert!(
        (1..=PERMISSION_CACHE_TTL_SECONDS).contains(&edit_ttl),
        "page:edit should have its own fresh TTL, but was {edit_ttl}"
    );
}

#[tokio::test]
async fn stale_user_permission_fence_does_not_write_cache() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();

    let stale_fence = PermissionCache::cache_fence(ctx, f.site_id, Some(f.user_a))
        .await
        .expect("Failed to read permission cache fence");

    PermissionCache::invalidate_user(ctx, f.site_id, f.user_a)
        .await
        .expect("Failed to invalidate permission cache for user");

    let wrote = PermissionCache::set_user_permission_if_fence_current(
        ctx,
        SetUserPermissionInput {
            site_id: Some(f.site_id),
            user_id: Some(f.user_a),
            resource_type: Resource::Page,
            resource_category_id: None,
            action: Action::View,
            has_permission: true,
        },
        &stale_fence,
    )
    .await
    .expect("Failed to attempt fenced permission cache write");

    assert!(
        !wrote,
        "stale user fence must not write permission cache after invalidation"
    );
    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        None,
        "stale fenced write must not recreate page:view cache"
    );
}

#[tokio::test]
async fn stale_user_permission_fence_does_not_read_old_cache_key() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();

    PermissionCache::set_user_permission(
        ctx,
        Some(f.site_id),
        Some(f.user_a),
        Resource::Page,
        None,
        Action::View,
        true,
    )
    .await
    .expect("Failed to seed page:view permission cache");

    let old_key = page_view_permission_cache_key(ctx, f.site_id, f.user_a).await;
    let mut redis = ctx.redis();
    let _: i64 = redis
        .incr(
            format!("permission:site:{}:user:{}:version", f.site_id, f.user_a),
            1,
        )
        .await
        .expect("Failed to bump permission cache user fence");
    let old_key_exists: bool = redis
        .exists(&old_key)
        .await
        .expect("Failed to check old permission cache key");
    assert!(
        old_key_exists,
        "precondition: old permission cache key should remain during cleanup window"
    );

    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        None,
        "permission cache reads must ignore keys written under stale fences"
    );
}

#[tokio::test]
async fn stale_site_permission_fence_does_not_write_cache() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();

    let stale_fence = PermissionCache::cache_fence(ctx, f.site_id, Some(f.user_a))
        .await
        .expect("Failed to read permission cache fence");

    PermissionCache::invalidate_site(ctx, f.site_id)
        .await
        .expect("Failed to invalidate permission cache for site");

    let wrote = PermissionCache::set_user_permission_if_fence_current(
        ctx,
        SetUserPermissionInput {
            site_id: Some(f.site_id),
            user_id: Some(f.user_a),
            resource_type: Resource::Page,
            resource_category_id: None,
            action: Action::View,
            has_permission: true,
        },
        &stale_fence,
    )
    .await
    .expect("Failed to attempt fenced permission cache write");

    assert!(
        !wrote,
        "stale site fence must not write permission cache after invalidation"
    );
    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        None,
        "stale site fenced write must not recreate page:view cache"
    );
}

#[tokio::test]
async fn site_permission_cache_invalidation_publishes_anonymous_fence() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();
    let site_key = format!("permission:site:{}:version", f.site_id);
    let anonymous_user_key =
        format!("permission:site:{}:user:anonymous:version", f.site_id);
    let mut redis = ctx.redis();
    let _: usize = redis
        .del((&site_key, &anonymous_user_key))
        .await
        .expect("failed to clear permission fence keys");
    let mut pubsub = subscribed_permission_invalidation_stream().await;

    PermissionCache::invalidate_site(ctx, f.site_id)
        .await
        .expect("Failed to invalidate permission cache for site");

    let expected_payload = format!(
        r#"{{"type":"anonymous-permission","site_id":{},"site_version":"1","user_version":"0"}}"#,
        f.site_id
    );
    let payload = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let message = pubsub
                .on_message()
                .next()
                .await
                .expect("pub/sub stream ended unexpectedly");
            let payload: String = message
                .get_payload()
                .expect("failed to read permission invalidation payload");
            if payload == expected_payload {
                break payload;
            }
        }
    })
    .await
    .expect("timed out waiting for permission invalidation");

    assert_eq!(payload, expected_payload);

    let _: usize = redis
        .del((&site_key, &anonymous_user_key))
        .await
        .expect("failed to clean permission fence keys");
}

#[tokio::test]
async fn permission_cache_version_keys_expire_after_invalidation() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();

    PermissionCache::invalidate_user(ctx, f.site_id, f.user_a)
        .await
        .expect("Failed to invalidate permission cache for user");
    PermissionCache::invalidate_site(ctx, f.site_id)
        .await
        .expect("Failed to invalidate permission cache for site");

    let mut redis = ctx.redis();
    let user_ttl: i64 = redis
        .ttl(format!(
            "permission:site:{}:user:{}:version",
            f.site_id, f.user_a
        ))
        .await
        .expect("Failed to read user permission fence TTL");
    let site_ttl: i64 = redis
        .ttl(format!("permission:site:{}:version", f.site_id))
        .await
        .expect("Failed to read site permission fence TTL");

    assert!(
        PERMISSION_CACHE_TTL_SECONDS < user_ttl
            && user_ttl <= PERMISSION_CACHE_FENCE_TTL_SECONDS,
        "user permission fence must outlive the permission cache TTL, but was {user_ttl}"
    );
    assert!(
        PERMISSION_CACHE_TTL_SECONDS < site_ttl
            && site_ttl <= PERMISSION_CACHE_FENCE_TTL_SECONDS,
        "site permission fence must outlive the permission cache TTL, but was {site_ttl}"
    );
}

#[tokio::test]
async fn role_permission_updates_invalidate_cached_view_permissions() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();

    run_queued_cache_invalidations(ctx).await;

    assert!(
        check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::View,
        )
        .await,
        "precondition: user_a should initially have RoleA page:view"
    );
    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        Some(true),
        "precondition: page:view should be cached before role permission update"
    );

    add_perms_to_role(
        ctx,
        f.site_id,
        f.role_a,
        vec![Permission {
            resource_type: Resource::Page,
            resource_category: None,
            action: Action::Edit,
        }],
    )
    .await;

    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        Some(true),
        "role permission update should queue invalidation until post-commit actions run"
    );

    run_queued_cache_invalidations(ctx).await;

    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        None,
        "role permission update should invalidate stale page:view cache"
    );
    assert!(
        !check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::View,
        )
        .await,
        "user_a should lose page:view after RoleA no longer grants it"
    );
    assert!(
        check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::Edit,
        )
        .await,
        "user_a should retain legitimate RoleA page:edit"
    );
}

#[tokio::test]
async fn role_revocation_invalidates_cached_view_permissions() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();

    run_queued_cache_invalidations(ctx).await;

    assert!(
        check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::View,
        )
        .await,
        "precondition: user_a should initially have RoleA page:view"
    );
    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        Some(true),
        "precondition: page:view should be cached before role revocation"
    );

    revoke_role(ctx, f.site_id, f.user_a, f.role_a).await;
    run_queued_cache_invalidations(ctx).await;

    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        None,
        "role revocation should invalidate stale page:view cache"
    );
    assert!(
        !check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::View,
        )
        .await,
        "user_a should lose page:view after RoleA is revoked"
    );
}

#[tokio::test]
async fn site_membership_changes_invalidate_cached_view_permissions() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();

    run_queued_cache_invalidations(ctx).await;

    assert!(
        check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::View,
        )
        .await,
        "precondition: user_a should initially have explicit RoleA page:view"
    );
    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        Some(true),
        "precondition: explicit page:view should be cached before membership change"
    );

    create_site_member(ctx, f.site_id, f.user_a).await;
    run_queued_cache_invalidations(ctx).await;
    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        None,
        "site membership creation should invalidate stale page:view cache"
    );

    assert!(
        check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::View,
        )
        .await,
        "explicit RoleA page:view should remain valid after membership creation"
    );
    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        Some(true),
        "explicit page:view should be cached again before membership removal"
    );

    remove_site_member(ctx, f.site_id, f.user_a).await;
    run_queued_cache_invalidations(ctx).await;
    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        None,
        "site membership removal should invalidate stale page:view cache"
    );

    assert!(
        check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::View,
        )
        .await,
        "explicit RoleA page:view should remain valid after membership removal"
    );
}

#[tokio::test]
async fn banned_user_does_not_retain_explicit_role_permissions() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();

    assert!(
        check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::View,
        )
        .await,
        "precondition: user_a should initially have RoleA page:view"
    );
    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        Some(true),
        "precondition: page:view should be cached before banning user_a"
    );

    assert!(
        check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::Edit,
        )
        .await,
        "precondition: user_a should initially have RoleA page:edit"
    );

    create_site_member(ctx, f.site_id, f.user_a).await;
    ban_site_user(ctx, f.site_id, f.user_a).await;
    run_queued_cache_invalidations(ctx).await;

    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        None,
        "site ban creation should invalidate stale page:view cache"
    );

    assert!(
        !check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::View,
        )
        .await,
        "banned user should not retain page:view from cached explicit RoleA"
    );
    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        None,
        "active site ban should not recreate page:view cache with a denial"
    );

    assert!(
        !check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::Edit,
        )
        .await,
        "banned user should not retain page:edit from explicit RoleA"
    );

    let roles = RoleService::get_all_roles_for_user_and_site(
        ctx,
        GetUserRolesInput {
            user_id: Some(f.user_a),
            site_id: f.site_id,
            page_reference: None,
        },
    )
    .await
    .expect("Failed to get roles for banned user");

    assert!(
        roles.iter().all(|role| role.name != "RoleA"),
        "banned user should not retain explicit RoleA in effective roles: {:?}",
        roles.iter().map(|role| &role.name).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn active_timed_site_ban_does_not_cache_denied_view_permission() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();

    assert!(
        check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::View,
        )
        .await,
        "precondition: user_a should initially have RoleA page:view"
    );
    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        Some(true),
        "precondition: page:view should be cached before the timed ban"
    );

    create_site_member(ctx, f.site_id, f.user_a).await;
    ban_site_user_until(
        ctx,
        f.site_id,
        f.user_a,
        Some(Date::from_calendar_date(9999, Month::January, 1).unwrap()),
    )
    .await;
    run_queued_cache_invalidations(ctx).await;

    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        None,
        "timed site ban creation should invalidate stale page:view cache"
    );
    assert!(
        !check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::View,
        )
        .await,
        "active timed site ban should deny page:view"
    );
    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        None,
        "active timed site ban should not recreate page:view cache with a denial"
    );
}

#[tokio::test]
async fn page_scoped_view_check_does_not_populate_the_category_cache() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();

    let allowed = PermissionService::check_user_can(
        ctx,
        &CheckPermissionContext {
            user_id: Some(f.user_a),
            site_id: f.site_id,
            page_reference: Some(Reference::Id(1)),
        },
        Permission {
            resource_type: Resource::Page,
            resource_category: None,
            action: Action::View,
        },
    )
    .await
    .expect("page-scoped view check should succeed");
    assert!(allowed, "user_a has unscoped RoleA page:view");

    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        None,
        "a page-scoped view decision must not be written to the category-wide cache",
    );
}

#[tokio::test]
async fn active_site_ban_suppresses_view_permission_caching() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();

    let registered = RoleService::create(
        ctx,
        InternalCreateRoleInput {
            site_id: f.site_id,
            name: "registered".to_owned(),
            description: Some("virtual registered role".to_owned()),
            is_virtual: true,
            parent_role_id: None,
            creating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("registered virtual role should be created")
    .role_id;
    add_perms_to_role(
        ctx,
        f.site_id,
        registered,
        vec![Permission {
            resource_type: Resource::Page,
            resource_category: None,
            action: Action::Edit,
        }],
    )
    .await;

    create_site_member(ctx, f.site_id, f.user_a).await;
    ban_site_user_until(
        ctx,
        f.site_id,
        f.user_a,
        Some(Date::from_calendar_date(9999, Month::January, 1).unwrap()),
    )
    .await;
    run_queued_cache_invalidations(ctx).await;

    assert!(
        !check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::View,
        )
        .await,
        "a banned user without page:view should be denied"
    );
    assert_eq!(
        cached_page_view(ctx, f.site_id, f.user_a).await,
        None,
        "an active site ban must suppress caching of the view decision",
    );
}

#[tokio::test]
async fn expired_site_ban_does_not_suppress_explicit_role_permissions() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();

    create_site_member(ctx, f.site_id, f.user_a).await;
    ban_site_user_until(
        ctx,
        f.site_id,
        f.user_a,
        Some(Date::from_calendar_date(2000, Month::January, 1).unwrap()),
    )
    .await;

    assert!(
        check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::View,
        )
        .await,
        "expired site ban should not suppress explicit RoleA page:view"
    );

    assert!(
        check(
            &runner,
            Some(f.user_a),
            f.site_id,
            Resource::Page,
            None,
            Action::Edit,
        )
        .await,
        "expired site ban should not suppress explicit RoleA page:edit"
    );

    let roles = RoleService::get_all_roles_for_user_and_site(
        ctx,
        GetUserRolesInput {
            user_id: Some(f.user_a),
            site_id: f.site_id,
            page_reference: None,
        },
    )
    .await
    .expect("Failed to get roles for previously banned user");

    assert!(
        roles.iter().any(|role| role.name == "RoleA"),
        "expired site ban should not suppress explicit RoleA in effective roles: {:?}",
        roles.iter().map(|role| &role.name).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn batch_check_user_can() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;

    let a = Some(f.user_a);
    let b = Some(f.user_b);
    let c = Some(f.user_c);
    let cat = Some(f.category_id);

    let [can_view, can_edit] = batch_check(
        &runner,
        a,
        f.site_id,
        [
            (Resource::Page, None, Action::View),
            (Resource::Page, None, Action::Edit),
        ],
    )
    .await;
    assert!(can_view, "user_a: batch should pass page:view");
    assert!(can_edit, "user_a: batch should pass page:edit");

    let [can_view, can_edit] = batch_check(
        &runner,
        b,
        f.site_id,
        [
            (Resource::Page, cat, Action::View),
            (Resource::Page, cat, Action::Edit),
        ],
    )
    .await;
    assert!(
        !can_view,
        "user_b: batch should fail page:view in test-category"
    );
    assert!(
        can_edit,
        "user_b: batch should pass page:edit in test-category"
    );

    let [can_view, can_edit] = batch_check(
        &runner,
        c,
        f.site_id,
        [
            (Resource::Page, None, Action::View),
            (Resource::Page, None, Action::Edit),
        ],
    )
    .await;
    assert!(!can_view, "user_c: batch should fail page:view");
    assert!(!can_edit, "user_c: batch should fail page:edit");

    let [batch_view, batch_edit] = batch_check(
        &runner,
        a,
        f.site_id,
        [
            (Resource::Page, None, Action::View),
            (Resource::Page, None, Action::Edit),
        ],
    )
    .await;
    assert_eq!(
        batch_view,
        check(&runner, a, f.site_id, Resource::Page, None, Action::View).await,
        "batch and single check differ on page:view"
    );
    assert_eq!(
        batch_edit,
        check(&runner, a, f.site_id, Resource::Page, None, Action::Edit).await,
        "batch and single check differ on page:edit"
    );
}

#[tokio::test]
async fn check_category_resolution() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;

    assert!(
        PermissionService::check_user_can(
            runner.context(),
            &CheckPermissionContext {
                user_id: Some(f.user_b),
                site_id: f.site_id,
                page_reference: None
            },
            Permission {
                resource_type: Resource::Page,
                resource_category: Some(Reference::from(TEST_CATEGORY_NAME)),
                action: Action::Edit,
            },
        )
        .await
        .expect("Permission check returned an error"),
        "user_b should have page:edit permission for test-category"
    )
}

#[tokio::test]
async fn check_permission_endpoint() {
    let mut runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_b),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Slug(std::borrow::Cow::Borrowed(
            "test-category:test-page",
        ))),
        ..Default::default()
    });
    let page = run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": f.site_id,
            "wikitext": "Test",
            "title": "Test Page",
            "alt_title": null,
            "slug": "test-category:test-page",
            "layout": null,
            "revision_comments": "",
            "user_id": f.user_b,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_b),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Id(page.page_id)),
        ..Default::default()
    });
    assert!(
        run_endpoint!(runner, page_edit_permission).can_edit,
        "user_b should have edit permission for page in test-category"
    );

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_b),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Slug(std::borrow::Cow::Owned(page.slug.clone()))),
        ..Default::default()
    });
    assert!(
        run_endpoint!(runner, page_edit_permission).can_edit,
        "user_b should have edit permission for page in test-category"
    );

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_c),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Id(page.page_id)),
        ..Default::default()
    });
    assert!(
        !run_endpoint!(runner, page_edit_permission).can_edit,
        "user_c should NOT have edit permission for page in test-category"
    );

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_c),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Slug(std::borrow::Cow::Owned(page.slug.clone()))),
        ..Default::default()
    });
    assert!(
        !run_endpoint!(runner, page_edit_permission).can_edit,
        "user_c should NOT have edit permission for page in test-category"
    );

    // Upstream #3155: with no page in the request context, the endpoint
    // falls back to the site's default page instead of failing.
    let site = SiteService::get(runner.context(), Reference::Id(f.site_id))
        .await
        .expect("Failed to get site");

    PageService::create(
        runner.context(),
        CreatePage {
            site_id: f.site_id,
            wikitext: str!("Main page"),
            title: str!("Main Page"),
            alt_title: None,
            tags: Vec::new(),
            slug: site.default_page.clone(),
            layout: None,
            revision_comments: str!(""),
            user_id: SYSTEM_USER_ID,
            bypass_filter: true,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to create default page");

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_a),
        site_id: Some(f.site_id),
        page_reference: None,
        ..Default::default()
    });
    assert!(
        run_endpoint!(runner, page_edit_permission).can_edit,
        "user_a should have edit permission for the default page"
    );

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_c),
        site_id: Some(f.site_id),
        page_reference: None,
        ..Default::default()
    });
    assert!(
        !run_endpoint!(runner, page_edit_permission).can_edit,
        "user_c should NOT have edit permission for the default page"
    );

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_a),
        ..Default::default()
    });
    run_endpoint_err!(runner, page_edit_permission);
}

#[tokio::test]
async fn page_create_permission_reports_category_create_rights() {
    let mut runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let slug = format!("{TEST_CATEGORY_NAME}:create-permission-{}", next_n());

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_b),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Slug(slug.clone().into())),
        ..Default::default()
    });
    assert!(
        run_endpoint!(runner, page_create_permission).can_create,
        "user_b should have create permission for pages in test-category"
    );

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_c),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Slug(slug.into())),
        ..Default::default()
    });
    assert!(
        !run_endpoint!(runner, page_create_permission).can_create,
        "user_c should NOT have create permission for pages in test-category"
    );
}

#[tokio::test]
async fn page_revision_visibility_requires_actual_page_category_edit_permission() {
    let mut runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let page_slug = format!("{TEST_CATEGORY_NAME}:revision-visibility-{}", next_n());

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_b),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Slug(page_slug.clone().into())),
        ..Default::default()
    });
    let page = run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": f.site_id,
            "wikitext": "Revision visibility category fixture",
            "title": "Revision Visibility Category Fixture",
            "alt_title": null,
            "slug": page_slug,
            "layout": null,
            "revision_comments": "create category-scoped revision fixture",
            "user_id": f.user_b,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_a),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Id(page.page_id)),
        ..Default::default()
    });
    let error = run_endpoint_err!(
        runner,
        page_revision_edit,
        json!({
            "site_id": f.site_id,
            "page_id": page.page_id,
            "revision_id": page.revision_id,
            "user_id": f.user_a,
            "ip_address": common::IP_ADDRESS,
            "hidden": ["unknown"],
        }),
    );
    assert_contains_error!(error, ErrorType::PermissionDenied);

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_a),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Id(page.page_id)),
        ..Default::default()
    });
    let spoofed = run_endpoint_err!(
        runner,
        page_revision_edit,
        json!({
            "site_id": f.site_id,
            "page_id": page.page_id,
            "revision_id": page.revision_id,
            "user_id": f.user_b,
            "ip_address": common::IP_ADDRESS,
            "hidden": ["unknown"],
        }),
    );
    assert_contains_error!(spoofed, ErrorType::PermissionDenied);

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_a),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Id(page.page_id)),
        ..Default::default()
    });
    let unchanged = run_endpoint!(
        runner,
        page_revision_get,
        json!({
            "site_id": f.site_id,
            "page_id": page.page_id,
            "revision_number": 0,
        }),
    )
    .expect("the denied revision should remain readable");
    assert!(
        unchanged.hidden.is_empty(),
        "denied and spoofed callers must not update revision visibility",
    );

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_b),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Id(page.page_id)),
        ..Default::default()
    });
    let revision = run_endpoint!(
        runner,
        page_revision_edit,
        json!({
            "site_id": f.site_id,
            "page_id": page.page_id,
            "revision_id": page.revision_id,
            "user_id": f.user_b,
            "ip_address": common::IP_ADDRESS,
            "hidden": ["comments"],
        }),
    );
    assert_eq!(revision.hidden, vec![String::from("comments")]);
}

#[tokio::test]
async fn page_revision_visibility_rejects_a_revision_from_another_page() {
    let mut runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let suffix = next_n();
    let page_a_slug = format!("{TEST_CATEGORY_NAME}:revision-owner-a-{suffix}");
    let page_b_slug = format!("{TEST_CATEGORY_NAME}:revision-owner-b-{suffix}");

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_b),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Slug(page_a_slug.clone().into())),
        ..Default::default()
    });
    let page_a = run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": f.site_id,
            "wikitext": "Revision ownership fixture A",
            "title": "Revision Ownership Fixture A",
            "alt_title": null,
            "slug": page_a_slug,
            "layout": null,
            "revision_comments": "create revision ownership fixture A",
            "user_id": f.user_b,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_b),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Slug(page_b_slug.clone().into())),
        ..Default::default()
    });
    let page_b = run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": f.site_id,
            "wikitext": "Revision ownership fixture B",
            "title": "Revision Ownership Fixture B",
            "alt_title": null,
            "slug": page_b_slug,
            "layout": null,
            "revision_comments": "create revision ownership fixture B",
            "user_id": f.user_b,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_b),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Id(page_a.page_id)),
        ..Default::default()
    });
    let error = run_endpoint_err!(
        runner,
        page_revision_edit,
        json!({
            "site_id": f.site_id,
            "page_id": page_a.page_id,
            "revision_id": page_b.revision_id,
            "user_id": f.user_b,
            "ip_address": common::IP_ADDRESS,
            "hidden": ["comments"],
        }),
    );
    assert_contains_error!(error, ErrorType::PageRevision);

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_a),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Id(page_b.page_id)),
        ..Default::default()
    });
    let revision_b = run_endpoint!(
        runner,
        page_revision_get,
        json!({
            "site_id": f.site_id,
            "page_id": page_b.page_id,
            "revision_number": 0,
        }),
    )
    .expect("Revision ownership fixture B should remain readable");
    assert!(
        revision_b.hidden.is_empty(),
        "foreign revision was modified despite the page/revision mismatch",
    );
}

#[tokio::test]
async fn page_view_permission_endpoint_hides_missing_and_private_pages() {
    let mut runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_b),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Slug(std::borrow::Cow::Borrowed(
            "test-category:view-permission-page",
        ))),
        ..Default::default()
    });
    let page = run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": f.site_id,
            "wikitext": "View permission endpoint fixture",
            "title": "View permission endpoint fixture",
            "alt_title": null,
            "slug": "test-category:view-permission-page",
            "layout": null,
            "revision_comments": "view permission endpoint fixture",
            "user_id": f.user_b,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_a),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Id(page.page_id)),
        ..Default::default()
    });
    assert!(run_endpoint!(
        runner,
        page_view_permission,
        json!({"site_id": f.site_id, "page": page.page_id}),
    ));

    runner.set_request_context(RequestContext {
        user_id: Some(f.user_b),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Id(page.page_id)),
        ..Default::default()
    });
    assert!(!run_endpoint!(
        runner,
        page_view_permission,
        json!({"site_id": f.site_id, "page": page.page_id}),
    ));
    runner.set_request_context(RequestContext {
        user_id: Some(f.user_c),
        site_id: Some(f.site_id),
        page_reference: Some(Reference::Id(page.page_id)),
        ..Default::default()
    });
    assert!(!run_endpoint!(
        runner,
        page_view_permission,
        json!({"site_id": f.site_id, "page": "missing-view-permission-page"}),
    ));
}

#[tokio::test]
async fn role_update_permissions_and_get() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;

    const CATEGORY_NAME: &str = "TestCategory";
    const OTHER_CATEGORY_NAME: &str = "OtherCategory";

    let category_id =
        CategoryService::get_or_create(runner.context(), f.site_id, CATEGORY_NAME)
            .await
            .expect("Failed to create page category")
            .category_id;

    let other_category_id =
        CategoryService::get_or_create(runner.context(), f.site_id, OTHER_CATEGORY_NAME)
            .await
            .expect("Failed to create other page category")
            .category_id;

    let role = RoleService::create(
        runner.context(),
        InternalCreateRoleInput {
            site_id: f.site_id,
            name: str!("Test Role"),
            description: None,
            is_virtual: false,
            parent_role_id: None,
            creating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to create role");

    PermissionService::update_permissions_for_role(
        runner.context(),
        UpdateRolePermissionsInput {
            site_id: f.site_id,
            role_reference: Reference::Id(role.role_id),
            new_permissions: vec![
                Permission {
                    resource_type: Resource::Page,
                    resource_category: Some(Reference::Slug(CATEGORY_NAME.into())),
                    action: Action::View,
                },
                Permission {
                    resource_type: Resource::Page,
                    resource_category: Some(Reference::Slug(OTHER_CATEGORY_NAME.into())),
                    action: Action::Edit,
                },
            ],
            cascade_removals: false,
            updating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("Failed to update role permissions");

    let perms = run_endpoint!(
        runner,
        get_role_permissions,
        json!({
            "site_id": f.site_id,
            "role_reference": role.role_id,
            "human_readable_categories": false,
        }),
    );

    assert_eq!(perms.len(), 2);
    let view_perm = perms
        .iter()
        .find(|p| p.action == Action::View)
        .expect("Expected to find view permission");
    let edit_perm = perms
        .iter()
        .find(|p| p.action == Action::Edit)
        .expect("Expected to find edit permission");

    assert_eq!(
        view_perm.resource_category,
        Some(Reference::Id(category_id))
    );
    assert_eq!(
        edit_perm.resource_category,
        Some(Reference::Id(other_category_id))
    );

    let perms = run_endpoint!(
        runner,
        get_role_permissions,
        json!({
            "site_id": f.site_id,
            "role_reference": role.role_id,
            "human_readable_categories": true,
        }),
    );

    assert_eq!(perms.len(), 2);
    let view_perm = perms
        .iter()
        .find(|p| p.action == Action::View)
        .expect("Expected to find view permission");
    let edit_perm = perms
        .iter()
        .find(|p| p.action == Action::Edit)
        .expect("Expected to find edit permission");

    assert_eq!(
        view_perm.resource_category,
        Some(Reference::Slug(CATEGORY_NAME.into()))
    );
    assert_eq!(
        edit_perm.resource_category,
        Some(Reference::Slug(OTHER_CATEGORY_NAME.into()))
    );
}

#[tokio::test]
async fn role_permissions_resolve_human_readable_forum_category_names() {
    const FORUM_CATEGORY_NAME: &str = "Permission Forum Category";

    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();

    let group = ForumService::create_group(
        ctx,
        CreateForumGroup {
            site_id: f.site_id,
            user_id: SYSTEM_USER_ID,
            name: "Permission forum group".to_owned(),
            description: "Permission forum group".to_owned(),
            visible: true,
            sort_index: None,
            from_wikidot: false,
        },
    )
    .await
    .expect("forum group should be created");
    let category = ForumService::create_category(
        ctx,
        CreateForumCategory {
            forum_group_id: group.forum_group_id,
            user_id: SYSTEM_USER_ID,
            name: FORUM_CATEGORY_NAME.to_owned(),
            description: "Permission forum category".to_owned(),
            sort_index: None,
            max_nest_level: None,
            per_page_discussion: None,
            layout: None,
            from_wikidot: false,
        },
    )
    .await
    .expect("forum category should be created");

    let role = create_role(ctx, f.site_id, "Forum Scoped Role", None).await;
    add_perms_to_role(
        ctx,
        f.site_id,
        role,
        vec![Permission {
            resource_type: Resource::ForumCategory,
            resource_category: Some(Reference::Id(category.forum_category_id)),
            action: Action::View,
        }],
    )
    .await;

    let perms = PermissionService::get_permissions_for_role(
        ctx,
        GetRolePermissionsInput {
            site_id: f.site_id,
            role_reference: Reference::Id(role),
            human_readable_categories: true,
        },
    )
    .await
    .expect("role permissions should resolve");

    assert_eq!(perms.len(), 1);
    assert_eq!(
        perms[0].resource_category,
        Some(Reference::Slug(FORUM_CATEGORY_NAME.into())),
        "a forum-category-scoped permission must resolve to its category name",
    );
}

#[tokio::test]
async fn get_permissions_for_role_rejects_cross_site_numeric_role_id() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();
    let n = next_n();

    let other_site = SiteService::create(
        ctx,
        CreateSite {
            slug: format!("perm-other-{n}"),
            name: format!("Other permission test site {n}"),
            tagline: String::new(),
            description: format!("Other permission test site {n}"),
            default_page: None,
            layout: None,
            license: License::CcBySa40,
            locale: String::from("en"),
            ip_address: common::IP_ADDRESS,
        },
        None,
    )
    .await
    .expect("Failed to create other test site");

    let other_role_id =
        create_role(ctx, other_site.site_id, "Other Site Role", None).await;
    add_perms_to_role(
        ctx,
        other_site.site_id,
        other_role_id,
        vec![Permission {
            resource_type: Resource::Page,
            resource_category: None,
            action: Action::View,
        }],
    )
    .await;

    let err = PermissionService::get_permissions_for_role(
        ctx,
        GetRolePermissionsInput {
            site_id: f.site_id,
            role_reference: Reference::Id(other_role_id),
            human_readable_categories: false,
        },
    )
    .await
    .expect_err("cross-site numeric role IDs must not resolve permissions");

    assert_contains_error!(err, ErrorType::Role);
}

#[tokio::test]
async fn get_decorated_permissions_for_role() {
    let runner = TestRunner::setup().await;
    let f = PermissionFixture::setup(&runner).await;
    let ctx = runner.context();

    let parent_id = create_role(ctx, f.site_id, "Parent", None).await;
    add_perms_to_role(
        ctx,
        f.site_id,
        parent_id,
        vec![
            Permission {
                resource_type: Resource::Page,
                resource_category: None,
                action: Action::View,
            },
            Permission {
                resource_type: Resource::Page,
                resource_category: None,
                action: Action::Edit,
            },
        ],
    )
    .await;

    let child_id = create_role(ctx, f.site_id, "Child", Some(parent_id)).await;
    add_perms_to_role(
        ctx,
        f.site_id,
        child_id,
        vec![Permission {
            resource_type: Resource::Page,
            resource_category: None,
            action: Action::View,
        }],
    )
    .await;

    let find = |list: &Vec<DecoratedPermission<'static>>,
                resource: Resource,
                action: Action| {
        list.iter()
            .find(|d| {
                d.permission.resource_type == resource && d.permission.action == action
            })
            .unwrap_or_else(|| panic!("Permission {resource}:{action} not found"))
            .clone()
    };

    let child_decorated = run_endpoint!(
        runner,
        get_decorated_role_permissions,
        json!({
            "site_id": f.site_id,
            "role_reference": child_id,
            "human_readable_categories": false,
        }),
    );

    let p = find(&child_decorated, Resource::Page, Action::View);
    assert!(
        p.active && p.removable && !p.addable,
        "child page:view: expected active+removable"
    );

    let p = find(&child_decorated, Resource::Page, Action::Edit);
    assert!(
        !p.active && p.addable && !p.removable,
        "child page:edit: expected inactive+addable"
    );

    let p = find(&child_decorated, Resource::Page, Action::Create);
    assert!(
        !p.active && !p.addable && !p.removable,
        "child page:create: expected inactive+locked"
    );

    let parent_decorated = run_endpoint!(
        runner,
        get_decorated_role_permissions,
        json!({
            "site_id": f.site_id,
            "role_reference": parent_id,
            "human_readable_categories": false,
        }),
    );

    let p = find(&parent_decorated, Resource::Page, Action::View);
    assert!(
        p.active && !p.removable && !p.addable,
        "parent page:view: expected active+locked"
    );

    let p = find(&parent_decorated, Resource::Page, Action::Edit);
    assert!(
        p.active && p.removable && !p.addable,
        "parent page:edit: expected active+removable"
    );

    let p = find(&parent_decorated, Resource::Page, Action::Create);
    assert!(
        !p.active && p.addable && !p.removable,
        "parent page:create: expected inactive+addable"
    );

    assert_panics!(|| find(&parent_decorated, Resource::Site, Action::Assign));
}
