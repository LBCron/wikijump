/*
 * services/render/render_dependency.rs
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

use std::collections::BTreeSet;
use std::sync::LazyLock;

use regex::Regex;

use super::count_pages_recognition::recognize_count_pages_modules;
use super::count_pages_recognition::wikitext_has_executable_count_pages_module;
use super::include_resolution::wikitext_has_executable_include;
use super::list_pages::wikitext_has_executable_list_pages_module;
use super::literal_regions::LiteralRegionIndex;
use super::pages::wikitext_has_executable_pages_module;
use super::pages_by_tag::{PAGES_BY_TAG_MODULE_REGEX, parse_pages_by_tag_arguments};
use super::runtime_modules::wikitext_has_executable_tag_cloud_module;
use super::user_directory::wikitext_has_executable_members_module;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum RenderDependencyClass {
    RevisionLocal,
    SourceDependent,
    QueryDependent,
    ViewerDependent,
    RequestDependent,
    UnsupportedUnverified,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RenderDependencyClasses(BTreeSet<RenderDependencyClass>);

impl RenderDependencyClasses {
    fn revision_local() -> Self {
        let mut classes = BTreeSet::new();
        classes.insert(RenderDependencyClass::RevisionLocal);
        Self(classes)
    }

    fn insert(&mut self, class: RenderDependencyClass) {
        if class != RenderDependencyClass::RevisionLocal {
            self.0.remove(&RenderDependencyClass::RevisionLocal);
        }
        self.0.insert(class);
    }

    pub fn contains(&self, class: RenderDependencyClass) -> bool {
        self.0.contains(&class)
    }
}

const MODULE_QUERY_NAMES: &[&str] = &[
    "listpages",
    "backlinks",
    "categories",
    "tagcloud",
    "frontspecialmini",
    "sitestagcloud",
    "ratedpages",
    "childpages",
    "pagetree",
    "nextpage",
    "previouspage",
    "orphanedpages",
    "wantedpages",
];
const MODULE_VIEWER_NAMES: &[&str] = &[
    "rate",
    "newpage",
    "createaccount",
    "newsite",
    "clone",
    "join",
    "membershipapply",
    "membershipbypassword",
    "managesite",
    "petitionadmin",
];
const MODULE_REQUEST_NAMES: &[&str] = &["deleteaccount"];
const MODULE_STATIC_NAMES: &[&str] = &["css"];

static INCLUDE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)\[\[include(?:\s|\]\])")
        .expect("include regular expression should compile")
});
static EMPTY_LABEL_WIKIDOT_LINK_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)\[\[\[[^\]\|]+?\|\s*\]\]\]")
        .expect("empty-label Wikidot link regular expression should compile")
});
static SOURCE_PAGE_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:nav:top|nav:side|_template)\b")
        .expect("source dependency page regular expression should compile")
});
static MODULE_MARKER_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)\[\[module(?P<tail>[^\]]*)")
        .expect("module regular expression should compile")
});
static REQUEST_MARKER_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)@URL").expect("request marker regular expression should compile")
});
static WIKIDOT_USER_LINK_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\[\[\*user\b")
        .expect("Wikidot user link regular expression should compile")
});

pub fn classify_render_dependencies(source: &str) -> RenderDependencyClasses {
    classify_dependencies(source, false)
}

pub fn classify_anonymous_render_dependencies(source: &str) -> RenderDependencyClasses {
    classify_dependencies(source, true)
}

fn classify_dependencies(source: &str, anonymous: bool) -> RenderDependencyClasses {
    let mut classes = RenderDependencyClasses::revision_local();
    if wikitext_has_executable_members_module(source) {
        classes.insert(RenderDependencyClass::QueryDependent);
    }
    if wikitext_has_executable_list_pages_module(source)
        || wikitext_has_executable_tag_cloud_module(source)
    {
        classes.insert(RenderDependencyClass::QueryDependent);
    }
    if wikitext_has_executable_pages_module(source) {
        classes.insert(RenderDependencyClass::QueryDependent);
        classes.insert(RenderDependencyClass::RequestDependent);
    }
    let count_pages_literal_regions = source
        .to_ascii_lowercase()
        .contains("countpages")
        .then(|| LiteralRegionIndex::new_count_pages_syntax(source));
    let count_pages_recognition = count_pages_literal_regions
        .as_ref()
        .map(|_| recognize_count_pages_modules(source));
    let pages_by_tag_literal_regions = PAGES_BY_TAG_MODULE_REGEX
        .is_match(source)
        .then(|| LiteralRegionIndex::new_wikidot_module_recognition(source));
    let module_literal_regions = MODULE_MARKER_REGEX
        .is_match(source)
        .then(|| LiteralRegionIndex::new_wikidot_module_recognition(source));

    if INCLUDE_REGEX.is_match(source)
        || EMPTY_LABEL_WIKIDOT_LINK_REGEX.is_match(source)
        || SOURCE_PAGE_REGEX.is_match(source)
    {
        classes.insert(RenderDependencyClass::SourceDependent);
    }

    if REQUEST_MARKER_REGEX.find_iter(source).any(|marker| {
        !count_pages_recognition.as_ref().is_some_and(|recognition| {
            recognition.owns_static_fallback_marker(marker.start()..marker.end())
        })
    }) {
        classes.insert(RenderDependencyClass::RequestDependent);
    }

    if WIKIDOT_USER_LINK_REGEX.is_match(source) {
        classes.insert(RenderDependencyClass::SourceDependent);
    }

    for captures in MODULE_MARKER_REGEX.captures_iter(source) {
        let module_start = captures
            .get(0)
            .expect("module marker captures the full match")
            .start();
        let Some(name) = captures
            .name("tail")
            .and_then(|tail| safely_parsed_module_name(tail.as_str()))
        else {
            classes.insert(RenderDependencyClass::UnsupportedUnverified);
            continue;
        };

        let name = name.to_ascii_lowercase();
        if name != "countpages"
            && module_literal_regions
                .as_ref()
                .is_some_and(|literal_regions| literal_regions.contains(module_start))
        {
            continue;
        }
        if name == "countpages" {
            if count_pages_literal_regions
                .as_ref()
                .is_some_and(|literal_regions| literal_regions.contains(module_start))
                || count_pages_recognition
                    .as_ref()
                    .is_some_and(|recognition| recognition.is_literal_at(module_start))
            {
                continue;
            }
            if count_pages_recognition
                .as_ref()
                .is_some_and(|recognition| recognition.is_executable_at(module_start))
            {
                classes.insert(RenderDependencyClass::QueryDependent);
            } else {
                classes.insert(RenderDependencyClass::UnsupportedUnverified);
            }
            continue;
        }
        if name == "pagesbytag" {
            if pages_by_tag_literal_regions
                .as_ref()
                .is_some_and(|literal_regions| literal_regions.contains(module_start))
            {
                continue;
            }
            if supported_pages_by_tag_module_at(source, module_start) {
                classes.insert(RenderDependencyClass::QueryDependent);
                classes.insert(RenderDependencyClass::RequestDependent);
            } else {
                classes.insert(RenderDependencyClass::UnsupportedUnverified);
            }
            continue;
        }
        if matches!(name.as_str(), "listpages" | "pages" | "tagcloud") {
            continue;
        }
        if name == "members" {
            continue;
        }
        if MODULE_QUERY_NAMES.contains(&name.as_str()) {
            classes.insert(RenderDependencyClass::QueryDependent);
            continue;
        }

        if MODULE_VIEWER_NAMES.contains(&name.as_str()) {
            if !(anonymous && name == "rate") {
                classes.insert(RenderDependencyClass::ViewerDependent);
            }
            continue;
        }

        if MODULE_REQUEST_NAMES.contains(&name.as_str()) {
            classes.insert(RenderDependencyClass::RequestDependent);
            continue;
        }

        if MODULE_STATIC_NAMES.contains(&name.as_str()) {
            continue;
        }

        classes.insert(RenderDependencyClass::UnsupportedUnverified);
    }

    classes
}

pub(crate) fn wikitext_needs_latest_revision_for_render(wikitext: &str) -> bool {
    wikitext_has_executable_list_pages_module(wikitext)
        || wikitext_has_executable_count_pages_module(wikitext)
        || wikitext_has_executable_pages_module(wikitext)
        || wikitext_has_executable_tag_cloud_module(wikitext)
        || wikitext_has_executable_include(wikitext)
        || classify_render_dependencies(wikitext)
            .contains(RenderDependencyClass::QueryDependent)
}

fn supported_pages_by_tag_module_at(source: &str, module_start: usize) -> bool {
    PAGES_BY_TAG_MODULE_REGEX
        .captures_at(source, module_start)
        .is_some_and(|captures| {
            captures
                .get(0)
                .is_some_and(|module| module.start() == module_start)
                && captures.name("head").is_some_and(|head| {
                    parse_pages_by_tag_arguments(head.as_str()).is_some()
                })
        })
}

fn safely_parsed_module_name(tail: &str) -> Option<&str> {
    let trimmed = tail.strip_prefix(char::is_whitespace)?;
    let name_end = trimmed
        .find(|character: char| {
            !character.is_ascii_alphanumeric() && character != '_' && character != '-'
        })
        .unwrap_or(trimmed.len());
    let name = &trimmed[..name_end];

    if name
        .chars()
        .next()
        .is_some_and(|character| character.is_ascii_alphabetic())
    {
        Some(name)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::{
        RenderDependencyClass, classify_anonymous_render_dependencies,
        classify_render_dependencies, wikitext_needs_latest_revision_for_render,
    };

    #[test]
    fn first_revision_rerender_covers_current_page_query_modules() {
        for source in [
            "[[module PageTree showRoot=\"true\" depth=\"1\"]]",
            "[[module PreviousPage]]\n%%linked_title%%\n[[/module]]",
            "[[module NextPage by=\"title\"]]\n%%linked_title%%\n[[/module]]",
            "[[module Categories]]",
            "[[module ChildPages]]",
        ] {
            assert!(
                wikitext_needs_latest_revision_for_render(source),
                "{source}"
            );
        }
    }

    #[test]
    fn render_dependency_plain_source_is_revision_local() {
        let classes =
            classify_render_dependencies("Plain paragraph.\n\n[[div]]Static[[/div]]");

        assert!(classes.contains(RenderDependencyClass::RevisionLocal));
        assert!(!classes.contains(RenderDependencyClass::SourceDependent));
        assert!(!classes.contains(RenderDependencyClass::QueryDependent));
        assert!(!classes.contains(RenderDependencyClass::ViewerDependent));
        assert!(!classes.contains(RenderDependencyClass::RequestDependent));
        assert!(!classes.contains(RenderDependencyClass::UnsupportedUnverified));
    }

    #[test]
    fn render_dependency_include_source_is_source_dependent() {
        let classes =
            classify_render_dependencies("[[include component:license-box]]\nBody text.");

        assert!(classes.contains(RenderDependencyClass::SourceDependent));
        assert!(!classes.contains(RenderDependencyClass::RevisionLocal));
    }

    #[test]
    fn render_dependency_empty_label_wikidot_link_is_source_dependent() {
        let classes = classify_render_dependencies("[[[some-page|]]]");

        assert!(classes.contains(RenderDependencyClass::SourceDependent));
        assert!(!classes.contains(RenderDependencyClass::RevisionLocal));
    }

    #[test]
    fn render_dependency_whitespace_empty_label_wikidot_link_is_source_dependent() {
        let classes = classify_render_dependencies("[[[some-page | ]]]");

        assert!(classes.contains(RenderDependencyClass::SourceDependent));
        assert!(!classes.contains(RenderDependencyClass::RevisionLocal));
    }

    #[test]
    fn render_dependency_query_module_is_query_dependent() {
        for source in [
            "[[module ListPages category=\"fragment\"]]%%content%%[[/module]]",
            "[[module CountPages category=\"news\"]][[/module]]",
            "[[module RatedPages category=\"news\" limit=\"10\"]]",
            "[[module Pages]]",
            "[[module ChildPages]]",
            "[[module NextPage by=\"title\"]]%%linked_title%%[[/module]]",
            "[[module PreviousPage]]%%linked_title%%[[/module]]",
            "[[module OrphanedPages]]",
            "[[module WantedPages]]",
        ] {
            let classes = classify_render_dependencies(source);

            assert!(classes.contains(RenderDependencyClass::QueryDependent));
            assert!(!classes.contains(RenderDependencyClass::RevisionLocal));
        }
    }

    #[test]
    fn count_pages_dependencies_follow_executable_runtime_recognition() {
        for source in [
            "[[module CountPages category=\"news\"]]%%total%%[[/module]]",
            "[[module CountPages category=\"news\" tags=\"@URL|+fresh\"]]%%total%%[[/module]]",
            "[[module CountPages category=\"*\"]]%%total%%[[/module]]",
        ] {
            let classes = classify_render_dependencies(source);
            assert!(
                classes.contains(RenderDependencyClass::QueryDependent),
                "{source}",
            );
            assert!(
                !classes.contains(RenderDependencyClass::RequestDependent),
                "{source}",
            );
            assert!(
                !classes.contains(RenderDependencyClass::UnsupportedUnverified),
                "{source}",
            );
        }

        for source in [
            "[[code]]\n[[module CountPages category=\"news\"]]%%total%%[[/module]]\n[[/code]]",
            "[[module CountPages]][[/module]]",
        ] {
            let classes = classify_render_dependencies(source);
            assert!(
                classes.contains(RenderDependencyClass::RevisionLocal),
                "{source}",
            );
            assert!(
                !classes.contains(RenderDependencyClass::QueryDependent),
                "{source}",
            );
            assert!(
                !classes.contains(RenderDependencyClass::UnsupportedUnverified),
                "{source}",
            );
        }

        let source = "[[module CountPages tags=\"@URL\"]]%%total%%[[/module]]";
        let classes = classify_render_dependencies(source);
        assert!(
            classes.contains(RenderDependencyClass::UnsupportedUnverified),
            "{source}",
        );
        assert!(
            !classes.contains(RenderDependencyClass::QueryDependent),
            "{source}",
        );
        assert!(
            !classes.contains(RenderDependencyClass::RevisionLocal),
            "{source}",
        );
        assert!(
            classify_render_dependencies(
                "[[module CountPages tags=\"@URL\"]]%%total%%[[/module]]",
            )
            .contains(RenderDependencyClass::RequestDependent),
        );
        assert!(
            !classify_render_dependencies(
                "[[module CountPages category=\"*\"]]%%total%%[[/module]]",
            )
            .contains(RenderDependencyClass::RequestDependent),
        );

        let mixed = classify_render_dependencies(concat!(
            "[[module CountPages category=\"news\"]]%%total%%[[/module]]\n",
            "[[module CountPages tags=\"@URL\"]]%%total%%[[/module]]",
        ));
        assert!(mixed.contains(RenderDependencyClass::QueryDependent));
        assert!(mixed.contains(RenderDependencyClass::UnsupportedUnverified));
        assert!(mixed.contains(RenderDependencyClass::RequestDependent));

        for source in [
            concat!(
                "outside @URL|request\n",
                "[[module CountPages category=\"news\" tags=\"@URL|+fresh\"]]%%total%%[[/module]]",
            ),
            concat!(
                "[[module CountPages category=\"news\" tags=\"@URL|+fresh\"]]%%total%%[[/module]]\n",
                "[[module ListPages tags=\"@URL|other\"]]%%title%%[[/module]]",
            ),
        ] {
            let classes = classify_render_dependencies(source);
            assert!(classes.contains(RenderDependencyClass::RequestDependent));
        }
    }

    #[test]
    fn render_dependency_wikidot_user_link_is_source_dependent() {
        let classes = classify_render_dependencies("[[*user example]]");

        assert!(classes.contains(RenderDependencyClass::SourceDependent));
        assert!(!classes.contains(RenderDependencyClass::ViewerDependent));
        assert!(!classes.contains(RenderDependencyClass::RevisionLocal));
    }

    #[test]
    fn count_pages_static_url_fallback_is_not_request_dependent() {
        for source in [
            "[[module CountPages category=\"news\" offset=\"@URL|0\"]][[/module]]",
            "[[module CountPages category=\"news\" tags=\"@URL |+fresh\"]][[/module]]",
        ] {
            let classes = classify_render_dependencies(source);

            assert!(
                classes.contains(RenderDependencyClass::QueryDependent),
                "{source}",
            );
            assert!(
                !classes.contains(RenderDependencyClass::RequestDependent),
                "{source}",
            );
            assert!(
                !classes.contains(RenderDependencyClass::RevisionLocal),
                "{source}",
            );
        }
    }

    #[test]
    fn count_pages_only_owns_recognized_static_url_fallback_selectors() {
        for source in [
            concat!(
                "[[module CountPages category=\"news\" tags=\"@URL|+fresh\" ",
                "form=\"@URL|external\"]]%%total%%[[/module]]",
            ),
            concat!(
                "[[module CountPages category=\"news\" ",
                "tags=\"x@URL|+fresh\"]]%%total%%[[/module]]",
            ),
        ] {
            let classes = classify_render_dependencies(source);

            assert!(
                classes.contains(RenderDependencyClass::QueryDependent),
                "{source}",
            );
            assert!(
                classes.contains(RenderDependencyClass::RequestDependent),
                "{source}",
            );
            assert!(
                !classes.contains(RenderDependencyClass::UnsupportedUnverified),
                "{source}",
            );
        }
    }

    #[test]
    fn pages_is_query_and_request_dependent() {
        let classes = classify_render_dependencies("[[module Pages]]");

        assert!(classes.contains(RenderDependencyClass::QueryDependent));
        assert!(classes.contains(RenderDependencyClass::RequestDependent));
        assert!(!classes.contains(RenderDependencyClass::RevisionLocal));
    }

    #[test]
    fn pages_by_tag_is_query_and_conservatively_request_dependent() {
        let classes = classify_render_dependencies(
            r#"[[module PagesByTag tag="alpha" category="news"]]"#,
        );

        assert!(classes.contains(RenderDependencyClass::QueryDependent));
        assert!(classes.contains(RenderDependencyClass::RequestDependent));
        assert!(!classes.contains(RenderDependencyClass::RevisionLocal));
        assert!(!classes.contains(RenderDependencyClass::UnsupportedUnverified));
    }

    #[test]
    fn unsupported_pages_by_tag_head_is_unsupported_without_query_dependencies() {
        for source in [
            r#"[[module PagesByTag tag="alpha" limit="5"]]"#,
            r#"[[module PagesByTag tag="alpha"]"#,
            r#"[[module PagesByTag tag="alpha""#,
        ] {
            let classes = classify_render_dependencies(source);

            assert!(
                classes.contains(RenderDependencyClass::UnsupportedUnverified),
                "{source}",
            );
            assert!(!classes.contains(RenderDependencyClass::QueryDependent));
            assert!(!classes.contains(RenderDependencyClass::RequestDependent));
            assert!(!classes.contains(RenderDependencyClass::RevisionLocal));
        }
    }

    #[test]
    fn literal_pages_by_tag_text_is_revision_local() {
        let classes = classify_render_dependencies(
            "[[code]]\n[[module PagesByTag tag=\"alpha\"]]\n[[/code]]",
        );

        assert!(classes.contains(RenderDependencyClass::RevisionLocal));
        assert!(!classes.contains(RenderDependencyClass::QueryDependent));
        assert!(!classes.contains(RenderDependencyClass::RequestDependent));
        assert!(!classes.contains(RenderDependencyClass::UnsupportedUnverified));
    }

    #[test]
    fn literal_generic_module_text_is_revision_local() {
        for source in [
            "[[code]]\n[[module ListPages tags=\"+fresh\"]]%%fullname%%[[/module]]\n[[/code]]",
            "[[code]]\n[[module Pages]]\n[[/code]]",
            "<pre>[[module TagCloud]]</pre>",
        ] {
            let classes = classify_render_dependencies(source);
            assert!(
                classes.contains(RenderDependencyClass::RevisionLocal),
                "{source}",
            );
            assert!(
                !classes.contains(RenderDependencyClass::QueryDependent),
                "{source}",
            );
            assert!(
                !classes.contains(RenderDependencyClass::RequestDependent),
                "{source}",
            );
            assert!(
                !classes.contains(RenderDependencyClass::UnsupportedUnverified),
                "{source}",
            );
        }
    }

    #[test]
    fn render_dependency_unknown_dynamic_marker_is_unsupported() {
        let classes =
            classify_render_dependencies("[[module MagicWidget mode=\"live\"]]");

        assert!(classes.contains(RenderDependencyClass::UnsupportedUnverified));
        assert!(!classes.contains(RenderDependencyClass::RevisionLocal));
    }

    #[test]
    fn render_dependency_malformed_module_markers_are_unsupported() {
        for source in [
            "[[module]]",
            "[[module 123]]",
            "[[moduleListPages]]",
            "[[module123]]",
            "[[module_unknown]]",
        ] {
            let classes = classify_render_dependencies(source);

            assert!(classes.contains(RenderDependencyClass::UnsupportedUnverified));
            assert!(!classes.contains(RenderDependencyClass::RevisionLocal));
        }
    }

    #[test]
    fn render_dependency_viewer_module_is_viewer_dependent() {
        for source in [
            "[[module Rate]]",
            "[[module NewPage]]",
            "[[module CreateAccount]]",
            "[[module NewSite]]",
            "[[module Clone]]",
            "[[module Join]]",
            "[[module MembershipApply]]",
            "[[module MembershipByPassword]]",
            "[[module ManageSite]]",
            "[[module PetitionAdmin]]",
        ] {
            let classes = classify_render_dependencies(source);

            assert!(classes.contains(RenderDependencyClass::ViewerDependent));
            assert!(!classes.contains(RenderDependencyClass::RevisionLocal));
        }
    }

    #[test]
    fn hardened_www_system_modules_keep_their_runtime_dependency_classes() {
        for source in [
            "[[module FrontSpecialMini]]",
            "[[module SitesTagCloud limit=\"200\"]]",
        ] {
            let classes = classify_render_dependencies(source);
            assert!(classes.contains(RenderDependencyClass::QueryDependent));
            assert!(!classes.contains(RenderDependencyClass::UnsupportedUnverified));
        }
        let delete_account = classify_render_dependencies("[[module DeleteAccount]]");
        assert!(delete_account.contains(RenderDependencyClass::RequestDependent));
        assert!(!delete_account.contains(RenderDependencyClass::UnsupportedUnverified));
    }

    #[test]
    fn members_dependencies_follow_executable_runtime_recognition() {
        for source in [
            "[[module Members]]",
            r#"[[module Members group="moderators" order="nameDesc"]]"#,
            r#"[[module Members group="owners"]]"#,
            r#"[[module Members limit="1" foo="bar"]]"#,
        ] {
            let classes = classify_render_dependencies(source);
            assert!(
                classes.contains(RenderDependencyClass::QueryDependent),
                "{source}",
            );
            assert!(
                !classes.contains(RenderDependencyClass::ViewerDependent),
                "{source}",
            );
            assert!(
                !classes.contains(RenderDependencyClass::UnsupportedUnverified),
                "{source}",
            );
        }

        for source in [
            "[[code]]\n[[module Members]]\n[[/code]]",
            "<pre>[[module Members]]</pre>",
            "[[module Members]]x[[/module]]",
            "[[module Members]]x",
        ] {
            let classes = classify_render_dependencies(source);
            assert!(
                classes.contains(RenderDependencyClass::RevisionLocal),
                "{source}",
            );
            assert!(
                !classes.contains(RenderDependencyClass::QueryDependent),
                "{source}",
            );
            assert!(
                !classes.contains(RenderDependencyClass::ViewerDependent),
                "{source}",
            );
            assert!(
                !classes.contains(RenderDependencyClass::UnsupportedUnverified),
                "{source}",
            );
        }
    }

    #[test]
    fn render_dependency_multiple_classes_are_retained() {
        let classes = classify_render_dependencies(
            "[[include nav:side]]\n[[module TagCloud category=\"news\"]]\n[[module ListPages offset=\"@URL|1\"]]%%content%%[[/module]]",
        );

        assert!(classes.contains(RenderDependencyClass::SourceDependent));
        assert!(classes.contains(RenderDependencyClass::QueryDependent));
        assert!(classes.contains(RenderDependencyClass::RequestDependent));
        assert!(!classes.contains(RenderDependencyClass::RevisionLocal));
    }

    #[test]
    fn anonymous_classification_ignores_only_the_rating_widget() {
        let rate = "[[module Rate]]";
        assert!(
            classify_render_dependencies(rate)
                .contains(RenderDependencyClass::ViewerDependent)
        );
        assert!(
            !classify_anonymous_render_dependencies(rate)
                .contains(RenderDependencyClass::ViewerDependent)
        );

        let mixed = "[[module Rate]]\n[[module NewPage]]";
        assert!(
            classify_anonymous_render_dependencies(mixed)
                .contains(RenderDependencyClass::ViewerDependent)
        );
    }
}
