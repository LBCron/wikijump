/*
 * tests/page/page_move.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::*;
use deepwell::services::relation::{
    PageAttributionEntry, PageAttributionMetadata, SetPageAttributions,
};

async fn page_move_rpc_request(
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
            std::env::var("DEEPWELL_RPC_TOKEN")
                .expect("test RPC token must be configured"),
        )
        .json(&json!({
            "jsonrpc": "2.0",
            "id": 1,
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

    request
        .send()
        .await
        .expect("public page move RPC request should complete")
        .json()
        .await
        .expect("public page move RPC response should be JSON")
}

fn page_move_rpc_result(response: JsonValue, method: &str) -> JsonValue {
    assert!(
        response.get("error").is_none(),
        "public page move fixture method {method} failed: {response}",
    );
    response.get("result").cloned().unwrap_or(JsonValue::Null)
}

struct PageMoveRpcCleanup {
    site_id: Option<i64>,
    user_id: Option<i64>,
    session_token: Option<String>,
    page_ids: Vec<i64>,
    revision_ids: Vec<i64>,
    category_ids: Vec<i64>,
    owned_category_page_ids: Vec<i64>,
    relation_ids: Vec<i64>,
}

impl PageMoveRpcCleanup {
    fn new() -> Self {
        Self {
            site_id: None,
            user_id: None,
            session_token: None,
            page_ids: Vec::new(),
            revision_ids: Vec::new(),
            category_ids: Vec::new(),
            owned_category_page_ids: Vec::new(),
            relation_ids: Vec::new(),
        }
    }
}

async fn cleanup_page_move_rpc_fixture(
    state: &ServerState,
    cleanup: &PageMoveRpcCleanup,
) -> std::result::Result<(), String> {
    let Some(site_id) = cleanup.site_id else {
        return Ok(());
    };
    let transaction =
        state.database.begin().await.map_err(|error| {
            format!("page move cleanup transaction failed: {error:?}")
        })?;

    let mut category_ids = cleanup
        .category_ids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();
    for &page_id in &cleanup.owned_category_page_ids {
        if let Some(page) = PageTable::find_by_id(page_id)
            .one(&transaction)
            .await
            .map_err(|error| {
                format!("page move fixture page-category lookup failed: {error:?}")
            })?
        {
            category_ids.insert(page.page_category_id);
        }
    }

    let relation_ids = cleanup
        .relation_ids
        .iter()
        .copied()
        .collect::<BTreeSet<_>>();

    let mut text_hashes = BTreeSet::new();
    for &revision_id in &cleanup.revision_ids {
        if let Some(revision) = PageRevisionTable::find_by_id(revision_id)
            .one(&transaction)
            .await
            .map_err(|error| {
                format!("page move fixture revision lookup failed: {error:?}")
            })?
        {
            text_hashes.insert(revision.wikitext_hash);
            text_hashes.insert(revision.compiled_body_html_hash);
            text_hashes.extend(revision.compiled_body_styles_hash);
            text_hashes.extend(revision.compiled_top_bar_html_hash);
            text_hashes.extend(revision.compiled_side_bar_html_hash);
        }
    }

    for relation_id in relation_ids {
        transaction
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "DELETE FROM relation WHERE relation_id = $1",
                [Value::from(relation_id)],
            ))
            .await
            .map_err(|error| {
                format!("page move fixture relation cleanup failed: {error:?}")
            })?;
    }
    for &page_id in &cleanup.page_ids {
        let statements = [
            "DELETE FROM page_parent WHERE parent_page_id = $1 OR child_page_id = $1",
            "DELETE FROM page_connection WHERE from_page_id = $1 OR to_page_id = $1",
            "DELETE FROM page_connection_missing WHERE from_page_id = $1",
            "DELETE FROM page_link WHERE page_id = $1",
            "DELETE FROM page_lock WHERE page_id = $1",
            "DELETE FROM page_vote WHERE page_id = $1",
            "DELETE FROM text_block WHERE page_id = $1",
            "UPDATE page SET latest_revision_id = NULL WHERE page_id = $1",
            "DELETE FROM audit_log WHERE page_id = $1",
        ];
        for sql in statements {
            transaction
                .execute_raw(Statement::from_sql_and_values(
                    DatabaseBackend::Postgres,
                    sql,
                    [Value::from(page_id)],
                ))
                .await
                .map_err(|error| {
                    format!("page move fixture page cleanup failed: {error:?}")
                })?;
        }
    }
    for &revision_id in &cleanup.revision_ids {
        transaction
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "DELETE FROM page_revision WHERE revision_id = $1",
                [Value::from(revision_id)],
            ))
            .await
            .map_err(|error| {
                format!("page move fixture revision cleanup failed: {error:?}")
            })?;
    }
    for &page_id in &cleanup.page_ids {
        PageTable::delete_by_id(page_id)
            .exec(&transaction)
            .await
            .map_err(|error| {
                format!("page move fixture page deletion failed: {error:?}")
            })?;
    }
    for category_id in category_ids {
        PageCategoryTable::delete_by_id(category_id)
            .exec(&transaction)
            .await
            .map_err(|error| {
                format!("page move fixture category cleanup failed: {error:?}")
            })?;
    }
    if let Some(session_token) = &cleanup.session_token {
        SessionTable::delete_by_id(session_token)
            .exec(&transaction)
            .await
            .map_err(|error| {
                format!("page move fixture session cleanup failed: {error:?}")
            })?;
    }
    if let Some(user_id) = cleanup.user_id {
        let ctx = ServiceContext::new(state, &transaction);
        PermissionCache::invalidate_user(&ctx, site_id, user_id)
            .await
            .map_err(|error| {
                format!("page move fixture permission-cache cleanup failed: {error:?}")
            })?;
    }
    for hash in text_hashes {
        transaction
            .execute_raw(Statement::from_sql_and_values(
                DatabaseBackend::Postgres,
                "DELETE FROM text WHERE hash = $1 AND NOT EXISTS (SELECT 1 FROM page_revision WHERE wikitext_hash = text.hash OR compiled_body_html_hash = text.hash OR compiled_body_styles_hash = text.hash OR compiled_top_bar_html_hash = text.hash OR compiled_side_bar_html_hash = text.hash) AND NOT EXISTS (SELECT 1 FROM message_record WHERE wikitext_hash = text.hash OR compiled_hash = text.hash) AND NOT EXISTS (SELECT 1 FROM message_draft WHERE wikitext_hash = text.hash OR compiled_hash = text.hash) AND NOT EXISTS (SELECT 1 FROM forum_post_revision WHERE wikitext_hash = text.hash OR compiled_html_hash = text.hash)",
                [Value::from(hash)],
            ))
            .await
            .map_err(|error| {
                format!("page move fixture text cleanup failed: {error:?}")
            })?;
    }
    transaction
        .commit()
        .await
        .map_err(|error| format!("page move fixture cleanup commit failed: {error:?}"))
}

struct PageMoveRpcCreatePage<'a> {
    slug: &'a str,
    title: &'a str,
    wikitext: String,
    owns_category: bool,
}

async fn page_move_rpc_create_page(
    client: &reqwest::Client,
    address: SocketAddr,
    session_token: &str,
    user_id: i64,
    site_id: i64,
    request: PageMoveRpcCreatePage<'_>,
    cleanup: &mut PageMoveRpcCleanup,
) -> JsonValue {
    let PageMoveRpcCreatePage {
        slug,
        title,
        wikitext,
        owns_category,
    } = request;
    let created = page_move_rpc_result(
        page_move_rpc_request(
            client,
            address,
            Some(session_token),
            Some(site_id),
            Some(slug),
            "page_create",
            json!({
                "site_id": site_id,
                "wikitext": wikitext,
                "title": title,
                "alt_title": null,
                "slug": slug,
                "layout": null,
                "revision_comments": "create page move rollback fixture",
                "user_id": user_id,
                "ip_address": common::IP_ADDRESS,
            }),
        )
        .await,
        "page_create rollback fixture",
    );
    if let Some(page_id) = created["page_id"].as_i64() {
        cleanup.page_ids.push(page_id);
        if owns_category {
            cleanup.owned_category_page_ids.push(page_id);
        }
    }
    if let Some(revision_id) = created["revision_id"].as_i64() {
        cleanup.revision_ids.push(revision_id);
    }
    if owns_category {
        let page = page_move_rpc_get_page(client, address, site_id, slug).await;
        if let Some(category_id) = page["page_category_id"].as_i64()
            && !cleanup.category_ids.contains(&category_id)
        {
            cleanup.category_ids.push(category_id);
        }
    }
    created
}

async fn page_move_rpc_get_page(
    client: &reqwest::Client,
    address: SocketAddr,
    site_id: i64,
    slug: &str,
) -> JsonValue {
    page_move_rpc_result(
        page_move_rpc_request(
            client,
            address,
            None,
            Some(site_id),
            Some(slug),
            "page_get",
            json!({"site_id": site_id, "page": slug}),
        )
        .await,
        "page_get rollback fixture",
    )
}

#[tokio::test]
async fn page_move_renders_with_destination_category_context() {
    let mut runner = TestRunner::setup().await;

    const SITE_SLUG: &str = "test";
    const SOURCE_CATEGORY: &str = "fixture-page-move-render-source";
    const DESTINATION_CATEGORY: &str = "fixture-page-move-render-destination";
    const SOURCE_SLUG: &str = "fixture-page-move-render-source:target";
    const DESTINATION_SLUG: &str = "fixture-page-move-render-destination:target";
    const SOURCE_TOP_BAR_SLUG: &str = "fixture-page-move-render-nav:source-top";
    const DESTINATION_TOP_BAR_SLUG: &str = "fixture-page-move-render-nav:destination-top";
    const SOURCE_CONTEXT_SLUG: &str = "fixture-page-move-render-source:context-marker";
    const DESTINATION_CONTEXT_SLUG: &str =
        "fixture-page-move-render-destination:context-marker";
    const SOURCE_MARKER: &str = "PAGE_MOVE_SOURCE_TOP_BAR_MARKER";
    const DESTINATION_MARKER: &str = "PAGE_MOVE_DESTINATION_TOP_BAR_MARKER";

    let site = run_endpoint!(runner, site_get, json!({"site": SITE_SLUG}))
        .expect("seeded test site should exist")
        .site;
    let site_id = site.site_id;

    create_listpages_test_page(
        &mut runner,
        site_id,
        SOURCE_TOP_BAR_SLUG,
        "Page Move Source Top Bar",
        SOURCE_MARKER,
    )
    .await;
    create_listpages_test_page(
        &mut runner,
        site_id,
        DESTINATION_TOP_BAR_SLUG,
        "Page Move Destination Top Bar",
        DESTINATION_MARKER,
    )
    .await;
    create_listpages_test_page(
        &mut runner,
        site_id,
        SOURCE_CONTEXT_SLUG,
        "Page Move Source Context Marker",
        "Page move source context marker.",
    )
    .await;
    create_listpages_test_page(
        &mut runner,
        site_id,
        DESTINATION_CONTEXT_SLUG,
        "Page Move Destination Context Marker",
        "Page move destination context marker.",
    )
    .await;

    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        ..Default::default()
    });
    let source_category = run_endpoint!(
        runner,
        category_update,
        json!({
            "site": site_id,
            "category": SOURCE_CATEGORY,
            "user_id": ADMIN_USER_ID,
            "top_bar_page": SOURCE_TOP_BAR_SLUG,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    let destination_category = run_endpoint!(
        runner,
        category_update,
        json!({
            "site": site_id,
            "category": DESTINATION_CATEGORY,
            "user_id": ADMIN_USER_ID,
            "top_bar_page": DESTINATION_TOP_BAR_SLUG,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    set_mutation_request_context(
        &mut runner,
        ADMIN_USER_ID,
        site_id,
        Reference::Slug(Cow::Borrowed(SOURCE_SLUG)),
    );
    let page = run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": site_id,
            "wikitext": concat!(
                "[[module ListPages name=\"context-marker\" limit=\"1\" separate=\"no\" wrapper=\"no\"]]\n",
                "PAGE_MOVE_BODY_CONTEXT=%%fullname%%\n",
                "[[/module]]",
            ),
            "title": "Page Move Destination Render Context",
            "alt_title": null,
            "slug": SOURCE_SLUG,
            "layout": null,
            "revision_comments": "create page move render fixture",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    set_mutation_request_context(
        &mut runner,
        ADMIN_USER_ID,
        site_id,
        Reference::Id(page.page_id),
    );
    run_endpoint!(
        runner,
        page_move,
        json!({
            "site_id": site_id,
            "page": page.page_id,
            "new_slug": DESTINATION_SLUG,
            "last_revision_id": page.revision_id,
            "revision_comments": "move across render contexts",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    runner.set_request_context(RequestContext {
        site_id: Some(site_id),
        ..Default::default()
    });
    let view = run_endpoint!(
        runner,
        page_view,
        json!({
            "site_id": site_id,
            "session_token": null,
            "route": {
                "slug": DESTINATION_SLUG,
                "extra": "",
            },
            "locales": ["en-US", "en"],
        }),
    );
    let GetPageViewOutput::Found {
        page,
        compiled_body_html,
        compiled_top_bar_html,
        ..
    } = view
    else {
        panic!("moved destination should have a public page view: {view:?}");
    };
    let top_bar = compiled_top_bar_html.expect("moved page should have a top bar");

    assert_eq!(page.slug, DESTINATION_SLUG);
    assert_eq!(page.page_category_id, destination_category.category_id);
    assert_ne!(page.page_category_id, source_category.category_id);
    assert!(
        compiled_body_html.contains(DESTINATION_CONTEXT_SLUG),
        "move revision body should query the destination category context:\n{compiled_body_html}",
    );
    assert!(
        !compiled_body_html.contains(SOURCE_CONTEXT_SLUG),
        "move revision body must not retain the source category context:\n{compiled_body_html}",
    );
    assert!(
        top_bar.contains(DESTINATION_MARKER),
        "move revision should compile the destination category top bar:\n{top_bar}",
    );
    assert!(
        !top_bar.contains(SOURCE_MARKER),
        "move revision must not retain the source category top bar:\n{top_bar}",
    );
}

#[tokio::test]
async fn page_move_render_failure_rolls_back_destination_identity() {
    let run_id = cuid();
    let source_category = format!("fixture-page-move-rollback-source-{run_id}");
    let destination_category = format!("fixture-page-move-rollback-destination-{run_id}");
    let source_slug = format!("{source_category}:target");
    let destination_slug = format!("{destination_category}:target");
    let destination_template_slug = format!("{destination_category}:_template");
    let component_slug = format!("component:page-move-rollback-{run_id}");
    let join_slug = format!("system:join-{run_id}");
    let include_line = format!("[[include {component_slug}]]\n");
    let source_wikitext = include_line.repeat(200);
    let destination_template_wikitext =
        format!("{}%%content%%", include_line.repeat(100));

    let state = build_server_state_without_workers(
        Config::integration_testing(),
        Secrets::load(),
    )
    .await
    .expect("page move RPC state should build");
    let (address, handle) = build_server_at(
        state.clone(),
        SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
    )
    .await
    .expect("page move RPC server should start");
    let client = reqwest::Client::new();
    let mut cleanup = PageMoveRpcCleanup::new();

    let verification = AssertUnwindSafe(async {
        let site = page_move_rpc_result(
            page_move_rpc_request(
                &client,
                address,
                None,
                None,
                None,
                "site_get",
                json!({"site": "scpaiueouiuiuiui"}),
            )
            .await,
            "site_get",
        );
        let site_id = site["site_id"]
            .as_i64()
            .expect("seeded editable site ID should be present");
        cleanup.site_id = Some(site_id);
        let join_transaction = state
            .database
            .begin()
            .await
            .expect("page move Join fixture transaction should start");
        let join_page = {
            let join_context = ServiceContext::new(&state, &join_transaction);
            PageService::create(
                &join_context,
                CreatePage {
                    site_id,
                    wikitext: "[[module Join]]".to_owned(),
                    title: "Join this site".to_owned(),
                    alt_title: None,
                    tags: Vec::new(),
                    slug: join_slug.clone(),
                    layout: None,
                    revision_comments: "Create page move Join fixture".to_owned(),
                    user_id: SYSTEM_USER_ID,
                    bypass_filter: true,
                    ip_address: common::IP_ADDRESS,
                },
            )
            .await
            .expect("page move Join fixture should be created")
        };
        join_transaction
            .commit()
            .await
            .expect("page move Join fixture transaction should commit");
        cleanup.page_ids.push(join_page.page_id);
        cleanup.revision_ids.push(join_page.revision_id);
        let user = page_move_rpc_result(
            page_move_rpc_request(
                &client,
                address,
                None,
                None,
                None,
                "user_get",
                json!({"user": "guest"}),
            )
            .await,
            "user_get",
        );
        let user_id = user["user_id"]
            .as_i64()
            .expect("seeded guest user ID should be present");
        cleanup.user_id = Some(user_id);
        let login = page_move_rpc_result(
            page_move_rpc_request(
                &client,
                address,
                None,
                None,
                None,
                "login",
                json!({
                    "name_or_email": "guest",
                    "password": "guestuser123456",
                    "ip_address": common::IP_ADDRESS,
                    "user_agent": "page move transaction rollback test",
                }),
            )
            .await,
            "login",
        );
        let session_token = login["session_token"]
            .as_str()
            .expect("registered login should return a session token")
            .to_owned();
        cleanup.session_token = Some(session_token.clone());

        let membership = page_move_rpc_result(
            page_move_rpc_request(
                &client,
                address,
                None,
                Some(site_id),
                None,
                "member_get",
                json!({"site_id": site_id, "user_id": user_id}),
            )
            .await,
            "member_get",
        );
        assert_eq!(
            membership,
            JsonValue::Null,
            "seeded guest must begin outside the editable site",
        );
        let join_view = page_move_rpc_result(
            page_move_rpc_request(
                &client,
                address,
                Some(&session_token),
                Some(site_id),
                Some(&join_slug),
                "page_view",
                json!({
                    "site_id": site_id,
                    "session_token": session_token,
                    "route": {"slug": join_slug.clone(), "extra": ""},
                    "locales": ["en-US", "en"],
                }),
            )
            .await,
            "page_view system:join",
        );
        let join_action = join_view["data"]["membership_actions"]
            .as_array()
            .and_then(|actions| actions.first())
            .unwrap_or_else(|| {
                panic!(
                    "seeded editable site join page should expose one public action: {join_view}"
                )
            });
        let joined = page_move_rpc_result(
            page_move_rpc_request(
                &client,
                address,
                Some(&session_token),
                Some(site_id),
                Some(&join_slug),
                "membership_join",
                json!({
                    "page_id": join_action["page_id"],
                    "last_revision_id": join_action["revision_id"],
                    "action_index": join_action["index"],
                    "action_fingerprint": join_action["fingerprint"],
                    "ip_address": common::IP_ADDRESS,
                }),
            )
            .await,
            "membership_join",
        );
        assert_eq!(joined, "joined");
        let membership = page_move_rpc_result(
            page_move_rpc_request(
                &client,
                address,
                None,
                Some(site_id),
                None,
                "member_get",
                json!({"site_id": site_id, "user_id": user_id}),
            )
            .await,
            "member_get after join",
        );
        if let Some(relation_id) = membership["relation_id"].as_i64() {
            cleanup.relation_ids.push(relation_id);
        }
        assert_eq!(membership["dest_id"], site_id);
        assert_eq!(membership["from_id"], user_id);

        for category in [&source_category, &destination_category] {
            let existing = page_move_rpc_result(
                page_move_rpc_request(
                    &client,
                    address,
                    None,
                    Some(site_id),
                    None,
                    "category_get",
                    json!({"site": site_id, "category": category}),
                )
                .await,
                "category_get before rollback fixture create",
            );
            assert_eq!(
                existing,
                JsonValue::Null,
                "UUID-owned rollback fixture category must not pre-exist",
            );
        }

        page_move_rpc_create_page(
            &client,
            address,
            &session_token,
            user_id,
            site_id,
            PageMoveRpcCreatePage {
                slug: &component_slug,
                title: "Page Move Rollback Include Source",
                wikitext: format!("Page move rollback include source {run_id}."),
                owns_category: false,
            },
            &mut cleanup,
        )
        .await;
        page_move_rpc_create_page(
            &client,
            address,
            &session_token,
            user_id,
            site_id,
            PageMoveRpcCreatePage {
                slug: &destination_template_slug,
                title: "Page Move Rollback Destination Template",
                wikitext: destination_template_wikitext,
                owns_category: true,
            },
            &mut cleanup,
        )
        .await;
        let created = page_move_rpc_create_page(
            &client,
            address,
            &session_token,
            user_id,
            site_id,
            PageMoveRpcCreatePage {
                slug: &source_slug,
                title: "Page Move Rollback Source",
                wikitext: source_wikitext,
                owns_category: true,
            },
            &mut cleanup,
        )
        .await;
        let page_id = created["page_id"]
            .as_i64()
            .expect("page move rollback source page ID should be present");
        let revision_id = created["revision_id"]
            .as_i64()
            .expect("page move rollback source revision ID should be present");
        let page_id_header = page_id.to_string();
        // Member self-attribution through the RPC endpoint is denied since
        // C3W2L2-1 (attributions grant Rename + Delete), so the fixture seeds
        // the authorship the move needs directly.
        let attribution_transaction = state
            .database
            .begin()
            .await
            .expect("page move attribution fixture transaction should start");
        {
            let attribution_context =
                ServiceContext::new(&state, &attribution_transaction);
            let attributions = RelationService::set_page_attributions(
                &attribution_context,
                SetPageAttributions {
                    site_id,
                    page: Reference::Id(page_id),
                    updated_by: SYSTEM_USER_ID,
                    attributions: vec![PageAttributionEntry {
                        user_id,
                        metadata: PageAttributionMetadata {
                            attribution_type: PageAttributionKind::Author,
                            attribution_date: time::Date::from_calendar_date(
                                2026,
                                time::Month::August,
                                13,
                            )
                            .expect("page move attribution date should be valid"),
                        },
                    }],
                },
            )
            .await
            .expect("page move attribution fixture should be set");
            cleanup
                .relation_ids
                .extend(attributions.iter().map(|attribution| attribution.relation_id));
        }
        attribution_transaction
            .commit()
            .await
            .expect("page move attribution fixture transaction should commit");
        let before =
            page_move_rpc_get_page(&client, address, site_id, &source_slug).await;

        // Each fixture renders below the repository's 256-include ceiling. Applying the
        // destination template to the source revision crosses that ceiling inside
        // PageRevisionService::create, after PageService::move's early identity update.
        let failure = page_move_rpc_request(
            &client,
            address,
            Some(&session_token),
            Some(site_id),
            Some(&page_id_header),
            "page_move",
            json!({
                "site_id": site_id,
                "page": page_id,
                "new_slug": destination_slug,
                "last_revision_id": revision_id,
                "revision_comments": "force rollback after destination identity update",
                "user_id": user_id,
                "ip_address": common::IP_ADDRESS,
            }),
        )
        .await;
        assert!(failure.get("result").is_none());
        assert!(
            failure.get("error").is_some(),
            "registered page_move should return a public RPC error: {failure}",
        );
        assert_eq!(
            failure["error"]["data"]["code_trace"]
                .as_array()
                .and_then(|trace| trace.last())
                .and_then(JsonValue::as_i64),
            Some(i64::from(ErrorType::Render.code())),
            "page_move should fail with the public render classification: {failure}",
        );

        let after = page_move_rpc_get_page(&client, address, site_id, &source_slug).await;
        assert_eq!(after["page_id"], before["page_id"]);
        assert_eq!(after["slug"], before["slug"]);
        assert_eq!(after["page_category_id"], before["page_category_id"]);
        assert_eq!(after["revision_id"], before["revision_id"]);

        let destination =
            page_move_rpc_get_page(&client, address, site_id, &destination_slug).await;
        assert_eq!(destination, JsonValue::Null);
    })
    .catch_unwind()
    .await;

    let cleanup_result = cleanup_page_move_rpc_fixture(&state, &cleanup).await;
    let shutdown = AssertUnwindSafe(async {
        handle.stop().expect("page move RPC server should stop");
        handle.stopped().await;
    })
    .catch_unwind()
    .await;
    if let Err(payload) = verification {
        if let Err(error) = &cleanup_result {
            eprintln!("page move RPC fixture cleanup after panic failed: {error}");
        }
        if shutdown.is_err() {
            eprintln!("page move RPC server shutdown after panic failed");
        }
        resume_unwind(payload);
    }
    if let Err(payload) = shutdown {
        if let Err(error) = &cleanup_result {
            eprintln!(
                "page move RPC fixture cleanup after shutdown panic failed: {error}"
            );
        }
        resume_unwind(payload);
    }
    cleanup_result.expect("page move RPC fixture cleanup should succeed");
}

#[tokio::test]
async fn basic_move() {
    let mut runner = TestRunner::setup().await;

    const SITE_SLUG: &str = "test";
    const PAGE_SLUG_1: &str = "alpha";
    const PAGE_SLUG_2: &str = "beta";

    // Get site

    let output = run_endpoint!(runner, site_get, json!({"site": SITE_SLUG}))
        .expect("Seeded site not found");

    let site_id = output.site.site_id;
    assert_eq!(output.site.slug, SITE_SLUG, "Site slug doesn't match");

    // Set request context to populate params for the internal permission check.
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(PAGE_SLUG_1.into())),
    });

    // Create page

    let output = run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": site_id,
            "wikitext": "PAGE APPLE",
            "title": "Alpha 1",
            "alt_title": null,
            "slug": PAGE_SLUG_1,
            "layout": null,
            "revision_comments": "Created page",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    let page_id = output.page_id;
    let revision_id = output.revision_id;
    assert_eq!(output.slug, PAGE_SLUG_1);
    assert!(output.parser_errors.is_empty());

    // Page edit (success)

    let output = run_endpoint!(
        runner,
        page_edit,
        json!({
            "site_id": site_id,
            "page": page_id,
            "last_revision_id": revision_id,
            "revision_comments": "Edited page 1",
            "user_id": ADMIN_USER_ID,
            "title": "List of Things",
            "ip_address": common::IP_ADDRESS,
        }),
    )
    .expect("No revision created");
    assert_eq!(output.revision_number, 1);
    assert!(output.revision_id > revision_id);
    let revision_id = output.revision_id;

    // Move page

    let output = run_endpoint!(
        runner,
        page_move,
        json!({
            "site_id": site_id,
            "page": PAGE_SLUG_1,
            "new_slug": PAGE_SLUG_2,
            "last_revision_id": revision_id,
            "revision_comments": "move",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(output.revision_number, 2);
    assert!(output.revision_id > revision_id);
    let revision_id = output.revision_id;

    // Get page (by ID)

    let page = run_endpoint!(
        runner,
        page_get,
        json!({
            "site_id": site_id,
            "page": page_id,
        }),
    )
    .expect("Cannot find page");
    assert_eq!(page.site_id, site_id);
    assert_eq!(page.page_id, page_id);
    assert_eq!(page.slug, PAGE_SLUG_2);
    assert_eq!(page.revision_id, revision_id);
    assert_eq!(page.revision_number, 2);
    assert_eq!(page.revision_type, PageRevisionType::Move);
    assert_eq!(page.revision_user_id, ADMIN_USER_ID);
    assert_eq!(page.page_category_slug, "_default");

    // Page edit (failure)

    let error = run_endpoint_err!(
        runner,
        page_edit,
        json!({
            "site_id": site_id,
            "page": PAGE_SLUG_1,
            "last_revision_id": revision_id,
            "revision_comments": "Update title",
            "user_id": ADMIN_USER_ID,
            "title": "Beta 2",
            "wikitext": "PAGE BANANA",
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(error, ErrorType::PageNotFound);

    // Page edit (success)
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(PAGE_SLUG_2.into())),
    });

    let edit_lease_23 = common::acquire_page_edit_lease(
        &runner,
        site_id,
        &serde_json::json!(PAGE_SLUG_2),
        ADMIN_USER_ID,
    )
    .await;
    let output = run_endpoint!(
        runner,
        page_edit,
        json!({
            "lease": edit_lease_23,
            "site_id": site_id,
            "page": PAGE_SLUG_2,
            "last_revision_id": revision_id,
            "revision_comments": "Update title",
            "user_id": ADMIN_USER_ID,
            "title": "Beta 2",
            "wikitext": "PAGE BANANA",
            "ip_address": common::IP_ADDRESS,
        }),
    )
    .expect("No revision created");
    assert_eq!(output.revision_number, 3);
    assert!(output.revision_id > revision_id);
}

// TODO add more cases here
// e.g. create page in non-default category, move to a new category
//      create page, edit, delete, edit (fail), restore, edit (success), restore (fail)
//      create two pages, edit, make sure revision numbers are consistent
//      create page, have a variety of different edits, list revisions and check info
//      create page, edit with outdated revision, revision for another page, negative revision
//      create page, get with details (each permutation), check values are correct
//      create page, add revisions, then go back and hide revision data, then request that data (should be omitted)
//      etc.
