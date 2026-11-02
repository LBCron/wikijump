/*
 * tests/page/page_query.rs
 *
 * DEEPWELL - Wikijump API provider and database manager
 * Copyright (C) 2019-2026 Wikijump Team
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 */

use super::*;

#[tokio::test]
async fn listpages_created_at_order_renders_results() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let html = render_listpages_test_fixture_with_targets(
        &mut runner,
        site.site.site_id,
        "fixture-listpages-created-at",
        "verification-list-created-at",
        r#"tags="+verification-list-created-at" limit="3" order="created_at""#,
        "* %%title%% :: %%slug%%",
        &[
            (
                "target-z",
                "Fixture ListPages Created Zulu",
                "Fixture ListPages Created Zulu marker.",
            ),
            (
                "target-a",
                "Fixture ListPages Created Alpha",
                "Fixture ListPages Created Alpha marker.",
            ),
            (
                "target-m",
                "Fixture ListPages Created Middle",
                "Fixture ListPages Created Middle marker.",
            ),
        ],
    )
    .await;

    for expected in [
        "Fixture ListPages Created Zulu",
        "Fixture ListPages Created Alpha",
        "Fixture ListPages Created Middle",
        "fixture-listpages-created-at-target-z",
        "fixture-listpages-created-at-target-a",
        "fixture-listpages-created-at-target-m",
    ] {
        assert!(
            html.contains(expected),
            "created_at ListPages fixture should contain {expected:?}:\n{html}",
        );
    }

    assert!(
        !html.contains("[[module ListPages") && !html.contains("%%title%%"),
        "created_at ListPages fixture should render instead of remaining raw:\n{html}",
    );

    let positions = [
        "fixture-listpages-created-at-target-z",
        "fixture-listpages-created-at-target-a",
        "fixture-listpages-created-at-target-m",
    ]
    .map(|slug| {
        html.find(slug).unwrap_or_else(|| {
            panic!("created_at ListPages fixture should contain {slug:?}")
        })
    });
    assert!(
        positions[0] < positions[1] && positions[1] < positions[2],
        "created_at ListPages fixture should render in creation order, not lexical slug/title order:\n{html}"
    );
}

#[tokio::test]
async fn page_query_orders_by_page_slug_without_category_prefix() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let tag = "verification-page-slug-order";

    for (slug, title) in [
        ("zcategory:alpha", "Page slug order alpha"),
        ("acategory:beta", "Page slug order beta"),
        ("mcategory:gamma", "Page slug order gamma"),
    ] {
        let revision = create_listpages_test_page(
            &mut runner,
            site_id,
            slug,
            title,
            "Page slug order marker.",
        )
        .await;
        set_listpages_test_tags(&mut runner, site_id, slug, revision, &[tag]).await;
    }

    let all_tags = [Cow::Borrowed(tag)];
    let pages = PageQueryService::find(
        runner.context(),
        PageQuery {
            current_page_id: 0,
            current_site_id: site_id,
            queried_site_id: Some(site_id),
            page_type: PageTypeSelector::All,
            categories: CategoriesSelector {
                included_categories: IncludedCategories::All,
                excluded_categories: &[],
            },
            tags: TagCondition {
                any_present: &[],
                all_present: &all_tags,
                none_present: &[],
                untagged: false,
            },
            page_parent: PageParentSelector::NoParent,
            contains_outgoing_links: &[],
            creation_date: DateSelector::FromPresent {
                start: OffsetDateTime::UNIX_EPOCH,
            },
            update_date: DateSelector::FromPresent {
                start: OffsetDateTime::UNIX_EPOCH,
            },
            author: AuthorSelector::All,
            score: &[],
            votes: &[],
            offset: 0,
            range: RangeSelector::Current,
            name: None,
            slug: None,
            slugs: &[],
            data_form_fields: &[],
            order: Some(OrderBySelector {
                property: OrderProperty::PageSlug,
                ascending: true,
            }),
            candidate_limit: None,
            pagination: PaginationSelector {
                limit: Some(10),
                ..Default::default()
            },
            variables: &[],
            fields: FoundPageFields {
                slug: true,
                ..Default::default()
            },
        },
    )
    .await
    .expect("page slug order query should not fail");

    let slugs = pages
        .pages
        .into_iter()
        .map(|row| row.slug.expect("slug field should be requested"))
        .collect::<Vec<_>>();

    assert_eq!(
        slugs,
        ["zcategory:alpha", "acategory:beta", "mcategory:gamma"],
        "PageSlug order should sort by page slug, not by full category-qualified slug",
    );
}

#[tokio::test]
async fn tag_page_queries_plan_with_their_values_and_leave_the_render_on_cached_plans() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let tag = "verification-tag-custom-plan";
    let slug = "verification-tag-custom-plan-page";
    let revision = create_listpages_test_page(
        &mut runner,
        site_id,
        slug,
        "Tag custom plan",
        "Tag custom plan marker.",
    )
    .await;
    set_listpages_test_tags(&mut runner, site_id, slug, revision, &[tag]).await;

    let any_tags = [Cow::Borrowed(tag)];
    let pages = PageQueryService::find(
        runner.context(),
        PageQuery {
            current_page_id: 0,
            current_site_id: site_id,
            queried_site_id: Some(site_id),
            page_type: PageTypeSelector::All,
            categories: CategoriesSelector {
                included_categories: IncludedCategories::All,
                excluded_categories: &[],
            },
            tags: TagCondition {
                any_present: &any_tags,
                all_present: &[],
                none_present: &[],
                untagged: false,
            },
            page_parent: PageParentSelector::All,
            contains_outgoing_links: &[],
            creation_date: DateSelector::FromPresent {
                start: OffsetDateTime::UNIX_EPOCH,
            },
            update_date: DateSelector::FromPresent {
                start: OffsetDateTime::UNIX_EPOCH,
            },
            author: AuthorSelector::All,
            score: &[],
            votes: &[],
            offset: 0,
            range: RangeSelector::Current,
            name: None,
            slug: None,
            slugs: &[],
            data_form_fields: &[],
            order: None,
            candidate_limit: None,
            pagination: PaginationSelector {
                limit: Some(10),
                ..Default::default()
            },
            variables: &[],
            fields: FoundPageFields {
                slug: true,
                ..Default::default()
            },
        },
    )
    .await
    .expect("tag page query should not fail");
    let slugs = pages
        .pages
        .into_iter()
        .map(|row| row.slug.expect("slug field should be requested"))
        .collect::<Vec<_>>();
    assert_eq!(slugs, [slug]);

    // The custom plan is for the tag query only; the rest of the render
    // transaction keeps PostgreSQL's cached plans.
    let txn = runner.context().transaction();
    let setting = txn
        .query_one_raw(Statement::from_string(
            txn.get_database_backend(),
            "SELECT current_setting('plan_cache_mode') AS mode",
        ))
        .await
        .expect("plan_cache_mode should be readable")
        .expect("current_setting returns a row")
        .try_get::<String>("", "mode")
        .expect("plan_cache_mode is text");
    assert_eq!(setting, "auto");
}

#[tokio::test]
async fn page_query_revision_order_keeps_unrequested_count_out_of_results() {
    const LOW_SLUG: &str = "page-query-revision-order-low";
    const HIGH_SLUG: &str = "page-query-revision-order-high";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;

    create_listpages_test_page(
        &mut runner,
        site_id,
        LOW_SLUG,
        "PageQuery revision-order low",
        "one revision",
    )
    .await;
    let high_revision = create_listpages_test_page(
        &mut runner,
        site_id,
        HIGH_SLUG,
        "PageQuery revision-order high",
        "first revision",
    )
    .await;
    set_mutation_request_context(
        &mut runner,
        ADMIN_USER_ID,
        site_id,
        Reference::Slug(Cow::Borrowed(HIGH_SLUG)),
    );
    run_endpoint!(
        runner,
        page_edit,
        json!({
            "site_id": site_id,
            "page": HIGH_SLUG,
            "last_revision_id": high_revision,
            "revision_comments": "add second PageQuery revision-order revision",
            "user_id": ADMIN_USER_ID,
            "wikitext": "second revision",
            "ip_address": common::IP_ADDRESS,
        }),
    )
    .expect("revision-order high fixture edit should create a revision");

    let fixture_slugs = [Cow::Borrowed(LOW_SLUG), Cow::Borrowed(HIGH_SLUG)];
    let mut query = PageQuery {
        current_page_id: 0,
        current_site_id: site_id,
        queried_site_id: Some(site_id),
        page_type: PageTypeSelector::All,
        categories: CategoriesSelector {
            included_categories: IncludedCategories::All,
            excluded_categories: &[],
        },
        tags: TagCondition {
            any_present: &[],
            all_present: &[],
            none_present: &[],
            untagged: false,
        },
        page_parent: PageParentSelector::All,
        contains_outgoing_links: &[],
        creation_date: DateSelector::FromPresent {
            start: OffsetDateTime::UNIX_EPOCH,
        },
        update_date: DateSelector::FromPresent {
            start: OffsetDateTime::UNIX_EPOCH,
        },
        author: AuthorSelector::All,
        score: &[],
        votes: &[],
        offset: 0,
        range: RangeSelector::Current,
        name: None,
        slug: None,
        slugs: &fixture_slugs,
        data_form_fields: &[],
        order: Some(OrderBySelector {
            property: OrderProperty::Revisions,
            ascending: false,
        }),
        candidate_limit: None,
        pagination: PaginationSelector {
            limit: Some(10),
            ..Default::default()
        },
        variables: &[],
        fields: FoundPageFields {
            slug: true,
            revision_count: false,
            ..Default::default()
        },
    };

    let ordered = PageQueryService::find(runner.context(), query.clone())
        .await
        .expect("ordering-only revision query should succeed");
    assert_eq!(
        ordered
            .pages
            .iter()
            .map(|row| row.slug.as_deref())
            .collect::<Vec<_>>(),
        [Some(HIGH_SLUG), Some(LOW_SLUG)],
        "the internally projected count must still control revision ordering",
    );
    assert!(
        ordered.pages.iter().all(|row| row.revision_count.is_none()),
        "revision ordering must not expose an unrequested public result field",
    );

    query.fields.revision_count = true;
    let requested = PageQueryService::find(runner.context(), query)
        .await
        .expect("revision query with requested count should succeed");
    assert_eq!(
        requested
            .pages
            .iter()
            .map(|row| (row.slug.as_deref(), row.revision_count))
            .collect::<Vec<_>>(),
        [(Some(HIGH_SLUG), Some(2)), (Some(LOW_SLUG), Some(1))],
    );
}

