import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  PASS_CACHE_MAX_AGE_MS, passCacheKey, readCachedPass, recordPass, validationEnvironmentDigest,
} from "../src/validation-pass-cache.mjs";

const sha = (text) => createHash("sha256").update(text).digest("hex");

async function recordedPass(t, {status = "pass", completedAt = new Date().toISOString()} = {}) {
  const store = await fs.mkdtemp(path.join(os.tmpdir(), "wj-pass-cache-"));
  t.after(() => fs.rm(store, {recursive: true, force: true}));
  const logPath = path.join(store, "run.log");
  await fs.writeFile(logPath, "preflight: all selected checks passed\n");
  const receiptPath = path.join(store, "receipt.json");
  const receipt = {status, completed_at: completedAt, preflight: {log: {path: logPath, sha256: sha("preflight: all selected checks passed\n")}}};
  const bytes = `${JSON.stringify(receipt)}\n`;
  await fs.writeFile(receiptPath, bytes);
  const key = passCacheKey({tree: "t1", groups: "deepwell"});
  await recordPass({store, key, receiptPath, receiptSha256: sha(bytes), environmentNames: []});
  return {store, key, receiptPath, logPath};
}

test("a recorded PASS is reused for the same key", async (t) => {
  const {store, key, receiptPath} = await recordedPass(t);
  const hit = await readCachedPass({store, key});
  assert.equal(hit.receipt.status, "pass");
  assert.equal(hit.receiptPath, receiptPath);
});

test("the key changes with every input, so a changed tree or environment misses", async (t) => {
  const {store} = await recordedPass(t);
  const base = {tree: "t1", groups: "deepwell"};
  assert.equal(passCacheKey(base), passCacheKey({groups: "deepwell", tree: "t1"}));
  for (const changed of [{...base, tree: "t2"}, {...base, groups: "wws"}, {...base, extra: 1}]) {
    assert.notEqual(passCacheKey(changed), passCacheKey(base));
    assert.match((await readCachedPass({store, key: passCacheKey(changed)})).miss, /no cached PASS/u);
  }
  const first = validationEnvironmentDigest({WIKIJUMP_FTML_CHECKOUT: "/a", PATH: "/x"});
  assert.notEqual(first.sha256, validationEnvironmentDigest({WIKIJUMP_FTML_CHECKOUT: "/b", PATH: "/x"}).sha256);
  assert.equal(first.sha256, validationEnvironmentDigest({WIKIJUMP_FTML_CHECKOUT: "/a", PATH: "/y"}).sha256);
});

test("a tampered receipt, a changed log, a deleted receipt, and a stale PASS all miss", async (t) => {
  const tampered = await recordedPass(t);
  await fs.appendFile(tampered.receiptPath, " ");
  assert.match((await readCachedPass(tampered)).miss, /receipt changed/u);

  const logChanged = await recordedPass(t);
  await fs.appendFile(logChanged.logPath, "an injected line\n");
  assert.match((await readCachedPass(logChanged)).miss, /log changed/u);

  const removed = await recordedPass(t);
  await fs.rm(removed.receiptPath);
  assert.match((await readCachedPass(removed)).miss, /receipt is gone/u);

  const stale = await recordedPass(t, {completedAt: new Date(Date.now() - PASS_CACHE_MAX_AGE_MS - 60_000).toISOString()});
  assert.match((await readCachedPass(stale)).miss, /reuse window/u);
});

test("a recorded failure is never reused", async (t) => {
  const failed = await recordedPass(t, {status: "fail"});
  assert.match((await readCachedPass(failed)).miss, /not a pass/u);
});
