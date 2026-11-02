# Current-head authority evidence

The signed **2026-10-07 acceptance archive** ([ACCEPTANCE-ARCHIVE.md](ACCEPTANCE-ARCHIVE.md))
stays immutable and validates its own accepted Git-tag state. The maintained
Theme Lab binds later SHA-pinned adaptation receipts that the tag archive does
not carry, and their large files (screenshots, DOM captures, replay objects)
live in a content-addressed store, not in Git. A fresh checkout therefore needs
a restore step before `check-adaptation-authority.mjs` can pass (issue #2506).

## What a checkout needs

The gate reads exactly two kinds of file:

- every `{path, sha256}` in `ports/adaptation-authority.json` under
  `authority-evidence/` or `shared-fixtures/` (the ledger roots), and
- the files that each A/B receipt cited by a certified block
  (`SOURCE_AND_TARGET_CERTIFIED`, `TARGET_WIKIDOT_CERTIFIED`) binds by hash:
  screenshots, DOM captures, archived measurement sources, frozen replay
  objects, and the native History and page-preview artifacts.

`src/authority-evidence-closure.mjs` is the one enumeration of the second
kind. `verifyEvidence` hash-checks the same list the restore step derives, so
the two cannot drift. Evidence of a block that is not certified (for example
one downgraded to `RUNTIME_INDEPENDENT`) is only hash-pinned and never opened,
so its nested files are not restored.

## Restore

`scripts/restore-checkout-authority-evidence.sh` derives the restore inventory
on every run from the tracked ledger and the store, then hardlinks the verified
read-only blobs into the checkout:

```sh
install/local/theme-lab/scripts/restore-checkout-authority-evidence.sh
node install/local/theme-lab/ports/scripts/check-adaptation-authority.mjs
```

The store defaults to `~/.local/state/wikijump/theme-lab/authority-object-store-v1`
(`THEME_LAB_AUTHORITY_STORE` overrides it). `scripts/derive-authority-inventory.mjs`
writes the inventory; `scripts/content-addressed-authority-store.py` verifies
every blob against it and refuses tampering, unsafe paths and overwrites. There
is no committed inventory and no hash to re-pin. Run
`derive-authority-inventory.mjs --store <dir> --output <file>` by hand to see
the inventory, or the missing blobs it reports.

A successful restore and adaptation-authority check do **not** constitute full
Theme Lab acceptance, a new browser screenshot review, or approval to publish a
changed candidate.

## Rebinding the ledger

A rebind adds ledger rows and new evidence files. Nothing else is edited:

1. Commit the ledger change and the receipts it cites.
2. Ingest the new files into the store from the checkout that produced them,
   using a second, clean checkout of that commit as the destination (the
   source and destination must be independent):

   ```sh
   inventory="$(mktemp)"
   node install/local/theme-lab/scripts/derive-authority-inventory.mjs \
     --store "$store" --checkout "$source" --output "$inventory"
   python3 install/local/theme-lab/scripts/content-addressed-authority-store.py \
     --mode ingest --source-root "$source" --destination-root "$clean" \
     --store-root "$store" --inventory "$inventory" \
     --inventory-sha256 "$(sha256sum "$inventory" | cut -d' ' -f1)" --apply
   ```

   The derive step reads a checkout file first when its hash matches, then the
   store, so it works before the new evidence is in the store. Without
   `--apply` the ingest is a read-only plan.
3. Run the restore and the adaptation-authority check above.

If a cited file is in neither the checkout nor the store, the derive step lists
every missing path with its hash and exits non-zero.

## Offline gate and remote acquisition

`scripts/run-offline-authority-gate.sh <store>` derives the inventory the same
way, restores from the store inside a loopback-only network namespace, and runs
the 36-theme frozen package checks and the Python regression suite. It reports
input integrity only.

`scripts/fetch-authority-objects.py` (HTTPS acquisition into a store) takes an
inventory file and its hash. This repository configures no remote store. The
inventory has to come from `derive-authority-inventory.mjs` on a machine that
already has the receipts, because the closure is read from the receipts
themselves.

## Relocating frozen BHL screenshot references

The twelve frozen BHL option receipts from October 2026 record screenshots
using their original absolute worktree paths. Those receipt bytes are
SHA-pinned in the frozen publication set and must not be rewritten. The
verifier recognizes only the archived
`install/local/theme-lab/ports/black-highlighter-theme/option-scenarios/captures/`
suffix and resolves it within the current checked-out evidence root. It refuses
symlinks, traversal and unrelated absolute paths, then verifies every resolved
image against the screenshot SHA-256 in the original receipt.
