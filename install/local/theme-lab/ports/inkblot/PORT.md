Current source SHA-256: 679a88f60fb72ac72743a09380e121bfbb03207800e41b1ad74e59b1f66bc9ac; CSS SHA-256: fd7e2ae9c01c3d31160b1e7017e441b3abcd8d5eab309c631ef2ebf139fc3406. Full port acceptance remains a separate combined result.

# SCP-EN → SCP-JP port: `theme:inkblot`

State: **verified local candidate; not published**. Current upstream source is frozen in `upstream-en.wikidot.txt`; the SHA-256 and update date are in `manifest.json`.

## Starting point

- Existing SCP-JP counterpart: confirmed absent by targeted XML-RPC refresh.
- Initial candidate source: `upstream-en.wikidot.txt`. Candidate CSS extracts its inline CSS modules; external and included dependencies remain in `manifest.json`.
- Dependency family: `independent`.

## Technical decisions


## Historical evidence (superseded; no current acceptance authority)

- EN source identity: `b40f3fbe59527d76b49423d9297cb30e41599b32b3b2e2912203bac066dbb0af`; updated `2026-04-12T05:05:15+00:00`.
- JP baseline: No public JP counterpart existed after the targeted XML-RPC absence check.
- Final candidate source/CSS SHA-256: `cd23181e4484790b7f5ced563c672496f1466699effa0f1eae8deb2dd03b5110` / `12e6972e14518e7ca1a9bc1c27867ab36097ca579f73f6ed3fdf3b340b32d0f5`.
- Offline Theme Lab verdict: `warn`, zero errors/actions, torture `pass`, candidate missing assets `0`, external requests `0`.
- Candidate page images: `2` rendered, `0` broken; `2` of `1` declared page attachments replayed from verified local bytes.
- Geometry: desktop, laptop, tablet, and mobile all report zero document overflow.
- Japanese font specimen: requested `"Libre Baskerville", serif`; actual platform font(s): IPAPGothic (29 Japanese glyphs).
- Documented non-defect Theme Lab warnings (selector counts and/or localized-showcase visual diagnostics):
- `.collapsible-block`: 5 EN showcase occurrences vs 2 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- `.page-rate-widget-box`: 1 EN showcase occurrences vs 2 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- `.page-rate-widget-box .rate-points`: 1 EN showcase occurrences vs 2 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- visual-rmse-localized-showcase-difference at desktop: RMSE 0.184488; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at laptop: RMSE 0.255509; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at tablet: RMSE 0.254249; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at mobile: RMSE 0.273489; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- Runtime fixture rendered Rate, tabs, collapsible, table, blockquote, image block, footnote, code, and the Japanese glyph sample. Tabs, collapsible, pointer/focus, and any fixed/sticky scroll behavior report `pass`.
- `1` unconfirmed SCP-EN site-local author identity links were localized to visible credit text; upstream EN and the original human-port source retain their link markup. The local SCP-JP account namespace is not assumed to contain foreign identities.
- Local preview fixture expanded current JP `theme-squares` markup and `0` component CSS modules where used; `preview-fixture.json` binds its source hashes.
- When present, named Wikidot page attachments and their hashes are in `page-assets.json` and `page-assets/`; publish the named files with the candidate source.

## Current authoritative correction

- The correction is limited to that submenu below 360px; its source rule is retained in `authority-overrides.css`.
- Fresh full offline local acceptance is recorded in [artifacts/current-acceptance/current-local-check.json](artifacts/current-acceptance/current-local-check.json): port verdict `pass` with zero unresolved findings; target acceptance `fail` because local torture cannot render the TOC module and the mobile-navigation surface has a local-only measured overflow. Link-color observations are also local-only. These findings cannot authorize candidate CSS. The static rating fixture comes from the retained current SCP-JP rating DOM and is used only for local selector coverage.
