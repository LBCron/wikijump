# Foreign SCP branch theme to SCP-JP technical localization specification

Version: 1.4 (2026-09-23)

The normative requirement classes and surface requirements in this document
apply to foreign-branch theme ports generally. The original 1.4 campaign
covered all 34 SCP-EN sources listed in `en-theme-campaign.json` plus the
retained SCP-KO Dear Dictator port; those historical records continue to bind
that campaign version. New SCP-FR/SCP-KO/SCP-CN/etc. ports bind their own
source authority, dependencies, existing-JP evidence and final acceptance in
their package manifest/record. A previous JP or third-branch implementation
is evidence to inspect, never automatically the correctness authority. A
requirement is accepted only when its current DOM/CSS evidence is recorded in
the theme record.

## Evidence and authority

- For the historical EN34 campaign, current theme source, update metadata,
  tags, UUIDs, and attachments come from the refreshed shared corpus at
  `/home/roku/src/Rokurolize/scp-wiki-translation/corpus/{en,jp}/pages/`. The
  EN refresh was targeted to the 34 explicit slugs. JP existing counterparts
  were refreshed separately; the remaining 12 slugs returned the XML-RPC
  page-does-not-exist fault and were kept in the corpus pending area because
  no prior entity exists.
- For a new foreign-branch port, acquire the exact public Wikidot source and
  freeze it in the package before adapting it. Follow
  `NEW-FOREIGN-THEME-PORT.md` and use
  `install/local/theme-lab/scripts/acquire_wikidot_source.py` (or an
  equivalently retained source artifact) rather than reconstructing source
  from rendered HTML. Freeze material include/dependency source identities as
  well. After the explicit refresh, normal Theme Lab iteration is offline.
- The existing translation campaign's `worklists/theme/technical_surface_matrix_summary.md`, `technical_requirement_matrix_summary.md`, and `sigma10/static_dependency_matrix_summary.md` establish useful review classes and known risks across earlier human ports. They are screening evidence only: their page CSS extraction does not prove the current JP DOM or current EN revision.
- Its `theme_jp_available_review.py`, `theme_en_asset_review.py`, `theme_bhl_base_review.py`, `theme_static_dependency_matrix.py`, `theme_selector_reachability.py`, and `theme_network_audit.py` are retained as the classification method. Their outputs require page-level review; they do not authorize string-for-string replacement.
- Current local JP runtime evidence is a live page at `https://scpaiueouiuiuiui.wikijump.localhost:18443/boundary-check` plus Deepwell preview of candidate Wikidot sources. On 2026-09-23 the page exposed one each of `#header`, `#top-bar`, `#side-bar`, `#main-content`, `#page-title`, `#page-content`, `#page-info`, and `#page-options-container`. A plain boundary page had no rating widget or article components. A normal (non-syntax-only) preview of Bedrock source rendered `.page-rate-widget-box`; `--syntax-only` omitted that runtime module surface. The checks and screenshots in each port package preserve the actual per-theme evidence.
- A current EN Bedrock reference acquisition exposed `.ios-cache-issue-notification` around a collapsible; Theme Lab suggested the local `.collapsible-block` semantic anchor. It also retained three failed resource fetches with their causes and blocked third-party browser requests before send. This is the reason the campaign uses normal module preview and offline replay for ordinary iterations.

## Requirement classes

| Class | Rule |
| --- | --- |
| `MUST_PRESERVE` | Preserve the theme's evidenced visual identity, information hierarchy, meaningful imagery, typography intent, color/contrast relationships, and interaction states. Do not replace a theme with the generic JP base merely to clear a diff. |
| `MUST_ADAPT_FOR_JP` | Adapt selectors coupled to EN-only header, sidebar, interwiki, mobile-navigation, rating, file, or component DOM when the current JP runtime differs. Render Japanese content and verify glyph coverage, actual fallback, line-height, and resulting wrapping. Keep a JP-appropriate page width and readable mobile layout. |
| `MAY_DIFFER` | Reader-facing prose, page-specific demo contents, and structural wrappers may differ where localization or the current JP runtime requires it. Record each material difference and its evidence. A count-only difference between unrelated demo articles is not an automatic defect. |
| `FORBIDDEN_STALE_DEPENDENCY` | Do not leave an obsolete, accidental SCP-EN page, component, or asset URL in the delivered candidate. Do not use an EN-only DOM include when a verified JP runtime component is required. Any retained shared upstream CDN must be intentional, reachable, and recorded with URL, owner, reason, and acquisition status. |
| `MUST_VERIFY` | No horizontal overflow or obscured content at desktop 1440×1000, laptop 1024×900, tablet 768×1024, and mobile 390×844. Run the component torture corpus; exercise menu, tabs, collapsibles, hover/focus/active states, and fixed/sticky/scroll behavior when the theme uses them. Full Theme Lab acceptance must run the CSS-derived SCP-JP surface contract; source-specific active selectors not represented by a known runtime surface belong in the package `surface-contract.json`. |

