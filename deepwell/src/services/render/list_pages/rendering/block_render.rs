use super::super::pagination::ListPagesPagerArgs;
use super::super::rendering_support::{
    ListPagesBlockRenderArgs, ListPagesSelectedContentArgs,
};
use super::{
    Action, BTreeMap, BTreeSet, CategoriesSelector, CheckPermissionContext, ColumnTrait,
    ComparisonOperation, CompatHtmlFragments, Cow, DEFAULT_LISTPAGES_PER_PAGE,
    DateSelector, DateTimeResolution, EntityTrait, Error, ErrorType,
    FinishOrDeferListPagesDelayedOutputParams, FoundPageFields, FoundPages,
    IncludeExpansion, IncludedCategories, ListPagesArguments, ListPagesBlockRenderResult,
    ListPagesOutputShape, ListPagesPageContext, ListPagesRenderDiagnosticsInput,
    ListPagesRenderedBlock, ListPagesSubstitutionContext, MAX_LISTPAGES_RENDER_LIMIT,
    MAX_LISTPAGES_RENDER_SCAN_ROWS, OrderProperty, PageCategory, PageInfo,
    PageParentSelector, PageQuery, PageQueryService, PageRevisionService, PageService,
    PaginationSelector, Permission, PermissionService, PrepareDelayedListPagesRowParams,
    QueryFilter, Reference, RenderRuntime, RenderService, ResolvedListPagesAuthors,
    Resource, Result, ResultExt, ScoreSelector, ScoreValue, SelectedContentIncludeMode,
    SiteService, TagCondition, append_list_pages_delayed_occurrences,
    append_list_pages_runtime_text_ranges, escape_html_text,
    finish_or_defer_list_pages_delayed_output_with_modes, has_include_opening_candidate,
    has_list_pages_module_opening_candidate, is_list_pages_visible_tag,
    list_pages_body_uses_first_image, list_pages_content_query_target,
    list_pages_created_by_slug, list_pages_feed_info_html,
    list_pages_feed_only_render_result, list_pages_first_paragraph,
    list_pages_parent_fullname, list_pages_render_diagnostics,
    list_pages_row_markup_bytes, list_pages_row_scan_target,
    list_pages_runtime_container_open, list_pages_runtime_row_container_close,
    list_pages_runtime_row_container_open, list_pages_template_has_block_section,
    list_pages_template_starts_with_inline_anchor, list_pages_unknown_link_target_slugs,
    load_list_pages_child_counts, load_list_pages_data_form_definitions,
    load_list_pages_first_images, load_list_pages_parent_displays,
    native_numbered_list_content, neutralize_authored_markers, page_category,
    page_query_cap_requires_original_module, parse_static_wikidot_data_form_values,
    prepare_delayed_list_pages_row_with_budget, push_list_pages_generated_output,
    push_list_pages_generated_output_with_cost, push_list_pages_pager,
    push_list_pages_trailing_runtime_blocks, render_list_pages_default_summary_source,
    render_list_pages_selected_content_source, render_page_query_uses_single_scan,
    resolve_list_pages_first_image, seal_zero_row_list_pages_wrapper,
    seed_random_list_pages_order, select_list_pages_rows,
    should_render_current_page_list_pages_row, wikidot_content_section,
};

