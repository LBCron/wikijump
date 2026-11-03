# Edit-lock / save protocol — findings

Model: `EditLock.tla` (622 lines). Runner: `check.sh` (composition:
invariants, witnesses, trace shapes), `check.sh mutations` (eight
one-element mutations). Anchors: `extract.py` (12 code facts checked,
exit 2 on drift; 3 lease-side facts listed PENDING, printed and never
treated as bindings). No production code was changed.

Evidence basis: the live sandbox probes in the Phase 4 record
(`PROBES.md` as amended by RULING-2 section 2, `PROBES2.md`, batches
of 2026-11-02, and `PROBES3.md`, 2026-11-03). Every quoted behaviour below was observed on
live Wikidot; nothing is taken from the fossil Wikidot codebase or
from documentation.

## The composition the probes pinned

Opening a page hands out a lease (`lock_id` + `lock_secret`) whose
base is the revision current at acquisition. The lease lives 900 s;
expiry makes it acquirable by others but never invalidates the
holder. A save is decided in a fixed order:

1. **Source moved** — a source-changing revision in the saver's
   regions since the acquisition base → reject `page_changed` +
   `nonrecoverable`. "Moved" counts source revisions only, per
   region: metadata revisions (tags, parent) advance `latest` but
   never move a base, and a disjoint section's commit does not move a
   section base.
2. **Lease conflict** — else, a live lease conflicting with the
   save's mode that the presented credentials do not match → reject
   `other_locks`. Credentials are verified: a wrong secret against
   one's own live lease, and a never-issued `lock_id` while any lock
   is live, both give `other_locks`.
