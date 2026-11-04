#!/usr/bin/env python3
"""Promote the merged develop head to the standing runtime.

One command, in this order; each stage blocks the next and a failure leaves
standing as it was (or restores it):

1. identity       the checkout is clean and exactly the fetched
                  origin/develop.
2. build          the three application images, from BuildKit caches.
3. rehearsal      when activation cannot be undone by restarting the old
                  containers (new migrations or a new renderer generation),
                  the new images start on a copy of standing's data and must
                  pass the same freshness, HTTP and browser checks first.
4. live-migration the candidate's pending Deepwell migrations are applied
                  to the live database with the candidate image's own sqlx,
                  while the previous release keeps serving. A migration in
                  a promoted head therefore runs against the previous
                  release, so it must be backward-compatible with it
                  (expand first: add nullable columns or new tables; drop
                  or rename only in a later promotion, once no serving
                  code reads the old shape).
5. render-ahead   when the renderer generation changes, every saved page
                  is rendered with the new image while the old one keeps
                  serving. It runs after live-migration because the new
                  renderer reads the live database.
6. activation     park the old containers, start the new ones, require
                  health, reload Caddy from the new Deepwell, zero stale
                  saved pages, the HTTP canary and the standing browser
                  parity; restore the parked containers (and reload Caddy
                  from them) on any failure.

"""

from __future__ import annotations

import argparse
import concurrent.futures
import contextlib
from datetime import UTC, datetime, timedelta
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import time

import refresh
import render_ahead


SERVICES = refresh.SERVICES
VERIFICATION = Path("install/local/wikidot-verification")
STANDING_DATABASE = "wikijump-standing-database-1"
STANDING_DEEPWELL = "wikijump-standing-deepwell-1"
STANDING_CACHE = "wikijump-standing-cache-1"
STANDING_NAMESPACE = "wikijump-standing-caddy-1"
STANDING_FILES_VOLUME = "wikijump-standing-files-data"
TEXT_BLOCKS_BUCKET = "deepwell-text-blocks"
RESOURCE_LIFETIME = timedelta(days=30)
BROWSER_REFERENCE_SCHEMA = "wikijump.standing_browser_reference.v1"
GIT_OBJECT = re.compile(r"[0-9a-f]{40}")


def state_root() -> Path:
    return refresh.DEFAULT_RUNTIME_HOME.parent


def run(*args: str, cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    result = subprocess.run(
        args, cwd=cwd, env=env, check=True, text=True, capture_output=True
    )
    return result.stdout.strip()


def run_logged(args: list[str], log: Path, cwd: Path, env: dict[str, str] | None = None) -> str:
    """Run a step, keep its output in the evidence directory, and return
    stdout; a failure names the log."""
    with log.open("w", encoding="utf-8") as output:
        result = subprocess.run(
            args, cwd=cwd, env=env, text=True, stdout=subprocess.PIPE, stderr=output
        )
        output.write(result.stdout)
    if result.returncode != 0:
        raise RuntimeError(f"{Path(args[1]).name if len(args) > 1 else args[0]} failed; see {log}")
    return result.stdout


def last_json_line(stdout: str) -> dict[str, object]:
    for line in reversed(stdout.splitlines()):
        if line.startswith("{"):
            return json.loads(line)
    raise RuntimeError("step printed no JSON result")


def check_framerail_image_loads(image: str, log: Path, cwd: Path) -> None:
    try:
        run_logged(
            [
                "docker", "run", "--rm", "--network", "none",
                "--entrypoint", "node", image,
                "--input-type=module", "-e", 'await import("/app/server.ts")',
            ],
            log,
            cwd,
        )
    except RuntimeError:
        raise RuntimeError(
            f"the built framerail image cannot load /app/server.ts; see {log}"
        ) from None


class Stages:
    """Run named stages and report each one's duration."""

    def __init__(self) -> None:
        self.started = time.monotonic()

    def run(self, name: str, action):
        started = time.monotonic()
        print(f"promote: {name} ...", file=sys.stderr, flush=True)
        result = action()
        print(
            f"promote: {name} pass in {time.monotonic() - started:.0f}s",
            file=sys.stderr,
            flush=True,
        )
        return result

    def elapsed(self) -> float:
        return time.monotonic() - self.started


# Validation coverage



def changed_paths(source_root: Path, before: str, after: str) -> list[str]:
    return run(
        "git", "diff", "--no-renames", "--name-only", before, after, cwd=source_root
    ).splitlines()


# Rehearsal


def rehearsal_reason(mode: str, migrations: list[str]) -> str | None:
    """Why activation must be rehearsed first, or None when a failed
    activation can be undone. New migrations cannot be: the old build's
    migration check refuses a schema it does not know, so the parked
    containers would not start again. A renderer generation change can,
    because activation keeps the replaced saved-page output (see
    `snapshot_saved_page_output`)."""
    if migrations:
        return "the schema migrations change"
    if mode == "always":
        return "requested"
    return None


# Live migration


SQLX_BINARY = "/usr/local/bin/sqlx"
MIGRATIONS_IN_IMAGE = "/opt/deepwell/migrations"
MIGRATION_FILENAME = re.compile(r"^([0-9]+)_.+\.sql$")


def migration_version(filename: str) -> int:
    match = MIGRATION_FILENAME.match(Path(filename).name)
    if match is None:
        raise ValueError(f"not a Deepwell migration filename: {filename}")
    return int(match.group(1))


def candidate_migration_files(source_root: Path) -> list[str]:
    directory = source_root / "deepwell" / "migrations"
    return sorted(path.name for path in directory.glob("*.sql"))


def pending_migration_files(candidate: list[str], applied_versions: set[int]) -> list[str]:
    """Candidate migrations the database has not recorded, in the order
    sqlx applies them."""
    return [
        name for name in sorted(candidate) if migration_version(name) not in applied_versions
    ]


def applied_migration_versions(database: str = STANDING_DATABASE) -> set[int]:
    present = psql(
        database, "SELECT to_regclass('public._sqlx_migrations') IS NOT NULL;\n"
    ).split()
    if present != ["t"]:
        return set()
    rows = psql(
        database, "SELECT version FROM _sqlx_migrations WHERE success ORDER BY version;\n"
    )
    return {int(value) for value in rows.split()}


@contextlib.contextmanager
def one_off_env_file(environment: dict[str, str]):
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", prefix="live-migration-env.", delete=False
    ) as env_file:
        os.chmod(env_file.name, 0o600)
        for key, value in environment.items():
            if "\n" in value:
                raise ValueError(f"{key} is not a single-line environment value")
            env_file.write(f"{key}={value}\n")
    try:
        yield Path(env_file.name)
    finally:
        os.unlink(env_file.name)


