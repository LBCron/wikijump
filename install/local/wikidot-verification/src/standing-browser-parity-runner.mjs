import path from "node:path";

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
} from "./standing-browser-parity-observation.mjs";
import {
  DEFAULT_PARITY_BROWSER_ROOT,
  createParityBrowserControls,
  launchParityBrowser,
} from "./standing-browser-parity-browser-session.mjs";
import {
  buildLiveReferenceLedger,
  loadLiveReference,
  validateLiveReferenceRecord,
} from "./standing-browser-parity-reference.mjs";
import {
  createPrivateEmptyDirectory,
  writeJson,
  readJsonObject,
} from "./standing-browser-parity-util.mjs";

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
    } else if (flag === "--candidate-port") {
      args.candidatePort = positiveInteger(nextArgument(argv, index, flag), flag);
      index += 1;
    } else if (flag === "--live-reference-ledger") {
      args.liveReferenceLedger = path.resolve(nextArgument(argv, index, flag));
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
  if (args.mode === "candidate" && !args.candidatePort) throw new Error("--candidate-port is required in candidate mode");
  if ((args.mode === "candidate" || args.mode === "standing") && !args.liveReferenceLedger) {
    throw new Error(`--live-reference-ledger is required in ${args.mode} mode`);
  }
  if (args.mode === "standing") {
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
  return screenshot.sha256;
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

async function writeLiveReference({
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
    browserEnvironment,
    requestGate: finalGateSnapshot,
  });
  const outputPath = path.join(
    args.outputDir,
    "standing-browser-live-reference.json",
  );
  await writeJson(outputPath, ledger);
  const loaded = await loadLiveReference({
    filePath: outputPath,
    pairs,
    viewport: args.viewport,
    thresholds: DEFAULT_THRESHOLDS,
    policy: policy.value,
  });
  return { ledger: loaded };
}

async function collectLocalParity({args, policy, browser, localOrigin}) {
  const pairs = defaultCanaryPairs({localOrigin, liveOrigin: DEFAULT_LIVE_ORIGIN});
  const liveReference = await loadLiveReference({
    filePath: args.liveReferenceLedger,
    pairs,
    viewport: args.viewport,
    thresholds: DEFAULT_THRESHOLDS,
    policy: policy.value,
  });
  const captures = await captureSet({browser, pairs, label: "local", args});
  for (const [index, capture] of captures.entries()) validateCandidateCapture(capture, pairs[index]);
  return {pairs, liveReference, captures};
}

async function writeParityResult({args, finalGateSnapshot, capture}) {
  const {pairs, liveReference, captures} = capture;
  assertRequestGateAbortAccounting(captures, finalGateSnapshot);
  const records = captures.map((local, index) => ({
    input: {local_url: pairs[index].local_url, live_url: pairs[index].live_url},
    comparison: {
      ...compareCaptures(local, liveReference.records[index].capture, DEFAULT_THRESHOLDS, undefined, comparisonContractForPair(pairs[index])),
      comparison_scope: "standing-chrome",
    },
  }));
  const pairsFailed = records.filter((record) => record.comparison.status !== "pass").length;
  const proof = {
    schema: STANDING_BROWSER_PARITY_SCHEMA,
    status: pairsFailed === 0 ? "pass" : "fail",
    generated_at: new Date().toISOString(),
    viewport: args.viewport,
    records,
    summary: {pairs_total: records.length, pairs_failed: pairsFailed, pairs_passed: records.length - pairsFailed},
  };
  await writeJson(path.join(args.outputDir, "standing-browser-parity.json"), proof);
  return {proof};
}

function localEndpoint(args) {
  if (args.mode === "standing") {
    return {candidate: {endpoint: {allowed_origin_set: [STANDING_LOCAL_ORIGIN, STANDING_FILES_ORIGIN], local_connect_address: "127.0.0.1"}}};
  }
  if (args.mode === "candidate") {
    const port = args.candidatePort;
    return {candidate: {endpoint: {
      allowed_origin_set: [`https://scp-wiki.wikijump.localhost:${port}`, `https://scp-wiki.wjfiles.localhost:${port}`],
      local_connect_address: "127.0.0.1",
    }}};
  }
  return null;
}

export async function runStandingBrowserParity(args) {
  const policy = await readPolicy(args.liveCompletionPolicy);
  await createPrivateEmptyDirectory(args.outputDir);
  let controls = null;
  let browser = null;
  let capture = null;
  let browserEnvironment = null;
  let operationFailure = null;
  let cleanupFailure = null;
  let finalGateSnapshot = null;
  try {
    controls = await createParityBrowserControls({
      args,
      outputDir: args.outputDir,
      policy,
      candidate: localEndpoint(args),
      responseCacheOptions: args.sourceResponseCacheDir === null ? null : {
        persistentDir: args.sourceResponseCacheDir,
        persistentIdentity: args.sourceResponseCacheIdentity,
        cacheDocuments: args.sourceResponseCacheDocuments,
        evidenceReplay: true,
      },
    });
    browser = await launchParityBrowser({
      browserRoot: args.browserRoot,
      browserExecutable: args.browserExecutable,
      controls,
      local: args.mode === "candidate" || args.mode === "standing",
      viewport: args.viewport,
      responseCache: controls.responseCache,
    });
    browserEnvironment = browser.environment;
    capture = args.mode === "live-reference"
      ? await collectLiveReference({args, policy, browser})
      : await collectLocalParity({
          args, policy, browser,
          localOrigin: args.mode === "standing" ? STANDING_LOCAL_ORIGIN : `https://scp-wiki.wikijump.localhost:${args.candidatePort}`,
        });
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
    throw new Error("browser parity capture did not close cleanly");
  }
  const result = args.mode === "live-reference"
    ? await writeLiveReference({args, policy, browserEnvironment, finalGateSnapshot, capture})
    : await writeParityResult({args, finalGateSnapshot, capture});
  return {
    mode: args.mode,
    output_dir: args.outputDir,
    status: result.verdict?.status ?? result.proof?.status,
    result,
  };
}
