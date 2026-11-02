#[macro_use]
mod common;

use self::common::TestRunner;
use cuid2::cuid;
use deepwell::constants::ADMIN_USER_ID;
use deepwell::error::ErrorType;
use deepwell::hash::{blob_hash_to_hex, sha512_hash};
use deepwell::license::License;
use deepwell::models::blob_pending;
use deepwell::services::RequestContext;
use deepwell::services::blob::EMPTY_BLOB_HASH;
use deepwell::services::file::{CreateFile, FileService};
use deepwell::services::file_revision::FileRevisionService;
use deepwell::services::import::{
    ImportFile, ImportPage, ImportService, ImportSite, ImportUser, ImportedUserType,
};
use deepwell::services::mirror_scope::{
    MirrorScopeService, ReconcileMirrorFiles, SetMirrorScope, SourceFileExpectation,
};
use deepwell::types::Reference;
use ftml::data::KarmaLevel;
use sea_orm::{ActiveModelTrait, ActiveValue::Set};
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

fn unique_site_id(tag: &Uuid) -> i64 {
    5_100_000_000
        + i64::from(
            u32::from_be_bytes(tag.as_bytes()[..4].try_into().unwrap()) % 50_000_000,
        )
}

fn unique_page_id(tag: &Uuid, salt: u32) -> i64 {
    5_200_000_000
        + i64::from(
            u32::from_be_bytes(tag.as_bytes()[..4].try_into().unwrap())
                .wrapping_add(salt)
                % 50_000_000,
        )
}

fn unique_user_id(tag: &Uuid, salt: u32) -> i32 {
    16_000_000
        + i32::try_from(
            u32::from_be_bytes(tag.as_bytes()[..4].try_into().unwrap())
                .wrapping_add(salt)
                % 1_000_000,
        )
        .unwrap()
}

