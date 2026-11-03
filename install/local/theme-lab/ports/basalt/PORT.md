Current source SHA-256: 7167897315929a07f31f9008682a529351686d51ddab7a8569f6e6d06ca021d5; CSS SHA-256: 059a0e4ff9dc0071e1c13e0bb17578722f46c783ff9227edaa9b0215649afba0. Full port acceptance remains a separate combined result.

# SCP-EN → SCP-JP port: `theme:basalt`

State: **verified local candidate; not published**. Current upstream source is frozen in `upstream-en.wikidot.txt`; the SHA-256 and update date are in `manifest.json`.

## Starting point

- Existing SCP-JP counterpart: confirmed absent by targeted XML-RPC refresh.
- Initial candidate source: `upstream-en.wikidot.txt`. Candidate CSS extracts its inline CSS modules; external and included dependencies remain in `manifest.json`.
- Dependency family: `basalt`.

## Technical decisions


## Bound final evidence

- EN source identity: `df4b78d344536f5b7c363ac86b2ddc6f3c31b3647693f473169550e03fca17c5`; updated `2026-07-22T01:52:12+00:00`.
- JP baseline: No public JP counterpart existed after the targeted XML-RPC absence check.
- Final candidate source/CSS SHA-256: `709badff7dcb9d0a384a7a7cf557df8e1c16c9b9860deef2ace04932f120fa28` / `a11d628beb2c0d6694b2bb178a192e1c367b26e7b758e93742dbc9c6012d7961`.
- Offline Theme Lab verdict: `warn`, zero errors/actions, torture `pass`, candidate missing assets `0`, external requests `0`.
- Candidate page images: `1` rendered, `0` broken; `1` of `1` declared page attachments replayed from verified local bytes.
- Geometry: desktop, laptop, tablet, and mobile all report zero document overflow.
- Japanese font specimen: requested `InterVariable, メイリオ, meiryo, tahoma, verdana, "ヒラギノ角ゴ Pro W3", "Hiragino Kaku Gothic Pro", osaka, "ＭＳ Ｐゴシック", "MS PGothic", sans-serif`; actual platform font(s): IPAPGothic (29 Japanese glyphs).
- Documented non-defect Theme Lab warnings (selector counts and/or localized-showcase visual diagnostics):
- `.scp-image-block`: 7 EN showcase occurrences vs 1 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- `.yui-navset`: 1 EN showcase occurrences vs 2 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- visual-rmse-localized-showcase-difference at desktop: RMSE 0.143925; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at laptop: RMSE 0.161924; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at tablet: RMSE 0.179578; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at mobile: RMSE 0.232772; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- Runtime fixture rendered Rate, tabs, collapsible, table, blockquote, image block, footnote, code, and the Japanese glyph sample. Tabs, collapsible, pointer/focus, and any fixed/sticky scroll behavior report `pass`.
- `6` unconfirmed SCP-EN site-local author identity links were localized to visible credit text; upstream EN and the original human-port source retain their link markup. The local SCP-JP account namespace is not assumed to contain foreign identities.
- Local preview fixture expanded current JP `theme-squares` markup and `0` component CSS modules where used; `preview-fixture.json` binds its source hashes.
- When present, named Wikidot page attachments and their hashes are in `page-assets.json` and `page-assets/`; publish the named files with the candidate source.

## Full-check warnings (basalt-final-20261022-full3)

Run `basalt-final-20261022-full3` (raw result sha256 `121c91de…`, target contract `f2f38252…`) on the runtime worktree at 12d01d0ee6. Port verdict: PASS. Target verdict: INCONCLUSIVE with 16 warnings (11 torture components, 4 expanded selectors, 1 collapsed selector). A warning is **explained** only where the mechanism is checked against source evidence. All 16 are explained below; none is an open defect. The finalizer still reports the target as `warn` while the raw issues exist (see Other findings).

Terms: "reference" for selector rows is the frozen Basalt EN page (offline replay of the retained Wikidot snapshot). "baseline" for torture rows is the Sigma-9 offline baseline CSS applied to the same fixture, and "candidate" is Basalt.

