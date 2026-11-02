import assert from "node:assert/strict";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import test from "node:test";

import {main as auditMirrorFixtureFiles} from "../scripts/audit-mirror-fixture-files.mjs";
import {
  buildFixtureTombstoneManifest,
  buildSeedIndex,
  buildSourceInventoryIndex,
  classifyMirrorFileRow,
} from "../src/mirror-fixture-file-audit.mjs";

const SEEDER = {
  "scp-wiki": {
    "scp-002": [
      {name: "800px-SCP002-new.jpg", path: "scp-002--800px-SCP002-new.jpg"},
      {name: "SCP.txt", path: "scp-main.ftml", overwrite: "scp-002.ftml"},
    ],
  },
};

function row(overrides = {}) {
  return {
    site_id: 6000006,
    site_slug: "scp-wiki",
    page_id: 3000000021,
    page_slug: "scp-002",
    page_from_wikidot: true,
    file_id: 22,
    name: "SCP.txt",
    file_from_wikidot: false,
    file_deleted_at: "",
    user_id: -2,
    comments: "",
    size: 5871,
    last_revision_id: 27,
    ...overrides,
  };
}

test("seed index keys site, page, and name without collisions", () => {
  const index = buildSeedIndex(SEEDER);
  assert.equal(index.size, 2);
  assert.equal(index.get("scp-wiki\u0000scp-002\u0000SCP.txt")?.path, "scp-main.ftml");
  assert.equal(index.get("scp-wiki\u0000scp-002\u0000other.txt"), undefined);
  assert.equal(index.get("scp-wiki\u0000scp-002 SCP\u0000txt"), undefined);
});

const SCP_002_INVENTORY = buildSourceInventoryIndex([
  {site_slug: "scp-wiki", page_slug: "scp-002", name: "800px-SCP002-new.jpg"},
]);

test("requires inventory absence for a fixture verdict, using SCP-002", () => {
  const seed = buildSeedIndex(SEEDER);
  const fixture = classifyMirrorFileRow(row(), seed, SCP_002_INVENTORY);
  assert.equal(fixture.verdict, "FIXTURE");
  assert.equal(fixture.seed_path, "scp-main.ftml");
  const genuine = classifyMirrorFileRow(
    row({file_id: 23, name: "800px-SCP002-new.jpg", size: 182048, last_revision_id: 28}),
    seed,
    SCP_002_INVENTORY,
  );
  assert.equal(genuine.verdict, "SEED_SOURCE_MATCH");
  const undecided = classifyMirrorFileRow(row(), seed);
  assert.equal(undecided.verdict, "UNCLASSIFIED_LOCAL");
  assert.match(undecided.reason, /no source inventory covers/);
});

test("seed match on an uncovered page fails closed", () => {
  const seed = buildSeedIndex({
    "scp-wiki": {"scp-9999": [{name: "orphan.txt", path: "orphan.txt"}]},
  });
  const classification = classifyMirrorFileRow(
    row({page_slug: "scp-9999", name: "orphan.txt"}),
    seed,
    SCP_002_INVENTORY,
  );
  assert.equal(classification.verdict, "UNCLASSIFIED_LOCAL");
});

test("keeps genuine mirror-import inventory out of repair", () => {
  const classification = classifyMirrorFileRow(
    row({
      file_id: 50000,
      name: "real-attachment.png",
      user_id: -1,
      comments: "local scp-wiki mirror attachment import from scp-wiki-translation corpus",
    }),
    buildSeedIndex(SEEDER),
  );
  assert.equal(classification.verdict, "MIRROR_IMPORT");
});

test("routes unknown local rows to human review, never repair", () => {
  const classification = classifyMirrorFileRow(
    row({file_id: 60000, name: "mystery.bin", user_id: 42, comments: "uploaded"}),
    buildSeedIndex(SEEDER),
  );
  assert.equal(classification.verdict, "UNCLASSIFIED_LOCAL");
});

test("passes through out-of-scope, tombstoned, and imported rows", () => {
  const seed = buildSeedIndex(SEEDER);
  assert.equal(
    classifyMirrorFileRow(row({page_from_wikidot: false}), seed).verdict,
    "OUT_OF_SCOPE",
  );
  assert.equal(
    classifyMirrorFileRow(row({file_deleted_at: "2026-01-01T00:00:00+00:00"}), seed).verdict,
    "ALREADY_TOMBSTONED",
  );
  assert.equal(
    classifyMirrorFileRow(row({file_from_wikidot: true}), seed).verdict,
    "IMPORTED",
  );
});

