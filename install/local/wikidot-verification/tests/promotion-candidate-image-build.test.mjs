import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {
  APPLICATION_IMAGE_ROLES,
  PROMOTION_IMAGE_ROLES,
  buildPromotionCandidateImages,
  promotionImageBuildPlan,
  promotionSourceIdentity,
  standingInfrastructureImages,
} from "../scripts/build-promotion-candidate-images.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], {encoding: "utf8"});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function createPromotionSourceFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "promotion-source-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, "deepwell"), {recursive: true});
  await fs.copyFile(path.join(repositoryRoot, "deepwell/Cargo.lock"), path.join(root, "deepwell/Cargo.lock"));
  await fs.writeFile(path.join(root, "tracked.txt"), "tracked\n");
  git(root, "init", "--quiet");
  git(root, "config", "user.email", "promotion-source@example.invalid");
  git(root, "config", "user.name", "Promotion Source Test");
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "fixture");
  return root;
}

test("promotion candidate image build records all seven production runtime roles", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "promotion-build-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const sourceRoot = repositoryRoot;
  const outputDir = path.join(root, "sealed-build");
  const sourceIdentity = {
    wikijump_commit: "1".repeat(40),
    wikijump_tree: "2".repeat(40),
    ftml_sha: "3".repeat(40),
  };
  const roles = [];
  await buildPromotionCandidateImages({
    sourceRoot,
    outputDir,
    runId: "candidate-build-20260818",
    sourceIdentity,
    buildImage: async (entry) => {
      roles.push(entry.role);
      return {image_id: `sha256:${String(roles.length).repeat(64)}`, os: "linux", architecture: "amd64"};
    },
  });
  assert.deepEqual(roles, PROMOTION_IMAGE_ROLES);
  const images = JSON.parse(await fs.readFile(path.join(outputDir, "images", "final-images.json"), "utf8"));
  assert.deepEqual(images.map(({role}) => role), PROMOTION_IMAGE_ROLES);
});

test("a standing promotion builds only the application images, side by side, and reuses standing's others", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "promotion-build-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const reuse = {
    cache: `sha256:${"c".repeat(64)}`,
    caddy: `sha256:${"d".repeat(64)}`,
    database: `sha256:${"e".repeat(64)}`,
    files: `sha256:${"f".repeat(64)}`,
  };
  const started = [];
  let release;
  const allStarted = new Promise((resolve) => { release = resolve; });
  const result = await buildPromotionCandidateImages({
    sourceRoot: repositoryRoot,
    outputDir: path.join(root, "sealed-build"),
    runId: "standing-promotion-test",
    sourceIdentity: {wikijump_commit: "1".repeat(40), wikijump_tree: "2".repeat(40), ftml_sha: "3".repeat(40)},
    reuse,
    buildImage: async (entry) => {
      started.push(entry.role);
      if (started.length === APPLICATION_IMAGE_ROLES.length) release();
      await allStarted;
      return {image_id: `sha256:${String(started.indexOf(entry.role) + 1).repeat(64)}`, os: "linux", architecture: "amd64"};
    },
    reuseImage: async (role, imageId) => ({image_id: imageId, os: "linux", architecture: "amd64"}),
  });
  assert.deepEqual([...started].sort(), [...APPLICATION_IMAGE_ROLES].sort());
  for (const [role, imageId] of Object.entries(reuse)) assert.equal(result.images[role], imageId);
});

test("a promotion never reuses an application image", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "promotion-build-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await assert.rejects(
    buildPromotionCandidateImages({
      sourceRoot: repositoryRoot,
      outputDir: path.join(root, "sealed-build"),
      runId: "standing-promotion-test",
      sourceIdentity: {wikijump_commit: "1".repeat(40), wikijump_tree: "2".repeat(40), ftml_sha: "3".repeat(40)},
      reuse: {deepwell: `sha256:${"a".repeat(64)}`},
      buildImage: async () => assert.fail("nothing may build"),
    }),
    /only standing infrastructure images may be reused, not deepwell/u,
  );
});

test("standing infrastructure images come from the runtime home environment", async (t) => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "standing-home-"));
  t.after(() => fs.rm(home, {recursive: true, force: true}));
  const id = (character) => `sha256:${character.repeat(64)}`;
  await fs.writeFile(path.join(home, ".env"), [
    `STANDING_CACHE_IMAGE=${id("1")}`,
    `STANDING_CADDY_IMAGE=${id("2")}`,
    `STANDING_DATABASE_IMAGE=${id("3")}`,
    `STANDING_FILES_IMAGE=${id("4")}`,
    `STANDING_DEEPWELL_IMAGE=${id("5")}`,
    "DEEPWELL_RPC_TOKEN=secret",
    "",
  ].join("\n"));
  assert.deepEqual(await standingInfrastructureImages(home), {
    cache: id("1"), caddy: id("2"), database: id("3"), files: id("4"),
  });
  await fs.writeFile(path.join(home, ".env"), `STANDING_CACHE_IMAGE=${id("1")}\n`);
  await assert.rejects(standingInfrastructureImages(home), /standing runtime has no immutable caddy image/u);
});

test("promotion image plan uses production application images and a candidate-seed-capable Deepwell image", async () => {
  const plan = promotionImageBuildPlan(repositoryRoot);
  assert.deepEqual(plan.map(({role}) => role), PROMOTION_IMAGE_ROLES);
  assert.match(plan.find(({role}) => role === "deepwell").dockerfile, /install\/prod\/deepwell\/Dockerfile$/u);
  assert.deepEqual(plan.find(({role}) => role === "framerail").build_args, ["FRAMERAIL_ENV=local", "FRAMERAIL_CSRF_CHECK_ORIGIN=true"]);
  assert.deepEqual(plan.find(({role}) => role === "deepwell").build_args, ["CARGO_PROFILE=standing"]);
  const deepwellDockerfile = await fs.readFile(path.join(repositoryRoot, "install/prod/deepwell/Dockerfile"), "utf8");
  assert.match(deepwellDockerfile, /COPY \.\/deepwell\/seeder \/opt\/deepwell\/seeder/u);
});

test("promotion source identity ignores unrelated operator overlays but rejects build-input dirt", async (t) => {
  const sourceRoot = await createPromotionSourceFixture(t);
  await fs.writeFile(path.join(sourceRoot, "operator-overlay.txt"), "untracked operator state\n");
  const identity = await promotionSourceIdentity(sourceRoot);
  assert.match(identity.wikijump_commit, /^[0-9a-f]{40}$/u);
  assert.match(identity.wikijump_tree, /^[0-9a-f]{40}$/u);
  assert.match(identity.ftml_sha, /^[0-9a-f]{40}$/u);

  await fs.writeFile(path.join(sourceRoot, "deepwell/untracked.rs"), "// build input dirt\n");
  await assert.rejects(
    promotionSourceIdentity(sourceRoot),
    /promotion candidate build inputs contain untracked files: deepwell\/untracked\.rs/u,
  );
  await fs.rm(path.join(sourceRoot, "deepwell/untracked.rs"));

  await fs.appendFile(path.join(sourceRoot, "tracked.txt"), "dirty\n");
  await assert.rejects(
    promotionSourceIdentity(sourceRoot),
    /promotion candidate tracked source must be clean/u,
  );
});
