
export const DEVIATION_LOG_SCHEMA = 'wikijump_local_lab.deviation_log.v1';
export const MERGE_READINESS_SCHEMA = 'wikijump_local_lab.merge_readiness.v1';

const REVIEW_STATES = new Set(['pending', 'approved', 'rejected', 'withdrawn']);

export function parseDeviationLog(text) {
  const entries = [];
  const errors = [];
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  lines.forEach((line, index) => {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      errors.push({ line: index + 1, error: `invalid JSON: ${error.message}` });
      return;
    }
    for (const field of ['id', 'date', 'summary', 'reason', 'review_state']) {
      if (!entry[field]) errors.push({ line: index + 1, error: `missing field: ${field}` });
    }
    if (entry.review_state && !REVIEW_STATES.has(entry.review_state)) {
      errors.push({ line: index + 1, error: `unknown review_state: ${entry.review_state}` });
    }
    entries.push(entry);
  });
  return { entries, errors };
}

export function buildMergeReadiness({ runId, branch, validators, deviations, logErrors = [], frozenCandidateCommit = null, prHead = null, candidateReviewFreeze = null }) {
  const candidateRunId = candidateReviewFreeze?.run_id ?? null;
  const blockers = [];
  for (const validator of validators) {
    if (validator.exitCode !== 0) {
      blockers.push({
        kind: 'validator-failing',
        name: validator.name,
        detail: `exit code ${validator.exitCode}`,
      });
    }
  }
  for (const error of logErrors) {
    blockers.push({ kind: 'deviation-log-invalid', detail: `line ${error.line}: ${error.error}` });
  }
  for (const deviation of deviations) {
    if (deviation.review_state === 'pending') {
      blockers.push({ kind: 'deviation-unreviewed', id: deviation.id, detail: deviation.summary });
    }
    if (deviation.review_state === 'rejected') {
      blockers.push({ kind: 'deviation-rejected', id: deviation.id, detail: deviation.summary });
    }
  }
  if (frozenCandidateCommit !== null && prHead !== null && frozenCandidateCommit !== prHead) {
    blockers.push({
      kind: 'candidate-pr-head-mismatch',
      detail: `frozen candidate ${frozenCandidateCommit} differs from PR head ${prHead}`,
    });
  }
  return {
    schema: MERGE_READINESS_SCHEMA,
    run_id: runId,
    merge_run_id: runId,
    candidate_run_id: candidateRunId,
    branch,
    merge_ready: blockers.length === 0,
    blockers,
    validators: validators.map(({ name, exitCode, path, sha256 }) => ({
      name,
      exit_code: exitCode,
      ...(path === undefined ? {} : {path, sha256}),
    })),
    deviations: deviations.map(({ id, review_state }) => ({ id, review_state })),
    candidate_pr_binding: frozenCandidateCommit === null && prHead === null
      ? null
      : {frozen_candidate_commit: frozenCandidateCommit, pr_head: prHead, matched: frozenCandidateCommit === prHead},
    candidate_review_freeze: candidateReviewFreeze,
  };
}
