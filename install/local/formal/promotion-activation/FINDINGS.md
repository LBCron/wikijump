# Promotion activation vs concurrent writers — findings

Rewritten 2026-11-02 (BRIEF-TLA-FIX Step 3) to the real protocol, per the
tla-pilot ASSESSMENT.md ruling. This supersedes the pilot FINDINGS in this
file; the pilot commits themselves are unchanged. Model:
`PromotionActivation.tla` (206 lines). Runner: `check.sh` (fixed +
incident + restore + rollback-witness configurations), `check.sh
mutations` (three one-element mutations). Production code now implements
the modeled FIX design in `install/standing/promote.py`.

## What the code does (Step 0, rechecked)

1. **What defines "stale"?** A live page whose latest revision's
   `compiled_generator` differs from the target build's string. The count
   (`saved_page_staleness`) and the new delta query
   (`saved_page_stale_ids`) share one predicate
   (`_stale_saved_pages_from_where`). Render-ahead validity is stricter
   (same revision, wikitext hash, `source_updated_at`, rendered at/after
   cutoff; `deepwell/src/services/render/ahead.rs`).
2. **Check and flip are not one transaction.** Activation is a container
   switch: snapshot, park, compose up (the new Deepwell promotes valid
   ahead rows in one startup transaction), health, gateway, then stale
   counting as separate queries. The pilot's atomic `CheckFlip`, the short
   fence, the lane gate, and the `refused` rollback outcome are removed
   from the model: none exists in the code, and the assessment showed the
   model's green result was partly vacuous because of them (rollback was
   unreachable in D2).
3. **Parking is the fence.** Parking stops the old Deepwell, and with it
   RPC writers and the deferred re-render fan-out. After the flip the new
   build's own writes carry the target generator and cannot re-stale a
   page; only direct-SQL imports (placeholder generator `corpus db
   import`) can, and those are the import's own finalizer's job once
   promotion is over.
4. **Rollback never touches source.** `restore_saved_page_output` writes
   only compiled-output columns, for snapshot revisions still at the
   promoted generator. Two concrete defects followed (assessment ruling):
   a post-flip in-place rerender (`rerender_inner` stamps `compiled_at`
   with the running build's clock) was silently overwritten by the
   snapshot restore; and revisions created after the flip stayed at the
   promoted generator, refused by the old build's view path
   (`compiled_generator_is_current` check) with nothing re-rendering them.
   The fix guards the restore with the database clock captured before
   parking (`compiled_at < switch start`) and renders the old build's
   stale delta with the old image after recovery.

## Chosen design (FIX in the model)

Bounded convergence instead of atomicity: count, then while stale render
the stale page IDs with the new image, restart Deepwell (promotes the
ahead rows), reload the gateway, and re-count — at most
`render_ahead.CATCH_UP_ROUNDS` rounds within a total time bound
(`ACTIVATION_CATCH_UP_TIMEOUT_SECONDS`). A zero first count is exactly the
old behavior (no render, no restart). Non-convergence keeps the old
failure (`standing serves {stale} stale saved pages`) and rolls back.
When a catch-up render moves the link graph, known link readers (the
render-ahead receipt's `link_reader_page_ids` plus readers the catch-up
passes report) are marked stale, re-rendered, and settled by link-digest
rounds exactly as `render_ahead.verify_with_catch_up` does (#2738);
readers no pass in this promotion rendered are not enumerable without a
persisted reader registry (Deepwell reports readers only per render), so
the model does not claim them either.

**D1 is still rejected, for the corrected reason.** The pilot said D1
fails `CleanVerifyNoAbort`; the assessment showed D2 violates that same
property, so it never discriminated. The code reason stands on its own:
Deepwell's fan-out runs until the old container is parked, so no lane
gate can hold the pre-park window; the only point with no autonomous
Deepwell writer is after park. **D2 (transaction/fence/gate/atomic
check-and-flip) is rejected** by the ruling: rollback stays always
available, no write fence is added, and the two derived-output defects
above are fixed instead. The pilot's claim "rollback is refused while
post-flip writes exist" was a model artifact and is corrected here:
rollback is never refused; source survives by construction, and derived
output is guarded and re-rendered as above.

## Model scope notes

- Per page the model tracks the input version its saved output reflects
  (`outVer`), the generator that rendered it (`outGen`), and whether it
  was compiled before or after the switch started (`outTime`), so restore
  regression is statable. `rev[p2]` also moves when p1 is written (p2's
  inputs include p1).
- `RollbackNoRegression` is scoped to inputs as of rollback entry
  (`rbMoved`): a write landing during or after recovery advances inputs
  under any build and is owned by the same fan-out/finalizer paths as a
  write after any rollback completes.
- Recovery in the model renders the old build's stale delta (selected the
  way `saved_page_stale_ids` selects it, by generator) and the old
  Deepwell's restart also drains the bounded rerender queue. That queue
  is RSMQ messages in Valkey (`deepwell/src/services/job/service.rs`),
  not database rows, and it survives parking for a simpler reason:
  activation parks only Deepwell, Framerail, and WWS, never the cache
  container. Dependent-input freshness for a page whose own generator
  already matches is, as outside promotion, the fan-out/finalizer's job,
  not the activation count's. Unproven residual: deferred dependents
  rely on that queue survival and on Deepwell's `rerender_skip` rules
  not skipping them when the worker resumes; neither has been exercised
  on Standing.
- Properties dropped as true by construction in the pilot
  (`RollbackRestores`, the old `NoLostWrite`, `FenceReopens`,
  `GateReopens`): FIX keeps `NoPassWithStale` (the receipt cannot pass
  while the last count saw stale pages; the view path refuses stale
  output for writes after that count), `RollbackNoRegression`,
  `Termination`, and `QuietSuccess`.

## Results (check.sh, TLC 1.7.4, ~5 s total)

- **Fixed (FIX): PASS** — `NoPassWithStale`, `RollbackNoRegression`,
  `Termination`, `QuietSuccess` (23,597 distinct states; STEER-1 recount after the count predicate was
  made generator-only — no property changed its result: `QuietSuccess`
  and the rollback properties still pass in FIX).
- **Incident (CUR): EXPECTED-FAIL** — `CleanVerifyNoRollback` violated;
  shape asserted from the parsed trace states, not a grep: a clean verify
  (state 3), a write landing before the flip (state 5–6), and a final
  clean `rolledback`. This is Incident B's real order (verify → import
  commit → flip → count → rollback), reduced to one writing page.
