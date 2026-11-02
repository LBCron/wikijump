//! Regression tests for issue #3461 (finding F2 of the TLA+ re-render
//! lifecycle model): a page's hosted text blocks must always end up matching
//! the page's latest revision, even when renders and saves interleave.
//!
//! Two shapes are exercised, both with real transactions against the
//! integration database (the single-transaction `TestRunner` cannot express
//! commit ordering, so these tests build raw server state and manage their
//! own transactions, like `tests/page.rs`'s page-create concurrency test):
//!
//! * `older_rerender_does_not_overwrite_newer_blocks` — a rerender job that
//!   read revision 1 renders slowly; a save to revision 2 commits in the
//!   meantime; the job then finishes. Its stale blocks must not win.
//! * `overlapping_add_blocks_do_not_abort_the_writer` — two `add_blocks`
//!   calls for the same page overlap so the second one's DELETE blocks
//!   behind the first one's transaction. Once the first commits, the second
//!   must still complete instead of aborting (its INSERT would otherwise
//!   hit the `(block_type, page_id, block_index)` primary key, because its
//!   DELETE statement's snapshot predates the winner's rows).
//!
//! Deferred post-commit actions (S3 cleanups of replaced objects) are not
//! run by these tests; they drop with each test context. That only leaks
//! unreferenced objects in the test bucket and does not affect any
//! assertion, which all read committed rows and live objects.
//!
//! Run serially, like the rest of the stateful suite:
//! `RUST_MIN_STACK=8388608 cargo test --test text_block_rerender_race -- --test-threads 1`

use deepwell::api::{ServerState, build_server_state_without_workers};
use deepwell::config::{Config, Secrets};
use deepwell::constants::ADMIN_USER_ID;
use deepwell::models::page::Entity as PageEntity;
use deepwell::models::site::{self, Entity as SiteEntity};
use deepwell::services::page::{CreatePage, EditPage, EditPageBody, PageService};
use deepwell::services::page_revision::RerenderType;
use deepwell::services::text_block::{MIME_HTML, TextBlock};
use deepwell::services::{PageRevisionService, ServiceContext, TextBlockService};
use deepwell::types::{Maybe, PageId, Reference, RerenderDepth, TextBlockType};
use ftml::layout::Layout;
use sea_orm::{
    ColumnTrait, ConnectionTrait, EntityTrait, QueryFilter, Statement, TransactionTrait,
};
use std::future::Future;
use std::net::{IpAddr, Ipv4Addr};
use std::pin::Pin;
use std::time::Duration;
use tokio::time::sleep;

const IP_ADDRESS: IpAddr = IpAddr::V4(Ipv4Addr::new(127, 0, 0, 10));

fn err_string(error: impl std::fmt::Debug) -> String {
    format!("{error:?}")
}

type CtxFut<'c, T> = Pin<Box<dyn Future<Output = Result<T, String>> + Send + 'c>>;

/// Runs `f` the way the JSONRPC method wrapper in `api.rs` runs a method:
/// one transaction, committed on success and rolled back on error.
///
/// The only deliberate deviation is that drained post-commit actions are
/// dropped instead of run (the drain itself is crate-private); see the
/// module comment for why that cannot affect these tests.
async fn transact<T, F>(state: &ServerState, f: F) -> Result<T, String>
where
    T: Send,
    F: for<'c> FnOnce(&'c ServiceContext<'c>) -> CtxFut<'c, T>,
{
    let txn = state.database.begin().await.map_err(err_string)?;
    let ctx = ServiceContext::new(state, &txn);
    match f(&ctx).await {
        Ok(value) => {
            drop(ctx);
            txn.commit().await.map_err(err_string)?;
            Ok(value)
        }
        Err(error) => {
            drop(ctx);
            let _ = txn.rollback().await;
            Err(error)
        }
    }
}

async fn setup_state() -> ServerState {
    build_server_state_without_workers(Config::integration_testing(), Secrets::load())
        .await
        .expect("test server state should build")
}

async fn seeded_site_id(state: &ServerState) -> i64 {
    SiteEntity::find()
        .filter(site::Column::Slug.eq("test"))
        .one(&state.database)
        .await
        .expect("seeded site query should succeed")
        .expect("seeded test site should exist")
        .site_id
}

struct Fixture {
    page_id: PageId,
    revision_id: i64,
}

/// Creates a page (committed) whose wikitext is `wikitext`, and returns its
/// identifiers. The page is left in the shared test database, under a
/// unique slug, like other stateful fixtures in this suite.
async fn create_fixture_page(state: &ServerState, wikitext: String) -> Fixture {
    create_fixture_page_outcome(state, wikitext)
        .await
        .expect("fixture page should be created")
}

