import fs from "node:fs/promises";
import path from "node:path";

import {
  STANDING_BROWSER_CAPTURE_SCHEMA,
  STANDING_BROWSER_LIVE_REFERENCE_SCHEMA,
  assertRequestGateAbortAccounting,
  canaryContractForPair,
  evaluateFirstPaintCustomProperties,
  evaluatePresenceProbes,
  isExternalFailure,
  policyAllowsFailure,
  validateRequestGateAborts,
  validateLiveCompletionPolicy,
  validateThresholds,
} from "./standing-browser-parity-contract.mjs";
import {
  isPlainObject,
  normalizedUrl,
  requireNonEmptyString,
  requirePlainObject,
  sha256Value,
} from "./standing-browser-parity-util.mjs";

function sameJson(left, right) {
  return sha256Value(left) === sha256Value(right);
}

function normalizedPair(value) {
  const pair = requirePlainObject(value, "canary pair");
  return {
    local_url: normalizedUrl(pair.local_url, "canary pair local_url").href,
    live_url: normalizedUrl(pair.live_url, "canary pair live_url").href,
  };
}

function safeArtifactName(value, label) {
  const name = requireNonEmptyString(value, label);
  if (
    path.basename(name) !== name ||
    /[\\/]/u.test(name) ||
    name === "." ||
    name === ".."
  ) {
    throw new Error(`${label} must be a safe artifact basename`);
  }
  return name;
}

async function verifyScreenshotArtifact(
  root,
  screenshot,
  label,
  expectedFullPage,
) {
  const metadata = requirePlainObject(
    screenshot,
    `live reference ${label} screenshot`,
  );
  const fileName = safeArtifactName(
    metadata.path,
    `live reference ${label} screenshot path`,
  );
  if (metadata.full_page !== expectedFullPage) {
    throw new Error(
      `live reference ${label} screenshot has the wrong full-page value`,
    );
  }
  const filePath = path.join(root, fileName);
  const stat = await fs.lstat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) {
    throw new Error(`live reference ${label} screenshot is unavailable`);
  }
  return { path: fileName, sha256: metadata.sha256, full_page: expectedFullPage };
}

function validateObservedFailure(failure, capture, policy) {
  const value = requirePlainObject(failure, "live reference failure");
  normalizedUrl(value.url, "live reference failure.url");
  if (!policyAllowsFailure(policy, value, capture)) {
    throw new Error(
      `live reference contains an unapproved failure: ${value.url}`,
    );
  }
}

function normalizedBrokenImageFailure(image) {
  const value = requirePlainObject(image, "live reference broken image");
  return {
    kind: "broken_image",
    url: normalizedUrl(value.src, "live reference broken image.src").href,
    resource_type: "image",
    error: "image did not decode",
  };
}

function normalizeRetainedCapture(capture) {
  const input = requirePlainObject(capture, "live reference capture");
  const legacyCapture = input.first_paint?.document?.phase === "domcontentloaded";
  const firstDocument = input.first_paint?.document;
  const settledDocument = input.document;
  return {
    ...input,
    request_gate_aborts: input.request_gate_aborts ?? [],
    first_paint: firstDocument?.phase === "domcontentloaded"
      ? {
          ...input.first_paint,
          document: {
            ...firstDocument,
            phase: "domcontentloaded_immediate_observation",
          },
        }
      : input.first_paint,
    document: settledDocument && !settledDocument.resource_completion
      ? {
          ...settledDocument,
          resource_completion: {
            status: "complete",
            load_ready_state: settledDocument.ready_state,
            font_status: "loaded",
            image_count: settledDocument.rendered_images?.length ?? 0,
            incomplete_image_count: 0,
          },
      }
      : settledDocument,
    ...(legacyCapture ? { legacy_capture: true } : {}),
  };
}

function validateRequestGate(value, { minimumPublicRequests = 0 } = {}) {
  const input = requirePlainObject(value, "live reference request gate");
  const gate = input.schema === "wikijump_full_parity.browser_request_gate.v1"
    ? input
    : input.snapshot?.schema === "wikijump_full_parity.browser_request_gate.v1"
      ? {
          ...input.snapshot,
          public_requests: input.snapshot.public_requests ?? input.snapshot.grants?.length ?? 0,
        }
      : input;
  if (gate.schema !== "wikijump_full_parity.browser_request_gate.v1") {
    throw new Error("live reference request gate has an unsupported schema");
  }
  if (!Number.isInteger(gate.interval_ms) || gate.interval_ms < 0) {
    throw new Error("live reference request gate interval must be non-negative");
  }
  if (gate.execution_mode !== undefined && gate.execution_mode !== "live") {
    throw new Error("live reference request gate must use live execution mode");
  }
  if (gate.enforcement_failed !== false) {
    throw new Error("live reference request gate enforcement was not clean");
  }
  if (
    !Number.isInteger(gate.public_requests) ||
    gate.public_requests < minimumPublicRequests
  ) {
    throw new Error(
      "live reference request gate did not admit every required live navigation",
    );
  }
  return gate;
}

