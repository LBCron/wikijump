import {
  COMMON_GEOMETRY_SELECTORS,
  PAGE_CHROME_SKELETON,
  STANDING_BROWSER_CANARY_SCHEMA,
  assertThemeFamilyCoverage,
  canaryForUrl,
  firstPaintPropertyNames,
  standingBrowserCanaryContractSha256,
} from "./standing-browser-canaries.mjs";
import {
  comparePseudoLayouts,
  evaluatePseudoLayout,
} from "./standing-browser-pseudo-layout.mjs";
import {
  isPlainObject,
  normalizedUrl,
  requireNonEmptyString,
  requirePlainObject,
  sortedUniqueStrings,
} from "./standing-browser-parity-util.mjs";
import {
  environmentHostIdentity,
  normalizeAttributeObservation,
  normalizeAttributeSignatures,
  normalizeDomSignatures,
} from "./render-compare.mjs";
import { compareFirstDivergenceTraces } from "./first-divergent-element.mjs";

export const STANDING_BROWSER_CAPTURE_SCHEMA =
  "wikijump_local_lab.standing_browser_parity_capture.v2";
export const STANDING_BROWSER_PARITY_SCHEMA =
  "wikijump_local_lab.standing_browser_parity_run.v2";
export const STANDING_BROWSER_LIVE_REFERENCE_SCHEMA =
  "wikijump_local_lab.standing_browser_live_reference.v2";
export const STANDING_BROWSER_LIVE_POLICY_SCHEMA =
  "wikijump.standing_browser_live_completion_policy.v1";
export const STANDING_CANDIDATE_PARITY_IDENTITY_SCHEMA =
  "wikijump.standing_candidate_parity_identity.v1";
export const STANDING_CANDIDATE_PARITY_RECEIPT_SCHEMA =
  "wikijump.standing_candidate_parity_receipt.v1";

export const DEFAULT_THRESHOLDS = Object.freeze({
  geometry_position_px: 8,
  geometry_size_px: 12,
  image_count_delta: 0,
  dom_multiset_distance_ratio: 0.15,
});

