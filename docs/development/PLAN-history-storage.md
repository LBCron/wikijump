# Page revision history storage plan

This plan covers controlling the long-term storage growth of page revision history in Deepwell and Postgres. The full Wikidot page-history import (#2076) writes every source content revision through `import_wikidot_page_revision`. Before it, a mirror page held 1 to 3 snapshot revisions. After it, the page holds its whole history. The SCP-9506 pilot alone went from 3 revisions to 25.

This is a planning document. It changes no source code. Every claim about current behavior cites the code or migration it comes from. Numbers are labeled **measured**, **from the pilot**, or **estimate**. An estimate is a working assumption, and Step 0 replaces it.

## Summary

1. **Every content revision stores two full copies of the page: the wikitext and the rendered HTML.** The `text` table deduplicates only byte-identical content, keyed by its 128-bit K12 hash. A one-character edit to a 26 KB article adds a new 26 KB wikitext row and a new compiled-HTML row. Imports work the same way, because `ImportService::add_page_revision` renders each historical revision with FTML at import time.
2. **Garbage collection of `text` does not work as written, and it gets slower as history grows.** `TextService::prune` uses `NOT IN (subquery)` against nullable columns. By SQL semantics it then deletes nothing, as long as any revision has a NULL styles, top-bar or side-bar hash. It also leaves out `page_revision_render_ahead`, which has foreign keys to `text`. Every rerender and FTML epoch orphans the previous compiled HTML of each changed page, so dead bytes pile up even with no new history.
3. **Postgres compression is not configured the way the install scripts suggest.** `SET default_toast_compression = lz4` in `install/common/postgres/init/02-seed.sql` applies only to that init session. The migrations run in other sessions, so `text.contents` uses the server default compression.
4. **Several indexes and scans grow with the total number of revisions instead of with the number of pages:** GIN on every revision's tags, a btree on every text row's `character_count`, and full scans of `page_revision` in `can_read` and in foreign-key checks during prune.
5. **The biggest levers, in order:**
   - (a) Make GC correct, so orphaned bytes can be reclaimed at all.
   - (b) Stop keeping compiled HTML for superseded revisions. Render it on demand instead. This needs Wikidot evidence first.
   - (c) Store historical wikitext as reverse deltas against the latest revision. Compression settings matter for CPU time, not size.
6. **Sequence:** Step 0 measures on Standing, read-only. Steps 1 to 3 are small, safe, and ship independently. Steps 4 and 5 are the structural savings, each behind its own measurement and evidence gate.

## 1. How revision text is stored today

### Schema (from migrations)

- `text(hash BYTEA PK CHECK length=16, contents TEXT NOT NULL)`. The table is content-addressed. The comment says the hash is KangarooTwelve, 128-bit (`20220906103252_deepwell.sql:325`). `character_count BIGINT GENERATED ALWAYS AS (char_length(contents)) STORED` plus the btree `text_character_count_idx` were added in `20260713180000_text_character_count.sql`.
- `page_revision` has one row per revision (`20220906103252_deepwell.sql:333`). It holds 5 references into `text`:
  - `wikitext_hash` (NOT NULL)
  - `compiled_body_html_hash` (NOT NULL)
  - `compiled_top_bar_html_hash` (nullable)
  - `compiled_side_bar_html_hash` (nullable)
  - `compiled_body_styles_hash` (nullable; added in `20260713160000`, and older revisions stay NULL "until rerendered")

  Every revision also carries its own copies of `title`, `slug`, `comments`, `compiled_generator`, `tags TEXT[]`, `changes TEXT[]`, and `hidden TEXT[]`.
- `page_revision` indexes: the PK `(revision_id)`, `UNIQUE (page_id, site_id, revision_number)`, and `page_revision_tags_gin_idx` GIN over `tags` (`20260713170000`). No column that references `text` is indexed.
- `page_revision_render_ahead` (`20261014120000`) has 4 more foreign keys to `text(hash)`. Deepwell has no SeaORM model for this table.
- `forum_post_revision`, `message_record`, and `message_draft` also reference `text`. Imported forum discussions (`import/discussion.rs:592`) share the same table.

### Write path (from code)

- `TextService::create` (`services/text.rs`) computes `k12_hash(contents)`, checks whether the row exists, and inserts it with `ON CONFLICT DO NOTHING`. The table never stores deltas or chunks.
- When the wikitext changes, `PageRevisionService::create` (`page_revision/service.rs:480`) calls `PageRevisionDraft::derive`, which writes the new wikitext. It then calls `draft.render`, which goes through `render_and_update_links` and `RenderService::persist_or_hash_compiled_text` (`render/service.rs:2713`). That writes body HTML, the styles JSON (top-bar, side-bar and body CSS together), and the top-bar and side-bar HTML as `text` rows.
- **The import uses the same path.** `ImportService::add_page_revision` (`import/service.rs:1132`) calls `create_first` and `create` for each source revision. Each historical revision is therefore FTML-rendered once, and its HTML is stored for good. Includes resolve against whatever the database holds at import time, so the stored "historical" HTML is not a rendering as of that time either.
- **The import writes each revision row twice.** After inserting, it runs `UPDATE page_revision SET revision_id = <source id>, created_at, updated_at, tags, anonymous_author_ip` (`import/service.rs:1298`). Changing the primary key forces a non-HOT update. The result is a dead tuple plus new entries in the PK, unique, and GIN indexes for every imported revision, until vacuum runs.
- **Rerenders overwrite in place.** `rerender_inner` (`service.rs:1400`) and render-ahead promotion (`render/ahead.rs:295`) `UPDATE` the latest revision's compiled hashes. The old compiled rows become orphans, and only `prune` can reclaim them. Each FTML or epoch bump creates a new body-HTML row for every page whose output changed. The latest commit on `develop` is the fifth FTML snapshot bump that day.

### What a content revision costs

For a content revision with wikitext of `W` raw bytes and rendered HTML of `H` raw bytes:

```
bytes ≈ row (~0.6–0.9 KB: header, 5×17 B hashes, tags/changes/hidden arrays, title, slug, comments, generator)
      + index entries (PK, unique, GIN per tag; ~0.1–0.3 KB)
      + toast(W) + toast(H) + toast(styles, if changed)
      + per new text row: ~100 B (tuple, 17 B hash, 8 B character_count, 18 B TOAST pointer, text_pkey + character_count index entries)
```

- `toast(x)` is the size after TOAST compression. TOAST compresses only values over roughly 2 KB, and it stores them in roughly 2 KB chunks with per-chunk overhead.
- Top-bar and side-bar HTML usually deduplicate across revisions of the same page, because they don't change when only the body changes. The row size above is an **estimate**.

**From the pilot** (#2076 comments; the operator-side capture was not re-read here):

- SCP-9506 has 50 source revisions holding 1,308,721 bytes of raw wikitext, about 26 KB per revision. The seeded `deepwell/seeder/scp-9506.ftml` is 30,109 bytes, which is consistent.
- 25 of those revisions changed content and were imported.
- 3 of them are rollbacks to byte-identical earlier content, so they deduplicate.
- That leaves about 22 distinct full wikitext copies, roughly 0.57 MB raw, plus as many compiled-HTML copies, for a page whose current source is 26–30 KB.
- A reverse-delta layout would hold about one full copy plus 21 small edits.

### Duplication across revisions of the same page

- Only exact duplicates collapse: rollbacks, tag-only edits, title-only edits, and edits that change only navigation or metadata.
- A normal edit stores the entire new wikitext and the entire new HTML.
- Nothing shares bytes between adjacent revisions. TOAST compresses each value on its own.

## 2. How the code reads history

This shapes what each lever costs at query time.

| Reader | Reads | Text needed | Code |
|---|---|---|---|
| Article view, includes, nav, ListPages | latest revision only | latest wikitext and compiled | `get_latest*`, `*_batch` via `page.latest_revision_id`; `view/service.rs:908` |
| History list | `page_revision_range` ordered by revision_number | none (rows only; Framerail requests no details) | `service.rs:2140`; `framerail/src/lib/server/deepwell/page.ts:592` |
| History "S" / `history/PageSourceModule` | one old revision | wikitext | `pageRevisionById(..., wikitext=true)`; `endpoints/page_revision.rs` |
| History "V" / `history/PageVersionModule` | one old revision | **stored compiled HTML** of that revision | `ajax-module-connector.php/+server.ts:803`; `HistoryPane.svelte:665` |
| Diff | two revisions | wikitext × 2 | `get_diff`, `service.rs:1964` |
| Rollback, undo, resurrection | one old revision | wikitext | `create_resurrection`, `service.rs:930` |
| Site-changes RSS | recent revisions across a site (bounded scan) | compiled HTML of each listed revision | `render/site_changes_feed.rs:170` |
| ListPages RSS | latest revisions | compiled body HTML | `render/list_pages/feed.rs:284` |
| Page size ordering | latest | `text.character_count` via join and COALESCE | `page_revision/service.rs:1771`, `page_query/service/ordering.rs:190` |
| `TextService::can_read` | any hash | OR across 5 hash columns of `page_revision`, unindexed, so a sequential scan | `services/text.rs:146` |
| `TextService::prune` (daily in shipped configs) | all text | 11 `NOT IN` subqueries | `services/text.rs:330` |

Consequences:

- Latest-revision reads never touch historical text. Historical **wikitext** is read one or two revisions at a time, on explicit user actions.
- Historical **compiled HTML** is read only by "V" / PageVersionModule and by the recent-changes RSS. That makes it the cheapest data to stop storing, provided compatibility evidence allows on-demand rendering (Step 4).

## 3. Defects and index costs found

These come from reading the code. The SQL semantics are certain; their effect on Standing has not been measured yet.

1. **Prune deletes nothing when nullable references contain NULL.**
   - What happens: `prune_condition` (`services/text.rs:330`) builds `hash NOT IN (SELECT compiled_top_bar_html_hash FROM page_revision)` and similar conditions. If that subquery returns any NULL, the condition evaluates to NULL instead of true for every hash that isn't in the list, so the row is kept.
   - Why it is likely to trigger: NULLs are expected wherever a page's nav is disabled, and in every revision that was never rerendered after `compiled_body_styles_hash` was added.
   - Test coverage: the unit test only checks that the statement contains `NOT IN` 11 times.
2. **Prune ignores `page_revision_render_ahead`.** That table has `REFERENCES text(hash)` but no model, so `text_references()` cannot derive it. If (1) were fixed, any row referenced only by render-ahead would cause a foreign-key violation, and the whole DELETE would roll back.
3. **Prune gets slower as history grows.**
   - `NOT IN (subquery)` can't be turned into an anti-join. It needs a hashed subplan that fits in `work_mem` for each of the 11 subqueries. Otherwise each text row rescans the subquery result.
   - Each text row it does delete triggers foreign-key checks that look up each referencing column. With no index on those columns, each check is a sequential scan of `page_revision`.
4. **lz4 is not the effective TOAST compression.** `02-seed.sql` uses `SET`, which applies only to its own session. Applying all 57 migrations to the local scratch database (PostgreSQL 16) gives `attcompression = ''` for `text.contents`, so the server default applies. Standing runs `postgres:19rc1` (`install/local/postgres/Dockerfile`), so its default must be read on Standing in Step 0.
5. **Indexes on all revisions that are only queried for the latest one:**
   - `page_revision_tags_gin_idx` covers every revision's tags. Tag filters join through `page.latest_revision_id` (`page_query/service.rs:475`). If the planner uses the GIN index, it reads about N historical matches per page and discards them in the join.
   - `text_character_count_idx` indexes every text row, including all historical HTML. The only reader orders by `COALESCE(snapshot.wikidot_size, text.character_count)`, and a btree on `character_count` can't serve that order. This is **probably unused**; Step 0 checks `idx_scan`.
6. **Import write amplification:** the primary-key update in `add_page_revision` (section 1).

## 4. Levers

Expected ratios are **estimates** until Step 0 and Step 5 measure them.

| Lever | What it saves | Expected effect | Query-cost trade-off | Risk |
|---|---|---|---|---|
| **L1 Correct and scalable GC** | orphaned compiled HTML from rerenders, epochs, and previews | All orphaned bytes. The amount is measured exactly by Step 0.4 (class "orphan"). It grows by roughly (pages whose output changed) × H per FTML bump. | Prune switches to `NOT EXISTS` anti-joins (hash joins) and batched deletes. Foreign-key checks need indexes on the referencing compiled columns; alternatively, compiled references stop being foreign keys. | Low. Prune deletes only rows that nothing references. |
| **L2 Explicit lz4 on `text.contents`** | CPU, not size | Size about the same as pglz on text (roughly ±15%, **estimate**). Compression and decompression are several times faster. | Faster detoast on every read and faster import writes. | Low. Only new values use it; old values change only when rewritten. |
| **L3 Index discipline** | index bytes that scale with history | Drop `text_character_count_idx` if unused. For tags GIN, measure first; if the planner uses it, move tag filtering to a current-revision-only structure. | Unused index: none. Tags: behavior must stay identical, so it is a separate change. | Low for the unused index; moderate for tags. |
| **L4 No stored HTML for superseded revisions** | H × (content revisions − pages), the largest single class after wikitext | All of class "history-only compiled" from Step 0.4. It also removes FTML rendering of historical revisions during import, which cuts import CPU about N-fold. | "V" / PageVersionModule becomes one render under the existing render budget instead of a PK lookup. Site-changes RSS renders on demand or keeps HTML for the newest K revisions. | **Compatibility gate.** Requires evidence on what Wikidot's PageVersionModule shows for old revisions. Stored HTML is already rendered at import time, not as of the revision's date. |
| **L5 Reverse-delta history wikitext** | (k−1) of k full copies per page | **Estimate** for small-edit histories like SCP-9506: about 5–20× on historical wikitext bytes. Measured by the Step 0.7 procedure. | The latest revision stays full, so hot paths are unchanged. Reading revision r applies at most K deltas, with a keyframe every K revisions. Diff, source and rollback each pay at most 2K delta applications. | Moderate. Correctness is checked by rehashing each rebuilt revision with K12 and comparing it with the stored `wikitext_hash`, which every row already carries. |
| **L6 Cold-history separation** | memory and backup pressure on hot `text` | No byte reduction by itself. Keeps the hot working set (latest content, forum, messages) small. | One extra lookup for historical reads only. | Only worth it if Step 0 trends show the hot set outgrowing memory. |

Rejected or deferred:

- **Stronger TOAST codecs:** core Postgres offers pglz and lz4 only. Anything stronger, such as zstd with dictionaries or `--patch-from`, has to live in the application. That is L5.
- **Dropping history rows:** history must be preserved for compatibility (#2076).
- **Git-backed revisions:** #3027 is a much larger redesign and is out of scope here.

## 5. Sequenced steps

Each step ships on its own as a normal PR, with the measurement that validates it.

### Step 0: Baseline on Standing (read-only SQL, no code)

Run these on Standing, or on a restored copy, and record the results in the PR that starts Step 1.

```sql
-- 0.1 sizes
SELECT relname, pg_size_pretty(pg_table_size(oid)) AS heap_and_toast,
       pg_size_pretty(pg_indexes_size(oid)) AS indexes,
       pg_size_pretty(pg_total_relation_size(oid)) AS total
FROM pg_class
WHERE relname IN ('text','page_revision','page_revision_render_ahead','forum_post_revision','page')
ORDER BY pg_total_relation_size(oid) DESC;

-- 0.2 index sizes and use
SELECT relname, indexrelname, pg_size_pretty(pg_relation_size(indexrelid)) AS size, idx_scan
FROM pg_stat_user_indexes WHERE relname IN ('text','page_revision')
ORDER BY pg_relation_size(indexrelid) DESC;

-- 0.3 effective compression (sampled: octet_length detoasts)
SHOW default_toast_compression;
SELECT attcompression FROM pg_attribute
WHERE attrelid = 'text'::regclass AND attname = 'contents';
SELECT pg_column_compression(contents) AS method, count(*),
       sum(octet_length(contents)) AS raw_bytes, sum(pg_column_size(contents)) AS stored_bytes
FROM text TABLESAMPLE SYSTEM (2) GROUP BY 1;

-- 0.4 classify every text row by its strongest referrer
WITH latest AS (
  SELECT pr.* FROM page p JOIN page_revision pr ON pr.revision_id = p.latest_revision_id
), refs(hash, kind) AS (
            SELECT wikitext_hash, 1 FROM latest
  UNION ALL SELECT compiled_body_html_hash, 2 FROM latest
  UNION ALL SELECT compiled_body_styles_hash, 2 FROM latest
  UNION ALL SELECT compiled_top_bar_html_hash, 2 FROM latest
  UNION ALL SELECT compiled_side_bar_html_hash, 2 FROM latest
  UNION ALL SELECT wikitext_hash, 3 FROM page_revision
  UNION ALL SELECT compiled_body_html_hash, 4 FROM page_revision
  UNION ALL SELECT compiled_body_styles_hash, 4 FROM page_revision
  UNION ALL SELECT compiled_top_bar_html_hash, 4 FROM page_revision
  UNION ALL SELECT compiled_side_bar_html_hash, 4 FROM page_revision
  UNION ALL SELECT compiled_body_html_hash, 5 FROM page_revision_render_ahead
  UNION ALL SELECT compiled_body_styles_hash, 5 FROM page_revision_render_ahead
  UNION ALL SELECT compiled_top_bar_html_hash, 5 FROM page_revision_render_ahead
  UNION ALL SELECT compiled_side_bar_html_hash, 5 FROM page_revision_render_ahead
  UNION ALL SELECT wikitext_hash, 6 FROM forum_post_revision
  UNION ALL SELECT compiled_html_hash, 6 FROM forum_post_revision
  UNION ALL SELECT wikitext_hash, 6 FROM message_record
  UNION ALL SELECT compiled_hash, 6 FROM message_record
  UNION ALL SELECT wikitext_hash, 6 FROM message_draft
  UNION ALL SELECT compiled_hash, 6 FROM message_draft
), cls AS (SELECT hash, min(kind) AS kind FROM refs WHERE hash IS NOT NULL GROUP BY hash)
SELECT CASE coalesce(c.kind, 7)
         WHEN 1 THEN 'latest wikitext' WHEN 2 THEN 'latest compiled'
         WHEN 3 THEN 'history-only wikitext' WHEN 4 THEN 'history-only compiled'
         WHEN 5 THEN 'render-ahead only' WHEN 6 THEN 'forum/message' ELSE 'orphan' END AS class,
       count(*) AS rows, pg_size_pretty(sum(pg_column_size(t.contents))) AS stored,
       sum(t.character_count) AS chars
FROM text t LEFT JOIN cls c USING (hash) GROUP BY 1 ORDER BY 1;

-- 0.5 NULLs that make the current prune a no-op
SELECT count(*) FILTER (WHERE compiled_body_styles_hash IS NULL) AS styles_null,
       count(*) FILTER (WHERE compiled_top_bar_html_hash IS NULL)  AS top_null,
       count(*) FILTER (WHERE compiled_side_bar_html_hash IS NULL) AS side_null
FROM page_revision;

-- 0.6 history shape and exact-dedup ratio
SELECT percentile_disc(ARRAY[0.5,0.9,0.99,1.0]) WITHIN GROUP (ORDER BY n)
FROM (SELECT page_id, count(*) AS n FROM page_revision GROUP BY page_id) s;
SELECT count(*) AS revisions, count(DISTINCT wikitext_hash) AS distinct_wikitext,
       count(DISTINCT compiled_body_html_hash) AS distinct_body_html
FROM page_revision;

-- 0.8 import double-write bloat
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables WHERE relname IN ('page_revision','text','page');
```

- **0.7 delta potential:** export the wikitext chains of about 200 sampled pages with at least 5 revisions, joining `page_revision` to `text` in revision order. For each chain, compare the sum of compressed full copies with the latest compressed copy plus compressed reverse diffs (for example `zstd --patch-from=<newer> <older>`). Report the ratio per percentile of revision count.
- **0.9 prune plan:** run `EXPLAIN` on the statement `TextService::prune` generates. Plain `EXPLAIN` doesn't execute it. Confirm subplan versus hashed subplan.
- **Done when** classes 0.4 and 0.5 are known. They size L1, L4 and L5 directly, and replace every estimate above.
- **Operational note while the import runs (no code):** watch 0.8 and run `VACUUM (ANALYZE) page_revision` between import batches if autovacuum falls behind.

### Step 1: Fix text GC (L1)

- **Change:**
  - Rewrite `prune_condition` as `NOT EXISTS` anti-joins, which are NULL-safe.
  - Include `page_revision_render_ahead`, either through a model or an explicit table list.
  - Delete in bounded batches.
  - Add btree indexes on the compiled hash columns that GC deletes against. Before that, measure their size against dropping the foreign keys on compiled columns, and record the decision in the PR.
- **Tests:**
  - A deepwell DB test with a revision whose top bar is NULL, an orphaned compiled row, and a render-ahead-only row. Prune must delete exactly the orphan.
  - Replace the string-count unit test.
- **Validate:** on a restored Standing copy, rows deleted equal the 0.4 "orphan" count. `EXPLAIN` shows hash anti-joins. Prune time scales roughly linearly with `text` size; time it at 1× and at a synthetic 10×.

### Step 2: Make lz4 explicit (L2)

- **Change:**
  - A migration runs `ALTER TABLE text ALTER COLUMN contents SET COMPRESSION lz4`.
  - Delete or correct the session-scoped `SET` in both `02-seed.sql` files so they stop implying a server default.
  - Rewriting existing rows (`VACUUM FULL` or a batched re-insert) is optional and decided from 0.3.
- **Validate:**
  - 0.3 shows new rows as `lz4`.
  - On a 1% sample, compare the stored-to-raw ratio with pglz rows and benchmark detoast time for historical reads.
  - Ship only if size regresses by no more than about 5% on the sample.

### Step 3: Index discipline (L3)

- **Change:**
  - Drop `text_character_count_idx` if 0.2 shows `idx_scan = 0` and `EXPLAIN` on the size-ordered ListPages queries doesn't use it.
  - Confirm the callers of `TextService::can_read`. Restrict its `page_revision` probe to the indexed path, or add the index that Step 1 already justifies.
  - For `page_revision_tags_gin_idx`, capture `EXPLAIN (ANALYZE, BUFFERS)` for representative tag ListPages queries before and after the import grows history. Move tag filtering to a current-only structure only if the plan or its buffer reads degrade, and do that in its own PR with ListPages regression tests.
- **Validate:** 0.2 index bytes drop. ListPages and `can_read` latency doesn't regress against the existing offline ListPages suites.

### Step 4: Superseded revisions stop keeping compiled HTML (L4, behind an evidence gate)

- **Gate:** retained Wikidot evidence, following `docs/agents/compatibility/evidence.md`, on what `history/PageVersionModule` serves for an old revision: stored rendering, or a render at view time of the old source with current includes and data. Collect at least 2 positive and 2 negative observations, using include or template changes made after the revision.
- **Change, once the gate allows on-demand rendering:**
  - When a revision is superseded, clear the previous revision's compiled hashes. This requires `compiled_body_html_hash` to become nullable.
  - Render "V" on demand within the existing render budget.
  - The site-changes RSS keeps HTML for the newest K revisions per site or renders on demand.
  - The import renders only the final revision of each page. Historical revisions still store wikitext and metadata.
  - Step 1's GC reclaims the cleared rows.
- **Validate:**
  - The 0.4 class "history-only compiled" drops to roughly zero after one GC run.
  - Offline golden for "V" on sampled revisions, for the case where include state is unchanged.
  - p95 latency of "V" stays within the render budget.
  - Per-revision import CPU drops; measure it on the pilot payload.

### Step 5: Reverse-delta history wikitext (L5)

- **Change:**
  - Historical wikitext moves to a history store keyed by `(page_id, revision_number)`: a full keyframe every K revisions plus reverse deltas from the newer revision.
  - The latest revision's wikitext stays a normal `text` row, so hot paths don't change.
  - `TextService::get` for a non-latest `wikitext_hash` resolves through the store.
  - `wikitext_hash` stays in `page_revision` as the identity and integrity check.
  - Choose K from 0.7 so that at most K applications stay under about 5 ms for the 99th-percentile page.
- **Migration:** convert old pages in background batches, oldest first. Each batch rebuilds every revision it converts, rehashes it with K12, compares the result with `wikitext_hash`, and only then deletes the full `text` rows through the Step 1 GC.
- **Validate:**
  - A rerunnable full check rebuilds every converted revision and compares hashes; it must report zero mismatches.
  - Bytes of 0.4 "history-only wikitext" shrink by the 0.7 ratio.
  - Latency of diff, source and rollback stays within budget.

### Step 6 (conditional): Cold separation (L6)

Only if Step 0 trends after Steps 1, 4 and 5 show the hot `text` set outgrowing the buffer cache. Move the history store to its own table or tablespace, then reevaluate.

## 6. Open questions

1. Standing's `default_toast_compression` on `postgres:19rc1`, and the actual compression mix (0.3).
2. Wikidot's PageVersionModule semantics (Step 4 gate).
3. The real HTML-to-wikitext size ratio H/W for the corpus (0.4 gives it directly).
4. The callers of `TextService::can_read`, and how often they run.
5. Whether the import should set `revision_id` and `created_at` at insert time to avoid the primary-key rewrite. That would change `PageRevisionService::create`'s contract, so it belongs with the import owner (#2076).

## STATUS

**Done**

- Traced the write path for revision text: editing, import, rerender, render-ahead.
- Traced every history read path in Deepwell and Framerail that reaches `text`.
- Traced the GC job and its configuration, and the indexes on `page_revision` and `text`.
- Confirmed the schema by applying all 57 migrations in `deepwell/migrations/` to a scratch PostgreSQL 16 database. This showed that `text.contents` has no explicit compression setting (`attcompression = ''`).
- Identified the defects and costs in section 3: the NOT IN/NULL no-op in prune, render-ahead missing from prune, unindexed foreign-key checks during prune, session-scoped lz4, indexes that cover every revision, and import write amplification.
- Wrote the lever analysis and the sequenced, independently shippable steps with their validating measurements.

**Partial**

- **No storage ratios have been measured.** The compression, delta and HTML-size figures are estimates, plus the one data point from the SCP-9506 pilot.
- A local FTML HTML-size measurement and a synthetic revision-chain load were started and not finished. They produced no results and nothing from them is committed.
- The prune no-op is certain from SQL semantics, but it has not been confirmed against Standing data. That needs 0.5 to show NULLs in the nullable hash columns.

**Remaining**

- Run Step 0 on Standing and fold the results into this plan's estimates.
- Collect the Wikidot evidence for the Step 4 gate.
- Answer the open questions in section 6.
- Implement Steps 1–5 as separate PRs.
