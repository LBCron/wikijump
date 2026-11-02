#[macro_use]
mod common;

use self::common::TestRunner;
use cuid2::cuid;
use deepwell::constants::ADMIN_USER_ID;
use deepwell::error::ErrorType;
use deepwell::license::License;
use deepwell::services::import::{
    ImportPage, ImportPageRevision, ImportService, ImportSite,
};
use deepwell::services::mirror_scope::{
    MirrorScopeService, ReconcileMirrorPages, ReconcilePageDelete, ReconcilePageRename,
    SetMirrorScope,
};
use deepwell::services::page::PageService;
use deepwell::services::{PageRevisionService, RequestContext};
use deepwell::types::{PageRevisionType, Reference};
use serde_json::json;
use std::borrow::Cow;
use time::OffsetDateTime;
use uuid::Uuid;

fn unique_site_id(tag: &Uuid) -> i64 {
    4_100_000_000
        + i64::from(
            u32::from_be_bytes(tag.as_bytes()[..4].try_into().unwrap()) % 50_000_000,
        )
}

fn unique_page_id(tag: &Uuid, salt: u32) -> i64 {
    4_200_000_000
        + i64::from(
            u32::from_be_bytes(tag.as_bytes()[..4].try_into().unwrap())
                .wrapping_add(salt)
                % 50_000_000,
        )
}

