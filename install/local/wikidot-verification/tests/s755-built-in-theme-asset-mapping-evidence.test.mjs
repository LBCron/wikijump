import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const artifactUrl = new URL(
  "../artifacts/s755-built-in-theme-asset-mapping-20260914.json",
  import.meta.url,
);

const ARTIFACT_SHA256 =
  "9d846ead9aaee97ff618663576e82d86273f2beb1094811a8a8d6c359b9ed3d8";

const ASSET_ORIGIN =
  "http://d3g0gp89917ko0.cloudfront.net/v--7690939296dc/common--theme";

const PANEL_ORDER = [
  1, 162746, 6651, 6258, 6650, 25, 26, 2, 3, 56, 121, 5, 9, 10, 6, 7, 8, 57,
  75, 54, 55, 58, 59, 2439, 2440, 2437, 2438, 122, 123,
];

const EXPECTED_DIRS = {
  1: ["base"],
  162746: ["bootstrap-base"],
  6651: ["base", "basic"],
  6258: ["base", "bloo"],
  6650: ["base", "bloo", "bloo-no-side-bar"],
  25: ["base", "cappuccino"],
  26: ["base", "cappuccino", "cappuccino-right"],
  2: ["base", "clean"],
  3: ["base", "clean", "clean-no-side-bar"],
  56: ["base", "co"],
  121: ["base", "co", "co-no-side-bar"],
  5: ["base", "flannel"],
  9: ["base", "flannel-nature"],
  10: ["base", "flannel-nature", "flannel-nature-no-side-bar"],
  6: ["base", "flannel", "flannel-no-side-bar"],
  7: ["base", "flannel-ocean"],
  8: ["base", "flannel-ocean", "flannel-ocean-no-side-bar"],
  57: ["base", "flower-blossom"],
  75: ["base", "flower-blossom", "flower-blossom-no-side-bar"],
  54: ["base", "gila"],
  55: ["base", "gila", "gila-no-side-bar"],
  58: ["base", "localize"],
  59: ["base", "localize", "localize-no-side-bar"],
  2439: ["base", "shiny"],
  2440: ["base", "shiny", "shiny-no-side-bar"],
  2437: ["base", "webbish2"],
  2438: ["base", "webbish2", "webbish2-no-side-bar"],
  122: ["base", "webbish"],
  123: ["base", "webbish", "webbish-no-side-bar"],
};

async function readArtifact() {
  const bytes = await readFile(artifactUrl);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    ARTIFACT_SHA256,
    "retained built-in theme mapping evidence must be byte-identical to the sealed capture summary",
  );
  return JSON.parse(bytes.toString("utf8"));
}

test("the summary pins the sealed authenticated capture provenance", async () => {
  const artifact = await readArtifact();

  assert.equal(artifact.schema, "wikijump.s755_built_in_theme_asset_mapping.v1");
  assert.equal(artifact.site, "sandbox-for-codex");
  assert.equal(artifact.run_id, "ef66413d-35c3-4d7d-bf5c-c6d5767cb6e8");
  assert.equal(
    artifact.authoritative_seam,
    "authenticated_document_fetch (x-wikidot-static-cache: BYPASS)",
  );
  assert.equal(artifact.credentials_persisted, false);
  assert.deepEqual(artifact.source_artifacts, [
    {
      role: "verdict",
      path: "/home/roku/wjlab/evidence/s755-theme-assets-20260914-r1/theme-mapping-verdict.json",
      sha256: "8435bb58441f042907f358772f4cd264d598c23a6ce9ae25fc6653551a5a3e31",
    },
    {
      role: "receipt",
      path: "/home/roku/wjlab/evidence/s755-theme-assets-20260914-r1/mapping-receipt.json",
      sha256: "795b4ab5393a10b57d62abcf594e9143de659c4d8e208bd1fc875846f5be8704",
    },
  ]);
  assert.equal(artifact.emission.asset_origin, ASSET_ORIGIN);
  assert.equal(
    artifact.emission.form,
    'inline @import inside <style type="text/css" id="internal-style">',
  );
});

test("every built-in id maps to its exact ordered versioned asset URL set", async () => {
  const artifact = await readArtifact();

  assert.deepEqual(artifact.site_custom_theme_ids, [
    8248876, 8248877, 8248878, 8248879, 8248880, 8248881, 8248882, 8248883,
    8248884, 8248885, 8248886, 8248887, 8248888,
  ]);

  const mapping = artifact.built_in_theme_mapping;
  assert.equal(mapping.length, 29);
  assert.deepEqual(
    mapping.map(({ theme_id: id }) => id),
    PANEL_ORDER,
    "the mapping keeps the appearance panel order",
  );
  for (const entry of mapping) {
    const dirs = EXPECTED_DIRS[entry.theme_id];
    assert.ok(dirs, `unknown built-in id ${entry.theme_id}`);
    assert.deepEqual(entry.theme_dirs, dirs, `dirs for ${entry.theme_id}`);
    assert.deepEqual(
      entry.theme_urls,
      dirs.map((dir) => `${ASSET_ORIGIN}/${dir}/css/style.css`),
      `urls for ${entry.theme_id}`,
    );
    assert.match(entry.internal_style_sha256, /^[0-9a-f]{64}$/u);
    assert.equal(
      artifact.site_custom_theme_ids.includes(entry.theme_id),
      false,
      "site custom theme ids are not built-in themes",
    );
  }

  assert.equal(
    mapping.find(({ theme_id: id }) => id === 1).internal_style_sha256,
    "b2ecb0f12af4596dbad1526bf2713b6953ee53cfc4b5c379a70e590371bf00e7",
  );
  assert.deepEqual(
    mapping.find(({ theme_id: id }) => id === 6651).theme_urls,
    [
      `${ASSET_ORIGIN}/base/css/style.css`,
      `${ASSET_ORIGIN}/basic/css/style.css`,
    ],
  );
});

test("the capture restored the run-owned category and left no mutation active", async () => {
  const artifact = await readArtifact();

  assert.deepEqual(artifact.restore, {
    save_status: "ok",
    save_http_status: 200,
    requested: { theme_default: true, theme_id: 1, theme_external_url: "" },
    stored_theme_default: true,
    stored_theme_id: 1,
    stored_theme_external_url: "",
    matches_baseline: true,
  });
  assert.deepEqual(artifact.cleanup, {
    mutation_left_active: false,
    restored: true,
  });
  assert.equal(artifact.variant_investigation.triggered, false);
});

test("the capture honors the request gate and records pacing", async () => {
  const artifact = await readArtifact();

  assert.deepEqual(artifact.request_gate, {
    interval_ms: 4000,
    grant_count: 198,
    enforcement_failed: false,
  });
});
