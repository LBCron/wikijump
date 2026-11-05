# Plan: reduce the memory needed to run the Wikijump stack

Base revision: `af9afac` (`origin/develop`, 2026-11-05). Planning only: this
document changes no source, configuration, or runtime state.

## Summary

The stack (Standing topology in `install/standing/compose.yaml`: PostgreSQL,
the `silo` object store, Valkey, Deepwell, Framerail, WWS, Caddy) has **no
memory bounds anywhere**: none of the Compose files (standing, local, dev) set
a container memory limit; PostgreSQL runs image defaults; Valkey has no
`maxmemory`; Node has no heap cap; the Go services have no `GOMEMLIMIT`; the
Rust services use glibc `malloc` with Tokio defaults sized to the host core
count.

The code review identifies one growth source that is not bounded at all and
several that grow with host size or concurrency rather than with the
workload:

1. **Valkey grows without limit (largest, and it never shrinks).**
   Deepwell's anonymous article cache writes each entry with a plain `SET` and
   no expiry. Its key embeds the renderer epoch, the revision, the
   public-content fence, and the permission fence. Every site write,
   permission change, re-render, and renderer-generation promotion therefore
   leaves the old entries unreachable but resident. Each entry holds the full
   page source plus all compiled HTML as JSON. Valkey keeps the whole dataset
   in RAM and persists it through AOF/RDB on the durable cache volume, so the
   unreachable entries also survive restarts.
2. **Deepwell and WWS keep more memory resident than they use.** Both run glibc
   `malloc` with up to 8 arenas per core, and Tokio worker threads equal to the
   host core count. Deepwell renders run on the blocking pool (up to 512
   threads), with no concurrency cap. A timed-out render keeps running after
   the request returns. Peak memory is roughly concurrent renders × render
   footprint, and glibc arenas keep that peak resident.
3. **PostgreSQL connection fan-out.** Deepwell's pool allows 100 connections,
   which equals PostgreSQL's default `max_connections`. sqlx caches 100
   prepared statements per connection, and JIT is enabled by default. Every
   backend is a separate process with its own catalog and plan caches.
4. **Runtimes sized to the host.** V8 heap, Go heap targets (Caddy, `silo`),
   and the object store's request buffers all size themselves from host or
   cgroup memory. With no cgroup limit, they size from the whole machine.

Framerail's own response caches are already bounded (32 MiB + 8 MiB nominal).
WWS image work is bounded (2 jobs, 16 MiB source, 64 MiB decode). These
services are secondary.

Recommended order: measure (Phase 0); stop the Valkey growth (Phase 1);
apply environment-only allocator, thread, and heap settings (Phase 2); then
the code changes for pool size, render concurrency cap, and streaming
(Phases 3–4). Swap the allocator only if Phase 2 does not achieve the target
(Phase 5). Add container limits last, as guardrails set from measured peaks
(Phase 6).

Expected outcome, **unmeasured, to be confirmed by Phase 0/each phase's
check**:

- Valkey goes from unbounded growth to a fixed ceiling. This is the largest
  saving on any long-running node.
- Deepwell's and WWS's resident memory after load peaks drops substantially.
  Constraining glibc arenas on many-core hosts commonly cuts this by several
  times.
- PostgreSQL's worst-case backend count drops from about 100 to about 20–30.
- The target small single-node configuration below fits in roughly 1.5–2 GiB.

## STATUS

**Done**

- Read every deployment manifest that defines the runtime:
  - Standing: `install/standing/compose.yaml`, `render.py`, `README.md`.
  - Local: `install/local/docker-compose*.yaml`, plus its Dockerfiles and
    start scripts for Deepwell, Framerail, PostgreSQL, Valkey, and silo.
  - Dev: `install/dev/docker-compose.yaml` and its Valkey config.
  - Prod: the Dockerfiles for Deepwell, Framerail, WWS, and Caddy;
    `install/prod/deepwell/config.toml`; and the Caddyfile template
    (`deepwell/src/services/caddy/caddyfile.j2`).
- Inventoried the memory consumers in the code:
  - Deepwell: every Redis key family it writes and its TTL, the
    process-global statics and thread-locals, the database pool, the RPC
    server limits, render scheduling and timeouts, the per-render caches, and
    render-ahead concurrency.
  - Framerail: the article-response caches and the Node entry point.
  - WWS: Redis caches, resize limits, and file and range buffering.
- Confirmed the dependency defaults that the interventions rely on, from the
  locked crate sources:
  - sqlx 0.9 statement cache: 100 per connection.
  - jsonrpsee 0.26: 100 connections, 10 MB body limits.
  - Tokio 1.54: `TOKIO_WORKER_THREADS` is honored; 512 blocking threads.
  - sea-orm 2.0.4 exposes `map_sqlx_postgres_opts` and `max_lifetime`.
