# Local Wikidot verification tools

The scripts in this directory import frozen Wikidot corpus data, inspect a local runtime, capture browser output, and compare it with Wikidot. Expected behavior comes from the frozen corpus, reviewed policy, or a checked-in fixture, never from local output.

## Routine compatibility regression is offline

Routine development consumes repository-owned frozen observations and does not reacquire Wikidot, WDFiles, theme CDNs, or fonts.

Run the hermetic contract/unit suite plus the checked-in syntax differential with:

```sh
pnpm --dir install/local/wikidot-verification offline
```

The Node test runner may execute independent test files concurrently. Mocked
`capture-browser-rendering.mjs` CLI tests use separate, test-owned capture
locks and request-gate state paths **only** under the repository's offline
network guard (`WIKIJUMP_TEST_NETWORK_GUARD_ACTIVE=1`). This prevents false
cross-test lock contention while retaining the single global capture lock
for actual public-source acquisition. The fixture override is rejected if the
offline guard is absent; never set it for real Wikidot browser capture.

Run the product-owned WWS, Framerail, and Deepwell regression suites against
task-owned local services with external networking denied with:

```sh
pnpm --dir install/local/wikidot-verification offline:products
```

`offline:portable` runs both layers. This is the fresh-checkout compatibility
gate. It does not require any live Wikidot endpoint.

Run the full-page SCP-9506 browser oracle against a local standing runtime with:

```sh
pnpm --dir install/local/wikidot-verification offline:browser
```

`offline:browser` uses `fixtures/offline-compatibility/scp-9506-recapture-oracle.json`, the exact Chromium identity recorded in that oracle, a repository-owned external-response fixture, and the full-page Wikijump image accepted by the paired 2026-11-03 re-capture (the successor to the 2026-09-15 final-zero oracle, whose golden went stale after live Wikidot changed the page). Public stylesheet/font/image responses are replayed from the fixture. Any missing public response fails closed instead of fetching it. The semantic comparison uses the frozen Wikidot browser observation; the visual comparison uses normalized ImageMagick RMSE against the Wikijump image that passed the paired live comparison bound in the oracle provenance. The browser runs in a fresh user+network namespace with only loopback. A Unix-domain socket bridges that namespace's `127.0.0.1:443` exclusively to the host's existing standing `127.0.0.1:443`; Chromium has no external IP route at all. The harness locally fulfills only the exact `/local--favicon/favicon.gif` browser-internal request to prevent its standing redirect from escaping the sealed fixture model, and records that normalization in the verdict. For retained redirects to external CSS, the browser route fulfills the terminal response at the original origin because Chromium cannot follow the public redirect in its isolated namespace. The harness rewrites relative `url()` and quoted `@import` references in the *in-memory replay only*, relative to the retained terminal URL. The verdict records each such normalization; the source response fixture and frozen oracle remain unchanged. Missing font/image response bytes still fail closed.

Run the portable gate plus the local-standing browser oracle with
`pnpm --dir install/local/wikidot-verification offline:all`. Live-reference,
preview-capture, authenticated probe, and sandbox-mutation commands below are
acquisition tools for discovering a behavior that is not yet represented by a
frozen fixture. They are never prerequisites for an ordinary regression run.
After a reviewed acquisition, reduce the observation to a checked-in fixture
and test it offline thereafter.

## Deepwell test stacks seed once

`scripts/run-deepwell-integration-validation.mjs` runs the Deepwell suite as nextest shards, each on its own PostgreSQL, Valkey, and MinIO containers with one active test at a time. The shard parent seeds one stack, captures its PostgreSQL dump, MinIO bucket trees, and Valkey keys, and every shard restores that capture instead of running the seeder itself. A failed capture or restore discards that stack and seeds it the old way, with a loud log line.

The capture is keyed by everything that changes seeded state: migrations, the seeder directory, the locales it reads, `install/local/deepwell/config.toml`, the Deepwell binary, and the three image IDs. Every shard of one run shares the id layout of that one seeding; the seeder's own id layout varies between runs.

- `WIKIJUMP_DEEPWELL_SEED_CAPTURE=off` restores per-stack seeding.
- `WIKIJUMP_DEEPWELL_SEED_CAPTURE_ROOT=<dir>` keeps keyed captures across runs. This saves another 65 to 75 s (measured, 12 shards), but seeded rows then carry the capture's wall-clock times into later runs. Do not set it for a validation whose result is recorded as a PASS.

## Syntax differential runner

