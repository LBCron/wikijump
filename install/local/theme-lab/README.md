# theme-lab

Agent-facing iteration harness for porting foreign SCP-branch themes/CSS to
SCP-JP. The objective is not Wikijump startup time; it is **edit → actionable
verdict latency** and **information per trial**. A theme port should not require
a save, a page rerender, a cache invalidation, or a browser launch per attempt.

For a **new** foreign-branch port, start with
`ports/NEW-FOREIGN-THEME-PORT.md`; do not infer the source-acquisition and
package workflow from an old completed campaign. Agent routing starts at
`docs/agents/theme-lab.md`.

This is a development tool, intentionally separate from
`install/local/wikidot-verification` (whose offline suites forbid external
network access and whose theme-localization runner is a hand-authored,
receipt-driven validator, not a generic loop).

## The loop

```
edit CSS/wikitext
  -> apply to the real SCP-JP DOM (no reload, no save)
  -> compare against a foreign reference (acquired once, replayed locally)
  -> detect desktop/mobile breakage
  -> check standard UI components for regressions (torture corpus)
  -> return a compact structured JSON verdict with the next things to fix
```

## Commands

Start one persistent session (Chromium + candidate/reference tabs):

```sh
export DEEPWELL_RPC_TOKEN=...   # from the local dev stack
node scripts/theme-lab.mjs serve \
  --socket /tmp/theme-lab.sock \
  --candidate-url https://scpaiueouiuiuiui.wikijump.dev.localhost:18443/<page> \
  --asset-dir /absolute/path/to/port/assets \
  --sidebar-html /absolute/path/to/sidebar-preview.html \
  --allow-private               # only for localhost references/fixtures
```

The one command that matters:

```sh
node scripts/theme-lab.mjs check --socket /tmp/theme-lab.sock \
  --site-id 6000003 \
  --wikitext candidate.wikidot.txt --syntax-only \
  --css candidate.css \
  --reference https://<foreign-branch>.wikidot.com/<page> \
  [--offline] [--visual] [--artifact-dir /tmp/theme-lab-artifacts] \
  [--selectors selectors.txt] [--no-torture] [--no-viewports] \
  [--verbose | --json-full]
```

`check` returns one final result: `verdict` and `overall_acceptance.status`
combine `port_decision.verdict` with `target_acceptance.status`. Either failure
makes the final result `fail`; an inconclusive port makes it `inconclusive`;
otherwise a warning yields `warn`, and both passes yield `pass`. CLI exit codes
are 1 for failure, 2 for inconclusive, and 0 for pass/warn. A successful socket
request (`ok: true`) alone is not acceptance. `--verbose` adds raw selector rows,
computed-style rows, and the full torture result.

Publication also requires the [adaptation-authority gate](ports/ADAPTATION-AUTHORITY-AUDIT.md).
Local target acceptance and synthetic fixture results cannot authorize JP CSS.
Use `scripts/wikidot-adaptation-ab.mjs` with frozen read-only Wikidot replay to
prove a target correction. Its receipts bind both viewport edges, every submenu
and link, the exact CSS, DOM, screenshots and acquisition identity. Generation
rejects missing dispositions, stale evidence and non-publishable quarantine.
Use `--state navigation-action` to exercise the production navigation helper
without revealing submenu CSS. Use `--state sidebar-closed --selectors '#side-bar'`
to require a nonempty drawer wholly off-canvas, and pair it with `sidebar-open`
to prove the actual open control exposes a contained drawer. A closed drawer
cannot be judged by the ordinary inside-viewport geometry contract.

For a normal full check with both `--site-id` and candidate CSS, Theme Lab also
runs the SCP-JP runtime **surface contract** by default. It parses the
candidate CSS, discovers the known runtime surfaces actually touched by its
selectors, renders the repository-owned high-fidelity JP component fixture,
and checks only the relevant states. Examples include desktop/mobile header
geometry, an expanded mobile top-menu, an open mobile sidebar, rating focus,
credit normal/open states, tab selection and collapsibles. Each surface is
measured once with the JP baseline and once with the candidate CSS so a theme
cannot accidentally flatten a responsive baseline rule without producing
evidence. State-specific horizontal overflow is attributed to the surface that
owns the offender rather than to every component on the page.