#[tokio::test]
async fn page_query_page_slug_ties_follow_wikidot_source_identity() {
    const IMPORT_RUN_ID: i64 = 7_130_562;
    const B_OLDER: &str = "bcategory:alpha";
    const C_MIDDLE: &str = "ccategory:alpha";
    const A_NEWER: &str = "acategory:alpha";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;

    for (slug, title) in [
        (B_OLDER, "Page name tie older"),
        (A_NEWER, "Page name tie newer"),
        (C_MIDDLE, "Page name tie middle"),
    ] {
        create_listpages_test_page(
            &mut runner,
            site_id,
            slug,
            title,
            "Page name tie marker.",
        )
        .await;
    }

    let b_older_id = listpages_test_page_id(&runner, site_id, B_OLDER).await;
    let a_newer_id = listpages_test_page_id(&runner, site_id, A_NEWER).await;
    let c_middle_id = listpages_test_page_id(&runner, site_id, C_MIDDLE).await;
    create_listpages_test_import_run(&runner, site_id, IMPORT_RUN_ID, 3).await;
    for fixture in [
        (b_older_id, B_OLDER, 601, "Page Name Tie Author"),
        (a_newer_id, A_NEWER, 602, "Page Name Tie Author"),
        (c_middle_id, C_MIDDLE, 603, "Page Name Tie Author"),
    ] {
        mark_imported_page_with_author_snapshot(&runner, site_id, IMPORT_RUN_ID, fixture)
            .await;
    }
    let transaction = runner.context().transaction();
    for (page_id, source_page_id) in [
        (b_older_id, 100_i64),
        (c_middle_id, 200_i64),
        (a_newer_id, 300_i64),
    ] {
        transaction
            .execute_raw(Statement::from_sql_and_values(
                transaction.get_database_backend(),
                "UPDATE wikidot_page_snapshot \
                 SET meta_json = jsonb_build_object('page_id', $1::text) \
                 WHERE page_id = $2",
                [Value::from(source_page_id), Value::from(page_id)],
            ))
            .await
            .expect("page-name tie fixture should receive a source page ID");
    }

    let fixture_slugs = [
        Cow::Borrowed(B_OLDER),
        Cow::Borrowed(C_MIDDLE),
        Cow::Borrowed(A_NEWER),
    ];
    let mut query = PageQuery {
        current_page_id: 0,
        current_site_id: site_id,
        queried_site_id: Some(site_id),
        page_type: PageTypeSelector::All,
        categories: CategoriesSelector {
            included_categories: IncludedCategories::All,
            excluded_categories: &[],
        },
        tags: TagCondition {
            any_present: &[],
            all_present: &[],
            none_present: &[],
            untagged: false,
        },
        page_parent: PageParentSelector::All,
        contains_outgoing_links: &[],
        creation_date: DateSelector::FromPresent {
            start: OffsetDateTime::UNIX_EPOCH,
        },
        update_date: DateSelector::FromPresent {
            start: OffsetDateTime::UNIX_EPOCH,
        },
        author: AuthorSelector::All,
        score: &[],
        votes: &[],
        offset: 0,
        range: RangeSelector::Current,
        name: None,
        slug: None,
        slugs: &fixture_slugs,
        data_form_fields: &[],
        order: Some(OrderBySelector {
            property: OrderProperty::PageSlug,
            ascending: true,
        }),
        candidate_limit: None,
        pagination: PaginationSelector {
            limit: Some(10),
            ..Default::default()
        },
        variables: &[],
        fields: FoundPageFields {
            slug: true,
            ..Default::default()
        },
    };

    let ordered_slugs = |pages: deepwell::services::page_query::FoundPages| {
        pages
            .pages
            .into_iter()
            .map(|row| row.slug.expect("slug field should be requested"))
            .collect::<Vec<_>>()
    };
    let ascending = PageQueryService::find(runner.context(), query.clone())
        .await
        .expect("ascending page-name tie query should succeed");
    assert_eq!(
        ordered_slugs(ascending),
        [B_OLDER, C_MIDDLE, A_NEWER],
        "equal category-local page names should follow Wikidot source identity",
    );

    query.order = Some(OrderBySelector {
        property: OrderProperty::PageSlug,
        ascending: false,
    });
    let descending = PageQueryService::find(runner.context(), query)
        .await
        .expect("descending page-name tie query should succeed");
    assert_eq!(
        ordered_slugs(descending),
        [A_NEWER, C_MIDDLE, B_OLDER],
        "descending name order should reverse the source-identity tie-break",
    );
}

#[tokio::test]
async fn page_query_equal_sort_values_follow_wikidot_source_identity() {
    const IMPORT_RUN_ID: i64 = 7_130_563;
    const SOURCE_OLDER: &str = "bcategory:created-at-tie";
    const SOURCE_MIDDLE: &str = "ccategory:created-at-tie";
    const SOURCE_NEWER: &str = "acategory:created-at-tie";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let tied_created_at = OffsetDateTime::from_unix_timestamp(1_700_000_000)
        .expect("fixture timestamp is valid");

    for (slug, title) in [
        (SOURCE_OLDER, "Created-at tie older source"),
        (SOURCE_NEWER, "Created-at tie newer source"),
        (SOURCE_MIDDLE, "Created-at tie middle source"),
    ] {
        create_listpages_test_page(
            &mut runner,
            site_id,
            slug,
            title,
            "Created-at tie marker.",
        )
        .await;
        set_listpages_test_created_at(&runner, site_id, slug, tied_created_at).await;
    }

    let source_older_id = listpages_test_page_id(&runner, site_id, SOURCE_OLDER).await;
    let source_newer_id = listpages_test_page_id(&runner, site_id, SOURCE_NEWER).await;
    let source_middle_id = listpages_test_page_id(&runner, site_id, SOURCE_MIDDLE).await;
    create_listpages_test_import_run(&runner, site_id, IMPORT_RUN_ID, 3).await;
    for fixture in [
        (source_older_id, SOURCE_OLDER, 611, "Created At Tie Author"),
        (source_newer_id, SOURCE_NEWER, 612, "Created At Tie Author"),
        (
            source_middle_id,
            SOURCE_MIDDLE,
            613,
            "Created At Tie Author",
        ),
    ] {
        mark_imported_page_with_author_snapshot(&runner, site_id, IMPORT_RUN_ID, fixture)
            .await;
    }
    let transaction = runner.context().transaction();
    for (page_id, source_page_id) in [
        (source_older_id, 100_i64),
        (source_middle_id, 200_i64),
        (source_newer_id, 300_i64),
    ] {
        transaction
            .execute_raw(Statement::from_sql_and_values(
                transaction.get_database_backend(),
                "UPDATE wikidot_page_snapshot \
                 SET meta_json = jsonb_build_object('page_id', $1::text) \
                 WHERE page_id = $2",
                [Value::from(source_page_id), Value::from(page_id)],
            ))
            .await
            .expect("created-at tie fixture should receive a source page ID");
    }

    let fixture_slugs = [
        Cow::Borrowed(SOURCE_OLDER),
        Cow::Borrowed(SOURCE_MIDDLE),
        Cow::Borrowed(SOURCE_NEWER),
    ];
    let mut query = PageQuery {
        current_page_id: 0,
        current_site_id: site_id,
        queried_site_id: Some(site_id),
        page_type: PageTypeSelector::All,
        categories: CategoriesSelector {
            included_categories: IncludedCategories::All,
            excluded_categories: &[],
        },
        tags: TagCondition {
            any_present: &[],
            all_present: &[],
            none_present: &[],
            untagged: false,
        },
        page_parent: PageParentSelector::All,
        contains_outgoing_links: &[],
        creation_date: DateSelector::FromPresent {
            start: OffsetDateTime::UNIX_EPOCH,
        },
        update_date: DateSelector::FromPresent {
            start: OffsetDateTime::UNIX_EPOCH,
        },
        author: AuthorSelector::All,
        score: &[],
        votes: &[],
        offset: 0,
        range: RangeSelector::Current,
        name: None,
        slug: None,
        slugs: &fixture_slugs,
        data_form_fields: &[],
        order: Some(OrderBySelector {
            property: OrderProperty::CreatedAt,
            ascending: true,
        }),
        candidate_limit: None,
        pagination: PaginationSelector {
            limit: Some(10),
            ..Default::default()
        },
        variables: &[],
        fields: FoundPageFields {
            slug: true,
            ..Default::default()
        },
    };

    let ordered_slugs = |pages: deepwell::services::page_query::FoundPages| {
        pages
            .pages
            .into_iter()
            .map(|row| row.slug.expect("slug field should be requested"))
            .collect::<Vec<_>>()
    };
    let ascending = PageQueryService::find(runner.context(), query.clone())
        .await
        .expect("ascending created-at tie query should succeed");
    assert_eq!(
        ordered_slugs(ascending),
        [SOURCE_OLDER, SOURCE_MIDDLE, SOURCE_NEWER],
        "equal creation timestamps should follow Wikidot source identity",
    );

    query.order = Some(OrderBySelector {
        property: OrderProperty::CreatedAt,
        ascending: false,
    });
    let descending = PageQueryService::find(runner.context(), query.clone())
        .await
        .expect("descending created-at tie query should succeed");
    assert_eq!(
        ordered_slugs(descending),
        [SOURCE_NEWER, SOURCE_MIDDLE, SOURCE_OLDER],
        "descending creation order should reverse the source-identity tie-break",
    );

    for slug in [SOURCE_OLDER, SOURCE_MIDDLE, SOURCE_NEWER] {
        set_listpages_test_updated_at(&runner, site_id, slug, tied_created_at).await;
    }
    query.order = Some(OrderBySelector {
        property: OrderProperty::UpdatedAt,
        ascending: true,
    });
    let ascending = PageQueryService::find(runner.context(), query.clone())
        .await
        .expect("ascending updated-at tie query should succeed");
    assert_eq!(
        ordered_slugs(ascending),
        [SOURCE_OLDER, SOURCE_MIDDLE, SOURCE_NEWER],
        "equal update timestamps should follow Wikidot source identity",
    );

    query.order = Some(OrderBySelector {
        property: OrderProperty::UpdatedAt,
        ascending: false,
    });
    let descending = PageQueryService::find(runner.context(), query.clone())
        .await
        .expect("descending updated-at tie query should succeed");
    assert_eq!(
        ordered_slugs(descending),
        [SOURCE_NEWER, SOURCE_MIDDLE, SOURCE_OLDER],
        "descending update order should reverse the source-identity tie-break",
    );

    query.order = Some(OrderBySelector {
        property: OrderProperty::Size,
        ascending: true,
    });
    let ascending = PageQueryService::find(runner.context(), query.clone())
        .await
        .expect("ascending size tie query should succeed");
    assert_eq!(
        ordered_slugs(ascending),
        [SOURCE_OLDER, SOURCE_MIDDLE, SOURCE_NEWER],
        "equal page sizes should follow Wikidot source identity",
    );

    query.order = Some(OrderBySelector {
        property: OrderProperty::Size,
        ascending: false,
    });
    let descending = PageQueryService::find(runner.context(), query)
        .await
        .expect("descending size tie query should succeed");
    assert_eq!(
        ordered_slugs(descending),
        [SOURCE_NEWER, SOURCE_MIDDLE, SOURCE_OLDER],
        "descending size order should reverse the source-identity tie-break",
    );
}

