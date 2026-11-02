// Admitted target-acceptance instruments (post-closure successor anchors).
//
// TARGET_ACCEPTANCE_CONTRACT_SHA256 (src/target-acceptance-contract.mjs) is
// the live identity of the instrument that measures full package checks:
// src/session-server.mjs stamps it into every verdict, and campaign
// completion / visual finalization compare recorded results against it.
// The closure instrument's value is also a historical record: all 36
// archived accepted results of the frozen 2026-10-28 campaign carry it, and
// Check 1 (src/campaign-record-integrity.mjs) verifies them against the
// closure anchor TARGET_ACCEPTANCE_CONTRACT_CLOSURE_SHA256, which therefore
// never moves.
//
// An instrument change after closure is admitted by recording the new
// instrument HERE, never by moving the closure anchor. This registry is the
// complete, closed list of instruments whose measurements the current
// campaign machinery treats as comparable with the closure:
//   - Check 2's drift evaluation (src/post-closure-acceptance.mjs) fails a
//     successor admission evaluated under any instrument not in this list;
//   - campaign completion (src/campaign-completion.mjs) and visual
//     finalization (src/finalize-visual-acceptance.mjs) accept a recorded
//     result whose contract digest names the live instrument or an admitted
//     one, and reject any other as superseded.
// Admission is a deliberate, recorded act: each successor entry names its
// change and the equivalence basis for treating its measurements as
// comparable with the closure instrument's. An unrecorded instrument change
// is drift and fails Check 2 / C6.
//
// This module imports nothing on purpose: campaign-record-integrity imports
// campaign-completion, which imports finalize-visual-acceptance, so any
// placement inside that web would create an import cycle; and no module
// inside the session-server program closure may gain imports, or a future
// closure delta would stop being exactly the change it records.

// The closure instrument. Must equal TARGET_ACCEPTANCE_CONTRACT_CLOSURE_SHA256
// in src/campaign-record-integrity.mjs; tests/campaign-record-integrity.test.mjs
// pins both values and their equality.
export const TARGET_ACCEPTANCE_INSTRUMENT_CLOSURE_SHA256 = 'df8e0b532decad8636fc7d5488c44d6c08e0bdc525a02eae8330c19554487a0a';

export const TARGET_ACCEPTANCE_INSTRUMENT_SUCCESSORS = Object.freeze([
  Object.freeze({
    sha256: '1811b3b4bdb78d1d6a52584cd0f7c2bbaee39480498a9a017eb40498a4835131',
    admitted: '2026-11-02',
    change: 'session teardown only: session.close() closes the pages and the browser before the reference-replay servers, and ReferenceReplay.close() destroys its tracked sockets (the session teardown stall fix, owner-ordered 2026-11-02)',
    basis: 'teardown-only equivalence: every recorded value is computed and returned by the check call before close() runs, close() returns and writes nothing, and the reference-replay request handler is byte-identical, so no recorded measurement can change; only the instrument identity stamped into future verdicts moves',
  }),
]);

export const ADMITTED_TARGET_ACCEPTANCE_CONTRACT_SHA256S = Object.freeze([
  TARGET_ACCEPTANCE_INSTRUMENT_CLOSURE_SHA256,
  ...TARGET_ACCEPTANCE_INSTRUMENT_SUCCESSORS.map(entry => entry.sha256),
]);

export function isAdmittedTargetAcceptanceContract(sha256) {
  return ADMITTED_TARGET_ACCEPTANCE_CONTRACT_SHA256S.includes(sha256);
}