async fn import_mirror_site(runner: &TestRunner, tag: &Uuid) -> i64 {
    ImportService::add_site(
        runner.context(),
        ImportSite {
            site_id: unique_site_id(tag),
            created_at: OffsetDateTime::UNIX_EPOCH,
            name: format!("File reconcile mirror {}", cuid()),
            slug: format!("file-reconcile-mirror-{}", cuid()),
            tagline: format!("File reconcile fixture {}", cuid()),
            description: "File reconciliation fixture site".to_owned(),
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
    ImportService::add_page(
        runner.context(),
        ImportPage {
            page_id,
            site_id,
            created_at: OffsetDateTime::UNIX_EPOCH,
            slug: format!("file-reconcile-{label}-{tag}"),
            locked: false,
            discussion_thread_id: None,
            meta_tags: vec![],
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("mirror page should import");
    page_id
}

async fn import_source_uploader(runner: &TestRunner, tag: &Uuid, label: &str) -> i64 {
    let user_id = unique_user_id(tag, label.len() as u32);
    ImportService::add_user(
        runner.context(),
        ImportUser {
            user_id,
            created_at: OffsetDateTime::UNIX_EPOCH,
            fetched_at: OffsetDateTime::UNIX_EPOCH + time::Duration::seconds(1),
            wikidot_user_type: ImportedUserType::Extant {
                name: format!("File Reconcile {label} {tag}"),
                slug: format!("file-reconcile-{label}-{tag}"),
            },
            avatar_uploaded_blob_id: None,
            real_name: None,
            gender: None,
            birthday: None,
            location: None,
            biography: None,
            website: None,
            karma: KarmaLevel::Three,
            is_pro: false,
            upsert: false,
            delete_old_if_same_name: false,
            importing_user_id: ADMIN_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("source uploader should import");
    i64::from(user_id)
}

async fn import_source_file(
    runner: &TestRunner,
    site_id: i64,
    page_id: i64,
    name: &str,
    data: Vec<u8>,
    user_id: i64,
) -> (i64, String) {
    let size = i64::try_from(data.len()).expect("fixture data should fit");
    let hash_hex = blob_hash_to_hex(&sha512_hash(&data)).to_string();
    ImportService::add_file(
        runner.context(),
        ImportFile {
            site_id,
            page_id,
            name: name.to_owned(),
            data,
            size,
            s3_hash: hash_hex.clone(),
            user_id,
            created_at: OffsetDateTime::UNIX_EPOCH,
            revision_comments: format!("Source import of {name}"),
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("source file should import");
    let file_id = FileService::get_id(
        runner.context(),
        deepwell::services::file::GetFile {
            site_id,
            page_id,
            file: Reference::Slug(std::borrow::Cow::Borrowed(name)),
        },
    )
    .await
    .expect("imported file should resolve");
    runner
        .state()
        .s3_files_bucket
        .delete_object(&hash_hex)
        .await
        .ok();
    (file_id, hash_hex)
}

async fn insert_local_file(
    runner: &TestRunner,
    site_id: i64,
    page_id: i64,
    name: &str,
    label: &str,
) -> i64 {
    let pending_blob_id = cuid();
    blob_pending::ActiveModel {
        external_id: Set(pending_blob_id.clone()),
        created_by: Set(ADMIN_USER_ID),
        created_at: Set(OffsetDateTime::now_utc()),
        expires_at: Set(OffsetDateTime::now_utc() + time::Duration::minutes(5)),
        expected_length: Set(0),
        s3_path: Set(format!("uploads/reconcile-{label}-{pending_blob_id}")),
        s3_hash: Set(Some(EMPTY_BLOB_HASH.to_vec())),
        presign_url: Set("https://uploads.example.test/reconcile".to_owned()),
        site_id: Set(Some(site_id)),
        page_id: Set(Some(page_id)),
        content_type_label: Set(Some("text".to_owned())),
        content_type_description: Set(Some("text/plain".to_owned())),
    }
    .insert(runner.context().transaction())
    .await
    .expect("pending blob fixture should insert");
    let input: CreateFile = serde_json::from_value(json!({
        "site_id": site_id,
        "page_id": page_id,
        "name": name,
        "uploaded_blob_id": pending_blob_id,
        "revision_comments": "local fixture, not source data",
        "user_id": ADMIN_USER_ID,
        "bypass_filter": false,
        "ip_address": common::IP_ADDRESS,
    }))
    .expect("local file input should deserialize");
    FileService::create(runner.context(), input)
        .await
        .expect("local file should create")
        .file_id
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

fn set_admin_context(runner: &mut TestRunner, site_id: i64, page_id: i64) {
    runner.set_request_context(RequestContext {
        session: None,
        user_id: Some(ADMIN_USER_ID),
        site_id: Some(site_id),
        page_reference: Some(Reference::Id(page_id)),
    });
}

fn expectation(
    name: &str,
    hash_hex: Option<String>,
    size: Option<i64>,
) -> SourceFileExpectation {
    SourceFileExpectation {
        name: name.to_owned(),
        s3_hash_hex: hash_hex,
        size,
    }
}

#[tokio::test]
async fn reconcile_tombstones_source_removed_files_but_keeps_inventory() {
    let runner = TestRunner::setup().await;
    let tag = Uuid::new_v4();
    let site_id = import_mirror_site(&runner, &tag).await;
    let page_id = import_mirror_page(&runner, site_id, &tag, "inventory", 0).await;
    let uploader = import_source_uploader(&runner, &tag, "uploader").await;
    set_scope(&runner, site_id).await;

    let (kept_imported, kept_hash) = import_source_file(
        &runner,
        site_id,
        page_id,
        "kept.jpg",
        b"reconcile kept bytes".to_vec(),
        uploader,
    )
    .await;
    let kept_local = insert_local_file(&runner, site_id, page_id, "local.txt", "a").await;
    let dropped_imported = import_source_file(
        &runner,
        site_id,
        page_id,
        "dropped.jpg",
        b"reconcile dropped bytes".to_vec(),
        uploader,
    )
    .await;
    let _dropped_local =
        insert_local_file(&runner, site_id, page_id, "stale.txt", "b").await;

    let output = MirrorScopeService::reconcile_files(
        runner.context(),
        ADMIN_USER_ID,
        ReconcileMirrorFiles {
            site_id,
            page: Reference::Id(page_id),
            files: vec![
                expectation("kept.jpg", Some(kept_hash), Some(20)),
                expectation("local.txt", None, None),
                expectation("source-only.png", None, None),
            ],
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("reconciliation should apply");

    assert_eq!(output.tombstoned, 2, "both source-removed rows must go");
    assert_eq!(output.kept, 2);
    assert_eq!(output.failed, 0);
    assert_eq!(output.missing, vec![String::from("source-only.png")]);
    assert!(
        output
            .items
            .iter()
            .filter(|item| item.op == "tombstone")
            .all(|item| item.ok && item.revision_number.is_some()),
        "tombstones must record their new revision numbers",
    );

    for gone in [dropped_imported.0, _dropped_local] {
        assert!(
            FileService::get(
                runner.context(),
                deepwell::services::file::GetFile {
                    site_id,
                    page_id,
                    file: Reference::Id(gone),
                },
            )
            .await
            .is_err(),
            "tombstoned file {gone} must not resolve",
        );
    }
    for kept in [kept_imported, kept_local] {
        FileService::get(
            runner.context(),
            deepwell::services::file::GetFile {
                site_id,
                page_id,
                file: Reference::Id(kept),
            },
        )
        .await
        .expect("kept file must still resolve");
    }
}

#[tokio::test]
async fn reconcile_reports_changed_bytes_without_touching() {
    let runner = TestRunner::setup().await;
    let tag = Uuid::new_v4();
    let site_id = import_mirror_site(&runner, &tag).await;
    let page_id = import_mirror_page(&runner, site_id, &tag, "changed", 1).await;
    let uploader = import_source_uploader(&runner, &tag, "changer").await;
    set_scope(&runner, site_id).await;

    let (changed, _) = import_source_file(
        &runner,
        site_id,
        page_id,
        "changed.jpg",
        b"reconcile original bytes".to_vec(),
        uploader,
    )
    .await;
    let before =
        FileRevisionService::get_latest(runner.context(), site_id, page_id, changed)
            .await
            .expect("latest revision should resolve")
            .revision_number;

    let output = MirrorScopeService::reconcile_files(
        runner.context(),
        ADMIN_USER_ID,
        ReconcileMirrorFiles {
            site_id,
            page: Reference::Id(page_id),
            files: vec![expectation("changed.jpg", Some("ab".repeat(64)), Some(999))],
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("reconciliation should apply");

    assert_eq!(output.tombstoned, 0);
    assert_eq!(output.kept, 0);
    assert_eq!(output.changed, vec![String::from("changed.jpg")]);
    assert_eq!(output.failed, 0);

    let after =
        FileRevisionService::get_latest(runner.context(), site_id, page_id, changed)
            .await
            .expect("latest revision should still resolve")
            .revision_number;
    assert_eq!(before, after, "reported change must not create a revision");
    FileService::get(
        runner.context(),
        deepwell::services::file::GetFile {
            site_id,
            page_id,
            file: Reference::Id(changed),
        },
    )
    .await
    .expect("reported file must stay active");
}

#[tokio::test]
async fn reconcile_files_requires_an_existing_scope_record() {
    let runner = TestRunner::setup().await;
    let tag = Uuid::new_v4();
    let site_id = import_mirror_site(&runner, &tag).await;
    let page_id = import_mirror_page(&runner, site_id, &tag, "unscoped", 2).await;

    let error = MirrorScopeService::reconcile_files(
        runner.context(),
        ADMIN_USER_ID,
        ReconcileMirrorFiles {
            site_id,
            page: Reference::Id(page_id),
            files: vec![],
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect_err("reconciliation without a scope record must fail");

    assert_contains_error!(error, ErrorType::Site);
}

#[tokio::test]
async fn reconcile_files_endpoint_requires_platform_staff() {
    let mut runner = TestRunner::setup().await;
    let tag = Uuid::new_v4();
    let site_id = import_mirror_site(&runner, &tag).await;
    let page_id = import_mirror_page(&runner, site_id, &tag, "gated", 3).await;
    set_scope(&runner, site_id).await;

    let error = run_endpoint_err!(
        runner,
        mirror_scope_reconcile_files,
        json!({
            "site_id": site_id,
            "page": page_id,
            "files": [],
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_contains_error!(error, ErrorType::PermissionDenied);

    set_admin_context(&mut runner, site_id, page_id);
    let output = run_endpoint!(
        runner,
        mirror_scope_reconcile_files,
        json!({
            "site_id": site_id,
            "page": page_id,
            "files": [],
            "ip_address": common::IP_ADDRESS,
        }),
    );
    assert_eq!(output.tombstoned, 0);
    assert_eq!(output.failed, 0);
}