The default contract is equivalent to `--surface-contract auto`. A port may
pass `--surface-contract ports/<slug>/surface-contract.json` to add active
theme-specific selectors and evidence-backed reviewed exceptions. Use
`--surface-contract off` only for a deliberately scoped diagnostic; it is not a
valid final acceptance shortcut. `--iteration` omits the surface contract,
along with the other expensive final-acceptance checks, for edit-loop speed.

## Wikidot parity is a prerequisite for port requirements

The JP surface contract proves how candidate CSS affects the local Wikijump
runtime. It does not prove that runtime matches Wikidot. Theme Lab therefore
uses [`fixtures/runtime-surface-parity.json`](fixtures/runtime-surface-parity.json)
as a separate source/runtime trust boundary. Each CSS-discovered and
interactive-fixture surface has an explicit status, provenance, implementation
and test references, intentional differences, and remaining evidence gaps.

The machine-readable registry now separates parity authority from local target
acceptance. The 41 CSS-discovered and interactive SCP-JP runtime contracts
remain in the local acceptance matrix, but their observations cannot establish
Wikidot parity or create parity-based port actions. Their failures remain
visible in `target_acceptance`; candidate asset and include failures remain
actionable because they do not depend on runtime-surface parity. Only an exact
`PARITY_CERTIFIED` scope can create a parity-based port requirement. A direct
observation with no current disposition still blocks the port conclusion.
Synthetic diagnostic states and naming aliases are explicitly classified and
cannot certify a runtime contract.

History is the initial scoped example. Current anonymous SCP-EN and SCP-JP AMC
responses prove the same seven-cell History table DOM; the Japanese response
also proves one file-deletion event's place in that timeline. They do not prove
mobile presentation, pager transitions, action outcomes, or other file
revision variants. The overall `page.history` row is therefore still
`INSUFFICIENT_EVIDENCE`; only `page.history.table-dom` and
`page.history.file-revision-timeline` have narrow parity authority. Read-only
source-side browser captures and exact module receipts add bounded observations
for shell and interaction states, but do not certify those broader contracts.
See
[`ports/RUNTIME-SURFACE-PARITY-AUDIT.md`](ports/RUNTIME-SURFACE-PARITY-AUDIT.md)
and its accounting fixture before interpreting any port finding on these
surfaces.

For repeated edits after opening/capturing the reference, use `check --iteration`
to get the selector, cascade, candidate-asset, and preview verdict without
rerunning viewport, torture, interaction, or screenshot acceptance. The JSON
marks those checks as deferred in `verification_scope`; use the default full
check before accepting a port. A CSS-only iteration can omit `--wikitext` when
the current candidate DOM is already the intended preview.

Lower-level commands, for targeted work:

```sh
theme-lab css --file candidate.css [--torture-site-id 6000003]   # live CSS + optional guard
theme-lab preview --site-id 6000003 --file preview.wikidot.txt --syntax-only
theme-lab torture --site-id 6000003
theme-lab reference --url https://<branch>/<page> [--offline]    # acquire + replay
theme-lab diff --reference-url <replay-url> [--selectors selectors.txt]
theme-lab snapshot | viewport --size 390x844 | screenshot --path shot.png
theme-lab probe --selector '#main-content' --property margin-left --viewport 390x844
theme-lab status | stop
```

All commands print one JSON document. Failures carry a stable `error.code`
(`no_candidate_page`, `no_preview_client`, `invalid_site_id`, `no_daemon`,
`socket_in_use`, `reference_offline_miss`, ...).

## Verdict shape

```json
{
  "verdict": "fail",
  "timing_ms": {"reference_ms": 12, "torture_ms": 124, "total": 171},
  "top_issues": [
    {"kind": "missing_selector", "selector": ".foreign-rate-box", "reference": 1, "candidate": 0,
     "reference_role": "rating_widget",
     "suggested_candidate": {"selector": ".page-rate-widget-box", "confidence": 0.94,
                             "evidence": ["same semantic anchor"]}},
    {"kind": "became_invisible", "component": "table", "viewport": "mobile"}
  ],
  "style_changes": [
    {"anchor": "#page-content", "property": "width", "reference": "1120px", "candidate": "900px",
     "cascade": {"status": "overridden",
                 "winner": {"selector": ".scp-jp-content", "important": false, "specificity": [0,1,0]},
                 "media_inactive": [], "variables": null}}
  ],
  "reference": {"reference_selector_count": 42, "missing": 1, "collapsed": 0, "expanded": 0},
  "torture": {"verdict": "pass", "issue_count": 0},
  "visual": null
}
```