def apply_live_migrations(
    image: str,
    source_root: Path,
    log: Path,
    changed_migrations: list[str] | tuple[str, ...] = (),
    database: str = STANDING_DATABASE,
    deepwell: str = STANDING_DEEPWELL,
) -> dict[str, object]:
    """Apply the candidate's pending migrations to the live database.

    This is the mechanism activation's Deepwell uses, run early: a one-off
    container from the candidate image runs its own
    `sqlx migrate run --source /opt/deepwell/migrations`, which records
    version and checksum in `_sqlx_migrations` and is a no-op when nothing
    is pending. The container joins the serving Deepwell's network
    namespace and copies its environment, so `DATABASE_URL` is standing's
    own and no second credential path exists. It runs while the previous
    release keeps serving, so the migrations it applies must be
    backward-compatible with that release (see the module docstring).
    A changed migration file with no pending version still runs sqlx, so a
    checksum drift against an applied migration fails here instead of at
    activation."""
    candidate = candidate_migration_files(source_root)
    pending = pending_migration_files(candidate, applied_migration_versions(database))
    if not pending and not changed_migrations:
        return {"status": "no-op", "pending": [], "applied": []}
    inspected = render_ahead.container_inspect(deepwell)
    environment = render_ahead.runtime_environment(inspected)
    try:
        with one_off_env_file(environment) as env_file:
            run_logged(
                [
                    "docker", "run", "--rm",
                    "--network", f"container:{deepwell}",
                    "--env-file", str(env_file),
                    "--entrypoint", SQLX_BINARY,
                    image, "migrate", "run", "--source", MIGRATIONS_IN_IMAGE,
                ],
                log,
                source_root,
            )
    except RuntimeError:
        raise RuntimeError(
            f"applying the candidate migrations to the standing database failed; see {log}"
        ) from None
    remaining = pending_migration_files(candidate, applied_migration_versions(database))
    if remaining:
        raise RuntimeError(
            "the standing database is still missing migrations after the "
            f"live-migration stage: {', '.join(remaining)}"
        )
    return {"status": "pass", "pending": pending, "applied": pending}


def free_port() -> int:
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


def clone_standing_database(volume: str) -> None:
    """Copy the standing database with pg_basebackup into a new volume.

    The copy is physical and consistent at one point in time; standing keeps
    serving. The helper joins standing's network namespace and reads the
    replication password from the database container's own environment."""
    image = run("docker", "inspect", "--format", "{{.Image}}", STANDING_DATABASE)
    run("docker", "volume", "create", "--label", "com.rokurolize.wikijump.owner=standing-rehearsal", volume)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as env_file:
        os.chmod(env_file.name, 0o600)
        env_file.write(
            "PGPASSWORD="
            + run("docker", "exec", STANDING_DATABASE, "printenv", "POSTGRES_PASSWORD")
            + "\n"
        )
    try:
        run(
            "docker", "run", "--rm", "--user", "postgres",
            "--network", f"container:{STANDING_NAMESPACE}",
            "--env-file", env_file.name,
            "--volume", f"{volume}:/var/lib/postgresql/data",
            "--entrypoint", "pg_basebackup",
            image,
            "--host", "127.0.0.1", "--username", "wikijump",
            "--pgdata", "/var/lib/postgresql/data",
            "--format", "plain", "--wal-method", "stream", "--checkpoint", "fast",
        )
    finally:
        os.unlink(env_file.name)


def overlay_standing_files(volume: str, upper_volume: str) -> None:
    """A copy-on-write view of the standing object store.

    The rehearsal's writes land in `upper_volume`; standing's volume is only
    the read-only lower layer. Rendering a page replaces its hosted text
    blocks and deletes the old objects, so standing's render-ahead and
    ordinary edits would remove, from the shared lower layer, objects the
    cloned database still names (#2650). The text-block bucket is small, so
    it is copied up front and pinned to the moment of the clone; files stay
    shared."""
    lower = run(
        "docker", "volume", "inspect", "--format", "{{.Mountpoint}}", STANDING_FILES_VOLUME
    )
    run("docker", "volume", "create", "--label", "com.rokurolize.wikijump.owner=standing-rehearsal", upper_volume)
    upper_root = run("docker", "volume", "inspect", "--format", "{{.Mountpoint}}", upper_volume)
    helper = run("docker", "inspect", "--format", "{{.Image}}", STANDING_DATABASE)
    run(
        "docker", "run", "--rm", "--network", "none", "--entrypoint", "mkdir",
        "--volume", f"{upper_volume}:/upper", helper, "/upper/data", "/upper/work",
    )
    run(
        "docker", "run", "--rm", "--network", "none", "--entrypoint", "cp",
        "--volume", f"{STANDING_FILES_VOLUME}:/lower:ro",
        "--volume", f"{upper_volume}:/upper", helper,
        "-a", f"/lower/{TEXT_BLOCKS_BUCKET}", "/upper/data/",
    )
    run(
        "docker", "volume", "create", "--driver", "local",
        "--label", "com.rokurolize.wikijump.owner=standing-rehearsal",
        "--opt", "type=overlay", "--opt", "device=overlay",
        "--opt", f"o=lowerdir={lower},upperdir={upper_root}/data,workdir={upper_root}/work",
        volume,
    )


def deepwell_log_lines(since: datetime) -> int:
    """Lines standing's Deepwell has logged since a moment, both streams."""
    result = subprocess.run(
        ["docker", "logs", "--since", since.strftime("%Y-%m-%dT%H:%M:%SZ"), STANDING_DEEPWELL],
        capture_output=True, text=True, check=True,
    )
    return len(result.stdout.splitlines()) + len(result.stderr.splitlines())


@contextlib.contextmanager
def deepwell_paused_for_clone():
    """Freeze standing's Deepwell while the rehearsal clone is taken.

    Deepwell is the only writer of text_block rows and their objects, and
    its deferred re-render fan-out replaces them continuously. A
    replacement uploads the new objects, commits the new rows, and only
    then deletes the old objects (the cleanup is deferred past the
    commit), so standing is consistent at every instant -- but the
    database copy (pg_basebackup) and the text-block bucket copy are
    taken at different moments, and a re-render landing between them
    leaves the rehearsal database naming objects its file copy lacks.

    Pausing the container freezes both stores at one instant, and any
    instant is a consistent one for that write order: an uncommitted
    replacement still has its old objects, and a committed one already
    has its new objects. The pause covers exactly the clone segment; the
    finally path always resumes the container, and the resume is verified
    before the promotion continues.
    """
    started = datetime.now(UTC)
    run("docker", "pause", STANDING_DEEPWELL)
    try:
        # A paused container produces no new log lines; two equal samples
        # prove the render fan-out has actually stopped before the clone.
        time.sleep(3)
        lines = deepwell_log_lines(started)
        time.sleep(3)
        if deepwell_log_lines(started) != lines:
            raise RuntimeError(
                "standing Deepwell kept logging while paused for the rehearsal clone"
            )
        yield started
    finally:
        run("docker", "unpause", STANDING_DEEPWELL)
        state = run(
            "docker", "inspect", "--format",
            "{{.State.Paused}} {{.State.Running}}", STANDING_DEEPWELL,
        )
        resumed = datetime.now(UTC)
        print(
            "standing Deepwell paused for the rehearsal clone: "
            f"{started.isoformat()} .. {resumed.isoformat()}",
            flush=True,
        )
        if state != "false true":
            raise RuntimeError(
                f"standing Deepwell did not resume after the rehearsal clone pause: {state}"
            )


