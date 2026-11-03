------------------------ MODULE PromotionActivation ------------------------
(***************************************************************************)
(* Promotion activation vs concurrent writers (rewritten 2026-11-02 to   *)
(* the real protocol per tla-pilot ASSESSMENT.md; supersedes the pilot's  *)
(* D0/D1/D2, atomic CheckFlip, fence, gate, and `refused` outcome).       *)
(* Protocol (promote.py): snapshot, park, up+promote, health, gateway,    *)
(* count, bounded catch-up (render delta, restart, re-count), commit,     *)
(* proof; post-flip failure rolls back (guarded restore, old containers,  *)
(* old-image recovery). Parking fences Deepwell-routed writers (fan-out   *)
(* included); after the flip only direct-SQL imports stale a page.        *)
(* outVer/outGen/outTime track which input version a page's output        *)
(* reflects, by which generator, before/after the switch started, so      *)
(* restore regression is statable. CUR = pre-fix; FIX = the protocol.     *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS Design              \* Design \in {"CUR", "FIX"}
Pages == {"p1", "p2"}         \* p2 depends on p1 (fan-out target)
VARIABLES rev, outVer, outGen, outTime, aheadVer, aheadTime, snapVer, snapGen,
          active, flipped, verifiedStale, lastCount, pc, outcome, summary,
          queue, impLeft, rpcLeft, failLeft, retries, preFlipWrite, rbMoved, promoted
vars == <<rev, outVer, outGen, outTime, aheadVer, aheadTime, snapVer, snapGen,
          active, flipped, verifiedStale, lastCount, pc, outcome, summary,
          queue, impLeft, rpcLeft, failLeft, retries, preFlipWrite, rbMoved, promoted>>

FreshGen(p) == outGen[p] = "new"   \* the activation count: generator only
FreshVerified(p) == FreshGen(p) \/ aheadVer[p] = rev[p]  \* render-ahead verify
StaleCount == Cardinality({p \in Pages : ~FreshGen(p)})
VerifiedStaleCount == Cardinality({p \in Pages : ~FreshVerified(p)})
Quiet == impLeft = 0 /\ rpcLeft = 0 /\ queue = 0 /\ failLeft = 0
          /\ pc \notin {"rbrestore", "rbup", "rbrender", "rbrestart", "done"}

Init ==
    /\ rev = [p \in Pages |-> 1] /\ outVer = [p \in Pages |-> 1]
    /\ outGen = [p \in Pages |-> "old"] /\ outTime = [p \in Pages |-> "pre"]
    /\ aheadVer = [p \in Pages |-> 0] /\ aheadTime = [p \in Pages |-> "pre"]
    /\ snapVer = [p \in Pages |-> 0] /\ snapGen = [p \in Pages |-> "old"]
    /\ active = "old" /\ flipped = FALSE /\ verifiedStale = -1
    /\ lastCount = -1 /\ pc = "render" /\ outcome = "running"
    /\ summary = FALSE /\ queue = 0 /\ impLeft = 1 /\ rpcLeft = 1
    /\ failLeft \in 0..1 /\ retries = 0 /\ preFlipWrite = FALSE
    /\ rbMoved = [p \in Pages |-> FALSE] /\ promoted = [p \in Pages |-> FALSE]

\* --- Promoter ---
RenderOne ==
    /\ pc = "render" /\ outcome = "running"
    /\ \E p \in Pages :
        /\ aheadVer[p] < rev[p]
        /\ aheadVer' = [aheadVer EXCEPT ![p] = rev[p]]
        /\ pc' = IF \A q \in Pages : aheadVer[q] = rev[q] \/ q = p
                 THEN "verify" ELSE "render"
    /\ UNCHANGED <<promoted, rbMoved, rev, outVer, outGen, outTime, aheadTime, snapVer, snapGen, active, flipped, verifiedStale, lastCount, outcome, summary, queue, impLeft, rpcLeft, failLeft, retries, preFlipWrite>>
Verify ==
    /\ pc = "verify" /\ outcome = "running"
    /\ verifiedStale' = VerifiedStaleCount /\ pc' = "snap"
    /\ UNCHANGED <<promoted, rbMoved, rev, outVer, outGen, outTime, aheadVer, aheadTime, snapVer, snapGen, active, flipped, lastCount, outcome, summary, queue, impLeft, rpcLeft, failLeft, retries, preFlipWrite>>
Snapshot ==
    /\ pc = "snap" /\ outcome = "running"
    /\ snapVer' = outVer /\ snapGen' = outGen /\ pc' = "park"
    /\ UNCHANGED <<promoted, rbMoved, rev, outVer, outGen, outTime, aheadVer, aheadTime, active, flipped, verifiedStale, lastCount, outcome, summary, queue, impLeft, rpcLeft, failLeft, retries, preFlipWrite>>
Park ==   \* the fence: no Deepwell runs, so no RPC write or fan-out can land
    /\ pc = "park" /\ outcome = "running"
    /\ active' = "none" /\ pc' = "up"
    /\ UNCHANGED <<promoted, rbMoved, rev, outVer, outGen, outTime, aheadVer, aheadTime, snapVer, snapGen, flipped, verifiedStale, lastCount, outcome, summary, queue, impLeft, rpcLeft, failLeft, retries, preFlipWrite>>
Up ==     \* new Deepwell promotes valid ahead rows in one txn at startup
    /\ pc = "up" /\ outcome = "running"
    /\ active' = "new" /\ flipped' = TRUE
    /\ outVer' = [p \in Pages |-> IF aheadVer[p] = rev[p] THEN aheadVer[p] ELSE outVer[p]]
    /\ outGen' = [p \in Pages |-> IF aheadVer[p] = rev[p] THEN "new" ELSE outGen[p]]
    /\ outTime' = [p \in Pages |-> IF aheadVer[p] = rev[p] THEN aheadTime[p] ELSE outTime[p]]
    /\ aheadVer' = [p \in Pages |-> 0] /\ pc' = "health"
    /\ promoted' = [p \in Pages |-> promoted[p] \/ aheadVer[p] = rev[p]]
    /\ UNCHANGED <<rbMoved, rev, aheadTime, snapVer, snapGen, verifiedStale, lastCount, outcome, summary, queue, impLeft, rpcLeft, failLeft, retries, preFlipWrite>>
HealthGateway ==
    /\ pc \in {"health", "gateway"} /\ outcome = "running"
    /\ pc' = IF pc = "health" THEN "gateway" ELSE "count"
    /\ UNCHANGED <<promoted, rbMoved, rev, outVer, outGen, outTime, aheadVer, aheadTime, snapVer, snapGen, active, flipped, verifiedStale, lastCount, outcome, summary, queue, impLeft, rpcLeft, failLeft, retries, preFlipWrite>>
Count ==  \* the activation stale count (and every catch-up re-count)
    /\ pc = "count" /\ outcome = "running"
    /\ lastCount' = StaleCount /\ rbMoved' = [p \in Pages |-> FALSE]
    /\ pc' = IF StaleCount = 0 THEN "commit"
             ELSE IF Design = "FIX" /\ retries < 3 THEN "catchup" ELSE "rbrestore"
    /\ UNCHANGED <<promoted, rev, outVer, outGen, outTime, aheadVer, aheadTime, snapVer, snapGen, active, flipped, verifiedStale, outcome, summary, queue, impLeft, rpcLeft, failLeft, retries, preFlipWrite>>
CatchUpRender ==   \* render the stale delta with the new image (ahead rows)
    /\ pc = "catchup" /\ outcome = "running" /\ Design = "FIX"
    /\ retries' = retries + 1
    /\ aheadVer' = [p \in Pages |-> IF FreshGen(p) THEN aheadVer[p] ELSE rev[p]]
    /\ aheadTime' = [p \in Pages |-> IF FreshGen(p) THEN aheadTime[p] ELSE "post"]
    /\ pc' = "restart"
    /\ UNCHANGED <<promoted, rbMoved, rev, outVer, outGen, outTime, snapVer, snapGen, active, flipped, verifiedStale, lastCount, outcome, summary, queue, impLeft, rpcLeft, failLeft, preFlipWrite>>
Restart ==   \* Deepwell restart promotes the catch-up ahead rows, then re-count
    /\ pc = "restart" /\ outcome = "running"
    /\ outVer' = [p \in Pages |-> IF aheadVer[p] = rev[p] THEN aheadVer[p] ELSE outVer[p]]
    /\ outGen' = [p \in Pages |-> IF aheadVer[p] = rev[p] THEN "new" ELSE outGen[p]]
    /\ outTime' = [p \in Pages |-> IF aheadVer[p] = rev[p] THEN aheadTime[p] ELSE outTime[p]]
    /\ aheadVer' = [p \in Pages |-> 0] /\ pc' = "count"
    /\ promoted' = [p \in Pages |-> promoted[p] \/ aheadVer[p] = rev[p]]
    /\ UNCHANGED <<rbMoved, rev, aheadTime, snapVer, snapGen, active, flipped, verifiedStale, lastCount, outcome, summary, queue, impLeft, rpcLeft, failLeft, retries, preFlipWrite>>
Commit ==   \* summary commit, then canary/proof; summary records lastCount
    /\ pc = "commit" /\ outcome = "running"
    /\ summary' = TRUE /\ pc' = "proof"
    /\ UNCHANGED <<promoted, rbMoved, rev, outVer, outGen, outTime, aheadVer, aheadTime, snapVer, snapGen, active, flipped, verifiedStale, lastCount, outcome, queue, impLeft, rpcLeft, failLeft, retries, preFlipWrite>>
Proof ==
    /\ pc = "proof" /\ outcome = "running"
    /\ outcome' = "activated" /\ pc' = "done"
    /\ UNCHANGED <<promoted, rbMoved, rev, outVer, outGen, outTime, aheadVer, aheadTime, snapVer, snapGen, active, flipped, verifiedStale, lastCount, summary, queue, impLeft, rpcLeft, failLeft, retries, preFlipWrite>>
PostFlipFail ==   \* health/gateway/canary/proof failure after the flip
    /\ pc \in {"health", "gateway", "count", "catchup", "restart", "commit", "proof"} /\ outcome = "running" /\ failLeft > 0
    /\ failLeft' = failLeft - 1 /\ pc' = "rbrestore" /\ rbMoved' = [p \in Pages |-> FALSE]
    /\ UNCHANGED <<promoted, rev, outVer, outGen, outTime, aheadVer, aheadTime, snapVer, snapGen, active, flipped, verifiedStale, lastCount, outcome, summary, queue, impLeft, rpcLeft, retries, preFlipWrite>>

\* --- Rollback (guarded restore in FIX, then recovery convergence) ---
RbRestore ==
    /\ pc = "rbrestore" /\ outcome = "running"
    /\ outVer' = [p \in Pages |-> IF outGen[p] = "new" /\ snapGen[p] = "old"
            /\ (Design = "CUR" \/ outTime[p] = "pre") THEN snapVer[p] ELSE outVer[p]]
    /\ outGen' = [p \in Pages |-> IF outGen[p] = "new" /\ snapGen[p] = "old"
            /\ (Design = "CUR" \/ outTime[p] = "pre") THEN snapGen[p] ELSE outGen[p]]
    /\ outTime' = [p \in Pages |-> IF outGen[p] = "new" /\ snapGen[p] = "old"
            /\ (Design = "CUR" \/ outTime[p] = "pre") THEN "pre" ELSE outTime[p]]
    /\ pc' = "rbup"
    /\ UNCHANGED <<promoted, rbMoved, rev, aheadVer, aheadTime, snapVer, snapGen, active, flipped, verifiedStale, lastCount, outcome, summary, queue, impLeft, rpcLeft, failLeft, retries, preFlipWrite>>
