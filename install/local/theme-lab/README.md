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
check-driven validator, not a generic loop).

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

Local target acceptance and synthetic fixture results cannot authorize JP CSS.

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
source-side browser captures and exact module captures add bounded observations
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