#[tokio::test]
async fn page_query_created_by_uses_earliest_available_revision() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let tag = "verification-page-query-created-by-earliest";
    let slug = "fixture-page-query-created-by-earliest";

    let revision_id = create_listpages_test_page(
        &mut runner,
        site_id,
        slug,
        "Fixture PageQuery CreatedBy Earliest",
        "Fixture PageQuery CreatedBy Earliest marker.",
    )
    .await;
    set_listpages_test_revision_number(&runner, revision_id, 42).await;
    set_listpages_test_tags(&mut runner, site_id, slug, revision_id, &[tag]).await;

    let all_tags = [Cow::Borrowed(tag)];
    let pages = PageQueryService::find(
        runner.context(),
        PageQuery {
            current_page_id: 0,
            current_site_id: site_id,
            queried_site_id: Some(site_id),
            page_type: PageTypeSelector::All,
            categories: CategoriesSelector {
                included_categories: IncludedCategories::All,
                excluded_categories: &[],
            },
            tags: TagCondition {
                any_present: &[],
                all_present: &all_tags,
                none_present: &[],
                untagged: false,
            },
            page_parent: PageParentSelector::All,
            contains_outgoing_links: &[],
            creation_date: DateSelector::FromPresent {
                start: OffsetDateTime::UNIX_EPOCH,
            },
            update_date: DateSelector::FromPresent {
                start: OffsetDateTime::UNIX_EPOCH,
            },
            author: AuthorSelector::All,
            score: &[],
            votes: &[],
            offset: 0,
            range: RangeSelector::Current,
            name: None,
            slug: None,
            slugs: &[],
            data_form_fields: &[],
            order: Some(OrderBySelector {
                property: OrderProperty::PageSlug,
                ascending: true,
            }),
            candidate_limit: None,
            pagination: PaginationSelector {
                limit: Some(10),
                ..Default::default()
            },
            variables: &[],
            fields: FoundPageFields {
                slug: true,
                created_by: true,
                ..Default::default()
            },
        },
    )
    .await
    .expect("created_by query should not fail");

    let page = pages
        .pages
        .iter()
        .find(|page| page.slug.as_deref() == Some(slug))
        .expect("created_by query should include the fixture page");
    assert_eq!(
        page.created_by,
        Some(ADMIN_USER_ID),
        "created_by should come from the earliest available revision, even when it is not revision 0",
    );

    let author_filter = [ADMIN_USER_ID];
    let filtered_pages = PageQueryService::find(
        runner.context(),
        PageQuery {
            current_page_id: 0,
            current_site_id: site_id,
            queried_site_id: Some(site_id),
            page_type: PageTypeSelector::All,
            categories: CategoriesSelector {
                included_categories: IncludedCategories::All,
                excluded_categories: &[],
            },
            tags: TagCondition {
                any_present: &[],
                all_present: &all_tags,
                none_present: &[],
                untagged: false,
            },
            page_parent: PageParentSelector::All,
            contains_outgoing_links: &[],
            creation_date: DateSelector::FromPresent {
                start: OffsetDateTime::UNIX_EPOCH,
            },
            update_date: DateSelector::FromPresent {
                start: OffsetDateTime::UNIX_EPOCH,
            },
            author: AuthorSelector::Any {
                user_ids: &author_filter,
                wikidot_snapshot_names: &[],
            },
            score: &[],
            votes: &[],
            offset: 0,
            range: RangeSelector::Current,
            name: None,
            slug: None,
            slugs: &[],
            data_form_fields: &[],
            order: Some(OrderBySelector {
                property: OrderProperty::PageSlug,
                ascending: true,
            }),
            candidate_limit: None,
            pagination: PaginationSelector {
                limit: Some(10),
                ..Default::default()
            },
            variables: &[],
            fields: FoundPageFields {
                slug: true,
                created_by: true,
                ..Default::default()
            },
        },
    )
    .await
    .expect("author-filtered query should not fail");
    assert!(
        filtered_pages
            .pages
            .iter()
            .any(|page| page.slug.as_deref() == Some(slug)),
        "author filter should use the same earliest-available revision semantics as created_by",
    );
}

