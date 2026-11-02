//! Issue #2690: foreign include-source snapshots are storage, not pages.
//!
//! Pages whose snapshot source names a foreign origin must not be served
//! as pages of the holding site (direct routes serve the missing-page
//! response), while own-source snapshots and locally created pages keep
//! resolving.

use super::*;

#[tokio::test]
async fn foreign_include_source_pages_are_not_served_as_site_pages() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("seeded test site should exist")
        .site;
    let tag = cuid();
    let own_slug = format!("own-slug-2690-{tag}");
    let own_branch_slug = format!("own-branch-2690-{tag}");
    let foreign_slug = format!("foreign-2690-{tag}");
    let local_slug = format!("local-2690-{tag}");

    let create = async |runner: &mut TestRunner, slug: &str| {
        set_mutation_request_context(
            runner,
            ADMIN_USER_ID,
            site.site_id,
            Reference::Slug(Cow::Owned(slug.to_owned())),
        );
        run_endpoint!(
            runner,
            page_create,
            json!({
                "site_id": site.site_id,
                "wikitext": "2690 foreign-source fixture",
                "title": slug,
                "alt_title": null,
                "slug": slug,
                "layout": "wikidot",
                "revision_comments": "2690 fixture",
                "user_id": ADMIN_USER_ID,
                "ip_address": common::IP_ADDRESS,
            }),
        )
    };
    let own_slug_page = create(&mut runner, &own_slug).await;
    let own_branch_page = create(&mut runner, &own_branch_slug).await;
    let foreign_page = create(&mut runner, &foreign_slug).await;
    let local_page = create(&mut runner, &local_slug).await;

    let run_id = async |runner: &mut TestRunner, branch: &str, source: &str| {
        runner
            .context()
            .transaction()
            .query_one_raw(Statement::from_string(
                DatabaseBackend::Postgres,
                format!(
                    "INSERT INTO wikidot_corpus_import_run (site_id, source_branch, source_site, manifest_sha256, manifest_row_count, complete_inventory, state, summary) VALUES ({}, '{branch}', '{source}', decode(repeat('00', 32), 'hex'), 1, FALSE, 'done', '{{}}'::jsonb) RETURNING import_run_id",
                    site.site_id,
                ),
            ))
            .await
            .expect("import run fixture should insert")
            .expect("import run should return its ID")
            .try_get::<i64>("", "import_run_id")
            .expect("import run ID should be readable")
    };
    // The site's own branch and a foreign branch both recorded as import
    // runs of this site; the foreign run must not whitelist its site name.
    let own_run_id = run_id(&mut runner, "2690-own-branch", "test").await;
    let foreign_run_id =
        run_id(&mut runner, "2690-foreign-branch", "2690-foreign-site").await;

    let snapshot = async |runner: &mut TestRunner,
                          page_id: i64,
                          branch: &str,
                          source: &str,
                          run: i64| {
        let source_entity_id = uuid::Uuid::new_v4();
        runner
            .context()
            .transaction()
            .execute_raw(Statement::from_string(
                DatabaseBackend::Postgres,
                format!(
                    "INSERT INTO wikidot_page_snapshot (page_id, source_branch, source_site, source_entity_id, source_fullname, source_created_at, source_updated_at, source_revision_count, imported_rating, comments, source_sha256, meta_sha256, meta_json, last_import_run_id) VALUES ({page_id}, '{branch}', '{source}', '{source_entity_id}', '{source}', NOW(), NOW(), 1, 0, 0, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), '{{}}'::jsonb, {run})",
                ),
            ))
            .await
            .expect("snapshot fixture should insert")
    };
    // Own: source names the site slug itself, and the site's own branch.
    snapshot(
        &mut runner,
        own_slug_page.page_id,
        "test",
        "test",
        own_run_id,
    )
    .await;
    snapshot(
        &mut runner,
        own_branch_page.page_id,
        "2690-own-branch",
        "2690-own-branch",
        own_run_id,
    )
    .await;
    // Foreign: a dated one-off branch importing another site.
    snapshot(
        &mut runner,
        foreign_page.page_id,
        "2690-foreign-branch",
        "2690-foreign-site",
        foreign_run_id,
    )
    .await;

    let fetch = async |runner: &mut TestRunner, page_id: i64| {
        run_endpoint!(
            runner,
            page_get,
            json!({
                "site_id": site.site_id,
                "page": page_id,
                "details": {"compiled_html": true},
            }),
        )
    };
    assert!(
        fetch(&mut runner, own_slug_page.page_id).await.is_some(),
        "a snapshot naming the site slug stays served",
    );
    assert!(
        fetch(&mut runner, own_branch_page.page_id).await.is_some(),
        "a snapshot naming the site's own branch stays served",
    );
    assert!(
        fetch(&mut runner, foreign_page.page_id).await.is_none(),
        "a foreign include-source snapshot must serve the missing-page response",
    );
    assert!(
        fetch(&mut runner, local_page.page_id).await.is_some(),
        "a locally created page without a snapshot stays served",
    );
}

