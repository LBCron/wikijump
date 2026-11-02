use super::{
    AuthorizedPageSelector, BTreeMap, BTreeSet, CategoryService, CompatHtmlFragments,
    CompatTextFragments, Cow, FoundPageFields, FoundPages, IncludeExpansion,
    IncludeSourceCache, ListPagesArgumentError, ListPagesBatchDisplayRequirements,
    ListPagesBlock, ListPagesBlockPlan, ListPagesBlockRenderResult,
    ListPagesContentCache, ListPagesExpansion, ListPagesExpansionBudget,
    ListPagesExpansionOptions, ListPagesPageContext, ListPagesTemplatePlan,
    MAX_LISTPAGES_RENDER_LIMIT, MAX_NESTED_LISTPAGES_DEPTH,
    MAX_NESTED_LISTPAGES_MODULES_PER_PASS, OrderProperty, PageInfo,
    PageQueryScoreFilterCache, PendingDelayedListPagesOutput, Reference, RenderService,
    Result, ServiceContext, TextHash, WikitextSettings,
    collect_list_pages_css_yield_openers, current_data_form_list_pages_head,
    escape_html_text, exact_name_list_pages_batch_key,
    expand_list_pages_generated_includes,
    find_list_pages_module_matches_with_delayed_links_budgeted,
    has_list_pages_module_opening_candidate, k12_hash,
    list_pages_argument_error_with_parent_precedence,
    list_pages_body_has_standalone_count_pages_opening,
    list_pages_body_inline_count_pages_legacy_tail,
    list_pages_body_is_no_visible_tracking_markup,
    list_pages_body_starts_with_preparsed_block,
    list_pages_head_has_current_data_form_query_selector,
    list_pages_html_encoded_head_owns_script_tail, list_pages_module654_literal,
    list_pages_raw_footnote_prefix_end, list_pages_runtime_head_can_execute,
    list_pages_static_category_preflight, list_pages_static_parent_fullname_with_url,
    load_current_page_data_form_context, parse_list_pages_arguments_with_url,
    prepare_list_pages_rendered_block, preserve_list_pages_module_matches,
    protect_ajax_module_literal_markers, push_source_without_css_yield_openers,
    raw_module_close_end, restore_pending_nested_list_pages,
    seal_pending_list_pages_delayed_outputs, union_found_page_fields,
    unsupported_list_pages_replacement, url_offset_list_pages_content_bytes,
};

