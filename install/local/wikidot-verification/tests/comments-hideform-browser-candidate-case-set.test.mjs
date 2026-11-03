import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { candidateCaseSet } from "../src/candidate-case-command.mjs";
import { createCommentsHideformBrowserCandidateCaseSet } from "../src/comments-hideform-browser-candidate-case-set.mjs";
import { runCandidateCaseSet } from "../src/candidate-case-runner.mjs";
import { sha256Value } from "../src/standing-browser-parity-util.mjs";

const hash = (letter) => (letter + "0123456789abcdef".replace(letter, "")[0]).repeat(32);
const git = (letter) => (letter + "0123456789abcdef".replace(letter, "")[0]).repeat(20);
const identity = {
  schema: "wikijump.standing_candidate_parity_identity.v1",
  status: "sealed",
  artifact_key: hash("a"),
  build: { seal_sha256: hash("b"), verdict_sha256: hash("c"), final_images_sha256: hash("d") },
  candidate: {
    owner: "comments-hideform-fixture",
    expires_at: "2099-08-10T00:00:00.000Z",
    compose_project: "comments-hideform-fixture",
    port_443_published: false,
    wikijump_commit: git("1"),
    wikijump_tree: git("2"),
    ftml_sha: git("3"),
    profile: "production-build",
    source_clean: true,
    images: { caddy: `sha256:${hash("e")}` },
    config: { isolated_overlay_sha256: hash("f"), promotion_base_manifest_sha256: hash("0"), effective_runtime_services_sha256: hash("4") },
    endpoint: { scheme: "https", host: "scpaiueouiuiuiui.wikijump.localhost", port: 18443, resolved_addresses: ["127.0.0.1"], allowed_origin_set: ["https://scpaiueouiuiuiui.wikijump.localhost:18443", "https://scpaiueouiuiuiui.wjfiles.localhost:18443"], local_connect_address: "127.0.0.1" },
  },
  evidence: { status: "sealed", manifest_sha256: hash("5"), seal_sha256: hash("6") },
};

const privateInput = {
  actors: {
    administrator: { user_id: 41, session_token: "administrator-secret" },
    non_admin: { user_id: 42, session_token: "non-admin-secret" },
    expired: { user_id: 43, session_token: "expired-secret" },
  },
  fixture: { site_id: 6_000_003, cross_site_sentinel_id: 9_000_000_043, default_category: { category_id: 100_000_015, slug: "_default", page_id: 70, page_slug: "boundary-check" }, transition_category: { category_id: 100_000_016, slug: "corpus", page_id: 71, page_slug: "corpus:scp-9506-draft" } },
  deepwell_rpc_url: "http://127.0.0.1:22747/jsonrpc",
  deepwell_rpc_token: "r".repeat(64),
  tls_ca_pem: "private-ca",
};

function fakeSession({ events }) {
  const privateInputIdentity = { administrator_user_id: 41, administrator_session_sha256: hash("a"), non_admin_user_id: 42, non_admin_session_sha256: hash("b"), fixture_identity_sha256: hash("c") };
  const pages = new Map();
  let nextPageId = 900;
  let currentSource = "[[module Comments]]";
  let category = { category_id: 100_000_023, slug: "run-owned", per_page_discussion: null, settings_revision: 0 };
  return {
    candidateIdentity: identity,
    pageOrigin: "https://scpaiueouiuiuiui.wikijump.localhost:18443",
    fixtureIdentity: { site_id: 6_000_003 },
    requiredServiceBindings: [{ role: "deepwell", container_port: "2747/tcp", host_address: "127.0.0.1", host_port: 22747 }],
    privateInputIdentity,
    get currentSource() { return currentSource; },
    storageState(actor) { return { actor }; },
    async verifyActorSessions() { events.push("session-verify"); return { administrator_user_id: 41, non_admin_user_id: 42, expired_session: null }; },
    async rpc(method, params, { actor = "administrator", cleanup = false } = {}) {
      events.push(`${cleanup ? "cleanup-" : ""}${method}:${actor}`);
      if (method === "site_get") return { site_id: 6_000_003 };
      if (method === "page_get") return pages.get(params.page) ?? null;
      if (method === "page_create") {
        const page = { page_id: nextPageId++, revision_id: 1, slug: params.slug, title: params.title, wikitext: params.wikitext };
        pages.set(page.slug, page);
        return page;
      }
      if (method === "page_edit_lock_acquire") {
        const page = pages.get(params.page);
        return { grant: { lock_id: 4242, ["lock_secret"]: "fake-lease-secret", base_revision_id: page?.revision_id ?? null, expires_at: "2999-01-01T00:00:00Z" }, conflicts: [] };
      }
      if (method === "page_edit_lock_release") return true;
      if (method === "page_edit") {
        const page = pages.get("run-owned:comments-hideform-0123456789ab");
        assert.ok(params.lease, "page_edit must present an edit lease");
        page.revision_id += 1;
        page.wikitext = params.wikitext;
        currentSource = params.wikitext;
        return page;
      }
      if (method === "category_get") return { ...category };
      if (method === "category_update") {
        assert.equal(params.expected_settings_revision, category.settings_revision);
        category = { ...category, per_page_discussion: params.per_page_discussion, settings_revision: category.settings_revision + 1 };
        return { ...category };
      }
      if (method === "wikidot_page_discussion_create") {
        assert.equal(category.per_page_discussion, true);
        return { thread_id: 700, thread_unix_title: "candidate-comments" };
      }
      if (method === "page_delete") {
        pages.delete("run-owned:comments-hideform-0123456789ab");
        return null;
      }
      throw new Error(`unexpected method ${method}`);
    },
  };
}