#[tokio::test]
async fn nested_includes_of_imported_sources_resolve_on_the_source_site() {
    let mut runner = TestRunner::setup().await;
    let site = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("seeded test site should exist")
        .site;
    let tag = cuid();
    let source_site = "nested-foreign-source";
    let nested_slug = format!("component:nested-target-{tag}");
    let missing_slug = format!("component:nested-missing-{tag}");
    let imported_slug = format!("workbench-nested-{tag}");
    let consumer_slug = format!("nested-consumer-{tag}");

    let create = async |runner: &mut TestRunner, slug: &str, wikitext: &str| {
        set_mutation_request_context(
            runner,
            ADMIN_USER_ID,
            site.site_id,
            Reference::Slug(Cow::Owned(slug.to_owned())),
        );
        run_endpoint!(
            runner,
            page_create,
            json!({
                "site_id": site.site_id,
                "wikitext": wikitext,
                "title": slug,
                "alt_title": null,
                "slug": slug,
                "layout": "wikidot",
                "revision_comments": "nested imported include fixture",
                "user_id": ADMIN_USER_ID,
                "ip_address": common::IP_ADDRESS,
            }),
        )
    };

    let nested_page =
        create(&mut runner, &nested_slug, "Nested imported include marker.").await;
    let imported_page = create(
        &mut runner,
        &imported_slug,
        &format!(
            "Imported source body.\n[[include {nested_slug}]]\n[[include {missing_slug}]]"
        ),
    )
    .await;

    let run_id = runner
        .context()
        .transaction()
        .query_one_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            format!(
                "INSERT INTO wikidot_corpus_import_run (site_id, source_branch, source_site, manifest_sha256, manifest_row_count, complete_inventory, state, summary) VALUES ({}, 'nested-foreign-branch', '{source_site}', decode(repeat('00', 32), 'hex'), 1, FALSE, 'done', '{{}}'::jsonb) RETURNING import_run_id",
                site.site_id,
            ),
        ))
        .await
        .expect("import run fixture should insert")
        .expect("import run should return its ID")
        .try_get::<i64>("", "import_run_id")
        .expect("import run ID should be readable");

    let snapshot = async |runner: &mut TestRunner,
                          page_id: i64,
                          branch: &str,
                          source: &str,
                          fullname: &str,
                          run: i64| {
        let source_entity_id = uuid::Uuid::new_v4();
        runner
            .context()
            .transaction()
            .execute_raw(Statement::from_string(
                DatabaseBackend::Postgres,
                format!(
                    "INSERT INTO wikidot_page_snapshot (page_id, source_branch, source_site, source_entity_id, source_fullname, source_created_at, source_updated_at, source_revision_count, imported_rating, comments, source_sha256, meta_sha256, meta_json, last_import_run_id) VALUES ({page_id}, '{branch}', '{source}', '{source_entity_id}', '{fullname}', NOW(), NOW(), 1, 0, 0, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), '{{}}'::jsonb, {run})",
                ),
            ))
            .await
            .expect("snapshot fixture should insert")
    };
    // Both pages are foreign include-source snapshots of the source site,
    // held as storage on this site (#2690): neither is an ordinary page of
    // this site, so the ordinary page surface excludes both.
    snapshot(
        &mut runner,
        nested_page.page_id,
        "nested-foreign-branch",
        source_site,
        &nested_slug,
        run_id,
    )
    .await;
    snapshot(
        &mut runner,
        imported_page.page_id,
        "nested-foreign-branch",
        source_site,
        &imported_slug,
        run_id,
    )
    .await;

    let consumer = create(
        &mut runner,
        &consumer_slug,
        &format!("[[include :{source_site}:{imported_slug}]]"),
    )
    .await;

    let fetched = run_endpoint!(
        runner,
        page_get,
        json!({
            "site_id": site.site_id,
            "page": consumer.page_id,
            "details": {"compiled": true},
        }),
    )
    .expect("nested include consumer should exist");
    let html = fetched
        .compiled_body_html
        .expect("nested include consumer should have compiled HTML");

    assert!(
        html.contains("Nested imported include marker."),
        "an unprefixed include nested inside an imported source must resolve \
         against the source site snapshot store: {html}",
    );
    assert!(
        !html.contains(&format!(
            "Included page &quot;{nested_slug}&quot; does not exist"
        )),
        "the source-site nested include must not render the missing-page error: {html}",
    );
    assert!(
        html.contains(&format!(
            "Included page &quot;{missing_slug}&quot; does not exist"
        )),
        "a nested include that exists nowhere must keep the standard \
         missing-page error: {html}",
    );
}

