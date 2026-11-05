/*
 * database/mod.rs
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

mod seeder;

pub use self::seeder::seed;

use crate::config::Config;
use crate::error::prelude::*;
use sea_orm::{ConnectOptions, Database, DatabaseConnection};
use std::time::Duration;

/// Connect to PostgreSQL with the pool size, prepared-statement cache size, and
/// connection lifetime from configuration.
///
/// The defaults keep the previous behavior (`max_connections = 100`, a
/// 100-statement cache per connection, no lifetime limit); deployments that
/// need a smaller footprint lower them in `[database]`.
pub async fn connect<S: Into<String>>(
    database_uri: S,
    config: &Config,
) -> Result<DatabaseConnection> {
    let make_error =
        || Error::new("failed to connect to database", ErrorType::DatabaseSetup);

    let database_uri = database_uri.into();
    let mut options = ConnectOptions::new(database_uri);
    options
        .min_connections(4)
        .max_connections(config.database_max_connections)
        .connect_timeout(Duration::from_secs(5))
        .idle_timeout(Duration::from_secs(10))
        .sqlx_logging(config.sqlx_logging);

    if let Some(max_lifetime) = config.database_max_lifetime {
        options.max_lifetime(max_lifetime);
    }

    let statement_cache_capacity = config.database_statement_cache_capacity as usize;
    options.map_sqlx_postgres_opts(move |options| {
        options.statement_cache_capacity(statement_cache_capacity)
    });

    let sea_orm_db = Database::connect(options).await.or_raise(make_error)?;
    Ok(sea_orm_db)
}
