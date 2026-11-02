---
name: verify-article-cache-fence
description: Model-check the public-content fence that keeps Wikijump's anonymous article caches (Deepwell ArticlePageCache in Redis, Framerail article response cache) from serving content older than a change the fence already announced. Use when a change touches ViewService::article or preload, ArticlePageCache, PublicContentCache, defer_public_content_cache_invalidate_site or post-commit actions, the RPC transaction wrapper or its isolation, or Framerail's article-response cache keying.
---

# Verify the article cache fence

## The promise

Once a write that defers a public-content invalidation has committed and its fence bump has run, no anonymous article cache entry keyed by that fence (or a later one) holds data older than the write.

**Harm when broken:** anonymous readers get the old page, site settings, or license after the edit has finished. Deepwell's `ArticlePageCache` entries have no TTL, so a stale entry there lasts until the page's key changes. Framerail entries last up to `ARTICLE_RESPONSE_CACHE_TTL_SECONDS` (60 s).

## Run it

```bash
install/local/formal/article-cache-fence/check.sh
```

The check needs Java 11+ and Python 3, and runs in about a second. It downloads `tla2tools.jar` v1.7.4 to `~/.cache/tlaplus/1.7.4/` (pinned by sha256), or uses `$TLA2TOOLS_JAR` if set. To keep the generated model and TLC logs, set `ARTICLE_CACHE_FENCE_WORK=<dir>`.

Exit codes:

- **0**: both properties hold.
- **1**: TLC found a violation, and the shortest counterexample is printed.
- **2**: either the source drifted from the anchors the model is built from (`MODEL DRIFT: ...`) or the toolchain is missing.

Read every result with the pstack `/statechart` skill. For a violation, it turns the trace into the shortest path in plain words. For a pass, it draws how the system moves between states.

## Expected result at the sync commit

```
PASS  DeepwellCacheFresh (6671 distinct states found)
PASS  FramerailCacheFresh (6671 distinct states found)
```

**History:** the first run found that `FramerailCacheFresh` failed. `ViewService::article` read the viewer (`Self::preload` and `Self::apply_article_category_license`, which cover the site row, site settings and category license) before it read the fence. Framerail then stored the rendered HTML, viewer data included, under that fence.

The counterexample:

1. A view reads the site.
2. A site or category update commits and its post-commit action bumps the fence.
3. The view reads the new fence.
4. Framerail caches the old site data under the new fence, where anonymous readers get it for up to 60 s.

The fix reads the fence first in `article` and passes it to `ArticlePageCache::metadata`. If a change brings this failure back, the code broke the promise again. Fix the code, not the model.

## What the model is

- **Model:** `install/local/formal/article-cache-fence/ArticleCacheFence.tla`
- **Extractor:** `install/local/formal/article-cache-fence/extract.py` derives the model's constants from the source on every run, so a reorder in the code changes what TLC checks.
- **Runner:** `install/local/formal/article-cache-fence/check.sh`

| Model element | Code |
| --- | --- |
| Writer `Commit` then `Incr` | Any transaction that calls `ctx.defer_public_content_cache_invalidate_site` (`deepwell/src/services/context.rs`). The `register!` macro in `deepwell/src/api.rs` runs `txn.commit()`, then `run_post_commit_actions_for_state`, then `PublicContentCache::invalidate_site_for_state` (INCR + PUBLISH in one Lua script). |
| `IncrAfterCommit` | Commit on the success path before `run_post_commit_actions_for_state`, none after it, and the defer function only queues `PostCommitAction::PublicContentSite`. |
| `ReaderOrder` | Line order in `ViewService::article` (`deepwell/src/services/view/service.rs`) of `Self::preload` / `Self::apply_article_category_license` ("viewer"), the fence read ("fence"), and `Self::page` ("page"). The fence read is the `PublicContentCache::cache_fence` call in `article` when `article` passes `Some(public_content_cache_fence)` to `ArticlePageCache::metadata`. When it passes `None`, the fence read is the `ArticlePageCache::metadata` call, which reads the fence itself. |
| `ReadPageFromCache` | An `ArticlePageCache::get` hit under the same fence. |
| `PerStatementSnapshot` | `rpc_transaction_isolation` in `api.rs` gives `article_view` no override, so Postgres runs it at its default READ COMMITTED. |
| `Store` | `ArticlePageCache::set` (page data only) and Framerail's response write (viewer data plus page data, keyed by `articleResponse.public_content_cache_fence`). |
| `DeepwellCacheFresh` / `FramerailCacheFresh` | The promise above, checked separately for each cache. |

