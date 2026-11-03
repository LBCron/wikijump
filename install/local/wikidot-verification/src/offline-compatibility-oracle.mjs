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
  return Object.freeze({oracle, goldenPath, oraclePath: absolutePath});
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
