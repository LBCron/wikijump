/*
 * endpoints/page_revision.rs
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

use super::prelude::*;
use crate::models::page_revision::Model as PageRevisionModel;
use crate::services::page::{GetPageReference, PageService};
use crate::services::page_revision::{
    CountPageRevisions, GetPageRevision, GetPageRevisionByIdDetails,
    GetPageRevisionDetails, GetPageRevisionDiff, GetPageRevisionRangeDetails,
    PageRevisionCountOutput, PageRevisionDiffOutput, PageRevisionModelFiltered,
    UpdatePageRevisionDetails,
};
use crate::services::permission::PermissionService;
use crate::services::{MutationAuthorization, TextService};
use crate::types::{Action, PageDetails, Permission, Reference, Resource};
use ftml::data::UserInfo;
use std::borrow::Cow;
use std::collections::{BTreeMap, BTreeSet};

pub async fn page_revision_count(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<PageRevisionCountOutput> {
    let GetPageReference {
        site_id,
        page: reference,
    } = parse!(params, PageRevision);

    let make_error =
        || Error::new("failed to get page revision count", ErrorType::PageRevision);

    let page_id = ensure_page_view_permission(ctx, site_id, reference)
        .await
        .or_raise(make_error)?;

    let revision_count =
        PageRevisionService::count(ctx, CountPageRevisions { site_id, page_id })
            .await
            .or_raise(make_error)?;

    Ok(PageRevisionCountOutput {
        revision_count,
        first_revision: 0,
        last_revision: revision_count.get() - 1,
    })
}

pub async fn page_revision_get(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Option<PageRevisionModelFiltered>> {
    let GetPageRevisionDetails { input, details } = parse!(params, PageRevision);

    let make_error =
        || Error::new("failed to get a page revision", ErrorType::PageRevision);

    ensure_page_view_permission(ctx, input.site_id, Reference::Id(input.page_id))
        .await
        .or_raise(make_error)?;

    let revision = PageRevisionService::get_optional(ctx, input)
        .await
        .or_raise(make_error)?;

    match revision {
        None => Ok(None),
        Some(revision) => {
            let authors = resolve_revision_authors(ctx, std::slice::from_ref(&revision))
                .await
                .or_raise(make_error)?;
            let author = authors.get(&revision.user_id).cloned();
            let revision = filter_and_populate_revision(ctx, revision, details, author)
                .await
                .or_raise(make_error)?;

            Ok(Some(revision))
        }
    }
}

pub async fn page_revision_get_by_id(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Option<PageRevisionModelFiltered>> {
    let GetPageRevisionByIdDetails {
        site_id,
        revision_id,
        details,
    } = parse!(params, PageRevision);
    let make_error = || {
        Error::new(
            "failed to get a page revision by ID",
            ErrorType::PageRevision,
        )
    };

    let Some(coordinate) =
        PageRevisionService::get_coordinate_by_id(ctx, site_id, revision_id)
            .await
            .or_raise(make_error)?
    else {
        return Ok(None);
    };

    ensure_page_view_permission(ctx, site_id, Reference::Id(coordinate.page_id))
        .await
        .or_raise(make_error)?;

    let revision = PageRevisionService::get_optional(
        ctx,
        GetPageRevision {
            site_id,
            page_id: coordinate.page_id,
            revision_number: coordinate.revision_number,
        },
    )
    .await
    .or_raise(make_error)?;

    match revision {
        None => Ok(None),
        Some(revision) => {
            let authors = resolve_revision_authors(ctx, std::slice::from_ref(&revision))
                .await
                .or_raise(make_error)?;
            let author = authors.get(&revision.user_id).cloned();
            let revision = filter_and_populate_revision(ctx, revision, details, author)
                .await
                .or_raise(make_error)?;

            Ok(Some(revision))
        }
    }
}

pub async fn page_revision_edit(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<PageRevisionModelFiltered> {
    let UpdatePageRevisionDetails { input, details } = parse!(params, PageRevision);
    let make_error =
        || Error::new("failed to edit a page revision", ErrorType::PageRevision);

    MutationAuthorization::require_matching_actor(
        ctx,
        input.user_id,
        "edit page revision visibility",
    )?;
    let page = PageService::get_direct_optional_for_update(ctx, input.page_id, false)
        .await
        .or_raise(make_error)?
        .filter(|page| page.site_id == input.site_id)
        .ok_or_else(make_error)?;
    MutationAuthorization::require_permission(
        ctx,
        input.site_id,
        Some(Reference::Id(input.page_id)),
        Permission {
            resource_type: Resource::Page,
            resource_category: Some(Reference::Id(page.page_category_id)),
            action: Action::Edit,
        },
        "edit page revision visibility",
    )
    .await?;

    info!(
        "Editing revision ID {} for page ID {} in site ID {}",
        input.revision_id, input.page_id, input.site_id,
    );

    let revision_id = input.revision_id;
    PageRevisionService::update(ctx, input)
        .await
        .or_raise(make_error)?;
    let revision = PageRevisionService::get_direct(ctx, revision_id).await;
    let revision = raise_multiple!(revision; make_error);
    let authors = resolve_revision_authors(ctx, std::slice::from_ref(&revision))
        .await
        .or_raise(make_error)?;
    let author = authors.get(&revision.user_id).cloned();

    filter_and_populate_revision(ctx, revision, details, author)
        .await
        .or_raise(make_error)
}

pub async fn page_revision_range(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Vec<PageRevisionModelFiltered>> {
    let GetPageRevisionRangeDetails { input, details } = parse!(params, PageRevision);

    let make_error = || {
        Error::new(
            "failed to get a range of page revisions",
            ErrorType::PageRevision,
        )
    };

    ensure_page_view_permission(ctx, input.site_id, Reference::Id(input.page_id))
        .await
        .or_raise(make_error)?;

    let revisions = PageRevisionService::get_range(ctx, input)
        .await
        .or_raise(make_error)?;

    filter_and_populate_revisions(ctx, revisions, details)
        .await
        .or_raise(make_error)
}

pub async fn page_revision_diff(
    ctx: &ServiceContext<'_>,
    params: Params<'static>,
) -> Result<Option<PageRevisionDiffOutput>> {
    let input: GetPageRevisionDiff = parse!(params, PageRevision);
    let make_error =
        || Error::new("failed to compare page revisions", ErrorType::PageRevision);

    ensure_page_view_permission(ctx, input.site_id, Reference::Id(input.page_id))
        .await
        .or_raise(make_error)?;

    PageRevisionService::get_diff(ctx, input)
        .await
        .or_raise(make_error)
}

async fn ensure_page_view_permission(
    ctx: &ServiceContext<'_>,
    site_id: i64,
    page_reference: Reference<'_>,
) -> Result<i64> {
    let make_error = || {
        Error::new(
            "failed to check page view permission",
            ErrorType::Permission,
        )
    };

    let page = PageService::get(ctx, site_id, page_reference)
        .await
        .or_raise(make_error)?;

    let can_view =
        PermissionService::check_user_can_view_page(ctx, ctx.request().user_id, &page)
            .await
            .or_raise(make_error)?;

    if can_view {
        Ok(page.page_id)
    } else {
        Err(Error::new(
            "user does not have permission to view this page",
            ErrorType::PermissionDenied,
        )
        .into())
    }
}

async fn filter_and_populate_revision(
    ctx: &ServiceContext<'_>,
    model: PageRevisionModel,
    mut details: PageDetails,
    author: Option<UserInfo<'static>>,
) -> Result<PageRevisionModelFiltered> {
    let PageRevisionModel {
        revision_id,
        revision_type,
        created_at,
        updated_at,
        from_wikidot,
        revision_number,
        page_id,
        site_id,
        user_id,
        anonymous_author_ip,
        changes,
        wikitext_hash,
        compiled_body_html_hash,
        compiled_body_styles_hash,
        compiled_top_bar_html_hash,
        compiled_side_bar_html_hash,
        compiled_at,
        compiled_generator,
        comments,
        hidden,
        title,
        mut alt_title,
        slug,
        tags,
    } = model;

    let author = match (author, anonymous_author_ip) {
        (Some(mut author), Some(ip))
            if user_id == crate::constants::ANONYMOUS_USER_ID =>
        {
            author.user_name = Cow::Owned(format!("{} ({ip})", author.user_name));
            Some(author)
        }
        (author, _) => author,
    };

    let make_error = || {
        Error::new(
            "failed to filter and populate revision data",
            ErrorType::PageRevision,
        )
    };

    let mut comments = Some(comments);
    let mut title = Some(title);
    let mut slug = Some(slug);
    let mut tags = Some(tags);

    let parsed_hidden = PageRevisionService::parse_hidden_fields(&hidden)?;
    if parsed_hidden.wikitext {
        details.wikitext = false;
    }
    if parsed_hidden.compiled {
        details.compiled_html = false;
    }
    if parsed_hidden.comments {
        comments = None;
    }
    if parsed_hidden.title {
        title = None;
    }
    if parsed_hidden.alt_title {
        alt_title = None;
    }
    if parsed_hidden.slug {
        slug = None;
    }
    if parsed_hidden.tags {
        tags = None;
    }

    let (
        wikitext,
        compiled_body_html,
        compiled_body_styles,
        compiled_top_bar_html,
        compiled_side_bar_html,
    ) = join!(
        TextService::get_conditional(ctx, details.wikitext, &wikitext_hash),
        TextService::get_conditional(
            ctx,
            details.compiled_html,
            &compiled_body_html_hash,
        ),
        TextService::get_conditional_option(
            ctx,
            details.compiled_html,
            &compiled_body_styles_hash,
        ),
        TextService::get_conditional_option(
            ctx,
            details.compiled_html,
            &compiled_top_bar_html_hash,
        ),
        TextService::get_conditional_option(
            ctx,
            details.compiled_html,
            &compiled_side_bar_html_hash,
        ),
    );

    let wikitext = wikitext.or_raise(make_error)?;
    let compiled_body_html = compiled_body_html.or_raise(make_error)?;
    let compiled_body_styles = compiled_body_styles.or_raise(make_error)?;
    let compiled_body_styles = if details.compiled_html {
        Some(
            compiled_body_styles
                .map(|styles| {
                    crate::services::render::compiled_styles::decode(&styles)
                        .map(|compiled| compiled.styles)
                })
                .transpose()
                .or_raise(make_error)?
                .unwrap_or_default(),
        )
    } else {
        None
    };
    let compiled_top_bar_html = compiled_top_bar_html.or_raise(make_error)?;
    let compiled_side_bar_html = compiled_side_bar_html.or_raise(make_error)?;

    Ok(PageRevisionModelFiltered {
        revision_id,
        revision_type,
        created_at,
        updated_at,
        from_wikidot,
        revision_number,
        page_id,
        site_id,
        user_id,
        author,
        changes,
        wikitext,
        compiled_body_html,
        compiled_body_styles,
        compiled_top_bar_html,
        compiled_side_bar_html,
        compiled_at,
        compiled_generator,
        comments,
        hidden,
        title,
        alt_title,
        slug,
        tags,
    })
}

async fn filter_and_populate_revisions(
    ctx: &ServiceContext<'_>,
    revisions: Vec<PageRevisionModel>,
    details: PageDetails,
) -> Result<Vec<PageRevisionModelFiltered>> {
    let mut f_revisions = Vec::with_capacity(revisions.len());

    let make_error = || {
        Error::new(
            "failed to populate a list of revisions",
            ErrorType::PageRevision,
        )
    };

    let authors = resolve_revision_authors(ctx, &revisions)
        .await
        .or_raise(make_error)?;
    for revision in revisions {
        let author = authors.get(&revision.user_id).cloned();
        let f_revision = filter_and_populate_revision(ctx, revision, details, author)
            .await
            .or_raise(make_error)?;

        f_revisions.push(f_revision)
    }

    Ok(f_revisions)
}

async fn resolve_revision_authors(
    ctx: &ServiceContext<'_>,
    revisions: &[PageRevisionModel],
) -> Result<BTreeMap<i64, UserInfo<'static>>> {
    let user_ids = revisions
        .iter()
        .map(|revision| revision.user_id)
        .collect::<BTreeSet<_>>();
    let mut authors = BTreeMap::new();
    for user_id in user_ids {
        let Some(user) = UserService::get_optional(ctx, Reference::Id(user_id)).await?
        else {
            continue;
        };
        if let Some(author) = user.into_public_identity() {
            authors.insert(user_id, author);
        }
    }
    Ok(authors)
}
