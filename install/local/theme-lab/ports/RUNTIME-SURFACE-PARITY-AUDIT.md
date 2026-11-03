# Wikidot-facing runtime parity audit

Date: 2026-09-30. This report records the current Theme Lab surface inventory, bounded source observations, and the authority assigned to each dependency. The machine-readable authority is [`fixtures/runtime-surface-parity.json`](../fixtures/runtime-surface-parity.json); the count and completion gate are in [`fixtures/runtime-surface-parity-accounting.json`](../fixtures/runtime-surface-parity-accounting.json).

## Decision rule

Theme Lab measures candidate CSS against the local Wikijump runtime. The 41 currently discovered CSS/interaction contracts remain required local SCP-JP acceptance observations. Their visual reviews and runtime findings may fail local target acceptance, but cannot establish a Wikidot mismatch or create a parity-based port action. This is recorded as `LOCAL_TARGET_ACCEPTANCE_ONLY`; it is a deliberate decision-authority boundary, not a claim that those contracts are source-certified.

Only exact `CERTIFIED_PARITY_SCOPE` rows may influence parity-based port conclusions. The two retained History certificates cover only the seven-cell table DOM and one Japanese file-deletion timeline event. Synthetic Theme Lab states are diagnostic only. Alias ids resolve to their active contract. `page.diff` has no independent current harness dependency; a direct observation of it routes to the fail-closed unknown-runtime sentinel. Any genuinely unmatched runtime finding blocks the port conclusion. Candidate asset and include checks remain independent of runtime parity.

The migration and interactive visual review records are also explicitly scoped to local SCP-JP target acceptance. Their pass/fail classifications remain useful to acceptance, but cannot be read as source parity proof.

## Current EN source baseline

