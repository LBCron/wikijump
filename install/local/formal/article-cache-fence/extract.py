#!/usr/bin/env python3
"""Derive ArticleCacheFence model constants from the source tree.

Each constant comes from an anchor in the code the model describes. A
missing or duplicated anchor means the code moved away from the model, so
the script exits 2 and the model needs review before it can be trusted.
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
VIEW_SERVICE = "deepwell/src/services/view/service.rs"
ARTICLE_CACHE = "deepwell/src/services/view/article_cache.rs"
CONTEXT = "deepwell/src/services/context.rs"
API = "deepwell/src/api.rs"
PAGE_LOAD = "framerail/src/lib/server/load/page/page.ts"
HOOKS = "framerail/src/hooks.server.ts"


class ModelDrift(Exception):
    pass


def lines(path: str) -> list[str]:
    return (ROOT / path).read_text(encoding="utf-8").splitlines()


def fn_body(path: str, signature: str) -> tuple[int, list[str]]:
    """Returns the 1-based start line and lines of the fn whose line contains
    `signature`, ending at the next fn at the same or lower indent."""
    src = lines(path)
    starts = [i for i, line in enumerate(src) if signature in line]
    if len(starts) != 1:
        raise ModelDrift(f"{path}: expected one '{signature}', found {len(starts)}")
    start = starts[0]
    indent = len(src[start]) - len(src[start].lstrip())
    fn_re = re.compile(r"^\s*(pub(\([a-z]+\))? )?(async )?fn ")
    end = len(src)
    for i in range(start + 1, len(src)):
        line = src[i]
        if fn_re.match(line) and len(line) - len(line.lstrip()) <= indent:
            end = i
            break
    return start + 1, src[start:end]


def find_one(path: str, start: int, body: list[str], needle: str) -> int:
    hits = [start + i for i, line in enumerate(body) if needle in line]
    if len(hits) != 1:
        raise ModelDrift(f"{path}: expected one '{needle}' in fn at line {start}, found {len(hits)}")
    return hits[0]


def reader_order(facts: list[str]) -> list[str]:
    start, body = fn_body(VIEW_SERVICE, "pub async fn article(")
    preload = find_one(VIEW_SERVICE, start, body, "Self::preload(")
    license_ = find_one(VIEW_SERVICE, start, body, "Self::apply_article_category_license(")
    metadata = find_one(VIEW_SERVICE, start, body, "ArticlePageCache::metadata(")
    page = find_one(VIEW_SERVICE, start, body, "Self::page(ctx, input")
    store = find_one(VIEW_SERVICE, start, body, "ArticlePageCache::set(")
    if store < max(metadata, page):
        raise ModelDrift(f"{VIEW_SERVICE}:{store}: ArticlePageCache::set runs before its inputs are read")

    # metadata uses a fence the caller passes in, or reads its own (None).
    m_start, m_body = fn_body(ARTICLE_CACHE, "pub(super) async fn metadata(")
    find_one(ARTICLE_CACHE, m_start, m_body, "PublicContentCache::cache_fence(")
    find_one(ARTICLE_CACHE, m_start, m_body, "Some(fence) => fence,")

    src = lines(VIEW_SERVICE)
    call = " ".join(line.strip() for line in src[metadata - 1 : metadata + 2])
    passed = re.search(r"ArticlePageCache::metadata\(ctx, &input, Some\(public_content_cache_fence\)\)", call)
    if passed:
        fence = find_one(VIEW_SERVICE, start, body, "PublicContentCache::cache_fence(")
        fence_note = "PublicContentCache::cache_fence, passed to ArticlePageCache::metadata"
    elif re.search(r"ArticlePageCache::metadata\(ctx, &input, None\)", call):
        fence = metadata
        fence_note = "ArticlePageCache::metadata"
    else:
        raise ModelDrift(f"{VIEW_SERVICE}:{metadata}: unrecognized fence argument to ArticlePageCache::metadata")

    viewer = min(preload, license_)
    facts.append(f"viewer read   {VIEW_SERVICE}:{preload} (preload), :{license_} (category license)")
    facts.append(f"fence read    {VIEW_SERVICE}:{fence} ({fence_note})")
    facts.append(f"page read     {VIEW_SERVICE}:{page} (Self::page)")
    return [name for _, name in sorted([(viewer, "viewer"), (fence, "fence"), (page, "page")])]


def incr_after_commit(facts: list[str]) -> bool:
    start, body = fn_body(CONTEXT, "pub fn defer_public_content_cache_invalidate_site(")
    if not any("PostCommitAction::PublicContentSite" in line for line in body):
        raise ModelDrift(f"{CONTEXT}:{start}: defer_public_content_cache_invalidate_site no longer queues a post-commit action")
    immediate = any("invalidate_site" in line and "defer_" not in line for line in body)

    r_start, r_body = fn_body(CONTEXT, "async fn run_post_commit_actions_with_rerender_trust(")
    find_one(CONTEXT, r_start, r_body, "PublicContentCache::invalidate_site_for_state(")

    # The success path of the register! macro: after the endpoint_result
    # match (whose error arm may commit an authentication rejection) and up
    # to Ok(output).
    src = lines(API)

    def only(needle: str, after: int = 0) -> int:
        hits = [i for i, line in enumerate(src) if needle in line and i >= after]
        if not hits or (after == 0 and len(hits) != 1):
            raise ModelDrift(f"{API}: expected one '{needle}', found {len(hits)}")
        return hits[0]

    match = only("let (output, post_commit_actions) = match endpoint_result")
    indent = len(src[match]) - len(src[match].lstrip())
    match_end = next(
        (i for i in range(match + 1, len(src)) if src[i] == " " * indent + "};"), None
    )
    if match_end is None:
        raise ModelDrift(f"{API}:{match + 1}: cannot find the end of the endpoint_result match")
    run = only("ServiceContext::run_post_commit_actions_for_state(")
    done = only("Ok(output)", after=run)
    if not match_end < run < done:
        raise ModelDrift(f"{API}:{run + 1}: post-commit actions moved out of the success path")
    before = [i + 1 for i in range(match_end, run) if "txn.commit()" in src[i]]
    after = [i + 1 for i in range(run, done) if "txn.commit()" in src[i]]
    ordered = bool(before) and not after and not immediate
    commit = (before or after or [0])[0]
    facts.append(f"rpc commit    {API}:{commit}, post-commit actions {API}:{run + 1}")
    if immediate:
        facts.append(f"              {CONTEXT}:{start} invalidates immediately, before commit")
    return ordered


def per_statement_snapshot(facts: list[str]) -> bool:
    start, body = fn_body(API, "fn rpc_transaction_isolation(")
    overridden = any('"article_view"' in line for line in body)
    facts.append(f"isolation     {API}:{start} article_view {'overridden' if overridden else 'default READ COMMITTED'}")
    return not overridden


def framerail_uses_article_fence(facts: list[str]) -> None:
    src = lines(PAGE_LOAD)
    hits = [i + 1 for i, line in enumerate(src) if "publicContentFence: articleResponse.public_content_cache_fence" in line]
    if len(hits) != 1:
        raise ModelDrift(f"{PAGE_LOAD}: Framerail no longer keys its response by the article_view fence")
    hooks = lines(HOOKS)
    writes = [i + 1 for i, line in enumerate(hooks) if "metadata: locals.anonymousArticleResponseCacheMetadata" in line]
    if len(writes) != 1:
        raise ModelDrift(f"{HOOKS}: Framerail response write no longer uses the article_view metadata")
    facts.append(f"framerail key {PAGE_LOAD}:{hits[0]}, write {HOOKS}:{writes[0]}")


def main() -> int:
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else None  # output directory
    facts: list[str] = []
    try:
        order = reader_order(facts)
        ordered = incr_after_commit(facts)
        snapshot = per_statement_snapshot(facts)
        framerail_uses_article_fence(facts)
    except ModelDrift as error:
        print(f"MODEL DRIFT: {error}", file=sys.stderr)
        print("The code no longer matches the anchors the model was built from; review the model.", file=sys.stderr)
        return 2

    seq = ", ".join(f'"{name}"' for name in order)
    cfg = "\n".join(
        [
            "\\* Generated by extract.py from the source tree. Do not edit.",
            "CONSTANTS",
            "    Writers = {w1, w2}",
            "    Readers = {r1, r2}",
            f"    IncrAfterCommit = {'TRUE' if ordered else 'FALSE'}",
            "    ReaderOrder <- MCReaderOrder",
            f"    PerStatementSnapshot = {'TRUE' if snapshot else 'FALSE'}",
            "SPECIFICATION Spec",
            "",
        ]
    )
    for fact in facts:
        print(fact)
    print(f"model         ReaderOrder <<{seq}>>, IncrAfterCommit {ordered}, PerStatementSnapshot {snapshot}")
    if out:
        (out / "MC.cfg").write_text(cfg, encoding="utf-8")
        (out / "MC.tla").write_text(
            "\n".join(
                [
                    "---- MODULE MC ----",
                    "\\* Generated by extract.py from the source tree. Do not edit.",
                    "EXTENDS ArticleCacheFence",
                    f"MCReaderOrder == <<{seq}>>",
                    "====",
                    "",
                ]
            ),
            encoding="utf-8",
        )
    return 0


if __name__ == "__main__":
    sys.exit(main())
