------------------------ MODULE RerenderLifecycle ------------------------
(***************************************************************************)
(* Re-render / hosted text-block lifecycle (2026-11-02). Protocol only.   *)
(* Facts (FINDINGS.md Step 0): a text_block row (page,type,index) names    *)
(* one S3 object under a fresh UUID; rows are page-scoped, not revision-  *)
(* scoped, and compiled HTML reaches blocks only by (page,index) through  *)
(* WWS, never by object name. Replace = read previous names (inside       *)
(* add_blocks, after inputs were read), upload new, delete+insert rows    *)
(* in the caller's txn, commit, then post-commit delete of the old        *)
(* objects (no reference check; UUID uniqueness is the guard).            *)
(* rerender_inner: no lock/version check; duplicate jobs may run          *)
(* concurrently (RSMQ 30 s redelivery). WWS reader: DB lookup, then S3    *)
(* fetch (at most ReaderOn reads are modeled, bounded at 2). Clone: DB    *)
(* and bucket copies at separate moments unless paused. Restore rewrites  *)
(* only compiled columns of snapshot revisions, guarded in FIX by         *)
(* compiled_at < switch start (CUR: unguarded). Snapshot and the switch   *)
(* clock are separate moments in promote.py, so they are separate steps.  *)
(* Assumed: block type collapsed; compiled_at as pre/post switch start    *)
(* (app clock = DB clock); unpromoted render-ahead replacement, block-    *)
(* count change, and page-deletion delete_blocks argued in FINDINGS.md.   *)
(***************************************************************************)
EXTENDS Integers, FiniteSets
CONSTANTS RestoreDesign, ClonePaused, AllowCrash, CloneOn, RestoreOn,
          ReaderOn, DupOn, FanoutOn
Pages == {"p1", "p2"}         \* p2 depends on p1
Jobs == {"a", "b", "f"}       \* a,b: duplicate deliveries for p1; f: fan-out for p2
JobPage == [a |-> "p1", b |-> "p1", f |-> "p2"]
VARIABLES rev, rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk,
          objects, nextGen, jPc, jIn, jPrev, jNew, sPc, sPrev, sNew,
          saveDone, rPc, rGen, reads, miss, cPc, cloneGen, cloneObjs,
          cloneDone, snapOut, snapGen, snapRev, snapped, flipped,
          restored, rDone, crashLeft, crashed
vars == <<rev, rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk,
          objects, nextGen, jPc, jIn, jPrev, jNew, sPc, sPrev, sNew,
          saveDone, rPc, rGen, reads, miss, cPc, cloneGen, cloneObjs,
          cloneDone, snapOut, snapGen, snapRev, snapped, flipped,
          restored, rDone, crashLeft, crashed>>
Frozen == ClonePaused /\ cPc = "gotdb"   \* Deepwell paused for the clone
Init ==
    /\ rev = [p \in Pages |-> 1] /\ rowGen = [p1 |-> 0, p2 |-> 1]
    /\ blkVer = [p \in Pages |-> 1] /\ blkGen = [p \in Pages |-> "old"]
    /\ outRev = [p \in Pages |-> 1] /\ outVer = [p \in Pages |-> 1]
    /\ outTime = [p \in Pages |-> "pre"] /\ maxBlk = [p \in Pages |-> 1]
    /\ objects = {0, 1} /\ nextGen = 2
    /\ jPc = [j \in Jobs |-> IF j = "f" THEN "wait" ELSE "idle"]
    /\ jIn = [j \in Jobs |-> 0] /\ jPrev = [j \in Jobs |-> 0]
    /\ jNew = [j \in Jobs |-> 0]
    /\ sPc = "idle" /\ sPrev = 0 /\ sNew = 0 /\ saveDone = FALSE
    /\ rPc = "idle" /\ rGen = 0 /\ reads = 2 /\ miss = FALSE
    /\ cPc = "idle" /\ cloneGen = 0 /\ cloneObjs = {} /\ cloneDone = FALSE
    /\ snapOut = 0 /\ snapGen = "old" /\ snapRev = 0 /\ snapped = FALSE
    /\ flipped = FALSE /\ restored = FALSE /\ rDone = FALSE
    /\ crashLeft = 1 /\ crashed = FALSE
\* --- One hosted-block replacement (job j rendering JobPage[j]) ---
JobStart(j) ==    \* reads its inputs (latest revision) here
    /\ ~Frozen /\ jPc[j] = "idle"
    /\ (j = "b" => DupOn) /\ (j = "f" => FanoutOn)
    /\ (j # "b" \/ jPc["a"] \in {"read", "prev", "up", "committed", "crashed"})
    /\ jIn' = [jIn EXCEPT ![j] = rev[JobPage[j]]]
    /\ jPc' = [jPc EXCEPT ![j] = "read"]
    /\ UNCHANGED <<rev, rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk, objects, nextGen, jPrev, jNew, sPc, sPrev, sNew, saveDone, rPc, rGen, reads, miss, cPc, cloneGen, cloneObjs, cloneDone, snapOut, snapGen, snapRev, snapped, flipped, restored, rDone, crashLeft, crashed>>
JobPrev(j) ==     \* add_blocks reads the previous filenames, just before upload
    /\ ~Frozen /\ jPc[j] = "read"
    /\ jPrev' = [jPrev EXCEPT ![j] = rowGen[JobPage[j]]]
    /\ jPc' = [jPc EXCEPT ![j] = "prev"]
    /\ UNCHANGED <<rev, rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk, objects, nextGen, jIn, jNew, sPc, sPrev, sNew, saveDone, rPc, rGen, reads, miss, cPc, cloneGen, cloneObjs, cloneDone, snapOut, snapGen, snapRev, snapped, flipped, restored, rDone, crashLeft, crashed>>
JobUpload(j) ==   \* S3 upload: outside any DB transaction
    /\ ~Frozen /\ jPc[j] = "prev" /\ nextGen < 7
    /\ jNew' = [jNew EXCEPT ![j] = nextGen] /\ nextGen' = nextGen + 1
    /\ objects' = objects \cup {nextGen} /\ jPc' = [jPc EXCEPT ![j] = "up"]
    /\ UNCHANGED <<rev, rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk, jIn, jPrev, sPc, sPrev, sNew, saveDone, rPc, rGen, reads, miss, cPc, cloneGen, cloneObjs, cloneDone, snapOut, snapGen, snapRev, snapped, flipped, restored, rDone, crashLeft, crashed>>
JobCommit(j) ==   \* row switch + revision compiled columns, one DB commit
    /\ ~Frozen /\ jPc[j] = "up" /\ LET p == JobPage[j] IN
       /\ rowGen' = [rowGen EXCEPT ![p] = jNew[j]]
       /\ blkVer' = [blkVer EXCEPT ![p] = jIn[j]]
       /\ blkGen' = [blkGen EXCEPT ![p] = IF flipped THEN "new" ELSE "old"]
       /\ outRev' = [outRev EXCEPT ![p] = jIn[j]]
       /\ outVer' = [outVer EXCEPT ![p] = jIn[j]]
       /\ maxBlk' = [maxBlk EXCEPT ![p] = IF jIn[j] > maxBlk[p] THEN jIn[j] ELSE maxBlk[p]]
       /\ outTime' = [outTime EXCEPT ![p] = IF flipped THEN "post" ELSE outTime[p]]
    /\ jPc' = [jPc EXCEPT ![j] = "committed"]
    /\ restored' = IF JobPage[j] = "p1" THEN FALSE ELSE restored
    /\ UNCHANGED <<rev, objects, nextGen, jIn, jPrev, jNew, sPc, sPrev, sNew, saveDone, rPc, rGen, reads, miss, cPc, cloneGen, cloneObjs, cloneDone, snapOut, snapGen, snapRev, snapped, flipped, rDone, crashLeft, crashed>>
JobCleanup(j) ==  \* post-commit delete of the objects read as previous
    /\ ~Frozen /\ jPc[j] = "committed"
    /\ objects' = objects \ {jPrev[j]} /\ jPc' = [jPc EXCEPT ![j] = "done"]
    /\ UNCHANGED <<rev, rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk, nextGen, jIn, jPrev, jNew, sPc, sPrev, sNew, saveDone, rPc, rGen, reads, miss, cPc, cloneGen, cloneObjs, cloneDone, snapOut, snapGen, snapRev, snapped, flipped, restored, rDone, crashLeft, crashed>>
JobCrash(j) ==    \* crash between upload / commit / delete
    /\ AllowCrash /\ crashLeft > 0 /\ jPc[j] \in {"read", "prev", "up", "committed"}
    /\ crashLeft' = crashLeft - 1 /\ crashed' = TRUE
    /\ jPc' = [jPc EXCEPT ![j] = "crashed"]
    /\ UNCHANGED <<rev, rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk, objects, nextGen, jIn, jPrev, jNew, sPc, sPrev, sNew, saveDone, rPc, rGen, reads, miss, cPc, cloneGen, cloneObjs, cloneDone, snapOut, snapGen, snapRev, snapped, flipped, restored, rDone>>
\* --- Saver: one save on p1 (new revision; p2 inputs move with it) ---
SaveBegin ==      \* inputs read here; the block read is a later step
    /\ ~Frozen /\ sPc = "idle"
    /\ rev' = [p \in Pages |-> 2] /\ sPc' = "read"
    /\ UNCHANGED <<rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk, objects, nextGen, jPc, jIn, jPrev, jNew, sPrev, sNew, saveDone, rPc, rGen, reads, miss, cPc, cloneGen, cloneObjs, cloneDone, snapOut, snapGen, snapRev, snapped, flipped, restored, rDone, crashLeft, crashed>>
SavePrev ==       \* add_blocks reads the previous filenames for p1
    /\ ~Frozen /\ sPc = "read" /\ sPrev' = rowGen["p1"] /\ sPc' = "prev"
    /\ UNCHANGED <<rev, rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk, objects, nextGen, jPc, jIn, jPrev, jNew, sNew, saveDone, rPc, rGen, reads, miss, cPc, cloneGen, cloneObjs, cloneDone, snapOut, snapGen, snapRev, snapped, flipped, restored, rDone, crashLeft, crashed>>
SaveUpload ==
    /\ ~Frozen /\ sPc = "prev" /\ nextGen < 7
    /\ sNew' = nextGen /\ nextGen' = nextGen + 1
    /\ objects' = objects \cup {nextGen} /\ sPc' = "up"
    /\ UNCHANGED <<rev, rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk, jPc, jIn, jPrev, jNew, sPrev, saveDone, rPc, rGen, reads, miss, cPc, cloneGen, cloneObjs, cloneDone, snapOut, snapGen, snapRev, snapped, flipped, restored, rDone, crashLeft, crashed>>
SaveCommit ==     \* revision insert + block row switch in one commit; queues f
    /\ ~Frozen /\ sPc = "up"
    /\ rowGen' = [rowGen EXCEPT !["p1"] = sNew] /\ blkVer' = [blkVer EXCEPT !["p1"] = 2]
    /\ blkGen' = [blkGen EXCEPT !["p1"] = IF flipped THEN "new" ELSE "old"]
    /\ outRev' = [outRev EXCEPT !["p1"] = 2] /\ outVer' = [outVer EXCEPT !["p1"] = 2]
    /\ maxBlk' = [maxBlk EXCEPT !["p1"] = 2]
    /\ outTime' = [outTime EXCEPT !["p1"] = IF flipped THEN "post" ELSE outTime["p1"]]
    /\ jPc' = [jPc EXCEPT !["f"] = IF jPc["f"] = "wait" THEN "idle" ELSE jPc["f"]]
    /\ sPc' = "committed" /\ saveDone' = TRUE /\ restored' = FALSE
    /\ UNCHANGED <<rev, objects, nextGen, jIn, jPrev, jNew, sPrev, sNew, rPc, rGen, reads, miss, cPc, cloneGen, cloneObjs, cloneDone, snapOut, snapGen, snapRev, snapped, flipped, rDone, crashLeft, crashed>>
SaveCleanup ==
    /\ ~Frozen /\ sPc = "committed" /\ objects' = objects \ {sPrev} /\ sPc' = "done"
    /\ UNCHANGED <<rev, rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk, nextGen, jPc, jIn, jPrev, jNew, sPrev, sNew, saveDone, rPc, rGen, reads, miss, cPc, cloneGen, cloneObjs, cloneDone, snapOut, snapGen, snapRev, snapped, flipped, restored, rDone, crashLeft, crashed>>
\* --- Reader (WWS): DB lookup, then S3 fetch; at most 2 reads ---
ReadLookup ==
    /\ ReaderOn /\ reads > 0 /\ rPc = "idle" /\ rGen' = rowGen["p1"] /\ rPc' = "fetch"
    /\ UNCHANGED <<rev, rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk, objects, nextGen, jPc, jIn, jPrev, jNew, sPc, sPrev, sNew, saveDone, reads, miss, cPc, cloneGen, cloneObjs, cloneDone, snapOut, snapGen, snapRev, snapped, flipped, restored, rDone, crashLeft, crashed>>
ReadFetch ==
    /\ rPc = "fetch" /\ miss' = (miss \/ (rGen \notin objects)) /\ rPc' = "idle"
    /\ reads' = reads - 1
    /\ UNCHANGED <<rev, rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk, objects, nextGen, jPc, jIn, jPrev, jNew, sPc, sPrev, sNew, saveDone, rGen, cPc, cloneGen, cloneObjs, cloneDone, snapOut, snapGen, snapRev, snapped, flipped, restored, rDone, crashLeft, crashed>>
\* --- Clone: DB copy and bucket copy as separate steps ---
CloneDb ==
    /\ CloneOn /\ cPc = "idle" /\ cloneGen' = rowGen["p1"] /\ cPc' = "gotdb"
    /\ UNCHANGED <<rev, rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk, objects, nextGen, jPc, jIn, jPrev, jNew, sPc, sPrev, sNew, saveDone, rPc, rGen, reads, miss, cloneObjs, cloneDone, snapOut, snapGen, snapRev, snapped, flipped, restored, rDone, crashLeft, crashed>>
CloneBucket ==
    /\ cPc = "gotdb" /\ cloneObjs' = objects /\ cloneDone' = TRUE /\ cPc' = "done"
    /\ UNCHANGED <<rev, rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk, objects, nextGen, jPc, jIn, jPrev, jNew, sPc, sPrev, sNew, saveDone, rPc, rGen, reads, miss, cloneGen, snapOut, snapGen, snapRev, snapped, flipped, restored, rDone, crashLeft, crashed>>
\* --- Snapshot, switch start, restore (p1, claim b) ---
Snapshot ==       \* promote.py: snapshot the compiled output
    /\ RestoreOn /\ ~snapped
    /\ snapOut' = outVer["p1"] /\ snapGen' = blkGen["p1"] /\ snapRev' = outRev["p1"]
    /\ snapped' = TRUE
    /\ UNCHANGED <<rev, rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk, objects, nextGen, jPc, jIn, jPrev, jNew, sPc, sPrev, sNew, saveDone, rPc, rGen, reads, miss, cPc, cloneGen, cloneObjs, cloneDone, flipped, restored, rDone, crashLeft, crashed>>
SwitchStart ==    \* promote.py: DB clock read, then park and flip
    /\ snapped /\ ~flipped /\ flipped' = TRUE
    /\ UNCHANGED <<rev, rowGen, blkVer, blkGen, outRev, outVer, outTime, maxBlk, objects, nextGen, jPc, jIn, jPrev, jNew, sPc, sPrev, sNew, saveDone, rPc, rGen, reads, miss, cPc, cloneGen, cloneObjs, cloneDone, snapOut, snapGen, snapRev, snapped, restored, rDone, crashLeft, crashed>>
Restore ==    \* rewrites snapshot revisions' compiled columns only; blocks stay
    /\ flipped /\ ~rDone
    /\ restored' = (RestoreDesign = "CUR" \/ outTime["p1"] = "pre") /\ outRev["p1"] = snapRev
    /\ outVer' = [outVer EXCEPT !["p1"] = IF (RestoreDesign = "CUR" \/ outTime["p1"] = "pre") /\ outRev["p1"] = snapRev THEN snapOut ELSE outVer["p1"]]
    /\ rDone' = TRUE
    /\ UNCHANGED <<rev, rowGen, blkVer, blkGen, outRev, outTime, maxBlk, objects, nextGen, jPc, jIn, jPrev, jNew, sPc, sPrev, sNew, saveDone, rPc, rGen, reads, miss, cPc, cloneGen, cloneObjs, cloneDone, snapOut, snapGen, snapRev, snapped, flipped, crashLeft, crashed>>
JobNext == \E j \in Jobs : JobStart(j) \/ JobPrev(j) \/ JobUpload(j)
           \/ JobCommit(j) \/ JobCleanup(j) \/ JobCrash(j)
SaverNext == SaveBegin \/ SavePrev \/ SaveUpload \/ SaveCommit \/ SaveCleanup
Next == JobNext \/ SaverNext \/ ReadLookup \/ ReadFetch \/ CloneDb
        \/ CloneBucket \/ Snapshot \/ SwitchStart \/ Restore
Spec == Init /\ [][Next]_vars /\ WF_vars(JobNext \/ SaverNext)
\* --- Properties ---
TypeOK ==
    /\ \A p \in Pages : rev[p] \in 1..2 /\ blkVer[p] \in 1..2 /\ rowGen[p] \in 0..6
    /\ objects \subseteq 0..6 /\ nextGen \in 2..7 /\ crashLeft \in 0..1 /\ reads \in 0..2
\* Every committed row names an existing object (delete-only-when-unreferenced).
CommittedRowLive == \A p \in Pages : rowGen[p] \in objects
\* A reader following a lookup finds its object (a miss is the served 500).
NoDanglingRead == ~miss
\* An older job never overwrites newer committed output (block level).
NoResurrect == \A p \in Pages : blkVer[p] = maxBlk[p]
\* A paused clone names only blocks its bucket copy holds.
CloneConsistent == cloneDone => cloneGen \in cloneObjs
\* Restored output is paired with blocks of its own version and build.
RestorePairsOwnBlocks ==
    rDone => (restored => (blkVer["p1"] = snapOut /\ blkGen["p1"] = snapGen))
\* Fan-out settles after the save (checked with crashes disabled).
FanOutSettles == saveDone ~> (blkVer["p2"] = 2)
\* Non-vacuity witnesses (each must FAIL: the path is reachable).
NeverCrashed == ~crashed
NeverDupDone == ~(jPc["a"] = "done" /\ jPc["b"] = "done")
NeverRestored == ~rDone
NeverCloned == ~cloneDone
=============================================================================
