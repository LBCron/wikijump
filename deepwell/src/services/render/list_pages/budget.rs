/*
 * services/render/list_pages/budget.rs
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

use super::super::service::{
    MAX_LISTPAGES_CONTENT_MODULES_PER_RENDER, MAX_LISTPAGES_CONTENT_ROWS_PER_RENDER,
};

pub(super) const MAX_LISTPAGES_TEMPLATE_BODY_BYTES: usize = 256 * 1024;

pub(super) const MAX_LISTPAGES_GENERATED_OUTPUT_BYTES_PER_RENDER: usize =
    16 * 1024 * 1024;

pub(super) const MAX_LISTPAGES_MODULES_PER_RENDER: usize = 512;

pub(super) const MAX_LISTPAGES_MODULE_SOURCE_BYTES_PER_RENDER: usize = 2 * 1024 * 1024;

#[derive(Debug)]
pub(in crate::services::render) struct ListPagesExpansionBudget {
    pub(in crate::services::render) remaining_content_modules: usize,
    pub(in crate::services::render) remaining_content_rows: usize,
    remaining_generated_output_bytes: usize,
    remaining_modules: usize,
    remaining_module_source_bytes: usize,
}

impl ListPagesExpansionBudget {
    pub(in crate::services::render) fn new() -> Self {
        Self {
            remaining_content_modules: MAX_LISTPAGES_CONTENT_MODULES_PER_RENDER,
            remaining_content_rows: MAX_LISTPAGES_CONTENT_ROWS_PER_RENDER,
            remaining_generated_output_bytes:
                MAX_LISTPAGES_GENERATED_OUTPUT_BYTES_PER_RENDER,
            remaining_modules: MAX_LISTPAGES_MODULES_PER_RENDER,
            remaining_module_source_bytes: MAX_LISTPAGES_MODULE_SOURCE_BYTES_PER_RENDER,
        }
    }

    pub(in crate::services::render) fn try_consume_modules(
        &mut self,
        modules: usize,
    ) -> bool {
        if modules > self.remaining_modules {
            self.remaining_modules = 0;
            return false;
        }
        self.remaining_modules -= modules;
        true
    }

    pub(in crate::services::render) fn try_consume_module_source_bytes(
        &mut self,
        bytes: usize,
    ) -> bool {
        if bytes > self.remaining_module_source_bytes {
            self.remaining_module_source_bytes = 0;
            return false;
        }
        self.remaining_module_source_bytes -= bytes;
        true
    }

    pub(in crate::services::render) fn try_start_content_module(&mut self) -> bool {
        if self.remaining_content_modules == 0 {
            return false;
        }
        self.remaining_content_modules -= 1;
        true
    }

    pub(in crate::services::render) fn remaining_content_rows(&self) -> usize {
        self.remaining_content_rows
    }

    pub(in crate::services::render) fn can_expand_content_rows(
        &self,
        rows: usize,
    ) -> bool {
        rows <= self.remaining_content_rows
    }

    pub(in crate::services::render) fn consume_content_rows(&mut self, rows: usize) {
        debug_assert!(self.can_expand_content_rows(rows));
        self.remaining_content_rows = self.remaining_content_rows.saturating_sub(rows);
    }

    pub(in crate::services::render) fn try_consume_generated_output_bytes(
        &mut self,
        bytes: usize,
    ) -> bool {
        if bytes > self.remaining_generated_output_bytes {
            self.remaining_generated_output_bytes = 0;
            return false;
        }
        self.remaining_generated_output_bytes -= bytes;
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::render::service::MAX_LISTPAGES_RENDER_LIMIT;

    #[test]
    fn content_row_budget_covers_the_supported_listpages_page_size() {
        let budget = ListPagesExpansionBudget::new();
        let maximum_page_rows = MAX_LISTPAGES_RENDER_LIMIT as usize;

        assert!(budget.can_expand_content_rows(maximum_page_rows));
        assert!(!budget.can_expand_content_rows(maximum_page_rows + 1));
    }
}