function fakeCapture({ actor, source, index }) {
  const open = actor === "administrator" && ["hideform-omitted", "hideform-false"].includes(source.case_id);
  const document = (phase) => ({ phase, ready_state: phase === "settled" ? "complete" : "interactive", dom_signature: hash(String(index)), resource_completion: phase === "settled" ? { status: "complete" } : undefined, presence_probes: [{ id: "comments-box", count: 1, rendered_count: 1 }, { id: "new-post-form", count: open ? 1 : 0, rendered_count: open ? 1 : 0 }, { id: "new-post-button", count: 1, rendered_count: open ? 0 : 1 }, { id: "thread-container", count: 1, rendered_count: 1 }] });
  return { input_url: "https://scpaiueouiuiuiui.wikijump.localhost:18443/run-owned%3Acomments-hideform-0123456789ab", final_url: "https://scpaiueouiuiuiui.wikijump.localhost:18443/run-owned%3Acomments-hideform-0123456789ab", navigation_status: 200, failures: [], request_gate_aborts: [], first_paint: { document: document("domcontentloaded_immediate_observation"), screenshot: { path: `first-${index}.png`, sha256: hash("d") } }, document: document("settled"), settled_viewport_screenshot: { path: `settled-${index}.png`, sha256: hash("e") }, screenshot: { path: `full-${index}.png`, sha256: hash("f") } };
}

test("Comments hideForm is registered as one executable candidate case with both actor controls", async (t) => {
  assert.equal((await candidateCaseSet("comments-hideform-browser")).id, "comments-hideform-browser");
  const events = [];
  const session = fakeSession({ events });
  const sourceCaseIds = ["hideform-omitted", "hideform-false", "hideform-true", "hideform-yes"];
  const browserContexts = {
    setActiveFixture(id) { events.push(`fixture:${id}`); },
    async newCandidateContext({ storageState }) { events.push(`context:${storageState.actor}`); return { context: storageState.actor }; },
    async captureCandidateObservation({ context, onPhase, index }) { await onPhase("domcontentloaded_immediate_observation"); await onPhase("settled"); const caseId = sourceCaseIds.find((value) => session.currentSource.includes(value === "hideform-omitted" ? "[[module Comments]]" : value.replace("hideform-", "hideForm=\""))); return fakeCapture({ actor: context, source: { case_id: caseId, source: session.currentSource }, index }); },
    async close() { events.push("browser-close"); return { browser_context_count: 2 }; },
  };
  const caseSet = createCommentsHideformBrowserCandidateCaseSet({ sessionFactory: () => session });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "comments-hideform-candidate-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = await runCandidateCaseSet({
    candidateIdentity: identity,
    candidateIdentitySha256: sha256Value(identity),
    privateInput,
    privateInputSha256: hash("7"),
    outputDir: path.join(root, "receipt"),
    caseSet,
    runId: "candidate-run-0123456789ab",
    dependencies: {
      createBrowserContexts: () => browserContexts,
      collectExecutionIdentity: async () => ({ schema: "fixture.execution.v1", source_clean: true, module_manifest_sha256: hash("q") }),
      observeRuntimeIdentity: async () => ({ schema: "fixture.runtime.v1", identity: "stable" }),
      assertStableRuntimeIdentity(before, after) { assert.deepEqual(before, after); },
      now: () => "2026-08-15T00:00:00.000Z",
    },
  });
  assert.equal(result.status, "pass");
  assert.equal(result.denominator.count, 1);
  assert.equal(JSON.stringify(result).includes("administrator-secret"), false);
  const browserClose = events.lastIndexOf("browser-close");
  const cleanupPageGet = events.indexOf("cleanup-page_get:administrator");
  const finalCleanupPageGet = events.lastIndexOf("cleanup-page_get:administrator");
  const cleanupPageDelete = events.lastIndexOf("cleanup-page_delete:administrator");
  assert.ok(browserClose >= 0 && cleanupPageGet > browserClose && cleanupPageDelete > cleanupPageGet && finalCleanupPageGet > cleanupPageDelete, events.join(","));
  assert.ok(events.includes("category_update:administrator"));
  assert.ok(events.includes("cleanup-category_update:administrator"));
});

test("candidate case registry keeps the no-replace runner entry explicit", async () => {
  assert.match((await candidateCaseSet("comments-hideform-browser")).caseIds[0], /^M1367_/u);
});
