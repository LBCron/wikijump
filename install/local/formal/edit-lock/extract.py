#!/usr/bin/env python3
"""Check EditLock model anchors against the current source tree.

Each anchor is a code fact the model relies on. A missing anchor means
the code drifted from the model: exit 2 and review the model before
trusting it, mirroring install/local/formal/rerender-lifecycle/extract.py.
Lease-side facts that the implementation steps (RULING-2 section 6,
steps 3-7) have not created yet are listed as PENDING: they are printed,
never fail, and are never treated as bindings. Assumptions that cannot
be derived mechanically are in the spec header.
"""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]

ANCHORS = [
    # (repo-relative path, needle, fact the model relies on)
    ("deepwell/src/services/page/service.rs",
     "fn check_last_revision(",
     "today's writers check only the client-supplied last_revision_id: the check that cannot stay as-is on lease-carrying saves"),
    ("deepwell/src/services/page/service.rs",
     "fn raise_if_revision_insert_conflict(",
     "S4: an insert-time unique violation or deadlock on the revision key is mapped to the typed NotLatestRevisionId; the typed surface the lease save builds on"),
    ("deepwell/src/error/error_type.rs",
     "ErrorType::NotLatestRevisionId => 4303,",
     "the typed revision-conflict outcome exists, as error code 4303"),
    ("deepwell/src/services/page/service.rs",
     "pub async fn edit(",
     "edit: the guarded core writer of the census (Step 0 row 2)"),
    ("deepwell/src/services/page/service.rs",
     "pub async fn r#move(",
     "move: census writer, only partially guarded today (Step 0 row 3)"),
    ("deepwell/src/services/page/service.rs",
     "pub async fn delete(",
     "delete: census writer, writes a tombstone revision (Step 0 row 4)"),
    ("deepwell/src/services/page/service.rs",
     "pub async fn rollback(",
     "rollback: census writer of the revert family (Step 0 row 6)"),
    ("deepwell/src/services/legacy_action.rs",
     "legacy action revision is stale",
     "legacy set-tags delegates to PageService::edit, so a tag write creates a source revision in Wikijump today (the I6 trap: it must become a meta writer)"),
    ("deepwell/src/services/import/service.rs",
     "PageRevisionService::create(",
     "import writes revisions through create directly: an explicit system bypass outside PageService's guards, as the model assumes"),
    ("deepwell/src/services/page_lock/service.rs",
     "lock_type: Set(input.lock_type),",
     "PageLockService is the administrative protection lock (typed, reasoned), not an edit lease: the lease store must be a separate table"),
    ("deepwell/src/services/page_draft/service.rs",
     "pub async fn save(",
     "drafts exist as the synchronize target, with save/exists/remove only: no lease is attached to a draft today"),
    ("framerail/src/lib/server/ajax-module-connector.ts",
     '"removePageEditLock"',
     "the Ajax connector knows the Wikidot draft events; removePageEditLock today only deletes the caller's own draft"),
    ("deepwell/src/models/page_edit_lock.rs",
     "page_edit_lock",
     "the lease store exists as its own table, separate from page_lock (RULING-2 step 3, landed)"),
    ("deepwell/src/services/page/service.rs",
     "edit_with_lease",
     "the lease-aware save in Deepwell: acquire/force/renew/release with typed outcomes 4303/4304 (RULING-2 step 3, landed)"),
    ("framerail/src/lib/server/ajax-module-connector.ts",
     '"edit/PageEditModule"',
     "the Ajax edit-open surface issuing lock_id/lock_secret with the acquisition base (RULING-2 step 5, landed)"),
]

PENDING = []


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
    for rel, needle, fact in PENDING:
        path = ROOT / rel
        found = False
        try:
            found = needle in path.read_text(encoding="utf-8")
        except OSError:
            found = False
        if found:
            print(f"anchor pend {rel}  {fact} [needle now present: promote this anchor]")
        else:
            print(f"anchor pend {rel}  {fact}")
    if missing:
        for item in missing:
            print(f"MODEL DRIFT: {item}", file=sys.stderr)
        print("The code no longer matches the model's anchors; review the model.",
              file=sys.stderr)
        return 2
    print(f"model         anchors {len(ANCHORS)} ok, {len(PENDING)} pending (implementation steps)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
