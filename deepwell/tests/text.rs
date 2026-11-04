/*
 * tests/text.rs
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
use deepwell::hash::{k12_hash, text_hash_to_hex};
use deepwell::license::License;
use deepwell::models::message_draft::{self, Entity as MessageDraftTable};
use deepwell::models::page_revision::{self, Entity as PageRevisionTable};
use deepwell::services::RequestContext;
use deepwell::services::page::{CreatePage, DeletePage, PageService};
use deepwell::services::permission::PermissionService;
use deepwell::services::role::{
    GrantUserRoleInput, InternalCreateRoleInput, RoleService, UpdateRolePermissionsInput,
};
use deepwell::services::site::{CreateSite, SiteService};
use deepwell::services::user::{CreateUser, UserService};
use deepwell::types::{Action, Permission, Reference, Resource, UserType};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter};
use serde_json::json;
use str_macro::str;

#[tokio::test]
async fn text() {
    let mut runner = TestRunner::setup().await;
    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        ..Default::default()
    });

    const TEXT_TO_STORE: &str = "Greetings fine whale! 🐳";
    const TEXT_HASH: &str = "923f4eee1cc5651277830ce7802dafe0";

    let expected_hash = k12_hash(TEXT_TO_STORE.as_bytes());
    let expected_hex_hash = text_hash_to_hex(&expected_hash);

    assert_eq!(
        TEXT_HASH,
        expected_hex_hash.as_str(),
        "Test hash value doesn't match, needs fix",
    );

    let error = run_endpoint_err!(runner, text_get, json!([TEXT_HASH]));
    assert_contains_error!(error, ErrorType::TextNotFound);

    let text_hash = run_endpoint!(runner, text_create, json!([TEXT_TO_STORE]));

    assert_eq!(
        text_hash_to_hex(text_hash.as_ref()),
        expected_hex_hash,
        "Actual text hash does not match expected",
    );

    let text_result = run_endpoint!(runner, text_get, json!([TEXT_HASH]));
    assert_eq!(
        text_result, TEXT_TO_STORE,
        "Actual text contents does not match expected",
    );

    let error = run_endpoint_err!(
        runner,
        text_get,
        json!(["zzzzyyyyxxxxvvvvuuuuttttssssrrrr"]),
    );
    assert!(
        format!("{error:?}").contains("InvalidParams"),
        "JSONRPC InvalidParams error not returned:\n{:?}",
        error,
    );

    let error = run_endpoint_err!(runner, text_get, json!(["aaff0011"]));
    assert_contains_error!(error, ErrorType::BadRequest);
}

async fn create_user(runner: &TestRunner, label: &str) -> i64 {
    UserService::create(
        runner.context(),
        CreateUser {
            user_type: UserType::Regular,
            name: format!("Text Authz {label} {}", cuid()),
            email: format!("text-authz-{label}-{}@email.com", cuid()),
            locales: vec![str!("en")],
            password: String::from("password-fixture"),
            bypass_filter: true,
            bypass_email_verification: true,
            override_user_id: None,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("failed to create text authz test user")
    .user_id
}

async fn grant_page_view(runner: &TestRunner, site_id: i64, user_id: i64) {
    let ctx = runner.context();
    let role_id = RoleService::create(
        ctx,
        InternalCreateRoleInput {
            site_id,
            name: format!("Text Authz Viewer {}", cuid()),
            description: None,
            is_virtual: false,
            parent_role_id: None,
            creating_user_id: SYSTEM_USER_ID,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("failed to create text authz role")
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
    .expect("failed to set text authz role permissions");

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
    .expect("failed to grant text authz role");
}

fn set_actor(runner: &mut TestRunner, user_id: Option<i64>) {
    runner.set_request_context(RequestContext {
        user_id,
        ..Default::default()
    });
}

#[tokio::test]
async fn text_get_requires_read_access_to_owning_content() {
    let mut runner = TestRunner::setup().await;

    let viewer = create_user(&runner, "viewer").await;
    let outsider = create_user(&runner, "outsider").await;
    let sender = create_user(&runner, "sender").await;
    let recipient = create_user(&runner, "recipient").await;

    let site_id = {
        let site = SiteService::create(
            runner.context(),
            CreateSite {
                slug: format!("text-authz-{}", cuid()),
                name: String::from("Text Authz Site"),
                tagline: String::new(),
                description: String::from("text get authorization fixture"),
                default_page: None,
                layout: None,
                license: License::CcBySa40,
                locale: String::from("en"),
                ip_address: common::IP_ADDRESS,
            },
            None,
        )
        .await
        .expect("failed to create text authz site");
        site.site_id
    };

    grant_page_view(&runner, site_id, viewer).await;

    const WIKITEXT: &str = "Text get authorization fixture wikitext";
    let page = PageService::create(
        runner.context(),
        CreatePage {
            site_id,
            wikitext: String::from(WIKITEXT),
            title: String::from("Text Authz Page"),
            alt_title: None,
            tags: Vec::new(),
            slug: format!("text-authz-{}", cuid()),
            layout: None,
            revision_comments: String::new(),
            user_id: SYSTEM_USER_ID,
            bypass_filter: true,
            ip_address: common::IP_ADDRESS,
        },
    )
    .await
    .expect("failed to create text authz page");

    let revision = PageRevisionTable::find()
        .filter(page_revision::Column::PageId.eq(page.page_id))
        .one(runner.context().transaction())
        .await
        .expect("page revision lookup should succeed")
        .expect("page revision should exist");
    let wikitext_hash: [u8; 16] = revision
        .wikitext_hash
        .try_into()
        .expect("wikitext hash should be 16 bytes");
    let wikitext_hex = text_hash_to_hex(&wikitext_hash).to_string();

    set_actor(&mut runner, Some(viewer));
    let text_result = run_endpoint!(runner, text_get, json!([wikitext_hex]));
    assert_eq!(text_result, WIKITEXT);

    set_actor(&mut runner, None);
    let error = run_endpoint_err!(runner, text_get, json!([wikitext_hex]));
    assert_contains_error!(error, ErrorType::TextNotFound);

    set_actor(&mut runner, Some(outsider));
    let error = run_endpoint_err!(runner, text_get, json!([wikitext_hex]));
    assert_contains_error!(error, ErrorType::TextNotFound);

    set_actor(&mut runner, Some(ADMIN_USER_ID));
    let text_result = run_endpoint!(runner, text_get, json!([wikitext_hex]));
    assert_eq!(text_result, WIKITEXT);

    const ORPHAN_TEXT: &str = "Text get authorization orphan text";
    let orphan_hash = run_endpoint!(runner, text_create, json!([ORPHAN_TEXT]));
    let orphan_hex = text_hash_to_hex(orphan_hash.as_ref()).to_string();

    set_actor(&mut runner, Some(viewer));
    let error = run_endpoint_err!(runner, text_get, json!([orphan_hex]));
    assert_contains_error!(error, ErrorType::TextNotFound);

    set_actor(&mut runner, None);
    let error = run_endpoint_err!(runner, text_get, json!([orphan_hex]));
    assert_contains_error!(error, ErrorType::TextNotFound);

    set_actor(&mut runner, Some(ADMIN_USER_ID));
    let text_result = run_endpoint!(runner, text_get, json!([orphan_hex]));
    assert_eq!(text_result, ORPHAN_TEXT);

    const MESSAGE_BODY: &str = "Text get authorization message body";
    set_actor(&mut runner, Some(sender));
    let draft = run_endpoint!(
        runner,
        message_draft_create,
        json!({
            "user_id": sender,
            "recipients": [recipient],
            "carbon_copy": [],
            "blind_carbon_copy": [],
            "locale": "en",
            "subject": "Text authz message",
            "wikitext": MESSAGE_BODY,
            "reply_to": null,
            "forwarded_from": null,
        }),
    );

    let draft_row = MessageDraftTable::find()
        .filter(message_draft::Column::ExternalId.eq(&draft.external_id))
        .one(runner.context().transaction())
        .await
        .expect("message draft lookup should succeed")
        .expect("message draft should exist");
    let message_hash: [u8; 16] = draft_row
        .wikitext_hash
        .try_into()
        .expect("message wikitext hash should be 16 bytes");
    let message_hex = text_hash_to_hex(&message_hash).to_string();

    set_actor(&mut runner, Some(sender));
    let text_result = run_endpoint!(runner, text_get, json!([message_hex]));
    assert_eq!(text_result, MESSAGE_BODY);

    set_actor(&mut runner, Some(recipient));
    let error = run_endpoint_err!(runner, text_get, json!([message_hex]));
    assert_contains_error!(error, ErrorType::TextNotFound);

    set_actor(&mut runner, Some(outsider));
    let error = run_endpoint_err!(runner, text_get, json!([message_hex]));
    assert_contains_error!(error, ErrorType::TextNotFound);

    set_actor(&mut runner, None);
    let error = run_endpoint_err!(runner, text_get, json!([message_hex]));
    assert_contains_error!(error, ErrorType::TextNotFound);

    set_actor(&mut runner, Some(sender));
    run_endpoint!(
        runner,
        message_draft_send,
        json!({ "message_draft_id": draft.external_id }),
    );

    set_actor(&mut runner, Some(recipient));
    let text_result = run_endpoint!(runner, text_get, json!([message_hex]));
    assert_eq!(text_result, MESSAGE_BODY);

    set_actor(&mut runner, Some(sender));
    let text_result = run_endpoint!(runner, text_get, json!([message_hex]));
    assert_eq!(text_result, MESSAGE_BODY);

    set_actor(&mut runner, Some(outsider));
    let error = run_endpoint_err!(runner, text_get, json!([message_hex]));
    assert_contains_error!(error, ErrorType::TextNotFound);

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
    .expect("text authz page delete should succeed");

    set_actor(&mut runner, Some(viewer));
    let error = run_endpoint_err!(runner, text_get, json!([wikitext_hex]));
    assert_contains_error!(error, ErrorType::TextNotFound);

    set_actor(&mut runner, Some(ADMIN_USER_ID));
    let text_result = run_endpoint!(runner, text_get, json!([wikitext_hex]));
    assert_eq!(text_result, WIKITEXT);
}
