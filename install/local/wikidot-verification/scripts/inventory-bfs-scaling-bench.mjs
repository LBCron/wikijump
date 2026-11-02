import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { buildDocumentationInventory } from "../src/listpages-campaign-inventory.mjs";
import { makeCorpus } from "./make-inventory-bench-corpus.mjs";

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

for (const [pages, fanIn] of [
  [200, 20],
  [400, 20],
  [800, 20],
  [1600, 20]
]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wj-inv-bench-"));
  const docsRoot = path.join(root, "pages");
  await fs.mkdir(docsRoot, { recursive: true });
  await makeCorpus({ docsRoot, pageCount: pages, fanIn });

  const ms = await medianMs(() => buildDocumentationInventory({ docsRoot }));

  const inventory = await buildDocumentationInventory({ docsRoot });
  const edgeCount = inventory.references.length;
  const docCount = inventory.summary.inspected_document_count;

  assert.ok(docCount > 0, "fixture must produce documents");
  assert.equal(docCount, inventory.documents.length);

  rows.push({ pages, fanIn, docCount, edges: edgeCount, ms });
  process.stderr.write(
    `${JSON.stringify({ pages, fanIn, docCount, edges: edgeCount, ms })}\n`
  );

  await fs.rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