function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative finite number`);
  }
  return value;
}

export function validateThresholds(value = DEFAULT_THRESHOLDS) {
  const thresholds = requirePlainObject(value, "thresholds");
  const result = {};
  for (const key of Object.keys(DEFAULT_THRESHOLDS)) {
    result[key] = finiteNonNegative(thresholds[key], `thresholds.${key}`);
  }
  if (Object.keys(thresholds).some((key) => !(key in DEFAULT_THRESHOLDS))) {
    throw new Error("thresholds contains an unknown field");
  }
  return Object.freeze(result);
}

function failureKey(failure) {
  return JSON.stringify([
    failure?.kind ?? null,
    failure?.url ?? null,
    failure?.status ?? null,
    failure?.resource_type ?? null,
    failure?.error ?? null,
  ]);
}

function failureParityKey(failure) {
  return JSON.stringify([
    failure?.kind ?? null,
    failure?.url ?? null,
    failure?.status ?? null,
    failure?.resource_type ?? null,
  ]);
}

function requestGateAbortKey(abort) {
  return JSON.stringify([
    abort?.kind ?? null,
    abort?.url ?? null,
    abort?.resource_type ?? null,
    abort?.decision ?? null,
    abort?.abort_reason ?? null,
  ]);
}

const REQUEST_GATE_ABORT_DECISIONS = new Set([
  "unsupported_protocol",
  "unsupported_public_origin_resource_type",
  "unretained_avatar_image",
]);

export function validateRequestGateAborts(value, label = "request-gate aborts") {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => {
    const name = `${label}[${index}]`;
    const abort = requirePlainObject(entry, name);
    const expectedKeys = [
      "abort_reason",
      "decision",
      "error",
      "kind",
      "resource_type",
      "url",
    ];
    if (
      JSON.stringify(Object.keys(abort).sort()) !== JSON.stringify(expectedKeys)
    ) {
      throw new Error(`${name} has unsupported fields`);
    }
    if (abort.kind !== "request_gate_abort") {
      throw new Error(`${name}.kind must be request_gate_abort`);
    }
    const decision = requireNonEmptyString(abort.decision, `${name}.decision`);
    if (!REQUEST_GATE_ABORT_DECISIONS.has(decision)) {
      throw new Error(`${name} has an unsupported request-gate abort decision`);
    }
    if (abort.abort_reason !== "blockedbyclient") {
      throw new Error(`${name}.abort_reason must be blockedbyclient`);
    }
    return {
      kind: "request_gate_abort",
      url: normalizedUrl(abort.url, `${name}.url`).href,
      resource_type: requireNonEmptyString(
        abort.resource_type,
        `${name}.resource_type`,
      ),
      error: requireNonEmptyString(abort.error, `${name}.error`),
      decision,
      abort_reason: "blockedbyclient",
    };
  });
}

export function assertRequestGateAbortAccounting(captures, requestGate) {
  const observed = captures.reduce(
    (total, capture, index) =>
      total +
      validateRequestGateAborts(
        capture?.request_gate_aborts,
        `captures[${index}].request_gate_aborts`,
      ).length,
    0,
  );
  if (
    !Number.isInteger(requestGate?.unsupported_requests_blocked) ||
    requestGate.unsupported_requests_blocked !== observed
  ) {
    throw new Error(
      "request-gate abort observations do not match the gate blocked-request count",
    );
  }
  return observed;
}

export function isExternalFailure(failure, capture) {
  let parsed;
  try {
    parsed = new URL(failure?.url);
  } catch {
    return false;
  }
  if (!new Set(["http:", "https:"]).has(parsed.protocol)) return false;
  const hostnames = new Set();
  for (const value of [
    capture?.input_url,
    capture?.final_url ?? capture?.input_url,
  ]) {
    try {
      hostnames.add(new URL(value).hostname.toLowerCase());
    } catch {
      return false;
    }
  }
  return !hostnames.has(parsed.hostname.toLowerCase());
}

function multiset(items) {
  const result = new Map();
  for (const item of items ?? []) {
    result.set(item, (result.get(item) ?? 0) + 1);
  }
  return result;
}

export function multisetDistance(leftItems, rightItems) {
  const left = multiset(leftItems);
  const right = multiset(rightItems);
  const keys = new Set([...left.keys(), ...right.keys()]);
  let difference = 0;
  let total = 0;
  for (const key of keys) {
    difference += Math.abs((left.get(key) ?? 0) - (right.get(key) ?? 0));
    total += Math.max(left.get(key) ?? 0, right.get(key) ?? 0);
  }
  return {
    different_elements: difference,
    union_elements: total,
    ratio: total === 0 ? 0 : difference / total,
  };
}

export function normalizeCssValue(value) {
  return String(value ?? "")
    .trim()
    .replace(/https?:\/\/[^/'")\s]+/gu, "")
    .replace(/\s+/gu, " ");
}

export function matchesPropertyExpectation(value, expectation) {
  if (!isPlainObject(expectation)) return false;
  if (expectation.operator === "eq") return value === expectation.value;
  if (expectation.operator === "contains") {
    return typeof value === "string" && value.includes(expectation.value);
  }
  return false;
}

export function evaluateFirstPaintCustomProperties(
  customProperties,
  expectations,
) {
  const checks = Object.entries(expectations ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([property, expectation]) => {
      const actual = customProperties?.[property] ?? null;
      return {
        property,
        actual,
        expected: expectation,
        status: matchesPropertyExpectation(actual, expectation)
          ? "pass"
          : "fail",
      };
    });
  return {
    status: checks.every((check) => check.status === "pass") ? "pass" : "fail",
    checks,
  };
}

export function evaluatePresenceProbes(probes, requirements) {
  const byId = new Map((probes ?? []).map((probe) => [probe.id, probe]));
  return (requirements ?? []).map((requirement) => {
    const observed = byId.get(requirement.id);
    const minimumCount = requirement.minimum_count ?? 1;
    const count = observed?.count ?? 0;
    const renderedCount = observed?.rendered_count ?? 0;
    const countPasses = count >= minimumCount;
    const pseudoLayout = evaluatePseudoLayout(observed, requirement);
    const renderedPasses = requirement.pseudo_layout
      ? pseudoLayout.status === "pass"
      : !requirement.require_rendered || renderedCount >= minimumCount;
    return {
      id: requirement.id,
      selector: requirement.selector,
      pseudo: requirement.pseudo ?? null,
      minimum_count: minimumCount,
      require_rendered: Boolean(requirement.require_rendered),
      observed_count: count,
      observed_rendered_count: renderedCount,
      pseudo_layout: pseudoLayout,
      status: countPasses && renderedPasses ? "pass" : "fail",
    };
  });
}

function geometryFor(capture, selector) {
  if (capture?.geometry?.[selector]) return capture.geometry[selector];
  if (capture?.required_geometry_by_selector?.[selector]) {
    return capture.required_geometry_by_selector[selector];
  }
  if (capture?.required_geometry) {
    return (
      capture.required_geometry.find(
        (geometry) => geometry.selector === selector,
      ) ?? null
    );
  }
  return (
    capture?.document?.required_geometry?.find(
      (geometry) => geometry.selector === selector,
    ) ?? null
  );
}

function rounded(value) {
  return Math.round(Number(value) * 100) / 100;
}

export function compareGeometry(
  local,
  live,
  selectors,
  thresholds,
  prefix = "",
) {
  const geometry = [];
  const anomalies = [];
  for (const selector of new Set(selectors)) {
    const localGeometry = geometryFor(local, selector);
    const liveGeometry = geometryFor(live, selector);
    if (
      !localGeometry ||
      !liveGeometry ||
      localGeometry.count !== liveGeometry.count ||
      localGeometry.count !== 1
    ) {
      const detail = {
        selector,
        local_count: localGeometry?.count ?? 0,
        live_count: liveGeometry?.count ?? 0,
      };
      geometry.push({ ...detail, status: "fail" });
      anomalies.push({ code: `${prefix}selector_count_divergence`, detail });
      continue;
    }
    const rawDelta = Object.fromEntries(
      ["x", "y", "width", "height"].map((key) => [
        key,
        localGeometry.rect[key] - liveGeometry.rect[key],
      ]),
    );
    const delta = Object.fromEntries(
      Object.entries(rawDelta).map(([key, value]) => [key, rounded(value)]),
    );
    const status =
      Math.abs(rawDelta.x) <= thresholds.geometry_position_px &&
      Math.abs(rawDelta.y) <= thresholds.geometry_position_px &&
      Math.abs(rawDelta.width) <= thresholds.geometry_size_px &&
      Math.abs(rawDelta.height) <= thresholds.geometry_size_px
        ? "pass"
        : "fail";
    const row = {
      selector,
      local: localGeometry.rect,
      live: liveGeometry.rect,
      delta,
      status,
    };
    geometry.push(row);
    if (status === "fail") {
      anomalies.push({
        code: `${prefix}selector_geometry_divergence`,
        detail: row,
      });
    }
  }
  return { geometry, anomalies };
}

function skeletonLinkStatus(observation, link) {
  const observed = (observation?.links ?? []).find(
    (candidate) =>
      candidate.parent === link.parent && candidate.child === link.child,
  );
  const present =
    observed?.parent_count === 1 &&
    observed?.child_count === 1 &&
    observed?.direct_child_count === 1;
  return {
    parent: link.parent,
    child: link.child,
    parent_count: observed?.parent_count ?? 0,
    child_count: observed?.child_count ?? 0,
    direct_child_count: observed?.direct_child_count ?? 0,
    status: present ? "pass" : "fail",
  };
}

export function comparePageChromeSkeleton(
  local,
  live,
  contract = PAGE_CHROME_SKELETON,
) {
  const links = contract?.links ?? [];
  if (links.length === 0) {
    return { status: "pass", links: [], anomalies: [] };
  }
  const localLinks = links.map((link) => skeletonLinkStatus(local, link));
  const liveLinks = links.map((link) => skeletonLinkStatus(live, link));
  const anomalies = [];
  for (const [index, link] of links.entries()) {
    const localLink = localLinks[index];
    const liveLink = liveLinks[index];
    if (localLink.status !== "pass" || liveLink.status !== "pass") {
      anomalies.push({
        code: "page_chrome_skeleton_divergence",
        detail: { link, local: localLink, live: liveLink },
      });
    } else if (
      localLink.parent_count !== liveLink.parent_count ||
      localLink.child_count !== liveLink.child_count ||
      localLink.direct_child_count !== liveLink.direct_child_count
    ) {
      anomalies.push({
        code: "page_chrome_skeleton_divergence",
        detail: { link, local: localLink, live: liveLink },
      });
    }
  }
  return {
    status: anomalies.length === 0 ? "pass" : "fail",
    links: links.map((link, index) => ({
      ...link,
      local: localLinks[index],
      live: liveLinks[index],
      status:
        localLinks[index].status === "pass" &&
        liveLinks[index].status === "pass" &&
        localLinks[index].parent_count === liveLinks[index].parent_count &&
        localLinks[index].child_count === liveLinks[index].child_count &&
        localLinks[index].direct_child_count ===
          liveLinks[index].direct_child_count
          ? "pass"
          : "fail",
    })),
    anomalies,
  };
}

function attributeMultiset(signatures) {
  return (signatures ?? []).map((signature) => JSON.stringify(signature));
}

function rawAttributeObservation(observation) {
  return {
    tag: String(observation?.tag ?? "").toLowerCase(),
    name: String(observation?.name ?? "").toLowerCase(),
    value: String(observation?.value ?? ""),
  };
}

function rawObservationKey(observation) {
  return JSON.stringify(rawAttributeObservation(observation));
}

function hasTabviewRootSignature(signatures, id) {
  return (signatures ?? []).some((signature) => {
    const match = /^div#([^.#\s]+)((?:\.[^.#\s]+)*)/u.exec(String(signature ?? ""));
    return match?.[1] === id && match[2].split(".").includes("yui-navset");
  });
}

function environmentTranslationEvent(local, live, raw, normalized) {
  const localRows = (local ?? []).map(rawAttributeObservation).sort((left, right) => rawObservationKey(left).localeCompare(rawObservationKey(right)));
  const liveRows = (live ?? []).map(rawAttributeObservation).sort((left, right) => rawObservationKey(left).localeCompare(rawObservationKey(right)));
  if (localRows.length !== liveRows.length) return null;
  const pairs = [];
  for (const [index, localRow] of localRows.entries()) {
    const liveRow = liveRows[index];
    const localNormalized = normalizeAttributeObservation(localRow);
    const liveNormalized = normalizeAttributeObservation(liveRow);
    if (JSON.stringify(localNormalized) !== JSON.stringify(liveNormalized)) {
      return null;
    }
    if (rawObservationKey(localRow) === rawObservationKey(liveRow)) continue;
    if (
      localRow.tag !== liveRow.tag ||
      localRow.name !== liveRow.name ||
      localNormalized.applied.length !== 1 ||
      liveNormalized.applied.length !== 1 ||
      !localNormalized.applied.includes("hostname_map") ||
      !liveNormalized.applied.includes("hostname_map")
    ) return null;
    const localIdentity = environmentHostIdentity(localRow.value);
    const liveIdentity = environmentHostIdentity(liveRow.value);
    if (
      !localIdentity ||
      !liveIdentity ||
      localIdentity.identity !== liveIdentity.identity ||
      localIdentity.hostname === liveIdentity.hostname
    ) return null;
    pairs.push({
      tag: localRow.tag,
      name: localRow.name,
      local: localIdentity,
      live: liveIdentity,
    });
  }
  if (pairs.length === 0) return null;
  const channels = ["hostname_map"];
  return {
    code: "environment_identity_translation",
    detail: {
      raw,
      normalized,
      channels,
      pairs,
    },
  };
}

function tabviewIdentityTranslationEvent(local, live, raw, normalized, localDomSignatures, liveDomSignatures) {
  const localRows = (local ?? [])
    .map(rawAttributeObservation)
    .sort((left, right) =>
      rawObservationKey(left).localeCompare(rawObservationKey(right)),
    );
  const liveRows = (live ?? [])
    .map(rawAttributeObservation)
    .sort((left, right) =>
      rawObservationKey(left).localeCompare(rawObservationKey(right)),
    );
  if (localRows.length !== liveRows.length) return null;
  const pairs = [];
  for (const [index, localRow] of localRows.entries()) {
    const liveRow = liveRows[index];
    if (localRow.tag !== liveRow.tag || localRow.name !== liveRow.name) return null;
    const localNormalized = normalizeAttributeObservation(localRow);
    const liveNormalized = normalizeAttributeObservation(liveRow);
    if (JSON.stringify(localNormalized) !== JSON.stringify(liveNormalized)) {
      return null;
    }
    if (rawObservationKey(localRow) === rawObservationKey(liveRow)) continue;
    if (
      localRow.name !== "id" ||
      !/^wiki-tabview-[0-9a-f]{32}$/iu.test(localRow.value) ||
      !/^wiki-tabview-[0-9a-f]{32}$/iu.test(liveRow.value) ||
      !hasTabviewRootSignature(localDomSignatures, localRow.value) ||
      !hasTabviewRootSignature(liveDomSignatures, liveRow.value)
    ) return null;
    pairs.push({local: localRow.value, live: liveRow.value});
  }
  if (pairs.length === 0) return null;
  return {
    code: "volatile_tabview_identity_translation",
    detail: {raw, normalized, pairs},
  };
}

export function compareAttributeSignatures(local, live, localDomSignatures = [], liveDomSignatures = []) {
  const localRaw = attributeMultiset(local);
  const liveRaw = attributeMultiset(live);
  const localNormalized = normalizeAttributeSignatures(local).signatures;
  const liveNormalized = normalizeAttributeSignatures(live).signatures;
  const raw = multisetDistance(localRaw, liveRaw);
  const normalized = multisetDistance(
    attributeMultiset(localNormalized),
    attributeMultiset(liveNormalized),
  );
  const anomalies = [];
  const normalizationEvents = [];
  if (raw.different_elements > 0 && normalized.different_elements === 0) {
    const environmentTranslation = environmentTranslationEvent(
      local,
      live,
      raw,
      normalized,
    );
    if (environmentTranslation) normalizationEvents.push(environmentTranslation);
    else {
      const tabviewIdentityTranslation = tabviewIdentityTranslationEvent(
        local,
        live,
        raw,
        normalized,
        localDomSignatures,
        liveDomSignatures,
      );
      if (tabviewIdentityTranslation) {
        normalizationEvents.push(tabviewIdentityTranslation);
        return {
          status: "pass",
          raw,
          normalized,
          anomalies,
          normalization_events: normalizationEvents,
        };
      }
      anomalies.push({
        code: "normalization_hides_difference",
        detail: {
          raw,
          normalized,
          channels: [
            ...new Set([
              ...normalizeAttributeSignatures(local).applied,
              ...normalizeAttributeSignatures(live).applied,
            ]),
          ].sort(),
        },
      });
    }
  } else if (normalized.different_elements > 0) {
    anomalies.push({
      code: "attribute_divergence",
      detail: { raw, normalized },
    });
  }
  return {
    status: anomalies.length === 0 ? "pass" : "fail",
    raw,
    normalized,
    anomalies,
    normalization_events: normalizationEvents,
  };
}

function propertyObservations(local, live, contract) {
  const localProperties = local.first_paint?.document?.custom_properties ?? {};
  const liveProperties = live.first_paint?.document?.custom_properties ?? {};
  return Object.entries(contract?.first_paint_custom_properties ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([property, expected]) => {
      const localValue = localProperties[property] ?? null;
      const liveValue = liveProperties[property] ?? null;
      const normalizedLocal = normalizeCssValue(localValue);
      const normalizedLive = normalizeCssValue(liveValue);
      return {
        property,
        expected,
        local: localValue,
        live: liveValue,
        normalized_local: normalizedLocal,
        normalized_live: normalizedLive,
        local_expected: matchesPropertyExpectation(localValue, expected),
        live_expected: matchesPropertyExpectation(liveValue, expected),
        status:
          matchesPropertyExpectation(localValue, expected) &&
          matchesPropertyExpectation(liveValue, expected) &&
          normalizedLocal === normalizedLive
            ? "pass"
            : "fail",
      };
    });
}

function probeObservations(
  localPhase,
  livePhase,
  contract,
  thresholds,
  { comparePseudoGeometry = false } = {},
) {
  const pseudoThresholds =
    contract?.comparison_scope === "standing-chrome"
      ? { ...thresholds, geometry_size_px: Math.max(thresholds.geometry_size_px, 20) }
      : thresholds;
  const localProbes = new Map(
    (localPhase?.presence_probes ?? []).map((probe) => [probe.id, probe]),
  );
  const liveProbes = new Map(
    (livePhase?.presence_probes ?? []).map((probe) => [probe.id, probe]),
  );
  return (contract?.presence_probes ?? []).map((requirement) => {
    const local = localProbes.get(requirement.id) ?? null;
    const live = liveProbes.get(requirement.id) ?? null;
    const minimumCount = requirement.minimum_count ?? 1;
    const countMatches =
      local?.count === live?.count && (local?.count ?? 0) >= minimumCount;
    const pseudoLayout = requirement.pseudo_layout
      ? comparePseudoLayouts(local, live, requirement, pseudoThresholds, {
          compareGeometry: comparePseudoGeometry,
        })
      : null;
    const renderedCountsMatch = requirement.pseudo_layout
      ? true
      : (local?.rendered_count ?? 0) === (live?.rendered_count ?? 0);
    const renderedRequirementPasses = requirement.pseudo_layout
      ? pseudoLayout.status === "pass"
      : !requirement.require_rendered ||
        ((local?.rendered_count ?? 0) >= minimumCount &&
          (live?.rendered_count ?? 0) >= minimumCount);
    const properties = (requirement.comparison_properties ?? []).map(
      (property) => {
        const localValue = local?.style?.[property] ?? null;
        const liveValue = live?.style?.[property] ?? null;
        const normalizedLocal = normalizeCssValue(localValue);
        const normalizedLive = normalizeCssValue(liveValue);
        let status = normalizedLocal === normalizedLive ? "pass" : "fail";
        if (
          contract?.comparison_scope === "standing-chrome" &&
          requirement.pseudo_layout &&
          (property === "width" || property === "height") &&
          pseudoLayout?.geometry
        ) {
          const delta = pseudoLayout.geometry[property];
          status =
            Number.isFinite(delta) &&
            Math.abs(delta) <= pseudoThresholds.geometry_size_px
              ? "pass"
              : "fail";
        } else if (
          (property === "width" || property === "height") &&
          /px$/u.test(normalizedLocal) &&
          /px$/u.test(normalizedLive)
        ) {
          status =
            Math.abs(
              Number.parseFloat(normalizedLocal) -
                Number.parseFloat(normalizedLive),
            ) <= thresholds.geometry_size_px
              ? "pass"
              : "fail";
        }
        return {
          property,
          local: localValue,
          live: liveValue,
          normalized_local: normalizedLocal,
          normalized_live: normalizedLive,
          status,
        };
      },
    );
    return {
      id: requirement.id,
      selector: requirement.selector,
      pseudo: requirement.pseudo ?? null,
      local_count: local?.count ?? 0,
      live_count: live?.count ?? 0,
      local_rendered_count: local?.rendered_count ?? 0,
      live_rendered_count: live?.rendered_count ?? 0,
      properties,
      pseudo_layout: pseudoLayout,
      status:
        countMatches &&
        renderedCountsMatch &&
        renderedRequirementPasses &&
        properties.every((property) => property.status === "pass")
          ? "pass"
          : "fail",
    };
  });
}

export function compareCaptures(
  local,
  live,
  thresholds = DEFAULT_THRESHOLDS,
  requiredSelectors = COMMON_GEOMETRY_SELECTORS,
  contract = null,
) {
  const checkedThresholds = validateThresholds(thresholds);
  const constructScope = contract?.comparison_scope === "construct";
  const localDocument = local.document ?? {};
  const liveDocument = live.document ?? {};
  const anomalies = [];
  const liveFailureKeys = new Set(
    (live.failures ?? [])
      .filter((failure) => isExternalFailure(failure, live))
      .map(failureParityKey),
  );
  const classifiedFailures = (local.failures ?? []).map((failure) => {
    const classification =
      isExternalFailure(failure, local) &&
      liveFailureKeys.has(failureParityKey(failure))
        ? "parity_matched"
        : "local_only";
    if (classification === "local_only") {
      anomalies.push({ code: "local_only_request_failure", detail: failure });
    }
    return { ...failure, classification };
  });
  const localFailureKeys = new Set(
    (local.failures ?? [])
      .filter((failure) => isExternalFailure(failure, local))
      .map(failureParityKey),
  );
  const liveOnlyFailures = (live.failures ?? []).filter(
    (failure) => !localFailureKeys.has(failureParityKey(failure)),
  );
  const liveGateAbortKeys = new Set(
    (live.request_gate_aborts ?? []).map(requestGateAbortKey),
  );
  const classifiedRequestGateAborts = (
    local.request_gate_aborts ?? []
  ).map((abort) => {
    const classification =
      liveGateAbortKeys.has(requestGateAbortKey(abort)) ||
      (abort.decision === "unretained_avatar_image" &&
        /^https:\/\/www\.wikidot\.com\/avatar\.php\?/u.test(abort.url ?? ""))
        ? "parity_matched"
        : "local_only";
    if (classification === "local_only") {
      anomalies.push({ code: "local_only_request_gate_abort", detail: abort });
    }
    return { ...abort, classification };
  });
  const localGateAbortKeys = new Set(
    (local.request_gate_aborts ?? []).map(requestGateAbortKey),
  );
  const liveOnlyRequestGateAborts = (
    live.request_gate_aborts ?? []
  ).filter((abort) => !localGateAbortKeys.has(requestGateAbortKey(abort)));
  if (local.navigation_status !== 200) {
    anomalies.push({
      code: "local_main_response_not_200",
      detail: local.navigation_status,
    });
  }
  if (local.capture_error) {
    anomalies.push({
      code: "local_capture_error",
      detail: local.capture_error,
    });
  }
  if (live.navigation_status !== 200) {
    anomalies.push({
      code: "live_main_response_not_200",
      detail: live.navigation_status,
    });
  }
  if (live.capture_error) {
    anomalies.push({ code: "live_capture_error", detail: live.capture_error });
  }
  const standingChromeScope = contract?.comparison_scope === "standing-chrome";
  const selectors = standingChromeScope
    ? ["#header", "#header h1 a"]
    : constructScope
    ? (contract?.geometry_selectors ?? requiredSelectors).filter(
        (selector) => selector !== "#page-content",
      )
    : (contract?.geometry_selectors ?? requiredSelectors);
  const pageChromeSkeleton = contract?.page_chrome_skeleton &&
    !(live.legacy_capture && !live.page_chrome_skeleton)
    ? comparePageChromeSkeleton(
        local.page_chrome_skeleton,
        live.page_chrome_skeleton,
        contract.page_chrome_skeleton,
      )
    : { status: live.legacy_capture ? "unavailable_legacy" : "pass", links: [], anomalies: [] };
  anomalies.push(...pageChromeSkeleton.anomalies);
  const settledGeometry = compareGeometry(
    local,
    live,
    selectors,
    checkedThresholds,
  );
  anomalies.push(...settledGeometry.anomalies);
  const attributes = standingChromeScope
    ? { status: "pass", raw: null, normalized: null, anomalies: [] }
    : Array.isArray(local.attribute_signatures) &&
      Array.isArray(live.attribute_signatures)
    ? compareAttributeSignatures(
        local.attribute_signatures,
        live.attribute_signatures,
        local.dom_signatures,
        live.dom_signatures,
      )
    : { status: "pass", raw: null, normalized: null, anomalies: [] };
  anomalies.push(...attributes.anomalies);
  const immediateGeometry = compareGeometry(
    local.first_paint?.document,
    live.first_paint?.document,
    contract?.first_paint_geometry_selectors ?? [],
    checkedThresholds,
    "domcontentloaded_immediate_",
  );
  anomalies.push(...immediateGeometry.anomalies);
  const localRenderedImages = constructScope
    ? (localDocument.page_content_rendered_images ?? local.rendered_images ?? 0)
    : (local.rendered_images ?? 0);
  const liveRenderedImages = constructScope
    ? (liveDocument.page_content_rendered_images ?? live.rendered_images ?? 0)
    : (live.rendered_images ?? 0);
  const imageCountDelta = localRenderedImages - liveRenderedImages;
  if (Math.abs(imageCountDelta) > checkedThresholds.image_count_delta) {
    anomalies.push({
      code: "rendered_image_count_divergence",
      detail: {
        local: localRenderedImages,
        live: liveRenderedImages,
        delta: imageCountDelta,
        scope: constructScope ? "construct" : "page-chrome",
      },
    });
  }
  const localBrokenImages = constructScope
    ? (localDocument.page_content_broken_images ?? local.broken_images ?? [])
    : (local.broken_images ?? []);
  const liveBrokenImages = constructScope
    ? (liveDocument.page_content_broken_images ?? live.broken_images ?? [])
    : (live.broken_images ?? []);
  const classifiedBrokenImages = localBrokenImages.map((image) => {
    const classification =
      /^https?:\/\//u.test(image.src) &&
      isExternalFailure({ url: image.src }, local) &&
      liveBrokenImages.some(
        (candidate) => candidate.src === image.src,
      )
        ? "parity_matched"
        : "local_only";
    if (classification === "local_only") {
      anomalies.push({ code: "local_broken_image", detail: image });
    }
    return { ...image, classification };
  });
  const localBrokenSources = new Set(
    localBrokenImages.map((image) => image.src),
  );
  const liveOnlyBrokenImages = liveBrokenImages.filter(
    (image) => !localBrokenSources.has(image.src),
  );
  const localDom = normalizeDomSignatures(local.dom_signatures ?? []);
  const liveDom = normalizeDomSignatures(live.dom_signatures ?? []);
  const rawDom = multisetDistance(
    local.dom_signatures ?? [],
    live.dom_signatures ?? [],
  );
  const dom = multisetDistance(localDom.signatures, liveDom.signatures);
  if (
    !standingChromeScope &&
    dom.ratio > checkedThresholds.dom_multiset_distance_ratio
  ) {
    anomalies.push({ code: "dom_structure_divergence", detail: dom });
  }
  const immediateProperties = propertyObservations(local, live, contract);
  for (const property of immediateProperties) {
    if (property.status === "fail") {
      anomalies.push({
        code: "domcontentloaded_immediate_custom_property_divergence",
        detail: property,
      });
    }
  }
  const immediateProbes = probeObservations(
    local.first_paint?.document,
    live.first_paint?.document,
    contract,
    checkedThresholds,
    { comparePseudoGeometry: true },
  );
  for (const probe of immediateProbes) {
    if (probe.status === "fail") {
      anomalies.push({
        code: "domcontentloaded_immediate_probe_divergence",
        detail: probe,
      });
    }
  }
  const settledProbes = probeObservations(
    local.document,
    live.document,
    contract,
    checkedThresholds,
    { comparePseudoGeometry: true },
  );
  for (const probe of settledProbes) {
    if (probe.status === "fail") {
      anomalies.push({ code: "settled_probe_divergence", detail: probe });
    }
  }
  const firstDivergenceOptions = {
    geometry_position_px: checkedThresholds.geometry_position_px,
    geometry_size_px: checkedThresholds.geometry_size_px,
    ignored_classes: contract?.ignored_first_divergence_classes ?? [],
  };
  const immediateFirstDivergentElement = contract?.first_divergence_trace
    ? compareFirstDivergenceTraces(
        local.first_paint?.document?.first_divergence_trace,
        live.first_paint?.document?.first_divergence_trace,
        firstDivergenceOptions,
      )
    : null;
  const settledFirstDivergentElement = contract?.first_divergence_trace
    ? compareFirstDivergenceTraces(
        local.document?.first_divergence_trace,
        live.document?.first_divergence_trace,
        firstDivergenceOptions,
      )
    : null;
  return {
    status: anomalies.length === 0 ? "pass" : "fail",
    classified_failures: classifiedFailures,
    live_only_failures: liveOnlyFailures,
    classified_request_gate_aborts: classifiedRequestGateAborts,
    live_only_request_gate_aborts: liveOnlyRequestGateAborts,
    classified_broken_images: classifiedBrokenImages,
    live_only_broken_images: liveOnlyBrokenImages,
    geometry: settledGeometry.geometry,
    page_chrome_skeleton: pageChromeSkeleton,
    attributes,
    domcontentloaded_immediate_geometry: immediateGeometry.geometry,
    image_counts: {
      local: localRenderedImages,
      live: liveRenderedImages,
      delta: imageCountDelta,
      scope: constructScope ? "construct" : "page-chrome",
    },
    dom_signature_normalization: {
      raw: rawDom,
      normalized: dom,
      events: [...localDom.events, ...liveDom.events],
    },
    dom_multiset_distance: dom,
    domcontentloaded_immediate_custom_properties: immediateProperties,
    domcontentloaded_immediate_probes: immediateProbes,
    settled_probes: settledProbes,
    domcontentloaded_immediate_first_divergent_element:
      immediateFirstDivergentElement,
    settled_first_divergent_element: settledFirstDivergentElement,
    anomalies,
  };
}

function validateFailureAllowance(value, index) {
  const rule = requirePlainObject(value, `allowed_external_failures[${index}]`);
  const url = normalizedUrl(
    rule.url,
    `allowed_external_failures[${index}].url`,
  );
  const kind = requireNonEmptyString(
    rule.kind,
    `allowed_external_failures[${index}].kind`,
  );
  if (!new Set(["http_error", "request_failed", "broken_image"]).has(kind)) {
    throw new Error(`allowed_external_failures[${index}].kind is unsupported`);
  }
  const resourceType = requireNonEmptyString(
    rule.resource_type,
    `allowed_external_failures[${index}].resource_type`,
  );
  const result = { url: url.href, kind, resource_type: resourceType };
  if (kind === "http_error") {
    if (
      !Number.isInteger(rule.status) ||
      rule.status < 100 ||
      rule.status > 599
    ) {
      throw new Error(
        `allowed_external_failures[${index}].status must be an HTTP status`,
      );
    }
    if ("error" in rule) {
      throw new Error(
        `allowed_external_failures[${index}] cannot combine http_error with error`,
      );
    }
    result.status = rule.status;
  } else {
    if ("status" in rule) {
      throw new Error(
        `allowed_external_failures[${index}] cannot combine ${kind} with status`,
      );
    }
    result.error = requireNonEmptyString(
      rule.error,
      `allowed_external_failures[${index}].error`,
    );
  }
  if (
    !isExternalFailure(
      { url: url.href },
      {
        input_url: "https://scp-wiki.wikidot.com/",
        final_url: "https://scp-wiki.wikidot.com/",
      },
    )
  ) {
    throw new Error(
      `allowed_external_failures[${index}].url must name an external HTTP(S) resource`,
    );
  }
  return result;
}

export function validateLiveCompletionPolicy(value) {
  const policy = requirePlainObject(value, "live completion policy");
  if (policy.schema !== STANDING_BROWSER_LIVE_POLICY_SCHEMA) {
    throw new Error(
      `live completion policy must use ${STANDING_BROWSER_LIVE_POLICY_SCHEMA}`,
    );
  }
  const policyVersion = requireNonEmptyString(
    policy.policy_version,
    "live completion policy.policy_version",
  );
  if (policy.status !== "sealed") {
    throw new Error("live completion policy.status must be sealed");
  }
  if (!Array.isArray(policy.allowed_external_failures)) {
    throw new Error(
      "live completion policy.allowed_external_failures must be an array",
    );
  }
  const allowed = policy.allowed_external_failures.map(
    validateFailureAllowance,
  );
  const keys = allowed.map(failureKey);
  sortedUniqueStrings(
    [...keys].sort(),
    "live completion policy allowed failure keys",
  );
  return Object.freeze({
    schema: STANDING_BROWSER_LIVE_POLICY_SCHEMA,
    status: "sealed",
    policy_version: policyVersion,
    allowed_external_failures: Object.freeze(
      [...allowed].sort((left, right) =>
        failureKey(left).localeCompare(failureKey(right)),
      ),
    ),
  });
}

export function policyAllowsFailure(policy, failure, capture) {
  if (!isExternalFailure(failure, capture)) return false;
  return policy.allowed_external_failures.some(
    (rule) => failureKey(rule) === failureKey(failure),
  );
}

export function currentCanaryContractSummary() {
  return {
    canary_schema: STANDING_BROWSER_CANARY_SCHEMA,
    canary_contract_sha256: standingBrowserCanaryContractSha256(),
    theme_family_coverage: assertThemeFamilyCoverage(),
  };
}

export function canaryContractForPair(pair) {
  const live = normalizedUrl(pair.live_url, "pair.live_url");
  const local = normalizedUrl(pair.local_url, "pair.local_url");
  const contract = canaryForUrl(live.href);
  if (!contract || canaryForUrl(local.href)?.slug !== contract.slug) {
    throw new Error(`pair must name a declared standing canary: ${live.href}`);
  }
  for (const property of firstPaintPropertyNames(contract)) {
    if (!contract.first_paint_custom_properties[property]) {
      throw new Error(
        `canary has an invalid immediate-observation property: ${property}`,
      );
    }
  }
  return contract;
}
