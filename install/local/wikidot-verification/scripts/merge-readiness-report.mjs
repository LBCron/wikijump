#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

import {runCliIfMain} from '../src/cli-entry.mjs';
import {sha256Hex} from '../src/canonical-json.mjs';
import {sealJsonNoReplace} from '../src/standing-browser-parity-util.mjs';
import {STANDING_CANDIDATE_PARITY_ADMISSION_SCHEMA} from '../src/standing-browser-promotion-admission.mjs';

import { buildMergeReadiness, parseDeviationLog } from '../src/deviation-log.mjs';

export function parseArgs(argv) {
  const args = {
    output: null,
    branch: null,
    deviationLog: null,
    validators: [],
    runId: null,
    frozenCandidateCommit: null,
    prHead: null,
    candidateReviewFreeze: null,
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      return value;
    };
    if (arg === '--output' || arg === '--branch' || arg === '--deviation-log' || arg === '--run-id' || arg === '--frozen-candidate-commit' || arg === '--pr-head' || arg === '--candidate-review-freeze') {
      if (seen.has(arg)) throw new Error(`${arg} may be supplied only once`);
      seen.add(arg);
      const value = next();
      if (arg === '--output') args.output = value;
      else if (arg === '--branch') args.branch = value;
      else if (arg === '--deviation-log') args.deviationLog = value;
      else if (arg === '--run-id') args.runId = value;
      else if (arg === '--frozen-candidate-commit') args.frozenCandidateCommit = value;
      else if (arg === '--pr-head') args.prHead = value;
      else args.candidateReviewFreeze = value;
    }
    else if (arg === '--validator') {
      const value = next();
      const separator = value.indexOf('=');
      const name = separator > 0 ? value.slice(0, separator) : '';
      const file = separator > 0 ? value.slice(separator + 1) : '';
      if (!name || !file || args.validators.some((validator) => validator.name === name)) {
        throw new Error('--validator must use one unique non-empty name=FILE value');
      }
      args.validators.push({ name, file });
    } else if (arg === '--help' || arg === '-h') return {help: true};
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.output) throw new Error('--output is required');
  if (!args.runId) throw new Error('--run-id is required');
  for (const [name, value] of [["--frozen-candidate-commit", args.frozenCandidateCommit], ["--pr-head", args.prHead]]) {
    if (!/^[0-9a-f]{40}$/u.test(value ?? "") || /^(.)\1+$/u.test(value)) throw new Error(`${name} must be a real full Git commit`);
  }
  if (!args.candidateReviewFreeze) throw new Error('--candidate-review-freeze is required');
  const names = args.validators.map(({name}) => name);
  if (args.validators.length !== 4 || JSON.stringify([...names].sort()) !== JSON.stringify(['browser', 'candidate', 'cleanup', 'static'])) throw new Error('validators must be exactly static,candidate,browser,cleanup');
  return args;
}

export function verdictExitCode(verdict) {
  if (['wikijump.compatibility_final_zero_receipt.v1', 'wikijump_syntax_differential.identity_bound_verdict.v1', 'wikijump_syntax_differential.runtime_stack_cleanup.v1', STANDING_CANDIDATE_PARITY_ADMISSION_SCHEMA].includes(verdict?.schema)) {
    return verdict.status === 'pass' ? 0 : verdict.status === 'fail' ? 1 : 2;
  }
  if (Object.hasOwn(verdict ?? {}, 'exit_code')) {
    return Number.isInteger(verdict.exit_code) && verdict.exit_code >= 0 ? verdict.exit_code : 2;
  }
  const aggregate = verdict?.aggregate;
  if (aggregate !== null && typeof aggregate === 'object' && !Array.isArray(aggregate)) {
    if (Object.hasOwn(aggregate, 'unclassified') && (!Number.isInteger(aggregate.unclassified) || aggregate.unclassified < 0)) return 2;
    if (Object.hasOwn(aggregate, 'regressions') && !Array.isArray(aggregate.regressions)) return 2;
    if (Object.hasOwn(aggregate, 'fail') && (!Number.isInteger(aggregate.fail) || aggregate.fail < 0)) return 2;
    if (Number.isInteger(aggregate.unclassified) || Array.isArray(aggregate.regressions) || Number.isInteger(aggregate.fail)) {
      if (aggregate.unclassified > 0) return 2;
      return (aggregate.regressions?.length ?? 0) > 0 || aggregate.fail > 0 ? 1 : 0;
    }
  }
  return 2;
}

