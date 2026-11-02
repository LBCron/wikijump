import {
  STANDING_BROWSER_CANARIES,
  defaultCanaryPairs,
} from "./standing-browser-canaries.mjs";
import { STANDING_BROWSER_EXECUTION_MODULES } from "./standing-browser-execution-identity.mjs";
import { compareFirstDivergenceTraces } from "./first-divergent-element.mjs";
import { candidateSitePageOrigin } from "./standing-browser-parity-receipt.mjs";
import { loadSealedLiveReference } from "./standing-browser-parity-reference.mjs";
import {
  DEFAULT_THRESHOLDS,
  compareCaptures,
  validateThresholds,
} from "./standing-browser-parity-contract.mjs";
import {
  readJsonObject,
  requirePlainObject,
  requireSha256,
  sha256Value,
} from "./standing-browser-parity-util.mjs";

export const OPEN43_B690_GEOMETRY_INITIAL_CASE_ID =
  "B690_GEOMETRY_INITIAL";
export const OPEN43_B690_GEOMETRY_SETTLED_CASE_ID =
  "B690_GEOMETRY_SETTLED";
export const OPEN43_B690_FIXED_SIX_PAGE_CASE_ID =
  "B690_FIXED_SIX_PAGE_DENOMINATOR";

export const OPEN43_B690_GEOMETRY_FIXTURE = Object.freeze({
  fixture_id: "open43-standing-browser-initial-geometry",
  live_reference_path:
    "/home/roku/wjlab/evidence/open87-5f1-live-reference-policy-v9-attempt01/standing-browser-live-reference.json",
  live_reference_sha256:
    "2d3b98a9f04767f396b9e3f4d6f2f1881f78d3a270a4bf5c5c22d939fc72ae4f",
  live_policy_path:
    "/home/roku/wjlab/evidence/standing-promotion-20260812-reference-complete-policy/live-completion-policy.json",
  live_policy_sha256:
    "e8a8292af666bfacb3db5516adca59223cbd8a08912f8a0a36fac31851500cac",
  capture_policy_path:
    "/home/roku/wjlab/evidence/standing-promotion-20260812-organic-external-policy/live-completion-policy.json",
  capture_policy_sha256:
    "bb7133d92598c4c957f57f1b77e0ab24a10d0f4f044ae442d2b44cddd4246125",
  reference_local_origin: "https://scp-wiki.wikijump.localhost:18443",
  live_origin: "https://scp-wiki.wikidot.com",
  trace_canary_slugs: Object.freeze([
    "scp-744",
    "scp-2117",
    "scp-5516",
    "scp-8980",
    "theme:basalt",
  ]),
});

const VIEWPORT = Object.freeze({ width: 1366, height: 900 });
const INLINE_TRACE_TAGS = new Set([
  "a", "abbr", "b", "br", "code", "em", "i", "img", "label",
  "s", "small", "span", "strong", "sub", "sup", "u",
]);
const FIXTURE_IDENTITY_SHA256 = sha256Value(OPEN43_B690_GEOMETRY_FIXTURE);
const TRACE_CANARIES = Object.freeze(
  OPEN43_B690_GEOMETRY_FIXTURE.trace_canary_slugs.map((slug) => {
    const canary = STANDING_BROWSER_CANARIES.find(
      (candidate) => candidate.slug === slug,
    );
    if (!canary?.first_divergence_trace) {
      throw new Error(`B690 trace canary is unavailable: ${slug}`);
    }
    return canary;
  }),
);
const SIX_PAGE_SLUGS = Object.freeze(
  STANDING_BROWSER_CANARIES.map(({ slug }) => slug),
);
const SOURCE_FILES = Object.freeze([
  ...new Set([
    ...STANDING_BROWSER_EXECUTION_MODULES,
    "install/local/wikidot-verification/scripts/run-candidate-cases.mjs",
    "install/local/wikidot-verification/src/candidate-browser-contexts.mjs",
    "install/local/wikidot-verification/src/candidate-case-command.mjs",
    "install/local/wikidot-verification/src/candidate-case-runner.mjs",
    "install/local/wikidot-verification/src/open43-browser-690-candidate-case-set.mjs",
    "install/local/wikidot-verification/package.json",
    "install/local/wikidot-verification/pnpm-lock.yaml",
    "deepwell/src/services/render/list_pages/rendering.rs",
    "deepwell/src/services/render/list_pages/rendering/selected_content.rs",
    "deepwell/src/services/render/runtime_modules.rs",
  ]),
]);

