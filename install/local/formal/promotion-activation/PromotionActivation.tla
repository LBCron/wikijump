------------------------ MODULE PromotionActivation ------------------------
(***************************************************************************)
(* Promotion activation vs concurrent writers (TLA+ pilot, 2026-11-02).    *)
(*                                                                         *)
(* Incident B (2026-11-01): render-ahead final verify saw 0 stale; a       *)
(* corpus-import batch began 6 s later; activation then found 16 stale     *)
(* and rolled back cleanly. Incident A (coupling): Deepwell's deferred     *)
(* re-render fan-out is autonomous (~1/s, depth<=2) and cannot be          *)
(* quiesced; it rewrites a revision's output and updated_at, which         *)
(* invalidates render-ahead validity without any cooperating writer.       *)
(*                                                                         *)
(* Code paths modeled (Step 0, file:line in FINDINGS.md):                  *)
(*  - Stale: latest revision compiled_generator # target string            *)
(*    (promote.py saved_page_staleness; refresh.expected_compiled_         *)
(*    generator). Render-ahead validity is stricter (ahead.rs              *)
(*    VALID_AHEAD_ROW: same revision, wikitext_hash, source_updated_at,    *)
(*    rendered_at >= cutoff). Model: stale(p) == ahead[p] # rev[p].        *)
(*  - Activation is NOT one DB transaction: flip = park containers, write  *)
(*    env, compose up (new Deepwell promotes ahead rows in one txn at      *)
(*    start, start.rs/ahead.rs promote), health, gateway, THEN a separate  *)
(*    stale count; failure restores parked containers + saved-page         *)
(*    snapshot. RPC default isolation is READ COMMITTED, so verify and     *)
(*    the activation check are separate steps with writers between them.   *)
(*  - Writers: ImportLane (corpus import; db mode writes page_revision     *)
(*    directly with generator 'corpus db import', rpc mode via Deepwell    *)
(*    page_create: either way a new rev with no valid ahead row) and       *)
(*    FanOut (post-commit job queue: write commits, then dependents are    *)
(*    enqueued at depth+1 and rerendered by a worker; NOT gateable).       *)
(*  - No maintenance-mode holder exists in promote.py: omitted (Step 0).   *)
(* Assumptions: rev versions bounded by writer budgets; one promoter       *)
(* crash; ahead rows survive a promoter crash (they are DB rows).          *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS Design, MaxRetries   \* Design \in {"D0","D1","D2"}; MaxRetries = 2

Pages == {"p1", "p2"}          \* p2 depends on p1 (fan-out target)
VARIABLES rev, ahead, active, verifiedStale, gate, fence, queue,
          postFlipWrites, outcome, pc, retries, crashed, flipClean,
          impLeft, snap, rendered, cur
vars == <<rev, ahead, active, verifiedStale, gate, fence, queue,
          postFlipWrites, outcome, pc, retries, crashed, flipClean,
          impLeft, snap, rendered, cur>>

StaleCount == Cardinality({p \in Pages : ahead[p] # rev[p]})
Quiet == impLeft = 0 /\ queue = 0
Terminal == outcome \in {"activated", "aborted", "rolledback", "refused"}

Init ==
    /\ rev = [p \in Pages |-> 1] /\ ahead = [p \in Pages |-> 0]
    /\ active = "old" /\ verifiedStale = -1
    /\ gate = "open" /\ fence = "open" /\ queue = 0
    /\ postFlipWrites = 0 /\ outcome = "running" /\ pc = "renderR"
    /\ retries = 0 /\ crashed = FALSE /\ flipClean = FALSE
    /\ impLeft = 2 /\ snap = [p \in Pages |-> 0] /\ rendered = {} /\ cur = ""

\* --- Promoter: render-ahead, one page per read/commit pair (READ COMMITTED:
\* a writer may land between the read of rev[p] and the ahead[p] commit). ---
RenderRead ==
    /\ pc = "renderR" /\ outcome = "running"
    /\ IF Design = "D1" THEN gate' = "closed" ELSE UNCHANGED gate
    /\ \E p \in Pages \ rendered :
        /\ snap' = [snap EXCEPT ![p] = rev[p]]
        /\ cur' = p
    /\ pc' = "renderC"
    /\ UNCHANGED <<rev, ahead, active, verifiedStale, fence, queue,
                   postFlipWrites, outcome, retries, crashed, flipClean,
                   impLeft, rendered>>
RenderCommit ==
    /\ pc = "renderC" /\ outcome = "running"
    /\ ahead' = [ahead EXCEPT ![cur] = snap[cur]]
    /\ rendered' = rendered \cup {cur} /\ cur' = ""
    /\ pc' = IF rendered \cup {cur} = Pages THEN "verify" ELSE "renderR"
    /\ UNCHANGED <<rev, active, verifiedStale, gate, fence, queue,
                   postFlipWrites, outcome, retries, crashed, flipClean,
                   impLeft, snap>>
Verify ==
    /\ pc = "verify" /\ outcome = "running"
    /\ verifiedStale' = StaleCount
    /\ pc' = IF Design = "D2" THEN "checkflip" ELSE "flip"
    /\ IF Design = "D2" THEN fence' = "closed" ELSE UNCHANGED fence
    /\ UNCHANGED <<rev, ahead, active, gate, queue, postFlipWrites, outcome,
                   retries, crashed, flipClean, impLeft, snap, rendered, cur>>
\* D0/D1 flip: container switch; ahead promotion inside it is one DB txn,
\* but writers land freely between this step and ActCheck.
Flip ==
    /\ pc = "flip" /\ outcome = "running" /\ Design # "D2"
    /\ active' = "new" /\ flipClean' = (StaleCount = 0) /\ pc' = "actcheck"
    /\ UNCHANGED <<rev, ahead, verifiedStale, gate, fence, queue,
                   postFlipWrites, outcome, retries, crashed, impLeft,
                   snap, rendered, cur>>
ActCheck ==
    /\ pc = "actcheck" /\ outcome = "running"
    /\ IF StaleCount = 0
         THEN /\ outcome' = "activated" /\ gate' = "open" /\ pc' = "done"
         ELSE /\ pc' = "rbdecide" /\ UNCHANGED <<outcome, gate>>
    /\ UNCHANGED <<rev, ahead, active, verifiedStale, fence, queue,
                   postFlipWrites, retries, crashed, flipClean, impLeft,
                   snap, rendered, cur>>
\* D2: atomic check-and-flip under the short fence (one label = one txn).
CheckFlip ==
    /\ pc = "checkflip" /\ outcome = "running" /\ Design = "D2"
    /\ fence' = "open"
    /\ IF StaleCount = 0
         THEN /\ active' = "new" /\ flipClean' = TRUE
              /\ outcome' = "activated" /\ pc' = "done"
              /\ UNCHANGED <<ahead, retries>>
         ELSE IF retries < MaxRetries \/ Quiet
              THEN /\ pc' = "catchup" /\ UNCHANGED <<active, flipClean, outcome, ahead, retries>>
              ELSE /\ outcome' = "aborted" /\ pc' = "done"
                   /\ UNCHANGED <<active, flipClean, ahead, retries>>
    /\ UNCHANGED <<rev, verifiedStale, gate, queue, postFlipWrites, crashed,
                   impLeft, snap, rendered, cur>>
CatchUp ==   \* catch-up render of the stale delta (render_ahead.py: <=3 rounds)
    /\ pc = "catchup" /\ outcome = "running"
    /\ ahead' = rev /\ retries' = retries + 1
    /\ rendered' = Pages /\ pc' = "verify"
    /\ UNCHANGED <<rev, active, verifiedStale, gate, fence, queue,
                   postFlipWrites, outcome, crashed, flipClean, impLeft,
                   snap, cur>>
\* Rollback policy the model exposes: post-flip writes are never discarded;
\* rollback is refused while any exist (promote.py restores only rows still
\* at the promoted generator, so this matches the code's partial restore).
RollbackDecide ==
    /\ pc = "rbdecide" /\ outcome = "running"
    /\ IF postFlipWrites = 0
         THEN /\ active' = "old" /\ outcome' = "rolledback"
         ELSE /\ outcome' = "refused" /\ UNCHANGED active
    /\ gate' = "open" /\ pc' = "done"
    /\ UNCHANGED <<rev, ahead, verifiedStale, fence, queue, postFlipWrites,
                   retries, crashed, flipClean, impLeft, snap, rendered, cur>>
\* Promoter crash (at most once, any label): a session-scoped gate clears
\* itself; ahead rows persist, so recovery re-verifies.
Crash ==
    /\ outcome = "running" /\ ~crashed /\ pc # "done"
    /\ crashed' = TRUE /\ pc' = "crashed"
    /\ gate' = "open" /\ fence' = "open"
    /\ UNCHANGED <<rev, ahead, active, verifiedStale, queue, postFlipWrites,
                   outcome, retries, flipClean, impLeft, snap, rendered, cur>>
Recover ==
    /\ pc = "crashed"
    /\ pc' = "verify" /\ rendered' = Pages
    /\ UNCHANGED <<rev, ahead, active, verifiedStale, gate, fence, queue,
                   postFlipWrites, outcome, retries, crashed, flipClean,
                   impLeft, snap, cur>>

\* --- Writers. ImportLane: gate check and commit are ONE step (the lock
\* spans the write transaction). FanOut: derived, post-commit, ungated. ---
ImportWrite ==
    /\ impLeft > 0 /\ fence = "open"
    /\ (Design # "D1" \/ gate = "open")
    /\ impLeft' = impLeft - 1
    /\ rev' = [rev EXCEPT !["p1"] = rev["p1"] + 1]
    /\ IF queue < 2 THEN queue' = queue + 1 ELSE UNCHANGED queue
    /\ IF active = "new" THEN postFlipWrites' = postFlipWrites + 1
       ELSE UNCHANGED postFlipWrites
    /\ UNCHANGED <<ahead, active, verifiedStale, gate, fence, outcome, pc,
                   retries, crashed, flipClean, snap, rendered, cur>>
FanOut ==   \* rerender of dependent p2: new output, ahead validity lost
    /\ queue > 0
    /\ queue' = queue - 1
    /\ rev' = [rev EXCEPT !["p2"] = rev["p2"] + 1]
    /\ IF active = "new" THEN postFlipWrites' = postFlipWrites + 1
       ELSE UNCHANGED postFlipWrites
    /\ UNCHANGED <<ahead, active, verifiedStale, gate, fence, outcome, pc,
                   retries, crashed, flipClean, impLeft, snap, rendered, cur>>

PromoterNext == RenderRead \/ RenderCommit \/ Verify \/ Flip \/ ActCheck
                \/ CheckFlip \/ CatchUp \/ RollbackDecide \/ Crash \/ Recover
Next == PromoterNext \/ ImportWrite \/ FanOut
Spec == Init /\ [][Next]_vars /\ WF_vars(PromoterNext)

\* --- Properties ---
TypeOK ==
    /\ active \in {"old", "new"} /\ gate \in {"open", "closed"}
    /\ fence \in {"open", "closed"} /\ retries \in 0..MaxRetries + 2
    /\ impLeft \in 0..2 /\ queue \in 0..2
NoStaleFlip == active = "new" => flipClean
RollbackRestores == outcome = "rolledback" => active = "old"
NoLostWrite == outcome = "rolledback" => postFlipWrites = 0
\* Incident-B progress claim (asserted only in the incident configuration):
CleanVerifyNoAbort ==
    ~(verifiedStale = 0 /\ outcome \in {"aborted", "rolledback", "refused"})
Termination == <>(Terminal)
QuietSuccess == (Quiet /\ outcome = "running") ~> (outcome = "activated")
GateReopens == (gate = "closed") ~> (gate = "open")
FenceReopens == (fence = "closed") ~> (fence = "open")
=============================================================================
