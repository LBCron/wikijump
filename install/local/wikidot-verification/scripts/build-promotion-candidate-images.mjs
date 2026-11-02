#!/usr/bin/env node

import {execFile as execFileCallback} from "node:child_process";
import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";

import {runCliIfMain} from "../src/cli-entry.mjs";

const execFile = promisify(execFileCallback);
const DOCKER = "/usr/bin/docker";
const GIT = "/usr/bin/git";
const BUILD_MANIFEST_EXCLUSIONS = new Set(["evidence-manifest.sha256", "seal.json"]);
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/u;
const GIT_OBJECT = /^[0-9a-f]{40}$/u;

export const APPLICATION_IMAGE_ROLES = Object.freeze(["deepwell", "framerail", "wws"]);

export const PROMOTION_IMAGE_ROLES = Object.freeze([
  "cache",
  "caddy",
  "database",
  "deepwell",
  "files",
  "framerail",
  "wws",
]);

const BUILD_DEFINITIONS = Object.freeze({
  cache: {dockerfile: "Dockerfile", context: "install/local/valkey"},
  caddy: {dockerfile: "install/prod/caddy/Dockerfile", context: "."},
  database: {dockerfile: "install/local/postgres/Dockerfile", context: "."},
  deepwell: {dockerfile: "install/prod/deepwell/Dockerfile", context: ".", buildArgs: ["CARGO_PROFILE=standing"]},
  files: {dockerfile: "Dockerfile", context: "install/local/silo"},
  framerail: {
    dockerfile: "install/prod/framerail/Dockerfile",
    context: ".",
    buildArgs: ["FRAMERAIL_ENV=local", "FRAMERAIL_CSRF_CHECK_ORIGIN=true"],
  },
  wws: {dockerfile: "install/prod/wws/Dockerfile", context: "."},
});

function fail(message) {
  throw new Error(message);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), {recursive: true});
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
}

async function fileSha256(filePath) {
  return sha256(await fs.readFile(filePath));
}

