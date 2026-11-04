#!/usr/bin/env python3
"""Render saved pages ahead of a Deepwell renderer-generation switch.

A renderer epoch or FTML bump makes every saved page stale, and Deepwell
refuses stale output. Rerendering only after activation therefore holds the
site in maintenance for the whole rerender. This command runs the `render-ahead`
action of the image that is about to be activated against the live database
while the current Deepwell keeps serving. The new Deepwell promotes the rows
when it starts, so activation costs a container restart.

The one-off container copies the environment and configuration mount of the
running Deepwell container and joins its network namespace, so it reaches the
same database, cache, and object store. Its entrypoint is the Deepwell binary,
not the image start script, so no migration is recorded: the command only runs
the image's idempotent render-ahead table migration, which keeps the serving
build's own migration check (and a rollback to it) working.

Rendering also refreshes link rows. Backlinks, OrphanedPages, WantedPages,
and page queries using ListPages/CountPages link_to= read those rows. Deepwell
reports every page whose render read the link graph. A link reader rendered
early in that pass may have read links that later renders changed, so the
readers are rendered again, alone, until a round leaves every link unchanged.
If links continue to change after the bounded rounds, the run fails closed:
even a nondeterministic reader can leave another reader with stale output.
Pages that miss the serving render deadline under concurrent load are retried
alone and then once with a longer one-shot deadline
(docs/agents/compatibility/execution.md). A text-block store request that
crosses the bucket's per-request timeout under the same load is retried the
same way: alone, the write pressure that starved it is gone. Any other
failure stops the run. A final dry run checks the whole site.

Each run renders every stale page itself: rows left by an earlier run are not
reused, because only this run's own passes know which pages read links.

The full pass dominates render-ahead wall-clock (about 97% on recent
generation changes: every stale page must render exactly once, so the pass is
pure throughput). Two controller-side levers keep that throughput visible and
scalable without touching the renderer's selection, validity, or convergence
rules:

* Per-pass overhead accounting: each pass entry records `overhead_seconds`
  (controller wall-clock minus the image's own render time, i.e. container
  startup and log handling), and every link-digest snapshot is timed into
  the summary's `link_digest_timings`.
* Sharded full pass (`--shards`, default 1): the full pass renders disjoint
  chunks of the live page-ID space in concurrent containers through the same
  `render_pass` primitive and merges their summaries. Shard 1 is the exact
  historical behavior. Only the full pass shards: reader rounds, deadline
  tail retries, and the dry-run verify stay single invocations.
"""

from __future__ import annotations

import argparse
import concurrent.futures
from datetime import UTC, datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


MIGRATION_PATH = "/opt/deepwell/migrations/20261014120000_page_revision_render_ahead.sql"
DEEPWELL_BINARY = "/usr/local/bin/deepwell"
CONFIG_PATH = "/etc/deepwell.toml"
# Only live pages with a current revision are eligible for render-ahead.
# Historical connections on deleted pages are still retained in the database,
# but they cannot be re-rendered. Excluding them here keeps the link probe's
# candidate set aligned with the renderer's active-page selection.
# Per-page link content: endpoints, type and count, not row timestamps, which
# rendering rewrites even when the links are unchanged.
LINK_DIGEST_QUERY = """
SELECT links.page_id, md5(string_agg(row, ',' ORDER BY row)) FROM (
  SELECT from_page_id AS page_id, 'c' || ROW(to_page_id, connection_type, count)::text AS row
  FROM page_connection
  UNION ALL
  SELECT from_page_id, 'm' || ROW(to_site_id, to_page_slug, connection_type, count)::text
  FROM page_connection_missing
  UNION ALL
  SELECT page_id, 'l' || ROW(url, count)::text FROM page_link
) AS links
JOIN page AS source_page ON source_page.page_id = links.page_id
WHERE source_page.deleted_at IS NULL
  AND source_page.latest_revision_id IS NOT NULL
GROUP BY links.page_id;
"""
# Every live page ID, for sharding the full pass. This is deliberately a
# superset of the stale set, not a copy of the renderer's staleness
# predicate: the image still applies its own selection (including the
# ahead-row validity rule) inside each chunk, so a controller/image skew can
# only leave pages stale, which the final verify fails closed on. Chunking
# the whole live space (rather than a predicted-stale subset) guarantees
# every live page belongs to exactly one shard, so sharding cannot miss one.
LIVE_PAGE_IDS_QUERY = """
SELECT page.page_id FROM page
WHERE page.deleted_at IS NULL
  AND page.latest_revision_id IS NOT NULL
ORDER BY page.page_id;
"""
# Mirrors the image's per-pass failure report cap: merged shard summaries
# keep every failed page ID (the tail-retry path needs the complete list)
# but truncate the verbose per-failure details the same way.
MAX_REPORTED_FAILURES = 50
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}")
IDEMPOTENT_STATEMENT = re.compile(
    r"^(CREATE TABLE IF NOT EXISTS|CREATE INDEX IF NOT EXISTS)\s", re.IGNORECASE
)
SUMMARY_SCHEMA = "wikijump.render_ahead_summary.v1"
RENDER_TIMEOUT = re.compile(r"^render-timeout-ms\s*=\s*[0-9]+\s*$", re.MULTILINE)
DEADLINE_MARKERS = ("deadline has elapsed", "due to timeout")
# The bucket request timeout (deepwell's BUCKET_REQUEST_TIMEOUT) surfaces as
# a reqwest "operation timed out" on the text-block PUT. It is a load
# latency tail, not a property of the page: the same page renders once the
# concurrent write pressure is gone, so it belongs to the tail-retry class.
STORAGE_TIMEOUT_MARKERS = ("operation timed out",)
TAIL_RETRY_MARKERS = DEADLINE_MARKERS + STORAGE_TIMEOUT_MARKERS
# A link reader's own links can be read by another reader, so each level of
# that chain needs one more round of reader renders.
MAX_READER_ROUNDS = 4


