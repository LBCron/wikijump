# Edit-lock / save protocol — findings

Model: `EditLock.tla` (525 lines). Runner: `check.sh` (composition:
invariants, witnesses, trace shapes), `check.sh mutations` (seven
one-element mutations). Anchors: `extract.py` (12 code facts checked,
exit 2 on drift; 3 lease-side facts listed PENDING, printed and never
treated as bindings). No production code was changed.

Evidence basis: the live sandbox probes in the Phase 4 record
(`PROBES.md` as amended by RULING-2 section 2, and `PROBES2.md`,
batches of 2026-11-02). Every quoted behaviour below was observed on
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
3. **Else commit.** The `revision_id` the client presents is not
   consulted; the operative base is the server-side acquisition base.
   A dead, expired or superseded token alone never rejects: with
   nothing conflicting and the source unmoved, the save re-creates
   the lease (`lockRecreated: true`) and commits.

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
| T7 (P7b losers) | released by the winner | no | yes | `page_changed` — see the witness defect below |
| T8 (P8-rb2) | killed by forced revert | no | yes | `page_changed` |

Probe-batch witnesses WA–WI8 cover batch 2 (A–H) plus round-1
acquisition behaviour (WP1 conflict dialog, WP5 self-conflict in a
second tab, WRename, WRevert, WI8): rejection priority when both
conditions hold (WA: `page_changed` wins), token re-creation (WB,
WE2, WF1), meta writers not moving the base (WC1 tags, WC2 parent),
section rebase with three committers (WD), expiry flows (WE1–WE3),
release on save and on no-op (WF1, WF2), presented-id ignored and
credential verification (WG1–WG3), delete bypass and the append
conflict matrix (WH1–WH3).

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
  ignored (WG1).
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
  lock, with acquire and force on the same lock.
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
property names no client. The main invariant run uses two clients:
the three-client graph at the same constants is 8,781,108 distinct
states (~3.3 min), and the three-client space is exercised by the
WD witness. Witness WD additionally runs under a state constraint
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
client-stop step, pending by design); composition branch 1m41s
total, exit 1 caused only by witness-T7 below; mutations branch
3m8s, exit 0; combined ≈ 4m49s.

| Run | Result | Time |
| --- | --- | --- |
| Main invariants I1–I9 (2 clients, MaxRev 2, MaxL 2, symmetry) | PASS, 4,650,252 distinct states | 55 s |
| Outcome-table witnesses T1–T6, T8 | all reachable (EXPECTED-FAIL) | ≈1 s each |
| Witness T7 (P7b) | NOT reachable — defect section below | 1 s |
| Probe witnesses WA–WI8 (incl. WD under `WitnessPrune`) | all reachable (EXPECTED-FAIL) | ≈1 s each (WD 4 s) |
| Trace-shape checks T2, T3, WG1, WH2, WE2 | all "shape ok" | — |

Mutations (`check.sh mutations`, each exactly one element):
M1 moved = raw latest (`latest > base`) → witnesses T3 and C1
unreachable; M2 rejection priority swapped → witness A unreachable;
M3 force keeps the displaced leases → I1 Exclusion fails; M4
`SaveAtomic = FALSE` → I3/I4 fail; M5 expired leases block
acquisition → the I8 witness reachable only through force, i.e.
plain acquisition over an expired lease is gone; M6
`LeaselessOn = TRUE` → I3/I4 fail; M7 forced revert leaves leases
in place → I9 fails.

Mutation run results (same final run): mut-m1-t3 caught (154 s —
a full-graph unreachability proof at minimal constants: the
witnessed trace forces two clients, two leases, and two revisions,
so nothing remains to shrink); mut-m1-c1 caught (9 s, one client —
a meta revision plus one commit needs no second client);
mut-m2-a caught (12 s at MaxRev 1 — the both-context decide needs
one source-changing revision); mut-m3 caught (1 s); mut-m4 caught
(1 s); mut-m5 caught (9 s at MaxRev 1 — acquisition over an expired
lease needs no revision); mut-m6 caught (1 s); mut-m7 caught
(1 s). One model-robustness fix was needed to run M7 at all:
`badKill'` in `RevertForce` was written as a disjunction
(`badKill' = badKill \/ (\E ...)`), and TLC's successor computation
reports the variable "not assigned" (exit 75) exactly when a
mutation makes that existential satisfiable; the semantically
identical IF form evaluates correctly in both the base and mutated
modules, so the base model now uses it.

## The T7 witness defect (unresolved; needs a decision)

Witness T7 (the P7b shape: parallel saves under one lock — exactly
one commits, the losers get `page_changed`) is **not reachable in
the model as written**, under either `SaveAtomic` setting, and
`check.sh` therefore fails on `witness-T7`. This was verified three
ways: exhaustive exploration of the non-atomic configuration at
reduced constants (28,042 distinct states, no violation), the
atomic configuration at the same constants (29,194 distinct
states, no violation) plus a partial atomic run at full constants
(14.3M states explored, no violation, stopped),
and the following structural argument. The predicate requires one
client to be both the trace's only committer (`commits[A] = 1`,
`latest = 1`) and a `page_changed` loser. But a commit by A sets
A's presented id to the new latest and retires A's lease row, so
every later base A can decide against is already past A's own
move — no later decide of A's can see "moved"; and any
`page_changed` decide before the commit is overwritten by the
commit's outcome. If the move is another client's commit instead,
A's own commit makes `latest = 2`. The probed shape has the losers
as *separate requests* of one session; the model records outcomes
and commit counts per client, not per request (per save slot), so
the shape cannot be expressed. The witness was not weakened and
the model was not tuned to force it. Remedies, for the coordinator
/ consult to choose: (1) give the model per-slot outcome and commit
records (slots already exist as save requests) and restate T7 over
slots — the faithful fix; (2) re-scope T7 to the single-request
shape already covered by T6, and record P7b as covered by the M4
demonstration instead. Until one is chosen, `witness-T7` stays in
`check.sh` as a failing check, and the rest of this result stands
on the other 28 witnesses.

## Implementation-facing notes

- Today's `check_last_revision` compares only the client-supplied
  `last_revision_id`; it cannot stay as-is on lease-carrying saves
  (anchor: `deepwell/src/services/page/service.rs`). The lease save
  decides on the server-side acquisition base and the per-region
  source check (D1/D2), not on the presented id (probe G).
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