async function validateLiveCapture(capture, pair, root, policy) {
  const legacyCapture = capture?.first_paint?.document?.phase === "domcontentloaded";
  const value = normalizeRetainedCapture(capture);
  if (value.schema !== STANDING_BROWSER_CAPTURE_SCHEMA) {
    throw new Error(
      `live reference capture has an unsupported schema for ${pair.live_url}`,
    );
  }
  if (value.navigation_status !== 200 || value.capture_error) {
    throw new Error(`live reference is incomplete for ${pair.live_url}`);
  }
  const requestGateAborts = validateRequestGateAborts(
    value.request_gate_aborts,
    `live request-gate aborts for ${pair.live_url}`,
  );
  for (const abort of requestGateAborts) {
    const failure = {
      kind: "request_failed",
      url: abort.url,
      resource_type: abort.resource_type,
      error: abort.error,
    };
    if (!policyAllowsFailure(policy, failure, value)) {
      throw new Error(`live reference contains an unapproved request-gate abort: ${abort.url}`);
    }
  }
  if (
    value.first_paint?.document?.phase !==
    "domcontentloaded_immediate_observation"
  ) {
    throw new Error(
      `live reference lacks the required DOMContentLoaded observation for ${pair.live_url}`,
    );
  }
  if (value.document?.phase !== "settled") {
    throw new Error(
      `live reference lacks the required settled observation for ${pair.live_url}`,
    );
  }
  if (value.document?.resource_completion?.status !== "complete") {
    throw new Error(
      `live reference did not complete load, font, and image observation for ${pair.live_url}`,
    );
  }
  if (
    normalizedUrl(value.input_url, "live reference input_url").href !==
    pair.live_url
  ) {
    throw new Error(`live reference URL mismatch: expected ${pair.live_url}`);
  }
  if (
    normalizedUrl(value.final_url, "live reference final_url").href !==
    pair.live_url
  ) {
    throw new Error(
      `live reference final URL mismatch: expected ${pair.live_url}`,
    );
  }
  const contract = canaryContractForPair(pair);
  const immediateProperties = evaluateFirstPaintCustomProperties(
    value.first_paint?.document?.custom_properties,
    contract.first_paint_custom_properties,
  );
  if (immediateProperties.status !== "pass") {
    throw new Error(
      `live reference fails DOMContentLoaded theme properties for ${pair.live_url}`,
    );
  }
  for (const phase of [value.first_paint?.document, value.document]) {
    const failed = evaluatePresenceProbes(
      phase?.presence_probes,
      contract.presence_probes,
    ).filter((probe) => probe.status !== "pass");
    if (failed.length > 0) {
      throw new Error(
        `live reference fails required browser probes for ${pair.live_url}: ${failed.map((probe) => probe.id).join(", ")}`,
      );
    }
  }
  for (const failure of value.failures ?? []) {
    if (legacyCapture && !isExternalFailure(failure, value)) continue;
    validateObservedFailure(failure, value, policy);
  }
  if (!Array.isArray(value.broken_images)) {
    throw new Error(
      `live reference lacks broken image observations for ${pair.live_url}`,
    );
  }
  for (const image of value.broken_images) {
    const failure = normalizedBrokenImageFailure(image);
    if (!isExternalFailure(failure, value)) {
      throw new Error(
        `live reference has a broken first-party image: ${failure.url}`,
      );
    }
    if (!policyAllowsFailure(policy, failure, value)) {
      throw new Error(
        `live reference has an unapproved broken external image: ${failure.url}`,
      );
    }
  }
  const artifacts = {
    domcontentloaded_immediate: await verifyScreenshotArtifact(
      root,
      value.first_paint?.screenshot,
      "DOMContentLoaded immediate",
      false,
    ),
    settled_viewport: await verifyScreenshotArtifact(
      root,
      value.settled_viewport_screenshot,
      "settled viewport",
      false,
    ),
    settled_full_page: await verifyScreenshotArtifact(
      root,
      value.screenshot,
      "settled full page",
      true,
    ),
  };
  return {
    capture: value,
    artifacts,
  };
}

