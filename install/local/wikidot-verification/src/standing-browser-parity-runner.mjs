import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SETTLE_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VIEWPORT,
  canaryForUrl,
  defaultCanaryPairs,
} from "./standing-browser-canaries.mjs";
import {
  DEFAULT_THRESHOLDS,
  STANDING_BROWSER_CAPTURE_SCHEMA,
  STANDING_BROWSER_PARITY_SCHEMA,
  assertRequestGateAbortAccounting,
  compareCaptures,
  validateLiveCompletionPolicy,
  validateRequestGateAborts,
  validateThresholds,
} from "./standing-browser-parity-contract.mjs";
import {
  captureBrowserParityObservation,
  observationArtifactName,
} from "./standing-browser-parity-observation.mjs";
import {
  DEFAULT_PARITY_BROWSER_ROOT,
  createParityBrowserControls,
  launchParityBrowser,
} from "./standing-browser-parity-browser-session.mjs";
import {
  buildCandidateParityReceipt,
  candidatePageOrigin,
  assertCandidateIdentityFresh,
  validateCandidateParityIdentity,
  validateCandidateParityReceipt,
} from "./standing-browser-parity-receipt.mjs";
import {
  buildLiveReferenceLedger,
  loadSealedLiveReference,
  validateLiveReferenceRecord,
} from "./standing-browser-parity-reference.mjs";
import {
  assertStableCandidateRuntimeIdentity,
  observeCandidateRuntimeIdentity,
} from "./standing-browser-runtime-identity.mjs";
import { collectCandidateExecutionIdentity } from "./standing-browser-execution-identity.mjs";
import {validateStandingRefreshReceipt} from "../../../standing/scripts/verify-standing-refresh.mjs";
import {
  createPrivateEmptyDirectory,
  readJsonObject,
  requireSha256,
  sealJsonNoReplace,
  sha256File,
  sha256Value,
} from "./standing-browser-parity-util.mjs";

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_LIVE_ORIGIN = "https://scp-wiki.wikidot.com";
const REFERENCE_LOCAL_ORIGIN = "https://scp-wiki.wikijump.localhost:18443";
const STANDING_LOCAL_ORIGIN = "https://scp-wiki.wikijump.localhost";
const STANDING_FILES_ORIGIN = "https://scp-wiki.wjfiles.localhost";

function nextArgument(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(value, flag) {
  if (!/^\d+$/u.test(value) || Number(value) <= 0) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value, flag) {
  if (!/^\d+$/u.test(value))
    throw new Error(`${flag} must be a non-negative integer`);
  return Number(value);
}

function parseViewport(value) {
  const match = /^(\d+)x(\d+)$/u.exec(value);
  if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) {
    throw new Error("--viewport must use WIDTHxHEIGHT with positive integers");
  }
  return { width: Number(match[1]), height: Number(match[2]) };
}

