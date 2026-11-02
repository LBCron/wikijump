import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { candidatePageOrigin } from "./standing-browser-parity-receipt.mjs";
import { CandidateHttpSession } from "./candidate-case-http.mjs";
import { requirePlainObject, requireSha256 } from "./standing-browser-parity-util.mjs";

const CASE_IDS = Object.freeze([
  "Q748_LIVE_TOPBAR_SUBMISSION_CONTRACT",
  "Q748_EXACT_CANDIDATE_BROWSER_SUBMISSION",
]);
const SITE_HOST = "scpaiueouiuiuiui.wikijump.localhost";
const FIXTURE_ID = "Q748_TOPBAR_SUBMISSION";
const SAVED_PAGE_SLUG = "search:site";

const FORM_FIXTURE_PATH = "install/local/wikidot-verification/artifacts/listpages-campaign-live-fixtures.json";
const FORM_FIXTURE_URL = new URL("../artifacts/listpages-campaign-live-fixtures.json", import.meta.url);
const FORM_FIXTURE_BYTES = readFileSync(FORM_FIXTURE_URL);
const FORM_FIXTURE_SHA256 = createHash("sha256").update(FORM_FIXTURE_BYTES).digest("hex");
const SEALED_FORM_FIXTURE_SHA256 = "9494777d18face903fa6b8c48444f4c3aa687fae6175156977700fa8476559ea";
if (FORM_FIXTURE_SHA256 !== SEALED_FORM_FIXTURE_SHA256) throw new Error("Q748 topbar live form fixture changed");

const LIVE_FORM_CONTRACT = Object.freeze({
  id: "search-top-box-form",
  action: "dummy",
  query_name: "query",
  prompt_value: "Search this site",
  submit_name: "search",
  submit_value: "Search",
});

const RESULT_EVIDENCE_PATH = "install/local/wikidot-verification/artifacts/search-feed-live-preview-20260809.json";
const RESULT_EVIDENCE_URL = new URL("../artifacts/search-feed-live-preview-20260809.json", import.meta.url);
const RESULT_EVIDENCE_BYTES = readFileSync(RESULT_EVIDENCE_URL);
const RESULT_EVIDENCE_SHA256 = createHash("sha256").update(RESULT_EVIDENCE_BYTES).digest("hex");
const SEALED_RESULT_EVIDENCE_SHA256 = "b8642635e71c02bb9e798af5740be5de3c259fef13f000dc6f0bd0fe28946565";
if (RESULT_EVIDENCE_SHA256 !== SEALED_RESULT_EVIDENCE_SHA256) throw new Error("Q748 topbar result evidence changed");

const SEARCH_ERROR = '<div class="error-block">Search is temporarily unavailable, we are working to bring it online!</div>';
const SEARCH_ERROR_SHA256 = createHash("sha256").update(SEARCH_ERROR).digest("hex");

const QUERIES = Object.freeze([
  Object.freeze({ query: "codex search probe", encoded_path: "codex%20search%20probe" }),
  Object.freeze({ query: "  a/b? c  ", encoded_path: "%20%20a%2Fb%3F%20c%20%20" }),
]);

const UNSELALED_LIVE_VALUES = Object.freeze([
  "anonymous live topbar submit-event capture (event count, redirect chain, empty and Unicode queries)",
]);

