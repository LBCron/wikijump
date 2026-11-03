Current source SHA-256: ed339b72f5d04e7e11f6d419596b7449ca397f549ef1e73f1d1e349c0c0e1bf8; CSS SHA-256: 78954600d05073df1461599a2b73cc656d379f0289d798d6e2ad65c76df1ccca. Full port acceptance remains a separate combined result.

# SCP-EN → SCP-JP port: `theme:black-highlighter-theme`

State: **verified local candidate; not published**. Current upstream source is frozen in `upstream-en.wikidot.txt`; the SHA-256 and update date are in `manifest.json`.

## Starting point

- Existing SCP-JP counterpart: present; frozen in `existing-jp.wikidot.txt`.
- Initial candidate source: `existing-jp.wikidot.txt`. Candidate CSS extracts its inline CSS modules; external and included dependencies remain in `manifest.json`.
- Dependency family: `black-highlighter`.

## Technical decisions


## Bound final evidence

- EN source identity: `fa840cb320ea4de09864cd687aca308115f9027076d8c5712c3fb52cd5c31a58`; updated `2024-09-03T02:55:28+00:00`.
- JP baseline: Previous public JP source SHA-256 809901626419de877645afccb36574a01ef943cfbd5d70a4b167210ebe4db939 (updated 2025-11-16T06:26:19+00:00); EN was refreshed to 2024-09-03T02:55:28+00:00.
- Final candidate source/CSS SHA-256: `4d58de367c9e56fdf2b3a29bad656ee6894b9e1796ac56e3a8ff78813d84689a` / `7c4112b27d9d0a5b1a7d9a3cd6fdbb9db61a010cf9333be7cc1c6fba00f72720`.
- Offline Theme Lab verdict: `warn`, zero errors/actions, torture `pass`, candidate missing assets `0`, external requests `0`.
- Candidate page images: `1` rendered, `0` broken; `1` of `1` declared page attachments replayed from verified local bytes.
- Geometry: desktop, laptop, tablet, and mobile all report zero document overflow.
- Japanese font specimen: requested `Inter, "BIZ UDPGothic", "M Plus 1p", sans-serif`; actual platform font(s): IPAPGothic (29 Japanese glyphs).
- Documented non-defect Theme Lab warnings (selector counts and/or localized-showcase visual diagnostics):
- `table`: 1 EN showcase occurrences vs 3 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- `.yui-navset`: 1 EN showcase occurrences vs 2 JP occurrences; EN reference and JP candidate are different localized theme-showcase documents; the JP runtime fixture adds canonical article modules. A repeated selector count difference alone is not a missing theme rule.
- visual-rmse-localized-showcase-difference at desktop: RMSE 0.332327; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at laptop: RMSE 0.357417; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at tablet: RMSE 0.389321; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- visual-rmse-localized-showcase-difference at mobile: RMSE 0.347977; This full-page RMSE compares different localized theme-showcase text/images and EN versus JP-native header/sidebar/account/rating runtime surfaces, so it is retained as a non-gating diagnostic and not mislabeled as a visual pass. The paired viewport screenshots were reviewed for theme identity, logo/palette, major composition, and responsive structure.
- Runtime fixture rendered Rate, tabs, collapsible, table, blockquote, image block, footnote, code, and the Japanese glyph sample. Tabs, collapsible, pointer/focus, and any fixed/sticky scroll behavior report `pass`.
- `4` unconfirmed SCP-EN site-local author identity links were localized to visible credit text; upstream EN and the original human-port source retain their link markup. The local SCP-JP account namespace is not assumed to contain foreign identities.
- Local preview fixture expanded current JP `theme-squares` markup and `2` component CSS modules where used; `preview-fixture.json` binds its source hashes.
- When present, named Wikidot page attachments and their hashes are in `page-assets.json` and `page-assets/`; publish the named files with the candidate source.

## Option-scenario recapture (Theme Lab #2506)

