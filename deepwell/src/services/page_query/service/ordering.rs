/*
 * services/page_query/service/ordering.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::super::structs::{FoundPageFields, OrderBySelector, OrderProperty};
use crate::error::prelude::{Error, ErrorType, Result, ResultExt};
use crate::models::page::{self, Entity as Page};
use crate::models::page_revision;
use crate::services::ServiceContext;
use crate::services::score::ScoreValue;
use sea_orm::query::Order;
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, FromQueryResult, JoinType, QueryFilter,
    QueryOrder, QuerySelect, RelationTrait, Select, Statement,
};
use sea_query::func::Func;
use sea_query::{Alias, Expr, SimpleExpr, Value};
use std::cmp::Ordering;
use std::collections::BTreeMap;

pub(super) const EFFECTIVE_REVISION_COUNT_ALIAS: &str = "effective_revision_count";

#[derive(Debug, FromQueryResult)]
struct PageOrderingIdentityRow {
    page_id: i64,
    ordering_id: i64,
}

pub(super) async fn load_page_ordering_identities(
    ctx: &ServiceContext<'_>,
    page_ids: &[i64],
) -> Result<BTreeMap<i64, i64>> {
    if page_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    let statement = Statement::from_sql_and_values(
        ctx.transaction().get_database_backend(),
        "SELECT input.page_id,
                CASE
                    WHEN snapshot.meta_json->>'page_id' ~ '^[0-9]{1,18}$'
                    THEN (snapshot.meta_json->>'page_id')::bigint
                    ELSE input.page_id
                END AS ordering_id
           FROM UNNEST($1::bigint[]) AS input(page_id)
           LEFT JOIN wikidot_page_snapshot snapshot
             ON snapshot.page_id = input.page_id",
        [Value::from(page_ids.to_vec())],
    );
    Ok(PageOrderingIdentityRow::find_by_statement(statement)
        .all(ctx.transaction())
        .await
        .or_raise(|| {
            Error::new(
                "failed to load ListPages ordering identities",
                ErrorType::PageQuery,
            )
        })?
        .into_iter()
        .map(|row| (row.page_id, row.ordering_id))
        .collect())
}

pub(super) async fn load_page_ordering_titles(
    ctx: &ServiceContext<'_>,
    pages: &[page::Model],
) -> Result<BTreeMap<i64, String>> {
    let revision_ids = pages
        .iter()
        .filter_map(|page| page.latest_revision_id)
        .collect::<Vec<_>>();
    if revision_ids.is_empty() {
        return Ok(BTreeMap::new());
    }
    Ok(page_revision::Entity::find()
        .filter(page_revision::Column::RevisionId.is_in(revision_ids))
        .all(ctx.transaction())
        .await
        .or_raise(|| {
            Error::new(
                "failed to load ListPages ordering titles",
                ErrorType::PageQuery,
            )
        })?
        .into_iter()
        .map(|revision| (revision.page_id, revision.title))
        .collect())
}

pub(super) fn apply_sql_ordering(
    mut query: Select<Page>,
    order: &OrderBySelector,
    needs_tag_filter: bool,
) -> Select<Page> {
    let property = &order.property;
    let sql_order = if order.ascending {
        Order::Asc
    } else {
        Order::Desc
    };

    match property {
        OrderProperty::PageSlug => {
            let expr = Expr::cust_with_expr(
                "regexp_replace(regexp_replace($1, '^.*:', ''), '[^[:alnum:]]', '', 'g')",
                Expr::col((Page, page::Column::Slug)),
            );
            let identity = SimpleExpr::Custom(
                wikidot_page_ordering_identity_sql("page.page_id").into(),
            );
            query = query
                .order_by(expr, sql_order.clone())
                .order_by(identity, sql_order.clone())
                .order_by(page::Column::PageId, sql_order);
        }
        OrderProperty::FullSlug => {
            query = query.order_by(page::Column::Slug, sql_order);
        }
        OrderProperty::Title => {
            let normalized = Expr::cust_with_expr(
                "regexp_replace(lower($1), '[^[:alnum:][:space:]]', '', 'g')",
                Expr::col(page_revision::Column::Title),
            );
            query = query
                .order_by(normalized, sql_order.clone())
                .order_by(
                    Func::lower(Expr::col(page_revision::Column::Title)),
                    sql_order.clone(),
                )
                .order_by(page_revision::Column::Title, sql_order);
        }
        OrderProperty::AltTitle => {
            let normalized = Expr::cust_with_expr(
                "regexp_replace(lower($1), '[^[:alnum:][:space:]]', '', 'g')",
                Expr::col(page_revision::Column::AltTitle),
            );
            query = query
                .order_by(normalized, sql_order.clone())
                .order_by(
                    Func::lower(Expr::col(page_revision::Column::AltTitle)),
                    sql_order.clone(),
                )
                .order_by(page_revision::Column::AltTitle, sql_order);
        }
        OrderProperty::CreatedBy => {
            let expr = SimpleExpr::Custom(
                "(SELECT pr.user_id FROM page_revision pr WHERE pr.page_id = page.page_id ORDER BY pr.revision_number ASC, pr.revision_id ASC LIMIT 1)".into(),
            );
            query = query.order_by(expr, sql_order);
        }
        OrderProperty::CreatedAt => {
            let identity = SimpleExpr::Custom(
                wikidot_page_ordering_identity_sql("page.page_id").into(),
            );
            query = query
                .order_by(page::Column::CreatedAt, sql_order.clone())
                .order_by(identity, sql_order.clone())
                .order_by(page::Column::PageId, sql_order);
        }
        OrderProperty::UpdatedAt => {
            let identity = SimpleExpr::Custom(
                wikidot_page_ordering_identity_sql("page.page_id").into(),
            );
            query = query
                .order_by(page::Column::UpdatedAt, sql_order.clone())
                .order_by(identity, sql_order.clone())
                .order_by(page::Column::PageId, sql_order);
        }
        OrderProperty::Size => {
            query = query.join(
                if needs_tag_filter {
                    JoinType::Join
                } else {
                    JoinType::LeftJoin
                },
                page_revision::Relation::Text1.def(),
            );
            let expr = SimpleExpr::Custom(
                "COALESCE((
                    SELECT snapshot.wikidot_size
                    FROM wikidot_page_snapshot snapshot
                    WHERE snapshot.page_id = page.page_id
                ), text.character_count)"
                    .into(),
            );
            let identity = SimpleExpr::Custom(
                wikidot_page_ordering_identity_sql("page.page_id").into(),
            );
            query = query
                .order_by(expr, sql_order.clone())
                .order_by(identity, sql_order.clone())
                .order_by(page::Column::PageId, sql_order);
        }
        OrderProperty::Score => {}
        OrderProperty::Votes => {
            let expr =
                SimpleExpr::Custom(effective_vote_count_sql("page.page_id").into());
            query = query.order_by(expr, sql_order);
        }
        OrderProperty::Revisions => {
            let identity = SimpleExpr::Custom(
                wikidot_page_ordering_identity_sql("page.page_id").into(),
            );
            query = query
                .order_by(
                    Expr::col(Alias::new(EFFECTIVE_REVISION_COUNT_ALIAS)),
                    sql_order.clone(),
                )
                .order_by(identity, sql_order.clone())
                .order_by(page::Column::PageId, sql_order);
        }
        OrderProperty::Comments => {
            let expr = SimpleExpr::Custom(
                "COALESCE((SELECT COUNT(*) FROM forum_post fp JOIN forum_thread ft ON fp.forum_thread_id = ft.forum_thread_id WHERE ft.page_id = page.page_id AND fp.deleted_at IS NULL AND ft.deleted_at IS NULL), 0)".into(),
            );
            query = query.order_by(expr, sql_order);
        }
        OrderProperty::Random => {
            let expr = SimpleExpr::FunctionCall(Func::random());
            query = query.order_by(expr, sql_order);
        }
        OrderProperty::SeededRandom(seed) => {
            let expr = Expr::cust_with_values(
                "md5($1 || ':' || page.page_id::text)",
                [seed.to_string()],
            );
            query = query
                .order_by(expr, sql_order)
                .order_by(page::Column::PageId, Order::Asc);
        }
        OrderProperty::DataFormFieldName { .. } => {}
    }
    if !matches!(
        property,
        OrderProperty::Random
            | OrderProperty::SeededRandom(_)
            | OrderProperty::Score
            | OrderProperty::DataFormFieldName { .. }
    ) {
        if !matches!(
            property,
            OrderProperty::PageSlug
                | OrderProperty::FullSlug
                | OrderProperty::CreatedAt
                | OrderProperty::UpdatedAt
                | OrderProperty::Size
                | OrderProperty::Revisions
        ) {
            query = query.order_by(page::Column::Slug, Order::Asc);
        }
        if !matches!(
            property,
            OrderProperty::PageSlug
                | OrderProperty::CreatedAt
                | OrderProperty::UpdatedAt
                | OrderProperty::Size
                | OrderProperty::Revisions
        ) {
            query = query.order_by(page::Column::PageId, Order::Asc);
        }
    }
    query
}

pub(super) fn effective_vote_count_sql(page_id_sql: &str) -> String {
    format!(
        "COALESCE((\
            SELECT \
                COALESCE(\
                    CASE \
                        WHEN snapshot.meta_json ->> 'votes_count' ~ '^[0-9]{{1,19}}$' \
                             AND (length(snapshot.meta_json ->> 'votes_count') < 19 \
                                  OR snapshot.meta_json ->> 'votes_count' <= '9223372036854775807') \
                        THEN (snapshot.meta_json ->> 'votes_count')::bigint \
                        ELSE COUNT(vote.page_vote_id) FILTER (WHERE vote.from_wikidot = TRUE) \
                    END, \
                    0\
                ) \
                + COUNT(vote.page_vote_id) FILTER (WHERE vote.from_wikidot = FALSE) \
            FROM (SELECT 1) vote_seed \
            LEFT JOIN wikidot_page_snapshot snapshot ON snapshot.page_id = {page_id_sql} \
            LEFT JOIN page_vote vote ON vote.page_id = {page_id_sql} \
                AND vote.deleted_at IS NULL \
                AND vote.disabled_at IS NULL \
            GROUP BY snapshot.page_id, snapshot.meta_json\
        ), 0)"
    )
}

pub(super) fn effective_revision_count_sql(page_id_sql: &str) -> String {
    format!(
        "(\
            SELECT \
                CASE \
                    WHEN snapshot.source_revision_count < 0 THEN NULL \
                    ELSE COALESCE(snapshot.source_revision_count::bigint, 0) \
                        + COUNT(revision.revision_id) FILTER (\
                            WHERE snapshot.page_id IS NULL \
                                OR revision.from_wikidot = FALSE\
                        ) \
                END \
            FROM (SELECT 1) revision_seed \
            LEFT JOIN wikidot_page_snapshot snapshot \
                ON snapshot.page_id = {page_id_sql} \
            LEFT JOIN page_revision revision \
                ON revision.page_id = {page_id_sql} \
                AND (snapshot.page_id IS NULL OR revision.from_wikidot = FALSE) \
            GROUP BY snapshot.page_id, snapshot.source_revision_count\
        )"
    )
}

pub(super) fn needs_effective_revision_projection(
    fields: &FoundPageFields,
    order: &OrderBySelector,
) -> bool {
    fields.revision_count || matches!(order.property, OrderProperty::Revisions)
}

pub(super) fn project_effective_revision_count(
    fields: &FoundPageFields,
    count: Option<u64>,
) -> Option<u64> {
    fields.revision_count.then_some(count).flatten()
}

pub(super) fn wikidot_page_ordering_identity_sql(page_id_sql: &str) -> String {
    format!(
        "COALESCE((\
            SELECT CASE \
                WHEN snapshot.meta_json->>'page_id' ~ '^[0-9]{{1,18}}$' \
                THEN (snapshot.meta_json->>'page_id')::bigint \
            END \
            FROM wikidot_page_snapshot snapshot \
            WHERE snapshot.page_id = {page_id_sql}\
        ), {page_id_sql})"
    )
}

pub(super) fn score_to_f32(score: ScoreValue) -> f32 {
    match score {
        ScoreValue::Integer(value) => value as f32,
        ScoreValue::Float(value) => value as f32,
    }
}

pub(super) fn compare_ordering_titles(
    left: Option<&str>,
    right: Option<&str>,
) -> Ordering {
    let left = left.unwrap_or("");
    let right = right.unwrap_or("");
    left.to_ascii_lowercase()
        .cmp(&right.to_ascii_lowercase())
        .then_with(|| left.cmp(right))
}

pub(super) fn list_pages_deferred_ordering(
    ordering: Ordering,
    ascending: bool,
    left_ordering_id: i64,
    right_ordering_id: i64,
    left: &page::Model,
    right: &page::Model,
) -> Ordering {
    let ordering = if ascending {
        ordering
    } else {
        ordering.reverse()
    };
    ordering
        .then_with(|| {
            let identity_ordering = left_ordering_id.cmp(&right_ordering_id);
            if ascending {
                identity_ordering
            } else {
                identity_ordering.reverse()
            }
        })
        .then_with(|| {
            let page_id_ordering = left.page_id.cmp(&right.page_id);
            if ascending {
                page_id_ordering
            } else {
                page_id_ordering.reverse()
            }
        })
}

pub(super) fn data_form_field_value_ordering(
    left: Option<&str>,
    right: Option<&str>,
    numeric: bool,
) -> Ordering {
    if numeric {
        let left = left
            .and_then(|value| value.trim().parse::<i64>().ok())
            .unwrap_or(0);
        let right = right
            .and_then(|value| value.trim().parse::<i64>().ok())
            .unwrap_or(0);
        left.cmp(&right)
    } else {
        left.unwrap_or("").cmp(right.unwrap_or(""))
    }
}
