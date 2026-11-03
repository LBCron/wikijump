# SCP-JP interactive theme surface specification

Version: 1.1 (2026-09-24; interactive harness and coverage contract)

This is the acceptance inventory for applying a localized theme to actual SCP-JP/Wikijump pages. A selector's presence is not visual acceptance: each state requires a settled screenshot, an interaction assertion, and human image review. The current runtime must be the SCP-JP mirror or a run-owned page in `scpaiueouiuiuiui`; an SCP-EN page is useful implementation evidence but cannot close an SCP-JP row.

For ordinary Theme Lab full checks, this inventory is now partially enforced
automatically. Candidate CSS is parsed to determine which known SCP-JP runtime
surfaces it touches; only those surfaces are promoted into the fast surface
contract. The contract renders the repository-owned high-fidelity JP component
fixture and measures the same state without/with the theme. It is a fast
pre-acceptance gate, not a replacement for the larger cross-engine visual
matrix below. Source-specific active selectors that are not known runtime
surfaces belong in the port package's `surface-contract.json`.

## Authority and current evidence

- SCP-JP custom theme policy: `/home/roku/src/Rokurolize/scp-wiki-translation/corpus/jp/pages/custom-theme-policy/source.wikidot.txt`. It requires an installed Rate module, practical readability, and visibility of `#footer`, `#license-area`, `#login-status`, `.scpnet-interwiki-frame`; `#side-bar` and `#top-bar` may be redesigned only while retaining usable navigation. It recommends the credited Rate module.
- Current credit source contracts: `corpus/jp/pages/credit:start/source.wikidot.txt`, `credit:otherwise`, `credit:end`, and `credit:style`. `credit:start` defaults to the rated credit variant; `mode=no-rate` is a real variant. The end component includes its own Rate, CC link, and heritage branch. `credit:otherwise` is a second hash-target modal. Verify source freshness before relying on these as the current public revision.
- Wikijump browser implementation and existing verification anchors: `framerail/tests/page-workflows.spec.ts`, `framerail/tests/generated-page-styles-navigation.spec.ts`, `install/local/wikidot-verification/src/theme-localization-e2e.mjs`, `theme-browser-capture.mjs`, `open43-issue775-edit-browser-adapter.mjs`, `open43-issue1041-lifecycle-browser-adapter.mjs`, `open43-a1030-rate-browser-adapter.mjs`, `open43-page-tags-browser-candidate-case-set.mjs`, and `src/standing-browser-canaries.mjs`.
- Live visual probes actually inspected on 2026-09-24: Chromium local SCP-Wiki Wikijump `/scp-9506` (1440×1000) and local JP-language authoring site `/boundary-check` (1440×1000, 1024×900, 390×844). The SCP-Wiki screenshot showed a readable article, visible rating, sidebar, action row, footer, and license; its long tag list collapsed into a narrow vertical strip. The local authoring screenshot showed the Japanese login status, page title/body, opened action row, footer, and license. These are runtime probes only, not per-theme results.
- Environment boundary and run-owned fixture: the first `/boundary-check` probe was incomplete, and the SCP-JP mirror route still is not used for authoring. The persistent local-development stack exposes Deepwell on loopback port 2747 and the editable `scpaiueouiuiuiui` authoring site on port 18443. The campaign now owns an imported-style page and variants with Rate, both credit hash targets, multiple revisions, tags, parent/backlink, attachment, interwiki, navigation and long Japanese content. No SCP-Wiki or SCP-JP mirror was mutated.

## Classification vocabulary

- `PASS_NATURAL`: screenshot and interaction both meet the criteria without a material theme-specific exception.
- `PASS_INTENTIONAL_DIVERGENCE`: both pass, but a documented SCP-JP adaptation changes the upstream presentation; record names the source evidence and affected rule.
- `NEEDS_FIX`: a reproducible visual or interaction defect exists. Capture before/after and review the regenerated after-image.
- `UNCONFIRMED`: there is no valid runtime/state evidence. The record must state what is missing, why, and which source/runtime was checked. Never count this as pass.

## Viewport and engine contract