## Bounds and assumptions (what a pass does not cover)

- **Bounds:** two writers and two concurrent readers, all interleavings, each writer and reader runs once.
- **Data:** a single version counter. Only changes that leave the Deepwell cache key unchanged are modeled (site and category settings, license, votes, tags, files, attribution). Page edits that change the key's revision or compiled hashes are safe by key, not by fence, and are not modeled.
- **Framerail's local fence mirror (out of scope):** this covers `fence-state.js` (pub/sub messages, `seedRevision` guard, poison on disconnect) and the hot cache. The model checks entries against the Redis fence. The delay before a pub/sub message arrives is by design and is not modeled.
- **Token write (out of scope):** the token write's fence recheck in `writeAnonymousArticleResponseToken` is not modeled. The response store write does not depend on it.
- **Isolation assumption:** the database default isolation is READ COMMITTED. The repo does not set `default_transaction_isolation`.
- **Dependent rerenders (out of scope):** this includes whether `OutdateService` queues rerenders for dependent pages.

## Did my change touch the verified code?

It did if the diff touches any of these:

- `deepwell/src/services/view/service.rs`: `article`, `preload`, `get_viewer`, `apply_article_category_license`, `page`
- `deepwell/src/services/view/article_cache.rs`: `metadata`, `get`, `set`
- `deepwell/src/services/public_cache.rs`
- `deepwell/src/services/context.rs`: `defer_public_content_cache_invalidate_site`, `run_post_commit_actions_with_rerender_trust`
- `deepwell/src/api.rs`: the `register!` macro and `rpc_transaction_isolation`
- `framerail/src/lib/server/load/page/page.ts`, `framerail/src/hooks.server.ts`, `framerail/src/lib/server/cache/article-response/`, `framerail/article-response-fast-path.js`

To list the covered files changed since the last sync:

```bash
git diff --stat "$(git log -1 --format=%h -- .claude/skills/verify-article-cache-fence/SKILL.md)" -- deepwell/src/services/view/service.rs deepwell/src/services/view/article_cache.rs deepwell/src/services/public_cache.rs deepwell/src/services/context.rs deepwell/src/api.rs framerail/src/lib/server/load/page/page.ts framerail/src/hooks.server.ts framerail/src/lib/server/cache/article-response framerail/article-response-fast-path.js
```

If this lists anything, run the check.

## Reading a result

- **A new FAIL, or the Deepwell property failing:** compare the `model` line with the code. If `ReaderOrder`, `IncrAfterCommit`, or `PerStatementSnapshot` changed because of your edit, the code broke the promise. That is a real bug: fix the code, not the model.
- **MODEL DRIFT:** an anchor moved, was renamed, or was duplicated. Open the named file and line. If the behavior is unchanged and only the text moved, update the anchor in `extract.py`. If the behavior changed (for example a new data read in `article`, or a new cache write), extend the model before trusting any result.
- **A FAIL that does not match the code:** if a TLC step is impossible in the real code, the model is wrong. Fix `ArticleCacheFence.tla`, and say so in the change.

## Updating the verification on an intended change

1. Change the model or extractor so it matches the new code. Keep the properties as they are.
2. Prove that it can still fail. Temporarily break the real code with each of the following and check that the runner fails:
   - In `api.rs`, move `txn.commit()` after `run_post_commit_actions_for_state`. Both properties should fail.
   - In `ViewService::article`, move the `let public_content_cache_fence = PublicContentCache::cache_fence(...)` statement to just below `Self::preload(...)`. `FramerailCacheFresh` should fail.
3. Revert the scratch edits (`git checkout -- <file>`) and confirm the expected result above.
4. Move the sync commit below forward, but only after you have confirmed that the model describes the code at the new commit.

## Coverage record

- **Sync commit:** the last commit that changed this file, given by `git log -1 --format=%h -- .claude/skills/verify-article-cache-fence/SKILL.md`. The model was last confirmed against the code at that commit. Move it forward by committing an edit to this record, but only after confirming the model. The model was first built at `b030c2c14e`.
- **Scratch break seen to fail with the fence-first fix:** moving the `PublicContentCache::cache_fence` statement below `Self::preload` failed `FramerailCacheFresh`.
- **Scratch breaks seen to fail at `b030c2c14e`, before the fix:**
  - The commit-after-actions reorder in `api.rs` failed both properties.
  - The fence read moved after `Self::page` failed both properties.
  - A renamed anchor reported `MODEL DRIFT`.
  - Moving `ArticlePageCache::metadata` above `Self::preload` passed both properties, which shows the finding depends on read order.
