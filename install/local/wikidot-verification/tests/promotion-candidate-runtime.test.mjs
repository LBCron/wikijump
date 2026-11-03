import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {candidateCompose, candidateDeepwellConfig} from "../scripts/start-promotion-candidate.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const source = {wikijump_commit: "1".repeat(40), wikijump_tree: "2".repeat(40), ftml_sha: "3".repeat(40)};
const images = Object.fromEntries(["cache", "caddy", "database", "deepwell", "files", "framerail", "wws"].map((role, index) => [role, `sha256:${String(index + 1).repeat(64)}`]));

test("promotion candidate topology uses isolated volumes and only loopback non-443 publications", () => {
  const compose = candidateCompose({
    project: "wikijump-candidate-fixture",
    source,
    images,
    expiry: "2026-08-19T00:00:00.000Z",
    publicPort: 20443,
    rpcPort: 22747,
    objectStorePort: 29000,
    deepwellConfigPath: "/tmp/deepwell.toml",
    caddyRequestPath: "/tmp/request.json",
    caddyGeneratorPath: "/tmp/generate.sh",
  });
  assert.deepEqual(Object.keys(compose.services).sort(), ["cache", "caddy", "database", "deepwell", "files", "framerail", "wws"]);
  assert.deepEqual(compose.services.caddy.ports, ["127.0.0.1:20443:443"]);
  assert.deepEqual(compose.services.deepwell.ports, ["127.0.0.1:22747:2747"]);
  assert.deepEqual(compose.services.files.ports, ["127.0.0.1:29000:9000"]);
  assert.equal(JSON.stringify(compose).includes("runtime50x"), false);
  assert.equal(JSON.stringify(compose).includes('"443:443"'), false);
  for (const [role, service] of Object.entries(compose.services)) {
    assert.equal(service.image, images[role]);
    assert.equal(service.labels["com.rokurolize.wikijump.role"], role);
    assert.equal(service.healthcheck.test.length > 0, true);
  }
});

test("candidate Deepwell production image contains the immutable seeder payload", async () => {
  const dockerfile = await fs.readFile(path.join(repositoryRoot, "install/prod/deepwell/Dockerfile"), "utf8");
  assert.match(dockerfile, /COPY \.\/deepwell\/seeder \/opt\/deepwell\/seeder/u);
});

test("a rehearsal candidate attaches prepared copies of standing data and does not seed them", async () => {
  const compose = candidateCompose({
    project: "wjcand-rehearsal-test",
    source: {wikijump_commit: "a".repeat(40), wikijump_tree: "b".repeat(40), ftml_sha: "c".repeat(40)},
    images: Object.fromEntries(["cache", "caddy", "database", "deepwell", "files", "framerail", "wws"].map((role) => [role, `sha256:${"1".repeat(64)}`])),
    expiry: "2026-10-18T00:00:00Z",
    publicPort: 20443,
    rpcPort: 20444,
    objectStorePort: 20445,
    deepwellConfigPath: "/tmp/config.toml",
    caddyRequestPath: "/tmp/request.json",
    caddyGeneratorPath: "/tmp/generate.sh",
    dataVolumes: {database: "wjrehearsal-test-postgres", files: "wjrehearsal-test-files"},
  });
  assert.deepEqual(compose.volumes["database-data"], {external: true, name: "wjrehearsal-test-postgres"});
  assert.deepEqual(compose.volumes["files-data"], {external: true, name: "wjrehearsal-test-files"});
  assert.deepEqual(compose.volumes["cache-data"], {});

  const sourceConfig = await fs.readFile(path.join(repositoryRoot, "install/prod/deepwell/config.toml"), "utf8");
  assert.match(candidateDeepwellConfig(sourceConfig, 20443, {seed: false}), /run-seeder = false/u);
  assert.match(candidateDeepwellConfig(sourceConfig, 20443), /run-seeder = true/u);
});

test("promotion candidate makes public registration deterministic", async () => {
  const sourceConfig = await fs.readFile(path.join(repositoryRoot, "install/prod/deepwell/config.toml"), "utf8");
  const candidateConfig = candidateDeepwellConfig(sourceConfig, 20443);
  assert.match(candidateConfig, /mock-mailcheck = true/u);
  assert.doesNotMatch(candidateConfig, /mock-mailcheck = false/u);
  assert.match(candidateConfig, /main = "wikijump\.localhost"/u);
  assert.match(candidateConfig, /https-port = 20443/u);
  assert.match(candidateConfig, /files = "wjfiles\.localhost"\n/u);
});
