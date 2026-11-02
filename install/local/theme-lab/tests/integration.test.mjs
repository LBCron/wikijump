// End-to-end browser integration for the theme-port loop.
//
// Everything is served from loopback fixtures; the reference stylesheet is the
// repository's checked-in Wikidot base theme, so the selector shapes are real.
// No external network is used.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {loadChromium} from "../src/browser-lab.mjs";
import {ReferenceCache} from "../src/reference-cache.mjs";
import {startSessionServer} from "../src/session-server.mjs";
import {TARGET_ACCEPTANCE_CONTRACT_SHA256} from "../src/target-acceptance-contract.mjs";

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(MODULE_DIR, "../../../..");
const WIKIDOT_BASE_CSS = path.join(
  REPO_ROOT,
  "framerail/static/wikidot/styles/wikidot-base-165bc434fd1d.css",
);

const CANDIDATE_HTML = `<!doctype html><html><head><link rel="stylesheet" href="/wikidot-base.css"></head>
<body><div id="header"><h1>JP</h1></div>
<div id="page-content"><div class="page-rate-widget-box"><span class="rate-points">+1</span></div>
<table class="wiki-content-table"><tr><td>x</td></tr></table></div></body></html>`;

const REFERENCE_HTML = `<!doctype html><html><head><link rel="stylesheet" href="/wikidot-base.css"><link rel="stylesheet" href="/foreign.css"></head>
<body><div id="header"><h1>Foreign</h1></div>
<div id="page-content"><div class="foreign-rate-box"><span class="rate-points">+1</span></div>
<table class="wiki-content-table"><tr><td>x</td></tr></table></div></body></html>`;

const FOREIGN_CSS = `#header h1 { color: rgb(187, 1, 17); font-size: 31px; }
.foreign-rate-box { display: inline-block; border: 1px solid rgb(187, 1, 17); }`;

const SELECTORS = ["#header h1", "#page-content", ".foreign-rate-box", ".page-rate-widget-box", "table.wiki-content-table"];

