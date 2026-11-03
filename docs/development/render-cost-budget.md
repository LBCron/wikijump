# Render-wide cost budget

## Decision

Deepwell will give each top-level render one shared cost budget. The budget
will be created by `RenderService` and passed through every expansion that can
do work before, during, or after FTML rendering. A nested render will consume
the caller's budget; it will not create a fresh budget.

The budget is a small interface with one operation:

```rust
pub(super) trait RenderCostBudget {
    fn charge(&mut self, cost: RenderCost) -> Result<(), RenderBudgetExceeded>;
}
```

`RenderCost` is a value with named constructors for work already measured in
the renderer: source bytes scanned, rows examined, rows permission-checked,
module occurrences expanded, output bytes produced, and restoration work. The
implementation may store a scalar counter, but callers must not do arithmetic
on the counter or inspect its remaining value. A charge either succeeds or
returns a structured exhaustion reason containing the stage and operation.

The budget is a safety limit, not a wall-clock timer. Existing request
timeouts remain in force. The implementation must charge before an expensive
operation and must use saturating arithmetic when a size and count are
multiplied. An exhausted budget fails closed at the existing Wikidot-compatible
fallback for that operation; it must not return partial generated markup.

## Why one budget

The current limits protect separate pieces of work. They do not cover all
pre-FTML scans, repeated database lookups, whole-output string restoration, or
fresh budgets created by recursive selected-content rendering. A page can stay
under each local limit while doing excessive combined work.

The shared budget gives callers a single invariant:

> One render request, including all nested expansion, may spend at most its
> configured cost.

This is a Wikijump runtime policy. FTML continues to own syntax parsing and
syntax-rendering primitives. Deepwell owns the budget, query work, permission
work, output restoration, and operational failure handling.

## Interface and ownership

`RenderService` owns the external seam. It creates the budget once at the root
of `render_inner` and includes it in the existing render context. Existing
special-purpose limits remain useful as local shape limits, but they cannot
reset or increase the shared budget.

The following callers use the same budget:

- include expansion and selected-page content expansion;
- ListPages scanning, row selection, permission filtering, and row rendering;
- Pages, RatedPages, WantedPages, OrphanedPages, ChildPages,
  NextPage/PreviousPage, PageCalendar, NewPage, and MembershipByPassword;
- parser-recovery scans for ListPages, iftags, Rate, and legacy markers;
- output restorers for empty paragraphs and embed markers;
- parent-change rerender admission and work-queue enqueuing.

FTML receives no database, permission, site, or viewer dependency from this
design. The budget is passed at the Wikijump/FTML orchestration seam instead.

## Charging rules

Charge before starting the operation. Do not charge only after a query or scan
has returned, because the expensive operation may already have completed.

| Work | Charge basis | Findings covered |
| --- | --- | --- |
| Source and recovery scans | bytes visited plus candidate/range comparisons | #1152, #1153, #1155, #1160, #1192, #1194 |
| Nested selected-content rendering | nested render entry and all nested work from the shared budget | #1159 |
| Query and permission work | rows fetched, rows checked, and module occurrence | #1162, #1176, #1180, #1182, #1183, #1184, #1186, #1187, #1188, #1203 |
| Whole-output restoration | marker count multiplied by output bytes, with saturation | #1154, #1211, #1217 |
| Parent-change rerenders | affected parent count and queued render jobs, after the transaction commits | #1190 |
| NewPage format matching | not a Deepwell render charge; validate the user pattern before synchronous JavaScript execution | #1179 |

The charge must use the effective requested amount. A module with
`limit="1"` must not be charged as if it will render 250 rows merely because a
shared query helper fetches batches. A bounded query may still charge the
candidate rows it must inspect to find one authorized result.

The implementation must preserve the existing local limits while the shared
budget is introduced. A later change may remove a redundant local limit only
after a benchmark and a compatibility test show that the shared charge covers
the same work.

Issue #1179 is deliberately a separate Framerail input-validation fix. A
Deepwell render budget cannot stop a synchronous JavaScript regular expression
from blocking the SvelteKit event loop. The route must reject or replace that
operation at its own seam; it must not pretend that the render budget covers
it.

## Failure and observability

Budget exhaustion must identify the operation, stage, attempted charge, and
render identity in structured tracing. The rendered result uses the existing
fail-closed behavior for that operation. It must not expose hidden row counts,
permission state, or internal budget values to the viewer.

The render log records the configured budget, feature set, and the final
spent amount. It also records the first exhaustion reason when a render is
bounded. These fields are diagnostic evidence; they are not a new compatibility
classification and must not alter the frozen ListPages replay contract.

## Implementation order

1. Add the private budget type and root render-context plumbing with unit tests
   for successful charges, exhaustion, and saturating multiplication.
2. Move include expansion and selected-content rendering onto the shared
   budget. Add a regression proving that nested rendering cannot reset it.
3. Add charges to the pre-FTML scanners and output restorers. Replace repeated
   whole-string replacement with one bounded pass where the existing output
   remains identical.
4. Add charges and per-render memoization to runtime modules. Apply the
   effective row limit before query execution and keep permission filtering
   explicit.
5. Bound parent-change rerender admission and enqueue only after commit.
6. Reproduce every finding in the table with a focused regression, then run
   the affected module tests, the Deepwell suite, and the verifier checks.

The order keeps each change testable. It does not require a new generic query
framework or a second rendering service.

## Acceptance criteria

- The root render creates exactly one budget, and every nested render shares it.
- Each operation in the table charges before work begins and reports a
  structured exhaustion reason.
- Existing ListPages module, source, row, output, and include limits continue
  to apply. The frozen ListPages replay scope and acceptance records are not
  changed.
- The 22 findings above each have a regression that either demonstrates the
  bounded behavior or records why the operation remains unsupported.
- Repeated identical runtime modules use one per-render query result where the
  result is viewer- and site-scoped. Permission checks remain explicit.
- A bounded module does not fetch or render more rows than its effective limit
  unless the query must inspect additional candidates to find authorized rows;
  those candidates are charged.
- Output restoration has a bounded cost and does not perform one full-output
  replacement per marker.
- Parent rerender jobs are bounded and are enqueued only after a successful
  transaction commit.
- Focused regressions, `cargo fmt --check`, warnings-as-errors Clippy, and the
  relevant Deepwell and verifier suites pass. No FTML revision or ListPages
  reference input changes as part of this design.

## Non-goals

This decision does not add a CPU-time watchdog to every loop, move query or
permission logic into FTML, replace existing shape limits, or change the
ListPages acceptance denominator. It also does not close a security finding by
classification alone. Each behavior must be fixed or remain an explicit,
fail-closed limitation with evidence.
