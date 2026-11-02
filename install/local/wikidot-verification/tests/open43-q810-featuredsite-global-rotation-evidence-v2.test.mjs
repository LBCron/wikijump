import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import {fileURLToPath} from "node:url";

process.chdir(fileURLToPath(new URL("../../../../", import.meta.url)));

const base = "bc97b7cbb84c5a7cb693ad5f1f73bf4ce7db1c03";
const surfaces = ["open43-audit-case:Q810_ACTIVE_GLOBAL_ROTATION", "catalog-feature:module-featuredsite"];
const fixturePath = "install/local/wikidot-verification/fixtures/open43-q810-featuredsite-global-rotation-v2.json";
const artifactPath = "install/local/wikidot-verification/artifacts/open43-q810-featuredsite-global-rotation-live-v2.json";
const scriptPath = "install/local/wikidot-verification/scripts/capture_wikidot_featuredsite_global_rotation_v2.py";
const testPath = "install/local/wikidot-verification/tests/open43-q810-featuredsite-global-rotation-evidence-v2.test.mjs";
const v1ArtifactPath = "install/local/wikidot-verification/artifacts/open43-q810-featuredsite-global-rotation-live.json";
const requirementsPath = "install/local/wikidot-verification/requirements.txt";
const historicalRequirementsPath = "install/local/wikidot-verification/requirements-2434bf77744488cb2095327c9e0e4450add78df3.txt";
const historicalScriptSha256 = "e1bf38153d5110750853f423fcb095554b5c99739a8761eea0006a1056bae6a4";
const requirementsLockPath = "install/local/wikidot-verification/requirements.lock";
const historicalRequirementsLockSha256 = "8f2ec862f6f0358b5f0aea8ca6edd40c1ef043c2f0391701217fd907c2ae82e1";
const producerOffsets = [0, 4, 8, 12, 32, 36, 56, 60];
const negativeOffsets = [64, 68];
const allowedPaths = [scriptPath, fixturePath, artifactPath, testPath].sort();
const sensitiveKey = /^(?:password|passwd|cookie|authorization|session[_-]?(?:id|token)|access[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|credential)$/i;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function walk(value, visit, path = "$") {
  visit(value, path);
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, `${path}[${index}]`));
  else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assert.equal(sensitiveKey.test(key), false, `sensitive key at ${path}.${key}`);
      walk(item, visit, `${path}.${key}`);
    }
  }
}

function expectedForm(fixture, source) {
  const seam = fixture.producer_seam;
  return new URLSearchParams([
    ["wikidot_token7", String(seam.anonymous_wikidot_token7)],
    ["moduleName", seam.module_name],
    ["mode", seam.mode],
    ["source", source],
    ["title", seam.title],
  ]).toString();
}

function validateSupersession(fixture) {
  const v1Bytes = readFileSync(v1ArtifactPath);
  const v1 = JSON.parse(v1Bytes);
  assert.equal(sha256(v1Bytes), "e0ac3c628bad7c145076a32f486e9edefa24c21d2b844ca8679e7a150ea5d083");
  assert.deepEqual(fixture.supersedes, {
    artifact_path: v1ArtifactPath,
    artifact_sha256: sha256(v1Bytes),
    schema: v1.schema,
    acquisition_status: v1.acquisition_status,
    case_disposition: v1.case_disposition,
    actual_requests: v1.counters.actual_requests,
    global_rotation_authority: v1.global_rotation_authority,
    blocker: v1.blockers[0],
    reason: "the pinned environment is now available",
  });
  assert.equal(v1.acquisition_status, "blocked");
  assert.equal(v1.case_disposition, "non_closure");
  assert.equal(v1.counters.actual_requests, 0);
  assert.equal(v1.global_rotation_authority, "not_established");
  assert.deepEqual(v1.blockers, ["pinned-python-environment-unavailable"]);
}