| ID | Size | Contract |
|---|---:|---|
| desktop | 1440×1000 | Full header, sidebar, page, controls and lower-page navigation |
| laptop | 1024×900 | Narrow desktop shell and action row |
| tablet | 768×1024 | Responsive breakpoint and table/modal fit |
| mobile | 390×844 | Mobile top bar and sidebar open/closed states |
| narrow-mobile | 320×800 | SCP-JP policy boundary; header, modal, history, source, options and dialog |

Run Chromium full interaction coverage. Run Firefox and Playwright WebKit core states (normal desktop/mobile, credit view, mobile sidebar open, History and Source). WebKit is a Safari compatibility proxy, not Safari evidence. Keep browser contexts and theme styles isolated; record executable versions and viewport for each screenshot.

## Surface inventory and state contract

| Surface ID | Purpose / selectors | Entry and required states | Desktop/mobile | Auth / mutation | Visual acceptance | Interaction acceptance / evidence |
|---|---|---|---|---|---|---|
| shell.header | Site identity, logo, subtitle: `#header`, `#header h1`, `#header h2`, logo pseudo-elements | Initial settled page; scroll; resize | both | anonymous / none | Identity remains recognizable; title/subtitle do not collide; Japanese glyphs render and wrap naturally | Logo/home link works; source theme header selectors checked against current JP DOM. `theme-localization-e2e.mjs`, current page screenshot |
| shell.search | Search: `#search-top-box`, input/button | Empty, placeholder, typed, focus, hover, submit-ready | both | anonymous / no submit required | Typed text and placeholder contrast; focus indicator visible; no clipping | Input accepts text; do not submit external search. Runtime shell + theme styles |
| shell.login | Login/account status: `#login-status` | logged-out; logged-in/dropdown only if session fixture permits | both | login state required for logged-in / none | Must remain visible and legible; dropdown layers above theme panels | Links/menu open when available; policy + runtime shell |
| nav.top | Desktop top navigation: `#top-bar`, submenu selectors | normal, hover submenu, keyboard focus, nested submenu when present | desktop; tablet only when the rendered desktop bar is visible | anonymous / none | Hover/focus never erases labels; submenu contrast and stacking | Navigate by pointer and keyboard; `generated-page-styles-navigation.spec.ts` |
| nav.mobile-top | Compact navigation: `.mobile-top-bar` and open-menu controls | collapsed, expanded, submenu/section expanded | mobile/320 | anonymous / none | Expanded menu fits viewport and preserves touch targets | Tap open/close and section toggle; mobile runtime implementation |
| nav.sidebar | Site navigation: `#side-bar`, `.side-block`, mobile toggle | desktop; mobile closed/open; inner collapsible expanded; scrolled | both (open state mobile) | anonymous / none | Useful hierarchy, text contrast, Japanese labels wrap; no obscured close control | Toggle by actual button, close and scroll; policy + runtime shell |
| content.article | Reader content: `#main-content`, `#page-title`, `#page-content` | headings, text, links normal/hover/focus/visited, lists, quote, table, code, image, footnote, TOC, tabs and collapsible | both | anonymous / none | Reader prose readable, Japanese font fallback/glyphs, no hidden component or overflow | Tab/collapsible controls change state; content fixtures and Theme Lab torture corpus |
| content.rating | Mandatory evaluation: `.page-rate-widget-box`, `.rate-points`, `.rateup`, `.ratedown`, `.cancel` | ordinary Rate; credit-associated Rate; normal/hover/focus/selected; no-rate credit variant | both | anonymous / rating mutation prohibited in visual run | +/- and score visible; source palette retained; control states discernible | Assert installed widget and operable hit targets without changing score; SCP-JP policy, `open43-a1030-rate-browser-adapter.mjs` |
| content.credit.default | Credit module: `.creditRate`, `.rate-box-with-credit-button`, `.creditButton`, `#u-credit-view` | normal, hover/focus, rated, no-rate, heritage if actual fixture tag activates it | both | anonymous / none | Credit button aligned with Rate and theme palette; no default hidden-state leak | Click/tap info entry; verify hash and visible target. Current `credit:start`/`credit:end` corpus source |
| content.credit.view | Attribution modal: `#u-credit-view`, `.fader`, `.modalcontainer`, `.modalbox`, `.modalbox-title`, `.credit` | closed → open settled → scroll → close/back; nested otherwise entry | both + 320 | anonymous / none | Overlay, z-order, title/body/link/Japanese text/Rate/license all readable; fit or scroll within viewport | Hash `#u-credit-view`; background interaction blocked; close/back restores page. Current credit source and CSS |
| content.credit.otherwise | Other-license modal: `#u-credit-otherwise` and same modal selectors | closed → open → vertical scroll → back/close | both + 320 | anonymous / none | Distinct content readable; no clipping or hidden page leak | Hash `#u-credit-otherwise`, back returns to view/default. `credit:otherwise` source |
| page.actions | Bottom controls: `#page-options-container`, `#page-options-bottom`, `#page-options-bottom-2`, `#more-options-button` | collapsed, hover/focus/disabled; expanded more options | both + 320 | anonymous; destructive actions never invoked | Edit/Tags/History/Files/Print/Options text, borders, focus and selected states discernible | Click More; assert expanded pane; `framerail/tests/page-workflows.spec.ts` |
| page.tags | Tags pane and inputs | open, populated, focus, close | both + 320 | permission varies; no save | Labels/input/buttons readable, no horizontal escape | Open/close only unless fixture is explicitly run-owned; `open43-page-tags-browser-candidate-case-set.mjs` |
| page.history | Revisions: `.page-history`, `#revision-list`, History table/forms | list, selected revision, hover/focus, pager; desktop/mobile | both | anonymous / read only | Preserve Wikidot's seven-cell table: revision number, from/to controls, flags, V/S actions, author, date, comments. The JP AMC sample also proves one F file-deletion row between page rows 38 and 36, displayed as shared ordinal 37. AMC evidence does not establish mobile presentation, pagination, or action outcomes; do not infer a card layout or classify a local mobile difference as a port requirement. | Select only run-owned revisions; existing History browser flows. Current source evidence: `install/local/theme-lab/evidence/wikidot-history-parity-20260929.json`; broader History parity remains unconfirmed. |
| page.diff | Revision comparison and historical version/source | added/removed/unchanged, long line, Japanese, blank line, link-like text | both | anonymous / read only | Diff colors remain distinct under theme; no syntax blended into background | Select two fixture revisions and open compare; existing History/Version adapters |
| page.source | View Source: `.page-source`, `#view-source-button` | open, scroll, close/back; desktop/mobile | both + 320 | anonymous / read only | Monospace source, Japanese and Wikidot punctuation contrast; long lines scroll without hiding actions | Open actual source action and return; `PageSourceModule`, `ViewSourceModule` |
| page.files | Attachment listing/upload controls | listing, long filename, metadata/download, upload panel if available | both | upload auth/permission; no upload in acceptance | Filename, dates, controls readable and mobile layout usable | Open Files; download only non-mutating fixture attachment. Existing files browser flows and `page-file-name-theme-isolation` |
| page.backlinks | Backlinks action/pane | populated, empty/loading if reproducible, close/back | both | anonymous / none | Empty/loading labels and linked titles readable | Open from More; verify route/close |
| page.parent | Parent action/pane | no parent and assigned parent if fixture supports; input/selection | both | no save | Relationship, labels and buttons readable | Open/close only; no persistent mutation |
| page.edit | Edit action/editor | open editor, toolbar, source text, summary, checkboxes, preview/diff controls | desktop/mobile | edit permission; no save | Textarea/code color and controls readable; Japanese source preserved | Open then cancel; use only isolated run-owned fixture. Existing edit browser adapters |
| page.rename | Rename/move pane | pane/dialog open, focus, cancel | both | protected action; do not confirm | Warning, input and buttons clear; dialog stacking correct | Stop before confirmation; run-owned fixture only |
| page.delete | Delete confirmation | confirmation open, cancel | both | destructive; delete is forbidden | Warning and cancel/confirm distinction clear | Open confirmation only, cancel; run-owned fixture only |
| dialog.generic | Generic Wikidot dialog: `#odialog-container`, `.odialog-shader`, `.owindow` | opening, settled, focus, cancel/close; error dialog when safe | both + 320 | anonymous; no destructive confirm | Overlay opacity, layering, content/buttons readable, no clipping | Trigger existing safe dialog and dismiss; `open43-issue1041-lifecycle-browser-adapter.mjs`, `open43-issue775-edit-browser-adapter.mjs` |
| shell.footer | Site footer: `#footer` | actual bottom scroll, link hover/focus | both | anonymous / none | Must remain visible in normal page flow and readable | Scroll to bottom; SCP-JP policy |
| shell.license | License: `#license-area` | actual bottom, hover/focus | both | anonymous / none | Must not be hidden; theme background and link maintain contrast | Scroll and follow focus; SCP-JP policy |
| shell.interwiki | Interwiki: `.scpnet-interwiki-frame` | loaded/settled, links and clipping | both | anonymous / none | Frame visible, unclipped and visually integrated; hiding is forbidden | Verify frame load and internal link reachability where safe; SCP-JP policy |