def missing_text_blocks(database_container: str, files_container: str) -> list[str]:
    """Hosted text blocks the database names but its object store lacks.

    Each key is checked as a stored object directory in the bucket; the
    object store image has a shell but no find."""
    keys = psql(database_container, "SELECT s3_filename FROM text_block ORDER BY 1")
    return subprocess.run(
        [
            "docker", "exec", "-i", files_container, "sh", "-c",
            f'while IFS= read -r key; do [ -f "/data/{TEXT_BLOCKS_BUCKET}/$key/xl.meta" ] || echo "$key"; done',
        ],
        input=keys, check=True, text=True, capture_output=True,
    ).stdout.split()


def remove_volumes(*names: str) -> None:
    for name in names:
        subprocess.run(["docker", "volume", "rm", "--force", name], capture_output=True)


def _stale_saved_pages_from_where(
    expected: str, scp_wiki_slugs: list[str] | None = None
) -> str:
    """The one stale-page predicate, shared by the count and the ID query:
    a live page whose latest revision was not compiled by `expected`."""
    sql = (
        "FROM page p JOIN page_revision pr "
        "ON pr.revision_id = p.latest_revision_id WHERE p.deleted_at IS NULL "
        "AND pr.compiled_generator <> '" + expected.replace("'", "''") + "'"
    )
    if scp_wiki_slugs is not None:
        quoted = ", ".join("'" + slug.replace("'", "''") + "'" for slug in scp_wiki_slugs)
        sql += (
            " AND p.site_id = (SELECT site_id FROM site WHERE slug = 'scp-wiki')"
            f" AND p.slug IN ({quoted})"
        )
    return sql


def _psql_scalar(database_container: str, sql: str) -> str:
    return run(
        "docker", "exec", database_container, "sh", "-c",
        'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h 127.0.0.1 -U "$POSTGRES_USER" '
        '-d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 -c "$1"',
        "sh", sql,
    )


def saved_page_staleness(
    database_container: str, expected: str, scp_wiki_slugs: list[str] | None = None
) -> int:
    return int(
        _psql_scalar(
            database_container,
            "SELECT count(*) " + _stale_saved_pages_from_where(expected, scp_wiki_slugs),
        )
    )


def saved_page_stale_ids(database_container: str, expected: str) -> list[int]:
    """Page IDs failing the stale predicate, ascending."""
    output = _psql_scalar(
        database_container,
        "SELECT p.page_id " + _stale_saved_pages_from_where(expected) + " ORDER BY p.page_id",
    )
    return [int(value) for value in output.split()]


def database_clock(database: str = STANDING_DATABASE) -> str:
    """The database's clock, for comparing against `compiled_at` values
    the database-adjacent writers recorded."""
    return psql(database, "SELECT clock_timestamp();\n").splitlines()[0].strip()


SAVED_PAGE_OUTPUT_COLUMNS = (
    "revision_id",
    "compiled_body_html_hash",
    "compiled_body_styles_hash",
    "compiled_top_bar_html_hash",
    "compiled_side_bar_html_hash",
    "compiled_at",
    "compiled_generator",
)


def psql(container: str, script: str) -> str:
    return subprocess.run(
        [
            "docker", "exec", "-i", container, "sh", "-c",
            'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -q -h 127.0.0.1 -U "$POSTGRES_USER" '
            '-d "$POSTGRES_DB" -At -v ON_ERROR_STOP=1 --single-transaction',
        ],
        input=script, check=True, text=True, capture_output=True,
    ).stdout


def snapshot_saved_page_output(path: Path, database: str = STANDING_DATABASE) -> int:
    """Keep the compiled output that activating a new renderer generation
    replaces, so a failed activation can put it back for the old build
    instead of leaving every saved page stale to it."""
    columns = ", ".join(SAVED_PAGE_OUTPUT_COLUMNS)
    data = psql(
        database,
        f"COPY (SELECT {columns} FROM page_revision WHERE revision_id IN "
        "(SELECT latest_revision_id FROM page WHERE deleted_at IS NULL) "
        "ORDER BY revision_id) TO STDOUT;\n",
    )
    path.write_text(data, encoding="utf-8")
    os.chmod(path, 0o600)
    return len(data.splitlines())


def restore_saved_page_output(
    path: Path,
    promoted_generator: str,
    database: str = STANDING_DATABASE,
    cache: str = STANDING_CACHE,
    switch_started_at: str | None = None,
) -> int:
    """Put the snapshot back on revisions the new build has not rendered
    since (their generator is still the promoted one), and move every site's
    public-content fence so no cached response from the new build is served.

    Rows compiled at or after `switch_started_at` (the database clock
    captured before parking) are not restored: a post-flip in-place
    rerender already replaced their output, and the compiled-at guard
    pairs restored HTML with its own blocks — HTML reaches its hosted
    text blocks by (page, index) — so restoring would silently regress
    them under a generator the old build accepts. Post-rollback
    convergence renders those pages with the old build instead."""
    columns = ", ".join(SAVED_PAGE_OUTPUT_COLUMNS)
    assignments = ", ".join(f"{column} = saved.{column}" for column in SAVED_PAGE_OUTPUT_COLUMNS[1:])
    generator = promoted_generator.replace("'", "''")
    guard = ""
    if switch_started_at is not None:
        guard = (
            "AND page_revision.compiled_at < '"
            + switch_started_at.replace("'", "''")
            + "' "
        )
    output = psql(
        database,
        "CREATE TEMPORARY TABLE saved ON COMMIT DROP AS "
        f"SELECT {columns} FROM page_revision WITH NO DATA;\n"
        f"COPY saved ({columns}) FROM STDIN;\n"
        + path.read_text(encoding="utf-8")
        + "\\.\n"
        + f"WITH restored AS (UPDATE page_revision SET {assignments} FROM saved "
        "WHERE page_revision.revision_id = saved.revision_id "
        f"AND page_revision.compiled_generator = '{generator}' {guard}RETURNING 1) "
        "SELECT count(*) FROM restored;\n",
    )
    sites = psql(database, "SELECT site_id FROM site ORDER BY site_id;\n").split()
    for site_id in sites:
        run(
            "docker", "exec", cache, "valkey-cli", "INCR",
            f"deepwell:public-content:site:{site_id}:version",
        )
    return int(output.split()[-1])


def http_canary(url: str, resolve: str | None = None) -> dict[str, object]:
    args = ["curl", "--silent", "--show-error", "--fail", "--location", "--insecure", "--max-time", "30"]
    if resolve:
        args += ["--resolve", resolve]
    body = run(*args, url)
    if "scp-9506" not in body.lower() or "page-content" not in body:
        raise RuntimeError(f"canary {url} returned an unexpected document")
    return {"url": url, "status": "pass", "required_markers": ["scp-9506", "page-content"]}


