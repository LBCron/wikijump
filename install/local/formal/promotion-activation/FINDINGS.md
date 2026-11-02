# Promotion activation vs concurrent writers — findings

Pilot of 2026-11-02 (BRIEF-TLA-PILOT). Model: `PromotionActivation.tla`
(188 lines). Runner: `check.sh` (incident + gate + fixed configurations),
`check.sh mutations` (Step-3 mutations). No production code changed.

## Step 0 — answers from the code

1. **What defines "stale"?** A live page whose latest revision's
   `compiled_generator` differs from the target build's string
   (`install/standing/promote.py:535` `saved_page_staleness`, target from
   `install/standing/refresh.py:152` `expected_compiled_generator`).
   Render-ahead's own predicate is stricter: stale *without a valid ahead
   row*, where validity needs same revision, `wikitext_hash`,
   `source_updated_at`, and `rendered_at >= cutoff`
   (`deepwell/src/services/render/ahead.rs:63`). Db-mode corpus imports
   insert revisions with generator `'corpus db import'`
   (`install/local/wikidot-verification/scripts/apply-corpus-import-manifest.mjs:75`),
   so every imported page is stale until rendered. Model:
   `stale(p) == ahead[p] # rev[p]`.

2. **Check and flip: one transaction?** No. Activation is a container
   switch, not a DB transaction: `switch_stage`
   (`install/standing/promote.py:1291`) parks the old containers, writes
   the environment, runs compose up, waits for health, reloads the
   gateway, and only then counts stale pages
   (`install/standing/promote.py:1322`) as a separate psql query; failure
   restores parked containers and the saved-page snapshot
   (`install/standing/promote.py:597`, restore touches only rows still at
   the promoted generator). What *is* one transaction is the new
   Deepwell's startup promotion of ahead rows
   (`deepwell/src/start.rs:102` →
   `deepwell/src/services/render/ahead.rs:285`, begin `:293`, commit
   `:343`). RPC transactions default to READ COMMITTED; only
   `parent_get_direct_metadata` is overridden to RepeatableRead
   (`deepwell/src/api.rs:289`). So any writer can land between
   render-ahead's final verify and the activation stale count. The model
   therefore splits Render read/commit, Verify, Flip, and ActCheck.

3. **Does the fan-out change staleness?** Not the generator predicate
   directly: a rerender rewrites the revision's output and `updated_at`
   with the *running* build's generator. But `updated_at` is part of
   ahead validity (`ahead.rs:63`), so a fan-out rerender invalidates a
   valid ahead row and re-stales the page. Fan-out is deferred
   post-commit work: the write commits, then dependents are enqueued at
   depth+1 (`deepwell/src/services/context.rs:391`,
   `deepwell/src/services/job/worker.rs:238`); it also commits new
   text-block objects and deletes the old ones after commit
   (`install/standing/promote.py:464`). It is autonomous and not
   gateable. Model: `FanOut` bumps `rev["p2"]`, never checks the gate.

4. **Do import lanes write through Deepwell?** Both ways.
   `--create-mode rpc` uses Deepwell `page_create`
   (`apply-corpus-import-manifest.mjs:1475`); `--create-mode db` writes
   `page_revision` by direct SQL with the placeholder generator (above).
   The Incident-B lane was a corpus-import/backfill batch; either way the
   model treats it as one cooperating writer (`ImportWrite`) that *could*
   check a gate in the same step as its commit, and currently does not.

No maintenance-mode holder exists in `promote.py`, so none is modeled.
Unsettled: nothing material; bounded-revision and single-crash bounds are
carried as assumptions in the spec header.

## Chosen design

**D2** — no long gate; catch-up render of the stale delta with bounded
retries, then one atomic check-and-flip under a short fence for
cooperating writers. D1 (long gate for cooperating lanes) is **rejected
by the model**: with the gate held closed, `CleanVerifyNoAbort` still
fails, because the ungateable fan-out re-stales `p2` between verify and
the activation check (Gate configuration, 958 states). D0 (current code)
fails the same property (Incident configuration, 676 states). D2 passes
`NoStaleFlip`, `RollbackRestores`, `NoLostWrite`, `Termination`,
`QuietSuccess`, and `FenceReopens` (Fixed configuration, 945 states).

Note what D2 does *not* prove: run separately, D2 also violates
`CleanVerifyNoAbort` — a verify that saw 0 stale can still end in a
clean abort after repeated fan-out/import writes. D2's guarantee is
"never flip stale, never hang", not "clean verify implies success".

## Traces

- **Incident (D0, shortest counterexample):** render `p1`,`p2` → verify
  sees `verifiedStale = 0` → flip (`active = new`) → import commits `p1`
  (`impLeft 2→1`, fan-out queued) → activation check finds stale →
  rollback decision → **`refused`**, because the write landed after the
  flip. Incident B's retained record (verify 08:38:31 UTC, import batch
  08:38:37 UTC, 16 stale, clean rollback) is the same race with the
  write landing before the flip; the model shows the post-flip timing
  is strictly worse. Reduced from 16 pages to 1, as briefed.
- **Mutation M1 (split check-and-flip):** writer lands between
  `CheckOnly` and `FlipOnly` → `NoStaleFlip` violated. Expected fail, 1 s.
- **Mutation M2 (fence removed, flip trusts the pre-check snapshot):**
  import ignores the fence and commits between verify and flip →
  `NoStaleFlip` violated. Expected fail, 1 s.

## NoLostWrite policy question (for the coordinator)

The model encodes: *rollback is refused while any post-flip write
exists* (matching `restore_saved_page_output`, which only restores rows
still at the promoted generator). Question for the fix PR: is "refuse
rollback and keep the new build serving" the intended operator policy
for that window, or should activation instead prevent post-flip writes
from committing until the stale count passes? The model exposes the
choice; it does not settle it.

## CRITERION-4 STATEMENT

The model changed a decision. (1) It rejected candidate design D1: a
cooperating-lane gate cannot hold the window, because the autonomous
fan-out violates the progress property while the gate is closed (Gate
configuration counterexample) — a D1 fix would have been built and
would still abort promotions under fan-out load. (2) It exposed a new
hazard not in Incident B's record: a writer landing after the flip but
before the activation stale count makes rollback *refused*, not clean
(Incident configuration shortest trace) — the rollback policy question
above. (3) It qualified the consult's D2 prior: D2 is safe and live,
but it does not make a clean verify predictive of success. Reproducing
the incident alone would not have produced (1)–(3).