const DEFAULT_VIEWPORT = Object.freeze({ width: 1280, height: 900 });
const CAPTURE_TIMEOUT_MS = 30_000;
const EXPECTED_CANCELLED_SIGMA_ASSETS = new Set([
  "https://scp-wiki-cdn.nyc3.cdn.digitaloceanspaces.com/theme/en/sigma/fonts/Sans-Normalcy.woff2",
  "https://scp-wiki-cdn.nyc3.cdn.digitaloceanspaces.com/theme/en/sigma/images/header-logo.svg",
  "https://scp-wiki-cdn.nyc3.cdn.digitaloceanspaces.com/theme/en/sigma/images/body_bg.svg",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function liveFormFixtureRow() {
  for (const line of FORM_FIXTURE_BYTES.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line);
    if (row.case?.case_id !== "lp-live-parent-selectors") continue;
    const html = row.raw_page_html;
    if (typeof html !== "string") break;
    for (const value of Object.values(LIVE_FORM_CONTRACT)) {
      if (!html.includes(value)) throw new Error(`Q748 live form fixture drifted: missing ${value}`);
    }
    return row;
  }
  throw new Error("Q748 live form fixture row is missing");
}

liveFormFixtureRow();

function queryPath(origin, query) {
  return new URL(`/search:site/q/${encodeURIComponent(query.query)}`, origin).href;
}

class Open43Q748TopBarSearchBrowserAdapter {
  #browserContexts;
  #pageOrigin;

  constructor({ browserContexts, pageOrigin }) {
    if (typeof browserContexts?.newCandidateContext !== "function" || typeof browserContexts?.setActiveFixture !== "function") throw new Error("Q748 browser contexts are required");
    this.#browserContexts = browserContexts;
    this.#pageOrigin = pageOrigin;
  }

  async captureTopBarSearch() {
    await this.#browserContexts.setActiveFixture(FIXTURE_ID);
    const owned = await this.#browserContexts.newCandidateContext({ viewport: DEFAULT_VIEWPORT });
    const page = await owned.context.newPage();
    const requestMethods = [];
    const failedRequests = [];
    const navigationUrls = [];
    const onRequest = (request) => requestMethods.push(request.method());
    const onFailed = (request) => failedRequests.push({ url: request.url(), method: request.method(), failure: request.failure()?.errorText ?? null });
    const onNavigation = (frame) => {
      if (frame !== page.mainFrame()) return;
      const url = frame.url();
      if (navigationUrls.at(-1) !== url) navigationUrls.push(url);
    };
    page.on("request", onRequest);
    page.on("requestfailed", onFailed);
    page.on("framenavigated", onNavigation);
    const baseUrl = new URL(`/${SAVED_PAGE_SLUG}`, this.#pageOrigin).href;

    const readState = () => page.evaluate(() => {
      const form = document.querySelector("#search-top-box-form");
      const query = document.querySelector("#search-top-box-input");
      const submit = form?.querySelector('input[name="search"]') ?? null;
      return {
        form: form
          ? {
              id: form.id,
              action: form.getAttribute("action"),
              query_name: query?.getAttribute("name") ?? null,
              query_value: query?.value ?? null,
              submit_name: submit?.getAttribute("name") ?? null,
              submit_value: submit?.getAttribute("value") ?? null,
            }
          : null,
        result: {
          content: document.querySelector("#page-content")?.innerHTML ?? "",
          url: location.href,
        },
      };
    });

    const submitOne = async (query) => {
      const expectedUrl = queryPath(this.#pageOrigin, query);
      await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: CAPTURE_TIMEOUT_MS });
      await page.waitForLoadState("load", { timeout: CAPTURE_TIMEOUT_MS });
      const beforeNavigationCount = navigationUrls.length;
      const input = page.locator("#search-top-box-input");
      await input.evaluate((element, value) => {
        element.value = value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
      }, query.query);
      await Promise.all([
        page.waitForURL(expectedUrl, { timeout: CAPTURE_TIMEOUT_MS }),
        page.locator("#search-top-box-form").evaluate((form) => form.requestSubmit()),
      ]);
      const state = await readState();
      return {
        query: query.query,
        encoded_path: query.encoded_path,
        input_url: baseUrl,
        final_url: state.result.url,
        navigation_delta: navigationUrls.length - beforeNavigationCount,
        navigation_urls: navigationUrls.slice(beforeNavigationCount),
        result: {
          content_sha256: sha256(state.result.content),
          error_boundary_present: state.result.content.includes(SEARCH_ERROR),
        },
      };
    };

    try {
      const initialNavigation = await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: CAPTURE_TIMEOUT_MS });
      const initial = await readState();
      const liveQuery = await submitOne(QUERIES[0]);
      const exactQuery = await submitOne(QUERIES[1]);
      return {
        saved_page: { slug: SAVED_PAGE_SLUG, url: baseUrl, status: initialNavigation?.status() ?? 0 },
        initial_form: initial.form,
        initial_result: { content_sha256: sha256(initial.result.content), error_boundary_present: initial.result.content.includes(SEARCH_ERROR) },
        live_query: liveQuery,
        exact_query: exactQuery,
        request_methods: requestMethods,
        failed_requests: failedRequests,
        navigation_urls: navigationUrls,
        mutation_detected: requestMethods.some((method) => !["GET", "HEAD", "OPTIONS"].includes(method)),
      };
    } finally {
      page.off("request", onRequest);
      page.off("requestfailed", onFailed);
      page.off("framenavigated", onNavigation);
      await page.close({ runBeforeUnload: false, timeout: 10_000 }).catch(() => undefined);
    }
  }
}

