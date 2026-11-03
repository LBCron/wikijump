import fs from "node:fs";

import { Open43SettingsCandidateSession } from "./open43-settings-candidate-http.mjs";
import { leasedPageEdit } from "./page-edit-lease.mjs";
import { STANDING_BROWSER_EXECUTION_MODULES } from "./standing-browser-execution-identity.mjs";
import { candidatePageOrigin } from "./standing-browser-parity-receipt.mjs";
import { sha256Text, sha256Value } from "./standing-browser-parity-util.mjs";

export const COMMENTS_HIDEFORM_BROWSER_CASE_IDS = Object.freeze([
  "M1367_COMMENTS_HIDEFORM_ACTOR_FORM_STATE",
]);

const SITE_SLUG = "scpaiueouiuiuiui";
const SITE_HOST = `${SITE_SLUG}.wikijump.localhost`;
const CASE_FIXTURE_PATH = "install/local/wikidot-verification/fixtures/comments-hideform-actor/cases.json";
const CASE_FIXTURE_BYTES = fs.readFileSync(new URL("../fixtures/comments-hideform-actor/cases.json", import.meta.url));
const CASE_FIXTURE = JSON.parse(CASE_FIXTURE_BYTES);
const CASE_FIXTURE_SHA256 = sha256Text(CASE_FIXTURE_BYTES);
const CASES = Object.freeze(CASE_FIXTURE.cases.filter(({ documented_form_state }) => ["open", "closed"].includes(documented_form_state)));
const ACTORS = Object.freeze([
  { label: "permitted", fixtureActor: "administrator" },
  { label: "denied", fixtureActor: "non_admin" },
]);
const BROWSER_CONTRACT = Object.freeze({
  schema: "wikijump.comments_hideform_browser_contract.v1",
  presence_probes: [
    { id: "comments-box", selector: ".comments-box" },
    { id: "new-post-form", selector: "#new-post-form" },
    { id: "new-post-button", selector: "#new-post-button" },
    { id: "thread-container", selector: "#thread-container" },
  ],
  first_paint_geometry_selectors: [".comments-box", "#new-post-form", "#new-post-button"],
  geometry_selectors: [".comments-box", "#new-post-form", "#new-post-button"],
});

const SOURCE_FILES = Object.freeze([...new Set([
  ...STANDING_BROWSER_EXECUTION_MODULES,
  "install/local/wikidot-verification/scripts/run-candidate-cases.mjs",
  "install/local/wikidot-verification/src/candidate-case-command.mjs",
  "install/local/wikidot-verification/src/candidate-case-runner.mjs",
  "install/local/wikidot-verification/src/candidate-browser-contexts.mjs",
  "install/local/wikidot-verification/src/comments-hideform-browser-candidate-case-set.mjs",
  "install/local/wikidot-verification/src/deepwell-rpc-auth.mjs",
  "install/local/wikidot-verification/src/open43-settings-candidate-http.mjs",
  "install/local/wikidot-verification/src/page-edit-lease.mjs",
  CASE_FIXTURE_PATH,
  "install/local/wikidot-verification/package.json",
  "install/local/wikidot-verification/pnpm-lock.yaml",
])]);

function requireCapturePhase(capture, settled) {
  const document = settled ? capture.document : capture.first_paint?.document;
  const expectedPhase = settled ? "settled" : "domcontentloaded_immediate_observation";
  if (capture.capture_error || capture.navigation_status !== 200 || document?.phase !== expectedPhase) throw new Error("Comments hideForm browser capture is incomplete");
  return document;
}

function probe(document, id) {
  const value = document.presence_probes?.find((entry) => entry.id === id);
  if (!value) throw new Error(`Comments hideForm browser capture lacks ${id}`);
  return { count: value.count, rendered_count: value.rendered_count };
}