def run(*args: str, input_text: str | None = None) -> str:
    result = subprocess.run(
        args, check=True, text=True, capture_output=True, input=input_text
    )
    return result.stdout


def sql_statements(sql: str) -> list[str]:
    """Split a migration into statements, dropping comments and blank lines."""
    lines = [
        line for line in sql.splitlines() if line.strip() and not line.lstrip().startswith("--")
    ]
    return [statement.strip() for statement in "\n".join(lines).split(";") if statement.strip()]


def require_idempotent_migration(sql: str) -> None:
    statements = sql_statements(sql)
    if not statements:
        raise ValueError("render-ahead migration is empty")
    for statement in statements:
        if IDEMPOTENT_STATEMENT.match(statement) is None:
            raise ValueError(
                "render-ahead migration must only create tables or indexes IF NOT EXISTS: "
                + statement.splitlines()[0]
            )


def container_inspect(container: str) -> dict[str, object]:
    [inspected] = json.loads(run("docker", "inspect", container))
    state = inspected.get("State") or {}
    if not state.get("Running"):
        raise RuntimeError(f"{container} is not running")
    return inspected


def config_mount(inspected: dict[str, object]) -> str:
    for mount in inspected.get("Mounts") or []:
        if mount.get("Destination") == CONFIG_PATH:
            return str(mount["Source"])
    raise RuntimeError(f"Deepwell container has no {CONFIG_PATH} mount")


def runtime_environment(inspected: dict[str, object]) -> dict[str, str]:
    environment = {}
    for entry in (inspected.get("Config") or {}).get("Env") or []:
        key, _, value = entry.partition("=")
        if key.startswith("DEEPWELL_RENDER") or key == "DEEPWELL_RUNTIME_ACTION":
            continue
        environment[key] = value
    for required in ("DATABASE_URL", "REDIS_URL", "DEEPWELL_RPC_TOKEN"):
        if required not in environment:
            raise RuntimeError(f"Deepwell container environment lacks {required}")
    return environment


def render_ahead_settings(
    concurrency: int,
    batch_size: int,
    not_before: str | None,
    page_ids: list[int] | None = None,
    dry_run: bool = False,
) -> dict[str, str]:
    settings = {
        "DEEPWELL_RUNTIME_ACTION": "render-ahead",
        "DEEPWELL_RENDER_AHEAD_DRY_RUN": "true" if dry_run else "false",
        "DEEPWELL_RENDER_AHEAD_CONCURRENCY": str(concurrency),
        "DEEPWELL_RENDER_AHEAD_BATCH_SIZE": str(batch_size),
    }
    if not_before is not None:
        settings["DEEPWELL_RENDER_AHEAD_NOT_BEFORE"] = not_before
    if page_ids is not None:
        if not page_ids:
            raise ValueError("a page-limited render-ahead run needs page IDs")
        settings["DEEPWELL_RENDER_AHEAD_PAGE_IDS"] = ",".join(map(str, page_ids))
    return settings