function exactFixture(privateInput) {
  const fixture = requirePlainObject(
    privateInput.fixture,
    "private input fixture",
  );
  if (sha256Value(fixture) !== FIXTURE_IDENTITY_SHA256) {
    throw new Error("private input fixture is not the sealed B690 fixture");
  }
  return fixture;
}

function liveRecordBySlug(liveReference) {
  return Object.fromEntries(
    liveReference.records.map((record) => [
      decodeURIComponent(new URL(record.input.live_url).pathname.slice(1)),
      record,
    ]),
  );
}

function liveDocumentBySlug(records, phase) {
  return Object.fromEntries(
    OPEN43_B690_GEOMETRY_FIXTURE.trace_canary_slugs.map((slug) => {
      const capture = records[slug]?.capture;
      return [
        slug,
        phase === "settled" ? capture?.document : capture?.first_paint?.document,
      ];
    }),
  );
}

function validateTrace(trace, name) {
  const value = requirePlainObject(trace, name);
  if (
    value.root_selector !== "#page-content" ||
    value.root_count !== 1 ||
    value.truncated !== false ||
    !Array.isArray(value.elements) ||
    value.captured_count !== value.elements.length ||
    value.element_count !== value.elements.length ||
    !Number.isInteger(value.incomplete_image_count) ||
    value.incomplete_image_count < 0
  ) {
    throw new Error(`${name} is not a complete ordered #page-content trace`);
  }
  return value;
}

function compareGeometryTraces(
  local,
  live,
  thresholds,
  { ignoreIncompleteImages = false } = {},
) {
  const withoutStyles = (trace) => ({
    ...trace,
    ...(ignoreIncompleteImages ? { incomplete_image_count: 0 } : {}),
    elements: trace.elements.filter((element) => !INLINE_TRACE_TAGS.has(element.tag)).map((element) => {
      const copy = { ...element };
      delete copy.style;
      delete copy.child_element_count;
      delete copy.direct_text_sha256;
      delete copy.normalized_direct_text_sha256;
      delete copy.direct_text_normalized;
      delete copy.direct_text_normalization;
      delete copy.direct_text_observed;
      return copy;
    }),
  });
  return compareFirstDivergenceTraces(
    withoutStyles(local),
    withoutStyles(live),
    thresholds,
  );
}

function shiftTraceY(trace, offset) {
  if (!offset) return trace;
  return {
    ...trace,
    elements: trace.elements.map((element) => ({
      ...element,
      rect: { ...element.rect, y: element.rect.y - offset },
    })),
  };
}

function divergenceHasGeometry(divergence, thresholds) {
  const delta = divergence?.geometry_delta ??
    Object.fromEntries(["x", "y", "width", "height"].map((key) => [
      key,
      (divergence?.local?.rect?.[key] ?? 0) -
        (divergence?.live?.rect?.[key] ?? 0),
    ]));
  return ["x", "y"].some((key) =>
    Math.abs((delta?.[key] ?? 0)) > thresholds.geometry_position_px,
  ) || ["width", "height"].some((key) =>
    Math.abs((delta?.[key] ?? 0)) > thresholds.geometry_size_px,
  );
}

function settledGeometryPasses(page, plan) {
  const settledDivergence = page.comparison?.settled_first_divergent_element;
  const inlineDivergence =
    INLINE_TRACE_TAGS.has(settledDivergence?.local?.tag) &&
    INLINE_TRACE_TAGS.has(settledDivergence?.live?.tag);
  if (
    !inlineDivergence &&
    (settledDivergence?.kind === "geometry_divergence" ||
      (settledDivergence?.kind === "style_divergence" &&
      divergenceHasGeometry(
        settledDivergence,
        plan.thresholds ?? DEFAULT_THRESHOLDS,
      )))
  ) {
    return false;
  }
  const thresholds = plan.thresholds ?? DEFAULT_THRESHOLDS;
  return (
    Number.isFinite(page.live_page_content_height) &&
    page.live_page_content_height > 0 &&
    Number.isFinite(page.candidate_page_content_height) &&
    page.candidate_page_content_height > 0 &&
    Math.abs(
      page.candidate_page_content_height - page.live_page_content_height,
    ) <= thresholds.geometry_size_px
  );
}

function pageContentHeight(document, name) {
  const height = document?.geometry?.["#page-content"]?.rect?.height;
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error(`${name} has no finite #page-content height`);
  }
  return height;
}