- Ranked the interventions, with files, measurement, rollout, and rollback
  for each. Defined the small single-node target.

**Partial**

- No live measurement. This cloud VM has no Docker daemon and no Standing
  data, so every size in this document is an estimate or an illustration,
  not a measurement. Phase 0 must run on the WSL workstation before any
  number here is used to set a limit.
- Some files were not read, because the investigation was stopped for scope:
  the Komodo files under `install/dev/komodo/`, `install/prod/caddy/request.json`,
  and the remaining Caddy scripts.
- Open questions that must be settled before the step that depends on them:
  - **Q1 (blocks Phase 1c):** What happens when an expiring
    permission-cache fence key is evicted early? This decides the Valkey
    eviction policy.
  - **Q2 (blocks Phase 1c):** Is an `ArticlePageCache::set` failure fatal to
    the RPC? This decides whether `noeviction` at `maxmemory` is safe.
  - **Q3 (blocks Phase 2's silo settings):** Does the `pgsty/silo` fork honor
    the upstream `MINIO_*` memory and console settings?

**Remains**

- Phases 0–6 below, all of them. No source or configuration was changed.

## 1. Inventory: where resident memory goes

### 1.1 Topology and global settings

| Service | Image / runtime | Memory-relevant configuration today | Source |
|---|---|---|---|
| database | `postgres:19rc1-alpine` | Image defaults: `shared_buffers=128MB`, `max_connections=100`, `work_mem=4MB`, `maintenance_work_mem=64MB`, `jit=on`, parallel query on. No tuning in any repository file. | `install/local/postgres/Dockerfile` (Standing's database image, per `install/standing/README.md`) |
| files | `pgsty/silo` (MinIO fork), Go | No `GOMEMLIMIT`. The console also listens on `:9001`. MinIO sizes request and buffer pools from system memory. | `install/local/silo/Dockerfile`, `docker-entrypoint.sh` |
| cache | `valkey:9.1-alpine` | No `maxmemory`, so the default `noeviction` policy applies and memory is unbounded. `appendonly yes` and RDB `save`; both fork the server, which copies memory pages as they are written. | `install/local/valkey/valkey.conf`, `install/dev/valkey/valkey.conf` |
| deepwell | Rust, Debian trixie, glibc | No global allocator. `#[tokio::main]` (workers = host cores). Database pool min 4 / max 100 / idle 10 s. jsonrpsee defaults. `[job] workers = 2`. | `deepwell/src/main.rs`, `deepwell/src/database/mod.rs`, `deepwell/src/api.rs`, `install/prod/deepwell/config.toml` |
| framerail | Node 24, `node server.ts` | No `NODE_OPTIONS` or heap cap. In-process caches of 32 MiB and 8 MiB. | `install/prod/framerail/Dockerfile`, `framerail/server.ts` |
| wws | Rust, glibc | No global allocator. `#[tokio::main]`. | `wws/src/main.rs` |
| caddy | Caddy 2.11.7, Go | No `GOMEMLIMIT`; `metrics { per_host }`; `encode` defaults. | `install/prod/caddy/Dockerfile`, `deepwell/src/services/caddy/caddyfile.j2` |

Every Standing service except Caddy shares Caddy's network namespace
(`network_mode: "service:caddy"`). If the Caddy container is recreated or
killed, every other service restarts. Caddy must therefore never get a tight
memory limit.

### 1.2 Valkey (cache): key families

| Family | Writer | Expiry | Size per key | Notes |
|---|---|---|---|---|
| `deepwell:article-view:page:v<epoch>:site=…:page=…:rev=…:updated=…:public=<fence>:permission=<fence>:template=…:body=<hash>:…` | `ArticlePageCache::set`, `deepwell/src/services/view/article_cache.rs:255-276` | **None** (plain `SET`) | Large: the JSON of `GetPageViewOutput::Found` (`deepwell/src/services/view/structs.rs:97-131`). It includes `wikitext` (up to the 200,001-character source limit), `compiled_body_html`, `compiled_body_styles`, and the top and side bar HTML. | Only for `from_wikidot` pages, which means the mirror sites, which hold most of the content. Every change to a key component makes the old entry unreachable. |
| `deepwell:public-content:site:<id>:version` | `PublicContentCache::invalidate_site`, `deepwell/src/services/public_cache.rs` (`INCR`) | None, **must persist** | Tiny | If evicted, `cache_fence` returns `"0"`. That can make a lookup match old entries keyed with `public=0` and serve stale content. |
| Permission cache entries and fences | `deepwell/src/services/permission/cache.rs:33-34` | 300 s and 600 s | Small | Q1: early eviction of a fence is not yet analysed. |
| RSMQ job queue (`rsmq:*`) | `deepwell/src/redis.rs`, `services/job` | None, **must persist** | Small | Background jobs. Evicting these keys would lose work. |
| Random ListPages cache | `deepwell/src/services/render/list_pages/random_cache.rs:35` | 60 s (`SETEX`) | Medium | Bounded by TTL. |
| `site_domain:<id>`, `user_avatar:<id>` | `wws/src/cache.rs` | 60 s | Tiny | Bounded. |

Illustrative arithmetic only, not measured: suppose a mirror of N pages
averages S bytes per serialized entry. One full sweep of anonymous views
after a fence change adds N × S of unreachable data. At N = 30,000 and
S = 100 KB, that is about 3 GB per epoch. Each epoch is never reclaimed.
Promotions that change the renderer epoch or the compiled HTML start a new
epoch for every page. Phase 0 measures the real key count and size.

Fork copy cost: a BGSAVE or AOF rewrite forks Valkey. Memory pages written
during the save are copied, so under write load peak memory can approach
twice the dataset size. A smaller dataset also shrinks this peak.

### 1.3 Deepwell

- **Allocator and threads.** Deepwell uses glibc `malloc` (there is no
  `#[global_allocator]` in the repository). `#[tokio::main]` starts one worker
  thread per host core. Tokio's blocking pool allows up to 512 threads, and
  idle threads are reaped after 10 s. glibc gives each thread an arena, up to
  8 × cores in total. Freed memory in an arena is rarely returned to the
  operating system. Render peaks therefore stay resident as fragmented
  arenas.
- **Render scheduling.** Parse, render, and embed-video resolution run on the
  blocking pool (`spawn_blocking` at
  `deepwell/src/services/render/service.rs:2294`, `:2373`, `:2574`).
  - Each RPC enforces a timeout (`:2318`, `:2565`), but a blocking task cannot
    be cancelled. After a timeout, the parse tree and output stay allocated
    until the thread finishes.
  - No semaphore bounds concurrent renders. Every concurrent request, both job
    workers, and any runtime action add renders.
  - Per-render working memory is bounded by the render cost budget, the
    ListPages limits, and the per-render caches (`IncludeSourceCache`,
    `ListPagesContentCache`, `PageQueryScoreFilterCache`; all created per
    render, see `render/service.rs:1373` and
    `list_pages/rendering/expansion.rs:500-502`). It can still reach tens of
    MB for large ListPages pages: up to 250 results per module
    (`page_query/compat_select.rs:42`), with compiled HTML of the listed pages
    cached during the render.
- **Process-global state is small.** The `LazyLock` statics are compiled
  regexes and version strings. The `thread_local!` items under
  `services/render/**` are `Cell<usize>` test counters. The Fluent locale
  data is about 85 KB. None of these are worth targeting.
- **RPC server.** `ServerConfig::builder().http_only()` (`deepwell/src/api.rs`,
  `build_server_at`) keeps jsonrpsee's defaults: 100 connections and 10 MB
  request and response bodies. A page view builds the response struct and
  then a complete JSON string. Each request therefore holds about 2× the page
  size, temporarily.
- **Database pool.** `deepwell/src/database/mod.rs::connect` sets
  `min_connections(4)`, `max_connections(100)`, `idle_timeout(10s)`. It sets
  no `max_lifetime`. The sqlx statement cache defaults to 100 per connection.
- **Peak events outside normal serving.**
  - Render-ahead during promotion runs as a one-off Deepwell container beside
    the serving stack. It uses `DEEPWELL_RENDER_AHEAD_CONCURRENCY`, default 16
    (`deepwell/src/services/render/ahead.rs:39`;
    `install/standing/render_ahead.py --concurrency` also defaults to 16).
    It opens its own pool of up to 100 connections.
  - The corpus finalizer defaults to 16 (`render/corpus/finalizer.rs:40`).
  - Promotion rehearsal adds a `pg_basebackup` clone, and a second database
    process runs alongside.

### 1.4 PostgreSQL

Each Deepwell connection is a PostgreSQL backend process. A backend uses a
few MB of private memory at baseline. It adds catalog and relation caches, and
plans for up to 100 cached prepared statements. Deepwell issues many distinct
dynamic SQL texts (ListPages, compat select), so the plan cache does fill.
Each sort or hash node can use `work_mem` (× `hash_mem_multiplier`), times
parallel workers. Each parallel worker is another process. With JIT on,
queries above `jit_above_cost` compile LLVM code inside the backend, and
long-lived backends keep that memory. Worst case today is 100 Deepwell
backends, plus up to 100 more from a render-ahead container if PostgreSQL
allowed it. It does not: `max_connections=100` makes the excess connections
fail instead.

Measure PostgreSQL with PSS, not RSS. RSS counts the `shared_buffers` pages a
backend has touched once per process.

### 1.5 Framerail

- The caches are bounded (`framerail/src/lib/server/cache/article-response/shared.ts:3-9`):
  - The response store holds 1,024 entries or 32 MiB, with a 60 s TTL.
  - The local hot cache holds 1,024 entries or 8 MiB, with a 5 s TTL.
  - Single entries over 1 MiB are not cached.
- The byte accounting uses UTF-8 length. V8 stores any string that contains a
  character above Latin-1 in two bytes per character. A mostly-ASCII page with
  one Japanese character therefore costs about twice its counted size. The
  hot cache also stores the body as a string, a `Buffer` copy, and the
  br/gzip replay variants (`hot.ts`, `replay.ts`). The real heap use can
  exceed the nominal 40 MiB by a small multiple.
- Response compression uses Brotli quality 5 (`framerail/article-response-fast-path.ts:280-284`),
  which is moderate.
- There are no other unbounded module-level caches in server code. The
  regex-pattern Maps in `src/lib/server/xmlrpc/protocol.ts:244-245` are keyed
  by a fixed tag vocabulary.
- V8's heap limit is derived from host or cgroup memory, about 4 GB on a large
  host with no cgroup limit. Old space grows lazily up to that limit before
  aggressive collection.
- `PageView.svelte` uses `wikitext` from page data (edit sections, source
  view, gallery lightbox). **Do not strip it from the view payload**; that
  would change browser-visible behavior.

### 1.6 WWS

- Bounded paths:
  - Resize: 2 concurrent jobs (`wws/src/state.rs:35`), 16 MiB source,
    64 MiB decode, 4096 px maximum (`wws/src/handler/resized_image.rs:32-34`).
  - Text blocks are capped at 16 MiB (`wws/src/handler/text_block.rs:35`).
  - Single-range and full-file responses stream from S3.
- **Unbounded peak:** `serve_multi_range` (`wws/src/handler/file.rs:255-300`)
  collects up to 10 ranges (`wws/src/range.rs:21`) fully into one `Vec`. The
  ranges are not coalesced, and blobs can be up to 1 GiB
  (`maximum-blob-size-kb`). One anonymous request can therefore ask WWS to
  buffer several GiB. This is a memory-exhaustion vector and should also go
  through the project's security process.
- Minor: `Cache` opens a new multiplexed Valkey connection on every call
  (`wws/src/cache.rs`, `get_connection!`). This costs connection churn and
  short-lived buffers, not resident memory.

### 1.7 Local development tier (`install/local`)

This tier is not the deployment target, but it is what the workstation runs,
and the workstation's memory guard kills the largest process under pressure
(`docs/agents/compatibility/execution.md`).

- Deepwell and WWS run `cargo watch` + `cargo run` inside their containers.
  `rustc` peaks dominate, and `CARGO_BUILD_JOBS` defaults to 2.
- Framerail defaults to `FRAMERAIL_MODE=dev`, which runs the Vite dev server.
  `built` mode runs `pnpm build` at container start (a startup peak) and then
  the light `node server.ts`.
- Recommendation: run work that does not iterate on source against Standing
  or built images. Use `FRAMERAIL_MODE=built` when no UI is being edited.
- This tier is otherwise out of scope for this plan.

## 2. Ranked interventions

Rank weighs expected saving against risk and effort. "Env" means a
configuration or environment change with no code. Each item lists the files
involved, the check that proves its saving, and how to roll it back.

| # | Intervention | Saving | Risk | Effort | Type |
|---|---|---|---|---|---|
| 1 | Expire Deepwell article-view keys; one-off cleanup of unreachable entries | Very high (unbounded → bounded) | Low–medium (fence correctness) | Low | Code + ops |
| 2 | Valkey `maxmemory` guardrail with a fence-safe policy | High (hard ceiling) | Medium (policy choice) | Low | Env |
| 3 | `MALLOC_ARENA_MAX=2` and `TOKIO_WORKER_THREADS` for Deepwell and WWS | High on many-core hosts | Low | Very low | Env |
| 4 | Deepwell database pool 100 → configurable (~16); sqlx statement cache 100 → ~32; `max_lifetime`; PostgreSQL `max_connections` → ~40 | Medium–high (worst case) | Medium (pool exhaustion) | Low–medium | Code + env |
| 5 | PostgreSQL `jit=off`, parallel workers per gather → 0–1 on small nodes | Medium (per-backend peaks) | Low | Very low | Env |
| 6 | Render concurrency cap that also counts abandoned timed-out renders; lower `max_blocking_threads` | High (peak) | Medium (queueing latency) | Medium | Code |
| 7 | Framerail `--max-old-space-size`; optionally make cache budgets configurable | Medium | Low–medium (OOM restart if too low) | Low | Env (+ small code) |
| 8 | `GOMEMLIMIT` for Caddy and silo; silo console off and request limits (after Q3) | Low–medium | Low | Very low | Env |
| 9 | WWS: stream `multipart/byteranges` instead of buffering | High (peak; closes the DoS vector) | Low | Low–medium | Code |
| 10 | Render-ahead concurrency 16 → 4 on small nodes | Medium (promotion peak) | Low (slower promotions) | Very low | Ops flag |
| 11 | Replace glibc with jemalloc or mimalloc (only if #3 is insufficient) | Medium–high | Medium (allocator behavior change) | Medium | Code |
| 12 | Container `mem_limit` guardrails from measured peaks | Bounds the blast radius | Medium (OOM kills) | Low | Env |
| 13 | Deferred: lighter object store; compressed Valkey values | Medium | High (data migration) | High | Code + data |

### #1 Stop unbounded article-view growth in Valkey

- **Files:** `deepwell/src/services/view/article_cache.rs` (`set`); the tests
  in the same file.
- **Change:**
  - Write with `SET key value EX <ttl>`. Start with 1 hour and tune it from
    hit-rate data. A TTL only shortens how long an entry can be served, so it
    cannot cause stale content; the fence keys stay untouched and decide what
    is current.
  - Run the `verify-article-cache-fence` skill. It is required for any change
    to `ArticlePageCache`.
- **One-off cleanup:**
  - Delete only the `deepwell:article-view:page:*` family with
    `SCAN … MATCH` + `UNLINK`, run in batches. Every key in it is a cache
    entry, so the only effect is cache misses, which refill.
  - **Never** use `FLUSHALL` or `FLUSHDB`: the RSMQ jobs and the
    public-content fences share the database, and both must persist.
  - The cache volume `wikijump-standing-cache-data` itself is kept; only
    these keys are deleted.
- **Proof (before and after; repeat 24 h later and after one promotion):**
  - `valkey-cli INFO memory` (`used_memory`, `used_memory_rss`).
  - The size of the article-view key family:
    `valkey-cli --scan --pattern 'deepwell:article-view:page:*' | wc -l`,
    plus `MEMORY USAGE` on a sample of keys.
  - AOF size on the volume.
  - Pass: the key count stops growing across promotions, and
    `used_memory` stays flat at steady traffic.
- **Rollback:** revert the commit (the old code reads TTL'd keys fine). The
  cleanup needs no rollback.

### #2 Valkey memory ceiling

- **Files:** `install/local/valkey/valkey.conf` and `install/dev/valkey/valkey.conf`
  (the Standing cache image is built from the local one); Compose only if a
  per-deployment value is wanted.
- **Change:**
  - Set `maxmemory <budget>` only **after** #1.
  - Policy: `allkeys-*` is unsafe, because it can evict the fences and the
    job queue. `volatile-lru`/`volatile-ttl` evict only keys with a TTL. The
    article-view cache is the large TTL'd family after #1, so these policies
    are the candidates.
  - Settle Q1 first: permission fences carry a TTL, so `volatile-*` can evict
    them early. If early fence eviction is unsafe, use `noeviction` plus #1's
    TTL as the bound, and confirm (Q2) that a failed cache write degrades to a
    cache miss rather than failing the request.
- **Rollout:** apply live with `CONFIG SET maxmemory` /
  `CONFIG SET maxmemory-policy`, observe for a day, then bake into
  `valkey.conf`. The image change is a Tier 2 step under
  `install/standing/README.md`. Do not lower the image below
  `cache-data-compatibility.json`.
- **Proof:**
  - `INFO memory` and `INFO stats` (`evicted_keys`, `keyspace_misses`).
  - The RSMQ queue length and fence keys are unchanged after an
    eviction-pressure test on a cloned cache volume.
- **Rollback:** `CONFIG SET maxmemory 0`.

### #3 Allocator arenas and worker threads (environment only)

- **Files:**
  - `install/standing/compose.yaml`: the `deepwell` and `wws` `environment`.
  - `install/local/docker-compose.yaml`: optional for the dev tier.
  - `install/dev/docker-compose.yaml`.
- **Change:**
  - `MALLOC_ARENA_MAX=2` (try 2, then 4 if CPU contention shows).
  - `TOKIO_WORKER_THREADS=<n>`: 2 on a small node, otherwise about the CPU
    quota. The Tokio runtime reads this variable itself; no code change is
    needed.
- **Rollout:** re-render the Standing home with `render.py --replace`, then
  recreate only `deepwell` and `wws` (`docker compose up -d --no-deps --no-build deepwell wws`),
  or let the next Tier 1 promotion recreate them from the new home.
- **Proof:**
  - Inside the containers, `VmRSS`/`VmHWM` from `/proc/<pid>/status` and
    `/proc/<pid>/smaps_rollup`. Equivalently, cgroup `memory.current` and
    `memory.peak`.
  - Measure at idle, after the HTTP canary + browser parity, and after a
    render-ahead dry run.
  - Pass: post-load RSS falls with no p95 latency regression on the canary.
- **Rollback:** remove the variables and recreate the services.

### #4 Connection fan-out

- **Files:**
  - `deepwell/src/database/mod.rs::connect`: read the pool size from
    configuration instead of the literal 100.
  - Add `[database] max-connections`, `statement-cache-capacity`, and
    `max-lifetime-secs` to `deepwell/src/config/{file,object}.rs`,
    `install/prod/deepwell/config.toml`, and
    `install/local/deepwell/config.toml`.
  - Use sea-orm's `map_sqlx_postgres_opts(|o| o.statement_cache_capacity(n))`
    and `max_lifetime`.
  - PostgreSQL `max_connections` as a Compose `command: postgres -c …` on the
    `database` service, the same pattern as
    `install/local/docker-compose.postgres-perf.yaml`.
- **Sizing rule:** `max_connections` ≥ serving pool + render-ahead pool
  (its own container) + maintenance (`pg_basebackup`, `psql`) +
  `superuser_reserved_connections`. Deepwell keeps one transaction per RPC,
  so pool size caps concurrent RPCs that touch the database. Render-ahead
  concurrency must stay ≤ its pool.
- **Rollout:**
  1. Code with defaults equal to today's values, so behavior is unchanged.
  2. Lower the values in configuration.
  3. Lower PostgreSQL `max_connections` last. This is a Tier 2 step: the
     database must restart, under the 503 maintenance procedure.
- **Proof:**
  - `SELECT count(*), state FROM pg_stat_activity GROUP BY state` at peak.
  - The sum of PSS over the PostgreSQL processes.
  - `pg_backend_memory_contexts` on a long-lived backend, before and after
    the statement-cache change.
  - No pool-acquire timeouts in Deepwell logs during the canary,
    browser parity, and render-ahead.
- **Rollback:** raise the configuration values. PostgreSQL's setting
  requires a restart.

### #5 PostgreSQL per-backend peaks

- **Files:** the `database` service `command:` in
  `install/standing/compose.yaml`; the same in local and dev if wanted.
- **Change:**
  - `jit=off`.
  - `max_parallel_workers_per_gather=0` on small nodes, 1 otherwise.
  - Keep `work_mem=4MB` and `shared_buffers=128MB` on small nodes. Do not
    raise them without measurement.
- **Rollout:** validate live first with `ALTER SYSTEM SET jit=off;
  SELECT pg_reload_conf();` (both settings are reloadable). Then move the
  settings into Compose and `ALTER SYSTEM RESET` them, so the source stays
  authoritative and nothing lingers in `postgresql.auto.conf` on the standing
  volume.
- **Proof:**
  - Backend PSS during a large ListPages render.
  - `EXPLAIN (ANALYZE)` timings on the heaviest saved queries, to check for
    planner regressions.
- **Rollback:** `ALTER SYSTEM RESET`, or remove the flags.

### #6 Bound concurrent renders

- **Files:**
  - `deepwell/src/services/render/service.rs`: the three `spawn_blocking`
    sites.
  - `deepwell/src/services/render/legacy_actions.rs:159`.
  - `deepwell/src/services/page_revision/service.rs:2012`.
  - A permit in `ServerStateInner` (`deepwell/src/runtime.rs`).
  - `max_blocking_threads` via an explicit runtime builder in
    `deepwell/src/main.rs`.
  - Configuration key `[ftml] render-concurrency`.
- **Design:**
  - Acquire an owned semaphore permit before spawning, and move it **into**
    the blocking closure. A render abandoned after a timeout then keeps
    holding its permit until it really ends, so the cap also counts
    abandoned renders.
  - Wait for the permit **before** the render-timeout clock starts, with a
    separately bounded wait.
  - When the wait expires, return a retryable error (503), not the
    render-timeout fallback. Queueing must not change which pages hit the
    Wikidot-compatible timeout behavior.
  - Size: permits ≈ CPU quota; `max_blocking_threads` about 4 × permits.
- **Rollout:** ship with the cap at a high default, equal to today's
  behavior; lower it in configuration; then run the render-ahead and corpus
  finalizer at the same concurrency to check for new timeouts.
- **Proof:**
  - `memory.peak` during the browser parity and during render-ahead.
  - The count of `RenderTimeout` errors and new 503s is unchanged relative
    to the baseline at equal load.
- **Rollback:** raise the permit count in configuration.

### #7 Node heap

- **Files:**
  - The `framerail` `environment` in `install/standing/compose.yaml`
    (`NODE_OPTIONS=--max-old-space-size=<MiB>`), or `ENV` in
    `install/prod/framerail/Dockerfile`.
  - Optionally, make the constants in
    `framerail/src/lib/server/cache/article-response/shared.ts`
    configurable from the environment, for small nodes.
- **Sizing:** start at about 3 × the measured post-load `heapUsed`. Node
  respects a cgroup limit, but an explicit flag is clearer.
- **Proof:**
  - `process.memoryUsage()` / `--heapsnapshot-near-heap-limit` during the
    browser parity.
  - No heap-OOM restarts (`docker inspect` `RestartCount`).
- **Rollback:** remove the flag.

### #8 Go services

- **Files:** the `files` and `caddy` `environment` in
  `install/standing/compose.yaml`.
- **Change:**
  - `GOMEMLIMIT` (a soft limit that makes the Go GC work harder near the
    target).
  - For silo, after verifying Q3: `MINIO_API_REQUESTS_MAX` and
    `MINIO_BROWSER=off`. The console is started on `:9001` by
    `install/local/silo/docker-entrypoint.sh`.
  - Caddy `metrics { per_host }`: keep it. The per-site label set is small at
    current site counts.
- **Rollout:** Tier 2, because these are base services and recreating Caddy
  restarts its namespace.
- **Proof:** cgroup `memory.current` for each container at idle and during
  file-heavy browser parity.
- **Rollback:** remove the variables.

### #9 WWS multi-range streaming

- **Files:** `wws/src/handler/file.rs` (`serve_multi_range`) and
  `wws/src/fetch.rs`.
- **Change:** build the body as a stream that interleaves the part headers
  with `fetch_range_stream` for each range, with the same bytes and the same
  `Content-Length`. The observable output does not change, so Wikidot HTTP
  parity is unaffected.
- **Proof:**
  - The existing byte-exact tests in `file.rs` pass.
  - A regression test asserts that memory does not grow with range size,
    for example with a mock S3 serving a large range.
- **Rollback:** revert.

### #10 Render-ahead during promotion

- **Change:** pass `--concurrency 4` to `install/standing/render_ahead.py` on
  small nodes. Promotion forwards `DEEPWELL_RENDER_AHEAD_CONCURRENCY`, and
  changing that forwarding is a small change to `promote.py`.
- **Trade-off:** renderer-generation promotions take longer.
- **Proof:** `memory.peak` of the one-off container and of the host during a
  render-ahead dry run.

### #11 Allocator swap (conditional)

- **Use only if** #3 does not reach the target. Add `tikv-jemallocator`
  (with background purge and `dirty_decay_ms`) or `mimalloc` as
  `#[global_allocator]` in `deepwell/src/main.rs` and `wws/src/main.rs`.
  Declaring the static needs no `unsafe`, which is consistent with
  `unsafe_code = "forbid"`. Add the dependencies to the `Cargo.toml` files.
- **Proof:** an A/B comparison of post-load RSS and canary latency against #3
  on the same workload.
- **Rollback:** revert.

### #12 Container memory limits (last)

- **Change:** set `mem_limit` (and `memswap_limit` equal to it) per service
  in `install/standing/compose.yaml`, at about 1.5 × the measured `memory.peak`
  after Phases 1–5.
- **Do not limit Caddy tightly:** killing it restarts its namespace (§1.1).
- **Database restarts:** an OOM kill of PostgreSQL restarts the database.
  Deepwell's per-RPC transactions make that safe for data, but it is an
  outage. Keep this limit generous.
- **Rollback:** remove the limits; this is a Tier 2 re-render.

## 3. Measurement method (Phase 0 and every phase)

Run this on the WSL workstation against Standing, after checking `/-/about`
against `origin/develop` (`install/standing/README.md`). Use one fixed
workload for every comparison:

1. idle for 10 minutes;
2. the HTTP canary and the Standing browser parity;
3. a render-ahead dry run (`render_ahead.py --dry-run`; it writes nothing
   to `page_revision`).

For each container, record:

- cgroup v2 `memory.current`, `memory.peak`, and `memory.stat` (`anon`,
  `file`, `shmem`), or `docker stats --no-stream` as a coarse view;
- process `VmRSS`/`VmHWM` and `smaps_rollup` PSS, summed over the
  PostgreSQL processes;
- Valkey `INFO memory` and the key-family census from #1;
- `pg_stat_activity` counts by state;
- the Node heap from `process.memoryUsage()`.

To follow the project rule "checks over records of checks", make this a
cheap, rerunnable script. A proposed name is
`scripts/measure-stack-memory.sh`, written as part of Phase 0, not in this
change. It prints the numbers above. Do not add receipts, ledgers, or pinned
baselines: rerun the script whenever a result is in doubt.

## 4. Rollout and rollback order

Each phase is independently revertible and is shipped through the normal PR
→ merge → promotion path. Base-service changes (database, cache, files,
Caddy) are Tier 2 steps. Application-service changes are applied by
re-rendering the home and recreating the service.

| Phase | Content | How applied | Rollback |
|---|---|---|---|
| 0 | Baseline measurement | Read-only | — |
| 1 | #1 TTL + cleanup; then #2 ceiling, after Q1 and Q2 | Code PR + Tier 1; live `CONFIG SET`, then config file (Tier 2) | Revert; `CONFIG SET maxmemory 0` |
| 2 | #3, #5, #7, #8 (environment only) | Re-render home; recreate app services; Tier 2 for base services; PostgreSQL validated live first | Remove variables; `ALTER SYSTEM RESET` |
| 3 | #4 pool, statement cache, `max_lifetime`; then PostgreSQL `max_connections` | Code PR (defaults unchanged) → configuration → Tier 2 database restart | Raise values |
| 4 | #6 render cap; #9 WWS streaming; #10 render-ahead concurrency | Code PRs + Tier 1 | Raise the cap; revert |
| 5 | #11 allocator, only if needed | Code PR, A/B on a candidate | Revert |
| 6 | #12 container limits | Re-render, Tier 2 | Remove limits |

Phase 1 comes first because it is the only change that stops unbounded
growth. Phase 2 comes before the code phases because it is free and its
measurements set the targets for Phases 3–6.

## 5. Target configuration: small single node

Assumptions: 2 vCPU, about 2–3 GiB RAM, one or two mirror sites, low
concurrency. Every budget below is a **target to verify** in Phase 0 and 6,
not a measured value.

| Service | Settings | Target budget |
|---|---|---|
| database | `shared_buffers=128MB`, `max_connections=30`, `work_mem=4MB`, `maintenance_work_mem=64MB`, `jit=off`, `max_parallel_workers_per_gather=0` | ≤ 400 MiB PSS |
| cache | `maxmemory 128mb` + policy from Q1/Q2; article-view TTL 1 h; AOF kept | ≤ 128 MiB + fork headroom |
| deepwell | `MALLOC_ARENA_MAX=2`, `TOKIO_WORKER_THREADS=2`, pool 10, statement cache 32, `max_lifetime` 30 min, render permits 2, `[job] workers = 1` | ≤ 350 MiB |
| framerail | `NODE_OPTIONS=--max-old-space-size=192`; response cache 8 MiB, hot cache 2 MiB (needs the small change in #7) | ≤ 250 MiB |
| wws | `MALLOC_ARENA_MAX=2`, `TOKIO_WORKER_THREADS=2`; resize jobs 1 (constant in `wws/src/state.rs`) | ≤ 150 MiB at peak |
| files (silo) | `GOMEMLIMIT=192MiB`, console off, request cap (after Q3) | ≤ 250 MiB |
| caddy | `GOMEMLIMIT=96MiB`, no hard limit | ≤ 100 MiB |
| Promotion | `render_ahead.py --concurrency 4` | Transient |

Total: about 1.5–1.7 GiB steady, leaving headroom for render-ahead and fork
copy peaks within 2–3 GiB.

**Functionality traded away.** None is Wikidot-observable by design. The
trade-offs are operational:

- Lower peak throughput: renders queue behind 2 permits, and a burst gets
  retryable 503s instead of unbounded memory growth. Large ListPages pages
  render more slowly without parallel query.
- More cache misses: article-view entries expire after 1 h, and smaller
  Framerail caches mean more Deepwell and database work for repeat anonymous
  views.
- Slower promotions: render-ahead at concurrency 4. One job worker means
  background jobs (rerender fan-out, pruning) drain more slowly.
- No MinIO/silo web console.
- More GC CPU in Node and Go.
- With container limits: a misjudged budget becomes an OOM restart instead of
  host-wide pressure. Sizing from measured peaks is what keeps this rare.

## 6. Constraints honored by this plan

- The standing volumes are never removed or recreated. The Valkey cleanup
  deletes only the `deepwell:article-view:page:*` family and never flushes
  the database.
- No change alters Wikidot-observable output. Where a step could change
  timing-dependent behavior (#6), it is designed so the Wikidot-compatible
  timeout fallback is not newly triggered by queueing.
- Changes to the article cache's fence or keying must pass the
  `verify-article-cache-fence` skill.
- Measurement stays a rerunnable check, not a stored record.