- **Restore (CUR): EXPECTED-FAIL** — `RestoreRegressionFree` violated;
  shape: the regressed page (`p2`) was promoted at the flip, then the
  unguarded restore put its older snapshot output back under the old
  generator, where the old build serves it.
- **Witness (FIX, `NeverRolledback`): EXPECTED-FAIL** — rollback is
  reachable in the fixed design (a post-flip failure still rolls back),
  so the safety properties above are not vacuous over an unreachable
  rollback.
- **Mutations, each exactly one element changed, each fails:**
  MA no post-flip catch-up (the count's catch-up branch
  `Design = "FIX" /\ retries < 3` → `FALSE`) violates `QuietSuccess` —
  a write after the verify, followed by quiet, ends in rollback instead
  of activation; that property is what justifies the loop (an earlier
  version moved the catch-up guard to `"snap"`, which did not test this
  claim, and was replaced on review). MB restore guard removed
  (`(Design = "CUR" \/ outTime[p] = "pre")` → `TRUE`) violates
  `RollbackNoRegression`; MC receipt passing without the re-count
  (restart goes straight to `commit`) violates `NoPassWithStale`.
- The model's activation count is generator-only, exactly like
  `saved_page_stale_ids`: a dependent awaiting fan-out at the target
  generator is not stale to it (`outVer` tracking remains only so
  restore regression can be stated). Ahead validity applies at the
  render-ahead verify (`VerifiedStaleCount`), not at the count.

## CRITERION-4 STATEMENT (updated)

The model changed decisions, on the assessment's narrower grounds:
(1) D1 rejected for the corrected, code-confirmed reason (fan-out cannot
be gated before park); (2) following the pilot's rollback-refusal
artifact into the code exposed the two real derived-output defects
(guarded restore, post-rollback convergence) that the fix now addresses;
(3) a clean verify is not predictive — the fixed design therefore
converges a bounded delta after the flip instead of trying to make the
verify atomic. Reproducing Incident B alone would have produced none of
these.