- Wikidot supplies its generic Base theme stylesheet. The frozen local artifact used by the hermetic Theme Lab browser integration test is [`framerail/static/wikidot/styles/wikidot-base-165bc434fd1d.css`](../../../../framerail/static/wikidot/styles/wikidot-base-165bc434fd1d.css), SHA-256 `165bc434fd1da2092fee0ea6bdeb55aa38402aaaafd6d1e3303180d2b595b981`. The live site-theme asset observation records the versioned `common--theme/base/css/style.css` asset as the first stylesheet for built-in themes that include Base; the Theme Lab fixture uses the retained general Wikidot CSS, not Sigma-10.
- The current SCP-EN `theme:site` source identifies the page as **Sigma-10 Theme**. Its frozen source hash is `17f5d83fc92f3f171fcdb790f78fe207db86203eeca1e34f508631fb36daca34` (source updated `2026-05-22T09:04:20Z`). It instructs the site owner to import `https://cdn.scpwiki.com/theme/en/sigma/css/sigma.min.css`.
- The dependency graph binds that import and the official [`scpwiki/sigma` repository](https://github.com/scpwiki/sigma). The retained resolved stylesheet [`candidate-base.css`](site/candidate-base.css) has SHA-256 `869c96d0a83b3beef1775abe5c08801a319443a301ea6e8f056b0a38ad9e6833`; this is the Sigma stylesheet input, distinct from Wikidot Base CSS.
- These claims are bound by [`site/manifest.json`](site/manifest.json), [`site/upstream-en.wikidot.txt`](site/upstream-en.wikidot.txt), [`ports/en-theme-dependency-graph.json`](en-theme-dependency-graph.json), and the [current SCP Wiki theme page](https://scp-wiki.wikidot.com/theme:site). The source repository README describes Sigma as the default CSS used by SCP Wiki.

## Live History comparison

Anonymous read-only `wikidot.py` 4.4.1 captures were made on 2026-09-29 for `scp-173` on `scp-wiki.wikidot.com` (page 1956234) and `scp-jp.wikidot.com` (page 19439882). Both `history/PageRevisionListModule` fragments have one `table.page-history`, seven cells in the same order, revision row ids `revision-row-{id}`, `from` and `to` radios, a flags cell, V/S action links, `.printuser.avatarhover`, `.odate`, and comments. The English and Japanese header/flag labels differ while the structure stays the same. The complete response hashes and request records are in [`evidence/wikidot-history-parity-20260929.json`](../evidence/wikidot-history-parity-20260929.json) and its adjacent `*.responses/` directory.

The Japanese capture contains an `F` file/attachment deletion row numbered 37 between page rows 38 and 36. Its timestamp sorts between those page events, and it retains the same seven cells, V/S links, author, date, and comment fields. Wikijump now merges page and file revision data for WIKIDOT-facing History, orders the observed event by creation time, and assigns one ordinal across both streams. The native Wikijump History view continues to use page revisions only. The narrow timeline certificate covers this observed deletion shape and placement; it does not establish other file-operation variants, equal-timestamp ordering, or V/S outcomes. AMC fragments do not expose source-side CSS or browser behavior, so History mobile presentation, pagination, focus/hover states, and action outcomes remain unproven. They contain `.odate` markup and date text but do not establish final client-side hydration or visibility. Wikijump's retained Wikidot Base CSS hides `.odate` with `display:none`, so visible and relative-date parity also remains unverified and quarantined.


## Additional source observations captured 2026-09-30

A source-only, read-only browser run retained state screenshots and DOM artifacts for SCP-173 and `advanced-formatting-and-you` on SCP-Wiki and SCP-JP. It attempted 28 source states; 24 completed and four second-tab selections failed because no visible second YUI tab link was available. The failed tab states are retained as failures and are not proof. The successful set includes normal desktop/mobile, focused search, top-navigation hover/focus, mobile sidebar open, rating focus, More Options expanded, footer scroll, Japanese credit modals, and expanded collapsibles. The retained record reports no public requests or external network requests during this replay and leaves all 13 pre-existing acquisition barriers intact. See [`evidence/wikidot-runtime-surface-20260930.states-v3/records.json`](../evidence/wikidot-runtime-surface-20260930.states-v3/records.json).

Separate exact anonymous AMC records cover `ListPagesModule`, `PageFilesModule`, and `ViewSourceModule` for SCP-173 on SCP-Wiki and SCP-JP. The Files modules establish only that these two pages have no attached files and show the empty state; they do not establish non-empty file row layout. The ViewSource responses establish a `.page-source` wrapper and, for Japanese content, include-path anchors on this sample; they do not certify the rendered page-source module or browser behavior. The module record and raw response hashes are in [`evidence/wikidot-runtime-surface-modules-20260930.json`](../evidence/wikidot-runtime-surface-modules-20260930.json) and the adjacent response directory.

These source observations are not parity certificates. In particular, the source search capture accepted focus and text entry while the Sigma-10 SCP-JP migration capture records the input hidden. Those captures are not a paired general runtime contract; `shell.search` remains local-acceptance-only and no search parity claim or parity-based action follows from the migration screenshot.

## Surface inventory

The inventory has 41 active local-acceptance contracts, two exact certified History scopes, two synthetic diagnostics, two aliases covered by the active footer/license contract, one inactive `page.diff` row, and one fail-closed sentinel. Status and current decision authority are shown separately so `INSUFFICIENT_EVIDENCE` is not mistaken for either a parity certificate or a removed local test.

| Surface ID | Evidence status | Current harness disposition | Conclusion resolution | Parity eligible? | Blocks if observed? |
|---|---|---|---|:---:|:---:|
| `content.article` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `content.blockquote` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `content.code` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `content.collapsible` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `content.credit` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `content.footnotes` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `content.image-block` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `content.link` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `content.links` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `content.rating` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `content.table` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `content.tabview` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `content.toc` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `credit.close-back` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `credit.default` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `credit.otherwise` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `credit.view` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `dialog.generic` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `nav.desktop-top` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `nav.mobile-top` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `nav.mobile-top.forced-submenu-state` | `THEME_LAB_ONLY_SYNTHETIC_SURFACE` | synthetic diagnostic only | `SYNTHETIC_DIAGNOSTIC_ONLY` | no | no |
| `nav.sidebar` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `nav.tablet-top` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `nav.top` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `page.actions` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `page.backlinks` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `page.delete` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `page.diff` | `INSUFFICIENT_EVIDENCE` | no independent current dependency | `NO_CURRENT_DEPENDENCY` | no | no |
| `page.edit` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `page.files` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `page.history` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `page.history.file-revision-timeline` | `PARITY_CERTIFIED` | certified narrow scope | `CERTIFIED_PARITY_SCOPE` | yes | no |
| `page.history.table-dom` | `PARITY_CERTIFIED` | certified narrow scope | `CERTIFIED_PARITY_SCOPE` | yes | no |
| `page.normal` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `page.options` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `page.parent` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `page.rename` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `page.source` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `page.tags` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `shell.container` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `shell.footer` | `INSUFFICIENT_EVIDENCE` | alias of `shell.footer-license` | `COVERED_BY_ACTIVE_SURFACE` | no | no |
| `shell.footer-license` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `shell.header` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `shell.interwiki` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `shell.interwiki.fixture` | `THEME_LAB_ONLY_SYNTHETIC_SURFACE` | synthetic diagnostic only | `SYNTHETIC_DIAGNOSTIC_ONLY` | no | no |
| `shell.license` | `INSUFFICIENT_EVIDENCE` | alias of `shell.footer-license` | `COVERED_BY_ACTIVE_SURFACE` | no | no |
| `shell.login` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `shell.search` | `INSUFFICIENT_EVIDENCE` | active local target acceptance | `LOCAL_TARGET_ACCEPTANCE_ONLY` | no | no |
| `unclassified-runtime-surface` | `INSUFFICIENT_EVIDENCE` | fail-closed sentinel | `BLOCK_IF_OBSERVED` | no | yes |

Only the two History rows marked `CERTIFIED_PARITY_SCOPE` can authorize parity-based port requirements. Their narrow scope is limited to the captured seven-cell DOM and the observed F deletion row/order/ordinal. The 41 active broad contracts remain in the local matrix, and their current parity eligibility is zero. The machine accounting gate asserts 41 active, two prior narrow certificates, zero new certificates, zero active mismatch fixes, zero required-but-uncertified parity dependencies, and 41 active dependencies removed from parity-based conclusions.
### Material surface findings

- The CSS surface analyzer discovers `page.history` and `page.files`. Their local fixture probes can expose missing action-pane structure; those results remain part of local target acceptance and do not certify source structure.
- The interactive harness force-opens one mobile submenu with a Theme Lab-only class and appends an Interwiki iframe fixture. These are synthetic diagnostics and cannot certify real Wikidot states.
- All 41 active CSS/interaction contracts remain measured locally. Their insufficient source evidence is recorded, but local failures cannot become parity-based port actions. The two footer/license aliases are covered by `shell.footer-license`; `page.diff` is not an independent current harness dependency; the unmatched-runtime sentinel still blocks any new unclassified observation.

## Adaptation audit

| Classification | Finding | Decision |
|---|---|---|
| C — confirmed emulator-only workaround, removed | `HistoryPane.svelte` used six semantic cells, no from/to radios, a desktop grid to imitate imported-theme placements, and a locally invented mobile card layout. The live EN and JP AMC fragments show a seven-cell table, so this was a Wikijump/Wikidot mismatch rather than an EN/JP requirement. | Fixed in Wikijump WIKIDOT History rendering; the six-cell grid/card override was deleted. No Theme Lab candidate CSS was rewritten. |
| C — confirmed runtime mismatch, fixed | WIKIDOT-facing History omitted file revisions from the page timeline even though the retained JP AMC response places a file deletion between page rows 38 and 36 as row 37. | WIKIDOT History now merges the page and file revision streams by event time and assigns a shared ordinal. Native Wikijump History remains page-revision-only. No theme CSS change was needed. |
| B — intentional EN/JP difference, retained | Live History header and flag tooltip strings are localized; the seven cell positions and selectors are shared. | Localize text only. Keep DOM order identical. |
| D — source proof missing, quarantined | SCPedia mobile History overrides mention a “History card grid” and target `.revision-row` sizing; Much Cool reserves phone-width action-pane heading space from a WebKit Source screenshot. Available artifacts are local candidate captures and do not pair these behaviors with the corresponding live Wikidot source state. The capture harness also had stale metadata claiming mobile History reflows to cards. | Leave candidate rules and accepted screenshots unchanged. The metadata now records that the AMC fragment does not establish mobile scroll/reflow behavior. These rules cannot be promoted as port requirements while the whole History surface remains uncertified. |
| D — source proof missing, quarantined | SCP-JP header/search, credit-return, label-contrast, and long-name wrapping rules exist in port or generated-adaptation inputs. Some comments explain the Japanese text or local contrast problem, but the current source oracle does not provide matching Wikidot interaction/browser states for those claims. | Treat them as port hypotheses, not proven A/B requirements, until paired source evidence shows which differences are actual JP localization requirements. No candidate source was rewritten. |

The search covered all Theme Lab candidate CSS and Wikitext source inputs, maintenance base/final/override files, the generated interactive-adaptation source, surface spec, interactive capture code, and retained asset CSS. Rules that simply implement the imported theme itself were not mislabeled as emulator repairs. This continuation removed no candidate CSS: inspected `.page-history` rules, including SCPedia and Monotypical styles, are not proven emulator-only workarounds by the retained source evidence. The D cases remain part of local target acceptance where the harness observes them; their observations cannot form source-parity claims or parity-based port actions.

## Remaining source-side gaps

The bounded browser and AMC captures narrow several evidence gaps but do not cover the full active contract matrix. Missing evidence still includes broad page action panes, non-empty Files rows, generic source rendering, page diff behavior, dialog variants, full tab selection, many responsive/keyboard states, and History pagination/action outcomes. The four failed second-tab attempts remain explicit failures. The two selected source pages do not generalize these observations to every content or theme shape.

Do not promote a local observation, screenshot review, captured module fragment, or existing candidate rule into a source parity certificate. A future exact certificate needs a generalized contract, a paired source/runtime observation at that scope, and tests that bind the evidence. Until then the active contracts stay in local target acceptance; an unmatched runtime dependency remains fail-closed.

## Regression and preservation

- Frozen-history tests verify raw response digests, the seven-cell contract for both source sites, and the observed F deletion row's identity, order, ordinal, and seven-cell structure.
- Framerail tests assert the seven-cell WIKIDOT output, shared page/file timeline ordering, F flag, radios, row ids, selectors, localized labels, V/S affordances without file rollback, `.odate`, and existing History behavior.
- Theme Lab tests assert registry coverage, the 41-contract authority accounting, local target acceptance retention, fail-closed unmatched observations, exact certified-scope actions, independent dependency actions, and synthetic-state status.
- Existing port packages, candidate CSS, and accepted screenshot corpus are unchanged by the History repair.