## Surface requirements

### Dependencies and assets

Record `[[include]]`, CSS-module, `@import`, font, image, icon, background, CDN, `local--files`, `local--code`, and CDN-origin edges. Classify every external surface as one of `retain-shared-upstream`, `replace-with-public-jp-counterpart`, `localize-into-package`, `replace-with-jp-owned-asset`, or `remove-obsolete`; include the exact evidence and digest. A same-name asset is only a candidate until its bytes and visual/semantic use are compared. Missing assets are blockers unless the record justifies an intentionally absent optional reference resource. Keep required candidate assets local and fail-closed.

For BHL-derived themes, separately identify BHL normalize/base CSS, theme-specific CSS, logo, component includes, and theme assets. SCP-JP's public BHL CSS or logo is a replacement candidate only after current source/revision and rendered behavior are checked. For Sigma/Basalt-derived themes, record the actual inheritance chain and avoid duplicating shared base fixes in each child theme.

Page-level `[[image]]` assets and browser `<img>` elements are part of candidate asset acceptance, separate from CSS URL inspection. Theme Lab waits for image completion and requires nonzero `naturalWidth`/`naturalHeight`; every missing image has a selector, alt text, source URL and an evidence-backed `localize_image` action. Reproducible page attachments live under each port's `page-assets/` with a `page-assets.json` filename, SHA-256, source URL, and content-addressed pool path. Upload those named files to the candidate SCP-JP theme page when publishing. For Theme Lab replay the runner verifies the hash and substitutes only those declared attachments with local data URLs before screenshot/interaction checks. Undeclared external requests remain blocked.

### JP runtime and content surfaces

- `#header`, title/subtitle, logo, search, account/navigation, `#top-bar`, `#side-bar`, mobile sidebar controls, and `#main-content` must be mapped against the current JP runtime. Do not depend on EN-only IDs or `nth-child` menu order without direct DOM evidence.
- Do not flatten responsive behavior merely because a cross-branch port uses a
  fixed value. Where the current JP baseline changes header/logo/title size,
  positioning, width or other geometry across desktop/mobile, record the
  baseline computed values and preserve that responsive contract unless the
  source theme has evidence for deliberately replacing it. Theme Lab reports
  `baseline_responsive_behavior_flattened` when a property that varies in the
  JP baseline becomes the same value at both canonical viewports.