RbUp ==
    /\ pc = "rbup" /\ outcome = "running"
    /\ active' = "old"
    /\ IF Design = "CUR"
         THEN /\ outcome' = "rolledback" /\ pc' = "done"
         ELSE /\ pc' = "rbrender" /\ UNCHANGED outcome
    /\ UNCHANGED <<promoted, rbMoved, rev, outVer, outGen, outTime, aheadVer, aheadTime, snapVer, snapGen, flipped, verifiedStale, lastCount, summary, queue, impLeft, rpcLeft, failLeft, retries, preFlipWrite>>
RbRender ==   \* render the old build's stale delta with the old image
    /\ pc = "rbrender" /\ outcome = "running" /\ Design = "FIX"
    /\ aheadVer' = [p \in Pages |-> IF outGen[p] = "old" THEN aheadVer[p] ELSE rev[p]]
    /\ aheadTime' = [p \in Pages |-> "post"] /\ pc' = "rbrestart"
    /\ UNCHANGED <<promoted, rbMoved, rev, outVer, outGen, outTime, snapVer, snapGen, active, flipped, verifiedStale, lastCount, outcome, summary, queue, impLeft, rpcLeft, failLeft, retries, preFlipWrite>>
RbRestart ==   \* old Deepwell restart promotes them and its worker drains
              \* the bounded rerender queue (RSMQ survives: cache not parked)
    /\ pc = "rbrestart" /\ outcome = "running" /\ Design = "FIX"
    /\ outVer' = [p \in Pages |-> IF p = "p2" /\ queue > 0 THEN rev[p] ELSE IF aheadVer[p] = rev[p] THEN aheadVer[p] ELSE outVer[p]]
    /\ outGen' = [p \in Pages |-> IF p = "p2" /\ queue > 0 THEN "old" ELSE IF aheadVer[p] = rev[p] THEN "old" ELSE outGen[p]]
    /\ outTime' = [p \in Pages |-> IF aheadVer[p] = rev[p] THEN "post" ELSE outTime[p]]
    /\ aheadVer' = [p \in Pages |-> 0] /\ queue' = 0
    /\ outcome' = "rolledback" /\ pc' = "done"
    /\ UNCHANGED <<promoted, rbMoved, rev, aheadTime, snapVer, snapGen, active, flipped, verifiedStale, lastCount, summary, impLeft, rpcLeft, failLeft, retries, preFlipWrite>>