function verifyForm(form, label) {
  const value = requirePlainObject(form, `Q748 ${label}`);
  if (
    value.id !== LIVE_FORM_CONTRACT.id ||
    value.action !== LIVE_FORM_CONTRACT.action ||
    value.query_name !== LIVE_FORM_CONTRACT.query_name ||
    value.query_value !== LIVE_FORM_CONTRACT.prompt_value ||
    value.submit_name !== LIVE_FORM_CONTRACT.submit_name ||
    value.submit_value !== LIVE_FORM_CONTRACT.submit_value
  ) {
    throw new Error(`Q748 ${label} topbar form differs from the sealed live form contract`);
  }
}

function verifyDiscipline(observations, label) {
  if (!Array.isArray(observations.request_methods) || observations.request_methods.some((method) => !["GET", "HEAD", "OPTIONS"].includes(method))) {
    throw new Error(`Q748 ${label} issued a mutating or non-read request`);
  }
  if (
    !Array.isArray(observations.failed_requests) ||
    observations.failed_requests.some((request) => !(
      EXPECTED_CANCELLED_SIGMA_ASSETS.has(request?.url) &&
      request.method === "GET" &&
      request.failure === "net::ERR_ABORTED"
    ))
  ) {
    throw new Error(
      `Q748 ${label} candidate observed failed requests: ${JSON.stringify(observations.failed_requests)}`,
    );
  }
  if (observations.mutation_detected !== false) throw new Error(`Q748 ${label} candidate mutation was detected`);
  if (observations.navigation_urls.some((url) => url.includes("/dummy"))) {
    throw new Error(`Q748 ${label} candidate navigated to the legacy dummy action`);
  }
}

function verifyQueryObservation(value, expected, plan, label) {
  const observation = requirePlainObject(value, `Q748 ${label}`);
  const expectedUrl = new URL(`/search:site/q/${expected.encoded_path}`, plan.page_origin).href;
  if (observation.query !== expected.query || observation.encoded_path !== expected.encoded_path) {
    throw new Error(`Q748 ${label} did not preserve the exact query whitespace`);
  }
  if (observation.final_url !== expectedUrl || observation.navigation_delta !== 1) {
    throw new Error(`Q748 ${label} navigation contract is wrong`);
  }
  requireSha256(observation.result.content_sha256, `Q748 ${label} result sha`);
  if (observation.result.error_boundary_present !== true) {
    throw new Error(`Q748 ${label} result did not render the sealed live unavailable boundary`);
  }
}

export function verifyOpen43Q748TopBarSearchCase(caseId, rawObservations, plan) {
  const observations = requirePlainObject(rawObservations, "Q748 observations");
  const fixedPlan = requirePlainObject(plan, "Q748 plan");
  requireSha256(fixedPlan.form_fixture_sha256, "Q748 form fixture sha");
  if (fixedPlan.form_fixture_sha256 !== SEALED_FORM_FIXTURE_SHA256) throw new Error("Q748 form fixture digest differs from sealed live evidence");
  if (fixedPlan.result_evidence_sha256 !== SEALED_RESULT_EVIDENCE_SHA256) throw new Error("Q748 result evidence digest differs from sealed live evidence");
  if (JSON.stringify(fixedPlan.queries) !== JSON.stringify(QUERIES)) throw new Error("Q748 query denominator changed");
  const saved = requirePlainObject(observations.saved_page, "Q748 saved page");
  if (saved.slug !== fixedPlan.saved_page_slug || saved.status !== 200 || saved.url !== new URL(`/${fixedPlan.saved_page_slug}`, fixedPlan.page_origin).href) {
    throw new Error("Q748 saved fixture identity is wrong");
  }
  const initialResult = requirePlainObject(observations.initial_result, "Q748 initial result");
  requireSha256(initialResult.content_sha256, "Q748 initial result sha");
  if (initialResult.error_boundary_present !== true) throw new Error("Q748 initial fixture page omitted the sealed live unavailable boundary");
  verifyForm(observations.initial_form, "initial form");
  verifyDiscipline(observations, "submission");
  if (caseId === "Q748_LIVE_TOPBAR_SUBMISSION_CONTRACT") {
    verifyQueryObservation(observations.live_query, QUERIES[0], fixedPlan, "live contract query");
    return { verified: true, case_id: caseId, saved_page_slug: saved.slug, form_fixture_sha256: fixedPlan.form_fixture_sha256, result_evidence_sha256: fixedPlan.result_evidence_sha256 };
  }
  if (caseId === "Q748_EXACT_CANDIDATE_BROWSER_SUBMISSION") {
    verifyQueryObservation(observations.live_query, QUERIES[0], fixedPlan, "exact normal query");
    verifyQueryObservation(observations.exact_query, QUERIES[1], fixedPlan, "exact whitespace query");
    return { verified: true, case_id: caseId, saved_page_slug: saved.slug, encoded_paths: [QUERIES[0].encoded_path, QUERIES[1].encoded_path], result_boundary_sha256: SEARCH_ERROR_SHA256 };
  }
  throw new Error(`unknown Q748 case: ${caseId}`);
}