// Foreign snapshots are stored at `_foreign:<source_site>:<fullname>`, so
// one fullname can be held from several source sites. Seeds the real
// amoris -> :scp-int:theme:fogwalker -> :scpko:theme:fogwalker closure
// (shared-corpus sources, CC BY-SA) under natural-slug storage and under
// namespaced storage, and compares amoris and ordinary-include probes.

const KO_THEME_CSS_MARKER: &str = "GowunBatang";
const MISSING_FOGWALKER: &str =
    "Included page &quot;theme:fogwalker&quot; does not exist";

/// (fullname, fixture) pages the holding site owns, beyond the seeder's.
const OWN_PAGES: &[(&str, &str)] = &[
    (
        "info:start",
        include_str!("../fixtures/fogwalker-chain/en__info__start.txt"),
    ),
    (
        "info:end",
        include_str!("../fixtures/fogwalker-chain/en__info__end.txt"),
    ),
    (
        "component:croqstyle",
        include_str!("../fixtures/fogwalker-chain/en__component__croqstyle.txt"),
    ),
    (
        "component:earthworm",
        include_str!("../fixtures/fogwalker-chain/en__component__earthworm.txt"),
    ),
];

/// (source branch, source site, fullname, fixture), in the order an import
/// would land them: scp-int first, as on Standing.
const FOREIGN_PAGES: &[(&str, &str, &str, &str)] = &[
    (
        "int",
        "scp-int",
        "theme:fogwalker",
        include_str!("../fixtures/fogwalker-chain/int__theme__fogwalker.txt"),
    ),
    (
        "ko",
        "scpko",
        "theme:fogwalker",
        include_str!("../fixtures/fogwalker-chain/ko__theme__fogwalker.txt"),
    ),
    (
        "ko",
        "scpko",
        "info:start",
        include_str!("../fixtures/fogwalker-chain/ko__info__start.txt"),
    ),
    (
        "ko",
        "scpko",
        "info:end",
        include_str!("../fixtures/fogwalker-chain/ko__info__end.txt"),
    ),
    (
        "ko",
        "scpko",
        "component:image-block",
        include_str!("../fixtures/fogwalker-chain/ko__component__image-block.txt"),
    ),
    (
        "ko",
        "scpko",
        "component:image-block-base",
        include_str!("../fixtures/fogwalker-chain/ko__component__image-block-base.txt"),
    ),
    (
        "ko",
        "scpko",
        "component:fogwalker-proto-attach",
        "[[image proto-relative.png]]",
    ),
];