3. **Else commit.** While the lease row exists, the `revision_id`
   the client presents is not consulted; the operative base is the
   server-side acquisition base. Once the row is gone (released by
   the holder's own save, or killed), the presented id *is* the
   operative base: equal to the current latest it commits (with
   re-creation), older or empty it rejects `page_changed`
   (PROBES3, all three predictions held sequentially, no
   concurrency). A dead, expired or superseded token alone never
   rejects: with nothing conflicting and the source unmoved, the
   save re-creates the lease (`lockRecreated: true`) and commits.

Every successful save, no-op included, **releases** the lease; a
later save on the same credentials succeeds only through
re-creation. Draft `synchronize` (renew) never creates a revision:
on an expired lease it re-creates it; on a superseded lease it is
rejected `other_locks`, exactly like a save.

Conflict matrix (which live leases block an acquisition or a save):
whole-page conflicts with every mode; a section conflicts with
itself and with whole-page; append conflicts with whole-page and
with itself; disjoint sections coexist, and append coexists with
section locks including the last section. Section locks are not
fixed line ranges: after another section's save grows, shrinks or
appends lines, a section save lands exactly on the re-located
section (probe D), so the per-region check needs no carve-out for
line shifts.

The RULING-2 outcome table, as witnessed by the model (T1–T8):

| Case | Lock state | Rival live | Base moved | Outcome |
|---|---|---|---|---|
| T1 normal save | own, live | no | no | commit |
| T2 (P4-Y) | own, expired | no | no | commit |
| T3 (P6 section) | own, live, disjoint | yes, disjoint | yes | commit |
| T4 (P2) | superseded | yes | no | `other_locks` |
| T5 (P4-X) | expired, then rival acquired | yes | no | `other_locks` |
| T6 (P3) | superseded | no (winner's save released it) | yes | `page_changed` |
| T7 (P7b losers) | released by the winner | no | yes | `page_changed` — witnessed over save slots since the RULING-3 fix below |
| T8 (P8-rb2) | killed by forced revert | no | yes | `page_changed` |

Probe-batch witnesses WA–WI8 cover batch 2 (A–H) plus round-1
acquisition behaviour (WP1 conflict dialog, WP5 self-conflict in a
second tab, WRename, WRevert, WI8): rejection priority when both
conditions hold (WA: `page_changed` wins), token re-creation (WB,
WE2, WF1), meta writers not moving the base (WC1 tags, WC2 parent),
section rebase with three committers (WD), expiry flows (WE1–WE3),
release on save and on no-op (WF1, WF2), presented-id not consulted
on a live row, and credential verification (WG1–WG3), delete bypass
and the append
conflict matrix (WH1–WH3). The PROBES3 presented-id batch is
witnessed by WX1–WX3: own release then old id → `page_changed`
(WX1); superseded then current-latest id → commit with
re-creation, landing on top of the rival's revision (WX2); dead
lease then empty id → `page_changed`, the empty id a non-matching
base rather than a wildcard or a lock error (WX3).

## Decisions D1–D8, as resolved

- **D1 check order:** source-moved first, lease conflict second
  (probe A: both conditions hold → `page_changed`). The model's
  `DecideOutcome` is exactly this order; mutation M2 swaps it and
  loses witness WA.
- **D2 meaning of "moved":** source-changing revisions only, per
  region (`MovedFrom` over `regionRev`). A raw latest-id check is
  mutation M1; it loses the P6 witness (T3) and the meta witnesses
  (WC1/WC2 class), which is the RULING-2 trap made mechanical:
  layering leases over today's `check_last_revision` would reject a
  holder after a tag edit and after a disjoint section commit.
- **D3 lease validity:** conflict-at-save, not token liveness.
  Expired rows are kept (an expired holder still commits, T2);
  a save or renew with a dead token and no conflicting live lease
  re-creates the lease (WB, WE2); credentials must match a live row
  the server issued (WG2, WG3); the presented revision id is
  ignored while the lease row exists (WG1) — and is the operative
  base once the row is gone (WX1–WX3).
- **D4 section base:** per-region check; ranges rebase onto the
  re-located section, reproducing probe D exactly, including after
  line shifts. No I3 carve-out was needed.
- **D5 atomic boundary:** with `SaveAtomic`, the lease check, the
  moved check and the insert decide on one snapshot; parallel saves
  under one lease commit at most once (`OneCommitPerCreds`) and no
  commit lands over a move or a rival (I3/I4). Mutation M4
  (`SaveAtomic = FALSE`, decide on the begin-time snapshot) breaks
  I3/I4. This is the page-row-lock requirement for the
  implementation: lease check, revision number and insert under one
  lock, with acquire and force on the same lock. The "commit at
  most once" half of this claim was **unproven until the RULING-3
  fix** (defect section below): the old invariant counted commits
  per lease row, and a commit on a dead row was tallied in the
  unchecked `commitCount[0]`. What proves it now: every commit is
  also tallied under the deciding request's frozen (lock id,
  presented id) pair with no escape bucket, and
  `OneCommitPerRequest` (no key exceeds one) is checked in the
  main run and exhaustively in the two-slot run; mutation M8
  (decide reading mutable client values) produces the double
  commit and breaks it.
- **D6 writer classes:** tags and parent metadata — bypass, and
  create *meta* revisions (probe C: they do create revisions on
  Wikidot; the model's `chain` kind is what keeps them from moving
  a base). Rename — blocked by any live lease (WRename). Delete —
  bypasses a live lease entirely; the page goes and the displaced
  holder's later save fails untyped, outside the save outcome set
  (WH1). Revert with force — passes a conflicting live lease,
  commits, and kills it (I9); revert without force is blocked
  (WRevert). Import and mirror reconcile — explicit system
  bypasses, deployment constants, not model actions.
- **D7 lifecycle edges:** release on every successful save
  including no-op (WF1, WF2); a second save on the same credentials
  works only via re-creation; renewing an expired lease re-creates
  it without a revision (WE2); renewing a superseded lease is
  `other_locks` (WE3).
- **D8 enforcement point:** in Deepwell, with the system-writer
  bypasses explicit. `LeaselessSave` (a user save carrying no
  lease — today's Wikijump shape) breaks I3 and I4 whenever it is
  enabled (mutation M6), so every user surface must carry a lease;
  a Framerail-only check cannot close paths that never present one.

## Results (check.sh, TLC 1.7.4)

Configurations are per-property: each run enables only the
variables and constants its property needs (the Aux/Pres/Oracles
gates in the spec freeze the rest), with client symmetry where the
property names no client. The main invariant run uses two clients
at one slot each: 5,945,716 distinct states (88 s), up from
4,650,252 (55 s) before the RULING-3 freeze — the growth is the
frozen request fields and the per-request commit tally. (A first
version of the fix also froze the begin-time server snapshot in
atomic runs and reached 8,563,116 states / 2m15 s; the snapshot
trio is still written only in the non-atomic configuration,
exactly as before the fix, since only that configuration's decide
reads it.) The three-client space is exercised by the WD witness
and the two-slot space by the slot run and WX1/WX3. The optional
rival run (two clients, two slots) was **dropped**: pruned as far
as the constants allow (symmetry on; Aux, Oracles and Pres off),
it still had 10,603,424 distinct states explored with 5.5 M
queued at a 150 s cutoff and no violation; it is recorded here as
unfinished, never as a pass. Witness WD additionally runs under a state constraint
(`WitnessPrune`) that removes only states its trace cannot use
(traces through expiry, delete, revert, meta writers, blocked
dialogs, or a non-commit outcome); the probe-D trace uses none of
them, and without the constraint the same configuration generated
over 14 million states in three minutes without finishing. Five
witnesses (T2, T3, WG1, WH2, WE2) additionally carry a trace-shape
check on the counterexample: their bare predicates also admit
shorter accidental traces (T2's was a force-acquire kill with no
expiry), so two witness-oracle variables — `expd` (the client's
lease expired at some point) and `staleBase` (the client presented
a stale id against a live row) — pin the final state to the probed
shape, and `check.sh` asserts it. No predicate was weakened; the
strengthened predicates still fail, on traces of the probed shape.

Final full run (2026-11-03, this machine, 8 workers): anchors 12
ok, 3 pending (the two RULING-2 §6 implementation steps and the
client-stop step, pending by design); composition branch 2m32s
total, exit 0; mutations branch 4m27s, exit 0; combined ≈ 6m59s.
The full-check budget for this model is 10 minutes by coordinator
decision (2026-11-03), superseding RULING-2's one-minute guidance
because the witness set grew; this fix adds as little toward it
as it can.

| Run | Result | Time |
| --- | --- | --- |
| Main invariants I1–I9 + `OneCommitPerRequest` (2 clients, MaxRev 2, MaxL 2, symmetry) | PASS, 5,945,716 distinct states | 88 s |
| Slot run: `OneCommitPerRequest` (1 client, 2 slots, MaxRev 2, MaxL 1) | PASS, 169,044 distinct states, exhaustive | 3 s |
| Outcome-table witnesses T1–T6, T8 | all reachable (EXPECTED-FAIL) | ≈1 s each |
| Witness T7 (P7b), restated over slots | reachable (EXPECTED-FAIL) | 2 s |
| Probe witnesses WA–WI8 (incl. WD under `WitnessPrune`) | all reachable (EXPECTED-FAIL) | ≈1 s each (WD 4 s) |
| PROBES3 witnesses WX1–WX3 | all reachable (EXPECTED-FAIL) | 1 s / 13 s / 1 s |
| Trace-shape checks T2, T3, WG1, WH2, WE2 | all "shape ok" | — |

Mutations (`check.sh mutations`, each exactly one element, M8
three):
M1 moved = raw latest (`latest > base`) → witnesses T3 and C1
unreachable; M2 rejection priority swapped → witness A unreachable;
M3 force keeps the displaced leases → I1 Exclusion fails; M4
`SaveAtomic = FALSE` → I3/I4 fail; M5 expired leases block
acquisition → the I8 witness reachable only through force, i.e.
plain acquisition over an expired lease is gone; M6
`LeaselessOn = TRUE` → I3/I4 fail; M7 forced revert leaves leases
in place → I9 fails; M8 decide reads the client's mutable values
instead of the frozen request → T7 unreachable and
`OneCommitPerRequest` fails (the double commit is back).

Mutation run results (same final run): mut-m1-t3 caught (218 s —
a full-graph unreachability proof at minimal constants: the
witnessed trace forces two clients, two leases, and two revisions,
so nothing remains to shrink); mut-m1-c1 caught (13 s, one client —
a meta revision plus one commit needs no second client);
mut-m2-a caught (15 s at MaxRev 1 — the both-context decide needs
one source-changing revision); mut-m3 caught (2 s); mut-m4 caught
(2 s); mut-m5 caught (10 s at MaxRev 1 — acquisition over an expired
lease needs no revision); mut-m6 caught (1 s); mut-m7 caught
(2 s); mut-m8-t7 caught (2 s — under M8 the slot witness is
unreachable over the whole two-slot graph); mut-m8-inv caught
(2 s — the frozen-pair tally reaches 2). One model-robustness fix was needed to run M7 at all:
`badKill'` in `RevertForce` was written as a disjunction
(`badKill' = badKill \/ (\E ...)`), and TLC's successor computation
reports the variable "not assigned" (exit 75) exactly when a
mutation makes that existential satisfiable; the semantically
identical IF form evaluates correctly in both the base and mutated
modules, so the base model now uses it.

## The T7 defect and its fix (RULING-3, 2026-11-03)

Witness T7 (the P7b shape: parallel saves under one lock — exactly
one commits, the losers get `page_changed`) was **not reachable**
in the model as first written, under either `SaveAtomic` setting,
verified exhaustively at reduced constants (29,194 / 28,042
distinct states) plus a partial run at full constants. The first
account of that failure — outcomes are recorded per client, not
per request, so the shape is "not visibly in the protocol
actions" — was **wrong**. The consult's ruling (RULING-3) found
the real defect in the protocol actions themselves: under
`SaveAtomic`, `SaveDecide` read the client's *mutable* `pres`,
`cid`, `csec` and `cmode`, so an in-flight request picked up
whatever the winner's commit had written into the client record
(the winner's commit updates `pres` to the new latest). The
loser's base therefore moved with the winner, its decide saw "not
moved", and the model predicted **two commits** where live
Wikidot gave exactly one. The comment on `SaveBegin` claimed
presented values froze there; in atomic mode they did not. The
alternative remedy — re-scoping T7 to the single-request shape
already covered by T6 and recording P7b as covered by the M4
demonstration — was rejected by the ruling as weakening: M4
shows a stale *server* snapshot breaking I3/I4, not that the
correct configuration produces the probed outcome, and P7b is
the only case where a holder's own commit released the lease and
its own stale request was then rejected.

The fix, as ruled: `SaveBegin` freezes the **whole request** —
lock id, secret validity, mode and presented id — per save slot,
in both `SaveAtomic` settings, and `SaveDecide` reads only that
frozen request plus current server state (row lookup, conflict,
moved, retirement, commit tally). Outcomes are additionally
recorded per slot (Aux-gated, so the main run carries no extra
history), and T7 is restated over two slots of one client: the
same frozen credentials and presented id in both slots, one
`commit`, the other `page_changed`, `latest = 1`, at MaxRev 2 —
exhaustively reachable now (the old MaxRev 1 configuration is
retired; at MaxRev 1 the commit branch's `latest < MaxRev` guard
had masked the second commit anyway). `OneCommitPerCreds` is
kept for the lease-row form and joined by
`OneCommitPerRequest` (above, D5), and mutation M8 reverts the
decide to mutable reads: it loses T7 and breaks the new
invariant, both caught. The ruling's gate probes (PROBES3) then
confirmed the presented-id rule the fix relies on, sequentially:
once the lease row is gone the presented id is the operative
base (WX1–WX3 above). No other witness changed its result under
the freeze; all stay per-client, as the ruling directed.

## Implementation-facing notes

- Today's `check_last_revision` compares only the client-supplied
  `last_revision_id`; it cannot stay as-is on lease-carrying saves
  (anchor: `deepwell/src/services/page/service.rs`). The lease save
  decides on the server-side acquisition base and the per-region
  source check (D1/D2) while the lease row exists, not on the
  presented id (probe G) — but the presented id must be taken as a
  request input and used as the operative base once the row is
  gone (PROBES3). A request's base and credentials come from that
  request's parameters, never from session or row state written
  by a concurrent commit.
- The typed outcome surface already exists from the S4 fix:
  `NotLatestRevisionId` (error 4303), with insert-time unique
  violations and deadlocks mapped onto it
  (`raise_if_revision_insert_conflict`). The lease-aware save
  builds its `page_changed` on that surface.
- In Wikijump today a tag write creates a *source* revision,
  because legacy set-tags delegates to `PageService::edit`
  (anchor: `deepwell/src/services/legacy_action.rs`). Under D2/D6
  it must become a meta writer, or every tag edit will reject the
  page's lock holder — the D2 trap, present in current code.
- The lease store must be a separate table: `PageLockService` is
  the administrative protection lock, not an edit lease (anchor:
  `deepwell/src/services/page_lock/service.rs`). The three PENDING
  anchors in `extract.py` are the RULING-2 section 6 steps 3 and 5
  surfaces (Deepwell lease core, lease-aware save, Ajax edit-open);
  they print as pending and become bindings only when those steps
  land.
- Import writes revisions through `PageRevisionService::create`
  directly, outside `PageService`'s guards (anchor:
  `deepwell/src/services/import/service.rs`) — the explicit system
  bypass D6/D8 assume; the lease checks must not be layered into
  that path.

## Assumed, and limits of the model

Recorded in the spec header and kept visible there: append versus
append conflicts (same-region writer; unobserved on live); rename
is blocked by any live lease (observed for a whole-page lease);
lease ids are bounded and never reused within a trace; P7 fired
three parallel saves, the model configures two save slots for the
witnesses that need concurrency. Out of the model per RULING-2
section 4: the 900 s value and the `since_last_input` offset,
dialog HTML and the `ok` envelope, permissions, line arithmetic
(probe D's rebase makes per-region state sufficient), and draft
visibility. File attach and the API path stay unobserved and
unmodeled (Wikijump has no XML-RPC server; attach is left as it is
today).
