/*
 * services/render/list_pages/rendering/count_block.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

#![allow(clippy::wildcard_imports)]

use super::*;

impl RenderService {
    pub(in crate::services::render) async fn render_count_pages_block(
        ctx: &ServiceContext<'_>,
        page_context: ListPagesPageContext<'_>,
        page_info: &PageInfo<'_>,
        arguments: ListPagesArguments,
        body: &str,
        permission_cache: &mut BTreeMap<(i64, Option<i64>), bool>,
    ) -> Result<CountPagesBlockRenderResult> {
        let ListPagesPageContext {
            site_id: current_site_id,
            page_id: current_page_identity,
            url: _,
        } = page_context;
        let current_page_id = current_page_identity.unwrap_or(0);
        let unbounded_all_category_shape =
            count_pages_unbounded_all_category_shape(&arguments);
        let ListPagesArguments {
            current_page_only,
            category_selector_present,
            category_all,
            include_current_category,
            categories,
            excluded_categories,
            mut any_tags,
            all_tags,
            default_tags,
            no_tags,
            untagged: _,
            same_visible_tags: _,
            exact_visible_tags: _,
            authors,
            author_filter_present,
            order,
            reverse: _,
            limit,
            count_pages_explicit_limit,
            count_pages_per_page: _,
            url_attr_prefix: _,
            tag_target: _,
            offset,
            offset_origin: _,
            offset_beyond_render_window,
            exclude_current_page,
            relative_range: _,
            page_type,
            page_parent,
            static_parent_fullname: _,
            creation_date,
            update_date,
            creation_date_current_page: _,
            update_date_current_page: _,
            score,
            score_equals_current_page: _,
            votes,
            votes_equals_current_page: _,
            slug,
            name_pattern,
            prepend_line: _,
            append_line: _,
            data_form_fields,
            exclude_current_page_author: _,
            unsupported_author_filter: _,
            unsupported_list_pages_filter: _,
            link_to,
            unsupported_score_filter: _,
            unsupported_count_pages_filter,
            separate: _,
            wrapper: _,
            rss_title: _,
            rss_description: _,
            rss_home: _,
            rss_limit: _,
            rss_only: _,
            rss_path: _,
        } = arguments;
        if unsupported_count_pages_filter
            || count_pages_explicit_limit.is_some_and(|limit| {
                limit
                    .saturating_add(u64::from(offset))
                    .saturating_add(u64::from(exclude_current_page))
                    > u64::from(MAX_LISTPAGES_RENDER_SCAN_ROWS)
            })
        {
            return Ok(CountPagesBlockRenderResult::PreserveOriginal);
        }
        let count_pages_query_limit = count_pages_explicit_limit
            .map(|limit| {
                limit
                    .saturating_add(u64::from(offset))
                    .saturating_add(u64::from(exclude_current_page))
            })
            .unwrap_or(u64::from(MAX_LISTPAGES_RENDER_SCAN_ROWS))
            .min(u64::from(MAX_LISTPAGES_RENDER_SCAN_ROWS));
        any_tags.extend(default_tags);
        let link_to_references = link_to
            .iter()
            .map(|slug| Reference::Slug(Cow::Borrowed(slug.as_ref())))
            .collect::<Vec<_>>();
        let (category_all, include_current_category) = if category_selector_present {
            (category_all, include_current_category)
        } else {
            (false, true)
        };
        let categories = if include_current_category && !category_all {
            Self::categories_with_current_page_category(categories, page_info)
        } else {
            categories
        };
        let included_categories = if category_all {
            IncludedCategories::All
        } else {
            IncludedCategories::List(&categories)
        };
        let resolved_authors = Self::resolve_list_pages_authors(
            ctx,
            current_site_id,
            current_page_id,
            &authors,
            author_filter_present,
            false,
        )
        .await?;
        let query = PageQuery {
            current_page_id,
            current_site_id,
            queried_site_id: None,
            page_type,
            categories: CategoriesSelector {
                included_categories,
                excluded_categories: &excluded_categories,
            },
            tags: TagCondition {
                any_present: &any_tags,
                all_present: &all_tags,
                none_present: &no_tags,
                untagged: false,
            },
            page_parent,
            contains_outgoing_links: &link_to_references,
            creation_date,
            update_date,
            author: resolved_authors.as_selector(),
            score: &score,
            votes: &votes,
            offset: 0,
            name: name_pattern,
            slug,
            slugs: &[],
            data_form_fields: &data_form_fields,
            order: order.clone(),
            candidate_limit: if data_form_fields.is_empty()
                && !matches!(
                    order.as_ref().map(|order| &order.property),
                    Some(OrderProperty::Score | OrderProperty::DataFormFieldName { .. })
                ) {
                None
            } else {
                Some(u64::from(MAX_LISTPAGES_RENDER_SCAN_ROWS))
            },
            pagination: PaginationSelector {
                limit: Some(count_pages_query_limit),
                per_page: PaginationSelector::default().per_page,
                reversed: false,
            },
            fields: FoundPageFields {
                page_category_id: true,
                ..Default::default()
            },
        };

        if unbounded_all_category_shape && !current_page_only {
            return Self::render_count_pages_exact_total(
                ctx,
                current_site_id,
                query,
                body,
                exclude_current_page,
                offset > 0 || offset_beyond_render_window.is_some(),
                permission_cache,
            )
            .await;
        }
        if offset_beyond_render_window.is_some() {
            return Ok(CountPagesBlockRenderResult::Expanded(
                substitute_count_pages_variables(body, 0),
            ));
        }

        let mut count_pages_metadata = None;
        let sample = if current_page_only && current_page_identity.is_none() {
            CountPagesSample::Complete(FoundPages { pages: Vec::new() })
        } else if current_page_only
            && should_render_current_page_list_pages_row(current_page_only, limit, offset)
        {
            CountPagesSample::Complete(
                Self::current_page_list_pages_row(
                    ctx,
                    current_site_id,
                    current_page_id,
                    page_info,
                    &query.fields,
                )
                .await?,
            )
        } else if current_page_only {
            CountPagesSample::Complete(FoundPages { pages: Vec::new() })
        } else {
            let target_count = count_pages_query_limit.min(usize::MAX as u64) as usize;
            let found = RenderRuntime::new(ctx)
                .find_viewable_count_pages_rows(query, target_count, permission_cache)
                .await?;
            count_pages_metadata = Some((
                found.metadata.clone(),
                found.view_permission_filtering_applied,
            ));
            found.sample
        };
        if let Some((metadata, view_permission_filtering_applied)) = count_pages_metadata
        {
            let preserve_original = page_query_cap_requires_original_module(&metadata);
            let diagnostics = count_pages_exact_count_render_diagnostics(
                metadata,
                view_permission_filtering_applied,
                exclude_current_page,
                offset > 0,
                count_pages_explicit_limit,
                count_pages_query_limit,
            );
            debug!("CountPages exact count eligibility diagnostics: {diagnostics:?}");
            if preserve_original {
                return Ok(CountPagesBlockRenderResult::PreserveOriginal);
            }
        }
        if sample.requires_preservation(
            sample.pages().pages.len(),
            count_pages_query_limit.min(usize::MAX as u64) as usize,
        ) {
            return Ok(CountPagesBlockRenderResult::PreserveOriginal);
        }
        let pages = sample
            .pages()
            .pages
            .iter()
            .filter(|page| !exclude_current_page || page.page_id != current_page_id)
            .skip(offset as usize);
        let total = match count_pages_explicit_limit {
            Some(limit) => pages.take(limit.min(usize::MAX as u64) as usize).count(),
            None => {
                let Some(total) = sample.exact_unbounded_total(pages.count()) else {
                    return Ok(CountPagesBlockRenderResult::PreserveOriginal);
                };
                total
            }
        };

        Ok(CountPagesBlockRenderResult::Expanded(
            substitute_count_pages_variables(body, total),
        ))
    }

    async fn render_count_pages_exact_total(
        ctx: &ServiceContext<'_>,
        current_site_id: i64,
        mut query: PageQuery<'_>,
        body: &str,
        exclude_current_page: bool,
        post_query_offset_applied: bool,
        permission_cache: &mut BTreeMap<(i64, Option<i64>), bool>,
    ) -> Result<CountPagesBlockRenderResult> {
        let categories = CategoryService::get_all(ctx, current_site_id).await?;
        let category_ids = categories
            .iter()
            .map(|category| Some(category.category_id))
            .collect::<Vec<_>>();
        let viewable = PermissionService::batch_check_page_view_without_page_roles(
            ctx,
            None,
            current_site_id,
            &category_ids,
            permission_cache,
        )
        .await?;
        let viewable_slugs = categories
            .iter()
            .zip(viewable.iter())
            .filter(|(_, viewable)| **viewable)
            .map(|(category, _)| Cow::Owned(category.slug.clone()))
            .collect::<Vec<_>>();
        if viewable_slugs.len() != categories.len() {
            query.categories.included_categories =
                IncludedCategories::List(&viewable_slugs);
        }
        let envelope = PageQueryService::count_with_metadata(ctx, query).await?;
        let evaluation = count_pages_exact_count_render_evaluation(
            envelope.metadata,
            false,
            exclude_current_page,
            post_query_offset_applied,
            None,
            0,
        );
        debug!(
            "CountPages exact count eligibility diagnostics: {:?}",
            evaluation.diagnostics,
        );
        if let Some(total) = evaluation.exact_total {
            return Ok(CountPagesBlockRenderResult::Expanded(
                substitute_count_pages_variables(body, total.total()),
            ));
        }
        Ok(CountPagesBlockRenderResult::PreserveOriginal)
    }
}