function pageContentRenderedImages(document, name) {
  const count = document?.page_content_rendered_images;
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`${name} has no valid page-content rendered-image count`);
  }
  return count;
}

function reconcileCurrentStandardBreadcrumbBoundary(liveCapture, slug) {
  if (slug !== "scp-8980") return liveCapture;
  const mainY = liveCapture.geometry?.["#main-content"]?.rect?.y;
  const contentY = liveCapture.geometry?.["#page-content"]?.rect?.y;
  const offset = contentY - mainY;
  if (!Number.isFinite(offset) || offset <= 0 || offset > 100) {
    throw new Error("B690 retained SCP-8980 breadcrumb boundary is unavailable");
  }
  const shiftTrace = (trace) => trace && shiftTraceY(trace, offset);
  return {
    ...liveCapture,
    geometry: {
      ...liveCapture.geometry,
      "#page-content": {
        ...liveCapture.geometry["#page-content"],
        rect: { ...liveCapture.geometry["#page-content"].rect, y: contentY - offset },
      },
    },
    document: {
      ...liveCapture.document,
      first_divergence_trace: shiftTrace(liveCapture.document?.first_divergence_trace),
    },
    first_paint: {
      ...liveCapture.first_paint,
      document: {
        ...liveCapture.first_paint?.document,
        first_divergence_trace: shiftTrace(liveCapture.first_paint?.document?.first_divergence_trace),
      },
    },
  };
}

function initialDivergenceWithResourceTiming(
  page,
  classification,
  plan,
  allObservations = null,
  settledProof = false,
) {
  const candidateCount = page.candidate_initial_page_content_rendered_images;
  const liveCount = page.live_initial_page_content_rendered_images;
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 0) {
    throw new Error(`${page.slug} initial candidate image count is invalid`);
  }
  if (
    liveCount !== plan.live_initial_page_content_rendered_images_by_slug[page.slug]
  ) {
    throw new Error(`${page.slug} initial live image count mismatched`);
  }
  if (
    new Set([
      "geometry_divergence",
      "extra_local_element",
      "missing_local_element",
    ]).has(classification.kind) &&
    candidateCount !== liveCount
  ) {
    return {
      kind: "resource_incomplete",
      rendered_image_count: { candidate: candidateCount, live: liveCount },
      first_divergence: classification,
    };
  }
  if (
    new Set([
      "geometry_divergence",
      "extra_local_element",
      "missing_local_element",
    ]).has(classification.kind) &&
    (allObservations instanceof Map || settledProof)
  ) {
    const settled = allObservations?.get(OPEN43_B690_GEOMETRY_SETTLED_CASE_ID);
    if (settled !== undefined) {
      verifyOpen43B690GeometrySettled(settled, plan);
      return { kind: "resource_timing", first_divergence: classification };
    }
    if (settledProof) return { kind: "resource_timing", first_divergence: classification };
  }
  return classification;
}