function validateFixture(fixture) {
  assert.equal(fixture.schema, "wikijump.open43.q810_featuredsite_global_rotation_fixture.v2");
  assert.deepEqual(fixture.surface_ids, surfaces);
  assert.equal(fixture.integration_base, base);
  validateSupersession(fixture);
  assert.equal(fixture.optional_public_producer_page, null);
  assert.deepEqual(fixture.producer_observation_offsets_seconds, producerOffsets);
  assert.deepEqual(fixture.negative_controls.map((item) => item.scheduled_offset_seconds), negativeOffsets);
  assert.equal(new Set(fixture.negative_controls.map((item) => item.body_identity)).size, 2);
  assert.deepEqual(
    Object.fromEntries(["scheme", "host", "path", "method", "authenticated", "module_name", "mode", "source", "title"].map((key) => [key, fixture.producer_seam[key]])),
    {
      scheme: "http",
      host: "sandbox-for-codex.wikidot.com",
      path: "/ajax-module-connector.php",
      method: "POST",
      authenticated: false,
      module_name: "edit/PagePreviewModule",
      mode: "page",
      source: "[[module FeaturedSite]]\ncommunity.wikidot.com\n[[/module]]",
      title: "Open43 Q810 FeaturedSite global rotation evidence",
    },
  );
  assert.deepEqual(fixture.producer_seam.request_field_order, ["wikidot_token7", "moduleName", "mode", "source", "title"]);
  assert.equal(fixture.producer_seam.request_form_bytes_utf8, expectedForm(fixture, fixture.producer_seam.source));
  for (const control of fixture.negative_controls) assert.equal(control.source, `[[module FeaturedSite]]\n${control.body_identity}\n[[/module]]`);
  assert.deepEqual(fixture.budgets, {
    maximum_outbound_requests: 10,
    producer_attempts: 8,
    negative_control_attempts: 2,
    retries: 0,
    redirects_followed: 0,
    minimum_interval_seconds: 4,
    maximum_request_body_bytes: 4096,
    maximum_aggregate_request_bytes: 40960,
    maximum_response_bytes: 262144,
    maximum_aggregate_response_bytes: 2097152,
    connect_timeout_seconds: 10,
    read_timeout_seconds: 15,
    maximum_schedule_lateness_seconds: 3,
    wall_clock_seconds: 150,
    direct_asset_requests: 0,
    mutations: 0,
    private_content_reads: 0,
  });
  assert.deepEqual(fixture.dependency, {
    requirements_path: requirementsPath,
    requirements_lock_path: requirementsLockPath,
    requirements_sha256: sha256(readFileSync(historicalRequirementsPath)),
    requirements_lock_sha256: historicalRequirementsLockSha256,
    python_version: "3.12.3",
    wikidot_py_commit: "2434bf77744488cb2095327c9e0e4450add78df3",
    wikidot_py_version: "4.4.1",
  });
  assert.match(readFileSync(historicalRequirementsPath, "utf8"), /Rokurolize\/wikidot\.py@2434bf77744488cb2095327c9e0e4450add78df3/);
  assert.equal("expected_selected_identities" in fixture, false);
  assert.equal(fixture.policies.no_expected_featured_site_identities, true);
  assert.deepEqual(fixture.policies.allowed_hosts, ["sandbox-for-codex.wikidot.com"]);
  for (const key of ["no_cache_busters", "no_assets", "no_mutations", "no_private_site_data", "local_wikijump_is_not_oracle", "producer_is_not_leaf_owned"]) assert.equal(fixture.policies[key], true, key);
  walk(fixture, () => {});
}

