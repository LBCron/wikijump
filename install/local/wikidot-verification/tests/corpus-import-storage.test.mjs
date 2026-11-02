import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertForeignStoragePlan,
  upsertSnapshotSql,
} from "../scripts/apply-corpus-import-manifest.mjs";
import {
  assertNotReservedFullname,
  classifyForeignSnapshotHolders,
  isForeignSource,
  parseHoldingSite,
  storageSlug,
} from "../src/corpus-import-storage.mjs";

const SCP_WIKI = { siteSlug: "scp-wiki", runBranches: ["05command", "en", "ko"] };
const ENTITY = "5a8f1709-bd8b-49e4-8e29-80c185d6ad96";

function row(overrides = {}) {
  return {
    source_site: "scpko",
    source_branch: "ko",
    fullname: "theme:fogwalker",
    source_entity_id: ENTITY,
    attachments: [],
    ...overrides,
  };
}

test("foreign classification matches Deepwell's foreign_snapshot_exclusion_sql", () => {
  assert.equal(isForeignSource(SCP_WIKI, "scp-wiki"), false, "the site's own slug is own");
  assert.equal(isForeignSource(SCP_WIKI, "en"), false, "a branch the site imported is own");
  assert.equal(
    isForeignSource(SCP_WIKI, "05command"),
    false,
    "a source named like one of the site's run branches reads as own",
  );
  assert.equal(isForeignSource(SCP_WIKI, "scpko"), true, "another Wikidot site is foreign");
  assert.equal(isForeignSource(SCP_WIKI, "scp-int"), true);
});

test("foreign rows are stored under their source site, own rows at their fullname", () => {
  assert.equal(storageSlug(SCP_WIKI, row()), "_foreign:scpko:theme:fogwalker");
  assert.equal(
    storageSlug(SCP_WIKI, row({ source_site: "scp-int", source_branch: "int" })),
    "_foreign:scp-int:theme:fogwalker",
    "one fullname held from two source sites gets two storage slugs",
  );
  assert.equal(storageSlug(SCP_WIKI, row({ source_site: "en", fullname: "info:start" })), "info:start");
  assert.equal(
    storageSlug(SCP_WIKI, row({ fullname: "art:re:goi-arts" })),
    "_foreign:scpko:art:re:goi-arts",
  );
});

test("the storage prefix is reserved", () => {
  assert.throws(() => assertNotReservedFullname(row({ fullname: "_foreign:scpko:x" })), /reserved/u);
  assert.doesNotThrow(() => assertNotReservedFullname(row({ fullname: "_template" })));
});

test("holding site output parses and rejects a missing site", () => {
  assert.deepEqual(
    parseHoldingSite('{"siteSlug": "scp-wiki", "runBranches": ["en", "ko"]}'),
    { siteSlug: "scp-wiki", runBranches: ["en", "ko"] },
  );
  assert.throws(() => parseHoldingSite('{"siteSlug": null, "runBranches": []}'), /not found/u);
});

function holder(overrides = {}) {
  return {
    page_id: 3000130373,
    site_id: 6000006,
    slug: "theme:fogwalker",
    page_category_id: 41,
    revision_id: 77,
    source_fullname: "theme:fogwalker",
    source_entity_id: ENTITY,
    ...overrides,
  };
}

test("a foreign row with no holder is created at its storage slug", () => {
  assert.deepEqual(classifyForeignSnapshotHolders(6000006, row(), ""), { kind: "absent" });
  assert.deepEqual(classifyForeignSnapshotHolders(6000006, row(), "null"), { kind: "absent" });
});

test("a foreign row already held on this site is reused in place, keeping a legacy natural slug", () => {
  const result = classifyForeignSnapshotHolders(6000006, row(), JSON.stringify([holder()]));
  assert.equal(result.kind, "held");
  assert.deepEqual(result.page, { page_id: 3000130373, slug: "theme:fogwalker", page_category_id: 41, revision_id: 77 });
});

