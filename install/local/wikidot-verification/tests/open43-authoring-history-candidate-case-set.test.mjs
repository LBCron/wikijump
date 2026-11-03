import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { candidateCaseSet } from "../src/candidate-case-command.mjs";
import { createOpen43AuthoringHistoryCandidateCaseSet } from "../src/open43-authoring-history-candidate-case-set.mjs";
import { runCandidateCaseSet } from "../src/candidate-case-runner.mjs";
import { sha256Value } from "../src/standing-browser-parity-util.mjs";

const hash = (value) => (value + "0123456789abcdef".replace(value, "")[0]).repeat(32);
const git = (value) => (value + "0123456789abcdef".replace(value, "")[0]).repeat(20);
const PAGE_ORIGIN = "https://scpaiueouiuiuiui.wikijump.localhost:18443";
const LONG_LINE = "L".repeat(8192);

function candidateIdentity() {
  return {
    schema: "wikijump.standing_candidate_parity_identity.v1",
    status: "sealed",
    artifact_key: hash("a"),
    build: {
      seal_sha256: hash("b"),
      verdict_sha256: hash("c"),
      final_images_sha256: hash("d"),
    },
    candidate: {
      owner: "candidate-case-fixture",
      expires_at: "2099-08-10T00:00:00.000Z",
      compose_project: "wikijump-candidate-case-fixture",
      port_443_published: false,
      wikijump_commit: git("1"),
      wikijump_tree: git("2"),
      ftml_sha: git("3"),
      profile: "production-build",
      source_clean: true,
      images: { caddy: `sha256:${hash("e")}` },
      config: {
        isolated_overlay_sha256: hash("f"),
        promotion_base_manifest_sha256: hash("0"),
        effective_runtime_services_sha256: hash("4"),
      },
      endpoint: {
        scheme: "https",
        host: "scpaiueouiuiuiui.wikijump.localhost",
        port: 18443,
        resolved_addresses: ["127.0.0.1"],
        allowed_origin_set: [
          "https://scpaiueouiuiuiui.wikijump.localhost:18443",
          "https://scpaiueouiuiuiui.wjfiles.localhost:18443",
        ],
        local_connect_address: "127.0.0.1",
      },
    },
    evidence: {
      status: "sealed",
      manifest_sha256: hash("5"),
      seal_sha256: hash("6"),
    },
  };
}

function fakeSession(calls, state) {
  let nextRevisionId = 200;
  return {
    editorUserId: -1,
    editorSessionToken: "editor-session",
    pageOrigin: PAGE_ORIGIN,
    requiredServiceBindings: [],
    privateInputIdentity: { editor_session_sha256: hash("7") },
    async rpc(method, params, options) {
      calls.push({ kind: "rpc", method, params, options });
      if (method === "site_get") return { site_id: 99, slug: "scpaiueouiuiuiui" };
      if (method === "page_get") {
        const page = [...state.pages.values()].find((value) => value.slug === params.page || value.page_id === params.page);
        return page === undefined ? null : { ...page };
      }
      if (method === "page_create") {
        const page = { page_id: 100, revision_id: nextRevisionId++, revision_number: 0, slug: params.slug };
        state.pages.set(page.slug, page);
        return { ...page };
      }
      if (method === "page_edit_lock_acquire") {
        const page = [...state.pages.values()].find((value) => value.page_id === params.page);
        return { grant: { lock_id: 4242, ["lock_secret"]: "fake-lease-secret", base_revision_id: page?.revision_id ?? null, expires_at: "2999-01-01T00:00:00Z" }, conflicts: [] };
      }
      if (method === "page_edit_lock_release") return true;
      if (method === "page_edit") {
        const page = [...state.pages.values()].find((value) => value.page_id === params.page);
        assert.ok(params.lease, "page_edit must present an edit lease");
        Object.assign(page, { revision_id: nextRevisionId++, revision_number: page.revision_number + 1 });
        return { ...page };
      }
      if (method === "page_revision_diff") return {
        site_id: 99,
        page_id: params.page_id,
        from_revision_number: 0,
        to_revision_number: 2,
        lines: [
          { kind: "unchanged", text: "first line" },
          { kind: "removed", text: "old source only" },
          { kind: "added", text: "final line" },
        ],
      };
      if (method === "page_delete") {
        const page = [...state.pages.values()].find((value) => value.page_id === params.page);
        if (page) state.pages.delete(page.slug);
        return null;
      }
      if (method === "user_get") return { user_id: -1, user_type: "regular", locales: [...state.locales] };
      if (method === "user_edit") {
        assert.equal(params.user, -1);
        state.locales = [...params.locales];
        return { user_id: -1, user_type: "regular", locales: [...state.locales] };
      }
      throw new Error(`unexpected RPC ${method}`);
    },
    async ajaxModuleRequest(fields, options) {
      calls.push({ kind: "ajax", fields, options });
      return {
        http_status: 200,
        response_body_size: 32,
        response_body_sha256: hash("8"),
        payload: { status: "ok", body: "<history>public</history>" },
      };
    },
  };
}

