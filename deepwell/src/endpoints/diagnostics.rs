/*
 * endpoints/diagnostics.rs
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
use serde_json::Value as JsonValue;

pub async fn echo(
    _ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<JsonValue> {
    let data: JsonValue = parse!(params);
    Ok(data)
}

pub async fn yield_error(
    _ctx: &ServiceContext<'_>,
    _params: Params<'static>,
) -> Result<()> {
    info!("Returning DEEPWELL error for testing");
    bail!(Error::new(
        "this method type always fails",
        ErrorType::BadRequest
    ));
}

pub async fn config_dump(
    ctx: &ServiceContext<'_>,
    _params: Params<'static>,
) -> Result<String> {
    info!("Dumping raw DEEPWELL configuration for debugging");
    Ok(ctx.config().raw_toml.to_string())
}
