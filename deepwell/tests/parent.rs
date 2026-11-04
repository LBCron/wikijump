/*
 * tests/parent.rs
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
use deepwell::models::page_parent::ActiveModel as PageParentActiveModel;
use deepwell::models::page_parent::Entity as PageParentTable;
use deepwell::services::category::CategoryService;
use deepwell::services::job::JOB_QUEUE_NAME;
use deepwell::services::parent::DirectParentMetadataResult;
use deepwell::services::permission::PermissionService;
use deepwell::services::role::{
    GrantUserRoleInput, InternalCreateRoleInput, RoleService, UpdateRolePermissionsInput,
};
use deepwell::services::{
    PageRevisionService, PageService, RequestContext, ServiceContext,
};
use deepwell::types::{Action, Permission, Reference, Resource};
use rsmq_async::RsmqConnection;
use sea_orm::{ActiveModelTrait, EntityTrait, Set};
use serde_json::json;
use std::borrow::Cow;

async fn queued_job_count(runner: &TestRunner) -> u64 {
    runner
        .context()
        .rsmq()
        .get_queue_attributes(JOB_QUEUE_NAME)
        .await
        .expect("job queue attributes should be readable")
        .totalsent
}

async fn create_page(
    runner: &mut TestRunner,
    site_id: i64,
    slug: &'static str,
    wikitext: &str,
) -> i64 {
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(Cow::Borrowed(slug))),
    });
    let created = run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": site_id,
            "wikitext": wikitext,
            "title": slug,
            "alt_title": null,
            "slug": slug,
            "layout": "wikidot",
            "revision_comments": "create parent outdate fixture",
            "user_id": ADMIN_USER_ID,
            "bypass_filter": true,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    created.revision_id
}

async fn create_parent_auth_page(
    runner: &mut TestRunner,
    site_id: i64,
    slug: &'static str,
) -> i64 {
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
            "wikitext": format!("Parent authorization fixture for {slug}"),
            "title": slug,
            "alt_title": null,
            "slug": slug,
            "layout": "wikidot",
            "revision_comments": "create parent authorization fixture",
            "user_id": ADMIN_USER_ID,
            "bypass_filter": true,
            "ip_address": common::IP_ADDRESS,
        }),
    )
    .page_id
}

async fn grant_private_parent_view_role(ctx: &ServiceContext<'_>, site_id: i64) {
    let category_id =
        CategoryService::get_or_create(ctx, site_id, "fixture-parent-read-private")
            .await
            .expect("private parent test category should be created")
            .category_id;
    let role = RoleService::create(
        ctx,
        InternalCreateRoleInput {
            site_id,
            name: "fixture-parent-read-private-admin".to_owned(),
            description: None,
            is_virtual: false,
            parent_role_id: None,
            creating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("private parent test role should be created");
    PermissionService::update_permissions_for_role(
        ctx,
        UpdateRolePermissionsInput {
            site_id,
            role_reference: Reference::Id(role.role_id),
            new_permissions: [Action::View, Action::Create, Action::Edit]
                .into_iter()
                .map(|action| Permission {
                    resource_type: Resource::Page,
                    resource_category: Some(Reference::Id(category_id)),
                    action,
                })
                .collect(),
            cascade_removals: false,
            updating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("private parent test permissions should be assigned");
    RoleService::grant_role_to_user(
        ctx,
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
    .expect("admin should receive private parent test role");
}

async fn insert_parent_relationship(
    runner: &TestRunner,
    parent_page_id: i64,
    child_page_id: i64,
) {
    PageParentActiveModel {
        parent_page_id: Set(parent_page_id),
        child_page_id: Set(child_page_id),
        ..Default::default()
    }
    .insert(runner.context().transaction())
    .await
    .expect("parent relationship fixture should be inserted");
}

#[tokio::test]
async fn changed_parent_relationships_queue_parent_rerenders() {
    const PARENT_SLUG: &str = "fixture-parent-outdate-listpages";
    const CHILD_SLUG: &str = "fixture-parent-outdate-child";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;

    create_page(
        &mut runner,
        site_id,
        PARENT_SLUG,
        "[[module ListPages parent=\".\"]]\n%%fullname%%\n[[/module]]",
    )
    .await;
    create_page(&mut runner, site_id, CHILD_SLUG, "Child body").await;

    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(Cow::Borrowed(CHILD_SLUG))),
    });

    let before_create = queued_job_count(&runner).await;
    let created = run_endpoint!(
        runner,
        parent_set,
        json!({
            "site_id": site_id,
            "parent": PARENT_SLUG,
            "child": CHILD_SLUG,
        }),
    );
    assert!(created.is_some());
    let child_page = PageService::get(
        runner.context(),
        site_id,
        Reference::Slug(Cow::Borrowed(CHILD_SLUG)),
    )
    .await
    .expect("child should remain readable after setting its parent");
    let parent_revision =
        PageRevisionService::get_latest(runner.context(), site_id, child_page.page_id)
            .await
            .expect("setting a parent should create the Wikidot metadata revision");
    assert_eq!(parent_revision.revision_number, 1);
    assert_eq!(parent_revision.changes, vec!["parent".to_owned()]);
    assert_eq!(
        parent_revision.comments,
        format!("Parent page set to: \"{PARENT_SLUG}\"."),
    );
    let parent_revision_id = parent_revision.revision_id;
    assert_eq!(
        queued_job_count(&runner).await,
        before_create,
        "parent changes must not enqueue before post-commit processing"
    );
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("parent rerender should queue after commit");
    assert_eq!(queued_job_count(&runner).await, before_create + 1);

    let duplicate = run_endpoint!(
        runner,
        parent_set,
        json!({
            "site_id": site_id,
            "parent": PARENT_SLUG,
            "child": CHILD_SLUG,
        }),
    );
    assert!(duplicate.is_none());
    let after_duplicate =
        PageRevisionService::get_latest(runner.context(), site_id, child_page.page_id)
            .await
            .expect("duplicate parent set should leave the latest revision readable");
    assert_eq!(after_duplicate.revision_id, parent_revision_id);
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("duplicate parent update should have no post-commit error");
    assert_eq!(queued_job_count(&runner).await, before_create + 1);

    let removed = run_endpoint!(
        runner,
        parent_remove,
        json!({
            "site_id": site_id,
            "parent": PARENT_SLUG,
            "child": CHILD_SLUG,
        }),
    );
    assert!(removed.was_deleted);
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("parent rerender should queue after commit");
    assert_eq!(queued_job_count(&runner).await, before_create + 2);

    let absent = run_endpoint!(
        runner,
        parent_remove,
        json!({
            "site_id": site_id,
            "parent": PARENT_SLUG,
            "child": CHILD_SLUG,
        }),
    );
    assert!(!absent.was_deleted);
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("absent parent removal should have no post-commit error");
    assert_eq!(queued_job_count(&runner).await, before_create + 2);

    let recreated = run_endpoint!(
        runner,
        parent_set,
        json!({
            "site_id": site_id,
            "parent": PARENT_SLUG,
            "child": CHILD_SLUG,
        }),
    );
    assert!(recreated.is_some());
    let recreated_revision =
        PageRevisionService::get_latest(runner.context(), site_id, child_page.page_id)
            .await
            .expect("recreated parent relationship should create a metadata revision");
    assert_eq!(recreated_revision.revision_number, 2);
    assert_eq!(recreated_revision.changes, vec!["parent".to_owned()]);
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("parent rerender should queue after commit");
    assert_eq!(queued_job_count(&runner).await, before_create + 3);

    run_endpoint!(
        runner,
        page_delete,
        json!({
            "site_id": site_id,
            "page": CHILD_SLUG,
            "last_revision_id": recreated_revision.revision_id,
            "revision_comments": "delete parent outdate fixture child",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    runner
        .context()
        .run_post_commit_actions()
        .await
        .expect("parent deletion rerender should queue after commit");
    assert_eq!(queued_job_count(&runner).await, before_create + 4);
}

#[tokio::test]
async fn parent_update_rejects_an_unbounded_relationship_batch() {
    let runner = TestRunner::setup().await;
    let before = queued_job_count(&runner).await;
    let parents = (0..65)
        .map(|index| format!("fixture-parent-batch-{index}"))
        .collect::<Vec<_>>();

    let error = run_endpoint_err!(
        runner,
        parent_update,
        json!({
            "site_id": 1,
            "child": "fixture-parent-batch-child",
            "add": parents,
            "remove": null,
        }),
    );
    assert_contains_error!(error, ErrorType::BadRequest);
    assert_eq!(queued_job_count(&runner).await, before);
}

#[tokio::test]
async fn parent_get_all_enforces_child_and_parent_view_permissions() {
    const SITE_SLUG: &str = "scp-wiki";
    const PRIVATE_CHILD_SLUG: &str = "fixture-parent-read-private:child";
    const PRIVATE_PARENT_SLUG: &str = "fixture-parent-read-private:parent";
    const PUBLIC_CHILD_SLUG: &str = "fixture-parent-read-public-child";
    const PUBLIC_PARENT_SLUG: &str = "fixture-parent-read-public-parent";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": SITE_SLUG}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;

    grant_private_parent_view_role(runner.context(), site_id).await;
    let private_child_id =
        create_parent_auth_page(&mut runner, site_id, PRIVATE_CHILD_SLUG).await;
    let private_parent_id =
        create_parent_auth_page(&mut runner, site_id, PRIVATE_PARENT_SLUG).await;
    let public_child_id =
        create_parent_auth_page(&mut runner, site_id, PUBLIC_CHILD_SLUG).await;
    let public_parent_id =
        create_parent_auth_page(&mut runner, site_id, PUBLIC_PARENT_SLUG).await;

    insert_parent_relationship(&runner, private_parent_id, private_child_id).await;
    insert_parent_relationship(&runner, private_parent_id, public_child_id).await;
    insert_parent_relationship(&runner, public_parent_id, public_child_id).await;

    for page in [json!(private_child_id), json!(PRIVATE_CHILD_SLUG)] {
        runner.set_request_context(RequestContext::default());
        let error = run_endpoint_err!(
            runner,
            parent_get_all,
            json!({
                "site_id": site_id,
                "page": page,
            }),
        );
        assert_contains_error!(error, ErrorType::PermissionDenied);
    }

    runner.set_request_context(RequestContext::default());
    let anonymous_parents = run_endpoint!(
        runner,
        parent_get_all,
        json!({
            "site_id": site_id,
            "page": public_child_id,
        }),
    );
    assert_eq!(anonymous_parents, [PUBLIC_PARENT_SLUG.to_owned()]);

    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Id(public_child_id)),
    });
    let mut admin_parents = run_endpoint!(
        runner,
        parent_get_all,
        json!({
            "site_id": site_id,
            "page": public_child_id,
        }),
    );
    admin_parents.sort();
    assert_eq!(
        admin_parents,
        [
            PRIVATE_PARENT_SLUG.to_owned(),
            PUBLIC_PARENT_SLUG.to_owned(),
        ],
    );
}

#[tokio::test]
async fn direct_parent_metadata_tracks_one_current_relationship_and_rejects_ambiguity() {
    const CHILD_SLUG: &str = "fixture-parent-metadata-child";
    const FIRST_PARENT_SLUG: &str = "fixture-parent-metadata-first";
    const SECOND_PARENT_SLUG: &str = "fixture-parent-metadata-second";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let child_id = create_parent_auth_page(&mut runner, site_id, CHILD_SLUG).await;
    let first_parent_id =
        create_parent_auth_page(&mut runner, site_id, FIRST_PARENT_SLUG).await;
    let second_parent_id =
        create_parent_auth_page(&mut runner, site_id, SECOND_PARENT_SLUG).await;

    insert_parent_relationship(&runner, first_parent_id, child_id).await;
    runner.set_request_context(RequestContext::default());
    let DirectParentMetadataResult::Visible(first) = run_endpoint!(
        runner,
        parent_get_direct_metadata,
        json!({"site_id": site_id, "page": CHILD_SLUG}),
    ) else {
        panic!("one viewable direct parent should be projected");
    };
    assert_eq!(first.slug, FIRST_PARENT_SLUG);
    assert_eq!(first.title, FIRST_PARENT_SLUG);

    PageParentTable::delete_by_id((first_parent_id, child_id))
        .exec(runner.context().transaction())
        .await
        .expect("first parent relationship should be replaced");
    insert_parent_relationship(&runner, second_parent_id, child_id).await;
    let DirectParentMetadataResult::Visible(second) = run_endpoint!(
        runner,
        parent_get_direct_metadata,
        json!({"site_id": site_id, "page": child_id}),
    ) else {
        panic!("the endpoint should resolve the current relationship");
    };
    assert_eq!(second.slug, SECOND_PARENT_SLUG);
    assert_eq!(second.title, SECOND_PARENT_SLUG);

    insert_parent_relationship(&runner, first_parent_id, child_id).await;
    assert!(
        matches!(
            run_endpoint!(
                runner,
                parent_get_direct_metadata,
                json!({"site_id": site_id, "page": CHILD_SLUG}),
            ),
            DirectParentMetadataResult::Undisclosed
        ),
        "ambiguous direct parents must fail closed",
    );
}

#[tokio::test]
async fn direct_parent_metadata_hides_an_unviewable_child_or_parent() {
    const PUBLIC_CHILD_SLUG: &str = "fixture-parent-metadata-public-child";
    const PRIVATE_PARENT_SLUG: &str = "fixture-parent-read-private:metadata-parent";
    const PRIVATE_CHILD_SLUG: &str = "fixture-parent-read-private:metadata-child";
    const PUBLIC_PARENT_SLUG: &str = "fixture-parent-metadata-public-parent";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    grant_private_parent_view_role(runner.context(), site_id).await;
    let public_child_id =
        create_parent_auth_page(&mut runner, site_id, PUBLIC_CHILD_SLUG).await;
    let private_parent_id =
        create_parent_auth_page(&mut runner, site_id, PRIVATE_PARENT_SLUG).await;
    let private_child_id =
        create_parent_auth_page(&mut runner, site_id, PRIVATE_CHILD_SLUG).await;
    let public_parent_id =
        create_parent_auth_page(&mut runner, site_id, PUBLIC_PARENT_SLUG).await;
    insert_parent_relationship(&runner, private_parent_id, public_child_id).await;
    insert_parent_relationship(&runner, public_parent_id, private_child_id).await;

    runner.set_request_context(RequestContext::default());
    assert!(
        matches!(
            run_endpoint!(
                runner,
                parent_get_direct_metadata,
                json!({"site_id": site_id, "page": PUBLIC_CHILD_SLUG}),
            ),
            DirectParentMetadataResult::Undisclosed
        ),
        "a caller without Page:View must learn no parent metadata",
    );
    assert!(
        matches!(
            run_endpoint!(
                runner,
                parent_get_direct_metadata,
                json!({"site_id": site_id, "page": PRIVATE_CHILD_SLUG}),
            ),
            DirectParentMetadataResult::Undisclosed
        ),
        "a caller without child Page:View must learn no relationship metadata",
    );
}

#[tokio::test]
async fn direct_parent_metadata_rejects_missing_deleted_and_cross_site_parents() {
    const MISSING_CHILD_SLUG: &str = "fixture-parent-metadata-missing-child";
    const DELETED_CHILD_SLUG: &str = "fixture-parent-metadata-deleted-child";
    const DELETED_PARENT_SLUG: &str = "fixture-parent-metadata-deleted-parent";
    const CROSS_SITE_CHILD_SLUG: &str = "fixture-parent-metadata-cross-site-child";
    const CROSS_SITE_PARENT_SLUG: &str = "fixture-parent-metadata-cross-site-parent";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let other_site = run_endpoint!(runner, site_get, json!({"site": "scp-jp"}))
        .expect("seeded SCP-JP site should exist");
    let site_id = site.site.site_id;
    let other_site_id = other_site.site.site_id;

    runner.set_request_context(RequestContext::default());
    assert!(matches!(
        run_endpoint!(
            runner,
            parent_get_direct_metadata,
            json!({"site_id": site_id, "page": MISSING_CHILD_SLUG}),
        ),
        DirectParentMetadataResult::Undisclosed
    ),);

    let deleted_child_id =
        create_parent_auth_page(&mut runner, site_id, DELETED_CHILD_SLUG).await;
    let deleted_parent_id =
        create_parent_auth_page(&mut runner, site_id, DELETED_PARENT_SLUG).await;
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Id(deleted_parent_id)),
    });
    let deleted_parent = run_endpoint!(
        runner,
        page_get,
        json!({"site_id": site_id, "page": deleted_parent_id}),
    )
    .expect("parent should exist before deletion");
    run_endpoint!(
        runner,
        page_delete,
        json!({
            "site_id": site_id,
            "page": deleted_parent_id,
            "last_revision_id": deleted_parent.revision_id,
            "revision_comments": "delete parent metadata fixture",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    insert_parent_relationship(&runner, deleted_parent_id, deleted_child_id).await;
    runner.set_request_context(RequestContext::default());
    assert!(
        matches!(
            run_endpoint!(
                runner,
                parent_get_direct_metadata,
                json!({"site_id": site_id, "page": DELETED_CHILD_SLUG}),
            ),
            DirectParentMetadataResult::Undisclosed
        ),
        "a deleted parent must not be projected",
    );

    let cross_site_child_id =
        create_parent_auth_page(&mut runner, site_id, CROSS_SITE_CHILD_SLUG).await;
    let cross_site_parent_id =
        create_parent_auth_page(&mut runner, other_site_id, CROSS_SITE_PARENT_SLUG).await;
    insert_parent_relationship(&runner, cross_site_parent_id, cross_site_child_id).await;
    runner.set_request_context(RequestContext::default());
    assert!(
        matches!(
            run_endpoint!(
                runner,
                parent_get_direct_metadata,
                json!({"site_id": site_id, "page": CROSS_SITE_CHILD_SLUG}),
            ),
            DirectParentMetadataResult::Undisclosed
        ),
        "a parent from another site must not be projected",
    );
}