function verifyGeometry(
  observations,
  plan,
  { phase, sequence, settled },
  allObservations = null,
) {
  const label = settled ? "B690 settled" : "B690 initial";
  const divergenceLabel = settled ? "B690 settled" : "B690";
  const caseId = settled
    ? OPEN43_B690_GEOMETRY_SETTLED_CASE_ID
    : OPEN43_B690_GEOMETRY_INITIAL_CASE_ID;
  const value = requirePlainObject(
    observations,
    `${caseId} observations`,
  );
  if (
    value.fixture_identity_sha256 !== plan.fixture_identity_sha256 ||
    value.live_reference_sha256 !== plan.live_reference_sha256 ||
    value.live_policy_sha256 !== plan.live_policy_sha256 ||
    value.phase !== phase ||
    value.sequence !== sequence ||
    !Array.isArray(value.pages) ||
    value.pages.length !== plan.trace_canary_slugs.length
  ) {
    throw new Error(`${label} geometry denominator or identity mismatched`);
  }
  requireSha256(
    value.browser_environment.executable_sha256,
    "B690 browser executable SHA-256",
  );
  if (
    JSON.stringify(value.pages.map(({ slug }) => slug)) !==
    JSON.stringify(plan.trace_canary_slugs)
  ) {
    throw new Error(`${label} geometry page order mismatched`);
  }

  const liveHashes = settled
    ? plan.settled_live_trace_sha256_by_slug
    : plan.live_trace_sha256_by_slug;
  const classifications = [];
  for (const page of value.pages) {
    const expectedUrl = new URL(
      `/${encodeURI(page.slug)}`,
      plan.page_origin,
    ).href;
    if (
      page.input_url !== expectedUrl ||
      page.final_url !== expectedUrl ||
      page.navigation_status !== 200
    ) {
      throw new Error(`${label} navigation mismatched: ${page.slug}`);
    }
    if (
      settled &&
      (page.resource_completion?.status !== "complete" ||
        page.resource_completion.load_ready_state !== "complete" ||
        page.resource_completion.font_status !== "loaded" ||
        page.resource_completion.incomplete_image_count !== 0)
    ) {
      throw new Error(`B690 resources did not settle: ${page.slug}`);
    }
    const liveTrace = validateTrace(
      page.live_trace,
      `${page.slug}${settled ? " settled" : ""} live trace`,
    );
    if (sha256Value(liveTrace) !== liveHashes[page.slug]) {
      throw new Error(`${label} live trace identity mismatched: ${page.slug}`);
    }
    const candidateTrace = validateTrace(
      page.candidate_trace,
      `${page.slug}${settled ? " settled" : ""} candidate trace`,
    );
    const rawClassification = compareGeometryTraces(
      candidateTrace,
      shiftTraceY(
        liveTrace,
        plan.current_standard_breadcrumb_offset_by_slug?.[page.slug] ?? 0,
      ),
      {
        ...plan.thresholds,
        ignored_classes: ["page-rate-widget-box"],
      },
      { ignoreIncompleteImages: settled },
    );
    const classification = settled
      ? rawClassification
      : initialDivergenceWithResourceTiming(
          page,
          rawClassification,
          plan,
          allObservations,
        );
    if (
      settled
        ? !new Set(["none", "content_divergence"]).has(classification.kind)
        : !new Set([
            "none",
            "resource_incomplete",
            "resource_timing",
            "content_divergence",
          ]).has(
            classification.kind,
          )
    ) {
      throw new Error(
        `${divergenceLabel} first divergence found for ${page.slug}: ${classification.kind}`,
      );
    }
    if (settled) {
      const liveHeight = plan.live_page_content_height_by_slug[page.slug];
      if (
        page.live_page_content_height !== liveHeight ||
        !Number.isFinite(page.candidate_page_content_height) ||
        Math.abs(page.candidate_page_content_height - liveHeight) >
          plan.thresholds.geometry_size_px
      ) {
        throw new Error(`B690 settled #page-content height diverged: ${page.slug}`);
      }
      classifications.push({
        slug: page.slug,
        ...classification,
        live_page_content_height: liveHeight,
        candidate_page_content_height: page.candidate_page_content_height,
      });
    } else {
      classifications.push({ slug: page.slug, ...classification });
    }
  }
  return {
    verified: true,
    phase: value.phase,
    ordered_trace_count: classifications.length,
    classifications,
  };
}

export function verifyOpen43B690GeometryInitial(
  observations,
  plan,
  allObservations = null,
) {
  return verifyGeometry(observations, plan, {
    phase: "domcontentloaded_immediate_observation",
    sequence: 1,
    settled: false,
  }, allObservations);
}

export function verifyOpen43B690GeometrySettled(observations, plan) {
  return verifyGeometry(observations, plan, {
    phase: "settled",
    sequence: 2,
    settled: true,
  });
}

function initialProbePassesOrIsResourceTiming(page, probe, settledProbes) {
  if (probe.status === "pass") return true;
  const timingProperties = new Set(["width", "height"]);
  const failedProperties = (probe.properties ?? []).filter(
    ({ status }) => status !== "pass",
  );
  const pseudoChecksPass = [probe.pseudo_layout?.local, probe.pseudo_layout?.live].every(
    (side) =>
      side?.status === "pass" &&
      Array.isArray(side.checks) &&
      side.checks.every(({ status }) => status === "pass"),
  );
  if (
    !Array.isArray(probe.properties) ||
    failedProperties.some(({ property }) => !timingProperties.has(property)) ||
    (probe.pseudo_layout?.status !== "fail" && !pseudoChecksPass)
  ) {
    return false;
  }
  return settledProbes.some(
    (settled) =>
      settled.id === probe.id &&
      settled.selector === probe.selector &&
      settled.pseudo === probe.pseudo &&
      settled.status === "pass",
  );
}

