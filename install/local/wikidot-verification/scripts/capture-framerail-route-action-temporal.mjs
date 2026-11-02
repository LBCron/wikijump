#!/usr/bin/env node

import crypto from "node:crypto";
import {execFileSync, spawn} from "node:child_process";
import {constants as fsConstants} from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {startCaptureEgressProxy} from "../src/capture-egress-proxy.mjs";
import {publishBytesNoReplace} from "../src/atomic-no-replace.mjs";
import {
  DEFAULT_REQUEST_INTERVAL_MS,
  acquireBrowserCaptureLock,
  candidatePublicEvidenceResponseCacheOptions,
  createPersistentBrowserRequestGate,
  localBrowserCaptureOrigins,
} from "../src/browser-request-gate.mjs";
import {defaultBrowserRoot, loadPlaywright, openBrowser} from "../src/browser-session.mjs";
import {safePathSegment} from "../src/browser-render-evidence.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_RELATIVE_PATH = "install/local/wikidot-verification/scripts/capture-framerail-route-action-temporal.mjs";
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "../../../..");
const DEFAULT_CONTRACT = path.resolve(path.dirname(SCRIPT_PATH), "../fixtures/framerail-route-action-browser/run-contract.json");
const REQUIRED_INTERVALS = ["denial", "failure", "loading", "selection", "settled", "success"];
const SCENARIO_ORDER = ["denial", "failure", "success"];
const SUBJECT_KINDS = ["missing_page", "saved_page"];
const DEFAULT_TIMEOUT_MS = 30_000;
const XVFB_EXECUTABLE = "/usr/bin/Xvfb";
const X11_IMPORT_EXECUTABLE = "/usr/bin/import";
const CAPTURE_DISPLAY_WIDTH = 1400;
const CAPTURE_DISPLAY_HEIGHT = 900;
const CAPTURE_DISPLAY_DEPTH = 24;
export const DOM_MAX_BYTES = 4 * 1024 * 1024;
export const SCREENSHOT_MAX_BYTES = 16 * 1024 * 1024;
export const DIAGNOSTIC_MAX_BYTES = 1024 * 1024;
export const SHUTDOWN_TIMEOUT_MS = 10_000;

function repositoryEvidencePath(value) {
  if (typeof value !== "string" || value.length === 0 || path.isAbsolute(value) || path.normalize(value) !== value) {
    throw new Error("historical evidence must use an exact repository-relative path");
  }
  const resolved = path.resolve(REPO_ROOT, value);
  const relative = path.relative(REPO_ROOT, resolved);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error("historical evidence must remain inside the repository");
  }
  return resolved;
}

