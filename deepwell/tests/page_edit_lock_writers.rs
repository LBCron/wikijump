/*
 * tests/page_edit_lock_writers.rs
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
use deepwell::constants::{ADMIN_USER_ID, SAMPLE_USER_ID};
use deepwell::error::ErrorType;
use deepwell::models::page_edit_lock::{
    Entity as PageEditLockTable, Model as PageEditLockModel,
};
use deepwell::services::legacy_action::SetLegacyActionTags;
use deepwell::services::page::{
    DeletePage, DeletePageOutput, EditPage, EditPageBody, EditPageLease, EditPageOutput,
    MovePage, MovePageOutput, RestorePage, RollbackPage,
};
use deepwell::services::page_edit_lock::{
    AcquirePageEditLock, AcquirePageEditLockOutput, PageEditLockGrant,
    ReleasePageEditLock,
};
use deepwell::services::render::LegacyActionRegistry;
use deepwell::services::{
    LegacyActionService, PageEditLockService, PageRevisionService, PageService,
    RequestContext, TextService,
};
use deepwell::types::{Maybe, PageEditLockMode, Reference};
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, QueryOrder, Statement,
};
use serde_json::json;
use std::borrow::Cow;

const SITE_SLUG: &str = "scpaiueouiuiuiui";
const USER_A: i64 = ADMIN_USER_ID;
const USER_B: i64 = SAMPLE_USER_ID;

fn set_request_context(runner: &mut TestRunner, user_id: i64, site_id: i64, slug: &str) {
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(user_id),
        site_id: Some(site_id),
        page_reference: Some(Reference::Slug(Cow::Owned(slug.to_owned()))),
    });
}

async fn setup_page(
    runner: &mut TestRunner,
    slug: &str,
    wikitext: &str,
) -> (i64, i64, i64) {
    let site = run_endpoint!(runner, site_get, json!({ "site": SITE_SLUG }))
        .expect("editable authoring site should exist")
        .site;
    let site_id = site.site_id;

    set_request_context(runner, USER_A, site_id, slug);
    let created = run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": site_id,
            "wikitext": wikitext,
            "title": format!("Edit lock writers test {slug}"),
            "alt_title": null,
            "slug": slug,
            "layout": "wikidot",
            "revision_comments": "edit lock writers test create",
            "user_id": USER_A,
            "ip_address": common::IP_ADDRESS,
        }),
    );

    (site_id, created.page_id, created.revision_id)
}

async fn acquire(
    runner: &TestRunner,
    site_id: i64,
    page_id: i64,
    user_id: i64,
    mode: PageEditLockMode,
    section_index: Option<i32>,
) -> AcquirePageEditLockOutput {
    PageEditLockService::acquire(
        runner.context(),
        AcquirePageEditLock {
            site_id,
            page: Reference::Id(page_id),
            user_id,
            mode,
            section_index,
        },
    )
    .await
    .expect("acquire should not error")
}

fn grant(output: &AcquirePageEditLockOutput) -> PageEditLockGrant {
    assert!(
        output.conflicts.is_empty(),
        "expected no conflicts, got {:?}",
        output.conflicts,
    );
    output.grant.clone().expect("expected a grant")
}

fn lease_of(grant: &PageEditLockGrant, mode: PageEditLockMode) -> EditPageLease {
    EditPageLease {
        lock_id: grant.lock_id,
        lock_secret: grant.lock_secret.clone(),
        mode,
        section_index: None,
    }
}

async fn release(
    runner: &TestRunner,
    site_id: i64,
    page_id: i64,
    user_id: i64,
    grant: &PageEditLockGrant,
) -> bool {
    PageEditLockService::release(
        runner.context(),
        ReleasePageEditLock {
            site_id,
            page: Reference::Id(page_id),
            user_id,
            lock_id: grant.lock_id,
            lock_secret: grant.lock_secret.clone(),
        },
    )
    .await
    .expect("release should not error")
}

async fn edit(
    runner: &TestRunner,
    site_id: i64,
    page_id: i64,
    user_id: i64,
    presented_revision_id: i64,
    body: EditPageBody,
    lease: Option<EditPageLease>,
) -> deepwell::error::Result<Option<EditPageOutput>> {
    PageService::edit(
        runner.context(),
        EditPage {
            site_id,
            page: Reference::Id(page_id),
            last_revision_id: presented_revision_id,
            revision_comments: "edit lock writers test edit".to_owned(),
            user_id,
            body,
            ip_address: common::IP_ADDRESS,
            lease,
            system_writer: false,
        },
    )
    .await
}

fn text_body(wikitext: &str) -> EditPageBody {
    EditPageBody {
        wikitext: Maybe::Set(wikitext.to_owned()),
        ..Default::default()
    }
}

async fn move_page(
    runner: &TestRunner,
    site_id: i64,
    page_id: i64,
    user_id: i64,
    last_revision_id: i64,
    new_slug: &str,
) -> deepwell::error::Result<MovePageOutput> {
    PageService::r#move(
        runner.context(),
        MovePage {
            site_id,
            page: Reference::Id(page_id),
            last_revision_id,
            new_slug: new_slug.to_owned(),
            revision_comments: "edit lock writers test move".to_owned(),
            user_id,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
}

async fn delete_page(
    runner: &TestRunner,
    site_id: i64,
    page_id: i64,
    user_id: i64,
    last_revision_id: i64,
) -> deepwell::error::Result<DeletePageOutput> {
    PageService::delete(
        runner.context(),
        DeletePage {
            site_id,
            page: Reference::Id(page_id),
            last_revision_id,
            revision_comments: "edit lock writers test delete".to_owned(),
            user_id,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
}

async fn rollback_page(
    runner: &TestRunner,
    site_id: i64,
    page_id: i64,
    user_id: i64,
    last_revision_id: i64,
    revision_number: i32,
) -> deepwell::error::Result<Option<EditPageOutput>> {
    PageService::rollback(
        runner.context(),
        RollbackPage {
            site_id,
            page: Reference::Id(page_id),
            last_revision_id,
            revision_number,
            revision_comments: "edit lock writers test rollback".to_owned(),
            user_id,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
}

async fn latest_revision_id(runner: &TestRunner, site_id: i64, page_id: i64) -> i64 {
    PageRevisionService::get_latest(runner.context(), site_id, page_id)
        .await
        .expect("latest revision should exist")
        .revision_id
}

async fn latest_changes(runner: &TestRunner, site_id: i64, page_id: i64) -> Vec<String> {
    PageRevisionService::get_latest(runner.context(), site_id, page_id)
        .await
        .expect("latest revision should exist")
        .changes
}

async fn latest_wikitext(runner: &TestRunner, site_id: i64, page_id: i64) -> String {
    let latest = PageRevisionService::get_latest(runner.context(), site_id, page_id)
        .await
        .expect("latest revision should exist");
    TextService::get(runner.context(), &latest.wikitext_hash)
        .await
        .expect("latest wikitext should load")
}

async fn revision_count(runner: &TestRunner, page_id: i64) -> usize {
    deepwell::models::page_revision::Entity::find()
        .filter(deepwell::models::page_revision::Column::PageId.eq(page_id))
        .all(runner.context().transaction())
        .await
        .expect("revision query should run")
        .len()
}

async fn lease_rows(runner: &TestRunner, page_id: i64) -> Vec<PageEditLockModel> {
    PageEditLockTable::find()
        .filter(deepwell::models::page_edit_lock::Column::PageId.eq(page_id))
        .order_by_asc(deepwell::models::page_edit_lock::Column::PageEditLockId)
        .all(runner.context().transaction())
        .await
        .expect("lease row query should run")
}

async fn expire_leases(runner: &TestRunner, page_id: i64) {
    let backend = runner.context().transaction().get_database_backend();
    runner
        .context()
        .transaction()
        .execute_raw(Statement::from_sql_and_values(
            backend,
            "UPDATE page_edit_lock SET expires_at = now() - interval '5 seconds' \
             WHERE page_id = $1",
            [page_id.into()],
        ))
        .await
        .expect("expiry update should run");
}

async fn insert_live_lease_row(
    runner: &TestRunner,
    page_id: i64,
    user_id: i64,
    base_revision_id: i64,
) {
    let backend = runner.context().transaction().get_database_backend();
    runner
        .context()
        .transaction()
        .execute_raw(Statement::from_sql_and_values(
            backend,
            "INSERT INTO page_edit_lock \
             (expires_at, lock_id, lock_secret, mode, base_revision_id, page_id, user_id) \
             VALUES (now() + interval '900 seconds', $1, $2, 'page', $3, $4, $5)",
            [
                777_001i64.into(),
                "writers-test-secret".into(),
                base_revision_id.into(),
                page_id.into(),
                user_id.into(),
            ],
        ))
        .await
        .expect("lease row insert should run");
}

#[tokio::test]
async fn move_refused_under_live_lease_and_free_after_expiry_or_release() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, revision_id) =
        setup_page(&mut runner, "lease-writers-move", "move v0").await;

    let a = grant(
        &acquire(
            &runner,
            site_id,
            page_id,
            USER_A,
            PageEditLockMode::Page,
            None,
        )
        .await,
    );

    let blocked = move_page(
        &runner,
        site_id,
        page_id,
        USER_B,
        revision_id,
        "lease-writers-move-renamed",
    )
    .await
    .expect_err("a live lease must refuse another user's move");
    assert_contains_error!(blocked, ErrorType::PageEditLockConflict);

    let blocked_holder = move_page(
        &runner,
        site_id,
        page_id,
        USER_A,
        revision_id,
        "lease-writers-move-renamed",
    )
    .await
    .expect_err("a live lease must refuse even the holder's move");
    assert_contains_error!(blocked_holder, ErrorType::PageEditLockConflict);

    let page = PageService::get(
        runner.context(),
        site_id,
        Reference::Slug(Cow::Borrowed("lease-writers-move")),
    )
    .await
    .expect("refused moves must leave the page at its slug");
    assert_eq!(page.page_id, page_id);
    assert_eq!(revision_count(&runner, page_id).await, 1);

    expire_leases(&runner, page_id).await;
    let moved = move_page(
        &runner,
        site_id,
        page_id,
        USER_B,
        revision_id,
        "lease-writers-move-renamed",
    )
    .await
    .expect("an expired lease must not block a move");
    assert_eq!(moved.new_slug, "lease-writers-move-renamed");
    assert_eq!(revision_count(&runner, page_id).await, 2);

    let latest = latest_revision_id(&runner, site_id, page_id).await;
    let a2 = grant(
        &acquire(
            &runner,
            site_id,
            page_id,
            USER_A,
            PageEditLockMode::Page,
            None,
        )
        .await,
    );
    let blocked_again = move_page(
        &runner,
        site_id,
        page_id,
        USER_B,
        latest,
        "lease-writers-move-again",
    )
    .await
    .expect_err("a fresh live lease must refuse a move again");
    assert_contains_error!(blocked_again, ErrorType::PageEditLockConflict);

    assert!(release(&runner, site_id, page_id, USER_A, &a2).await);
    let moved_again = move_page(
        &runner,
        site_id,
        page_id,
        USER_B,
        latest,
        "lease-writers-move-again",
    )
    .await
    .expect("a released lease must not block a move");
    assert_eq!(moved_again.new_slug, "lease-writers-move-again");
    let _ = a;
}

#[tokio::test]
async fn delete_bypasses_live_lease_and_removes_its_rows() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, revision_id) =
        setup_page(&mut runner, "lease-writers-delete", "delete v0").await;

    let a = grant(
        &acquire(
            &runner,
            site_id,
            page_id,
            USER_A,
            PageEditLockMode::Page,
            None,
        )
        .await,
    );
    assert_eq!(lease_rows(&runner, page_id).await.len(), 1);

    delete_page(&runner, site_id, page_id, USER_B, revision_id)
        .await
        .expect("delete must proceed despite the live lease");

    assert!(
        lease_rows(&runner, page_id).await.is_empty(),
        "deletion must remove the page's lease rows",
    );
    assert!(
        PageService::get(runner.context(), site_id, Reference::Id(page_id))
            .await
            .is_err(),
        "the deleted page must be gone",
    );

    let result = edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        revision_id,
        text_body("delete v1"),
        Some(lease_of(&a, PageEditLockMode::Page)),
    )
    .await;
    assert!(
        result.is_err(),
        "the displaced holder's save must fail after the delete",
    );
}

#[tokio::test]
async fn rollback_kills_live_lease_and_dead_row_rules_follow() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, revision_id) =
        setup_page(&mut runner, "lease-writers-rollback", "rollback v0").await;

    let b = grant(
        &acquire(
            &runner,
            site_id,
            page_id,
            USER_B,
            PageEditLockMode::Page,
            None,
        )
        .await,
    );
    let v1 = edit(
        &runner,
        site_id,
        page_id,
        USER_B,
        revision_id,
        text_body("rollback v1"),
        Some(lease_of(&b, PageEditLockMode::Page)),
    )
    .await
    .expect("plain edit should commit")
    .expect("plain edit creates a revision");
    let revision_id_v1 = v1.revision_id;

    let a = grant(
        &acquire(
            &runner,
            site_id,
            page_id,
            USER_A,
            PageEditLockMode::Page,
            None,
        )
        .await,
    );
    assert_eq!(a.base_revision_id, Some(revision_id_v1));

    let rolled_back = rollback_page(&runner, site_id, page_id, USER_B, revision_id_v1, 0)
        .await
        .expect("rollback should proceed despite the live lease")
        .expect("rollback creates a revision");
    let revision_id_v2 = rolled_back.revision_id;
    assert_eq!(
        latest_wikitext(&runner, site_id, page_id).await,
        "rollback v0",
    );
    assert!(
        lease_rows(&runner, page_id).await.is_empty(),
        "rollback must kill the conflicting live lease",
    );

    let stale = edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        revision_id_v1,
        text_body("rollback v2 stale"),
        Some(lease_of(&a, PageEditLockMode::Page)),
    )
    .await
    .expect_err("a killed lease with a stale presented id must fail page_changed");
    assert_contains_error!(stale, ErrorType::NotLatestRevisionId);

    let fresh = edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        revision_id_v2,
        text_body("rollback v2"),
        Some(lease_of(&a, PageEditLockMode::Page)),
    )
    .await
    .expect("a killed lease presenting the current latest should commit")
    .expect("should create a revision");
    assert!(fresh.lock_recreated);
}

#[tokio::test]
async fn restore_kills_live_lease_rows_on_the_page() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, revision_id) =
        setup_page(&mut runner, "lease-writers-restore", "restore v0").await;

    delete_page(&runner, site_id, page_id, USER_B, revision_id)
        .await
        .expect("delete should succeed");
    insert_live_lease_row(&runner, page_id, USER_A, revision_id).await;
    assert_eq!(lease_rows(&runner, page_id).await.len(), 1);

    PageService::restore(
        runner.context(),
        RestorePage {
            site_id,
            page_id,
            revision_comments: "edit lock writers test restore".to_owned(),
            user_id: USER_B,
            slug: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("restore should proceed");

    assert!(
        lease_rows(&runner, page_id).await.is_empty(),
        "restore must kill the page's live lease rows",
    );
    let page = PageService::get(runner.context(), site_id, Reference::Id(page_id))
        .await
        .expect("the restored page must be back");
    assert!(page.deleted_at.is_none());
}

#[tokio::test]
async fn legacy_set_tags_during_lease_is_meta_only_and_lease_survives() {
    const SLUG: &str = "lease-writers-set-tags";
    const SOURCE: &str = "[[button set-tags -* +favorite +_book text=\"Change tags\"]]";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({ "site": SITE_SLUG }))
        .expect("editable authoring site should exist")
        .site;
    let site_id = site.site_id;

    set_request_context(&mut runner, USER_A, site_id, SLUG);
    let created = run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": site_id,
            "wikitext": SOURCE,
            "title": "Edit lock writers set-tags test",
            "alt_title": null,
            "tags": ["ordinary", "favorite", "_movie", "_kept"],
            "slug": SLUG,
            "layout": "wikidot",
            "revision_comments": "edit lock writers test create",
            "user_id": USER_A,
            "ip_address": common::IP_ADDRESS,
        }),
    );
    let page_id = created.page_id;
    let revision_id = created.revision_id;

    let a = grant(
        &acquire(
            &runner,
            site_id,
            page_id,
            USER_A,
            PageEditLockMode::Page,
            None,
        )
        .await,
    );

    let action_fingerprint = LegacyActionRegistry::from_wikidot_source(SOURCE)
        .fingerprint(0)
        .expect("set-tags descriptor should have a fingerprint");

    set_request_context(&mut runner, USER_B, site_id, SLUG);
    let changed = LegacyActionService::set_tags(
        runner.context(),
        SetLegacyActionTags {
            page_id,
            last_revision_id: revision_id,
            action_index: 0,
            action_fingerprint,
            user_id: USER_B,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("a third-party set-tags write must not be blocked by the lease")
    .expect("set-tags creates a revision");
    assert_ne!(changed.revision_id, revision_id);
    assert_eq!(
        latest_changes(&runner, site_id, page_id).await,
        vec!["tags".to_owned()],
        "a set-tags revision must record tags only, never a wikitext change",
    );

    let rows = lease_rows(&runner, page_id).await;
    assert_eq!(rows.len(), 1, "the lease row must survive a set-tags write");
    assert_eq!(rows[0].lock_id, a.lock_id);

    let output = edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        revision_id,
        text_body("after tags"),
        Some(lease_of(&a, PageEditLockMode::Page)),
    )
    .await
    .expect("the holder's save after a set-tags write should commit")
    .expect("should create a revision");
    assert!(!output.lock_recreated);
}

#[tokio::test]
async fn parent_set_during_lease_is_meta_only_and_lease_survives() {
    let mut runner = TestRunner::setup().await;
    let (site_id, _parent_id, _parent_revision_id) =
        setup_page(&mut runner, "lease-writers-parent", "parent body").await;
    let (site_id_child, child_id, child_revision_id) =
        setup_page(&mut runner, "lease-writers-child", "child body").await;
    assert_eq!(site_id, site_id_child);

    let holder = grant(
        &acquire(
            &runner,
            site_id,
            child_id,
            USER_B,
            PageEditLockMode::Page,
            None,
        )
        .await,
    );

    set_request_context(&mut runner, USER_A, site_id, "lease-writers-child");
    let relationship = run_endpoint!(
        runner,
        parent_set,
        json!({
            "site_id": site_id,
            "parent": "lease-writers-parent",
            "child": "lease-writers-child",
        }),
    );
    assert!(
        relationship.is_some(),
        "setting a parent must not be blocked by the child's lease",
    );
    assert_eq!(
        latest_changes(&runner, site_id, child_id).await,
        vec!["parent".to_owned()],
        "a parent revision must record parent only, never a wikitext change",
    );

    let rows = lease_rows(&runner, child_id).await;
    assert_eq!(rows.len(), 1, "the lease row must survive a parent write");
    assert_eq!(rows[0].lock_id, holder.lock_id);

    let output = edit(
        &runner,
        site_id,
        child_id,
        USER_B,
        child_revision_id,
        text_body("child v1"),
        Some(lease_of(&holder, PageEditLockMode::Page)),
    )
    .await
    .expect("the holder's save after a parent write should commit")
    .expect("should create a revision");
    assert!(!output.lock_recreated);
}