\* --- Writers ---
DbImport ==   \* direct SQL: any time, placeholder generator; its finalizer
              \* queues a dependent rerender (RSMQ in Valkey, not parked)
    /\ outcome = "running" /\ impLeft > 0
    /\ impLeft' = impLeft - 1 /\ preFlipWrite' = (preFlipWrite \/ ~flipped)
    /\ rev' = [rev EXCEPT !["p1"] = rev["p1"] + 1, !["p2"] = rev["p2"] + 1]
    /\ rbMoved' = [p \in Pages |-> TRUE]
    /\ outVer' = [outVer EXCEPT !["p1"] = 0]
    /\ outGen' = [outGen EXCEPT !["p1"] = "import"]
    /\ outTime' = [outTime EXCEPT !["p1"] = IF flipped THEN "post" ELSE "pre"]
    /\ aheadVer' = [aheadVer EXCEPT !["p1"] = 0]
    /\ queue' = IF queue < 2 THEN queue + 1 ELSE queue
    /\ UNCHANGED <<promoted, aheadTime, snapVer, snapGen, active, flipped, verifiedStale, lastCount, pc, outcome, summary, rpcLeft, failLeft, retries>>
RpcWrite ==   \* through the running Deepwell; renders with its generator
    /\ outcome = "running" /\ rpcLeft > 0 /\ active \in {"old", "new"}
    /\ rpcLeft' = rpcLeft - 1 /\ preFlipWrite' = (preFlipWrite \/ ~flipped)
    /\ rev' = [rev EXCEPT !["p1"] = rev["p1"] + 1, !["p2"] = rev["p2"] + 1]
    /\ rbMoved' = [p \in Pages |-> TRUE]
    /\ outVer' = [outVer EXCEPT !["p1"] = rev["p1"] + 1]
    /\ outGen' = [outGen EXCEPT !["p1"] = active]
    /\ outTime' = [outTime EXCEPT !["p1"] = IF flipped THEN "post" ELSE "pre"]
    /\ aheadVer' = [aheadVer EXCEPT !["p1"] = 0]
    /\ queue' = IF queue < 2 THEN queue + 1 ELSE queue
    /\ UNCHANGED <<promoted, aheadTime, snapVer, snapGen, active, flipped, verifiedStale, lastCount, pc, outcome, summary, impLeft, failLeft, retries>>
