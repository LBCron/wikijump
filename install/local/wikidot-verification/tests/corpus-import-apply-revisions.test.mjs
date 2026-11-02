import assert from "node:assert/strict";
import test from "node:test";

import {
  holdingForImport,
  isForeignSource,
  isSameSnapshotProvenance,
} from "../src/corpus-import-storage.mjs";
import { assertForeignStoragePlan } from "../scripts/apply-corpus-import-manifest.mjs";

// Holding fixture: scp-wiki, whose persisted import runs cover the en/ko
// corpus branches (same shape as corpus-import-storage.test.mjs).
const PERSISTED = { siteSlug: "scp-wiki", runBranches: ["en", "ko"] };

function row(overrides = {}) {
  return {
    source_site: "scpko",
    source_branch: "ko",
    fullname: "info:start",
    attachments: [],
    ...overrides,
  };
}

test("holdingForImport never admits manifest branch strings", () => {
  // The branch set an import classifies with is the persisted run branches
  // plus the operator-declared --source-branch. Branch strings carried by
  // the manifest being applied are data: if one is spelled like a site,
  // admitting it would reclassify that site's rows as the holding site's
  // own and bind their revisions by fullname onto colliding own pages.
  const holding = holdingForImport(PERSISTED, "en");
  assert.deepEqual(holding.runBranches, ["en", "ko"]);
  assert.equal(isForeignSource(holding, "scpko"), true);
  assert.equal(isForeignSource(holding, "en"), false);
});

test("holdingForImport seeds the declared branch for a fresh site", () => {
  const holding = holdingForImport({ siteSlug: "scp-jp", runBranches: [] }, "jp");
  assert.equal(isForeignSource(holding, "jp"), false, "the declared corpus branch is the site's own");
  assert.equal(isForeignSource(holding, "scp-jp"), false, "the site's own slug is always own");
  assert.equal(isForeignSource(holding, "scpko"), true);
});

function planArgs(holding) {
  return {
    createMode: "db",
    holding,
    rerenderAfterDbCreate: false,
    attachmentsOnlyExisting: false,
    assumeEmptyDbImport: false,
    skipRerender: true,
    skipExistingDone: false,
    adoptExisting: false,
    replaceExisting: false,
    textHashBatchCommand: null,
    skipAttachments: true,
    attachmentCreateMode: "rpc",
  };
}

test("assertForeignStoragePlan rejects a branch spelled like its foreign site", () => {
  // Recording such a run would persist the site name as an import-run
  // branch, after which every later apply (and Deepwell itself, which
  // classifies by the same branch set) treats that site's rows as own.
  const holding = holdingForImport(PERSISTED, "en");
  assert.throws(
    () => assertForeignStoragePlan(planArgs(holding), [row({ source_branch: "scpko" })]),
    /source_branch equals its source_site/,
  );
});

test("assertForeignStoragePlan accepts ordinary foreign and own provenances", () => {
  const holding = holdingForImport(PERSISTED, "en");
  assert.doesNotThrow(
    () => assertForeignStoragePlan(planArgs(holding), [row()]),
    "scpko rows on the ko branch are ordinary foreign rows",
  );
  assert.doesNotThrow(
    () => assertForeignStoragePlan(planArgs(holding), [row({ source_site: "en", source_branch: "en" })]),
    "the en corpus spells its branch like its source_site and is own",
  );
  const with05 = holdingForImport({ siteSlug: "scp-wiki", runBranches: ["05command", "en"] }, "en");
  assert.doesNotThrow(
    () => assertForeignStoragePlan(planArgs(with05), [row({ source_site: "05command", source_branch: "05command" })]),
    "a branch/site pair already in the persisted runs is established provenance",
  );
});

test("isSameSnapshotProvenance pins the revision-binding guard", () => {
  // The apply refuses to write a row onto an existing page whose snapshot
  // provenance differs from the row in both site and branch — the shape of
  // the foreign-revision overwrite, where scpko revisions landed on the
  // en pages info:start, component:image-block and
  // component:image-block-base.
  const enPage = { source_site: "en", source_branch: "en" };
  assert.equal(isSameSnapshotProvenance(enPage, row()), false, "a scpko row must never rewrite an en page");
  assert.equal(isSameSnapshotProvenance(enPage, row({ source_branch: "scpko" })), false);
  assert.equal(
    isSameSnapshotProvenance(enPage, row({ source_site: "scp-wiki", source_branch: "en" })),
    true,
    "the other spelling of the same corpus still matches by branch",
  );
  assert.equal(
    isSameSnapshotProvenance({ source_site: "scpko", source_branch: "ko" }, row({ source_branch: "ko-2026" })),
    true,
    "same site, renamed branch still matches by site",
  );
  assert.equal(isSameSnapshotProvenance(null, row()), true, "a snapshot-less page has no provenance to protect");
});