class FakeResponse {
  constructor(url, status, body, method = "GET") {
    this.responseUrl = url;
    this.responseStatus = status;
    this.body = body;
    this.method = method;
  }

  status() { return this.responseStatus; }
  url() { return this.responseUrl; }
  request() { return { method: () => this.method, url: () => this.responseUrl }; }
  async text() { return this.body; }
}

class FakePage {
  constructor({ authenticated, state }) {
    this.authenticated = authenticated;
    this.state = state;
    this.currentUrl = "about:blank";
    this.history = [this.currentUrl];
    this.historyIndex = 0;
    this.inputValue = "";
    this.listeners = new Set();
    this.responseWaiters = [];
  }

  async goto(url) {
    this.currentUrl = !this.authenticated && new URL(url).pathname === "/-/settings"
      ? new URL("/-/login", PAGE_ORIGIN).href
      : url;
    this.history.splice(this.historyIndex + 1);
    this.history.push(this.currentUrl);
    this.historyIndex = this.history.length - 1;
    if (this.authenticated && new URL(this.currentUrl).pathname === "/-/settings") this.inputValue = this.state.locales.join(" ");
    return new FakeResponse(this.currentUrl, 200, "ok");
  }

  url() { return this.currentUrl; }

  async evaluate(_callback, argument) {
    if (argument.operation === "history-diff-workflow") return {
      initial_selection: { from: String(argument.fromRevisionNumber), to: String(argument.toRevisionNumber) },
      swapped_selection: { from: String(argument.toRevisionNumber), to: String(argument.fromRevisionNumber) },
      loading_observed: true,
      focus_before: true,
      focus_after: true,
      lines: [
        { kind: "removed", text: "first line" },
        { kind: "added", text: "final line" },
        { kind: "unchanged", text: LONG_LINE },
        { kind: "unchanged", text: "" },
      ],
      unsafe_element_count: 0,
    };
    if (argument.operation === "missing-revision-probe") return { status: 200, body_size: 12, body_sha256: hash("a"), leaked_markup: false };
    if (argument.operation === "history-fail-closed-workflow") return { loading_observed: true, result_count: 0, error_visible: false, error_text_sha256_input: "", hidden_source_present: false, unsafe_element_count: 0 };
    if (argument.operation === "settings-state") return { form_count: 1, input_count: 1, input_value: this.inputValue, save_count: 1, cancel_count: 1 };
    if (argument.operation === "add-submitted-user") {
      this.submittedUser = 999;
      return undefined;
    }
    if (argument.operation === "submit-settings-form") {
      const parsed = [...new Set(this.inputValue.replaceAll("_", "-").replaceAll(",", " ").split(/\s+/u).filter(Boolean))];
      if (parsed.length === 0) return { status: 400, body: "invalid" };
      const requestBody = "locales=ja_JP%2C+en-US+ja-JP&signature=&user=999&__superform_id=11b3t38";
      this.state.locales = parsed;
      this.deferNextReload = this.state.deferNextSettingsReloadSettlement === true;
      return { status: 200, body: "saved", request_body: requestBody };
    }
    throw new Error(`unexpected browser operation ${argument.operation}`);
  }

  async fill(selector, value) {
    assert.equal(selector, "#user-display-locales");
    this.inputValue = value;
  }

