#!/usr/bin/env python3
"""Check PromotionActivation model anchors against the current source tree.

Each anchor is a code fact the model relies on (Step 0). A missing anchor
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
     "staleness = latest revision compiled_generator != target"),
    ("install/standing/promote.py", 'stages.run("activation"',
     "activation is a promote.py stage after render-ahead"),
    ("install/standing/promote.py", "def restore_saved_page_output(",
     "rollback restores only rows still at the promoted generator"),
    ("install/standing/render_ahead.py", "def verify_with_catch_up(",
     "render-ahead already catch-up renders, bounded rounds"),
    ("install/standing/render_ahead.py", "CATCH_UP_ROUNDS = 3",
     "catch-up bound the model's MaxRetries mirrors"),
    ("deepwell/src/services/render/ahead.rs", "ahead.wikitext_hash = revision.wikitext_hash",
     "ahead validity: same revision + source (VALID_AHEAD_ROW)"),
    ("deepwell/src/services/render/ahead.rs", "txn.commit()",
     "ahead promotion at startup is one committed transaction"),
    ("deepwell/src/start.rs", "RenderAheadService::promote(&app_state, None)",
     "new Deepwell promotes ahead rows at container start"),
    ("deepwell/src/api.rs", "fn rpc_transaction_isolation(",
     "RPC isolation is per-method; default READ COMMITTED assumed"),
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
    print(f"model         Design in {{D0,D1,D2}}, MaxRetries 2, anchors {len(ANCHORS)} ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