def failures_only(summary: dict[str, object], markers: tuple[str, ...]) -> bool:
    failures = summary["failures"]
    return len(failures) == summary["failed"] and all(
        any(marker in failure["error"] for marker in markers)
        for failure in failures
    )


def deadline_only(summary: dict[str, object]) -> bool:
    """Whether every failure of a pass is the renderer deadline."""
    return failures_only(summary, DEADLINE_MARKERS)


def tail_retryable_only(summary: dict[str, object]) -> bool:
    """Whether every failure of a pass is the renderer deadline or a
    transient storage timeout: the two classes the tail retries exist for."""
    return failures_only(summary, TAIL_RETRY_MARKERS)


def config_with_render_timeout(config: str, timeout_ms: int) -> str:
    matches = RENDER_TIMEOUT.findall(config)
    if len(matches) != 1:
        raise ValueError("Deepwell config must set render-timeout-ms exactly once")
    return RENDER_TIMEOUT.sub(f"render-timeout-ms = {timeout_ms}", config)


def parse_summary(output: str, dry_run: bool = False) -> dict[str, object]:
    summaries = []
    for line in output.splitlines():
        if not line.startswith("{"):
            continue
        value = json.loads(line)
        if value.get("action") == "render-ahead":
            summaries.append(value)
    if len(summaries) != 1:
        raise RuntimeError("render-ahead did not print exactly one summary")
    summary = summaries[0]
    if summary.get("dry_run") is not dry_run:
        raise RuntimeError("render-ahead summary does not match the requested mode")
    return summary


def psql(database_container: str, sql: str) -> str:
    return run(
        "docker",
        "exec",
        "-i",
        database_container,
        "sh",
        "-c",
        'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -U "$POSTGRES_USER" '
        '-d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 --single-transaction',
        input_text=sql,
    ).strip()


def link_digests(database_container: str) -> dict[str, str]:
    rows = psql(database_container, LINK_DIGEST_QUERY).splitlines()
    return dict(row.split("|", 1) for row in rows)


def changed_pages(before: dict[str, str], after: dict[str, str]) -> list[int]:
    return sorted(int(page) for page in before.keys() | after.keys() if before.get(page) != after.get(page))


def live_page_ids(database_container: str) -> list[int]:
    """Every live page ID, ascending. The sharding superset: see LIVE_PAGE_IDS_QUERY."""
    return [int(line) for line in psql(database_container, LIVE_PAGE_IDS_QUERY).splitlines()]


def split_shards(page_ids: list[int], shards: int) -> list[list[int]]:
    """Split page IDs into contiguous non-empty chunks for concurrent shards.

    Chunks are disjoint, preserve ascending order, and cover every input ID,
    so each live page renders in exactly one shard. Never emits an empty
    chunk: the image rejects an empty page-ID list.
    """
    if shards < 1:
        raise ValueError("shards must be positive")
    if shards == 1:
        return [list(page_ids)]
    width, remainder = divmod(len(page_ids), shards)
    chunks = []
    start = 0
    for index in range(shards):
        stop = start + width + (1 if index < remainder else 0)
        if stop > start:
            chunks.append(page_ids[start:stop])
        start = stop
    return chunks


