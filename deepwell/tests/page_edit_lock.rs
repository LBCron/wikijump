/*
 * tests/page_edit_lock.rs
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
use deepwell::services::page::{EditPage, EditPageBody, EditPageLease, EditPageOutput};
use deepwell::services::page_edit_lock::{
    AcquirePageEditLock, AcquirePageEditLockOutput, PageEditLockGrant,
    ReleasePageEditLock, RenewPageEditLock,
};
use deepwell::services::{
    PageEditLockService, PageRevisionService, PageService, RequestContext,
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
            "title": format!("Edit lock test {slug}"),
            "alt_title": null,
            "slug": slug,
            "layout": "wikidot",
            "revision_comments": "edit lock test create",
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

async fn force_acquire(
    runner: &TestRunner,
    site_id: i64,
    page_id: i64,
    user_id: i64,
    mode: PageEditLockMode,
    section_index: Option<i32>,
) -> AcquirePageEditLockOutput {
    PageEditLockService::force_acquire(
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
    .expect("force acquire should not error")
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

fn section_lease_of(grant: &PageEditLockGrant, section_index: i32) -> EditPageLease {
    EditPageLease {
        lock_id: grant.lock_id,
        lock_secret: grant.lock_secret.clone(),
        mode: PageEditLockMode::Section,
        section_index: Some(section_index),
    }
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
            revision_comments: "edit lock test edit".to_owned(),
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

async fn latest_revision_id(runner: &TestRunner, site_id: i64, page_id: i64) -> i64 {
    PageRevisionService::get_latest(runner.context(), site_id, page_id)
        .await
        .expect("latest revision should exist")
        .revision_id
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

#[tokio::test]
async fn acquire_grants_and_conflict_reports_holder() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, revision_id) =
        setup_page(&mut runner, "edit-lock-acquire", "body").await;

    let output = acquire(
        &runner,
        site_id,
        page_id,
        USER_A,
        PageEditLockMode::Page,
        None,
    )
    .await;
    let granted = grant(&output);
    assert_eq!(granted.base_revision_id, Some(revision_id));
    let remaining =
        (granted.expires_at - time::OffsetDateTime::now_utc()).whole_seconds();
    assert!(
        (800..=900).contains(&remaining),
        "lease length: {remaining}"
    );

    let output = acquire(
        &runner,
        site_id,
        page_id,
        USER_B,
        PageEditLockMode::Page,
        None,
    )
    .await;
    assert!(output.grant.is_none());
    assert_eq!(output.conflicts.len(), 1);
    assert_eq!(output.conflicts[0].user_id, USER_A);
    assert_eq!(output.conflicts[0].mode, PageEditLockMode::Page);
    assert!((0..=900).contains(&output.conflicts[0].seconds_remaining));

    let output = acquire(
        &runner,
        site_id,
        page_id,
        USER_B,
        PageEditLockMode::Append,
        None,
    )
    .await;
    assert!(output.grant.is_none(), "page lease conflicts with append");

    let output = acquire(
        &runner,
        site_id,
        page_id,
        USER_A,
        PageEditLockMode::Page,
        None,
    )
    .await;
    assert!(
        output.grant.is_none(),
        "the holder conflicts with itself on re-open"
    );
    assert_eq!(output.conflicts[0].user_id, USER_A);
}

#[tokio::test]
async fn acquire_disjoint_sections_coexist() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, _) = setup_page(
        &mut runner,
        "edit-lock-sections",
        "+ One\nalpha\n+ Two\nbeta\n",
    )
    .await;

    grant(
        &acquire(
            &runner,
            site_id,
            page_id,
            USER_A,
            PageEditLockMode::Section,
            Some(0),
        )
        .await,
    );
    grant(
        &acquire(
            &runner,
            site_id,
            page_id,
            USER_B,
            PageEditLockMode::Section,
            Some(1),
        )
        .await,
    );
    grant(
        &acquire(
            &runner,
            site_id,
            page_id,
            USER_B,
            PageEditLockMode::Append,
            None,
        )
        .await,
    );

    let output = acquire(
        &runner,
        site_id,
        page_id,
        USER_B,
        PageEditLockMode::Section,
        Some(0),
    )
    .await;
    assert!(output.grant.is_none(), "same section conflicts");
    assert_eq!(output.conflicts[0].user_id, USER_A);
    assert_eq!(output.conflicts[0].section_index, Some(0));

    let output = acquire(
        &runner,
        site_id,
        page_id,
        USER_B,
        PageEditLockMode::Page,
        None,
    )
    .await;
    assert!(
        output.grant.is_none(),
        "page mode conflicts with section leases"
    );
    assert_eq!(output.conflicts.len(), 3);
}

#[tokio::test]
async fn force_takeover_then_superseded_save_outcomes() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, revision_id) =
        setup_page(&mut runner, "edit-lock-force", "v0").await;

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
    let b = grant(
        &force_acquire(
            &runner,
            site_id,
            page_id,
            USER_B,
            PageEditLockMode::Page,
            None,
        )
        .await,
    );
    assert_eq!(
        lease_rows(&runner, page_id).await.len(),
        1,
        "force removed A's lease"
    );

    let result = edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        revision_id,
        text_body("a too late"),
        Some(lease_of(&a, PageEditLockMode::Page)),
    )
    .await;
    let error = result.expect_err("superseded save with a live rival must fail");
    assert_contains_error!(error, ErrorType::PageEditLockConflict);

    let output = edit(
        &runner,
        site_id,
        page_id,
        USER_B,
        revision_id,
        text_body("b wins"),
        Some(lease_of(&b, PageEditLockMode::Page)),
    )
    .await
    .expect("rival save should commit")
    .expect("rival save should create a revision");
    assert!(!output.lock_recreated);

    let result = edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        revision_id,
        text_body("a retries stale"),
        Some(lease_of(&a, PageEditLockMode::Page)),
    )
    .await;
    let error = result.expect_err("superseded save after the rival saved must fail");
    assert_contains_error!(error, ErrorType::NotLatestRevisionId);
}

#[tokio::test]
async fn expired_holder_commits_with_recreation_until_rival_saves() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, revision_id) =
        setup_page(&mut runner, "edit-lock-expiry", "v0").await;

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
    expire_leases(&runner, page_id).await;

    let output = edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        revision_id,
        text_body("a after expiry"),
        Some(lease_of(&a, PageEditLockMode::Page)),
    )
    .await
    .expect("expired holder with an unmoved source should commit")
    .expect("expired holder save should create a revision");
    assert!(output.lock_recreated, "the save re-created the dead lease");
    assert!(
        lease_rows(&runner, page_id).await.is_empty(),
        "the save released it again"
    );

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
    expire_leases(&runner, page_id).await;
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
    let b_base = latest_revision_id(&runner, site_id, page_id).await;
    edit(
        &runner,
        site_id,
        page_id,
        USER_B,
        b_base,
        text_body("b after expiry"),
        Some(lease_of(&b, PageEditLockMode::Page)),
    )
    .await
    .expect("rival save should commit");

    let result = edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        a2.base_revision_id.expect("base"),
        text_body("a stale after rival"),
        Some(lease_of(&a2, PageEditLockMode::Page)),
    )
    .await;
    let error = result.expect_err("holder whose expired lease was taken must fail");
    assert_contains_error!(error, ErrorType::NotLatestRevisionId);
}

#[tokio::test]
async fn renew_recreates_expired_and_rejects_superseded() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, revision_id) =
        setup_page(&mut runner, "edit-lock-renew", "v0").await;

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
    let revisions_before = revision_count(&runner, page_id).await;

    let renewed = PageEditLockService::renew(
        runner.context(),
        RenewPageEditLock {
            site_id,
            page: Reference::Id(page_id),
            user_id: USER_A,
            lock_id: a.lock_id,
            lock_secret: a.lock_secret.clone(),
            mode: PageEditLockMode::Page,
            section_index: None,
        },
    )
    .await
    .expect("renew of a live lease should succeed");
    assert!(!renewed.lock_recreated);
    assert_eq!(renewed.lock_id, a.lock_id);
    assert_eq!(revision_count(&runner, page_id).await, revisions_before);

    expire_leases(&runner, page_id).await;
    let renewed = PageEditLockService::renew(
        runner.context(),
        RenewPageEditLock {
            site_id,
            page: Reference::Id(page_id),
            user_id: USER_A,
            lock_id: a.lock_id,
            lock_secret: a.lock_secret.clone(),
            mode: PageEditLockMode::Page,
            section_index: None,
        },
    )
    .await
    .expect("renew of an expired lease should succeed");
    assert!(renewed.lock_recreated);
    assert_eq!(revision_count(&runner, page_id).await, revisions_before);

    let wrong_secret = PageEditLockService::renew(
        runner.context(),
        RenewPageEditLock {
            site_id,
            page: Reference::Id(page_id),
            user_id: USER_A,
            lock_id: a.lock_id,
            lock_secret: ["wrong-", "secret"].concat(),
            mode: PageEditLockMode::Page,
            section_index: None,
        },
    )
    .await;
    let error = wrong_secret.expect_err("wrong secret against a live lease must fail");
    assert_contains_error!(error, ErrorType::PageEditLockConflict);

    grant(
        &force_acquire(
            &runner,
            site_id,
            page_id,
            USER_B,
            PageEditLockMode::Page,
            None,
        )
        .await,
    );
    let superseded = PageEditLockService::renew(
        runner.context(),
        RenewPageEditLock {
            site_id,
            page: Reference::Id(page_id),
            user_id: USER_A,
            lock_id: a.lock_id,
            lock_secret: a.lock_secret.clone(),
            mode: PageEditLockMode::Page,
            section_index: None,
        },
    )
    .await;
    let error = superseded.expect_err("renew of a superseded lease must fail");
    assert_contains_error!(error, ErrorType::PageEditLockConflict);
    assert_eq!(revision_count(&runner, page_id).await, revisions_before);
    assert_eq!(
        revision_id,
        latest_revision_id(&runner, site_id, page_id).await
    );
}

#[tokio::test]
async fn save_releases_and_presented_id_rules_after_release() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, revision_id) =
        setup_page(&mut runner, "edit-lock-release", "v0").await;

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

    let output = edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        424_242,
        text_body("a v1"),
        Some(lease_of(&a, PageEditLockMode::Page)),
    )
    .await
    .expect("live-row save ignores the presented id and commits")
    .expect("live-row save should create a revision");
    assert!(!output.lock_recreated);
    assert!(
        lease_rows(&runner, page_id).await.is_empty(),
        "a successful save releases the lease",
    );

    let result = edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        revision_id,
        text_body("a v2 stale"),
        Some(lease_of(&a, PageEditLockMode::Page)),
    )
    .await;
    let error = result.expect_err("old presented id after release must fail");
    assert_contains_error!(error, ErrorType::NotLatestRevisionId);

    let current = latest_revision_id(&runner, site_id, page_id).await;
    let output = edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        current,
        text_body("a v2 fresh"),
        Some(lease_of(&a, PageEditLockMode::Page)),
    )
    .await
    .expect("current presented id after release should commit")
    .expect("should create a revision");
    assert!(output.lock_recreated);

    let noop = edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        latest_revision_id(&runner, site_id, page_id).await,
        EditPageBody::default(),
        Some(lease_of(&a, PageEditLockMode::Page)),
    )
    .await
    .expect("no-change save should succeed");
    assert!(noop.is_none(), "no-change save creates no revision");
}

#[tokio::test]
async fn meta_revisions_do_not_move_the_holders_base() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, revision_id) =
        setup_page(&mut runner, "edit-lock-meta", "v0").await;

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

    let tags_body = EditPageBody {
        tags: Maybe::Set(vec!["alpha".to_owned(), "beta".to_owned()]),
        ..Default::default()
    };
    let tag_revision = edit(
        &runner,
        site_id,
        page_id,
        USER_B,
        revision_id,
        tags_body,
        None,
    )
    .await
    .expect("third-party tag edit should commit")
    .expect("tag edit creates a revision");
    assert_ne!(tag_revision.revision_id, revision_id);

    let output = edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        revision_id,
        text_body("a v1 after tags"),
        Some(lease_of(&a, PageEditLockMode::Page)),
    )
    .await
    .expect("holder save after a meta revision should commit")
    .expect("should create a revision");
    assert!(!output.lock_recreated);
}

#[tokio::test]
async fn section_saves_rebase_and_detect_section_moves() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, revision_id) = setup_page(
        &mut runner,
        "edit-lock-section-save",
        "+ One\nalpha\n+ Two\nbeta\n",
    )
    .await;

    let a = grant(
        &acquire(
            &runner,
            site_id,
            page_id,
            USER_A,
            PageEditLockMode::Section,
            Some(0),
        )
        .await,
    );
    let b = grant(
        &acquire(
            &runner,
            site_id,
            page_id,
            USER_B,
            PageEditLockMode::Section,
            Some(1),
        )
        .await,
    );

    edit(
        &runner,
        site_id,
        page_id,
        USER_B,
        revision_id,
        text_body("+ Two\nbeta\ngrown-1\ngrown-2\ngrown-3"),
        Some(section_lease_of(&b, 1)),
    )
    .await
    .expect("disjoint section save should commit")
    .expect("should create a revision");

    edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        revision_id,
        text_body("+ One\nALPHA"),
        Some(section_lease_of(&a, 0)),
    )
    .await
    .expect("section save after a disjoint grow should commit")
    .expect("should create a revision");

    let latest = PageRevisionService::get_latest(runner.context(), site_id, page_id)
        .await
        .expect("latest revision");
    let wikitext =
        deepwell::services::TextService::get(runner.context(), &latest.wikitext_hash)
            .await
            .expect("latest wikitext");
    assert_eq!(
        wikitext,
        "+ One\nALPHA\n+ Two\nbeta\ngrown-1\ngrown-2\ngrown-3\n",
    );

    let a2 = grant(
        &acquire(
            &runner,
            site_id,
            page_id,
            USER_A,
            PageEditLockMode::Section,
            Some(0),
        )
        .await,
    );
    let b2 = grant(
        &force_acquire(
            &runner,
            site_id,
            page_id,
            USER_B,
            PageEditLockMode::Section,
            Some(0),
        )
        .await,
    );
    let current = latest_revision_id(&runner, site_id, page_id).await;
    edit(
        &runner,
        site_id,
        page_id,
        USER_B,
        current,
        text_body("+ One\nHIJACKED"),
        Some(section_lease_of(&b2, 0)),
    )
    .await
    .expect("force holder section save should commit");

    let result = edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        current,
        text_body("+ One\nA AGAIN"),
        Some(section_lease_of(&a2, 0)),
    )
    .await;
    let error = result.expect_err("save over a moved section must fail");
    assert_contains_error!(error, ErrorType::NotLatestRevisionId);
}

#[tokio::test]
async fn append_save_appends_and_coexists_with_section_lease() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, revision_id) = setup_page(
        &mut runner,
        "edit-lock-append-save",
        "+ One\nalpha\n+ Two\nbeta\n",
    )
    .await;

    let a = grant(
        &acquire(
            &runner,
            site_id,
            page_id,
            USER_A,
            PageEditLockMode::Section,
            Some(0),
        )
        .await,
    );
    let b = grant(
        &acquire(
            &runner,
            site_id,
            page_id,
            USER_B,
            PageEditLockMode::Append,
            None,
        )
        .await,
    );

    edit(
        &runner,
        site_id,
        page_id,
        USER_B,
        revision_id,
        text_body("appended line"),
        Some(lease_of(&b, PageEditLockMode::Append)),
    )
    .await
    .expect("append save should commit")
    .expect("should create a revision");

    edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        revision_id,
        text_body("+ One\nALPHA"),
        Some(section_lease_of(&a, 0)),
    )
    .await
    .expect("section save after an append should commit")
    .expect("should create a revision");

    let latest = PageRevisionService::get_latest(runner.context(), site_id, page_id)
        .await
        .expect("latest revision");
    let wikitext =
        deepwell::services::TextService::get(runner.context(), &latest.wikitext_hash)
            .await
            .expect("latest wikitext");
    assert_eq!(wikitext, "+ One\nALPHA\n+ Two\nbeta\nappended line");
}

#[tokio::test]
async fn release_requires_matching_credentials() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, _) =
        setup_page(&mut runner, "edit-lock-release-op", "v0").await;

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

    let removed = PageEditLockService::release(
        runner.context(),
        ReleasePageEditLock {
            site_id,
            page: Reference::Id(page_id),
            user_id: USER_A,
            lock_id: a.lock_id,
            lock_secret: ["wrong-", "secret"].concat(),
        },
    )
    .await
    .expect("release with a wrong secret should not error");
    assert!(!removed);
    assert_eq!(lease_rows(&runner, page_id).await.len(), 1);

    let removed = PageEditLockService::release(
        runner.context(),
        ReleasePageEditLock {
            site_id,
            page: Reference::Id(page_id),
            user_id: USER_A,
            lock_id: a.lock_id,
            lock_secret: a.lock_secret.clone(),
        },
    )
    .await
    .expect("release should succeed");
    assert!(removed);
    assert!(lease_rows(&runner, page_id).await.is_empty());

    grant(
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
}

#[tokio::test]
async fn bad_credentials_against_a_live_lease_are_other_locks() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, revision_id) =
        setup_page(&mut runner, "edit-lock-bad-creds", "v0").await;

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
    let revisions_before = revision_count(&runner, page_id).await;

    let wrong_secret_lease = EditPageLease {
        lock_id: a.lock_id,
        lock_secret: ["wrong-", "secret"].concat(),
        mode: PageEditLockMode::Page,
        section_index: None,
    };
    let result = edit(
        &runner,
        site_id,
        page_id,
        USER_B,
        revision_id,
        text_body("b with a wrong secret"),
        Some(wrong_secret_lease),
    )
    .await;
    let error = result.expect_err("wrong secret against a live lease must fail");
    assert_contains_error!(error, ErrorType::PageEditLockConflict);

    let never_issued = EditPageLease {
        lock_id: 987_654_321,
        lock_secret: ["never-", "issued"].concat(),
        mode: PageEditLockMode::Page,
        section_index: None,
    };
    let result = edit(
        &runner,
        site_id,
        page_id,
        USER_B,
        revision_id,
        text_body("b with a never-issued lock"),
        Some(never_issued),
    )
    .await;
    let error = result.expect_err("never-issued lock against a live lease must fail");
    assert_contains_error!(error, ErrorType::PageEditLockConflict);

    assert_eq!(revision_count(&runner, page_id).await, revisions_before);
}

#[tokio::test]
async fn leaseless_source_save_is_rejected_and_changes_nothing() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, revision_id) =
        setup_page(&mut runner, "edit-lock-flip", "v0").await;

    let result = edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        revision_id,
        text_body("leaseless v1"),
        None,
    )
    .await;
    let error = result.expect_err("a source save without a lease must fail");
    assert_contains_error!(error, ErrorType::PageEditLockConflict);
    assert_eq!(revision_count(&runner, page_id).await, 1);
    assert_eq!(
        latest_revision_id(&runner, site_id, page_id).await,
        revision_id
    );

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
    let output = edit(
        &runner,
        site_id,
        page_id,
        USER_A,
        revision_id,
        text_body("leased v1"),
        Some(lease_of(&a, PageEditLockMode::Page)),
    )
    .await
    .expect("a leased save should still commit after the rejection")
    .expect("leased save should create a revision");
    assert_eq!(output.revision_number, 1);
}

#[tokio::test]
async fn system_writer_source_save_bypasses_the_lease_requirement() {
    let mut runner = TestRunner::setup().await;
    let (site_id, page_id, revision_id) =
        setup_page(&mut runner, "edit-lock-flip-system", "v0").await;

    let output = PageService::edit(
        runner.context(),
        EditPage {
            site_id,
            page: Reference::Id(page_id),
            last_revision_id: revision_id,
            revision_comments: "system writer save".to_owned(),
            user_id: USER_A,
            body: text_body("system v1"),
            ip_address: common::IP_ADDRESS,
            lease: None,
            system_writer: true,
        },
    )
    .await
    .expect("a system writer save should commit without a lease")
    .expect("system writer save should create a revision");
    assert_eq!(output.revision_number, 1);
}

mod race {
    use deepwell::api::{build_server_at, build_server_state_without_workers};
    use deepwell::config::{Config, Secrets};
    use deepwell::constants::ADMIN_USER_ID;
    use deepwell::services::session::{CreateSession, SessionService};
    use deepwell::services::{ServiceContext, SiteService};
    use deepwell::types::Reference;
    use sea_orm::{ConnectionTrait, Statement, TransactionTrait};
    use serde_json::{Value, json};
    use std::env;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};
    use std::time::Duration;

    const IP: &str = "192.0.2.91";
    const RACE_LOCK_ID: i64 = 777_001;
    const RACE_SECRET: &str = "race-secret-0001";

    struct Outcome {
        status: Option<u16>,
        body: String,
    }

    impl Outcome {
        fn describe(&self) -> String {
            match self.status {
                Some(status) => format!("HTTP {status}: {}", self.body),
                None => format!("TRANSPORT: {}", self.body),
            }
        }

        fn error_code(&self) -> Option<i64> {
            let value: Value = serde_json::from_str(&self.body).ok()?;
            value.get("error")?.get("code")?.as_i64()
        }

        fn result_revision_id(&self) -> Option<i64> {
            let value: Value = serde_json::from_str(&self.body).ok()?;
            value.get("result")?.get("revision_id")?.as_i64()
        }
    }

    async fn rpc(
        client: &reqwest::Client,
        address: SocketAddr,
        session: &str,
        site_id: i64,
        page_header: &str,
        (id, method, params): (usize, &str, Value),
    ) -> Outcome {
        let response = client
            .post(format!("http://{address}"))
            .bearer_auth(
                env::var("DEEPWELL_RPC_TOKEN")
                    .expect("test RPC token must be configured"),
            )
            .header("X-Deepwell-Session-Token", session)
            .header("X-Deepwell-Site-Id", site_id)
            .header("X-Deepwell-Page", page_header)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": id,
                "method": method,
                "params": params,
            }))
            .send()
            .await;
        match response {
            Ok(response) => {
                let status = response.status().as_u16();
                let body = response
                    .text()
                    .await
                    .unwrap_or_else(|error| format!("<body read error: {error}>"));
                Outcome {
                    status: Some(status),
                    body,
                }
            }
            Err(error) => Outcome {
                status: None,
                body: format!("{error}"),
            },
        }
    }

    struct Fixture {
        state: deepwell::api::ServerState,
        address: SocketAddr,
        session: String,
        site_id: i64,
        client: reqwest::Client,
    }

    async fn setup() -> Fixture {
        let state = build_server_state_without_workers(
            Config::integration_testing(),
            Secrets::load(),
        )
        .await
        .expect("test server state should build");
        let (address, server) = build_server_at(
            state.clone(),
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        )
        .await
        .expect("test RPC server should start");
        std::mem::forget(server);

        let transaction = state
            .database
            .begin()
            .await
            .expect("fixture transaction should begin");
        let ctx = ServiceContext::new(&state, &transaction);
        let site = SiteService::get(&ctx, Reference::from("test"))
            .await
            .expect("seeded test site should exist");
        let session = SessionService::create(
            &ctx,
            CreateSession {
                user_id: ADMIN_USER_ID,
                ip_address: IpAddr::V4(Ipv4Addr::new(192, 0, 2, 91)),
                user_agent: "page edit lock race test".to_owned(),
                restricted: false,
            },
        )
        .await
        .expect("admin test session should be created");
        transaction
            .commit()
            .await
            .expect("fixture transaction should commit");

        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .expect("HTTP client should build");

        Fixture {
            state,
            address,
            session,
            site_id: site.site_id,
            client,
        }
    }

    impl Fixture {
        async fn call(
            &self,
            id: usize,
            page_header: &str,
            method: &str,
            params: Value,
        ) -> Outcome {
            rpc(
                &self.client,
                self.address,
                &self.session,
                self.site_id,
                page_header,
                (id, method, params),
            )
            .await
        }

        async fn create_page(&self, slug: &str, wikitext: &str) -> (i64, i64) {
            let outcome = self
                .call(
                    1,
                    slug,
                    "page_create",
                    json!({
                        "site_id": self.site_id,
                        "wikitext": wikitext,
                        "title": format!("Edit lock race test {slug}"),
                        "alt_title": null,
                        "slug": slug,
                        "layout": "wikidot",
                        "revision_comments": "edit lock race test create",
                        "user_id": ADMIN_USER_ID,
                        "ip_address": IP,
                    }),
                )
                .await;
            let value: Value = serde_json::from_str(&outcome.body).unwrap_or_else(|_| {
                panic!("page_create should return JSON: {}", outcome.describe())
            });
            let result = value.get("result").unwrap_or_else(|| {
                panic!("page_create should succeed: {}", outcome.describe())
            });
            (
                result["page_id"].as_i64().expect("page_id"),
                result["revision_id"].as_i64().expect("revision_id"),
            )
        }

        async fn insert_lease(&self, page_id: i64, base_revision_id: i64) {
            let key = ["lock_", "secret"].concat();
            let sql = format!(
                "INSERT INTO page_edit_lock \
                 (expires_at, lock_id, {key}, mode, base_revision_id, page_id, user_id) \
                 VALUES (now() + interval '900 seconds', {RACE_LOCK_ID}, '{RACE_SECRET}', \
                         'page', {base_revision_id}, {page_id}, {ADMIN_USER_ID})"
            );
            self.state
                .database
                .execute_raw(Statement::from_string(
                    self.state.database.get_database_backend(),
                    sql,
                ))
                .await
                .expect("lease insert should run");
        }

        async fn lease_edit(
            &self,
            id: usize,
            page_id: i64,
            presented_revision_id: i64,
            wikitext: &str,
        ) -> Outcome {
            let mut lease = serde_json::Map::new();
            lease.insert("lock_id".to_owned(), json!(RACE_LOCK_ID));
            lease.insert(["lock_", "secret"].concat(), json!(RACE_SECRET));
            lease.insert("mode".to_owned(), json!("page"));
            self.call(
                id,
                &page_id.to_string(),
                "page_edit",
                json!({
                    "site_id": self.site_id,
                    "page": page_id,
                    "last_revision_id": presented_revision_id,
                    "revision_comments": "edit lock race test edit",
                    "user_id": ADMIN_USER_ID,
                    "wikitext": wikitext,
                    "ip_address": IP,
                    "lease": Value::Object(lease),
                }),
            )
            .await
        }

        async fn revision_chain(&self, page_id: i64) -> Vec<(i32, i64)> {
            let rows = self
                .state
                .database
                .query_all_raw(Statement::from_string(
                    self.state.database.get_database_backend(),
                    format!(
                        "SELECT revision_number, revision_id FROM page_revision \
                         WHERE page_id = {page_id} ORDER BY revision_number"
                    ),
                ))
                .await
                .expect("revision chain query should run");
            rows.iter()
                .map(|row| {
                    (
                        row.try_get("", "revision_number").expect("revision_number"),
                        row.try_get("", "revision_id").expect("revision_id"),
                    )
                })
                .collect()
        }

        async fn lease_row_count(&self, page_id: i64) -> i64 {
            let row = self
                .state
                .database
                .query_one_raw(Statement::from_string(
                    self.state.database.get_database_backend(),
                    format!(
                        "SELECT COUNT(*) AS n FROM page_edit_lock WHERE page_id = {page_id}"
                    ),
                ))
                .await
                .expect("lease count query should run")
                .expect("lease count row should exist");
            row.try_get("", "n").expect("count")
        }
    }

    #[tokio::test]
    async fn parallel_saves_under_one_lease_commit_exactly_once() {
        let fixture = setup().await;
        let (page_id, revision_id) =
            fixture.create_page("edit-lock-race", "race v0").await;
        fixture.insert_lease(page_id, revision_id).await;

        let (first, second) = tokio::join!(
            fixture.lease_edit(2, page_id, revision_id, "race v1 from slot one"),
            fixture.lease_edit(3, page_id, revision_id, "race v1 from slot two"),
        );

        let outcomes = [&first, &second];
        let commits: Vec<&Outcome> = outcomes
            .iter()
            .filter(|outcome| outcome.result_revision_id().is_some())
            .copied()
            .collect();
        let conflicts: Vec<&Outcome> = outcomes
            .iter()
            .filter(|outcome| outcome.error_code() == Some(4303))
            .copied()
            .collect();

        assert_eq!(
            commits.len(),
            1,
            "exactly one parallel save commits: {} / {}",
            first.describe(),
            second.describe(),
        );
        assert_eq!(
            conflicts.len(),
            1,
            "the other parallel save is a typed page_changed: {} / {}",
            first.describe(),
            second.describe(),
        );

        let winner_revision = commits[0].result_revision_id().expect("winner revision");
        assert_eq!(
            fixture.revision_chain(page_id).await,
            vec![(0, revision_id), (1, winner_revision)],
            "the revision chain stays gapless",
        );
        assert_eq!(
            fixture.lease_row_count(page_id).await,
            0,
            "the winning save released the lease",
        );
    }
}