test("manifest contains only fixture rows with delete parameters", () => {
  const seed = buildSeedIndex(SEEDER);
  const classified = [
    {row: row(), classification: classifyMirrorFileRow(row(), seed, SCP_002_INVENTORY)},
    {
      row: row({file_id: 23, name: "800px-SCP002-new.jpg"}),
      classification: classifyMirrorFileRow(
        row({file_id: 23, name: "800px-SCP002-new.jpg"}),
        seed,
        SCP_002_INVENTORY,
      ),
    },
    {
      row: row({file_id: 50000, name: "real-attachment.png"}),
      classification: classifyMirrorFileRow(
        row({file_id: 50000, name: "real-attachment.png"}),
        seed,
        SCP_002_INVENTORY,
      ),
    },
  ];
  const manifest = buildFixtureTombstoneManifest(classified);
  assert.equal(manifest.dry_run, true);
  assert.equal(manifest.entry_count, 1);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].file_id, 22);
  assert.equal(manifest.entries[0].last_revision_id, 27);
  assert.equal(manifest.entries[0].seed_path, "scp-main.ftml");
  assert.match(manifest.repair_path, /ordinary file_delete/);
  assert.match(manifest.repair_path, /NOT import_wikidot_file_delete/);
});


const GENUINE_SEEDED_NAME = "800px-SCP002-new.jpg";

test("seeder-origin file present in the source inventory is not synthetic", () => {
  const classification = classifyMirrorFileRow(
    row({file_id: 23, name: GENUINE_SEEDED_NAME, size: 182048, last_revision_id: 28}),
    buildSeedIndex(SEEDER),
    SCP_002_INVENTORY,
  );
  assert.equal(classification.verdict, "SEED_SOURCE_MATCH");
  assert.notEqual(classification.verdict, "FIXTURE");
  const manifest = buildFixtureTombstoneManifest([{row: row(), classification}]);
  assert.equal(manifest.entry_count, 0);
});

test("seeder-origin file absent from the source inventory is synthetic", () => {
  const classification = classifyMirrorFileRow(
    row(),
    buildSeedIndex(SEEDER),
    SCP_002_INVENTORY,
  );
  assert.equal(classification.verdict, "FIXTURE");
  const manifest = buildFixtureTombstoneManifest([{row: row(), classification}]);
  assert.equal(manifest.entry_count, 1);
  assert.equal(manifest.entries[0].name, "SCP.txt");
});

test("no source inventory supplied fails closed for every seeder-origin file", () => {
  const seed = buildSeedIndex(SEEDER);
  const seededRows = [
    row(),
    row({file_id: 23, name: GENUINE_SEEDED_NAME, size: 182048, last_revision_id: 28}),
  ];
  const withoutEvidence = [undefined, null, buildSourceInventoryIndex(null), buildSourceInventoryIndex([])];
  for (const inventory of withoutEvidence) {
    const classified = seededRows.map((seededRow) => ({
      row: seededRow,
      classification: classifyMirrorFileRow(seededRow, seed, inventory),
    }));
    for (const {classification} of classified) {
      assert.equal(classification.verdict, "UNCLASSIFIED_LOCAL");
      assert.match(classification.reason, /no source inventory covers/);
    }
    assert.equal(buildFixtureTombstoneManifest(classified).entry_count, 0);
  }
});

test("malformed or non-array inventory input is refused, never read as absence", () => {
  const valid = {site_slug: "scp-wiki", page_slug: "scp-002", name: GENUINE_SEEDED_NAME};
  assert.throws(
    () => buildSourceInventoryIndex([{site_slug: "scp-wiki", page_slug: "scp-002"}]),
    /source inventory entry 0 is malformed/,
  );
  assert.throws(
    () => buildSourceInventoryIndex([{site_slug: "scp-wiki", page_slug: "scp-002", name: null}]),
    /malformed/,
  );
  assert.throws(
    () => buildSourceInventoryIndex([{site_slug: "scp-wiki", page_slug: "scp-002", name: "   "}]),
    /malformed/,
  );
  assert.throws(
    () => buildSourceInventoryIndex([{page_slug: "scp-002", name: GENUINE_SEEDED_NAME}]),
    /malformed/,
  );
  assert.throws(
    () => buildSourceInventoryIndex([valid, {site_slug: "scp-wiki", page_slug: "scp-002"}]),
    /source inventory entry 1 is malformed/,
  );
  assert.throws(
    () => buildSourceInventoryIndex({"scp-wiki": {"scp-002": [GENUINE_SEEDED_NAME]}}),
    /must be an array/,
  );
});

