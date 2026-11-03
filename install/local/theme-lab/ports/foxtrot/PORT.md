Current source SHA-256: 94bec2085323e08e9fe302fa86df5a051c3d21f93dd57c9986a750cc591845f0; CSS SHA-256: 97f8003415d8cc463fc82677a4c2b35b1078985e945f73aca7fee09f70ba095b. Full port acceptance remains a separate combined result.

# SCP-EN → SCP-JP port: `theme:foxtrot`

State: **verified local candidate; not published**. Current upstream source is frozen in `upstream-en.wikidot.txt`; the SHA-256 and update date are in `manifest.json`.

## Starting point

- Existing SCP-JP counterpart: present; frozen in `existing-jp.wikidot.txt`.
- Initial candidate source: `existing-jp.wikidot.txt`. Candidate CSS extracts its inline CSS modules; external and included dependencies remain in `manifest.json`.
- Dependency family: `basalt`.

## Technical decisions


## Bound final evidence

- EN source identity: `04407aa0cfb8cf27b6066cd994b7b1ae7d2c867f187aacbd90639423f7c78b5d`; updated `2026-03-26T17:29:48+00:00`.
- JP baseline: Previous public JP source SHA-256 93f5876476041e7bc3f28e52fc7da233f1f78733f1ff687157086a64b05eb925 (updated 2024-08-16T17:44:19+00:00); EN was refreshed to 2026-03-26T17:29:48+00:00.
- Final candidate source/CSS SHA-256: `f14d6c66818c37030344c147fd839db970b5ecce26bdfbe66d130a86df1f71ab` / `48945c99fe06c76f94e978c56c96a77623f4b92c58c77c57806fa957af7a3d27`.
- Offline Theme Lab verdict: `warn`, zero errors/actions, torture `pass`, candidate missing assets `0`, external requests `0`.
- Candidate page images: `24` rendered, `0` broken; `24` of `24` declared page attachments replayed from verified local bytes.
- Geometry: desktop, laptop, tablet, and mobile all report zero document overflow.
- Japanese font specimen: requested `"IBM Plex Sans", "Noto Sans JP"`; actual platform font(s): IPAPGothic (29 Japanese glyphs).
- Documented non-defect Theme Lab warnings (selector counts and/or localized-showcase visual diagnostics):
- visual-rmse-localized-showcase-difference at desktop: RMSE 0.262322; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at laptop: RMSE 0.322663; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at tablet: RMSE 0.353996; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at mobile: RMSE 0.232857; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- Runtime fixture rendered Rate, tabs, collapsible, table, blockquote, image block, footnote, code, and the Japanese glyph sample. Tabs, collapsible, pointer/focus, and any fixed/sticky scroll behavior report `pass`.
- `1` unconfirmed SCP-EN site-local author identity links were localized to visible credit text; upstream EN and the original human-port source retain their link markup. The local SCP-JP account namespace is not assumed to contain foreign identities.
- Local preview fixture expanded current JP `theme-squares` markup and `0` component CSS modules where used; `preview-fixture.json` binds its source hashes.
- When present, named Wikidot page attachments and their hashes are in `page-assets.json` and `page-assets/`; publish the named files with the candidate source.
