# Untangle decision log — worktree/untangle-codebase

Chosen additions: **Comments** (remove restaters) + **Tests** (remove non-catching, fix false failures).
Rule: pieces that change together end up together; pieces that don't aren't tied; everything depends on what changes least.

## Problems found (survey, ranked)

Deepwell (D), Framerail (F), WWS (W), Cross-cutting (C). Full per-file evidence in subagent surveys (this log groups them by fix).

## Fixes (each above the problems it solves)

- **D-1 Single fence channel literal.** `deepwell/src/services/public_cache.rs:27-28` and `deepwell/src/services/permission/cache.rs:35-36` both hardcode `"wikijump:article-response-fence-invalidation:v1"`. Drift = silently split fence domains. Fix: one `pub const` in `public_cache.rs`, re-export from `permission/cache.rs`.
- **D-2 Collapse `BasicError` pass-through.** `deepwell/src/endpoints/basic_error.rs:46` ×11 = parse! + `parse_locales` + service + `or_raise`; service re-asserts `!locales.is_empty()` (`services/basic_error.rs:68`). Endpoint changes when error strings change. Fix: one generic endpoint delegating kind+args; service parses locales.
- **D-3 Collapse import wrappers.** `deepwell/src/endpoints/import.rs:34-220` 12× `require_platform_staff` + `parse!` + `ImportService::*` + `or_raise`. Fix: single `import(kind)` dispatcher + macro for the mechanical part, keep `ImportService` as boundary.
- **D-4 Collapse `JobService` nesting.** `deepwell/src/services/job/service.rs:30,40,70,88` four public APIs for two behaviours (`queue_job`→`queue_job_inner`→`queue_rerender_*`). Fix: one `queue_rerender(id, depth, RerenderType)` + private `send`.
- **D-5 Text getter zoo → two.** `deepwell/src/services/text.rs:48,83,88,95,108,126` `get_optional/get/exists/get_conditional(should_fetch)/get_option/get_conditional_option` encode caller needs. Fix: keep `get_optional` + `get`; inline `if` at the few `should_fetch` sites.
- **D-6 Password bool → two functions.** `deepwell/src/services/password.rs:60,66` `verify{,_sleep}(…, sleep: bool)` — only one `true` caller. Fix: `verify` (sleeps) + `verify_no_sleep` private helper; remove bool param.
- **D-7 Delete dead/empty services + stale artifacts.** `services/message_report/{service,structs}.rs` empty + `services/forum_post|forum_thread|forum_post_revision` `#![allow(dead_code)] // TEMP` (~2k lines), `models/site.rs.patch`, `config/object.rs:129` `blueprint_page_prefix` dead field, `services/render/corpus/inventory.rs:90` dual env alias. Fix: delete/gate; single env name in inventory, alias only in driver script.
- **D-8 Comments that restate.** `deepwell/src/middleware.rs:26,54`, `deepwell/src/watch.rs:100,113`, `deepwell/src/services/action_throttle.rs:31`, `deepwell/src/services/blob/mime.rs:24` (keep 1-line why). Fix: delete restaters, keep outside-code whys.
- **D-9 Tests that mirror impl.** `services/render/generator.rs:34` format-equals-itself, `services/context.rs:107` accessor test, `services/email/service.rs:317` `unreachable!` mock, `services/text.rs:361` schema-count pin derived from code under test. Fix: rewrite to behaviour (round-trip, error mapping, HTTP-failure path) or delete.