#[tokio::test]
async fn page_query_score_order_returns_results() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let tag = "verification-page-score-order";

    for (slug, title, vote) in [
        ("fixture-score-order-high", "Score Order High", 5),
        ("fixture-score-order-low", "Score Order Low", -2),
        ("fixture-score-order-zero", "Score Order Zero", 0),
    ] {
        set_mutation_request_context(
            &mut runner,
            ADMIN_USER_ID,
            site_id,
            Reference::Slug(Cow::Borrowed(slug)),
        );
        let output = run_endpoint!(
            runner,
            page_create,
            json!({
                "site_id": site_id,
                "wikitext": "Score order marker.",
                "title": title,
                "alt_title": null,
                "slug": slug,
                "layout": "wikidot",
                "revision_comments": "create score order test page",
                "user_id": ADMIN_USER_ID,
                "ip_address": common::IP_ADDRESS,
            }),
        );
        set_listpages_test_tags(&mut runner, site_id, slug, output.revision_id, &[tag])
            .await;
        if vote != 0 {
            set_stored_point_vote(&runner, output.page_id, vote).await;
        }
    }

    let all_tags = [Cow::Borrowed(tag)];
    let base_query = PageQuery {
        current_page_id: 0,
        current_site_id: site_id,
        queried_site_id: Some(site_id),
        page_type: PageTypeSelector::All,
        categories: CategoriesSelector {
            included_categories: IncludedCategories::All,
            excluded_categories: &[],
        },
        tags: TagCondition {
            any_present: &[],
            all_present: &all_tags,
            none_present: &[],
            untagged: false,
        },
        page_parent: PageParentSelector::NoParent,
        contains_outgoing_links: &[],
        creation_date: DateSelector::FromPresent {
            start: OffsetDateTime::UNIX_EPOCH,
        },
        update_date: DateSelector::FromPresent {
            start: OffsetDateTime::UNIX_EPOCH,
        },
        author: AuthorSelector::All,
        score: &[],
        votes: &[],
        offset: 0,
        range: RangeSelector::Current,
        name: None,
        slug: None,
        slugs: &[],
        data_form_fields: &[],
        order: Some(OrderBySelector {
            property: OrderProperty::Score,
            ascending: true,
        }),
        candidate_limit: None,
        pagination: PaginationSelector::default(),
        variables: &[],
        fields: FoundPageFields {
            slug: true,
            score: true,
            ..Default::default()
        },
    };

    let pages = PageQueryService::find(runner.context(), base_query.clone())
        .await
        .expect("score ordering should not fail");

    let error = PageQueryService::find_with_hard_candidate_limit(
        runner.context(),
        base_query.clone(),
        2,
    )
    .await
    .expect_err("a hard candidate cap must fail closed before score aggregation");
    assert_contains_error!(error, ErrorType::PageQuery);

    let ordered = pages
        .pages
        .into_iter()
        .map(|row| {
            (
                row.slug.expect("slug field should be requested"),
                row.score.expect("score field should be requested"),
            )
        })
        .collect::<Vec<_>>();

    assert_eq!(
        ordered,
        [
            ("fixture-score-order-low".to_owned(), -2.0),
            ("fixture-score-order-zero".to_owned(), 0.0),
            ("fixture-score-order-high".to_owned(), 5.0),
        ],
        "score order query should return pages sorted by computed score",
    );

    let mut limited_query = base_query.clone();
    limited_query.pagination.limit = Some(2);
    let limited_pages = PageQueryService::find(runner.context(), limited_query)
        .await
        .expect("limited score ordering should not fail");

    let limited_ordered = limited_pages
        .pages
        .into_iter()
        .map(|row| {
            (
                row.slug.expect("slug field should be requested"),
                row.score.expect("score field should be requested"),
            )
        })
        .collect::<Vec<_>>();

    assert_eq!(
        limited_ordered,
        [
            ("fixture-score-order-low".to_owned(), -2.0),
            ("fixture-score-order-zero".to_owned(), 0.0),
        ],
        "limited score order should truncate after computed-score sorting",
    );

    let mut offset_query = base_query;
    offset_query.offset = 1;
    offset_query.pagination.limit = Some(1);
    let offset_pages = PageQueryService::find(runner.context(), offset_query)
        .await
        .expect("offset score ordering should not fail");
    let offset_ordered = offset_pages
        .pages
        .into_iter()
        .map(|row| {
            (
                row.slug.expect("slug field should be requested"),
                row.score.expect("score field should be requested"),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        offset_ordered,
        [("fixture-score-order-zero".to_owned(), 0.0)],
        "score order should apply offset after computed-score sorting",
    );
}

#[tokio::test]
async fn page_query_vote_filter_and_order_use_imported_snapshot_vote_counts() {
    const IMPORT_RUN_ID: i64 = 7_130_559;
    const ZERO: &str = "fixture-vote-filter-zero";
    const LOCAL_TWO: &str = "fixture-vote-filter-local-two";
    const IMPORTED: &str = "fixture-vote-filter-imported";
    const LEGACY_IMPORTED: &str = "fixture-vote-filter-legacy-imported";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;

    for (slug, title) in [
        (ZERO, "Vote Filter Zero"),
        (LOCAL_TWO, "Vote Filter Local Two"),
        (IMPORTED, "Vote Filter Imported"),
        (LEGACY_IMPORTED, "Vote Filter Legacy Imported"),
    ] {
        create_listpages_test_page(
            &mut runner,
            site_id,
            slug,
            title,
            "Vote filter fixture.",
        )
        .await;
    }

    let zero_id = listpages_test_page_id(&runner, site_id, ZERO).await;
    let local_two_id = listpages_test_page_id(&runner, site_id, LOCAL_TWO).await;
    let imported_id = listpages_test_page_id(&runner, site_id, IMPORTED).await;
    let legacy_imported_id =
        listpages_test_page_id(&runner, site_id, LEGACY_IMPORTED).await;

    let transaction = runner.context().transaction();
    transaction
        .execute_raw(Statement::from_sql_and_values(
            transaction.get_database_backend(),
            "INSERT INTO page_vote (from_wikidot, page_id, user_id, value) VALUES \
             (false, $1, $2, 1), \
             (false, $1, $3, -1), \
             (false, $4, $2, 1), \
             (true, $4, $3, 1), \
             (true, $5, $2, 1)",
            [
                Value::from(local_two_id),
                Value::from(ADMIN_USER_ID),
                Value::from(SAMPLE_USER_ID),
                Value::from(imported_id),
                Value::from(legacy_imported_id),
            ],
        ))
        .await
        .expect("vote-count fixtures should be inserted");
    transaction
        .execute_raw(Statement::from_sql_and_values(
            transaction.get_database_backend(),
            "INSERT INTO page_vote (from_wikidot, page_id, user_id, value, deleted_at, disabled_at, disabled_by) VALUES \
             (false, $1, $2, 1, NOW(), NULL, NULL), \
             (false, $1, $3, 1, NULL, NOW(), $4)",
            [
                Value::from(imported_id),
                Value::from(UNKNOWN_USER_ID),
                Value::from(SYSTEM_USER_ID),
                Value::from(ADMIN_USER_ID),
            ],
        ))
        .await
        .expect("inactive vote-count fixtures should be inserted");

    create_listpages_test_import_run(&runner, site_id, IMPORT_RUN_ID, 1).await;
    mark_imported_page_with_author_snapshot(
        &runner,
        site_id,
        IMPORT_RUN_ID,
        (imported_id, IMPORTED, 560, "Imported Vote Author"),
    )
    .await;
    transaction
        .execute_raw(Statement::from_sql_and_values(
            transaction.get_database_backend(),
            "UPDATE wikidot_page_snapshot SET meta_json = jsonb_build_object('votes_count', '7') WHERE page_id = $1",
            [Value::from(imported_id)],
        ))
        .await
        .expect("imported vote-count fixture should receive snapshot votes");

    assert_eq!(
        PageQueryService::effective_vote_count(runner.context(), zero_id)
            .await
            .expect("zero vote count should load"),
        0,
    );
    assert_eq!(
        PageQueryService::effective_vote_count(runner.context(), imported_id)
            .await
            .expect("imported vote count should load"),
        8,
        "snapshot votes_count should combine with active local non-Wikidot votes only",
    );

    let fixture_slugs = [
        Cow::Borrowed(ZERO),
        Cow::Borrowed(LOCAL_TWO),
        Cow::Borrowed(IMPORTED),
        Cow::Borrowed(LEGACY_IMPORTED),
    ];
    let base_query = PageQuery {
        current_page_id: 0,
        current_site_id: site_id,
        queried_site_id: Some(site_id),
        page_type: PageTypeSelector::All,
        categories: CategoriesSelector {
            included_categories: IncludedCategories::All,
            excluded_categories: &[],
        },
        tags: TagCondition {
            any_present: &[],
            all_present: &[],
            none_present: &[],
            untagged: false,
        },
        page_parent: PageParentSelector::All,
        contains_outgoing_links: &[],
        creation_date: DateSelector::FromPresent {
            start: OffsetDateTime::UNIX_EPOCH,
        },
        update_date: DateSelector::FromPresent {
            start: OffsetDateTime::UNIX_EPOCH,
        },
        author: AuthorSelector::All,
        score: &[],
        votes: &[],
        offset: 0,
        range: RangeSelector::Current,
        name: None,
        slug: None,
        slugs: &fixture_slugs,
        data_form_fields: &[],
        order: Some(OrderBySelector {
            property: OrderProperty::PageSlug,
            ascending: true,
        }),
        candidate_limit: None,
        pagination: PaginationSelector {
            limit: Some(20),
            ..Default::default()
        },
        variables: &[],
        fields: FoundPageFields {
            slug: true,
            ..Default::default()
        },
    };

    let selector = [ScoreSelector {
        score: QueryScoreValue::Integer(1),
        comparison: ComparisonOperation::GreaterThan,
    }];
    let mut filtered_query = base_query.clone();
    filtered_query.votes = &selector;
    let filtered = PageQueryService::find(runner.context(), filtered_query)
        .await
        .expect("vote-count filter should not fail")
        .pages
        .into_iter()
        .map(|row| row.slug.expect("slug field should be requested"))
        .collect::<Vec<_>>();
    assert_eq!(filtered, [IMPORTED.to_owned(), LOCAL_TWO.to_owned()]);

    let mut ordered_query = base_query;
    ordered_query.order = Some(OrderBySelector {
        property: OrderProperty::Votes,
        ascending: false,
    });
    let ordered = PageQueryService::find(runner.context(), ordered_query)
        .await
        .expect("vote-count order should not fail")
        .pages
        .into_iter()
        .map(|row| row.slug.expect("slug field should be requested"))
        .collect::<Vec<_>>();
    assert_eq!(
        ordered,
        [
            IMPORTED.to_owned(),
            LOCAL_TWO.to_owned(),
            LEGACY_IMPORTED.to_owned(),
            ZERO.to_owned(),
        ],
    );
}

#[tokio::test]
async fn page_query_vote_count_falls_back_to_imported_roster_without_snapshot_votes_count()
 {
    const IMPORT_RUN_ID: i64 = 7_130_778;
    const ROSTER: &str = "fixture-vote-fallback-roster";
    const MIXED: &str = "fixture-vote-fallback-mixed";
    const KEYED: &str = "fixture-vote-fallback-keyed";

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;

    for (slug, title) in [
        (ROSTER, "Vote Fallback Roster"),
        (MIXED, "Vote Fallback Mixed"),
        (KEYED, "Vote Fallback Keyed"),
    ] {
        create_listpages_test_page(
            &mut runner,
            site_id,
            slug,
            title,
            "Vote count fallback fixture.",
        )
        .await;
    }

    let roster_id = listpages_test_page_id(&runner, site_id, ROSTER).await;
    let mixed_id = listpages_test_page_id(&runner, site_id, MIXED).await;
    let keyed_id = listpages_test_page_id(&runner, site_id, KEYED).await;

    // Roster page: four active imported votes (+1, +1, +1, -1; sum +2, the
    // imported baseline). Mixed page: two imported votes (+1, +1; the
    // baseline) plus two local votes (+1, -1). Keyed page: two imported
    // votes and one local vote, with a snapshot votes_count figure of 7.
    let transaction = runner.context().transaction();
    transaction
        .execute_raw(Statement::from_sql_and_values(
            transaction.get_database_backend(),
            "INSERT INTO page_vote (from_wikidot, page_id, user_id, value) VALUES \
             (true, $1, $4, 1), \
             (true, $1, $5, 1), \
             (true, $1, $6, 1), \
             (true, $1, $7, -1), \
             (true, $2, $4, 1), \
             (true, $2, $5, 1), \
             (false, $2, $6, 1), \
             (false, $2, $7, -1), \
             (true, $3, $4, 1), \
             (true, $3, $5, 1), \
             (false, $3, $6, 1)",
            [
                Value::from(roster_id),
                Value::from(mixed_id),
                Value::from(keyed_id),
                Value::from(ADMIN_USER_ID),
                Value::from(SAMPLE_USER_ID),
                Value::from(SYSTEM_USER_ID),
                Value::from(UNKNOWN_USER_ID),
            ],
        ))
        .await
        .expect("vote-count fallback fixtures should be inserted");

    create_listpages_test_import_run(&runner, site_id, IMPORT_RUN_ID, 1).await;
    for (page_id, slug, suffix) in [
        (roster_id, ROSTER, 7_130_901),
        (mixed_id, MIXED, 7_130_902),
        (keyed_id, KEYED, 7_130_903),
    ] {
        mark_imported_page_with_author_snapshot(
            &runner,
            site_id,
            IMPORT_RUN_ID,
            (page_id, slug, suffix, "Imported Vote Author"),
        )
        .await;
    }
    // Every snapshot's imported baseline is the imported roster sum (+2).
    // Only the keyed page's snapshot carries a votes_count meta figure;
    // the other two keep the helper's empty meta, the shape the corpus
    // import actually writes.
    transaction
        .execute_raw(Statement::from_sql_and_values(
            transaction.get_database_backend(),
            "UPDATE wikidot_page_snapshot SET imported_rating = 2 WHERE page_id IN ($1, $2, $3)",
            [
                Value::from(roster_id),
                Value::from(mixed_id),
                Value::from(keyed_id),
            ],
        ))
        .await
        .expect("vote-count fallback baselines should be set");
    transaction
        .execute_raw(Statement::from_sql_and_values(
            transaction.get_database_backend(),
            "UPDATE wikidot_page_snapshot SET meta_json = jsonb_build_object('votes_count', '7') WHERE page_id = $1",
            [Value::from(keyed_id)],
        ))
        .await
        .expect("keyed vote-count fixture should receive snapshot votes");

    assert_eq!(
        PageQueryService::effective_vote_count(runner.context(), roster_id)
            .await
            .expect("roster vote count should load"),
        4,
        "a snapshot without votes_count must fall back to the imported vote roster",
    );
    assert_eq!(
        PageQueryService::effective_vote_count(runner.context(), mixed_id)
            .await
            .expect("mixed vote count should load"),
        4,
        "the roster fallback must combine imported rows with local votes",
    );
    assert_eq!(
        PageQueryService::effective_vote_count(runner.context(), keyed_id)
            .await
            .expect("keyed vote count should load"),
        8,
        "a present votes_count figure must keep combining with local votes only",
    );
}

#[tokio::test]
async fn page_query_data_form_field_ordering_uses_static_form_values() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let tag = "verification-page-query-data-form-order";

    for (slug, mainword, albums) in [
        ("fixture-data-form-order-beta", "beta", "2"),
        ("fixture-data-form-order-alpha", "alpha", "10"),
        ("fixture-data-form-order-gamma", "gamma", "1"),
    ] {
        let revision = create_listpages_test_page(
            &mut runner,
            site_id,
            slug,
            slug,
            &format!(
                "mainword: {mainword}\nalbums: {albums}\n\nData form order fixture.",
            ),
        )
        .await;
        set_listpages_test_tags(&mut runner, site_id, slug, revision, &[tag]).await;
    }

    let all_tags = [Cow::Borrowed(tag)];
    let base_query = PageQuery {
        current_page_id: 0,
        current_site_id: site_id,
        queried_site_id: Some(site_id),
        page_type: PageTypeSelector::All,
        categories: CategoriesSelector {
            included_categories: IncludedCategories::All,
            excluded_categories: &[],
        },
        tags: TagCondition {
            any_present: &[],
            all_present: &all_tags,
            none_present: &[],
            untagged: false,
        },
        page_parent: PageParentSelector::All,
        contains_outgoing_links: &[],
        creation_date: DateSelector::FromPresent {
            start: OffsetDateTime::UNIX_EPOCH,
        },
        update_date: DateSelector::FromPresent {
            start: OffsetDateTime::UNIX_EPOCH,
        },
        author: AuthorSelector::All,
        score: &[],
        votes: &[],
        offset: 0,
        range: RangeSelector::Current,
        name: None,
        slug: None,
        slugs: &[],
        data_form_fields: &[],
        order: Some(OrderBySelector {
            property: OrderProperty::DataFormFieldName {
                field: Cow::Borrowed("mainword"),
                numeric: false,
            },
            ascending: true,
        }),
        candidate_limit: None,
        pagination: PaginationSelector {
            limit: Some(20),
            ..Default::default()
        },
        variables: &[],
        fields: FoundPageFields {
            slug: true,
            ..Default::default()
        },
    };

    let ordered = PageQueryService::find(runner.context(), base_query.clone())
        .await
        .expect("data-form string ordering should not fail")
        .pages
        .into_iter()
        .map(|row| row.slug.expect("slug field should be requested"))
        .collect::<Vec<_>>();
    assert_eq!(
        ordered,
        [
            "fixture-data-form-order-alpha",
            "fixture-data-form-order-beta",
            "fixture-data-form-order-gamma",
        ],
    );

    let mut integer_order_query = base_query;
    integer_order_query.order = Some(OrderBySelector {
        property: OrderProperty::DataFormFieldName {
            field: Cow::Borrowed("albums"),
            numeric: true,
        },
        ascending: false,
    });
    let ordered = PageQueryService::find(runner.context(), integer_order_query)
        .await
        .expect("data-form integer ordering should not fail")
        .pages
        .into_iter()
        .map(|row| row.slug.expect("slug field should be requested"))
        .collect::<Vec<_>>();
    assert_eq!(
        ordered,
        [
            "fixture-data-form-order-alpha",
            "fixture-data-form-order-beta",
            "fixture-data-form-order-gamma",
        ],
    );
}