class Open43Q748TopBarSearchRun {
  #session;
  #browser;
  #resources;
  #plan;
  #siteId = null;
  #page = null;
  #observations = null;

  constructor({ session, browser, resources, plan }) {
    this.#session = session;
    this.#browser = browser;
    this.#resources = resources;
    this.#plan = plan;
  }

  async #prepareFixture() {
    const site = await this.#session.rpc("site_get", { site: "scpaiueouiuiuiui" });
    this.#siteId = site.site_id;
    if (await this.#session.rpc("page_get", { site_id: this.#siteId, page: SAVED_PAGE_SLUG, details: { wikitext: true, compiled: false } }) !== null) throw new Error(`Q748 fixture page already exists: ${SAVED_PAGE_SLUG}`);
    const page = await this.#session.rpc("page_create", { site_id: this.#siteId, slug: SAVED_PAGE_SLUG, title: "Search", alt_title: null, wikitext: "[[module Search]]", layout: "wikidot", user_id: this.#session.editorUserId, ip_address: "127.0.0.1", tags: [], revision_comments: "Open43 Q748 candidate fixture" });
    if (!Number.isSafeInteger(page?.page_id) || page.slug !== SAVED_PAGE_SLUG) throw new Error("Q748 fixture page_create did not return its public identity");
    this.#page = page;
    this.#resources.register("page", { page_id: page.page_id, revision_id: page.revision_id, slug: SAVED_PAGE_SLUG });
  }

  async execute() {
    await this.#prepareFixture();
    this.#observations = await this.#browser.captureTopBarSearch();
    return CASE_IDS.map((caseId) => ({
      case_id: caseId,
      observations: {
        ...this.#observations,
        result_identity: {
          case_id: caseId,
          saved_page_slug: this.#plan.saved_page_slug,
          candidate_identity_sha256: this.#plan.candidate_identity_sha256,
          form_fixture_sha256: this.#plan.form_fixture_sha256,
          result_evidence_sha256: this.#plan.result_evidence_sha256,
        },
      },
    }));
  }

