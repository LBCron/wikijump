import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fixtureRpcTarget } from "../src/fixture-rpc-target.mjs";

const task = "wikijump-theme-lab-basalt-fresh-20261019";
const url = `http://${task}-deepwell-1:2747/jsonrpc`;

test("freshly seeded isolated database keeps the canonical SCP-JP target site and ID contract", () => {
  const repo = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
  const sites = JSON.parse(
    fs.readFileSync(path.join(repo, "deepwell/seeder/sites.json"), "utf8"),
  );
  const siteIndex = sites.findIndex((site) => site.slug === "scpaiueouiuiuiui");
  assert.equal(
    siteIndex,
    3,
    "site order changed: built Caddy expects local fixture site_id 6000003",
  );
  assert.equal(sites[siteIndex].locale, "ja");
  const pages = JSON.parse(
    fs.readFileSync(path.join(repo, "deepwell/seeder/pages.json"), "utf8"),
  );
  assert.ok(
    (pages.scpaiueouiuiuiui ?? []).length >= 3,
    "clean DB must include seeded JP corpus pages",
  );
});

test("shared-development writes require explicit opt-in and exact loopback target", () => {
  assert.throws(() => fixtureRpcTarget({}), /require explicit/u);
  assert.deepEqual(
    fixtureRpcTarget({ THEME_LAB_FIXTURE_SCOPE: "shared-development" }),
    {
      rpcUrl: "http://127.0.0.1:2747/jsonrpc",
      project: "wikijump-local-development",
      scope: "shared-development",
    },
  );
  assert.equal(
    fixtureRpcTarget({
      THEME_LAB_FIXTURE_SCOPE: "shared-development",
      DEEPWELL_RPC_URL: "http://127.0.0.1:2747/jsonrpc",
    }).scope,
    "shared-development",
  );
});

test("task fixture provisioning binds the unique Compose backend container DNS", () => {
  assert.deepEqual(
    fixtureRpcTarget({
      THEME_LAB_BACKEND_PROJECT: task,
      DEEPWELL_RPC_URL: url,
    }),
    {
      rpcUrl: url,
      project: task,
      scope: "isolated-task",
    },
  );
});

test("task mode fails closed on missing endpoint, legacy loopback, another backend, URL credentials, and external network", () => {
  for (const bad of [
    undefined,
    "http://127.0.0.1:2747/jsonrpc",
    "http://deepwell:2747/jsonrpc",
    "http://wikijump-local-development-deepwell-1:2747/jsonrpc",
    `http://attacker:password@${task}-deepwell-1:2747/jsonrpc`,
    `${url}?token=secret`,
    "https://scp-jp.wikidot.com/jsonrpc",
  ]) {
    assert.throws(
      () =>
        fixtureRpcTarget({
          THEME_LAB_BACKEND_PROJECT: task,
          DEEPWELL_RPC_URL: bad,
        }),
      /requires the exact isolated Deepwell DNS target/u,
    );
  }
});

test("shared mode cannot switch to a private, remote, or Docker task endpoint", () => {
  for (const endpoint of [
    url,
    "http://localhost:2747/jsonrpc",
    "http://127.0.0.1:3396/jsonrpc",
    "https://scp-jp.wikidot.com/jsonrpc",
  ])
    assert.throws(
      () =>
        fixtureRpcTarget({
          THEME_LAB_FIXTURE_SCOPE: "shared-development",
          DEEPWELL_RPC_URL: endpoint,
        }),
      /cannot override/u,
    );
});

test("malformed or ambiguous project markers never enable fixture write access", () => {
  for (const project of [
    "",
    "wikijump-standing",
    "wikijump-local-development",
    "wikijump-theme-lab-a",
    "wikijump-theme-lab-Bad",
    "wikijump-theme-lab-foo/bar",
    "wikijump-theme-lab-foo..bar",
  ])
    assert.throws(
      () =>
        fixtureRpcTarget({
          THEME_LAB_BACKEND_PROJECT: project,
          DEEPWELL_RPC_URL: url,
        }),
      /invalid task-owned/u,
    );
});

test("all mutating fixture scripts reject shared RPC under a task-owned project before network access", () => {
  const repo = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
  const scripts = [
    "install/local/theme-lab/scripts/provision-canonical-corpus.mjs",
    "install/local/theme-lab/ports/interactive-visual-fixture/provision-fixture.mjs",
    "install/local/theme-lab/ports/interactive-visual-fixture/provision-credit-variants.mjs",
  ];
  for (const script of scripts) {
    const result = spawnSync(process.execPath, [path.join(repo, script)], {
      encoding: "utf8",
      timeout: 5000,
      env: {
        ...process.env,
        THEME_LAB_BACKEND_PROJECT: task,
        DEEPWELL_RPC_URL: "http://127.0.0.1:2747/jsonrpc",
        DEEPWELL_RPC_TOKEN: "a".repeat(64),
        WIKIDOT_VERIFY_ADMIN_EMAIL: "fake@localhost",
        WIKIDOT_VERIFY_ADMIN_PASS: "test-only",
      },
    });
    assert.notEqual(result.status, 0, script);
    assert.match(
      result.stderr,
      /requires the exact isolated Deepwell DNS target/u,
      script,
    );
  }
});

test("wrong local site ID blocks all fixture writers before any database edit", (t) => {
  const repo = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../..",
  );
  const scratch = fs.mkdtempSync(
    path.join(os.tmpdir(), "theme-lab-site-guard-"),
  );
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  const mock = path.join(scratch, "mock-fetch.mjs");
  fs.writeFileSync(
    mock,
    `globalThis.fetch=async(_url,options)=>{
  const data=JSON.parse(options.body);
  if(data.method!=='site_get')throw new Error('UNSAFE WRITE: fixture mutated wrong site');
  return {ok:true,json:async()=>({result:{site_id:6000004,slug:'scpaiueouiuiuiui'}})};
 };`,
  );
  const scripts = [
    "install/local/theme-lab/scripts/provision-canonical-corpus.mjs",
    "install/local/theme-lab/ports/interactive-visual-fixture/provision-fixture.mjs",
    "install/local/theme-lab/ports/interactive-visual-fixture/provision-credit-variants.mjs",
  ];
  for (const script of scripts) {
    const result = spawnSync(
      process.execPath,
      ["--import", mock, path.join(repo, script)],
      {
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          THEME_LAB_BACKEND_PROJECT: task,
          DEEPWELL_RPC_URL: url,
          DEEPWELL_RPC_TOKEN: "a".repeat(64),
          WIKIDOT_VERIFY_ADMIN_EMAIL: "fake@localhost",
          WIKIDOT_VERIFY_ADMIN_PASS: "test-only",
        },
      },
    );
    assert.notEqual(result.status, 0, script);
    assert.match(result.stderr, /site ID differs/u, script);
    assert.doesNotMatch(result.stderr, /UNSAFE WRITE/u, script);
  }
});
