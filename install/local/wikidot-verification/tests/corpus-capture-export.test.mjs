import assert from "node:assert/strict";
import {execFileSync, spawnSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {sha256Hex, stableStringify} from "../src/canonical-json.mjs";
import {
  canonicalCorpusJsonBytes,
  canonicalizeCaptureValue,
  deriveMetaProjection,
  exportCorpusCaptures,
  listStoredCorpusPages,
  observationLineBytes,
  prettyCorpusJsonBytes,
  readStoredCorpusCapture,
} from "../src/corpus-capture-export.mjs";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STARTED_AT = "2026-11-01T00:00:00.000+00:00";
const RECEIVED_AT = "2026-11-01T01:02:03.000+00:00";

const FALLBACK_PAYLOAD = {
  fullname: "component:login-module",
  title: "Login Module",
  created_at: "2023-04-20T12:12:18+00:00",
  created_by: "darkstuff",
  created_by_id: 4597083,
  created_by_unix: "darkstuff",
  updated_at: "2023-04-20T12:12:18+00:00",
  updated_by: "darkstuff",
  updated_by_id: 4597083,
  updated_by_unix: "darkstuff",
  tags: [],
  rating: 0,
  revisions: 3,
  parent_fullname: null,
  children: 0,
  comments: 0,
  commented_at: null,
  commented_by: null,
  commented_by_id: null,
  commented_by_unix: null,
  content: "[[div]]\nhello\n[[/div]]\n",
  html: "",
};

const XMLRPC_PAYLOAD = {
  fullname: "credit:backmodule",
  title: "クレジットモジュール",
  created_at: "2020-10-25T09:16:43+00:00",
  created_by: "someone",
  updated_at: "2021-01-01T00:00:00+00:00",
  updated_by: "someone",
  tags: ["クレジット"],
  rating: 12,
  revisions: 5,
  parent_fullname: null,
  parent_title: null,
  title_shown: "クレジットモジュール",
  children: 0,
  comments: 2,
  commented_at: null,
  commented_by: null,
  content: "body text\n",
  html: "<p>body text</p>\n",
};
const XMLRPC_META = (() => {
  const meta = {...XMLRPC_PAYLOAD};
  delete meta.content;
  delete meta.html;
  return meta;
})();

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "corpus-capture-export-"));
}

function exportOne(root, captures, extra = {}) {
  return exportCorpusCaptures({
    exportRoot: root,
    branch: "en",
    site: "scp-wiki",
    runId: "test-run-1",
    captures,
    startedAt: STARTED_AT,
    finishedAt: STARTED_AT,
    ...extra,
  });
}

test("canonical and pretty byte forms match the corpus store's Python json.dumps output", () => {
  assert.equal(
    canonicalCorpusJsonBytes({b: 1, a: "x"}).toString("utf8"),
    '{"a":"x","b":1}\n',
  );
  assert.equal(
    prettyCorpusJsonBytes({b: 1, a: {d: [1, 2], c: null}}).toString("utf8"),
    '{\n  "a": {\n    "c": null,\n    "d": [\n      1,\n      2\n    ]\n  },\n  "b": 1\n}\n',
  );
  assert.equal(
    observationLineBytes({b: [1, 2], a: "x"}).toString("utf8"),
    '{"a": "x", "b": [1, 2]}\n',
  );
});