#[tokio::test]
async fn page_query_score_filter_plans_preserve_imported_and_local_vote_semantics() {
    const IMPORT_RUN_ID: i64 = 7_130_558;
    const PREFIX: &str = "fixture-score-filter-plan";
    const HIGH: &str = "fixture-score-filter-plan-high";
    const ZERO: &str = "fixture-score-filter-plan-zero";
    const LOW: &str = "fixture-score-filter-plan-low";
    const IMPORTED: &str = "fixture-score-filter-plan-imported";
    const LARGE_INTEGER: &str = "fixture-score-filter-plan-large-integer";
    const INACTIVE_VOTES: &str = "fixture-score-filter-plan-inactive-votes";
    const LEGACY_IMPORTED_VOTE: &str = "fixture-score-filter-plan-legacy-imported-vote";
    const DELETED_PAGE: &str = "fixture-score-filter-plan-soft-deleted";
    const DUMMY_PREFIX: &str = "fixture-score-filter-plan-dummy-";
    const LARGE_INTEGER_SCORE: i64 = 9_007_199_254_740_993;

    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;

    for (slug, title) in [
        (HIGH, "Score Filter Plan High"),
        (ZERO, "Score Filter Plan Zero"),
        (LOW, "Score Filter Plan Low"),
        (IMPORTED, "Score Filter Plan Imported"),
        (LARGE_INTEGER, "Score Filter Plan Large Integer"),
        (INACTIVE_VOTES, "Score Filter Plan Inactive Votes"),
        (LEGACY_IMPORTED_VOTE, "Score Filter Plan Legacy Vote"),
        (DELETED_PAGE, "Score Filter Plan Soft Deleted"),
    ] {
        create_listpages_test_page(
            &mut runner,
            site_id,
            slug,
            title,
            "Score filter plan fixture.",
        )
        .await;
    }

    let high_id = listpages_test_page_id(&runner, site_id, HIGH).await;
    let low_id = listpages_test_page_id(&runner, site_id, LOW).await;
    let imported_id = listpages_test_page_id(&runner, site_id, IMPORTED).await;
    let large_integer_id = listpages_test_page_id(&runner, site_id, LARGE_INTEGER).await;
    let inactive_votes_id =
        listpages_test_page_id(&runner, site_id, INACTIVE_VOTES).await;
    let legacy_imported_vote_id =
        listpages_test_page_id(&runner, site_id, LEGACY_IMPORTED_VOTE).await;
    let deleted_page_id = listpages_test_page_id(&runner, site_id, DELETED_PAGE).await;

    for (page_id, value) in [
        (high_id, 5),
        (low_id, -2),
        (imported_id, 2),
        (inactive_votes_id, 9),
        (deleted_page_id, 20),
    ] {
        set_stored_point_vote(&runner, page_id, value).await;
    }

    create_listpages_test_import_run(&runner, site_id, IMPORT_RUN_ID, 2).await;
    mark_imported_page_with_author_snapshot(
        &runner,
        site_id,
        IMPORT_RUN_ID,
        (imported_id, IMPORTED, 558, "Imported Score Author"),
    )
    .await;
    mark_imported_page_with_author_snapshot(
        &runner,
        site_id,
        IMPORT_RUN_ID,
        (
            large_integer_id,
            LARGE_INTEGER,
            559,
            "Large Integer Score Author",
        ),
    )
    .await;

    let transaction = runner.context().transaction();
    transaction
        .execute_raw(Statement::from_sql_and_values(
            transaction.get_database_backend(),
            "UPDATE wikidot_page_snapshot SET imported_rating = 7 WHERE page_id = $1",
            [Value::from(imported_id)],
        ))
        .await
        .expect("imported score fixture should receive its snapshot rating");
    transaction
        .execute_raw(Statement::from_sql_and_values(
            transaction.get_database_backend(),
            "UPDATE wikidot_page_snapshot SET imported_rating = $1 WHERE page_id = $2",
            [
                Value::from(LARGE_INTEGER_SCORE),
                Value::from(large_integer_id),
            ],
        ))
        .await
        .expect("large integer score fixture should receive its snapshot rating");
    transaction
        .execute_raw(Statement::from_sql_and_values(
            transaction.get_database_backend(),
            "INSERT INTO page_vote (from_wikidot, page_id, user_id, value) VALUES (true, $1, $2, -5), (true, $3, $2, 3)",
            [
                Value::from(imported_id),
                Value::from(SAMPLE_USER_ID),
                Value::from(legacy_imported_vote_id),
            ],
        ))
        .await
        .expect("Wikidot vote fixtures should be inserted");
    transaction
        .execute_raw(Statement::from_sql_and_values(
            transaction.get_database_backend(),
            "INSERT INTO page_vote (page_id, user_id, value, deleted_at, disabled_at, disabled_by) VALUES ($1, $2, -20, NOW(), NULL, NULL), ($1, $3, -20, NULL, NOW(), $4)",
            [
                Value::from(inactive_votes_id),
                Value::from(SAMPLE_USER_ID),
                Value::from(SYSTEM_USER_ID),
                Value::from(ADMIN_USER_ID),
            ],
        ))
        .await
        .expect("inactive score fixtures should be inserted");

    let deleted_page = PageTable::find_by_id(deleted_page_id)
        .one(transaction)
        .await
        .expect("soft-deleted score fixture lookup should succeed")
        .expect("soft-deleted score fixture should exist");
    let mut deleted_page = deleted_page.into_active_model();
    deleted_page.deleted_at = Set(Some(OffsetDateTime::now_utc()));
    deleted_page
        .update(transaction)
        .await
        .expect("score fixture page should be soft-deleted");

    let category_id = PageTable::find_by_id(high_id)
        .one(transaction)
        .await
        .expect("score fixture category lookup should succeed")
        .expect("score fixture page should exist")
        .page_category_id;
    transaction
        .execute_raw(Statement::from_sql_and_values(
            transaction.get_database_backend(),
            "INSERT INTO page (site_id, page_category_id, slug) SELECT $1, $2, $3 || '-' || value FROM generate_series(1, 513) AS value",
            [
                Value::from(site_id),
                Value::from(category_id),
                Value::from(format!("{PREFIX}-dummy")),
            ],
        ))
        .await
        .expect("broad score-plan probe fixtures should be inserted");

    let base_query = PageQuery {
        current_page_id: 0,
        current_site_id: site_id,
        queried_site_id: Some(site_id),
        page_type: PageTypeSelector::All,
        categories: CategoriesSelector {
            included_categories: IncludedCategories::All,
            excluded_categories: &[],
        },
        tags: TagCondition {
            any_present: &[],
            all_present: &[],
            none_present: &[],
            untagged: false,
        },
        page_parent: PageParentSelector::All,
        contains_outgoing_links: &[],
        creation_date: DateSelector::FromPresent {
            start: OffsetDateTime::UNIX_EPOCH,
        },
        update_date: DateSelector::FromPresent {
            start: OffsetDateTime::UNIX_EPOCH,
        },
        author: AuthorSelector::All,
        score: &[],
        votes: &[],
        offset: 0,
        range: RangeSelector::Current,
        name: None,
        slug: None,
        slugs: &[],
        data_form_fields: &[],
        order: Some(OrderBySelector {
            property: OrderProperty::PageSlug,
            ascending: true,
        }),
        candidate_limit: None,
        pagination: PaginationSelector {
            limit: Some(1_000),
            ..PaginationSelector::default()
        },
        variables: &[],
        fields: FoundPageFields {
            slug: true,
            ..FoundPageFields::default()
        },
    };
    let fixture_slugs = [
        Cow::Borrowed(HIGH),
        Cow::Borrowed(ZERO),
        Cow::Borrowed(LOW),
        Cow::Borrowed(IMPORTED),
        Cow::Borrowed(LARGE_INTEGER),
        Cow::Borrowed(INACTIVE_VOTES),
        Cow::Borrowed(LEGACY_IMPORTED_VOTE),
        Cow::Borrowed(DELETED_PAGE),
    ];

    fn selected_slugs(pages: deepwell::services::page_query::FoundPages) -> Vec<String> {
        pages
            .pages
            .into_iter()
            .map(|page| page.slug.expect("score filter query requested slugs"))
            .collect()
    }

    for (threshold, comparison, expected) in [
        (
            0,
            ComparisonOperation::GreaterThan,
            vec![
                HIGH.to_owned(),
                IMPORTED.to_owned(),
                INACTIVE_VOTES.to_owned(),
                LARGE_INTEGER.to_owned(),
                LEGACY_IMPORTED_VOTE.to_owned(),
            ],
        ),
        (0, ComparisonOperation::LessThan, vec![LOW.to_owned()]),
        (
            8,
            ComparisonOperation::GreaterThan,
            vec![
                IMPORTED.to_owned(),
                INACTIVE_VOTES.to_owned(),
                LARGE_INTEGER.to_owned(),
            ],
        ),
        (0, ComparisonOperation::Equal, vec![ZERO.to_owned()]),
    ] {
        let score = [ScoreSelector {
            score: QueryScoreValue::Integer(threshold),
            comparison,
        }];

        let mut correlated_query = base_query.clone();
        correlated_query.score = &score;
        correlated_query.slugs = &fixture_slugs;
        let correlated = PageQueryService::find(runner.context(), correlated_query)
            .await
            .expect("candidate-correlated score filter should succeed");

        let mut site_wide_query = base_query.clone();
        site_wide_query.score = &score;
        site_wide_query.name = Some(Cow::Owned(format!("{PREFIX}-*")));
        let site_wide = PageQueryService::find(runner.context(), site_wide_query)
            .await
            .expect("site-wide score filter should succeed");

        assert_eq!(selected_slugs(correlated), expected);
        assert_eq!(
            selected_slugs(site_wide)
                .into_iter()
                .filter(|slug| !slug.starts_with(DUMMY_PREFIX))
                .collect::<Vec<_>>(),
            expected,
        );
    }

    let bounded_score = [
        ScoreSelector {
            score: QueryScoreValue::Integer(0),
            comparison: ComparisonOperation::GreaterOrEqualThan,
        },
        ScoreSelector {
            score: QueryScoreValue::Integer(5),
            comparison: ComparisonOperation::LessOrEqualThan,
        },
    ];
    let expected_bounded = vec![
        HIGH.to_owned(),
        LEGACY_IMPORTED_VOTE.to_owned(),
        ZERO.to_owned(),
    ];

    let mut correlated_query = base_query.clone();
    correlated_query.score = &bounded_score;
    correlated_query.slugs = &fixture_slugs;
    let correlated = PageQueryService::find(runner.context(), correlated_query)
        .await
        .expect("candidate-correlated repeated score filters should succeed");

    let mut site_wide_query = base_query.clone();
    site_wide_query.score = &bounded_score;
    site_wide_query.name = Some(Cow::Owned(format!("{PREFIX}-*")));
    let site_wide = PageQueryService::find(runner.context(), site_wide_query)
        .await
        .expect("site-wide repeated score filters should succeed");

    assert_eq!(selected_slugs(correlated), expected_bounded);
    assert_eq!(
        selected_slugs(site_wide)
            .into_iter()
            .filter(|slug| !slug.starts_with(DUMMY_PREFIX))
            .collect::<Vec<_>>(),
        expected_bounded,
    );

    for (threshold, expected) in [
        (LARGE_INTEGER_SCORE - 1, Vec::new()),
        (LARGE_INTEGER_SCORE, vec![LARGE_INTEGER.to_owned()]),
    ] {
        let score = [ScoreSelector {
            score: QueryScoreValue::Integer(threshold),
            comparison: ComparisonOperation::Equal,
        }];

        let mut correlated_query = base_query.clone();
        correlated_query.score = &score;
        correlated_query.slugs = &fixture_slugs;
        let correlated = PageQueryService::find(runner.context(), correlated_query)
            .await
            .expect("large integer candidate-correlated score filter should succeed");

        let mut site_wide_query = base_query.clone();
        site_wide_query.score = &score;
        site_wide_query.name = Some(Cow::Owned(format!("{PREFIX}-*")));
        let site_wide = PageQueryService::find(runner.context(), site_wide_query)
            .await
            .expect("large integer site-wide score filter should succeed");

        assert_eq!(selected_slugs(correlated), expected);
        assert_eq!(
            selected_slugs(site_wide)
                .into_iter()
                .filter(|slug| !slug.starts_with(DUMMY_PREFIX))
                .collect::<Vec<_>>(),
            expected,
        );
    }
}