  async click(selector) {
    if (selector.endsWith(".button-cancel")) {
      this.inputValue = this.state.locales.join(" ");
      return;
    }
    assert.equal(selector, "#user-settings-form .button-save");
    const url = new URL("/-/settings?/display", PAGE_ORIGIN).href;
    const body = new URLSearchParams({ locales: this.inputValue });
    if (this.submittedUser !== undefined) body.set("user", String(this.submittedUser));
    const request = { method: () => "POST", url: () => url, postData: () => body.toString() };
    for (const listener of this.listeners) listener(request);
    const parsed = [...new Set(this.inputValue.replaceAll("_", "-").replaceAll(",", " ").split(/\s+/u).filter(Boolean))];
    const response = new FakeResponse(url, parsed.length === 0 ? 400 : 200, parsed.length === 0 ? "invalid" : "saved", "POST");
    if (parsed.length > 0) this.state.locales = parsed;
    for (const waiter of this.responseWaiters.splice(0)) {
      if (waiter.predicate(response)) waiter.resolve(response);
      else waiter.reject(new Error("fake response did not match"));
    }
  }

  waitForResponse(predicate) {
    return new Promise((resolve, reject) => this.responseWaiters.push({ predicate, resolve, reject }));
  }

  async reload() {
    if (this.deferNextReload) {
      this.deferNextReload = false;
      this.pendingInputValue = this.state.locales.join(" ");
    } else {
      this.inputValue = this.state.locales.join(" ");
    }
    return new FakeResponse(this.currentUrl, 200, "ok");
  }

  async waitForFunction(_callback, argument, options) {
    assert.deepEqual(argument, {
      selector: "#user-display-locales",
      expected: this.state.locales.join(" "),
    });
    assert.equal(options.timeout, 10_000);
    this.state.settingsWaitCalls = (this.state.settingsWaitCalls ?? 0) + 1;
    if (this.pendingInputValue !== undefined) {
      this.inputValue = this.pendingInputValue;
      this.pendingInputValue = undefined;
    }
    assert.equal(this.inputValue, argument.expected);
  }

  async goBack() {
    this.historyIndex -= 1;
    this.currentUrl = this.history[this.historyIndex];
    return new FakeResponse(this.currentUrl, 200, "ok");
  }

  async goForward() {
    this.historyIndex += 1;
    this.currentUrl = this.history[this.historyIndex];
    return new FakeResponse(this.currentUrl, 200, "ok");
  }

  async waitForSelector() {}
  on(name, listener) { assert.equal(name, "request"); this.listeners.add(listener); }
  off(name, listener) { assert.equal(name, "request"); this.listeners.delete(listener); }
  async close() {}
}

function fakeCapture(url, label, index) {
  const artifact = (kind, digest) => ({ path: `/tmp/${label}-${index}-${kind}.png`, sha256: hash(digest) });
  return {
    schema: "wikijump_local_lab.standing_browser_parity_capture.v2",
    input_url: url,
    final_url: url,
    navigation_status: 200,
    failures: [],
    request_gate_aborts: [],
    first_paint: { document: { phase: "domcontentloaded_immediate_observation" }, screenshot: artifact("initial", "a") },
    document: { phase: "settled" },
    settled_viewport_screenshot: artifact("settled", "b"),
    screenshot: artifact("full", "c"),
  };
}

function fakeBrowserOwner(calls, state) {
  return {
    setActiveFixture(fixtureId) { calls.push({ kind: "fixture", fixtureId }); },
    async newCandidateContext({ storageState }) {
      const authenticated = storageState?.cookies?.some(({ name }) => name === "wikijump_token") === true;
      const context = {
        async newPage() { return new FakePage({ authenticated, state }); },
        request: {
          async post(url) { return new FakeResponse(url, 403, "cross-site origin rejected", "POST"); },
        },
      };
      return { context, environment: { browser: "fake" } };
    },
    async captureCandidateObservation({ page, url, label, index, navigate }) {
      if (navigate) await navigate({ page, url, timeoutMs: 300_000 });
      return fakeCapture(url, label, index);
    },
    async close() { return { browser_context_count: 3, browser_environments: [], request_gate: null }; },
  };
}

