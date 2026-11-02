import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {performance} from "node:perf_hooks";
import {fileURLToPath, pathToFileURL} from "node:url";

import {createBrowserResponseCache as newCache} from "../src/browser-request-gate.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../../../..");
const revision = process.env.BASELINE_REVISION ?? "6112a90d88ecd087a465421f87afdd44e847a6dc";
const source = execFileSync("git", ["show", `${revision}:install/local/wikidot-verification/src/browser-request-gate.mjs`], {cwd: repoRoot, encoding: "utf8"});
const baselineSource = source.replace(
  'from "./resource-manifest.mjs"',
  `from "${pathToFileURL(path.resolve(scriptDir, "../src/resource-manifest.mjs")).href}"`,
);
assert.notEqual(baselineSource, source);
const {createBrowserResponseCache: oldCache} = await import(`data:text/javascript;base64,${Buffer.from(baselineSource).toString("base64")}`);

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return Number(ordered[Math.floor(ordered.length / 2)].toFixed(2));
}

async function run(createCache, requests) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wj-browser-gate-bench-"));
  try {
    const options = {persistentDir: root, persistentIdentity: "parallel-benchmark", evidenceReplay: true};
    const caches = Array.from({length: requests}, () => createCache(options));
    await Promise.all(caches.map((cache) => cache.load()));
    let active = 0;
    let peak = 0;
    const start = performance.now();
    await Promise.all(caches.map((cache, index) => {
      const key = `https://cdn.example.test/asset-${index}.css`;
      return cache.withFill(key, {requestHeaders: {}}, async ({markAcquisitionStarted}) => {
        await markAcquisitionStarted();
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 75));
        active -= 1;
        const entry = {status: 200, headers: {}, body: Buffer.alloc(256, index)};
        assert.equal(cache.store(key, entry, {requestHeaders: {}}), true);
        return entry;
      });
    }));
    const ms = performance.now() - start;
    const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
    assert.equal(manifest.entries.length, requests);
    assert.deepEqual(manifest.acquisition_barriers ?? [], []);
    return {ms, peak, manifest_bytes: Buffer.byteLength(JSON.stringify(manifest))};
  } finally {
    await fs.rm(root, {recursive: true, force: true});
  }
}

const rows = [];
for (const requests of [1, 2, 4, 8]) {
  const old = [];
  const fresh = [];
  for (let sample = 0; sample < 3; sample += 1) {
    old.push(await run(oldCache, requests));
    fresh.push(await run(newCache, requests));
  }
  rows.push({requests, old_ms: median(old.map((row) => row.ms)), new_ms: median(fresh.map((row) => row.ms)), old_peak: Math.max(...old.map((row) => row.peak)), new_peak: Math.max(...fresh.map((row) => row.peak)), manifest_bytes: fresh[0].manifest_bytes});
}
process.stdout.write(`${JSON.stringify({revision, rows}, null, 2)}\n`);