impl RenderService {
    #[allow(clippy::too_many_arguments)]
    pub(in crate::services::render) async fn expand_list_pages_nested(
        ctx: &ServiceContext<'_>,
        wikitext: String,
        page_info: &PageInfo<'_>,
        settings: &WikitextSettings,
        compat_html: &mut CompatHtmlFragments,
        include_source_cache: &mut IncludeSourceCache,
        compat_text: &mut CompatTextFragments,
        options: ListPagesExpansionOptions<'_>,
        expansion_budget: &mut ListPagesExpansionBudget,
        seen: &mut BTreeSet<TextHash>,
        depth: usize,
    ) -> Result<ListPagesExpansion> {
        tokio::task::yield_now().await;
        let ListPagesExpansionOptions {
            current_site_id,
            current_page_id,
            current_page_data_form_values,
            page_preview,
            viewer_user_id,
            mut include_budget,
            render_cost_budget,
            url,
            pager_route,
        } = options;
        let Some(current_site_id) = current_site_id else {
            return Ok(ListPagesExpansion {
                wikitext,
                included_pages: Vec::new(),
                expanded_include_count: 0,
                url_offset_content_bytes: 0,
                runtime_css_insertions: Vec::new(),
            });
        };
        let requested_current_page_id = current_page_id;
        let current_page_id = current_page_id.unwrap_or(0);

        if !settings.enable_page_syntax {
            return Ok(ListPagesExpansion {
                wikitext,
                included_pages: Vec::new(),
                expanded_include_count: 0,
                url_offset_content_bytes: 0,
                runtime_css_insertions: Vec::new(),
            });
        }

        if !has_list_pages_module_opening_candidate(&wikitext) {
            return Ok(ListPagesExpansion {
                wikitext,
                included_pages: Vec::new(),
                expanded_include_count: 0,
                url_offset_content_bytes: 0,
                runtime_css_insertions: Vec::new(),
            });
        }

        if !seen.insert(k12_hash(wikitext.as_bytes())) {
            return Ok(ListPagesExpansion {
                wikitext,
                included_pages: Vec::new(),
                expanded_include_count: 0,
                url_offset_content_bytes: 0,
                runtime_css_insertions: Vec::new(),
            });
        }

        let current_data_form_context = load_current_page_data_form_context(
            ctx,
            current_site_id,
            requested_current_page_id,
            page_info,
            current_page_data_form_values.clone(),
        )
        .await?;

        let initial_remaining_include_expansions = include_budget.remaining;
        let current_category = Self::page_info_category_slug(page_info);
        let unsupported_plan = |module_source: &str, body: &str| {
            let replacement = unsupported_list_pages_replacement(module_source, body);
            if replacement == module_source {
                ListPagesBlockPlan::PreserveOriginal("unsupported template shape")
            } else {
                ListPagesBlockPlan::Static(replacement)
            }
        };
        let unsafe_unknown_tracking_template = |template: &ListPagesTemplatePlan| {
            template.has_unknown_variables()
                && list_pages_body_is_no_visible_tracking_markup(template.body())
        };
        let fail_closed_unknown_tracking_plan =
            |compat_html: &mut CompatHtmlFragments| {
                ListPagesBlockPlan::Static(
                    compat_html.push_block_html(
                        r#"<div class="list-pages-box"></div>"#.to_owned(),
                    ),
                )
            };
        let module_matches = find_list_pages_module_matches_with_delayed_links_budgeted(
            &wikitext,
            &render_cost_budget,
        );
        let css_yield_openers = collect_list_pages_css_yield_openers(&wikitext);
        let mut css_yield_opener_index = 0usize;
        let module_source_bytes = module_matches.iter().fold(0usize, |total, module| {
            total.saturating_add(module.original.len())
        });
        if !expansion_budget.try_consume_modules(module_matches.len())
            || !expansion_budget.try_consume_module_source_bytes(module_source_bytes)
        {
            let preserved = preserve_list_pages_module_matches(
                &wikitext,
                &module_matches,
                compat_text,
            );
            return Ok(ListPagesExpansion {
                wikitext: preserved,
                included_pages: Vec::new(),
                expanded_include_count: 0,
                url_offset_content_bytes: 0,
                runtime_css_insertions: Vec::new(),
            });
        }
        if depth > 0 && module_matches.len() > MAX_NESTED_LISTPAGES_MODULES_PER_PASS {
            return Ok(ListPagesExpansion {
                wikitext,
                included_pages: Vec::new(),
                expanded_include_count: 0,
                url_offset_content_bytes: 0,
                runtime_css_insertions: Vec::new(),
            });
        }
        let static_parent_references = module_matches
            .iter()
            .filter_map(|module| {
                let head = current_data_form_list_pages_head(
                    module.head,
                    current_data_form_context.as_ref(),
                );
                list_pages_runtime_head_can_execute(head.as_ref())
                    .then(|| {
                        list_pages_static_parent_fullname_with_url(head.as_ref(), url)
                    })
                    .flatten()
            })
            .collect::<BTreeSet<_>>()
            .into_iter()
            .map(|parent| Reference::Slug(Cow::Owned(parent)))
            .collect::<Vec<_>>();
        let mut authorized_selector = AuthorizedPageSelector::new(ctx, viewer_user_id);
        let existing_static_parents = authorized_selector
            .resolve_models(current_site_id, &static_parent_references)
            .await?
            .into_iter()
            .map(|page| page.slug)
            .collect::<BTreeSet<_>>();
        let needs_static_category_existence = module_matches.iter().any(|module| {
            let head = current_data_form_list_pages_head(
                module.head,
                current_data_form_context.as_ref(),
            );
            list_pages_static_category_preflight(head.as_ref()).is_some()
        });
        let existing_category_slugs = if needs_static_category_existence {
            Some(
                CategoryService::get_all(ctx, current_site_id)
                    .await?
                    .into_iter()
                    .map(|category| category.slug)
                    .collect::<BTreeSet<_>>(),
            )
        } else {
            None
        };
        let blocks = module_matches
            .into_iter()
            .map(|module| {
                let preserve_original = module.preserve_original;
                let preserve_as_module654 = module.preserve_as_module654;
                let consume_empty_tail = module.consume_empty_tail;
                let resolved_head = current_data_form_list_pages_head(
                    module.head,
                    current_data_form_context.as_ref(),
                );
                let head = resolved_head.as_ref();
                let unresolved_current_data_form_query = current_data_form_context
                    .is_none()
                    && list_pages_head_has_current_data_form_query_selector(head);
                let static_category_preflight =
                    list_pages_static_category_preflight(head);
                let body_was_preparsed =
                    list_pages_body_starts_with_preparsed_block(module.body);
                let html_encoded_head_owns_script_tail =
                    list_pages_html_encoded_head_owns_script_tail(head, module.body);
                let body_is_empty = module.body.trim().is_empty();
                let raw_footnote_prefix_end = (body_is_empty
                    && module.end == module.body_start)
                    .then(|| {
                        list_pages_raw_footnote_prefix_end(
                            head,
                            &wikitext[module.body_start..],
                        )
                    })
                    .flatten()
                    .map(|end| module.body_start + end);
                let body = if body_was_preparsed || html_encoded_head_owns_script_tail {
                    ""
                } else {
                    module.body
                };
                let compile_template = |source: &str| {
                    let mut template = ListPagesTemplatePlan::compile(source)?;
                    if body_was_preparsed {
                        template.use_full_default_summary();
                    }
                    Some(template)
                };
                let zero_row_runtime_output = parse_list_pages_arguments_with_url(
                    head, url,
                )
                .is_some_and(|arguments| {
                    arguments
                        .rss_title
                        .as_deref()
                        .is_some_and(|title| !title.is_empty())
                        || !arguments.separate
                            && (arguments.prepend_line.is_some()
                                || arguments.append_line.is_some()
                                || compile_template(body).is_some_and(|template| {
                                    template.head_section().is_some()
                                        || template.foot_section().is_some()
                                }))
                });
                let static_categories_prove_empty = !zero_row_runtime_output
                    && static_category_preflight.as_ref().is_some_and(
                        |(categories, _)| {
                            existing_category_slugs.as_ref().is_some_and(|existing| {
                                categories
                                    .iter()
                                    .all(|category| !existing.contains(category))
                            })
                        },
                    );
                let module_end = if html_encoded_head_owns_script_tail {
                    module.end
                } else if body_was_preparsed {
                    module.body_start
                } else if let Some(end) = raw_footnote_prefix_end {
                    end
                } else if unresolved_current_data_form_query
                    && module.end == module.body_start
                {
                    raw_module_close_end(&wikitext, module.body_start)
                        .unwrap_or(module.end)
                } else if body_is_empty && !consume_empty_tail {
                    module.body_start
                } else if body_is_empty
                    && consume_empty_tail
                    && module.end == module.body_start
                {
                    raw_module_close_end(&wikitext, module.body_start)
                        .unwrap_or(module.end)
                } else {
                    module.end
                };
                let leaves_raw_closer = module_end == module.body_start
                    && (body_was_preparsed || body_is_empty);
                let module_original = if leaves_raw_closer {
                    &wikitext[module.start..module.body_start]
                } else {
                    module.original
                };
                let head_can_execute = list_pages_runtime_head_can_execute(head);
                let feed_only_plan = head_can_execute
                    .then(|| parse_list_pages_arguments_with_url(head, url))
                    .flatten()
                    .filter(|arguments| {
                        arguments.rss_only
                            && arguments
                                .rss_title
                                .as_deref()
                                .is_some_and(|title| !title.is_empty())
                    })
                    .and_then(|arguments| {
                        compile_template("").map(|template| ListPagesBlockPlan::Render {
                            arguments,
                            template,
                            batch_key: None,
                            legacy_tail: None,
                        })
                    });
                let missing_static_parent =
                    list_pages_static_parent_fullname_with_url(head, url)
                        .filter(|parent| !existing_static_parents.contains(parent));
                let plan = if preserve_as_module654 {
                    ListPagesBlockPlan::Static(compat_text.push_escaped_html_text(
                        &list_pages_module654_literal(module_original),
                    ))
                } else if preserve_original {
                    ListPagesBlockPlan::PreserveOriginal(
                        "unclosed inline-raw documentation example",
                    )
                } else if let Some(plan) = feed_only_plan {
                    plan
                } else if let Some(error) =
                    list_pages_argument_error_with_parent_precedence(
                        head,
                        requested_current_page_id.is_some(),
                        url,
                        missing_static_parent,
                    )
                {
                    let message = match error {
                        ListPagesArgumentError::Message(message) => message.to_owned(),
                        ListPagesArgumentError::MissingParent(parent) => format!(
                            "Parent page {} does not exist",
                            escape_html_text(&parent),
                        ),
                    };
                    ListPagesBlockPlan::Static(compat_html.push_block_html(format!(
                        r#"<div class="error-block">{message}</div>"#,
                    )))
                } else if static_categories_prove_empty {
                    let replacement = if static_category_preflight
                        .as_ref()
                        .is_some_and(|(_, wrapper)| *wrapper)
                    {
                        compat_html.push_block_html(
                            r#"<div class="list-pages-box"></div>"#.to_owned(),
                        )
                    } else {
                        String::new()
                    };
                    ListPagesBlockPlan::Static(replacement)
                } else if unresolved_current_data_form_query
                    && let Some(mut arguments) =
                        parse_list_pages_arguments_with_url(head, url)
                {
                    if zero_row_runtime_output {
                        arguments.limit = Some(0);
                        arguments.unsupported_author_filter = false;
                        arguments.unsupported_list_pages_filter = false;
                        arguments.unsupported_score_filter = false;
                        match compile_template(body) {
                            Some(template)
                                if unsafe_unknown_tracking_template(&template) =>
                            {
                                fail_closed_unknown_tracking_plan(compat_html)
                            }
                            Some(template) => ListPagesBlockPlan::Render {
                                arguments,
                                template,
                                batch_key: None,
                                legacy_tail: None,
                            },
                            None => unsupported_plan(module_original, body),
                        }
                    } else {
                        let replacement = if arguments.wrapper {
                            compat_html.push_block_html(
                                r#"<div class="list-pages-box"></div>"#.to_owned(),
                            )
                        } else {
                            String::new()
                        };
                        ListPagesBlockPlan::Static(replacement)
                    }
                } else if !head_can_execute {
                    ListPagesBlockPlan::PreserveOriginal(
                        "head, parent, or page-type selector is not executable",
                    )
                } else if let Some(arguments) =
                    parse_list_pages_arguments_with_url(head, url)
                {
                    if !zero_row_runtime_output
                        && (arguments.limit == Some(0)
                            || arguments.count_pages_per_page == Some(0)
                            || arguments.current_page_only
                                && requested_current_page_id.is_none())
                    {
                        let replacement = if arguments.wrapper {
                            compat_html.push_block_html(
                                r#"<div class="list-pages-box"></div>"#.to_owned(),
                            )
                        } else {
                            String::new()
                        };
                        ListPagesBlockPlan::Static(replacement)
                    } else if arguments.unsupported_author_filter
                        || arguments.unsupported_list_pages_filter
                        || arguments.unsupported_score_filter
                    {
                        ListPagesBlockPlan::PreserveOriginal(
                            "unsupported author, query, or score selector",
                        )
                    } else if let Some(legacy_tail) =
                        list_pages_body_inline_count_pages_legacy_tail(body)
                    {
                        compile_template("").map_or_else(
                            || unsupported_plan(module_original, body),
                            |template| ListPagesBlockPlan::Render {
                                arguments,
                                template,
                                batch_key: None,
                                legacy_tail: Some(legacy_tail),
                            },
                        )
                    } else if list_pages_body_has_standalone_count_pages_opening(body) {
                        let template = ListPagesTemplatePlan::empty_row();
                        let batch_key = exact_name_list_pages_batch_key(
                            head,
                            &template,
                            &arguments,
                            current_category.as_ref(),
                        );
                        ListPagesBlockPlan::Render {
                            arguments,
                            template,
                            batch_key,
                            legacy_tail: None,
                        }
                    } else if let Some(template) = compile_template(body) {
                        if unsafe_unknown_tracking_template(&template) {
                            fail_closed_unknown_tracking_plan(compat_html)
                        } else {
                            let batch_key = exact_name_list_pages_batch_key(
                                head,
                                &template,
                                &arguments,
                                current_category.as_ref(),
                            );
                            ListPagesBlockPlan::Render {
                                arguments,
                                template,
                                batch_key,
                                legacy_tail: None,
                            }
                        }
                    } else {
                        unsupported_plan(module_original, body)
                    }
                } else {
                    unsupported_plan(module_original, body)
                };
                ListPagesBlock {
                    start: module.start,
                    end: module_end,
                    plan,
                }
            })
            .collect::<Vec<_>>();

        let mut expanded = String::with_capacity(wikitext.len());
        let mut included_pages = Vec::new();
        let mut runtime_css_insertions = Vec::new();
        let mut pending_delayed_outputs = Vec::<PendingDelayedListPagesOutput>::new();
        let mut url_offset_content_bytes = 0usize;
        let mut content_cache = ListPagesContentCache::default();
        let mut permission_cache = BTreeMap::new();
        let mut score_filter_cache = PageQueryScoreFilterCache::default();
        let mut author_resolution_cache = BTreeMap::new();
        let mut cursor = 0;
        let mut blocks = blocks.into_iter().peekable();

        while let Some(block) = blocks.next() {
            let batch_key = match &block.plan {
                ListPagesBlockPlan::Render {
                    batch_key: Some(key),
                    ..
                } => Some(key.clone()),
                _ => None,
            };
            if let Some(batch_key) = batch_key {
                let mut batch = vec![block];
                while batch.len() < MAX_LISTPAGES_RENDER_LIMIT as usize
                    && blocks.peek().is_some_and(|next| {
                        matches!(
                            &next.plan,
                            ListPagesBlockPlan::Render {
                                batch_key: Some(key),
                                ..
                            } if key == &batch_key
                        )
                    })
                {
                    batch.push(blocks.next().unwrap());
                }

                let mut unique_slugs = BTreeSet::new();
                let mut fields = FoundPageFields::default();
                let mut display_requirements =
                    ListPagesBatchDisplayRequirements::default();
                for block in &batch {
                    let ListPagesBlockPlan::Render {
                        arguments,
                        template,
                        ..
                    } = &block.plan
                    else {
                        unreachable!();
                    };
                    unique_slugs.insert(arguments.slug.as_ref().unwrap().to_string());
                    let mut block_fields = template.fields();
                    block_fields.revision_count |= matches!(
                        arguments.order.as_ref().map(|order| &order.property),
                        Some(OrderProperty::Revisions)
                    );
                    union_found_page_fields(&mut fields, &block_fields);
                    display_requirements.include(template);
                }
                let slugs = unique_slugs
                    .iter()
                    .map(|slug| Cow::Borrowed(slug.as_str()))
                    .collect::<Vec<_>>();
                let prefetched = Self::load_exact_name_list_pages_batch(
                    ctx,
                    current_site_id,
                    current_page_id,
                    &batch_key,
                    &slugs,
                    fields,
                    &mut permission_cache,
                )
                .await?;
                let prefetched_displays = if let Some(prefetched) = prefetched.as_ref() {
                    let prefetched_rows =
                        prefetched.values().flatten().cloned().collect::<Vec<_>>();
                    Some(
                        Self::load_list_pages_batch_displays(
                            ctx,
                            &prefetched_rows,
                            display_requirements,
                        )
                        .await?,
                    )
                } else {
                    None
                };

                for block in batch {
                    push_source_without_css_yield_openers(
                        &mut expanded,
                        &wikitext,
                        cursor..block.start,
                        &css_yield_openers,
                        &mut css_yield_opener_index,
                    );
                    let ListPagesBlockPlan::Render {
                        arguments,
                        template,
                        legacy_tail,
                        ..
                    } = block.plan
                    else {
                        unreachable!();
                    };
                    let offset_origin = arguments.offset_origin;
                    let uses_content = template.uses_content();
                    let slug = arguments.slug.as_ref().unwrap().to_string();
                    let prefetched_pages =
                        prefetched.as_ref().map(|prefetched| FoundPages {
                            pages: prefetched.get(&slug).cloned().unwrap_or_default(),
                        });
                    let rendered = Box::pin(Self::render_list_pages_block(
                        ctx,
                        ListPagesPageContext {
                            site_id: current_site_id,
                            page_id: requested_current_page_id,
                            url,
                        },
                        pager_route,
                        compat_html,
                        viewer_user_id,
                        page_info,
                        page_preview,
                        settings,
                        arguments,
                        &template,
                        &mut include_budget,
                        &render_cost_budget,
                        prefetched_pages,
                        prefetched_displays.as_ref(),
                        &mut content_cache,
                        expansion_budget,
                        &mut permission_cache,
                        &mut score_filter_cache,
                        &mut author_resolution_cache,
                        compat_text,
                    ))
                    .await?;
                    match rendered {
                        ListPagesBlockRenderResult::Expanded(rendered) => {
                            let boundaries = (
                                &wikitext[cursor..block.start],
                                legacy_tail.as_deref().unwrap_or(&wikitext[block.end..]),
                            );
                            let Some(IncludeExpansion {
                                wikitext: replacement,
                                included_pages: replacement_included_pages,
                                expanded_include_count: _,
                            }) = prepare_list_pages_rendered_block(
                                rendered,
                                boundaries,
                                expansion_budget,
                                compat_html,
                                compat_text,
                                &mut pending_delayed_outputs,
                                &mut runtime_css_insertions,
                            )
                            else {
                                expanded.push_str(&compat_text.push_escaped_html_text(
                                    &wikitext[block.start..block.end],
                                ));
                                cursor = block.end;
                                continue;
                            };
                            url_offset_content_bytes = url_offset_content_bytes
                                .saturating_add(url_offset_list_pages_content_bytes(
                                    offset_origin,
                                    uses_content,
                                    &replacement,
                                ));
                            expanded.push_str(&replacement);
                            if let Some(legacy_tail) = legacy_tail {
                                expanded.push_str(&legacy_tail);
                            }
                            included_pages.extend(replacement_included_pages);
                        }
                        ListPagesBlockRenderResult::PreserveOriginal(reason) => {
                            debug!(
                                "ListPages preserved original for {:?}: {reason}",
                                page_info.title,
                            );
                            expanded.push_str(&compat_text.push_escaped_html_text(
                                &wikitext[block.start..block.end],
                            ));
                        }
                    }
                    cursor = block.end;
                }
                continue;
            }

            push_source_without_css_yield_openers(
                &mut expanded,
                &wikitext,
                cursor..block.start,
                &css_yield_openers,
                &mut css_yield_opener_index,
            );
            match block.plan {
                ListPagesBlockPlan::Static(replacement) => {
                    expanded.push_str(&replacement);
                }
                ListPagesBlockPlan::PreserveOriginal(reason) => {
                    debug!(
                        "ListPages preserved original for {:?}: {reason}",
                        page_info.title,
                    );
                    expanded.push_str(
                        &compat_text
                            .push_escaped_html_text(&wikitext[block.start..block.end]),
                    );
                    if reason == "unclosed inline-raw documentation example"
                        && wikitext[block.end..].starts_with("@@\n@@[[div")
                    {
                        expanded.push(' ');
                    }
                }
                ListPagesBlockPlan::Render {
                    arguments,
                    template,
                    legacy_tail,
                    ..
                } => {
                    let offset_origin = arguments.offset_origin;
                    let uses_content = template.uses_content();
                    let rendered = Box::pin(Self::render_list_pages_block(
                        ctx,
                        ListPagesPageContext {
                            site_id: current_site_id,
                            page_id: requested_current_page_id,
                            url,
                        },
                        pager_route,
                        compat_html,
                        viewer_user_id,
                        page_info,
                        page_preview,
                        settings,
                        arguments,
                        &template,
                        &mut include_budget,
                        &render_cost_budget,
                        None,
                        None,
                        &mut content_cache,
                        expansion_budget,
                        &mut permission_cache,
                        &mut score_filter_cache,
                        &mut author_resolution_cache,
                        compat_text,
                    ))
                    .await?;
                    match rendered {
                        ListPagesBlockRenderResult::Expanded(rendered) => {
                            let boundaries = (
                                &wikitext[cursor..block.start],
                                legacy_tail.as_deref().unwrap_or(&wikitext[block.end..]),
                            );
                            let Some(IncludeExpansion {
                                wikitext: replacement,
                                included_pages: replacement_included_pages,
                                expanded_include_count: _,
                            }) = prepare_list_pages_rendered_block(
                                rendered,
                                boundaries,
                                expansion_budget,
                                compat_html,
                                compat_text,
                                &mut pending_delayed_outputs,
                                &mut runtime_css_insertions,
                            )
                            else {
                                expanded.push_str(&compat_text.push_escaped_html_text(
                                    &wikitext[block.start..block.end],
                                ));
                                cursor = block.end;
                                continue;
                            };
                            url_offset_content_bytes = url_offset_content_bytes
                                .saturating_add(url_offset_list_pages_content_bytes(
                                    offset_origin,
                                    uses_content,
                                    &replacement,
                                ));
                            expanded.push_str(&replacement);
                            if let Some(legacy_tail) = legacy_tail {
                                expanded.push_str(&legacy_tail);
                            }
                            included_pages.extend(replacement_included_pages);
                        }
                        ListPagesBlockRenderResult::PreserveOriginal(reason) => {
                            debug!(
                                "ListPages preserved original for {:?}: {reason}",
                                page_info.title,
                            );
                            expanded.push_str(&compat_text.push_escaped_html_text(
                                &wikitext[block.start..block.end],
                            ));
                        }
                    }
                }
            }
            cursor = block.end;
        }

        push_source_without_css_yield_openers(
            &mut expanded,
            &wikitext,
            cursor..wikitext.len(),
            &css_yield_openers,
            &mut css_yield_opener_index,
        );
        let expanded = if page_info.page.as_ref() == "_ajax-module-connector" {
            protect_ajax_module_literal_markers(expanded, compat_text)
        } else {
            expanded
        };
        let mut expansion = ListPagesExpansion {
            wikitext: expanded,
            included_pages,
            expanded_include_count: initial_remaining_include_expansions
                .saturating_sub(include_budget.remaining),
            url_offset_content_bytes,
            runtime_css_insertions,
        };
        expand_list_pages_generated_includes(
            ctx,
            &mut expansion,
            page_info,
            settings,
            current_site_id,
            page_preview,
            include_source_cache,
            compat_text,
            &mut include_budget,
            &render_cost_budget,
            initial_remaining_include_expansions,
        )
        .await?;
        let nested_source = restore_pending_nested_list_pages(
            &expansion.wikitext,
            &pending_delayed_outputs,
        );
        if depth < MAX_NESTED_LISTPAGES_DEPTH
            && has_list_pages_module_opening_candidate(&nested_source)
        {
            let nested = Box::pin(Self::expand_list_pages_nested(
                ctx,
                nested_source,
                page_info,
                settings,
                compat_html,
                include_source_cache,
                compat_text,
                ListPagesExpansionOptions {
                    current_site_id: Some(current_site_id),
                    current_page_id: requested_current_page_id,
                    current_page_data_form_values: current_page_data_form_values.clone(),
                    page_preview,
                    viewer_user_id,
                    include_budget,
                    render_cost_budget: render_cost_budget.clone(),
                    url,
                    pager_route,
                },
                expansion_budget,
                seen,
                depth + 1,
            ))
            .await?;
            expansion.wikitext = nested.wikitext;
            expansion.included_pages.extend(nested.included_pages);
            expansion.expanded_include_count = expansion
                .expanded_include_count
                .saturating_add(nested.expanded_include_count);
            expansion.url_offset_content_bytes = expansion
                .url_offset_content_bytes
                .saturating_add(nested.url_offset_content_bytes);
            expansion
                .runtime_css_insertions
                .extend(nested.runtime_css_insertions);
        } else if depth >= MAX_NESTED_LISTPAGES_DEPTH
            && has_list_pages_module_opening_candidate(&nested_source)
        {
            expansion.wikitext = nested_source;
        }
        seal_pending_list_pages_delayed_outputs(
            &mut expansion.wikitext,
            pending_delayed_outputs,
            page_info,
            settings,
            compat_html,
        )?;
        Ok(expansion)
    }
}