## Matrix reduction rules

Chromium captures normal content at all five viewports. Detailed interaction states use canonical desktop and mobile when the surface table says “both”; the policy-boundary run adds only the modal, mobile-navigation, history/source, action and other states listed for 320px. Laptop and tablet retain their own normal-page and wide Search rendering; state-specific breakpoint checks are added only where the surface contract calls for them. Firefox and WebKit run the defined core states per theme. The state runner publishes `state_applicability` in the audit JSON with each surface/state's applicable viewport list and a reason for other viewport omissions. At 768px, capture the active navigation mode from the rendered shell: some candidate/runtime combinations retain `#top-bar`, while others use `.mobile-top-bar`; do not force a hidden desktop submenu action. An omitted state is never counted as a visual PASS, and omission is based on the UI breakpoint contract, not runtime cost. A missing selector in an applicable state is `UNCONFIRMED` until the correct SCP-JP fixture/runtime establishes whether it should exist.

Each audit record binds theme, engine/version, viewport, surface/state, exact action sequence, screenshot path and SHA-256, candidate CSS/source hash, state-action contract hash, classification, visual findings, intentional divergence, missing evidence, external-request/asset diagnostics, and whether it was image-reviewed after the final source change. Theme CSS must be reset between themes. Screenshots are never edited after capture. Existing captures are reused only when the candidate CSS hash, browser version, session state, state-action contract (for new records), and on-disk screenshot SHA-256 still match; `--force` recaptures selected evidence. A fresh capture may inherit a visual classification without re-review only when theme, engine, viewport, surface and state are identical, the screenshot SHA-256 is byte-identical to an attributable prior review (direct image review, or a reuse row that retained its source reviewer/timestamp), and both the prior and current captures have no action, asset, page-error, external-request or missing-screenshot failures. Pixel-identical (different bytes, same decoded pixels) reuse is never automatic; the post-process tool requires an explicit `--pixel-identical` opt-in. Failed or unattributable evidence is never reused.