The twelve BHL option records are `option-scenarios/runs/{combined,collapsible}-{sigma9,sigma10}-{chromium,firefox,webkit}.json`, with screenshots under `option-scenarios/captures/<baseline>/<engine>/`. The procedure below is the only supported way to produce them. Nothing in it writes evidence by hand.

1. **Fixture provisioning.** `ports/interactive-visual-fixture/provision-fixture.mjs` creates or refreshes the BHL fixture `run-owned:theme-lab-visual-acceptance-imported-20260924` from `interactive-visual-fixture/fixture.wikidot.txt`. It also writes the other run-owned pages. Task mode is already built in: set `THEME_LAB_BACKEND_PROJECT=wikijump-theme-lab-<namespace>` and `DEEPWELL_RPC_URL=http://wikijump-theme-lab-<namespace>-deepwell-1:2747/jsonrpc`. `src/fixture-rpc-target.mjs` refuses any other endpoint. Run it inside a disposable Node container attached only to the task project network, with the checkout mounted read-only. Put `DEEPWELL_RPC_TOKEN` and the verification admin credentials in a private env file. Do not run it on the host against `:2747`. Its site-ID guard (`6000003`) applies as usual.
2. **Runtime.** Start the task backend and its built Framerail sidecar, following the task-mode section of `install/local/theme-lab/README.md`. The sidecar must serve `x-theme-lab-runtime-source-sha` equal to the checkout Framerail fingerprint, and Deepwell identity headers equal to the running container.
3. **Capture.** For each of the 12 combinations, run:

   ```sh
   node install/local/theme-lab/ports/black-highlighter-theme/option-scenarios/capture.mjs \
     --scenario combined|collapsible --baseline sigma9|sigma10 --engine chromium|firefox|webkit \
     --transport-origin https://scpaiueouiuiuiui.wikijump.localhost:<task-port> \
     --backend-project wikijump-theme-lab-<namespace> \
     [--run-contract <absolute path>] [--fixture-slug <run-owned:slug>] [--runtime-sigma-href <href>] [--intent-review-date YYYY-MM-DD]
   ```

   Every option is optional except `--scenario`, `--baseline` and `--engine` (default `chromium`). The defaults are: transport origin from the run contract's `transport_origin`, else the authority's `framerail.runtime_origin`; backend project shared (`wikijump-local-development`); fixture slug the imported BHL fixture; intent review date from the authority. `--intent-review-date` must match the authority. The runtime Sigma stylesheet is discovered from the served page and must be unique. Each record records `candidate_set_sha256` computed from `publication/frozen-candidate-set.json`, the baseline CSS SHA-256, the transport origin and fixture, the served and checkout Framerail fingerprints, and the running Deepwell identity. The capture refuses when served headers disagree with the checkout or the running container. It also refuses a run contract that pins a different Framerail fingerprint or backend identity.
4. **Visual review.** A reviewer inspects every screenshot and writes an explicit decisions file: `{"schema":"theme_lab_bhl_option_visual_decisions.v1","reviewer":"...","review_method":"direct visual inspection ...","reviewed_at":"...","decisions":[{"sha256":"<screenshot sha256>","classification":"PASS_NATURAL|PASS_INTENTIONAL_DIVERGENCE|NEEDS_FIX","note":"..."}]}`. Then run `node install/local/theme-lab/ports/black-highlighter-theme/option-scenarios/record-visual-review.mjs --decisions <absolute path> [--replace]`. It writes `runs/visual-review.json` only when every screenshot has exactly one decision, no decision names an unknown sha, no `NEEDS_FIX` remains, every record and screenshot hash still matches, and the candidate set, authority and runtime identities agree. Otherwise it exits non-zero and writes nothing.

Current state (campaign 20261023): the authority pins Framerail `b0036e2c...` and Deepwell backend identity `df081d0b...`, measured on task runtime `wikijump-theme-lab-campaign-20261023`. The 12 records and 82 screenshots were recaptured there and directly reviewed (82 PASS_NATURAL); `publication/frozen-candidate-set.json` binds them by SHA-256. The `runs/` and `captures/` files are not in the repository; they are restored from the content-addressed evidence store.