def merge_summaries(summaries: list[dict[str, object]]) -> dict[str, object]:
    """Merge concurrent shard summaries into one pass-shaped summary.

    Counts add up; page-ID sets union; verbose failure details truncate the
    way the image truncates them, while `failed_page_ids` stays complete for
    the tail-retry path. Shards must agree on generator, action mode, and
    settings: a skew means the shards did not render the same thing, so the
    run must stop rather than merge.
    """
    if not summaries:
        raise ValueError("merging needs at least one shard summary")
    first = summaries[0]
    for key in ("compiled_generator", "action", "dry_run", "batch_size", "concurrency"):
        values = {summary[key] for summary in summaries}
        if len(values) != 1:
            raise RuntimeError(f"shard summaries disagree on {key}: {sorted(map(str, values))}")
    elapsed = [summary["elapsed_ms"] for summary in summaries]
    if not all(isinstance(value, int) for value in elapsed):
        raise RuntimeError("shard summaries must report integer elapsed_ms")
    failures: list[object] = []
    for summary in summaries:
        details = summary["failures"]
        if not isinstance(details, list):
            raise RuntimeError("shard summaries must report a failures list")
        failures.extend(details)
    slowest: list[dict[str, object]] = []
    for summary in summaries:
        entries = summary["slowest_renders"]
        if not isinstance(entries, list):
            raise RuntimeError("shard summaries must report a slowest_renders list")
        slowest.extend(entries)
    slowest.sort(key=lambda entry: (-entry["elapsed_ms"], entry["page_id"]))
    rendered = sum(summary["rendered"] for summary in summaries)
    wall_ms = max(elapsed)
    return {
        **first,
        "candidates": sum(summary["candidates"] for summary in summaries),
        "rendered": rendered,
        "failed": sum(summary["failed"] for summary in summaries),
        "failed_page_ids": sorted(
            {page for summary in summaries for page in summary["failed_page_ids"]}
        ),
        "link_reader_page_ids": sorted(
            {page for summary in summaries for page in summary["link_reader_page_ids"]}
        ),
        "stale_without_valid_ahead": sum(
            summary["stale_without_valid_ahead"] for summary in summaries
        ),
        "elapsed_ms": wall_ms,
        "rows_per_sec": rendered / (wall_ms / 1000) if wall_ms > 0 else 0.0,
        "failures": failures[:MAX_REPORTED_FAILURES],
        "slow_renders": sum(summary["slow_renders"] for summary in summaries),
        "slowest_renders": slowest[:MAX_REPORTED_FAILURES],
    }


def record_pass(
    passes: list[dict[str, object]],
    name: str,
    settings: dict[str, str],
    extended: bool,
    duration_seconds: float,
    summary: dict[str, object],
) -> None:
    """Append one pass entry, splitting controller overhead out of the total.

    `overhead_seconds` is the wall-clock the image did not spend rendering:
    container startup, environment handling, and log capture. It is the only
    part of a pass the controller can shrink without touching the renderer.
    """
    elapsed_ms = summary["elapsed_ms"]
    if not isinstance(elapsed_ms, int):
        raise RuntimeError("pass summary must report integer elapsed_ms")
    passes.append(
        {
            "pass": name,
            "settings": {
                key: value for key, value in settings.items() if key != "DEEPWELL_RUNTIME_ACTION"
            },
            "config": "extended-deadline" if extended else "serving",
            "duration_seconds": duration_seconds,
            "overhead_seconds": duration_seconds - elapsed_ms / 1000,
            "summary": summary,
        }
    )


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def render_pass(
    image: str,
    deepwell_container: str,
    config_source: str,
    environment: dict[str, str],
    settings: dict[str, str],
    log_path: Path,
) -> dict[str, object]:
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", prefix="render-ahead-env.", delete=False
    ) as env_file:
        os.chmod(env_file.name, 0o600)
        for key, value in {**environment, **settings}.items():
            if "\n" in value:
                raise ValueError(f"{key} is not a single-line environment value")
            env_file.write(f"{key}={value}\n")
    try:
        result = subprocess.run(
            (
                "docker",
                "run",
                "--rm",
                "--network",
                f"container:{deepwell_container}",
                "--env-file",
                env_file.name,
                "--volume",
                f"{config_source}:{CONFIG_PATH}:ro",
                "--entrypoint",
                DEEPWELL_BINARY,
                image,
                CONFIG_PATH,
            ),
            check=False,
            text=True,
            capture_output=True,
        )
    finally:
        os.unlink(env_file.name)
    log_path.write_text(result.stdout + result.stderr, encoding="utf-8")
    if result.returncode != 0:
        raise RuntimeError(f"render-ahead exited {result.returncode}; see {log_path}")
    return parse_summary(
        result.stdout, settings["DEEPWELL_RENDER_AHEAD_DRY_RUN"] == "true"
    )


def link_readers(summary: dict[str, object]) -> set[int]:
    """Pages of one pass whose render read the link graph."""
    readers = summary.get("link_reader_page_ids")
    if not isinstance(readers, list):
        raise RuntimeError(
            "the render image does not report link readers; it predates this tool"
        )
    return set(readers)