function intervalObservation(capture, settled) {
  const document = requireCapturePhase(capture, settled);
  const form = probe(document, "new-post-form");
  const button = probe(document, "new-post-button");
  if (!new Set(["interactive", "complete"]).has(document.ready_state)) throw new Error("Comments hideForm browser ready state is invalid");
  return {
    interval: settled ? "settled" : "domcontentloaded",
    sequence: settled ? 2 : 1,
    ready_state: document.ready_state,
    comments_box_present: probe(document, "comments-box").count === 1,
    form_present: form.count === 1,
    form_visible: form.rendered_count === 1,
    new_post_button_present: button.count === 1,
    new_post_button_visible: button.rendered_count === 1,
    thread_container_present: probe(document, "thread-container").count === 1,
    dom_signature: document.dom_signature,
    resource_completion: settled ? document.resource_completion : null,
    screenshot: settled ? capture.settled_viewport_screenshot : capture.first_paint.screenshot,
    full_page_screenshot: settled ? capture.screenshot : null,
  };
}

function expectedState(actor, sourceCase) {
  const formOpen = actor === "permitted" && sourceCase.documented_form_state === "open";
  return { form_present: formOpen, form_visible: formOpen, new_post_button_present: true, new_post_button_visible: !formOpen };
}

function verifyObservation(observation, expected, actor, sourceCase, actorIdentity) {
  if (observation.actor !== actor.label || observation.actor_fixture !== actor.fixtureActor || observation.actor_user_id !== actorIdentity.user_id || observation.actor_session_sha256 !== actorIdentity.session_sha256 || observation.case_id !== sourceCase.case_id || observation.source_sha256 !== sha256Text(sourceCase.source)) throw new Error("Comments hideForm observation identity is not exact");
  if (observation.navigation_status !== 200 || observation.input_url !== observation.final_url || observation.failures.length !== 0 || observation.request_gate_aborts.length !== 0) throw new Error("Comments hideForm browser navigation was not clean");
  for (const interval of [observation.domcontentloaded, observation.settled]) {
    if (!interval.comments_box_present || !interval.thread_container_present || interval.form_present !== expected.form_present || interval.form_visible !== expected.form_visible || interval.new_post_button_present !== expected.new_post_button_present || interval.new_post_button_visible !== expected.new_post_button_visible) throw new Error(`Comments hideForm state mismatch for ${actor}:${sourceCase.case_id}:${interval.interval}`);
    if (!interval.screenshot?.path || !/^[0-9a-f]{64}$/u.test(interval.screenshot.sha256)) throw new Error("Comments hideForm observation screenshot identity is missing");
    if (interval.interval === "settled" && !interval.full_page_screenshot?.path) throw new Error("Comments hideForm settled full-page screenshot is missing");
  }
}

class CommentsHideformRun {
  #session;
  #browserContexts;
  #resources;
  #runId;
  #siteId = null;
  #pageSlug;
  #pageTitle;
  #ownedPage = null;
  #pageResource = null;
  #categorySetting = null;
  #categoryResource = null;
  #actorIdentities = null;
  #observations = [];

  constructor({ session, browserContexts, resources, runId }) {
    this.#session = session;
    this.#browserContexts = browserContexts;
    this.#resources = resources;
    this.#runId = runId;
    this.#pageSlug = `run-owned:comments-hideform-${runId.slice("candidate-run-".length)}`;
    this.#pageTitle = `Candidate Comments hideForm ${this.#pageSlug}`;
  }

