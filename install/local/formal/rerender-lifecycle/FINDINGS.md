# Re-render / hosted text-block lifecycle — findings

Model: `RerenderLifecycle.tla` (177 lines). Runner: `check.sh` (current
protocol, clone, restore and witness configurations), `check.sh mutations`
(four one-element mutations). Anchors: `extract.py` (17 code facts, exit 2
on drift). No production code was changed.

## Step 0 — what the code does (file:line anchors)

Terminology settled first, because two different stores are involved. The
**compiled text** store (`text` table) is content-addressed by hash
(`deepwell/src/services/text.rs:24-25,172-198`) and is named by revision
columns `compiled_body_html_hash` etc. and by ahead-row columns. The
**hosted text blocks** modeled here are different: a `text_block` row keyed
by `(block_type, page_id, block_index)` names exactly one S3 object
(`deepwell/src/models/text_block.rs:10-17`), and the object is served by WWS
at `/local--code/<page>/<n>` and the HTML-block routes.

1. **What references a text block?** Only `text_block` rows. The primary
   key is `(block_type, page_id, block_index)` and `s3_filename` is
   `unique` (`deepwell/src/models/text_block.rs:11-17`), so no two rows —
   on any page, in any revision — can name one object. References are
   page-scoped, **not revision-scoped**: nothing in the table ties a block
   to the revision that produced it. Object names are not
   content-addressed: every replacement mints
   `text-blocks/{page_id}/{type}/{Uuid::new_v4()}`
   (`deepwell/src/services/text_block/service.rs:224-228`). Revision
   columns and `page_revision_render_ahead` rows name compiled *text* by
   hash (`deepwell/src/models/page_revision.rs:28-34`,
   `deepwell/src/services/page_revision/render_ahead.rs:80-99`), never
   text-block objects.
2. **When does delete run, guarded how?** `add_blocks` reads the previous
   filenames (`text_block/service.rs:182-185`), uploads the new objects to
   S3 (outside the DB transaction, `service.rs:244-264`), deletes all rows
   for `(page, type)` and inserts the new rows in the caller's transaction
   (`service.rs:276-300`), and defers deletion of the old objects to a
   post-commit action (`service.rs:309-312` →
   `deepwell/src/services/context.rs:420-432,531-546`). Delete therefore
   runs **after** commit, one object at a time, and checks nothing: the
   deferred set is exactly the snapshot read before the replacement. The
   only protection is UUID uniqueness (anchor 1): a filename a cleanup
   deletes can never be re-inserted, so it cannot be a live row's object
   at delete time — unless the reader/cleanup race in finding F1 applies
   to a filename a reader already looked up. Failures of the DB phase
   delete the *new*, never-referenced objects instead
   (`service.rs:304-307`); a crash between commit and cleanup leaves
   orphans, not dangling rows (verified in the model, §Results).
3. **Can an older job commit after a newer one? Yes.** `rerender_inner`
   reads the latest revision with no lock
   (`deepwell/src/services/page_revision/service.rs:1426-1429`), renders,
   then updates that revision by id with no version or timestamp guard
   (`service.rs:1504-1549`). The revision update itself is safe against a
   newer save (it names the older revision's id), but its `add_blocks`
   calls replace the **page's** block rows, so an older job committing
   after a save overwrites the page's blocks with older content (finding
   F2). Nothing serializes jobs for a page: `rerender_skip`
   (`service.rs:1457-1465`, config `deepwell/src/config/object.rs:350-354`)
   only skips a job that starts after a recent update; two jobs that both
   started earlier both run. RSMQ visibility is 30 s
   (`deepwell/src/services/job/service.rs:31-41`): a job still running
   after 30 s is delivered again, and the worker
   (`deepwell/src/services/job/worker.rs:191-344`) has no per-page lock,
   so a redelivery and its first run genuinely execute `rerender_inner`
   concurrently. Process restart has the same shape.
4. **Other deleters of blocks.** (a) Page deletion: `delete_blocks`
   deletes the S3 objects **first, inside the still-open transaction**,
   then the rows (`text_block/service.rs:617-635`, called from
   `deepwell/src/services/page/service.rs:848-850`) — the opposite order
   from `add_blocks`; a later rollback leaves rows naming deleted
   objects. (b) Render-ahead replaces blocks through the same
   `add_blocks` path while writing its compiled columns to the ahead
   table (`render_ahead.rs:64-115`), so it deletes old objects **without
   moving the revision's `compiled_at`** (see claim (b)). (c) Failed
   uploads clean up only their own new objects (`service.rs:120-126`).
   Promotion and restore never touch `text_block` rows or objects (§claim
   (b)); `TextService::prune` deletes unreferenced compiled *text* only
   (`deepwell/src/services/text.rs:204-269`). Maintenance of the bucket
   itself is the rehearsal copy in `install/standing/promote.py:420-452`.