test("fallback capture exports a complete corpus page record with identity fields intact", () => {
  const root = tempRoot();
  const summary = exportOne(root, [
    {transport: "wikidot.py-fallback", received_at: RECEIVED_AT, payload: FALLBACK_PAYLOAD},
  ]);
  assert.equal(summary.exported.length, 1);
  assert.equal(summary.not_exportable.length, 0);
  assert.equal(summary.response_count, 2);

  const branchRoot = path.join(root, "en");
  const pageDir = path.join(branchRoot, "pages", "component:login-module");
  for (const name of [
    "source.wikidot.txt", "meta.json", "entity_id.txt",
    "api-response.json", "html.xmlrpc.html", "current.json",
  ]) {
    assert.ok(fs.existsSync(path.join(pageDir, name)), `missing ${name}`);
  }
  assert.equal(fs.readFileSync(path.join(pageDir, "source.wikidot.txt"), "utf8"), FALLBACK_PAYLOAD.content);
  assert.equal(fs.readFileSync(path.join(pageDir, "html.xmlrpc.html"), "utf8"), "");

  const apiBytes = fs.readFileSync(path.join(pageDir, "api-response.json"));
  assert.ok(apiBytes.equals(canonicalCorpusJsonBytes(FALLBACK_PAYLOAD)));
  const current = JSON.parse(fs.readFileSync(path.join(pageDir, "current.json"), "utf8"));
  assert.equal(current.payload_sha256, `sha256:${sha256Hex(apiBytes)}`);

  const metaText = fs.readFileSync(path.join(pageDir, "meta.json"), "utf8");
  const meta = JSON.parse(metaText);
  assert.equal(meta.created_by_id, 4597083);
  assert.equal(meta.created_by_unix, "darkstuff");
  assert.equal(meta.parent_title, null);
  assert.equal(meta.title_shown, null);
  assert.ok(!("content" in meta) && !("html" in meta));
  const keyOrder = [...metaText.matchAll(/^  "([^"]+)":/gm)].map((match) => match[1]);
  assert.deepEqual(keyOrder, [...keyOrder].sort());
  assert.ok(metaText.endsWith("}\n"));

  const entityId = fs.readFileSync(path.join(pageDir, "entity_id.txt"), "utf8").trim();
  assert.equal(summary.exported[0].entity_id, entityId);
  const snapshotPath = path.join(
    branchRoot, "by-uuid", entityId, "snapshots", `${current.capture_id}.json`,
  );
  const snapshot = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
  assert.equal(
    current.capture_id,
    sha256Hex(`${snapshot.get_meta_response.payload_sha256}|${snapshot.get_one_response.payload_sha256}`),
  );
  for (const reference of [snapshot.get_meta_response, snapshot.get_one_response]) {
    const objectBytes = fs.readFileSync(path.join(branchRoot, reference.object_path));
    assert.equal(`sha256:${sha256Hex(objectBytes)}`, reference.payload_sha256);
    assert.match(reference.object_path, /^_objects\/sha256\/[0-9a-f]{2}\/[0-9a-f]{64}\.json$/);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(
    path.join(branchRoot, snapshot.get_one_response.object_path), "utf8",
  )), FALLBACK_PAYLOAD);

  const envelopes = fs.readFileSync(
    path.join(branchRoot, "_runs", "test-run-1", "responses.ndjson"), "utf8",
  ).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(envelopes.map((envelope) => envelope.method), ["pages.get_meta", "pages.get_one"]);
  assert.ok(envelopes.every((envelope) => envelope.run_id === "test-run-1" && envelope.redactions.length === 0));
  const manifest = JSON.parse(fs.readFileSync(
    path.join(branchRoot, "_runs", "test-run-1", "manifest.json"), "utf8",
  ));
  assert.equal(manifest.status, "targeted");
  assert.equal(manifest.profile, "wikijump-import-capture");
  assert.equal(manifest.response_count, 2);
  assert.equal(manifest.counts.pages_committed, 1);
  assert.equal(manifest.complete_gate.targeted_scope, true);

  const observations = fs.readFileSync(
    path.join(branchRoot, "by-uuid", entityId, "observations.ndjson"), "utf8",
  );
  assert.ok(observations.startsWith('{"change_kinds": ["first_seen"], '));
  const observation = JSON.parse(observations.trim());
  assert.equal(observation.fullname, "component:login-module");
  assert.equal(observation.content_sha256, `sha256:${sha256Hex(FALLBACK_PAYLOAD.content)}`);

  const index = JSON.parse(fs.readFileSync(path.join(branchRoot, "index.json"), "utf8"));
  const entity = index.entities[entityId];
  assert.deepEqual(Object.keys(entity).sort(), [
    "aliases", "created_at", "current_fullname", "current_title", "entity_id",
    "entity_type", "first_seen_at", "flags", "last_checked_run_id",
    "last_observed_at", "last_status_confirmed_at", "latest_content_sha256",
    "latest_page_revision", "latest_tags", "latest_updated_at", "site", "status",
  ]);
  assert.deepEqual(entity.aliases, {
    fullnames: ["component:login-module"],
    titles: ["Login Module"],
    created_by_values: ["darkstuff"],
  });
  assert.deepEqual(
    index.by_site_created_at["scp-wiki|2023-04-20T12:12:18+00:00"], [entityId],
  );
});