The syntax differential runner answers context-free “what does this wikitext render as?” questions by freezing anonymous live Wikidot previews once, then streaming the same syntax cases through one long-lived FTML process. The checked-in starter matrix is `fixtures/syntax-differential/preview-cases.jsonl`.

Capture a new no-replace Wikidot reference file with the repository-pinned `wikidot.py` environment:

```sh
install/local/wikidot-verification/.venv/bin/python \
  install/local/wikidot-verification/scripts/capture_wikidot_preview_references.py \
  --cases install/local/wikidot-verification/fixtures/syntax-differential/preview-cases.jsonl \
  --output /absolute/evidence/path/preview-references.jsonl
```

Routine regression uses Deepwell's exact pinned FTML dependency rather than a separate developer checkout:

```sh
pnpm --dir install/local/wikidot-verification offline:syntax
```

The command builds `deepwell/src/bin/wikidot_syntax_renderer.rs` with Cargo `--offline --locked`, then streams the checked-in `preview-references.jsonl` through that renderer. This keeps the oracle bound to the FTML revision actually used by Wikijump. For diagnostic work against another explicitly chosen FTML executable, the lower-level runner remains available:

```sh
cargo build --manifest-path /path/to/ftml/Cargo.toml --example render_html_jsonl
node install/local/wikidot-verification/scripts/run-syntax-differential.mjs \
  --references /absolute/evidence/path/preview-references.jsonl \
  --renderer /path/to/ftml/target/debug/examples/render_html_jsonl \
  --output /absolute/evidence/path/verdict.json
```

Each syntax case declares a `wikidot_observation_tier`, a `local_execution_tier`, and the page title supplied to both renderers. The current acquisition command accepts only `page-preview`; it performs no authentication or mutation. The current local runner executes only `ftml` cases and reports `wikijump-runtime` cases as `not-applicable`.

The verdict requires parsed DOM tree, DOM signature, and visible text parity. Parsing both fragments before comparison accounts for browser parser behavior such as implicit `tbody` insertion without hiding hierarchy, child order, attribute value, comment, or text-node differences. A mismatch retains both raw HTML fragments for diagnosis. The verdict also records the renderer executable SHA-256 and FTML engine revision. Live references record the resolved Wikidot site and domain, the pinned `wikidot.py` commit and version, and the dependency-file SHA-256.

Review the remaining static mismatches against the checked-in identity-bound policy:

```sh
pnpm --dir install/local/wikidot-verification syntax-dispositions -- \
  --verdict /absolute/evidence/path/verdict.json \
  --policy install/local/wikidot-verification/fixtures/syntax-differential/disposition-policy.json
```

The policy accepts only `intentional-security-boundary`, `wikijump-runtime-boundary`, and `live-observation-resource-failure`, and keys every entry on its case ID and source hash. An unknown mismatch, changed source, runner error, missing policy case, resolved exception, or policy entry aimed at a `not-applicable` case fails the check. Runtime cases remain outside this exception path: declare `local_execution_tier: wikijump-runtime` and let the syntax runner report them as `not-applicable`, then exercise them through the saved-page runtime lane.

### Report and repair include-closure source drift

A mirrored page renders through every page it includes, so a stale theme or component source changes the page even when the page itself is current. For example, an older `theme:basalt` revision lacks a later CSS rule, and every Basalt page then gets the old cascade. Report the drift of a page's transitive include closure against the canonical corpus with:

```sh
node install/local/wikidot-verification/scripts/report-mirror-include-drift.mjs \
  --corpus-root /absolute/path/to/canonical-corpus \
  --root scp-9506 \
  --site-id <scp-wiki site id> \
  --db-container <database container>
```

The command is read-only. It follows same-site `[[include]]` targets (skipping other sites, include-variable targets, and escaped documentation text), compares each page's current local revision source with the corpus source, and exits nonzero when any page is `drift`, `local_missing`, or `corpus_missing`. Before acting on a report, confirm the corpus slugs are current against live Wikidot as the corpus contract requires.

Repair drifted pages as new revisions: build an import manifest for exactly the drifted slugs with `build-corpus-import-manifest.mjs --fullname <slug>...`, apply it with `apply-corpus-import-manifest.mjs --create-mode db --replace-existing`, rerender the dependents, and rerun the report until it exits zero. `--replace-existing` appends a revision; it never rewrites or deletes existing rows.

### Import mirrored site icons

