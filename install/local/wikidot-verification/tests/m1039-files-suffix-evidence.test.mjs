import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const artifactUrl = new URL(
  "../artifacts/m1039-files-suffix-live-20260914.json",
  import.meta.url,
);

const ARTIFACT_SHA256 =
  "e91d5f3e58d8fc3e8e605abb768308182377e399877b4af51fd11962d932b228";

async function readArtifact() {
  const bytes = await readFile(artifactUrl);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    ARTIFACT_SHA256,
    "retained Files suffix evidence must be byte-identical to the sealed capture summary",
  );
  return JSON.parse(bytes.toString("utf8"));
}

test("the retained summary is bound to the sealed live run and receipt", async () => {
  const artifact = await readArtifact();

  assert.equal(artifact.schema, "wikijump.m1039_files_suffix_live.v1");
  assert.equal(artifact.site, "sandbox-for-codex");
  assert.equal(artifact.run_id, "m1039-files-suffix-20260914-r1");
  assert.deepEqual(artifact.source_artifact, {
    path: "/home/roku/wjlab/evidence/m1039-files-suffix-20260914-r1/artifact.json",
    sha256: "ed93e3c9024f243c52552c3c138653a7b9bcfd612b80aad875186c83e64d01b9",
  });
  assert.deepEqual(artifact.source_receipt, {
    path: "/home/roku/wjlab/evidence/m1039-files-suffix-20260914-r1/receipt.json",
    sha256: "77c1d2754feeb88f6277ad536e8160a5256c35c4d24570c666bccf89b091951a",
  });
  assert.equal(artifact.credentials_in_evidence, false);
});

test("saved Files container, refresh function, and selector share one suffix", async () => {
  const artifact = await readArtifact();
  const contract = artifact.container_contract;

  assert.equal(contract.container_element_prefix, '<div id="files-N">');
  assert.equal(contract.container_class, null);
  assert.equal(contract.empty_text, "No files attached to this page.");
  assert.equal(contract.refresh_function, "updateFileSimpleListN(pageNo)");
  assert.equal(contract.refresh_module, "files/PageFilesSimpleModule");
  assert.equal(contract.refresh_selector, "containerElId = 'files-N'");
  assert.match(contract.page_identity, /real saved page id/u);
  assert.match(contract.page_identity, /never the suffix/u);
  assert.match(contract.manage_attachments, /class="manage-attachments-link"/u);
  assert.match(
    contract.manage_attachments,
    /WIKIDOT\.page\.listeners\.filesClick\(null\)/u,
  );
  assert.equal(
    contract.suffix_shape,
    "unpadded decimal integer; observed 4 to 6 digits",
  );
  assert.equal(contract.suffix_generator, "not established by this evidence");
});

test("the suffix is fresh, opaque, and independent of page identity", async () => {
  const artifact = await readArtifact();
  const units = artifact.observable_evidence_units;

  assert.equal(units.container_observations, 19);
  assert.equal(units.distinct_suffixes, 19);
  assert.equal(units.pages, 4);
  assert.equal(units.fresh_renders, 17);
  assert.equal(units.same_page_distinct_suffixes_empty_page, 8);
  assert.equal(units.min_numeric, 8856);
  assert.equal(units.max_numeric, 985748);
  assert.equal(units.min_digits, 4);
  assert.equal(units.max_digits, 6);

  const suffixes = artifact.observed_suffixes;
  assert.equal(suffixes.length, units.distinct_suffixes);
  assert.equal(new Set(suffixes).size, suffixes.length);
  for (const suffix of suffixes) {
    assert.match(String(suffix), /^[1-9][0-9]*$/u, `${suffix} is unpadded decimal`);
  }
  assert.equal(Math.min(...suffixes), units.min_numeric);
  assert.equal(Math.max(...suffixes), units.max_numeric);
});

test("each Files module in one render owns its own suffix", async () => {
  const artifact = await readArtifact();

  assert.equal(artifact.two_module_pairs.length, 2);
  for (const pair of artifact.two_module_pairs) {
    assert.equal(pair.length, 2);
    assert.notEqual(
      pair[0],
      pair[1],
      "two Files modules in one render must not share a suffix",
    );
    for (const suffix of pair) {
      assert.ok(
        artifact.observed_suffixes.includes(suffix),
        `${suffix} is part of the retained observation table`,
      );
    }
  }
  assert.deepEqual(artifact.retained_live_cross_check, {
    page_id: 1956155,
    suffix: 325178,
  });
});

test("the observed page identity and generator gaps remain recorded", async () => {
  const artifact = await readArtifact();

  assert.deepEqual(
    artifact.counterexamples.map((entry) => entry.hypothesis),
    [
      "N equals the page id",
      "N is stable for a saved page or revision",
      "N follows the module ordinal",
      "N is derived from the page source or file presence",
    ],
  );
  assert.ok(
    artifact.counterexamples.every((entry) => entry.observed === false),
    "every counterexample records that the hypothesis was not observed",
  );
  assert.match(artifact.missing_observation, /generator is not established/u);
  assert.deepEqual(artifact.cleanup, {
    pages_deleted: 5,
    files_deleted: 1,
    verified: true,
  });
});