The fast surface contract deliberately uses real repository-owned component
markup when available. A simplified DOM invented for a single theme is not
valid evidence for credit, rating, navigation, tabs, collapsibles or another
existing SCP-JP component because component specificity/cascade is part of the
behavior being tested. The contract also opens the relevant mobile submenu and
sidebar states before checking overflow; a normal settled page alone cannot
close those rows. Responsive computed-style differences between the JP
baseline and candidate are recorded so fixed foreign-branch values cannot
silently erase an existing mobile/desktop runtime distinction.

## Current gate status

The completed 35-package interactive campaign is retained under
`install/local/theme-lab/ports/interactive-visual-fixture/` and
`interactive-visual-audit.json`. The current accepted audit contains **4,947**
records: **4,819 `PASS_NATURAL`**, **128
`PASS_INTENTIONAL_DIVERGENCE`**, and **0 `UNCONFIRMED`**. Historical replaced
captures remain in `superseded_records` rather than being reused as current
evidence.

The CSS-derived fast surface contract is a complementary gate for future
ports/edits. It was validated against accepted themes with materially different
structures (Black Highlighter, Penumbra, Classic) without creating actionable
regressions, and against the unadapted FR Technical Staff draft where it still
detects the known 390px mobile top-navigation overflow. It does not rewrite or
reclassify the frozen 35-package visual evidence.