#[tokio::test]
async fn page_query_find_with_metadata_marks_sql_limited_results() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let tag = "verification-page-query-metadata-sql";

    for slug in [
        "fixture-page-query-metadata-sql-a",
        "fixture-page-query-metadata-sql-b",
    ] {
        let revision = create_listpages_test_page(
            &mut runner,
            site_id,
            slug,
            "Fixture PageQuery Metadata SQL",
            "Fixture PageQuery Metadata SQL marker.",
        )
        .await;
        set_listpages_test_tags(&mut runner, site_id, slug, revision, &[tag]).await;
    }

    let all_tags = [Cow::Borrowed(tag)];
    let result = PageQueryService::find_with_metadata(
        runner.context(),
        PageQuery {
            current_page_id: 0,
            current_site_id: site_id,
            queried_site_id: Some(site_id),
            page_type: PageTypeSelector::All,
            categories: CategoriesSelector {
                included_categories: IncludedCategories::All,
                excluded_categories: &[],
            },
            tags: TagCondition {
                any_present: &[],
                all_present: &all_tags,
                none_present: &[],
                untagged: false,
            },
            page_parent: PageParentSelector::All,
            contains_outgoing_links: &[],
            creation_date: DateSelector::FromPresent {
                start: OffsetDateTime::UNIX_EPOCH,
            },
            update_date: DateSelector::FromPresent {
                start: OffsetDateTime::UNIX_EPOCH,
            },
            author: AuthorSelector::All,
            score: &[],
            votes: &[],
            offset: 0,
            range: RangeSelector::Current,
            name: None,
            slug: None,
            slugs: &[],
            data_form_fields: &[],
            order: Some(OrderBySelector {
                property: OrderProperty::PageSlug,
                ascending: true,
            }),
            candidate_limit: None,
            pagination: PaginationSelector {
                limit: Some(1),
                ..Default::default()
            },
            variables: &[],
            fields: FoundPageFields {
                slug: true,
                ..Default::default()
            },
        },
    )
    .await
    .expect("metadata query should not fail");

    assert_eq!(result.pages.total(), 1);
    assert_eq!(result.metadata.candidate_count, Some(1));
    assert!(result.metadata.sql_limit_offset_applied);
    assert!(!result.metadata.filtering_deferred_to_rust);
    assert!(!result.metadata.ordering_deferred_to_rust);
    assert!(!result.metadata.cap_exceeded);
    assert!(result.metadata.exact_count_safe);
}

