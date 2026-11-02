import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildDocumentationInventory as currentInventory } from "../src/listpages-campaign-inventory.mjs";
import { makeCorpus } from "./make-inventory-bench-corpus.mjs";

const baselineRevision = process.env.BASELINE_REVISION;
let buildDocumentationInventory = currentInventory;
if (baselineRevision) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = path.resolve(scriptDir, "../../../..");
  const source = execFileSync(
    "git",
    ["show", `${baselineRevision}:install/local/wikidot-verification/src/listpages-campaign-inventory.mjs`],
    { cwd: repositoryRoot, encoding: "utf8" }
  );
  const readerUrl = pathToFileURL(path.resolve(scriptDir, "../src/corpus-file-reader.mjs"));
  const baselineSource = source.replace('from "./corpus-file-reader.mjs"', `from "${readerUrl.href}"`);
  assert.notEqual(baselineSource, source, "baseline import must be rebound");
  const baselineUrl = `data:text/javascript;base64,${Buffer.from(baselineSource).toString("base64")}`;
  ({ buildDocumentationInventory } = await import(baselineUrl));
}

const medianMs = async (fn, samples = 5) => {
  await fn();
  const times = [];
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  return Number(times[Math.floor(times.length / 2)].toFixed(2));
};

const rows = [];

const SCALE = process.env.SCALE ?? "full";

const SERIES = {
  full: [
    [400, 20],
    [400, 40],
    [400, 80],
    [800, 160],
    [1600, 320]
  ],
  small: [
    [400, 20],
    [400, 40],
    [400, 80]
  ]
};

for (const [pages, fanIn] of SERIES[SCALE] ?? SERIES.full) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wj-inv-edge-bench-"));
  const docsRoot = path.join(root, "pages");
  await fs.mkdir(docsRoot, { recursive: true });
  await makeCorpus({ docsRoot, pageCount: pages, fanIn });

  const ms = await medianMs(() => buildDocumentationInventory({ docsRoot }));
  const inventory = await buildDocumentationInventory({ docsRoot });
  const edges = inventory.references.length;
  const docCount = inventory.summary.inspected_document_count;

  assert.ok(edges > 0, "fixture must produce references");
  assert.equal(docCount, inventory.documents.length);

  rows.push({ pages, fanIn, docCount, edges, ms });
  process.stderr.write(
    `${JSON.stringify({ pages, fanIn, docCount, edges, ms })}\n`
  );

  await fs.rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