The verdict never dumps raw browser data by default. Geometry/font changes that
are not inherently wrong are reported as `style_changes`, not as errors.

Compact check results include per-viewport overflow status, the Chromium platform font(s) used to draw the Japanese glyph specimen, and interaction observations for tabs, collapsibles, hover/focus, and fixed/sticky header scrolling. The interaction probe restores the original tab, collapsible, and scroll state before torture runs. `--verbose` includes source geometry for any viewport failure.

`surface_contract` in the compact verdict lists the touched runtime surfaces,
theme-specific selectors, reviewed findings and remaining issue count.
`--json-full` additionally exposes baseline/theme computed-style captures for
each state. A candidate that styles a real component is tested against the
real repository-owned component fixture; do not replace a missing component
with an ad-hoc approximation merely to make a CSS selector match.

`next_actions` contains only steps grounded in a missing selector, overflow measurement, missing candidate asset, or inactive media query with a measured cascade winner. An intentional font or color change alone does not create a repair action. A provided selector list is measured directly even when its entries do not appear as exact CSS rule selectors. Count changes where both pages still contain the element are warnings because two real theme articles can repeat the same component a different number of times.

## Reference acquisition (once) and local replay

Foreign reference resources are fetched **once**, stored by SHA-256 under
`$XDG_CACHE_HOME/wikijump/theme-lab` (default `~/.cache/wikijump/theme-lab`),
and thereafter served by a loopback replay server. The persistent Chromium
reference tab loads the replay, so iteration is fully local.

- Follows stylesheets, nested `@import`, `url()` assets, fonts, images, `srcset`.
- Records redirects and final URLs in a manifest; identical bytes are stored once.
- Rewrites HTML/CSS references to loopback object paths; optional subresources
  that fail are recorded as `failed_assets` and pointed at `/missing`, never the
  foreign origin.
- SSRF guards: `http`/`https` only, no credentials, loopback/private hosts
  rejected unless `--allow-private` (local fixtures), DNS rebinding check,
  object size cap, redirect cap, `@import` depth cap, asset cap, fetch timeout.
- `--offline` forbids all network and fails closed on a cache miss.
- Reference selector counts/elements are cached in-session, so only the
  candidate is remeasured until the reference URL changes.
- Inline `<style>` imports and assets are captured and rewritten too. A complete snapshot is reused without another acquisition pass; optional asset failures retain their URL and cause. Browser tabs deny external requests and report blocked attempts separately from successful acquisitions.

## Local candidate assets

Pass `--asset-dir` to `serve` when CSS uses `url("./assets/name.png")` or a font file in the same form. Theme Lab validates regular files and replaces those URLs with `data:` bytes only in the injected copy. This preserves readable candidate CSS and works with the local Wikijump page's CSP. Missing names appear as `candidate_asset_missing` in the verdict. `--sidebar-html` fills an empty local authoring-site `#side-bar` with a task-owned DOM fixture so foreign sidebar selectors can be assessed without saving global site navigation.

The completed SCP-KO Dear Dictator → SCP-JP run is in `ports/dear-dictator/`. Its `PORT.md` records the reference, decisions, exact offline command, and self-contained Wikidot source builder.

The generic new-foreign-port workflow is in
`ports/NEW-FOREIGN-THEME-PORT.md`, with the completed SCP-FR
`theme:quand-le-soleil-se-couche` → SCP-JP package in
`ports/quand-le-soleil-se-couche/`. That package demonstrates exact anonymous
Wikidot source acquisition, include/dependency inspection, third-branch and
existing-JP evidence, include-variable handling, local-vs-public asset
materialization, an evidence-driven JP navigation repair, offline acceptance,
paired visual review, a package-specific surface contract, preservation of the
JP responsive header baseline, and a deterministic publishable source.