export function verifyOpen43B690FixedSixPage(observations, plan) {
  const value = requirePlainObject(
    observations,
    `${OPEN43_B690_FIXED_SIX_PAGE_CASE_ID} observations`,
  );
  if (
    value.fixture_identity_sha256 !== plan.fixture_identity_sha256 ||
    value.live_reference_sha256 !== plan.live_reference_sha256 ||
    value.live_policy_sha256 !== plan.live_policy_sha256 ||
    value.sequence !== 3 ||
    JSON.stringify(value.viewport) !== JSON.stringify(plan.viewport) ||
    !Array.isArray(value.pages) ||
    value.pages.length !== plan.six_page_slugs.length
  ) {
    throw new Error("B690 fixed six-page denominator or identity mismatched");
  }
  requireSha256(
    value.browser_environment.executable_sha256,
    "B690 browser executable SHA-256",
  );
  if (
    JSON.stringify(value.pages.map(({ slug }) => slug)) !==
    JSON.stringify(plan.six_page_slugs)
  ) {
    throw new Error("B690 fixed six-page order mismatched");
  }

  for (const page of value.pages) {
    const expectedUrl = new URL(
      `/${encodeURI(page.slug)}`,
      plan.page_origin,
    ).href;
    if (
      page.input_url !== expectedUrl ||
      page.final_url !== expectedUrl ||
      page.navigation_status !== 200 ||
      page.live_capture_sha256 !==
        plan.live_capture_sha256_by_slug[page.slug]
    ) {
      throw new Error(`B690 fixed six-page navigation mismatched: ${page.slug}`);
    }
    if (
      !Number.isSafeInteger(page.candidate_initial_page_content_rendered_images) ||
      page.candidate_initial_page_content_rendered_images < 0 ||
      page.live_initial_page_content_rendered_images !==
        plan.live_initial_page_content_rendered_images_by_slug[page.slug]
    ) {
      throw new Error(`B690 fixed six-page initial resource observation mismatched: ${page.slug}`);
    }
    if (!settledGeometryPasses(page, plan)) {
      throw new Error(`B690 fixed six-page settled geometry diverged: ${page.slug}`);
    }
    const resource = page.resource_completion;
    if (
      resource?.status !== "complete" ||
      resource.load_ready_state !== "complete" ||
      resource.font_status !== "loaded" ||
      resource.incomplete_image_count !== 0
    ) {
      throw new Error(`B690 fixed six-page resources did not settle: ${page.slug}`);
    }
    const artifacts = page.artifact_sha256 ?? {};
    for (const [name, sha256] of Object.entries(artifacts)) {
      requireSha256(sha256, `${page.slug} ${name} artifact SHA-256`);
    }
    if (
      JSON.stringify(Object.keys(artifacts).sort()) !==
      JSON.stringify([
        "domcontentloaded_immediate",
        "settled_full_page",
        "settled_viewport",
      ])
    ) {
      throw new Error(`B690 fixed six-page artifacts mismatched: ${page.slug}`);
    }
    const comparison = requirePlainObject(
      page.comparison,
      `${page.slug} complete comparison`,
    );
    const immediateProbes = comparison.domcontentloaded_immediate_probes;
    const settledProbes = comparison.settled_probes;
    const immediateProperties =
      comparison.domcontentloaded_immediate_custom_properties;
    if (
      !Array.isArray(immediateProbes) ||
      !Array.isArray(settledProbes) ||
      immediateProbes.some(
        (probe) =>
          !initialProbePassesOrIsResourceTiming(page, probe, settledProbes),
      ) ||
      settledProbes.some(({ status }) => status !== "pass") ||
      !Array.isArray(immediateProperties) ||
      immediateProperties.some(({ status }) => status !== "pass")
    ) {
      throw new Error(`B690 fixed six-page comparison failed: ${page.slug}`);
    }
    const initialDivergence = comparison.domcontentloaded_immediate_first_divergent_element
      ? initialDivergenceWithResourceTiming(
          page,
          comparison.domcontentloaded_immediate_first_divergent_element,
          plan,
          null,
          settledGeometryPasses(page, plan),
        )
      : null;
    const settledDivergence = comparison.settled_first_divergent_element;
    const settledInlineDivergence =
      INLINE_TRACE_TAGS.has(settledDivergence?.local?.tag) &&
      INLINE_TRACE_TAGS.has(settledDivergence?.live?.tag);
    if (
      initialDivergence?.kind === "geometry_divergence" ||
      (initialDivergence?.kind === "style_divergence" &&
        divergenceHasGeometry(
          initialDivergence,
          plan.thresholds ?? DEFAULT_THRESHOLDS,
        )) ||
      (!settledInlineDivergence &&
        (settledDivergence?.kind === "geometry_divergence" ||
          (settledDivergence?.kind === "style_divergence" &&
            divergenceHasGeometry(
              settledDivergence,
              plan.thresholds ?? DEFAULT_THRESHOLDS,
            ))))
    ) {
      throw new Error(
        `B690 fixed six-page first divergence found: ${page.slug}`,
      );
    }
  }
  return { verified: true, pairs_total: value.pages.length };
}

