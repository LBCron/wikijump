# ListPages scanner survivor oracle review — 2026-10-08

This is an **independent evidence-boundary review**, not a claim that the
remaining mutants are equivalent or that the audit owner is accepted.
The frozen scanner source SHA-256 is
`41c1f5132bd938cf8fb0fb4228767583b59b7529a1ad0fd7740376ebbdb9d30e`.
The reconciled `136 = 88 caught + 44 missed + 4 unviable` inventory and its
per-mutation identifiers are stored in
`/tmp/wj-1990-scanner-reconciled-20261008-final.json` (SHA-256
`682c45ee877925196197ac5965d919c7bb0c8d031e8028c4f051673a7dbfc527`).

## Independently supplied inputs and their limits

- `install/local/wikidot-verification/artifacts/listpages-campaign-matrix/corpus-invocation-cases.jsonl.gz`
  (SHA-256 `35fc15bac37c402b1da2f169d67bc27b47df4062a4c3e7fa7d38aa36337bc044`)
  contains 23,964 extracted source invocations: 23,280 marked executable,
  of which 23,220 are balanced and 60 are malformed (47 unclosed heads,
  13 missing module closers). **All 23,964 rows have `verification_status:
  pending-live`**. These are independently authored *source examples*, not
  frozen expected Wikidot outputs. Do not turn their contents into a
  behavioral oracle just because they came from a real wiki corpus.
- `install/local/wikidot-verification/artifacts/listpages-head-recovery-boundary-live-20260801.jsonl`
  (SHA-256 `3ea72047ae256c0ead89c5b248780245631ab9b4670f08334b9aadf2f0b6e545`)
  has 14 retained PagePreviewModule observations, including six cases named
  `final-unclosed-*` that still have a raw `[[/module]]` closer. These are
  **unclosed quoted head values**, not evidence of an absent module closer.
  Its baseline renders `ROW|main:about`; an unclosed unknown selector instead
  renders the default ListPages template. This corroborates head recovery,
  not the scanner's internal `consume_empty_tail` flag.
- `docs/wikidot-specifications/specifications/module/module-listpages.md`,
  particularly the head-recovery analysis around lines 482–491, distinguishes
  saved/live PagePreviewModule behavior from corpus-derived shapes. It does
  **not** justify equating every locally computed scanner flag with a Wikidot
  observable result.

The corpus's executable malformed sources and its live observations have
different authority: the former only establish real-world syntax occurrence.
An intentionally broad lexical screening found nine executable source
invocations containing both CSS/code-like and link/anchor-like tokens, but
that does **not** prove those tokens occupy the single projected-event context
needed to kill `scanner.rs:1645`; each candidate still needs parser-level
ownership inspection. In contrast, the archived `final-unclosed-*` live
matrix confirms behavior for unclosed **quoted arguments**, not the missing
`[[/module]]` branch relevant to `1912–1913`.

## Four unresolved conditional mutations

| Location | Surviving mutation | Proposed independent owner and missing evidence |
| --- | --- | --- |
| `scanner.rs:1645` | `&&` → `\|\|` | A projected module-shaped event inside exactly **one** of the original CSS or anchor literal ranges must not become executable. The existing guard requires absence from both. Confirm the exclusion rule with a frozen syntax/runtime reference; project and direct paths must be differentiated, otherwise a conventional scanner test is insufficient. |
| `scanner.rs:1912` | `\|\|` → `&&` | An unclosed/default-template ListPages opener should consume the immediate raw closer only to the extent actually observed by Wikidot, rather than deriving that expectation from `default_template` itself. |
| `scanner.rs:1912` | delete `!` | Exercise a nonempty versus empty module head in the **unclosed** recovery path, while keeping the surrounding source/real closer identical. Require an independently justified observable suffix boundary. |
| `scanner.rs:1913` | `&&` → `\|\|` | Exercise the case with nonempty head but no immediate raw closer, and separately the empty-head case with one. Check whether following executable ListPages modules are retained, not merely a private Boolean. |

The remaining 44 survivors comprise four possible behavior-owner gaps and 40 unresolved work-accounting mutations. The four behavioral candidates are **possible behavioral owner gaps**, not confirmed divergences.
The other 40 unresolved mutations change scanner work accounting, arithmetic,
or offsets; they still require bounded-resource/absolute-position owners.
The closed-module empty-tail mutations at 1743–1744 are caught by newer tests.

## Follow-up mutation-owner replay (2026-10-08)

A source-locked targeted replay of the two `scanner.rs:1890:43` suffix-end
translation mutations against the existing
`unclosed_at_marker_preservation_does_not_hide_a_later_valid_module` test
caught both. That test asserts the later module's absolute `start`,
`body_start`, `end`, original source slice, and work counters. This establishes
an internal absolute-offset ownership contract for the already represented
recovery case; it does **not** supply new live Wikidot output for malformed
module-closer behavior. The independently reconciled frontier is now
`136 = 90 caught + 42 missed + 4 unviable`, with 42 survivors still
unaccepted. The retained report is
`/tmp/wj-1990-scanner-reconciled-offset-recheck-20261008.json`.

## Reproduction and acceptance boundary

1. Preserve the frozen corpus and live-capture source hashes. Select a
   minimally different pair of inputs per conditional mutation; compare with
   Wikidot's *recorded* output or run an independently controlled Wikidot probe.
2. Only then add source-grounded assertions to the appropriate existing
   scanner/integration owner, and replay targeted `cargo-mutants` candidates.
3. Reconcile targeted outcomes by **mutation identity** (the reconciliation
   script was removed with the test-quality audit programme); do not sum
   retries as new inventory entries. Record any nonmonotonic compilation outcomes explicitly.
4. Keep the entire owner `replayed_unreviewed_survivors` until every survivor
   has a concrete independent disposition. Passing a new local test alone is
   insufficient to reclassify a mutation as equivalent or accepted.

## 2026-10-08 work-counter replay addendum

The projected quoted-continuation malformed-syntax test now asserts its exact
measured scanner work (`110` and `234`) and literal-range advance counts (`0`
and `1`) in addition to fail-closed behavior and linear upper bounds. Its
source-locked replay covered eight recovery accounting mutants: six were
caught and two substitutions at `scanner.rs:1590:71` and `scanner.rs:1591:41`
remained missed. Instrumentation showed `recovery_advances == 0` for both
fixtures, so those particular substitutions are not distinguished by these
cases. They remain unaccepted and among the outstanding survivors.

The reconciled inventory is now **136 = 96 caught + 36 missed + 4 unviable**.
Four behavioral candidates still require independent Wikidot evidence; the
remaining 32 work/arithmetic/offset candidates still need reviewed owners or
specific equivalent/unviable dispositions. No survivor is accepted by this
addendum.