The current SCP-EN 34-theme campaign uses `ports/en-theme-campaign.json`, individual port receipts, a committed deduplicated `ports/shared-replay-assets/` pool, and the sequential 35-port runner `node scripts/real-port-regression.mjs`. The runner verifies frozen EN/JP source hashes and pooled asset digests before checking each candidate. Its candidate daemon uses the shared pool; the Dear Dictator daemon uses its packaged assets/sidebar fixture. Set `THEME_LAB_SOCKET`, `THEME_LAB_DEAR_SOCKET`, and `THEME_LAB_ASSET_DIR` to their sockets/pool. The runner also reads each daemon's `status.asset_dir` and fails closed when that pool does not contain a frozen asset digest, because a daemon pool older than the committed pool would otherwise report `candidate_asset_missing` for assets the package already declares and dress the gap up as a port-authoritative finding. It performs offline visual checks and records warning-only cases separately from errors and actionable failures. Use `--iteration` only for the normal edit loop; it is not a final acceptance run. See `ports/README.md` for replay setup.

## Measured performance (local dev `scpaiueouiuiuiui`, site 6000003)

| metric | observed |
| --- | ---: |
| CSS edit → selector + computed-style probe | **~11 ms** median |
| wikitext edit → preview DOM (`--syntax-only`) | **~16 ms** median |
| 300-selector diagnostic | **~87 ms** median |
| 11-component × 4-viewport torture corpus | **~123 ms** median |
| 4-viewport layout probe | **~32 ms** |
| desktop screenshot | **~51 ms** median |
| legacy core check before surface-contract phase | **~170 ms** median warm |
| surface-contract phase, representative accepted themes | **~4.2–7.6 s** |
| full FR acceptance with surface contract + 8 visual screenshots | **~7.2 s** |

The EN34 campaign's heavy full acceptance check is profiled separately from
the edit loop; its showcase previews, reference DOM reads, four viewports,
and torture run are not repeated for every CSS change. After one warm preview,
`check --iteration` updates the persistent candidate stylesheet and returns a
local reference/cascade verdict. The campaign measured 102 changed-CSS checks
across 34 themes; see `ports/warm-edit-verdict-benchmark.json` for the exact
median, maximum, and per-theme timings.

The surface-contract phase is intentionally a final-acceptance cost, not part
of the hot edit loop. Its first implementation repeated the same normal-state
desktop/mobile measurement once per touched surface (~25.4 s on Black
Highlighter); the current implementation measures the union once per
viewport/baseline/theme mode and fans the evidence back out to each surface
(~7.6 s on Black Highlighter, ~4.3 s on Penumbra, ~4.2 s on Classic in the
same local stack).

## Reuse

- `src/browser-lab.mjs` — Playwright launch or `connectOverCDP`; live style
  injection; batched cross-page probes; cascade collection.
- `src/css-probe.mjs` / `src/cascade.mjs` / `src/semantic-anchors.mjs` /
  `src/verdict.mjs` — pure analysis.
- `src/reference-cache.mjs` / `src/reference-replay.mjs` — acquisition + replay.
- `src/deepwell-preview.mjs` — Deepwell `wikidot_page_preview` client.
- `src/torture-corpus.mjs` / `src/visual-diff.mjs` — regression guards.
- `src/daemon.mjs` / `src/errors.mjs` — session lifecycle and stable errors.

## Tests

```sh
npm test
# npm test runs: node --test --test-concurrency=4 --test-timeout=240000 tests/*.test.mjs
# The finite concurrency and timeout keep the browser-heavy suite deterministic;
# unbounded runs exhaust the host and stall instead of failing.
```

Includes pure unit tests, a fixture HTTP server proving once-then-local
acquisition/offline behavior, and browser integration tests (using the
checked-in Wikidot base theme CSS) that assert semantic mapping, cascade
diagnosis, a broken-CSS canary that must fail, and a zero-request offline run.

## Not built

- A standalone resident FTML renderer that does not require a live Deepwell,
  database, Redis, and S3. The current preview reuses Deepwell's
  `wikidot_page_preview`, which is ~10–25 ms, so this is only worth doing if
  the stack dependency becomes an agent-session obstacle.

## Current campaign completion

For a **PR change-impact work plan**, use
`node scripts/plan-change-impact.mjs --base origin/develop` from this checkout.
The planner reads the 36 maintained adaptation packages, the frozen 145-row
policy, and the available historical theme include graph. It prints JSON
containing mandatory coverage, an advisory priority queue, and reasons for
any inability to narrow the run. Runtime, source, asset, or unknown changes
conservatively require all 36 themes (5,220 canonical state obligations).
Documentation and test-code-only changes can avoid new target captures, but
must still pass their ordinary checks. The upstream dependency graph currently
covers only 34 of 36 maintained themes; its priority suggestions are not a
correctness proof. The planner cannot substitute for a current-runtime
acceptance receipt or the final campaign gate.