function nextArg(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(value, flag, allowZero = false) {
  if (!/^\d+$/u.test(value)) throw new Error(`${flag} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  const number = Number.parseInt(value, 10);
  if ((!allowZero && number <= 0) || !Number.isSafeInteger(number)) throw new Error(`${flag} is out of range`);
  return number;
}

function parseArgs(argv) {
  const args = {
    contract: DEFAULT_CONTRACT,
    browserRoot: defaultBrowserRoot(),
    timeoutMs: DEFAULT_TIMEOUT_MS,
    ignoreHttpsErrors: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--contract") {
      args.contract = path.resolve(nextArg(argv, index, flag));
      index += 1;
    } else if (flag === "--output-dir") {
      args.outputDir = path.resolve(nextArg(argv, index, flag));
      index += 1;
    } else if (flag.endsWith("-url")) {
      args[flag.slice(2).replaceAll("-", "_")] = nextArg(argv, index, flag);
      index += 1;
    } else if (flag === "--browser-root") {
      args.browserRoot = path.resolve(nextArg(argv, index, flag));
      index += 1;
    } else if (flag === "--browser-executable") {
      args.browserExecutable = path.resolve(nextArg(argv, index, flag));
      index += 1;
    } else if (["--denial-storage-state", "--failure-storage-state", "--success-storage-state"].includes(flag)) {
      args[flag.slice(2).replaceAll("-", "_")] = path.resolve(nextArg(argv, index, flag));
      index += 1;
    } else if (flag === "--fixture-identity") {
      args.fixtureIdentity = path.resolve(nextArg(argv, index, flag));
      index += 1;
    } else if (flag === "--failure-control-identity") {
      args.failureControlIdentity = path.resolve(nextArg(argv, index, flag));
      index += 1;
    } else if (flag === "--runtime-identity") {
      args.runtimeIdentity = path.resolve(nextArg(argv, index, flag));
      index += 1;
    } else if (flag === "--denial-actor-class") {
      args.denial_actor_class = nextArg(argv, index, flag);
      index += 1;
    } else if (flag === "--failure-actor-class") {
      args.failure_actor_class = nextArg(argv, index, flag);
      index += 1;
    } else if (flag === "--success-actor-class") {
      args.success_actor_class = nextArg(argv, index, flag);
      index += 1;
    } else if (flag === "--run-id") {
      args.runId = nextArg(argv, index, flag);
      index += 1;
    } else if (flag === "--timeout-ms") {
      args.timeoutMs = positiveInteger(nextArg(argv, index, flag), flag);
      index += 1;
    } else if (flag === "--ignore-https-errors") {
      args.ignoreHttpsErrors = true;
    } else if (flag === "--help") {
      return {help: true};
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  if (args.help) return args;
  for (const key of [
    "denial_missing_url", "denial_saved_url", "failure_missing_url", "failure_saved_url",
    "success_missing_url", "success_saved_url",
  ]) {
    if (!args[key]) throw new Error(`--${key.replaceAll("_", "-")} is required`);
  }
  for (const key of [
    "outputDir", "browserExecutable", "fixtureIdentity", "failureControlIdentity", "runtimeIdentity",
    "denial_storage_state", "failure_storage_state", "success_storage_state",
    "denial_actor_class", "failure_actor_class", "success_actor_class",
  ]) {
    if (!args[key]) throw new Error(`--${key.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required`);
  }
  args.runId ??= crypto.randomUUID();
  return args;
}

export function validateTemporalRunContract(contract) {
  if (contract?.issue !== 1372) throw new Error("temporal run contract is not for issue 1372");
  if (contract.repository !== "Rokurolize/wikijump") throw new Error("temporal run contract has no exact repository identity");
  if (contract.authority !== undefined) throw new Error("temporal run contract must not contain authority state");
  if (contract.preflight_required?.includes("authority_state_sha256")) {
    throw new Error("temporal run contract must not require authority state");
  }
  if (JSON.stringify(contract.required_intervals) !== JSON.stringify(REQUIRED_INTERVALS)) {
    throw new Error("temporal run contract interval set is not exact");
  }
  if (contract.capture?.script !== SCRIPT_RELATIVE_PATH) throw new Error("temporal run contract points at the wrong capture script");
  if (!/^[0-9a-f]{40}$/u.test(contract.source_revision ?? "")) throw new Error("temporal run contract source revision is malformed");
  if (contract.historical_evidence?.schema !== "wikijump.page_pane_lazy_browser.v1" || contract.historical_evidence?.classification !== "historical_history_only") {
    throw new Error("temporal run contract historical receipt is not classified as history-only");
  }
  repositoryEvidencePath(contract.historical_evidence.path);
  if (!/^[0-9a-f]{64}$/u.test(contract.historical_evidence.sha256 ?? "")) {
    throw new Error("temporal run contract historical receipt SHA-256 is malformed");
  }
  const scenarios = SCENARIO_ORDER.map((id) => {
    const scenario = contract.capture.scenarios?.[id];
    if (!scenario || !Array.isArray(scenario.intervals)) {
      throw new Error(`temporal scenario ${id} is incomplete`);
    }
    if (id !== "success" && scenario.result_oracle_source !== "failure_control_identity") {
      throw new Error(`temporal scenario ${id} has no failure-control result oracle source`);
    }
    if (id === "success" && scenario.result_oracle_source !== undefined) {
      throw new Error("temporal success scenario must not require a failure-control result oracle");
    }
    return {id, intervals: scenario.intervals};
  });
  const subjects = contract.subjects;
  if (!Array.isArray(subjects) || subjects.length !== 14) throw new Error("temporal subject count is not 14");
  const ids = subjects.map(({id}) => id);
  if (ids.some((id) => typeof id !== "string" || id === "") || new Set(ids).size !== ids.length) {
    throw new Error("temporal subjects must have unique IDs");
  }
  for (const subject of subjects) {
    if (!SUBJECT_KINDS.includes(subject.kind)) throw new Error(`${subject.id} has no executable page kind`);
    if (!subject.loading || !["dom", "navigation", "request"].includes(subject.loading.kind)) {
      throw new Error(`${subject.id} has no observable loading boundary`);
    }
    if (subject.loading.kind === "navigation" && (typeof subject.loading.url_suffix !== "string" || subject.loading.url_suffix === "" || subject.loading.status !== 200)) {
      throw new Error(`${subject.id} has no exact navigation destination and status`);
    }
    if (subject.id === "control:create" && (subject.loading.url_suffix !== "/edit/true" || subject.loading.status !== 200)) {
      throw new Error("control:create has no exact navigation destination and status");
    }
    if (subject.loading.kind === "dom" && (typeof subject.loading.selector !== "string" || subject.loading.state !== "visible")) {
      throw new Error(`${subject.id} has an invalid loading predicate`);
    }
    if (subject.loading.kind === "request" && (subject.loading.method !== "POST" || typeof subject.loading.url_suffix !== "string")) {
      throw new Error(`${subject.id} has an invalid loading request`);
    }
    if (!Array.isArray(subject.trigger_selectors) || subject.trigger_selectors.length === 0) {
      throw new Error(`${subject.id} has no trigger selector`);
    }
    if (subject.trigger_selectors.some((selector) => typeof selector !== "string" || selector === "")) {
      throw new Error(`${subject.id} has an invalid trigger selector`);
    }
    const settled = subject.settled_predicate;
    if (!settled || typeof settled.selector !== "string" || !/^[#.]/u.test(settled.selector) || settled.state !== "visible") {
      throw new Error(`${subject.id} has no exact settled predicate`);
    }
    if (subject.success_event && (!['navigation', 'request', 'response'].includes(subject.success_event.kind) || !subject.success_event.method || !subject.success_event.url_suffix)) {
      throw new Error(`${subject.id} has an invalid success event`);
    }
  }
  const expectedIntervals = {
    denial: ["denial"],
    failure: ["failure"],
    success: ["selection", "loading", "settled", "success"],
  };
  for (const scenario of scenarios) {
    if (JSON.stringify(scenario.intervals) !== JSON.stringify(expectedIntervals[scenario.id])) {
      throw new Error(`temporal scenario ${scenario.id} has the wrong interval boundary`);
    }
  }
  return {subjects, scenarios};
}

export function buildTemporalCapturePlan(contract, urls) {
  const {subjects, scenarios} = validateTemporalRunContract(contract);
  const plan = [];
  for (const scenario of scenarios) {
    for (const subject of subjects) {
      const url = urls?.[scenario.id]?.[subject.kind];
      if (typeof url !== "string" || url === "") throw new Error(`missing ${scenario.id} URL for ${subject.kind}`);
      for (const interval of scenario.intervals) plan.push({subject, scenario, interval, url});
    }
  }
  return plan;
}

function urlsFromArgs(args) {
  return {
    denial: {missing_page: args.denial_missing_url, saved_page: args.denial_saved_url},
    failure: {missing_page: args.failure_missing_url, saved_page: args.failure_saved_url},
    success: {missing_page: args.success_missing_url, saved_page: args.success_saved_url},
  };
}

export function captureUrlsSha256(urls) {
  const canonical = SCENARIO_ORDER.map((scenario) => [
    scenario,
    SUBJECT_KINDS.map((kind) => [kind, urls?.[scenario]?.[kind] ?? null]),
  ]);
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function assertByteLimit(value, limit, label) {
  const bytes = typeof value === "string" ? Buffer.byteLength(value, "utf8") : value?.byteLength;
  if (!Number.isSafeInteger(bytes) || bytes > limit) throw new Error(`${label} exceeds the ${limit}-byte limit`);
  return value;
}

export async function withTimeout(operation, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function viewportCropGeometry(
  geometry,
  {screenWidth = CAPTURE_DISPLAY_WIDTH, screenHeight = CAPTURE_DISPLAY_HEIGHT} = {},
) {
  const values = [
    "innerWidth",
    "innerHeight",
    "outerWidth",
    "outerHeight",
    "screenX",
    "screenY",
  ];
  for (const name of values) {
    if (!Number.isSafeInteger(geometry?.[name])) throw new Error(`viewport ${name} is not an integer`);
  }
  if (geometry.devicePixelRatio !== 1) throw new Error("capture display requires devicePixelRatio 1");
  if (geometry.innerWidth <= 0 || geometry.innerHeight <= 0) throw new Error("viewport dimensions must be positive");
  if (geometry.outerWidth < geometry.innerWidth || geometry.outerHeight < geometry.innerHeight) {
    throw new Error("browser outer geometry cannot be smaller than the viewport");
  }
  const x = Math.round(geometry.screenX + (geometry.outerWidth - geometry.innerWidth) / 2);
  const y = Math.round(geometry.screenY + geometry.outerHeight - geometry.innerHeight);
  if (
    x < 0 ||
    y < 0 ||
    x + geometry.innerWidth > screenWidth ||
    y + geometry.innerHeight > screenHeight
  ) {
    throw new Error("browser viewport is outside the owned capture display");
  }
  return {
    x,
    y,
    width: geometry.innerWidth,
    height: geometry.innerHeight,
    crop: `${geometry.innerWidth}x${geometry.innerHeight}+${x}+${y}`,
  };
}

async function startCaptureDisplay() {
  await fs.access(XVFB_EXECUTABLE, fsConstants.X_OK);
  await fs.access(X11_IMPORT_EXECUTABLE, fsConstants.X_OK);
  const firstDisplay = 77 + (process.pid % 32);
  for (let offset = 0; offset < 32; offset += 1) {
    const number = 77 + ((firstDisplay - 77 + offset) % 32);
    const lockPath = `/tmp/.X${number}-lock`;
    if (await fs.access(lockPath).then(() => true, () => false)) continue;
    const child = spawn(
      XVFB_EXECUTABLE,
      [
        `:${number}`,
        "-screen",
        "0",
        `${CAPTURE_DISPLAY_WIDTH}x${CAPTURE_DISPLAY_HEIGHT}x${CAPTURE_DISPLAY_DEPTH}`,
        "-nolisten",
        "tcp",
        "-pn",
      ],
      {stdio: "ignore"},
    );
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    child.once("error", () => {
      exited = true;
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const ready = await fs.access(lockPath).then(() => true, () => false);
      if (ready && !exited) {
        return {
          display: `:${number}`,
          width: CAPTURE_DISPLAY_WIDTH,
          height: CAPTURE_DISPLAY_HEIGHT,
          depth: CAPTURE_DISPLAY_DEPTH,
          async close() {
            if (exited || child.exitCode !== null || child.signalCode !== null) return;
            child.kill("SIGTERM");
            try {
              await withTimeout(
                () => new Promise((resolve) => child.once("exit", resolve)),
                SHUTDOWN_TIMEOUT_MS,
                "capture display shutdown",
              );
            } catch {
              child.kill("SIGKILL");
              await withTimeout(
                () => new Promise((resolve) => child.once("exit", resolve)),
                SHUTDOWN_TIMEOUT_MS,
                "capture display forced shutdown",
              );
            }
          },
        };
      }
      if (exited) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (!exited) child.kill("SIGKILL");
  }
  throw new Error("could not allocate an owned Xvfb capture display");
}

async function captureViewportScreenshot(page, captureDisplay, timeoutMs) {
  await new Promise((resolve) => setTimeout(resolve, 25));
  const geometry = viewportCropGeometry(
    await page.evaluate(() => ({
      innerWidth,
      innerHeight,
      outerWidth,
      outerHeight,
      screenX,
      screenY,
      devicePixelRatio,
    })),
    {screenWidth: captureDisplay.width, screenHeight: captureDisplay.height},
  );
  return execFileSync(
    X11_IMPORT_EXECUTABLE,
    [
      "-silent",
      "-window",
      "root",
      "-crop",
      geometry.crop,
      "-quality",
      "45",
      "jpeg:-",
    ],
    {
      env: {...process.env, DISPLAY: captureDisplay.display},
      maxBuffer: SCREENSHOT_MAX_BYTES,
      timeout: timeoutMs,
    },
  );
}

async function readFileIdentity(filePath, label) {
  const requestedPath = path.resolve(filePath);
  let handle;
  try {
    handle = await fs.open(requestedPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${label} is not a file: ${requestedPath}`);
    const bytes = await handle.readFile();
    if (bytes.byteLength !== stat.size) throw new Error(`${label} changed while it was read`);
    return {
      identity: {
        label,
        path: requestedPath,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        size: bytes.byteLength,
      },
      bytes,
      mode: stat.mode,
    };
  } finally {
    await handle?.close();
  }
}

async function fileIdentity(filePath, label) {
  return (await readFileIdentity(filePath, label)).identity;
}

function repositoryIdentity() {
  const git = (args) => execFileSync("/usr/bin/git", args, {cwd: REPO_ROOT, encoding: "utf8"}).trim();
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") throw new Error("capture repository must be clean before browser startup");
  const wikijumpCommit = git(["rev-parse", "HEAD"]);
  const wikijumpTree = git(["rev-parse", "HEAD^{tree}"]);
  if (!/^[0-9a-f]{40}$/u.test(wikijumpCommit) || !/^[0-9a-f]{40}$/u.test(wikijumpTree)) throw new Error("capture repository identity is malformed");
  return {wikijump_commit: wikijumpCommit, wikijump_tree: wikijumpTree};
}

export function validateSourceIdentity(sourceIdentity, runtimeIdentity) {
  if (runtimeIdentity?.wikijump_commit === sourceIdentity?.wikijump_commit && runtimeIdentity?.wikijump_tree === sourceIdentity?.wikijump_tree) return sourceIdentity;
  if (!/^[0-9a-f]{40}$/u.test(runtimeIdentity?.wikijump_commit ?? "") || !/^[0-9a-f]{40}$/u.test(runtimeIdentity?.wikijump_tree ?? "")) throw new Error("runtime identity does not match the actual clean capture source identity");
  const git = (args) => execFileSync("/usr/bin/git", args, {cwd: REPO_ROOT, encoding: "utf8"}).trim();
  try {
    if (git(["rev-parse", `${runtimeIdentity.wikijump_commit}^{tree}`]) !== runtimeIdentity.wikijump_tree) throw new Error("runtime tree is not the sealed commit tree");
    execFileSync("/usr/bin/git", ["merge-base", "--is-ancestor", runtimeIdentity.wikijump_commit, sourceIdentity.wikijump_commit], {cwd: REPO_ROOT, stdio: "ignore"});
    const changed = git(["diff", "--name-only", `${runtimeIdentity.wikijump_commit}..${sourceIdentity.wikijump_commit}`]).split("\n").filter(Boolean);
    if (changed.length === 0 || changed.some((file) => !file.startsWith("install/local/wikidot-verification/") && !file.startsWith(".github/"))) throw new Error("capture source changed outside verifier-only files");
  } catch {
    throw new Error("runtime identity does not match the actual clean capture source identity");
  }
  return {wikijump_commit: runtimeIdentity.wikijump_commit, wikijump_tree: runtimeIdentity.wikijump_tree};
}

export async function verifyHistoricalEvidence(historicalEvidence) {
  if (!historicalEvidence || historicalEvidence.schema !== "wikijump.page_pane_lazy_browser.v1" || historicalEvidence.classification !== "historical_history_only") {
    throw new Error("historical evidence is not a classified history-only receipt");
  }
  const retainedPath = repositoryEvidencePath(historicalEvidence.path);
  if (!/^[0-9a-f]{64}$/u.test(historicalEvidence.sha256 ?? "")) {
    throw new Error("historical evidence SHA-256 is malformed");
  }
  const {identity, bytes} = await readFileIdentity(retainedPath, "historical_evidence");
  if (identity.path !== retainedPath || identity.sha256 !== historicalEvidence.sha256) {
    throw new Error("historical evidence SHA-256 does not match the retained artifact");
  }
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`historical evidence receipt is not valid JSON: ${errorMessage(error)}`);
  }
  if (receipt?.schema !== historicalEvidence.schema) throw new Error("historical evidence receipt has the wrong schema");
  return identity;
}