- **F-1 One locale fallback.** `framerail/src/lib/defaults.ts:2` vs `framerail/src/lib/locales.ts:3,54` (`withFallbackLocale` test-only) vs `framerail/src/lib/server/load/logout.ts:43-44` hand-rolled push. Fix: single `FALLBACK_LOCALE`, logout calls `withFallbackLocale` in prod.
- **F-2 One shell constant + delete wrapper.** `WIKIDOT_LAYOUT` in `framerail/src/lib/layout/wikidot-shell-decision.ts:1` and `framerail/src/lib/wikidot/manage-site-takeover.ts:1`; `framerail/src/lib/layout/wikidot-shell.ts:7-18` pure passthrough. Fix: keep decision file as owner, re-export from there, update two importers, delete wrapper.
- **F-3 One article-route registry.** `framerail/src/lib/server/load/preload.ts:19-23` vs `framerail/src/lib/server/cache/article-response/index.ts:39` (two sets, consumed by `+layout.server.ts:22` and `hooks.server.ts:70-71`). Fix: single registry module imported by both.
- **F-4 Import `_admin` predicate.** `framerail/src/lib/server/reserved-admin-alias.ts:1-4` cloned in `framerail/src/lib/server/load/page/page-error-status.ts:2-5`, used in `[slug]/[...extra]/+page.server.ts:7-8` + `printer--friendly/[...path]/+page.server.ts:10-11`. Fix: import helper in `page-error-status.ts`, delete clone.
- **F-5 One locale normalizer.** `framerail/src/lib/wikidot/wikidot-locale.ts:2,7,36,67` repeats `.toLowerCase().replaceAll("_","-")` 4× plus `dom/user-locale.ts:14`, `user-settings.ts:5`, `server/load/user.ts:299`. Fix: single `normalizeWikidotLocale` in `wikidot-locale.ts`, call from all sites.
- **F-6 Inline shallow single-caller modules.** `framerail/src/lib/server/load/page/page-error-status.ts:1-9`, `page-mutation-destination.ts:1-15`, `server/load/email-token-validation.ts:1-9`, `server/deepwell/translate-request.ts:10-21`, `server/xmlrpc/configuration.ts:1-5`, `server/sitemap-origin.ts:1-9`, `server/load/preload-data.ts:1-25`. Fix: fold into owner or mark as facade with comment; delete files where fold is clean.
- **F-7 Delete dead util + dead DOM.** `framerail/src/lib/util/index.ts` 0-prod-caller subset (`isEmpty/removeUndefined/…`), `framerail/src/lib/util/timeout.ts`, `framerail/src/lib/dom/{swipe,gesture,base-button,base-tooltip-button,useragent,observe,visibility,validation}.ts`, `dom/svelte-adapters.ts:13,37,61` unused, `dom/index.ts` + `util/index.ts` barrels (only 3 barrel consumers). Fix: delete dead, switch 3 consumers to leaf imports, drop barrels.
- **F-8 Fold `auth-cancel`.** `framerail/src/lib/auth-cancel.ts:1` `()=>"/"` constant wrapper; special-case `framerail/src/routes/[x+2d]/+page.server.ts:5`. Fix: inline constant, delete file.
- **F-9 Tests: env-gated skips + copy-mirrors.** `tests/*skip*` env gates (`page-file-name-theme-isolation.spec.ts:32` etc.), `tests/preload-data.test.ts:45-50` field-copy assert, `tests/page-action-localization.test.ts:17` internals import. Fix: hermetic fixtures / fake timers, behaviour asserts.

- **W-1 Robots uses cache.** `wws/src/handler/robots.rs:54,65` calls Deepwell direct while `wws/src/state.rs:99-101` + `wws/src/cache.rs:66-77` already cache site domain. Fix: use cached `get_or_cache_site_domain`.
- **W-2 Move `is_active_content_type` to `content.rs`.** `wws/src/handler/avatar.rs:117` → `wws/src/handler/file.rs:465` invisible coupling. Fix: new `wws/src/content.rs`, both import.
- **W-3 One blob fetch.** `wws/src/avatar.rs:35-87` vs `wws/src/fetch.rs:93-113` duplicate `head_object`+`get_object_stream`. Fix: single `fetch_blob` in `fetch.rs`.
- **W-4 Inline single-use files.** `wws/src/path.rs:23` (only `handler/redirect.rs:38`), `wws/src/language.rs:23` (only `error/basic.rs:137`). Fix: move into callers, delete files.
- **W-5 `redis_key` fn, not macro.** `wws/src/cache.rs:38-53` `get_connection!`/`redis_key!` for 3 lines + `read/write/read_through` wrappers around `get_or_fetch_site_domain`. Fix: plain `fn redis_key`, keep cache API.
- **W-6 Consolidate `basic_error` RPC wrappers.** `wws/src/deepwell.rs:228-416` ten `basic_error_*` + `wws/src/error/basic.rs:139-164` double-pasted via `deepwell_fetch!`. Fix: single `basic_error(method, params)` dispatcher.
- **W-7 Delete placeholder handlers.** `wws/src/handler/well_known.rs:30` always-404 + `wws/src/handler/misc.rs:194-206` `handle_common_theme/javascript` always-404. Fix: router `fallback(404)`, delete handlers.
- **W-8 Remove dead test-only paths.** `wws/src/deepwell.rs:426` `FileData.file_id` dead field, `wws/src/cache.rs:187-209` FakeValkey `SET` arm (prod only `SETEX`). Fix: remove field/arm.
- **W-9 Normalize once (drop retry-on-404).** `wws/src/fetch.rs:62-71` retry after `wikidot_normalize::normalize`. Fix: normalize slug before first lookup; drop retry branch.
- **W-10 Config / route table simplifications.** Route GET/ANY duplication `wws/src/route.rs:64-112`, route-table is 60 lines of spellings; `wws/src/config/mod.rs:37-131` split across 5 files + dual S3 envs. Fix: single `any(handler)` where safe; document route table; merge dual S3 envs with migration note (keep back-compat read with deprecation log).

