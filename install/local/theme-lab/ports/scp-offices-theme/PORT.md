Current source SHA-256: 1fb480f19fd71c9d78ba365e5d88d5668ce46b722546f514b795a83b74eb82c8; CSS SHA-256: f3d5d0cec11e9092bed5913399d302ed8a19dea98a4e43ee71845afe4e803545. Full port acceptance remains a separate combined result.

# SCP-EN → SCP-JP port: `theme:scp-offices-theme`

State: **verified local candidate; not published**. Current upstream source is frozen in `upstream-en.wikidot.txt`; the SHA-256 and update date are in `manifest.json`.

## Starting point

- Existing SCP-JP counterpart: present; frozen in `existing-jp.wikidot.txt`.
- Initial candidate source: `existing-jp.wikidot.txt`. Candidate CSS extracts its inline CSS modules; external and included dependencies remain in `manifest.json`.
- Dependency family: `black-highlighter`.

## Technical decisions


## Bound final evidence

- EN source identity: `b102a2474cef0f96202818ee1e283eab2807c83db8c69479e642b2758629a00a`; updated `2026-04-12T05:22:32+00:00`.
- JP baseline: Previous public JP source SHA-256 712c7edf8e1060819d93f205158f599cf5318cdc4cec6d3e2c5241e059873808 (updated 2023-01-20T10:11:35+00:00); EN was refreshed to 2026-04-12T05:22:32+00:00.
- Final candidate source/CSS SHA-256: `645ad8f6c1cbc5b3fc4a23dee7fe21df3f3172e241207513094912401eefbebe` / `7058588c819cf88bfbe6885f9c656df1eb7a6c428d74f238ceb7ceab73b55035`.
- Offline Theme Lab verdict: `warn`, zero errors/actions, torture `pass`, candidate missing assets `0`, external requests `0`.
- Candidate page images: `2` rendered, `0` broken; `2` of `2` declared page attachments replayed from verified local bytes.
- Geometry: desktop, laptop, tablet, and mobile all report zero document overflow.
- Japanese font specimen: requested `"JetBrains Mono", Recursive, Consolas, monaco, monospace`; actual platform font(s): IPAGothic (29 Japanese glyphs).
- Documented non-defect Theme Lab warnings (selector counts and/or localized-showcase visual diagnostics):
- `table`: 1 EN showcase occurrences vs 3 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- `.yui-navset`: 1 EN showcase occurrences vs 2 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- `.scp-image-block`: 1 EN showcase occurrences vs 2 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- visual-rmse-localized-showcase-difference at desktop: RMSE 0.214754; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at laptop: RMSE 0.247533; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at tablet: RMSE 0.256003; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at mobile: RMSE 0.280107; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- Runtime fixture rendered Rate, tabs, collapsible, table, blockquote, image block, footnote, code, and the Japanese glyph sample. Tabs, collapsible, pointer/focus, and any fixed/sticky scroll behavior report `pass`.
- `1` unconfirmed SCP-EN site-local author identity links were localized to visible credit text; upstream EN and the original human-port source retain their link markup. The local SCP-JP account namespace is not assumed to contain foreign identities.
- Local preview fixture expanded current JP `theme-squares` markup and `2` component CSS modules where used; `preview-fixture.json` binds its source hashes.
- When present, named Wikidot page attachments and their hashes are in `page-assets.json` and `page-assets/`; publish the named files with the candidate source.
