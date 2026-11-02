# Historical closure record inputs (2026-10-28 campaign)

Archived copies of the non-manifest inputs to the frozen campaign record,
for `src/campaign-record-integrity.mjs` (ALLOC-32 R4 Check 1). Every file
here is byte-identical to its source at the closure tree
(`bf9fb6de1e` / `a72654b58e`, tree `2fab425a…`):

- Files that are git-committed at closure were copied from those git
  objects (`git show bf9fb6de1e:<path>`), preserving their relative paths.
- `current-campaign-acceptance.json` and the two campaign run contracts
  exist only in the campaign evidence manifest; they were copied from the
  content-addressed store blobs pinned by that manifest
  (`aa98a537…`, `86799138…`, `5ac0ed99…`).
- Content-addressed asset files keep the bytes their names hash to; most
  blobs are already tracked elsewhere in this repository, so these copies
  add tree entries, not new object data.

Do not edit anything in this directory. A changed byte here is a changed
closure record and must fail Check 1; the module pins the governing
SHA-256 values as code constants and verifies these copies against them.