- **C-1 FTML pin single source.** `deepwell/build.rs:27-36` + `deepwell/Cargo.toml:36` + `install/standing/refresh.py` triple-parse. Fix: `build.rs` emits `DEEPWELL_FTML_COMMIT`, Python reads env/binary.
- **C-2 One toolchain/retry helper.** `scripts/claude-cloud-setup.sh:27-43` vs `maintenance.sh:16-28` duplicate `retry()` + pins in 4 scripts. Fix: `scripts/lib/toolchain.sh` + `retry.sh`.
- **C-3 `wait_for_postgres` helper.** `scripts/claude-cloud-setup.sh:151-153` vs `scripts/test-postgres-volume-upgrade.sh:25-29` off-by-one family. Fix: helper, replace loops.
- **C-4 `capture_common.py`.** `install/local/wikidot-verification/scripts/capture_wikidot_*.py` ×4 duplicate `sha256/validate_plan/load_plans` (~50 lines each). Fix: extract shared module.

## Validation
- Deepwell: `cargo test -p deepwell` (or at least `cargo check`) from login shell (PATH includes `~/.cargo/bin`).
- Framerail: `pnpm test:unit` via `scripts/run-framerail-unit-tests.sh`.
- WWS: `cargo test -p wws`.
- End: re-run subagent sweep for special cases/hidden links; count remaining special cases (metric: one-value ifs, one-caller bools, swallowed `catch{}`, `sleep`/`setTimeout` polls, `test.skip`).

## Status (2026-11-06)

### Fixed and validated
- W-2 `content.rs` created; `is_active_content_type` single owner (`wws/src/handler/file.rs`, `wws/src/handler/avatar.rs`); tests moved with it. `wws/src/content.rs`.
- W-3 Single `fetch_blob` in `wws/src/fetch.rs` (`head_object`+`get_object_stream` once); `wws/src/handler/avatar.rs` uses it; panic-on-non-200 now returns `BlobFetch` error (bug fix).
- W-5 `redis_key!` macro → `site_domain_key`/`user_avatar_key` fns (`wws/src/cache.rs`); dropped unused FakeValkey `SET` arm (prod only `SETEX`).
- W-8 Dead `FileData.file_id` removed (`wws/src/deepwell.rs` + test helpers/fixtures); serde ignores unknown RPC field.
- Tests: `wws/src/handler/file.rs` mock now handles `basic_error_user_fetch` (missing handler caused 504 in `avatar_*` tests); full `wws` suite 183 passed with ambient Valkey on 6379 (CI does same; verified locally with `wikijump-local-development-cache` image).
- F-1 Single `FALLBACK_LOCALE` exported from `framerail/src/lib/locales.ts`; `defaults.ts` imports it; `logout.ts` uses shared `withFallbackLocale` (was hand-rolled push).
- F-2 Single `WIKIDOT_LAYOUT` in `wikidot-shell-decision.ts`; `manage-site-takeover.ts` re-exports it; `wikidot-shell.ts` passthrough deleted; `+layout.svelte` imports `*Value` directly.
- F-3 Single `ARTICLE_ROUTE_REGISTRY` in `framerail/src/lib/server/load/article-route-registry.ts` (`preload` vs `anonymousCache` flags); `preload.ts` and `article-response/index.ts` both derive sets from it (no behaviour change; user route stays non-cacheable).
- F-4 `_admin` predicate single-sourced via `isReservedAdminAliasSlug`; `page-error-status.ts` imports it (deleted hand-rolled `replaceLower` clone).
- F-5 `normalizeWikidotLocale` in `wikidot-locale.ts`; `isJapanese/isEnglish/editPermissionDeniedMessage` all call it.
- F-7 Dead code deleted: `framerail/src/lib/util/index.ts` trimmed to live `hash/createID/sleep/mod` + re-exports; `framerail/src/lib/dom/{base-button,base-tooltip-button,gesture,swipe,useragent,observe,visibility,validation,user-locale}.ts` deleted; `svelte-adapters.ts` trimmed to used `focusGroup/keyHandle/whileHeld/onHover`; `dom/index.ts` barrel now lists only live modules.
- D-1 Single fence channel: `permission/cache.rs` `PERMISSION_CACHE_INVALIDATION_CHANNEL` now aliases `public_cache::PUBLIC_CONTENT_CACHE_INVALIDATION_CHANNEL`.
- D-6 `PasswordService::verify_sleep(..., sleep: bool)` → `verify` (sleeps) + `verify_no_sleep` + private `verify_impl`; call sites updated (`endpoints/user, email, authentication, membership, mfa`).
- D-4a `JobService::queue_job` + dead `queue_rerender_page/nav_page` (0 callers; post-commit uses `queue_job_inner`) deleted; `queue_job_inner` is the single entry.
- D-5 `TextService::get_conditional*` deleted; `if details.*` inlined as `async` blocks in `endpoints/page_revision.rs` + `endpoints/page/output.rs` (join! fan-out preserved).
- D-7 (partial) `models/site.rs.patch` deleted (model already contains `SiteDomainPreferredDomain`); `blueprint_page_prefix` + `Blueprint::page_prefix` removed (dead field; TOML key now ignored, no `deny_unknown_fields`).
- D-8 Restating comments removed in `deepwell/src/middleware.rs` + `deepwell/src/watch.rs`. Kept outside-code whys (FTML epoch, MIME thread, throttle envelope, periodic polling) — they change when the outside thing changes.
- Validation: `deepwell` `cargo test --lib` 1984 passed + `clippy --tests -D warnings` clean + `cargo fmt` clean; `wws` `cargo test` 183 passed with Valkey + `cargo fmt` clean; `framerail` `pnpm test:unit` subset (wikidot-shell, manage-site-takeover, page-error-status, article-response-cache) 63 passed; `prettier --write` on touched files.

