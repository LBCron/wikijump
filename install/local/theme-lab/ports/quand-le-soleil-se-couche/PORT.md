Current source SHA-256: 242dcf54d6b52cea946b65f1c38b508479d255853810d8d7cee3ed3be42815eb; CSS SHA-256: 6b82140e1f875394bb5ceb7e2e6be6e9805157dd18c04fc7c63c6eea72eb49a8. Full port acceptance remains a separate combined result.

# SCP-FR → SCP-JP port: `theme:quand-le-soleil-se-couche`

State: **verified local SCP-JP candidate; not published**.

This package is the worked example for the generic new-foreign-theme workflow
in `../NEW-FOREIGN-THEME-PORT.md`.

## Source and existing JP state

- SCP-FR source: `https://fondationscp.wikidot.com/theme:quand-le-soleil-se-couche`
  - page ID `1453535015`
  - revision `13`
  - updated `2025-08-12T09:09:31Z`
  - source SHA-256 `eebdb3d7e620550d2921ff5814fa44df29a98ecc96e953ba29423ad525ec281d`
- Source credits preserved from the FR page: Cauchynambour; the upstream comment
  also credits Cyrielle Centori for international/English adaptation and
  Cauchynambour for the logo.
- SCP-KO cross-branch implementation:
  `https://scpko.wikidot.com/theme:quand-le-soleil-se-couche`, revision 4,
  source SHA-256
  `a7dac1e183074b01d4aa246e8ee1e60f56618ea2dc4a7222ab7717baa49ed497`.
- Current SCP-JP canon hub:
  `https://scp-jp.wikidot.com/centre-quand-le-soleil-se-couche`, revision 5,
  source SHA-256
  `ad58489823ebe90644008ddb2df87c794c71e0eced39fc0762d5f31cd6fedf5d`.
  It currently includes `:scpko:theme:quand-le-soleil-se-couche` and its
  translated instructions explicitly note that the raw FR include does not
  operate normally under the JP site environment. The natural local target,
  `https://scp-jp.wikidot.com/theme:quand-le-soleil-se-couche`, currently
  returns HTTP 404, so there is no existing SCP-JP theme page to overwrite or
  treat as an authority.
- `https://scp-jp.wikidot.com/theme:quand-le-soleil-se-couche` currently
  returns HTTP 404. This package is therefore a new local JP candidate, not a
  refresh of an existing public JP theme page.

`source-acquisition.json` and the frozen `upstream-*.wikidot.txt` files bind
the exact source identities. The FR source was reacquired with
`scripts/acquire_wikidot_source.py` and matched the frozen bytes exactly.

## What had to be ported

The FR source is not portable by copying its CSS verbatim. It defines `ct_*`
variables consumed by the FR site framework and uses
`:fondationscp:component:modele-theme` for its theme showcase.

The include chain was inspected through
`component:modele-theme-base`. Its showcase content is guarded by
`[[iftags +thème]]`, so it is a documentation-page fixture rather than a
runtime dependency required by articles using the theme.

The SCP-KO port is useful evidence because it already maps the FR `ct_*`
contract onto stock Sigma-9 header/link DOM. The JP candidate retains that
structural compatibility layer but localizes the branch-specific identity:

- Korean `재단` → Japanese `財団`;
- preserves the existing `sous-titre` include parameter exposed by the
  current SCP-JP hub;
- removes FR/INT/EN tag-conditional adaptation blocks that are not JP runtime
  behavior;
- replaces the FR-only showcase include with a local JP validation fixture.

The FR page imports Google `Space Mono`, but neither the FR theme source nor
the evidenced KO compatibility layer contains a declaration that selects that
font family. The JP port therefore classifies the import as
`remove-obsolete` instead of shipping an unused font.

## Assets

The two required runtime images are frozen locally and are the attachments
expected on the eventual JP theme page:

| file | SHA-256 | bytes |
| --- | --- | ---: |
| `header-logo.png` | `e242245d05519a8b2b8d672837f580ce483ded9691f8f14c1c7653fc4c2a336a` | 368742 |
| `body_bg_grey.png` | `bec371b36d3f250ca4b45a03ab46d6a31a5536481ba334cd4ec06eb985db7b0a` | 4099 |

Theme Lab uses those local bytes during validation. The publishable source
instead refers to the corresponding named
`https://scp-jp.wdfiles.com/local--files/theme:quand-le-soleil-se-couche/`
attachments; public publication is intentionally outside this repository
task.

## Include-variable handling