  async cleanup() {
    if (this.#observations?.mutation_detected === true) throw new Error("Q748 candidate observed a mutating request without a run-owned cleanup operation");
    if (this.#page !== null) {
      const current = await this.#session.rpc("page_get", { site_id: this.#siteId, page: SAVED_PAGE_SLUG, details: { wikitext: true, compiled: false } }, { cleanup: true });
      if (current?.page_id !== this.#page.page_id) throw new Error("Q748 cleanup refused an unowned fixture page");
      await this.#session.rpc("page_delete", { site_id: this.#siteId, page: current.page_id, last_revision_id: current.revision_id, revision_comments: "Open43 Q748 candidate cleanup", user_id: this.#session.editorUserId, ip_address: "127.0.0.1" }, { cleanup: true });
      const after = await this.#session.pageRequest(SAVED_PAGE_SLUG, { cleanup: true, operation: "q748-cleanup" });
      if (after.status !== 404) throw new Error("Q748 cleanup did not prove public absence");
      this.#resources.release({ sequence: 1, kind: "page" }, { page_get: null, public_status: after.status });
    }
    return { public_absence_verified: true, mutation_count: 0, cleanup_required: false, fixture_page_count: this.#page === null ? 0 : 1 };
  }

  verifyCase(caseId, observations) {
    if (!CASE_IDS.includes(caseId)) throw new Error(`unknown Q748 case: ${caseId}`);
    const identity = requirePlainObject(observations.result_identity, `Q748 ${caseId} result identity`);
    if (
      identity.case_id !== caseId ||
      identity.saved_page_slug !== this.#plan.saved_page_slug ||
      identity.candidate_identity_sha256 !== this.#plan.candidate_identity_sha256 ||
      identity.form_fixture_sha256 !== this.#plan.form_fixture_sha256 ||
      identity.result_evidence_sha256 !== this.#plan.result_evidence_sha256
    ) throw new Error(`Q748 ${caseId} result is not identity-bound`);
    return verifyOpen43Q748TopBarSearchCase(caseId, observations, this.#plan);
  }
}

function verifyCleanup(proof, resources) {
  const cleanup = requirePlainObject(proof, "Q748 cleanup proof");
  if (cleanup.public_absence_verified !== true || cleanup.mutation_count !== 0 || cleanup.cleanup_required !== false) {
    throw new Error("Q748 read-only candidate cleanup proof is invalid");
  }
  if (!Array.isArray(resources) || resources.length !== 1 || resources.some((resource) => resource.released !== true)) throw new Error("Q748 candidate fixture resource cleanup is incomplete");
  return { verified: true, public_absence_verified: true, mutation_count: 0, fixture_page_count: 1 };
}

const SOURCE_FILES = Object.freeze([
  "install/local/wikidot-verification/artifacts/listpages-campaign-live-fixtures.json",
  "install/local/wikidot-verification/artifacts/search-feed-live-preview-20260809.json",
  "install/local/wikidot-verification/scripts/run-candidate-cases.mjs",
  "install/local/wikidot-verification/src/candidate-browser-contexts.mjs",
  "install/local/wikidot-verification/src/candidate-case-command.mjs",
  "install/local/wikidot-verification/src/candidate-case-runner.mjs",
  "install/local/wikidot-verification/src/open43-q748-topbar-search-candidate-case-set.mjs",
  "install/local/wikidot-verification/src/standing-browser-parity-receipt.mjs",
  "install/local/wikidot-verification/src/standing-browser-parity-util.mjs",
  "framerail/src/lib/wikidot/wikidot-search.js",
  "framerail/src/routes/+layout.svelte",
  "framerail/tests/wikidot-search.test.js",
]);

export function createOpen43Q748TopBarSearchCandidateCaseSet({ sessionFactory = (options) => new CandidateHttpSession(options) } = {}) {
  return Object.freeze({
    id: "open43-q748-topbar-search",
    caseIds: CASE_IDS,
    async prepareRun({ runId, candidateIdentity, candidateIdentitySha256, candidateBrowserContexts, resources, privateInput, signal }) {
      requireSha256(candidateIdentitySha256, "Q748 candidate identity sha");
      if (candidateIdentity.candidate.endpoint.host !== SITE_HOST || candidateIdentity.candidate.endpoint.port === 443 || candidateIdentity.candidate.port_443_published !== false) {
        throw new Error(`Q748 requires exact non-standing ${SITE_HOST}`);
      }
      const pageOrigin = candidatePageOrigin(candidateIdentity);
      const plan = Object.freeze({
        schema: "wikijump.open43_q748_topbar_search_candidate_plan.v1",
        issue: 748,
        run_id: runId,
        case_ids: [...CASE_IDS],
        page_origin: pageOrigin,
        candidate_identity_sha256: candidateIdentitySha256,
        saved_page_slug: SAVED_PAGE_SLUG,
        saved_page_source: "[[module Search]]",
        form_fixture: Object.freeze({ path: FORM_FIXTURE_PATH, sha256: FORM_FIXTURE_SHA256 }),
        form_fixture_sha256: FORM_FIXTURE_SHA256,
        result_evidence: Object.freeze({ path: RESULT_EVIDENCE_PATH, sha256: RESULT_EVIDENCE_SHA256 }),
        result_evidence_sha256: RESULT_EVIDENCE_SHA256,
        live_form_contract: LIVE_FORM_CONTRACT,
        queries: QUERIES,
        error_boundary_sha256: SEARCH_ERROR_SHA256,
        unsealed_live_values: UNSELALED_LIVE_VALUES,
        mutation_policy: "read-only",
      });
      const browser = new Open43Q748TopBarSearchBrowserAdapter({ browserContexts: candidateBrowserContexts, pageOrigin });
      const session = sessionFactory({ candidateIdentity, privateInput, signal });
      const execution = new Open43Q748TopBarSearchRun({ session, browser, resources, plan });
      return Object.freeze({
        sourceFiles: SOURCE_FILES,
        runtimeBindings: session.requiredServiceBindings,
        privateInputIdentity: Object.freeze({ ...session.privateInputIdentity, mode: "candidate-fixture", fixture_sha256: FORM_FIXTURE_SHA256 }),
        browserCredentialPolicy: "none",
        plan,
        execute: () => execution.execute(),
        cleanup: () => execution.cleanup(),
        verifyCase: (caseId, observations) => execution.verifyCase(caseId, observations),
        verifyCleanup,
      });
    },
  });
}
