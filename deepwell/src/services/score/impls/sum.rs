/*
 * services/score/impls/sum.rs
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

use super::super::scorer::Scorer;
use super::super::structs::{ScoreType, VoteType};
use super::make_error;
use crate::error::prelude::{Result, ResultExt};
use crate::models::page_vote::{self, Entity as PageVote};
use ftml::data::ScoreValue;
use sea_orm::{
    ColumnTrait, Condition, DatabaseTransaction, EntityTrait, FromQueryResult,
    QueryFilter, QuerySelect,
};

#[derive(Debug)]
pub struct SumScorer;

impl Scorer for SumScorer {
    #[inline]
    fn score_type(&self) -> ScoreType {
        ScoreType::Sum
    }

    #[inline]
    fn accepts_vote_type(&self, _: VoteType) -> bool {
        true
    }

    async fn score(
        &self,
        txn: &DatabaseTransaction,
        condition: Condition,
    ) -> Result<ScoreValue> {
        #[derive(FromQueryResult, Debug)]
        struct SumRow {
            sum: Option<i64>,
        }

        let result = PageVote::find()
            .select_only()
            .column_as(page_vote::Column::Value.sum(), "sum")
            .filter(condition)
            .into_model::<SumRow>()
            .one(txn)
            .await
            .or_raise(|| make_error("sum"))?
            .expect("aggregate query should return one row");

        Ok(ScoreValue::Integer(result.sum.unwrap_or(0)))
    }
}