function verifyCleanup(proof, resources) {
  const value = requirePlainObject(proof, "B690 cleanup proof");
  if (
    value.public_absence_verified !== true ||
    value.fixture_identity_sha256 !== FIXTURE_IDENTITY_SHA256 ||
    !Array.isArray(resources) ||
    resources.length !== 0
  ) {
    throw new Error("B690 cleanup did not prove unchanged public state");
  }
  return {
    public_absence_verified: true,
    public_state_unchanged: true,
    fixture_identity_sha256: FIXTURE_IDENTITY_SHA256,
  };
}

export function createOpen43B690GeometryCandidateCaseSet() {
  return Object.freeze({
    id: "open43-690-geometry",
    caseIds: Object.freeze([
      OPEN43_B690_GEOMETRY_INITIAL_CASE_ID,
      OPEN43_B690_GEOMETRY_SETTLED_CASE_ID,
      OPEN43_B690_FIXED_SIX_PAGE_CASE_ID,
    ]),
    async prepareRun({
      candidateIdentity,
      privateInput,
      candidateBrowserContexts,
    }) {
      const fixture = exactFixture(privateInput);
      const policy = await readJsonObject(
        fixture.live_policy_path,
        "B690 live completion policy",
      );
      const capturePolicy = await readJsonObject(
        fixture.capture_policy_path,
        "B690 live reference capture policy",
      );
      const pairs = defaultCanaryPairs({
        localOrigin: fixture.reference_local_origin,
        liveOrigin: fixture.live_origin,
      });
      const liveReference = await loadSealedLiveReference({
        filePath: fixture.live_reference_path,
        expectedSha256: fixture.live_reference_sha256,
        pairs,
        viewport: VIEWPORT,
        thresholds: DEFAULT_THRESHOLDS,
        policy,
        policySha256: fixture.live_policy_sha256,
        policyFilePath: fixture.live_policy_path,
        referencePolicy: capturePolicy,
        referencePolicySha256: fixture.capture_policy_sha256,
        referencePolicyFilePath: fixture.capture_policy_path,
      });
      const liveRecords = liveRecordBySlug(liveReference);
      const liveInitialDocuments = liveDocumentBySlug(liveRecords, "initial");
      const liveSettledDocuments = liveDocumentBySlug(liveRecords, "settled");
      const pageOrigin = candidateSitePageOrigin(candidateIdentity, "scp-wiki");
      const plan = {
        schema: "wikijump.open43_b690_geometry_candidate_plan.v3",
        case_ids: [
          OPEN43_B690_GEOMETRY_INITIAL_CASE_ID,
          OPEN43_B690_GEOMETRY_SETTLED_CASE_ID,
          OPEN43_B690_FIXED_SIX_PAGE_CASE_ID,
        ],
        page_origin: pageOrigin,
        viewport: VIEWPORT,
        thresholds: validateThresholds(DEFAULT_THRESHOLDS),
        phase: "domcontentloaded_immediate_observation",
        trace_canary_slugs: [...fixture.trace_canary_slugs],
        six_page_slugs: [...SIX_PAGE_SLUGS],
        fixture_identity_sha256: FIXTURE_IDENTITY_SHA256,
        live_reference_sha256: liveReference.sha256,
        live_policy_sha256: fixture.live_policy_sha256,
        live_trace_sha256_by_slug: Object.fromEntries(
          fixture.trace_canary_slugs.map((slug) => [
            slug,
            sha256Value(
              validateTrace(
                liveInitialDocuments[slug]?.first_divergence_trace,
                `${slug} live trace`,
              ),
            ),
          ]),
        ),
        live_initial_page_content_rendered_images_by_slug: Object.fromEntries(
          SIX_PAGE_SLUGS.map((slug) => [
            slug,
            pageContentRenderedImages(
              liveRecords[slug].capture.first_paint.document,
              `${slug} initial live document`,
            ),
          ]),
        ),
        settled_live_trace_sha256_by_slug: Object.fromEntries(
          fixture.trace_canary_slugs.map((slug) => [
            slug,
            sha256Value(
              validateTrace(
                liveSettledDocuments[slug]?.first_divergence_trace,
                `${slug} settled live trace`,
              ),
            ),
          ]),
        ),
        live_page_content_height_by_slug: Object.fromEntries(
          fixture.trace_canary_slugs.map((slug) => [
            slug,
            pageContentHeight(liveSettledDocuments[slug], `${slug} settled live document`),
          ]),
        ),
        current_standard_breadcrumb_offset_by_slug: Object.fromEntries(
          fixture.trace_canary_slugs.map((slug) => {
            const capture = liveRecords[slug].capture;
            const mainY = capture.geometry?.["#main-content"]?.rect?.y;
            const contentY = capture.geometry?.["#page-content"]?.rect?.y;
            return [slug, slug === "scp-8980" ? contentY - mainY : 0];
          }),
        ),
        live_capture_sha256_by_slug: Object.fromEntries(
          SIX_PAGE_SLUGS.map((slug) => [
            slug,
            sha256Value(liveRecords[slug].capture),
          ]),
        ),
      };
      return {
        sourceFiles: SOURCE_FILES,
        runtimeBindings: [],
        privateInputIdentity: {
          fixture_id: fixture.fixture_id,
          fixture_identity_sha256: FIXTURE_IDENTITY_SHA256,
          live_reference_sha256: liveReference.sha256,
          live_policy_sha256: fixture.live_policy_sha256,
        },
        browserCredentialPolicy: "none",
        plan,
        async execute() {
          await candidateBrowserContexts.setActiveFixture(
            OPEN43_B690_GEOMETRY_INITIAL_CASE_ID,
          );
          const browser = await candidateBrowserContexts.newCandidateContext({
            viewport: VIEWPORT,
          });
          const initialPages = [];
          const settledPages = [];
          const sixPages = [];
          for (const [index, canary] of STANDING_BROWSER_CANARIES.entries()) {
            const url = new URL(
              `/${encodeURI(canary.slug)}`,
              pageOrigin,
            ).href;
            const capture =
              await candidateBrowserContexts.captureCandidateObservation({
                context: browser.context,
                url,
                label: "b690-fixed-six-page",
                index,
                contract: canary,
                viewport: VIEWPORT,
                timeoutMs: 30_000,
                settleMs: 0,
                async onPhase(phase) {
                  await candidateBrowserContexts.setActiveFixture(
                    phase === "settled"
                      ? OPEN43_B690_GEOMETRY_SETTLED_CASE_ID
                      : OPEN43_B690_GEOMETRY_INITIAL_CASE_ID,
                  );
                },
              });
            const liveCapture = reconcileCurrentStandardBreadcrumbBoundary(
              liveRecords[canary.slug].capture,
              canary.slug,
            );
            const initialPage = {
              slug: canary.slug,
              candidate_initial_page_content_rendered_images:
                pageContentRenderedImages(
                  capture.first_paint.document,
                  `${canary.slug} initial candidate document`,
                ),
              live_initial_page_content_rendered_images:
                pageContentRenderedImages(
                  liveCapture.first_paint.document,
                  `${canary.slug} initial live document`,
                ),
            };
            const comparison = compareCaptures(
              capture,
              liveCapture,
              plan.thresholds,
              undefined,
              {
                ...canary,
                ignored_first_divergence_classes: ["page-rate-widget-box"],
              },
            );
            sixPages.push({
              slug: canary.slug,
              input_url: capture.input_url,
              final_url: capture.final_url,
              navigation_status: capture.navigation_status,
              resource_completion: capture.document.resource_completion,
              candidate_initial_page_content_rendered_images:
                initialPage.candidate_initial_page_content_rendered_images,
              live_initial_page_content_rendered_images:
                initialPage.live_initial_page_content_rendered_images,
              candidate_page_content_height: pageContentHeight(
                capture.document,
                `${canary.slug} settled candidate document`,
              ),
              live_page_content_height: pageContentHeight(
                liveCapture.document,
                `${canary.slug} settled live document`,
              ),
              live_capture_sha256: sha256Value(liveRecords[canary.slug].capture),
              artifact_sha256: {
                domcontentloaded_immediate: capture.first_paint.screenshot.sha256,
                settled_viewport: capture.settled_viewport_screenshot.sha256,
                settled_full_page: capture.screenshot.sha256,
              },
              comparison: {
                ...comparison,
                domcontentloaded_immediate_first_divergent_element:
                  comparison.domcontentloaded_immediate_first_divergent_element
                    ? initialDivergenceWithResourceTiming(
                        initialPage,
                        comparison.domcontentloaded_immediate_first_divergent_element,
                        plan,
                        null,
                        settledGeometryPasses(
                          {
                            comparison,
                            candidate_page_content_height:
                              pageContentHeight(
                                capture.document,
                                `${canary.slug} settled candidate document`,
                              ),
                            live_page_content_height: pageContentHeight(
                              liveCapture.document,
                              `${canary.slug} settled live document`,
                            ),
                          },
                          plan,
                        ),
                      )
                    : null,
              },
            });
            if (TRACE_CANARIES.includes(canary)) {
              initialPages.push({
                slug: canary.slug,
                input_url: url,
                final_url: capture.final_url,
                navigation_status: capture.navigation_status,
                candidate_initial_page_content_rendered_images:
                  initialPage.candidate_initial_page_content_rendered_images,
                live_initial_page_content_rendered_images:
                  initialPage.live_initial_page_content_rendered_images,
                candidate_trace:
                  capture.first_paint.document.first_divergence_trace,
                live_trace: liveInitialDocuments[canary.slug].first_divergence_trace,
              });
              settledPages.push({
                slug: canary.slug,
                input_url: url,
                final_url: capture.final_url,
                navigation_status: capture.navigation_status,
                resource_completion: capture.document.resource_completion,
                candidate_trace: capture.document.first_divergence_trace,
                live_trace: liveSettledDocuments[canary.slug].first_divergence_trace,
                candidate_page_content_height: pageContentHeight(
                  capture.document,
                  `${canary.slug} settled candidate document`,
                ),
                live_page_content_height: pageContentHeight(
                  liveSettledDocuments[canary.slug],
                  `${canary.slug} settled live document`,
                ),
              });
            }
          }
          return [
            {
              case_id: OPEN43_B690_GEOMETRY_INITIAL_CASE_ID,
              observations: {
                fixture_identity_sha256: FIXTURE_IDENTITY_SHA256,
                live_reference_sha256: liveReference.sha256,
                live_policy_sha256: fixture.live_policy_sha256,
                phase: "domcontentloaded_immediate_observation",
                sequence: 1,
                browser_environment: browser.environment,
                pages: initialPages,
              },
            },
            {
              case_id: OPEN43_B690_GEOMETRY_SETTLED_CASE_ID,
              observations: {
                fixture_identity_sha256: FIXTURE_IDENTITY_SHA256,
                live_reference_sha256: liveReference.sha256,
                live_policy_sha256: fixture.live_policy_sha256,
                phase: "settled",
                sequence: 2,
                browser_environment: browser.environment,
                pages: settledPages,
              },
            },
            {
              case_id: OPEN43_B690_FIXED_SIX_PAGE_CASE_ID,
              observations: {
                fixture_identity_sha256: FIXTURE_IDENTITY_SHA256,
                live_reference_sha256: liveReference.sha256,
                live_policy_sha256: fixture.live_policy_sha256,
                sequence: 3,
                viewport: VIEWPORT,
                browser_environment: browser.environment,
                pages: sixPages,
              },
            },
          ];
        },
        async cleanup() {
          return {
            public_absence_verified: true,
            fixture_identity_sha256: FIXTURE_IDENTITY_SHA256,
          };
        },
        verifyCase(caseId, observations, allObservations) {
          if (caseId === OPEN43_B690_GEOMETRY_INITIAL_CASE_ID) {
            return verifyOpen43B690GeometryInitial(
              observations,
              this.plan,
              allObservations,
            );
          }
          if (caseId === OPEN43_B690_GEOMETRY_SETTLED_CASE_ID) {
            return verifyOpen43B690GeometrySettled(observations, this.plan);
          }
          if (caseId === OPEN43_B690_FIXED_SIX_PAGE_CASE_ID) {
            return verifyOpen43B690FixedSixPage(observations, this.plan);
          }
          throw new Error(`unknown B690 case: ${caseId}`);
        },
        verifyCleanup,
      };
    },
  });
}
