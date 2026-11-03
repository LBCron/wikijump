/*
 * tests/authoring_boundaries.rs
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
use deepwell::constants::{ADMIN_USER_ID, SYSTEM_USER_ID};
use deepwell::error::ErrorType;
use deepwell::models::page::Entity as PageTable;
use deepwell::services::category::CategoryService;
use deepwell::services::permission::PermissionService;
use deepwell::services::role::{
    GrantUserRoleInput, InternalCreateRoleInput, RoleService, UpdateRolePermissionsInput,
};
use deepwell::services::view::{GetArticleViewOutput, GetPageViewOutput};
use deepwell::services::{RequestContext, SiteService};
use deepwell::types::{Action, Permission, Reference, Resource};
use sea_orm::{
    ActiveModelTrait, ConnectionTrait, EntityTrait, IntoActiveModel, Set, Statement,
};
use serde_json::json;
use std::borrow::Cow;
use time::OffsetDateTime;

fn set_request_context(
    runner: &mut TestRunner,
    user_id: Option<i64>,
    site_id: i64,
    page: Reference<'static>,
) {
    runner.set_request_context(RequestContext {
        session: None,
        user_id,
        site_id: Some(site_id),
        page_reference: Some(page),
    });
}

async fn create_page(
    runner: &mut TestRunner,
    site_id: i64,
    slug: &str,
    title: &str,
    wikitext: &str,
) -> (i64, i64) {
    set_request_context(
        runner,
        Some(ADMIN_USER_ID),
        site_id,
        Reference::Slug(Cow::Owned(slug.to_owned())),
    );
    let created = run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": site_id,
            "wikitext": wikitext,
            "title": title,
            "alt_title": null,
            "slug": slug,
            "layout": "wikidot",
            "revision_comments": "create issue 1063 boundary fixture",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    (created.page_id, created.revision_id)
}

async fn edit_page(
    runner: &mut TestRunner,
    site_id: i64,
    page_id: i64,
    last_revision_id: i64,
    wikitext: String,
) -> (i64, i32) {
    set_request_context(runner, Some(ADMIN_USER_ID), site_id, Reference::Id(page_id));
    let edit_lease_1 = common::acquire_page_edit_lease(
        runner,
        site_id,
        &serde_json::json!(page_id),
        ADMIN_USER_ID,
    )
    .await;
    let edited = run_endpoint!(
        runner,
        page_edit,
        json!({
            "lease": edit_lease_1,
            "site_id": site_id,
            "page": page_id,
            "last_revision_id": last_revision_id,
            "revision_comments": "edit issue 1063 boundary fixture",
            "user_id": ADMIN_USER_ID,
            "wikitext": wikitext,
            "ip_address": common::IP_ADDRESS,
        }),
    )
    .expect("authoring boundary edit should create a revision");
    (edited.revision_id, edited.revision_number)
}

async fn make_category_admin_only(
    runner: &TestRunner,
    site_id: i64,
    category_slug: &str,
) {
    let category_id =
        CategoryService::get_or_create(runner.context(), site_id, category_slug)
            .await
            .expect("private diff category should be created")
            .category_id;
    let role = RoleService::create(
        runner.context(),
        InternalCreateRoleInput {
            site_id,
            name: format!("{category_slug}-viewer"),
            description: None,
            is_virtual: false,
            parent_role_id: None,
            creating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("private diff role should be created");
    PermissionService::update_permissions_for_role(
        runner.context(),
        UpdateRolePermissionsInput {
            site_id,
            role_reference: Reference::Id(role.role_id),
            new_permissions: vec![Permission {
                resource_type: Resource::Page,
                resource_category: Some(Reference::Id(category_id)),
                action: Action::View,
            }],
            cascade_removals: false,
            updating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("private diff role permissions should be updated");
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
    .expect("admin should receive the private diff role");
}

#[tokio::test]
async fn revision_diff_fails_closed_across_every_source_boundary() {
    const SITE_SLUG: &str = "scpaiueouiuiuiui";
    const PAGE_SLUG: &str = "authoring-diff-boundary";
    const PRIVATE_SLUG: &str = "authoring-diff-private:hidden";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": SITE_SLUG}))
        .expect("editable authoring site should exist")
        .site;
    let site_id = site.site_id;
    let (page_id, revision_0_id) = create_page(
        &mut runner,
        site_id,
        PAGE_SLUG,
        "Authoring diff boundary",
        "alpha\nold <script>secret()</script>\nomega",
    )
    .await;
    let (revision_1_id, revision_1_number) = edit_page(
        &mut runner,
        site_id,
        page_id,
        revision_0_id,
        "alpha\nnew & safe\nomega".to_owned(),
    )
    .await;

    let (other_page_id, _) = create_page(
        &mut runner,
        site_id,
        "authoring-diff-other-page",
        "Other diff page",
        "other source",
    )
    .await;
    let other_page = run_endpoint!(
        runner,
        page_revision_diff,
        json!({
            "site_id": site_id,
            "page_id": other_page_id,
            "from_revision_number": 0,
            "to_revision_number": revision_1_number,
        }),
    );
    assert!(
        other_page.is_none(),
        "A1063_DIFF_ANOTHER_PAGE: revision numbers must not escape their page tuple",
    );

    let equal = run_endpoint!(
        runner,
        page_revision_diff,
        json!({
            "site_id": site_id,
            "page_id": page_id,
            "from_revision_number": revision_1_number,
            "to_revision_number": revision_1_number,
        }),
    )
    .expect("A1063_DIFF_EQUAL_PAIR: an equal visible pair should exist");
    assert!(equal.lines.iter().all(|line| {
        serde_json::to_value(line)
            .expect("diff line should serialize")
            .get("kind")
            == Some(&json!("unchanged"))
    }));

    let reversed = run_endpoint!(
        runner,
        page_revision_diff,
        json!({
            "site_id": site_id,
            "page_id": page_id,
            "from_revision_number": revision_1_number,
            "to_revision_number": 0,
        }),
    )
    .expect("A1063_DIFF_REVERSED_PAIR: a reversed visible pair should exist");
    let reversed_json =
        serde_json::to_value(reversed).expect("reversed diff should serialize");
    assert!(reversed_json["lines"].as_array().is_some_and(|lines| {
        lines.contains(&json!({"kind": "removed", "text": "new & safe"}))
            && lines.contains(&json!({
                "kind": "added",
                "text": "old <script>secret()</script>"
            }))
    }));

    let long_line = "x".repeat(8_192);
    let (revision_2_id, revision_2_number) = edit_page(
        &mut runner,
        site_id,
        page_id,
        revision_1_id,
        format!("alpha\n{long_line}\nomega"),
    )
    .await;
    let long = run_endpoint!(
        runner,
        page_revision_diff,
        json!({
            "site_id": site_id,
            "page_id": page_id,
            "from_revision_number": revision_1_number,
            "to_revision_number": revision_2_number,
        }),
    )
    .expect("A1063_DIFF_LONG_LINE: a bounded long line should remain typed text");
    assert!(long.lines.iter().any(|line| line.text == long_line));

    let over_budget_from = (0..2_001)
        .map(|index| format!("left-{index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let (revision_3_id, revision_3_number) = edit_page(
        &mut runner,
        site_id,
        page_id,
        revision_2_id,
        over_budget_from,
    )
    .await;
    let over_budget_to = (0..2_001)
        .map(|index| format!("right-{index}"))
        .collect::<Vec<_>>()
        .join("\n");
    let (_, revision_4_number) =
        edit_page(&mut runner, site_id, page_id, revision_3_id, over_budget_to).await;
    let over_budget = run_endpoint_err!(
        runner,
        page_revision_diff,
        json!({
            "site_id": site_id,
            "page_id": page_id,
            "from_revision_number": revision_3_number,
            "to_revision_number": revision_4_number,
        }),
    );
    assert_contains_error!(over_budget, ErrorType::BadRequest);

    let other_site = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("second seeded site should exist")
        .site;
    set_request_context(
        &mut runner,
        Some(ADMIN_USER_ID),
        other_site.site_id,
        Reference::Id(page_id),
    );
    let other_site_error = run_endpoint_err!(
        runner,
        page_revision_diff,
        json!({
            "site_id": other_site.site_id,
            "page_id": page_id,
            "from_revision_number": 0,
            "to_revision_number": 1,
        }),
    );
    assert_contains_error!(other_site_error, ErrorType::PageRevision);

    make_category_admin_only(&runner, site_id, "authoring-diff-private").await;
    let (private_page_id, private_revision_0_id) = create_page(
        &mut runner,
        site_id,
        PRIVATE_SLUG,
        "Private diff source",
        "private old source",
    )
    .await;
    edit_page(
        &mut runner,
        site_id,
        private_page_id,
        private_revision_0_id,
        "private new source".to_owned(),
    )
    .await;
    set_request_context(&mut runner, None, site_id, Reference::Id(private_page_id));
    let unauthorized = run_endpoint_err!(
        runner,
        page_revision_diff,
        json!({
            "site_id": site_id,
            "page_id": private_page_id,
            "from_revision_number": 0,
            "to_revision_number": 1,
        }),
    );
    assert_contains_error!(unauthorized, ErrorType::PermissionDenied);

    let page = PageTable::find_by_id(page_id)
        .one(runner.context().transaction())
        .await
        .expect("diff page lookup should succeed")
        .expect("diff page should exist");
    let mut page = page.into_active_model();
    page.deleted_at = Set(Some(OffsetDateTime::now_utc()));
    page.update(runner.context().transaction())
        .await
        .expect("diff page should be soft-deleted");
    set_request_context(
        &mut runner,
        Some(ADMIN_USER_ID),
        site_id,
        Reference::Id(page_id),
    );
    let deleted = run_endpoint_err!(
        runner,
        page_revision_diff,
        json!({
            "site_id": site_id,
            "page_id": page_id,
            "from_revision_number": 0,
            "to_revision_number": 1,
        }),
    );
    assert_contains_error!(deleted, ErrorType::PageRevision);
}

async fn create_imported_page(
    runner: &mut TestRunner,
    site_id: i64,
    category_id: i64,
    slug: &str,
    title: &str,
) -> i64 {
    let (page_id, _) = create_page(
        runner,
        site_id,
        slug,
        title,
        "Imported breadcrumb boundary fixture",
    )
    .await;
    let page = PageTable::find_by_id(page_id)
        .one(runner.context().transaction())
        .await
        .expect("breadcrumb page lookup should succeed")
        .expect("breadcrumb page should exist");
    let mut page = page.into_active_model();
    page.page_category_id = Set(category_id);
    page.from_wikidot = Set(true);
    page.update(runner.context().transaction())
        .await
        .expect("breadcrumb page should become imported");
    page_id
}

async fn article_breadcrumbs(
    runner: &mut TestRunner,
    site_id: i64,
    slug: &str,
) -> Vec<(String, String)> {
    set_request_context(
        runner,
        None,
        site_id,
        Reference::Slug(Cow::Owned(slug.to_owned())),
    );
    let article: GetArticleViewOutput = run_endpoint!(
        runner,
        article_view,
        json!({
            "site_id": site_id,
            "session_token": null,
            "route": {"slug": slug, "extra": ""},
            "locales": ["en-US", "en"],
        }),
    );
    match article.page {
        GetPageViewOutput::Found {
            wikidot_breadcrumbs,
            ..
        } => wikidot_breadcrumbs
            .into_iter()
            .map(|breadcrumb| (breadcrumb.slug, breadcrumb.title))
            .collect(),
        other => panic!("expected imported breadcrumb article, got {other:?}"),
    }
}

#[tokio::test]
async fn imported_breadcrumbs_fail_closed_at_relation_boundaries() {
    const IMPORT_RUN_ID: i64 = 7_700_463;
    const NONE_SLUG: &str = "breadcrumb-boundary:none";
    const MISSING_SLUG: &str = "breadcrumb-boundary:missing";
    const CYCLE_A_SLUG: &str = "breadcrumb-boundary:cycle-a";
    const CYCLE_B_SLUG: &str = "breadcrumb-boundary:cycle-b";
    const RENAMED_PARENT_SOURCE_SLUG: &str = "breadcrumb-boundary:rename-parent";
    const RENAMED_PARENT_LOCAL_SLUG: &str = "breadcrumb-boundary:renamed-locally";
    const RENAMED_CHILD_SLUG: &str = "breadcrumb-boundary:rename-child";

    let mut runner = TestRunner::setup().await;
    let site = SiteService::get(runner.context(), Reference::Slug(Cow::Borrowed("test")))
        .await
        .expect("seeded test site should exist");
    let category = CategoryService::get(
        runner.context(),
        site.site_id,
        Reference::Slug(Cow::Borrowed("_default")),
    )
    .await
    .expect("seeded default category should exist");

    let none_id = create_imported_page(
        &mut runner,
        site.site_id,
        category.category_id,
        NONE_SLUG,
        "No parent",
    )
    .await;
    let missing_id = create_imported_page(
        &mut runner,
        site.site_id,
        category.category_id,
        MISSING_SLUG,
        "Missing parent",
    )
    .await;
    let cycle_a_id = create_imported_page(
        &mut runner,
        site.site_id,
        category.category_id,
        CYCLE_A_SLUG,
        "Cycle A",
    )
    .await;
    let cycle_b_id = create_imported_page(
        &mut runner,
        site.site_id,
        category.category_id,
        CYCLE_B_SLUG,
        "Cycle B",
    )
    .await;
    let renamed_parent_id = create_imported_page(
        &mut runner,
        site.site_id,
        category.category_id,
        RENAMED_PARENT_SOURCE_SLUG,
        "Renamed parent",
    )
    .await;
    let renamed_child_id = create_imported_page(
        &mut runner,
        site.site_id,
        category.category_id,
        RENAMED_CHILD_SLUG,
        "Renamed child",
    )
    .await;

    let transaction = runner.context().transaction();
    for sql in [
        format!(
            r#"
INSERT INTO wikidot_corpus_import_run (
    import_run_id, site_id, source_branch, source_site, manifest_sha256,
    manifest_row_count, complete_inventory, state, summary
) VALUES (
    {IMPORT_RUN_ID}, {}, 'test', 'test', decode(repeat('00', 32), 'hex'),
    6, false, 'metadata_done', '{{}}'::jsonb
)
"#,
            site.site_id,
        ),
        format!(
            r#"
INSERT INTO wikidot_page_snapshot (
    page_id, source_branch, source_site, source_entity_id, source_fullname,
    source_created_at, source_updated_at, source_revision_count,
    imported_rating, title_shown, parent_fullname, comments, source_sha256,
    meta_sha256, meta_json, last_import_run_id
) VALUES
    ({none_id}, 'test', 'test',
     '46300000-0000-4000-8000-000000000001', '{NONE_SLUG}',
     NOW(), NOW(), 1, 0, 'No parent', NULL, 0,
     decode(repeat('01', 32), 'hex'), decode(repeat('11', 32), 'hex'),
     '{{}}'::jsonb, {IMPORT_RUN_ID}),
    ({missing_id}, 'test', 'test',
     '46300000-0000-4000-8000-000000000002', '{MISSING_SLUG}',
     NOW(), NOW(), 1, 0, 'Missing parent', 'breadcrumb-boundary:absent', 0,
     decode(repeat('02', 32), 'hex'), decode(repeat('12', 32), 'hex'),
     '{{}}'::jsonb, {IMPORT_RUN_ID}),
    ({cycle_a_id}, 'test', 'test',
     '46300000-0000-4000-8000-000000000003', '{CYCLE_A_SLUG}',
     NOW(), NOW(), 1, 0, 'Cycle A', '{CYCLE_B_SLUG}', 0,
     decode(repeat('03', 32), 'hex'), decode(repeat('13', 32), 'hex'),
     '{{}}'::jsonb, {IMPORT_RUN_ID}),
    ({cycle_b_id}, 'test', 'test',
     '46300000-0000-4000-8000-000000000004', '{CYCLE_B_SLUG}',
     NOW(), NOW(), 1, 0, 'Cycle B', '{CYCLE_A_SLUG}', 0,
     decode(repeat('04', 32), 'hex'), decode(repeat('14', 32), 'hex'),
     '{{}}'::jsonb, {IMPORT_RUN_ID}),
    ({renamed_parent_id}, 'test', 'test',
     '46300000-0000-4000-8000-000000000005', '{RENAMED_PARENT_SOURCE_SLUG}',
     NOW(), NOW(), 1, 0, 'Renamed parent', NULL, 0,
     decode(repeat('05', 32), 'hex'), decode(repeat('15', 32), 'hex'),
     '{{}}'::jsonb, {IMPORT_RUN_ID}),
    ({renamed_child_id}, 'test', 'test',
     '46300000-0000-4000-8000-000000000006', '{RENAMED_CHILD_SLUG}',
     NOW(), NOW(), 1, 0, 'Renamed child', '{RENAMED_PARENT_SOURCE_SLUG}', 0,
     decode(repeat('06', 32), 'hex'), decode(repeat('16', 32), 'hex'),
     '{{}}'::jsonb, {IMPORT_RUN_ID})
"#,
        ),
    ] {
        transaction
            .execute_raw(Statement::from_string(
                transaction.get_database_backend(),
                sql,
            ))
            .await
            .expect("breadcrumb boundary fixture SQL should succeed");
    }

    let renamed_parent = PageTable::find_by_id(renamed_parent_id)
        .one(transaction)
        .await
        .expect("renamed parent lookup should succeed")
        .expect("renamed parent should exist");
    let mut renamed_parent = renamed_parent.into_active_model();
    renamed_parent.slug = Set(RENAMED_PARENT_LOCAL_SLUG.to_owned());
    renamed_parent
        .update(transaction)
        .await
        .expect("local parent rename should succeed");

    for (case_id, slug) in [
        ("A1063_BREADCRUMB_PARENT_NONE", NONE_SLUG),
        ("A1063_BREADCRUMB_MISSING_PARENT", MISSING_SLUG),
        ("A1063_BREADCRUMB_CYCLE", CYCLE_A_SLUG),
    ] {
        assert!(
            article_breadcrumbs(&mut runner, site.site_id, slug)
                .await
                .is_empty(),
            "{case_id}: an incomplete relation must not expose a partial chain",
        );
    }

    assert_eq!(
        article_breadcrumbs(&mut runner, site.site_id, RENAMED_CHILD_SLUG).await,
        vec![
            (
                RENAMED_PARENT_SOURCE_SLUG.to_owned(),
                "Renamed parent".to_owned(),
            ),
            (RENAMED_CHILD_SLUG.to_owned(), "Renamed child".to_owned()),
        ],
        "A1063_BREADCRUMB_RENAME: imported source identity must remain stable",
    );
}
