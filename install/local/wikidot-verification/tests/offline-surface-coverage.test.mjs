import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {extractDeclaredPublicTests} from "../../../../scripts/lib/wikidot-implementation-ledger.mjs";
import {
  CAMPAIGN_ONLY_MIGRATED_COUNT,
  FINAL_ZERO_SURFACE_COUNT,
  loadOfflineSurfaceCoverage,
  verifyCoverageAnchorFiles,
} from "../src/offline-surface-coverage.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, "..");
const repositoryRoot = path.resolve(packageRoot, "../../..");
const fixturePath = path.join(
  packageRoot,
  "fixtures/offline-compatibility/final-zero-surface-coverage.json",
);

test("final-zero 900-surface denominator has portable offline ownership", async () => {
  const fixture = await loadOfflineSurfaceCoverage(fixturePath);
  assert.equal(fixture.rows.length, FINAL_ZERO_SURFACE_COUNT);
  assert.equal(fixture.counts.total, FINAL_ZERO_SURFACE_COUNT);
  assert.equal(
    fixture.rows.filter((row) => row.migrated_from_campaign_only).length,
    CAMPAIGN_ONLY_MIGRATED_COUNT,
  );
  assert.equal(fixture.final_zero.denominator_sha256, "17f8099e0a3afc7ae4ece536b9dc57ac4388eb53de5a8c69db0652ce9e6b0192");
  assert.equal(fixture.final_zero.reconciled_ledger_sha256, "c71e7b17ec5607efe3eca046fb902440ac98b2932e6d305fb11d4d0cbf214fe8");
});

test("every frozen surface anchor resolves inside the repository", async () => {
  const fixture = await loadOfflineSurfaceCoverage(fixturePath);
  const result = await verifyCoverageAnchorFiles(fixture, repositoryRoot);
  assert.equal(result.status, "pass", JSON.stringify(result.missing, null, 2));
  assert.deepEqual(result.unresolvedNamedTests, []);
  assert.deepEqual(result.unresolvedCommands, []);
  assert.deepEqual(result.unresolvedAnchors, []);
  assert.deepEqual(result.rowsWithoutExecutableOwner, []);
  assert.deepEqual(result.rowsWithoutNamedTestOwner, []);
  assert.ok(result.checked > 100, `expected broad executable coverage, got ${result.checked}`);
});

test("a row owned only by a bare test file must name a specific test", async () => {
  const result = await verifyCoverageAnchorFiles(
    {
      rows: [
        {
          surface_id: "surface:99999996",
          anchors: ["deepwell/tests/page.rs"],
        },
      ],
    },
    repositoryRoot,
  );
  assert.equal(result.status, "fail");
  assert.deepEqual(result.rowsWithoutExecutableOwner, []);
  assert.deepEqual(
    result.rowsWithoutNamedTestOwner.map((row) => row.surface_id),
    ["surface:99999996"],
  );
});

test("a named test anchor resolves against declared tests, including Rust submodules", async () => {
  const result = await verifyCoverageAnchorFiles(
    {
      rows: [
        {
          surface_id: "surface:99999997",
          anchors: [
            "deepwell/tests/page.rs#listpages_checkbox_and_wiki_variables_match_live_wikidot",
          ],
        },
      ],
    },
    repositoryRoot,
  );
  assert.equal(result.status, "pass");
  assert.deepEqual(result.rowsWithoutExecutableOwner, []);
  assert.deepEqual(result.unresolvedNamedTests, []);
});

test("a bogus test name in a valid test file rejects a row with no other owner", async () => {
  const bogus = "deepwell/tests/page.rs#not_a_real_listpages_regression";
  const result = await verifyCoverageAnchorFiles(
    {rows: [{surface_id: "surface:99999998", anchors: [bogus]}]},
    repositoryRoot,
  );
  assert.equal(result.status, "fail");
  assert.deepEqual(result.missing, []);
  assert.deepEqual(
    result.rowsWithoutExecutableOwner.map((row) => row.surface_id),
    ["surface:99999998"],
  );
  assert.deepEqual(
    result.unresolvedNamedTests.map((entry) => entry.anchor),
    [bogus],
  );
  assert.equal(
    result.unresolvedNamedTests[0].reason,
    "not-a-declared-runnable-test",
  );
});


test("source fragments cannot masquerade as executable named-test owners", async () => {
  const anchor = "deepwell/src/services/filter/structs.rs#impl";
  const result = await verifyCoverageAnchorFiles(
    {rows: [{surface_id: "surface:99999994", anchors: [anchor]}]},
    repositoryRoot,
  );
  assert.equal(result.status, "fail");
  assert.deepEqual(result.unresolvedNamedTests.map((entry) => entry.anchor), [anchor]);
  assert.equal(result.rowsWithoutExecutableOwner.length, 1);
});

