/*
 * tests/common/params.rs
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

#![allow(dead_code)]

use jsonrpsee::types::Params;
use serde_json::Value as JsonValue;

#[inline]
pub fn empty_params() -> Params<'static> {
    Params::new(None)
}

#[inline]
pub fn make_params(value: JsonValue) -> Params<'static> {
    let raw = serde_json::value::to_raw_value(&value).expect("Unable to emit JSON");
    Params::new(Some(raw.get())).into_owned()
}