async fn create_fixture_page_outcome(
    state: &ServerState,
    wikitext: String,
) -> Result<Fixture, String> {
    create_fixture_page_with_slug_outcome(
        state,
        format!("f2-race-{}", cuid2::cuid()),
        wikitext,
    )
    .await
}

async fn create_fixture_page_with_slug_outcome(
    state: &ServerState,
    slug: String,
    wikitext: String,
) -> Result<Fixture, String> {
    let site_id = seeded_site_id(state).await;
    let output = transact(state, |ctx| {
        let create = CreatePage {
            site_id,
            wikitext,
            title: String::from("F2 race fixture"),
            alt_title: None,
            tags: Vec::new(),
            slug,
            layout: Some(Layout::Wikidot),
            revision_comments: String::from("F2 race fixture"),
            user_id: ADMIN_USER_ID,
            bypass_filter: true,
            ip_address: IP_ADDRESS,
        };
        Box::pin(
            async move { PageService::create(ctx, create).await.map_err(err_string) },
        )
    })
    .await?;
    let page = PageEntity::find_by_id(output.page_id)
        .one(&state.database)
        .await
        .map_err(err_string)?
        .ok_or_else(|| String::from("fixture page should exist"))?;
    Ok(Fixture {
        page_id: PageId {
            site_id,
            category_id: page.page_category_id,
            page_id: output.page_id,
        },
        revision_id: output.revision_id,
    })
}

