import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { candidateCaseSet } from "../src/candidate-case-command.mjs";
import { runCandidateCaseSet } from "../src/candidate-case-runner.mjs";
import { createOpen43AuthoringCandidateCaseSet } from "../src/open43-authoring-candidate-case-set.mjs";

const PAGE_ORIGIN = "https://scpaiueouiuiuiui.wikijump.localhost:18443";
const CAPTURE_SCHEMA = "wikijump_local_lab.standing_browser_parity_capture.v2";
const RED = "rgb(255, 0, 0)";
const BLUE = "rgb(0, 0, 255)";
const hash = (character) => (character + "0123456789abcdef".replace(character, "")[0]).repeat(32);
const git = (character) => (character + "0123456789abcdef".replace(character, "")[0]).repeat(20);

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
      owner: "open43-authoring-fixture",
      expires_at: "2099-08-20T00:00:00.000Z",
      compose_project: "wikijump-open43-authoring-fixture",
      port_443_published: false,
      wikijump_commit: git("1"),
      wikijump_tree: git("2"),
      ftml_sha: git("3"),
      profile: "production-build",
      source_clean: true,
      images: { deepwell: `sha256:${hash("4")}` },
      config: {
        isolated_overlay_sha256: hash("5"),
        promotion_base_manifest_sha256: hash("6"),
        effective_runtime_services_sha256: hash("7"),
      },
      endpoint: {
        scheme: "https",
        host: "scpaiueouiuiuiui.wikijump.localhost",
        port: 18443,
        resolved_addresses: ["127.0.0.1"],
        allowed_origin_set: [
          PAGE_ORIGIN,
          "https://scpaiueouiuiuiui.wjfiles.localhost:18443",
        ],
        local_connect_address: "127.0.0.1",
      },
    },
    evidence: {
      status: "sealed",
      manifest_sha256: hash("8"),
      seal_sha256: hash("9"),
    },
  };
}

class FakePublicSession {
  constructor({ staleDependentPageGet = false } = {}) {
    this.staleDependentPageGet = staleDependentPageGet;
  }

  editorUserId = -1;
  pageOrigin = PAGE_ORIGIN;
  requiredServiceBindings = [{
    role: "deepwell",
    container_port: "2747/tcp",
    host_address: "127.0.0.1",
    host_port: 32747,
  }];
  privateInputIdentity = { editor_session_sha256: hash("0") };
  events = [];
  pages = new Map();
  nextPageId = 100;
  nextRevisionId = 200;

  async rpc(method, params, options = {}) {
    this.events.push({ method, params: structuredClone(params), options: structuredClone(options) });
    if (method === "site_get") return { site_id: 77, slug: "scpaiueouiuiuiui" };
    if (method === "page_get") {
      const page = [...this.pages.values()].find((candidate) =>
        candidate.page_id === params.page || candidate.slug === params.page,
      ) ?? null;
      if (page === null) return null;
      const result = structuredClone(page);
      if (this.staleDependentPageGet && result.slug.includes("dependent") && params.details?.compiled_html) {
        result.compiled_body_styles = [".authoring-color { color: red; }"];
        result.compiled_at = 1;
      }
      return result;
    }
    if (method === "page_create") {
      const page = {
        page_id: this.nextPageId++,
        revision_id: this.nextRevisionId++,
        revision_number: 0,
        slug: params.slug,
        title: params.title,
        wikitext: params.wikitext,
        compiled_body_styles: params.slug.includes("dependent")
          ? [".authoring-color { color: red; }"]
          : [],
        compiled_at: 1,
      };
      this.pages.set(page.page_id, page);
      return structuredClone(page);
    }
    if (method === "page_edit_lock_acquire") {
      const page = this.pages.get(params.page);
      assert.ok(page, "page_edit_lock_acquire must target an existing page");
      return { grant: { lock_id: 4242, ["lock_secret"]: "fake-lease-secret", base_revision_id: page.revision_id, expires_at: "2999-01-01T00:00:00Z" }, conflicts: [] };
    }
    if (method === "page_edit_lock_release") return true;
    if (method === "page_edit") {
      const page = this.pages.get(params.page);
      assert.ok(page, "page_edit must target an existing page");
      assert.ok(params.lease, "page_edit must present an edit lease");
      page.revision_id = this.nextRevisionId++;
      page.revision_number += 1;
      page.wikitext = params.wikitext;
      if (page.slug.startsWith("component:")) {
        for (const dependent of this.pages.values()) {
          if (dependent.slug.includes("dependent")) {
            dependent.compiled_body_styles = [".authoring-color { color: blue; }"];
            dependent.compiled_at = 2;
          }
        }
      }
      return structuredClone(page);
    }
    if (method === "article_view") {
      const page = [...this.pages.values()].find((candidate) =>
        candidate.slug === params.route.slug,
      );
      return page === undefined
        ? { page: null }
        : { page: { type: "found", data: structuredClone(page) } };
    }
    if (method === "page_delete") {
      this.pages.delete(params.page);
      return { page_id: params.page };
    }
    throw new Error(`unexpected public RPC method: ${method}`);
  }
}

