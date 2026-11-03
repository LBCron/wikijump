# Runtime Drift Policy

This policy governs the local standing Wikijump runtime used for continuous browser and client compatibility checks. Its purpose is to keep the browser-facing service on one merged source revision and to stop an old candidate from silently taking over.

## Authoritative standing runtime

Port 443 is owned by exactly one standing Compose stack. That stack is built only from the current merged `develop` head and its committed FTML lock pin. It is not a branch checkout, a pull-request image, a local dirty tree, or a retained test container.

`install/standing/promote.py` promotes the merged `origin/develop` head in one command: it verifies the exact clean source, runs the final validation for the check groups the change selects, builds the application images labelled with that source from BuildKit caches, renders saved pages ahead when the renderer generation changes, rehearses on a copy of standing's data when migrations change, and activates with `docker compose up --no-build`. Activation itself never recompiles Rust or rebundles Framerail. One receipt records every stage. Local development remains the `install/local` watch-mode tier.

The standing stack must remain available as a deliverable. Its normal canaries cover HTTP responses for representative pages and assets, WIKIREQUEST metadata, AJAX ListPages, DOM rendering, and an unmodified `wikidot.py` site and page lookup. A failed canary is a runtime incident and is repaired before unrelated candidate work proceeds.

Standing state is not owned by a campaign workspace. The canonical runtime
home is `${XDG_STATE_HOME:-$HOME/.local/state}/wikijump/standing` unless an
operator supplies another absolute state path. Persistent application data is
attached through the durable external volumes
`wikijump-standing-postgres-data`, `wikijump-standing-files-data`, and
`wikijump-standing-cache-data`; the local Caddy state remains
`local-caddy-data` and `local-caddy-config`. Historical `runtime50x-*` volumes
are valid only as bounded migration rollback inputs and must not appear in a
newly rendered active topology.

Any persistent-volume migration is a separate quiesced data operation. Prove
source-before, destination-after, and source-after tree identity before
activating the new attachment, retain the old volume through cutover
validation, and remove it only after the new standing runtime and browser/client
canaries pass and no container references the legacy name. Use
`install/standing/volume_transfer.py` for the maintained copy, archive, restore,
and post-cutover checks.

## Candidate runtimes

Candidate stacks are isolated from the standing stack and never publish port 443. Each candidate carries owner, source SHA, and expiry labels.

Candidates may use a dedicated non-443 port or no host port. They must not share the authoritative service name or network alias while the standing stack is serving traffic. A candidate is removed when its run ends or its expiry passes.

## Candidate image lifecycle

Candidate images are disposable build outputs. Remove a candidate's containers and images when it ends, after confirming no live container uses them.

Keep the current production image and one immediate rollback image through a successful promotion. Image cleanup must never remove an image the live stack uses.

## Promotion after merge

Promotion begins only after the change has merged normally to `develop`, and its images are built from that merged head itself, so no pre-merge candidate has to be bound to the merge. Build reuse is content-addressed by BuildKit: unchanged runtime inputs rebuild from cache, changed ones are recompiled, and every image carries the merged commit, tree, and FTML labels activation verifies. Validation reuse is content-addressed by check group: a passing final receipt counts for a group when the difference between its tree and the merged tree does not select that group, so a documentation-only merge revalidates nothing while a runtime change revalidates exactly the groups it touches.

The switch is atomic from the browser's perspective: park the old standing application containers, start the exact merged-head containers with the authoritative aliases, wait for health, require zero stale saved pages, and run the HTTP canary and the standing browser parity. If any of these fails, remove the new containers, put back the saved-page output a renderer generation change replaced (snapshotted before parking), restore the parked known-good containers, and record the failed promotion receipt. A change that adds migrations is rehearsed on a copy of standing's data first, because the old build cannot start on the migrated schema. Do not leave a candidate under the standing container name after a failed or interrupted promotion.

`promote.py` writes `promotion-receipt.json` under `${XDG_STATE_HOME:-$HOME/.local/state}/wikijump/promotions/<sha>-<time>/` with each stage's duration and result.

## Measurements and maintenance windows

Browser-facing measurement work is normally performed against an isolated candidate. If a measurement must temporarily use the standing routing identity, the browser edges return an explicit 503 maintenance response for the bounded interval. The measurement wrapper owns restoration, verifies the exact production image after restoration, and reruns the standing canaries before releasing its lease. A candidate must never be served as a substitute for the standing runtime during that interval.

## Drift response

When the served revision disagrees with `origin/develop` or a canary fails, stop trusting that runtime and run `install/standing/promote.py`.