test("xmlrpc capture records the transport's own get_meta payload as the meta response", () => {
  const root = tempRoot();
  const summary = exportCorpusCaptures({
    exportRoot: root,
    branch: "jp",
    site: "scp-jp",
    runId: "test-run-jp",
    captures: [{
      transport: "xmlrpc",
      received_at: RECEIVED_AT,
      payload: XMLRPC_PAYLOAD,
      meta_payload: XMLRPC_META,
    }],
    startedAt: STARTED_AT,
    finishedAt: STARTED_AT,
  });
  assert.equal(summary.exported.length, 1);
  const branchRoot = path.join(root, "jp");
  const pageDir = path.join(branchRoot, "pages", "credit:backmodule");
  const current = JSON.parse(fs.readFileSync(path.join(pageDir, "current.json"), "utf8"));
  const entityId = summary.exported[0].entity_id;
  const snapshot = JSON.parse(fs.readFileSync(
    path.join(branchRoot, "by-uuid", entityId, "snapshots", `${current.capture_id}.json`), "utf8",
  ));
  const metaObject = JSON.parse(fs.readFileSync(
    path.join(branchRoot, snapshot.get_meta_response.object_path), "utf8",
  ));
  assert.deepEqual(metaObject, XMLRPC_META);
  const meta = JSON.parse(fs.readFileSync(path.join(pageDir, "meta.json"), "utf8"));
  assert.equal(meta.title_shown, "クレジットモジュール");
  assert.deepEqual(meta, XMLRPC_META);
  assert.equal(fs.readFileSync(path.join(pageDir, "html.xmlrpc.html"), "utf8"), XMLRPC_PAYLOAD.html);
});

test("digested projections are listed as not exportable and write nothing", () => {
  const root = tempRoot();
  const digested = {...FALLBACK_PAYLOAD};
  delete digested.content;
  delete digested.html;
  const summary = exportOne(root, [{transport: "stored-capture", payload: digested}]);
  assert.equal(summary.exported.length, 0);
  assert.equal(summary.not_exportable.length, 1);
  assert.match(summary.not_exportable[0].reason, /not a raw capture/);
  assert.ok(!fs.existsSync(path.join(root, "en", "pages")));
});

test("entity identity is reused from the identity source corpus", () => {
  const identityRoot = tempRoot();
  const knownId = "12345678-1234-4234-8234-1234567890ab";
  const pageDir = path.join(identityRoot, "en", "pages", "component:login-module");
  fs.mkdirSync(pageDir, {recursive: true});
  fs.writeFileSync(path.join(pageDir, "entity_id.txt"), `${knownId}\n`);
  const root = tempRoot();
  const summary = exportOne(
    root,
    [{transport: "wikidot.py-fallback", received_at: RECEIVED_AT, payload: FALLBACK_PAYLOAD}],
    {identityCorpusRoot: identityRoot},
  );
  assert.equal(summary.exported[0].entity_id, knownId);
});

test("a second export of changed content appends a content observation and a new snapshot", () => {
  const root = tempRoot();
  exportOne(root, [
    {transport: "wikidot.py-fallback", received_at: RECEIVED_AT, payload: FALLBACK_PAYLOAD},
  ]);
  const changed = {...FALLBACK_PAYLOAD, content: "changed\n", revisions: 4, updated_at: "2023-05-01T00:00:00+00:00"};
  const summary = exportCorpusCaptures({
    exportRoot: root,
    branch: "en",
    site: "scp-wiki",
    runId: "test-run-2",
    captures: [{transport: "wikidot.py-fallback", received_at: RECEIVED_AT, payload: changed}],
    startedAt: STARTED_AT,
    finishedAt: STARTED_AT,
  });
  const entityId = summary.exported[0].entity_id;
  const observations = fs.readFileSync(
    path.join(root, "en", "by-uuid", entityId, "observations.ndjson"), "utf8",
  ).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(observations.map((row) => row.change_kinds), [["first_seen"], ["content"]]);
  const snapshots = fs.readdirSync(path.join(root, "en", "by-uuid", entityId, "snapshots"));
  assert.equal(snapshots.length, 2);
  const index = JSON.parse(fs.readFileSync(path.join(root, "en", "index.json"), "utf8"));
  assert.equal(
    index.entities[entityId].latest_content_sha256,
    `sha256:${sha256Hex("changed\n")}`,
  );
  assert.equal(index.entities[entityId].last_checked_run_id, "test-run-2");
});

test("an immutable object path with different bytes fails the export", () => {
  const root = tempRoot();
  const digest = sha256Hex(canonicalCorpusJsonBytes(deriveMetaProjection(FALLBACK_PAYLOAD)));
  const objectPath = path.join(root, "en", "_objects", "sha256", digest.slice(0, 2), `${digest}.json`);
  fs.mkdirSync(path.dirname(objectPath), {recursive: true});
  fs.writeFileSync(objectPath, "{}\n");
  assert.throws(
    () => exportOne(root, [
      {transport: "wikidot.py-fallback", received_at: RECEIVED_AT, payload: FALLBACK_PAYLOAD},
    ]),
    /immutable file exists with different bytes/,
  );
});