test("candidate registry executes the unblocked #1063 source, diff, and settings rows", async (t) => {
  const caseSet = await candidateCaseSet("open43-authoring-history");
  assert.equal(caseSet.id, "open43-authoring-history");
  assert.deepEqual(caseSet.caseIds, [
    "A1063_EXACT_PUBLIC_SOURCE_CANDIDATE",
    "A1063_DIFF_BROWSER_WORKFLOW",
    "A1063_SETTINGS_BROWSER_WORKFLOW",
  ]);
  assert.equal(typeof caseSet.prepareRun, "function");

  const calls = [];
  const state = {
    pages: new Map(),
    locales: ["en-US"],
    deferNextSettingsReloadSettlement: true,
    settingsWaitCalls: 0,
  };
  const outputRoot = await fs.mkdtemp(path.join(os.tmpdir(), "open43-history-case-"));
  t.after(() => fs.rm(outputRoot, { recursive: true, force: true }));
  const outputDir = path.join(outputRoot, "evidence");
  await runCandidateCaseSet({
    candidateIdentity: candidateIdentity(),
    candidateIdentitySha256: sha256Value(candidateIdentity()),
    privateInput: { secret: "test-only" },
    privateInputSha256: hash("9"),
    outputDir,
    caseSet: createOpen43AuthoringHistoryCandidateCaseSet({ sessionFactory: () => fakeSession(calls, state) }),
    runId: "candidate-run-0123456789ab",
    dependencies: {
      collectExecutionIdentity: async () => ({ schema: "fixture.execution_identity.v1" }),
      observeRuntimeIdentity: async () => ({ schema: "fixture.runtime_identity.v1", stable: true }),
      assertStableRuntimeIdentity: () => {},
      createBrowserContexts: async () => fakeBrowserOwner(calls, state),
      now: () => "2026-08-15T00:00:00.000Z",
    },
  });
  const aggregate = JSON.parse(await fs.readFile(path.join(outputDir, "candidate-case-receipt.json"), "utf8"));
  assert.equal(aggregate.denominator.count, 3);
  assert.deepEqual(aggregate.denominator.case_ids, caseSet.caseIds);
  for (const excluded of ["A1063_LEGACY_AUTHORING_PRESENTATION", "A1063_FULL_BREADCRUMB_LIVE_BOUNDARY"]) assert.equal(aggregate.denominator.case_ids.includes(excluded), false);
  assert.equal(calls.filter((call) => call.kind === "rpc" && call.method === "page_edit").length, 2);
  assert.equal(calls.some((call) => call.kind === "rpc" && call.method === "page_revision_diff"), true);
  assert.deepEqual(calls.filter((call) => call.kind === "ajax").map((call) => call.fields.moduleName), [
    "history/PageRevisionListModule",
    "history/PageSourceModule",
    "history/PageVersionModule",
  ]);
  assert.deepEqual(calls.filter((call) => call.kind === "fixture").map(({ fixtureId }) => fixtureId), [
    "A1063_DIFF_BROWSER_WORKFLOW",
    "A1063_SETTINGS_BROWSER_WORKFLOW",
  ]);
  assert.equal(calls.some((call) => call.kind === "rpc" && call.method === "user_edit" && call.params.user === -1 && call.params.locales[0] === "en-US"), true);
  assert.equal(state.settingsWaitCalls, 1);
  assert.equal(calls.some((call) => call.kind === "rpc" && call.method === "page_delete"), true);
  assert.equal(state.pages.size, 0);
  assert.deepEqual(state.locales, ["en-US"]);
});

