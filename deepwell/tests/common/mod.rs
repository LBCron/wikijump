/*
 * tests/common/mod.rs
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
mod assert;

#[macro_use]
mod endpoint;

#[macro_use]
mod error;

mod audit;
mod params;
mod runner;

#[allow(unused_imports)]
pub use self::audit::*;

#[allow(unused_imports)]
pub use self::error::extract_error;

#[allow(unused_imports)]
pub use self::params::*;
pub use self::runner::TestRunner;
use deepwell::services::PageEditLockService;
use deepwell::services::page_edit_lock::AcquirePageEditLock;
use deepwell::types::{PageEditLockMode, Reference};
use std::net::{IpAddr, Ipv4Addr};

#[allow(dead_code)]
pub async fn acquire_page_edit_lease(
    runner: &TestRunner,
    site_id: i64,
    page: &serde_json::Value,
    user_id: i64,
) -> serde_json::Value {
    let page = match page {
        serde_json::Value::Number(number) => {
            Reference::Id(number.as_i64().expect("page id should be an integer"))
        }
        serde_json::Value::String(slug) => {
            Reference::Slug(std::borrow::Cow::Owned(slug.clone()))
        }
        _ => panic!("page reference should be an id or a slug: {page}"),
    };
    let output = PageEditLockService::acquire(
        runner.context(),
        AcquirePageEditLock {
            site_id,
            page,
            user_id,
            mode: PageEditLockMode::Page,
            section_index: None,
        },
    )
    .await
    .expect("test edit lease acquisition should not error");
    let grant = output
        .grant
        .expect("test edit lease acquisition should grant");
    serde_json::json!({
        "lock_id": grant.lock_id,
        "lock_secret": grant.lock_secret,
        "mode": "page",
    })
}

#[allow(dead_code)]
pub const IP_ADDRESS: IpAddr = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 10));
