import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const artifactUrl = new URL(
  "../artifacts/m756-windows-tile-live-20260914.json",
  import.meta.url,
);

const ARTIFACT_SHA256 =
  "20be4e14d8addc6340664e0ad765bb0eec85dcf047dbb0c7f1c203a34e3396d7";

async function readArtifact() {
  const bytes = await readFile(artifactUrl);
  assert.equal(
    createHash("sha256").update(bytes).digest("hex"),
    ARTIFACT_SHA256,
    "retained Windows tile evidence must be byte-identical to the sealed capture summary",
  );
  return JSON.parse(bytes.toString("utf8"));
}

test("configured Windows tile declares the exact live meta and local route", async () => {
  const artifact = await readArtifact();

  assert.equal(artifact.schema, "wikijump.m756_windows_tile_live_observation.v1");
  assert.equal(artifact.site, "sandbox-for-codex");
  assert.equal(
    artifact.head_declaration,
    '<meta name="msapplication-TileImage" content="/local--wp8icon/wp8icon.png"/>',
  );
  assert.equal(
    artifact.route.url,
    "http://sandbox-for-codex.wikidot.com/local--wp8icon/wp8icon.png",
  );
  assert.deepEqual(artifact.head_declaration_order, {
    after: "apple-touch-icons",
    before: null,
  });
});

test("the Windows tile route serves the uploaded bytes for GET and HEAD", async () => {
  const artifact = await readArtifact();

  assert.equal(artifact.route.get.status, 200);
  assert.equal(artifact.route.get.content_type, "image/png; charset=utf-8");
  assert.equal(artifact.route.get.content_length, "287");
  assert.equal(artifact.route.get.body_bytes, 287);
  assert.equal(
    artifact.route.get.body_sha256,
    "56e27a06d92ab9c0b9a19e5e05e927321a2f44e3e16d84fa6e149ecd3224ba01",
  );
  assert.equal(
    artifact.route.get.body_sha256,
    artifact.tile_source_sha256,
    "the served tile bytes are the uploaded source bytes",
  );
  assert.equal(artifact.route.get.etag, '"49bc4af5fbdbc0fa2b2e30f3fe6e80af"');
  assert.equal(
    artifact.route.get.cache_control,
    "maxage=3600, public max-age=3600",
  );

  assert.equal(artifact.route.head.status, 200);
  assert.equal(artifact.route.head.content_type, "image/png; charset=utf-8");
  assert.equal(artifact.route.head.content_length, "287");
});

test("unconfigured and restored sites keep the negative control", async () => {
  const artifact = await readArtifact();

  assert.deepEqual(artifact.negative_control, {
    before_head_has_msapplication: false,
    after_revert_head_has_msapplication: false,
    head_elements_equal_after_revert: true,
  });
});

test("the mutation is cleaned up and leaves no active tile", async () => {
  const artifact = await readArtifact();

  assert.deepEqual(artifact.cleanup, {
    delete_response_status: "ok",
    public_meta_absent_after_revert: true,
    mutation_left_active: false,
  });
  assert.equal(artifact.credentials_in_evidence, false);
  assert.equal(artifact.request_pacing.enforcement_failed, false);
  assert.equal(artifact.request_pacing.retry_after_honored, 0);
});