FanOut ==     \* deferred rerender of dependent p2 by the running Deepwell
    /\ outcome = "running" /\ queue > 0 /\ active \in {"old", "new"}
    /\ queue' = queue - 1
    /\ outVer' = [outVer EXCEPT !["p2"] = rev["p2"]]
    /\ outGen' = [outGen EXCEPT !["p2"] = active]
    /\ outTime' = [outTime EXCEPT !["p2"] = IF flipped THEN "post" ELSE "pre"]
    /\ aheadVer' = [aheadVer EXCEPT !["p2"] = 0]
    /\ UNCHANGED <<promoted, rbMoved, rev, aheadTime, snapVer, snapGen, active, flipped, verifiedStale, lastCount, pc, outcome, summary, impLeft, rpcLeft, failLeft, retries, preFlipWrite>>
PromoterNext == RenderOne \/ Verify \/ Snapshot \/ Park \/ Up \/ HealthGateway
                \/ Count \/ CatchUpRender \/ Restart \/ Commit \/ Proof
                \/ PostFlipFail \/ RbRestore \/ RbUp \/ RbRender \/ RbRestart
Next == PromoterNext \/ DbImport \/ RpcWrite \/ FanOut
Spec == Init /\ [][Next]_vars /\ WF_vars(PromoterNext)

