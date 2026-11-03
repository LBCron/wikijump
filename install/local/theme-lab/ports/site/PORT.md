Current source SHA-256: 6538b37accac65ba5c9ae78c88244b48ca447963251ac7e99b58e3d27334b1fc; CSS SHA-256: fa49d12c7af28d6001cccb36f6763b5539b2909a322aaf47e140a3aaf9a2ceae. Full port acceptance remains a separate combined result.

## Current acceptance selector scope

The package uses `acceptance-selectors.txt` to apply the maintained SCP-JP
runtime selector contract during its full check. The frozen EN showcase
contains the Wikidot-specific `.ios-cache-issue-notification` notice and its
dismissal markup; that source-page UI is absent from the localized JP target
fixture. It is retained in the frozen source/CSS evidence but is not a JP
target acceptance requirement. Source-theme identity is reviewed separately
against the exact paired screenshots and the current interactive browser
matrix.

# SCP-EN → SCP-JP port: `theme:site`

State: **verified local candidate; not published**. Current upstream source is frozen in `upstream-en.wikidot.txt`; the SHA-256 and update date are in `manifest.json`.

## Starting point

- Existing SCP-JP counterpart: confirmed absent by targeted XML-RPC refresh.
- Initial candidate source: `upstream-en.wikidot.txt`. Candidate CSS extracts its inline CSS modules; external and included dependencies remain in `manifest.json`.
- Dependency family: `sigma`.

## Technical decisions


## Bound final evidence

- EN source identity: `17f5d83fc92f3f171fcdb790f78fe207db86203eeca1e34f508631fb36daca34`; updated `2026-05-22T09:04:20+00:00`.
- JP baseline: No public JP counterpart existed after the targeted XML-RPC absence check.
- Final candidate source/CSS SHA-256: `f452b2e23d6b9701d1ce194416af7747382ddd75166a9c743545533342a03a92` / `1c69e2059807bc7cf8db8fdbe52b23d58ea3bd490b4a404dcb88636b625cc3c3`.
- Offline Theme Lab verdict: `warn`, zero errors/actions, torture `pass`, candidate missing assets `0`, external requests `0`.
- Candidate page images: `0` rendered, `0` broken; `0` of `0` declared page attachments replayed from verified local bytes.
- Geometry: desktop, laptop, tablet, and mobile all report zero document overflow.
- Japanese font specimen: requested `InterVariable, RedactRect, Inter, BlinkMacSystemFont, "Segoe UI", Roboto, Oxygen, Ubuntu, Cantarell, "Fira Sans", "Droid Sans", "Helvetica Neue", sans-serif`; actual platform font(s): IPAPGothic (29 Japanese glyphs).
- Documented non-defect Theme Lab warnings (selector counts and/or localized-showcase visual diagnostics):
- `.collapsible-block`: 2 EN showcase occurrences vs 1 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- visual-rmse-localized-showcase-difference at desktop: RMSE 0.386407; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at laptop: RMSE 0.408421; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at tablet: RMSE 0.393949; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at mobile: RMSE 0.413277; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- Runtime fixture rendered Rate, tabs, collapsible, table, blockquote, image block, footnote, code, and the Japanese glyph sample. Tabs, collapsible, pointer/focus, and any fixed/sticky scroll behavior report `pass`.
- `0` unconfirmed SCP-EN site-local author identity links were localized to visible credit text; upstream EN and the original human-port source retain their link markup. The local SCP-JP account namespace is not assumed to contain foreign identities.
- Local preview fixture expanded current JP `theme-squares` markup and `0` component CSS modules where used; `preview-fixture.json` binds its source hashes.
- When present, named Wikidot page attachments and their hashes are in `page-assets.json` and `page-assets/`; publish the named files with the candidate source.
