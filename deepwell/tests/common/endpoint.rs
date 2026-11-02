/*
 * tests/common/endpoint.rs
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

#![allow(unused_macros)]

macro_rules! run_endpoint {
    ($runner:expr, $endpoint:ident, $params_value:expr $(,)?) => {
        run_endpoint!($runner => $endpoint, common::make_params($params_value))
    };

    ($runner:expr, $endpoint:ident $(,)?) => {
        run_endpoint!($runner => $endpoint, common::empty_params())
    };

    ($runner:expr => $endpoint:ident, $params:expr) => {
        match deepwell::endpoints::all::$endpoint($runner.context(), $params).await {
            Ok(result) => result,
            Err(error) => {
                panic!("Call to method '{}' failed!\n{:?}", stringify!($endpoint), error);
            }
        }
    };
}

macro_rules! run_endpoint_err {
    ($runner:expr, $endpoint:ident, $params_value:expr $(,)?) => {
        run_endpoint_err!($runner => $endpoint, common::make_params($params_value))
    };

    ($runner:expr, $endpoint:ident $(,)?) => {
        run_endpoint_err!($runner => $endpoint, common::empty_params())
    };

    ($runner:expr => $endpoint:ident, $params:expr) => {
        match deepwell::endpoints::all::$endpoint($runner.context(), $params).await {
            Err(error) => error,
            Ok(_) => {
                panic!(
                    "Call to method '{}' succeeded when it should have failed",
                    stringify!($endpoint),
                );
            }
        }
    };
}