\* --- Properties ---
TypeOK ==
    /\ active \in {"old", "new", "none"} /\ outcome \in {"running", "activated", "rolledback"}
    /\ \A p \in Pages : rev[p] \in 1..3 /\ outGen[p] \in {"old", "new", "import"}
\* Receipt cannot pass while the last count saw stale pages.
NoPassWithStale == summary => lastCount = 0
\* After rollback a page is either refused (not the old generator's
\* output) or reflects its latest inputs, scoped to inputs at rollback
\* entry (rbMoved): later writes are the fan-out/finalizer's, as always.
RollbackNoRegression ==
    outcome = "rolledback" =>
        \A p \in Pages : ~rbMoved[p] =>
            (outGen[p] = "old" => outVer[p] = rev[p])
Termination == <>(outcome \in {"activated", "rolledback"})
QuietSuccess == (Quiet /\ outcome = "running") ~> (outcome = "activated")
\* Restore-config property: any violation is a restore regression (a
\* promoted page served by the old build with older-than-input output).
RestoreRegressionFree ==
    ~(outcome = "rolledback" /\ \E p \in Pages :
        promoted[p] /\ ~rbMoved[p] /\ outGen[p] = "old" /\ outVer[p] < rev[p])
\* Incident-B shape (CUR only): clean verify, pre-flip write, rollback.
CleanVerifyNoRollback == ~(verifiedStale = 0 /\ preFlipWrite /\ outcome = "rolledback")
NeverRolledback == outcome # "rolledback"
=============================================================================