### Explained: content width (6 warnings)

Frozen Basalt sets `#main-content{width:var(--main-content-width);max-width:calc(100% - var(--main-content-side-margin)*2)}` with `--main-content-side-margin:1.325rem` (21.2px). At 768px the content box is 768 − 2×21.2 = 725.6px, and at 390px it is 390 − 2×21.2 = 347.6px. The Sigma-9 baseline keeps a narrower column (about 435px at tablet). The measured candidate widths match the rule exactly.

The desktop and laptop rows follow the frozen `--main-content-width: 60rem` (960px). The torture toc and blockquote widths also come from frozen rules that scale with that width: `div#toc{max-width:calc(var(--main-content-width)*.375)}` gives 360px (measured 118.8 → 360 at desktop, laptop, and tablet), and `#main-content blockquote{max-width:calc(var(--main-content-width)*.825)}` gives 792px (measured 627 → 792 at desktop and 611 → 792 at laptop). At narrow widths the container limit applies (toc 107.5 → 277.6 at narrow-mobile equals 100% of the 277.6px content box).

| # | surface / component | viewport | property | baseline | candidate | explanation |
|---|---|---|---|---|---|---|
| 1 | content.toc / toc | mobile | rect.width | 107.5 | 347.6 | Basalt `#main-content` max-width at 390px |
| 2 | content.blockquote / blockquote | tablet | rect.width | 355.2 | 725.6 | same rule at 768px |
| 3 | content.article / heading | tablet | rect.width | 435.2 | 725.6 | same rule |
| 4 | content.article / list | tablet | rect.width | 435.2 | 725.6 | same rule |
| 5 | content.code / code | tablet | rect.width | 435.2 | 725.6 | same rule |
| 6 | content.tabview / tabview | tablet | rect.width | 435.2 | 725.6 | same rule |

### Explained: candidate preview content (4 warnings)

These are element-count differences between the frozen EN reference page and the candidate preview source (`candidate.wikidot.txt`, which the full check renders). They come from preview content and the JP credit adaptation, not from theme CSS.

| # | selector | reference (frozen EN markup) | candidate | evidence |
|---|---|---|---|---|
| 7 | `.page-rate-widget-box` | 1 | 2 | candidate preview has one `[[module Rate]]` (line 1362) plus the JP credit rate box `div.rate-box-with-credit-button` / `div.creditRate` (lines 1709–1711). `ports/basalt/maintenance/jp-overrides.css` targets that JP credit box, and the JP credit snapshots (credit-end, lines 16 and 20) carry the Rate module inside the credit modal. The credit modal in the captured states shows a rating widget, so the second widget is the JP credit adaptation. The mapping from widget to markup is inferred from markup, not from a DOM dump. |
| 8 | `.page-rate-widget-box .rate-points` | 1 | 2 | same cause as row 7 |
| 9 | `.yui-navset` | 1 | 2 | candidate preview has two `[[tabview]]` blocks (lines 1544 and 1723); the frozen EN page has one tabview in its markup (upstream count 1). |
| 10 | `.scp-image-block` (collapsed) | 7 | 1 | the frozen EN page markup has seven `scp-image-block` elements; the candidate preview has one `[[div class="scp-image-block block-right"]]` (line 1737). The count follows preview content. |

### Explained: torture geometry and the header heading (6 warnings)

Torture rows compare the Sigma-9 baseline with the candidate on the same fixture. Every candidate rule that matches a table, math, rating, collapsible, or footnote selector is verbatim in the frozen Basalt sources (upstream EN source or the frozen replay stylesheets). No JP-only rule touches those selectors. The inputs that change are the frozen font chain and the frozen content width:

