use crate::services::page_query::FoundPageFields;
use crate::services::render::literal_regions::LiteralRegionIndex;
use regex::Regex;
use std::collections::BTreeSet;
use std::sync::LazyLock;

use super::budget::MAX_LISTPAGES_TEMPLATE_BODY_BYTES;

pub(in crate::services::render) static LISTPAGES_VARIABLE_REGEX: LazyLock<Regex> =
    LazyLock::new(|| {
        Regex::new(
        r"%%(?P<name>[A-Za-z0-9_]+)(?:\{(?P<argument>[A-Za-z0-9_-]+)\})?(?:\((?P<length>[0-9]+)\))?(?:\|(?P<format>(?:[^%]|%[^%])+?))?%%",
    )
    .unwrap()
    });

static LISTPAGES_SECTION_MARKER_REGEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i:\[\[(?P<close>/)?(?P<name>head|body|foot)\]\])")
        .expect("the ListPages section marker regex is valid")
});

const DEFAULT_LISTPAGES_TEMPLATE: &str = "+ %%title_linked%%\n\nby %%created_by_linked%% %%created_at|%O ago (%e %b %Y, %H:%M)%%\n\n%%summary%%";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in crate::services::render) enum ListPagesOutputShape {
    Plain,
    NumberedRows,
    TableRows,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
enum ListPagesVariable {
    TitleLinked,
    Title,
    Slug,
    FullSlug,
    Link,
    CreatedBy,
    CreatedByLinked,
    CreatedByUnix,
    CreatedById,
    CreatedAt,
    UpdatedBy,
    UpdatedByUnix,
    UpdatedById,
    UpdatedAt,
    CommentedBy,
    CommentedAt,
    Rating,
    RatingVotes,
    RatingPercent,
    Comments,
    Tags,
    TagsLinked,
    HiddenTagsLinked,
    RawTags,
    Category,
    Size,
    SiteDomain,
    SiteTitle,
    SiteName,
    ParentFullname,
    ParentName,
    ParentCategory,
    ParentTitle,
    ParentTitleLinked,
    Revisions,
    Children,
    FormData,
    Content,
    Preview,
    Summary,
    Index,
    Total,
    Limit,
    TotalOrLimit,
}

impl ListPagesVariable {
    fn parse(name: &str) -> Option<Self> {
        match name.to_ascii_lowercase().as_str() {
            "title_linked" | "linked_title" => Some(Self::TitleLinked),
            "title" => Some(Self::Title),
            "name" | "slug" | "page_name" => Some(Self::Slug),
            "fullname" | "full_slug" | "page_unix_name" | "full_page_name" => {
                Some(Self::FullSlug)
            }
            "link" => Some(Self::Link),
            "created_by" | "createdby" => Some(Self::CreatedBy),
            "created_by_linked" | "createdbylinked" | "author" => {
                Some(Self::CreatedByLinked)
            }
            "created_by_unix" => Some(Self::CreatedByUnix),
            "created_by_id" => Some(Self::CreatedById),
            "created_at" | "createdat" | "date" => Some(Self::CreatedAt),
            "updated_by" | "updatedby" | "updated_by_linked" | "updatedbylinked"
            | "author_edited" | "user_edited" => Some(Self::UpdatedBy),
            "updated_by_unix" => Some(Self::UpdatedByUnix),
            "updated_by_id" => Some(Self::UpdatedById),
            "updated_at" | "updatedat" | "date_edited" => Some(Self::UpdatedAt),
            "commented_by"
            | "commentedby"
            | "commented_by_linked"
            | "commentedbylinked"
            | "commented_by_unix"
            | "commented_by_id" => Some(Self::CommentedBy),
            "commented_at" | "commentedat" => Some(Self::CommentedAt),
            "rating" => Some(Self::Rating),
            "rating_votes" | "ratingvotes" => Some(Self::RatingVotes),
            "rating_percent" => Some(Self::RatingPercent),
            "comments" => Some(Self::Comments),
            "tags" => Some(Self::Tags),
            "tags_linked" | "tagslinked" => Some(Self::TagsLinked),
            "_tags_linked" => Some(Self::HiddenTagsLinked),
            "_tags" => Some(Self::RawTags),
            "category" => Some(Self::Category),
            "size" => Some(Self::Size),
            "site_domain" => Some(Self::SiteDomain),
            "site_title" => Some(Self::SiteTitle),
            "site_name" => Some(Self::SiteName),
            "parent_fullname" => Some(Self::ParentFullname),
            "parent_name" => Some(Self::ParentName),
            "parent_category" => Some(Self::ParentCategory),
            "parent_title" => Some(Self::ParentTitle),
            "parent_title_linked" => Some(Self::ParentTitleLinked),
            "revisions" => Some(Self::Revisions),
            "children" => Some(Self::Children),
            "form_data" | "form_raw" | "form_label" | "form_hint" => Some(Self::FormData),
            "content" | "text" | "long" | "body" => Some(Self::Content),
            "preview" => Some(Self::Preview),
            "summary" | "first_paragraph" | "description" | "short" => {
                Some(Self::Summary)
            }
            "index" => Some(Self::Index),
            "total" => Some(Self::Total),
            "limit" => Some(Self::Limit),
            "total_or_limit" => Some(Self::TotalOrLimit),
            _ => None,
        }
    }

    fn supports_suffix(
        self,
        argument: Option<&str>,
        length: Option<&str>,
        format: Option<&str>,
    ) -> bool {
        match self {
            Self::FormData => argument.is_some() && length.is_none() && format.is_none(),
            Self::Content => {
                argument.is_none_or(|value| {
                    !value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit())
                }) && length.is_none()
                    && format.is_none()
            }
            Self::Preview => {
                argument.is_none()
                    && length.is_none_or(|value| {
                        !value.is_empty()
                            && value.bytes().all(|byte| byte.is_ascii_digit())
                    })
                    && format.is_none()
            }
            Self::CreatedAt
            | Self::UpdatedAt
            | Self::CommentedAt
            | Self::TagsLinked
            | Self::HiddenTagsLinked => argument.is_none() && length.is_none(),
            _ => argument.is_none() && length.is_none() && format.is_none(),
        }
    }
}

