/*
 * tests/members_freshness.rs
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

use common::TestRunner;
use cuid2::cuid;
use deepwell::constants::ADMIN_USER_ID;
use deepwell::services::RequestContext;
use deepwell::services::view::GetPageViewOutput;
use deepwell::types::Reference;
use serde_json::json;
use std::borrow::Cow;

fn mutation_context(runner: &mut TestRunner, site_id: i64, page: &str) {
    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(Cow::Owned(page.to_owned()))),
        ..Default::default()
    });
}

async fn page_body(
    runner: &mut TestRunner,
    site_id: i64,
    slug: &str,
    session_token: Option<&str>,
) -> String {
    runner.set_request_context(RequestContext {
        site_id: Some(site_id),
        ..Default::default()
    });
    let view = run_endpoint!(
        runner,
        page_view,
        json!({
            "site_id": site_id,
            "session_token": session_token,
            "route": {"slug": slug, "extra": ""},
            "locales": ["en-US", "en"],
        }),
    );
    match view {
        GetPageViewOutput::Found {
            compiled_body_html, ..
        } => compiled_body_html,
        other => panic!("expected a found page view for {slug}, got {other:?}"),
    }
}

async fn stored_body(runner: &TestRunner, site_id: i64, slug: &str) -> Option<String> {
    run_endpoint!(runner, page_get, json!({"site_id": site_id, "page": slug}))
        .expect("saved Members fixture should exist")
        .compiled_body_html
}

#[tokio::test]
async fn saved_members_pages_refresh_after_membership_changes_without_mutating_revision_html()
 {
    let run_id = cuid();
    let direct_slug = format!("members-freshness-direct-{run_id}:holder");
    let template_category = format!("members-freshness-template-{run_id}");
    let template_slug = format!("{template_category}:_template");
    let templated_slug = format!("{template_category}:holder");
    let member_name = format!("Fresh Members User {run_id}");
    let member_email = format!("fresh-members-{run_id}@example.invalid");
    let password = "fresh-members-password";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scpaiueouiuiuiui"}))
        .expect("the editable local site should exist")
        .site;
    let site_id = site.site_id;

    mutation_context(&mut runner, site_id, &template_slug);
    run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": site_id,
            "wikitext": "TEMPLATE_START\n[[module Members]]\nTEMPLATE_END\n%%content%%",
            "title": "Members freshness template",
            "alt_title": null,
            "slug": template_slug,
            "layout": "wikidot",
            "revision_comments": "create Members freshness template",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    mutation_context(&mut runner, site_id, &direct_slug);
    run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": site_id,
            "wikitext": concat!(
                "LIVE_START\n[[module Members]]\nLIVE_END\n",
                "[[code]]\n[[module Members]]\n[[/code]]\n",
                "<pre>[[module Members]]</pre>\n",
                "INVALID_START\n[[module Members group=\"owners\"]]\nINVALID_END",
            ),
            "title": "Direct Members freshness",
            "alt_title": null,
            "slug": direct_slug,
            "layout": "wikidot",
            "revision_comments": "create direct Members freshness page",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    mutation_context(&mut runner, site_id, &templated_slug);
    run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": site_id,
            "wikitext": "templated body",
            "title": "Templated Members freshness",
            "alt_title": null,
            "slug": templated_slug,
            "layout": "wikidot",
            "revision_comments": "create templated Members freshness page",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    let stored_before = [
        stored_body(&runner, site_id, &direct_slug).await,
        stored_body(&runner, site_id, &templated_slug).await,
    ];
    assert!(
        stored_before
            .iter()
            .all(|html| !html.as_deref().unwrap_or_default().contains(&member_name)),
    );

    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        ..Default::default()
    });
    let user = run_endpoint!(
        runner,
        user_create,
        json!({
            "user_type": "regular",
            "name": member_name,
            "email": member_email,
            "locales": ["en"],
            "password": password,
            "bypass_filter": true,
            "bypass_email_verification": true,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    runner.set_request_context(RequestContext::default());
    let login = run_endpoint!(
        runner,
        auth_login,
        json!({
            "name_or_email": user.slug,
            "password": password,
            "ip_address": common::IP_ADDRESS,
            "user_agent": "Members saved-page freshness test",
        }),
    );

    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        ..Default::default()
    });
    run_endpoint!(
        runner,
        membership_set,
        json!({
            "site_id": site_id,
            "user_id": user.user_id,
            "metadata": {
                "accepted": {"cause": "accepted", "user_id": ADMIN_USER_ID},
            },
            "created_by": ADMIN_USER_ID,

            "ip_address": common::IP_ADDRESS,
        }),
    );

    let stored_after = [
        stored_body(&runner, site_id, &direct_slug).await,
        stored_body(&runner, site_id, &templated_slug).await,
    ];
    assert_eq!(
        stored_after, stored_before,
        "membership mutation must not rewrite stored revision HTML",
    );

    for (actor, session_token) in [
        ("anonymous", None),
        ("authenticated", Some(login.session_token.as_str())),
    ] {
        for slug in [&direct_slug, &templated_slug] {
            let html = page_body(&mut runner, site_id, slug, session_token).await;
            assert!(
                html.contains(&member_name),
                "{actor} view must render current Members data for {slug}:\n{html}",
            );
            if slug == &direct_slug {
                assert_eq!(
                    html.matches(&member_name).count(),
                    2,
                    "live executes both the bare module and the module whose unknown group value is ignored, while code and pre forms stay literal:\n{html}",
                );
                assert!(
                    !html.contains("No such module"),
                    "an unknown Members group value is ignored instead of failing closed:\n{html}",
                );
            }
        }
    }
}

#[tokio::test]
async fn imported_members_sources_preserve_runtime_cache_boundaries() {
    let run_id = cuid();
    let page_id_base = rand::random_range(1_700_000_000_i64..1_799_999_997_i64);
    let revision_id_base = rand::random_range(1_800_000_000_i64..1_899_999_997_i64);

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("the seeded test site should exist")
        .site;
    for (offset, (label, source, expects_cache_key)) in [
        ("executable", "[[module Members]]", false),
        ("literal", "[[code]]\n[[module Members]]\n[[/code]]", true),
        ("inline", "[[module Members]]x[[/module]]", true),
        (
            "ignored-argument",
            "[[module Members group=\"owners\"]]",
            false,
        ),
    ]
    .into_iter()
    .enumerate()
    {
        let offset = i64::try_from(offset).expect("four cache fixtures fit i64");
        let page_id = page_id_base + offset;
        let revision_id = revision_id_base + offset;
        let slug = format!("members-import-cache-{run_id}:{label}");
        runner.set_request_context(RequestContext {
            user_id: Some(ADMIN_USER_ID),
            site_id: Some(site.site_id),
            ..Default::default()
        });
        run_endpoint!(
            runner,
            import_wikidot_page,
            json!({
                "page_id": page_id,
                "site_id": site.site_id,
                "created_at": "1970-01-01T00:00:00Z",
                "slug": slug,
                "locked": false,
                "discussion_thread_id": null,
                "ip_address": common::IP_ADDRESS,
            }),
        );
        run_endpoint!(
            runner,
            import_wikidot_page_revision,
            json!({
                "revision_id": revision_id,
                "revision_type": "create",
                "created_at": time::OffsetDateTime::UNIX_EPOCH,
                "updated_at": null,
                "revision_number": 0,
                "page_id": page_id,
                "site_id": site.site_id,
                "user_id": ADMIN_USER_ID,
                "wikitext": source,
                "comments": format!("import {label} Members cache fixture"),
                "title": format!("Imported {label} Members cache fixture"),
                "slug": slug,
                "tags": [],
            }),
        );

        runner.set_request_context(RequestContext {
            site_id: Some(site.site_id),
            ..Default::default()
        });
        let metadata = run_endpoint!(
            runner,
            article_view_cache_metadata,
            json!({
                "site_id": site.site_id,
                "session_token": null,
                "route": {"slug": slug, "extra": ""},
                "locales": ["en-US", "en"],
            }),
        );
        assert_eq!(
            metadata.article_page_cache_key.is_some(),
            expects_cache_key,
            "{label} Members imported cache eligibility must follow runtime executability",
        );
    }
}