5. **Reader.** WWS resolves the page, asks Deepwell for
   `(index, s3_filename)` (`wws/src/handler/text_block.rs:168-265`,
   `deepwell/src/services/text_block/service.rs:452-519`), then HEADs and
   GETs the object from S3 as a separate step
   (`wws/src/handler/text_block.rs:293-382`). Lookup and fetch are not in
   one snapshot (the RPC runs at READ COMMITTED,
   `deepwell/src/api.rs:289-294,330-331`). A miss at fetch is a served
   error, not a fallback: `FallbackError::TextBlockS3Fetch` → HTTP 500
   (`wws/src/error/fallback.rs:87-99`). The article view path proper
   refuses output whose `compiled_generator` is stale
   (`deepwell/src/services/view/service.rs:507-516`) but does not fetch
   text-block objects; browsers fetch those through WWS afterwards.
6. **`compiled_at`; input snapshot.** `compiled_at` is `now()` stamped
   when the render *finishes* (`deepwell/src/services/render/service.rs:1277-1286`,
   app clock `deepwell/src/utils/time.rs:24-26`), in the same transaction
   as the block-row switch for `rerender_inner`. It is not taken at
   render start. `rerender_inner` does **not** read its inputs in one
   snapshot: revision, wikitext, score and layout are separate statements
   (`page_revision/service.rs:1426-1429,1361-1371`) in a READ COMMITTED
   transaction, so a save landing mid-render can be half-seen — the model
   abstracts a job's inputs as the version at its start step and notes
   this as a widening, not a narrowing, of the real races.

## Evidence verdict on the "#2095-class" claim

**Dropped: no recorded loss of text blocks was found.** Issue #2095 is
"compat: imported attachment inventory can diverge from materialized file
blobs and source Wikidot" — page *attachment* inventories, not hosted text
blocks. Its recorded closure event is a reviewed runbook tombstoning 21
`file` rows the #2625 audit classified as fixtures, through the ordinary
`file_delete` path as an operator action; only `scp-002/SCP.txt` changed
on Standing. That is operator action on attachments, not a render race,
and it neither records nor resembles a text-block loss. A repository
issue search for text-block loss found none either. The one *recorded*
text-block dangling event is #2650: a rehearsal whose database copy named
objects its object-store copy lacked, answering HTTP 500 on
`/local--code/...` — the clone shape modeled below — since fixed by
copying the bucket up front, adding the missing-block self-check, and
pausing Deepwell for the clone. No model trace in this file is claimed
to explain any incident; a trace shows a shape is possible.

## Results (check.sh, TLC 1.7.4)

Each configuration enables only the processes its property needs
(constants in `check.sh`); the reader is bounded to 2 reads. State counts
are TLC distinct states; times are per-config wall seconds (JVM start
included). `check.sh` exits 0; about 13–19 s wall in total (14 TLC JVM launches), largest single config 2 s, against the brief's ~5 s guidance.

| Config | Processes on | Result |
|---|---|---|
| committed (FIX, crash on) | jobs+saver | PASS `CommittedRowLive` (77,830) |
| restorefix (FIX) | job a+saver+restore | PASS `RestorePairsOwnBlocks` (952) |
| clonepaused | job a+saver+clone | PASS `CloneConsistent` (861) |
| settles (no crash) | jobs+saver | PASS `FanOutSettles` (569) |
| dangling | jobs+saver+reader | EXPECTED-FAIL `NoDanglingRead` (1,187), shape asserted |
| resurrect | jobs+saver | EXPECTED-FAIL `NoResurrect` (1,236), shape asserted |
| cloneunpaused | job a+saver+clone | EXPECTED-FAIL `CloneConsistent` (332), shape asserted |
| restorecur (CUR) | job a+saver+restore | EXPECTED-FAIL `RestorePairsOwnBlocks` (538), shape asserted |
| witnesses | per path | EXPECTED-FAIL `NeverCrashed` (30), `NeverDupDone` (2,084), `NeverRestored` (107), `NeverCloned` (61) |

Mutations (`check.sh mutations`, each exactly one element, each
EXPECTED-FAIL on its named property): MA delete-before-commit →
`CommittedRowLive` (122); MB restore guard removed →
`RestorePairsOwnBlocks` (406); MC skip the pause (`Frozen == FALSE`) →
`CloneConsistent` (315); MD drop the fresh-name guard (replacements
reuse the live object name) → `CommittedRowLive` (184). No mutation was
tuned: each failed on its first run as designed.

