import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { candidateCaseSet } from "../src/candidate-case-command.mjs";
import { runCandidateCaseSet } from "../src/candidate-case-runner.mjs";
import { createOpen43Q1027CandidateCaseSet } from "../src/open43-q1027-candidate-case-set.mjs";
import { sha256Value } from "../src/standing-browser-parity-util.mjs";

const CASE_ID = "Q1027_RENAME_DELETE_RESTORE_CACHE_AND_SERVED_CANDIDATE";
const PAGE_ORIGIN = "https://scpaiueouiuiuiui.wikijump.localhost:18443";
const mixedHex = (character, length) => (character + "0123456789abcdef".replace(character, "")[0]).repeat(length / 2);
const hash = (character) => mixedHex(character, 64);
const git = (character) => mixedHex(character, 40);
const RUN_ID = "candidate-run-0123456789ab";
const EMPTY_BOX = "\n<div class=\"backlinks-module-box\">\n</div>\n";
const INLINE_LITERAL = "\nstart-[[module Backlinks]]-middle\n";

function populatedBoxHtml(rows) {
  const items = rows.map(({ slug, title }) => `\t\t\t\t\t\t\t<li>\n\t\t\t\t\t<a href="/${slug}">${title}</a>\n\t\t\t\t</li>`).join("\n");
  return `<div class="backlinks-module-box">\n\t\t\t<ul>\n${items}\n\t\t\t\t\t</ul>\n\t</div>`;
}

function candidateIdentity() {
  return {
    schema: "wikijump.standing_candidate_parity_identity.v1",
    status: "sealed",
    artifact_key: hash("a"),
    build: { seal_sha256: hash("b"), verdict_sha256: hash("c"), final_images_sha256: hash("d") },
    candidate: {
      owner: "open43-q1027-fixture",
      expires_at: "2099-08-10T00:00:00.000Z",
      compose_project: "wikijump-open43-q1027-fixture",
      port_443_published: false,
      wikijump_commit: git("1"),
      wikijump_tree: git("2"),
      ftml_sha: git("3"),
      profile: "production-build",
      source_clean: true,
      images: { caddy: `sha256:${hash("4")}`, deepwell: `sha256:${hash("5")}`, files: `sha256:${hash("6")}` },
      config: { isolated_overlay_sha256: hash("7"), promotion_base_manifest_sha256: hash("8"), effective_runtime_services_sha256: hash("9") },
      endpoint: {
        scheme: "https",
        host: "scpaiueouiuiuiui.wikijump.localhost",
        port: 18443,
        resolved_addresses: ["127.0.0.1"],
        allowed_origin_set: [PAGE_ORIGIN, "https://scpaiueouiuiuiui.wjfiles.localhost:18443"],
        local_connect_address: "127.0.0.1",
      },
    },
    evidence: { status: "sealed", manifest_sha256: hash("a"), seal_sha256: hash("b") },
  };
}

function fakeCandidateSession() {
  const state = { pages: new Map(), events: [], nextPageId: 10, nextRevisionId: 20 };
  const bySlug = (slug) => [...state.pages.values()].find((page) => page.slug === slug) ?? null;
  const target = () => [...state.pages.values()].find((page) => page.slug.endsWith("-target"));
  const visibleRows = () => [...state.pages.values()]
    .filter((page) => !page.deleted && /-(linker-a|linker-b)$/u.test(page.slug) && page.wikitext.includes(`[[[${target().slug}]]]`))
    .sort((left, right) => left.title.localeCompare(right.title))
    .map(({ slug, title }) => ({ slug, title }));
  const viewBody = (slug) => {
    if (slug.endsWith("-control")) return `<p>Q1027_CONTROL_START</p>${EMPTY_BOX}<p>Q1027_CONTROL_END</p>`;
    const rows = visibleRows();
    const box = rows.length === 0 ? EMPTY_BOX : `\n${populatedBoxHtml(rows)}`;
    return `<p>Q1027_DEFAULT_START</p>${box}<p>Q1027_DEFAULT_END</p><p>Q1027_PAGE_ARG_START</p>${box}<p>Q1027_PAGE_ARG_END</p><p>Q1027_INLINE_START</p>${INLINE_LITERAL}<p>Q1027_INLINE_END</p>`;
  };
  const session = {
    editorUserId: 10,
    editorSessionToken: "editor-session-token",
    pageOrigin: PAGE_ORIGIN,
    privateInputIdentity: { actor_user_id: 10 },
    requiredServiceBindings: [],
    get events() { return structuredClone(state.events); },
    async rpc(method, params = {}, { actor = "editor" } = {}) {
      state.events.push({ service: "deepwell", operation: method, method: "POST", response_status: 200, actor });
      if (method === "site_get") return { site_id: 7 };
      if (method === "page_get") {
        const page = bySlug(params.page);
        if (!page || page.deleted) return null;
        return { ...structuredClone(page), ...(params.details?.compiled ? { compiled_body_html: page.wikitext } : {}) };
      }
      if (method === "page_create") {
        const page = { page_id: ++state.nextPageId, revision_id: ++state.nextRevisionId, slug: params.slug, title: params.title, wikitext: params.wikitext, deleted: false };
        state.pages.set(page.slug, page);
        return structuredClone(page);
      }
      if (method === "page_view") {
        assert.deepEqual(params.route, { slug: params.route.slug, extra: "" });
        return { type: "found", data: { compiled_body_html: viewBody(params.route.slug) } };
      }
      if (method === "page_edit_lock_acquire") {
        const page = bySlug(params.page);
        return { grant: { lock_id: 4242, ["lock_secret"]: "fake-lease-secret", base_revision_id: page?.revision_id ?? null, expires_at: "2999-01-01T00:00:00Z" }, conflicts: [] };
      }
      if (method === "page_edit_lock_release") return true;
      if (method === "page_edit") {
        const page = bySlug(params.page);
        if (params.wikitext !== undefined) assert.ok(params.lease, "page_edit with wikitext must present an edit lease");
        if (params.title !== undefined) page.title = params.title;
        if (params.wikitext !== undefined) page.wikitext = params.wikitext;
        page.revision_id = ++state.nextRevisionId;
        return { revision_id: page.revision_id };
      }
      if (method === "page_delete") {
        const page = Number.isSafeInteger(params.page) ? [...state.pages.values()].find((value) => value.page_id === params.page) : bySlug(params.page);
        page.deleted = true;
        page.revision_id = ++state.nextRevisionId;
        return { page_id: page.page_id, revision_id: page.revision_id };
      }
      if (method === "page_restore") {
        const page = [...state.pages.values()].find((value) => value.page_id === params.page_id);
        page.deleted = false;
        page.revision_id = ++state.nextRevisionId;
        return { page_id: page.page_id, revision_id: page.revision_id, slug: page.slug };
      }
      throw new Error(`unexpected RPC ${method}`);
    },
    async pageRequest(slug) {
      const page = bySlug(slug);
      if (!page || page.deleted) return { status: 404, body_base64: "" };
      const rows = visibleRows();
      const box = rows.length === 0 ? "" : populatedBoxHtml(rows);
      return { status: 200, body_base64: Buffer.from(`<div id="page-content"><p>Q1027_DEFAULT_START</p>\n${box}<p>Q1027_DEFAULT_END</p></div>`).toString("base64") };
    },
  };
  return { session, state };
}