Choose verification cadence and evidence retention from supported revisions,
measured cost, change rate and risk, rather than a fixed number of years.
See `ports/LONG-TERM-VALIDATION-OPERATIONS.md`.

Historical source and screenshot integrity can be inspected with
`node sigma10-migration/check-final.mjs --historical-only`. This does not accept
current candidates or authorize promotion.

The final campaign gate is `node scripts/check-campaign-completion.mjs` (also
`node sigma10-migration/check-final.mjs` with no options). Promotion requires
both a full combined current acceptance for every maintained package and a
separate `theme_lab_current_sigma10_acceptance.v1` receipt for the current
Sigma-10 candidate matrix. That receipt binds the current migration run contract,
browser audit, candidate CSS/source identities, complete browser coverage, and
reviewed screenshots. Historical integrity and screenshots remain inspectable
with `node sigma10-migration/check-final.mjs --historical-only`; that command's
`evidence_integrity.status` describes only archive integrity and its
`overall_acceptance.status` is always `inconclusive`.

Current completion CLI exit codes are 0 for accepted, 1 for failed/stale
evidence, 2 for missing or inconclusive acceptance, and 64 for invalid command
options. The JSON `overall_acceptance.status` is authoritative; historical
inspection success never means campaign acceptance.

After current browser evidence and direct reviews are complete, finalize each
package with `node scripts/finalize-current-package.mjs --package NAME
--result PATH --review PATH --audit PATH --output ports/current-acceptance/NAME`.

For a fresh **Sigma-9 full-check capture**, use
`node scripts/run-current-full-check.mjs basalt /path/to/frozen-reference-cache --run-id=basalt-YYYYMMDD-new-runtime`
from the Theme Lab directory after provisioning a task-owned built Framerail
transport with a current SHA-pinned run contract. If the new contract is at a
different path, supply `--run-contract=/absolute/path/to/current-run-contract.json`
(inside the Theme Lab tree). The capture reads `target_site.origin` from that
contract, probes the required runtime/backend identity headers, and writes its
result and artifacts under `ports/current-acceptance/basalt/runs/<run-id>/`.
Existing run directories fail closed rather than overwriting the sealed
October 7 evidence. This creates an input for review, **not a PASS**: use the
same current run contract and fresh interactive audit for final acceptance.

Generate the new run contract from **measured source and the running Deepwell**,
rather than repinning old receipts by hand. The runtime checkout must own the
live Deepwell source mounts, match the explicitly required Git commit, and have
no tracked Framerail, Deepwell or locale modifications:

```sh
node scripts/prepare-current-runtime-contract.mjs \
  --runtime-repo=/absolute/path/to/runtime-checkout \
  --required-head=<exact-40-character-git-commit> \
  --run-id=basalt-current-run --port=3396 --check-only=true
# Repeat without --check-only=true to create an immutable new contract.

node ports/interactive-visual-fixture/ensure-built-framerail.mjs \
  --runtime-repo=/absolute/path/to/runtime-checkout \
  --namespace=basalt-current-run --port=3396 \
  --run-contract=/absolute/path/to/run-contract-basalt-current-run.json
node ports/interactive-visual-fixture/capture-theme-matrix.mjs \
  --theme=basalt --state=page.normal.settled \
  --engine=chromium --viewport=desktop --anonymous \
  --transport-origin=https://scpaiueouiuiuiui.wikijump.localhost:3396 \
  --run-contract=/absolute/path/to/run-contract-basalt-current-run.json \
  --runtime-repo=/absolute/path/to/runtime-checkout \
  --backend-project=wikijump-theme-lab-<namespace>   # task-owned backend only
```

A task-port contract's `target_site.origin` must equal `--transport-origin`;
only the shared development contract keeps the fixed `:18443` logical origin.
For a task-owned backend, `--runtime-repo` and `--backend-project` (supplied
together) make the capture measure that Compose project's Deepwell against the
runtime checkout that owns its source mounts. The primary fixture page
`run-owned:theme-lab-visual-acceptance-20260924` is created by
`provision-fixture.mjs` on a fresh backend; fixture provisioning must precede
`ensure-built-framerail.mjs` because readiness probes the imported fixture page.