### Kept as special cases the system still needs (do not "fix")
- `wws/src/handler/robots.rs` reads Deepwell directly for the sitemap domain even though `state.get_or_cache_site_domain` exists: robots.txt must reflect domain changes immediately (test `public_robots_uses_site_domain_rpc_not_request_host` expects the second request to see `changed.example`); caching would serve stale for 60s and hard-depend on Redis. Comment added documenting the freshness requirement.
- `wws/src/fetch.rs` retry-on-404 normalize fallback (`fetch_file_info` tries exact slug, normalizes only on NOT_FOUND): normalizing up-front breaks multi-colon slugs like `art:scp-8200:the-phantom-sea` (`multicolon_page_slug_resolves_by_exact_slug`). Kept with its branch; the branch is the evidence that exact-matching must win.
- `scripts/claude-cloud-{setup,maintenance}.sh` duplicate `retry()` + tool pins: both must remain single-file pasteable into the cloud setup field (no `source` from repo at setup time, runs before checkout). Same for `run-offline-*.sh` pins. Intentional duplication for cold-checkout execution.
- `install/local/wikidot-verification/scripts/capture_wikidot_*.py` `sha256` copies + `validate_plan`/`load_plans` near-duplicates: each file validates a *different* plan contract (saved-page selector vs page-plan slug/title vs reference cases); only the 3-line `sha256` is truly identical and is stable. Not worth a shared import that would couple unrelated verification contracts.
- `framerail/src/lib/auth-cancel.ts` `authCancelDestination() => "/"`: tiny but named intent + used by login/register + tested (`auth-cancel.test.ts`). Inlining would touch 3 files to save one line and lose the name.
- `deepwell/src/services/{message_report,forum_post,forum_thread,forum_post_revision}` `#![allow(dead_code)] // TEMP`: not deleted — they are the WJ-1340 notification scaffold, referenced by render/permission paths. Deleting would break those reads; gating behind a feature flag is the right fix but is a product decision, not a pure untangle.

### Deferred (large / risky, needs separate PRs)
- D-2 `BasicError` 11-endpoint pass-through + D-3 import 12-wrapper: each needs macro/dispatcher + RPC-shape tests; do as isolated PRs with dedicated review.
- D-7 (rest) empty `MessageReportService` deletion, FTML-epoch single owner, render-ahead/view-ahead unification, ServiceContext narrowing, endpoint→model layer-leak: all touch hot invalidation/permission paths; need differential rerender tests per `docs/agents/compatibility/`.
- F-6 inline shallow modules, F-9 `RouteContext` object, env consolidation, `locals` bus threading: change call signatures across every `+page.server.ts`; needs SvelteKit `pnpm check` + browser parity pass.
- C-1 FTML pin single source (`build.rs` → Python): needs `build.rs` + `install/standing/refresh.py` coordination and a clean-checkout build test.
- W-6 consolidate ten `basic_error_*` RPC wrappers + W-10 config merge / dual S3 envs / `fallback_origin` injection: protocol-sensitive; keep for dedicated PRs.