/// A pre-migration foreign row: stays at its natural slug in both layouts,
/// so the namespaced run also proves a mixed (lazily migrated) store works.
const LEGACY_FOREIGN: (&str, &str, &str, &str) = (
    "int",
    "scp-int",
    "component:fogwalker-proto-legacy",
    "LEGACY-NATURAL-SLUG-FOREIGN-MARKER",
);

const AMORIS: &str = include_str!("../fixtures/fogwalker-chain/en__amoris.txt");
const AMORIS_TAGS: &[&str] = &[
    "_cc",
    "_cc4",
    "_licensebox",
    "bittersweet",
    "illustrated",
    "intcanoncon2025",
    "romance",
    "tale",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Storage {
    Natural,
    Namespaced,
}

fn storage_slug(storage: Storage, source_site: &str, fullname: &str) -> String {
    match storage {
        Storage::Natural => fullname.to_owned(),
        Storage::Namespaced => format!("_foreign:{source_site}:{fullname}"),
    }
}

#[derive(Debug)]
struct Outcome {
    unstorable: Vec<String>,
    amoris_html: String,
    amoris_styles: String,
    probe_scpko_info_start: String,
    regression_probes: Vec<(&'static str, String)>,
    /// (target, page_id served for it, foreign storage page_id).
    direct_visits: Vec<(String, Option<i64>, i64)>,
}

async fn create_page(
    runner: &mut TestRunner,
    site_id: i64,
    slug: &str,
    wikitext: &str,
    tags: &[&str],
) -> i64 {
    set_mutation_request_context(
        runner,
        ADMIN_USER_ID,
        site_id,
        Reference::Slug(Cow::Owned(slug.to_owned())),
    );
    run_endpoint!(
        runner,
        page_create,
        json!({
            "site_id": site_id,
            "wikitext": wikitext,
            "title": slug,
            "alt_title": null,
            "slug": slug,
            "tags": tags,
            "layout": "wikidot",
            "revision_comments": "fogwalker prototype fixture",
            "user_id": ADMIN_USER_ID,
            "ip_address": common::IP_ADDRESS,
        }),
    )
    .page_id
}

async fn sql_i64(runner: &TestRunner, sql: String) -> Option<i64> {
    runner
        .context()
        .transaction()
        .query_one_raw(Statement::from_string(DatabaseBackend::Postgres, sql))
        .await
        .expect("fixture query should run")
        .map(|row| row.try_get_by_index::<i64>(0).expect("i64 column"))
}

async fn import_run(
    runner: &TestRunner,
    site_id: i64,
    branch: &str,
    source: &str,
) -> i64 {
    sql_i64(
        runner,
        format!(
            "INSERT INTO wikidot_corpus_import_run (site_id, source_branch, source_site, manifest_sha256, manifest_row_count, complete_inventory, state, summary) VALUES ({site_id}, '{branch}', '{source}', decode(repeat('00', 32), 'hex'), 1, FALSE, 'done', '{{}}'::jsonb) RETURNING import_run_id",
        ),
    )
    .await
    .expect("import run should return its ID")
}

/// Lands one foreign snapshot the way the corpus applier's DB mode does: a
/// page row at the storage slug plus a snapshot row keyed by provenance.
/// Returns `None` when the storage slug is already taken on the site.
async fn land_foreign(
    runner: &mut TestRunner,
    site_id: i64,
    run_id: i64,
    storage: Storage,
    (branch, source_site, fullname, wikitext): (&str, &str, &str, &str),
) -> Option<i64> {
    let slug = storage_slug(storage, source_site, fullname);
    let taken = sql_i64(
        runner,
        format!(
            "SELECT page_id FROM page WHERE site_id = {site_id} AND slug = '{slug}' AND deleted_at IS NULL",
        ),
    )
    .await;
    if taken.is_some() {
        return None;
    }

    let staging_slug = format!("fogwalker-proto-staging-{}", cuid());
    let page_id = create_page(runner, site_id, &staging_slug, wikitext, &[]).await;
    runner
        .context()
        .transaction()
        .execute_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            format!("UPDATE page SET slug = '{slug}' WHERE page_id = {page_id}"),
        ))
        .await
        .expect("storage slug should be free");
    let entity = uuid::Uuid::new_v4();
    runner
        .context()
        .transaction()
        .execute_raw(Statement::from_string(
            DatabaseBackend::Postgres,
            format!(
                "INSERT INTO wikidot_page_snapshot (page_id, source_branch, source_site, source_entity_id, source_fullname, source_created_at, source_updated_at, source_revision_count, imported_rating, comments, source_sha256, meta_sha256, meta_json, last_import_run_id) VALUES ({page_id}, '{branch}', '{source_site}', '{entity}', '{fullname}', NOW(), NOW(), 1, 0, 0, decode(repeat('00', 32), 'hex'), decode(repeat('00', 32), 'hex'), '{{}}'::jsonb, {run_id})",
            ),
        ))
        .await
        .expect("snapshot row should insert");
    Some(page_id)
}