function fakeBrowserContexts(state) {
  return {
    async newCandidateContext() {
      const page = {
        on() {},
        off() {},
        async evaluate() {
          const rows = [...state.pages.values()]
            .filter((value) => !value.deleted && /-(linker-a|linker-b)$/u.test(value.slug) && value.wikitext.includes(`[[[${[...state.pages.values()].find((value) => value.slug.endsWith("-target")).slug}]]]`))
            .sort((left, right) => left.title.localeCompare(right.title))
            .map(({ slug, title }) => ({ slug, title }));
          const box = populatedBoxHtml(rows);
          return {
            url: PAGE_ORIGIN,
            default_box: box,
            page_arg_box: box,
            default_box_count: 1,
            page_arg_box_count: 1,
            total_box_count: 2,
            compat_markers: [],
          };
        },
        async close() {},
      };
      return { context: { async newPage() { return page; } }, environment: {} };
    },
    async captureCandidateObservation({ url }) {
      return { navigation_status: 200, input_url: url, final_url: url, failures: [] };
    },
    async close() { return { browser_context_count: 1 }; },
  };
}

test("Q1027 runs the rename-delete-restore candidate through the canonical runner", async (t) => {
  const selected = await candidateCaseSet("open43-q1027");
  assert.deepEqual(selected.caseIds, [CASE_ID]);
  const { session, state } = fakeCandidateSession();
  const caseSet = createOpen43Q1027CandidateCaseSet({ sessionFactory: () => session });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "open43-q1027-candidate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const identity = candidateIdentity();
  const receipt = await runCandidateCaseSet({
    candidateIdentity: identity,
    candidateIdentitySha256: sha256Value(identity),
    privateInput: {},
    privateInputSha256: hash("e"),
    outputDir: path.join(root, "evidence"),
    caseSet,
    runId: RUN_ID,
    dependencies: {
      createBrowserContexts: async () => fakeBrowserContexts(state),
      collectExecutionIdentity: async () => ({ schema: "fixture.execution_identity.v1", source_clean: true, module_manifest_sha256: hash("f") }),
      observeRuntimeIdentity: async () => ({ schema: "fixture.runtime_observation.v1", identity: "stable" }),
      assertStableRuntimeIdentity(before, after) { assert.deepEqual(after, before); },
      now: () => "2026-08-15T00:00:00.000Z",
    },
  });
  assert.equal(receipt.status, "pass");
  assert.equal(receipt.cases[0].case_id, CASE_ID);
  const caseReceipt = JSON.parse(await fs.readFile(path.join(root, "evidence", "cases", `${CASE_ID}.json`), "utf8"));
  for (const flag of ["exact_served_dom", "multiple_modules_identical", "inline_literal_boundary", "link_edit_next_read", "rename_delete_restore_next_read", "cache_isolation_control", "actors_identical", "internal_identifiers_absent"]) {
    assert.equal(caseReceipt.verification[flag], true, flag);
  }
  assert.equal([...state.pages.values()].every((page) => page.deleted), true);
  assert.equal(state.events.filter((event) => event.operation === "page_view").length >= 7, true);
  assert.equal(receipt.resources.every((resource) => resource.released), true);
});

test("Q1027 verification rejects a served DOM drift", () => {
  const { session } = fakeCandidateSession();
  const run = createOpen43Q1027CandidateCaseSet({ sessionFactory: () => session }).prepareRun({
    runId: RUN_ID,
    candidateIdentity: candidateIdentity(),
    privateInput: {},
    signal: null,
    resources: {},
    candidateBrowserContexts: {},
  });
  const url = `https://scpaiueouiuiuiui.wikijump.localhost:18443/open43-q1027-${RUN_ID.slice("candidate-case-".length)}-target`;
  assert.throws(() => run.verifyCase(CASE_ID, {
    url,
    capture: { navigation_status: 200, input_url: url, final_url: url, failures: [] },
    served: { default_box: '<div class="backlinks-module-box"><div class="drifted"/></div>', page_arg_box: null, default_box_count: 1, page_arg_box_count: 0, compat_markers: [] },
    lifecycle: {},
  }), /exact Backlinks boxes/u);
});