function validateScript() {
  const script = readFileSync(scriptPath, "utf8");
  const allowlistBlock = script.match(/ALLOWED_PATHS = \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(allowlistBlock, "script allowlist missing");
  const paths = [...allowlistBlock.matchAll(/"(install\/local\/wikidot-verification\/[^\"]+)"/g)].map((match) => match[1]).sort();
  assert.deepEqual(paths, allowedPaths);
  assert.match(script, /with path\.open\("xb"\)/);
  assert.match(script, /if args\.output\.exists\(\)/);
  assert.match(script, /attempt_limit=1/);
  assert.match(script, /retry_max_retries=0/);
  assert.doesNotMatch(script, /follow_redirects\s*=\s*True/);
  assert.doesNotMatch(script, /[?&](?:cache[_-]?buster|nonce)=|random title/i);
  assert.doesNotMatch(script, /(?:\.get|\.post)\([^\n]*(?:thumbnail|destination)/i);
}

function validateArtifact(fixture, artifact) {
  assert.equal(artifact.schema, "wikijump.open43.q810_featuredsite_global_rotation_live_evidence.v2");
  assert.deepEqual(artifact.surface_ids, surfaces);
  assert.equal(artifact.integration_base, base);
  assert.deepEqual(artifact.supersedes, fixture.supersedes);
  assert.equal(artifact.fixture_sha256, sha256(readFileSync(fixturePath)));
  assert.equal(artifact.capture_script_sha256, historicalScriptSha256);
  assert.deepEqual(artifact.dependency, {
    python_version: fixture.dependency.python_version,
    wikidot_py_version: fixture.dependency.wikidot_py_version,
    wikidot_py_commit: fixture.dependency.wikidot_py_commit,
    requirements_path: requirementsPath,
    requirements_sha256: sha256(readFileSync(historicalRequirementsPath)),
    requirements_lock_path: requirementsLockPath,
    requirements_lock_sha256: historicalRequirementsLockSha256,
  });
  assert.deepEqual(artifact.producer_seam, fixture.producer_seam);
  assert.deepEqual(artifact.schedule, { producer_offsets_seconds: producerOffsets, negative_control_offsets_seconds: negativeOffsets });
  assert.equal(artifact.producer_request_sha256, sha256(expectedForm(fixture, fixture.producer_seam.source)));
  for (const key of ["retries", "redirects_followed", "asset_requests", "mutations_attempted", "private_content_reads", "cache_busters", "credentials_used"]) assert.equal(artifact.counters[key], 0, key);
  assert.equal(artifact.cleanup, "not_applicable_read_only");
  assert.equal(artifact.producer_owned_by_leaf, false);
  assert.equal(artifact.hard_coded_local_producer_recommendation, null);
  for (const value of Object.values(artifact.unestablished)) assert.equal(value, "not_established");
  walk(artifact, (value, path) => {
    if (typeof value === "string") assert.equal(/(?:wikijump\.localhost|wjfiles\.localhost)/i.test(value), false, `local value at ${path}`);
  });

  assert.ok(["captured", "blocked"].includes(artifact.acquisition_status));
  assert.ok(["evidence_ready", "non_closure"].includes(artifact.case_disposition));
  assert.ok(artifact.observations.length <= 10);
  assert.equal(artifact.counters.actual_requests, artifact.observations.length);
  assert.equal(artifact.counters.producer_attempts, artifact.observations.filter((item) => item.kind === "producer").length);
  assert.equal(artifact.counters.negative_control_attempts, artifact.observations.filter((item) => item.kind === "negative_control").length);
  assert.ok(artifact.counters.request_bytes <= fixture.budgets.maximum_aggregate_request_bytes);
  assert.ok(artifact.counters.response_bytes <= fixture.budgets.maximum_aggregate_response_bytes);
  assert.ok(artifact.wall_clock_elapsed_seconds <= fixture.budgets.wall_clock_seconds);
  for (let index = 1; index < artifact.observations.length; index += 1) {
    const interval = artifact.observations[index].actual_monotonic_offset_seconds - artifact.observations[index - 1].actual_monotonic_offset_seconds;
    assert.ok(interval >= fixture.budgets.minimum_interval_seconds - 0.001, `interval ${index} too short`);
  }
  for (const observation of artifact.observations) {
    assert.ok(observation.request_body_bytes <= fixture.budgets.maximum_request_body_bytes);
    assert.ok(observation.response_bytes <= fixture.budgets.maximum_response_bytes);
    assert.deepEqual(Object.keys(observation.selected_headers), ["age", "cache-control", "date", "etag", "last-modified"]);
  }

  const producers = artifact.observations.filter((item) => item.kind === "producer");
  const negatives = artifact.observations.filter((item) => item.kind === "negative_control");
  assert.deepEqual(producers.map((item) => item.scheduled_offset_seconds), producerOffsets.slice(0, producers.length));
  if (negatives.length) assert.deepEqual(negatives.map((item) => item.scheduled_offset_seconds), negativeOffsets.slice(0, negatives.length));
  const producerHashes = new Set(producers.map((item) => item.request_body_sha256));
  if (producers.length) assert.deepEqual([...producerHashes], [artifact.producer_request_sha256]);
  const recomputedCounts = Object.fromEntries([...producers.reduce((counts, item) => {
    if (item.selected_card_identity) counts.set(item.selected_card_identity, (counts.get(item.selected_card_identity) ?? 0) + 1);
    return counts;
  }, new Map()).entries()].sort());
  assert.deepEqual(artifact.observed_site_identity_counts, recomputedCounts);

  assert.equal(artifact.claims.length, fixture.rule_ids.length);
  assert.deepEqual(new Set(artifact.claims.map((item) => item.rule_id)), new Set(fixture.rule_ids));
  const observationIds = new Set(artifact.observations.map((item) => item.probe_id));
  const rotation = artifact.claims.find((item) => item.rule_id === "global_rotation");
  assert.ok(rotation);
  for (const claim of artifact.claims) {
    assert.ok(["established", "blocked", "unobserved"].includes(claim.status));
    for (const id of [...claim.positive_observation_ids, ...claim.negative_observation_ids]) assert.ok(observationIds.has(id));
    if (claim.rule_id !== "global_rotation") {
      assert.equal(claim.status === "established", false);
      assert.deepEqual(claim.positive_observation_ids, []);
      assert.deepEqual(claim.negative_observation_ids, []);
    }
  }

  const qualifying = Object.entries(recomputedCounts).filter(([, count]) => count >= 2).map(([identity]) => identity).sort();
  const selectedIdentitiesAbsentFromNegatives = qualifying.slice(0, 2).every((identity) => negatives.every((item) => item.selected_card_identity !== identity));
  const thresholdReached = artifact.acquisition_status === "captured" && artifact.observations.length === 10 && qualifying.length >= 2 && producerHashes.size === 1 && selectedIdentitiesAbsentFromNegatives && artifact.maximum_schedule_lateness_seconds <= 3;
  if (thresholdReached) {
    assert.equal(artifact.global_rotation_authority, "established");
    assert.equal(artifact.case_disposition, "evidence_ready");
    assert.equal(rotation.status, "established");
    assert.equal(rotation.positive_observation_ids.length, 4);
    assert.equal(new Set(rotation.positive_observation_ids).size, 4);
    assert.equal(rotation.negative_observation_ids.length, 2);
    assert.equal(new Set(rotation.negative_observation_ids).size, 2);
    assert.deepEqual(rotation.positive_observation_ids, artifact.positive_rotation_observation_ids);
  } else {
    assert.equal(artifact.global_rotation_authority, "not_established");
    assert.equal(artifact.case_disposition, "non_closure");
    assert.equal(rotation.status, "blocked");
    assert.deepEqual(rotation.positive_observation_ids, []);
    assert.deepEqual(rotation.negative_observation_ids, []);
    assert.deepEqual(artifact.positive_rotation_observation_ids, []);
    assert.ok(artifact.blockers.length > 0);
  }
}

test("frozen FeaturedSite v2 global rotation evidence satisfies the bounded contract", () => {
  const fixture = readJson(fixturePath);
  validateFixture(fixture);
  validateScript();
  if (!existsSync(artifactPath)) throw new Error(`EVIDENCE_ARTIFACT_MISSING:${artifactPath}`);
  validateArtifact(fixture, readJson(artifactPath));
});
