/*
 * services/score/scorer.rs
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

use super::structs::{ScoreType, VoteType};
use crate::error::prelude::Result;
use ftml::data::ScoreValue;
use sea_orm::{Condition, DatabaseTransaction};
use std::future::Future;

pub trait Scorer {
    fn score_type(&self) -> ScoreType;

    fn accepts_vote_type(&self, vtype: VoteType) -> bool;

    fn score(
        &self,
        txn: &DatabaseTransaction,
        condition: Condition,
    ) -> impl Future<Output = Result<ScoreValue>> + Send;
}
