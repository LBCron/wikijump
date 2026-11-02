/*
 * tests/message.rs
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
use deepwell::error::exn_error_to_rpc_error;
use deepwell::models::message::{self, Entity as MessageTable};
use deepwell::models::message_draft::{self, Entity as MessageDraftTable};
use deepwell::models::message_recipient::{self, Entity as MessageRecipientTable};
use deepwell::services::{MessageService, RequestContext};
use deepwell::types::MessageRecipientType;
use sea_orm::{ColumnTrait, EntityTrait, PaginatorTrait, QueryFilter};
use serde_json::json;

fn public_error(error: deepwell::error::ExnError) -> (i32, String) {
    let error = exn_error_to_rpc_error(error);
    (error.code(), error.message().to_owned())
}

fn draft_params(subject: &str, wikitext: &str) -> serde_json::Value {
    json!({
        "user_id": ADMIN_USER_ID,
        "recipients": [SAMPLE_USER_ID],
        "carbon_copy": [],
        "blind_carbon_copy": [],
        "locale": "en",
        "subject": subject,
        "wikitext": wikitext,
        "reply_to": null,
        "forwarded_from": null,
    })
}

#[tokio::test]
async fn self_only_message_marks_its_sender_row_as_self_without_outbox() {
    let mut runner = TestRunner::setup().await;
    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        ..Default::default()
    });

    let draft = run_endpoint!(
        runner,
        message_draft_create,
        json!({
            "user_id": ADMIN_USER_ID,
            "recipients": [],
            "carbon_copy": [ADMIN_USER_ID, ADMIN_USER_ID],
            "blind_carbon_copy": [],
            "locale": "en",
            "subject": "Self only",
            "wikitext": "Message to self",
            "reply_to": null,
            "forwarded_from": null,
        }),
    );
    let record = run_endpoint!(
        runner,
        message_draft_send,
        json!({"message_draft_id": draft.external_id}),
    );

    let messages = MessageTable::find()
        .filter(message::Column::RecordId.eq(&record.external_id))
        .all(runner.context().transaction())
        .await
        .unwrap();
    assert_eq!(messages.len(), 1);
    let sender_message = &messages[0];
    assert_eq!(sender_message.user_id, ADMIN_USER_ID);
    assert!(!sender_message.flag_inbox);
    assert!(!sender_message.flag_outbox);
    assert!(sender_message.flag_self);

    let recipients = MessageRecipientTable::find()
        .filter(message_recipient::Column::RecordId.eq(&record.external_id))
        .all(runner.context().transaction())
        .await
        .unwrap();
    assert_eq!(recipients.len(), 1);
    assert_eq!(recipients[0].recipient_id, ADMIN_USER_ID);
    assert_eq!(recipients[0].recipient_type, MessageRecipientType::Cc);
}

#[tokio::test]
async fn self_and_other_message_marks_sender_as_self_and_outbox() {
    let mut runner = TestRunner::setup().await;
    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        ..Default::default()
    });

    let draft = run_endpoint!(
        runner,
        message_draft_create,
        json!({
            "user_id": ADMIN_USER_ID,
            "recipients": [SAMPLE_USER_ID, SAMPLE_USER_ID],
            "carbon_copy": [ADMIN_USER_ID],
            "blind_carbon_copy": [],
            "locale": "en",
            "subject": "Self and other",
            "wikitext": "Message to self and another user",
            "reply_to": null,
            "forwarded_from": null,
        }),
    );
    let record = run_endpoint!(
        runner,
        message_draft_send,
        json!({"message_draft_id": draft.external_id}),
    );

    let messages = MessageTable::find()
        .filter(message::Column::RecordId.eq(&record.external_id))
        .all(runner.context().transaction())
        .await
        .unwrap();
    assert_eq!(messages.len(), 2);

    let sender_message = messages
        .iter()
        .find(|message| message.user_id == ADMIN_USER_ID)
        .unwrap();
    assert!(!sender_message.flag_inbox);
    assert!(sender_message.flag_outbox);
    assert!(sender_message.flag_self);

    let recipient_message = messages
        .iter()
        .find(|message| message.user_id == SAMPLE_USER_ID)
        .unwrap();
    assert!(recipient_message.flag_inbox);
    assert!(!recipient_message.flag_outbox);
    assert!(!recipient_message.flag_self);

    let recipients = MessageRecipientTable::find()
        .filter(message_recipient::Column::RecordId.eq(&record.external_id))
        .all(runner.context().transaction())
        .await
        .unwrap();
    assert_eq!(recipients.len(), 2);
    assert!(recipients.iter().any(|recipient| {
        recipient.recipient_id == ADMIN_USER_ID
            && recipient.recipient_type == MessageRecipientType::Cc
    }));
    assert!(recipients.iter().any(|recipient| {
        recipient.recipient_id == SAMPLE_USER_ID
            && recipient.recipient_type == MessageRecipientType::Regular
    }));
}

#[tokio::test]
async fn message_draft_mutations_do_not_reveal_foreign_drafts() {
    const ABSENT_DRAFT_ID: &str = "c00000000000000000000000";

    let mut runner = TestRunner::setup().await;
    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        ..Default::default()
    });

    let editable = run_endpoint!(
        runner,
        message_draft_create,
        draft_params("Private editable draft", "Original edit body"),
    );
    let deletable = run_endpoint!(
        runner,
        message_draft_create,
        draft_params("Private deletable draft", "Original delete body"),
    );
    let sendable = run_endpoint!(
        runner,
        message_draft_create,
        draft_params("Private sendable draft", "Original send body"),
    );

    let edit_params = |message_draft_id: &str| {
        json!({
            "message_draft_id": message_draft_id,
            "recipients": [SAMPLE_USER_ID],
            "carbon_copy": [],
            "blind_carbon_copy": [],
            "locale": "en",
            "subject": "Unauthorized update",
            "wikitext": "Unauthorized body",
        })
    };

    macro_rules! assert_indistinguishable {
        ($endpoint:ident, $existing:expr, $absent:expr, $expected:expr $(,)?) => {{
            let existing_error =
                public_error(run_endpoint_err!(runner, $endpoint, $existing));
            let absent_error =
                public_error(run_endpoint_err!(runner, $endpoint, $absent));
            let expected = ($expected.code(), $expected.summary().to_owned());

            assert_eq!(existing_error, expected);
            assert_eq!(existing_error, absent_error);
        }};
    }

    runner.set_request_context(RequestContext {
        user_id: Some(SAMPLE_USER_ID),
        ..Default::default()
    });
    assert_indistinguishable!(
        message_draft_edit,
        edit_params(editable.external_id.as_str()),
        edit_params(ABSENT_DRAFT_ID),
        deepwell::error::ErrorType::MessageDraftNotFound,
    );
    assert_indistinguishable!(
        message_draft_delete,
        json!({"message_draft_id": deletable.external_id}),
        json!({"message_draft_id": ABSENT_DRAFT_ID}),
        deepwell::error::ErrorType::MessageDraftNotFound,
    );
    assert_indistinguishable!(
        message_draft_send,
        json!({"message_draft_id": sendable.external_id}),
        json!({"message_draft_id": ABSENT_DRAFT_ID}),
        deepwell::error::ErrorType::MessageDraftNotFound,
    );

    runner.set_request_context(RequestContext::default());
    assert_indistinguishable!(
        message_draft_edit,
        edit_params(editable.external_id.as_str()),
        edit_params(ABSENT_DRAFT_ID),
        deepwell::error::ErrorType::PermissionDenied,
    );
    assert_indistinguishable!(
        message_draft_delete,
        json!({"message_draft_id": deletable.external_id}),
        json!({"message_draft_id": ABSENT_DRAFT_ID}),
        deepwell::error::ErrorType::PermissionDenied,
    );
    assert_indistinguishable!(
        message_draft_send,
        json!({"message_draft_id": sendable.external_id}),
        json!({"message_draft_id": ABSENT_DRAFT_ID}),
        deepwell::error::ErrorType::PermissionDenied,
    );

    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        ..Default::default()
    });
    for expected in [&editable, &deletable, &sendable] {
        let actual =
            MessageService::get_draft(runner.context(), expected.external_id.as_str())
                .await
                .expect("a denied mutation must preserve the owner's draft");
        assert_eq!(&actual, expected);
    }
}

#[tokio::test]
async fn message_draft_lifecycle_sends_and_deletes_drafts() {
    let mut runner = TestRunner::setup().await;
    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        ..Default::default()
    });

    let draft = run_endpoint!(
        runner,
        message_draft_create,
        draft_params("Initial subject", "Initial **body**"),
    );
    assert_eq!(draft.user_id, ADMIN_USER_ID);
    assert_eq!(draft.subject, "Initial subject");

    runner.set_request_context(RequestContext {
        user_id: Some(SAMPLE_USER_ID),
        ..Default::default()
    });
    let error = run_endpoint_err!(
        runner,
        message_draft_edit,
        json!({
            "message_draft_id": draft.external_id,
            "recipients": [SAMPLE_USER_ID],
            "carbon_copy": [],
            "blind_carbon_copy": [],
            "locale": "en",
            "subject": "Unauthorized update",
            "wikitext": "Unauthorized body",
        }),
    );
    assert_contains_error!(error, deepwell::error::ErrorType::MessageDraftNotFound,);
    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        ..Default::default()
    });

    let edited = run_endpoint!(
        runner,
        message_draft_edit,
        json!({
            "message_draft_id": draft.external_id,
            "recipients": [SAMPLE_USER_ID],
            "carbon_copy": [],
            "blind_carbon_copy": [],
            "locale": "en",
            "subject": "Updated subject",
            "wikitext": "Updated body",
        }),
    );
    assert_eq!(edited.external_id, draft.external_id);
    assert_eq!(edited.subject, "Updated subject");
    assert!(edited.updated_at.is_some());

    let record = run_endpoint!(
        runner,
        message_draft_send,
        json!({"message_draft_id": edited.external_id}),
    );
    assert_eq!(record.sender_id, ADMIN_USER_ID);
    assert_eq!(record.subject, "Updated subject");

    assert!(
        MessageService::get_draft_optional(runner.context(), &record.external_id)
            .await
            .unwrap()
            .is_none(),
    );

    let recipient_message = MessageService::get_message(
        runner.context(),
        &record.external_id,
        SAMPLE_USER_ID,
    )
    .await
    .unwrap();
    assert!(recipient_message.flag_inbox);
    assert!(!recipient_message.flag_outbox);
    assert!(!recipient_message.flag_self);

    let sender_message =
        MessageService::get_message(runner.context(), &record.external_id, ADMIN_USER_ID)
            .await
            .unwrap();
    assert!(!sender_message.flag_inbox);
    assert!(sender_message.flag_outbox);
    assert!(!sender_message.flag_self);

    let deletable = run_endpoint!(
        runner,
        message_draft_create,
        draft_params("Delete me", "Temporary body"),
    );
    run_endpoint!(
        runner,
        message_draft_delete,
        json!({"message_draft_id": deletable.external_id}),
    );
    assert!(
        MessageService::get_draft_optional(runner.context(), &deletable.external_id)
            .await
            .unwrap()
            .is_none(),
    );
}

#[tokio::test]
async fn message_reference_drafts_require_sender_or_recipient_access() {
    const UNRELATED_USER_ID: i64 = -6;
    const NONEXISTENT_MESSAGE_ID: &str = "c00000000000000000000000";

    let mut runner = TestRunner::setup().await;
    runner.set_request_context(RequestContext {
        user_id: Some(ADMIN_USER_ID),
        ..Default::default()
    });

    let source_draft = run_endpoint!(
        runner,
        message_draft_create,
        draft_params("Access-controlled message", "Private body"),
    );
    let source_message = run_endpoint!(
        runner,
        message_draft_send,
        json!({"message_draft_id": source_draft.external_id}),
    );
    let source_message_id = source_message.external_id.as_str();
    let unrelated_drafts_before = MessageDraftTable::find()
        .filter(message_draft::Column::UserId.eq(UNRELATED_USER_ID))
        .count(runner.context().transaction())
        .await
        .expect("unrelated actor draft count should load");

    let reference_draft_params =
        |user_id: i64, reply_to: Option<&str>, forwarded_from: Option<&str>| {
            json!({
                "user_id": user_id,
                "recipients": [ADMIN_USER_ID],
                "carbon_copy": [],
                "blind_carbon_copy": [],
                "locale": "en",
                "subject": "Message access check",
                "wikitext": "Private response",
                "reply_to": reply_to,
                "forwarded_from": forwarded_from,
            })
        };

    runner.set_request_context(RequestContext {
        user_id: Some(SAMPLE_USER_ID),
        ..Default::default()
    });
    let recipient_reply = deepwell::endpoints::all::message_draft_create(
        runner.context(),
        common::make_params(reference_draft_params(
            SAMPLE_USER_ID,
            Some(source_message_id),
            None,
        )),
    )
    .await
    .expect("a recipient should be able to reply to a visible message");
    assert_eq!(recipient_reply.reply_to.as_deref(), Some(source_message_id),);
    let recipient_forward = deepwell::endpoints::all::message_draft_create(
        runner.context(),
        common::make_params(reference_draft_params(
            SAMPLE_USER_ID,
            None,
            Some(source_message_id),
        )),
    )
    .await
    .expect("a recipient should be able to forward a visible message");
    assert_eq!(
        recipient_forward.forwarded_from.as_deref(),
        Some(source_message_id),
    );

    runner.set_request_context(RequestContext {
        user_id: Some(UNRELATED_USER_ID),
        ..Default::default()
    });
    let unrelated_reply = deepwell::endpoints::all::message_draft_create(
        runner.context(),
        common::make_params(reference_draft_params(
            UNRELATED_USER_ID,
            Some(source_message_id),
            None,
        )),
    )
    .await
    .expect_err("an unrelated actor must not reply to a private message");
    let unrelated_reply_rpc = exn_error_to_rpc_error(unrelated_reply);
    assert_eq!(
        unrelated_reply_rpc.code(),
        deepwell::error::ErrorType::MessageNotFound.code(),
    );
    assert_eq!(
        unrelated_reply_rpc.message(),
        deepwell::error::ErrorType::MessageNotFound.summary(),
    );
    let unrelated_forward = deepwell::endpoints::all::message_draft_create(
        runner.context(),
        common::make_params(reference_draft_params(
            UNRELATED_USER_ID,
            None,
            Some(source_message_id),
        )),
    )
    .await
    .expect_err("an unrelated actor must not forward a private message");
    let unrelated_forward_rpc = exn_error_to_rpc_error(unrelated_forward);
    assert_eq!(
        unrelated_forward_rpc.code(),
        deepwell::error::ErrorType::MessageNotFound.code(),
    );
    assert_eq!(
        unrelated_forward_rpc.message(),
        deepwell::error::ErrorType::MessageNotFound.summary(),
    );

    let spoofed_recipient = deepwell::endpoints::all::message_draft_create(
        runner.context(),
        common::make_params(reference_draft_params(
            SAMPLE_USER_ID,
            Some(source_message_id),
            None,
        )),
    )
    .await
    .expect_err("an unrelated actor must not impersonate an authorized recipient");
    assert_contains_error!(
        spoofed_recipient,
        deepwell::error::ErrorType::PermissionDenied,
    );

    let unrelated_drafts_after = MessageDraftTable::find()
        .filter(message_draft::Column::UserId.eq(UNRELATED_USER_ID))
        .count(runner.context().transaction())
        .await
        .expect("unrelated actor draft count should reload");
    assert_eq!(
        unrelated_drafts_after, unrelated_drafts_before,
        "denied references must not create a draft",
    );

    let nonexistent_reply = deepwell::endpoints::all::message_draft_create(
        runner.context(),
        common::make_params(reference_draft_params(
            UNRELATED_USER_ID,
            Some(NONEXISTENT_MESSAGE_ID),
            None,
        )),
    )
    .await
    .expect_err("a nonexistent reply target must fail closed");
    let nonexistent_reply_rpc = exn_error_to_rpc_error(nonexistent_reply);
    assert_eq!(
        nonexistent_reply_rpc.code(),
        deepwell::error::ErrorType::MessageNotFound.code(),
    );
    assert_eq!(
        nonexistent_reply_rpc.message(),
        deepwell::error::ErrorType::MessageNotFound.summary(),
    );
    let nonexistent_forward = deepwell::endpoints::all::message_draft_create(
        runner.context(),
        common::make_params(reference_draft_params(
            UNRELATED_USER_ID,
            None,
            Some(NONEXISTENT_MESSAGE_ID),
        )),
    )
    .await
    .expect_err("a nonexistent forward target must fail closed");
    let nonexistent_forward_rpc = exn_error_to_rpc_error(nonexistent_forward);
    assert_eq!(
        nonexistent_forward_rpc.code(),
        deepwell::error::ErrorType::MessageNotFound.code(),
    );
    assert_eq!(
        nonexistent_forward_rpc.message(),
        deepwell::error::ErrorType::MessageNotFound.summary(),
    );
    assert_eq!(
        (unrelated_reply_rpc.code(), unrelated_reply_rpc.message()),
        (
            nonexistent_reply_rpc.code(),
            nonexistent_reply_rpc.message()
        ),
        "unauthorized and absent reply targets must have the same public error",
    );
    assert_eq!(
        (
            unrelated_forward_rpc.code(),
            unrelated_forward_rpc.message(),
        ),
        (
            nonexistent_forward_rpc.code(),
            nonexistent_forward_rpc.message(),
        ),
        "unauthorized and absent forward targets must have the same public error",
    );
}