`candidate-template.css` is the actual reusable template and retains
`{$sous-titre}`. Direct Theme Lab CSS injection does not execute Wikidot
include substitution, so `candidate.css` is a deterministic validation copy
with `夜明けまで忘れるな` substituted as the representative value.

`build.mjs` fails closed if those two forms drift, if the frozen FR/KO/JP
source hashes differ from `manifest.json`, or if either attachment's bytes or
digest change.

## Theme Lab findings and repair

The first full check found one actionable JP adaptation:

- mobile viewport: **13 px new horizontal overflow** from an expanded
  `.mobile-top-bar` submenu containing longer JP navigation labels.

The accepted fix uses the campaign's established SCP-JP navigation adaptation:
bound nested menu/list/link widths to the viewport and allow localized labels
to wrap. It does not hide or clip navigation.

The failing pre-fix result is retained as `initial-verdict.json`; its overflow
sources are the mobile top-bar `ul`, descendant `li`, and `a.newpage` geometry.

Later comparison against an independent SCP-JP Technical Staff draft exposed a
second, Theme-Lab-owned mistake in the first accepted candidate: the KO-derived
compatibility mapping had flattened the SCP-JP baseline's responsive header
geometry by forcing a 100×100 px logo and theme-sized wordmark at mobile
widths. The port now preserves the JP baseline mobile sizing and applies the
100 px logo size only at the desktop breakpoint. This is now guarded
generically by the CSS-derived surface contract's
`baseline_responsive_behavior_flattened` diagnostic rather than by a
theme-specific assertion.

The same comparison also demonstrated why Theme Lab must exercise the real JP
component DOM instead of a simplified hand-written approximation. A simplified
credit-button probe suggested a link-color regression, but the repository-owned
current credit component has a higher-specificity link rule and the real
surface remained readable. No unnecessary credit override was added. Full
acceptance now renders the shared JP component fixture whenever candidate CSS
touches credit/rating/navigation/etc. selectors.

`surface-contract.json` additionally binds the source hub's active
`h2 .flickering` selector at desktop and mobile. Known SCP-JP surfaces are
auto-discovered from the CSS; source-specific selectors are explicit so a new
theme cannot pass merely because its special showcase class was absent from the
generic fixture.

The final full offline check reports:

- verdict: `warn`
- `next_actions: []`
- desktop/laptop/tablet/mobile: **PASS, 0 px document overflow**
- torture corpus: **PASS**, 0 issues
- tab interaction: **PASS**
- pointer/focus interaction: **PASS**
- candidate assets: **2 referenced, 0 missing**
- candidate request failures: **0**
- external acquisition during final offline run: **0**
- surface-contract actionable issues: **0**
- touched JP surfaces: header, top/mobile navigation, sidebar, rating,
  article/links, credit, tabview, and image-block
- source-specific `.flickering` heading: **present at desktop and mobile**

The only remaining structured warning is
`#page-content a`: FR showcase 21 occurrences vs JP fixture 9. Both sides
contain the selector; the count difference comes from different
foreign-language/localized showcase content and is not a missing theme rule.

Full-page visual RMSE is retained as a diagnostic rather than a pass/fail
criterion because the compared pages contain different language, text, site
chrome and showcase content:

- desktop `0.248828`
- laptop `0.303082`
- tablet `0.308492`
- mobile `0.379088`

The paired screenshots are in `artifacts/`. Geometry, required selectors,
assets, interaction states and the responsive structure are the acceptance
signals; raw full-page pixel identity between FR and JP is not expected.

All four paired viewport screenshots were manually reviewed after the final
run. The candidate preserves the source theme's monochrome header/logo,
wordmark treatment and responsive composition while retaining SCP-JP's
mobile header/logo sizing. The conspicuous FR red
`EH TOI LÀ!` box and several surrounding blocks are showcase-page content
from the foreign documentation/component layer, not reusable theme identity,
so their absence from the JP validation fixture is intentional.

## Build

From the repository root:

```sh
node install/local/theme-lab/ports/quand-le-soleil-se-couche/build.mjs \
  /tmp/quand-le-soleil-se-couche.wikidot.txt
```

This writes:

- a self-contained local demonstration source at the requested path;
- a `-theme.wikidot.txt` reusable source that references the two named
  SCP-JP theme-page attachments.

The reviewed publishable source is committed as
`publishable-theme.wikidot.txt`.

Publication would require uploading the two exact attachment files and saving
that reviewed source as `theme:quand-le-soleil-se-couche` on SCP-JP. This
package does **not** mutate SCP-JP.