# Caddy keeps port 443 across activation, but its routes come from Deepwell's
# `caddyfile` RPC, which its own cron only reloads every five minutes. Run the
# cron's command as the cron's user, then compare the loaded configuration
# with the adapted Caddyfile Deepwell renders now.
GATEWAY_RELOAD_SCRIPT = r"""set -e
/usr/local/bin/wikijump-update-caddyfile > /dev/null
rendered=$(mktemp)
trap 'rm -f "$rendered"' EXIT
curl -fsS http://deepwell:2747/jsonrpc -X POST \
	-H @/run/wikijump/deepwell-authorization-header \
	--json @/etc/caddy-request.json | jq -er .result > "$rendered"
expected=$(caddy adapt --config "$rendered" --adapter caddyfile 2> /dev/null | jq -S . | sha256sum)
loaded=$(curl -fsS http://localhost:2019/config/ | jq -S . | sha256sum)
echo "${expected%% *} ${loaded%% *}"
"""


def reload_gateway(attempts: int = 3, delay: float = 5.0) -> dict[str, object]:
    """Load the Caddyfile the running Deepwell renders into standing Caddy."""
    for attempt in range(1, attempts + 1):
        try:
            output = run(
                "docker", "exec", "--user", "daemon", STANDING_NAMESPACE,
                "sh", "-c", GATEWAY_RELOAD_SCRIPT,
            )
        except subprocess.CalledProcessError as error:
            if attempt == attempts:
                raise RuntimeError(f"gateway reload failed: {error.stderr.strip()}") from error
            time.sleep(delay)
            continue
        expected, loaded = output.split()
        if expected != loaded:
            raise RuntimeError("standing Caddy did not load the Caddyfile Deepwell renders")
        return {"status": "pass", "attempts": attempt, "config_sha256": loaded}
    raise AssertionError("unreachable")


def browser_canary_slugs(source_root: Path) -> list[str]:
    """The pages the browser parity loads, from its own canary contract."""
    return json.loads(
        run(
            "node", "--input-type=module", "-e",
            "const m = await import('./install/local/wikidot-verification/src/standing-browser-canaries.mjs');"
            "console.log(JSON.stringify(m.STANDING_BROWSER_CANARIES.map((c) => c.slug)));",
            cwd=source_root,
        )
    )


def rerender_rehearsal_pages(project: str, image: str, slugs: list[str]) -> dict[str, object]:
    """Render the canary pages on the rehearsal with its own configuration.

    The copied saved pages were rendered by standing, so their embedded URLs
    name standing's origin, which the rehearsal does not serve. Marking only
    these pages stale on the copy lets render-ahead render them with the new
    image and the rehearsal's configuration; restarting its Deepwell promotes
    them, as activation would."""
    database = f"{project}-database-1"
    deepwell = f"{project}-deepwell-1"
    quoted = ", ".join("'" + slug.replace("'", "''") + "'" for slug in slugs)
    page_ids = [
        int(value)
        for value in psql(
            database,
            "WITH canary AS (SELECT p.page_id, p.latest_revision_id FROM page p "
            "JOIN site s ON s.site_id = p.site_id "
            f"WHERE s.slug = 'scp-wiki' AND p.slug IN ({quoted}) AND p.deleted_at IS NULL), "
            "marked AS (UPDATE page_revision SET compiled_generator = 'rehearsal-rerender' "
            "WHERE revision_id IN (SELECT latest_revision_id FROM canary) RETURNING 1) "
            "SELECT page_id FROM canary;\n",
        ).split()
    ]
    if len(page_ids) != len(slugs):
        raise RuntimeError(f"the rehearsal has {len(page_ids)} of the {len(slugs)} canary pages")
    inspected = render_ahead.container_inspect(deepwell)
    migration = run("docker", "run", "--rm", "--entrypoint", "cat", image, render_ahead.MIGRATION_PATH)
    render_ahead.require_idempotent_migration(migration)
    render_ahead.psql(database, migration)
    with tempfile.TemporaryDirectory() as directory:
        summary = render_ahead.render_pass(
            image, deepwell,
            render_ahead.config_mount(inspected),
            render_ahead.runtime_environment(inspected),
            render_ahead.render_ahead_settings(len(page_ids), 200, render_ahead.utc_now(), page_ids),
            Path(directory) / "render.log",
        )
    if summary["rendered"] != len(page_ids) or summary["failed"]:
        raise RuntimeError(f"the rehearsal could not render its canary pages: {summary['failures']}")
    run("docker", "restart", deepwell)
    deadline = time.monotonic() + 300
    while run("docker", "inspect", "--format", "{{.State.Health.Status}}", deepwell) != "healthy":
        if time.monotonic() > deadline:
            raise RuntimeError("the rehearsal Deepwell did not become healthy after its restart")
        time.sleep(1)
    return {"pages": len(page_ids), "slugs": slugs}


# Activation catch-up and post-rollback convergence

# Total wall-clock bound for one convergence loop, on top of the round
# bound (`render_ahead.CATCH_UP_ROUNDS`) it reuses.
ACTIVATION_CATCH_UP_TIMEOUT_SECONDS = 900


def render_delta_pages(
    image: str,
    page_ids: list[int] | None,
    log_path: Path,
    *,
    dry_run: bool = False,
    database: str = STANDING_DATABASE,
    deepwell: str = STANDING_DEEPWELL,
) -> dict[str, object]:
    """Render `page_ids` into render-ahead rows with `image`, following
    `rerender_rehearsal_pages`: the image's idempotent render-ahead
    migration runs first (so this also works when the render-ahead stage
    was not needed), and the pass joins the running Deepwell's network
    namespace. A dry run renders nothing; its summary still carries the
    image's own `compiled_generator`."""
    if page_ids is not None and not page_ids and not dry_run:
        raise ValueError("a page-limited render needs page IDs")
    inspected = render_ahead.container_inspect(deepwell)
    migration = run("docker", "run", "--rm", "--entrypoint", "cat", image, render_ahead.MIGRATION_PATH)
    render_ahead.require_idempotent_migration(migration)
    render_ahead.psql(database, migration)
    summary = render_ahead.render_pass(
        image, deepwell,
        render_ahead.config_mount(inspected),
        render_ahead.runtime_environment(inspected),
        render_ahead.render_ahead_settings(
            # Cap concurrency at render-ahead's default: the delta can be
            # thousands of imported pages, and every task uses pool
            # connections on the live site.
            min(len(page_ids), 16) if page_ids else 16,
            200, render_ahead.utc_now(), page_ids, dry_run
        ),
        log_path,
    )
    # A page that failed its render (e.g. the serving deadline under load)
    # is reported, not raised: it stays stale and the caller's next bounded
    # round retries it, as render_ahead's own tail retries do. Only a
    # failed render *process* (nonzero exit, in render_pass) raises.
    return summary


def restart_standing_deepwell(
    runtime_home: Path, override_file: Path, health_timeout: int
) -> dict[str, str]:
    """Restart standing Deepwell so it promotes valid ahead rows at
    startup, then require the whole runtime healthy again."""
    run("docker", "restart", STANDING_DEEPWELL)
    return refresh.wait_for_health(runtime_home, override_file, health_timeout)


def mark_link_readers_stale(page_ids: list[int], database: str = STANDING_DATABASE) -> None:
    """Mark readers' latest revisions stale to the running generator (the
    `rerender_rehearsal_pages` marking), so a page-limited render pass
    selects them even though they already carry the target generator."""
    quoted = ", ".join(str(int(page_id)) for page_id in page_ids)
    psql(
        database,
        "UPDATE page_revision SET compiled_generator = 'activation-link-rerender' "
        "WHERE revision_id IN (SELECT latest_revision_id FROM page "
        f"WHERE page_id IN ({quoted}) AND deleted_at IS NULL "
        "AND latest_revision_id IS NOT NULL);\n",
    )


