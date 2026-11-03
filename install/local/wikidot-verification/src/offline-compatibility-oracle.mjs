import {execFile as execFileCallback} from "node:child_process";
import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";

import {
  DEFAULT_THRESHOLDS,
  compareCaptures,
} from "./standing-browser-parity-contract.mjs";
import {canaryForUrl} from "./standing-browser-canaries.mjs";

export const OFFLINE_BROWSER_ORACLE_SCHEMA =
  "wikijump.offline_compatibility_browser_oracle.v1";

export const DEFAULT_VISUAL_RMSE_THRESHOLD = 0.015;

const SHA256_RE = /^[0-9a-f]{64}$/u;
const GIT_SHA_RE = /^[0-9a-f]{40}$/u;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/u;
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;
const execFile = promisify(execFileCallback);

function requireObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireSha256(value, label) {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256`);
  }
  return value;
}

function requireGitSha(value, label) {
  if (typeof value !== "string" || !GIT_SHA_RE.test(value)) {
    throw new Error(`${label} must be a lowercase git SHA-1`);
  }
  return value;
}

function requireIsoDate(value, label) {
  if (typeof value !== "string" || !ISO_DATE_RE.test(value)) {
    throw new Error(`${label} must be an ISO calendar date`);
  }
  return value;
}

function requireIsoTimestamp(value, label) {
  if (typeof value !== "string" || !ISO_TIMESTAMP_RE.test(value)) {
    throw new Error(`${label} must be a UTC ISO-8601 timestamp`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function validateRecaptureSuccessorProvenance(provenance) {
  if (provenance.status !== "pass") {
    throw new Error(
      "offline browser oracle successor must record a passing recapture",
    );
  }
  const supersedes = requireObject(
    provenance.supersedes,
    "oracle provenance.supersedes",
  );
  requireString(supersedes.fixture_id, "oracle provenance.supersedes.fixture_id");
  requireSha256(
    supersedes.oracle_sha256,
    "oracle provenance.supersedes.oracle_sha256",
  );
  requireSha256(
    supersedes.golden_sha256,
    "oracle provenance.supersedes.golden_sha256",
  );
  requireIsoDate(
    provenance.owner_authorized_on,
    "oracle provenance.owner_authorized_on",
  );
  requireIsoTimestamp(
    provenance.live_captured_at,
    "oracle provenance.live_captured_at",
  );
  requireIsoTimestamp(
    provenance.standing_captured_at,
    "oracle provenance.standing_captured_at",
  );
  requireGitSha(
    provenance.standing_wikijump_sha,
    "oracle provenance.standing_wikijump_sha",
  );
  requireGitSha(
    provenance.standing_wikijump_tree,
    "oracle provenance.standing_wikijump_tree",
  );
  requireGitSha(provenance.ftml_sha, "oracle provenance.ftml_sha");
  requireSha256(provenance.golden_sha256, "oracle provenance.golden_sha256");
  requirePositiveInteger(
    provenance.golden_width,
    "oracle provenance.golden_width",
  );
  requirePositiveInteger(
    provenance.golden_height,
    "oracle provenance.golden_height",
  );
}

function requireExactHttpsUrl(value, label) {
  const parsed = new URL(requireString(value, label));
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.hash
  ) {
    throw new Error(`${label} must be an unauthenticated HTTPS URL`);
  }
  return parsed.href;
}

export function validateOfflineBrowserOracle(value) {
  const oracle = requireObject(value, "offline browser oracle");
  if (oracle.schema !== OFFLINE_BROWSER_ORACLE_SCHEMA) {
    throw new Error(
      `offline browser oracle must use ${OFFLINE_BROWSER_ORACLE_SCHEMA}`,
    );
  }
  const provenance = requireObject(oracle.provenance, "oracle provenance");
  const successor = provenance.kind === "recapture-successor";
  if (successor) {
    validateRecaptureSuccessorProvenance(provenance);
  } else {
    if (provenance.final_zero_status !== "pass") {
      throw new Error("offline browser oracle must derive from a passing final-zero");
    }
    requireSha256(
      provenance.final_zero_receipt_sha256,
      "oracle provenance.final_zero_receipt_sha256",
    );
  }
  for (const field of [
    "standing_browser_proof_sha256",
    "standing_browser_parity_sha256",
    "live_reference_sha256",
  ]) {
    requireSha256(provenance[field], `oracle provenance.${field}`);
  }
  requireSha256(
    provenance.accepted_browser?.executable_sha256,
    "oracle provenance.accepted_browser.executable_sha256",
  );
  const pair = requireObject(oracle.pair, "oracle pair");
  const liveUrl = requireExactHttpsUrl(pair.live_url, "oracle pair.live_url");
  const localUrl = requireExactHttpsUrl(pair.local_url, "oracle pair.local_url");
  const liveCanary = canaryForUrl(liveUrl);
  const localCanary = canaryForUrl(localUrl);
  if (!liveCanary || !localCanary || liveCanary.slug !== localCanary.slug) {
    throw new Error("offline browser oracle pair must name one declared canary");
  }
  const liveCapture = requireObject(oracle.live_capture, "oracle live_capture");
  if (liveCapture.input_url !== liveUrl || liveCapture.final_url !== liveUrl) {
    throw new Error("offline browser oracle live capture URL does not match its pair");
  }
  if (liveCapture.navigation_status !== 200 || liveCapture.capture_error) {
    throw new Error("offline browser oracle live capture is incomplete");
  }
  if (oracle.accepted_comparison?.status !== "pass") {
    throw new Error("offline browser oracle lacks a passing accepted comparison");
  }
  const golden = requireObject(
    oracle.verified_local_golden,
    "oracle verified_local_golden",
  );
  const goldenFile = requireString(golden.file, "oracle golden file");
  if (path.basename(goldenFile) !== goldenFile) {
    throw new Error("oracle golden file must be a basename");
  }
  requireSha256(golden.sha256, "oracle golden sha256");
  if (successor && provenance.golden_sha256 !== golden.sha256) {
    throw new Error("offline browser oracle successor golden SHA-256 mismatch");
  }
  return Object.freeze({
    ...oracle,
    pair: Object.freeze({live_url: liveUrl, local_url: localUrl}),
  });
}

export async function sha256File(filePath) {
  const buffer = await fs.readFile(filePath);
  return createHash("sha256").update(buffer).digest("hex");
}

export async function loadOfflineBrowserOracle(filePath) {
  const absolutePath = path.resolve(filePath);
  const raw = JSON.parse(await fs.readFile(absolutePath, "utf8"));
  const oracle = validateOfflineBrowserOracle(raw);
  const goldenPath = path.join(
    path.dirname(absolutePath),
    oracle.verified_local_golden.file,
  );
  const goldenBuffer = await fs.readFile(goldenPath);
  const goldenSha256 = createHash("sha256").update(goldenBuffer).digest("hex");
  if (goldenSha256 !== oracle.verified_local_golden.sha256) {
    throw new Error("offline browser oracle golden PNG SHA-256 mismatch");
  }
  if (oracle.provenance.kind === "recapture-successor") {
    const dimensions = readPngDimensions(goldenBuffer);
    if (
      dimensions.width !== oracle.provenance.golden_width ||
      dimensions.height !== oracle.provenance.golden_height
    ) {
      throw new Error("offline browser oracle golden PNG dimensions mismatch");
    }
  }
  return Object.freeze({oracle, goldenPath, oraclePath: absolutePath});
}

function readPngDimensions(buffer) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const valid =
    buffer.length >= 24 &&
    signature.every((byte, index) => buffer[index] === byte) &&
    buffer.toString("ascii", 12, 16) === "IHDR";
  if (!valid) {
    throw new Error("offline browser oracle golden PNG lacks a PNG IHDR header");
  }
  return {width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20)};
}

export function compareCaptureToOfflineOracle(localCapture, oracle) {
  const checked = validateOfflineBrowserOracle(oracle);
  const contract = canaryForUrl(checked.pair.live_url);
  return compareCaptures(
    localCapture,
    checked.live_capture,
    DEFAULT_THRESHOLDS,
    contract.geometry_selectors,
    {...contract, comparison_scope: "standing-chrome"},
  );
}

export function parseImageMagickRmse(stderr) {
  const text = String(stderr ?? "").trim();
  const match = /(?:^|\s)([0-9]+(?:\.[0-9]+)?)\s+\(([0-9]+(?:\.[0-9]+)?(?:e[+-]?\d+)?)\)\s*$/iu.exec(
    text,
  );
  if (!match) throw new Error(`could not parse ImageMagick RMSE: ${text}`);
  const absolute = Number(match[1]);
  const normalized = Number(match[2]);
  if (!Number.isFinite(absolute) || !Number.isFinite(normalized)) {
    throw new Error("ImageMagick RMSE is not finite");
  }
  return {absolute, normalized};
}

export async function comparePngRmse(
  expectedPath,
  actualPath,
  {
    threshold = DEFAULT_VISUAL_RMSE_THRESHOLD,
    command = "compare",
    run = execFile,
  } = {},
) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new Error("visual RMSE threshold must be between 0 and 1");
  }
  let stderr = "";
  let exitCode = 0;
  try {
    const result = await run(command, [
      "-metric",
      "RMSE",
      expectedPath,
      actualPath,
      "null:",
    ]);
    stderr = result.stderr ?? "";
  } catch (error) {
    if (error?.code !== 1) {
      if (error?.code === "ENOENT") {
        throw new Error(
          "offline browser visual regression requires ImageMagick `compare`",
        );
      }
      throw error;
    }
    exitCode = 1;
    stderr = error.stderr ?? "";
  }
  const metric = parseImageMagickRmse(stderr);
  return {
    status: metric.normalized <= threshold ? "pass" : "fail",
    metric: "RMSE",
    normalized_rmse: metric.normalized,
    absolute_rmse: metric.absolute,
    threshold,
    image_magick_exit_code: exitCode,
  };
}