- Frozen `:root` sets `--base-font-size: .875rem` (upstream line 118) and `--page-content-font-size: calc(var(--true-font-size) * 1.13)` (line 119). `#page-content` uses it. Desktop body text measures 12.8 → 15.43 px (×1.206); mobile headings 21.89 → 26.24 px (×1.199).
- Frozen `--main-content-width: 60rem` widens the desktop column (heading 707 → 960 px).
- The fixture is Latin-only, so the frozen `:root:where(:lang(ja))` CJK fallback stack (`basalt-bedrock-min.css`, decision `freeze-source-stylesheet`) does not change line metrics here.

| # | row | baseline → candidate | mechanism |
|---|---|---|---|
| 11 | torture table (narrow-mobile height; mobile; desktop) | 96.7 → 223.8; 96.7 → 164.0; 72.0 → 120.5 | frozen table rules; inherited frozen font chain (×1.206 desktop); text wraps more at unchanged width |
| 12 | torture math (narrow-mobile height) | 23.5 → 53.5 | `candidate.css` has no math-specific selector (only the editor toolbar icon); the block inherits the frozen font chain |
| 13 | torture rating (desktop height; width) | 18 → 35.1; 148.2 → 178.3 | frozen rating rules: `span.btn` is a block sized by `--rate-module-button-size: 1.625em` (verbatim in the frozen replay stylesheet), so it scales with the frozen font chain |
| 14 | torture collapsible (mobile height) | 12 → 20.3 | frozen `.collapsible-block` rules; inherited font chain |
| 15 | torture footnote (mobile width; desktop 5.94 → 5.0 width, 12 → 15 height) | 5.34 → 4.0 | frozen `sup` and `sub,sup` rules (`font-size:75%`, `top:-.5em`) apply to the marker |
| 16 | expanded `#header h2` (reference 1, candidate 2) | 1 → 2 | runtime shell, not theme CSS. A read-only DOM probe of the final runtime page found two `#header h2`: the tagline (`<h2><span>`) and the Framerail sign-in dialog title `<h2 id="wikidot-login-dialog-title">` inside `#login-status` (`framerail/src/lib/wikidot/WikidotLoginDialog.svelte`). The EN replay header has only the tagline. CSS cannot change an element count. |

Limit: rows 11, 12, 13, and 15 are attributed to the frozen rules and font chain. Per-line wrap counts and the baseline rules that set the native heights were not measured separately.

### Rate-widget reset block (resolved, provenance)

The eight `unset` rules for `.page-rate-widget-box` in `candidate.css` are verbatim in frozen `normalize-min.css` (sha256 `6f6014087e44…`, from `https://cdn.scpwiki.com/theme/en/basalt/normalize-min.css`). `ports/basalt/assets.json` records it as a `candidate-css-import` with decision `freeze-source-stylesheet`. The generator is that frozen import, so no package input is missing.

### Other findings and their status

- Candidate preview sample line (resolved): the "On any page" and theme-setting samples rendered as ':scp-jp:[[/span]]theme:basalt]]@@'. The preview builder treated include-like text inside Wikidot @@ raw spans as a directive (commit 6c09889378). The preview is regenerated through `ports/scripts/rebuild-previews.py`; candidate.wikidot.source.txt and candidate.css are unchanged.
- Desktop full-check candidate capture (resolved): the sidebar drawer was open in the first desktop screenshot because captureVisualPair did not park the pointer before screenshots (commit ca046d3940). The safe-area park now runs before every paired and single-page screenshot; full3 shows a clean reading state at all five viewports.
- Finalize (current status): accepted at `overall warn` (port `pass`, target `warn` with the 16 explained raw issues, visual `warn`). The result is `ports/current-acceptance/basalt/accepted-result.json` (sha256 `6c9740f4…`, untracked evidence in the evidence store). The semantic visual question was recorded with `scripts/record-semantic-browser-reviews.mjs` from `ports/basalt/semantic-review-decisions.json`, which stamps `acceptance_model` only after the whole semantic validation passes. Earlier, finalize refused because no tool wrote that marker. The target contract bound by the full3 raw result is `f2f38252…`, which is the runtime's pinned Theme Lab plus the pointer-park overlay. The #2733 tree computes `91ec0e…`. A full-check rerun from the merged code is needed before a later finalize can bind that tree.