- Preserve the source theme's article width and title behavior where compatible. Audit fixed/sticky elements while scrolling and during viewport transitions, not only after layout settles.
- The standard Wikidot `[[module Rate]]` is mandatory in each theme fixture when the theme can style a page. Compare the source module and resulting EN rating selector assumptions with the normal SCP-JP Deepwell preview. On current JP the tested preview exposes `.page-rate-widget-box`; the runtime may not render rating markup on a page lacking the module. A syntax-only preview is insufficient for rating acceptance.
- Wikidot `[[*user NAME]]` links resolve in the current site's account namespace. Preserve those links only when the referenced identity is confirmed on SCP-JP. For an SCP-EN-only/unconfirmed author, preserve the credited visible name as text in the JP candidate; do not publish a broken JP user link. The source EN and human-port snapshots retain the original identity markup for provenance.
- Current SCP-JP BHL-based headers synthesize the site wordmark through `#header h1 a::before`; the runtime's mobile rule sets that anchor to `3rem` (48px at the tested 390px viewport). If a localized two-word theme title wraps into or overlaps its subtitle, compare the computed `font-size`, pseudo-element content, and mobile width before changing structure. Ouroborous evidence required a 390px-only `clamp(1rem, 5vw, 1.4rem)` title size and `white-space: nowrap`; the existing subtitle positioning then remained intact. Preserve EN desktop/tablet sizing and record the theme-specific override.
- Exercise tables, blockquotes, code, tabs, collapsibles, footnotes, TOC, and image blocks when the source styles them. An include that Deepwell preview does not expand must be represented by an equivalent JP-runtime fixture and called out; zero matches are not evidence of compatibility.
- Where themes touch page options, credits/license components, or action controls, record their live JP selector mapping and check focus/hover/active states.
- A simplified hand-written DOM is not sufficient evidence for an existing
  SCP-JP component. Use the repository-owned current component fixture when
  available. The surface contract deliberately renders the real credit/rating
  fixture before evaluating selectors so cascade/specificity from the component
  itself is part of the result.

### CSS behavior and Japanese text

Record custom properties and their defaults/overrides, selector specificity, `!important`, cascade winner, inactive media rules, pseudo-elements, `nth-child` assumptions, transitions/animations, and all breakpoints that affect the four required viewports. The final candidate must have no unexplained next actions, selector reachability errors, unresolved cascade errors, or torture regressions.

The shared runtime selector list checks common SCP-JP surfaces only. Full
Theme Lab acceptance additionally derives a surface inventory from the
candidate CSS and exercises every known runtime surface that the theme touches.
A theme with source-specific active component selectors must add them to its
package `surface-contract.json` (and may also retain them in
`acceptance-selectors.txt` for reference/candidate count comparison). This
campaign caught the Sigma candidate's omitted `.color`, `.blink`, and
`.footnotes-footer` rules when the selectors were added; the rules are now
preserved from current EN CSS in the JP candidate, and the fixture exercises
them. A common rating/table fixture alone cannot establish that a theme's own
CSS module survived localization.

Font acceptance requires real Japanese text, not just a `font-family` declaration. The local fixture includes a Japanese glyph specimen, and Theme Lab queries Chromium `CSS.getPlatformFontsForNode` for its rendered node. Record the requested CSS stack, the actual platform font family or families, custom-font status and glyph counts, and line-height/wrapping consequences. A foreign font with incomplete Japanese glyph coverage must receive a suitable JP font stack or packaged font whose license/source is documented. A screenshot alone is insufficient when the actual platform font can be queried.

## Acceptance record

### Expanded navigation geometry

A submenu rendered inside `#top-bar .top-bar > ul > li > ul` or `.mobile-top-bar > ul > li > ul` must remain within the viewport at the state where it opens. SCP-JP labels are longer than many EN labels, so the first-level submenu may anchor to the parent item’s right edge and wrap Japanese link text; nested submenu positioning remains theme-owned. This is `MUST_ADAPT_FOR_JP` when browser evidence shows viewport spill. Validate laptop/tablet desktop-bar widths and mobile open-menu states; do not hide the submenu or clip its overflow. Evidence: current interactive capture `nav.mobile-top/submenu-expanded` and Theme Lab `new_horizontal_overflow` source selectors `ul`, `li`, `a.newpage` for Foxtrot, SCPedia, Al-Slop, Pataphysics, Turbo Vision, Paperstack and Hansarp.

The reference and candidate theme pages are documentation pages, often with different language, content, and showcase samples. Their raw pixel RMSE is diagnostic evidence, not a direct acceptance score. Review paired screenshots for broken theme identity/layout; explain selector-count warnings that are caused by showcase/component repetition differences. Every port's `record.json` binds the source identity, previous public JP identity/status, source/candidate hashes, dependency decisions, Theme Lab findings, edit/check counts, manual fallbacks, assets/fonts, rating/module evidence, all four viewport verdicts and screenshots, interactions when relevant, offline external-request count, warnings and rationale, torture result, and technical-spec version. A warning is acceptable only with a documented intentional visual difference, JP structural adaptation, reference/candidate content mismatch, or other concrete non-defect explanation.
