/*
 * tests/common/assert.rs
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

#[allow(unused_macros)]
macro_rules! assert_str_eq {
    ($left:expr, $right:expr $(,)?) => {{
        let left: Option<&str> = $left.as_deref();
        let right: Option<&str> = $right;
        assert_eq!(left, right);
    }};
}

#[allow(unused_macros)]
macro_rules! assert_panics {
    ($expr:expr) => {
        assert!(
            std::panic::catch_unwind($expr).is_err(),
            "Expression did not panic!"
        );
    };
}