  async #rpc(method, params = {}, { actor = "administrator", cleanup = false } = {}) {
    return await this.#session.rpc(method, params, { actor, siteId: this.#siteId, page: this.#pageSlug, cleanup });
  }

  async #page({ cleanup = false } = {}) {
    return await this.#rpc("page_get", { site_id: this.#siteId, page: this.#pageSlug, details: { wikitext: true, compiled: false } }, { cleanup });
  }

  #matchesOwnedPage(page) {
    return this.#ownedPage !== null && page?.page_id === this.#ownedPage.page_id && page.slug === this.#pageSlug && page.title === this.#pageTitle && CASES.some(({ source }) => page.wikitext === source);
  }

  async #setSource(sourceCase) {
    let page = await this.#page();
    if (!this.#matchesOwnedPage(page)) throw new Error("run-owned Comments page identity drifted");
    if (page.wikitext !== sourceCase.source) {
      await leasedPageEdit((method, params) => this.#rpc(method, params), {
        site_id: this.#siteId,
        page: page.page_id,
        last_revision_id: page.revision_id,
        revision_comments: "Comments hideForm candidate case",
        user_id: this.#actorIdentities.permitted.user_id,
        ip_address: "127.0.0.1",
        wikitext: sourceCase.source,
        title: this.#pageTitle,
      });
      page = await this.#page();
    }
    if (!this.#matchesOwnedPage(page) || page.wikitext !== sourceCase.source) throw new Error(`Comments hideForm source did not round-trip for ${sourceCase.case_id}`);
  }

  async #capture(actor, sourceCase, index, context) {
    const caseLabel = sourceCase.case_id.replaceAll("-", "_").toUpperCase();
    const actorLabel = actor.label.toUpperCase();
    const capture = await this.#browserContexts.captureCandidateObservation({
      context,
      url: new URL(`/${encodeURIComponent(this.#pageSlug)}`, this.#session.pageOrigin).href,
      label: `M1367_${actorLabel}_${caseLabel}`,
      index,
      contract: BROWSER_CONTRACT,
      viewport: { width: 1280, height: 900 },
      timeoutMs: 30_000,
      settleMs: 0,
      onPhase: (phase) => this.#browserContexts.setActiveFixture(`M1367_${actorLabel}_${caseLabel}_${phase === "settled" ? "SETTLED" : "DOMCONTENTLOADED"}`),
    });
    return {
      actor: actor.label,
      actor_fixture: actor.fixtureActor,
      actor_user_id: this.#actorIdentities[actor.label].user_id,
      actor_session_sha256: this.#actorIdentities[actor.label].session_sha256,
      case_id: sourceCase.case_id,
      source_sha256: sha256Text(sourceCase.source),
      input_url: capture.input_url,
      final_url: capture.final_url,
      navigation_status: capture.navigation_status,
      failures: capture.failures,
      request_gate_aborts: capture.request_gate_aborts,
      domcontentloaded: intervalObservation(capture, false),
      settled: intervalObservation(capture, true),
    };
  }

  async execute() {
    const fixture = this.#session.fixtureIdentity;
    this.#siteId = fixture.site_id;
    const site = await this.#session.rpc("site_get", { site: SITE_SLUG });
    if (site?.site_id !== this.#siteId) throw new Error("Comments hideForm candidate site identity differs from the actor fixture");
    const sessions = await this.#session.verifyActorSessions();
    this.#actorIdentities = {
      permitted: { user_id: sessions.administrator_user_id, session_sha256: this.#session.privateInputIdentity.administrator_session_sha256 },
      denied: { user_id: sessions.non_admin_user_id, session_sha256: this.#session.privateInputIdentity.non_admin_session_sha256 },
    };
    const existing = await this.#page();
    if (existing !== null) throw new Error("Comments hideForm run-owned page namespace already exists");
    const firstSource = CASES[0].source;
    const created = await this.#rpc("page_create", {
      site_id: this.#siteId,
      slug: this.#pageSlug,
      title: this.#pageTitle,
      alt_title: null,
      wikitext: firstSource,
      layout: "wikidot",
      user_id: this.#actorIdentities.permitted.user_id,
      ip_address: "127.0.0.1",
      tags: [],
      revision_comments: "Comments hideForm candidate fixture",
    });
    if (!Number.isSafeInteger(created?.page_id) || created.slug !== this.#pageSlug) throw new Error("Comments hideForm page_create did not return an exact page identity");
    this.#ownedPage = { page_id: created.page_id, slug: this.#pageSlug, title: this.#pageTitle };
    this.#pageResource = this.#resources.register("page", { ...this.#ownedPage, source_fixture_sha256: CASE_FIXTURE_SHA256 });
    if (!this.#matchesOwnedPage(await this.#page())) throw new Error("Comments hideForm page_create did not round-trip");

    const category = await this.#rpc("category_get", { site: this.#siteId, category: "run-owned" });
    if (!Number.isSafeInteger(category?.category_id) || !Number.isSafeInteger(category.settings_revision)) throw new Error("Comments hideForm run-owned category fixture is missing");
    this.#categorySetting = { category_id: category.category_id, per_page_discussion: category.per_page_discussion };
    const updatedCategory = await this.#rpc("category_update", {
      site: this.#siteId,
      category: "run-owned",
      user_id: this.#actorIdentities.permitted.user_id,
      expected_settings_revision: category.settings_revision,
      per_page_discussion: true,
      ip_address: "127.0.0.1",
    });
    if (updatedCategory?.category_id !== category.category_id || updatedCategory.per_page_discussion !== true) throw new Error("Comments hideForm discussion category fixture was not enabled");
    this.#categoryResource = this.#resources.register("category-setting", {
      category_id: category.category_id,
      slug: "run-owned",
      per_page_discussion_before: category.per_page_discussion,
    });

    // A saved Wikidot Comments module only has the actor/form state that this
    // case verifies after the page has an actual per-page discussion thread.
    // The candidate is disposable; create that thread through the same public
    // page-discussion seam used by the browser instead of assuming seed state.
    const discussion = await this.#rpc("wikidot_page_discussion_create", {
      site_id: this.#siteId,
      page_id: created.page_id,
    });
    if (!Number.isSafeInteger(discussion?.thread_id)) throw new Error("Comments hideForm discussion fixture was not created");

    const contexts = new Map();
    const ensureContext = async (actor) => {
      if (!contexts.has(actor.label)) contexts.set(actor.label, this.#browserContexts.newCandidateContext({ storageState: this.#session.storageState(actor.fixtureActor) }).then(({ context }) => context));
      return await contexts.get(actor.label);
    };
    let index = 0;
    for (const sourceCase of CASES) {
      await this.#setSource(sourceCase);
      for (const actor of ACTORS) this.#observations.push(await this.#capture(actor, sourceCase, index++, await ensureContext(actor)));
    }
    return [{ case_id: COMMENTS_HIDEFORM_BROWSER_CASE_IDS[0], observations: { actors: this.#actorIdentities, cases: this.#observations } }];
  }

  async cleanup() {
    const page = await this.#page({ cleanup: true });
    if (page !== null && !this.#matchesOwnedPage(page)) throw new Error("Comments hideForm cleanup refused a changed run-owned page");
    if (page !== null) await this.#rpc("page_delete", { site_id: this.#siteId, page: page.page_id, last_revision_id: page.revision_id, revision_comments: "Comments hideForm candidate cleanup", user_id: this.#actorIdentities.permitted.user_id, ip_address: "127.0.0.1" }, { cleanup: true });
    const after = await this.#page({ cleanup: true });
    if (after !== null) throw new Error("Comments hideForm run-owned page remains after cleanup");
    if (this.#pageResource !== null) this.#resources.release(this.#pageResource, { page_get: null, page_id: this.#ownedPage.page_id, public_absence_verified: true });
    let categoryRestored = this.#categorySetting === null;
    if (this.#categorySetting !== null) {
      const category = await this.#rpc("category_get", { site: this.#siteId, category: "run-owned" }, { cleanup: true });
      if (category?.category_id !== this.#categorySetting.category_id || !Number.isSafeInteger(category.settings_revision)) throw new Error("Comments hideForm cleanup could not reload run-owned category");
      const restored = await this.#rpc("category_update", {
        site: this.#siteId,
        category: "run-owned",
        user_id: this.#actorIdentities.permitted.user_id,
        expected_settings_revision: category.settings_revision,
        per_page_discussion: this.#categorySetting.per_page_discussion,
        ip_address: "127.0.0.1",
      }, { cleanup: true });
      categoryRestored = restored?.category_id === this.#categorySetting.category_id && restored.per_page_discussion === this.#categorySetting.per_page_discussion;
      if (!categoryRestored) throw new Error("Comments hideForm cleanup did not restore discussion category setting");
      if (this.#categoryResource !== null) this.#resources.release(this.#categoryResource, { per_page_discussion: restored.per_page_discussion, restored: true });
    }
    return { page_get: after, page_id: this.#ownedPage?.page_id ?? null, category_restored: categoryRestored, public_absence_verified: after === null && categoryRestored };
  }

  verifyCase(caseId, observations) {
    if (caseId !== COMMENTS_HIDEFORM_BROWSER_CASE_IDS[0] || this.#actorIdentities === null || observations?.cases?.length !== ACTORS.length * CASES.length) throw new Error("Comments hideForm candidate denominator is incomplete");
    for (const actor of ACTORS) {
      const identity = observations.actors?.[actor.label];
      const expected = this.#actorIdentities[actor.label];
      if (identity?.user_id !== expected.user_id || identity?.session_sha256 !== expected.session_sha256) throw new Error(`Comments hideForm ${actor.label} identity is not exact`);
    }
    for (const sourceCase of CASES) for (const actor of ACTORS) {
      const row = observations.cases.find((value) => value.actor === actor.label && value.case_id === sourceCase.case_id);
      if (!row) throw new Error(`Comments hideForm observation is missing for ${actor.label}:${sourceCase.case_id}`);
      verifyObservation(row, expectedState(actor.label, sourceCase), actor, sourceCase, this.#actorIdentities[actor.label]);
    }
    return { verified: true, issue: 1367, actor_count: ACTORS.length, source_case_count: CASES.length, interval_count: 2, mutation_capable_browser_requests: 0 };
  }
}

function verifyCleanup(proof, resources) {
  if (proof?.page_get !== null || proof?.category_restored !== true || proof?.public_absence_verified !== true || !Array.isArray(resources) || resources.length !== 2 || resources.some((resource) => resource.released !== true) || !resources.some((resource) => resource.kind === "page") || !resources.some((resource) => resource.kind === "category-setting")) throw new Error("Comments hideForm cleanup did not prove run-owned page absence and category restoration");
  return { public_absence_verified: true, page_absent: true, category_restored: true, page_id: proof.page_id, resource_count: resources.length };
}

export function createCommentsHideformBrowserCandidateCaseSet({ sessionFactory = (options) => new Open43SettingsCandidateSession(options) } = {}) {
  return Object.freeze({
    id: "comments-hideform-browser",
    caseIds: COMMENTS_HIDEFORM_BROWSER_CASE_IDS,
    prepareRun({ runId, candidateIdentity, privateInput, signal, resources, candidateBrowserContexts }) {
      if (candidateIdentity.candidate.endpoint.host !== SITE_HOST || candidateIdentity.candidate.endpoint.port === 443 || candidateIdentity.candidate.port_443_published !== false) throw new Error(`Comments hideForm cases require exact non-standing ${SITE_HOST}`);
      const session = sessionFactory({ candidateIdentity, privateInput, signal });
      if (session.pageOrigin !== candidatePageOrigin(candidateIdentity)) throw new Error("Comments hideForm session did not bind the candidate origin");
      const execution = new CommentsHideformRun({ session, browserContexts: candidateBrowserContexts, resources, runId });
      return Object.freeze({
        sourceFiles: SOURCE_FILES,
        runtimeBindings: session.requiredServiceBindings,
        privateInputIdentity: session.privateInputIdentity,
        browserCredentialPolicy: { mode: "private-actor-storage-states", storage_state_count: ACTORS.length, private_input_identity_sha256: sha256Value(session.privateInputIdentity) },
        plan: { schema: "wikijump.comments_hideform_browser_candidate_plan.v1", issue: 1367, site_slug: SITE_SLUG, page_slug: `run-owned:comments-hideform-${runId.slice("candidate-run-".length)}`, source_fixture: CASE_FIXTURE_PATH, source_fixture_sha256: CASE_FIXTURE_SHA256, source_cases: CASES.map(({ case_id, source, documented_form_state }) => ({ case_id, source_sha256: sha256Text(source), documented_form_state })), actor_matrix: ACTORS.map(({ label, fixtureActor }) => ({ label, fixture_actor: fixtureActor })), intervals: ["domcontentloaded", "settled"], browser_contract_sha256: sha256Value(BROWSER_CONTRACT) },
        execute: () => execution.execute(),
        cleanup: () => execution.cleanup(),
        verifyCase: (caseId, observations) => execution.verifyCase(caseId, observations),
        verifyCleanup,
      });
    },
  });
}
