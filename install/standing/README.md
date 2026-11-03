# Standing runtime operations

`compose.yaml` is the source-owned topology for the browser-facing standing runtime. The rendered home uses the role-based `wikijump-standing` project and the durable external volume names `wikijump-standing-postgres-data`, `wikijump-standing-files-data`, `wikijump-standing-cache-data`, `local-caddy-data`, and `local-caddy-config`. Never run `docker compose down -v` against this topology. Legacy `runtime50x-*` volume names are migration-only rollback inputs and are not part of the active topology.

The durable cache has a source-owned compatibility floor in
`cache-data-compatibility.json`. A standing/cache image must not be downgraded
below that Valkey version: persisted AOF/RDB data may use formats introduced by
the floor release. The hermetic compatibility suite checks both local/dev
Dockerfiles against that policy so a future base-image cleanup cannot silently
turn a standing activation into an unreadable-cache rollback incident.

## Startup topology

Warm startup latency was dominated by Docker bridge/NAT and published-port
programming per container, not by application initialization. In this topology
only Caddy is attached to the Docker bridge and publishes host ports
(`80/tcp`, `443/tcp`, `443/udp`). Database, files, cache, Deepwell, Framerail,
and WWS share Caddy's network namespace with `network_mode: "service:caddy"`, so
the engine programs one network endpoint instead of seven.

Inter-service traffic therefore uses `127.0.0.1`, not Compose service DNS, and
Caddy resolves the application upstreams through `extra_hosts`. The application
services no longer expose host ports; inspect them through the namespace (for
example `docker compose exec caddy ...`). Recreating Caddy restarts the services
that share its namespace, so a Tier 1 refresh recreates only Deepwell,
Framerail, and WWS and never stops Caddy.

Caddy, Framerail, and WWS run with `WIKIJUMP_STARTUP_READINESS=true`: they serve
an explicit `Cache-Control: no-store` 503 until a real authenticated Deepwell
`ping` RPC succeeds, then Caddy atomically loads the Deepwell-generated routes.
Deepwell keeps its `depends_on` on the base services so migrations run exactly
once against a healthy database, and it retries only transient Redis/Valkey
startup unavailability (`BusyLoading`, connection refusal) in-process instead of
exiting into a Docker restart loop. Startup 503s are acceptable; partial HTML,
stale application routes, and false 200s are not.

There are two operational tiers. Routine application refreshes use Tier 1. Tier 2 is reserved for operations that can change a named volume attachment, the Compose project name, the network name, or edge routing.

## Tier 1: promote the merged develop head

Tier 1 is the routine step after a change merges to `develop`, and it is one command. A browser-visible, chrome, layout, or DOM claim about standing needs the current merged head on standing first: a claim against an older standing SHA is not evidence about current code.

```sh
python3 install/standing/promote.py
```

It fetches `origin/develop`, moves its own worktree `${XDG_STATE_HOME:-$HOME/.local/state}/wikijump/promotion-checkout` there (creating it the first time), and continues with that checkout's `promote.py`, so the orchestrator is always the one the promoted source ships. The worktree keeps its Cargo target directories and `node_modules` between promotions, so checks that must run compile incrementally. It must stay clean and is never reset; local changes in it stop the promotion. `--source-root <clean checkout of the fetched origin/develop>` promotes from another checkout instead.

### Browser verification of Standing

A browser result is evidence about the revision Standing is actually serving, not about the checkout in front of you. Before trusting one:

1. GET `/-/about` on the Standing host and compare the git-commit rows against the fetched `origin/develop` HEAD. The rows are public by design (WJ-1279) for exactly this check. A result against any other served revision is not evidence about current code.
2. If the served revision differs, promote first (Tier 1 above) and re-check `/-/about`.
3. Run the browser verification.
4. Record the served SHA beside every verdict, so the reader can tell which revision the verdict rests on.

The check must be against the running runtime, not the checkout: a build can pass its unit tests while its production server entry fails at boot, so a green build in a checkout says nothing about what Standing serves.

It stops at the first failing stage and leaves standing as it was or restores it. Stage durations print to stderr, and logs stay under `${XDG_STATE_HOME:-$HOME/.local/state}/wikijump/promotions/<sha>-<time>/`. The merge already passed the PR checks, so promotion reruns no test suite. It proves the new build runs here, through health, the HTTP canary, and the browser parity. The stages:

1. **identity** — the checkout is clean and exactly the fetched `origin/develop`; the standing runtime records the revision it serves. Nothing runs when standing already serves this head.
2. **plan** — counts saved pages the new renderer generation makes stale and lists migration changes.
3. **build** — the Deepwell, Framerail, and WWS production images, side by side, from BuildKit caches (cargo registry and target directories, the pnpm store). Deepwell uses the `standing` cargo profile: release optimisation without the whole-program LTO that alone took about 14 minutes, and incremental, so a source change rebuilds in about four minutes. The database, files, cache, and Caddy images are standing's own (they change only in Tier 2).
4. **render-ahead** — when saved pages are stale to the new renderer generation, `render_ahead.py` renders them with the new image while the old one serves (below).
5. **rehearsal** — only when migrations change. They cannot be undone: the old build's migration check refuses a schema it does not know, so its parked containers would not start again. The new images start on a copy of standing's data — a `pg_basebackup` of the database (about a minute) and a copy-on-write overlay of the object store (standing's volume is only the read-only lower layer; the ~100 MB hosted text-block bucket is copied into the upper layer, because rendering deletes replaced text blocks and render-ahead would otherwise remove objects the cloned database names, #2650) — and must pass zero stale saved pages, every hosted text block its database names present in its object store, the HTTP canary, and the candidate browser parity. The copy is removed afterwards.
6. **activation** — park the serving Deepwell, Framerail, and WWS containers, record the new image IDs and revision in the runtime `.env`, `docker compose up --no-deps --no-build` the three services, and require health, a gateway reload, zero stale saved pages, the SCP-9506 HTTP canary, and the standing browser parity. Parking is the fence for everything routed through Deepwell (including its re-render fan-out): after the flip the new build's own writes carry the target generator, so only a direct-SQL import can still stale a page. Pages that changed after render-ahead's final verify are therefore converged, not rolled back on sight: activation lists the stale page IDs, renders just that delta with the new image (running the idempotent render-ahead migration first when the render-ahead stage was not needed), restarts Deepwell so it promotes the rows, reloads the gateway, and counts again, for at most `render_ahead.CATCH_UP_ROUNDS` rounds within a total time bound. If a catch-up render moved the link graph, the known link readers (from the render-ahead summary and the catch-up passes) are marked, re-rendered, and settled the same way, because readers already at the target generator are not re-rendered by render-ahead (#2738). A marked reader carries a placeholder generator until the restart after its re-render promotes it, so the view path refuses it to anonymous viewers in that window (fail-closed, never stale output). Only a delta that never reaches zero stale rolls back. Any failure removes the new containers and restores the parked ones; after a renderer generation change it first puts back the saved-page output it replaced (snapshotted just before parking), except rows compiled at or after the switch began — a post-flip rerender already replaced their output, and the snapshot could name text blocks that rerender deleted — so the old build serves current pages again. After the old containers are back, rollback renders whatever the flip left stale to the old build (post-flip revisions and those guarded-out rows) with the old image, bounded the same way, and records the count that remains as `stale_after_recovery`; that step is best-effort and never masks the original activation failure. On success the parked containers are removed. Catch-up rounds and page counts appear in the final JSON result.

Rollback cannot assume renamed containers survive `docker compose up`: Compose retains container-management labels across `docker rename` and may remove those parked containers while reconciling the service. If the original parked app containers have vanished, rollback now recreates **only Deepwell, Framerail and WWS** from the previously verified immutable image IDs after restoring the original `.env` and saved-page output. The recovery refuses image substitution and verifies every recreated app runs the pinned image; it never pulls images or touches shared named volumes, Caddy, the database, files or cache. If the old applications are already missing when a new promotion starts, promotion fails early with a recovery diagnostic rather than proceeding into render-ahead or falsely reporting that Standing is current.

Caddy keeps port 443 and is never recreated, but its routes come from Deepwell's `caddyfile` RPC, which the Caddy container's own cron reloads only every five minutes. Activation therefore runs that cron's `wikijump-update-caddyfile` (as the cron's `daemon` user) once the new Deepwell is healthy, and requires the configuration Caddy then reports on its admin API to equal the adapted Caddyfile Deepwell renders; a rollback reloads it the same way from the restored Deepwell. Without this, the standing proof could pass against the previous build's gateway routes (#2598).

Activation never compiles, never stops Caddy, the database, files, or cache, never runs `down`, and has no volume or Compose passthrough option. The browser parity compares against the retained live Wikidot reference in `${XDG_STATE_HOME:-$HOME/.local/state}/wikijump/standing-browser-reference/reference.json` (policy, reference ledger, response cache, browser); it is captured once with `run-standing-browser-parity.mjs --mode live-reference` and recaptured only when the canary contract or the live pages change, never as part of a promotion.

Measured on this workstation (16 cores) on 2026-10-17: a Deepwell source change rebuilds in about 4 minutes (the old uncached fat-LTO build took about 22), the database copy takes about a minute, each browser parity about 40 seconds, and activation about a minute. Routine promotions therefore finish within ten minutes; a renderer generation change adds its render-ahead.

### Renderer generation switches: render ahead

Deepwell refuses saved output whose `compiled_generator` is not its own (`ftml vX; deepwell-render/vN`), so a release that bumps the renderer epoch or FTML makes every saved page stale at activation. `promote.py` renders them first, while the old runtime keeps serving. For diagnostics, run it alone:

```sh
python3 install/standing/render_ahead.py \
  --image <deepwell image ID> \
  --output-dir "$runtime_home/render-ahead-<wikijump-sha>"
```

The command runs the image's `render-ahead` runtime action as a one-off container in the serving Deepwell's network namespace, with its environment and configuration. It creates the `page_revision_render_ahead` table from the image's idempotent migration without recording the migration, so the serving build (and a rollback to it) still passes its own migration check. Each stale page's latest revision is rendered into that table in its own task; `page_revision` is untouched.

Rendering refreshes link rows. Backlinks, OrphanedPages, WantedPages, and ListPages/CountPages queries with `link_to=` read the link graph. Deepwell reports every page whose render read it (`link_reader_page_ids`), including queries expanded from included source. A link reader rendered early in a full pass may have read links a later render changed, so readers are rendered again until a round leaves every link unchanged. If links keep moving at the round limit, promotion is blocked: without the individual reader-to-writer dependencies, a randomly changing reader may leave another page's saved output based on old links. The 2026-10-16 standing run spent 37 of its 54 minutes re-rendering about 3,700 deterministic pages eight times and then every page again; standing had two readers under the then-current classifier, which did not include `link_to=` queries. Each run renders every stale page itself, because only its own passes know which pages read links.

Pages that miss the serving render deadline under load are retried alone, then with a one-shot `--tail-render-timeout-ms` deadline; any other failure stops the run. The summary `render-ahead-summary.json` records the image, generator, per-pass timings and counts, the link readers, and `stale_without_valid_ahead`, which must be `0`. A run that exits nonzero without a passing summary has **stopped**: inspect its saved pass logs rather than waiting or promoting.

The new Deepwell promotes valid rows in one statement when it starts, before it accepts requests. A row is valid only while its revision is still the page's latest, with the same source, and has not been rerendered by the serving build since the row's inputs were read. Pages that changed after the run therefore stay stale at the flip; activation's freshness check renders just that delta with the new image and restarts Deepwell to promote it (bounded rounds, above), and restores the old runtime only when the delta does not converge to zero stale pages.

The candidate Framerail image is built from the production Dockerfile with origin checks enabled by default, and the standing Compose environment repeats `FRAMERAIL_CSRF_CHECK_ORIGIN=true` so the runtime cannot silently disable the check.

The standing image tier is deliberately separate from `install/local`: local images retain bind mounts and watch-mode startup for source iteration, while the promoted images are already-built production artifacts. Deepwell's image contains the pinned `sqlx-cli` and migrations and runs `sqlx migrate run` before the binary; migration handling is therefore explicit rather than silently lost when the local startup script is removed.

## Rendering the canonical home

`render.py` materializes the canonical home from a clean checkout at an exact merged Wikijump revision. Export `DEEPWELL_RPC_TOKEN` as the 64-character lowercase hexadecimal service credential before rendering; the renderer validates it and stores it only in the mode-600 runtime `.env`, never in `identity.json` or image arguments. It copies the production Deepwell config and replaces only the production domain pair with `wikijump.localhost` and `wjfiles.localhost`. Deepwell uses the locales already packaged at `/opt/locales` in the immutable production image, so the rendered home contains no checkout path or external locales bind. The renderer fails closed if the production domain block changes, the requested FTML revision is absent, either required Deepwell runtime source is missing, or the checkout identity is not exact. `identity.json` records the source tree, FTML pin, config hash, image inputs, and persistent volume names without host paths or render-time fields.

`identity.json` describes the materialized topology and is updated only by `render.py`. `runtime-differential-identity.json` describes the application artifacts currently activated by the latest successful Tier 1 refresh and is the identity input for saved-page runtime comparisons.

Rendering does not mutate the running stack. A routine Tier 1 refresh uses the already materialized home; a topology change uses Tier 2.

## Tier 2: topology, volume, network, or edge maintenance

Tier 2 is the controlled maintenance ceremony for changes to named volume attachments, the Compose project name, the network name, or edge routing. Routine source updates do not use Tier 2. The old `runtime50x-*` identities must never be introduced into a newly rendered standing home.

1. Record the current container identities, image digests, mounted volumes, network, edge owner, and passing canaries as rollback evidence. Verify the five named persistent volumes and their consumers before changing anything.
2. Build the exact merged-head images under the required lease, render a staging home bound to those identities, and validate it before touching the canonical home.
3. Activate the bounded explicit 503 maintenance response. Connection refusal, a generic 5xx, or silently serving an old candidate is not an acceptable maintenance state.
4. Stop the old standing containers without `-v`, start the merged-head topology, and verify that every named volume survives. Never prune or recreate a named data volume as part of this ceremony.
5. Verify one port-443 owner, expected project and network identities, service health, HTTP and assets, WIKIREQUEST metadata, AJAX ListPages, DOM, and unmodified `wikidot.py` lookup canaries.
6. On failure, restore the saved topology without `-v`, restore normal edge routing. On success, retain the immediate rollback image and remove superseded images that no container uses.

Physical volume migration is explicit and rollback-preserving. Copying data to a durable name and changing the Compose attachment are separate operations; neither is an incidental effect of Compose recreation. The migration verifier must prove checksum-equivalent copies while the old volumes are quiesced before the active topology is switched.

### PostgreSQL major upgrade

`install/local/postgres/Dockerfile` names the database image, but a promotion never changes the database (Tier 1 above), so a major bump is a Tier 2 step on the merged head. The data stays in `wikijump-standing-postgres-data`, at the path `SERVICE_DESTINATIONS` names.

1. Check on a copy first: `promote.clone_standing_database(<volume>)`, start the old image on it once so it finishes recovery, stop it, then `scripts/upgrade-postgres-volume.sh <volume>`.
2. Build the new image from the merged head and hold the 503 maintenance response. Stop Deepwell, Framerail, WWS, and the database with `docker compose stop` and no `-v`.
3. `scripts/upgrade-postgres-volume.sh wikijump-standing-postgres-data --rollback-volume <rollback volume>`. The rollback volume is compared against the source before the upgrade starts. The upgrade uses hard links and cannot be undone.
4. Set `STANDING_DATABASE_IMAGE` in the runtime `.env` to the new image ID, then `docker compose up -d --no-deps --no-build database deepwell framerail wws`, and verify health and the canaries (step 5 of the ceremony).
5. To roll back, stop the same services, swap the rollback volume's contents back into the standing volume, and restore the old image ID. Writes made since the upgrade are lost, so remove the rollback volume only once the new runtime is trusted.

An upgraded cluster keeps checksums off, as it was initialised; `pg_upgrade` requires the setting to match.

### One-time legacy volume migration

The campaign-era `runtime50x-*` names are migrated exactly once. Stop the
standing project without removing containers or volumes, then copy and verify
all three data volumes while they are quiesced:

```sh
runtime_home="${XDG_STATE_HOME:-$HOME/.local/state}/wikijump/standing"
mkdir -p "$runtime_home"

docker compose -p wikijump-standing -f /path/to/current/standing/compose.yaml stop

python install/standing/volume_transfer.py migrate \
  --record "$runtime_home/legacy-volume-migration.json"
```

`volume_transfer.py migrate` refuses to run while any `wikijump-standing`
container is running. It resolves the currently installed Deepwell image as a
network-disabled copy/verification helper, creates only the durable
`wikijump-standing-{postgres,files,cache}-data` destinations, copies with
numeric ownership/ACL/xattr preservation, and computes the same deterministic
tree digest for the legacy source before copy, the destination after copy, and
the legacy source again after copy. A mismatch fails closed. The legacy volume
is never deleted by the migration command. If an interrupted run leaves a
partial durable destination, inspect its consumers first and rerun explicitly
with `--replace-destinations`.

After the verified copy exists, activate the merged standing topology
whose Compose file names the durable volumes. Then prove that the running
database, files, and cache containers mount only the durable names while all
three legacy rollback inputs still exist:

```sh
python install/standing/volume_transfer.py post-cutover \
  --record "$runtime_home/legacy-volume-migration.json" \
  --output "$runtime_home/legacy-volume-cutover.json" \
  --runtime-home "$runtime_home"

pnpm --dir install/local/wikidot-verification run offline:browser
```

Also run the ordinary standing health, SCP-9506, file/object-store,
database/cache, WIKIREQUEST, AJAX ListPages, and `wikidot.py` canaries. Only
after those pass and `docker ps -a` shows no container mounting a
`runtime50x-*` volume may the three legacy volumes be removed. Their removal is
an explicit operator action; neither Compose nor `volume_transfer.py` performs
it implicitly. The optional `--runtime-home` binding is part of the cutover
proof: it refuses a Compose file that still names a legacy volume and updates
only `identity.json`'s persistent-volume identity plus the migration record
hash, so an older rendered home cannot keep advertising the retired names.

### Portable backup and clean-Ubuntu restore

The same tool is the repository-owned state-transfer path for a fresh Ubuntu
WSL instance. A consistent backup includes the three durable application data
volumes plus `local-caddy-data` and `local-caddy-config`, preserving the local
Caddy CA as well as Wikijump data. Quiesce the standing stack first:

```sh
helper_image="$(docker inspect -f '{{.Image}}' wikijump-standing-deepwell-1)"
docker compose -p wikijump-standing -f "$runtime_home/compose.yaml" stop

python install/standing/volume_transfer.py backup \
  --output-dir /absolute/backup/wikijump-standing \
  --helper-image "$helper_image" \
  --gzip

docker compose -p wikijump-standing -f "$runtime_home/compose.yaml" start
```

`manifest.json` seals each archive SHA-256 plus the deterministic extracted
tree digest. Keep that directory outside the disposable checkout/WSL instance.
On the clean Ubuntu instance, install Docker, clone the exact desired Wikijump
source, make the recorded (or another compatible GNU-tar) helper image locally
available, and restore before starting standing:

```sh
python install/standing/volume_transfer.py restore \
  --input-dir /absolute/backup/wikijump-standing \
  --helper-image sha256:<local-helper-image-id>
```

Restore refuses pre-existing destination volumes, verifies every archive hash
before creating any destination, then verifies each extracted tree. Render the
standing home from the clean checkout into
`${XDG_STATE_HOME:-$HOME/.local/state}/wikijump/standing`, activate it with the
normal merged-head promotion path, and rerun the same standing/browser
canaries. No `/home/roku/wjlab` path is required; an old WJLab tree is archive
provenance only.

The archive can also be rehearsed non-destructively on the source host while
the canonical durable volumes still exist. Supply a temporary lowercase Docker
volume prefix ending in `-`; the archive still has to name the canonical source
volumes, but extraction and tree verification use prefixed destinations:

```sh
python install/standing/volume_transfer.py restore \
  --input-dir /absolute/backup/wikijump-standing \
  --helper-image sha256:<local-helper-image-id> \
  --volume-prefix restore-rehearsal-
```

After a successful rehearsal, remove only those explicitly prefixed temporary
volumes. This is the same archive-hash, extraction, ownership/xattr, sparse-file,
and deterministic-tree verification path used by a clean-host restore; it does
not read from the live source volumes.
