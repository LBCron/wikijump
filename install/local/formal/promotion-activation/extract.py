#!/usr/bin/env python3
"""Check PromotionActivation model anchors against the current source tree.

Each anchor is a code fact the rewritten model relies on. A missing anchor
means the code drifted from the model: exit 2 and review the model before
trusting it, mirroring install/local/formal/article-cache-fence/extract.py.
Design-variant and stage vocabulary that cannot be derived mechanically is
carried as an assumption in the spec header instead (see FINDINGS.md).
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]

ANCHORS = [
    # (repo-relative path, needle, fact the model relies on)
    ("install/standing/promote.py", "def saved_page_staleness(",
     "staleness = latest revision compiled_generator != target (count)"),
    ("install/standing/promote.py", "def saved_page_stale_ids(",
     "the stale delta is listed by page ID from the same predicate"),
    ("install/standing/promote.py", "def converge_saved_pages(",
     "activation converges stale pages in bounded rounds after the flip"),
    ("install/standing/promote.py", "standing serves {stale} stale saved pages",
     "non-convergence keeps the historical stale failure and rolls back"),
    ("install/standing/promote.py", "page_revision.compiled_at < '",
     "restore guard: rows compiled at/after the switch start are not restored"),
    ("install/standing/promote.py", "SELECT clock_timestamp()",
     "the switch start comes from the database clock before parking"),
    ("install/standing/promote.py", "def recover_stale_saved_pages(",
     "post-rollback convergence renders the old build's stale delta"),
    ("install/standing/promote.py", "def render_delta_pages(",
     "delta renders reuse render_pass with the running Deepwell's namespace"),
    ("install/standing/render_ahead.py", "CATCH_UP_ROUNDS = 3",
     "the round bound the model's catch-up retries mirror"),
    ("install/standing/render_ahead.py", "def verify_with_catch_up(",
     "link readers settle by digest rounds after a catch-up (the precedent)"),
    ("deepwell/src/services/render/ahead.rs", "ahead.wikitext_hash = revision.wikitext_hash",
     "ahead validity: same revision + source (VALID_AHEAD_ROW)"),
    ("deepwell/src/start.rs", "RenderAheadService::promote(&app_state, None)",
     "new Deepwell promotes ahead rows at container start (one txn)"),
    ("deepwell/src/services/view/service.rs", "compiled_generator_is_current(&page_revision.compiled_generator)",
     "the view path refuses stale output without an editing session"),
    ("deepwell/src/services/page_revision/service.rs", "compiled_at: Set(compiled_at)",
     "in-place rerenders stamp compiled_at with the running build's clock"),
    ("deepwell/src/services/context.rs", "PostCommitAction::RerenderPage",
     "fan-out rerenders are deferred post-commit actions (ungateable)"),
    ("install/local/wikidot-verification/scripts/apply-corpus-import-manifest.mjs",
     "const SHELL_COMPILED_GENERATOR = 'corpus db import';",
     "db-mode corpus imports carry the placeholder generator (stale)"),
]


def main() -> int:
    missing = []
    for rel, needle, fact in ANCHORS:
        path = ROOT / rel
        try:
            text = path.read_text(encoding="utf-8")
        except OSError:
            missing.append(f"{rel}: unreadable (anchor: {fact})")
            continue
        if needle not in text:
            missing.append(f"{rel}: missing {needle!r} (anchor: {fact})")
        else:
            lineno = text[: text.index(needle)].count("\n") + 1
            print(f"anchor ok   {rel}:{lineno}  {fact}")
    if missing:
        for item in missing:
            print(f"MODEL DRIFT: {item}", file=sys.stderr)
        print("The code no longer matches the model's anchors; review the model.",
              file=sys.stderr)
        return 2
    print(f"model         Design in {{CUR,FIX}}, anchors {len(ANCHORS)} ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