pub(in crate::services::render) fn list_pages_variable_capture_is_valid(
    captures: &regex::Captures<'_>,
) -> bool {
    ListPagesVariable::parse(&captures["name"]).is_some_and(|variable| {
        variable.supports_suffix(
            captures.name("argument").map(|matched| matched.as_str()),
            captures.name("length").map(|matched| matched.as_str()),
            captures.name("format").map(|matched| matched.as_str()),
        )
    })
}

pub(in crate::services::render) fn list_pages_variable_capture_has_unknown_name(
    captures: &regex::Captures<'_>,
) -> bool {
    ListPagesVariable::parse(&captures["name"]).is_none()
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ListPagesVariables(u64);

impl ListPagesVariables {
    fn insert(&mut self, variable: ListPagesVariable) {
        self.0 |= 1_u64 << variable as u8;
    }

    fn contains(self, variable: ListPagesVariable) -> bool {
        self.0 & (1_u64 << variable as u8) != 0
    }

    fn intersects(self, variables: &[ListPagesVariable]) -> bool {
        variables
            .iter()
            .copied()
            .any(|variable| self.contains(variable))
    }
}

#[derive(Debug)]
pub(in crate::services::render) struct ListPagesTemplatePlan {
    body: String,
    default_template: bool,
    default_summary_first_paragraph: bool,
    sections: ListPagesSections,
    variables: ListPagesVariables,
    fields: FoundPageFields,
    content_sections: BTreeSet<Option<usize>>,
    output_shape: ListPagesOutputShape,
    rating_only: bool,
    has_unknown_variables: bool,
    #[cfg(test)]
    variable_traversals: usize,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct ListPagesSections {
    head: Option<String>,
    head_starts_on_next_line: bool,
    foot: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ListPagesSectionKind {
    Head,
    Body,
    Foot,
}

impl ListPagesSectionKind {
    fn parse(name: &str) -> Self {
        match name.to_ascii_lowercase().as_str() {
            "head" => Self::Head,
            "body" => Self::Body,
            "foot" => Self::Foot,
            _ => unreachable!("the section marker regex limits section names"),
        }
    }

    fn index(self) -> usize {
        match self {
            Self::Head => 0,
            Self::Body => 1,
            Self::Foot => 2,
        }
    }
}

#[derive(Clone, Copy, Debug)]
struct ListPagesSectionMarker {
    kind: ListPagesSectionKind,
    start: usize,
    end: usize,
}

#[derive(Clone, Copy, Debug)]
struct ListPagesSectionPair {
    kind: ListPagesSectionKind,
    open_start: usize,
    content_start: usize,
    content_end: usize,
    close_end: usize,
}

fn split_list_pages_sections(body: &str) -> Option<(ListPagesSections, String, bool)> {
    let literal_regions = LiteralRegionIndex::new(body);
    let mut stacks: [Vec<ListPagesSectionMarker>; 3] =
        std::array::from_fn(|_| Vec::new());
    let mut pairs = Vec::new();
    let mut body_open = None;
    let mut body_pair = None;

    for captures in LISTPAGES_SECTION_MARKER_REGEX.captures_iter(body) {
        let matched = captures
            .get(0)
            .expect("the section marker regex has a whole match");
        if literal_regions.contains(matched.start()) {
            continue;
        }
        let kind = ListPagesSectionKind::parse(&captures["name"]);
        if kind == ListPagesSectionKind::Body {
            if captures.name("close").is_none() {
                if body_pair.is_none() && body_open.is_none() {
                    body_open = Some(ListPagesSectionMarker {
                        kind,
                        start: matched.start(),
                        end: matched.end(),
                    });
                }
            } else if body_pair.is_none()
                && let Some(open) = body_open.take()
            {
                body_pair = Some(ListPagesSectionPair {
                    kind,
                    open_start: open.start,
                    content_start: open.end,
                    content_end: matched.start(),
                    close_end: matched.end(),
                });
            }
            continue;
        }
        if captures.name("close").is_none() {
            stacks[kind.index()].push(ListPagesSectionMarker {
                kind,
                start: matched.start(),
                end: matched.end(),
            });
            continue;
        }

        if let Some(open) = stacks[kind.index()].pop() {
            debug_assert_eq!(open.kind, kind);
            pairs.push(ListPagesSectionPair {
                kind,
                open_start: open.start,
                content_start: open.end,
                content_end: matched.start(),
                close_end: matched.end(),
            });
        }
    }

    let Some(body_pair) = body_pair else {
        return Some((ListPagesSections::default(), body.to_owned(), false));
    };

    let valid_head_gap_starts = section_gap_closure_suffixes(
        body,
        body_pair.open_start,
        ListPagesSectionKind::Head,
    );
    let head_pair = pairs.iter().rev().find(|pair| {
        pair.kind == ListPagesSectionKind::Head
            && pair.close_end <= body_pair.open_start
            && valid_head_gap_starts.contains(&pair.close_end)
    });
    let head_starts_on_next_line = head_pair.is_some_and(|pair| {
        matches!(
            body[pair.content_start..pair.content_end]
                .trim_start_matches([' ', '\t'])
                .as_bytes()
                .first(),
            Some(b'\r' | b'\n')
        )
    });
    let head = head_pair.map(|pair| {
        let mut content = body[pair.content_start..pair.content_end].trim().to_owned();
        let residual = body[pair.close_end..body_pair.open_start].trim();
        if !residual.is_empty() {
            content.push_str(residual);
        }
        content
    });
    let foot = pairs
        .iter()
        .filter(|pair| {
            pair.kind == ListPagesSectionKind::Foot
                && pair.open_start >= body_pair.close_end
                && body[body_pair.close_end..pair.open_start].trim().is_empty()
        })
        .min_by_key(|pair| pair.open_start)
        .map(|pair| body[pair.content_start..pair.content_end].trim().to_owned());

    Some((
        ListPagesSections {
            head,
            head_starts_on_next_line,
            foot,
        },
        body[body_pair.content_start..body_pair.content_end]
            .trim()
            .to_owned(),
        true,
    ))
}

fn section_gap_closure_suffixes(
    source: &str,
    end: usize,
    kind: ListPagesSectionKind,
) -> BTreeSet<usize> {
    let mut cursor = end;
    let mut valid = true;
    let mut starts = BTreeSet::new();
    let markers = LISTPAGES_SECTION_MARKER_REGEX
        .captures_iter(&source[..end])
        .collect::<Vec<_>>();
    for captures in markers.into_iter().rev() {
        let matched = captures
            .get(0)
            .expect("the section marker regex has a whole match");
        if !source[matched.end()..cursor].trim().is_empty()
            || captures.name("close").is_none()
            || ListPagesSectionKind::parse(&captures["name"]) != kind
        {
            valid = false;
        }
        if valid {
            starts.insert(matched.end());
        }
        cursor = matched.start();
    }
    starts
}

impl ListPagesTemplatePlan {
    pub(in crate::services::render) fn empty_row() -> Self {
        let variables = ListPagesVariables::default();
        Self {
            body: String::new(),
            default_template: false,
            default_summary_first_paragraph: false,
            sections: ListPagesSections::default(),
            variables,
            fields: found_page_fields(variables),
            content_sections: BTreeSet::new(),
            output_shape: ListPagesOutputShape::Plain,
            rating_only: false,
            has_unknown_variables: false,
            #[cfg(test)]
            variable_traversals: 0,
        }
    }

    pub(in crate::services::render) fn compile(body: &str) -> Option<Self> {
        if body.len() > MAX_LISTPAGES_TEMPLATE_BODY_BYTES {
            return None;
        }
        let (sections, body, explicit_body_section) = split_list_pages_sections(body)?;
        let default_template = body.trim().is_empty();
        let default_summary_first_paragraph = default_template && !explicit_body_section;
        let body = match body.trim() {
            "" => DEFAULT_LISTPAGES_TEMPLATE,
            body => body,
        };
        let mut variables = ListPagesVariables::default();
        let mut content_sections = BTreeSet::new();
        let mut variable_count = 0;
        let mut rating_only = true;
        let mut has_unknown_variables = false;

        for captures in LISTPAGES_VARIABLE_REGEX.captures_iter(body) {
            let Some(variable) = ListPagesVariable::parse(&captures["name"]) else {
                has_unknown_variables = true;
                continue;
            };
            if !variable.supports_suffix(
                captures.name("argument").map(|matched| matched.as_str()),
                captures.name("length").map(|matched| matched.as_str()),
                captures.name("format").map(|matched| matched.as_str()),
            ) {
                has_unknown_variables = true;
                continue;
            }
            variable_count += 1;
            rating_only &= variable == ListPagesVariable::Rating;
            variables.insert(variable);
            if variable == ListPagesVariable::Content {
                content_sections.insert(
                    captures
                        .name("argument")
                        .and_then(|matched| matched.as_str().parse().ok()),
                );
            }
        }

        Some(Self {
            body: body.to_owned(),
            default_template,
            default_summary_first_paragraph,
            sections,
            variables,
            fields: found_page_fields(variables),
            content_sections,
            output_shape: output_shape(body),
            rating_only: variable_count > 0 && rating_only,
            has_unknown_variables,
            #[cfg(test)]
            variable_traversals: 1,
        })
    }

    pub(in crate::services::render) fn body(&self) -> &str {
        &self.body
    }

    pub(in crate::services::render) fn is_default_template(&self) -> bool {
        self.default_template
    }

    pub(in crate::services::render) fn default_summary_first_paragraph(&self) -> bool {
        self.default_summary_first_paragraph
    }

    pub(in crate::services::render) fn use_full_default_summary(&mut self) {
        if self.default_template {
            self.default_summary_first_paragraph = false;
        }
    }

    pub(in crate::services::render) fn head_section(&self) -> Option<&str> {
        self.sections.head.as_deref()
    }

    pub(in crate::services::render) fn head_row_separator(&self) -> &'static str {
        if self.sections.head_starts_on_next_line {
            "\n\n"
        } else {
            "\n"
        }
    }

    pub(in crate::services::render) fn foot_section(&self) -> Option<&str> {
        self.sections.foot.as_deref()
    }

    pub(in crate::services::render) fn has_sections(&self) -> bool {
        self.sections != ListPagesSections::default()
    }

    pub(in crate::services::render) fn fields(&self) -> FoundPageFields {
        self.fields.clone()
    }

    pub(in crate::services::render) fn output_shape(&self) -> ListPagesOutputShape {
        self.output_shape
    }

    pub(in crate::services::render) fn uses_title(&self) -> bool {
        self.variables
            .intersects(&[ListPagesVariable::Title, ListPagesVariable::TitleLinked])
    }

    pub(in crate::services::render) fn uses_created_by(&self) -> bool {
        self.variables.intersects(&[
            ListPagesVariable::CreatedBy,
            ListPagesVariable::CreatedByLinked,
            ListPagesVariable::CreatedByUnix,
            ListPagesVariable::CreatedById,
        ])
    }

    pub(in crate::services::render) fn uses_created_by_unix(&self) -> bool {
        self.variables.contains(ListPagesVariable::CreatedByUnix)
    }

    pub(in crate::services::render) fn uses_created_at(&self) -> bool {
        self.variables.contains(ListPagesVariable::CreatedAt)
    }

    pub(in crate::services::render) fn uses_updated_by(&self) -> bool {
        self.variables.intersects(&[
            ListPagesVariable::UpdatedBy,
            ListPagesVariable::UpdatedByUnix,
            ListPagesVariable::UpdatedById,
        ])
    }

    pub(in crate::services::render) fn uses_updated_at(&self) -> bool {
        self.variables.contains(ListPagesVariable::UpdatedAt)
    }

    pub(in crate::services::render) fn uses_comments(&self) -> bool {
        self.variables.contains(ListPagesVariable::Comments)
    }

    pub(in crate::services::render) fn uses_commented_by(&self) -> bool {
        self.variables.contains(ListPagesVariable::CommentedBy)
    }

    pub(in crate::services::render) fn uses_commented_at(&self) -> bool {
        self.variables.contains(ListPagesVariable::CommentedAt)
    }

    pub(in crate::services::render) fn uses_rating_votes(&self) -> bool {
        self.variables.contains(ListPagesVariable::RatingVotes)
    }

    pub(in crate::services::render) fn uses_rating(&self) -> bool {
        self.variables.contains(ListPagesVariable::Rating)
    }

    pub(in crate::services::render) fn uses_rating_percent(&self) -> bool {
        self.variables.contains(ListPagesVariable::RatingPercent)
    }

    pub(in crate::services::render) fn uses_content(&self) -> bool {
        self.variables.intersects(&[
            ListPagesVariable::Content,
            ListPagesVariable::Preview,
            ListPagesVariable::Summary,
        ])
    }

    pub(in crate::services::render) fn uses_first_paragraph(&self) -> bool {
        self.variables.contains(ListPagesVariable::Summary)
    }

    pub(in crate::services::render) fn uses_preview(&self) -> bool {
        self.variables.contains(ListPagesVariable::Preview)
    }

    pub(in crate::services::render) fn uses_size(&self) -> bool {
        self.variables.contains(ListPagesVariable::Size)
    }

    pub(in crate::services::render) fn uses_site_domain(&self) -> bool {
        self.variables.contains(ListPagesVariable::SiteDomain)
    }

    pub(in crate::services::render) fn uses_site_title(&self) -> bool {
        self.variables.contains(ListPagesVariable::SiteTitle)
    }

    pub(in crate::services::render) fn uses_parent_metadata(&self) -> bool {
        self.variables.intersects(&[
            ListPagesVariable::ParentFullname,
            ListPagesVariable::ParentName,
            ListPagesVariable::ParentCategory,
            ListPagesVariable::ParentTitle,
            ListPagesVariable::ParentTitleLinked,
        ])
    }

    pub(in crate::services::render) fn uses_total(&self) -> bool {
        self.variables.contains(ListPagesVariable::Total)
    }

    pub(in crate::services::render) fn uses_revisions(&self) -> bool {
        self.variables.contains(ListPagesVariable::Revisions)
    }

    pub(in crate::services::render) fn uses_children(&self) -> bool {
        self.variables.contains(ListPagesVariable::Children)
    }

    pub(in crate::services::render) fn content_sections(
        &self,
    ) -> &BTreeSet<Option<usize>> {
        &self.content_sections
    }

    pub(in crate::services::render) fn uses_data_form(&self) -> bool {
        self.variables.contains(ListPagesVariable::FormData)
    }

    pub(in crate::services::render) fn mentions_data_form(&self) -> bool {
        LISTPAGES_VARIABLE_REGEX
            .captures_iter(&self.body)
            .any(|captures| {
                ListPagesVariable::parse(&captures["name"])
                    == Some(ListPagesVariable::FormData)
            })
    }

    pub(in crate::services::render) fn uses_only_rating(&self) -> bool {
        self.rating_only
    }

    pub(in crate::services::render) fn has_unknown_variables(&self) -> bool {
        self.has_unknown_variables
    }

    #[cfg(test)]
    fn variable_traversals(&self) -> usize {
        self.variable_traversals
    }
}

fn found_page_fields(variables: ListPagesVariables) -> FoundPageFields {
    let created_by = variables.intersects(&[
        ListPagesVariable::CreatedBy,
        ListPagesVariable::CreatedByLinked,
        ListPagesVariable::CreatedByUnix,
        ListPagesVariable::CreatedById,
    ]);
    let rating_votes = variables.contains(ListPagesVariable::RatingVotes);
    FoundPageFields {
        title: true,
        slug: true,
        page_category_id: true,
        created_by,
        created_at: variables.contains(ListPagesVariable::CreatedAt),
        tags: variables.intersects(&[
            ListPagesVariable::Tags,
            ListPagesVariable::TagsLinked,
            ListPagesVariable::HiddenTagsLinked,
            ListPagesVariable::RawTags,
        ]),
        updated_by: variables.intersects(&[
            ListPagesVariable::UpdatedBy,
            ListPagesVariable::UpdatedByUnix,
            ListPagesVariable::UpdatedById,
        ]),
        updated_at: variables.contains(ListPagesVariable::UpdatedAt),
        score: variables.contains(ListPagesVariable::Rating)
            || variables.contains(ListPagesVariable::RatingPercent)
            || rating_votes,
        revision_count: variables.contains(ListPagesVariable::Revisions),
        ..Default::default()
    }
}

fn output_shape(body: &str) -> ListPagesOutputShape {
    let mut saw_nonempty = false;
    let mut table_rows = true;
    let mut numbered_rows = false;
    for line in body.lines().filter(|line| !line.trim().is_empty()) {
        saw_nonempty = true;
        let trimmed = line.trim();
        table_rows &= trimmed.ends_with("||")
            && (trimmed.starts_with("||=") || trimmed.starts_with("||~"));
        numbered_rows |= line.trim_start_matches(' ').starts_with("# ");
    }

    if saw_nonempty && table_rows {
        ListPagesOutputShape::TableRows
    } else if numbered_rows {
        ListPagesOutputShape::NumberedRows
    } else {
        ListPagesOutputShape::Plain
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compiles_aliases_into_field_and_dependency_requirements_once() {
        let body = concat!(
            "%%createdbylinked%% %%date%% %%tagslinked%% %%_tags_linked%% %%updatedby%% ",
            "%%updatedat%% %%date_edited%% %%ratingvotes%% %%comments%% %%commentedby%% ",
            "%%commentedat%% %%content%% %%form_raw{status}%% %%size%% %%created_by_unix%% ",
            "%%site_domain%% %%parent_fullname%% %%revisions%% %%children%%",
        );
        let plan = ListPagesTemplatePlan::compile(body).expect("aliases should compile");

        assert!(plan.uses_created_by());
        assert!(plan.uses_created_by_unix());
        assert!(plan.uses_created_at());
        assert!(plan.uses_updated_by());
        assert!(plan.uses_updated_at());
        assert!(plan.uses_rating_votes());
        assert!(plan.uses_comments());
        assert!(plan.uses_commented_by());
        assert!(plan.uses_commented_at());
        assert!(plan.uses_content());
        assert!(plan.uses_size());
        assert!(plan.uses_site_domain());
        assert!(plan.uses_parent_metadata());
        assert!(plan.uses_revisions());
        assert!(plan.uses_children());
        assert_eq!(plan.content_sections(), &BTreeSet::from([None]));
        assert!(plan.uses_data_form());
        assert_eq!(plan.variable_traversals(), 1);
        assert_eq!(
            plan.fields(),
            FoundPageFields {
                title: true,
                slug: true,
                page_category_id: true,
                tags: true,
                created_at: true,
                created_by: true,
                updated_at: true,
                updated_by: true,
                score: true,
                revision_count: true,
                ..Default::default()
            }
        );
    }

    #[test]
    fn preserves_unknown_names_without_hiding_known_variable_dependencies() {
        let plan = ListPagesTemplatePlan::compile(
            "%%unsupported%%|%%created_at%%|%%createdbyunix%%",
        )
        .expect("unknown variable names should remain local to their tokens");

        assert_eq!(
            plan.body(),
            "%%unsupported%%|%%created_at%%|%%createdbyunix%%",
        );
        assert!(plan.uses_created_at());
        assert!(plan.has_unknown_variables());
        assert!(
            !ListPagesTemplatePlan::compile("%%created_at%%")
                .expect("known variable should compile")
                .has_unknown_variables()
        );
        let sectioned = ListPagesTemplatePlan::compile(concat!(
            "[[body]]\n",
            "[[image https://tracker.invalid/%%unsupported%%]]\n",
            "[[/body]]",
        ))
        .expect("a sectioned tracking template should compile before policy filtering");
        assert_eq!(
            sectioned.body(),
            "[[image https://tracker.invalid/%%unsupported%%]]"
        );
        assert!(sectioned.has_unknown_variables());
        assert!(ListPagesTemplatePlan::compile("%%form_data%%").is_some());
        assert!(ListPagesTemplatePlan::compile("%%form_raw%%").is_some());
    }

    #[test]
    fn incomplete_unknown_variable_does_not_consume_the_next_known_token() {
        let body = "BEGIN|%%unknown|%%title%%|END";
        let plan = ListPagesTemplatePlan::compile(body)
            .expect("an incomplete unknown token must not abort the row plan");

        assert_eq!(plan.body(), body);
        assert!(plan.fields().title, "the later title dependency was hidden");
        assert!(
            !plan.has_unknown_variables(),
            "an unclosed delimiter is source text, not a complete unknown variable",
        );

        let captures = LISTPAGES_VARIABLE_REGEX
            .captures_iter(body)
            .map(|captures| captures[0].to_owned())
            .collect::<Vec<_>>();
        assert_eq!(captures, ["%%title%%"]);

        for token in [
            "%%unknown|x%%",
            "%%created_at|%Y/%m/%d%%",
            "%%created_at|%O ago (%e %b %Y, %H:%M)%%",
        ] {
            assert_eq!(
                LISTPAGES_VARIABLE_REGEX
                    .find(token)
                    .map(|matched| matched.as_str()),
                Some(token),
                "non-empty formats with ordinary percent directives remain valid",
            );
        }
    }

    #[test]
    fn empty_row_is_distinct_from_the_default_template() {
        let empty = ListPagesTemplatePlan::empty_row();
        let default = ListPagesTemplatePlan::compile("")
            .expect("an ordinary empty ListPages body should use the default template");

        assert_eq!(empty.body(), "");
        assert!(!empty.is_default_template());
        assert_eq!(empty.output_shape(), ListPagesOutputShape::Plain);
        assert_eq!(empty.variable_traversals(), 0);
        assert_ne!(default.body(), empty.body());
        assert!(default.is_default_template());
    }

    #[test]
    fn records_distinct_content_sections_during_compilation() {
        let plan = ListPagesTemplatePlan::compile(
            "%%content{2}%% %%content{4}%% %%content{2}%% %%content%%",
        )
        .expect("content sections should compile");

        assert_eq!(
            plan.content_sections(),
            &BTreeSet::from([None, Some(2), Some(4)]),
        );
    }

    #[test]
    fn accepts_every_supported_bare_alias_and_family_specific_suffix() {
        for name in [
            "title_linked",
            "linked_title",
            "title",
            "name",
            "slug",
            "page_name",
            "page_unix_name",
            "full_page_name",
            "fullname",
            "full_slug",
            "link",
            "created_by",
            "createdby",
            "created_by_linked",
            "createdbylinked",
            "created_by_unix",
            "created_by_id",
            "author",
            "created_at",
            "createdat",
            "date",
            "updated_by",
            "updatedby",
            "updated_by_linked",
            "updatedbylinked",
            "author_edited",
            "user_edited",
            "updated_by_unix",
            "updated_by_id",
            "updated_at",
            "updatedat",
            "date_edited",
            "commented_by",
            "commentedby",
            "commented_by_linked",
            "commentedbylinked",
            "commented_by_unix",
            "commented_by_id",
            "commented_at",
            "commentedat",
            "rating",
            "rating_votes",
            "ratingvotes",
            "comments",
            "tags",
            "tags_linked",
            "_tags_linked",
            "category",
            "tagslinked",
            "_tags",
            "site_domain",
            "site_title",
            "site_name",
            "parent_fullname",
            "parent_name",
            "parent_category",
            "parent_title",
            "parent_title_linked",
            "size",
            "children",
            "rating_percent",
            "revisions",
            "content",
            "text",
            "long",
            "body",
            "preview",
            "summary",
            "first_paragraph",
            "description",
            "short",
            "index",
            "total",
            "limit",
            "total_or_limit",
        ] {
            let body = format!("%%{name}%%");
            assert!(
                ListPagesTemplatePlan::compile(&body).is_some(),
                "unsupported alias: {name}",
            );
        }
        for name in ["form_data", "form_raw", "form_label", "form_hint"] {
            assert!(
                ListPagesTemplatePlan::compile(&format!("%%{name}{{field-name}}%%"))
                    .is_some(),
            );
        }
        for body in [
            "%%content{2}%%",
            "%%preview(17)%%",
            "%%created_at|%Y%%",
            "%%updated_at|%Y|agohover%%",
            "%%commented_at|%%",
            "%%tags_linked|#%%",
        ] {
            assert!(
                ListPagesTemplatePlan::compile(body).is_some(),
                "unsupported family-specific suffix: {body}",
            );
        }
    }

    #[test]
    fn classifies_rating_only_and_output_shapes() {
        let rating = ListPagesTemplatePlan::compile("article [+%%rating%%]")
            .expect("rating body should compile");
        assert!(rating.uses_only_rating());
        assert_eq!(rating.output_shape(), ListPagesOutputShape::Plain);

        let numbered = ListPagesTemplatePlan::compile("# %%title%%\n# %%rating%%")
            .expect("numbered body should compile");
        assert!(!numbered.uses_only_rating());
        assert_eq!(numbered.output_shape(), ListPagesOutputShape::NumberedRows);

        let table = ListPagesTemplatePlan::compile("||~ %%title%% ||\n||= %%rating%% ||")
            .expect("table body should compile");
        assert_eq!(table.output_shape(), ListPagesOutputShape::TableRows);

        let wikidot_cells = ListPagesTemplatePlan::compile("|| %%title%% ||")
            .expect("ordinary cells should remain supported");
        assert_eq!(wikidot_cells.output_shape(), ListPagesOutputShape::Plain);
    }

    #[test]
    fn synthetic_ralliston_shape_uses_one_variable_traversal_per_template() {
        let plans = (0..191)
            .map(|index| {
                ListPagesTemplatePlan::compile(&format!(
                    "unique article {index} [+%%rating%%]"
                ))
                .expect("rating template should compile")
            })
            .collect::<Vec<_>>();

        assert_eq!(
            plans
                .iter()
                .map(ListPagesTemplatePlan::variable_traversals)
                .sum::<usize>(),
            191,
        );
        assert!(plans.iter().all(ListPagesTemplatePlan::uses_only_rating));
    }
}

#[cfg(test)]
mod section_tests {
    use super::*;

    #[test]
    fn section_recovery_scans_only_the_nearest_head_pair() {
        let source = format!("{}[[body]]B[[/body]]", "[[head]]H[[/head]]".repeat(256),);
        let plan = ListPagesTemplatePlan::compile(&source)
            .expect("repeated head sections should remain within the template limit");
        assert_eq!(plan.head_section(), Some("H"));
        assert_eq!(plan.body(), "B");
    }

    #[test]
    fn splits_the_evidenced_head_body_foot_template() {
        let plan = ListPagesTemplatePlan::compile(
            "[[head]]G59_HEAD;[[/head]][[body]]G59_BODY=%%name%%;[[/body]][[foot]]G59_FOOT;[[/foot]]",
        )
        .expect("the sectioned template should compile");

        assert_eq!(plan.head_section(), Some("G59_HEAD;"));
        assert_eq!(plan.body(), "G59_BODY=%%name%%;");
        assert_eq!(plan.foot_section(), Some("G59_FOOT;"));
        assert!(plan.has_sections());
    }

    #[test]
    fn an_unsectioned_template_is_one_per_row_body() {
        let plan = ListPagesTemplatePlan::compile("%%title_linked%%")
            .expect("an ordinary template should compile");

        assert_eq!(plan.head_section(), None);
        assert_eq!(plan.foot_section(), None);
        assert_eq!(plan.body(), "%%title_linked%%");
        assert!(!plan.has_sections());
    }

    #[test]
    fn trims_module_and_section_boundary_whitespace_before_rows_are_combined() {
        let plan = ListPagesTemplatePlan::compile(
            "\n  [[head]]\n  H\n  [[/head]]\n  [[body]]\n  B=%%name%%\n  [[/body]]\n  [[foot]]\n  F\n  [[/foot]]\n",
        )
        .expect("boundary whitespace should not split combined ListPages output");

        assert_eq!(plan.head_section(), Some("H"));
        assert_eq!(plan.body(), "B=%%name%%");
        assert_eq!(plan.foot_section(), Some("F"));
    }

    #[test]
    fn head_or_foot_without_a_body_remains_literal_row_template_text() {
        for body in ["[[head]]H[[/head]]%%name%%", "[[foot]]F[[/foot]]%%name%%"] {
            let plan = ListPagesTemplatePlan::compile(body)
                .expect("a standalone head or foot remains ordinary row text");
            assert_eq!(plan.head_section(), None);
            assert_eq!(plan.foot_section(), None);
            assert_eq!(plan.body(), body);
        }
    }

    #[test]
    fn section_recognition_is_ordered_around_the_body_pair() {
        for (source, expected_head, expected_body, expected_foot) in [
            (
                "[[head]]H[[/head]][[body]]B[[/body]][[foot]]F[[/foot]]",
                Some("H"),
                "B",
                Some("F"),
            ),
            (
                "[[head]]H[[/head]][[foot]]F[[/foot]][[body]]B[[/body]]",
                None,
                "B",
                None,
            ),
            (
                "[[body]]B[[/body]][[head]]H[[/head]][[foot]]F[[/foot]]",
                None,
                "B",
                None,
            ),
            (
                "[[body]]B[[/body]][[foot]]F[[/foot]][[head]]H[[/head]]",
                None,
                "B",
                Some("F"),
            ),
            (
                "[[foot]]F[[/foot]][[head]]H[[/head]][[body]]B[[/body]]",
                Some("H"),
                "B",
                None,
            ),
            (
                "[[foot]]F[[/foot]][[body]]B[[/body]][[head]]H[[/head]]",
                None,
                "B",
                None,
            ),
            (
                "PRE[[head]]H[[/head]]MID[[body]]B[[/body]]MID[[foot]]F[[/foot]]POST",
                None,
                "B",
                None,
            ),
        ] {
            let plan = ListPagesTemplatePlan::compile(source)
                .expect("a complete body pair should remain executable");
            assert_eq!(plan.head_section(), expected_head, "{source}");
            assert_eq!(plan.body(), expected_body, "{source}");
            assert_eq!(plan.foot_section(), expected_foot, "{source}");
        }
    }

    #[test]
    fn section_markers_are_case_insensitive_and_literal_aware() {
        let mixed = ListPagesTemplatePlan::compile(
            "[[Head]]H[[/hEAd]][[bODy]]B[[/Body]][[FOot]]F[[/fooT]]",
        )
        .expect("mixed-case section markers should compile");
        assert_eq!(mixed.head_section(), Some("H"));
        assert_eq!(mixed.body(), "B");
        assert_eq!(mixed.foot_section(), Some("F"));

        for protected_head in [
            "[!-- [[head]]H[[/head]] --]",
            "@@[[head]]H[[/head]]@@",
            "{{[[head]]H[[/head]]}}",
            "@<[[head]]>@H@<[[/head]]>@",
        ] {
            let source =
                format!("{protected_head}\n[[body]]B[[/body]]\n[[foot]]F[[/foot]]",);
            let plan = ListPagesTemplatePlan::compile(&source)
                .expect("literal-owned section markers should not block the real body");
            assert_eq!(plan.head_section(), None, "{source}");
            assert_eq!(plan.body(), "B", "{source}");
            assert_eq!(plan.foot_section(), Some("F"), "{source}");
        }
    }

    #[test]
    fn an_explicit_empty_body_uses_the_default_row_template() {
        let plan = ListPagesTemplatePlan::compile(
            "[[head]]H[[/head]][[body]][[/body]][[foot]]F[[/foot]]",
        )
        .expect("an empty body section should compile");

        assert_eq!(plan.head_section(), Some("H"));
        assert_eq!(
            plan.body(),
            concat!(
                "+ %%title_linked%%\n\n",
                "by %%created_by_linked%% ",
                "%%created_at|%O ago (%e %b %Y, %H:%M)%%\n\n",
                "%%summary%%",
            ),
        );
        assert_eq!(plan.foot_section(), Some("F"));
        assert!(plan.is_default_template());
        assert!(
            !plan.default_summary_first_paragraph(),
            "an explicit body section uses Wikidot's complete first content section",
        );

        let mut unsectioned = ListPagesTemplatePlan::compile("")
            .expect("an empty unsectioned body should use the default row");
        assert!(unsectioned.default_summary_first_paragraph());
        unsectioned.use_full_default_summary();
        assert!(
            !unsectioned.default_summary_first_paragraph(),
            "preparsed owners can select the full default summary",
        );
    }

    #[test]
    fn row_variables_in_once_emitted_sections_remain_literal() {
        let plan = ListPagesTemplatePlan::compile(
            "[[head]]H=%%title%%[[/head]][[body]]B=%%name%%[[/body]][[foot]]F=%%title%%[[/foot]]",
        )
        .expect("once-emitted row variables should not reject the body plan");

        assert_eq!(plan.head_section(), Some("H=%%title%%"));
        assert_eq!(plan.body(), "B=%%name%%");
        assert_eq!(plan.foot_section(), Some("F=%%title%%"));
    }

    #[test]
    fn repeated_and_nested_body_markers_commit_the_first_body_pair() {
        let repeated =
            ListPagesTemplatePlan::compile("[[body]]A[[/body]][[body]]B[[/body]]")
                .expect("a repeated body keeps the first completed pair");
        assert_eq!(repeated.body(), "A");

        let nested = ListPagesTemplatePlan::compile(concat!(
            "[[head]]H[[/head]]",
            "[[body]]B1[[body]]B2[[/body]]B3[[/body]]",
            "[[foot]]F[[/foot]]",
        ))
        .expect("a nested body opener remains literal inside the first body");
        assert_eq!(nested.head_section(), Some("H"));
        assert_eq!(nested.body(), "B1[[body]]B2");
        assert_eq!(nested.foot_section(), None);
    }

    #[test]
    fn extra_head_close_remains_in_the_once_emitted_head() {
        let plan = ListPagesTemplatePlan::compile(concat!(
            "[[head]]H[[/head]][[/head]]\n",
            "[[body]]B[[/body]]\n",
            "[[foot]]F[[/foot]]",
        ))
        .expect("an extra head close recovers locally before the body");

        assert_eq!(plan.head_section(), Some("H[[/head]]"));
        assert_eq!(plan.body(), "B");
        assert_eq!(plan.foot_section(), Some("F"));
    }

    #[test]
    fn unclosed_section_markers_recover_locally() {
        let unclosed_body = "[[body]]A";
        let plan = ListPagesTemplatePlan::compile(unclosed_body)
            .expect("an unclosed body marker remains ordinary row source");
        assert_eq!(plan.head_section(), None);
        assert_eq!(plan.body(), unclosed_body);
        assert_eq!(plan.foot_section(), None);

        let plan = ListPagesTemplatePlan::compile(
            "[[head]]H[[/head]][[body]]A[[/body]][[foot]]F",
        )
        .expect("an unclosed foot recovers after a valid head/body pair");
        assert_eq!(plan.head_section(), Some("H"));
        assert_eq!(plan.body(), "A");
        assert_eq!(plan.foot_section(), None);
    }
}