def render_with_deadline_tail(render, name, cutoff, pages=None):
    """Render, then retry pages that only missed the serving deadline or hit
    a transient storage timeout: alone, then once with the extended deadline.
    Returns how many pages the first pass selected and every pass's link
    readers."""
    summary = render(name, cutoff, pages)
    selected = summary["candidates"]
    readers = link_readers(summary)
    for tail, extended in (("tail-serial", False), ("tail-extended-deadline", True)):
        failed = summary["failed_page_ids"]
        if not failed:
            break
        if not tail_retryable_only(summary):
            raise RuntimeError(
                f"{name} has failures other than the render deadline "
                "or a transient storage timeout"
            )
        # Alone, a page must meet the serving deadline; with the extended
        # deadline nothing is racing it, so those renders run side by side.
        summary = render(f"{name}-{tail}", cutoff, failed, serial=not extended, extended=extended)
        readers |= link_readers(summary)
    if summary["failed_page_ids"]:
        raise RuntimeError(
            f"{name} could not render pages even with the extended deadline: "
            f"{summary['failed_page_ids'][:20]}"
        )
    return selected, readers


def render_full_sharded(render, name, cutoff, chunks, *, serial=False, extended=False):
    """Render one logical pass as concurrent disjoint page-ID shards.

    Each chunk runs through the same `render` callable as the serial path, so
    settings, log files, and summary shapes keep their meaning; chunks are
    recorded as `<name>-shard-<index>` in index order for a deterministic
    summary. Returns the merged summary, shaped like one pass summary for
    the settle loop and the tail-retry path. A shard failure stops the run:
    still-queued shards are cancelled and the first error propagates, so a
    partial shard can never be mistaken for a complete pass.
    """
    if not chunks:
        raise ValueError("sharding needs at least one chunk")
    if any(not chunk for chunk in chunks):
        raise ValueError("shard chunks must be non-empty")
    results: dict[int, dict[str, object]] = {}
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(chunks)) as pool:
        pending = {
            pool.submit(
                render, f"{name}-shard-{index}", cutoff, chunk,
                serial=serial, extended=extended,
            ): index
            for index, chunk in enumerate(chunks)
        }
        try:
            for future in concurrent.futures.as_completed(pending):
                results[pending[future]] = future.result()
        except BaseException:
            pool.shutdown(cancel_futures=True)
            raise
    return merge_summaries([results[index] for index in sorted(results)])


def _digest_snapshot(digests, timings=None):
    """A link-digest snapshot function that times itself into `timings`.

    The snapshots scan the whole link graph, so their cost is the
    controller-side counterpart to the render passes.
    """
    def snapshot(stage):
        started = time.monotonic()
        try:
            return digests()
        finally:
            if timings is not None:
                timings.append({"stage": stage, "digest_seconds": time.monotonic() - started})

    return snapshot


def _settle_link_readers(render, snapshot, readers, changed, *, pass_prefix, stage_prefix):
    """Render the link readers until a round leaves every link unchanged.

    A reader may have observed links before another render rewrote them, so
    the readers render again, alone, while digests keep moving. Fails closed
    when the graph never settles: a continually moving reader cannot be
    declared safe without dependency provenance proving that its output is
    independent of those changes. Returns the accumulated reader set and the
    pages whose links changed in every round.
    """
    readers = set(readers)
    changed = set(changed)
    moving: set[int] | None = None
    for number in range(1, MAX_READER_ROUNDS + 1):
        if not changed or not readers:
            return sorted(readers), sorted(moving or ())
        links_before = snapshot(f"links-before-{stage_prefix}readers-{number}")
        requested = sorted(readers)
        selected, round_readers = render_with_deadline_tail(
            render, f"{pass_prefix}link-readers-{number}", utc_now(), requested
        )
        if selected != len(requested):
            raise RuntimeError(
                f"link-reader round {number} selected {selected} of "
                f"{len(requested)} reader pages: {requested[:20]}"
            )
        readers |= round_readers
        changed = set(changed_pages(links_before, snapshot(f"links-after-{stage_prefix}readers-{number}")))
        moving = changed if moving is None else moving & changed
    if changed:
        suspected_stochastic = changed & (moving or set())
        raise RuntimeError(
            f"links of {len(changed)} pages did not settle after "
            f"{MAX_READER_ROUNDS} link-reader rounds: {sorted(changed)[:20]}; "
            f"{len(suspected_stochastic)} changed in every round. "
            "A subsequent reader may have observed an earlier link snapshot"
        )
    return sorted(readers), []


