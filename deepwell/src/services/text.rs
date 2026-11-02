/*
 * services/text.rs
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

use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::hash::{TEXT_HASH_LENGTH, TextHash, k12_hash};
use crate::models::forum_post_revision::{self, Entity as ForumPostRevision};
use crate::models::message_draft::{self, Entity as MessageDraft};
use crate::models::message_record::{self, Entity as MessageRecord};
use crate::models::page_revision::{self, Entity as PageRevision};
use crate::models::text::{self, Entity as Text};
use crate::services::ServiceContext;
use paste::paste;
use sea_orm::sea_query::OnConflict;
use sea_orm::{ColumnTrait, Condition, DeleteResult, EntityTrait, QueryFilter, Set};
use sea_query::Query;

#[derive(Debug)]
pub struct TextService;

impl TextService {
    pub async fn get_optional(
        ctx: &ServiceContext<'_>,
        hash: &[u8],
    ) -> Result<Option<String>> {
        if hash.len() != TEXT_HASH_LENGTH {
            error!(
                "Text hash length does not match, should be {}, is {}",
                TEXT_HASH_LENGTH,
                hash.len(),
            );
            bail!(Error::new(
                format!(
                    "failed to get text entry, hash should be {} bytes, but is {} bytes",
                    TEXT_HASH_LENGTH,
                    hash.len(),
                ),
                ErrorType::BadRequest,
            ));
        }

        let txn = ctx.transaction();
        let contents = Text::find()
            .filter(text::Column::Hash.eq(hash))
            .one(txn)
            .await
            .or_raise(|| {
                Error::new("failed to get optional text entry", ErrorType::Text)
            })?
            .map(|model| model.contents);

        Ok(contents)
    }

    #[inline]
    pub async fn get(ctx: &ServiceContext<'_>, hash: &[u8]) -> Result<String> {
        find_or_error!(Self::get_optional(ctx, hash), "text entry", Text)
    }

    #[inline]
    pub async fn exists(ctx: &ServiceContext<'_>, hash: &[u8]) -> Result<bool> {
        Self::get_optional(ctx, hash)
            .await
            .map(|text| text.is_some())
    }

    pub async fn get_conditional(
        ctx: &ServiceContext<'_>,
        should_fetch: bool,
        hash: &[u8],
    ) -> Result<Option<String>> {
        if should_fetch {
            let text = Self::get(ctx, hash).await.or_raise(|| {
                Error::new("failed to conditionally get text entry", ErrorType::Text)
            })?;
            Ok(Some(text))
        } else {
            Ok(None)
        }
    }

    pub async fn get_option<B: AsRef<[u8]>>(
        ctx: &ServiceContext<'_>,
        hash: &Option<B>,
    ) -> Result<Option<String>> {
        match hash {
            None => Ok(None),
            Some(hash) => {
                let hash = hash.as_ref();
                let text = Self::get(ctx, hash).await.or_raise(|| {
                    Error::new("failed to get optional text entry", ErrorType::Text)
                })?;

                Ok(Some(text))
            }
        }
    }

    pub async fn get_conditional_option<B: AsRef<[u8]>>(
        ctx: &ServiceContext<'_>,
        should_fetch: bool,
        hash: &Option<B>,
    ) -> Result<Option<String>> {
        if should_fetch {
            Self::get_option(ctx, hash).await
        } else {
            Ok(None)
        }
    }

    pub async fn create(ctx: &ServiceContext<'_>, contents: String) -> Result<TextHash> {
        let make_error =
            || Error::new("failed to create new text entry", ErrorType::Text);

        let txn = ctx.transaction();
        let hash = k12_hash(contents.as_bytes());
        let exists = Self::exists(ctx, &hash).await.or_raise(make_error)?;

        if !exists {
            let model = text::ActiveModel {
                hash: Set(hash.to_vec()),
                contents: Set(contents),
            };

            Text::insert(model)
                .on_conflict(
                    OnConflict::column(text::Column::Hash)
                        .do_nothing()
                        .to_owned(),
                )
                .exec_without_returning(txn)
                .await
                .or_raise(make_error)?;
        }

        Ok(hash)
    }

    pub async fn prune(ctx: &ServiceContext<'_>) -> Result<()> {
        macro_rules! not_in_column {
            ($table:expr, $column:expr $(,)?) => {
                text::Column::Hash.not_in_subquery(
                    Query::select().column($column).from($table).to_owned(),
                )
            };
        }

        let txn = ctx.transaction();
        let DeleteResult { rows_affected, .. } = Text::delete_many()
            .filter(
                Condition::all()
                    .add(not_in_column!(
                        PageRevision,
                        page_revision::Column::WikitextHash,
                    ))
                    .add(not_in_column!(
                        PageRevision,
                        page_revision::Column::CompiledBodyHtmlHash,
                    ))
                    .add(not_in_column!(
                        PageRevision,
                        page_revision::Column::CompiledTopBarHtmlHash,
                    ))
                    .add(not_in_column!(
                        PageRevision,
                        page_revision::Column::CompiledSideBarHtmlHash,
                    ))
                    .add(not_in_column!(
                        MessageDraft,
                        message_draft::Column::WikitextHash,
                    ))
                    .add(not_in_column!(
                        MessageDraft,
                        message_draft::Column::CompiledHash,
                    ))
                    .add(not_in_column!(
                        MessageRecord,
                        message_record::Column::WikitextHash,
                    ))
                    .add(not_in_column!(
                        MessageRecord,
                        message_record::Column::CompiledHash,
                    ))
                    .add(not_in_column!(
                        ForumPostRevision,
                        forum_post_revision::Column::WikitextHash,
                    ))
                    .add(not_in_column!(
                        ForumPostRevision,
                        forum_post_revision::Column::CompiledHtmlHash,
                    )),
            )
            .exec(txn)
            .await
            .or_raise(|| {
                Error::new("failed to prune unused text entries", ErrorType::Text)
            })?;

        debug!("Pruned {rows_affected} unused text rows");
        Ok(())
    }
}
