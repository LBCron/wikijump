/*
 * services/render/list_pages/substitution/batch.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::ListPagesArguments;
use crate::services::page_query::{
    AuthorSelector, FoundPageFields, normalize_wikidot_author_name,
};
use crate::services::render::list_pages::template::ListPagesTemplatePlan;
use crate::services::render::module_arguments::wikidot_list_pages_arguments;
use sea_orm::FromQueryResult;
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone)]
pub(in crate::services::render) struct WikidotUserDisplay {
    pub(in crate::services::render) user_id: i64,
    pub(in crate::services::render) name: String,
    pub(in crate::services::render) slug: Option<String>,
    pub(in crate::services::render) wikidot_profile: bool,
}

#[derive(Debug, Clone)]
pub(in crate::services::render) struct ListPagesSnapshotDisplay {
    pub(in crate::services::render) title_shown: Option<String>,
    pub(in crate::services::render) created_at: time::OffsetDateTime,
    pub(in crate::services::render) updated_at: time::OffsetDateTime,
    pub(in crate::services::render) created_by_user_id: Option<i64>,
    pub(in crate::services::render) created_by_name: Option<String>,
    pub(in crate::services::render) created_by_slug: Option<String>,
    pub(in crate::services::render) updated_by_user_id: Option<i64>,
    pub(in crate::services::render) updated_by_name: Option<String>,
    pub(in crate::services::render) updated_by_slug: Option<String>,
    pub(in crate::services::render) comments: i32,
    pub(in crate::services::render) commented_at: Option<time::OffsetDateTime>,
    pub(in crate::services::render) commented_by_name: Option<String>,
    pub(in crate::services::render) rating_votes: Option<i64>,
    pub(in crate::services::render) parent_fullname: Option<String>,
    pub(in crate::services::render) source_revision_count: i32,
}

#[derive(Debug, Clone)]
pub(in crate::services::render) struct ListPagesRuntimeDisplay {
    pub(in crate::services::render) comments: i64,
    pub(in crate::services::render) commented_at: Option<time::OffsetDateTime>,
    pub(in crate::services::render) commented_by_user_id: Option<i64>,
    pub(in crate::services::render) commented_by_name: Option<String>,
    pub(in crate::services::render) commented_by_slug: Option<String>,
    pub(in crate::services::render) commented_by_wikidot_profile: bool,
    pub(in crate::services::render) rating_votes: i64,
    pub(in crate::services::render) rating_type: String,
}

#[derive(Debug, FromQueryResult)]
pub(in crate::services::render) struct CurrentPageAuthorSource {
    pub(in crate::services::render) from_wikidot: bool,
    pub(in crate::services::render) snapshot_present: bool,
    pub(in crate::services::render) created_by_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub(in crate::services::render) struct ListPagesAuthorCacheKey {
    pub(in crate::services::render) filter_present: bool,
    pub(in crate::services::render) negated: bool,
    pub(in crate::services::render) normalized_names: Vec<String>,
}

pub(in crate::services::render) fn list_pages_author_cache_key(
    author_names: &[Cow<'static, str>],
    author_filter_present: bool,
) -> ListPagesAuthorCacheKey {
    let normalized_names = author_names
        .iter()
        .filter_map(|author| {
            if author.as_ref() == "=" {
                Some("=".to_owned())
            } else {
                let normalized = normalize_wikidot_author_name(author);
                (!normalized.is_empty()).then_some(normalized)
            }
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    ListPagesAuthorCacheKey {
        filter_present: author_filter_present,
        negated: false,
        normalized_names,
    }
}

#[derive(Debug, Clone)]
pub(in crate::services::render) enum ResolvedListPagesAuthors {
    All,
    Any {
        user_ids: Vec<i64>,
        wikidot_snapshot_names: Vec<Cow<'static, str>>,
    },
    NotAny {
        user_ids: Vec<i64>,
        wikidot_snapshot_names: Vec<Cow<'static, str>>,
    },
    None,
}

impl ResolvedListPagesAuthors {
    pub(in crate::services::render) fn as_selector(&self) -> AuthorSelector<'_> {
        match self {
            Self::All => AuthorSelector::All,
            Self::Any {
                user_ids,
                wikidot_snapshot_names,
            } => AuthorSelector::Any {
                user_ids,
                wikidot_snapshot_names,
            },
            Self::NotAny {
                user_ids,
                wikidot_snapshot_names,
            } => AuthorSelector::NotAny {
                user_ids,
                wikidot_snapshot_names,
            },
            Self::None => AuthorSelector::None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(in crate::services::render) struct ExactNameListPagesBatchKey {
    pub(in crate::services::render) category_all: bool,
    pub(in crate::services::render) categories: Vec<String>,
    pub(in crate::services::render) excluded_categories: Vec<String>,
}

#[derive(Debug, Default)]
pub(in crate::services::render) struct ListPagesBatchDisplays {
    pub(in crate::services::render) user_displays: BTreeMap<i64, WikidotUserDisplay>,
    pub(in crate::services::render) snapshot_displays:
        BTreeMap<i64, ListPagesSnapshotDisplay>,
    pub(in crate::services::render) runtime_displays:
        BTreeMap<i64, ListPagesRuntimeDisplay>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(in crate::services::render) struct ListPagesBatchDisplayRequirements {
    pub(in crate::services::render) users: bool,
    pub(in crate::services::render) snapshots: bool,
    pub(in crate::services::render) runtime: bool,
}

impl ListPagesBatchDisplayRequirements {
    pub(in crate::services::render) fn include(
        &mut self,
        template: &ListPagesTemplatePlan,
    ) {
        let needs_user_displays =
            template.uses_created_by() || template.uses_updated_by();
        self.users |= needs_user_displays;
        self.snapshots |= template.uses_title()
            || needs_user_displays
            || template.uses_created_at()
            || template.uses_updated_at()
            || template.uses_parent_metadata();
        self.runtime |= template.uses_comments()
            || template.uses_commented_by()
            || template.uses_commented_at()
            || template.uses_rating()
            || template.uses_rating_percent()
            || template.uses_rating_votes();
    }
}

pub(in crate::services::render) fn exact_name_list_pages_batch_key(
    head: &str,
    template: &ListPagesTemplatePlan,
    arguments: &ListPagesArguments,
    current_category: &str,
) -> Option<ExactNameListPagesBatchKey> {
    let head_arguments = wikidot_list_pages_arguments(head);
    if template.uses_content()
        || template.uses_data_form()
        || template.mentions_data_form()
    {
        return None;
    }

    let mut name_arguments = 0;
    for argument in head_arguments {
        if argument.op != "=" {
            return None;
        }
        match argument.key.to_ascii_lowercase().as_str() {
            "name" | "fullname" => {
                name_arguments += 1;
            }
            "category" => {}
            _ => return None,
        }
    }
    if name_arguments != 1 || arguments.slug.is_none() {
        return None;
    }
    if arguments
        .slug
        .as_deref()
        .is_some_and(|slug| !slug.contains(':'))
        && arguments.category_selector_present
        && arguments
            .categories
            .iter()
            .any(|category| category.as_ref() != "_default")
    {
        return None;
    }

    let mut categories = arguments
        .categories
        .iter()
        .map(|category| category.to_string())
        .collect::<Vec<_>>();
    let category_all = if arguments.category_selector_present {
        if arguments.include_current_category {
            categories.push(current_category.to_owned());
        }
        arguments.category_all
    } else {
        categories.push(current_category.to_owned());
        false
    };

    Some(ExactNameListPagesBatchKey {
        category_all,
        categories,
        excluded_categories: arguments
            .excluded_categories
            .iter()
            .map(|category| category.to_string())
            .collect(),
    })
}

pub(in crate::services::render) fn union_found_page_fields(
    left: &mut FoundPageFields,
    right: &FoundPageFields,
) {
    left.title |= right.title;
    left.alt_title |= right.alt_title;
    left.slug |= right.slug;
    left.page_category_id |= right.page_category_id;
    left.page_revision_id |= right.page_revision_id;
    left.tags |= right.tags;
    left.created_at |= right.created_at;
    left.created_by |= right.created_by;
    left.updated_at |= right.updated_at;
    left.updated_by |= right.updated_by;
    left.score |= right.score;
    left.revision_count |= right.revision_count;
}
