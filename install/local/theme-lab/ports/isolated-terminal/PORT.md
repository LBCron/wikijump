Current source SHA-256: 528f4a52a34ac4dd3de8133a2fff4dd6c0b56da8be0b4b10c8b6c3b21a4e1e26; CSS SHA-256: 4b8fb8dd0aca57923f47143d4e2dc55192b35d2173b54b93dfc25785ed1511d8. Full port acceptance remains a separate combined result.

# SCP-EN → SCP-JP port: `theme:isolated-terminal`

State: **verified local candidate; not published**. Current upstream source is frozen in `upstream-en.wikidot.txt`; the SHA-256 and update date are in `manifest.json`.

## Starting point

- Existing SCP-JP counterpart: present; frozen in `existing-jp.wikidot.txt`.
- Initial candidate source: `existing-jp.wikidot.txt`. Candidate CSS extracts its inline CSS modules; external and included dependencies remain in `manifest.json`.
- Dependency family: `black-highlighter`.

## Technical decisions


## Bound final evidence

- EN source identity: `120ce0a71fa1ca235d3ed1955957ebe037bdb8e4a160b7099fe810d61f17a257`; updated `2026-02-01T03:34:54+00:00`.
- JP baseline: Previous public JP source SHA-256 4cffaa491e5f88926e9793f732bdb80616f0c8a91282b2544478e1b9caa41e30 (updated 2026-07-30T02:50:04+00:00); EN was refreshed to 2026-02-01T03:34:54+00:00.
- Final candidate source/CSS SHA-256: `0f94026cb973ca4de41bd5e5b579a5242f24ec6a5cdeb7e3f27953c21c557ae1` / `896f768887a6a20768c84ad4b9a10917df38146b72ec1192fe8c7c9cf492d699`.
- Offline Theme Lab verdict: `warn`, zero errors/actions, torture `pass`, candidate missing assets `0`, external requests `0`.
- Candidate page images: `1` rendered, `0` broken; `1` of `1` declared page attachments replayed from verified local bytes.
- Geometry: desktop, laptop, tablet, and mobile all report zero document overflow.
- Japanese font specimen: requested `Terminus, "Noto Sans JP", sans-serif`; actual platform font(s): IPAPGothic (29 Japanese glyphs).
- Documented non-defect Theme Lab warnings (selector counts and/or localized-showcase visual diagnostics):
- `.page-rate-widget-box`: 3 EN showcase occurrences vs 1 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- `.page-rate-widget-box .rate-points`: 3 EN showcase occurrences vs 1 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- `blockquote`: 3 EN showcase occurrences vs 8 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- `table`: 1 EN showcase occurrences vs 3 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- `.yui-navset`: 1 EN showcase occurrences vs 2 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- visual-rmse-localized-showcase-difference at desktop: RMSE 0.178013; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at laptop: RMSE 0.238317; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at tablet: RMSE 0.303546; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at mobile: RMSE 0.276272; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- Runtime fixture rendered Rate, tabs, collapsible, table, blockquote, image block, footnote, code, and the Japanese glyph sample. Tabs, collapsible, pointer/focus, and any fixed/sticky scroll behavior report `pass`.
- `4` unconfirmed SCP-EN site-local author identity links were localized to visible credit text; upstream EN and the original human-port source retain their link markup. The local SCP-JP account namespace is not assumed to contain foreign identities.
- Local preview fixture expanded current JP `theme-squares` markup and `2` component CSS modules where used; `preview-fixture.json` binds its source hashes.
- When present, named Wikidot page attachments and their hashes are in `page-assets.json` and `page-assets/`; publish the named files with the candidate source.