test("stored captures round-trip; projection-only pages are not exportable from store", () => {
  const root = tempRoot();
  exportOne(root, [
    {transport: "wikidot.py-fallback", received_at: RECEIVED_AT, payload: FALLBACK_PAYLOAD},
  ]);
  const stored = readStoredCorpusCapture(root, "en", "component:login-module");
  assert.equal(stored.ok, true);
  assert.deepEqual(stored.capture.payload, FALLBACK_PAYLOAD);
  assert.deepEqual(stored.capture.meta_payload, deriveMetaProjection(FALLBACK_PAYLOAD));
  assert.equal(stored.capture.received_at, RECEIVED_AT);
  assert.deepEqual(listStoredCorpusPages(root, "en"), ["component:login-module"]);

  const projectionDir = path.join(root, "en", "pages", "projection-only");
  fs.mkdirSync(projectionDir, {recursive: true});
  fs.writeFileSync(path.join(projectionDir, "source.wikidot.txt"), "x\n");
  fs.writeFileSync(path.join(projectionDir, "meta.json"), "{}\n");
  fs.writeFileSync(path.join(projectionDir, "entity_id.txt"), "00000000-0000-4000-8000-000000000000\n");
  const missing = readStoredCorpusCapture(root, "en", "projection-only");
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /api-response\.json missing/);
  const absent = readStoredCorpusCapture(root, "en", "no-such-page");
  assert.equal(absent.ok, false);
});

test("export command re-emits a stored corpus and lists projection-only pages", () => {
  const corpusRoot = tempRoot();
  exportCorpusCaptures({
    exportRoot: corpusRoot,
    branch: "en",
    site: "scp-wiki",
    runId: "seed-run",
    captures: [{transport: "xmlrpc", received_at: RECEIVED_AT, payload: XMLRPC_PAYLOAD, meta_payload: XMLRPC_META}],
    startedAt: STARTED_AT,
    finishedAt: STARTED_AT,
  });
  const projectionDir = path.join(corpusRoot, "en", "pages", "projection-only");
  fs.mkdirSync(projectionDir, {recursive: true});
  fs.writeFileSync(path.join(projectionDir, "meta.json"), "{}\n");

  const exportRoot = tempRoot();
  const stdout = execFileSync(process.execPath, [
    path.join(PACKAGE_ROOT, "scripts", "export-corpus-captures.mjs"),
    "--from-corpus", corpusRoot,
    "--branch", "en",
    "--site", "scp-wiki",
    "--export-root", exportRoot,
    "--run-id", "cli-run",
    "--all-pages",
  ], {encoding: "utf8"});
  const summary = JSON.parse(stdout);
  assert.equal(summary.exported.length, 1);
  assert.equal(summary.exported[0].fullname, "credit:backmodule");
  assert.equal(summary.not_exportable.length, 1);
  assert.equal(summary.not_exportable[0].fullname, "projection-only");
  assert.ok(fs.existsSync(path.join(
    exportRoot, "en", "pages", "credit:backmodule", "api-response.json",
  )));
});

test("export command reports an all-projection corpus with exit 3 and no writes", () => {
  const corpusRoot = tempRoot();
  const pageDir = path.join(corpusRoot, "en", "pages", "projection-only");
  fs.mkdirSync(pageDir, {recursive: true});
  fs.writeFileSync(path.join(pageDir, "source.wikidot.txt"), "x\n");
  fs.writeFileSync(path.join(pageDir, "meta.json"), "{}\n");
  fs.writeFileSync(path.join(pageDir, "entity_id.txt"), "00000000-0000-4000-8000-000000000000\n");
  const exportRoot = path.join(tempRoot(), "out");
  const result = spawnSync(process.execPath, [
    path.join(PACKAGE_ROOT, "scripts", "export-corpus-captures.mjs"),
    "--from-corpus", corpusRoot,
    "--branch", "en",
    "--site", "scp-wiki",
    "--export-root", exportRoot,
    "--run-id", "cli-run-none",
    "--all-pages",
  ], {encoding: "utf8"});
  assert.equal(result.status, 3);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary.exported, []);
  assert.equal(summary.not_exportable.length, 1);
  assert.equal(summary.not_exportable[0].fullname, "projection-only");
  assert.ok(!fs.existsSync(path.join(exportRoot, "en")));
});

test("canonicalization strips capability parameters from download urls", () => {
  const redactions = [];
  const value = canonicalizeCaptureValue(
    {download_url: "https://example.test/f?ukey=secret&keep=1#frag"},
    "payload",
    redactions,
  );
  assert.equal(
    canonicalCorpusJsonBytes(value).toString("utf8"),
    '{"download_url":"https://example.test/f?keep=1"}\n',
  );
  assert.deepEqual(redactions, [
    {path: "payload.download_url", reason: "capability_token_redacted"},
  ]);
  assert.equal(stableStringify({a: 1}), '{"a":1}');
});
