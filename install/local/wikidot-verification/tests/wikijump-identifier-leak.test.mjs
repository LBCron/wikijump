import assert from "node:assert/strict";
import test from "node:test";

import {
  CONSTRUCT_BATTERY,
  evaluateRenderedBattery,
  findWikijumpIdentifiers,
  runWikijumpIdentifierLeakCheck,
} from "../src/wikijump-identifier-leak.mjs";
import {
  assertLoopbackRpcUrl,
  parseArgs,
  usage,
} from "../scripts/check-wikijump-identifier-leaks.mjs";

test("Wikijump identifiers are found as classes, tags and data attributes", () => {
  assert.deepEqual(
    findWikijumpIdentifiers(
      '<wj-code class="wj-code wj-language-css"><div class="code" data-wj-language="css">',
    ),
    ["data-wj-language", "wj-code", "wj-language-css"],
  );
});

test("Wikidot's own names are not identifiers", () => {
  const wikidot = [
    '<div class="collapsible-block collapsible-block-folded">',
    '<div class="footnotes-footer"><div class="title">Footnotes</div>',
    '<sup class="footnoteref"><a id="footnoteref-1" href="#footnote-1">1</a></sup>',
    '<h1 id="toc0"><span>Heading</span></h1>',
    '<div class="page-rate-widget-box"><span class="rate-points">',
    '<div class="code"><div class="hl-main"><span class="hl-identifier">.x</span>',
    '<ul class="yui-nav"><li class="selected"><a href="javascript:;">',
  ].join("");
  assert.deepEqual(findWikijumpIdentifiers(wikidot), []);
});

test("a word merely containing wj is not an identifier", () => {
  assert.deepEqual(findWikijumpIdentifiers('<div class="swj-thing awkward-wj">'), []);
});

test("a non-string body is refused rather than silently passing", () => {
  assert.throws(() => findWikijumpIdentifiers(undefined), /must be a string/u);
  assert.throws(() => findWikijumpIdentifiers(null), /must be a string/u);
});

test("a clean battery passes and a leaking one does not", () => {
  const clean = evaluateRenderedBattery([
    {id: "a", body: '<div class="collapsible-block">'},
    {id: "b", body: '<h1 id="toc0">x</h1>'},
  ]);
  assert.equal(clean.status, "clean");
  assert.equal(clean.leaked_case_count, 0);
  assert.deepEqual(clean.identifiers, []);

  const leaking = evaluateRenderedBattery([
    {id: "a", body: '<div class="collapsible-block">'},
    {id: "b", body: '<div class="code" data-wj-language="css">'},
  ]);
  assert.equal(leaking.status, "leaked");
  assert.equal(leaking.leaked_case_count, 1);
  assert.deepEqual(leaking.identifiers, ["data-wj-language"]);
  assert.equal(leaking.cases[1].status, "leaked");
});

test("a construct that fails to render is a failure, not a pass", () => {
  const report = evaluateRenderedBattery([
    {id: "a", body: "<p>fine</p>"},
    {id: "b", error: "local preview returned no body"},
  ]);
  assert.equal(report.status, "leaked");
  assert.equal(report.render_error_count, 1);
  assert.equal(report.cases[1].status, "render-error");
});

test("duplicate or unnamed cases are refused", () => {
  assert.throws(() => evaluateRenderedBattery([{id: "a", body: ""}, {id: "a", body: ""}]), /duplicate/u);
  assert.throws(() => evaluateRenderedBattery([{body: ""}]), /needs an id/u);
});

test("the battery runs every construct and survives one throwing", async () => {
  const seen = [];
  const report = await runWikijumpIdentifierLeakCheck({
    battery: [
      {id: "ok", wikitext: "x"},
      {id: "boom", wikitext: "y"},
    ],
    render: async (construct) => {
      seen.push(construct.id);
      if (construct.id === "boom") throw new Error("runtime said no");
      return "<p>clean</p>";
    },
  });
  assert.deepEqual(seen, ["ok", "boom"]);
  assert.equal(report.status, "leaked");
  assert.equal(report.cases[1].error, "runtime said no");
});

test("the battery refuses to run without a renderer or constructs", async () => {
  await assert.rejects(
    () => runWikijumpIdentifierLeakCheck({render: null}),
    /render must be a function/u,
  );
  await assert.rejects(
    () => runWikijumpIdentifierLeakCheck({battery: [], render: async () => ""}),
    /at least one construct/u,
  );
});

test("the shipped battery has unique ids and non-empty wikitext", () => {
  assert.ok(CONSTRUCT_BATTERY.length >= 30);
  const ids = CONSTRUCT_BATTERY.map((construct) => construct.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const construct of CONSTRUCT_BATTERY) {
    assert.match(construct.id, /^[a-z0-9-]+$/u, construct.id);
    assert.ok(construct.wikitext.trim().length > 0, construct.id);
  }
  for (const required of ["code-language", "collapsible", "tabview", "footnote", "list-pages-row-heading"]) {
    assert.ok(ids.includes(required), required);
  }
});

test("the RPC target must be loopback", () => {
  assert.ok(assertLoopbackRpcUrl("http://127.0.0.1:2747/jsonrpc"));
  assert.ok(assertLoopbackRpcUrl("http://localhost:12747/jsonrpc"));
  for (const bad of [
    "https://example.com/jsonrpc",
    "http://example.com/jsonrpc",
    "http://user:pass@127.0.0.1:2747/jsonrpc",
    "not a url",
  ]) {
    assert.throws(() => assertLoopbackRpcUrl(bad), bad);
  }
});

test("the CLI parses its options and requires a site", () => {
  assert.deepEqual(parseArgs(["--site", "scp-wiki"]), {
    rpcUrl: "http://127.0.0.1:2747/jsonrpc",
    site: "scp-wiki",
    json: false,
  });
  assert.deepEqual(parseArgs(["--", "--site", "scp-wiki", "--json"]).json, true);
  assert.equal(parseArgs(["--site", "s", "--rpc-url", "http://localhost:1/x"]).rpcUrl, "http://localhost:1/x");
  assert.deepEqual(parseArgs(["--help"]), {help: true});
  assert.throws(() => parseArgs([]), /--site is required/u);
  assert.throws(() => parseArgs(["--nope"]), /unknown option/u);
  assert.throws(() => parseArgs(["--site"]), /requires a value/u);
  assert.throws(() => parseArgs(["--site", "s", "--rpc-url", "https://evil.example"]), /loopback/u);
  assert.match(usage(), /Wikidot layout/u);
});
