# Semantic browser acceptance

A correctly localized theme preserves the frozen upstream theme's intentional
visual identity, structure, responsive behavior and interactions while making
the documented language, site identity, glyph and evidenced JP contract
adaptations. The requirement classes in TECHNICAL-LOCALIZATION-SPEC.md remain
normative. An emulator defect cannot authorize a theme adaptation. The runtime
parity registry continues to govern source conclusions independently of local
target acceptance.

## Observations and obligations

The exhaustive browser matrix remains mandatory, including Chromium's 320px
viewport and the maintained Firefox/WebKit core states. A screenshot records
an observation; its existence does not create another visual judgment.

Each capture run contract pins `expected_runtime_source_sha256`. The matrix
runner checks the built-runtime fingerprint and probes the served fixture's
`X-Theme-Lab-Runtime-Source-Sha` response header before starting child captures;
each browser fixture navigation checks the same header and records the
measured `runtime_source_sha256`. This served-runtime identity is separate from
`runtime_surface_contract_sha256`, which describes local source dependencies.
Completion requires the measured value to match the run contract.

Each active run contract also pins `expected_backend_runtime_identity`, which
binds the current Deepwell source fingerprint and FTML git revision to the
actual running container ID, image ID, executable SHA-256, and active config
SHA-256. Before a matrix child starts, the runner verifies that the live
Deepwell mounts come from this checkout, that the built Framerail container
resolves `deepwell` to that container, and that Deepwell answers its RPC ping.
The fixture probe and every browser fixture navigation must return the same
backend identity. Browser records, machine assertions, semantic observation
digests, and environment contracts retain that measured identity; completion
requires an exact match with the run contract. A prior C row without a
measured backend identity is not comparable and is promoted to direct review.

The final current-campaign visual gate keeps all 145 canonical observations
and uses `current-acceptance/visual-gate-policy.json`, bound by SHA-256 in both
run contracts. Its 35 V rows always require a screenshot and direct review of
that exact screenshot bound to the current candidate/source. Its 76 C rows
require a state-specific machine assertion for the active target, geometry,
interaction or scroll state, plus the normal candidate, source, asset, run,
action, fixture, runtime and viewport bindings. A C row's risk assessment
stores the prior candidate CSS/source/structure, asset dependency, fixture,
action, scoped run, served-runtime and local runtime-surface identities, plus
the browser version. The gate recomputes the comparison: a missing prior
identity or any changed identity promotes the row to screenshot and direct
review. The same applies when there is no comparable prior capture, a relevant
browser version changed, visible title overlap occurs, or measured document
overflow exceeds the target-baseline state. In particular, a legacy row with no
measured served-runtime SHA is not a comparable prior when the current runtime
has one. Candidate CSS/source/structure and asset changes conservatively cover
selector, breakpoint/media-query, component, font and asset risks; the scoped
run identity covers changed authority inputs. Its 34 M rows retain
structured action evidence on success; failed actions retain a diagnostic
screenshot. Theme-specific evidence such as BetterFootnotes and the BHL option
scenarios remains separately required.

The optional `theme_lab_semantic_browser_acceptance.v1` audit model replaces
the historical per-record image classification with recomputed facts and
specific question reviews. It does not accept a record merely because the
model name is present. Missing facts, failed actions, failed network/assets,
stale provenance and unanswered questions block completion.

| Obligation | Evidence and decision |
| --- | --- |
| Current inputs and observations | Candidate/source/baseline/fixture/asset/action/runtime hashes; completion independently opens bound artifacts and checks the current inventory. |
| Capture safety | Explicit action responses, errors, assets and network counts on every row. Exact screenshot binding is required for V and risk-promoted C rows; M and unpromoted C success rows use their structured machine evidence. Pending image review is not an action failure. Other unknown items remain blocking. |
| Maintained action execution | The known action contract and clean execution. This establishes execution only. Search types/focuses a visible query; a concealed query instead requires a real visible-button native navigation request, the exact encoded current value and a current source-side action receipt. An unexercised or unbound alternative remains a source-authority gap. |
| Document containment | Measured document and client widths with the existing one-pixel rounding tolerance. When the candidate exceeds the viewport, measure the same already-reached DOM/action state with only the SCP-JP target-baseline layers painted. Equal inherited overflow passes this theme-attribution fact; candidate overflow beyond that baseline fails. A required baseline measurement that is absent or stale remains missing evidence, not a visual-review question. |
| Title intersections | Geometry plus effective ancestor visibility and overflow clipping. Hidden intersections and menus crossing only empty title-container space are machine facts. Visible title text ranges must actually intersect the other element before a composition question is created. Missing visibility/text geometry requires another measurement. |
| Source visual identity | One question per theme and candidate/source/base/baseline identity, binding every declared responsive normal-page observation. Review imagery, typography, palette and information hierarchy against the frozen upstream source and source rendering, explaining documented localization differences. |
| Full package acceptance | The full five-viewport paired check, Japanese platform-font proof, CSS-derived surface checks, interactions, torture corpus, dependency/source authority and combined port/target verdict remain independently mandatory. A browser question cannot override them. |

Run `node scripts/account-browser-acceptance.mjs /absolute/audit.json` from
Theme Lab before substantive image review. It emits machine-settled facts,
actual failure records, missing machine evidence, source-authority gaps and
distinct visual questions. These categories can overlap. It never edits an
audit or assigns PASS. Visual questions are provisional until missing machine
measurements determine which intersections are actually visible.