def render_ahead_link_readers(render_ahead_result: dict[str, object]) -> list[int]:
    """Link readers the render-ahead stage's own passes reported, from its
    summary; empty when that stage did not run or its summary is unreadable."""
    if render_ahead_result.get("status") != "pass":
        return []
    summary_path = render_ahead_result.get("summary_path")
    if not isinstance(summary_path, str):
        return []
    try:
        data = json.loads(Path(summary_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    readers = data.get("link_reader_page_ids")
    if not isinstance(readers, list):
        return []
    return [int(page_id) for page_id in readers]


def _converge_stale_pages(
    expected: str,
    image: str,
    evidence: Path,
    runtime_home: Path,
    override_file: Path,
    health_timeout: int,
    *,
    log_prefix: str,
    settle_link_readers: bool,
    known_link_readers: list[int] | tuple[int, ...] = (),
) -> dict[str, object]:
    """Bounded stale-page convergence against the running Deepwell: render
    the stale delta with `image`, restart Deepwell to promote it, reload
    the gateway, re-count. Returns the final stale count (never raises on
    non-convergence; raises on render/restart failures)."""
    started = time.monotonic()
    stale = saved_page_staleness(STANDING_DATABASE, expected)
    result: dict[str, object] = {"rounds": [], "link_reader_rounds": []}
    if not stale:
        result["stale_pages_remaining"] = 0
        return result
    links_before = render_ahead.link_digests(STANDING_DATABASE) if settle_link_readers else None
    readers = set(known_link_readers)
    for round_number in range(1, render_ahead.CATCH_UP_ROUNDS + 1):
        if time.monotonic() - started > ACTIVATION_CATCH_UP_TIMEOUT_SECONDS:
            break
        page_ids = saved_page_stale_ids(STANDING_DATABASE, expected)
        if not page_ids:
            # The count and the ID query are separate reads: a view or
            # fan-out render between them can clear every stale page.
            stale = 0
            break
        summary = render_delta_pages(
            image, page_ids, evidence / f"{log_prefix}-{round_number}.log"
        )
        readers |= render_ahead.link_readers(summary)
        restart_standing_deepwell(runtime_home, override_file, health_timeout)
        reload_gateway()
        stale = saved_page_staleness(STANDING_DATABASE, expected)
        result["rounds"].append(
            {
                "round": round_number, "pages": len(page_ids), "stale_after": stale,
                "failed": int(summary.get("failed") or 0),
                "failed_page_ids": list(summary.get("failed_page_ids") or []),
            }
        )
        if not stale:
            break
    if stale or not settle_link_readers or links_before is None:
        result["stale_pages_remaining"] = stale
        return result
    # A catch-up render can move the link graph; known readers already at
    # the target generator are not re-rendered by render-ahead (#2738), so
    # settle them the way render_ahead.verify_with_catch_up does: mark,
    # re-render, restart, until a round leaves every link unchanged.
    changed = set(render_ahead.changed_pages(links_before, render_ahead.link_digests(STANDING_DATABASE)))
    result["link_pages_changed"] = sorted(changed)
    if changed and readers:
        for round_number in range(1, render_ahead.MAX_READER_ROUNDS + 1):
            if not changed or not readers:
                break
            if time.monotonic() - started > ACTIVATION_CATCH_UP_TIMEOUT_SECONDS:
                # The total bound spans both loops: readers can be many,
                # and an unbounded settle would hold the flip open.
                raise RuntimeError(
                    "activation catch-up exceeded its time bound "
                    f"({ACTIVATION_CATCH_UP_TIMEOUT_SECONDS}s) while settling link readers"
                )
            before = render_ahead.link_digests(STANDING_DATABASE)
            requested = sorted(readers)
            mark_link_readers_stale(requested)
            summary = render_delta_pages(
                image, requested, evidence / f"{log_prefix}-link-readers-{round_number}.log"
            )
            readers |= render_ahead.link_readers(summary)
            restart_standing_deepwell(runtime_home, override_file, health_timeout)
            reload_gateway()
            stale = saved_page_staleness(STANDING_DATABASE, expected)
            changed = set(
                render_ahead.changed_pages(before, render_ahead.link_digests(STANDING_DATABASE))
            )
            result["link_reader_rounds"].append(
                {
                    "round": round_number, "pages": len(requested), "stale_after": stale,
                    "failed": int(summary.get("failed") or 0),
                    "failed_page_ids": list(summary.get("failed_page_ids") or []),
                }
            )
            if stale:
                break
        if changed:
            raise RuntimeError(
                f"links of {len(changed)} pages did not settle after "
                f"{render_ahead.MAX_READER_ROUNDS} link-reader rounds during activation catch-up"
            )
    result["stale_pages_remaining"] = stale
    return result


def converge_saved_pages(
    expected: str,
    image: str,
    evidence: Path,
    runtime_home: Path,
    override_file: Path,
    health_timeout: int,
    known_link_readers: list[int] | tuple[int, ...] = (),
) -> dict[str, object]:
    """Activation freshness after the flip. A zero first count is exactly
    the historical behavior (no render, no restart); otherwise converge in
    bounded rounds and keep the historical failure when it does not."""
    result = _converge_stale_pages(
        expected, image, evidence, runtime_home, override_file, health_timeout,
        log_prefix="activation-catch-up",
        settle_link_readers=True,
        known_link_readers=known_link_readers,
    )
    stale = int(result["stale_pages_remaining"])
    if stale:
        message = f"standing serves {stale} stale saved pages"
        failed = [
            page_id
            for entry in [*result["rounds"], *result["link_reader_rounds"]]
            for page_id in entry.get("failed_page_ids", [])
        ]
        if failed:
            message += f"; catch-up renders failed for pages {failed[:20]}"
        raise RuntimeError(message)
    return result


def recover_stale_saved_pages(
    old_image: str,
    evidence: Path,
    runtime_home: Path,
    override_file: Path,
    health_timeout: int,
) -> int:
    """After a rollback, render pages left stale to the old build with the
    old image (its generator comes from the image's own dry-run summary),
    bounded the same way. Returns the stale count that remains."""
    probe = render_delta_pages(
        old_image, None, evidence / "rollback-render-probe.log", dry_run=True
    )
    old_generator = probe["compiled_generator"]
    if not isinstance(old_generator, str) or not old_generator:
        raise RuntimeError("the rollback image did not report its compiled generator")
    result = _converge_stale_pages(
        old_generator, old_image, evidence, runtime_home, override_file,
        health_timeout,
        log_prefix="rollback-catch-up",
        settle_link_readers=False,
    )
    return int(result["stale_pages_remaining"])


# Browser parity


def browser_reference(path: Path) -> dict[str, str]:
    """The retained live Wikidot reference the browser parity compares to.

    It is captured once (`run-standing-browser-parity.mjs --mode
    live-reference`) and replayed by every promotion; recapture it only when
    the canary contract or the live pages change."""
    manifest = json.loads((path / "reference.json").read_text(encoding="utf-8"))
    if manifest.get("schema") != BROWSER_REFERENCE_SCHEMA:
        raise ValueError(f"{path / 'reference.json'} is not a standing browser reference")
    ledger = path / manifest["live_reference_ledger"]
    return {
        "policy": str(path / manifest["live_completion_policy"]),
        "ledger": str(ledger),
        "cache_dir": manifest["source_response_cache_dir"],
        "cache_identity": manifest["source_response_cache_identity"],
        "browser": manifest["browser_executable"],
        # Cross-origin responses vary by Origin, so the retained responses
        # replay only for the candidate origin they were captured from.
        "candidate_port": int(manifest["candidate_public_port"]),
    }


def browser_parity(
    source_root: Path, mode: str, output: Path, reference: dict[str, str], binding: list[str], log: Path
) -> dict[str, object]:
    stdout = run_logged(
        [
            "node", str(VERIFICATION / "scripts" / "run-standing-browser-parity.mjs"),
            "--mode", mode,
            "--output-dir", str(output),
            "--live-completion-policy", reference["policy"],
            "--live-reference-ledger", reference["ledger"],
            "--source-response-cache-dir", reference["cache_dir"],
            "--source-response-cache-identity", reference["cache_identity"],
            "--browser-root", "framerail",
            "--browser-executable", reference["browser"],
            *binding,
        ],
        log,
        source_root,
    )
    result = last_json_line(stdout)
    if result.get("status") != "pass":
        raise RuntimeError(f"{mode} browser parity did not pass; see {output}")
    return {"status": "pass", "output_dir": str(output)}


# Promotion


def prepare_promotion_checkout(repository: Path, checkout: Path) -> Path:
    """The persistent checkout promotions run from, moved to the fetched
    origin/develop.

    It keeps its cargo target directory, node_modules and test build between
    promotions, so a promotion that must run checks compiles incrementally
    instead of from a fresh worktree. It must be clean; it is never reset."""
    run("git", "-C", str(repository), "fetch", "--quiet", "origin", "develop")
    if not checkout.exists():
        checkout.parent.mkdir(parents=True, exist_ok=True)
        run("git", "-C", str(repository), "worktree", "add", "--detach", str(checkout), "origin/develop")
        return checkout
    common = lambda root: Path(root, run("git", "-C", str(root), "rev-parse", "--git-common-dir")).resolve()
    if common(checkout) != common(repository):
        raise ValueError(f"{checkout} is not a worktree of {repository}")
    if run("git", "-C", str(checkout), "status", "--porcelain", "--untracked-files=all"):
        raise ValueError(f"the promotion checkout {checkout} has local changes; it is never reset")
    run("git", "-C", str(checkout), "checkout", "--quiet", "--detach", "origin/develop")
    return checkout


def run_from_source_root(source_root: Path) -> None:
    """Re-run this command from the promoted source's own promote.py, so the
    orchestrator is the one that source ships."""
    own = source_root / "install" / "standing" / "promote.py"
    if Path(__file__).resolve() == own.resolve():
        return
    arguments = [argument for argument in sys.argv[1:]]
    if "--source-root" not in arguments:
        arguments = ["--source-root", str(source_root), *arguments]
    os.execv(sys.executable, [sys.executable, str(own), *arguments])




def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--source-root",
        type=Path,
        help="a clean checkout of the fetched origin/develop; by default the persistent "
        "promotion checkout under the state directory, moved to origin/develop",
    )
    parser.add_argument("--runtime-home", type=Path, default=refresh.DEFAULT_RUNTIME_HOME)
    parser.add_argument("--evidence-dir", type=Path)
    parser.add_argument(
        "--browser-reference", type=Path, default=state_root() / "standing-browser-reference"
    )
    parser.add_argument(
        "--rehearse",
        choices=("auto", "always"),
        default="auto",
        help="auto rehearses only when a failed activation cannot be undone",
    )
    parser.add_argument("--health-timeout-seconds", type=int, default=600)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.source_root is None:
        source_root = prepare_promotion_checkout(
            Path(__file__).resolve().parents[2], state_root() / "promotion-checkout"
        )
    else:
        source_root = args.source_root.resolve()
    run_from_source_root(source_root)
    runtime_home = args.runtime_home.resolve()
    override_file = source_root / "install" / "standing" / "refresh.compose.yaml"
    stages = Stages()
    started_at = datetime.now(UTC)

    # 1. identity
    def identity_stage():
        identity = refresh.repository_identity(source_root)
        environment = refresh.read_environment(runtime_home / ".env")
        # A previous failed promotion must not be mistaken for an already-current
        # runtime or allowed to fail much later inside render-ahead.
        refresh.require_standing_applications_running(runtime_home)
        standing_sha = environment.get("STANDING_WIKIJUMP_SHA", "")
        if not GIT_OBJECT.fullmatch(standing_sha):
            raise ValueError("the standing runtime does not record its source revision")
        return {**identity, "standing_sha": standing_sha}

    identity = stages.run("identity", identity_stage)
    target, standing_sha = identity["wikijump_sha"], identity["standing_sha"]
    if target == standing_sha:
        print(json.dumps({"status": "current", "wikijump_sha": target}))
        return 0
    evidence = (
        args.evidence_dir
        or state_root() / "promotions" / f"{target[:12]}-{started_at.strftime('%Y%m%dT%H%M%SZ')}"
    ).resolve()
    evidence.mkdir(mode=0o700, parents=True, exist_ok=False)
    return promote(args, source_root, runtime_home, override_file, identity, evidence, stages)


def promote(args, source_root, runtime_home, override_file, identity, evidence, stages) -> int:
    target, standing_sha = identity["wikijump_sha"], identity["standing_sha"]
    reference = browser_reference(args.browser_reference)

    # 2. plan
    def plan_stage():
        changed = changed_paths(source_root, standing_sha, target)
        expected_generator = refresh.expected_compiled_generator(source_root)
        stale = saved_page_staleness(STANDING_DATABASE, expected_generator)
        migrations = sorted(path for path in changed if path.startswith("deepwell/migrations/"))
        reason = rehearsal_reason(args.rehearse, migrations)
        return {
            "changed_paths": len(changed),
            "expected_compiled_generator": expected_generator,
            "stale_pages_before": stale,
            "render_ahead": stale > 0,
            "migration_changes": migrations,
            "rehearse": reason is not None,
            "rehearsal_reason": reason,
        }

    plan = stages.run("plan", plan_stage)

    # 3. build
    def build_stage():
        stdout = run_logged(
            [
                "node", str(VERIFICATION / "scripts" / "build-promotion-candidate-images.mjs"),
                "--source-root", str(source_root),
                "--output-dir", str(evidence / "build"),
                "--run-id", f"promotion-{target[:12]}-{int(time.time())}",
                "--reuse-runtime-home", str(runtime_home),
            ],
            evidence / "build.log",
            source_root,
        )
        built = last_json_line(stdout)
        check_framerail_image_loads(
            built["images"]["framerail"],
            evidence / "framerail-image-import.log",
            source_root,
        )
        return built

    rehearsal_volumes = {
        "database": f"wjrehearsal-{target[:12]}-postgres",
        "files": f"wjrehearsal-{target[:12]}-files",
        "files_upper": f"wjrehearsal-{target[:12]}-files-upper",
    }

    def clone_stage():
        with deepwell_paused_for_clone():
            clone_standing_database(rehearsal_volumes["database"])
            overlay_standing_files(rehearsal_volumes["files"], rehearsal_volumes["files_upper"])
        return dict(rehearsal_volumes)

    def browser_dependencies_stage():
        # The browser parity drives Chromium through Framerail's locked
        # Playwright; a fresh checkout has no node_modules yet.
        if (source_root / "framerail" / "node_modules" / "@playwright" / "test").is_dir():
            return {"status": "present"}
        run_logged(
            ["pnpm", "--dir", "framerail", "install", "--frozen-lockfile", "--prefer-offline"],
            evidence / "browser-dependencies.log",
            source_root,
        )
        return {"status": "installed"}

    # The rehearsal renders the pages it serves itself, so its copy needs
    # nothing from render-ahead and is taken alongside the build.
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        build = pool.submit(stages.run, "build", build_stage)
        dependencies = pool.submit(stages.run, "browser-dependencies", browser_dependencies_stage)
        clone = pool.submit(stages.run, "rehearsal-clone", clone_stage) if plan["rehearse"] else None
        try:
            built = build.result()
            dependencies.result()
            if clone:
                clone.result()
        except BaseException:
            for future in (build, dependencies, clone):
                if future:
                    future.cancel()
            if plan["rehearse"]:
                pool.shutdown(wait=True)
                remove_volumes(*rehearsal_volumes.values())
            raise
    try:
        return finish(
            args, source_root, runtime_home, override_file, identity, evidence,
            stages, plan, reference, built, rehearsal_volumes,
        )
    finally:
        if plan["rehearse"]:
            remove_volumes(*rehearsal_volumes.values())


def finish(
    args, source_root, runtime_home, override_file, identity, evidence,
    stages, plan, reference, built, rehearsal_volumes,
) -> int:
    """Rehearse, migrate the live database, render ahead, activate and
    prove, after the build."""
    target = identity["wikijump_sha"]
    images = {service: built["images"][service] for service in SERVICES}

    # 4. render-ahead, after rehearsal and live-migration below
    render_ahead = {
        "status": "not-needed",
        "expected_compiled_generator": plan["expected_compiled_generator"],
        "stale_pages_before": 0,
    }
    if plan["render_ahead"]:
        def render_stage():
            output = evidence / "render-ahead"
            run_logged(
                [
                    sys.executable, str(Path(__file__).with_name("render_ahead.py")),
                    "--image", images["deepwell"],
                    "--output-dir", str(output),
                ],
                evidence / "render-ahead.log",
                source_root,
            )
            path = output / "render-ahead-summary.json"
            ahead = json.loads(path.read_text(encoding="utf-8"))
            if (
                ahead.get("status") != "pass"
                or ahead.get("render_image_id") != images["deepwell"]
                or ahead.get("compiled_generator") != plan["expected_compiled_generator"]
                or ahead.get("stale_without_valid_ahead") != 0
            ):
                raise RuntimeError(f"render-ahead did not render every stale page: {path}")
            return {
                "status": "pass",
                "expected_compiled_generator": plan["expected_compiled_generator"],
                "stale_pages_before": plan["stale_pages_before"],
                "summary_path": str(path),
            }

    def rehearsal_stage():
        return rehearse(
            source_root, evidence, stages, plan, reference, rehearsal_volumes,
            target, images["deepwell"],
        )

    def live_migration_stage():
        return apply_live_migrations(
            images["deepwell"], source_root, evidence / "live-migration.log",
            plan["migration_changes"],
        )

    # 5. rehearsal, then live-migration, then render-ahead. These no longer
    # run alongside each other: render-ahead runs the new renderer against
    # the live database, so that database must already carry the candidate's
    # migrations, and applying them is only safe once the rehearsal has
    # passed on a copy of standing's data.
    if plan["rehearse"]:
        rehearsal_stage()
    stages.run("live-migration", live_migration_stage)
    if plan["render_ahead"]:
        render_ahead = stages.run("render-ahead", render_stage)

    # 6. activation and standing proof
    activation = activate(
        source_root, runtime_home, override_file, identity, evidence, stages,
        images, render_ahead, reference, args.health_timeout_seconds,
    )
    print(json.dumps({"status": "pass", "wikijump_sha": target, "duration_seconds": round(stages.elapsed()), "catch_up": activation["catch_up"]}))
    return 0


def rehearse(source_root, evidence, stages, plan, reference, volumes, target, deepwell_image) -> dict[str, object]:
    project = f"wjcand-rehearsal-{target[:12]}"
    candidate_root = evidence / "rehearsal"
    ports = {"public": reference["candidate_port"], "rpc": free_port(), "object_store": free_port()}
    try:
        def start_stage():
            stdout = run_logged(
                [
                    "node", str(VERIFICATION / "scripts" / "start-promotion-candidate.mjs"),
                    "--source-root", str(source_root),
                    "--build-evidence", str(evidence / "build"),
                    "--candidate-root", str(candidate_root),
                    "--staging-home", str(evidence / "rehearsal-staging"),
                    "--public-port", str(ports["public"]),
                    "--rpc-port", str(ports["rpc"]),
                    "--object-store-port", str(ports["object_store"]),
                    "--project", project,
                    "--expires-at", (datetime.now(UTC) + timedelta(hours=2)).isoformat(),
                    "--database-volume", volumes["database"],
                    "--files-volume", volumes["files"],
                ],
                evidence / "rehearsal-start.log",
                source_root,
            )
            return last_json_line(stdout)

        stages.run("rehearsal-start", start_stage)
        slugs = browser_canary_slugs(source_root)
        stages.run(
            "rehearsal-render",
            lambda: rerender_rehearsal_pages(project, deepwell_image, slugs),
        )

        def check_stage():
            # After a generator change only the pages the rehearsal rendered
            # itself are current on its copy; render-ahead renders the rest on
            # standing, and activation requires all of them fresh there.
            stale = saved_page_staleness(
                f"{project}-database-1",
                plan["expected_compiled_generator"],
                slugs if plan["render_ahead"] else None,
            )
            if stale:
                raise RuntimeError(f"the rehearsal serves {stale} stale saved pages")
            # Without its hosted text blocks the rehearsal answers
            # local--code with 500 and parity reports unstyled geometry
            # instead of a product difference.
            missing = missing_text_blocks(f"{project}-database-1", f"{project}-files-1")
            if missing:
                raise RuntimeError(
                    f"the rehearsal object store lacks {len(missing)} hosted text blocks "
                    f"its database names, e.g. {', '.join(missing[:5])}"
                )
            origin = f"scp-wiki.wikijump.localhost:{ports['public']}"
            canary = http_canary(
                f"https://{origin}/scp-9506", f"{origin}:127.0.0.1"
            )
            parity = browser_parity(
                source_root, "candidate", evidence / "rehearsal-browser-parity", reference,
                ["--candidate-port", str(ports["public"])],
                evidence / "rehearsal-browser-parity.log",
            )
            return {"stale_pages_remaining": 0, "canary": canary, "browser_parity": parity}

        result = stages.run("rehearsal-checks", check_stage)
        return {"status": "pass", "project": project, **result}
    finally:
        compose = candidate_root / "compose.json"
        if compose.exists():
            subprocess.run(
                ["docker", "compose", "-p", project, "-f", str(compose), "down", "--volumes", "--remove-orphans"],
                capture_output=True,
                env={**os.environ, "DEEPWELL_RPC_TOKEN": "0" * 64},
            )
        remove_volumes(volumes["files"], volumes["files_upper"], volumes["database"])


def activate(
    source_root, runtime_home, override_file, identity, evidence, stages,
    image_ids, render_ahead, reference, health_timeout,
) -> dict[str, object]:
    run_id = f"{identity['wikijump_sha']}-{evidence.name}"
    environment = refresh.read_environment(runtime_home / ".env")
    previous_environment = dict(environment)
    if environment.get("STANDING_PROJECT_NAME") != "wikijump-standing":
        raise ValueError("runtime home is not the wikijump-standing project")
    previous = refresh.runtime_containers(runtime_home)
    previous_owner = refresh.port_443_owner(previous)
    rollback_images = {
        service: refresh.image_identity(previous[service]["image_id"], runtime_home)
        for service in SERVICES
    }
    images = {}
    for service in SERVICES:
        image = refresh.image_identity(image_ids[service], runtime_home)
        labels = image["labels"]
        if (
            labels.get("com.rokurolize.wikijump.sha") != identity["wikijump_sha"]
            or labels.get("com.rokurolize.wikijump.tree") != identity["wikijump_tree"]
            or labels.get("com.rokurolize.wikijump.ftml_sha") != identity["ftml_sha"]
        ):
            raise RuntimeError(f"built {service} image is not labelled for {identity['wikijump_sha']}")
        images[service] = image
    expiry = (datetime.now(UTC) + RESOURCE_LIFETIME).isoformat()
    parked: dict[str, dict[str, object]] = {}
    switched = False
    timings: dict[str, float] = {}
    switch_started_at: str | None = None
    snapshot = evidence / "saved-page-output-before.tsv"

    def timed(name, action):
        started = time.monotonic()
        try:
            return action()
        finally:
            timings[name] = round(time.monotonic() - started, 3)

    def switch_stage():
        nonlocal parked, switched, switch_started_at
        if refresh.runtime_containers(runtime_home) != previous:
            raise RuntimeError("standing changed while the promotion prepared; rerun it")
        if render_ahead["status"] == "pass":
            snapshot_rows = timed("saved-page-snapshot", lambda: snapshot_saved_page_output(snapshot))
            if snapshot_rows < render_ahead["stale_pages_before"]:
                raise RuntimeError("the saved-page snapshot is missing pages")
        switch_started_at = database_clock()
        parked = refresh.park_containers(previous, runtime_home, run_id)
        environment.update(
            {
                "STANDING_DEEPWELL_IMAGE": images["deepwell"]["id"],
                "STANDING_FRAMERAIL_IMAGE": images["framerail"]["id"],
                "STANDING_WWS_IMAGE": images["wws"]["id"],
                "STANDING_WIKIJUMP_SHA": identity["wikijump_sha"],
                "STANDING_FTML_SHA": identity["ftml_sha"],
                "STANDING_RESOURCE_EXPIRY": expiry,
            }
        )
        refresh.write_environment(runtime_home / ".env", environment)
        switched = True
        timed("compose", lambda: refresh.command(
            *refresh.compose_command(
                runtime_home, "up", "--detach", "--no-deps", "--no-build", *SERVICES,
                override_file=override_file,
            ),
            cwd=runtime_home,
        ))
        health = timed("health", lambda: refresh.wait_for_health(runtime_home, override_file, health_timeout))
        gateway = timed("gateway", reload_gateway)
        catch_up = timed("catch-up", lambda: converge_saved_pages(
            render_ahead["expected_compiled_generator"], images["deepwell"]["id"],
            evidence, runtime_home, override_file, health_timeout,
            known_link_readers=render_ahead_link_readers(render_ahead),
        ))
        canary = timed("canary", lambda: http_canary(refresh.CANARY_URL))
        current = refresh.runtime_containers(runtime_home)
        for service in SERVICES:
            if current[service]["container_id"] == previous[service]["container_id"]:
                raise RuntimeError(f"activation did not create a new {service} container")
            if current[service]["image_id"] != images[service]["id"]:
                raise RuntimeError(f"standing {service} does not run the promoted image")
        if refresh.port_443_owner(current)["container_id"] != previous_owner["container_id"]:
            raise RuntimeError("activation changed the port-443 owner")
        return {
            "timings": dict(timings), "health": health, "canary": canary,
            "gateway": gateway, "catch_up": catch_up,
        }

    try:
        switched_result = stages.run("activation", switch_stage)
        proof = stages.run(
            "standing-proof",
            lambda: browser_parity(
                source_root, "standing", evidence / "standing-browser-parity", reference,
                [],
                evidence / "standing-browser-parity.log",
            ),
        )
    except BaseException as error:
        if not parked:
            raise
        rollback = {"status": "fail"}
        try:
            if switched:
                refresh.write_environment(
                    runtime_home / ".env",
                    refresh.rollback_environment(previous_environment, rollback_images),
                )
                for service in SERVICES:
                    subprocess.run(
                        ["docker", "rm", "--force", f"wikijump-standing-{service}-1"],
                        capture_output=True,
                    )
                if snapshot.exists():
                    rollback["restored_saved_pages"] = restore_saved_page_output(
                        snapshot, render_ahead["expected_compiled_generator"],
                        switch_started_at=switch_started_at,
                    )
            rollback["container_recovery"] = refresh.restore_or_recreate_previous_containers(
                parked, runtime_home, override_file, rollback_images
            )
            refresh.wait_for_health(runtime_home, override_file, health_timeout)
            rollback["gateway"] = reload_gateway()
            # Best effort, after the old build is back: render whatever the
            # flip left stale to it (post-flip revisions, guarded-out
            # rerenders) with the old image, before the final canary. A
            # failure here never masks the original activation error.
            try:
                rollback["stale_after_recovery"] = recover_stale_saved_pages(
                    rollback_images["deepwell"]["id"], evidence, runtime_home,
                    override_file, health_timeout,
                )
            except BaseException as recovery_error:
                rollback["stale_after_recovery"] = None
                rollback["recovery_error"] = str(recovery_error)
            rollback.update(status="pass", canary=http_canary(refresh.CANARY_URL))
        except BaseException as rollback_error:
            rollback["error"] = str(rollback_error)
        raise RuntimeError(f"activation failed ({error}); rollback {rollback}") from error

    for entry in parked.values():
        subprocess.run(["docker", "rm", entry["parked_name"]], capture_output=True)
    refresh.discard_parked_images(parked, runtime_home)
    return {**switched_result, "standing_proof": proof, "rollback_images": {s: rollback_images[s]["id"] for s in SERVICES}}


if __name__ == "__main__":
    raise SystemExit(main())
