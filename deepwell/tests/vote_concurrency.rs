/*
 * tests/vote_concurrency.rs
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

use deepwell::api::{
    ServerState, build_server_at,
    build_server_state_without_workers_with_job_queue_namespace,
};
use deepwell::config::{Config, Secrets};
use deepwell::constants::SYSTEM_USER_ID;
use deepwell::license::License;
use deepwell::models::audit_log::{self, Entity as AuditLog};
use deepwell::models::known_user::Entity as KnownUserTable;
use deepwell::models::page::{self, Entity as PageTable};
use deepwell::models::page_category::{self, Entity as PageCategory};
use deepwell::models::page_revision::{self, Entity as PageRevisionTable};
use deepwell::models::page_vote::{self, Entity as PageVoteTable};
use deepwell::models::relation::{self, Entity as RelationTable};
use deepwell::models::role::{self, Entity as RoleTable};
use deepwell::models::role_permission::{self, Entity as RolePermissionTable};
use deepwell::models::session::{self, Entity as SessionTable};
use deepwell::models::site::Entity as SiteTable;
use deepwell::models::user::Entity as UserTable;
use deepwell::services::ServiceContext;
use deepwell::services::category::CategoryService;
use deepwell::services::job::JOB_QUEUE_NAME;
use deepwell::services::page::PageService;
use deepwell::services::page_revision::{PageRevisionService, RerenderType};
use deepwell::services::permission::PermissionService;
use deepwell::services::public_cache::PublicContentCache;
use deepwell::services::role::{
    InternalCreateRoleInput, RoleService, SystemRole, UpdateRolePermissionsInput,
};
use deepwell::services::session::{CreateSession, SessionService};
use deepwell::services::site::{CreateSite, SiteService};
use deepwell::services::user::{CreateUser, UserService};
use deepwell::types::{
    Action, PageId, Permission, Reference, RelationObjectType, RerenderDepth, Resource,
    UserType,
};
use redis::AsyncCommands;
use rsmq_async::{Rsmq, RsmqConnection};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, Condition, EntityTrait, IntoActiveModel,
    PaginatorTrait, QueryFilter, Set, TransactionTrait,
};
use serde_json::{Value as JsonValue, json};
use std::env;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::panic::AssertUnwindSafe;
use std::time::Duration;
use uuid::Uuid;

use futures::FutureExt;

const TEST_IP: IpAddr = IpAddr::V4(Ipv4Addr::new(192, 0, 2, 71));
const SITE_PREFIX: &str = "vote-contention";
const RATE_SOURCE: &str = "[[module Rate]]";

async fn cleanup_namespace(redis_url: &str, namespace: &str) {
    let client =
        redis::Client::open(redis_url).expect("failed to construct Redis client");
    let mut connection = client
        .get_multiplexed_async_connection()
        .await
        .expect("failed to connect to Redis for cleanup");
    let keys: Vec<String> = redis::cmd("KEYS")
        .arg(format!("{namespace}:*"))
        .query_async(&mut connection)
        .await
        .expect("failed to list test Redis keys");
    if !keys.is_empty() {
        let _: usize = connection
            .del(keys)
            .await
            .expect("failed to delete test Redis keys");
    }
}

struct VoteContentionFixture {
    state: ServerState,
    redis_url: String,
    namespace: String,
    session_token: String,
    site_id: i64,
    site_user_id: i64,
    actor_user_id: i64,
    page_id: i64,
    page_slug: String,
}

impl VoteContentionFixture {
    async fn new() -> Self {
        let redis_url =
            env::var("REDIS_URL").expect("REDIS_URL must be set for integration tests");
        let run_id = Uuid::new_v4().simple().to_string();
        let namespace = format!("rsmq-vote-concurrency-{run_id}");
        let mut config = Config::integration_testing();
        config.job_min_poll_delay = Duration::from_millis(10);
        config.job_max_poll_delay = Duration::from_millis(50);
        config.job_work_delay = Duration::from_millis(10);
        config.rerender_skip = vec![(10, None)];
        let state = build_server_state_without_workers_with_job_queue_namespace(
            config,
            Secrets::load(),
            &namespace,
        )
        .await
        .expect("isolated vote contention state should build");
        let mut rsmq = Rsmq::clone(&state.rsmq);
        clear_job_queue(&mut rsmq).await;

        let site_slug = format!("{SITE_PREFIX}-{run_id}");
        let page_slug = format!("{SITE_PREFIX}-page-{run_id}");
        let transaction = state
            .database
            .begin()
            .await
            .expect("vote contention fixture transaction should begin");
        let (site_id, site_user_id, actor_user_id, page_id, page_slug, session_token) = {
            let ctx = ServiceContext::new(&state, &transaction);
            let created = SiteService::create(
                &ctx,
                CreateSite {
                    slug: site_slug.clone(),
                    name: String::from("Vote contention fixture"),
                    tagline: String::new(),
                    description: String::from(
                        "Isolated committed vote contention test site",
                    ),
                    default_page: None,
                    layout: Some(ftml::layout::Layout::Wikidot),
                    license: License::CcBySa40,
                    locale: String::from("en"),
                    ip_address: TEST_IP,
                },
                None,
            )
            .await
            .expect("vote contention site should be created");
            for category in ["_default", "component"] {
                CategoryService::get_or_create(&ctx, created.site_id, category)
                    .await
                    .expect("vote contention page category should be created");
            }
            let everyone = RoleService::create(
                &ctx,
                InternalCreateRoleInput {
                    site_id: created.site_id,
                    name: SystemRole::Everyone.to_string(),
                    description: Some(String::from("Vote contention fixture role")),
                    is_virtual: true,
                    parent_role_id: None,
                    creating_user_id: SYSTEM_USER_ID,
                    ip_address: TEST_IP,
                },
            )
            .await
            .expect("vote contention everyone role should be created");
            PermissionService::update_permissions_for_role(
                &ctx,
                UpdateRolePermissionsInput {
                    site_id: created.site_id,
                    role_reference: Reference::Id(everyone.role_id),
                    new_permissions: [Action::View]
                        .into_iter()
                        .map(|action| Permission {
                            resource_type: Resource::Page,
                            resource_category: None,
                            action,
                        })
                        .collect(),
                    cascade_removals: false,
                    updating_user_id: SYSTEM_USER_ID,
                    ip_address: TEST_IP,
                },
            )
            .await
            .expect("vote contention view permission should be granted");

            let actor = UserService::create(
                &ctx,
                CreateUser {
                    user_type: UserType::Regular,
                    name: format!("vote-contention-actor-{run_id}"),
                    email: format!("vote-contention-{run_id}@example.com"),
                    locales: vec![String::from("en")],
                    password: String::from("vote-contention-password"),
                    bypass_filter: true,
                    bypass_email_verification: true,
                    override_user_id: None,
                    ip_address: TEST_IP,
                },
            )
            .await
            .expect("vote contention actor should be created");

            let rate_category =
                CategoryService::get_or_create(&ctx, created.site_id, &site_slug)
                    .await
                    .expect("vote contention rate category should be created");
            let mut category_model = rate_category.into_active_model();
            category_model.rating_enabled = Set(Some(true));
            category_model.rating_permission = Set(Some(String::from("registered")));
            category_model.rating_type = Set(Some(String::from("plus_minus")));
            let category = category_model
                .update(&transaction)
                .await
                .expect("vote contention rating settings should be stored");

            let page = PageService::create(
                &ctx,
                deepwell::services::page::CreatePage {
                    site_id: created.site_id,
                    wikitext: RATE_SOURCE.to_owned(),
                    title: String::from("Vote contention rate page"),
                    alt_title: None,
                    tags: Vec::new(),
                    slug: page_slug.clone(),
                    layout: None,
                    revision_comments: String::from(
                        "Create vote contention rate fixture",
                    ),
                    user_id: actor.user_id,
                    bypass_filter: true,
                    ip_address: TEST_IP,
                },
            )
            .await
            .expect("vote contention rate page should be created");
            PageRevisionService::rerender(
                &ctx,
                PageId {
                    site_id: created.site_id,
                    category_id: category.category_id,
                    page_id: page.page_id,
                },
                RerenderDepth::default(),
                RerenderType::Full,
            )
            .await
            .expect("vote contention rate page should render");

            let session_token = SessionService::create(
                &ctx,
                CreateSession {
                    user_id: actor.user_id,
                    ip_address: TEST_IP,
                    user_agent: String::from("vote contention RPC test"),
                    restricted: false,
                },
            )
            .await
            .expect("vote contention actor session should be created");

            (
                created.site_id,
                created.site_user_id,
                actor.user_id,
                page.page_id,
                page.slug,
                session_token,
            )
        };
        transaction
            .commit()
            .await
            .expect("vote contention fixture should commit");
        clear_job_queue(&mut rsmq).await;
        Self {
            state,
            redis_url,
            namespace,
            session_token,
            site_id,
            site_user_id,
            actor_user_id,
            page_id,
            page_slug,
        }
    }

    async fn cleanup(self) {
        let database_result = AssertUnwindSafe(self.cleanup_database())
            .catch_unwind()
            .await;
        let redis_result =
            AssertUnwindSafe(cleanup_namespace(&self.redis_url, &self.namespace))
                .catch_unwind()
                .await;
        let owned_redis_result = AssertUnwindSafe(self.cleanup_owned_redis_keys())
            .catch_unwind()
            .await;
        if let Err(payload) = database_result {
            std::panic::resume_unwind(payload);
        }
        if let Err(payload) = redis_result {
            std::panic::resume_unwind(payload);
        }
        if let Err(payload) = owned_redis_result {
            std::panic::resume_unwind(payload);
        }
    }

    async fn cleanup_database(&self) {
        let transaction = self
            .state
            .database
            .begin()
            .await
            .expect("vote contention cleanup transaction should begin");

        PageVoteTable::delete_many()
            .filter(page_vote::Column::PageId.eq(self.page_id))
            .exec(&transaction)
            .await
            .expect("owned vote contention votes should be removed");
        let owned_page = PageTable::find_by_id(self.page_id)
            .one(&transaction)
            .await
            .expect("owned vote contention page should be readable");
        if let Some(page) = owned_page {
            let mut model = page.into_active_model();
            model.latest_revision_id = Set(None);
            model
                .update(&transaction)
                .await
                .expect("owned vote contention page revision pointer should be cleared");
        }
        PageRevisionTable::delete_many()
            .filter(page_revision::Column::PageId.eq(self.page_id))
            .exec(&transaction)
            .await
            .expect("owned vote contention page revisions should be removed");
        PageTable::delete_many()
            .filter(page::Column::SiteId.eq(self.site_id))
            .exec(&transaction)
            .await
            .expect("owned vote contention pages should be removed");
        PageCategory::delete_many()
            .filter(page_category::Column::SiteId.eq(self.site_id))
            .exec(&transaction)
            .await
            .expect("owned vote contention categories should be removed");
        RolePermissionTable::delete_many()
            .filter(role_permission::Column::SiteId.eq(self.site_id))
            .exec(&transaction)
            .await
            .expect("owned vote contention permissions should be removed");
        RoleTable::delete_many()
            .filter(role::Column::SiteId.eq(self.site_id))
            .exec(&transaction)
            .await
            .expect("owned vote contention roles should be removed");
        RelationTable::delete_many()
            .filter(
                Condition::any()
                    .add(
                        Condition::all()
                            .add(relation::Column::DestType.eq(RelationObjectType::Site))
                            .add(relation::Column::DestId.eq(self.site_id)),
                    )
                    .add(
                        Condition::all()
                            .add(relation::Column::FromType.eq(RelationObjectType::User))
                            .add(relation::Column::FromId.eq(self.site_user_id)),
                    ),
            )
            .exec(&transaction)
            .await
            .expect("owned vote contention site-user relation should be removed");
        SessionTable::delete_many()
            .filter(session::Column::UserId.eq(self.actor_user_id))
            .exec(&transaction)
            .await
            .expect("owned vote contention actor sessions should be removed");
        AuditLog::delete_many()
            .filter(
                Condition::any()
                    .add(audit_log::Column::SiteId.eq(self.site_id))
                    .add(audit_log::Column::UserId.eq(self.actor_user_id)),
            )
            .exec(&transaction)
            .await
            .expect("owned vote contention audit rows should be removed");
        UserTable::delete_by_id(self.actor_user_id)
            .exec(&transaction)
            .await
            .expect("owned vote contention actor should be removed");
        UserTable::delete_by_id(self.site_user_id)
            .exec(&transaction)
            .await
            .expect("owned vote contention site user should be removed");
        SiteTable::delete_by_id(self.site_id)
            .exec(&transaction)
            .await
            .expect("owned vote contention site should be removed");
        KnownUserTable::delete_by_id(self.actor_user_id)
            .exec(&transaction)
            .await
            .expect("owned vote contention actor identity should be removed");
        KnownUserTable::delete_by_id(self.site_user_id)
            .exec(&transaction)
            .await
            .expect("owned vote contention site-user identity should be removed");
        transaction
            .commit()
            .await
            .expect("vote contention cleanup should commit");
    }

    async fn cleanup_owned_redis_keys(&self) {
        let public_cache_key = PublicContentCache::site_version_key(self.site_id);
        let permission_pattern = format!("permission:site:{}:*", self.site_id);
        let mut redis = self.state.redis.clone();
        let mut keys: Vec<String> = redis
            .keys(permission_pattern)
            .await
            .expect("owned vote contention permission keys should be listed");
        keys.push(public_cache_key);
        let _: usize = redis
            .del(keys)
            .await
            .expect("owned vote contention cache keys should be removed");
    }

    async fn current_vote_count(&self) -> u64 {
        let transaction = self
            .state
            .database
            .begin()
            .await
            .expect("vote count transaction should begin");
        let count = PageVoteTable::find()
            .filter(page_vote::Column::PageId.eq(self.page_id))
            .filter(page_vote::Column::DeletedAt.is_null())
            .count(&transaction)
            .await
            .expect("current vote count should be readable");
        transaction
            .rollback()
            .await
            .expect("vote count transaction should roll back");
        count
    }
}

async fn clear_job_queue(queue: &mut Rsmq) {
    while let Some(message) = queue
        .receive_message::<Vec<u8>>(JOB_QUEUE_NAME, None)
        .await
        .expect("vote contention queue should be readable")
    {
        queue
            .delete_message(JOB_QUEUE_NAME, &message.id)
            .await
            .expect("vote contention setup job should be removed");
    }
}

async fn rpc_request(
    client: &reqwest::Client,
    address: SocketAddr,
    session_token: Option<&str>,
    site_id: Option<i64>,
    page: Option<&str>,
    method: &str,
    params: JsonValue,
) -> JsonValue {
    let mut request = client
        .post(format!("http://{address}"))
        .bearer_auth(
            env::var("DEEPWELL_RPC_TOKEN").expect("test RPC token must be configured"),
        )
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1030,
            "method": method,
            "params": params,
        }));
    if let Some(session_token) = session_token {
        request = request.header("X-Deepwell-Session-Token", session_token);
    }
    if let Some(site_id) = site_id {
        request = request.header("X-Deepwell-Site-Id", site_id);
    }
    if let Some(page) = page {
        request = request.header("X-Deepwell-Page", page);
    }

    let response: JsonValue = request
        .send()
        .await
        .expect("public Deepwell request should complete")
        .json()
        .await
        .expect("public Deepwell response should be JSON");
    assert!(
        response.get("error").is_none(),
        "public Deepwell method {method} failed: {response}",
    );
    response
        .get("result")
        .cloned()
        .expect("public Deepwell response should contain a result")
}

fn score(output: &JsonValue) -> i64 {
    output["score"]
        .as_i64()
        .expect("vote output should carry an integer score")
}

fn contention_client() -> reqwest::Client {
    reqwest::Client::builder()
        .http1_only()
        .pool_max_idle_per_host(0)
        .build()
        .expect("vote contention client should build")
}

#[tokio::test]
async fn concurrent_vote_mutations_leave_one_current_vote_and_consistent_aggregate() {
    let fixture = VoteContentionFixture::new().await;
    let verification = AssertUnwindSafe(run_concurrent_vote_matrix(&fixture))
        .catch_unwind()
        .await;
    let cleanup = AssertUnwindSafe(fixture.cleanup()).catch_unwind().await;
    if let Err(payload) = verification {
        std::panic::resume_unwind(payload);
    }
    if let Err(payload) = cleanup {
        std::panic::resume_unwind(payload);
    }
}

async fn run_concurrent_vote_matrix(fixture: &VoteContentionFixture) {
    let (address, handle) = build_server_at(
        fixture.state.clone(),
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
    )
    .await
    .expect("public Deepwell server should start");
    let clients = [contention_client(), contention_client()];
    let site_id = fixture.site_id;
    let slug = fixture.page_slug.clone();

    let viewed = rpc_request(
        &clients[0],
        address,
        Some(&fixture.session_token),
        Some(site_id),
        Some(&slug),
        "page_view",
        json!({
            "site_id": site_id,
            "session_token": fixture.session_token,
            "route": {"slug": slug, "extra": ""},
            "locales": ["en-US", "en"],
        }),
    )
    .await;
    let rate_actions = viewed["data"]["rate_actions"]
        .as_object()
        .cloned()
        .expect("authenticated page view should expose the Rate sidecar");
    let revision_id = rate_actions["revision_id"]
        .as_i64()
        .expect("Rate sidecar should carry the current revision");
    let actions = rate_actions["actions"]
        .as_array()
        .cloned()
        .expect("Rate sidecar should carry typed actions");
    assert_eq!(actions.len(), 3);
    assert_eq!(actions[0]["value"], 1);
    assert_eq!(actions[1]["value"], -1);
    assert_eq!(actions[2]["type"], "rate-cancel");
    let activate = |action: &JsonValue| {
        json!({
            "page_id": fixture.page_id,
            "last_revision_id": revision_id,
            "action_index": action["index"],
            "action_fingerprint": action["fingerprint"],
            "value": 5,
            "score": 500,
            "user_id": -1,
            "site_id": -1,
        })
    };

    let first_votes = futures::future::join_all([
        rpc_request(
            &clients[0],
            address,
            Some(&fixture.session_token),
            Some(site_id),
            Some(&slug),
            "wikidot_legacy_rate",
            activate(&actions[0]),
        ),
        rpc_request(
            &clients[1],
            address,
            Some(&fixture.session_token),
            Some(site_id),
            Some(&slug),
            "wikidot_legacy_rate",
            activate(&actions[0]),
        ),
    ])
    .await;
    assert!(
        first_votes.iter().all(|output| score(output) == 1),
        "concurrent first votes must both settle at the committed winner: {first_votes:?}",
    );
    assert_eq!(
        fixture.current_vote_count().await,
        1,
        "concurrent first votes must leave exactly one current vote",
    );

    let changed = futures::future::join_all([
        rpc_request(
            &clients[0],
            address,
            Some(&fixture.session_token),
            Some(site_id),
            Some(&slug),
            "wikidot_legacy_rate",
            activate(&actions[1]),
        ),
        rpc_request(
            &clients[1],
            address,
            Some(&fixture.session_token),
            Some(site_id),
            Some(&slug),
            "wikidot_legacy_rate",
            activate(&actions[1]),
        ),
    ])
    .await;
    assert!(
        changed.iter().all(|output| score(output) == -1),
        "concurrent value changes must both settle at the committed winner: {changed:?}",
    );
    assert_eq!(
        fixture.current_vote_count().await,
        1,
        "concurrent value changes must leave exactly one current vote",
    );

    let canceled = futures::future::join_all([
        rpc_request(
            &clients[0],
            address,
            Some(&fixture.session_token),
            Some(site_id),
            Some(&slug),
            "wikidot_legacy_rate",
            activate(&actions[2]),
        ),
        rpc_request(
            &clients[1],
            address,
            Some(&fixture.session_token),
            Some(site_id),
            Some(&slug),
            "wikidot_legacy_rate",
            activate(&actions[2]),
        ),
    ])
    .await;
    assert!(
        canceled.iter().all(|output| score(output) == 0),
        "concurrent cancellation must both settle at zero: {canceled:?}",
    );
    assert_eq!(
        fixture.current_vote_count().await,
        0,
        "concurrent cancellation must leave no current vote",
    );

    handle.stop().expect("public Deepwell server should stop");
    handle.stopped().await;
}