**F1 — reader miss (current protocol, finding).** `NoDanglingRead`
fails: a WWS lookup returns a live filename, the replacing job's
post-commit cleanup deletes that object, and the reader's S3 fetch then
misses (trace shape: lookup@4, delete@6, miss@7). User-visible effect: a
single `/local--code/<page>/<n>` or HTML-block request answers HTTP 500
(`TextBlockS3Fetch`); a retry succeeds. Window: one request's
lookup→fetch gap (duration unmeasured), opened by any replacement commit whose
cleanup lands inside it. Lasting effect: none — `CommittedRowLive`
passing proves every *committed* row always names a live object.

**F2 — older job overwrites newer blocks (current protocol, finding).**
`NoResurrect` fails at block level: a job that read revision 1's inputs
(including a 30 s RSMQ redelivery of a job still running) commits after
the save to revision 2, and its page-scoped block replacement puts
revision 1's blocks back while revision 2 stays latest (shape asserted:
newest committed first, then overwritten). The revision's compiled
columns are *not* regressed (the job updates revision 1 by id); only the
hosted blocks regress. User-visible effect: the page serves new article
HTML with old hosted CSS/HTML blocks. Window: any rerender in flight
across a save (window duration unmeasured; redelivery widens it in principle). Lasting
effect: until the next rerender of that page — nothing re-detects it.

Non-vacuity: crash, duplicate-delivery completion, restore and clone
completion are all reachable in the current design (witnesses above), so
the passes are not vacuous over unreachable paths. `FanOutSettles` is
checked with crashes disabled: a crash may strand a job (its blocks stay
at the previous committed set, which `CommittedRowLive` covers), and the
code's retry is the queue's, not a guarantee this model should assume.

**Limit of the model.** `JobCommit` models `add_blocks` as one step, but
`deepwell/src/services/text_block/service.rs:276-300` runs `delete_many`
and then `insert_many` as separate statements in READ COMMITTED
transactions, against primary key `(block_type, page_id, block_index)`.
The model covers commit orders that do not overlap in those statements.
When two write transactions do overlap there, Postgres semantics imply
the blocked DELETE finds nothing left to delete once the other commits,
and its INSERT then fails with a unique violation. That shape aborts a
job or possibly a save; it is not an overwrite. It has not been executed
or modeled: it is an unmodeled and unexecuted residual, it may be a
separate user-visible failure (a failed save or job), and any
production issue filed for F2 must test it.

## Verdicts on the two claims

**(a) Paused clone consistency — holds, with its exact scope.**
`deepwell_paused_for_clone` (`install/standing/promote.py:464-512`) says
a replacement uploads new objects, commits new rows, then deletes old
objects, so any paused instant is consistent, while copies taken at
different moments can disagree. The model confirms both halves for one
page's block set: clone-paused passes `CloneConsistent`; clone-unpaused
fails it with a trace whose order is the docstring's (database copy,
replacement commit + cleanup, bucket copy — the #2650 order). Two
qualifications the code adds: the consistency is per replacement *set*
(the reader race F1 means a live reader can still miss between lookup
and fetch even though every committed instant is consistent), and the
pause must actually stop the fan-out — `promote.py` verifies that from
log silence (`promote.py:487-495`), which the model takes as the
`Frozen` guard rather than proving it.

