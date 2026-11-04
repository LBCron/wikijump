/*
 * tests/blob.rs
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
use cuid2::cuid;
use deepwell::constants::{ADMIN_USER_ID, SYSTEM_USER_ID};
use deepwell::error::prelude::*;
use deepwell::hash::{BlobHash, blob_hash_to_hex, sha512_hash};
use deepwell::license::License;
use deepwell::models::blob_blacklist::{self, Entity as BlobBlacklistTable};
use deepwell::models::blob_pending::{self, Entity as BlobPendingTable};
use deepwell::models::file;
use deepwell::models::file_revision;
use deepwell::models::user;
use deepwell::services::page::{CreatePage, DeletePage, PageService};
use deepwell::services::permission::PermissionService;
use deepwell::services::role::{
    GrantUserRoleInput, InternalCreateRoleInput, RoleService, UpdateRolePermissionsInput,
};
use deepwell::services::site::{CreateSite, SiteService};
use deepwell::services::user::{CreateUser, UserService};
use deepwell::services::{BlobService, RequestContext};
use deepwell::types::{
    Action, FileRevisionType, Permission, Reference, Resource, UserType,
};
use sea_orm::{ActiveModelTrait, ActiveValue::Set, EntityTrait};
use serde_json::json;
use str_macro::str;

const TEST_BLOB_HASH: &str = "11111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111111";
const SECURITY_600_DATA: &[u8] = b"issue 600 blacklisted upload fixture";

async fn cleanup_blacklisted_upload(
    runner: &TestRunner,
    pending_blob_id: &str,
    s3_path: &str,
    s3_hash: BlobHash,
) {
    BlobPendingTable::delete_by_id(pending_blob_id)
        .exec(&runner.state().database)
        .await
        .expect("pending blob fixture cleanup should succeed");
    BlobBlacklistTable::delete_by_id(s3_hash.to_vec())
        .exec(&runner.state().database)
        .await
        .expect("blob blacklist fixture cleanup should succeed");

    let temporary = runner
        .state()
        .s3_files_bucket
        .delete_object(s3_path)
        .await
        .expect("temporary blob fixture cleanup should succeed");
    assert_eq!(temporary.status_code(), 204);

    let permanent = runner
        .state()
        .s3_files_bucket
        .delete_object(blob_hash_to_hex(&s3_hash))
        .await
        .expect("permanent blob fixture cleanup should succeed");
    assert_eq!(permanent.status_code(), 204);
}

async fn prepare_blacklisted_upload(runner: &TestRunner) -> (String, String, BlobHash) {
    let pending_blob_id = cuid();
    let s3_path = format!("uploads/{pending_blob_id}");
    let s3_hash = sha512_hash(SECURITY_600_DATA);

    cleanup_blacklisted_upload(runner, &pending_blob_id, &s3_path, s3_hash).await;

    let temporary = runner
        .state()
        .s3_files_bucket
        .put_object(&s3_path, SECURITY_600_DATA)
        .await
        .expect("temporary blob fixture upload should succeed");
    assert_eq!(temporary.status_code(), 200);

    let created_at = time::OffsetDateTime::now_utc();
    blob_pending::ActiveModel {
        external_id: Set(pending_blob_id.clone()),
        created_by: Set(ADMIN_USER_ID),
        created_at: Set(created_at),
        expires_at: Set(created_at + time::Duration::minutes(5)),
        expected_length: Set(SECURITY_600_DATA
            .len()
            .try_into()
            .expect("fixture length fits")),
        s3_path: Set(s3_path.clone()),
        s3_hash: Set(None),
        presign_url: Set("not-used-in-test".to_owned()),
        site_id: Set(None),
        page_id: Set(None),
        content_type_label: Set(None),
        content_type_description: Set(None),
    }
    .insert(&runner.state().database)
    .await
    .expect("pending blob fixture insert should succeed");

    blob_blacklist::ActiveModel {
        s3_hash: Set(s3_hash.to_vec()),
        created_at: Set(created_at),
        created_by: Set(ADMIN_USER_ID),
    }
    .insert(&runner.state().database)
    .await
    .expect("blob blacklist fixture insert should succeed");

    (pending_blob_id, s3_path, s3_hash)
}

#[tokio::test]
async fn blob_hard_delete_requires_admin_request_context() {
    let runner = TestRunner::setup().await;

    let preview_error = run_endpoint_err!(
        runner,
        blob_hard_delete_preview,
        json!({ "s3_hash": TEST_BLOB_HASH }),
    );
    assert_contains_error!(preview_error, ErrorType::PermissionDenied);

    let confirm_error = run_endpoint_err!(
        runner,
        blob_hard_delete_confirm,
        json!({ "s3_hash": TEST_BLOB_HASH, "user_id": ADMIN_USER_ID }),
    );
    assert_contains_error!(confirm_error, ErrorType::PermissionDenied);
}

#[tokio::test]
async fn blob_hard_delete_uses_admin_request_actor() {
    let mut runner = TestRunner::setup().await;
    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        ..Default::default()
    });

    let preview = run_endpoint!(
        runner,
        blob_hard_delete_preview,
        json!({ "s3_hash": TEST_BLOB_HASH }),
    );
    assert_eq!(preview.total_revisions, 0);
    assert_eq!(preview.total_files, 0);

    let confirm = run_endpoint!(
        runner,
        blob_hard_delete_confirm,
        json!({ "s3_hash": TEST_BLOB_HASH, "user_id": 12345 }),
    );
    assert_eq!(confirm.total_revisions, 0);
    assert_eq!(confirm.total_files, 0);

    let hash = hex::decode(TEST_BLOB_HASH).expect("valid test blob hash");
    let blacklist = BlobBlacklistTable::find_by_id(hash)
        .one(runner.context().transaction())
        .await
        .expect("blob blacklist lookup should succeed")
        .expect("hard delete should blacklist the blob hash");
    assert_eq!(blacklist.created_by, ADMIN_USER_ID);
}

#[tokio::test]
async fn blob_blacklist_mutations_require_admin_request_context() {
    let mut runner = TestRunner::setup().await;

    let add_error = run_endpoint_err!(
        runner,
        blob_blacklist_add,
        json!({ "s3_hash": TEST_BLOB_HASH, "user_id": ADMIN_USER_ID }),
    );
    assert_contains_error!(add_error, ErrorType::PermissionDenied);

    let remove_error = run_endpoint_err!(
        runner,
        blob_blacklist_remove,
        json!({ "s3_hash": TEST_BLOB_HASH }),
    );
    assert_contains_error!(remove_error, ErrorType::PermissionDenied);

    runner.set_request_context(RequestContext {
        user_id: Some(12345),
        ..Default::default()
    });
    let non_admin_add_error = run_endpoint_err!(
        runner,
        blob_blacklist_add,
        json!({ "s3_hash": TEST_BLOB_HASH }),
    );
    assert_contains_error!(non_admin_add_error, ErrorType::PermissionDenied);

    let non_admin_remove_error = run_endpoint_err!(
        runner,
        blob_blacklist_remove,
        json!({ "s3_hash": TEST_BLOB_HASH }),
    );
    assert_contains_error!(non_admin_remove_error, ErrorType::PermissionDenied);
}

#[tokio::test]
async fn blob_blacklist_uses_admin_request_actor() {
    let mut runner = TestRunner::setup().await;
    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        ..Default::default()
    });

    run_endpoint!(
        runner,
        blob_blacklist_add,
        json!({ "s3_hash": TEST_BLOB_HASH, "user_id": 12345 }),
    );

    let hash = hex::decode(TEST_BLOB_HASH).expect("valid test blob hash");
    let blacklist = BlobBlacklistTable::find_by_id(hash.clone())
        .one(runner.context().transaction())
        .await
        .expect("blob blacklist lookup should succeed")
        .expect("admin request should blacklist the blob hash");
    assert_eq!(blacklist.created_by, ADMIN_USER_ID);

    run_endpoint!(
        runner,
        blob_blacklist_remove,
        json!({ "s3_hash": TEST_BLOB_HASH }),
    );
    let removed = BlobBlacklistTable::find_by_id(hash)
        .one(runner.context().transaction())
        .await
        .expect("blob blacklist lookup should succeed");
    assert!(removed.is_none());
}

async fn create_user(runner: &TestRunner, label: &str) -> i64 {
    UserService::create(
        runner.context(),
        CreateUser {
            user_type: UserType::Regular,
            name: format!("Blob Authz {label} {}", cuid()),
            email: format!("blob-authz-{label}-{}@email.com", cuid()),
            locales: vec![str!("en")],
            password: String::from("password-fixture"),
            bypass_filter: true,
            bypass_email_verification: true,
            override_user_id: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("failed to create blob authz test user")
    .user_id
}

async fn grant_page_view(runner: &TestRunner, site_id: i64, user_id: i64) {
    let ctx = runner.context();
    let role_id = RoleService::create(
        ctx,
        InternalCreateRoleInput {
            site_id,
            name: format!("Blob Authz Viewer {}", cuid()),
            description: None,
            is_virtual: false,
            parent_role_id: None,
            creating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("failed to create blob authz role")
    .role_id;

    PermissionService::update_permissions_for_role(
        ctx,
        UpdateRolePermissionsInput {
            site_id,
            role_reference: Reference::Id(role_id),
            new_permissions: vec![Permission {
                resource_type: Resource::Page,
                resource_category: None,
                action: Action::View,
            }],
            cascade_removals: false,
            updating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("failed to set blob authz role permissions");

    RoleService::grant_role_to_user(
        ctx,
        GrantUserRoleInput {
            site_id,
            user_id,
            role_id,
            assigning_user_id: SYSTEM_USER_ID,
            expires_at: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("failed to grant blob authz role");
}

fn set_actor(runner: &mut TestRunner, user_id: Option<i64>) {
    runner.set_request_context(RequestContext {
        user_id,
        ..Default::default()
    });
}

async fn put_blob(runner: &TestRunner, hash_hex: &str, data: &[u8], mime: &str) {
    let response = runner
        .state()
        .s3_files_bucket
        .put_object_with_content_type(hash_hex, data, mime)
        .await
        .expect("blob fixture upload should succeed");
    assert_eq!(response.status_code(), 200);
}

async fn delete_blob_object(runner: &TestRunner, hash_hex: &str) {
    let response = runner
        .state()
        .s3_files_bucket
        .delete_object(hash_hex)
        .await
        .expect("blob fixture cleanup should succeed");
    assert_eq!(response.status_code(), 204);
}

async fn insert_file_with_blob(
    runner: &TestRunner,
    site_id: i64,
    page_id: i64,
    user_id: i64,
    name: &str,
    hash: BlobHash,
    size: i64,
) -> i64 {
    let txn = runner.context().transaction();
    let file = file::ActiveModel {
        name: Set(name.to_owned()),
        page_id: Set(page_id),
        site_id: Set(site_id),
        ..Default::default()
    }
    .insert(txn)
    .await
    .expect("file fixture row should insert");

    file_revision::ActiveModel {
        revision_type: Set(FileRevisionType::Create),
        revision_number: Set(0),
        file_id: Set(file.file_id),
        page_id: Set(page_id),
        site_id: Set(site_id),
        user_id: Set(user_id),
        name: Set(name.to_owned()),
        s3_hash: Set(hash.to_vec()),
        mime: Set(String::from("text/plain")),
        size: Set(size),
        content_type_label: Set(None),
        content_type_description: Set(None),
        changes: Set(vec![
            String::from("page"),
            String::from("name"),
            String::from("blob"),
            String::from("mime"),
        ]),
        comments: Set(String::new()),
        hidden: Set(Vec::new()),
        ..Default::default()
    }
    .insert(txn)
    .await
    .expect("file revision fixture row should insert");

    file.file_id
}

#[tokio::test]
async fn blob_get_requires_read_access_to_owning_content() {
    let mut runner = TestRunner::setup().await;

    let viewer = create_user(&runner, "viewer").await;
    let outsider = create_user(&runner, "outsider").await;
    let avatar_user = create_user(&runner, "avatar").await;

    let site_id = {
        let site = SiteService::create(
            runner.context(),
            CreateSite {
                slug: format!("blob-authz-{}", cuid()),
                name: String::from("Blob Authz Site"),
                tagline: String::new(),
                description: String::from("blob get authorization fixture"),
                default_page: None,
                layout: None,
                license: License::CcBySa40,
                locale: String::from("en"),
                ip_address: common::IP_ADDRESS,
            },
            None,
        )
        .await
        .expect("failed to create blob authz site");
        site.site_id
    };
    let foreign_site_id = {
        let site = SiteService::create(
            runner.context(),
            CreateSite {
                slug: format!("blob-authz-foreign-{}", cuid()),
                name: String::from("Blob Authz Foreign Site"),
                tagline: String::new(),
                description: String::from("blob get authorization foreign fixture"),
                default_page: None,
                layout: None,
                license: License::CcBySa40,
                locale: String::from("en"),
                ip_address: common::IP_ADDRESS,
            },
            None,
        )
        .await
        .expect("failed to create blob authz foreign site");
        site.site_id
    };

    grant_page_view(&runner, site_id, viewer).await;

    async fn create_page(
        runner: &TestRunner,
        site_id: i64,
    ) -> deepwell::services::page::CreatePageOutput {
        PageService::create(
            runner.context(),
            CreatePage {
                site_id,
                wikitext: String::from("blob authz page"),
                title: String::from("Blob Authz Page"),
                alt_title: None,
                tags: Vec::new(),
                slug: format!("blob-authz-{}", cuid()),
                layout: None,
                revision_comments: String::new(),
                user_id: SYSTEM_USER_ID,
                bypass_filter: true,
                ip_address: common::IP_ADDRESS,
            },
        )
        .await
        .expect("failed to create blob authz page")
    }

    const FILE_DATA: &[u8] = b"blob get authorization fixture file";
    let file_hash = sha512_hash(FILE_DATA);
    let file_hex = blob_hash_to_hex(&file_hash).to_string();
    put_blob(&runner, &file_hex, FILE_DATA, "text/plain").await;

    let page = create_page(&runner, site_id).await;
    insert_file_with_blob(
        &runner,
        site_id,
        page.page_id,
        viewer,
        "authz.txt",
        file_hash,
        FILE_DATA.len().try_into().expect("fixture length fits"),
    )
    .await;

    set_actor(&mut runner, Some(viewer));
    let blob = run_endpoint!(runner, blob_get, json!(file_hex));
    assert_eq!(blob.data.as_slice(), FILE_DATA);

    runner.set_request_context(RequestContext {
        user_id: Some(viewer),
        site_id: Some(foreign_site_id),
        ..Default::default()
    });
    let blob = run_endpoint!(runner, blob_get, json!(file_hex));
    assert_eq!(blob.data.as_slice(), FILE_DATA);

    set_actor(&mut runner, None);
    let error = run_endpoint_err!(runner, blob_get, json!(file_hex));
    assert_contains_error!(error, ErrorType::BlobNotFound);

    set_actor(&mut runner, Some(outsider));
    let error = run_endpoint_err!(runner, blob_get, json!(file_hex));
    assert_contains_error!(error, ErrorType::BlobNotFound);

    runner.set_request_context(RequestContext {
        user_id: Some(outsider),
        site_id: Some(foreign_site_id),
        ..Default::default()
    });
    let error = run_endpoint_err!(runner, blob_get, json!(file_hex));
    assert_contains_error!(error, ErrorType::BlobNotFound);

    const DELETED_FILE_DATA: &[u8] = b"blob get authorization deleted file";
    let deleted_file_hash = sha512_hash(DELETED_FILE_DATA);
    let deleted_file_hex = blob_hash_to_hex(&deleted_file_hash).to_string();
    put_blob(&runner, &deleted_file_hex, DELETED_FILE_DATA, "text/plain").await;

    let second_page = create_page(&runner, site_id).await;
    let deleted_file_id = insert_file_with_blob(
        &runner,
        site_id,
        second_page.page_id,
        viewer,
        "authz-deleted.txt",
        deleted_file_hash,
        DELETED_FILE_DATA
            .len()
            .try_into()
            .expect("fixture length fits"),
    )
    .await;

    set_actor(&mut runner, Some(viewer));
    let blob = run_endpoint!(runner, blob_get, json!(deleted_file_hex));
    assert_eq!(blob.data.as_slice(), DELETED_FILE_DATA);

    file::ActiveModel {
        file_id: Set(deleted_file_id),
        deleted_at: Set(Some(time::OffsetDateTime::now_utc())),
        ..Default::default()
    }
    .update(runner.context().transaction())
    .await
    .expect("file fixture soft delete should succeed");

    let error = run_endpoint_err!(runner, blob_get, json!(deleted_file_hex));
    assert_contains_error!(error, ErrorType::BlobNotFound);

    PageService::delete(
        runner.context(),
        DeletePage {
            site_id,
            page: Reference::Id(page.page_id),
            last_revision_id: page.revision_id,
            revision_comments: String::new(),
            user_id: viewer,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("blob authz page delete should succeed");

    set_actor(&mut runner, Some(viewer));
    let error = run_endpoint_err!(runner, blob_get, json!(file_hex));
    assert_contains_error!(error, ErrorType::BlobNotFound);

    set_actor(&mut runner, None);
    let error = run_endpoint_err!(runner, blob_get, json!(file_hex));
    assert_contains_error!(error, ErrorType::BlobNotFound);

    set_actor(&mut runner, Some(ADMIN_USER_ID));
    let blob = run_endpoint!(runner, blob_get, json!(file_hex));
    assert_eq!(blob.data.as_slice(), FILE_DATA);

    const AVATAR_DATA: &[u8] = b"blob get authorization avatar";
    let avatar_hash = sha512_hash(AVATAR_DATA);
    let avatar_hex = blob_hash_to_hex(&avatar_hash).to_string();
    put_blob(&runner, &avatar_hex, AVATAR_DATA, "image/png").await;

    user::ActiveModel {
        user_id: Set(avatar_user),
        avatar_s3_hash: Set(Some(avatar_hash.to_vec())),
        ..Default::default()
    }
    .update(runner.context().transaction())
    .await
    .expect("avatar fixture update should succeed");

    set_actor(&mut runner, None);
    let blob = run_endpoint!(runner, blob_get, json!(avatar_hex));
    assert_eq!(blob.data.as_slice(), AVATAR_DATA);

    set_actor(&mut runner, Some(outsider));
    let blob = run_endpoint!(runner, blob_get, json!(avatar_hex));
    assert_eq!(blob.data.as_slice(), AVATAR_DATA);

    user::ActiveModel {
        user_id: Set(avatar_user),
        deleted_at: Set(Some(time::OffsetDateTime::now_utc())),
        ..Default::default()
    }
    .update(runner.context().transaction())
    .await
    .expect("avatar user soft delete should succeed");

    set_actor(&mut runner, None);
    let error = run_endpoint_err!(runner, blob_get, json!(avatar_hex));
    assert_contains_error!(error, ErrorType::BlobNotFound);

    set_actor(&mut runner, Some(ADMIN_USER_ID));
    let blob = run_endpoint!(runner, blob_get, json!(avatar_hex));
    assert_eq!(blob.data.as_slice(), AVATAR_DATA);

    const ORPHAN_DATA: &[u8] = b"blob get authorization orphan";
    let orphan_hash = sha512_hash(ORPHAN_DATA);
    let orphan_hex = blob_hash_to_hex(&orphan_hash).to_string();
    put_blob(
        &runner,
        &orphan_hex,
        ORPHAN_DATA,
        "application/octet-stream",
    )
    .await;

    set_actor(&mut runner, Some(viewer));
    let error = run_endpoint_err!(runner, blob_get, json!(orphan_hex));
    assert_contains_error!(error, ErrorType::BlobNotFound);

    set_actor(&mut runner, None);
    let error = run_endpoint_err!(runner, blob_get, json!(orphan_hex));
    assert_contains_error!(error, ErrorType::BlobNotFound);

    set_actor(&mut runner, Some(ADMIN_USER_ID));
    let blob = run_endpoint!(runner, blob_get, json!(orphan_hex));
    assert_eq!(blob.data.as_slice(), ORPHAN_DATA);

    delete_blob_object(&runner, &file_hex).await;
    delete_blob_object(&runner, &deleted_file_hex).await;
    delete_blob_object(&runner, &avatar_hex).await;
    delete_blob_object(&runner, &orphan_hex).await;
}

#[tokio::test]
async fn blob_finish_upload_rejects_blacklisted_content_before_permanent_write() {
    let runner = TestRunner::setup().await;
    let (pending_blob_id, s3_path, s3_hash) = prepare_blacklisted_upload(&runner).await;

    let output = BlobService::finish_unscoped_upload(
        runner.context(),
        ADMIN_USER_ID,
        &pending_blob_id,
    )
    .await;
    let permanent = BlobService::get_optional(runner.context(), &s3_hash).await;
    let pending = BlobPendingTable::find_by_id(&pending_blob_id)
        .one(&runner.state().database)
        .await;
    let temporary = runner.state().s3_files_bucket.get_object(&s3_path).await;

    cleanup_blacklisted_upload(&runner, &pending_blob_id, &s3_path, s3_hash).await;

    let error = output.expect_err("blacklisted blob finalization should fail");
    assert_contains_error!(
        error,
        ErrorType::BlobBlacklisted(found) if *found == s3_hash,
    );
    assert_eq!(
        permanent.expect("permanent blob lookup should succeed"),
        None,
        "blacklisted bytes must not be restored to permanent storage",
    );
    assert_eq!(
        pending.expect("pending blob lookup should succeed"),
        None,
        "blacklisted upload should remove its pending database row",
    );
    assert_eq!(
        temporary
            .expect("temporary blob lookup should succeed")
            .status_code(),
        404,
        "blacklisted upload should remove its temporary object",
    );
}