test("foreign rows whose identity moved are refused, never adopted", () => {
  const classify = (holders) => classifyForeignSnapshotHolders(6000006, row(), JSON.stringify(holders)).reason;
  assert.equal(classify([holder({ site_id: 6000004 })]), "foreign_snapshot_held_by_other_site");
  assert.equal(
    classify([holder({ source_entity_id: "00000000-0000-4000-8000-000000000000" })]),
    "foreign_snapshot_identity_changed",
    "recreated on Wikidot: same fullname, new entity",
  );
  assert.equal(
    classify([holder({ source_fullname: "theme:fogwalker-old" })]),
    "foreign_snapshot_identity_changed",
    "renamed on Wikidot: same entity, new fullname",
  );
  assert.equal(
    classify([holder(), holder({ page_id: 2, source_fullname: "theme:other" })]),
    "foreign_snapshot_identity_split",
  );
});

const PLAN_ARGS = { holding: SCP_WIKI, createMode: "db", textHashBatchCommand: "hash" };

test("foreign rows are only accepted by the serial DB import without attachments", () => {
  assert.doesNotThrow(() => assertForeignStoragePlan(PLAN_ARGS, [row()]));
  assert.throws(() => assertForeignStoragePlan({ ...PLAN_ARGS, createMode: "rpc" }, [row()]), /--create-mode db/u);
  assert.throws(
    () => assertForeignStoragePlan({ ...PLAN_ARGS, rerenderAfterDbCreate: true }, [row()]),
    /never served/u,
  );
  assert.throws(
    () => assertForeignStoragePlan({ ...PLAN_ARGS, attachmentsOnlyExisting: true }, [row()]),
    /attachments-only-existing/u,
  );
  assert.throws(
    () => assertForeignStoragePlan(PLAN_ARGS, [row({ attachments: [{ filename: "bg.jpg" }] })]),
    /with attachments/u,
  );
  assert.throws(
    () => assertForeignStoragePlan(
      { ...PLAN_ARGS, assumeEmptyDbImport: true, skipRerender: true, skipAttachments: true },
      [row()],
    ),
    /batched/u,
  );
  assert.doesNotThrow(
    () => assertForeignStoragePlan({ ...PLAN_ARGS, createMode: "rpc" }, [row({ source_site: "en" })]),
    "own rows keep every existing mode",
  );
});

function snapshotSql(holding, overrides) {
  const fixture = row(overrides);
  const metaPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "corpus-storage-")), "meta.json");
  fs.writeFileSync(metaPath, "{}");
  return upsertSnapshotSql({ holding }, {
    ...fixture,
    meta_path: metaPath,
    meta_sha256: crypto.createHash("sha256").update("{}").digest("hex"),
    source_sha256: "00".repeat(32),
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    revisions: 1,
    rating: 0,
    comments: 0,
    tags: [],
  }, 3000130373, 77, 449);
}

test("the snapshot upsert never moves a page between a foreign and another source", () => {
  const foreign = snapshotSql(SCP_WIKI, {});
  assert.match(
    foreign,
    /WHERE wikidot_page_snapshot\.source_site = EXCLUDED\.source_site\n   OR \(FALSE AND/u,
    "a foreign row only updates a snapshot of the same source site",
  );
  assert.match(foreign, /RAISE EXCEPTION 'page % already holds a snapshot of another source/u);
  assert.match(foreign, /WHERE page_id = 3000130373 AND source_site = 'scpko'\n/u);

  const own = snapshotSql(SCP_WIKI, { source_site: "en", source_branch: "en", fullname: "info:start" });
  assert.match(
    own,
    /OR \(TRUE AND wikidot_page_snapshot\.source_site IN \('scp-wiki', '05command', 'en', 'ko'\)\)/u,
    "an own row may replace another own source of the same site",
  );
});