**(b) "No restored output can name deleted blocks" — the wording is
wrong; the safety is real for a different reason, and the guard is
load-bearing for pairing, not for naming.** Settled from the code:
restored compiled HTML cannot name a deleted *object* at all. HTML
reaches blocks only by `(page, index)` through WWS
(`wws/src/handler/text_block.rs:156-277`); the object name lives only in
the current `text_block` row, whose object is always live
(`CommittedRowLive`). The snapshot names compiled-text hashes and
`(page, index)` references, never UUIDs — so the parenthetical in
`promote.py:640-642` ("may have deleted the text blocks the snapshot
names") describes a naming relation that does not exist. The real
questions are pairing and count:
(i) **Pairing** — restored HTML served with *newer* block content.
Modeled as `RestorePairsOwnBlocks` (restored output's version and build
equal the blocks'): CUR violates it with the order snapshot → switch →
post-flip job commits new-build blocks → restore puts the snapshot
output back over them; FIX passes, because a post-flip `rerender_inner`
commits its block replacement and its `compiled_at` stamp in one
transaction (Step 0.6), so the guard (`install/standing/promote.py:627-664`;
clock at `promote.py:1592,1720-1723`) skips exactly those pages. The
model also splits snapshot from switch-start (they are separate moments,
`promote.py:1589-1593`): a job committing between them is restored, and
that is correct in the code — it rendered with the old build against the
snapshot revision, so its blocks pair with the restored output; a save
in that window creates a new revision the restore never touches
(modeled by the `outRev = snapRev` condition).
(ii) **Count** — restored HTML referencing a block index the current
rows no longer have (a post-flip render produced fewer blocks). Not
modeled (a second dimension; would double the block state). Reachable
by argument: block count is a render output (`text_block/service.rs:194-242`),
WWS answers a missing index with its Missing basic-error response
(`wws/src/handler/text_block.rs:186-204,243-263`), and the guard in (i)
excludes exactly the pages whose count a post-flip render could have
changed — so (ii) is covered by the same guard, for the same reason.
Gaps argued, not modeled: an *unpromoted* render-ahead pass replaces
blocks without moving the revision's `compiled_at` (Step 0.4b); ahead
promotion stamps `compiled_at` from the ahead row
(`deepwell/src/services/render/ahead.rs:299-319`), so the hole is only a
catch-up ahead render landing between flip and rollback before any
promotion — outside the guard's stated reasoning; and `delete_blocks`
(Step 0.4a) tombstones its page, which restore output never serves. The
guard assumes renderer-host and database clocks agree (Step 0.6).

## Findings needing production work (issues to file, not fixes)

Per the lane boundary these are stated as issues to file; nothing here
was fixed, and the model was not tuned to make any of them disappear.

1. **Older rerender jobs overwrite newer hosted blocks (F2).** An
   in-flight rerender (or its 30 s RSMQ redelivery) that commits after a
   save leaves the page's hosted blocks at the older revision's content
   while the article HTML is new, until some later rerender. Reproducing
   order, user-visible effect and window in §Results. Possible
   directions for the production issue: a per-page serialization or
   committed-version check in `rerender_inner`, or making the block
   replacement conditional on the revision still being latest. The
   issue must also test the unmodeled overlap residual in *Limit of
   the model* above (overlapping `delete_many`/`insert_many` may abort
   a save or job with a unique violation instead of overwriting).
2. **Reader 500 in the lookup→fetch gap (F1).** A `/local--code` or
   HTML-block request whose DB lookup races a replacement's post-commit
   cleanup answers one HTTP 500. Transient and self-healing on retry;
   file at low priority, or close as accepted if the coordinator judges
   a one-request 500 inside a millisecond window acceptable — the model
   proves no lasting corruption sits behind it.
3. **`delete_blocks` deletes objects before its transaction commits
   (Step 0.4a, code reading, not modeled).** A rollback after page
   deletion's S3 sweep leaves live `text_block` rows naming deleted
   objects (the inverse of the `add_blocks` order). Effect if hit:
   lasting `/local--code` misses for a page whose deletion was rolled
   back. File as a small order-swap issue (rows first, objects
   post-commit, as `add_blocks` already does).
4. **Claim (b) wording in `promote.py:640-642`.** The snapshot names no
   text blocks; correct the parenthetical to the pairing/count hazards
   in the (b) verdict when that file is next touched. Documentation
   only; the guard itself is correct and load-bearing (mutation MB).

## CRITERION-4 STATEMENT

The model changed what this lane concluded, in two places — and in one
place it confirmed, rather than produced, the conclusion:

- **Produced by the model:** F2 as a shape reachable in the model under
  the Step 0 assumptions; not observed in production. Step 0 reading
  established that blocks are page-scoped and jobs are unserialized, so
  an older-over-newer block overwrite was conceivable; only the model
  showed the code's own step order (input read, previous-name read,
  upload, commit, cleanup — with the previous-name read split per
  STEER-1) actually commits it, including through the redelivery path,
  while the revision columns stay correct. F1's exact window (lookup →
  cleanup → fetch, and *only* that window, since `CommittedRowLive`
  passes with crash and duplicates enabled) is likewise reachable in
  the model under the Step 0 assumptions; not observed in production.
- **Produced by Step 0 reading, confirmed by the model:** claim (a)
  (both halves reproduce, including the #2650 order) and the safety
  half of claim (b). The (b) *reframing* — naming is impossible, pairing
  and count are the real hazards — came from Step 0 code reading; the
  model then showed the guard is load-bearing for pairing (CUR fails,
  FIX passes, MB fails when the guard is removed).
- **Decision consequence:** because the model produced F1 and F2 with
  code-shaped traces and the mutations prove `check.sh` stays sensitive
  to the delete order, the fresh-name guard, the pause, and the restore
  guard, landing the spec is recommended. Had it only reproduced what
  Step 0 already showed, this statement would recommend deleting it.