async fn compiled(
    runner: &mut TestRunner,
    site_id: i64,
    page: serde_json::Value,
) -> Option<(String, String)> {
    run_endpoint!(
        runner,
        page_get,
        json!({
            "site_id": site_id,
            "page": page,
            "details": {"compiled": true},
        }),
    )
    .map(|page| {
        (
            page.compiled_body_html.unwrap_or_default(),
            page.compiled_body_styles.unwrap_or_default().join("\n"),
        )
    })
}

async fn run_layout(storage: Storage) -> Outcome {
    let mut runner = TestRunner::setup().await;
    let site_id = run_endpoint!(runner, site_get, json!({"site": "scp-wiki"}))
        .expect("seeded scp-wiki site should exist")
        .site
        .site_id;
    let other_site_id = run_endpoint!(runner, site_get, json!({"site": "test"}))
        .expect("seeded test site should exist")
        .site
        .site_id;

    for (slug, wikitext) in OWN_PAGES {
        create_page(&mut runner, site_id, slug, wikitext, &[]).await;
    }
    create_page(
        &mut runner,
        other_site_id,
        "fogwalker-proto-xsite",
        "LOCAL-CROSS-SITE-MARKER",
        &[],
    )
    .await;

    let int_run = import_run(&runner, site_id, "int", "scp-int").await;
    let ko_run = import_run(&runner, site_id, "ko", "scpko").await;
    let mut unstorable = Vec::new();
    let mut foreign_ids = Vec::new();
    for page in FOREIGN_PAGES {
        let run = if page.1 == "scpko" { ko_run } else { int_run };
        match land_foreign(&mut runner, site_id, run, storage, *page).await {
            Some(id) => {
                foreign_ids.push((storage_slug(storage, page.1, page.2), page.2, id))
            }
            None => unstorable.push(format!(":{}:{}", page.1, page.2)),
        }
    }
    let legacy = LEGACY_FOREIGN;
    land_foreign(&mut runner, site_id, int_run, Storage::Natural, legacy)
        .await
        .expect("legacy natural-slug row should land");

    let amoris_id =
        create_page(&mut runner, site_id, "amoris", AMORIS, AMORIS_TAGS).await;
    let probes: &[(&'static str, &str)] = &[
        ("same-site own include", "[[include info:start]]"),
        (
            "same-site own component (scpko twin exists)",
            "[[include component:image-block name=x.png]]",
        ),
        (
            "cross-site to a local site",
            "[[include :test:fogwalker-proto-xsite]]",
        ),
        (
            "cross-site imported legacy natural-slug row",
            "[[include :scp-int:component:fogwalker-proto-legacy]]",
        ),
        (
            "cross-site to a site with no snapshot",
            "[[include :scp-int:component:fogwalker-proto-nowhere]]",
        ),
        (
            "cross-site imported source with a relative attachment",
            "[[include :scpko:component:fogwalker-proto-attach]]",
        ),
    ];
    let mut probe_ids = Vec::new();
    for (index, (label, wikitext)) in probes.iter().enumerate() {
        let id = create_page(
            &mut runner,
            site_id,
            &format!("fogwalker-proto-probe-{index}"),
            wikitext,
            &[],
        )
        .await;
        probe_ids.push((*label, id));
    }
    let scpko_probe = create_page(
        &mut runner,
        site_id,
        "fogwalker-proto-probe-scpko",
        "[[include :scpko:info:start]]",
        &[],
    )
    .await;

    let (amoris_html, amoris_styles) = compiled(&mut runner, site_id, json!(amoris_id))
        .await
        .expect("amoris should be served");
    let mut regression_probes = Vec::new();
    for (label, id) in probe_ids {
        let (html, styles) = compiled(&mut runner, site_id, json!(id))
            .await
            .expect("probe served");
        regression_probes.push((label, format!("{html}\n<!--styles-->\n{styles}")));
    }
    let probe_scpko_info_start = compiled(&mut runner, site_id, json!(scpko_probe))
        .await
        .expect("scpko probe served")
        .0;

    let mut direct_visits = Vec::new();
    for (slug, fullname, id) in &foreign_ids {
        for (target, page) in [
            (format!("id {id}"), json!(id)),
            (format!("storage slug {slug}"), json!(slug)),
            (format!("source slug {fullname}"), json!(fullname)),
        ] {
            let served = run_endpoint!(
                runner,
                page_get,
                json!({"site_id": site_id, "page": page, "details": {}}),
            )
            .map(|page| page.page_id);
            direct_visits.push((target, served, *id));
        }
    }

    Outcome {
        unstorable,
        amoris_html,
        amoris_styles,
        probe_scpko_info_start,
        regression_probes,
        direct_visits,
    }
}

#[tokio::test]
async fn namespaced_foreign_snapshots_resolve_the_fogwalker_chain() {
    let natural = run_layout(Storage::Natural).await;
    let namespaced = run_layout(Storage::Namespaced).await;

    for (name, outcome) in [("natural", &natural), ("namespaced", &namespaced)] {
        let errors = outcome.amoris_html.matches("does not exist").count();
        println!("== {name}");
        println!("unstorable foreign rows: {:?}", outcome.unstorable);
        println!("amoris include errors: {errors}");
        println!(
            "amoris ko theme CSS marker in styles: {}",
            outcome.amoris_styles.contains(KO_THEME_CSS_MARKER)
        );
        println!(
            "probe :scpko:info:start => {}",
            outcome.probe_scpko_info_start
        );
        for (target, served, foreign) in &outcome.direct_visits {
            println!(
                "direct visit {target}: served page {served:?} (foreign row {foreign})"
            );
        }
    }

    assert_eq!(
        natural.unstorable,
        [
            ":scpko:theme:fogwalker",
            ":scpko:info:start",
            ":scpko:info:end",
            ":scpko:component:image-block",
            ":scpko:component:image-block-base",
        ],
        "today's layout cannot land the scpko rows that share a slug with an earlier holder",
    );
    assert!(natural.amoris_html.contains(MISSING_FOGWALKER));
    assert!(!natural.amoris_styles.contains(KO_THEME_CSS_MARKER));

    assert!(namespaced.unstorable.is_empty());
    assert!(
        !namespaced.amoris_html.contains("does not exist"),
        "namespaced storage leaves no include error in amoris: {}",
        namespaced.amoris_html,
    );
    assert!(
        namespaced.amoris_styles.contains(KO_THEME_CSS_MARKER),
        "the scpko theme CSS reaches amoris through the scp-int payload",
    );
    assert!(namespaced.probe_scpko_info_start.contains("정보"));
    assert!(!namespaced.probe_scpko_info_start.contains("does not exist"));

    for outcome in [&natural, &namespaced] {
        for (target, served, foreign) in &outcome.direct_visits {
            assert_ne!(
                *served,
                Some(*foreign),
                "{target} must never serve the foreign snapshot row",
            );
            if !target.starts_with("source slug") {
                assert_eq!(
                    *served, None,
                    "{target} must serve the missing-page response"
                );
            }
        }
    }

    for ((label, before), (_, after)) in natural
        .regression_probes
        .iter()
        .zip(&namespaced.regression_probes)
    {
        println!("regression probe [{label}] identical={}", before == after);
        assert_eq!(
            before, after,
            "probe [{label}] must render identically under both layouts"
        );
    }
}