#[tokio::test]
async fn page_query_find_with_metadata_marks_deferred_score_ordering() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let tag = "verification-page-query-metadata-score";

    for slug in [
        "fixture-page-query-metadata-score-a",
        "fixture-page-query-metadata-score-b",
    ] {
        let revision = create_listpages_test_page(
            &mut runner,
            site_id,
            slug,
            "Fixture PageQuery Metadata Score",
            "Fixture PageQuery Metadata Score marker.",
        )
        .await;
        set_listpages_test_tags(&mut runner, site_id, slug, revision, &[tag]).await;
    }

    let all_tags = [Cow::Borrowed(tag)];
    let result = PageQueryService::find_with_metadata(
        runner.context(),
        PageQuery {
            current_page_id: 0,
            current_site_id: site_id,
            queried_site_id: Some(site_id),
            page_type: PageTypeSelector::All,
            categories: CategoriesSelector {
                included_categories: IncludedCategories::All,
                excluded_categories: &[],
            },
            tags: TagCondition {
                any_present: &[],
                all_present: &all_tags,
                none_present: &[],
                untagged: false,
            },
            page_parent: PageParentSelector::All,
            contains_outgoing_links: &[],
            creation_date: DateSelector::FromPresent {
                start: OffsetDateTime::UNIX_EPOCH,
            },
            update_date: DateSelector::FromPresent {
                start: OffsetDateTime::UNIX_EPOCH,
            },
            author: AuthorSelector::All,
            score: &[],
            votes: &[],
            offset: 0,
            range: RangeSelector::Current,
            name: None,
            slug: None,
            slugs: &[],
            data_form_fields: &[],
            order: Some(OrderBySelector {
                property: OrderProperty::Score,
                ascending: true,
            }),
            candidate_limit: None,
            pagination: PaginationSelector {
                limit: Some(1),
                ..Default::default()
            },
            variables: &[],
            fields: FoundPageFields {
                slug: true,
                score: true,
                ..Default::default()
            },
        },
    )
    .await
    .expect("metadata query should not fail");

    assert_eq!(result.pages.total(), 1);
    assert_eq!(result.metadata.candidate_count, Some(2));
    assert!(!result.metadata.sql_limit_offset_applied);
    assert!(!result.metadata.filtering_deferred_to_rust);
    assert!(result.metadata.ordering_deferred_to_rust);
    assert!(!result.metadata.cap_exceeded);
    assert!(!result.metadata.exact_count_safe);
}

#[tokio::test]
async fn page_query_data_form_candidate_cap_marks_partial_result_incomplete() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let tag = "verification-page-query-data-form-cap";

    for suffix in ["a", "b"] {
        let slug = format!("fixture-page-query-data-form-cap-{suffix}");
        let revision = create_listpages_test_page(
            &mut runner,
            site_id,
            &slug,
            "Fixture PageQuery data form cap",
            "status: wanted\n\nFixture PageQuery data form cap marker.",
        )
        .await;
        set_listpages_test_tags(&mut runner, site_id, &slug, revision, &[tag]).await;
    }

    let all_tags = [Cow::Borrowed(tag)];
    let data_form_fields = [DataFormSelector {
        field: Cow::Borrowed("status"),
        value: Cow::Borrowed("wanted"),
        negated: false,
    }];
    let result = PageQueryService::find_with_metadata(
        runner.context(),
        PageQuery {
            current_page_id: 0,
            current_site_id: site_id,
            queried_site_id: Some(site_id),
            page_type: PageTypeSelector::All,
            categories: CategoriesSelector {
                included_categories: IncludedCategories::All,
                excluded_categories: &[],
            },
            tags: TagCondition {
                any_present: &[],
                all_present: &all_tags,
                none_present: &[],
                untagged: false,
            },
            page_parent: PageParentSelector::All,
            contains_outgoing_links: &[],
            creation_date: DateSelector::FromPresent {
                start: OffsetDateTime::UNIX_EPOCH,
            },
            update_date: DateSelector::FromPresent {
                start: OffsetDateTime::UNIX_EPOCH,
            },
            author: AuthorSelector::All,
            score: &[],
            votes: &[],
            offset: 0,
            range: RangeSelector::Current,
            name: None,
            slug: None,
            slugs: &[],
            data_form_fields: &data_form_fields,
            order: Some(OrderBySelector {
                property: OrderProperty::PageSlug,
                ascending: true,
            }),
            candidate_limit: Some(1),
            pagination: PaginationSelector {
                limit: Some(20),
                ..Default::default()
            },
            variables: &[],
            fields: FoundPageFields {
                slug: true,
                ..Default::default()
            },
        },
    )
    .await
    .expect("capped data form query should return an explicitly incomplete result");

    assert_eq!(result.pages.total(), 1);
    assert_eq!(result.metadata.candidate_count, Some(1));
    assert!(result.metadata.cap_exceeded);
    assert!(result.metadata.filtering_deferred_to_rust);
    assert!(!result.metadata.exact_count_safe);
}

#[tokio::test]
async fn listpages_deferred_forms_remain_unsupported() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");

    // `created_by="-="` used to belong here. It is now supported and evidenced,
    // and `created_by_exclusion_omits_the_containing_pages_author` in
    // tests/list_pages.rs asserts the rendered exclusion instead.
    for (slug_suffix, module_head, body, raw_indicator) in [(
        "unknown-variable",
        r#"tags="+verification-list-negative-unknown-variable" limit="10" order="name""#,
        "* %%unsupported_variable%%",
        "%%unsupported_variable%%",
    )] {
        let slug_prefix = format!("fixture-listpages-negative-{slug_suffix}");
        let tag = format!("verification-list-negative-{slug_suffix}");
        let html = render_listpages_test_fixture(
            &mut runner,
            site.site.site_id,
            &slug_prefix,
            &tag,
            module_head,
            body,
        )
        .await;

        assert!(
            html.contains(raw_indicator)
                || html.contains("[[module ListPages")
                || html.contains("module ListPages"),
            "unsupported ListPages case {slug_suffix} should remain raw/degraded rather than silently accepted:\n{html}"
        );
        assert!(
            !html.contains(&format!(
                "Fixture ListPages Target Alpha :: {slug_prefix}-target-a"
            )),
            "unsupported ListPages case {slug_suffix} must not silently render accepted title/slug rows:\n{html}"
        );
    }
}