test("a bogus named claim still fails when a bare test file also owns the row", async () => {
  const bogus = "deepwell/src/services/filter/matcher.rs#definitely_not_a_test";
  const result = await verifyCoverageAnchorFiles(
    {
      rows: [
        {
          surface_id: "surface:99999993",
          anchors: [bogus, "deepwell/src/services/filter/matcher.rs"],
        },
      ],
    },
    repositoryRoot,
  );
  assert.equal(result.status, "fail");
  assert.deepEqual(result.unresolvedNamedTests.map((entry) => entry.anchor), [bogus]);
  assert.deepEqual(result.rowsWithoutExecutableOwner, []);
});

test("a real test name with an invented qualified suffix is rejected", async () => {
  const anchor =
    "deepwell/src/services/filter/matcher.rs#filter_summary_debug_redacts_private_filter_details::bogus";
  const result = await verifyCoverageAnchorFiles(
    {rows: [{surface_id: "surface:99999992", anchors: [anchor]}]},
    repositoryRoot,
  );
  assert.equal(result.status, "fail");
  assert.deepEqual(result.unresolvedNamedTests.map((entry) => entry.anchor), [anchor]);
});

test("an unscoped cargo filter does not establish executable ownership", async () => {
  const result = await verifyCoverageAnchorFiles(
    {
      rows: [
        {
          surface_id: "surface:99999991",
          anchors: ["cargo test definitely_nonexistent_test"],
        },
      ],
    },
    repositoryRoot,
  );
  assert.equal(result.status, "fail");
  assert.equal(result.rowsWithoutExecutableOwner.length, 1);
});

test("Rust test ownership follows declared modules instead of neighboring files", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wikijump-coverage-modules-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, "deepwell/tests/root"), {recursive: true});
  await fs.writeFile(
    path.join(root, "deepwell/tests/root.rs"),
    '#[path = "root/declared.rs"]\nmod declared;\n',
  );
  await fs.writeFile(
    path.join(root, "deepwell/tests/root/declared.rs"),
    "#[test]\nfn declared_case() {}\n",
  );
  await fs.writeFile(
    path.join(root, "deepwell/tests/root/neighbor.rs"),
    "#[test]\nfn neighboring_but_unreachable_case() {}\n",
  );

  const declared = await verifyCoverageAnchorFiles(
    {
      rows: [
        {
          surface_id: "surface:99999990",
          anchors: ["deepwell/tests/root.rs#declared_case"],
        },
      ],
    },
    root,
  );
  assert.equal(declared.status, "pass");

  const neighbor = await verifyCoverageAnchorFiles(
    {
      rows: [
        {
          surface_id: "surface:99999989",
          anchors: ["deepwell/tests/root.rs#neighboring_but_unreachable_case"],
        },
      ],
    },
    root,
  );
  assert.equal(neighbor.status, "fail");
  assert.equal(neighbor.unresolvedNamedTests.length, 1);
});

test("declared-test extraction is not desynchronized by regex literals that contain quotes", () => {
  const source = [
    "import test from \"node:test\";",
    "test(\"before regex\", () => {",
    "  const pattern = /'nonce-([^']+)'/u;",
    "  assert.match(\"x\", pattern);",
    "});",
    "test(\"after regex\", () => {});",
  ].join("\n");
  const declared = extractDeclaredPublicTests("example.test.js", source);
  assert.deepEqual([...declared].sort(), ["after regex", "before regex"]);
});

test("declared-test extraction recognizes regex literals after return without treating division as regex", () => {
  const afterReturn = extractDeclaredPublicTests(
    "example.test.js",
    'function pattern() { return /\'/; }\ntest("after return regex", () => {});',
  );
  assert.deepEqual([...afterReturn], ["after return regex"]);

  const afterDivision = extractDeclaredPublicTests(
    "example.test.js",
    'const quotient = left / right;\ntest("after division", () => {});',
  );
  assert.deepEqual([...afterDivision], ["after division"]);
});

test("campaign-only acceptance is no longer represented only by WJLab artifacts", async () => {
  const fixture = await loadOfflineSurfaceCoverage(fixturePath);
  const migrated = fixture.rows.filter((row) => row.migrated_from_campaign_only);
  assert.equal(migrated.length, CAMPAIGN_ONLY_MIGRATED_COUNT);
  for (const row of migrated) {
    assert.ok(row.offline_lanes.length > 0, row.surface_id);
    assert.ok(row.anchors.length > 0, row.surface_id);
    assert.equal(row.anchors.some((anchor) => anchor.startsWith("artifact:")), false);
  }
});