function readJsonInput(file, name) {
  const absolute = path.resolve(file);
  const bytes = fs.readFileSync(absolute);
  try {
    return {
      value: JSON.parse(bytes.toString('utf8')),
      reference: {path: absolute, sha256: sha256Hex(bytes)},
    };
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${error.message}`);
  }
}

export function verifyArtifactReference(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || typeof value.path !== 'string' || !path.isAbsolute(value.path) || !/^[0-9a-f]{64}$/u.test(value.sha256 ?? '')) {
    throw new Error(`${name} is not a named SHA-256 artifact`);
  }
  const stat = fs.lstatSync(value.path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${name} is not a regular file`);
  const bytes = fs.readFileSync(value.path);
  if (sha256Hex(bytes) !== value.sha256 || (value.bytes !== undefined && value.bytes !== bytes.length)) throw new Error(`${name} identity moved`);
  return {path: value.path, sha256: value.sha256};
}

function verifyArtifactList(value, name) {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${name} must name producer artifacts`);
  return value.map((artifact, index) => verifyArtifactReference(artifact, `${name}[${index}]`));
}

function readCandidateReviewFreeze(file, frozenCandidateCommit) {
  const {value, reference} = readJsonInput(file, 'candidate review freeze');
  const candidate = value?.candidate;
  if (value?.schema !== 'wikijump.standing_candidate_parity_identity.v1' || value?.status !== 'sealed' || typeof candidate?.run_id !== 'string' || candidate.run_id === '' || !/^[0-9a-f]{64}$/u.test(value.artifact_key ?? '') || candidate.wikijump_commit !== frozenCandidateCommit || !/^[0-9a-f]{40}$/u.test(candidate.wikijump_tree ?? '') || /^(.)\1+$/u.test(candidate.wikijump_tree)) {
    throw new Error('candidate review freeze is missing or does not bind the frozen candidate');
  }
  return {...reference, run_id: candidate.run_id, artifact_key: value.artifact_key, candidate_commit: candidate.wikijump_commit, candidate_tree: candidate.wikijump_tree};
}

function requirePassingStatic(value, frozenCandidateCommit) {
  if (value?.schema !== 'wikijump.compatibility_final_zero_receipt.v1' || value.status !== 'pass' || value.merge_commit !== frozenCandidateCommit || !value.counts || Object.values(value.counts).some((count) => count !== 0) || !value.inputs?.ledger || !value.inputs?.standing_matrix) throw new Error('static validator is not a passing final-zero receipt bound to the frozen PR head');
  verifyArtifactReference(value.inputs.ledger, 'final-zero ledger');
  verifyArtifactReference(value.inputs.standing_matrix, 'final-zero standing output');
  return value;
}

function requireCandidate(value, candidateRunId, frozenCandidateCommit, candidateArtifactKey) {
  const runtime = value?.binding?.runtime_identity;
  if (value?.schema !== 'wikijump_syntax_differential.identity_bound_verdict.v1' || value.status !== 'pass' || value.run_id !== candidateRunId || runtime?.wikijump_sha !== frozenCandidateCommit || !/^[0-9a-f]{40}$/u.test(runtime?.ftml_sha ?? '') || /^(.)\1+$/u.test(runtime.ftml_sha) || !/^[0-9a-f]{64}$/u.test(runtime?.dependency_lock_sha256 ?? '') || /^(.)\1+$/u.test(runtime.dependency_lock_sha256) || !/^[0-9a-f]{64}$/u.test(runtime?.executable_sha256 ?? '') || /^(.)\1+$/u.test(runtime.executable_sha256) || !/^[0-9a-f]{64}$/u.test(runtime?.runtime_config_sha256 ?? '') || /^(.)\1+$/u.test(runtime.runtime_config_sha256)) throw new Error('candidate validator is not a passing identity-bound receipt for the candidate run, source, dependencies, and PR head');
  const artifacts = verifyArtifactList(value.artifacts, 'candidate producer artifacts');
  if (value.binding?.artifact_key !== candidateArtifactKey) throw new Error('candidate validator is not bound to the frozen candidate artifact key');
  if (!value.binding?.candidate_manifest || !artifacts.some((artifact) => artifact.path === value.binding.candidate_manifest.path && artifact.sha256 === value.binding.candidate_manifest.sha256)) throw new Error('candidate validator has no bound candidate producer receipt');
  return value;
}

export function requireCleanup(value, candidateRunId, candidateVerdict) {
  if (value?.schema !== 'wikijump_syntax_differential.runtime_stack_cleanup.v1' || value.status !== 'pass' || value.run_id !== candidateRunId || value.run_root_removed !== true || value.public_absence_verified !== true || value.resources_released !== true || value.vacant !== true || value.browser_closed !== true || (value.compose_started === true && (value.compose_down_exit_code !== 0 || value.compose_down_signal !== null))) throw new Error('cleanup validator is not the passing runtime stack cleanup receipt for the candidate run');
  const after = value.resource_observation?.after;
  if (!after || Object.values(after).some((items) => !Array.isArray(items) || items.length !== 0)) throw new Error('cleanup validator does not prove resource absence after cleanup');
  const candidateReceipt = verifyArtifactReference(value.candidate_receipt, 'cleanup candidate receipt');
  if (candidateVerdict?.binding?.candidate_manifest?.path !== candidateReceipt.path || candidateVerdict.binding.candidate_manifest.sha256 !== candidateReceipt.sha256) throw new Error('cleanup receipt is not cryptographically bound to the candidate producer receipt');
  return value;
}

export function requireBrowser(value, candidateRunId, frozenCandidateCommit, candidateArtifactKey) {
  const hashes = [
    'candidate_parity_receipt_sha256', 'candidate_identity_sha256',
    'live_reference_sha256', 'live_completion_policy_sha256',
    'source_runner_sha256', 'source_observation_sha256',
    'source_execution_identity_sha256', 'parity.request_gate_final_sha256',
    'parity.runtime_identity_sha256', 'parity.ledger_sha256',
  ];
  const validHashes = hashes.every((name) => {
    const valueAtPath = name.split('.').reduce((current, key) => current?.[key], value);
    return /^[0-9a-f]{64}$/u.test(valueAtPath ?? '');
  });
  if (value?.schema !== STANDING_CANDIDATE_PARITY_ADMISSION_SCHEMA || value.status !== 'pass' || !validHashes) throw new Error('browser validator is not the source-owned standing-browser admission receipt');
  if (value.candidate?.wikijump_commit !== frozenCandidateCommit || value.candidate?.artifact_key !== candidateArtifactKey || !/^[0-9a-f]{40}$/u.test(value.candidate?.wikijump_tree ?? '') || !/^[0-9a-f]{40}$/u.test(value.candidate?.ftml_sha ?? '') || !Number.isSafeInteger(value.parity?.pairs_total) || value.parity.pairs_total <= 0 || !Number.isSafeInteger(value.parity?.local_artifacts_verified) || value.parity.local_artifacts_verified <= 0) throw new Error('browser admission is not bound to the frozen candidate run, artifact, and verified candidate artifacts');
  return value;
}

function validateValidator(name, value, {candidateRunId, frozenCandidateCommit, candidateArtifactKey, candidateVerdict}) {
  if (name === 'static') return requirePassingStatic(value, frozenCandidateCommit);
  if (name === 'candidate') return requireCandidate(value, candidateRunId, frozenCandidateCommit, candidateArtifactKey);
  if (name === 'browser') return requireBrowser(value, candidateRunId, frozenCandidateCommit, candidateArtifactKey);
  if (name === 'cleanup') return requireCleanup(value, candidateRunId, candidateVerdict);
  throw new Error(`unknown validator: ${name}`);
}

export function usage() {
  return 'Usage: merge-readiness-report.mjs --output <report.json> --run-id <merge-id> --frozen-candidate-commit <commit> --pr-head <commit> --candidate-review-freeze <identity.json> --validator static=FILE --validator candidate=FILE --validator browser=FILE --validator cleanup=FILE [--branch name] [--deviation-log <jsonl>]';
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const candidateReviewFreeze = readCandidateReviewFreeze(args.candidateReviewFreeze, args.frozenCandidateCommit);
  let candidateVerdict = null;
  const validators = args.validators.sort(({name: left}, {name: right}) => left.localeCompare(right)).map(({ name, file }) => {
    const {value: verdict, reference} = readJsonInput(file, `${name} validator`);
    validateValidator(name, verdict, {candidateRunId: candidateReviewFreeze.run_id, frozenCandidateCommit: args.frozenCandidateCommit, candidateArtifactKey: candidateReviewFreeze.artifact_key, candidateVerdict});
    if (name === 'candidate') candidateVerdict = verdict;
    return {name, exitCode: verdictExitCode(verdict), ...reference};
  });
  const parsed = args.deviationLog
    ? parseDeviationLog(fs.readFileSync(args.deviationLog, 'utf8'))
    : { entries: [], errors: [] };
  const report = buildMergeReadiness({
    runId: args.runId,
    branch: args.branch,
    validators,
    deviations: parsed.entries,
    logErrors: parsed.errors,
    frozenCandidateCommit: args.frozenCandidateCommit,
    prHead: args.prHead,
    candidateReviewFreeze,
  });
  await sealJsonNoReplace(args.output, report);
  console.log(JSON.stringify(report, null, 2));
  return report.merge_ready ? 0 : 1;
}

await runCliIfMain(import.meta.url, main, {
  onError: (error) => {
    console.error(error);
    return 2;
  },
});