async function fixtureServer() {
  // This is a diagnostic loopback fixture, not source-Wikidot authority.
  // Flatten decorative remote URLs so cache acquisition itself stays local.
  const pixel='data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const baseCss = (await fs.readFile(WIKIDOT_BASE_CSS,'utf8'))
    .replace(/url\(\s*(['"]?)(?:https?:)?\/\/[^)]*\)/giu,`url("${pixel}")`);
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push(request.url);
    const send = (type, body) => {
      response.statusCode = 200;
      response.setHeader("content-type", type);
      response.end(body);
    };
    if (request.url === "/candidate") return send("text/html", CANDIDATE_HTML);
    if (request.url === "/reference") return send("text/html", REFERENCE_HTML);
    if (request.url === "/foreign.css") return send("text/css", FOREIGN_CSS);
    if (request.url === "/wikidot-base.css") return send("text/css", baseCss);
    response.statusCode = 404;
    response.end("no");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withSession(t, run, {previewClient = null} = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "theme-lab-integration-"));
  const fixture = await fixtureServer();
  let server;
  try {
    server = await startSessionServer({
      socketPath: path.join(dir, "session.sock"),
      chromium: loadChromium(),
      headless: true,
      candidateUrl: `${fixture.origin}/candidate`,
      referenceAssets: new ReferenceCache({cacheDir: path.join(dir, "cache"), allowPrivate: true}),
      previewClient,
    });
  } catch (error) {
    // A listening fixture server keeps the file's process alive forever.
    await fixture.close();
    await fs.rm(dir, {recursive: true, force: true});
    throw error;
  }
  t.after(async () => {
    await server.close().catch(() => {});
    await fixture.close();
    await fs.rm(dir, {recursive: true, force: true});
  });
  await run({session: server.session, fixture});
}

test("theme-port check fails on a missing included component in the rendered preview", async (t) => {
  const previewClient = {
    preview: async () => ({
      body: '<span class="theme-lab-jp-font-probe">日本語の字形</span><div class="error-block">Included page "component:theme-squares" does not exist (create it now)</div>',
      styles: [],
      legacy_actions: [],
      membership_actions: [],
    }),
  };
  await withSession(t, async ({session}) => {
    const verdict = await session.check({
      siteId: 6000003,
      title: "Theme preview include diagnostic",
      wikitext: '[[include :scp-jp:component:theme-squares]]',
      viewports: false,
      torture: false,
    });
    assert.equal(verdict.verdict, "fail");
    assert.equal(verdict.font_diagnostics.status, "measured");
    assert.equal(verdict.font_diagnostics.evidence, "japanese-glyph-specimen");
    assert.ok(verdict.font_diagnostics.fonts.some((font) => font.glyph_count > 0));
    assert.ok(verdict.top_issues.some((issue) => issue.kind === "unresolved_include" && issue.include === "component:theme-squares"));
    assert.deepEqual(verdict.next_actions, [{
      kind: "resolve_candidate_include",
      include: "component:theme-squares",
      evidence: {preview_error: 'Included page "component:theme-squares" does not exist (create it now)'},
    }]);
  }, {previewClient});
});

test("recorded check binds the original candidate inputs before replay rewriting", async (t) => {
  const inputs = {css: '#page-content { color: black; }', baseCss: 'body { font-size: 16px; }', source: '[[module CSS]]\n/* 日本語 */\n[[/module]]', wikitext: '日本語のプレビュー'};
  const previewClient = {preview: async () => ({body: '<p class="theme-lab-jp-font-probe">日本語のプレビュー</p>', styles: [], legacy_actions: [], membership_actions: []})};
  await withSession(t, async ({session}) => {
    const result = await session.check({...inputs, siteId: 6000003, iteration: true});
    for (const [field, key] of [['candidate_css_sha256','css'], ['candidate_base_css_sha256','baseCss'], ['candidate_source_sha256','source'], ['candidate_preview_sha256','wikitext']]) {
      assert.equal(result[field], crypto.createHash('sha256').update(inputs[key]).digest('hex'));
    }
  }, {previewClient});
});

test("recorded reference identity binds original HTML and its distinct local replay", async (t) => {
  await withSession(t, async ({session, fixture}) => {
    const result = await session.check({referenceUrl: `${fixture.origin}/reference`, css: FOREIGN_CSS, iteration: true});
    const identity = result.reference_identity;
    assert.equal(identity.source_url, `${fixture.origin}/reference`);
    assert.equal(identity.original_html_sha256, crypto.createHash('sha256').update(REFERENCE_HTML).digest('hex'));
    assert.match(identity.replay_entry, /^\/o\/[a-f0-9]{64}$/u);
    assert.match(identity.snapshot_sha256, /^[a-f0-9]{64}$/u);
    assert.equal(identity.offline, false);
    assert.ok(result.reference.url.endsWith(identity.replay_entry));
  });
});

test("theme-port check retains a target-only selector suggestion without a parity action", async (t) => {
  await withSession(t, async ({session, fixture}) => {
    const verdict = await session.check({
      referenceUrl: `${fixture.origin}/reference`,
      selectors: SELECTORS,
      css: "#page-content { font-size: 15px; }",
      viewports: true,
      torture: false,
    });
    assert.equal(verdict.verdict, "fail");
    assert.equal(verdict.port_decision.verdict, "inconclusive");
    const missing = verdict.top_issues.find((issue) => issue.selector === ".foreign-rate-box");
    assert.ok(missing, "foreign rate box should be reported missing");
    assert.equal(missing.reference_role, "rating_widget");
    assert.equal(missing.suggested_candidate.selector, ".page-rate-widget-box");
    assert.ok(missing.suggested_candidate.confidence >= 0.6);
    assert.equal(missing.parity_review.decision_authority, "SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY");
    assert.equal(missing.parity_review.port_conclusion_eligible, false);
    assert.ok(verdict.target_acceptance.findings.some((issue) => issue.selector === ".foreign-rate-box"));
    assert.ok(!verdict.next_actions.some((action) => action.kind === "rewrite_selector"));
  });
});

test("theme-port check explains a computed-style delta via the cascade", async (t) => {
  await withSession(t, async ({session, fixture}) => {
    const verdict = await session.check({
      referenceUrl: `${fixture.origin}/reference`,
      selectors: SELECTORS,
      css: "#header h1 { color: rgb(0, 0, 0) !important; }",
      viewports: false,
      torture: false,
    });
    const headerColor = verdict.target_acceptance.style_changes.find(
      (change) => change.anchor === "#header h1" && change.property === "color",
    );
    assert.ok(headerColor, "header color delta should be reported");
    assert.ok(headerColor.cascade, "delta should carry a cascade diagnosis");
    assert.equal(headerColor.decision_authority, "SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY");
    assert.equal(headerColor.port_conclusion_eligible, false);
    assert.ok(!verdict.style_changes.some((change) => change.anchor === "#header h1" && change.property === "color"));
    assert.equal(headerColor.cascade.status, "overridden");
    assert.equal(headerColor.cascade.winner.important, true);
    assert.equal(headerColor.cascade.winner.value, "rgb(0, 0, 0)");
  });
});

test("iteration-mode check keeps local target comparison and explicitly defers full acceptance", async (t) => {
  const previewClient = {preview: async () => ({body: '<span class="theme-lab-jp-font-probe">日本語の字形</span><div id="iteration-content">theme DOM</div>', styles: [], legacy_actions: [], membership_actions: []})};
  await withSession(t, async ({session, fixture}) => {
    const verdict = await session.check({
      siteId: 6000003,
      title: "Fast theme CSS iteration",
      wikitext: "日本語の反復プレビュー",
      css: "#page-content { color: rgb(1, 2, 3); }",
      referenceUrl: `${fixture.origin}/reference`,
      selectors: SELECTORS,
      iteration: true,
      viewports: true,
      torture: true,
      visual: true,
    });
    assert.equal(verdict.verification_scope.mode, "iteration");
    assert.ok(verdict.target_acceptance.style_changes.some((change) => change.property === "color"));
    assert.ok(verdict.target_acceptance.style_changes.every((change) => change.decision_authority === "SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY"));
    assert.equal(verdict.viewport_status, null);
    assert.equal(verdict.torture, null);
    assert.equal(verdict.interaction_diagnostics, null);
    assert.equal(verdict.visual, null);
    assert.deepEqual(verdict.verification_scope.deferred, ["all viewports", "torture", "widget interactions", "visual screenshots"]);
    const cssOnly = await session.check({
      css: "#iteration-content { color: rgb(4, 5, 6); }",
      referenceUrl: `${fixture.origin}/reference`,
      selectors: SELECTORS,
      referenceOffline: true,
      iteration: true,
    });
    assert.equal(cssOnly.timing_ms.preview_ms, undefined);
    assert.equal((await session.probe({selector: "#iteration-content", property: "display"})).matched, 1,
      "CSS-only iterations keep the current preview DOM live");
  }, {previewClient});
});

test("broken CSS canary fails local acceptance without certifying a parity mismatch", async (t) => {
  await withSession(t, async ({session}) => {
    const verdict = await session.check({
      css: "#page-content { width: 5000px; }",
      viewports: true,
      torture: false,
    });
    assert.equal(verdict.verdict, "fail");
    assert.equal(verdict.overall_acceptance.status, "fail");
    assert.equal(verdict.port_decision.verdict, "pass");
    assert.equal(verdict.target_acceptance.status, "fail");
    assert.ok(verdict.top_issues.some((issue) => issue.kind === "viewport_overflow"));
  });
});

test("full viewport acceptance does not attribute inherited preview overflow to the theme", async (t) => {
  const previewClient = {
    preview: async () => ({
      body: '<div id="inherited-overflow" style="width:340px;height:20px">baseline content</div>',
      styles: [],
      legacy_actions: [],
      membership_actions: [],
    }),
  };
  await withSession(t, async ({session}) => {
    const verdict = await session.check({
      siteId: 6000003,
      wikitext: "inherited overflow fixture",
      css: "#inherited-overflow { color: rgb(1, 2, 3); }",
      viewports: true,
      torture: false,
    });
    const narrow = verdict.viewport_status["narrow-mobile"];
    assert.ok(narrow.viewport_escape_px > 1);
    assert.equal(narrow.viewport_escape_px, narrow.baseline_viewport_escape_px);
    assert.equal(narrow.status, "pass");
    assert.equal(verdict.target_acceptance_contract_sha256, TARGET_ACCEPTANCE_CONTRACT_SHA256);
    assert.ok(!verdict.top_issues.some((issue) => issue.kind === "viewport_overflow"));
  }, {previewClient});
});

test("second check is fully offline and makes no reference requests", async (t) => {
  await withSession(t, async ({session, fixture}) => {
    await session.check({referenceUrl: `${fixture.origin}/reference`, selectors: SELECTORS, viewports: false, torture: false});
    const hitsAfterFirst = fixture.hits.length;
    const second = await session.check({
      referenceUrl: `${fixture.origin}/reference`,
      referenceOffline: true,
      selectors: SELECTORS,
      viewports: false,
      torture: false,
    });
    assert.equal(fixture.hits.length, hitsAfterFirst, "offline check must not hit the fixture server");
    assert.ok(second.verdict);
  });
});

test("unapplied reference stylesheet fails the diff loudly instead of dropping deltas", async (t) => {
  // If the reference stylesheet never applies, the reference inherits and its
  // values can equal the candidate, so the delta row vanishes entirely. The
  // diff must fail closed with stylesheets_not_ready rather than record an
  // unstyled measurement that looks like parity.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "theme-lab-integration-"));
  const server = http.createServer((request, response) => {
    if (request.url === "/reference") {
      response.statusCode = 200;
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><html><head><link rel="stylesheet" href="/missing.css"></head><body><div id="header"><h1>Foreign</h1></div></body></html>`);
      return;
    }
    response.statusCode = 404;
    response.end("no");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let sessionServer;
  try {
    sessionServer = await startSessionServer({
      socketPath: path.join(dir, "session.sock"),
      chromium: loadChromium(),
      headless: true,
      candidateUrl: `${origin}/reference`,
      referenceAssets: new ReferenceCache({cacheDir: path.join(dir, "cache"), allowPrivate: true}),
    });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, {recursive: true, force: true});
    throw error;
  }
  t.after(async () => {
    await sessionServer.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, {recursive: true, force: true});
  });
  await assert.rejects(
    sessionServer.session.check({
      referenceUrl: `${origin}/reference`,
      selectors: ["#header h1"],
      css: "#header h1 { color: rgb(0, 0, 0) !important; }",
      viewports: false,
      torture: false,
    }),
    (error) => error?.code === "stylesheets_not_ready",
  );
});
