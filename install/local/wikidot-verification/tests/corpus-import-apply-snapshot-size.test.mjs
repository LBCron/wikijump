import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  batchShellCreatePageValues,
  upsertSnapshotSql,
} from "../scripts/apply-corpus-import-manifest.mjs";
import {
  buildCorpusImportManifest,
} from "../src/corpus-import-manifest.mjs";
import {
  writeSourceBundlePage,
} from "./support/corpus-import-manifest-fixture.mjs";

test("corpus snapshot SQL preserves first-class Wikidot page size in serial and batch imports", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "corpus-size-apply-"));
  writeSourceBundlePage(root, "start", {
    source: "short local source",
    meta: {
      rating: 7,
      revisions_count: 3,
      size: 123,
    },
  });
  const [row] = buildCorpusImportManifest({
    sourceBundleRoot: root,
    sourceSite: "sandbox-for-codex",
    sourceBranch: "synchronized",
  });
  assert.equal(row.wikidot_size, 123);

  const serialSql = upsertSnapshotSql(
    { holding: { siteSlug: "sandbox-for-codex", runBranches: ["synchronized"] } },
    row,
    101,
    201,
    301,
  );
  assert.match(
    serialSql,
    /source_revision_count,\n  wikidot_size,\n  imported_rating,/u,
  );
  assert.match(serialSql, /\n  3,\n  123,\n  7,\n/u);
  assert.match(serialSql, /wikidot_size = EXCLUDED\.wikidot_size,/u);
  assert.match(serialSql, /"size": 123/u);

  const batchValues = batchShellCreatePageValues({}, [row], {
    categoryIds: new Map([["_default", 701]]),
    sourceTextEntityIds: new Set([row.source_entity_id]),
    textHash: () => "11".repeat(16),
    shellHash: () => "22".repeat(16),
  });
  assert.match(batchValues, /\n      3,\n      123,\n      7,\n/u);
  assert.match(batchValues, /"size": 123/u);
});