This initial public capture is a readiness test, **not the 145-state acceptance
or the Sigma-10 check**. The built sidecar requires a unique namespace when
reading another checkout. A source-bound older commit also must not be passed
off as the latest `origin/develop`. Its Deepwell source identity ignores only
known generated locale installs (`locales/typed/node_modules` and
`locales/validator/target`); actual locale source and unexpected symlinks
remain strict fingerprint inputs.

The Sigma-10 migration contract has a sibling command. It measures the same
task runtime and writes nothing with `--check-only=true`:

```sh
node scripts/prepare-sigma10-runtime-contract.mjs \
  --runtime-repo=/absolute/path/to/runtime-checkout \
  --required-head=<exact-40-character-git-commit> \
  --run-id=basalt-current-20261022 --port=3396 \
  --backend-project=wikijump-theme-lab-<namespace> --check-only=true
```

Without `--check-only=true` it needs an explicit `--output` equal to the
canonical `sigma10-migration/current-campaign/run-contract-<run-id>.json`
(the only task-owned path the completion gate accepts, and only when it is named
explicitly with `--sigma10-run-contract=`). It creates that file exclusively,
and removes it if `validateCurrentSigma10Contract` rejects it. The builder
starts from the sealed `e56609...` Sigma-10 copy, regenerates candidate
identities from current bytes, verifies frozen authority, saved Credit and
fixture hashes against disk, and refuses when the frozen publication candidate
set does not validate. It never re-pins a frozen hash. Its `capture_blockers`
list records migration fixture paths that `capture-interactive.mjs` cannot
resolve from `current-campaign/`.

For a backend that must run from a **different, current Git checkout**, first
check the isolation of the intended disposable Compose project without
starting any container:

```sh
node scripts/prepare-isolated-runtime-stack.mjs \
  --runtime-repo=/absolute/path/to/current-checkout \
  --required-head=<exact-40-character-git-commit> \
  --namespace=basalt-current-unique
```

This validates an effective `docker compose config` generated from the
checkout's base and development YAML plus a task-namespaced override. The
configuration exposes **no host ports** and uses **no shared named volumes**,
enabling independent database/cache/object-store data. Framerail, WWS and
Caddy are excluded from this backend-only startup plan. Supply
`--write=true --output-dir=/absolute/outside/repository` to write the
verified override with exclusive creation. It does not build, start, stop or
remove Docker resources; separately coordinate memory and source deployment
before launching the full service set, then prove its executable provenance.

When that separate backend has been built and started by its owner, bind the
capture contract to the task-owned Deepwell Compose project rather than the
shared local-development backend by adding
`--backend-project=wikijump-theme-lab-<namespace>` to both
`prepare-current-runtime-contract.mjs` and `ensure-built-framerail.mjs`.
The built sidecar checks that its backend project matches the task namespace,
selects the independently provisioned Docker network and mounts only
checkout-local Framerail dependencies and assets read-only. Its Deepwell RPC
token is read from that task backend at launch. The old shared development
containers act only as an image/environment template; protected volumes and
the task backend's object/database storage remain separate. A collision with
an existing capture sidecar is treated as an error rather than silently
replacing another agent's environment.

**Fixture provisioning is a separate mutating operation.** The four page
writers (`scripts/provision-canonical-corpus.mjs`,
`ports/interactive-visual-fixture/provision-fixture.mjs`, its
`provision-credit-variants.mjs` companion, and
`sigma10-migration/provision-fixtures.mjs`) now refuse implicit RPC fallback.
Shared-development writes require the explicit
`THEME_LAB_FIXTURE_SCOPE=shared-development`, still bound exclusively to
`http://127.0.0.1:2747/jsonrpc`. For a task backend, set
`THEME_LAB_BACKEND_PROJECT=wikijump-theme-lab-<namespace>` and
`DEEPWELL_RPC_URL=http://wikijump-theme-lab-<namespace>-deepwell-1:2747/jsonrpc`.
Run the writer inside a *disposable Node container attached only to that task
project's Docker network*, with source fixtures mounted read-only and the
task-local `DEEPWELL_RPC_TOKEN`/admin credentials in a private environment
file. Do not execute a task-mode provisioner directly on the host against the
shared local-development RPC port. All four writers also assert that the
seeded `scpaiueouiuiuiui` site's ID matches the candidate Caddy's `6000003`
before any edit. Incorrect task project, endpoint, or seeded site identity
fails closed. These are source- and mock-tested guards, not evidence that
the new task backend has been started or its fixtures provisioned.