function exactHttpOrigin(value, flag) {
  const url = new URL(value);
  if (
    !new Set(["http:", "https:"]).has(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${flag} must be an exact unauthenticated HTTP(S) origin`);
  }
  return url.origin;
}

export function parseStandingBrowserParityArgs(argv) {
  const args = {
    mode: null,
    browserRoot: DEFAULT_PARITY_BROWSER_ROOT,
    browserExecutable: null,
    viewport: { ...DEFAULT_VIEWPORT },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    settleMs: DEFAULT_SETTLE_MS,
    liveOrigin: DEFAULT_LIVE_ORIGIN,
    sourceResponseCacheDir: null,
    sourceResponseCacheIdentity: null,
    sourceResponseCacheDocuments: false,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--mode") {
      args.mode = nextArgument(argv, index, flag);
      index += 1;
    } else if (flag === "--output-dir") {
      args.outputDir = path.resolve(nextArgument(argv, index, flag));
      index += 1;
    } else if (flag === "--browser-root") {
      args.browserRoot = path.resolve(nextArgument(argv, index, flag));
      index += 1;
    } else if (flag === "--browser-executable") {
      args.browserExecutable = path.resolve(nextArgument(argv, index, flag));
      index += 1;
    } else if (flag === "--viewport") {
      args.viewport = parseViewport(nextArgument(argv, index, flag));
      index += 1;
    } else if (flag === "--timeout-ms") {
      args.timeoutMs = positiveInteger(nextArgument(argv, index, flag), flag);
      index += 1;
    } else if (flag === "--settle-ms") {
      args.settleMs = nonNegativeInteger(nextArgument(argv, index, flag), flag);
      index += 1;
    } else if (flag === "--live-origin") {
      args.liveOrigin = exactHttpOrigin(nextArgument(argv, index, flag), flag);
      index += 1;
    } else if (flag === "--source-response-cache-dir") {
      args.sourceResponseCacheDir = path.resolve(nextArgument(argv, index, flag));
      index += 1;
    } else if (flag === "--source-response-cache-identity") {
      args.sourceResponseCacheIdentity = nextArgument(argv, index, flag);
      index += 1;
    } else if (flag === "--cache-source-documents") {
      args.sourceResponseCacheDocuments = true;
    } else if (flag === "--live-completion-policy") {
      args.liveCompletionPolicy = path.resolve(nextArgument(argv, index, flag));
      index += 1;
    } else if (flag === "--live-reference-capture-policy") {
      args.liveReferenceCapturePolicy = path.resolve(nextArgument(argv, index, flag));
      index += 1;
    } else if (flag === "--candidate-identity") {
      args.candidateIdentity = path.resolve(nextArgument(argv, index, flag));
      index += 1;
    } else if (flag === "--standing-refresh") {
      args.standingRefresh = path.resolve(nextArgument(argv, index, flag));
      index += 1;
    } else if (flag === "--live-reference-ledger") {
      args.liveReferenceLedger = path.resolve(nextArgument(argv, index, flag));
      index += 1;
    } else if (flag === "--live-reference-sha256") {
      args.liveReferenceSha256 = nextArgument(argv, index, flag);
      index += 1;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!args.outputDir) throw new Error("--output-dir is required");
  if (!new Set(["live-reference", "candidate", "standing"]).has(args.mode)) {
    throw new Error("--mode must be live-reference, candidate, or standing");
  }
  if (!args.liveCompletionPolicy) {
    throw new Error(
      "--live-completion-policy is required before any browser request",
    );
  }
  if (args.sourceResponseCacheDir !== null && args.sourceResponseCacheIdentity === null) throw new Error("--source-response-cache-identity is required with --source-response-cache-dir");
  if (args.sourceResponseCacheDir === null && args.sourceResponseCacheIdentity !== null) throw new Error("--source-response-cache-dir is required with --source-response-cache-identity");
  if (args.sourceResponseCacheDocuments && args.sourceResponseCacheDir === null) throw new Error("--cache-source-documents requires --source-response-cache-dir");
  if (args.mode === "live-reference" && args.sourceResponseCacheDir === null) throw new Error("live-reference mode requires --source-response-cache-dir");
  if (args.mode === "live-reference" && !args.sourceResponseCacheDocuments) throw new Error("live-reference mode requires --cache-source-documents");
  if (args.mode !== "live-reference" && args.sourceResponseCacheDocuments) throw new Error("--cache-source-documents is available only in live-reference mode");
  if (args.mode === "candidate" && !args.candidateIdentity) throw new Error("--candidate-identity is required in candidate mode");
  if (args.mode === "candidate" || args.mode === "standing") {
    for (const [flag, value] of [
      ["--live-reference-ledger", args.liveReferenceLedger],
      ["--live-reference-sha256", args.liveReferenceSha256],
    ]) {
      if (!value) throw new Error(`${flag} is required in candidate mode`);
    }
    requireSha256(args.liveReferenceSha256, "--live-reference-sha256");
  }
  if (args.mode === "standing") {
    if (!args.standingRefresh) throw new Error("--standing-refresh is required in standing mode");
    if (args.sourceResponseCacheDir === null) throw new Error("standing mode requires --source-response-cache-dir");
  }
  if (
    new Set(["live-reference", "standing"]).has(args.mode) &&
    args.liveOrigin !== DEFAULT_LIVE_ORIGIN
  ) {
    throw new Error(
      `--live-origin must remain ${DEFAULT_LIVE_ORIGIN} for the standing contract`,
    );
  }
  return args;
}

async function readPolicy(filePath) {
  const raw = await readJsonObject(filePath, "live completion policy");
  return {
    value: validateLiveCompletionPolicy(raw),
    sha256: await sha256File(filePath),
    filePath,
  };
}

async function readCandidateIdentity(filePath) {
  const raw = await readJsonObject(filePath, "candidate parity identity");
  return {
    value: validateCandidateParityIdentity(raw),
    sha256: await sha256File(filePath),
    filePath,
  };
}

async function readStandingRefresh(filePath) {
  const raw = await readJsonObject(filePath, "standing refresh receipt");
  return {
    value: validateStandingRefreshReceipt(raw),
    sha256: await sha256File(filePath),
    filePath,
  };
}

const LOCAL_CAPTURE_CONCURRENCY = 4;

async function captureSet({ browser, pairs, label, args }) {
  const captures = new Array(pairs.length);
  let next = 0;
  async function worker() {
    while (next < pairs.length) {
      const index = next;
      next += 1;
      const pair = pairs[index];
      const url = label === "live" ? pair.live_url : pair.local_url;
      const contract = canaryForUrl(url);
      captures[index] = await captureBrowserParityObservation({
        context: browser.context,
        url,
        label,
        index,
        outputDir: args.outputDir,
        contract,
        viewport: args.viewport,
        timeoutMs: args.timeoutMs,
        settleMs: args.settleMs,
        requestGateAttribution: browser.requestGateAttribution,
      });
    }
  }
  const concurrency = label === "live" ? 1 : Math.min(LOCAL_CAPTURE_CONCURRENCY, pairs.length);
  await Promise.all(Array.from({length: concurrency}, () => worker()));
  return captures;
}

function screenshotHash(screenshot, label) {
  if (!screenshot || typeof screenshot.sha256 !== "string") {
    throw new Error(`${label} screenshot was not captured`);
  }
  return requireSha256(screenshot.sha256, `${label} screenshot SHA-256`);
}

function comparisonContractForPair(pair) {
  const contract = canaryForUrl(pair.live_url);
  return contract
    ? { ...contract, comparison_scope: "standing-chrome" }
    : contract;
}

function validateCandidateCapture(capture, pair) {
  if (capture?.schema !== STANDING_BROWSER_CAPTURE_SCHEMA) {
    throw new Error(
      `candidate capture has an unsupported schema for ${pair.local_url}`,
    );
  }
  if (capture.navigation_status !== 200 || capture.capture_error) {
    throw new Error(
      `candidate capture is incomplete for ${pair.local_url}: ${JSON.stringify({
        navigation_status: capture.navigation_status,
        capture_error: capture.capture_error ?? null,
      })}`,
    );
  }
  validateRequestGateAborts(
    capture.request_gate_aborts,
    `candidate request-gate aborts for ${pair.local_url}`,
  );
  if (
    capture.input_url !== pair.local_url ||
    capture.final_url !== pair.local_url
  ) {
    throw new Error(`candidate capture URL does not bind ${pair.local_url}`);
  }
  if (
    capture.first_paint?.document?.phase !==
    "domcontentloaded_immediate_observation"
  ) {
    throw new Error(
      `candidate capture lacks the required DOMContentLoaded observation for ${pair.local_url}`,
    );
  }
  if (capture.document?.phase !== "settled") {
    throw new Error(
      `candidate capture lacks the required settled observation for ${pair.local_url}`,
    );
  }
  if (capture.document?.resource_completion?.status !== "complete") {
    throw new Error(
      `candidate capture did not complete load, font, and image observation for ${pair.local_url}`,
    );
  }
  screenshotHash(
    capture.first_paint?.screenshot,
    "candidate DOMContentLoaded immediate",
  );
  screenshotHash(
    capture.settled_viewport_screenshot,
    "candidate settled viewport",
  );
  screenshotHash(capture.screenshot, "candidate settled full page");
}

function candidateArtifactHashes(local, liveArtifacts) {
  return {
    local_domcontentloaded_immediate_png: screenshotHash(
      local.first_paint?.screenshot,
      "local DOMContentLoaded immediate",
    ),
    local_settled_viewport_png: screenshotHash(
      local.settled_viewport_screenshot,
      "local settled viewport",
    ),
    local_settled_full_page_png: screenshotHash(
      local.screenshot,
      "local settled full page",
    ),
    live_domcontentloaded_immediate_png:
      liveArtifacts.domcontentloaded_immediate.sha256,
    live_settled_viewport_png: liveArtifacts.settled_viewport.sha256,
    live_settled_full_page_png: liveArtifacts.settled_full_page.sha256,
  };
}

function requireExactHash(actual, expected, label) {
  if (actual !== expected)
    throw new Error(`${label} SHA-256 does not bind the supplied file`);
}

async function verifyLocalArtifacts(outputDir, records) {
  for (const [index, record] of records.entries()) {
    const localUrl = record.input.local_url;
    const expected = {
      local_domcontentloaded_immediate_png: observationArtifactName({
        label: "local",
        index,
        url: localUrl,
        phase: "domcontentloaded-immediate",
      }),
      local_settled_viewport_png: observationArtifactName({
        label: "local",
        index,
        url: localUrl,
        phase: "settled-viewport",
      }),
      local_settled_full_page_png: observationArtifactName({
        label: "local",
        index,
        url: localUrl,
        phase: "settled-full-page",
      }),
    };
    for (const [key, name] of Object.entries(expected)) {
      const stat = await fs.lstat(path.join(outputDir, name)).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) {
        throw new Error(`candidate artifact is unavailable: ${name}`);
      }
      requireExactHash(
        await sha256File(path.join(outputDir, name)),
        record.artifact_hashes[key],
        `candidate artifact ${name}`,
      );
    }
  }
}

async function collectLiveReference({ args, policy, browser }) {
  const pairs = defaultCanaryPairs({
    localOrigin: REFERENCE_LOCAL_ORIGIN,
    liveOrigin: args.liveOrigin,
  });
  const captures = await captureSet({ browser, pairs, label: "live", args });
  for (const [index, capture] of captures.entries()) {
    await validateLiveReferenceRecord({
      capture,
      pair: pairs[index],
      root: args.outputDir,
      policy: policy.value,
    });
  }
  return { pairs, captures };
}

async function sealLiveReference({
  args,
  policy,
  browserEnvironment,
  finalGateSnapshot,
  capture,
}) {
  const { pairs, captures } = capture;
  const ledger = buildLiveReferenceLedger({
    records: captures.map((live, index) => ({ input: pairs[index], live })),
    viewport: args.viewport,
    thresholds: validateThresholds(DEFAULT_THRESHOLDS),
    policy: policy.value,
    policySha256: policy.sha256,
    browserEnvironment,
    requestGate: finalGateSnapshot,
  });
  const outputPath = path.join(
    args.outputDir,
    "standing-browser-live-reference.json",
  );
  const sealed = await sealJsonNoReplace(outputPath, ledger);
  const loaded = await loadSealedLiveReference({
    filePath: outputPath,
    expectedSha256: sealed.sha256,
    pairs,
    viewport: args.viewport,
    thresholds: DEFAULT_THRESHOLDS,
    policy: policy.value,
    policySha256: policy.sha256,
    policyFilePath: policy.filePath,
  });
  const verdict = {
    schema: "wikijump.standing_browser_live_reference_verdict.v1",
    status: "sealed",
    reference_sha256: loaded.sha256,
    policy_sha256: policy.sha256,
    canary_contract_sha256: loaded.identity.canary_contract_sha256,
    pairs_total: loaded.records.length,
    request_gate_config_sha256: finalGateSnapshot.config_sha256,
  };
  const verdictSeal = await sealJsonNoReplace(
    path.join(args.outputDir, "standing-browser-live-reference-verdict.json"),
    verdict,
  );
  return { ledger: loaded, ledgerSeal: sealed, verdict, verdictSeal };
}

async function collectCandidateParity({
  args,
  policy,
  referencePolicy,
  candidateIdentity,
  browser,
}) {
  assertCandidateIdentityFresh(candidateIdentity.value);
  const pairs = defaultCanaryPairs({
    localOrigin: candidatePageOrigin(candidateIdentity.value),
    liveOrigin: DEFAULT_LIVE_ORIGIN,
  });
  const liveReference = await loadSealedLiveReference({
    filePath: args.liveReferenceLedger,
    expectedSha256: args.liveReferenceSha256,
    pairs,
    viewport: args.viewport,
    thresholds: DEFAULT_THRESHOLDS,
    policy: policy.value,
    policySha256: policy.sha256,
    policyFilePath: policy.filePath,
    referencePolicy: referencePolicy.value,
    referencePolicySha256: referencePolicy.sha256,
    referencePolicyFilePath: referencePolicy.filePath,
  });
  const captures = await captureSet({ browser, pairs, label: "local", args });
  for (const [index, capture] of captures.entries()) {
    validateCandidateCapture(capture, pairs[index]);
  }
  return { pairs, liveReference, captures };
}

async function collectStandingParity({args, policy, referencePolicy, browser}) {
  const pairs = defaultCanaryPairs({
    localOrigin: STANDING_LOCAL_ORIGIN,
    liveOrigin: DEFAULT_LIVE_ORIGIN,
  });
  const liveReference = await loadSealedLiveReference({
    filePath: args.liveReferenceLedger,
    expectedSha256: args.liveReferenceSha256,
    pairs,
    viewport: args.viewport,
    thresholds: DEFAULT_THRESHOLDS,
    policy: policy.value,
    policySha256: policy.sha256,
    policyFilePath: policy.filePath,
    referencePolicy: referencePolicy.value,
    referencePolicySha256: referencePolicy.sha256,
    referencePolicyFilePath: referencePolicy.filePath,
  });
  const captures = await captureSet({browser, pairs, label: "local", args});
  for (const [index, capture] of captures.entries()) validateCandidateCapture(capture, pairs[index]);
  return {pairs, liveReference, captures};
}

async function sealCandidateParity({
  args,
  candidateIdentity,
  browserEnvironment,
  finalGateSnapshot,
  runtimeIdentity,
  executionIdentity,
  capture,
}) {
  assertCandidateIdentityFresh(candidateIdentity.value);
  const { pairs, liveReference, captures } = capture;
  assertRequestGateAbortAccounting(captures, finalGateSnapshot);
  const records = captures.map((local, index) => {
    const referenceRecord = liveReference.records[index];
    return {
      input: {
        local_url: pairs[index].local_url,
        live_url: pairs[index].live_url,
      },
      comparison: {
        ...compareCaptures(
          local,
          referenceRecord.capture,
          DEFAULT_THRESHOLDS,
          undefined,
          comparisonContractForPair(pairs[index]),
        ),
        comparison_scope: "standing-chrome",
      },
      artifact_hashes: candidateArtifactHashes(
        local,
        referenceRecord.artifacts,
      ),
    };
  });
  await verifyLocalArtifacts(args.outputDir, records);
  const pairsFailed = records.filter(
    (record) => record.comparison.status !== "pass",
  ).length;
  const ledger = {
    schema: STANDING_BROWSER_PARITY_SCHEMA,
    status: pairsFailed === 0 ? "pass" : "fail",
    generated_at: new Date().toISOString(),
    capture_phase: "domcontentloaded_immediate_observation",
    viewport: args.viewport,
    candidate_identity_sha256: candidateIdentity.sha256,
    live_reference_sha256: liveReference.sha256,
    local_capture_config_sha256: finalGateSnapshot.config_sha256,
    request_gate: finalGateSnapshot,
    records,
    summary: {
      pairs_total: records.length,
      pairs_failed: pairsFailed,
      pairs_passed: records.length - pairsFailed,
    },
  };
  const ledgerPath = path.join(args.outputDir, "standing-browser-parity.json");
  const builtReceipt = buildCandidateParityReceipt({
    identity: candidateIdentity.value,
    identitySha256: candidateIdentity.sha256,
    parity: ledger,
    parityLedgerSha256: sha256Value(ledger),
    liveReference: liveReference.identity,
    browserEnvironment,
    runtimeIdentity,
    executionIdentity,
    runnerSha256: await sha256File(fileURLToPath(import.meta.url)),
    observationSha256: await sha256File(
      path.join(SOURCE_DIR, "standing-browser-parity-observation.mjs"),
    ),
  });
  const receipt = builtReceipt.receipt;
  requireExactHash(
    sha256Value(ledger),
    receipt.parity.ledger_sha256,
    "parity ledger",
  );
  requireExactHash(
    await sha256File(candidateIdentity.filePath),
    receipt.parity.candidate_identity_sha256,
    "candidate identity",
  );
  requireExactHash(
    await sha256File(args.liveReferenceLedger),
    receipt.parity.live_reference_sha256,
    "live reference",
  );
  requireExactHash(
    finalGateSnapshot.config_sha256,
    receipt.parity.request_gate_config_sha256,
    "request gate configuration",
  );
  if (sha256Value(ledger.records) !== sha256Value(receipt.parity.records)) {
    throw new Error(
      "candidate parity receipt records do not match the sealed ledger",
    );
  }
  assertCandidateIdentityFresh(candidateIdentity.value);
  validateCandidateParityReceipt(receipt, { requirePass: false });
  const ledgerSeal = await sealJsonNoReplace(ledgerPath, ledger);
  requireExactHash(
    ledgerSeal.sha256,
    receipt.parity.ledger_sha256,
    "sealed parity ledger",
  );
  assertCandidateIdentityFresh(candidateIdentity.value);
  const receiptPath = path.join(
    args.outputDir,
    "standing-candidate-parity-receipt.json",
  );
  const receiptSeal = await sealJsonNoReplace(receiptPath, receipt);
  return { ledger, ledgerSeal, receipt, receiptSeal };
}

async function sealStandingParity({
  args,
  standingRefresh,
  browserEnvironment,
  finalGateSnapshot,
  capture,
}) {
  const {pairs, liveReference, captures} = capture;
  assertRequestGateAbortAccounting(captures, finalGateSnapshot);
  const records = captures.map((local, index) => {
    const referenceRecord = liveReference.records[index];
    return {
      input: {local_url: pairs[index].local_url, live_url: pairs[index].live_url},
      comparison: {
        ...compareCaptures(local, referenceRecord.capture, DEFAULT_THRESHOLDS, undefined, comparisonContractForPair(pairs[index])),
        comparison_scope: "standing-chrome",
      },
      artifact_hashes: candidateArtifactHashes(local, referenceRecord.artifacts),
    };
  });
  await verifyLocalArtifacts(args.outputDir, records);
  const pairsFailed = records.filter((record) => record.comparison.status !== "pass").length;
  const ledger = {
    schema: STANDING_BROWSER_PARITY_SCHEMA,
    status: pairsFailed === 0 ? "pass" : "fail",
    generated_at: new Date().toISOString(),
    capture_phase: "domcontentloaded_immediate_observation",
    viewport: args.viewport,
    standing_refresh_sha256: standingRefresh.sha256,
    live_reference_sha256: liveReference.sha256,
    local_capture_config_sha256: finalGateSnapshot.config_sha256,
    request_gate: finalGateSnapshot,
    records,
    summary: {pairs_total: records.length, pairs_failed: pairsFailed, pairs_passed: records.length - pairsFailed},
  };
  const ledgerSeal = await sealJsonNoReplace(path.join(args.outputDir, "standing-browser-parity.json"), ledger);
  const scp9506 = records.find((record) => record.input.local_url.endsWith("/scp-9506"));
  const proof = {
    schema: "wikijump.compatibility_standing_browser_proof.v1",
    status: ledger.status,
    generated_at: ledger.generated_at,
    wikijump_sha: standingRefresh.value.wikijump_sha,
    wikijump_tree: standingRefresh.value.wikijump_tree,
    ftml_sha: standingRefresh.value.ftml_sha,
    standing_refresh: {path: standingRefresh.filePath, sha256: standingRefresh.sha256},
    parity: {path: ledgerSeal.path, sha256: ledgerSeal.sha256},
    live_reference: {path: args.liveReferenceLedger, sha256: liveReference.sha256},
    browser_environment: browserEnvironment,
    request_gate: finalGateSnapshot,
    summary: {
      ...ledger.summary,
      full_page_screenshots: records.length,
      scp_9506_full_page_sha256: scp9506?.artifact_hashes?.local_settled_full_page_png ?? null,
    },
  };
  const proofSeal = await sealJsonNoReplace(path.join(args.outputDir, "standing-browser-proof.json"), proof);
  return {ledger, ledgerSeal, proof, proofSeal};
}

export async function runStandingBrowserParity(args) {
  const policy = await readPolicy(args.liveCompletionPolicy);
  const referencePolicy = args.liveReferenceCapturePolicy
    ? await readPolicy(args.liveReferenceCapturePolicy)
    : policy;
  const candidateIdentity =
    args.mode === "candidate"
      ? await readCandidateIdentity(args.candidateIdentity)
      : null;
  const standingRefresh = args.mode === "standing" ? await readStandingRefresh(args.standingRefresh) : null;
  if (candidateIdentity) assertCandidateIdentityFresh(candidateIdentity.value);
  const executionIdentity = candidateIdentity
    ? await collectCandidateExecutionIdentity(candidateIdentity.value)
    : null;
  await createPrivateEmptyDirectory(args.outputDir);
  let controls = null;
  let browser = null;
  let capture = null;
  let browserEnvironment = null;
  let operationFailure = null;
  let cleanupFailure = null;
  let finalGateSnapshot = null;
  let runtimeIdentityBefore = null;
  let runtimeIdentityAfter = null;
  try {
    const standingEndpointIdentity = args.mode === "standing"
      ? {candidate: {endpoint: {allowed_origin_set: [STANDING_LOCAL_ORIGIN, STANDING_FILES_ORIGIN], local_connect_address: "127.0.0.1"}}}
      : null;
    controls = await createParityBrowserControls({
      args,
      outputDir: args.outputDir,
      policy,
      candidate: candidateIdentity?.value ?? standingEndpointIdentity,
      responseCacheOptions: args.sourceResponseCacheDir === null ? null : {
        persistentDir: args.sourceResponseCacheDir,
        persistentIdentity: args.sourceResponseCacheIdentity,
        cacheDocuments: args.sourceResponseCacheDocuments,
        evidenceReplay: true,
      },
    });
    if (candidateIdentity) {
      runtimeIdentityBefore = await observeCandidateRuntimeIdentity({
        identity: candidateIdentity.value,
        identitySha256: candidateIdentity.sha256,
      });
    }
    browser = await launchParityBrowser({
      browserRoot: args.browserRoot,
      browserExecutable: args.browserExecutable,
      controls,
      local: args.mode === "candidate" || args.mode === "standing",
      viewport: args.viewport,
      responseCache: controls.responseCache,
    });
    browserEnvironment = browser.environment;
    capture =
      args.mode === "live-reference"
        ? await collectLiveReference({ args, policy, browser })
        : args.mode === "candidate"
        ? await collectCandidateParity({
            args,
            policy,
            referencePolicy,
            candidateIdentity,
            browser,
          })
        : await collectStandingParity({args, policy, referencePolicy, browser});
  } catch (error) {
    operationFailure = error;
  } finally {
    await browser?.close().catch((error) => {
      cleanupFailure ??= error;
    });
    if (!cleanupFailure) {
      finalGateSnapshot = await controls?.close().catch((error) => {
        cleanupFailure ??= error;
        return null;
      });
    }
  }
  if (operationFailure) throw operationFailure;
  if (cleanupFailure) throw cleanupFailure;
  if (!capture || !browserEnvironment || !finalGateSnapshot) {
    throw new Error(
      "browser parity capture did not close cleanly before sealing",
    );
  }
  if (candidateIdentity) {
    runtimeIdentityAfter = await observeCandidateRuntimeIdentity({
      identity: candidateIdentity.value,
      identitySha256: candidateIdentity.sha256,
    });
    assertStableCandidateRuntimeIdentity(
      runtimeIdentityBefore,
      runtimeIdentityAfter,
      candidateIdentity.value,
      { identitySha256: candidateIdentity.sha256 },
    );
  }
  const result =
    args.mode === "live-reference"
      ? await sealLiveReference({
          args,
          policy,
          browserEnvironment,
          finalGateSnapshot,
          capture,
        })
      : args.mode === "candidate"
      ? await sealCandidateParity({
          args,
          candidateIdentity,
          browserEnvironment,
          finalGateSnapshot,
          runtimeIdentity: runtimeIdentityAfter,
          executionIdentity,
          capture,
        })
      : await sealStandingParity({args, standingRefresh, browserEnvironment, finalGateSnapshot, capture});
  return {
    mode: args.mode,
    output_dir: args.outputDir,
    status: result.receipt?.status ?? result.verdict?.status ?? result.proof?.status,
    result,
  };
}
