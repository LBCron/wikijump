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
use crate::models::forum_post_revision::Entity as ForumPostRevision;
use crate::models::message_draft::Entity as MessageDraft;
use crate::models::message_record::Entity as MessageRecord;
use crate::models::page_revision::Entity as PageRevision;
use crate::models::text::{self, Entity as Text};
use crate::services::ServiceContext;
use paste::paste;
use sea_orm::sea_query::{DynIden, IntoIden, OnConflict, TableRef};
use sea_orm::{
    ColumnTrait, Condition, DeleteResult, EntityName, EntityTrait, Identity, Iterable,
    QueryFilter, RelationTrait, Set,
};
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

    fn text_references() -> Vec<(TableRef, DynIden)> {
        fn collect<E>(references: &mut Vec<(TableRef, DynIden)>)
        where
            E: EntityTrait,
            E::Relation: RelationTrait,
        {
            let text_table = Text.table_ref();
            let text_hash = Identity::Unary(text::Column::Hash.into_iden());
            for relation in E::Relation::iter() {
                let definition = relation.def();
                if definition.to_tbl == text_table
                    && definition.to_col == text_hash
                    && let Identity::Unary(column) = definition.from_col
                {
                    references.push((definition.from_tbl, column));
                }
            }
        }

        let mut references = Vec::new();
        collect::<PageRevision>(&mut references);
        collect::<MessageDraft>(&mut references);
        collect::<MessageRecord>(&mut references);
        collect::<ForumPostRevision>(&mut references);
        references
    }

    fn prune_condition() -> Condition {
        Self::text_references().into_iter().fold(
            Condition::all(),
            |condition, (table, column)| {
                condition.add(text::Column::Hash.not_in_subquery(
                    Query::select().column(column).from(table).to_owned(),
                ))
            },
        )
    }

    pub async fn prune(ctx: &ServiceContext<'_>) -> Result<()> {
        let txn = ctx.transaction();
        let DeleteResult { rows_affected, .. } = Text::delete_many()
            .filter(Self::prune_condition())
            .exec(txn)
            .await
            .or_raise(|| {
                Error::new("failed to prune unused text entries", ErrorType::Text)
            })?;

        debug!("Pruned {rows_affected} unused text rows");
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{DbBackend, QueryTrait};

    #[test]
    fn text_references_derive_every_schema_foreign_key_to_text() {
        let mut references: Vec<(String, String)> = TextService::text_references()
            .into_iter()
            .map(|(table, column)| {
                (table.sea_orm_table().to_string(), column.to_string())
            })
            .collect();
        references.sort();
        assert_eq!(
            references,
            vec![
                (
                    "forum_post_revision".to_string(),
                    "compiled_html_hash".to_string()
                ),
                (
                    "forum_post_revision".to_string(),
                    "wikitext_hash".to_string()
                ),
                ("message_draft".to_string(), "compiled_hash".to_string()),
                ("message_draft".to_string(), "wikitext_hash".to_string()),
                ("message_record".to_string(), "compiled_hash".to_string()),
                ("message_record".to_string(), "wikitext_hash".to_string()),
                (
                    "page_revision".to_string(),
                    "compiled_body_html_hash".to_string()
                ),
                (
                    "page_revision".to_string(),
                    "compiled_body_styles_hash".to_string()
                ),
                (
                    "page_revision".to_string(),
                    "compiled_side_bar_html_hash".to_string()
                ),
                (
                    "page_revision".to_string(),
                    "compiled_top_bar_html_hash".to_string()
                ),
                ("page_revision".to_string(), "wikitext_hash".to_string()),
            ],
        );
    }

    #[test]
    fn prune_condition_excludes_every_text_reference() {
        let statement = Text::delete_many()
            .filter(TextService::prune_condition())
            .build(DbBackend::Postgres)
            .to_string();
        for column in [
            "wikitext_hash",
            "compiled_body_html_hash",
            "compiled_body_styles_hash",
            "compiled_top_bar_html_hash",
            "compiled_side_bar_html_hash",
            "compiled_hash",
            "compiled_html_hash",
        ] {
            assert!(statement.contains(column), "missing {column}: {statement}");
        }
        assert_eq!(statement.matches("NOT IN").count(), 11);
    }
}
