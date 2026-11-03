/*
 * services/text_block/structs.rs
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

#[derive(Debug)]
pub struct TextBlock<'a> {
    pub text: &'a str,

    pub text_type: Option<&'a str>,

    pub mime: &'a str,

    pub name: Option<&'a str>,
}

#[derive(Serialize, Debug, Clone)]
pub struct TextBlockIndex {
    pub index: i16,

    pub s3_filename: String,
}

#[derive(Debug, Clone)]
pub(crate) struct TextBlockCandidate {
    pub(crate) index: i16,
    pub(crate) s3_filename: String,
}