A mirrored site's favicon, iOS touch icon, and Windows tile are site-level assets (`site_icon`), not page files. `scripts/import-mirror-site-icons.mjs` reads which icons the source site's own head declares, fetches each through the identity-bound public evidence response cache (pass `--cache-dir`/`--cache-identity` to replay a retained store such as `scp9506-live-20261012-chromium149` with no network), and stores the bytes and observed media type with `site_icon_set`. A kind the source no longer declares is cleared, so re-running refreshes and removes stale icons. The session file holds a platform-staff Deepwell session; the RPC token comes from `DEEPWELL_RPC_TOKEN`.

```sh
node install/local/wikidot-verification/scripts/import-mirror-site-icons.mjs \
  --site scp-wiki --source-origin https://scp-wiki.wikidot.com \
  --rpc-url http://127.0.0.1:2747/jsonrpc --session-file /private/operator-session.json
```

### Verify imported source integrity

After materializing corpus pages, compare the selected local page's current revision source, stored corpus snapshot hash, latest import state, and (for selected complex canaries) compiled body length against the exact manifest source files. The command is read-only and exits nonzero for missing pages, changed or blank source, absent/mismatched provenance, incomplete import state, or a required empty body. Select the correct site ID explicitly when the local stack has more than one site:

```sh
node install/local/wikidot-verification/scripts/verify-corpus-import-integrity.mjs \
  --manifest /absolute/path/to/import-manifest.jsonl \
  --site-id 6000006 \
  --db-container wikijump-local-development-database-1 \
  --slug scp-5382 \
  --slug scp-7000 \
  --require-rendered-body scp-5382 \
  --require-rendered-body scp-7000
```

The manifest's source paths are re-hashed before querying the database. The report includes page and revision IDs plus source/provenance booleans, body character counts, and latest import state; it never prints the imported wikitext. The SQL client can instead use `DEEPWELL_VERIFY_DB_URL` or `--db-url` when a direct database connection is appropriate.

Corpus attachment rows use descriptor-bearing direct staging as their canonical import path. Run `apply-corpus-import-manifest.mjs` with `--attachment-create-mode direct`, or use `--skip-attachments` to defer them. The command rejects RPC attachment creation for selected corpus attachments because `file_create` would first commit the current host's libmagic descriptor and its post-commit outdate worker could make that approximation servable before corpus provenance replaced it.

## Wikijump identifier leaks

Imported content must carry Wikidot's own DOM names. The Wikidot stylesheet the page loads has no `.wj-` rules, so a leaked `wj-` class is an unstyled element as well as a tree difference.

```sh
pnpm --dir install/local/wikidot-verification wikijump-identifier-leaks -- \
  --site scp-wiki --rpc-url http://127.0.0.1:2747/jsonrpc
```

The check renders a battery of constructs through the local Deepwell runtime by anonymous page preview and fails if any `wj-` class, tag, id, or `data-wj-` attribute appears. The battery covers the constructs FTML renders differently under `Layout::Wikidot` (footnotes, bibliography, collapsible, code, tabview, math, table of contents, user, date, image, video, audio, tables, every link variant, alignment, lists, monospace, raw), the Wikijump-only blocks that must stay literal rather than render (`[[hidden]]`, `[[invisible]]`), and ListPages and CountPages row bodies. A construct that fails to render counts as a failure, since a render error hides whatever it would have emitted.

It requires a running local stack and creates no page. The `--rpc-url` must be loopback: pointing the battery at a remote host would send wikitext off the machine and describe someone else's runtime.

## Corpus-pinned compatibility rules

A compatibility rule earns its place by implementing what Wikidot does, not by recognizing a page the corpus happens to contain. A predicate that compares against a byte-exact fragment of a captured page reproduces that one page and diverges again as soon as a word or a line moves.

```sh
pnpm --dir install/local/wikidot-verification corpus-pinned-literals -- \
  --corpus /absolute/evidence/path/fresh-exact-live-references.jsonl \
  --corpus /absolute/evidence/path/fresh-literal-live-references.jsonl
```

The check is factual rather than stylistic. It extracts every string literal that sits where source text is matched against it, then reports the literals that occur verbatim in no more than eight captured pages. Measured against the 19,612-source campaign corpus, rules pinned to page content occur in one to eight captured pages while genuine module syntax occurs in 321 (`[[collapsible show="`), 658 (`[!--`), 7,803 (`created_at`) and 19,421 (`[[/module]]`); the threshold sits in that fortyfold gap. Pass every lane, because a literal absent from one lane can still be pinned in another. Rust `#[cfg(test)]` modules are skipped, since regression tests are supposed to hold corpus source.