test("genuine mirror-import provenance is never FIXTURE, even when seeded", () => {
  const classification = classifyMirrorFileRow(
    row({
      user_id: -1,
      comments: "local scp-wiki mirror attachment import from scp-wiki-translation corpus",
    }),
    buildSeedIndex(SEEDER),
    SCP_002_INVENTORY,
  );
  assert.equal(classification.verdict, "MIRROR_IMPORT");
  const manifest = buildFixtureTombstoneManifest([{row: row(), classification}]);
  assert.equal(manifest.entry_count, 0);
});

test("audit CLI: no --source-inventory leaves the manifest empty", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mirror-fixture-audit-"));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  t.mock.method(console, "log", () => {});
  const paths = writeCliInputs(dir);
  assert.equal(
    await auditMirrorFixtureFiles([
      "--rows", paths.rows,
      "--seeder-files", paths.seeder,
      "--classification-out", paths.classification,
      "--manifest-out", paths.manifest,
    ]),
    0,
  );
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
  assert.equal(manifest.entry_count, 0);
  const classification = JSON.parse(readFileSync(paths.classification, "utf8"));
  assert.deepEqual(classification.verdict_counts, {UNCLASSIFIED_LOCAL: 2});
});

test("audit CLI: source inventory yields FIXTURE only for the absent name", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mirror-fixture-audit-"));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  t.mock.method(console, "log", () => {});
  const paths = writeCliInputs(dir);
  assert.equal(
    await auditMirrorFixtureFiles([
      "--rows", paths.rows,
      "--seeder-files", paths.seeder,
      "--source-inventory", paths.inventory,
      "--classification-out", paths.classification,
      "--manifest-out", paths.manifest,
    ]),
    0,
  );
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
  assert.equal(manifest.entry_count, 1);
  assert.equal(manifest.entries[0].name, "SCP.txt");
  const classification = JSON.parse(readFileSync(paths.classification, "utf8"));
  assert.deepEqual(classification.verdict_counts, {FIXTURE: 1, SEED_SOURCE_MATCH: 1});
});

test("audit CLI: a malformed inventory aborts before writing any output", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mirror-fixture-audit-"));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  t.mock.method(console, "log", () => {});
  const paths = writeCliInputs(dir, [{site_slug: "scp-wiki", page_slug: "scp-002"}]);
  await assert.rejects(
    auditMirrorFixtureFiles([
      "--rows", paths.rows,
      "--seeder-files", paths.seeder,
      "--source-inventory", paths.inventory,
      "--manifest-out", paths.manifest,
    ]),
    /malformed/,
  );
  assert.equal(existsSync(paths.manifest), false);
});

function writeCliInputs(dir, inventory = [{site_slug: "scp-wiki", page_slug: "scp-002", name: GENUINE_SEEDED_NAME}]) {
  const paths = {
    rows: join(dir, "rows.tsv"),
    seeder: join(dir, "files.json"),
    inventory: join(dir, "inventory.json"),
    classification: join(dir, "classification.json"),
    manifest: join(dir, "manifest.json"),
  };
  const tab = "\t";
  writeFileSync(
    paths.rows,
    [
      ["6000006", "scp-wiki", "3000000021", "scp-002", "t", "22", "SCP.txt", "f", "", "-2", "", "5871", "27"].join(tab),
      ["6000006", "scp-wiki", "3000000021", "scp-002", "t", "23", GENUINE_SEEDED_NAME, "f", "", "-2", "", "182048", "28"].join(tab),
      "",
    ].join("\n"),
  );
  writeFileSync(paths.seeder, JSON.stringify(SEEDER));
  writeFileSync(paths.inventory, JSON.stringify(inventory));
  return paths;
}
