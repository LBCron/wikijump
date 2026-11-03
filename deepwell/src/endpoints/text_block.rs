/*
 * endpoints/text.rs
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

use super::prelude::*;
use crate::services::permission::{CheckPermissionContext, PermissionService};
use crate::services::text_block::TextBlockIndex;
use crate::types::{Action, Permission, Reference, Resource, TextBlockType};

#[derive(Deserialize, Debug, Clone)]
struct GetIndexInput {
    site_id: i64,
    page_id: Option<i64>,
    block_type: TextBlockType,
    index: Option<i16>,
    name: Option<String>,
    sha1: Option<String>,
    session_token: Option<String>,
}

pub async fn text_block_get_index(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Option<TextBlockIndex>> {
    let GetIndexInput {
        site_id,
        page_id,
        block_type,
        index,
        name,
        sha1,
        session_token,
    } = parse!(params);

    match (page_id, index, name, sha1) {
        (Some(page_id), Some(index), None, None) if index > 0 => {
            ensure_parent_page_view_permission(ctx, site_id, page_id, session_token.as_deref())
                .await?;
            TextBlockService::get_block_by_index(ctx, page_id, block_type, index)
                .await
                .or_raise(|| {
                    Error::new(
                        format!(
                            "failed to get text block {:?} index {} for page ID {}",
                            block_type, index, page_id,
                        ),
                        ErrorType::Request,
                    )
                })
        }
        (Some(page_id), None, Some(name), None) => {
            ensure_parent_page_view_permission(ctx, site_id, page_id, session_token.as_deref())
                .await?;
            TextBlockService::get_block_index(ctx, page_id, block_type, &name)
                .await
                .or_raise(|| {
                    Error::new(
                        format!(
                            "failed to get text block {:?} '{}' for page ID {}",
                            block_type, name, page_id,
                        ),
                        ErrorType::Request,
                    )
                })
        }
        (None, None, None, Some(sha1)) if block_type == TextBlockType::Html => {
            let digest = parse_wikidot_sha1(&sha1)?;
            let user_id = session_user_id(ctx, session_token.as_deref()).await?;
            let candidate = TextBlockService::get_visible_block_by_wikidot_sha1(
                ctx,
                site_id,
                &digest,
                user_id,
            )
            .await?;

            Ok(candidate.map(|candidate| TextBlockIndex {
                index: candidate.index,
                s3_filename: candidate.s3_filename,
            }))
        }
        _ => Err(Error::new(
            "text block lookup must provide exactly one positive index, name, or HTML SHA-1",
            ErrorType::Request,
        )
        .into()),
    }
}

fn parse_wikidot_sha1(value: &str) -> Result<Vec<u8>> {
    if value.len() != 40
        || !value
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(Error::new(
            "Wikidot HTML block SHA-1 must be 40 lowercase hexadecimal characters",
            ErrorType::Request,
        )
        .into());
    }

    hex::decode(value).or_raise(|| {
        Error::new(
            "failed to decode Wikidot HTML block SHA-1",
            ErrorType::Request,
        )
    })
}

async fn ensure_parent_page_view_permission(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    page_id: i64,
    session_token: Option<&str>,
) -> Result<()> {
    let make_error = || {
        Error::new(
            "failed to check parent page view permission for text block",
            ErrorType::Permission,
        )
    };

    let user_id = session_user_id(ctx, session_token).await?;

    let page = PageService::get(ctx, site_id, Reference::Id(page_id))
        .await
        .or_raise(make_error)?;

    let can_view = PermissionService::check_user_can(
        ctx,
        &CheckPermissionContext {
            user_id,
            site_id,
            page_reference: Some(Reference::Id(page.page_id)),
        },
        Permission {
            resource_type: Resource::Page,
            resource_category: Some(Reference::Id(page.page_category_id)),
            action: Action::View,
        },
    )
    .await
    .or_raise(make_error)?;

    if can_view {
        Ok(())
    } else {
        Err(Error::new(
            "user does not have permission to view this text block's parent page",
            ErrorType::PermissionDenied,
        )
        .into())
    }
}

async fn session_user_id(
    ctx: &ServiceContext<'_>,
    session_token: Option<&str>,
) -> Result<Option<i64>> {
    let make_error = || {
        Error::new(
            "failed to check parent page view permission for text block",
            ErrorType::Permission,
        )
    };

    match session_token {
        Some("") | None => Ok(None),
        Some(token) => SessionService::get_optional(ctx, token)
            .await
            .or_raise(make_error)
            .map(|session| session.map(|session| session.user_id)),
    }
}