Matches of sixteen characters or more are findings; shorter ones are notices. Short markup vocabulary such as `<br>`, `&quot;`, `[[html]]` and `~~~~` is also rare in a ListPages corpus without having been lifted from any page, and on the current render tree every rare literal at or above that length was genuine page content while every shorter one was vocabulary. Notices still deserve a look, since `属性...` and `@@*@@ ` are short and genuinely pinned; they simply cannot carry a gate on their own. The command reports without failing by default. Pass `--strict` to exit non-zero on findings.

Findings name the exact pages a literal came from. Resolve one by implementing the rule those pages demonstrate, proven by live observation including negative controls, or by leaving the case actionable and recording it as unimplemented. `fixtures/corpus-pinned-literals/allowlist.json` accepts a literal only when the pinned form is genuinely the whole of Wikidot's behavior, and requires at least two live observations per entry.

The check reads string literals only. A rule can overfit through an exact conjunction of ordinary syntax tokens without any corpus-derived literal, so a clean report is not proof that a rule generalizes.

## Python environment

The authenticated Wikidot helper runs from this component's private `.venv`. The runtime package subset mirrored from the frozen `requirements.txt` manifest lives in `requirements-pypi.txt`, build packages live in `requirements-build.txt`, and both are hash-locked in `requirements.lock`; the owner's `Rokurolize/wikidot.py` fork remains pinned separately to a full commit in `requirements.txt`. The setup script first installs the hash-locked bootstrap tools from `requirements-bootstrap.lock` (pip 26.2.2 and certifi 2026.10.19), then the hash-locked application packages, fetches only the pinned commit, verifies the checked-out `HEAD`, and installs the fork without dependency resolution or build isolation. This first step avoids making a package request with an older `ensurepip` pip/certifi bundle after the eMudhra/emSign CA incident. It requires `uv >= 0.13.4` and uses the official PyPI index for the security bootstrap and locked packages. To regenerate the locks, run `uv pip compile requirements-bootstrap.in --index-url https://pypi.org/simple/ --generate-hashes --output-file requirements-bootstrap.lock` and `uv pip compile requirements-pypi.txt requirements-build.txt --index-url https://pypi.org/simple/ --generate-hashes --output-file requirements.lock`. Create or refresh the environment before using the theme-localization execution path:

```sh
install/local/wikidot-verification/scripts/setup-python-env.sh
```

The helper never imports from a mutable host checkout. Credentials remain environment-only inputs to the helper process.


## Read-only browser capture

`scripts/capture-browser-rendering.mjs` uses a fixed host-wide capture lock and durable request-gate state under `/var/tmp/`. External evidence is cache-first: identity-bound retained responses are replayed without another public request, a genuine cache miss is acquired once and persisted for reuse, and the fixed inter-request interval is 0 ms. The source and local browser contexts share the same persistent response cache; exact local origins stay exempt, while any incidental external dependency emitted by the local page must replay from that cache or perform the one guarded acquisition. Anonymous document caching and exact `Vary` binding are enabled by default so omitting an optional cache flag cannot silently revert a repeated run to in-memory-only acquisition. An explicit server `Retry-After` deadline is still persisted and honored for cache misses. Service workers and WebSockets are blocked. The command accepts only canonical standing `https://<site>.wikijump.localhost` page URLs as local exemptions and derives the matching `https://<site>.wjfiles.localhost` file origin; public or credentialed inventory values fail before browser startup. It seals `request-gate-config.json` before starting the proxy or browser and records final gate counters in `records.json`. A failed state confirmation leaves the lock pending and blocks a later capture until an operator reviews it.

For anonymous read-only source inspection, `--source-only` skips the local context. An inventory row may declare `capture_states`, each with a stable `state_id`, viewport, and actions. The state runner permits only search-field fill, focus, hover, scroll, safe hash targets, and clicks on an explicit list of non-mutating navigation/tab/collapsible/credit controls. It reloads the same source URL for each state and retains the final DOM, screenshot, status, action result, and hashes. `blocked_source_request_prefixes` may exclude exact HTTP(S) host/path prefixes that are already known to be outside the captured contract; every excluded request is recorded on the evidence row. Do not use those exclusions to hide required platform markup, site CSS, or first-party behavior.

## Standing browser parity