#[tokio::test]
async fn excessive_score_selectors_preserve_listpages_and_countpages_modules() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let excessive_selectors = r#" score=">=0""#.repeat(65);
    let forged_marker = "WIKIJUMPWIKIDOTCOMPATTEXTffffffffffffffffffffffffffffffffI0X";
    let target_slug = "fixture-score-selector-cap-target";
    let target_tag = "verification-score-selector-cap";
    let target_revision = create_listpages_test_page(
        &mut runner,
        site_id,
        target_slug,
        "Fixture Score Selector Cap Target",
        "Fixture score selector cap target marker.",
    )
    .await;
    set_listpages_test_tags(
        &mut runner,
        site_id,
        target_slug,
        target_revision,
        &[target_tag],
    )
    .await;

    let list_head = format!(r#"tags="+{target_tag}" limit="20"{excessive_selectors}"#);
    let count_head = format!(r#"tags="+{target_tag}" limit="20"{excessive_selectors}"#);
    let index_slug = "fixture-score-selector-cap-index";
    let index_source = format!(
        "[[module ListPages {list_head}]]\nSCORE_SELECTOR_CAP_LIST=%%slug%% <script>&\"' {forged_marker}\n[[/module]]\n\n[[module CountPages {count_head}]]\nSCORE_SELECTOR_CAP_COUNT=%%total%% <script>&\"' {forged_marker}\n[[/module]]\n\nRAW_MARKER_LITERAL={forged_marker}",
    );
    create_listpages_test_page(
        &mut runner,
        site_id,
        index_slug,
        "Fixture Score Selector Cap Index",
        &index_source,
    )
    .await;
    let page = run_endpoint!(
        runner,
        page_get,
        json!({
            "site_id": site_id,
            "page": index_slug,
            "details": {
                "compiled": true
            },
        }),
    )
    .expect("score selector cap index should exist");
    let html = page
        .compiled_body_html
        .expect("score selector cap index should include compiled HTML");

    assert!(
        html.contains("SCORE_SELECTOR_CAP_LIST=%%slug%%"),
        "ListPages must preserve an excessive score-selector module instead of running a truncated query:\n{html}",
    );
    assert!(
        html.contains("SCORE_SELECTOR_CAP_COUNT=%%total%%"),
        "CountPages must preserve an excessive score-selector module instead of returning a partial count:\n{html}",
    );
    assert!(
        !html.contains(target_slug),
        "capped modules must not query rows:\n{html}"
    );
    assert_eq!(
        html.matches("&lt;script&gt;&amp;&quot;&#39;").count(),
        2,
        "both preserved modules must restore dangerous text only after HTML escaping:\n{html}",
    );
    assert!(
        !html.contains("<script>"),
        "preserved syntax must stay inert:\n{html}"
    );
    assert_eq!(
        html.matches(forged_marker).count(),
        3,
        "authored marker-shaped text must not resolve through the shared registry:\n{html}",
    );
}

#[tokio::test]
async fn countpages_does_not_execute_modules_owned_by_ftml_text_constructs() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let tag = "verification-countpages-ftml-text-owner";
    let target_slug = "fixture-countpages-ftml-text-owner-target";
    let target_revision = create_listpages_test_page(
        &mut runner,
        site_id,
        target_slug,
        "Fixture CountPages FTML Text Owner Target",
        "Fixture CountPages FTML text owner target marker.",
    )
    .await;
    set_listpages_test_tags(&mut runner, site_id, target_slug, target_revision, &[tag])
        .await;

    let hidden_module = |marker: &str| {
        format!(r#"[[module CountPages tags="+{tag}"]]{marker}=%%total%%[[/module]]"#,)
    };
    let owned_markers = [
        "ownedlabelsingle",
        "ownedlabeltriple",
        "ownedlabelanchor",
        "ownedquotedhead",
        "ownedtargetsingle",
        "ownedtargetanchor",
        "ownedtargettriple",
    ];
    let count_only =
        format!(r#"[[module CountPages tags="+{tag}"]]%%total%%[[/module]]"#,);
    let source = format!(
        "[https://e.test/ {} label]\n\n\
         [[[target|{} label]]]\n\n\
         [#toc {} label]\n\n\
         [[span title='{} label']]body[[/span]]\n\n\
         [https://e.test/{} label]\n\n\
         [#toc{} label]\n\n\
         [[[target {} suffix]]]\n\n\
         ##rgb(1,2,{count_only})|owned color body##\n\n\
         [[module CountPages tags=\"+{tag}\"]]ownedlive=%%total%%[[/module]]",
        hidden_module(owned_markers[0]),
        hidden_module(owned_markers[1]),
        hidden_module(owned_markers[2]),
        hidden_module(owned_markers[3]),
        hidden_module(owned_markers[4]),
        hidden_module(owned_markers[5]),
        hidden_module(owned_markers[6]),
    );
    let index_slug = "fixture-countpages-ftml-text-owner-index";
    create_listpages_test_page(
        &mut runner,
        site_id,
        index_slug,
        "Fixture CountPages FTML Text Owner Index",
        &source,
    )
    .await;
    let page = run_endpoint!(
        runner,
        page_get,
        json!({
            "site_id": site_id,
            "page": index_slug,
            "details": {
                "compiled": true
            },
        }),
    )
    .expect("CountPages FTML text owner index should exist");
    let html = page
        .compiled_body_html
        .expect("CountPages FTML text owner index should include compiled HTML");

    assert!(
        html.contains("ownedlive=1"),
        "a CountPages module outside FTML-owned text must still execute:\n{html}",
    );
    for marker in owned_markers {
        assert!(
            html.contains(marker),
            "FTML-owned CountPages source should remain represented in rendered output for {marker}:\n{html}",
        );
        assert!(
            !html.contains(&format!("{marker}=1")),
            "CountPages must not execute inside an FTML-owned text construct for {marker}:\n{html}",
        );
    }
    assert!(
        html.contains("owned color body"),
        "the pinned-valid color construct should render its body:\n{html}",
    );
    assert!(
        !html.contains("rgb(1,2,1)"),
        "CountPages must not execute while FTML owns the color descriptor:\n{html}",
    );
}

#[tokio::test]
async fn countpages_preserves_runtime_unsafe_outer_heads_without_executing_inner_modules()
{
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let tag = "verification-countpages-runtime-unsafe-head";
    let target_slug = "fixture-countpages-runtime-unsafe-head-target";
    let target_revision = create_listpages_test_page(
        &mut runner,
        site_id,
        target_slug,
        "Fixture CountPages Runtime Unsafe Head Target",
        "Fixture CountPages runtime unsafe head target marker.",
    )
    .await;
    set_listpages_test_tags(&mut runner, site_id, target_slug, target_revision, &[tag])
        .await;

    let nested_module = |head: &str, marker: &str| {
        format!(
            "[[module CountPages {head}]]\n\
             {marker}outer=%%total%% <script>&\"'\n\
             [[module CountPages tags=\"+{tag}\"]]{marker}inner=%%total%%[[/module]]\n\
             [[/module]]",
        )
    };
    let cases = [
        (
            "ownedquote",
            nested_module(r#"name = "secret@site.example" wrapper=no"#, "ownedquote"),
        ),
        (
            "embeddedquote",
            nested_module(r#"name = "secret"wrapper="no""#, "embeddedquote"),
        ),
        (
            "escapedquote",
            nested_module(r#"name = "secret\" wrapper=no"#, "escapedquote"),
        ),
        (
            "unicodeseparator",
            nested_module("limit\\\n\u{00a0}=\"1\"", "unicodeseparator"),
        ),
    ];
    let source = format!(
        "{}\n\n{}\n\n{}\n\n{}\n\n\
         [[module CountPages tags=\"+{tag}\"]]nestedlive=%%total%%[[/module]]",
        cases[0].1, cases[1].1, cases[2].1, cases[3].1,
    );
    let index_slug = "fixture-countpages-runtime-unsafe-head-index";
    create_listpages_test_page(
        &mut runner,
        site_id,
        index_slug,
        "Fixture CountPages Runtime Unsafe Head Index",
        &source,
    )
    .await;
    let page = run_endpoint!(
        runner,
        page_get,
        json!({
            "site_id": site_id,
            "page": index_slug,
            "details": {
                "compiled": true
            },
        }),
    )
    .expect("CountPages runtime unsafe head index should exist");
    let html = page
        .compiled_body_html
        .expect("CountPages runtime unsafe head index should include compiled HTML");

    assert!(
        html.contains("nestedlive=1"),
        "an outside CountPages module must still execute:\n{html}",
    );
    for (marker, _) in cases {
        for suffix in ["outer", "inner"] {
            assert!(
                html.contains(&format!("{marker}{suffix}=%%total%%")),
                "the original {marker} {suffix} module text must remain preserved:\n{html}",
            );
            assert!(
                !html.contains(&format!("{marker}{suffix}=1")),
                "neither the runtime-unsafe outer module nor its valid inner module may execute for {marker}:\n{html}",
            );
        }
    }
    assert_eq!(
        html.matches("&lt;script&gt;&amp;&quot;&#39;").count(),
        4,
        "every preserved unsafe outer module must restore authored text only after escaping:\n{html}",
    );
    assert!(
        !html.contains("<script>"),
        "preserved runtime-unsafe module syntax must stay inert:\n{html}",
    );
}

#[tokio::test]
async fn score_selectors_at_limit_render_listpages_normally() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let selectors_at_limit = r#" score=">=0""#.repeat(64);
    let list_tag = "verification-list-score-selector-limit";
    let list_head = format!(r#"tags="+{list_tag}" limit="20"{selectors_at_limit}"#);
    let target_slug = "fixture-list-score-selector-limit-target";
    let target_revision = create_listpages_test_page(
        &mut runner,
        site_id,
        target_slug,
        "Fixture ListPages Score Selector Limit Target",
        "Fixture ListPages score selector limit marker.",
    )
    .await;
    set_listpages_test_tags(
        &mut runner,
        site_id,
        target_slug,
        target_revision,
        &[list_tag],
    )
    .await;
    let index_slug = "fixture-list-score-selector-limit-index";
    create_listpages_test_page(
        &mut runner,
        site_id,
        index_slug,
        "Fixture ListPages Score Selector Limit Index",
        &format!(
            "[[module ListPages {list_head}]]\nSCORE_SELECTOR_LIMIT_LIST=%%slug%%\n[[/module]]"
        ),
    )
    .await;
    let page = run_endpoint!(
        runner,
        page_get,
        json!({
            "site_id": site_id,
            "page": index_slug,
            "details": {
                "compiled": true
            },
        }),
    )
    .expect("ListPages score selector limit index should exist");
    let list_html = page
        .compiled_body_html
        .expect("ListPages score selector limit index should include compiled HTML");
    assert!(
        list_html.contains(&format!("SCORE_SELECTOR_LIMIT_LIST={target_slug}")),
        "ListPages selectors at the limit must still execute normally:\n{list_html}",
    );
}

#[tokio::test]
async fn score_selectors_at_limit_render_countpages_normally() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded SCP Wiki site should exist");
    let site_id = site.site.site_id;
    let selectors_at_limit = r#" score=">=0""#.repeat(64);
    let count_tag = "verification-count-score-selector-limit";
    let count_head = format!(r#"tags="+{count_tag}" limit="20"{selectors_at_limit}"#);
    let target_slug = "fixture-count-score-selector-limit-target";
    let target_revision = create_listpages_test_page(
        &mut runner,
        site_id,
        target_slug,
        "Fixture CountPages Score Selector Limit Target",
        "Fixture CountPages score selector limit marker.",
    )
    .await;
    set_listpages_test_tags(
        &mut runner,
        site_id,
        target_slug,
        target_revision,
        &[count_tag],
    )
    .await;
    let index_slug = "fixture-count-score-selector-limit-index";
    create_listpages_test_page(
        &mut runner,
        site_id,
        index_slug,
        "Fixture CountPages Score Selector Limit Index",
        &format!(
            "[[module CountPages {count_head}]]\nSCORE_SELECTOR_LIMIT_COUNT=%%total%%\n[[/module]]"
        ),
    )
    .await;
    let page = run_endpoint!(
        runner,
        page_get,
        json!({
            "site_id": site_id,
            "page": index_slug,
            "details": {
                "compiled": true
            },
        }),
    )
    .expect("CountPages score selector limit index should exist");
    let count_html = page
        .compiled_body_html
        .expect("CountPages score selector limit index should include compiled HTML");
    assert!(
        count_html.contains("SCORE_SELECTOR_LIMIT_COUNT=1"),
        "CountPages selectors at the limit must still execute normally:\n{count_html}",
    );
}