/// Reads back the content of the page's first hosted HTML block through
/// the real read path (row lookup, then the S3 object it names).
async fn stored_html_block(state: &ServerState, page_id: i64) -> Option<String> {
    let txn = state.database.begin().await.expect("read txn");
    let ctx = ServiceContext::new(state, &txn);
    let index =
        TextBlockService::get_block_by_index(&ctx, page_id, TextBlockType::Html, 1)
            .await
            .expect("block lookup should succeed")?;
    let response = ctx
        .s3_tblocks_bucket()
        .get_object(&index.s3_filename)
        .await
        .expect("block object should be fetchable");
    assert_eq!(response.status_code(), 200, "block object should exist");
    let data: Vec<u8> = response.into();
    Some(String::from_utf8(data).expect("block content should be UTF-8"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn older_rerender_does_not_overwrite_newer_blocks() {
    let state = setup_state().await;

    // The rerender job must still be working from revision 1's inputs
    // when the small save to revision 2 commits (the F2 interleaving).
    // Revision 1 therefore carries thousands of tiny hosted blocks:
    // persisting them makes the job spend most of its time uploading
    // block objects inside `add_blocks`, long after it read revision 1
    // and well before it can commit, while revision 2 (one block)
    // saves almost immediately.
    let mut wikitext = String::from("[[html]]OLDER-BLOCK-CONTENT[[/html]]\n");
    for _ in 0..4_000 {
        wikitext.push_str("[[html]]filler[[/html]]\n");
    }
    // Creating the fixture uploads thousands of block objects; on a
    // loaded box a single object-store request can time out. Fixture
    // creation is not what is under test, so retry it with a fresh
    // page rather than let infrastructure noise fail the test.
    let mut fixture = None;
    for attempt in 1..=3 {
        match create_fixture_page_outcome(&state, wikitext.clone()).await {
            Ok(created) => {
                fixture = Some(created);
                break;
            }
            Err(error) => eprintln!("fixture creation attempt {attempt} failed: {error}"),
        }
    }
    let fixture = fixture.expect("fixture page should eventually be created");
    let initial_block = stored_html_block(&state, fixture.page_id.page_id).await;
    if initial_block.as_deref() != Some("OLDER-BLOCK-CONTENT") {
        let rows: i64 = state
            .database
            .query_one_raw(Statement::from_string(
                sea_orm::DatabaseBackend::Postgres,
                format!(
                    "SELECT count(*) AS n FROM text_block WHERE page_id = {}",
                    fixture.page_id.page_id,
                ),
            ))
            .await
            .expect("block row count query")
            .expect("block row count row")
            .try_get("", "n")
            .expect("block row count decode");
        panic!(
            "fixture should start with revision 1's block, got {initial_block:?};              text_block rows for the page: {rows}",
        );
    }

    // The rerender job for the page, run the way the method wrapper runs
    // it: it reads the latest revision (still revision 1), renders it
    // slowly, and only then commits.
    let job_state = state.clone();
    let job_page = fixture.page_id;
    let job = tokio::spawn(async move {
        transact(&job_state, |ctx| {
            Box::pin(async move {
                PageRevisionService::rerender(
                    ctx,
                    job_page,
                    RerenderDepth(0),
                    RerenderType::Full,
                )
                .await
                .map_err(err_string)
            })
        })
        .await
    });

    // Let the job read revision 1 and get into its render, then save
    // revision 2 (small, fast) and commit it.
    let job_started = std::time::Instant::now();
    sleep(Duration::from_millis(250)).await;
    let edit_result = transact(&state, |ctx| {
        let edit = EditPage {
            site_id: fixture.page_id.site_id,
            page: Reference::Id(fixture.page_id.page_id),
            last_revision_id: fixture.revision_id,
            revision_comments: String::from("F2 race: newer save"),
            user_id: ADMIN_USER_ID,
            body: EditPageBody {
                wikitext: Maybe::Set(String::from(
                    "[[html]]NEWER-BLOCK-CONTENT[[/html]]\n\nsmall page",
                )),
                ..Default::default()
            },
            ip_address: IP_ADDRESS,
        };
        Box::pin(async move { PageService::edit(ctx, edit).await.map_err(err_string) })
    })
    .await;
    assert!(
        edit_result.is_ok(),
        "newer save should commit: {edit_result:?}"
    );
    eprintln!("newer save committed at {:?}", job_started.elapsed());
    assert_eq!(
        stored_html_block(&state, fixture.page_id.page_id)
            .await
            .as_deref(),
        Some("NEWER-BLOCK-CONTENT"),
        "the save should have installed revision 2's block",
    );

    // The stale job now finishes. Whatever it returns, its revision 1
    // blocks must not displace revision 2's.
    let job_result = job.await.expect("rerender job task should not panic");
    eprintln!(
        "stale rerender job finished with: {job_result:?} at {:?}",
        job_started.elapsed(),
    );
    assert_eq!(
        stored_html_block(&state, fixture.page_id.page_id)
            .await
            .as_deref(),
        Some("NEWER-BLOCK-CONTENT"),
        "stale rerender overwrote the newer revision's hosted blocks",
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn overlapping_add_blocks_do_not_abort_the_writer() {
    let state = setup_state().await;
    let fixture = create_fixture_page(
        &state,
        String::from("[[html]]SEED-BLOCK-CONTENT[[/html]]\n\nseed page"),
    )
    .await;
    let page_id = fixture.page_id.page_id;
    assert_eq!(
        stored_html_block(&state, page_id).await.as_deref(),
        Some("SEED-BLOCK-CONTENT"),
    );

    // First writer: replaces the blocks inside its transaction and holds
    // the result uncommitted, locking the seed rows with its DELETE.
    let txn1 = state.database.begin().await.expect("first txn");
    {
        let ctx1 = ServiceContext::new(&state, &txn1);
        TextBlockService::add_blocks(
            &ctx1,
            page_id,
            TextBlockType::Html,
            &[TextBlock {
                text: "FIRST-WRITER-CONTENT",
                text_type: None,
                mime: MIME_HTML,
                name: None,
            }],
        )
        .await
        .expect("first add_blocks should succeed");
    }

    // Second writer: its add_blocks overlaps the first one's. Its DELETE
    // blocks behind the first transaction's row locks.
    let overlap_state = state.clone();
    let overlap = tokio::spawn(async move {
        transact(&overlap_state, |ctx| {
            Box::pin(async move {
                TextBlockService::add_blocks(
                    ctx,
                    page_id,
                    TextBlockType::Html,
                    &[TextBlock {
                        text: "SECOND-WRITER-CONTENT",
                        text_type: None,
                        mime: MIME_HTML,
                        name: None,
                    }],
                )
                .await
                .map_err(err_string)
            })
        })
        .await
    });

    // Wait until the second writer is genuinely blocked on a lock held
    // over the text_block table, so the overlap is real and not a
    // sequential near-miss.
    let mut saw_lock_wait = false;
    for _ in 0..60 {
        let count: i64 = state
            .database
            .query_one_raw(Statement::from_string(
                sea_orm::DatabaseBackend::Postgres,
                "SELECT count(*) AS n FROM pg_stat_activity \
                 WHERE datname = current_database() \
                   AND wait_event_type = 'Lock' \
                   AND query ILIKE '%text_block%' \
                   AND pid <> pg_backend_pid()"
                    .to_owned(),
            ))
            .await
            .expect("lock wait query should succeed")
            .expect("lock wait query should return a row")
            .try_get("", "n")
            .expect("lock wait count should decode");
        if count > 0 {
            saw_lock_wait = true;
            break;
        }
        sleep(Duration::from_millis(500)).await;
    }
    eprintln!("second writer seen blocked on a lock: {saw_lock_wait}");

    // Release the first writer. The second writer's DELETE now finds the
    // seed rows already gone; the primary key is held by the first
    // writer's committed row at the same index.
    txn1.commit().await.expect("first txn should commit");

    let overlap_result = overlap.await.expect("second writer task should not panic");
    assert!(
        overlap_result.is_ok(),
        "overlapping add_blocks aborted the second writer: {overlap_result:?}",
    );
    assert_eq!(
        stored_html_block(&state, page_id).await.as_deref(),
        Some("SECOND-WRITER-CONTENT"),
        "the second writer's committed replacement should be what is stored",
    );
}