`scripts/run-standing-browser-parity.mjs` is the browser check of a standing promotion. `install/standing/promote.py` runs it twice: in `candidate` mode against the rehearsal (only when migrations change), and in `standing` mode after activation, where a failure rolls standing back. Both modes compare six production-theme canaries (`src/standing-browser-canaries.mjs`) with a retained live Wikidot reference and replay public resources from a persistent response cache only (zero external requests).

The reference is retained once in `${XDG_STATE_HOME:-$HOME/.local/state}/wikijump/standing-browser-reference/reference.json`. It names the live completion policy, the reference ledger, the response cache directory and identity, the browser executable, and `candidate_public_port`. The port matters: cross-origin theme fonts and stylesheets answer with `Vary: Origin`, so a cached response replays only for the candidate origin it was captured from, and a candidate on any other port fails with "candidate response cache miss". Promotions never recapture the reference. Recapture it with `--mode live-reference` only when the canary contract or the live pages change, then update `reference.json`:

```sh
node install/local/wikidot-verification/scripts/run-standing-browser-parity.mjs \
  --mode live-reference \
  --output-dir <new reference directory> \
  --live-completion-policy <policy.json> \
  --source-response-cache-dir "$HOME/.cache/wikijump-verification/candidate-public-evidence-v1" \
  --source-response-cache-identity wikijump-candidate-public-evidence-cache-v1 \
  --cache-source-documents \
  --browser-root framerail \
  --browser-executable /usr/bin/google-chrome
```

`candidate` mode captures from a non-443 candidate (`--candidate-port`). `standing` mode captures the canonical local `https://scp-wiki.wikijump.localhost` and `https://scp-wiki.wjfiles.localhost` authorities on port 443 without rewriting their origins. Candidate mode never targets port 443; standing mode intentionally does, because changing the standing origin or port changes CSP and resource semantics. A candidate that serves a copy of standing's data must re-render the canary pages first. The result is written to `standing-browser-parity.json` in the output directory.

For a direct Framerail candidate that is not behind WWS, `--site-id ID` injects the non-secret trusted routing identity for the fixed `scp-wiki` authority. Omit it when exercising the complete edge path.


## Bounded corpus page discussion import

`capture-corpus-discussion-identities.py` is an explicit discovery tool. Run it
through the local `wikidot.py` fork's pinned environment, with a previously
retained thread document, its source URL, a private output directory, and a
private response cache. It reads only `forum/ForumViewThreadPostsModule` as an
anonymous actor. Persistent cache barriers prevent refetch after interrupted
acquisition; complete responses replay without network access. Replay retains
the original response capture time. This is not a CI acquisition command.

`build-corpus-discussion-manifest.mjs` is offline. Its explicit inputs are the
shared corpus root/branch/page, retained page DOM and thread document, visible
and complete forum structure documents, the identity observation, target site
and page IDs, and output path. It requires complete corpus membership and
immutable post payloads, agrees with the retained source inventory and body,
and binds their hashes in a `wikijump.corpus_discussion_import_manifest.v1`.
XML-RPC avatar placeholders resolve only against the exact corresponding live
user image authority. Attribute ordering introduced by the source client's
HTML serializer is irrelevant to this data comparison; all values, DOM nodes,
styles, timestamps and internal text remain compared.

Send the manifest's `params` to `import_wikidot_discussion` with the existing
trusted Deepwell service and platform-staff request actor. Caller-supplied
user IDs do not authorize the import. The target must be an active imported
page with a matching corpus page snapshot and comment count. The transaction
preserves source category/thread/post IDs and reply links, appends changed
post revisions, and journals source provenance. Identical snapshots are
idempotent; older/conflicting observations, foreign IDs, local revisions,
ambiguous containers, unobserved removals and restores fail closed. Deletion
reconciliation, ordinary forum thread import, private source acquisition, and
complete site forum import remain outside this bounded operation (#2075).

Public identity observations populate `known_user` and descriptive metadata,
without creating login accounts, roles, sessions, registration dates or full
profiles. Full profiles remain authoritative for profile/directory surfaces.
Wikidot user syntax and public forum author projection may use the observed
identity. A cached source post body can retain a pre-rename identity while its
author metadata is current; these observations stay scoped to the imported
revision and pass through the ordinary FTML user resolver, not a copied HTML
body. Source edits create revisions without fabricating missing history.

Renderer epoch 17 marks the persisted rendering change. A candidate must run
its normal source-owned rerender/finalizer before saved-page acceptance.
Import into the isolated candidate first. Standing still requires the normal
promotion and fresh browser proof; a manifest or successful import is not a
compatibility acceptance record.