def render_until_links_settle(render, digests, cutoff, timings=None):
    """Render every stale page once, then the link readers until their links
    settle. Every successful run ends with an unchanged graph: a reader may
    have observed links before another concurrent reader rewrote them. A
    continually moving reader cannot be declared safe without dependency
    provenance proving that its output is independent of those changes.

    When `timings` is a list, each link-digest snapshot appends its stage
    and wall-clock there.
    """
    snapshot = _digest_snapshot(digests, timings)

    links_before = snapshot("links-before-full")
    _, readers = render_with_deadline_tail(render, "full", cutoff)
    changed = set(changed_pages(links_before, snapshot("links-after-full")))
    return _settle_link_readers(
        render, snapshot, readers, changed, pass_prefix="", stage_prefix=""
    )


def image_identity(image: str) -> str:
    image_id = run("docker", "image", "inspect", "--format", "{{.Id}}", image).strip()
    if IMAGE_ID.fullmatch(image_id) is None:
        raise RuntimeError(f"{image} has no immutable image ID")
    return image_id



def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--image", required=True, help="Deepwell image ID to render with")
    parser.add_argument("--deepwell-container", default="wikijump-standing-deepwell-1")
    parser.add_argument("--database-container", default="wikijump-standing-database-1")
    parser.add_argument("--concurrency", type=int, default=16)
    parser.add_argument("--batch-size", type=int, default=200)
    parser.add_argument(
        "--shards",
        type=int,
        default=1,
        help="concurrent full-pass shards over the live page-ID space; "
        "1 keeps the historical single full pass",
    )
    parser.add_argument(
        "--tail-render-timeout-ms",
        type=int,
        default=300_000,
        help="one-shot deadline for pages that still miss the serving deadline alone",
    )
    parser.add_argument("--output-dir", type=Path, required=True)
    return parser.parse_args()


# A live wiki keeps taking edits while render-ahead runs. A page written
# after the cutoff has no valid ahead render yet, so verify would report it
# stale and fail the promotion. Render just those pages and verify again,
# a bounded number of times, before calling the run incomplete. A catch-up
# render can itself move the link graph, so the readers are settled again
# afterwards (see verify_with_catch_up).
CATCH_UP_ROUNDS = 3


def verify_with_catch_up(
    render,
    cutoff,
    digests=None,
    timings=None,
    readers=(),
    rounds: int = CATCH_UP_ROUNDS,
) -> dict[str, object]:
    """Verify the whole site, rendering pages written during the run first.

    When `digests` is given, the catch-up renders are bracketed by link
    digests: an edit caught up here can move the link graph after the main
    pass's readers already settled, leaving those readers with a stale link
    view. If any digest moved, the known readers (`readers` from the main
    pass plus any the catch-up renders report) render again until the graph
    settles, and a final verify confirms the settle left nothing stale
    (#2738). Without `digests` the historical behavior is kept.
    """
    final = render("verify", cutoff, dry_run=True)
    snapshot = _digest_snapshot(digests, timings) if digests is not None else None
    links_before_catch_up: dict[str, str] | None = None
    caught_up_readers: set[int] = set()
    for round_number in range(1, rounds + 1):
        if final["stale_without_valid_ahead"] == 0:
            break
        if snapshot is not None and links_before_catch_up is None:
            links_before_catch_up = snapshot("links-before-catch-up")
        summary = render(f"catch-up-{round_number}", cutoff)
        if snapshot is not None:
            caught_up_readers |= link_readers(summary)
        final = render(f"verify-{round_number}", cutoff, dry_run=True)
    if (
        snapshot is None
        or links_before_catch_up is None
        or final["stale_without_valid_ahead"] != 0
    ):
        return final
    changed = set(
        changed_pages(links_before_catch_up, snapshot("links-after-catch-up"))
    )
    known_readers = set(readers) | caught_up_readers
    if not changed or not known_readers:
        return final
    _settle_link_readers(
        render,
        snapshot,
        known_readers,
        changed,
        pass_prefix="catch-up-",
        stage_prefix="catch-up-",
    )
    return render("verify-after-catch-up", cutoff, dry_run=True)