async function listRegularFiles(root, relative = "") {
  const entries = await fs.readdir(path.join(root, relative), {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    const next = path.join(relative, entry.name);
    if (entry.isDirectory()) files.push(...(await listRegularFiles(root, next)));
    else if (entry.isFile()) files.push(next);
    else fail(`build evidence contains unsupported path: ${next}`);
  }
  return files.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
}

function ftmlRevision(lockContents) {
  const section = lockContents.match(/\[\[package\]\]\nname = "ftml"\n[\s\S]*?(?=\n\[\[package\]\]|$)/u)?.[0];
  const revision = section?.match(/^source = "[^"]+#([0-9a-f]{40})"$/mu)?.[1];
  if (!revision) fail("deepwell/Cargo.lock does not contain one exact FTML revision");
  return revision;
}

async function git(sourceRoot, ...args) {
  const {stdout} = await execFile(GIT, ["-C", sourceRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function promotionSourceIdentity(sourceRoot) {
  const [status, untracked, commit, tree, lock] = await Promise.all([
    git(sourceRoot, "status", "--porcelain=v1", "--untracked-files=no"),
    git(sourceRoot, "ls-files", "--others", "--exclude-standard"),
    git(sourceRoot, "rev-parse", "HEAD^{commit}"),
    git(sourceRoot, "rev-parse", "HEAD^{tree}"),
    fs.readFile(path.join(sourceRoot, "deepwell", "Cargo.lock"), "utf8"),
  ]);
  if (status !== "") fail("promotion candidate tracked source must be clean");
  const buildInputPrefixes = [
    ".cargo/",
    "assets/",
    "deepwell/",
    "framerail/",
    "install/local/silo/",
    "install/local/postgres/",
    "install/local/valkey/",
    "install/prod/",
    "locales/",
    "wws/",
  ];
  const untrackedBuildInputs = untracked
    .split("\n")
    .filter(Boolean)
    .filter((entry) =>
      entry === "rust-toolchain.toml" || buildInputPrefixes.some((prefix) => entry.startsWith(prefix)),
    );
  if (untrackedBuildInputs.length > 0) {
    fail(`promotion candidate build inputs contain untracked files: ${untrackedBuildInputs.join(", ")}`);
  }
  if (!GIT_OBJECT.test(commit) || !GIT_OBJECT.test(tree)) fail("promotion candidate Git identity is invalid");
  return Object.freeze({wikijump_commit: commit, wikijump_tree: tree, ftml_sha: ftmlRevision(lock)});
}

export function promotionImageBuildPlan(sourceRoot) {
  return PROMOTION_IMAGE_ROLES.map((role) => {
    const definition = BUILD_DEFINITIONS[role];
    return Object.freeze({
      role,
      dockerfile: path.resolve(sourceRoot, definition.context, definition.dockerfile),
      context: path.resolve(sourceRoot, definition.context),
      build_args: Object.freeze([...(definition.buildArgs ?? [])]),
    });
  });
}

async function dockerBuildImage({role, dockerfile, context, build_args: buildArgs}, sourceIdentity) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `wikijump-candidate-${role}-`));
  const iidfile = path.join(temporary, "iid");
  try {
    const args = [
      "build",
      "--file", dockerfile,
      "--label", "com.rokurolize.wikijump.owner=promotion-candidate-build",
      "--label", `com.rokurolize.wikijump.sha=${sourceIdentity.wikijump_commit}`,
      "--label", `com.rokurolize.wikijump.tree=${sourceIdentity.wikijump_tree}`,
      "--label", `com.rokurolize.wikijump.ftml_sha=${sourceIdentity.ftml_sha}`,
      "--label", "com.rokurolize.wikijump.profile=production-build",
      ...buildArgs.flatMap((value) => ["--build-arg", value]),
      ...(role === "deepwell" || role === "framerail"
        ? ["--build-arg", `WIKIJUMP_GIT_COMMIT=${sourceIdentity.wikijump_commit}`]
        : []),
      "--iidfile", iidfile,
      context,
    ];
    await execFile(DOCKER, args, {maxBuffer: 64 * 1024 * 1024});
    const imageId = (await fs.readFile(iidfile, "utf8")).trim();
    if (!IMAGE_ID.test(imageId)) fail(`candidate ${role} build did not produce an immutable image ID`);
    const {stdout} = await execFile(DOCKER, ["image", "inspect", imageId, "--format", "{{json .}}"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const inspect = JSON.parse(stdout);
    if (inspect?.Os !== "linux" || inspect?.Architecture !== "amd64") {
      fail(`candidate ${role} image is not linux/amd64`);
    }
    return {image_id: imageId, os: "linux", architecture: "amd64"};
  } finally {
    await fs.rm(temporary, {recursive: true, force: true});
  }
}

async function inspectReusedImage(role, imageId) {
  if (!IMAGE_ID.test(imageId)) fail(`reused ${role} image is not an immutable image ID`);
  const {stdout} = await execFile(DOCKER, ["image", "inspect", imageId, "--format", "{{json .}}"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  const inspect = JSON.parse(stdout);
  if (inspect?.Id !== imageId) fail(`reused ${role} image ${imageId} is not present`);
  if (inspect?.Os !== "linux" || inspect?.Architecture !== "amd64") fail(`reused ${role} image is not linux/amd64`);
  return {image_id: imageId, os: "linux", architecture: "amd64"};
}

export async function standingInfrastructureImages(runtimeHome) {
  const environment = Object.fromEntries(
    (await fs.readFile(path.join(runtimeHome, ".env"), "utf8"))
      .split("\n")
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
  return Object.fromEntries(
    PROMOTION_IMAGE_ROLES.filter((role) => !APPLICATION_IMAGE_ROLES.includes(role)).map((role) => {
      const imageId = environment[`STANDING_${role.toUpperCase()}_IMAGE`];
      if (!IMAGE_ID.test(imageId ?? "")) fail(`standing runtime has no immutable ${role} image`);
      return [role, imageId];
    }),
  );
}

export async function buildApplicationImages(sourceRoot, {buildImage = dockerBuildImage} = {}) {
  const sourceIdentity = await promotionSourceIdentity(sourceRoot);
  const plan = promotionImageBuildPlan(sourceRoot).filter(({role}) => APPLICATION_IMAGE_ROLES.includes(role));
  const images = await Promise.all(plan.map((entry) => buildImage(entry, sourceIdentity)));
  return Object.fromEntries(plan.map(({role}, index) => [role, images[index].image_id]));
}

async function writeEvidenceManifest(root) {
  const files = (await listRegularFiles(root)).filter((relative) => !BUILD_MANIFEST_EXCLUSIONS.has(relative));
  const lines = [];
  for (const relative of files) {
    lines.push(`${await fileSha256(path.join(root, relative))}  ./${relative}\n`);
  }
  const manifest = path.join(root, "evidence-manifest.sha256");
  await fs.writeFile(manifest, lines.join(""), {mode: 0o600});
  return fileSha256(manifest);
}

export async function buildPromotionCandidateImages({
  sourceRoot,
  outputDir,
  runId,
  sourceIdentity,
  reuse = {},
  buildImage = dockerBuildImage,
  reuseImage = inspectReusedImage,
}) {
  const root = path.resolve(outputDir);
  try {
    await fs.lstat(root);
    fail(`promotion build output already exists: ${root}`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (typeof runId !== "string" || !/^[a-z0-9][a-z0-9-]{7,127}$/u.test(runId)) fail("promotion build run ID is invalid");
  for (const value of Object.values(sourceIdentity)) if (!GIT_OBJECT.test(value)) fail("promotion build source identity is invalid");

  const staging = await fs.mkdtemp(path.join(path.dirname(root), `.${path.basename(root)}.build-`));
  try {
    const plan = promotionImageBuildPlan(sourceRoot);
    for (const role of Object.keys(reuse)) {
      if (APPLICATION_IMAGE_ROLES.includes(role) || !PROMOTION_IMAGE_ROLES.includes(role)) {
        fail(`only standing infrastructure images may be reused, not ${role}`);
      }
    }
    const results = await Promise.all(plan.map(async (entry) => {
      const reused = reuse[entry.role];
      const [image, dockerfileSha256] = await Promise.all([
        reused ? reuseImage(entry.role, reused) : buildImage(entry, sourceIdentity),
        fileSha256(entry.dockerfile),
      ]);
      return {entry, image, dockerfileSha256, reused: Boolean(reused)};
    }));
    const finalImages = [];
    const contextRows = [];
    for (const {entry, image, dockerfileSha256, reused} of results) {
      if (!IMAGE_ID.test(image.image_id) || image.os !== "linux" || image.architecture !== "amd64") {
        fail(`candidate ${entry.role} image result is invalid`);
      }
      finalImages.push({role: entry.role, image_id: image.image_id, os: image.os, architecture: image.architecture});
      contextRows.push({
        role: entry.role,
        dockerfile: path.relative(sourceRoot, entry.dockerfile),
        dockerfile_sha256: dockerfileSha256,
        context: path.relative(sourceRoot, entry.context) || ".",
        build_args: entry.build_args,
        ...(reused ? {reused_from: "standing-runtime"} : {}),
      });
    }
    if (new Set(finalImages.map(({image_id: imageId}) => imageId)).size !== finalImages.length) {
      fail("promotion build reuses an image ID across runtime roles");
    }
    const imageMap = Object.fromEntries(finalImages.map(({role, image_id: imageId}) => [role, {id: imageId}]));
    await writeJson(path.join(staging, "images", "final-images.json"), finalImages);
    await writeJson(path.join(staging, "image-producer.json"), {
      status: "pass",
      wikijump_sha: sourceIdentity.wikijump_commit,
      wikijump_tree: sourceIdentity.wikijump_tree,
      ftml_sha: sourceIdentity.ftml_sha,
      images: imageMap,
    });
    await writeJson(path.join(staging, "build", "context.json"), {run_id: runId, source: sourceIdentity, builds: contextRows});
    const verdict = {
      schema: "wikijump.standing_provenance_build.v1",
      status: "pass",
      promotion_eligible: true,
      run_id: runId,
      wikijump_commit: sourceIdentity.wikijump_commit,
      wikijump_tree: sourceIdentity.wikijump_tree,
      ftml_sha: sourceIdentity.ftml_sha,
      final_images: "images/final-images.json",
    };
    const verdictPath = path.join(staging, "verdict.json");
    await writeJson(verdictPath, verdict);
    const evidenceManifestSha256 = await writeEvidenceManifest(staging);
    await writeJson(path.join(staging, "seal.json"), {
      schema: "wikijump.standing_provenance_build_seal.v1",
      status: "sealed",
      run_id: runId,
      evidence_manifest_verified: true,
      evidence_manifest_exclusions: ["evidence-manifest.sha256", "seal.json"],
      evidence_manifest_sha256: evidenceManifestSha256,
      verdict_sha256: await fileSha256(verdictPath),
    });
    await fs.rename(staging, root);
    return Object.freeze({
      output_dir: root,
      run_id: runId,
      source: sourceIdentity,
      images: Object.freeze(Object.fromEntries(finalImages.map(({role, image_id: imageId}) => [role, imageId]))),
    });
  } catch (error) {
    await fs.rm(staging, {recursive: true, force: true});
    throw error;
  }
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const name = flag?.startsWith("--") ? flag.slice(2) : "";
    const value = argv[index + 1];
    if (!["source-root", "output-dir", "run-id", "reuse-runtime-home"].includes(name) || Object.hasOwn(args, name) || !value || value.startsWith("--")) fail(`unknown or duplicate option: ${flag}`);
    args[name] = value;
  }
  for (const name of ["source-root", "output-dir", "run-id"]) if (!args[name]) fail(`--${name} is required`);
  return args;
}

export async function main(argv, {stdout = console.log} = {}) {
  const args = parseArgs(argv);
  const sourceRoot = path.resolve(args["source-root"]);
  const sourceIdentity = await promotionSourceIdentity(sourceRoot);
  const result = await buildPromotionCandidateImages({
    sourceRoot,
    outputDir: path.resolve(args["output-dir"]),
    runId: args["run-id"],
    sourceIdentity,
    reuse: args["reuse-runtime-home"]
      ? await standingInfrastructureImages(path.resolve(args["reuse-runtime-home"]))
      : {},
  });
  if (await promotionSourceIdentity(sourceRoot).then((after) => JSON.stringify(after) !== JSON.stringify(sourceIdentity))) {
    fail("promotion candidate source identity changed during the build");
  }
  stdout(JSON.stringify(result));
  return 0;
}

await runCliIfMain(import.meta.url, main, {onError: (error) => { console.error(error?.stack ?? String(error)); return 1; }});