test("#1063 audit retires the stale standard-layout breadcrumb candidate without weakening ancestry authority", async () => {
  const audit = JSON.parse(await fs.readFile(new URL("../../../../docs/development/open43-a-authoring-closure-audit.json", import.meta.url), "utf8"));
  const issue = audit.issues.find((row) => row.issue === 1063);
  assert.ok(issue);
  assert.deepEqual(issue.candidate_required.map(({case_id}) => case_id), [
    "A1063_EXACT_PUBLIC_SOURCE_CANDIDATE",
    "A1063_DIFF_BROWSER_WORKFLOW",
    "A1063_SETTINGS_BROWSER_WORKFLOW",
  ]);
  assert.deepEqual(issue.superseded_acceptance, [{
    case_id: "A1063_BREADCRUMB_SERVED_CANDIDATE",
    status: "superseded_by_current_live_evidence",
    source_merge: "eb1c7876400abcd01d4e2d5ec670fe157186acb9",
    evidence_id: "AUTHORING_PARENT_STANDARD_LAYOUT_LIVE_20260908",
    result: issue.superseded_acceptance[0].result,
    boundary: issue.superseded_acceptance[0].boundary,
  }]);
  assert.match(issue.superseded_acceptance[0].result, /do not synthesize #breadcrumbs/u);
  assert.match(issue.superseded_acceptance[0].boundary, /Deepwell ancestry remains valid/u);
  const customLayout = issue.source_ready.find(({case_id}) => case_id === "A1063_FULL_BREADCRUMB_LIVE_BOUNDARY");
  assert.equal(customLayout.status, "owner_scope_boundary");
  assert.match(customLayout.result, /Pro custom-layout \[\[breadcrumbs\]\]/u);
  assert.deepEqual(customLayout.not_claimed, [
    "Pro custom-layout [[breadcrumbs]] DOM",
    "custom-layout relation-boundary presentation",
  ]);

  const evidence = audit.evidence.find(({evidence_id}) => evidence_id === "AUTHORING_PARENT_STANDARD_LAYOUT_LIVE_20260908");
  assert.deepEqual(evidence, {
    evidence_id: "AUTHORING_PARENT_STANDARD_LAYOUT_LIVE_20260908",
    authority: evidence.authority,
    path: "install/local/wikidot-verification/artifacts/issue1063-parent-breadcrumb-live-20260908.json",
    sha256: "5c68a8df37651e4fc0753860ca2aac2e6a8abac637665a1ff7fd8253852ae444",
    source_revision: "e7678a6c1d03171d3f884ad63b8bcd29bcec8bad",
  });
  const artifactBytes = await fs.readFile(new URL("../artifacts/issue1063-parent-breadcrumb-live-20260908.json", import.meta.url));
  assert.equal(createHash("sha256").update(artifactBytes).digest("hex"), evidence.sha256);
  assert.equal(audit.candidate_harness_gap.superseded_row.case_id, "A1063_BREADCRUMB_SERVED_CANDIDATE");
  assert.equal(audit.browser_commands.some(({case_ids}) => case_ids.includes("A1063_BREADCRUMB_SERVED_CANDIDATE")), false);
});

test("#1063 retained breadcrumb evidence verifies the standard-layout boundary and cleanup", async () => {
  const artifact = JSON.parse(await fs.readFile(new URL("../artifacts/issue1063-parent-breadcrumb-live-20260908.json", import.meta.url), "utf8"));
  assert.equal(artifact.schema, "wikijump.issue1063_parent_breadcrumb_live.v1");
  assert.deepEqual(artifact.cases.map(({case_id}) => case_id), [
    "issue1063-parent-chain-standard-layout-no-breadcrumbs",
    "issue1063-renamed-parent-standard-layout-no-breadcrumbs",
    "issue1063-no-parent-standard-layout-control",
    "issue1063-deleted-parent-standard-layout-control",
    "issue1063-cycle-standard-layout-control",
    "issue1063-independent-standard-layout-control",
    "issue1063-current-parented-documentation-page-no-breadcrumbs",
  ]);
  const cases = new Map(artifact.cases.map((row) => [row.case_id, row]));
  for (const caseId of [
    "issue1063-parent-chain-standard-layout-no-breadcrumbs",
    "issue1063-renamed-parent-standard-layout-no-breadcrumbs",
  ]) {
    assert.equal(cases.get(caseId).http_status, 200);
    assert.equal(cases.get(caseId).parent_mutations_succeeded, true);
    assert.equal(cases.get(caseId).breadcrumbs_present, false);
  }
  for (const caseId of [
    "issue1063-no-parent-standard-layout-control",
    "issue1063-deleted-parent-standard-layout-control",
    "issue1063-cycle-standard-layout-control",
    "issue1063-independent-standard-layout-control",
    "issue1063-current-parented-documentation-page-no-breadcrumbs",
  ]) {
    assert.equal(cases.get(caseId).http_status, 200);
    assert.equal(cases.get(caseId).breadcrumbs_present, false);
  }
  assert.equal(cases.get("issue1063-cycle-standard-layout-control").cycle_mutation_accepted, true);
  assert.deepEqual(artifact.cleanup, {
    sandbox_run_owned_pages_remaining: [],
    sandbox_cleanup_verified: true,
    credentials_persisted: false,
  });
  assert.deepEqual(artifact.scope, {
    standard_saved_page_layout: "observed",
    parent_relation_persistence: "preserved",
    custom_layout_breadcrumbs: "not_observed_do_not_infer",
  });
});