The fifth mutating fixture script,
`ports/interactive-visual-fixture/provision-file.mjs`, uploads or removes a
run-owned attachment through the browser. It likewise requires explicit
shared-development scope, or in task mode an absolute `--run-contract=` for
the private HTTPS transport. Before logging in or writing, it verifies the
served Framerail source and Deepwell runtime identity response headers against
that contract. No implicit fallback to the shared `:18443` origin is allowed
for task-mode attachment operations.

The regular `wikijump-local-development` development proxy does not itself
provide the Theme Lab proof headers. `ports/interactive-visual-fixture/ensure-built-framerail.mjs`
provisions the separate SHA-pinned built transport, and
`ports/interactive-visual-fixture/capture-theme-matrix.mjs` verifies it before
running interactive states. Neither operation can reuse the older runtime
fingerprint or an unreviewed historical browser receipt as current acceptance.
This writes `accepted-result.json` and `browser-audit.json` under that package's
current directory and updates its package receipt. The Sigma-10 current matrix
owner supplies `sigma10-migration/current-campaign/browser-audit.json` and
`accepted-result.json`; the latter must already be a
`theme_lab_current_sigma10_acceptance.v1` decision bound to the exact audit and
run contract. `node scripts/finalize-current-sigma10.mjs --audit=<runs audit>
--run-contract=<sigma10 contract> --scenario-matrix=<dir of <package>.json>
--browser-root=<framerail>` is the only writer of that decision. It applies the
same audit checks as the completion gate, derives `overall_acceptance` from the
evidence, and refuses with nothing written when any check fails. The campaign
assembler only indexes these finished artifacts: run
`node scripts/assemble-current-campaign.mjs`, then
`node scripts/check-campaign-completion.mjs`. A task-owned Sigma-10 contract is
named with `--sigma10-run-contract=<path>` on both commands; the assembler then
records `migration.run_contract` with its exact path and SHA-256, and the checker
rejects an unbound or differently named contract. Assembly records exact SHA-256
bindings for every maintained candidate input, package result/audit, and the
Sigma-10 result/audit. It does not create a review, infer a pass, or consult
historical evidence. Missing inputs stop assembly; stale or incomplete evidence
is rejected by the completion checker.

Paired images compare different foreign and JP articles. Pixel RMSE remains a
diagnostic; `check --visual --visual-review review.json` binds an explicit image
review to both exact PNGs and candidate inputs. Unreviewed images are inconclusive.
Use `--css-base candidate-base.css` when the package declares a separate frozen
base stylesheet. Full acceptance includes that layer.

Current browser runs use `ports/current-acceptance/run-contract.json`, including
the frozen production SCP-JP Sigma-9 baseline and hash-bound header/navigation
markup. The runtime asset previously labelled Sigma-9 contains English Sigma-10
CSS; its historical measurements remain archived under their original identity.

## Which Theme Lab checks the pre-merge gate runs

`scripts/preflight.sh --final` splits the Theme Lab evidence checks in two.

- **Every run.** The Theme Lab tests, authority evidence restore, adaptation
  authority, Python tests, maintainable sources, deterministic packages,
  Sigma-10 source evidence, post-closure changes, and the runtime drift
  report. These verify the live themes and guard the frozen instrument.
- **Only when Theme Lab changed.** Sigma-10 historical evidence integrity, the
  current campaign evidence restore, and campaign record integrity. They verify
  the finished campaign against the Theme Lab tree and the evidence store, so
  their verdict can only change when a tracked path under
  `install/local/theme-lab/` (or `scripts/preflight.sh`) changes. A syscall
  trace of both checks shows no other repository input, and changing a
  framerail source file leaves the integrity output byte-identical. When
  skipped, the validation log says so and the checks are absent from the
  receipt.

Set `PREFLIGHT_THEME_LAB_ARCHIVE=always` to run the archival checks regardless.
`install/standing/promote.py` does, and so should any scheduled run that also
needs to notice evidence-store corruption, which no pull request can cause.

The authority evidence is verified once per run, by the adaptation authority
check. The deterministic-packages and Sigma-10 historical checks skip
re-verifying it when `THEME_LAB_AUTHORITY_EVIDENCE_VERIFIED=1`, which preflight
sets only after the restore and that check both passed.
