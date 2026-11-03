/*
 * services/render/include_variables.rs
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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

use super::compat::text_fragments::CompatTextFragments;
use super::include_comment_branches::remove_unresolved_include_comment_branches_source_local;
use super::include_variable_iftags::resolve_include_variable_iftags;
use super::service::{
    INCLUDE_VARIABLE_CLOSE_SENTINEL, INCLUDE_VARIABLE_OPEN_SENTINEL,
    INCLUDE_VARIABLE_REGEX, MAX_INCLUDE_EXPANSION_DEPTH,
};
use crate::error::prelude::{Error, ErrorType, ExnError, Result};
use ftml::data::PageInfo;
use ftml::includes::IncludeRef;
use ftml::{self};
use std::borrow::Cow;
use std::collections::HashSet;

pub(super) const MAX_INCLUDE_VARIABLE_EXPANDED_BYTES: usize = 768_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct PassProjection {
    output_bytes: usize,
    changed: bool,
}

#[derive(Clone, Default)]
struct SelfReferenceGuard {
    names: HashSet<String>,
}

impl SelfReferenceGuard {
    fn blocks(&self, name: &str) -> bool {
        self.names.contains(name)
    }

    fn observe(&mut self, name: &str, value: &str, reference: &str) {
        if value.contains(reference) {
            self.names.insert(name.to_owned());
        }
    }
}

pub(super) fn apply_include_variables(
    content: &mut String,
    include: &IncludeRef<'_>,
) -> Result<()> {
    apply_include_variables_with_limits(
        content,
        include,
        MAX_INCLUDE_EXPANSION_DEPTH,
        MAX_INCLUDE_VARIABLE_EXPANDED_BYTES,
    )
}

fn apply_include_variables_with_limits(
    content: &mut String,
    include: &IncludeRef<'_>,
    maximum_passes: usize,
    maximum_output_bytes: usize,
) -> Result<()> {
    let mut self_referential_names = SelfReferenceGuard::default();

    for _ in 0..maximum_passes {
        let Some(projection) = project_include_variable_pass(
            content,
            include,
            &self_referential_names,
            maximum_output_bytes,
        )?
        else {
            break;
        };

        let mut expanded = String::with_capacity(projection.output_bytes);
        let mut previous_end = 0;
        let mut matched = false;
        let mut changed = false;

        for capture in INCLUDE_VARIABLE_REGEX.captures_iter(content) {
            let mtch = capture.get(0).unwrap();
            let name = &capture["name"];

            if self_referential_names.blocks(name) {
                continue;
            }

            if let Some(value) = include_variable_value(include, name) {
                expanded.push_str(&content[previous_end..mtch.start()]);
                expanded.push_str(&value);
                previous_end = mtch.end();
                matched = true;
                self_referential_names.observe(name, &value, mtch.as_str());
                changed |= value != mtch.as_str();
            }
        }

        if !matched {
            break;
        }

        expanded.push_str(&content[previous_end..]);
        *content = expanded;
        debug_assert_eq!(content.len(), projection.output_bytes);
        if !changed {
            break;
        }
    }

    Ok(())
}

fn project_include_variable_pass(
    content: &str,
    include: &IncludeRef<'_>,
    self_referential_names: &SelfReferenceGuard,
    maximum_output_bytes: usize,
) -> Result<Option<PassProjection>> {
    let mut projected_self_referential_names = self_referential_names.clone();
    let mut output_bytes = 0;
    let mut previous_end = 0;
    let mut matched = false;
    let mut changed = false;

    for capture in INCLUDE_VARIABLE_REGEX.captures_iter(content) {
        let mtch = capture.get(0).expect("full include variable match");
        let name = &capture["name"];
        if projected_self_referential_names.blocks(name) {
            continue;
        }

        let Some(value) = include_variable_value(include, name) else {
            continue;
        };

        output_bytes = checked_projected_add(
            output_bytes,
            mtch.start() - previous_end,
            maximum_output_bytes,
        )?;
        output_bytes =
            checked_projected_add(output_bytes, value.len(), maximum_output_bytes)?;
        previous_end = mtch.end();
        matched = true;
        projected_self_referential_names.observe(name, &value, mtch.as_str());
        changed |= value != mtch.as_str();
    }

    if !matched {
        return Ok(None);
    }

    output_bytes = checked_projected_add(
        output_bytes,
        content.len() - previous_end,
        maximum_output_bytes,
    )?;
    Ok(Some(PassProjection {
        output_bytes,
        changed,
    }))
}

fn checked_projected_add(
    current: usize,
    additional: usize,
    maximum_output_bytes: usize,
) -> Result<usize> {
    let Some(projected) = current.checked_add(additional) else {
        return Err(include_variable_expansion_limit_error(maximum_output_bytes));
    };
    if projected > maximum_output_bytes {
        return Err(include_variable_expansion_limit_error(maximum_output_bytes));
    }
    Ok(projected)
}

fn include_variable_expansion_limit_error(maximum_output_bytes: usize) -> ExnError {
    Error::new(
        format!(
            "include variable expansion exceeded maximum output size of {maximum_output_bytes} bytes"
        ),
        ErrorType::Render,
    )
    .into()
}

fn include_variable_value<'a>(
    include: &'a IncludeRef<'_>,
    name: &str,
) -> Option<Cow<'a, str>> {
    include
        .variables()
        .get(name)
        .map(|value| Cow::Borrowed(trim_include_variable_value(value)))
        .or_else(|| default_include_variable_value(name).map(Cow::Owned))
}

pub(super) fn apply_include_variables_before_resolving_iftags(
    content: &mut String,
    include: &IncludeRef<'_>,
    page_info: &PageInfo<'_>,
) -> Result<()> {
    apply_include_variables(content, include)?;
    resolve_include_variable_iftags(content, include.variables(), page_info);
    Ok(())
}

pub(super) fn prepare_include_source_variables_and_comment_branches(
    content: &mut String,
    include: &IncludeRef<'_>,
    page_info: &PageInfo<'_>,
    compat_text: &mut CompatTextFragments,
) -> Result<()> {
    apply_include_variables_before_resolving_iftags(content, include, page_info)?;
    remove_unresolved_include_comment_branches_source_local(content, compat_text);
    Ok(())
}

pub(super) fn trim_include_variable_value(value: &str) -> &str {
    value.trim_end_matches([' ', '\t', '\r', '\n'])
}

pub(super) fn default_include_variable_value(name: &str) -> Option<String> {
    match name.to_ascii_lowercase().as_str() {
        "author" => Some("%%created_by%%".to_owned()),
        "shadow" => Some("no".to_owned()),
        _ => None,
    }
}

pub(super) fn is_include_variable_name(name: &str) -> bool {
    !name.is_empty()
        && name.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
}

pub(super) fn protect_include_variables(content: &mut String) {
    if !content.contains("{$") {
        return;
    }
    let protected = INCLUDE_VARIABLE_REGEX
        .replace_all(content, |capture: &regex::Captures<'_>| {
            format!(
                "{}{}{}",
                INCLUDE_VARIABLE_OPEN_SENTINEL,
                &capture["name"],
                INCLUDE_VARIABLE_CLOSE_SENTINEL,
            )
        })
        .to_string();

    *content = protected;
}

pub(super) fn unprotect_include_variables(content: &mut String) {
    *content = content
        .replace(INCLUDE_VARIABLE_OPEN_SENTINEL, "{$")
        .replace(INCLUDE_VARIABLE_CLOSE_SENTINEL, "}");
}

#[cfg(test)]
mod tests {
    use super::*;
    use ftml::data::PageRef;
    use ftml::tree::VariableMap;

    fn include(variables: &[(&'static str, &'static str)]) -> IncludeRef<'static> {
        IncludeRef::new(
            PageRef::page_only("component:test"),
            variables
                .iter()
                .map(|&(name, value)| (Cow::Borrowed(name), Cow::Borrowed(value)))
                .collect::<VariableMap<'static>>(),
        )
    }

    #[test]
    fn rejects_recursive_growth_before_allocating_the_over_budget_pass() {
        let include = include(&[("x", "{$y}{$y}{$y}{$y}"), ("y", "{$x}{$x}{$x}{$x}")]);
        let mut content = "{$x}".to_owned();

        let error = apply_include_variables_with_limits(&mut content, &include, 8, 1_024)
            .expect_err("the fifth recursive pass must exceed the byte budget");

        assert_eq!(content.len(), 1_024);
        assert!(format!("{error:?}").contains("maximum output size of 1024 bytes"));
    }

    #[test]
    fn permits_output_exactly_at_the_byte_budget() {
        let include = include(&[("x", "{$y}{$y}{$y}{$y}"), ("y", "{$x}{$x}{$x}{$x}")]);
        let mut content = "{$x}".to_owned();

        apply_include_variables_with_limits(&mut content, &include, 4, 1_024)
            .expect("an output exactly at the budget must remain valid");

        assert_eq!(content.len(), 1_024);
    }

    #[test]
    fn rejects_projection_arithmetic_overflow() {
        let error = checked_projected_add(usize::MAX, 1, usize::MAX)
            .expect_err("projection overflow must fail closed");

        assert!(format!("{error:?}").contains("maximum output size"));
    }

    #[test]
    fn preserves_legitimate_recursive_resolution() {
        let include =
            include(&[("outer", "before {$inner} after"), ("inner", "resolved")]);
        let mut content = "{$outer}".to_owned();

        apply_include_variables_with_limits(&mut content, &include, 8, 64)
            .expect("small recursive substitution must remain valid");

        assert_eq!(content, "before resolved after");
    }
}
