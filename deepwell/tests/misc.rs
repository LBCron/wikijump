/*
 * tests/misc.rs
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

#[macro_use]
mod common;

use self::common::TestRunner;
use deepwell::error::prelude::*;
use serde_json::json;
use time::OffsetDateTime;

#[tokio::test]
async fn misc() {
    let runner = TestRunner::setup().await;

    run_endpoint!(runner, ping);

    let object = run_endpoint!(runner, echo, json!(["foo bar"]));
    assert_eq!(object, json!(["foo bar"]));

    let object = run_endpoint!(runner, echo, json!({"apple": "red", "banana": "yellow"}));
    assert_eq!(object, json!({"apple": "red", "banana": "yellow"}));

    let error = run_endpoint_err!(runner, yield_error);
    assert_contains_error!(error, ErrorType::BadRequest);

    let config = run_endpoint!(runner, config_dump);
    assert_eq!(config, runner.config().raw_toml);

    let normalized = run_endpoint!(runner, normalize_method, json!(["SCP-001"]));
    assert_eq!(normalized, "scp-001");

    let normalized =
        run_endpoint!(runner, normalize_method, json!(["Wanderer's Library"]));
    assert_eq!(normalized, "wanderer-s-library");

    let normalized = run_endpoint!(runner, normalize_method, json!(["abc-xyz"]));
    assert_eq!(normalized, "abc-xyz");

    run_endpoint_err!(runner, normalize_method, json!({"foo": "bar"}));

    let info = run_endpoint!(runner, server_info);
    assert_eq!(info.package.name, deepwell::info::PKG_NAME);
    assert_eq!(info.package.version, *deepwell::info::VERSION_INFO);
    assert_eq!(info.package.description, deepwell::info::PKG_DESCRIPTION);
    assert_eq!(info.package.license, deepwell::info::PKG_LICENSE);
    assert_eq!(info.package.repository, deepwell::info::PKG_REPOSITORY);
    assert_eq!(info.compile_info.built_at, *deepwell::info::BUILT_TIME_UTC);
    assert_eq!(
        info.compile_info.rustc_version,
        deepwell::info::RUSTC_VERSION,
    );
    assert_eq!(info.compile_info.endian, deepwell::info::CFG_ENDIAN);
    assert_eq!(info.compile_info.target, deepwell::info::TARGET);
    assert_eq!(info.compile_info.threads, deepwell::info::NUM_JOBS);
    assert_eq!(
        info.compile_info.git_commit,
        deepwell::info::GIT_COMMIT_HASH,
    );
    assert_eq!(info.config_path, runner.config().raw_toml_path);
    assert_eq!(info.hostname, *deepwell::info::HOSTNAME);
    assert!(info.current_time > OffsetDateTime::UNIX_EPOCH);
}