function fakeBrowserOwner(colors = [RED, BLUE, BLUE]) {
  const events = [];
  let colorIndex = 0;
  let currentUrl = PAGE_ORIGIN;
  const page = {
    on() {},
    off() {},
    url: () => currentUrl,
    async goto(url) {
      currentUrl = url;
      events.push("goto");
      return { status: () => 200 };
    },
    async reload() {
      events.push("reload");
      return { status: () => 200 };
    },
    async evaluate(callback) {
      if (String(callback).includes("window.stop")) {
        events.push("stop-pre-edit-load");
        return null;
      }
      const color = colors[Math.min(colorIndex, colors.length - 1)];
      colorIndex += 1;
      return {
        element_count: 1,
        computed_color: color,
        style_texts: [`.authoring-color { color: ${color === RED ? "red" : "blue"}; }`],
      };
    },
    async close() {
      events.push("page-close");
    },
  };
  return {
    events,
    setActiveFixture(fixtureId) {
      events.push(`fixture:${fixtureId}`);
    },
    async newCandidateContext() {
      events.push("context");
      return {
        context: { async newPage() { return page; } },
        environment: { fixture: "authoring" },
      };
    },
    async captureCandidateObservation({ page: capturedPage, url, navigate }) {
      const response = await navigate({ page: capturedPage, url, timeoutMs: 300_000 });
      return {
        schema: CAPTURE_SCHEMA,
        input_url: url,
        final_url: capturedPage.url(),
        navigation_status: response.status(),
        failures: [],
        request_gate_aborts: [],
        first_paint: {
          document: { phase: "domcontentloaded_immediate_observation" },
          screenshot: { path: "authoring-initial.png", sha256: hash("a") },
        },
        document: {
          phase: "settled",
          resource_completion: { status: "complete" },
        },
        settled_viewport_screenshot: { path: "authoring-settled.png", sha256: hash("b") },
        screenshot: { path: "authoring-full.png", sha256: hash("c") },
      };
    },
    async close() {
      events.push("browser-close");
      return { browser_context_count: 1 };
    },
  };
}

function candidateDependencies(browser) {
  return {
    createBrowserContexts: async () => browser,
    collectExecutionIdentity: async () => ({ schema: "fixture.execution_identity.v1" }),
    observeRuntimeIdentity: async () => ({ schema: "fixture.runtime_identity.v1", value: "stable" }),
    assertStableRuntimeIdentity(before, after) {
      assert.deepEqual(before, after);
    },
    now: () => "2026-08-20T00:00:00.000Z",
  };
}

test("authoring candidate executes the public component CSS slice before passing", async (t) => {
  const session = new FakePublicSession();
  const browser = fakeBrowserOwner();
  const registeredCaseSet = await candidateCaseSet("open43-authoring");
  const caseSet = createOpen43AuthoringCandidateCaseSet({ sessionFactory: () => session });
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "open43-authoring-case-"));
  const outputDir = path.join(tempRoot, "evidence");
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  const result = await runCandidateCaseSet({
    candidateIdentity: candidateIdentity(),
    candidateIdentitySha256: hash("a"),
    privateInput: {},
    privateInputSha256: hash("b"),
    outputDir,
    caseSet,
    runId: "candidate-run-0123456789ab",
    dependencies: candidateDependencies(browser),
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(registeredCaseSet.caseIds, [
    "A1061_EXACT_PUBLIC_SLICE_CANDIDATE",
    "A1061_EXACT_POST_COMMIT_WORKER_CANDIDATE",
    "A1061_FIRST_RELOAD_INTERVALS",
  ]);
  assert.deepEqual(caseSet.caseIds, registeredCaseSet.caseIds);
  assert.equal(result.cases.length, 3);
  assert.deepEqual(
    session.events.filter(({ method }) => method === "page_edit").map(({ params }) => params.page),
    [100],
  );
  assert.ok(session.events.some(({ method }) => method === "article_view"));
  assert.deepEqual(browser.events.slice(0, 5), [
    "fixture:A1061_FIRST_RELOAD_INTERVALS",
    "context",
    "goto",
    "stop-pre-edit-load",
    "reload",
  ]);
  assert.equal(browser.events.filter((event) => event === "reload").length, 1);
  assert.ok(browser.events.includes("browser-close"));
  assert.deepEqual(
    session.events.filter(({ method }) => method === "page_delete").map(({ params }) => params.page),
    [102, 101, 100],
  );
});

test("authoring candidate rejects CSS that remains stale on the first normal reload", async (t) => {
  const session = new FakePublicSession();
  const browser = fakeBrowserOwner([RED, RED, BLUE]);
  const caseSet = createOpen43AuthoringCandidateCaseSet({ sessionFactory: () => session });
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "open43-authoring-stale-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  await assert.rejects(
    runCandidateCaseSet({
      candidateIdentity: candidateIdentity(),
      candidateIdentitySha256: hash("a"),
      privateInput: {},
      privateInputSha256: hash("b"),
      outputDir: path.join(tempRoot, "evidence"),
      caseSet,
      runId: "candidate-run-0123456789ab",
      dependencies: candidateDependencies(browser),
    }),
    /first normal reload style did not expose the exact computed color/u,
  );
  assert.equal(session.pages.size, 0);
  assert.equal(browser.events.filter((event) => event === "reload").length, 1);
});

test("authoring candidate rejects a stale dependent page payload even when the article read is blue", async (t) => {
  const session = new FakePublicSession({ staleDependentPageGet: true });
  const browser = fakeBrowserOwner();
  const caseSet = createOpen43AuthoringCandidateCaseSet({ sessionFactory: () => session });
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "open43-authoring-page-stale-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));

  await assert.rejects(
    runCandidateCaseSet({
      candidateIdentity: candidateIdentity(),
      candidateIdentitySha256: hash("a"),
      privateInput: {},
      privateInputSha256: hash("b"),
      outputDir: path.join(tempRoot, "evidence"),
      caseSet,
      runId: "candidate-run-0123456789ab",
      dependencies: candidateDependencies(browser),
    }),
    /dependent page after component save did not expose only blue CSS/u,
  );
  assert.equal(session.pages.size, 0);
});