async function storageStateIdentity(filePath, label) {
  const {identity, bytes} = await readFileIdentity(filePath, label);
  const state = JSON.parse(bytes.toString("utf8"));
  if (!state || !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
    throw new Error(`${label} is not a Playwright storage state`);
  }
  return {identity, bytes};
}

export function runOwnedStorageStatePaths(outputDir) {
  const root = path.resolve(outputDir);
  return Object.fromEntries(SCENARIO_ORDER.map((scenario) => [scenario, path.join(root, `storage-state-${scenario}.json`)]));
}

export async function copyRunOwnedStorageStates(sourceStates, targetPaths) {
  const copied = {};
  try {
    for (const scenario of SCENARIO_ORDER) {
      const source = sourceStates[scenario];
      const sourceIdentity = source.identity ?? source;
      const bytes = source.bytes ?? await fs.readFile(sourceIdentity.path);
      const digest = crypto.createHash("sha256").update(bytes).digest("hex");
      if (digest !== sourceIdentity.sha256) throw new Error(`${scenario} storage state changed before copying`);
      const target = targetPaths[scenario];
      const publication = await publishBytesNoReplace(target, bytes, {mode: 0o600});
      if (publication === "exists") throw new Error(`${scenario} run-owned storage state already exists`);
      copied[scenario] = {...sourceIdentity, path: target};
    }
    return copied;
  } catch (error) {
    await removeRunOwnedStorageStates(copied).catch(() => {});
    throw error;
  }
}

export async function removeRunOwnedStorageStates(states) {
  for (const scenario of SCENARIO_ORDER) {
    const target = states?.[scenario]?.path;
    if (!target) continue;
    const stat = await fs.lstat(target).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (!stat) continue;
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`${scenario} run-owned storage state is not a file`);
    await fs.unlink(target);
  }
}

export async function assertRunOwnedStorageStatesAbsent(states) {
  for (const scenario of SCENARIO_ORDER) {
    const target = states?.[scenario]?.path;
    if (!target) continue;
    try {
      await fs.lstat(target);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`${scenario} run-owned storage state remains after cleanup`);
  }
}

