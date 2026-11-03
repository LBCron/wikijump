# SCP-JP Sigma-9 → Sigma-10 Theme Lab migration simulation

## Final result


The `--historical-only` verification uses `historical-run-contract.json`, which preserves the exact 2026-09-27 capture contract (SHA-256 `7d2313c1d42f010bd3a893e1364ba56931b56044ba1f782ed0ee887fde6deba9`, Git revision `e3fd603356`). The maintained `run-contract.json` gained `expected_runtime_source_sha256` during the 2026-10-07 source integration and now has a different hash. Historical audit records bind the earlier bytes; the historical verifier checks those bytes without changing the current runtime identity or rewriting audit rows. A clean checkout still needs the separately stored raw evidence to complete this verification; missing captures remain failures.

**Migration decision:** `SIGMA10-MOB-001` is an **unverified preview-state hypothesis**, not a required migration blocker or a required Technical Staff source change. The real saved Sigma-10 Wikidot page hides the preview notice through the later `sigma-10:info:style` stylesheet and has no 390px document overflow. Anonymous `edit/PagePreviewModule` returned real preview HTML without a lock or save, but did not establish the complete browser/editor preview stylesheet cascade. Technical Staff/manual Wikidot preview confirmation is required before proposing a source change. Search and historical local simulator findings carry no broader Wikidot parity authority.

## Authority and fixture provenance