export async function validateLiveReferenceRecord({
  capture,
  pair,
  root,
  policy,
}) {
  const checkedPair = normalizedPair(pair);
  const checkedPolicy = validateLiveCompletionPolicy(policy);
  return await validateLiveCapture(capture, checkedPair, root, checkedPolicy);
}

export function buildLiveReferenceLedger({
  records,
  viewport,
  thresholds,
  policy,
  browserEnvironment,
  requestGate,
  generatedAt = new Date().toISOString(),
}) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new Error("live reference records must be a non-empty array");
  }
  validateLiveCompletionPolicy(policy);
  const checkedThresholds = validateThresholds(thresholds);
  const checkedBrowser = requirePlainObject(
    browserEnvironment,
    "live reference browser environment",
  );
  requireNonEmptyString(
    checkedBrowser.engine,
    "live reference browser environment.engine",
  );
  requireNonEmptyString(
    checkedBrowser.version,
    "live reference browser environment.version",
  );
  const normalizedRecords = records.map((record) => {
    const input = normalizedPair(record.input);
    canaryContractForPair(input);
    return {
      input,
      live: requirePlainObject(record.live, "live reference capture"),
    };
  });
  const liveUrls = normalizedRecords
    .map((record) => record.input.live_url)
    .sort();
  if (new Set(liveUrls).size !== liveUrls.length) {
    throw new Error("live reference contains duplicate canary URLs");
  }
  const checkedRequestGate = validateRequestGate(requestGate, {
    minimumPublicRequests: normalizedRecords.length,
  });
  assertRequestGateAbortAccounting(
    normalizedRecords.map((record) => record.live),
    checkedRequestGate,
  );
  return {
    schema: STANDING_BROWSER_LIVE_REFERENCE_SCHEMA,
    generated_at: requireNonEmptyString(
      generatedAt,
      "live reference generated_at",
    ),
    capture_contract: { viewport, thresholds: checkedThresholds },
    browser: {
      engine: checkedBrowser.engine,
      version: checkedBrowser.version,
    },
    request_gate: checkedRequestGate,
    records: normalizedRecords,
  };
}

export async function loadLiveReference({
  filePath,
  pairs,
  viewport,
  thresholds,
  policy,
}) {
  const reference = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (
    !isPlainObject(reference) ||
    reference.schema !== STANDING_BROWSER_LIVE_REFERENCE_SCHEMA
  ) {
    throw new Error("live reference has an unsupported schema");
  }
  const recordsInput = reference.records ?? [];
  const accountingRecords = recordsInput.map((entry) => ({
    ...entry,
    live: normalizeRetainedCapture(entry.live),
  }));
  const checkedRequestGate = validateRequestGate(reference.request_gate, {
    minimumPublicRequests: Array.isArray(recordsInput)
      ? recordsInput.length
      : 0,
  });
  assertRequestGateAbortAccounting(
    accountingRecords.map((record) => record?.live),
    checkedRequestGate,
  );
  const checkedPolicy = validateLiveCompletionPolicy(policy);
  const contract = reference.capture_contract;
  if (
    !sameJson(contract?.viewport, viewport) ||
    !sameJson(contract?.thresholds, validateThresholds(thresholds))
  ) {
    throw new Error(
      "live reference viewport or thresholds do not match this parity run",
    );
  }
  const expectedPairs = pairs.map(normalizedPair);
  const seen = new Map();
  for (const entry of recordsInput) {
    const input = normalizedPair(entry.input);
    if (seen.has(input.live_url)) {
      throw new Error(
        `live reference contains duplicate URL: ${input.live_url}`,
      );
    }
    seen.set(input.live_url, entry);
  }
  if (seen.size !== expectedPairs.length) {
    throw new Error(
      "live reference does not contain exactly the requested canaries",
    );
  }
  const root = path.dirname(filePath);
  const records = [];
  for (const pair of expectedPairs) {
    const entry = seen.get(pair.live_url);
    if (!entry || normalizedPair(entry.input).live_url !== pair.live_url) {
      throw new Error(
        `live reference does not bind the requested pair: ${pair.live_url}`,
      );
    }
    const validated = await validateLiveCapture(
      entry.live,
      pair,
      root,
      checkedPolicy,
    );
    records.push({ input: pair, ...validated });
  }
  return {
    reference,
    policy: checkedPolicy,
    records,
  };
}
