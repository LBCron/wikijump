/*
 * tests/cycle3_f3_tombstone_parents.rs
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

// Regression test for C3W2L2-5: deleting a page must not irreversibly wipe
// its parent graph; restoring the page must bring the relations back.

#[macro_use]
mod common;

use self::common::TestRunner;
use cuid2::cuid;
use deepwell::constants::ADMIN_USER_ID;
use deepwell::services::PageService;
use deepwell::services::RequestContext;
use deepwell::services::page::CreatePage;
use deepwell::services::parent::{ParentDescription, ParentService};
use deepwell::types::Reference;
use serde_json::json;

async fn create_page(runner: &TestRunner, site_id: i64, slug: String) -> (i64, i64) {
    let output = PageService::create(
        runner.context(),
        CreatePage {
            site_id,
            wikitext: String::from("Tombstone parent fixture."),
            title: String::from("Tombstone Parent Fixture"),
            alt_title: None,
            tags: Vec::new(),
            slug,
            layout: None,
            revision_comments: String::from("create tombstone parent fixture"),
            user_id: ADMIN_USER_ID,
            bypass_filter: true,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("failed to create fixture page");
    (output.page_id, output.revision_id)
}

async fn link_parent(runner: &TestRunner, site_id: i64, parent_id: i64, child_id: i64) {
    ParentService::create(
        runner.context(),
        ParentDescription {
            site_id,
            parent: Reference::Id(parent_id),
            child: Reference::Id(child_id),
        },
    )
    .await
    .expect("failed to link parent and child");
}

#[tokio::test]
async fn undelete_restores_parent_graph() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("seeded test site should exist")
        .site;
    let tag = cuid();
    let (parent_id, _) =
        create_page(&runner, site.site_id, format!("tomb-parent-{tag}")).await;
    let (middle_id, middle_revision_id) =
        create_page(&runner, site.site_id, format!("tomb-middle-{tag}")).await;
    let (child_id, _) =
        create_page(&runner, site.site_id, format!("tomb-child-{tag}")).await;
    link_parent(&runner, site.site_id, parent_id, middle_id).await;
    link_parent(&runner, site.site_id, middle_id, child_id).await;

    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site.site_id),
        ..Default::default()
    });
    run_endpoint!(
        runner,
        page_delete,
        json!({
            "site_id": site.site_id,
            "page": middle_id,
            "last_revision_id": middle_revision_id,
            "revision_comments": "delete the middle of the chain",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    // While deleted, the page stays out of its neighbours' listings.
    let siblings = ParentService::get_children(
        runner.context(),
        site.site_id,
        Reference::Id(parent_id),
    )
    .await
    .expect("parent children should list");
    assert!(
        siblings.iter().all(|edge| edge.child_page_id != middle_id),
        "deleted page must be hidden from its parent's children",
    );
    let grown = ParentService::get_parents(
        runner.context(),
        site.site_id,
        Reference::Id(child_id),
    )
    .await
    .expect("child parents should list");
    assert!(
        grown.iter().all(|edge| edge.parent_page_id != middle_id),
        "deleted page must be hidden from its child's parents",
    );

    run_endpoint!(
        runner,
        page_restore,
        json!({
            "site_id": site.site_id,
            "page_id": middle_id,
            "revision_comments": "restore the middle of the chain",
            "user_id": ADMIN_USER_ID,
            "slug": null,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    // Undelete fully undoes delete: both directions of the graph come back.
    let parents = ParentService::get_parents(
        runner.context(),
        site.site_id,
        Reference::Id(middle_id),
    )
    .await
    .expect("restored parents should list");
    assert!(
        parents.iter().any(|edge| edge.parent_page_id == parent_id),
        "restored page must regain its parent",
    );
    let children = ParentService::get_children(
        runner.context(),
        site.site_id,
        Reference::Id(middle_id),
    )
    .await
    .expect("restored children should list");
    assert!(
        children.iter().any(|edge| edge.child_page_id == child_id),
        "restored page must regain its child",
    );
    let siblings = ParentService::get_children(
        runner.context(),
        site.site_id,
        Reference::Id(parent_id),
    )
    .await
    .expect("parent children should list after restore");
    assert!(
        siblings.iter().any(|edge| edge.child_page_id == middle_id),
        "parent must list the restored page as a child again",
    );
    let grown = ParentService::get_parents(
        runner.context(),
        site.site_id,
        Reference::Id(child_id),
    )
    .await
    .expect("child parents should list after restore");
    assert!(
        grown.iter().any(|edge| edge.parent_page_id == middle_id),
        "child must list the restored page as a parent again",
    );
}