The authority is frozen: [Technical Staff Sigma](https://github.com/KanekoLiku/sigma) commit `2bfcb97451695d99e8d056c3ac40ec954e005636`, upstream Sigma commit `84d8171abbeb5cc0b4e6c2f80ef553e08a053359`. Source, dependency, and fixture checkers pass: 10 public pages, 52 dependency entries, 9 run-owned fixtures and 13 recorded transformations. Fixture manifest SHA-256: `7f5dfcb5f61ee6f2593b7bd407575d1d7b0977faafca8a93ac9c653a5810b6da`.

The offline fixture maps public cross-site includes to run-owned local pages, omits the inaccessible private pseudo-site include, uses empty local Interwiki data documents, and binds the 1×1 nav decoration to content-addressed asset SHA-256 `4f8c6d416f09671777934e57bc67fb52ccc97145dc6f1869e628d9ffd7d8f6e7`. It does not invent unavailable page/link data. The migration capture is isolated from the accepted Sigma-9 campaign audit.

## Coverage and review

- Candidates: 35 maintained theme packages plus `sigma10-baseline`.
- Both baselines: Chromium desktop, laptop, tablet, mobile, narrow-mobile; Firefox desktop/mobile; WebKit desktop/mobile. Each has 324 `page.normal` rows.
- Sigma-10 audit: 460 historical rows, including 145 baseline-theme rows (9 normal states and 136 interaction/admin rows); 850 superseded captures retained in the audit history.
- Sigma-9 comparison: 326 historical rows (324 matrix cells plus Chromium desktop/mobile `page.history.historical-source`).
- All 35 maintained packages pass the real-port regression verification. All retained rows have direct-image review metadata bound to their screenshot digest. No unexplained `UNCONFIRMED` rows, sent external requests, asset failures, or page errors remain.
- Historical audit and review records are explicitly scoped to `SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY`; they cannot certify Wikidot runtime parity or create parity-based port requirements. The paired Sigma-9 rows are local attribution controls.

| Historical local row classification | Sigma-10 | Sigma-9 control |
| --- | ---: | ---: |
| `PASS_NATURAL` | 288 | 0 |
| `PASS_INTENTIONAL_DIVERGENCE` | 3 | 325 |
| `NEEDS_FIX` | 162 | 1 |
| `EXTERNAL_CONTRACT_UNVERIFIABLE` | 7 | 0 |
| `NOT_APPLICABLE` | 0 | 0 |

The retained `NEEDS_FIX` rows describe a local preview simulation (`SIGMA10-MOB-001`, now unverified against a true Wikidot preview) and a paired local history textarea issue (`WIKIJUMP-HIST-001`). They do not establish required Wikidot or migration repairs. Sigma-9 control rows are intentionally classified as divergence because Sigma-9 does not style the Sigma-10 credit module; they serve for paired geometry/attribution, not as the visual target.

Interaction review inspected action traces, target state, visibility/focus/hover where applicable, geometry and screenshots for navigation focus/hover, content link/rating focus, tags, credit/modal states, history/source transitions, dialogs, sidebar, login, footer, search, and Interwiki. Search's hidden control is recorded as an intentional local target state, not an upstream parity finding. The Interwiki wrapper and iframe attach in all seven sampled engine/viewport cases; the default frame is zero-height because remote Crom data is unavailable.

## Preview-state hypothesis requiring confirmation

### SIGMA10-MOB-001 — preview notice overflow is unverified on real Wikidot

- **Authority:** local preview simulation only; `port_conclusion_eligible = false`, `blocker = false`, `actionable = false`.
- **Preview limit:** anonymous PagePreviewModule produced 9,424 bytes of real preview HTML. It did not establish the editor/browser stylesheet cascade or measure an actual preview notice. No edit UI, lock, save, or public mutation was used.
- **Next evidence:** Technical Staff/manual preview confirmation. If actual preview overflow is confirmed, evaluate a preview-scoped wrapping correction. No source change is currently required for migration.


### WIKIJUMP-HIST-001 — mobile history source textarea overflows

At a 390px Chromium mobile viewport, `page.history.historical-source` measures 433px under both the Sigma-9 control and Sigma-10. The source textarea is the overflow contributor. Owner: `wikijump-runtime`; low severity and non-blocking for Sigma migration because the behavior is pre-existing and unchanged. Constrain the textarea to its pane while preserving usable source inspection. Both paired screenshot digests and widths are in `findings.json`.

## Theme Lab defects found and fixed

- `THEMELAB-SIM-001`: shell substitution previously ran before Svelte hydration, allowing the stale acceptance navigation to return. Capture now waits for hydration and verifies stable source-derived Sigma-10 navigation.
- `THEMELAB-SIM-003`: WebKit image replay previously misreported locally fulfilled or blocked images as missing. Replay now respects the local route; the frozen nav-side pixel asset is verified and all 36 candidates have zero page-normal asset failures.
- `THEMELAB-FIXTURE-002`: fixture-to-surface mapping is documented and bound to the manifest; navigation/shell states use the run-owned Sigma-10 shell, while acceptance content/admin states retain their appropriate fixture.

## Bounded external contract

`EXT-INTERWIKI-001` is owned by `external-runtime-contract`. The local wrapper/iframe attachment and measured placement are verified; frame height remains zero when external Crom data is blocked. Empty local Interwiki data keeps the run deterministic and all external requests were blocked. This evidence does **not** claim remote frame content, links, style propagation, resize messaging, or live Crom behavior. The frozen nav references `interwiki.scp-jp.org` and the local runtime's Crom integration; enabling arbitrary network access was not part of verification.

## Intentional differences

- Sigma-9 control screenshots contain the Sigma-10 credit markup without Sigma-10 styling; comparison is limited to geometry and attribution.
- The Sigma-10 migration target hides its search input. The separate live source capture shows the Wikidot input visible and focusable. `shell.search` remains parity-uncertified; the local migration review carries no parity authority.
- Source-derived page title/tagline text comes from the local authoring site's test configuration and is not SCP-JP production identity.
- Browser matrix contracts use Firefox/WebKit desktop and mobile; Chromium additionally covers laptop, tablet, and 320px narrow-mobile.

## Action list

**Technical Staff / migration policy:** confirm the true Wikidot preview state before deciding whether a preview-only change is needed. The hidden local search input remains a target observation; the source/runtime contract requires a separate paired review before any parity-based action is proposed.

**Wikijump runtime:** track the pre-existing history textarea width issue as low-priority runtime work. It is not a Sigma migration blocker.

**External runtime owner:** no migration action; retain the bounded Interwiki contract unless external service authority and deterministic fixtures are supplied.

## Final readiness statement

The archived local simulator evidence has: actionable simulator gaps 0; required matrix holes 0; all retained evidence bound to historical candidate identities; unexplained `UNCONFIRMED` records 0; ownerless blockers 0; fixture-owned defects 0. The Sigma-10 migration result is reviewable and owner-assigned. No migration prerequisite is established by the unverified preview hypothesis. Current cleaned candidates require their own combined full acceptance before a future migration promotion. Search remains outside this migration review's parity authority.

## Validation

Source closure, dependency snapshot, deterministic fixture materialization, maintainable source check (34/34), real-port verification (35/35), Theme Lab Node tests (167/167), Python tests (7/7), final evidence checker, and the local Wikidot-identifier leak scan (40 constructs) pass. `pnpm --dir install/local/wikidot-verification offline` was also attempted; compatibility tests that require the pinned FTML commit stop before their assertions because this checkout has no FTML submodule/object for `bf49d32fe980611fed368661396a3d6c1f02c51f`. The migration branch does not modify FTML. `corpus-pinned-literals` was not applicable: no captured live-reference JSONL inputs are present in the checkout, and this work does not add source-matching logic.
