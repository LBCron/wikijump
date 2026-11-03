--------------------------- MODULE EditLock ---------------------------
(***************************************************************************)
(* Wikidot edit-lock / save protocol (2026-11-02). Protocol only.        *)
(* Facts (PROBES.md as amended, PROBES2.md; FINDINGS.md has the table):  *)
(* opening a page hands out a lease (lock_id + lock_secret) with the     *)
(* base = the revision current at acquisition; the lease lives 900 s,    *)
(* expiry makes it acquirable but never invalidates the holder. A save   *)
(* decides, in this order: (1) a source-changing revision in the saver's *)
(* regions since the base -> page_changed + nonrecoverable; (2) a live   *)
(* lease conflicting with the save's mode that the presented credentials *)
(* do not match -> other_locks; (3) commit. "Moved" counts source        *)
(* revisions only, per region: meta revisions (tags, parent) advance     *)
(* latest but never move a base, and disjoint section commits do not     *)
(* move a section base. The presented revision_id is a request input:  *)
(* while the lease row exists it is not consulted and the base is the  *)
(* server-side acquisition base; once the row is gone the presented    *)
(* id is the operative base: equal to latest it commits (with          *)
(* re-creation), older or empty it rejects page_changed (PROBES3).     *)
(* A request's base and credentials come from that request's own       *)
(* parameters, never from session or row state a concurrent commit     *)
(* wrote. A dead token alone never rejects: with nothing conflicting   *)
(* and the source unmoved, the save                                    *)
(* re-creates the lease (lockRecreated). Every successful save, no-op    *)
(* included, releases the lease. Conflict matrix: page conflicts with    *)
(* everything, a section with itself and page, append with page and      *)
(* itself; disjoint sections and append+section coexist. Writers: tags   *)
(* and parent bypass (meta revisions), rename is blocked by a live       *)
(* lease, delete bypasses (the page goes; the holder's later save fails  *)
(* untyped, outside the outcome set), forced revert commits over a live  *)
(* lease and kills it. Import and mirror reconcile are system bypasses   *)
(* (constants of the deployment, not actions). This model's jobs are     *)
(* the atomic boundary (D5: with SaveAtomic, parallel saves under one    *)
(* lease commit exactly once, losers page_changed) and the lease-less    *)
(* closure (D8: with LeaselessOn, I3/I4 break, so every user surface     *)
(* must carry a lease).                                                  *)
(* Assumed: clients are sessions, not actors (a holder's second tab      *)
(* conflicts with itself); credentials are bearer tokens; append vs      *)
(* append conflicts (same-region writer, unobserved on live); rename     *)
(* is blocked by any live lease (observed for a page lease); the 900 s   *)
(* value, draft visibility, dialogs and permissions are out of the       *)
(* model (RULING-2 section 4). Lease ids are bounded and never reused    *)
(* within a trace. Save slots: two save requests per client may be in    *)
(* flight (P7 fired three; the 2-way re-run is the witnessed shape).     *)
(* Clients and Slots are configuration constants: the full-graph         *)
(* checks configure one save slot per client and client symmetry for     *)
(* the checks whose properties do not name a client; the P7 slot run     *)
(* configures two slots for one client, exhaustively. The only           *)
(* asymmetry in Init is the dummy client recorded                        *)
(* for never-issued leases, which no action or property reads while a    *)
(* lease row is unissued, so the symmetry quotient is faithful.          *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC
CONSTANTS SaveAtomic, LeaselessOn, AuxOn, OraclesOn, PresOn, MaxRev, MaxL, Clients, Slots, A, B, C
Modes == {"page", "s1", "s2", "append"}
Regions == {"s1", "s2", "app"}
LeaseIds == 1..MaxL
ClientSymm == Permutations(Clients)
RegOf(m) == CASE m = "s1" -> {"s1"} [] m = "s2" -> {"s2"}
              [] m = "append" -> {"app"} [] OTHER -> Regions
Conflicts(a, b) == a = "page" \/ b = "page" \/ a = b
VARIABLES lstate, lclient, lmode, lbase, nextL, chain, latest, regionRev,
          cid, csec, cmode, pres, contentBase, outcome, recreated,
          commits, spc, snapBase, snapMoved, snapConflict, snapCid,
          snapSec, snapMode, snapPres, commitCount, frzCount, pageGone,
          badOverwrite, badRival, badKill,
          reverted, renameBlocked, revertBlocked, didTags, didParent,
          decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase,
          slotOutcome
vars == <<lstate, lclient, lmode, lbase, nextL, chain, latest, regionRev,
          cid, csec, cmode, pres, contentBase, outcome, recreated,
          commits, spc, snapBase, snapMoved, snapConflict, snapCid,
          snapSec, snapMode, snapPres, commitCount, frzCount, pageGone,
          badOverwrite, badRival, badKill,
          reverted, renameBlocked, revertBlocked, didTags, didParent,
          decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase,
          slotOutcome>>
MovedFrom(base, m) == \E r \in RegOf(m) : regionRev[r] > base
LeaseConflictAt(m, id, secretOk) ==
    \E l \in LeaseIds : lstate[l] = "live" /\ Conflicts(lmode[l], m)
                        /\ ~(l = id /\ secretOk)
BaseOf(c) == IF cid[c] \in LeaseIds /\ lstate[cid[c]] # "none"
             THEN lbase[cid[c]] ELSE pres[c]
RowLive(c) == cid[c] \in LeaseIds /\ lstate[cid[c]] = "live"
RowExists(c) == cid[c] \in LeaseIds /\ lstate[cid[c]] # "none"
FrozenBaseOf(x) == IF snapCid[x] \in LeaseIds /\ lstate[snapCid[x]] # "none"
                   THEN lbase[snapCid[x]] ELSE snapPres[x]
ReqKey(x) == <<snapCid[x], snapPres[x]>>
DecideOutcome(moved, conflict) ==
    IF moved THEN "page_changed"
    ELSE IF conflict THEN "other_locks" ELSE "commit"
Init ==
    /\ lstate = [l \in LeaseIds |-> "none"] /\ lclient = [l \in LeaseIds |-> CHOOSE c \in Clients : TRUE]
    /\ lmode = [l \in LeaseIds |-> "page"] /\ lbase = [l \in LeaseIds |-> 0]
    /\ nextL = 1
    /\ chain = [i \in 0..MaxRev |-> IF i = 0 THEN "source" ELSE "none"]
    /\ latest = 0 /\ regionRev = [r \in Regions |-> 0]
    /\ cid = [c \in Clients |-> 0] /\ csec = [c \in Clients |-> FALSE]
    /\ cmode = [c \in Clients |-> "page"] /\ pres = [c \in Clients |-> 0]
    /\ contentBase = [c \in Clients |-> 0]
    /\ outcome = [c \in Clients |-> "none"] /\ recreated = [c \in Clients |-> FALSE]
    /\ commits = [c \in Clients |-> 0]
    /\ spc = [x \in Clients \X Slots |-> "idle"]
    /\ snapCid = [x \in Clients \X Slots |-> 0]
    /\ snapSec = [x \in Clients \X Slots |-> FALSE]
    /\ snapMode = [x \in Clients \X Slots |-> "page"]
    /\ snapPres = [x \in Clients \X Slots |-> 0]
    /\ snapBase = [x \in Clients \X Slots |-> 0]
    /\ snapMoved = [x \in Clients \X Slots |-> FALSE]
    /\ snapConflict = [x \in Clients \X Slots |-> FALSE]
    /\ commitCount = [l \in 0..MaxL |-> 0]
    /\ frzCount = [k \in (0..MaxL) \X (0..MaxRev) |-> 0]
    /\ slotOutcome = [x \in Clients \X Slots |-> "none"]
    /\ pageGone = FALSE /\ badOverwrite = FALSE /\ badRival = FALSE
    /\ badKill = FALSE /\ reverted = FALSE
    /\ renameBlocked = FALSE /\ revertBlocked = FALSE
    /\ didTags = FALSE /\ didParent = FALSE
    /\ decCtx = [c \in Clients |-> "none"] /\ commitDisjoint = FALSE
    /\ commitAfterMeta = FALSE /\ acqOverExpired = FALSE
    /\ expd = [c \in Clients |-> FALSE]
    /\ staleBase = [c \in Clients |-> 0]
\* --- Leases ---
Acquire(c, m) ==          \* granted only over non-conflicting live leases
    /\ ~pageGone /\ nextL <= MaxL
    /\ ~\E l \in LeaseIds : lstate[l] = "live" /\ Conflicts(lmode[l], m)
    /\ lstate' = [lstate EXCEPT ![nextL] = "live"]
    /\ lclient' = [lclient EXCEPT ![nextL] = c]
    /\ lmode' = [lmode EXCEPT ![nextL] = m]
    /\ lbase' = [lbase EXCEPT ![nextL] = latest]
    /\ nextL' = nextL + 1
    /\ cid' = [cid EXCEPT ![c] = nextL] /\ csec' = [csec EXCEPT ![c] = TRUE]
    /\ cmode' = [cmode EXCEPT ![c] = m] /\ pres' = [pres EXCEPT ![c] = latest]
    /\ contentBase' = IF AuxOn THEN [contentBase EXCEPT ![c] = latest] ELSE contentBase
    /\ acqOverExpired' = IF OraclesOn /\ (\E l \in LeaseIds : lstate[l] = "expired" /\ Conflicts(lmode[l], m)) THEN TRUE ELSE acqOverExpired
    /\ UNCHANGED <<chain, latest, regionRev, outcome, recreated, commits,
                   spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved, snapConflict, slotOutcome,
                   commitCount, frzCount, pageGone, badOverwrite, badRival, badKill,
                   reverted, renameBlocked, revertBlocked, didTags, didParent,
                   decCtx, commitDisjoint, commitAfterMeta, expd, staleBase>>
AcquireBlocked(c, m) ==   \* the conflict dialog: no lease is issued
    /\ \E l \in LeaseIds : lstate[l] = "live" /\ Conflicts(lmode[l], m)
    /\ outcome' = [outcome EXCEPT ![c] = "conflict"]
    /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, chain, latest,
                   regionRev, cid, csec, cmode, pres, contentBase, recreated,
                   commits, spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved, snapConflict, slotOutcome,
                   commitCount, frzCount, pageGone, badOverwrite, badRival, badKill,
                   reverted, renameBlocked, revertBlocked, didTags, didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
ForceAcquire(c, m) ==     \* removes every conflicting live lease, then issues
    /\ ~pageGone /\ nextL <= MaxL
    /\ lstate' = [l \in LeaseIds |-> IF l = nextL THEN "live"
                      ELSE IF lstate[l] = "live" /\ Conflicts(lmode[l], m)
                      THEN "none" ELSE lstate[l]]
    /\ lclient' = [lclient EXCEPT ![nextL] = c]
    /\ lmode' = [lmode EXCEPT ![nextL] = m]
    /\ lbase' = [lbase EXCEPT ![nextL] = latest]
    /\ nextL' = nextL + 1
    /\ cid' = [cid EXCEPT ![c] = nextL] /\ csec' = [csec EXCEPT ![c] = TRUE]
    /\ cmode' = [cmode EXCEPT ![c] = m] /\ pres' = [pres EXCEPT ![c] = latest]
    /\ contentBase' = IF AuxOn THEN [contentBase EXCEPT ![c] = latest] ELSE contentBase
    /\ UNCHANGED <<chain, latest, regionRev, outcome, recreated, commits,
                   spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved, snapConflict, slotOutcome,
                   commitCount, frzCount, pageGone, badOverwrite, badRival, badKill,
                   reverted, renameBlocked, revertBlocked, didTags, didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
Expire(l) ==
    /\ lstate[l] = "live" /\ lstate' = [lstate EXCEPT ![l] = "expired"]
    /\ expd' = IF AuxOn THEN [expd EXCEPT ![lclient[l]] = TRUE] ELSE expd
    /\ UNCHANGED <<lclient, lmode, lbase, nextL, chain, latest, regionRev,
                   cid, csec, cmode, pres, contentBase, outcome, recreated,
                   commits, spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved, snapConflict, slotOutcome,
                   commitCount, frzCount, pageGone, badOverwrite, badRival, badKill,
                   reverted, renameBlocked, revertBlocked, didTags, didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, staleBase>>
ReleaseNoSave(c) ==       \* removePageEditLock on the caller's own lease
    /\ RowExists(c) /\ lstate' = [lstate EXCEPT ![cid[c]] = "none"]
    /\ UNCHANGED <<lclient, lmode, lbase, nextL, chain, latest, regionRev,
                   cid, csec, cmode, pres, contentBase, outcome, recreated,
                   commits, spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved, snapConflict, slotOutcome,
                   commitCount, frzCount, pageGone, badOverwrite, badRival, badKill,
                   reverted, renameBlocked, revertBlocked, didTags, didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
Renew(c) ==               \* synchronize: never creates a revision
    /\ cid[c] >= 1
    /\ IF RowLive(c) /\ csec[c]
       THEN /\ outcome' = [outcome EXCEPT ![c] = "renewed"]
            /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, cid, csec,
                           recreated, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
       ELSE IF RowExists(c) /\ csec[c] /\ nextL <= MaxL
               /\ ~LeaseConflictAt(cmode[c], cid[c], csec[c])
       THEN /\ lstate' = [lstate EXCEPT ![cid[c]] = "none",
                                        ![nextL] = "live"]
            /\ lclient' = [lclient EXCEPT ![nextL] = c]
            /\ lmode' = [lmode EXCEPT ![nextL] = cmode[c]]
            /\ lbase' = [lbase EXCEPT ![nextL] = lbase[cid[c]]]
            /\ nextL' = nextL + 1 /\ cid' = [cid EXCEPT ![c] = nextL]
            /\ recreated' = [recreated EXCEPT ![c] = TRUE]
            /\ outcome' = [outcome EXCEPT ![c] = "renewed"]
            /\ UNCHANGED <<csec, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
       ELSE IF ~RowExists(c) /\ nextL <= MaxL
               /\ ~LeaseConflictAt(cmode[c], cid[c], csec[c])
       THEN /\ lstate' = [lstate EXCEPT ![nextL] = "live"]
            /\ lclient' = [lclient EXCEPT ![nextL] = c]
            /\ lmode' = [lmode EXCEPT ![nextL] = cmode[c]]
            /\ lbase' = [lbase EXCEPT ![nextL] = pres[c]]
            /\ nextL' = nextL + 1 /\ cid' = [cid EXCEPT ![c] = nextL]
            /\ recreated' = [recreated EXCEPT ![c] = TRUE]
            /\ outcome' = [outcome EXCEPT ![c] = "renewed"]
            /\ UNCHANGED <<csec, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
       ELSE /\ outcome' = [outcome EXCEPT ![c] = "other_locks"]
            /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, cid, csec,
                           recreated, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
    /\ UNCHANGED <<chain, latest, regionRev, cmode, pres, contentBase,
                   commits, spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved, snapConflict, slotOutcome,
                   commitCount, frzCount, pageGone, badOverwrite, badRival, badKill,
                   reverted, renameBlocked, revertBlocked, didTags, didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
\* --- Client-side presentations (the form's view of its credentials) ---
PresentStale(c) ==        \* presents an older / empty revision_id (probe G)
    /\ PresOn /\ RowLive(c) /\ pres' = [pres EXCEPT ![c] = 0]
    /\ staleBase' = [staleBase EXCEPT ![c] = lbase[cid[c]]]
    /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, chain, latest,
                   regionRev, cid, csec, cmode, contentBase, outcome,
                   recreated, commits, spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved,
                   snapConflict, slotOutcome, commitCount, frzCount, pageGone, badOverwrite,
                   badRival, badKill, reverted, renameBlocked, revertBlocked,
                   didTags, didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd>>
CorruptSecret(c) ==       \* presents the live id with a wrong secret
    /\ PresOn /\ RowLive(c) /\ csec' = [csec EXCEPT ![c] = FALSE]
    /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, chain, latest,
                   regionRev, cid, cmode, pres, contentBase, outcome,
                   recreated, commits, spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved,
                   snapConflict, slotOutcome, commitCount, frzCount, pageGone, badOverwrite,
                   badRival, badKill, reverted, renameBlocked, revertBlocked,
                   didTags, didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
ForgeId(c) ==             \* presents a never-issued lock_id
    /\ PresOn /\ \E l \in LeaseIds : lstate[l] = "none" /\ l # cid[c]
       /\ cid' = [cid EXCEPT ![c] = l] /\ csec' = [csec EXCEPT ![c] = FALSE]
    /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, chain, latest,
                   regionRev, cmode, pres, contentBase, outcome, recreated,
                   commits, spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved, snapConflict, slotOutcome,
                   commitCount, frzCount, pageGone, badOverwrite, badRival, badKill,
                   reverted, renameBlocked, revertBlocked, didTags, didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
ReadPage(c) ==            \* reads the page: content base and presented id move
    /\ PresOn /\ contentBase' = [contentBase EXCEPT ![c] = latest]
    /\ pres' = [pres EXCEPT ![c] = latest]
    /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, chain, latest,
                   regionRev, cid, csec, cmode, outcome, recreated, commits,
                   spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved, snapConflict, slotOutcome,
                   commitCount, frzCount, pageGone, badOverwrite, badRival, badKill,
                   reverted, renameBlocked, revertBlocked, didTags, didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
RefreshPres(c) ==         \* re-rendered form: presented id moves, content does not
    /\ PresOn /\ LeaselessOn /\ pres' = [pres EXCEPT ![c] = latest]
    /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, chain, latest,
                   regionRev, cid, csec, cmode, contentBase, outcome,
                   recreated, commits, spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved,
                   snapConflict, slotOutcome, commitCount, frzCount, pageGone, badOverwrite,
                   badRival, badKill, reverted, renameBlocked, revertBlocked,
                   didTags, didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
\* --- Saves ---
SaveBegin(c, s) ==        \* the request is formed: the whole request freezes here
    /\ spc[<<c, s>>] = "idle" /\ cid[c] >= 1 /\ latest < MaxRev
    /\ spc' = [spc EXCEPT ![<<c, s>>] = "begun"]
    /\ snapCid' = [snapCid EXCEPT ![<<c, s>>] = cid[c]]
    /\ snapSec' = [snapSec EXCEPT ![<<c, s>>] = csec[c]]
    /\ snapMode' = [snapMode EXCEPT ![<<c, s>>] = cmode[c]]
    /\ snapPres' = [snapPres EXCEPT ![<<c, s>>] = pres[c]]
    /\ snapBase' = IF SaveAtomic THEN snapBase
                   ELSE [snapBase EXCEPT ![<<c, s>>] =
                            IF cid[c] \in LeaseIds /\ lstate[cid[c]] # "none"
                            THEN lbase[cid[c]] ELSE pres[c]]
    /\ snapMoved' = IF SaveAtomic THEN snapMoved
                    ELSE [snapMoved EXCEPT ![<<c, s>>] =
                             MovedFrom(IF cid[c] \in LeaseIds
                                          /\ lstate[cid[c]] # "none"
                                       THEN lbase[cid[c]] ELSE pres[c],
                                       cmode[c])]
    /\ snapConflict' = IF SaveAtomic THEN snapConflict
                       ELSE [snapConflict EXCEPT ![<<c, s>>] =
                                LeaseConflictAt(cmode[c], cid[c], csec[c])]
    /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, chain, latest,
                   regionRev, cid, csec, cmode, pres, contentBase, outcome,
                   recreated, commits, commitCount, frzCount, pageGone,
                   badOverwrite, badRival, badKill, reverted, renameBlocked,
                   revertBlocked, didTags, didParent, decCtx, commitDisjoint,
                   commitAfterMeta, acqOverExpired, expd, staleBase, slotOutcome>>
SaveDecide(c, s) ==
    /\ spc[<<c, s>>] = "begun"
    /\ LET x == <<c, s>>
           base == IF SaveAtomic THEN FrozenBaseOf(x) ELSE snapBase[x]
           moved == IF SaveAtomic THEN MovedFrom(base, snapMode[x])
                    ELSE snapMoved[x]
           conflict == IF SaveAtomic
                       THEN LeaseConflictAt(snapMode[x], snapCid[x],
                                            snapSec[x])
                       ELSE snapConflict[x]
           oc == DecideOutcome(moved, conflict)
       IN IF pageGone
          THEN /\ slotOutcome' = IF AuxOn
                                 THEN [slotOutcome EXCEPT ![x] = "untyped"]
                                 ELSE slotOutcome
               /\ outcome' = [outcome EXCEPT ![c] = "untyped"]
               /\ spc' = [spc EXCEPT ![x] = "idle"]
               /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, chain,
                              latest, regionRev, cid, csec, cmode, pres,
                              contentBase, recreated, commits, snapBase,
                              snapMoved, snapConflict, snapCid, snapSec,
                              snapMode, snapPres, commitCount, frzCount,
                              pageGone, badOverwrite, badRival, badKill,
                              reverted, renameBlocked, revertBlocked,
                              didTags, didParent, decCtx, commitDisjoint,
                              commitAfterMeta, acqOverExpired, expd, staleBase>>
          ELSE IF oc # "commit"
          THEN /\ slotOutcome' = IF AuxOn
                                 THEN [slotOutcome EXCEPT ![x] = oc]
                                 ELSE slotOutcome
               /\ outcome' = [outcome EXCEPT ![c] = oc]
               /\ spc' = [spc EXCEPT ![x] = "idle"]
               /\ decCtx' = IF OraclesOn
                              THEN [decCtx EXCEPT ![c] =
                                       IF moved /\ conflict THEN "both"
                                       ELSE IF moved THEN "movedOnly"
                                       ELSE "conflictOnly"]
                              ELSE decCtx
               /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, chain,
                              latest, regionRev, cid, csec, cmode, pres,
                              contentBase, recreated, commits, snapBase,
                              snapMoved, snapConflict, snapCid, snapSec,
                              snapMode, snapPres, commitCount, frzCount,
                              pageGone, badOverwrite, badRival, badKill,
                              reverted, renameBlocked, revertBlocked,
                              didTags, didParent, commitDisjoint,
                              commitAfterMeta, acqOverExpired, expd, staleBase>>
          ELSE /\ latest < MaxRev
               /\ latest' = latest + 1
               /\ chain' = [chain EXCEPT ![latest + 1] = "source"]
               /\ regionRev' = [r \in Regions |->
                                   IF r \in RegOf(snapMode[x]) THEN latest + 1
                                   ELSE regionRev[r]]
               /\ badOverwrite' = IF MovedFrom(base, snapMode[x])
                                  THEN TRUE ELSE badOverwrite
               /\ badRival' = IF LeaseConflictAt(snapMode[x], snapCid[x],
                                                 snapSec[x])
                              THEN TRUE ELSE badRival
               /\ lstate' = IF snapCid[x] \in LeaseIds
                               /\ lstate[snapCid[x]] # "none"
                            THEN [lstate EXCEPT ![snapCid[x]] = "none"]
                            ELSE lstate
               /\ recreated' = IF snapCid[x] \in LeaseIds
                                  /\ lstate[snapCid[x]] = "live"
                               THEN recreated
                               ELSE [recreated EXCEPT ![c] = TRUE]
               /\ pres' = [pres EXCEPT ![c] = latest + 1]
               /\ slotOutcome' = IF AuxOn
                                 THEN [slotOutcome EXCEPT ![x] = "commit"]
                                 ELSE slotOutcome
               /\ commitCount' = [commitCount EXCEPT
                                     ![IF snapCid[x] \in LeaseIds
                                          /\ lstate[snapCid[x]] = "live"
                                       THEN snapCid[x] ELSE 0] =
                                     commitCount[IF snapCid[x] \in LeaseIds
                                                    /\ lstate[snapCid[x]] = "live"
                                                 THEN snapCid[x] ELSE 0] + 1]
               /\ frzCount' = [frzCount EXCEPT
                                  ![ReqKey(x)] = frzCount[ReqKey(x)] + 1]
               /\ commits' = IF AuxOn
                             THEN [commits EXCEPT ![c] = commits[c] + 1]
                             ELSE commits
               /\ outcome' = [outcome EXCEPT ![c] = "commit"]
               /\ spc' = [spc EXCEPT ![x] = "idle"]
               /\ decCtx' = IF OraclesOn
                            THEN [decCtx EXCEPT ![c] = "clean"] ELSE decCtx
               /\ commitDisjoint' = IF OraclesOn
                                       /\ (snapMode[x] = "s2"
                                           /\ regionRev["s1"] > base)
                                    THEN TRUE ELSE commitDisjoint
               /\ commitAfterMeta' = IF OraclesOn
                                        /\ (\E i \in 1..MaxRev : i > base
                                            /\ i <= latest /\ chain[i] = "meta")
                                     THEN TRUE ELSE commitAfterMeta
               /\ UNCHANGED <<lclient, lmode, lbase, nextL, cid, csec,
                              cmode, contentBase, snapBase, snapMoved,
                              snapConflict, snapCid, snapSec, snapMode,
                              snapPres, pageGone, badKill, reverted,
                              renameBlocked, revertBlocked, didTags,
                              didParent, acqOverExpired, expd, staleBase>>
NoopSave(c) ==            \* unchanged title+source: success, no revision
    /\ cid[c] >= 1 /\ ~pageGone
    /\ ~MovedFrom(BaseOf(c), cmode[c])
    /\ ~LeaseConflictAt(cmode[c], cid[c], csec[c])
    /\ outcome' = [outcome EXCEPT ![c] = "noop"]
    /\ lstate' = IF RowExists(c) THEN [lstate EXCEPT ![cid[c]] = "none"]
                 ELSE lstate
    /\ UNCHANGED <<lclient, lmode, lbase, nextL, chain, latest, regionRev,
                   cid, csec, cmode, pres, contentBase, recreated, commits,
                   spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved, snapConflict, slotOutcome,
                   commitCount, frzCount, pageGone, badOverwrite, badRival, badKill,
                   reverted, renameBlocked, revertBlocked, didTags, didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
LeaselessSave(c, m) ==    \* a user save with no lease (today's Wikijump shape)
    /\ LeaselessOn /\ cid[c] = 0 /\ ~pageGone /\ latest < MaxRev
    /\ pres[c] = latest
    /\ latest' = latest + 1 /\ chain' = [chain EXCEPT ![latest + 1] = "source"]
    /\ regionRev' = [r \in Regions |-> IF r \in RegOf(m) THEN latest + 1
                                        ELSE regionRev[r]]
    /\ badRival' = IF LeaseConflictAt(m, 0, FALSE) THEN TRUE ELSE badRival
    /\ badOverwrite' = badOverwrite
                       \/ (\E r \in RegOf(m) : regionRev[r] > contentBase[c])
    /\ outcome' = [outcome EXCEPT ![c] = "commit"]
    /\ commits' = IF AuxOn THEN [commits EXCEPT ![c] = commits[c] + 1] ELSE commits
    /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, cid, csec, cmode,
                   pres, contentBase, recreated, spc, snapCid, snapSec, snapMode, snapPres, snapBase,
                   snapMoved, snapConflict, slotOutcome, commitCount, frzCount, pageGone, badKill,
                   reverted, renameBlocked, revertBlocked, didTags, didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
\* --- Other writers ---
SetTags(c) ==             \* meta writer: bypasses leases, creates a meta revision
    /\ ~pageGone /\ latest < MaxRev
    /\ latest' = latest + 1 /\ chain' = [chain EXCEPT ![latest + 1] = "meta"]
    /\ didTags' = TRUE
    /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, regionRev, cid,
                   csec, cmode, pres, contentBase, outcome, recreated,
                   commits, spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved, snapConflict, slotOutcome,
                   commitCount, frzCount, pageGone, badOverwrite, badRival, badKill,
                   reverted, renameBlocked, revertBlocked, didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
ParentMeta(c) ==          \* parent metadata: same writer class as tags
    /\ ~pageGone /\ latest < MaxRev
    /\ latest' = latest + 1 /\ chain' = [chain EXCEPT ![latest + 1] = "meta"]
    /\ didParent' = TRUE
    /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, regionRev, cid,
                   csec, cmode, pres, contentBase, outcome, recreated,
                   commits, spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved, snapConflict, slotOutcome,
                   commitCount, frzCount, pageGone, badOverwrite, badRival, badKill,
                   reverted, renameBlocked, revertBlocked, didTags, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
Rename(c) ==              \* move: blocked by any live lease; a source revision
    /\ ~pageGone /\ latest < MaxRev
    /\ ~\E l \in LeaseIds : lstate[l] = "live"
    /\ latest' = latest + 1 /\ chain' = [chain EXCEPT ![latest + 1] = "source"]
    /\ regionRev' = [r \in Regions |-> latest + 1]
    /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, cid, csec, cmode,
                   pres, contentBase, outcome, recreated, commits, spc,
                   snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved, snapConflict, slotOutcome, commitCount, frzCount,
                   pageGone, badOverwrite, badRival, badKill, reverted,
                   renameBlocked, revertBlocked, didTags, didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
RenameBlocked(c) ==
    /\ \E l \in LeaseIds : lstate[l] = "live" /\ renameBlocked' = TRUE
    /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, chain, latest,
                   regionRev, cid, csec, cmode, pres, contentBase, outcome,
                   recreated, commits, spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved,
                   snapConflict, slotOutcome, commitCount, frzCount, pageGone, badOverwrite,
                   badRival, badKill, reverted, revertBlocked, didTags,
                   didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
RevertPost(l) == IF lstate[l] = "live" THEN "none" ELSE lstate[l]
RevertForce(c) ==         \* forced revert: commits over leases and kills them
    /\ ~pageGone /\ latest < MaxRev
    /\ latest' = latest + 1 /\ chain' = [chain EXCEPT ![latest + 1] = "source"]
    /\ regionRev' = [r \in Regions |-> latest + 1]
    /\ lstate' = [l \in LeaseIds |-> RevertPost(l)]
    /\ badKill' = IF (\E l \in LeaseIds : lstate[l] = "live" /\ RevertPost(l) = "live") THEN TRUE ELSE badKill
    /\ reverted' = TRUE
    /\ UNCHANGED <<lclient, lmode, lbase, nextL, cid, csec, cmode, pres,
                   contentBase, outcome, recreated, commits, spc, snapCid, snapSec, snapMode, snapPres,
                   snapBase, snapMoved, snapConflict, slotOutcome, commitCount, frzCount, pageGone,
                   badOverwrite, badRival, renameBlocked, revertBlocked,
                   didTags, didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
RevertBlocked(c) ==       \* revert without force, during a live lease
    /\ \E l \in LeaseIds : lstate[l] = "live" /\ revertBlocked' = TRUE
    /\ UNCHANGED <<lstate, lclient, lmode, lbase, nextL, chain, latest,
                   regionRev, cid, csec, cmode, pres, contentBase, outcome,
                   recreated, commits, spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved,
                   snapConflict, slotOutcome, commitCount, frzCount, pageGone, badOverwrite,
                   badRival, badKill, reverted, renameBlocked, didTags,
                   didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
Delete(c) ==              \* bypasses a live lease entirely: the page goes
    /\ ~pageGone /\ pageGone' = TRUE
    /\ lstate' = [l \in LeaseIds |-> "none"]
    /\ UNCHANGED <<lclient, lmode, lbase, nextL, chain, latest, regionRev,
                   cid, csec, cmode, pres, contentBase, outcome, recreated,
                   commits, spc, snapCid, snapSec, snapMode, snapPres, snapBase, snapMoved, snapConflict, slotOutcome,
                   commitCount, frzCount, badOverwrite, badRival, badKill, reverted,
                   renameBlocked, revertBlocked, didTags, didParent, decCtx, commitDisjoint, commitAfterMeta, acqOverExpired, expd, staleBase>>
LeaseNext == (\E c \in Clients, m \in Modes : Acquire(c, m)
               \/ ForceAcquire(c, m) \/ AcquireBlocked(c, m))
             \/ (\E c \in Clients : ReleaseNoSave(c) \/ Renew(c))
             \/ (\E l \in LeaseIds : Expire(l))
ClientNext == (\E c \in Clients : PresentStale(c) \/ CorruptSecret(c)
               \/ ForgeId(c) \/ ReadPage(c) \/ RefreshPres(c) \/ NoopSave(c))
              \/ (\E c \in Clients, s \in Slots : SaveBegin(c, s)
                  \/ SaveDecide(c, s))
              \/ (\E c \in Clients, m \in Modes : LeaselessSave(c, m))
WriterNext == \E c \in Clients : SetTags(c) \/ ParentMeta(c) \/ Rename(c)
              \/ RenameBlocked(c) \/ RevertForce(c) \/ RevertBlocked(c)
              \/ Delete(c)
Next == LeaseNext \/ ClientNext \/ WriterNext
Spec == Init /\ [][Next]_vars
\* --- Properties ---
TypeOK ==
    /\ lstate \in [LeaseIds -> {"none", "live", "expired"}]
    /\ lclient \in [LeaseIds -> Clients] /\ lmode \in [LeaseIds -> Modes]
    /\ lbase \in [LeaseIds -> 0..MaxRev] /\ nextL \in 1..(MaxL + 1)
    /\ chain \in [0..MaxRev -> {"source", "meta", "none"}]
    /\ latest \in 0..MaxRev /\ regionRev \in [Regions -> 0..MaxRev]
    /\ cid \in [Clients -> 0..MaxL] /\ csec \in [Clients -> BOOLEAN]
    /\ cmode \in [Clients -> Modes] /\ pres \in [Clients -> 0..MaxRev]
    /\ contentBase \in [Clients -> 0..MaxRev]
    /\ outcome \in [Clients -> {"none", "commit", "noop", "other_locks",
                                "page_changed", "conflict", "renewed",
                                "untyped"}]
    /\ commits \in [Clients -> 0..MaxRev]
    /\ commitCount \in [0..MaxL -> 0..MaxRev]
    /\ frzCount \in [(0..MaxL) \X (0..MaxRev) -> 0..MaxRev]
    /\ spc \in [Clients \X Slots -> {"idle", "begun"}]
    /\ snapCid \in [Clients \X Slots -> 0..MaxL]
    /\ snapSec \in [Clients \X Slots -> BOOLEAN]
    /\ snapMode \in [Clients \X Slots -> Modes]
    /\ snapPres \in [Clients \X Slots -> 0..MaxRev]
    /\ snapBase \in [Clients \X Slots -> 0..MaxRev]
    /\ snapMoved \in [Clients \X Slots -> BOOLEAN]
    /\ snapConflict \in [Clients \X Slots -> BOOLEAN]
    /\ slotOutcome \in [Clients \X Slots -> {"none", "commit", "noop",
                                "other_locks", "page_changed", "conflict",
                                "renewed", "untyped"}]
    /\ expd \in [Clients -> BOOLEAN]
    /\ staleBase \in [Clients -> 0..MaxRev]
\* I1 Exclusion: live leases never conflict, per the observed matrix.
Exclusion == \A a, b \in LeaseIds : a # b /\ lstate[a] = "live"
             /\ lstate[b] = "live" => ~Conflicts(lmode[a], lmode[b])
\* I2 Chain: linear, latest is max.
ChainLinear == chain[0] = "source"
    /\ \A i \in 1..MaxRev : (i <= latest) <=> (chain[i] # "none")
\* I3 NoSilentOverwrite: no commit lands over a source move in its regions.
NoSilentOverwrite == ~badOverwrite
\* I4 RivalBlocks: no commit lands while a conflicting lease is live.
RivalBlocks == ~badRival
\* D5 race form: commits riding one live lease row happen at most once.
\* (A commit through a re-created lease rides a new lease, not the row
\* its credentials named, and is counted under no row.)
OneCommitPerCreds == \A l \in LeaseIds : commitCount[l] <= 1
\* One request commits at most once: commits keyed by the frozen
\* (lock id, presented id) of the deciding request never exceed one.
\* Two requests of one client under two different leases (the P6
\* disjoint-section shape) carry different keys and may both commit;
\* a commit on a dead row still keys on its presented pair, so no
\* commit escapes the count.
OneCommitPerRequest == \A k \in (0..MaxL) \X (0..MaxRev) : frzCount[k] <= 1
\* I9: a source-changing writer that passes a live lease removes it.
SourceWriterKillsLease == ~badKill
\* I5 Total: save outcomes stay in the typed set; "untyped" only post-delete.
TotalOutcome == \A c \in Clients : outcome[c] = "untyped" => pageGone
\* Search prune for the WD witness configuration only: states on traces
\* that use an auxiliary event (expiry, delete, revert, a meta writer, a
\* blocked rename or revert) or record a non-commit save outcome. The
\* probe-D trace uses none of them, so its reachability is unaffected.
WitnessPrune ==
    /\ ~pageGone /\ ~reverted /\ ~renameBlocked /\ ~revertBlocked
    /\ ~didTags /\ ~didParent
    /\ \A l \in LeaseIds : lstate[l] # "expired"
    /\ \A c \in Clients : outcome[c] \in {"none", "commit"}
\* Mutation oracles: decide-time context, recorded so the checks do not
\* depend on which client a trace happened to name.
NeverDecideBothPC == ~(\E c \in Clients : decCtx[c] = "both"
                        /\ outcome[c] = "page_changed")
NeverCommitDisjoint == ~commitDisjoint
NeverCommitAfterMeta == ~commitAfterMeta
NeverAcqOverExpired == ~acqOverExpired
\* Non-vacuity witnesses (each must FAIL: the probed trace is reachable).
\* expd and staleBase are witness oracles in the same style as the
\* mutation oracles below: expd[c] records that a lease of c expired
\* (Aux-gated, like commits), staleBase[c] the base of the live row
\* when c presented a stale id. They pin the T2, WE2 and WG1
\* predicates to the probed shapes, which the outcome alone does not
\* (a force-kill or a fresh presentation reaches the same outcomes
\* by a shorter trace).
NeverT1 == ~(outcome[A] = "commit" /\ commits[A] = 1 /\ latest >= 1)
NeverT2 == ~(outcome[A] = "commit" /\ commits[A] = 1 /\ expd[A])
NeverT3 == ~(outcome[B] = "commit" /\ commits[B] = 1
             /\ regionRev["s1"] >= 1 /\ latest = 2
             /\ \E l \in LeaseIds : lclient[l] = B /\ lmode[l] = "s2"
                                    /\ lbase[l] = 0
             /\ \E k \in LeaseIds : lclient[k] = A /\ lmode[k] = "s1"
                                    /\ lbase[k] = 0)
NeverT4 == ~(outcome[A] = "other_locks")
NeverT5 == ~(outcome[A] = "other_locks" /\ commits[B] = 0)
NeverT6 == ~(outcome[A] = "page_changed" /\ commits[B] = 1)
NeverT7 == ~(slotOutcome[<<A, 1>>] = "commit"
             /\ slotOutcome[<<A, 2>>] = "page_changed" /\ latest = 1)
NeverT8 == ~(outcome[A] = "page_changed" /\ reverted)
NeverWA == ~(outcome[A] = "page_changed"
             /\ \E l \in LeaseIds : lstate[l] = "live" /\ lclient[l] = B)
NeverWB == ~(outcome[A] = "commit" /\ recreated[A])
NeverWC1 == ~(outcome[A] = "commit" /\ didTags /\ latest >= 2)
NeverWC2 == ~(outcome[A] = "commit" /\ didParent /\ latest >= 2)
NeverWD == ~(outcome[A] = "commit" /\ outcome[B] = "commit"
             /\ outcome[C] = "commit" /\ latest = 3)
NeverWE1 == ~(outcome[A] = "page_changed" /\ commits[B] = 1)
NeverWE2 == ~(outcome[A] = "renewed" /\ recreated[A] /\ expd[A]
              /\ outcome[B] = "conflict" /\ latest = 0)
NeverWE3 == ~(outcome[A] = "other_locks" /\ commits[A] = 0
              /\ latest = 0
              /\ \E l \in LeaseIds : lstate[l] = "live" /\ lclient[l] = B)
NeverWF1 == ~(commits[A] = 2 /\ recreated[A])
NeverWF2 == ~(outcome[A] = "noop" /\ latest = 0
              /\ \E l \in LeaseIds : lstate[l] = "live" /\ lclient[l] = B)
NeverWG1 == ~(outcome[A] = "commit" /\ commits[A] = 1 /\ latest = 2
              /\ staleBase[A] >= 1 /\ didParent)
NeverWG2 == ~(outcome[A] = "other_locks" /\ commits[A] = 0
              /\ \E l \in LeaseIds : lstate[l] = "live" /\ lclient[l] = A)
NeverWG3 == ~(outcome[A] = "other_locks" /\ commits[A] = 0
              /\ cid[A] >= 1 /\ lstate[cid[A]] = "none"
              /\ \E l \in LeaseIds : lstate[l] = "live")
NeverWH1 == ~(pageGone /\ outcome[B] = "untyped")
NeverWH2 == ~(outcome[A] = "commit" /\ outcome[B] = "commit"
              /\ latest = 2
              /\ \E l \in LeaseIds : lmode[l] = "append" /\ lbase[l] = 0
              /\ \E k \in LeaseIds : lmode[k] \in {"s1", "s2"}
                                     /\ lbase[k] = 0)
NeverWH3 == ~(outcome[B] = "conflict"
              /\ \E l \in LeaseIds : lstate[l] = "live" /\ lmode[l] = "page")
NeverWX1 == ~(outcome[A] = "page_changed" /\ commits[A] = 1 /\ latest = 1)
NeverWX2 == ~(outcome[A] = "commit" /\ recreated[A] /\ latest = 2
              /\ commits[A] = 1 /\ commits[B] = 1)
NeverWX3 == ~(outcome[A] = "page_changed" /\ commits[A] = 1 /\ latest = 1)
NeverWP1 == ~(outcome[B] = "conflict" /\ commits[B] = 0 /\ latest = 0)
NeverWP5 == ~(outcome[A] = "conflict"
              /\ \E l \in LeaseIds : lstate[l] = "live" /\ lclient[l] = A)
NeverWRename == ~renameBlocked
NeverWRevert == ~revertBlocked
NeverWI8 == ~(\E a, b \in LeaseIds : lstate[a] = "expired"
              /\ lclient[a] = A /\ lstate[b] = "live" /\ lclient[b] = B)
=============================================================================