A semantic question review records the exact question, evidence digest,
concrete conclusion, reviewer/time, source URL and bound source/rendering
artifacts, original reference HTML and the reference rendering receipt.
Completion matches the snapshot to maintained upstream source authority and
the source image to the receipt's exact frozen, offline reference replay.
Naming an arbitrary source URL beside a candidate screenshot is insufficient.
Every declared evidence item belongs to the review; an
unexplained representative screenshot is insufficient. These decisions remain
`SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY`, never source parity certificates.
Historical audits retain their original strict review semantics.

Composition questions name the intersecting elements. A single obligation can
cover their composition across responsive/action observations, just as a source
identity question spans responsive layouts. Its evidence digest binds every
state, image and dependency; different images are not declared equivalent and
no status is copied between them. A change within that evidence set makes the
review stale. Grouping the question is not permission to leave a member's
failure or unexplained composition unresolved.

Previously retained `theme_lab_wikidot_adaptation_ab.v1` source evidence also
qualifies when its source URL is current, public writes and browser external
requests are zero, replay is complete, and the exact DOM/image pair comes from
the `without` variant with an empty CSS intervention. A patched `with` variant
is never source rendering authority. This preserves usable source evidence
without refreshing an unrelated acquisition.

## Reuse and invalidation

Facts and question evidence depend on their theme, candidate/source/base,
fixture/assets, action/runtime surface, browser/version, viewport, actor/site,
locale and transport. Changing unrelated audit bytes or another theme's review
does not change a question identity or evidence digest.

New captures bind the selected candidate, inventory entry, viewport and engine
from a run contract. Other candidate entries, other viewports and output paths
do not invalidate that observation. All shared and unknown contract fields
remain dependencies. Legacy captures without this scoped provenance require
the exact original contract hash; scope cannot be guessed after a change.
The completion denominator still checks the entire current inventory and
matrix. Action helpers and runtime files remain selected by the exercised
surface. The historical-source primitive affects History, not unrelated shell
or article observations.

Semantic promotion recomputes the selected runtime file hashes from the
current checkout. A syntactically valid old runtime digest is insufficient.
It also anonymously dumps the current action/fixture contracts without opening
a site page, then checks the exact contract for each observed state. New
`theme_lab_action_contract.v3` captures bind action helpers separately from the
read-only diagnostics collector. Adding an unrelated diagnostic selector does
not alter that action contract. Legacy observations remain eligible only when
their broad action-and-observer contract still exactly matches; unknown action
models fail closed. Recomputing this cheap dependency graph never requires an
unrelated screenshot recapture.

Title measurements bind their producer separately from the existing action
observer. Adding this measurement does not invalidate unrelated action
execution. Old nonempty intersections without visibility are missing evidence,
not inferred passes. Changed pixels alone neither prove nor disprove port
correctness; an accepted question must retain its relevant evidence bindings.
Supplementary title-text measurements are needed only for visible container
intersections; already settled hidden/empty intersections retain their proof.
Geometry producers bind composition facts/questions, while the source artistic
identity question binds the actual rendering inputs and image. Adding a geometry
observer does not change an unchanged source-identity image review.
The current action proof remains independently mandatory; changing that proof
without changing the painted normal image does not create another artistic
identity judgment.

The retained source-only search probes in `../evidence/search-controls-20261001/`
exercise the native Wikidot submit listener against offline cached source HTML,
CSS and JavaScript. Each theme receipt binds its source, viewport, query
visibility, actual navigation, measurement programs and retained artifacts.
They settle only that action alternative; recorded missing reference resources
remain unresolved for any broader source appearance or asset obligation.

## Historical-source runtime correction

The anonymous EN/JP `history/PageSourceModule` responses retained in
`../evidence/wikidot-revision-source-20261001.json` establish an escaped
`.page-source` div with explicit line breaks. The retained PageHistoryModule
JavaScript establishes the source action and insertion into `#history-subarea`.
Wikijump's textarea primitive overflowed the mobile article under Wikidot Base
CSS. The shared AMC/browser primitive now uses the observed div and inert
escaped text. This is a runtime correction; no theme CSS workaround is added.
These bounded responses do not certify History's complete responsive layout,
heading, timeline, hover, pagination or other action outcomes.

Historical serialization evidence in
`../evidence/browser-action-contract-formats/` permits only the known omission
of unused null navigation fields. Changed actions, active navigation helpers
and required credit/sidebar helpers still invalidate their own states.
`../evidence/browser-run-contract-history/` retains exact complete contracts,
so a legacy observation can derive its unchanged dependency scope when another
package inventory entry changes. Missing history, changed selected candidates,
shared authority, fixtures, baseline, viewport, network policy or unknown
future dependencies fail closed. Neither history mechanism assigns a visual
review or changes the observation denominator.

Transient navigation title intersections can be settled from structured evidence
when the same exact candidate/source/base/assets/fixture/browser/session/site/locale
has a clean normal reading state and both observations pass action, safety and
containment facts. The source replay retained under
`authority-evidence/source-navigation-overlays-20261001` demonstrates the native
SCP-JP operation at multiple responsive widths, including clean reading states,
actual menu actions, screenshots, DOM, browser identity and measurement programs.
Only canonical fixture text inside a retained positioned submenu ancestry or the
rendered drawer/side-block geometry qualifies. Unknown labels, account/search
controls, missing ancestry, escaping menus and persistent normal-state overlap
remain visual questions. Completion independently verifies all source artifacts;
current action, fixture, runtime and run-contract gates still apply.

This extends the reviewed isolated proposal `471a7929b1` with canonical text and
structural provenance checks plus retained source evidence. It does not assign
image classifications or replace paired responsive source-identity review.
