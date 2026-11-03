import assert from "node:assert/strict";
import test from "node:test";

import { main as runParityCli, usage as parityCliUsage } from "../scripts/run-standing-browser-parity.mjs";
import { closeParityBrowserResources } from "../src/standing-browser-parity-browser-session.mjs";
import { parseStandingBrowserParityArgs } from "../src/standing-browser-parity-runner.mjs";

const policy = "/tmp/standing-policy.json";

test("standing parity CLI exposes result and help without opening a browser", async () => {
  const output = [];
  const code = await runParityCli(["node", "script", "--mode", "candidate"], {
    parseArgs: () => ({mode: "candidate"}),
    runParity: async () => ({mode: "candidate", status: "pass", output_dir: "/tmp/parity"}),
    stdout: (line) => output.push(JSON.parse(line)),
  });
  assert.equal(code, 0);
  assert.deepEqual(output, [{
    schema: "wikijump.standing_browser_parity_cli_result.v1",
    mode: "candidate",
    status: "pass",
    output_dir: "/tmp/parity",
  }]);
  assert.match(parityCliUsage(), /live-reference/u);
});

test("parity browser cleanup attempts every resource and reports every failure", async () => {
  const attempts = [];
  const context = {
    async close() {
      attempts.push("context");
      throw new Error("context close failed");
    },
  };
  const browser = {
    async close() {
      attempts.push("browser");
      throw new Error("browser close failed");
    },
  };

  await assert.rejects(
    () => closeParityBrowserResources(context, browser),
    (error) => {
      assert(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      return true;
    },
  );
  assert.deepEqual(attempts, ["context", "browser"]);
});

test("parity browser cleanup bounds a stalled close and still attempts every resource", async () => {
  const attempts = [];
  const never = new Promise(() => {});
  const context = {
    close() {
      attempts.push("context");
      return never;
    },
  };
  const browser = {
    close() {
      attempts.push("browser");
      return never;
    },
  };

  await assert.rejects(
    Promise.race([
      closeParityBrowserResources(context, browser, { timeoutMs: 10 }),
      new Promise((_, reject) => setTimeout(() => reject(new Error("cleanup remained unbounded")), 100)),
    ]),
    (error) => {
      assert(error instanceof AggregateError);
      assert.equal(error.errors.length, 2);
      assert.match(error.errors[0].message, /context close exceeded 10ms/u);
      assert.match(error.errors[1].message, /browser close exceeded 10ms/u);
      return true;
    },
  );
  assert.deepEqual(attempts, ["context", "browser"]);
});

test("live reference capture requires an identity-bound persistent document cache", () => {
  assert.throws(
    () =>
      parseStandingBrowserParityArgs([
        "node",
        "runner",
        "--mode",
        "live-reference",
        "--output-dir",
        "/tmp/standing-reference",
        "--live-completion-policy",
        policy,
      ]),
    /--source-response-cache-dir/u,
  );
  assert.throws(
    () =>
      parseStandingBrowserParityArgs([
        "node",
        "runner",
        "--mode",
        "live-reference",
        "--output-dir",
        "/tmp/standing-reference",
        "--live-completion-policy",
        policy,
        "--source-response-cache-dir",
        "/tmp/standing-source-cache",
        "--source-response-cache-identity",
        "scp-wiki:chromium-149:policy-v1",
      ]),
    /--cache-source-documents/u,
  );
  const args = parseStandingBrowserParityArgs([
    "node",
    "runner",
    "--mode",
    "live-reference",
    "--output-dir",
    "/tmp/standing-reference",
    "--live-completion-policy",
    policy,
    "--source-response-cache-dir",
    "/tmp/standing-source-cache",
    "--source-response-cache-identity",
    "scp-wiki:chromium-149:policy-v1",
    "--cache-source-documents",
    "--viewport",
    "1440x960",
  ]);
  assert.equal(args.mode, "live-reference");
  assert.deepEqual(args.viewport, { width: 1440, height: 960 });
  assert.equal(args.timeoutMs, 120_000);
  assert.equal(args.sourceResponseCacheDir, "/tmp/standing-source-cache");
  assert.equal(args.sourceResponseCacheDocuments, true);
  const cached = parseStandingBrowserParityArgs([
    "node",
    "runner",
    "--mode",
    "live-reference",
    "--output-dir",
    "/tmp/standing-reference-cached",
    "--live-completion-policy",
    policy,
    "--source-response-cache-dir",
    "/tmp/standing-source-cache",
    "--source-response-cache-identity",
    "scp-wiki:chromium-149:policy-v1",
    "--cache-source-documents",
  ]);
  assert.equal(cached.sourceResponseCacheDocuments, true);
  assert.equal(cached.sourceResponseCacheIdentity, "scp-wiki:chromium-149:policy-v1");
  assert.throws(
    () =>
      parseStandingBrowserParityArgs([
        "node",
        "runner",
        "--mode",
        "live-reference",
        "--output-dir",
        "/tmp/standing-reference",
      ]),
    /live-completion-policy/u,
  );
  const candidateCache = parseStandingBrowserParityArgs([
    "node", "runner", "--mode", "candidate", "--output-dir", "/tmp/candidate",
    "--live-completion-policy", policy, "--source-response-cache-dir", "/tmp/cache",
    "--source-response-cache-identity", "identity", "--candidate-port", "20443",
    "--live-reference-ledger", "/tmp/reference.json",
  ]);
  assert.equal(candidateCache.sourceResponseCacheDir, "/tmp/cache");
  assert.equal(candidateCache.sourceResponseCacheIdentity, "identity");
  assert.throws(
    () => parseStandingBrowserParityArgs([
      "node", "runner", "--mode", "candidate", "--output-dir", "/tmp/candidate",
      "--live-completion-policy", policy, "--source-response-cache-dir", "/tmp/cache",
      "--source-response-cache-identity", "identity", "--cache-source-documents",
      "--candidate-port", "20443", "--live-reference-ledger", "/tmp/reference.json",
    ]),
    /only in live-reference mode/u,
  );
});

test("candidate capture requires the candidate port and live reference", () => {
  assert.throws(
    () => parseStandingBrowserParityArgs([
      "node", "runner", "--mode", "candidate", "--output-dir", "/tmp/standing-candidate",
      "--live-completion-policy", policy,
    ]),
    /candidate-port/u,
  );
  const args = parseStandingBrowserParityArgs([
    "node", "runner", "--mode", "candidate", "--output-dir", "/tmp/standing-candidate",
    "--live-completion-policy", policy, "--candidate-port", "20443",
    "--live-reference-ledger", "/tmp/reference.json",
  ]);
  assert.equal(args.mode, "candidate");
  assert.equal(args.candidatePort, 20443);
});

test("standing capture requires the persistent replay cache", () => {
  assert.throws(
    () => parseStandingBrowserParityArgs([
      "node", "runner", "--mode", "standing", "--output-dir", "/tmp/standing",
      "--live-completion-policy", policy, "--live-reference-ledger", "/tmp/reference.json",
    ]),
    /source-response-cache-dir/u,
  );
  const args = parseStandingBrowserParityArgs([
    "node", "runner", "--mode", "standing", "--output-dir", "/tmp/standing",
    "--live-completion-policy", policy, "--live-reference-ledger", "/tmp/reference.json",
    "--source-response-cache-dir", "/tmp/cache", "--source-response-cache-identity", "identity",
  ]);
  assert.equal(args.mode, "standing");
  assert.equal(args.sourceResponseCacheIdentity, "identity");
});