async function jsonIdentity(filePath, label, schema) {
  const {identity, bytes} = await readFileIdentity(filePath, label);
  let descriptor;
  try {
    descriptor = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${errorMessage(error)}`);
  }
  if (!descriptor || descriptor.schema !== schema) throw new Error(`${label} has the wrong identity schema`);
  return {identity, descriptor};
}

export async function validateOutputPreflight(outputDir, paths) {
  const output = path.resolve(outputDir);
  const parent = path.dirname(output);
  const parentStat = await fs.lstat(parent).catch(() => null);
  if (!parentStat?.isDirectory() || parentStat.isSymbolicLink()) throw new Error("output parent must be a non-symbolic directory");
  const outputStat = await fs.lstat(output).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (outputStat) throw new Error(`output directory already exists: ${output}`);
  for (const target of paths) {
    const resolved = path.resolve(target);
    if (path.dirname(resolved) !== output) throw new Error(`output artifact is outside the run root: ${resolved}`);
    try {
      await fs.lstat(resolved);
      throw new Error(`output artifact already exists: ${resolved}`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

function validateResultOracle(oracle, label) {
  if (!oracle || !["event", "dom"].includes(oracle.type)) {
    throw new Error(`${label} has no exact observable result oracle`);
  }
  if (oracle.type === "dom") {
    const predicate = oracle.predicate;
    if (
      !predicate ||
      typeof predicate.selector !== "string" ||
      predicate.selector === "" ||
      !["visible", "absent"].includes(predicate.state)
    ) {
      throw new Error(`${label} has an invalid DOM result predicate`);
    }
    if (oracle.activation !== undefined && !["click", "none"].includes(oracle.activation)) {
      throw new Error(`${label} has an invalid DOM result activation`);
    }
    if (oracle.failure_control !== undefined) validateFailureControl(oracle.failure_control, label);
    return;
  }
  const event = oracle.event;
  if (!event || !["navigation", "request", "response"].includes(event.kind) || typeof event.url_suffix !== "string" || event.url_suffix === "") {
    throw new Error(`${label} has an invalid result event`);
  }
  if (event.kind === "navigation" && (!Number.isSafeInteger(event.status) || event.status < 100 || event.status > 599)) {
    throw new Error(`${label} has no exact navigation status`);
  }
  if (event.kind !== "navigation" && (typeof event.method !== "string" || !/^[A-Z]+$/u.test(event.method))) {
    throw new Error(`${label} has an invalid result event method`);
  }
  if (event.kind === "response" && (!Number.isSafeInteger(event.status) || event.status < 100 || event.status > 599)) {
    throw new Error(`${label} has no exact response status`);
  }
  if (event.post_data_contains !== undefined && typeof event.post_data_contains !== "string") {
    throw new Error(`${label} has an invalid result event control`);
  }
  if (oracle.failure_control !== undefined) validateFailureControl(oracle.failure_control, label);
}

function validateFailureControl(control, label) {
  if (!control || control.kind !== "abort_request") throw new Error(`${label} has an invalid failure control`);
  const request = control.request;
  if (!request || typeof request !== "object") throw new Error(`${label} failure control has no exact request matcher`);
  if (request.resource_type !== undefined && typeof request.resource_type !== "string") throw new Error(`${label} failure control has an invalid resource type`);
  if (request.method !== undefined && (typeof request.method !== "string" || !/^[A-Z]+$/u.test(request.method))) throw new Error(`${label} failure control has an invalid method`);
  if (request.url_suffix !== undefined && (typeof request.url_suffix !== "string" || request.url_suffix === "")) throw new Error(`${label} failure control has an invalid URL suffix`);
  if (request.resource_type === undefined && request.method === undefined && request.url_suffix === undefined) throw new Error(`${label} failure control matcher is empty`);
}

export function validateCaptureInputBindings(contract, urls, identities) {
  for (const scenario of SCENARIO_ORDER) {
    for (const kind of SUBJECT_KINDS) {
      if (typeof urls?.[scenario]?.[kind] !== "string" || urls[scenario][kind] === "") {
        throw new Error(`missing ${scenario} URL for ${kind}`);
      }
    }
  }
  const urlsSha256 = captureUrlsSha256(urls);
  const fixture = identities?.fixture?.descriptor;
  if (!fixture || fixture.schema !== "wikijump.framerail_route_action_fixture_identity.v1") {
    throw new Error("fixture identity descriptor is required");
  }
  if (fixture.urls_sha256 !== urlsSha256 || captureUrlsSha256(fixture.urls) !== urlsSha256) {
    throw new Error("fixture identity is not bound to the supplied URLs");
  }

  const failureControl = identities?.failureControl?.descriptor;
  if (!failureControl || failureControl.schema !== "wikijump.framerail_route_action_failure_control_identity.v1") {
    throw new Error("failure-control identity descriptor is required");
  }
  if (failureControl.urls_sha256 !== urlsSha256) {
    throw new Error("failure-control identity is not bound to the supplied URLs");
  }
  const resultOracles = {};
  const subjectKeys = contract.subjects.map(({id}) => id).sort().join("\n");
  for (const scenario of ["denial", "failure"]) {
    const bySubject = failureControl.result_oracles?.[scenario];
    if (!bySubject || Object.keys(bySubject).sort().join("\n") !== subjectKeys) {
      throw new Error(`${scenario} failure-control identity does not cover every subject`);
    }
    resultOracles[scenario] = {};
    for (const subject of contract.subjects) {
      const oracle = bySubject[subject.id];
      validateResultOracle(oracle, `${scenario} ${subject.id}`);
      resultOracles[scenario][subject.id] = oracle;
    }
  }
  return resultOracles;
}

async function inputIdentities(args, contract, urls, contractIdentity, outputDir) {
  const repository = execFileSync("/usr/bin/git", ["rev-parse", "--show-toplevel"], {cwd: REPO_ROOT, encoding: "utf8"}).trim();
  if (path.resolve(repository) !== REPO_ROOT) throw new Error("capture script is not running from the exact repository root");
  const actualSource = repositoryIdentity();
  const script = await fileIdentity(SCRIPT_PATH, "capture_script");
  if (contract.capture.script_sha256 !== script.sha256) throw new Error("capture script SHA-256 does not match the run contract");
  const historicalEvidence = await verifyHistoricalEvidence(contract.historical_evidence);
  const browserExecutableFile = await readFileIdentity(args.browserExecutable, "browser_executable");
  const browserExecutable = browserExecutableFile.identity;
  if ((browserExecutableFile.mode & 0o111) === 0) {
    throw new Error(`browser_executable is not executable: ${browserExecutable.path}`);
  }
  const fixture = await jsonIdentity(args.fixtureIdentity, "fixture", "wikijump.framerail_route_action_fixture_identity.v1");
  const failureControl = await jsonIdentity(args.failureControlIdentity, "failure_control", "wikijump.framerail_route_action_failure_control_identity.v1");
  const runtime = await jsonIdentity(args.runtimeIdentity, "runtime", "wikijump.framerail_route_action_runtime_identity.v1");
  const source = validateSourceIdentity(actualSource, runtime.descriptor);
  const resultOracles = validateCaptureInputBindings(contract, urls, {fixture, failureControl});
  const storageStateFiles = {
    denial: await storageStateIdentity(args.denial_storage_state, "denial_storage_state"),
    failure: await storageStateIdentity(args.failure_storage_state, "failure_storage_state"),
    success: await storageStateIdentity(args.success_storage_state, "success_storage_state"),
  };
  const scenarios = Object.fromEntries(Object.entries(storageStateFiles).map(([scenario, file]) => [scenario, file.identity]));
  const storageStatePaths = runOwnedStorageStatePaths(outputDir);
  return {
    source,
    historicalEvidence,
    contract: contractIdentity,
    repository: {name: contract.repository, root: REPO_ROOT},
    script,
    fixture: {...fixture.identity, urls_sha256: fixture.descriptor.urls_sha256},
    failureControl: {
      ...failureControl.identity,
      urls_sha256: failureControl.descriptor.urls_sha256,
      result_oracles_sha256: crypto.createHash("sha256").update(JSON.stringify(resultOracles)).digest("hex"),
    },
    resultOracles,
    runtime: runtime.identity,
    runtimeSource: {wikijump_commit: runtime.descriptor.wikijump_commit, wikijump_tree: runtime.descriptor.wikijump_tree},
    storageStateFiles,
    scenarios,
    storageStatePaths,
    browserStatePaths: Object.values(storageStatePaths),
    browserExecutable,
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

export function assertLoadingBoundaryPresent(present, subjectId) {
  if (!present) throw new Error(`${subjectId} loading predicate was not true at capture`);
}

function attachDiagnostics(page) {
  const diagnostics = {consoleErrors: [], pageErrors: [], failedRequests: [], httpErrors: [], bytes: 0, exceeded: false};
  const record = (field, value) => {
    const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (diagnostics.bytes + bytes > DIAGNOSTIC_MAX_BYTES) {
      diagnostics.exceeded = true;
      return;
    }
    diagnostics[field].push(value);
    diagnostics.bytes += bytes;
  };
  const onConsole = (message) => {
    if (message.type() === "error") record("consoleErrors", message.text());
  };
  const onPageError = (error) => record("pageErrors", errorMessage(error));
  const onRequestFailed = (request) => record("failedRequests", {url: request.url(), error: request.failure()?.errorText ?? null});
  const onResponse = (response) => {
    if (response.status() >= 400) record("httpErrors", {url: response.url(), status: response.status()});
  };
  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);
  diagnostics.cleanup = () => {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
    page.off("requestfailed", onRequestFailed);
    page.off("response", onResponse);
  };
  return diagnostics;
}

function assertDiagnosticsBounded(diagnostics) {
  if (diagnostics.exceeded) throw new Error(`diagnostics exceed the ${DIAGNOSTIC_MAX_BYTES}-byte limit`);
}

function matchesDomPredicate(value) {
    const element = document.querySelector(value.selector);
    if (value.state === "absent") return element === null;
    if (!element) return false;
    if (value.state === "visible") {
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0) return false;
    }
    if (value.text_not && element.textContent?.includes(value.text_not)) return false;
    return true;
}

async function predicateMatches(page, predicate) {
  return await page.evaluate(matchesDomPredicate, predicate);
}

function armDomPredicate(page, predicate, timeoutMs, label) {
  return (async () => {
    if (predicate.state !== "absent" && await predicateMatches(page, predicate)) throw new Error(`${label} predicate preexisted before activation`);
    await withTimeout(
      () => page.evaluate((value) => new Promise((resolve) => {
        const matches = () => {
          const element = document.querySelector(value.selector);
          if (value.state === "absent") return element === null;
          if (!element) return false;
          if (value.state === "visible") {
            const style = getComputedStyle(element);
            if (style.display === "none" || style.visibility === "hidden" || element.getClientRects().length === 0) return false;
          }
          if (value.text_not && element.textContent?.includes(value.text_not)) return false;
          return true;
        };
        if (matches()) {
          resolve(true);
          return;
        }
        const observer = new MutationObserver(() => {
          if (!matches()) return;
          observer.disconnect();
          resolve(true);
        });
        observer.observe(document.documentElement, {subtree: true, childList: true, attributes: true, characterData: true});
      }), predicate),
      timeoutMs,
      `${label} predicate observation`,
    );
  })();
}

export function urlSuffixMatches(rawUrl, suffix) {
  if (rawUrl.endsWith(suffix)) return true;
  if (!suffix.startsWith("/") || suffix.includes("?") || suffix.includes("#")) return false;
  return new URL(rawUrl).pathname.endsWith(suffix);
}

function failureRequestMatches(request, matcher) {
  if (matcher.resource_type !== undefined && request.resourceType() !== matcher.resource_type) return false;
  if (matcher.method !== undefined && request.method() !== matcher.method) return false;
  if (matcher.url_suffix !== undefined && !urlSuffixMatches(request.url(), matcher.url_suffix)) return false;
  return true;
}

async function armFailureControl(page, control, timeoutMs, label) {
  if (control === undefined) return {signal: Promise.resolve(null), cleanup: async () => {}};
  validateFailureControl(control, label);
  let resolved = false;
  let resolveSignal;
  const signal = withTimeout(
    () => new Promise((resolve) => { resolveSignal = resolve; }),
    timeoutMs,
    `${label} failure-control request`,
  );
  const handler = async (route, request) => {
    if (!resolved && failureRequestMatches(request, control.request)) {
      resolved = true;
      resolveSignal({url: request.url(), method: request.method(), resource_type: request.resourceType()});
      await route.abort("failed");
      return;
    }
    await route.fallback();
  };
  await page.route("**/*", handler);
  return {signal, cleanup: async () => page.unroute("**/*", handler)};
}

function armResultOracle(page, oracle, timeoutMs, label) {
  if (oracle.type === "event") return armBrowserEvent(page, oracle.event, timeoutMs, label);
  if (oracle.type === "dom") return armDomPredicate(page, oracle.predicate, timeoutMs, label);
  throw new Error(`${label} has unsupported result oracle`);
}

async function clickVisibleTrigger(page, selector, timeoutMs) {
  const locator = page.locator(selector);
  await locator.waitFor({state: "visible", timeout: timeoutMs});
  const box = await locator.boundingBox();
  if (!box || box.width <= 0 || box.height <= 0) throw new Error(`${selector} has no visible click target`);
  const viewport = page.viewportSize();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  if (viewport && x >= 0 && y >= 0 && x < viewport.width && y < viewport.height) {
    await page.mouse.click(x, y);
    return;
  }
  await locator.click({timeout: timeoutMs, noWaitAfter: true});
}

async function clickAttachedTrigger(page, selector, timeoutMs) {
  const locator = page.locator(selector);
  await locator.waitFor({state: "attached", timeout: timeoutMs});
  await locator.evaluate((element) => element.click());
}

async function waitForSavedPageHydration(page, timeoutMs) {
  const trigger = page.locator("#more-options-button");
  const readinessTimeoutMs = Math.max(timeoutMs, 90_000);
  await trigger.waitFor({state: "attached", timeout: readinessTimeoutMs});
  const deadline = Date.now() + readinessTimeoutMs;
  while (Date.now() < deadline) {
    await trigger.evaluate((element) => element.click());
    const opened = await page.locator("#page-options-bottom-2").waitFor({state: "attached", timeout: 250}).then(() => true).catch(() => false);
    if (opened) {
      await trigger.evaluate((element) => element.click());
      await page.locator("#page-options-bottom-2").waitFor({state: "detached", timeout: timeoutMs});
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("saved page did not hydrate before the bounded readiness deadline");
}

async function resetSavedPageState(page, timeoutMs) {
  const close = page.locator(".action-area-close");
  if (await close.count() > 0) {
    await clickAttachedTrigger(page, ".action-area-close", timeoutMs);
    await close.waitFor({state: "detached", timeout: timeoutMs});
  }
  const options = page.locator("#page-options-bottom-2");
  if (await options.count() > 0) {
    await clickAttachedTrigger(page, "#more-options-button", timeoutMs);
    await options.waitFor({state: "detached", timeout: timeoutMs});
  }
}

function requestMatches(request, event) {
  if (event.method && request.method() !== event.method) return false;
  if (!urlSuffixMatches(request.url(), event.url_suffix)) return false;
  return !event.post_data_contains || (request.postData() ?? "").includes(event.post_data_contains);
}

export function requireNavigationResponse(response, event, label) {
  if (!response || !response.url().endsWith(event.url_suffix) || response.status() !== event.status) {
    throw new Error(`${label} navigation did not match its exact destination and status`);
  }
  return response;
}

function armBrowserEvent(page, event, timeoutMs, label) {
  if (event.kind === "navigation") {
    const dataPath = `${event.url_suffix}/__data.json`;
    return Promise.all([
      page.waitForURL((url) => url.pathname.endsWith(event.url_suffix), {waitUntil: "commit", timeout: timeoutMs}),
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.status() === event.status && response.request().method() === "GET" && url.pathname.endsWith(dataPath);
      }, {timeout: timeoutMs}),
    ]).then(([, response]) => requireNavigationResponse({
      url: () => page.url(),
      status: () => response.status(),
    }, event, label));
  }
  if (event.kind === "request") {
    return page.waitForRequest((request) => requestMatches(request, event), {timeout: timeoutMs});
  }
  if (event.kind === "response") {
    return page.waitForResponse((response) => (event.status === undefined || response.status() === event.status) && requestMatches(response.request(), event), {timeout: timeoutMs});
  }
  throw new Error(`${label} has unsupported browser event ${event.kind}`);
}

async function writeExclusiveFile(filePath, data, label = "artifact") {
  const publication = await publishBytesNoReplace(filePath, data, {mode: 0o600});
  if (publication === "exists") throw new Error(`${label} already exists: ${filePath}`);
}

async function writeExclusiveJson(filePath, value) {
  await writeExclusiveFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeAndVerifyArtifact(filePath, data, label) {
  await writeExclusiveFile(filePath, data);
  const identity = await fileIdentity(filePath, label);
  const expectedSha256 = crypto.createHash("sha256").update(data).digest("hex");
  if (identity.sha256 !== expectedSha256) throw new Error(`${label} SHA-256 changed after publication`);
  return identity;
}

async function captureObservation(page, captureDisplay, diagnostics, args, execution, subject, scenario, interval, navigationStatus, outputDir) {
  assertDiagnosticsBounded(diagnostics);
  const subjectDir = path.join(outputDir, safePathSegment(subject.id));
  await fs.mkdir(subjectDir, {recursive: true, mode: 0o700});
  const stem = `${safePathSegment(scenario.id)}-${safePathSegment(interval)}`;
  const domPath = path.join(subjectDir, `${stem}.html`);
  const screenshotPath = path.join(subjectDir, `${stem}.jpg`);
  let html = "";
  const captureErrors = [];
  try {
    html = await withTimeout(() => page.content(), args.timeoutMs, "DOM capture");
  } catch (error) {
    captureErrors.push(`DOM: ${errorMessage(error)}`);
  }
  const domBytes = assertByteLimit(Buffer.from(html, "utf8"), DOM_MAX_BYTES, "DOM artifact");
  const domIdentity = await writeAndVerifyArtifact(domPath, domBytes, "DOM artifact");
  const screenshot = assertByteLimit(
    await withTimeout(
      () => captureViewportScreenshot(page, captureDisplay, args.timeoutMs),
      args.timeoutMs,
      "screenshot capture",
    ),
    SCREENSHOT_MAX_BYTES,
    "screenshot artifact",
  );
  const screenshotIdentity = await writeAndVerifyArtifact(screenshotPath, screenshot, "screenshot artifact");
  const resultOracle = execution.resultOracles?.[scenario.id]?.[subject.id];
  return {
    actor_class: scenario.actor_class,
    browser_identity: execution.browserIdentity,
    capture_errors: captureErrors,
    console_errors: [...diagnostics.consoleErrors],
    dom: domPath,
    dom_sha256: domIdentity.sha256,
    failed_requests: [...diagnostics.failedRequests],
    http_errors: [...diagnostics.httpErrors],
    interval,
    page_errors: [...diagnostics.pageErrors],
    runtime_identity: execution.runtimeIdentity,
    ...(resultOracle ? {result_oracle: resultOracle} : {}),
    scenario: scenario.id,
    screenshot: screenshotPath,
    screenshot_sha256: screenshotIdentity.sha256,
    status: navigationStatus,
    storage_state: execution.storageState,
    subject_id: subject.id,
    timestamp: new Date().toISOString(),
    url: page.url(),
  };
}

async function waitForCandidateNetworkIdle(page, timeoutMs, executionMode) {
  try {
    await page.waitForLoadState("networkidle", {timeout: timeoutMs});
  } catch (error) {
    if (executionMode !== "candidate" || !/Timeout/u.test(errorMessage(error))) throw error;
  }
}

async function waitForCandidateDocumentReady(page, timeoutMs, executionMode) {
  try {
    await page.waitForLoadState("domcontentloaded", {timeout: timeoutMs});
  } catch (error) {
    if (executionMode !== "candidate" || !/Timeout/u.test(errorMessage(error))) throw error;
  }
}

async function captureSubjectScenario(context, captureDisplay, args, execution, subject, scenario, url, outputDir, options = {}) {
  const page = options.page ?? await context.newPage();
  const ownsPage = options.page === undefined;
  const diagnostics = attachDiagnostics(page);
  let navigationStatus = options.navigationStatus ?? null;
  const clickTrigger = options.attachedTriggers ? clickAttachedTrigger : clickVisibleTrigger;
  const triggerTimeoutMs = options.triggerTimeoutMs ?? args.timeoutMs;
  const signalTimeoutMs = options.signalTimeoutMs ?? args.timeoutMs;
  try {
    if (options.navigate !== false) {
      const response = await page.goto(url, {waitUntil: "commit", timeout: args.timeoutMs});
      navigationStatus = response?.status() ?? null;
    }
    const triggers = subject.trigger_selectors;
    const resultOracle = scenario.id === "success"
      ? null
      : execution.resultOracles?.[scenario.id]?.[subject.id];
    const activates = scenario.id === "success" || (resultOracle?.activation ?? "click") === "click";
    if (activates) for (const selector of triggers.slice(0, -1)) {
      await clickTrigger(page, selector, triggerTimeoutMs);
    }
    const records = [];
    if (scenario.id === "success") {
      records.push(await captureObservation(page, captureDisplay, diagnostics, args, execution, subject, scenario, "selection", navigationStatus, outputDir));
      await waitForCandidateDocumentReady(page, triggerTimeoutMs, args.executionMode);
      await waitForCandidateNetworkIdle(page, triggerTimeoutMs, args.executionMode);
      const loadingSignal = subject.loading.kind === "dom"
        ? armDomPredicate(page, subject.loading, signalTimeoutMs, `${subject.id} loading`)
        : armBrowserEvent(page, subject.loading, signalTimeoutMs, `${subject.id} loading`);
      const settledSignal = subject.loading.kind === "navigation"
        ? null
        : armDomPredicate(page, subject.settled_predicate, signalTimeoutMs, `${subject.id} settled`);
      const successSignal = subject.success_event
        ? armBrowserEvent(page, subject.success_event, signalTimeoutMs, `${subject.id} success`)
        : null;
      for (const signal of [loadingSignal, settledSignal, successSignal]) {
        if (signal) void signal.catch(() => undefined);
      }
      await clickTrigger(page, triggers.at(-1), triggerTimeoutMs);
      const loadingResult = await loadingSignal;
      if (subject.loading.kind === "navigation") navigationStatus = loadingResult?.status() ?? null;
      records.push(await captureObservation(page, captureDisplay, diagnostics, args, execution, subject, scenario, "loading", navigationStatus, outputDir));
      if (settledSignal) await settledSignal;
      else await page.waitForFunction(matchesDomPredicate, subject.settled_predicate, {timeout: args.timeoutMs});
      records.push(await captureObservation(page, captureDisplay, diagnostics, args, execution, subject, scenario, "settled", navigationStatus, outputDir));
      if (successSignal) await successSignal;
      if (!(await predicateMatches(page, subject.settled_predicate))) {
        throw new Error(`${subject.id} settled predicate was not true at success`);
      }
      records.push(await captureObservation(page, captureDisplay, diagnostics, args, execution, subject, scenario, "success", navigationStatus, outputDir));
    } else {
      await waitForCandidateDocumentReady(page, triggerTimeoutMs, args.executionMode);
      await waitForCandidateNetworkIdle(page, triggerTimeoutMs, args.executionMode);
      if (!resultOracle) throw new Error(`${scenario.id} ${subject.id} has no exact result oracle`);
      const resultSignal = armResultOracle(page, resultOracle, args.timeoutMs, `${scenario.id} ${subject.id} result`);
      void resultSignal.catch(() => undefined);
      const failureControl = await armFailureControl(page, resultOracle.failure_control, args.timeoutMs, `${scenario.id} ${subject.id}`);
      void failureControl.signal.catch(() => undefined);
      try {
        if ((resultOracle.activation ?? "click") === "click") {
          await clickTrigger(page, triggers.at(-1), triggerTimeoutMs);
        }
        await Promise.all([resultSignal, failureControl.signal]);
      } finally {
        await failureControl.cleanup();
      }
      records.push(await captureObservation(page, captureDisplay, diagnostics, args, execution, subject, scenario, scenario.id, navigationStatus, outputDir));
    }
    return records;
  } finally {
    diagnostics.cleanup();
    if (ownsPage) await withTimeout(() => page.close(), SHUTDOWN_TIMEOUT_MS, `${subject.id} page shutdown`);
  }
}

async function captureSavedPageSubjects(context, captureDisplay, args, execution, subjects, scenario, url, outputDir) {
  const page = await context.newPage();
  const records = [];
  const failures = [];
  try {
    const response = await page.goto(url, {waitUntil: "commit", timeout: args.timeoutMs});
    const navigationStatus = response?.status() ?? null;
    if (scenario.id !== "denial") await waitForSavedPageHydration(page, args.timeoutMs);
    for (const subject of subjects) {
      try {
        records.push(...await captureSubjectScenario(
          context,
          captureDisplay,
          args,
          execution,
          subject,
          scenario,
          url,
          outputDir,
          {page, navigate: false, navigationStatus, attachedTriggers: scenario.id !== "denial"},
        ));
      } catch (error) {
        failures.push({subject_id: subject.id, scenario: scenario.id, message: errorMessage(error)});
      } finally {
        if (scenario.id !== "denial") {
          try {
            await resetSavedPageState(page, args.timeoutMs);
          } catch (error) {
            failures.push({subject_id: subject.id, scenario: scenario.id, message: `saved-page reset failed: ${errorMessage(error)}`});
            break;
          }
        }
      }
    }
  } finally {
    await withTimeout(() => page.close(), SHUTDOWN_TIMEOUT_MS, `${scenario.id} saved-page shutdown`);
  }
  return {records, failures};
}

export async function closeCaptureEgressProxies(sourceProxy, localProxy, timeoutMs = SHUTDOWN_TIMEOUT_MS) {
  return await closeCaptureEgressProxiesWithTimeout(sourceProxy, localProxy, timeoutMs);
}

async function closeCaptureEgressProxiesWithTimeout(sourceProxy, localProxy, timeoutMs) {
  let allClosed = Boolean(sourceProxy && localProxy);
  let error = null;
  for (const proxy of [sourceProxy, localProxy]) {
    if (!proxy) continue;
    try {
      await withTimeout(() => proxy.close(), timeoutMs, "capture egress proxy shutdown");
    } catch (nextError) {
      allClosed = false;
      error ??= nextError;
    }
  }
  return {allClosed, error};
}

async function closeBrowserSession(session) {
  const failures = [];
  const resources = [
    [session?.localContext, "local browser context"],
    [session?.sourceContext ?? session?.context, "source browser context"],
    [session?.browser, "browser"],
  ];
  const closed = new Set();
  for (const [resource, label] of resources) {
    if (!resource || closed.has(resource)) continue;
    closed.add(resource);
    try {
      await withTimeout(() => resource.close(), SHUTDOWN_TIMEOUT_MS, `${label} shutdown`);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "browser session failed to close");
}

function printHelp() {
  console.log(`Usage: capture-framerail-route-action-temporal.mjs --output-dir DIR --browser-executable FILE --fixture-identity FILE --failure-control-identity FILE --runtime-identity FILE --denial-storage-state FILE --failure-storage-state FILE --success-storage-state FILE --denial-actor-class CLASS --failure-actor-class CLASS --success-actor-class CLASS --denial-missing-url URL --denial-saved-url URL --failure-missing-url URL --failure-saved-url URL --success-missing-url URL --success-saved-url URL [options]

Captures the six issue #1372 temporal intervals for all 14 subjects. The URL flags name root-prepared denial, failure, and success fixtures for missing and saved pages. The command does not create or mutate fixtures, runtime data, or authority state.`);
}

export async function runTemporalCapture(args) {
  const contractFile = await jsonIdentity(args.contract, "run_contract", "wikijump.framerail_route_action_browser_run.v1");
  const contract = contractFile.descriptor;
  const executionMode = args.executionMode ?? "live";
  const requestIntervalMs = args.requestIntervalMs ?? DEFAULT_REQUEST_INTERVAL_MS;
  if (!["candidate", "live"].includes(executionMode) || !Number.isSafeInteger(requestIntervalMs) || requestIntervalMs !== 0) {
    throw new Error("temporal capture execution mode and request interval are incompatible");
  }
  const {scenarios: contractScenarios} = validateTemporalRunContract(contract);
  const urls = urlsFromArgs(args);
  const runId = args.runId;
  const requestGateConfigPath = path.join(args.outputDir, "request-gate-config.json");
  const recordsPath = path.join(args.outputDir, "records.json");
  const identities = await inputIdentities(args, contract, urls, contractFile.identity, args.outputDir);
  const actors = {
    denial: args.denial_actor_class,
    failure: args.failure_actor_class,
    success: args.success_actor_class,
  };
  for (const scenario of contractScenarios) {
    if (!contract.actor_classes.includes(actors[scenario.id])) throw new Error(`${scenario.id} actor class is not in the run contract`);
  }
  const plan = buildTemporalCapturePlan(contract, urls);
  const localOrigins = [...new Set(Object.values(urls).flatMap((scenarioUrls) => Object.values(scenarioUrls).flatMap((url) => localBrowserCaptureOrigins(url))))].sort();
  await validateOutputPreflight(args.outputDir, [requestGateConfigPath, recordsPath, ...identities.browserStatePaths]);
  const {chromium} = loadPlaywright(args.browserRoot);
  await fs.mkdir(args.outputDir, {mode: 0o700});
  let captureLock = null;
  let requestGate = null;
  let gateStateConfirmed = false;
  let sourceEgressProxy = null;
  let localEgressProxy = null;
  let captureDisplay = null;
  let browserSession = null;
  let observedBrowserIdentity = null;
  let browserSessionsClosed = 0;
  let egressProxiesClosed = false;
  let captureDisplayClosed = false;
  let requestGateFlushed = false;
  let captureLockReleased = false;
  let captureError = null;
  let cleanupError = null;
  let runOwnedStorageStates = null;
  let storageStatesRemoved = false;
  let result = null;
  try {
    runOwnedStorageStates = await copyRunOwnedStorageStates(identities.storageStateFiles, identities.storageStatePaths);
    const scenarios = contractScenarios.map((scenario) => ({
      ...scenario,
      actor_class: actors[scenario.id],
      storage_state: runOwnedStorageStates[scenario.id],
    }));
    captureLock = await acquireBrowserCaptureLock({runId});
    requestGate = await createPersistentBrowserRequestGate({statePath: captureLock.statePath, intervalMs: requestIntervalMs});
    const sourceResponseCacheOptions = candidatePublicEvidenceResponseCacheOptions();
    await writeExclusiveJson(requestGateConfigPath, {
      schema: "wikijump_full_parity.browser_request_gate_config.v1",
      status: "sealed_before_browser_request",
      run_id: runId,
      lock: {path: captureLock.path, owner: captureLock.owner},
      state_path: captureLock.statePath,
      execution_mode: executionMode,
      interval_ms: requestIntervalMs,
      source_context_exempt_origins: [],
      local_context_exempt_origins: localOrigins,
      public_request_policy: "every HTTP(S) request except an exact local-context origin is admitted by the shared gate",
      source_response_cache: {
        persistent_dir: sourceResponseCacheOptions.persistentDir,
        persistent_identity: sourceResponseCacheOptions.persistentIdentity,
        cache_documents: sourceResponseCacheOptions.cacheDocuments,
        evidence_replay: sourceResponseCacheOptions.evidenceReplay,
      },
      service_workers: "block",
      web_sockets: "blocked_without_network_connection",
    });
    captureDisplay = await startCaptureDisplay();
    sourceEgressProxy = await startCaptureEgressProxy();
    localEgressProxy = await startCaptureEgressProxy({allowedLocalOrigins: localOrigins});
    const records = [];
    const failures = [];
    for (const scenario of scenarios) {
      browserSession = await openBrowser({
        chromium,
        browserExecutable: identities.browserExecutable.path,
        headless: false,
        browserEnvironment: {...process.env, DISPLAY: captureDisplay.display},
        browserArgs: ["--window-position=0,0", "--window-size=1280,720"],
        ignoreHttpsErrors: args.ignoreHttpsErrors,
        storageState: scenario.storage_state.path,
        sourceProxyServer: sourceEgressProxy.url,
        localProxyServer: localEgressProxy.url,
        requestGate,
        localOrigins,
        sourceResponseCacheOptions,
      });
      try {
        if (!browserSession.localContext) throw new Error("browser local context was not initialized");
        const browserIdentity = {
          engine: "chromium",
          executable: identities.browserExecutable,
          version: browserSession.browser.version(),
        };
        if (observedBrowserIdentity && JSON.stringify(observedBrowserIdentity) !== JSON.stringify(browserIdentity)) {
          throw new Error("browser identity changed between scenario contexts");
        }
        observedBrowserIdentity ??= browserIdentity;
        const execution = {
          browserIdentity,
          resultOracles: identities.resultOracles,
          runtimeIdentity: identities.runtime,
          storageState: scenario.storage_state,
        };
        const missingSubjects = contract.subjects.filter((subject) => subject.kind === "missing_page");
        const savedSubjects = contract.subjects.filter((subject) => subject.kind === "saved_page");
        for (const subject of missingSubjects) {
          try {
            records.push(...await captureSubjectScenario(
              browserSession.localContext,
              captureDisplay,
              args,
              execution,
              subject,
              scenario,
              urls[scenario.id][subject.kind],
              args.outputDir,
              {
                attachedTriggers: scenario.id === "success" && subject.id !== "control:restore",
                triggerTimeoutMs: scenario.id === "success" ? Math.max(args.timeoutMs, 90_000) : args.timeoutMs,
                signalTimeoutMs: scenario.id === "success" ? Math.max(args.timeoutMs, 90_000) : args.timeoutMs,
              },
            ));
          } catch (error) {
            failures.push({subject_id: subject.id, scenario: scenario.id, message: errorMessage(error)});
          }
        }
        const savedPageResult = await captureSavedPageSubjects(
          browserSession.localContext,
          captureDisplay,
          args,
          execution,
          savedSubjects,
          scenario,
          urls[scenario.id].saved_page,
          args.outputDir,
        );
        records.push(...savedPageResult.records);
        failures.push(...savedPageResult.failures);
      } finally {
        const session = browserSession;
        browserSession = null;
        try {
          await closeBrowserSession(session);
          browserSessionsClosed += 1;
        } catch (error) {
          cleanupError ??= error;
        }
      }
    }
    const expected = plan.length;
    const artifactFailures = records.filter(({capture_errors: errors}) => errors.length > 0).length;
    result = {
      schema: "wikijump.framerail_route_action_temporal_evidence.v1",
      issue: contract.issue,
      status: failures.length === 0 && artifactFailures === 0 && records.length === expected ? "captured" : "failed",
      source_revision: identities.source.wikijump_commit,
      source_tree: identities.source.wikijump_tree,
      historical_evidence: contract.historical_evidence,
      run_id: runId,
      required_intervals: contract.required_intervals,
      expected_observation_count: expected,
      observation_count: records.length,
      failures,
      artifact_failures: artifactFailures,
      evidence: records.map((record) => ({...record, source_revision: identities.source.wikijump_commit})),
      capture: {
        browser_identity: observedBrowserIdentity,
        source_identity: identities.source,
        repository_identity: identities.repository,
        capture_script_identity: identities.script,
        run_contract_identity: identities.contract,
        fixture_identity: identities.fixture,
        historical_evidence_identity: identities.historicalEvidence,
        failure_control_identity: identities.failureControl,
        runtime_identity: identities.runtime,
        runtime_source_identity: identities.runtimeSource,
        timeout_ms: args.timeoutMs,
      screenshot: true,
        screenshot_capture: {
          method: "run_owned_xvfb_viewport",
          display_width: captureDisplay.width,
          display_height: captureDisplay.height,
          display_depth: captureDisplay.depth,
        },
        request_gate_config: requestGateConfigPath,
        execution_mode: executionMode,
        request_interval_ms: requestIntervalMs,
        request_gate: requestGate.snapshot(),
      },
    };
  } catch (error) {
    captureError = error;
  } finally {
    try {
      if (browserSession) {
        await closeBrowserSession(browserSession);
        browserSessionsClosed += 1;
      }
    } catch (error) {
      cleanupError ??= error;
    }
    try {
      if (captureDisplay) {
        await captureDisplay.close();
        captureDisplayClosed = true;
      }
    } catch (error) {
      cleanupError ??= error;
    }
    const proxyCleanup = await closeCaptureEgressProxies(sourceEgressProxy, localEgressProxy);
    egressProxiesClosed = proxyCleanup.allClosed;
    cleanupError ??= proxyCleanup.error;
    try {
      if (requestGate) {
        await withTimeout(() => requestGate.flush(), SHUTDOWN_TIMEOUT_MS, "request gate flush");
        requestGateFlushed = true;
      }
    } catch (error) {
      cleanupError ??= error;
    }
    if (captureLock && !gateStateConfirmed) {
      try {
        await withTimeout(() => captureLock.confirmState(), SHUTDOWN_TIMEOUT_MS, "capture lock state confirmation");
        gateStateConfirmed = true;
      } catch (error) {
        cleanupError ??= error;
      }
    }
    if (captureLock && gateStateConfirmed) {
      try {
        await withTimeout(() => captureLock.release(), SHUTDOWN_TIMEOUT_MS, "capture lock release");
        captureLockReleased = true;
      } catch (error) {
        cleanupError ??= error;
      }
    }
    try {
      await withTimeout(async () => {
        await removeRunOwnedStorageStates(runOwnedStorageStates);
        await assertRunOwnedStorageStatesAbsent(runOwnedStorageStates);
        storageStatesRemoved = true;
      }, SHUTDOWN_TIMEOUT_MS, "storage-state cleanup");
    } catch (error) {
      cleanupError ??= error;
    }
  }
  if (result) {
    if (cleanupError) result.status = "failed";
    result.cleanup_observed = {
      browser_sessions_closed: browserSessionsClosed,
      egress_proxies_closed: egressProxiesClosed,
      capture_display_closed: captureDisplayClosed,
      request_gate_flushed: requestGateFlushed,
      capture_lock_released: captureLockReleased,
      storage_states_removed: storageStatesRemoved,
      error: cleanupError ? errorMessage(cleanupError) : null,
    };
    await writeExclusiveJson(recordsPath, result);
  }
  if (captureError) throw captureError;
  if (cleanupError) throw cleanupError;
  if (result?.status !== "captured") {
    console.error(`captured ${result?.observation_count ?? 0}/${result?.expected_observation_count ?? plan.length} observations`);
    return 1;
  }
  console.log(`wrote ${result.observation_count} temporal observations to ${path.join(args.outputDir, "records.json")}`);
  return 0;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return 0;
  }
  return await runTemporalCapture(args);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  run().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