async fn import_mirror_site(runner: &TestRunner, tag: &Uuid) -> i64 {
    ImportService::add_site(
        runner.context(),
        ImportSite {
            site_id: unique_site_id(tag),
            created_at: OffsetDateTime::UNIX_EPOCH,
            name: format!("Reconcile mirror {}", cuid()),
            slug: format!("reconcile-mirror-{}", cuid()),
            tagline: format!("Reconcile fixture {}", cuid()),
            description: "Reconciliation fixture site".to_owned(),
            license: License::CcBySa40,
            locale: "en".to_owned(),
            meta_tags: vec![],
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("mirror site should import")
    .site_id
}

async fn import_mirror_page(
    runner: &TestRunner,
    site_id: i64,
    tag: &Uuid,
    label: &str,
    salt: u32,
) -> i64 {
    let page_id = unique_page_id(tag, salt);
    let slug = format!("reconcile-{label}-{tag}");
    ImportService::add_page(
        runner.context(),
        ImportPage {
            page_id,
            site_id,
            created_at: OffsetDateTime::UNIX_EPOCH,
            slug: slug.clone(),
            locked: false,
            discussion_thread_id: None,
            meta_tags: vec![],
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("mirror page should import");
    ImportService::add_page_revision(
        runner.context(),
        ImportPageRevision {
            revision_id: page_id + 1_000_000_000,
            revision_type: PageRevisionType::Create,
            created_at: OffsetDateTime::UNIX_EPOCH,
            updated_at: None,
            revision_number: 0,
            page_id,
            site_id,
            user_id: Some(ADMIN_USER_ID),
            anonymous_ip: None,
            wikitext: format!("mirror fixture {label}"),
            comments: "mirror reconcile fixture".to_owned(),
            title: label.to_owned(),
            slug,
            tags: vec![],
        },
    )
    .await
    .expect("mirror page revision should import");
    page_id
}

async fn latest_revision_id(runner: &TestRunner, site_id: i64, page_id: i64) -> i64 {
    PageRevisionService::get_latest(runner.context(), site_id, page_id)
        .await
        .expect("latest revision lookup should succeed")
        .revision_id
}

async fn set_scope(runner: &TestRunner, site_id: i64) {
    MirrorScopeService::set(
        runner.context(),
        SetMirrorScope {
            site_id,
            scope: String::from("full"),
            source_pin: Some(String::from("corpus-run-test")),
            inventoried_source_count: 2,
            declared_extras: vec![],
            consumed_slugs: vec![],
        },
    )
    .await
    .expect("mirror scope should record");
}

fn set_admin_context(runner: &mut TestRunner, site_id: i64) {
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: None,
    });
}

#[tokio::test]
async fn reconcile_tombstones_source_removed_pages() {
    let runner = TestRunner::setup().await;
    let tag = Uuid::new_v4();
    let site_id = import_mirror_site(&runner, &tag).await;
    let gone = import_mirror_page(&runner, site_id, &tag, "gone", 0).await;
    let kept = import_mirror_page(&runner, site_id, &tag, "kept", 1).await;
    set_scope(&runner, site_id).await;

    let output = MirrorScopeService::reconcile(
        runner.context(),
        ADMIN_USER_ID,
        ReconcileMirrorPages {
            site_id,
            deletes: vec![ReconcilePageDelete {
                page: Reference::Id(gone),
                last_revision_id: latest_revision_id(&runner, site_id, gone).await,
                revision_comments: "source page removed".to_owned(),
            }],
            renames: vec![],
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("reconciliation should apply");

    assert_eq!(output.applied_deletes, 1);
    assert_eq!(output.applied_renames, 0);
    assert_eq!(output.failed, 0);

    assert!(
        PageService::get(runner.context(), site_id, Reference::Id(gone),)
            .await
            .is_err(),
        "tombstoned page must not resolve",
    );
    PageService::get(runner.context(), site_id, Reference::Id(kept))
        .await
        .expect("untouched page must still resolve");
}

#[tokio::test]
async fn reconcile_moves_source_renamed_pages_and_consumes_old_slug() {
    let runner = TestRunner::setup().await;
    let tag = Uuid::new_v4();
    let site_id = import_mirror_site(&runner, &tag).await;
    let moved = import_mirror_page(&runner, site_id, &tag, "old-name", 2).await;
    set_scope(&runner, site_id).await;

    let new_slug = format!("reconcile-new-name-{tag}");
    let output = MirrorScopeService::reconcile(
        runner.context(),
        ADMIN_USER_ID,
        ReconcileMirrorPages {
            site_id,
            deletes: vec![],
            renames: vec![ReconcilePageRename {
                page: Reference::Id(moved),
                new_slug: new_slug.clone(),
                last_revision_id: latest_revision_id(&runner, site_id, moved).await,
                revision_comments: "source page renamed".to_owned(),
            }],
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("reconciliation should apply");

    assert_eq!(output.applied_renames, 1);
    assert_eq!(output.failed, 0);

    let page = PageService::get(
        runner.context(),
        site_id,
        Reference::Slug(Cow::Borrowed(new_slug.as_str())),
    )
    .await
    .expect("moved page must resolve under its new slug");
    assert_eq!(page.page_id, moved);

    let old_slug = format!("reconcile-old-name-{tag}");
    assert!(
        PageService::get(
            runner.context(),
            site_id,
            Reference::Slug(Cow::Borrowed(old_slug.as_str())),
        )
        .await
        .is_err(),
        "renamed-away slug must not resolve",
    );
    assert!(
        MirrorScopeService::is_consumed(runner.context(), site_id, &old_slug)
            .await
            .expect("consumed lookup should succeed"),
        "renamed-away slug must be recorded consumed",
    );
}

#[tokio::test]
async fn reconcile_rerun_records_failures_without_duplicates() {
    let runner = TestRunner::setup().await;
    let tag = Uuid::new_v4();
    let site_id = import_mirror_site(&runner, &tag).await;
    let gone = import_mirror_page(&runner, site_id, &tag, "gone-twice", 3).await;
    let moved = import_mirror_page(&runner, site_id, &tag, "old-twice", 4).await;
    set_scope(&runner, site_id).await;

    let new_slug = format!("reconcile-new-twice-{tag}");
    let first = MirrorScopeService::reconcile(
        runner.context(),
        ADMIN_USER_ID,
        ReconcileMirrorPages {
            site_id,
            deletes: vec![ReconcilePageDelete {
                page: Reference::Id(gone),
                last_revision_id: latest_revision_id(&runner, site_id, gone).await,
                revision_comments: "source page removed".to_owned(),
            }],
            renames: vec![ReconcilePageRename {
                page: Reference::Id(moved),
                new_slug: new_slug.clone(),
                last_revision_id: latest_revision_id(&runner, site_id, moved).await,
                revision_comments: "source page renamed".to_owned(),
            }],
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("first reconciliation should apply");
    assert_eq!(first.failed, 0);

    let second = MirrorScopeService::reconcile(
        runner.context(),
        ADMIN_USER_ID,
        ReconcileMirrorPages {
            site_id,
            deletes: vec![ReconcilePageDelete {
                page: Reference::Id(gone),
                last_revision_id: latest_revision_id(&runner, site_id, moved).await,
                revision_comments: "source page removed".to_owned(),
            }],
            renames: vec![ReconcilePageRename {
                page: Reference::Id(moved),
                new_slug,
                last_revision_id: latest_revision_id(&runner, site_id, moved).await,
                revision_comments: "source page renamed".to_owned(),
            }],
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("second reconciliation should report, not abort");

    assert_eq!(second.applied_deletes, 0);
    assert_eq!(second.applied_renames, 0);
    assert_eq!(second.failed, 2);
    assert!(second.items.iter().all(|item| !item.ok));
}

#[tokio::test]
async fn reconcile_requires_an_existing_scope_record() {
    let runner = TestRunner::setup().await;
    let tag = Uuid::new_v4();
    let site_id = import_mirror_site(&runner, &tag).await;
    let gone = import_mirror_page(&runner, site_id, &tag, "unscoped", 5).await;

    let error = MirrorScopeService::reconcile(
        runner.context(),
        ADMIN_USER_ID,
        ReconcileMirrorPages {
            site_id,
            deletes: vec![ReconcilePageDelete {
                page: Reference::Id(gone),
                last_revision_id: latest_revision_id(&runner, site_id, gone).await,
                revision_comments: "source page removed".to_owned(),
            }],
            renames: vec![],
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect_err("reconciliation without a scope record must fail");

    assert_contains_error!(error, ErrorType::Site);
}

#[tokio::test]
async fn reconcile_endpoint_requires_platform_staff() {
    let mut runner = TestRunner::setup().await;
    let tag = Uuid::new_v4();
    let site_id = import_mirror_site(&runner, &tag).await;
    set_scope(&runner, site_id).await;

    let error = run_endpoint_err!(
        runner,
        mirror_scope_reconcile,
        json!({
            "site_id": site_id,
            "deletes": [],
            "renames": [],
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(error, ErrorType::PermissionDenied);

    set_admin_context(&mut runner, site_id);
    let output = run_endpoint!(
        runner,
        mirror_scope_reconcile,
        json!({
            "site_id": site_id,
            "deletes": [],
            "renames": [],
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(output.applied_deletes, 0);
    assert_eq!(output.failed, 0);
}
