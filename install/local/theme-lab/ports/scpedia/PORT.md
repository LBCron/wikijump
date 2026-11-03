Current source SHA-256: 7cad349274e80a9710e32526e5366b85e4cec268d04a80fc5b6e80bdc806d41c; CSS SHA-256: 137675ef1fc201189336334bde5d9c88b8d38012a1c2d193cfbe5632338f556f. Full port acceptance remains a separate combined result.

# SCP-EN → SCP-JP port: `theme:scpedia`

State: **verified local candidate; not published**. Current upstream source is frozen in `upstream-en.wikidot.txt`; the SHA-256 and update date are in `manifest.json`.

## Starting point

- Existing SCP-JP counterpart: confirmed absent by targeted XML-RPC refresh.
- Initial candidate source: `upstream-en.wikidot.txt`. Candidate CSS extracts its inline CSS modules; external and included dependencies remain in `manifest.json`.
- Dependency family: `independent`.

## Technical decisions


## Bound final evidence

- EN source identity: `195a9d70bbfed2cf6cb177aec6b7f8f236c7ca161af19b040d1a653f8da16284`; updated `2026-04-12T05:22:44+00:00`.
- JP baseline: No public JP counterpart existed after the targeted XML-RPC absence check.
- Final candidate source/CSS SHA-256: `c1b5f73166c5a0838185ea424bd6e01e3594efc2c7875adf66e3b22881276342` / `4c1828e8284c3bf286f4a4be11a1c7b0662d752b49bef29dbe5dd80894004949`.
- Offline Theme Lab verdict: `warn`, zero errors/actions, torture `pass`, candidate missing assets `0`, external requests `0`.
- Candidate page images: `0` rendered, `0` broken; `0` of `0` declared page attachments replayed from verified local bytes.
- Geometry: desktop, laptop, tablet, and mobile all report zero document overflow.
- Japanese font specimen: requested `sans-serif, Roboto, sans-serif`; actual platform font(s): IPAPGothic (29 Japanese glyphs).
- Documented non-defect Theme Lab warnings (selector counts and/or localized-showcase visual diagnostics):
- `table`: 1 EN showcase occurrences vs 3 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- `.yui-navset`: 1 EN showcase occurrences vs 2 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- visual-rmse-localized-showcase-difference at desktop: RMSE 0.149244; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at laptop: RMSE 0.173177; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at tablet: RMSE 0.231744; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at mobile: RMSE 0.248318; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- Runtime fixture rendered Rate, tabs, collapsible, table, blockquote, image block, footnote, code, and the Japanese glyph sample. Tabs, collapsible, pointer/focus, and any fixed/sticky scroll behavior report `pass`.
- `1` unconfirmed SCP-EN site-local author identity links were localized to visible credit text; upstream EN and the original human-port source retain their link markup. The local SCP-JP account namespace is not assumed to contain foreign identities.
- Local preview fixture expanded current JP `theme-squares` markup and `0` component CSS modules where used; `preview-fixture.json` binds its source hashes.
- When present, named Wikidot page attachments and their hashes are in `page-assets.json` and `page-assets/`; publish the named files with the candidate source.