def main() -> int:
    args = parse_args()
    if min(args.concurrency, args.batch_size, args.tail_render_timeout_ms, args.shards) < 1:
        raise ValueError("numeric options must be positive")
    image_id = image_identity(args.image)
    args.output_dir.mkdir(mode=0o700, parents=True, exist_ok=False)
    started_at = datetime.now(UTC)
    started = time.monotonic()

    inspected = container_inspect(args.deepwell_container)
    serving_image_id = str(inspected.get("Image"))
    if serving_image_id == image_id:
        raise ValueError("the serving Deepwell already runs the render-ahead image")
    environment = runtime_environment(inspected)
    config_source = config_mount(inspected)

    migration = run("docker", "run", "--rm", "--entrypoint", "cat", image_id, MIGRATION_PATH)
    require_idempotent_migration(migration)
    psql(args.database_container, migration)

    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", prefix="render-ahead-config.", suffix=".toml", delete=False
    ) as config_file:
        config_file.write(
            config_with_render_timeout(
                Path(config_source).read_text(encoding="utf-8"),
                args.tail_render_timeout_ms,
            )
        )
    os.chmod(config_file.name, 0o644)
    extended_config = config_file.name

    passes: list[dict[str, object]] = []

    def render(name, cutoff, pages=None, *, serial=False, extended=False, dry_run=False):
        settings = render_ahead_settings(
            1 if serial else args.concurrency, args.batch_size, cutoff, pages, dry_run
        )
        pass_started = time.monotonic()
        summary = render_pass(
            image_id,
            args.deepwell_container,
            extended_config if extended else config_source,
            environment,
            settings,
            args.output_dir / f"{name}.log",
        )
        record_pass(passes, name, settings, extended, time.monotonic() - pass_started, summary)
        return summary

    # Shard the full pass only: reader rounds, deadline tail retries, and
    # the dry-run verify address explicit page lists or the whole site, so
    # they keep the single-invocation path. With one shard the wrapper below
    # is never installed and the run is the historical single full pass.
    chunks = (
        split_shards(live_page_ids(args.database_container), args.shards)
        if args.shards > 1
        else []
    )

    def settle_render(name, cutoff, pages=None, *, serial=False, extended=False, dry_run=False):
        if pages is None and not dry_run and len(chunks) > 1:
            return render_full_sharded(render, name, cutoff, chunks)
        return render(name, cutoff, pages, serial=serial, extended=extended, dry_run=dry_run)

    # Rows rendered before this run started are not accepted: only this
    # run's passes know which pages read links.
    cutoff = utc_now()
    digest_timings: list[dict[str, float]] = []
    try:
        readers, nondeterministic = render_until_links_settle(
            settle_render, lambda: link_digests(args.database_container), cutoff, digest_timings
        )
        # Verify the whole site, not just the last pass's pages, after
        # catching up on pages written while the run was in progress.
        final = verify_with_catch_up(
            render,
            cutoff,
            digests=lambda: link_digests(args.database_container),
            timings=digest_timings,
            readers=readers,
        )
    finally:
        os.unlink(extended_config)
    summary = {
        "schema": SUMMARY_SCHEMA,
        "status": "pass" if final["stale_without_valid_ahead"] == 0 else "incomplete",
        "started_at": started_at.isoformat(),
        "completed_at": datetime.now(UTC).isoformat(),
        "duration_seconds": time.monotonic() - started,
        "render_image_id": image_id,
        "serving_image_id": serving_image_id,
        "compiled_generator": final["compiled_generator"],
        "deepwell_container": args.deepwell_container,
        "database_container": args.database_container,
        "migration_sha256": hashlib.sha256(migration.encode()).hexdigest(),
        "tail_render_timeout_ms": args.tail_render_timeout_ms,
        "shards": args.shards,
        "passes": passes,
        "link_digest_timings": digest_timings,
        "unrendered_page_ids": [],
        "link_reader_page_ids": readers,
        "nondeterministic_link_page_ids": nondeterministic,
        "stale_without_valid_ahead": final["stale_without_valid_ahead"],
    }
    summary_path = args.output_dir / "render-ahead-summary.json"
    with summary_path.open("x", encoding="utf-8") as output:
        json.dump(summary, output, indent=2, sort_keys=True)
        output.write("\n")
    print(
        json.dumps(
            {
                key: summary[key]
                for key in ("status", "duration_seconds", "stale_without_valid_ahead")
            }
        )
    )
    return 0 if summary["status"] == "pass" else 1


if __name__ == "__main__":
    raise SystemExit(main())