impl RenderService {
    pub(in crate::services::render) async fn render_list_pages_block(
        args: ListPagesBlockRenderArgs<'_, '_, '_, '_>,
    ) -> Result<ListPagesBlockRenderResult> {
        let ListPagesBlockRenderArgs {
            ctx,
            page_context,
            pager_route,
            compat_html,
            viewer_user_id,
            page_info,
            page_preview,
            settings,
            arguments,
            template,
            include_budget,
            render_cost_budget,
            mut prefetched_pages,
            prefetched_displays,
            content_cache,
            expansion_budget,
            permission_cache,
            score_filter_cache,
            author_resolution_cache,
            compat_text,
        } = args;
        let ListPagesPageContext {
            site_id: current_site_id,
            page_id: current_page_identity,
            url,
        } = page_context;
        let current_page_id = current_page_identity.unwrap_or(0);
        let ajax_module_response = page_info.page.as_ref() == "_ajax-module-connector";
        let initial_remaining_include_expansions = include_budget.remaining;
        let mut arguments = arguments;
        let feed_info = list_pages_feed_info_html(page_info, &arguments);
        if arguments.rss_only
            && let Some(feed_info) = feed_info
        {
            return Ok(list_pages_feed_only_render_result(
                feed_info,
                expansion_budget,
            ));
        }
        seed_random_list_pages_order(
            ctx,
            current_site_id,
            current_page_identity,
            url,
            &mut arguments,
            template,
        )
        .await?;
        let ListPagesArguments {
            current_page_only,
            category_selector_present,
            category_all,
            include_current_category,
            categories,
            excluded_categories,
            mut any_tags,
            mut all_tags,
            default_tags,
            no_tags,
            untagged,
            same_visible_tags,
            exact_visible_tags,
            authors,
            author_filter_present,
            order,
            reverse,
            limit,
            count_pages_explicit_limit: _,
            count_pages_per_page,
            url_attr_prefix,
            tag_target,
            offset,
            offset_origin: _,
            offset_beyond_render_window,
            exclude_current_page,
            relative_range,
            page_type,
            page_parent,
            static_parent_fullname,
            mut creation_date,
            mut update_date,
            creation_date_current_page,
            update_date_current_page,
            mut score,
            score_equals_current_page,
            mut votes,
            votes_equals_current_page,
            slug,
            name_pattern,
            data_form_fields,
            prepend_line,
            append_line,
            separate,
            wrapper,
            rss_title: _,
            rss_description: _,
            rss_home: _,
            rss_limit: _,
            rss_only: _,
            rss_path: _,
            exclude_current_page_author,
            unsupported_author_filter: _,
            unsupported_list_pages_filter: _,
            link_to,
            unsupported_score_filter: _,
            unsupported_count_pages_filter: _,
        } = arguments;
        any_tags.extend(default_tags);
        let current_visible_tags = page_info
            .tags
            .iter()
            .filter(|tag| is_list_pages_visible_tag(tag))
            .map(|tag| tag.to_string())
            .collect::<BTreeSet<_>>();
        if same_visible_tags {
            any_tags.extend(current_visible_tags.iter().cloned().map(Cow::Owned));
        }
        if exact_visible_tags {
            all_tags.extend(current_visible_tags.iter().cloned().map(Cow::Owned));
        }
        let current_page_date_missing = current_page_identity.is_none()
            && (creation_date_current_page || update_date_current_page);
        if let Some(current_page_id) = current_page_identity
            && (creation_date_current_page || update_date_current_page)
        {
            let page = PageService::get_direct(ctx, current_page_id, false)
                .await
                .or_raise(|| {
                    Error::new(
                        "failed to load current page dates for ListPages render",
                        ErrorType::Render,
                    )
                })?;
            if creation_date_current_page {
                creation_date = DateSelector::Span {
                    timestamp: page.created_at,
                    resolution: DateTimeResolution::Day,
                    comparison: ComparisonOperation::Equal,
                };
            }
            if update_date_current_page {
                update_date = DateSelector::Span {
                    timestamp: page.updated_at.unwrap_or(page.created_at),
                    resolution: DateTimeResolution::Day,
                    comparison: ComparisonOperation::Equal,
                };
            }
        }
        if score_equals_current_page && current_page_identity.is_some() {
            score.push(ScoreSelector {
                score: page_info.score,
                comparison: ComparisonOperation::Equal,
            });
        }
        let mut votes_equal_current_zero_votes = false;
        if votes_equals_current_page && let Some(current_page_id) = current_page_identity
        {
            let current_votes =
                PageQueryService::effective_vote_count(ctx, current_page_id)
                    .await
                    .or_raise(|| {
                        Error::new(
                            "failed to load current page vote count for ListPages render",
                            ErrorType::Render,
                        )
                    })?;
            if current_votes == 0 {
                votes_equal_current_zero_votes = true;
            } else {
                votes.push(ScoreSelector {
                    score: ftml::data::ScoreValue::Integer(current_votes),
                    comparison: ComparisonOperation::Equal,
                });
            }
        }
        let current_page_full_slug = Self::page_info_full_slug(page_info);
        let link_to_references = link_to
            .iter()
            .filter_map(|slug| {
                let slug = if slug.as_ref() == "." {
                    current_page_identity?;
                    current_page_full_slug.as_str()
                } else {
                    slug.as_ref()
                };
                Some(Reference::Slug(Cow::Borrowed(slug)))
            })
            .collect::<Vec<_>>();
        let link_to_references = if link_to_references.is_empty() {
            Vec::new()
        } else {
            let target_pages =
                PageService::get_pages(ctx, current_site_id, &link_to_references).await?;
            if target_pages.is_empty()
                && let Some(target) = link_to.iter().find(|slug| slug.as_ref() != ".")
            {
                let html = format!(
                    r#"<div class="error-block">Linked page {} does not exist</div>"#,
                    escape_html_text(target),
                );
                if !expansion_budget.try_consume_generated_output_bytes(html.len()) {
                    return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                        "missing link target error exceeds generated-output budget",
                    ));
                }
                let output = compat_html.push_block_html(html);
                return Ok(ListPagesBlockRenderResult::Expanded(
                    ListPagesRenderedBlock {
                        expansion: IncludeExpansion {
                            wikitext: output,
                            included_pages: Vec::new(),
                            expanded_include_count: 0,
                        },
                        pending_delayed: None,
                        runtime_css_insertions: Vec::new(),
                    },
                ));
            }
            let mut viewable_target_ids = Vec::new();
            for target in target_pages {
                let can_view = PermissionService::check_user_can(
                    ctx,
                    &CheckPermissionContext {
                        user_id: viewer_user_id,
                        site_id: target.site_id,
                        page_reference: Some(Reference::Id(target.page_id)),
                    },
                    Permission {
                        resource_type: Resource::Page,
                        resource_category: Some(Reference::Id(target.page_category_id)),
                        action: Action::View,
                    },
                )
                .await?;
                if can_view {
                    viewable_target_ids.push(Reference::Id(target.page_id));
                }
            }
            viewable_target_ids
        };
        let link_to_has_no_viewable_targets =
            link_to.iter().any(|slug| slug.as_ref() != ".")
                && link_to_references.is_empty();
        let static_parent_references = static_parent_fullname
            .as_ref()
            .map(|parent| [Reference::Slug(Cow::Borrowed(parent.as_ref()))]);
        let page_parent = static_parent_references.as_ref().map_or_else(
            || {
                if current_page_identity.is_none()
                    && matches!(page_parent, PageParentSelector::DifferentParents)
                {
                    PageParentSelector::All
                } else {
                    page_parent
                }
            },
            |parents| PageParentSelector::HasParents(parents),
        );
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
        let zero_page_size = count_pages_per_page == Some(0);
        let per_page = count_pages_per_page
            .unwrap_or(DEFAULT_LISTPAGES_PER_PAGE)
            .clamp(1, MAX_LISTPAGES_RENDER_LIMIT);
        let url_page = url.page_for_prefix(url_attr_prefix.as_deref());
        let oversized_offset_initial_page =
            offset_beyond_render_window.is_some() && url_page.unwrap_or(1) <= 1;
        let offset = match (offset_beyond_render_window, url_page) {
            (Some(raw_offset), Some(page)) if page > 1 => (raw_offset % per_page) as u32,
            _ => offset,
        };
        let query_limit = list_pages_row_scan_target(
            if relative_range.is_some() {
                None
            } else {
                limit
            },
            offset,
            exclude_current_page,
        );
        let wants_content = template.uses_content();
        let wants_rendered_content = template.content_sections().contains(&None);
        let wants_summary = template.uses_first_paragraph();
        let wants_first_paragraph = wants_summary;
        let wants_full_default_summary = template.is_default_template()
            && !(template.default_summary_first_paragraph() && page_info.page.is_empty());
        let wants_preview = template.uses_preview();
        let wants_size = template.uses_size();
        let wants_first_image = list_pages_body_uses_first_image(template.body());
        let included_categories = if category_all {
            IncludedCategories::All
        } else {
            IncludedCategories::List(&categories)
        };

        let wants_created_by = template.uses_created_by();
        let wants_created_by_unix = template.uses_created_by_unix();
        let wants_created_at = template.uses_created_at();
        let wants_updated_by = template.uses_updated_by();
        let wants_updated_at = template.uses_updated_at();
        let wants_rating_votes = template.uses_rating_votes();
        let wants_site_domain = template.uses_site_domain();
        let wants_parent_metadata = template.uses_parent_metadata();
        let wants_revisions = template.uses_revisions();
        let orders_by_revisions = matches!(
            order.as_ref().map(|order| &order.property),
            Some(OrderProperty::Revisions)
        );
        let needs_revision_count = wants_revisions || orders_by_revisions;
        let wants_children = template.uses_children();
        let resolved_authors = Self::resolve_list_pages_authors_cached(
            ctx,
            current_site_id,
            current_page_id,
            &authors,
            author_filter_present,
            exclude_current_page_author,
            author_resolution_cache,
        )
        .await?;
        let mut query_fields = template.fields();
        query_fields.tags = true;
        query_fields.slug |= wants_first_image;
        query_fields.revision_count |= needs_revision_count;
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
                untagged,
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
                limit: Some(MAX_LISTPAGES_RENDER_LIMIT),
                per_page: PaginationSelector::default().per_page,
                reversed: false,
            },
            fields: query_fields,
        };
        let mut list_pages_metadata = None;
        let missing_current_page_for_selector = current_page_identity.is_none()
            && (current_page_only
                || exclude_current_page_author
                || score_equals_current_page
                || votes_equals_current_page);
        let current_page_excluded_by_author =
            current_page_only && exclude_current_page_author;
        let rows_are_complete_without_query = zero_page_size
            || oversized_offset_initial_page
            || current_page_date_missing
            || votes_equal_current_zero_votes
            || missing_current_page_for_selector
            || current_page_excluded_by_author
            || (same_visible_tags && current_visible_tags.is_empty())
            || current_page_only
            || prefetched_pages.is_some()
            || link_to_has_no_viewable_targets;
        let exact_total_from_scan =
            if template.uses_total() && !rows_are_complete_without_query {
                let mut total_query = query.clone();
                total_query.pagination.limit =
                    Some(u64::from(MAX_LISTPAGES_RENDER_SCAN_ROWS));
                total_query.fields = FoundPageFields {
                    page_category_id: true,
                    tags: exact_visible_tags,
                    ..FoundPageFields::default()
                };
                let target_count = MAX_LISTPAGES_RENDER_SCAN_ROWS as usize;
                let found = RenderRuntime::for_viewer(ctx, viewer_user_id)
                    .find_viewable_count_pages_rows(
                        total_query,
                        target_count,
                        permission_cache,
                    )
                    .await?;
                if page_query_cap_requires_original_module(&found.metadata)
                    || !found.sample.is_complete()
                {
                    return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                        "exact total scan incomplete",
                    ));
                }
                Some(
                    select_list_pages_rows(
                        found.sample.into_pages().pages,
                        exact_visible_tags,
                        &current_visible_tags,
                        relative_range,
                        current_page_id,
                        exclude_current_page,
                        offset,
                    )
                    .len(),
                )
            } else {
                None
            };
        let pages = if zero_page_size
            || oversized_offset_initial_page
            || current_page_date_missing
            || votes_equal_current_zero_votes
            || missing_current_page_for_selector
            || current_page_excluded_by_author
            || (same_visible_tags && current_visible_tags.is_empty())
            || link_to_has_no_viewable_targets
        {
            FoundPages { pages: Vec::new() }
        } else if current_page_only
            && should_render_current_page_list_pages_row(current_page_only, limit, offset)
        {
            let pages = Self::current_page_list_pages_row(
                ctx,
                current_site_id,
                current_page_id,
                page_info,
                &query.fields,
            )
            .await?;
            if data_form_fields.is_empty()
                || Self::current_page_matches_data_form_fields(
                    ctx,
                    current_site_id,
                    current_page_id,
                    &data_form_fields,
                )
                .await?
            {
                pages
            } else {
                FoundPages { pages: Vec::new() }
            }
        } else if current_page_only {
            FoundPages { pages: Vec::new() }
        } else if let Some(pages) = prefetched_pages.take() {
            pages
        } else {
            let query_target =
                if wants_content && !render_page_query_uses_single_scan(order.clone()) {
                    list_pages_content_query_target(
                        query_limit,
                        per_page,
                        expansion_budget.remaining_content_rows(),
                        offset,
                        exclude_current_page,
                        true,
                    )
                } else {
                    query_limit
                };
            let found = RenderRuntime::for_viewer(ctx, viewer_user_id)
                .find_viewable_list_pages_rows(
                    query,
                    query_target.min(usize::MAX as u64) as usize,
                    permission_cache,
                    Some(score_filter_cache),
                )
                .await?;
            if page_query_cap_requires_original_module(&found.metadata) {
                return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                    "page-query scan cap exceeded",
                ));
            }
            list_pages_metadata = Some((
                found.metadata.clone(),
                found.view_permission_filtering_applied,
            ));
            found.pages
        };
        if let Some((metadata, view_permission_filtering_applied)) = list_pages_metadata {
            let diagnostics =
                list_pages_render_diagnostics(ListPagesRenderDiagnosticsInput {
                    metadata,
                    view_permission_filtering_applied,
                    post_query_exclusion_applied: exclude_current_page,
                    post_query_offset_applied: offset > 0,
                    requested_limit: per_page,
                    query_limit,
                });
            debug!("ListPages render diagnostics: {diagnostics:?}");
        }
        let all_selected_pages = select_list_pages_rows(
            pages.pages,
            exact_visible_tags,
            &current_visible_tags,
            relative_range,
            current_page_id,
            exclude_current_page,
            offset,
        );
        let all_selected_total = all_selected_pages.len();
        let selected_pages = all_selected_pages
            .into_iter()
            .take(
                limit
                    .and_then(|limit| usize::try_from(limit).ok())
                    .unwrap_or(usize::MAX),
            )
            .collect::<Vec<_>>();
        let total_selected = selected_pages.len();

        let page_count = (total_selected as u64).div_ceil(per_page).max(1);
        let page = u64::from(url_page.unwrap_or(1)).clamp(1, page_count);
        let url_page_skip = usize::try_from((page - 1) * per_page).unwrap_or(usize::MAX);
        let mut pages = selected_pages
            .into_iter()
            .skip(url_page_skip)
            .take(per_page as usize)
            .collect::<Vec<_>>();
        if reverse {
            pages.reverse();
        }
        let exact_total = exact_total_from_scan
            .or_else(|| rows_are_complete_without_query.then_some(all_selected_total));
        if template.uses_total() && exact_total.is_none() {
            return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                "exact total unavailable",
            ));
        }
        let rendered_rows = pages.len();
        let total = exact_total.unwrap_or(rendered_rows);
        let body = template.body();
        let first_images = if wants_first_image && separate {
            load_list_pages_first_images(ctx, &pages).await?
        } else {
            BTreeMap::new()
        };
        if wants_content && !expansion_budget.can_expand_content_rows(rendered_rows) {
            return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                "selected content rows exceed remaining budget",
            ));
        }
        if wants_content
            && rendered_rows > 0
            && !expansion_budget.try_start_content_module()
        {
            return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                "content-module budget exhausted",
            ));
        }
        let wants_data_form_values = template.uses_data_form();
        if wants_content || wants_data_form_values {
            let mut missing_by_site = BTreeMap::<i64, Vec<i64>>::new();
            for page in &pages {
                let cache_key = (page.site_id, page.page_id);
                if !content_cache.wikitext.contains_key(&cache_key) {
                    missing_by_site
                        .entry(page.site_id)
                        .or_default()
                        .push(page.page_id);
                }
            }
            for (site_id, page_ids) in missing_by_site {
                let loaded = PageRevisionService::get_wikitext_optional_batch(
                    ctx, site_id, &page_ids,
                )
                .await?;
                content_cache.wikitext.extend(
                    loaded
                        .into_iter()
                        .map(|(page_id, wikitext)| ((site_id, page_id), wikitext)),
                );
            }
        }
        if wants_preview {
            let mut missing_by_site = BTreeMap::<i64, Vec<i64>>::new();
            for page in &pages {
                let cache_key = (page.site_id, page.page_id);
                if !content_cache.compiled_body_html.contains_key(&cache_key) {
                    missing_by_site
                        .entry(page.site_id)
                        .or_default()
                        .push(page.page_id);
                }
            }
            for (site_id, page_ids) in missing_by_site {
                let loaded = PageRevisionService::get_compiled_body_html_optional_batch(
                    ctx, site_id, &page_ids,
                )
                .await?;
                content_cache.compiled_body_html.extend(
                    loaded.into_iter().map(|(page_id, compiled_html)| {
                        ((site_id, page_id), compiled_html)
                    }),
                );
            }
        }
        if wants_size {
            let mut missing_by_site = BTreeMap::<i64, Vec<i64>>::new();
            for page in &pages {
                let cache_key = (page.site_id, page.page_id);
                if !content_cache.wikitext_scalar_count.contains_key(&cache_key) {
                    missing_by_site
                        .entry(page.site_id)
                        .or_default()
                        .push(page.page_id);
                }
            }
            for (site_id, page_ids) in missing_by_site {
                let loaded =
                    PageRevisionService::get_wikitext_scalar_count_optional_batch(
                        ctx, site_id, &page_ids,
                    )
                    .await?;
                content_cache.wikitext_scalar_count.extend(
                    loaded.into_iter().map(|(page_id, scalar_count)| {
                        ((site_id, page_id), scalar_count)
                    }),
                );
            }
            if pages.iter().any(|page| {
                content_cache
                    .wikitext_scalar_count
                    .get(&(page.site_id, page.page_id))
                    .copied()
                    .flatten()
                    .is_none()
            }) {
                return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                    "selected page source size unavailable",
                ));
            }
        }
        let category_ids = pages
            .iter()
            .filter_map(|page| page.page_category_id)
            .collect::<BTreeSet<_>>();
        let categories = if category_ids.is_empty() {
            Vec::new()
        } else {
            PageCategory::find()
                .filter(page_category::Column::CategoryId.is_in(category_ids))
                .all(ctx.transaction())
                .await
                .or_raise(|| {
                    Error::new(
                        "failed to load ListPages page categories",
                        ErrorType::Render,
                    )
                })?
        };
        let category_slugs = categories
            .iter()
            .map(|category| (category.category_id, category.slug.clone()))
            .collect::<BTreeMap<_, _>>();
        let data_form_definitions = if wants_data_form_values {
            load_list_pages_data_form_definitions(ctx, &categories).await?
        } else {
            BTreeMap::new()
        };
        let loaded_user_displays =
            if (wants_created_by || wants_updated_by) && prefetched_displays.is_none() {
                Some(Self::load_wikidot_user_displays(ctx, &pages).await?)
            } else {
                None
            };
        let empty_user_displays = BTreeMap::new();
        let user_displays = prefetched_displays
            .map(|displays| &displays.user_displays)
            .or(loaded_user_displays.as_ref())
            .unwrap_or(&empty_user_displays);
        if let ResolvedListPagesAuthors::NotAny {
            user_ids,
            wikidot_snapshot_names,
        } = &resolved_authors
            && user_ids.is_empty()
            && wikidot_snapshot_names.is_empty()
            && current_page_identity.is_some()
        {
            return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                "excluded current-page author cannot be resolved",
            ));
        }
        if wants_site_domain && page_info.site.is_empty() {
            return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                "site domain unavailable",
            ));
        }
        let wants_comments = template.uses_comments();
        let wants_commented_by = template.uses_commented_by();
        let wants_commented_at = template.uses_commented_at();
        let wants_snapshot_displays = wants_created_by
            || template.uses_title()
            || wants_updated_by
            || wants_created_at
            || wants_updated_at
            || wants_comments
            || wants_commented_by
            || wants_commented_at
            || wants_rating_votes
            || wants_parent_metadata;
        let loaded_snapshot_displays =
            if wants_snapshot_displays && prefetched_displays.is_none() {
                Some(Self::load_list_pages_snapshot_displays(ctx, &pages).await?)
            } else {
                None
            };
        let empty_snapshot_displays = BTreeMap::new();
        let snapshot_displays = prefetched_displays
            .map(|displays| &displays.snapshot_displays)
            .or(loaded_snapshot_displays.as_ref())
            .unwrap_or(&empty_snapshot_displays);
        let wants_rating = template.uses_rating();
        let wants_rating_percent = template.uses_rating_percent();
        let wants_runtime_displays = wants_comments
            || wants_commented_by
            || wants_commented_at
            || wants_rating
            || wants_rating_percent
            || wants_rating_votes;
        let loaded_runtime_displays =
            if wants_runtime_displays && prefetched_displays.is_none() {
                Some(Self::load_list_pages_runtime_displays(ctx, &pages).await?)
            } else {
                None
            };
        let empty_runtime_displays = BTreeMap::new();
        let runtime_displays = prefetched_displays
            .map(|displays| &displays.runtime_displays)
            .or(loaded_runtime_displays.as_ref())
            .unwrap_or(&empty_runtime_displays);
        if wants_created_by_unix
            && pages.iter().any(|page| {
                list_pages_created_by_slug(page, user_displays, snapshot_displays)
                    .is_none()
            })
        {
            return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                "imported creating author's Unix name unavailable",
            ));
        }
        let child_counts = if wants_children {
            match load_list_pages_child_counts(ctx, viewer_user_id, &pages).await? {
                Some(counts) => counts,
                None => {
                    return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                        "child permission scan exceeded its safety bound",
                    ));
                }
            }
        } else {
            BTreeMap::new()
        };
        if needs_revision_count && pages.iter().any(|page| page.revision_count.is_none())
        {
            return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                "revision count unavailable",
            ));
        }
        let relational_parent_displays = if wants_parent_metadata {
            load_list_pages_parent_displays(ctx, viewer_user_id, &pages).await?
        } else {
            BTreeMap::new()
        };
        let separate_zero_row_once_only_lines = pages.is_empty()
            && !separate
            && prepend_line.as_deref().is_some_and(|line| !line.is_empty())
            && append_line.as_deref().is_some_and(|line| !line.is_empty());
        let separate_zero_row_sections = pages.is_empty()
            && !separate
            && template
                .head_section()
                .is_some_and(|section| !section.is_empty())
            && template
                .foot_section()
                .is_some_and(|section| !section.is_empty());
        let site_title = if template.uses_site_title() {
            Some(
                SiteService::get(ctx, Reference::Id(current_site_id))
                    .await?
                    .name,
            )
        } else {
            None
        };
        let mut pager = String::new();
        push_list_pages_pager(ListPagesPagerArgs {
            output: &mut pager,
            page_info,
            route: pager_route,
            url,
            url_attr_prefix: url_attr_prefix.as_deref(),
            offset: u32::try_from(url_page_skip).unwrap_or(u32::MAX),
            per_page,
            total_selected,
        });
        let seal_zero_row_wrapper = wrapper
            && pages.is_empty()
            && pager.is_empty()
            && feed_info.is_none()
            && [
                prepend_line.as_deref(),
                template.head_section(),
                template.foot_section(),
                append_line.as_deref(),
            ]
            .into_iter()
            .flatten()
            .all(|source| !has_include_opening_candidate(source));
        let mut output = String::new();
        if wrapper && !seal_zero_row_wrapper {
            let opening =
                list_pages_runtime_container_open(compat_html, "list-pages-box");
            if !push_list_pages_generated_output_with_cost(
                &mut output,
                &format!("{opening}\n\n"),
                "[[div class=\"list-pages-box\"]]\n".len(),
                expansion_budget,
            ) {
                return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                    "wrapper opening exceeds generated-output budget",
                ));
            }
        }
        let mut included_pages = Vec::new();
        let mut runtime_css_insertions = Vec::new();
        let mut delayed_occurrences = Vec::new();
        let mut delayed_runtime_text_ranges = Vec::new();
        let mut delayed_html_fragments = Vec::new();
        if !separate
            && let Some(prepend_line) = prepend_line
            && (!push_list_pages_generated_output(
                &mut output,
                &prepend_line,
                expansion_budget,
            ) || !push_list_pages_generated_output(
                &mut output,
                "\n",
                expansion_budget,
            ))
        {
            return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                "prepend line exceeds generated-output budget",
            ));
        }
        if !separate
            && let Some(head) = template.head_section()
            && (!push_list_pages_generated_output(&mut output, head, expansion_budget)
                || !push_list_pages_generated_output(
                    &mut output,
                    template.head_row_separator(),
                    expansion_budget,
                ))
        {
            return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                "head section exceeds generated-output budget",
            ));
        }
        let render_generated_html =
            template.output_shape() == ListPagesOutputShape::TableRows;
        let unknown_link_target_slugs = list_pages_unknown_link_target_slugs(body);
        let numbered_link_titles = if body
            .lines()
            .any(|line| native_numbered_list_content(line).is_some())
            || wants_data_form_values
            || !unknown_link_target_slugs.is_empty()
        {
            let mut fallback_source = body.to_owned();
            for slug in &unknown_link_target_slugs {
                fallback_source.push_str("\n[[[");
                fallback_source.push_str(slug);
                fallback_source.push_str("|runtime target]]]");
            }
            if wants_data_form_values {
                for page in &pages {
                    if let Some(wikitext) = content_cache
                        .wikitext
                        .get(&(page.site_id, page.page_id))
                        .and_then(Option::as_deref)
                    {
                        fallback_source.push('\n');
                        fallback_source.push_str(wikitext);
                    }
                }
            }
            Some(
                RenderService::load_wikidot_compat_fallback_link_titles(
                    ctx,
                    current_site_id,
                    page_info.site.as_ref(),
                    &fallback_source,
                    viewer_user_id,
                )
                .await?,
            )
        } else {
            None
        };
        for (index, page) in pages.iter().enumerate() {
            let cache_key = (page.site_id, page.page_id);
            let page_wikitext = if wants_content || wants_data_form_values {
                content_cache
                    .wikitext
                    .get(&cache_key)
                    .cloned()
                    .unwrap_or_default()
            } else {
                None
            };
            let data_form_values = if wants_data_form_values {
                page_wikitext
                    .as_deref()
                    .map(parse_static_wikidot_data_form_values)
                    .unwrap_or_default()
            } else {
                BTreeMap::new()
            };
            if wants_content && page_wikitext.is_some() && page.site_id != current_site_id
            {
                return Err(Error::new(
                    format!(
                        "ListPages content row page ID {} belongs to site ID {}, not current site ID {}",
                        page.page_id, page.site_id, current_site_id,
                    ),
                    ErrorType::Render,
                )
                .into());
            }
            let (
                rendered_page_content,
                rendered_page_summary,
                rendered_page_first_paragraph,
                rendered_page_styles,
            ) = if wants_rendered_content || wants_first_paragraph {
                match page_wikitext.as_deref() {
                    Some(wikitext) => {
                        let mut rendered_page_styles = Vec::new();
                        let category = page
                            .page_category_id
                            .and_then(|category_id| category_slugs.get(&category_id));
                        let full_slug = page.slug.as_deref().unwrap_or_default();
                        let page_name = full_slug
                            .rsplit_once(':')
                            .map_or(full_slug, |(_, name)| name);
                        let selected_page_info = PageInfo {
                            page: Cow::Owned(page_name.to_owned()),
                            category: category
                                .map(|category| Cow::Owned(category.to_owned())),
                            site: Cow::Owned(page_info.site.to_string()),
                            title: Cow::Owned(
                                page.title.as_deref().unwrap_or(full_slug).to_owned(),
                            ),
                            alt_title: page
                                .alt_title
                                .as_deref()
                                .map(|title| Cow::Owned(title.to_owned())),
                            score: if wants_full_default_summary && page_preview {
                                ScoreValue::Integer(0)
                            } else {
                                ScoreValue::Float(page.score.unwrap_or(0.0).into())
                            },
                            tags: page
                                .tags
                                .as_deref()
                                .unwrap_or_default()
                                .iter()
                                .map(|tag| Cow::Owned(tag.to_owned()))
                                .collect(),
                            language: Cow::Owned(page_info.language.to_string()),
                        };
                        let render_passes = usize::from(wants_rendered_content)
                            + usize::from(wants_summary)
                            + usize::from(wants_first_paragraph);
                        let max_include_expansions = include_budget
                            .remaining
                            .checked_div(rendered_rows.max(1))
                            .and_then(|per_row| per_row.checked_div(render_passes.max(1)))
                            .unwrap_or(0);
                        let rendered_content = if wants_rendered_content {
                            let mut rendered = render_list_pages_selected_content_source(
                                ListPagesSelectedContentArgs {
                                    ctx,
                                    wikitext,
                                    page_info: &selected_page_info,
                                    settings,
                                    current_site_id,
                                    current_category_id: page
                                        .page_category_id
                                        .unwrap_or(0),
                                    current_page_id: page.page_id,
                                    viewer_user_id,
                                    max_include_expansions,
                                    render_cost_budget: render_cost_budget.clone(),
                                    url,
                                },
                                SelectedContentIncludeMode::Execute,
                            )
                            .await?;
                            include_budget.consume(rendered.expanded_include_count);
                            included_pages.extend(rendered.included_pages);
                            rendered_page_styles.append(&mut rendered.styles);
                            Some(rendered.body)
                        } else {
                            None
                        };
                        let summary_source = wants_summary.then(|| {
                            let summary = wikidot_content_section(wikitext, Some(1));
                            if wants_full_default_summary {
                                summary
                            } else {
                                Self::suppress_rate_modules_in_list_pages_content(
                                    summary, settings,
                                )
                            }
                        });
                        let rendered_summary = if let Some(summary) =
                            summary_source.as_deref()
                        {
                            let mut rendered = if wants_full_default_summary {
                                render_list_pages_default_summary_source(
                                    ListPagesSelectedContentArgs {
                                        ctx,
                                        wikitext: summary,
                                        page_info: if page_preview {
                                            page_info
                                        } else {
                                            &selected_page_info
                                        },
                                        settings,
                                        current_site_id,
                                        current_category_id: 0,
                                        current_page_id: page.page_id,
                                        viewer_user_id,
                                        max_include_expansions,
                                        render_cost_budget: render_cost_budget.clone(),
                                        url,
                                    },
                                    page_preview,
                                )
                                .await?
                            } else {
                                render_list_pages_selected_content_source(
                                    ListPagesSelectedContentArgs {
                                        ctx,
                                        wikitext: summary,
                                        page_info: &selected_page_info,
                                        settings,
                                        current_site_id,
                                        current_category_id: page
                                            .page_category_id
                                            .unwrap_or(0),
                                        current_page_id: page.page_id,
                                        viewer_user_id,
                                        max_include_expansions,
                                        render_cost_budget: render_cost_budget.clone(),
                                        url,
                                    },
                                    SelectedContentIncludeMode::Preserve,
                                )
                                .await?
                            };
                            include_budget.consume(rendered.expanded_include_count);
                            included_pages.extend(rendered.included_pages);
                            rendered_page_styles.append(&mut rendered.styles);
                            Some(rendered.body)
                        } else {
                            None
                        };
                        let rendered_first_paragraph = if wants_first_paragraph {
                            let first_paragraph = summary_source
                                .as_deref()
                                .map(|summary| {
                                    list_pages_first_paragraph(
                                        summary.trim_start_matches(['\r', '\n']),
                                    )
                                })
                                .unwrap_or_default();
                            if summary_source
                                .as_deref()
                                .is_some_and(|summary| summary == first_paragraph)
                            {
                                rendered_summary.clone()
                            } else {
                                let mut rendered =
                                    render_list_pages_selected_content_source(
                                        ListPagesSelectedContentArgs {
                                            ctx,
                                            wikitext: first_paragraph,
                                            page_info: &selected_page_info,
                                            settings,
                                            current_site_id,
                                            current_category_id: page
                                                .page_category_id
                                                .unwrap_or(0),
                                            current_page_id: page.page_id,
                                            viewer_user_id,
                                            max_include_expansions,
                                            render_cost_budget: render_cost_budget
                                                .clone(),
                                            url,
                                        },
                                        SelectedContentIncludeMode::Preserve,
                                    )
                                    .await?;
                                include_budget.consume(rendered.expanded_include_count);
                                included_pages.extend(rendered.included_pages);
                                rendered_page_styles.append(&mut rendered.styles);
                                Some(rendered.body)
                            }
                        } else {
                            None
                        };
                        (
                            rendered_content,
                            rendered_summary,
                            rendered_first_paragraph,
                            rendered_page_styles,
                        )
                    }
                    None => (None, None, None, Vec::new()),
                }
            } else {
                (None, None, None, Vec::new())
            };
            let substitution_context = ListPagesSubstitutionContext {
                authored_limit: limit,
                ajax_module_response,
                page_preview,
                site: page_info.site.as_ref(),
                site_title: site_title.as_deref().unwrap_or_default(),
                category: page
                    .page_category_id
                    .and_then(|category_id| category_slugs.get(&category_id))
                    .map(String::as_str)
                    .unwrap_or_default(),
                tag_target: tag_target.as_deref(),
                user_displays,
                snapshot_displays,
                runtime_displays,
                page_wikitext: page_wikitext.as_deref(),
                page_rendered_content: rendered_page_content.as_deref(),
                page_rendered_summary: rendered_page_summary.as_deref(),
                page_rendered_summary_is_block: wants_full_default_summary,
                default_summary_first_paragraph:
                    template.default_summary_first_paragraph()
                        && page_info.page.is_empty(),
                fallback_link_titles: numbered_link_titles.as_ref(),
                page_rendered_first_paragraph: rendered_page_first_paragraph
                    .as_deref(),
                page_compiled_body_html: wants_preview
                    .then(|| {
                        content_cache
                            .compiled_body_html
                            .get(&cache_key)
                            .and_then(Option::as_deref)
                    })
                    .flatten(),
                page_wikitext_scalar_count: wants_size.then(|| {
                    content_cache
                        .wikitext_scalar_count
                        .get(&cache_key)
                        .copied()
                        .flatten()
                        .expect("size-backed ListPages rows were validated before substitution")
                }),
                page_parent_fullname: list_pages_parent_fullname(
                    page,
                    snapshot_displays,
                    &relational_parent_displays,
                ),
                page_parent_display: relational_parent_displays.get(&page.page_id),
                page_child_count: wants_children
                    .then(|| child_counts.get(&page.page_id).copied().unwrap_or(0)),
                page_revision_count: wants_revisions.then(|| {
                    page.revision_count.expect(
                        "revision-backed ListPages rows were validated before substitution",
                    )
                }),
                data_form_values: &data_form_values,
                data_form_definition: page
                    .page_category_id
                    .and_then(|category_id| data_form_definitions.get(&category_id)),
                render_generated_html,
            };
            let uses_star_rating = runtime_displays
                .get(&page.page_id)
                .is_some_and(|display| display.rating_type == "stars");
            let row_body = if wants_first_image {
                resolve_list_pages_first_image(
                    body,
                    page.slug.as_deref(),
                    separate
                        .then(|| first_images.get(&(page.site_id, page.page_id)))
                        .flatten()
                        .map(String::as_str),
                )
            } else {
                Cow::Borrowed(body)
            };
            let prepared_row = prepare_delayed_list_pages_row_with_budget(
                PrepareDelayedListPagesRowParams {
                    template,
                    body: row_body.as_ref(),
                    page,
                    index: index + offset as usize + url_page_skip + 1,
                    total,
                    context: &substitution_context,
                    outer_page_tags: &page_info.tags,
                    compat_text,
                    uses_star_rating,
                    numbered_link_titles: numbered_link_titles.as_ref(),
                    render_cost_budget: Some(render_cost_budget),
                },
            );
            if let Some(fragments) = prepared_row.html_fragments {
                delayed_html_fragments.push(fragments);
            }
            let logical_body_bytes = prepared_row.logical_body_bytes;
            let rendered_body = prepared_row.body;
            let generated_row_open = if separate {
                format!("{}\n\n", list_pages_runtime_row_container_open(compat_html),)
            } else {
                String::new()
            };
            let generated_row_close = if separate {
                let last_wrapped_row = wrapper && index + 1 == pages.len();
                let marker = list_pages_runtime_row_container_close(compat_html);
                if last_wrapped_row {
                    format!("\n\n{marker}\n")
                } else if !wrapper && !pager.is_empty() && index + 1 == pages.len() {
                    format!("\n\n{marker}")
                } else {
                    format!("\n\n{marker}\n")
                }
            } else {
                String::new()
            };
            let row_markup_bytes = list_pages_row_markup_bytes(
                separate,
                &generated_row_open,
                &generated_row_close,
            );
            let Some(rendered_row_bytes) = logical_body_bytes
                .and_then(|body_bytes| body_bytes.checked_add(row_markup_bytes))
            else {
                return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                    "logical rendered row byte count overflowed",
                ));
            };
            if !expansion_budget.try_consume_generated_output_bytes(rendered_row_bytes) {
                return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                    "rendered rows exceed generated-output budget",
                ));
            }
            if !rendered_page_styles.is_empty() {
                let marker = compat_text.push("");
                runtime_css_insertions.push(
                    crate::services::render::compat::preparation::RuntimeCssInsertion {
                        marker,
                        styles: rendered_page_styles,
                    },
                );
            }
            if separate {
                output.push_str(&generated_row_open);
            }
            let rendered_body_start = output.len();
            output.push_str(&rendered_body);
            if !append_list_pages_delayed_occurrences(
                &mut delayed_occurrences,
                prepared_row.generated_slots,
                rendered_body_start,
                rendered_body.len(),
            ) {
                return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                    "generated slot source range escaped its substituted row",
                ));
            }
            if !append_list_pages_runtime_text_ranges(
                &mut delayed_runtime_text_ranges,
                prepared_row.runtime_text_ranges,
                rendered_body_start,
                rendered_body.len(),
            ) {
                return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                    "runtime scalar source range escaped its substituted row",
                ));
            }
            if separate {
                output.push_str(&generated_row_close);
            } else {
                output.push('\n');
            }
        }
        if !separate
            && let Some(foot) = template.foot_section()
            && ((separate_zero_row_sections
                && !push_list_pages_generated_output(
                    &mut output,
                    "\n",
                    expansion_budget,
                ))
                || !push_list_pages_generated_output(&mut output, foot, expansion_budget)
                || !push_list_pages_generated_output(&mut output, "\n", expansion_budget))
        {
            return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                "foot section exceeds generated-output budget",
            ));
        }
        if !separate && let Some(append_line) = append_line {
            let mut append_line = append_line;
            neutralize_authored_markers(&mut append_line);
            if (separate_zero_row_once_only_lines
                && !push_list_pages_generated_output(&mut output, "\n", expansion_budget))
                || !push_list_pages_generated_output(
                    &mut output,
                    &append_line,
                    expansion_budget,
                )
                || !push_list_pages_generated_output(&mut output, "\n", expansion_budget)
            {
                return Ok(ListPagesBlockRenderResult::PreserveOriginal(
                    "append line exceeds generated-output budget",
                ));
            }
        }
        if let Err(reason) = push_list_pages_trailing_runtime_blocks(
            &mut output,
            pager,
            feed_info,
            wrapper && !seal_zero_row_wrapper,
            !separate,
            compat_html,
            expansion_budget,
        ) {
            return Ok(ListPagesBlockRenderResult::PreserveOriginal(reason));
        }
        if seal_zero_row_wrapper {
            output = seal_zero_row_list_pages_wrapper(
                &output,
                page_info,
                settings,
                compat_html,
            )?;
        }
        if wants_content {
            expansion_budget.consume_content_rows(rendered_rows);
        }
        let defer_for_include_expansion = has_include_opening_candidate(&output)
            || has_list_pages_module_opening_candidate(&output)
            || delayed_html_fragments
                .iter()
                .any(CompatHtmlFragments::has_exact_fragments);
        let block_output = wrapper
            || separate
            || render_generated_html
            || template.is_default_template()
            || list_pages_template_has_block_section(template);
        let list_pages_inline = wrapper
            && !separate
            && list_pages_template_starts_with_inline_anchor(template);
        let (output, pending_delayed) =
            finish_or_defer_list_pages_delayed_output_with_modes(
                FinishOrDeferListPagesDelayedOutputParams {
                    output,
                    delayed_occurrences,
                    runtime_text_ranges: delayed_runtime_text_ranges,
                    delayed_html_fragments,
                    defer_for_include_expansion,
                    page_info,
                    settings,
                    compat_html,
                    compat_text,
                    block_output,
                    list_pages_inline,
                    page_existence: numbered_link_titles
                        .as_ref()
                        .and_then(|titles| titles.page_existence()),
                },
            )?;
        Ok(ListPagesBlockRenderResult::Expanded(
            ListPagesRenderedBlock {
                expansion: IncludeExpansion {
                    wikitext: output,
                    included_pages,
                    expanded_include_count: initial_remaining_include_expansions
                        .saturating_sub(include_budget.remaining),
                },
                pending_delayed,
                runtime_css_insertions,
            },
        ))
    }
}
