#!/usr/bin/env node


import {execFile as execFileCallback, spawn} from "node:child_process";
import {createHash} from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {promisify} from "node:util";

import {runCliIfMain} from "../src/cli-entry.mjs";
import {buildApplicationImages} from "./build-promotion-candidate-images.mjs";
import {sealJsonNoReplace} from "../src/standing-browser-parity-util.mjs";
import {CONSOLIDATED_VALIDATION_SCHEMA} from "../src/final-frozen-receipt-contract.mjs";
import {passCacheKey, readCachedPass, recordPass, validationEnvironmentDigest} from "../src/validation-pass-cache.mjs";

const execFile = promisify(execFileCallback);
const SOURCE_FILES = Object.freeze([
  "scripts/preflight.sh",
  "scripts/run-test-no-external-network.sh",
  "install/local/wikidot-verification/scripts/run-deepwell-integration-validation.mjs",
]);
const TOOLS = Object.freeze({
  node: ["node", ["--version"]],
  pnpm: ["pnpm", ["--version"]],
  cargo: ["cargo", ["--version"]],
  rustc: ["rustc", ["--version"]],
});

function fail(message) {
  throw new Error(message);
}

export function validationStore(env = process.env) {
  const stateRoot = env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(stateRoot, "wikijump", "validation");
}

function parseArgs(argv) {
  const args = {imageBuild: true, reusePass: false};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (flag === "--reuse-pass") {
      args.reusePass = true;
      index -= 1;
      continue;
    }
    if (flag === "--no-image-build") {
      args.imageBuild = false;
      index -= 1;
      continue;
    }
    const value = argv[index + 1];
    if (!["--repository", "--base", "--output", "--log", "--groups"].includes(flag) || !value || value.startsWith("--")) {
      fail(`invalid option: ${flag ?? "<missing>"}`);
    }
    const key = flag.slice(2);
    if (Object.hasOwn(args, key)) fail(`duplicate option: ${flag}`);
    args[key] = value;
  }
  for (const key of ["repository", "base"]) if (!args[key]) fail(`--${key} is required`);
  const output = path.resolve(args.output ?? path.join(validationStore(), `validation-${Date.now()}.json`));
  return {
    repository: path.resolve(args.repository),
    base: args.base,
    output,
    log: args.log ? path.resolve(args.log) : `${output}.log`,
    groups: args.groups ?? null,
    imageBuild: args.imageBuild,
    reusePass: args.reusePass,
  };
}

async function git(repository, ...args) {
  const {stdout} = await execFile("git", ["-C", repository, ...args], {encoding: "utf8"});
  return stdout.trim();
}

const DIRTY_PATHS_SHOWN = 20;

async function gitStatusSummary(repository) {
  const child = spawn("git", ["-C", repository, "status", "--porcelain=v1", "--untracked-files=all"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let count = 0;
  const first = [];
  let partial = "";
  let stderr = "";
  const takeLine = (line) => {
    count += 1;
    if (first.length < DIRTY_PATHS_SHOWN) first.push(line);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop();
    lines.forEach(takeLine);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    if (stderr.length < 4096) stderr += chunk;
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (partial !== "") takeLine(partial);
  if (code !== 0) fail(`git status failed with exit ${code}: ${stderr.trim()}`);
  return {count, first};
}

async function sha256File(file) {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}

export function parsePreflightOutput(output) {
  const groups = {};
  const groupLine = /^preflight: groups: (.*)$/mu.exec(output);
  for (const pair of groupLine?.[1].trim().split(/\s+/u) ?? []) {
    const [name, value] = pair.split("=");
    if (name) groups[name] = value === "true";
  }
  const checks = [];
  const activeChecks = [];
  for (const line of output.split(/\r?\n/u)) {
    const started = /^=== (.+)$/u.exec(line);
    if (started) {
      activeChecks.push(started[1]);
      continue;
    }
    const result = /^--- (.+): (ok|FAILED|INCONCLUSIVE)(?: \((\d+)s\))?$/u.exec(line);
    if (result && result[1] === activeChecks.at(-1)) {
      activeChecks.pop();
      if (activeChecks.length !== 0) continue;
      checks.push({
        name: result[1],
        status: {ok: "ok", FAILED: "failed", INCONCLUSIVE: "inconclusive"}[result[2]],
        ...(result[3] === undefined ? {} : {duration_seconds: Number(result[3])}),
      });
    }
  }
  return {groups, checks};
}

export function classifyConsolidatedChecks(preflightExit, groups, checks) {
  const permitted = () => false;
  const passed = preflightExit === 0 && checks.some((check) => check.status === "ok") &&
    checks.every((check) => check.status === "ok" || permitted(check));
  return {
    passed,
    failed: checks.filter((check) => check.status !== "ok" && !permitted(check)).map((check) => check.name),
    inconclusive: checks.filter(permitted).map((check) => check.name),
  };
}

async function toolVersions() {
  const versions = {};
  for (const [name, [command, args]] of Object.entries(TOOLS)) {
    try {
      versions[name] = (await execFile(command, args, {encoding: "utf8"})).stdout.trim();
    } catch {
      versions[name] = "unavailable";
    }
  }
  return versions;
}

async function runPreflight(repository, base, logPath, groups) {
  await fs.mkdir(path.dirname(logPath), {recursive: true, mode: 0o700});
  const log = await fs.open(logPath, "wx", 0o600);
  let output = "";
  try {
    const code = await new Promise((resolve, reject) => {
      const child = spawn("bash", ["scripts/preflight.sh", "--base", base, "--final", ...(groups ? ["--groups", groups] : [])], {
        cwd: repository,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const record = (chunk) => {
        output += chunk.toString("utf8");
        process.stdout.write(chunk);
        log.write(chunk);
      };
      child.stdout.on("data", record);
      child.stderr.on("data", record);
      child.on("error", reject);
      child.on("exit", (status, signal) => resolve(signal ? `signal ${signal}` : status));
    });
    return {code, output};
  } finally {
    await log.close();
  }
}

async function imageBuildCheck(repository, buildImages) {
  try {
    const images = await buildImages(repository);
    process.stdout.write(`--- standing images build: ok ${JSON.stringify(images)}\n`);
    return {name: "standing images build", status: "ok"};
  } catch (error) {
    process.stdout.write(`--- standing images build: FAILED ${error?.message ?? error}\n`);
    return {name: "standing images build", status: "failed"};
  }
}

async function checkoutHead(variable, environment) {
  const location = environment[variable]?.trim();
  if (!location) return null;
  try {
    return await git(location, "rev-parse", "HEAD");
  } catch {
    return "unavailable";
  }
}

async function validationPassKey({repository, commit, tree, baseCommit, onlyGroups, imageBuild, environment}) {
  const source_sha256 = {};
  for (const relative of SOURCE_FILES) source_sha256[relative] = await sha256File(path.join(repository, relative));
  const env = validationEnvironmentDigest(environment);
  return {
    environmentNames: env.names,
    key: passCacheKey({
      schema: "wikijump.validation_pass_key.v1", commit, tree, base_commit: baseCommit, groups: onlyGroups, image_build: imageBuild,
      tool_versions: await toolVersions(), source_sha256, environment_sha256: env.sha256,
      ftml_checkout_head: await checkoutHead("WIKIJUMP_FTML_CHECKOUT", environment),
      wikidot_py_head: await checkoutHead("WIKIDOT_PY_CHECKOUT", environment),
    }),
  };
}

export async function runConsolidatedValidation({
  repository,
  base,
  output,
  log,
  groups: onlyGroups = null,
  imageBuild = true,
  buildImages = buildApplicationImages,
  reusePass = false,
  store = validationStore(),
  environment = process.env,
}) {
  const status = await gitStatusSummary(repository);
  if (status.count > 0) {
    fail([
      `consolidated validation requires a clean checkout: ${status.count} changed or untracked paths${status.count > status.first.length ? `, first ${status.first.length}` : ""}`,
      ...status.first.map((line) => `  ${line}`),
    ].join("\n"));
  }
  const commit = await git(repository, "rev-parse", "HEAD^{commit}");
  const tree = await git(repository, "rev-parse", "HEAD^{tree}");
  const baseCommit = await git(repository, "rev-parse", `${base}^{commit}`);
  const startedAt = new Date().toISOString();
  if (onlyGroups !== null && !/^[a-z_]+(?:,[a-z_]+)*$/u.test(onlyGroups)) fail("--groups must be a comma-separated group list");
  const cacheKey = await validationPassKey({repository, commit, tree, baseCommit, onlyGroups, imageBuild, environment});
  if (reusePass) {
    const cached = await readCachedPass({store, key: cacheKey.key});
    if (cached.receipt) {
      process.stderr.write(`consolidated validation: reusing the PASS sealed at ${cached.receiptPath} (identical tree, base, groups, tools, sources and environment)\n`);
      const sealed = await sealJsonNoReplace(output, cached.receipt);
      return {receipt: cached.receipt, sealed, reused: {from: cached.receiptPath, sha256: cached.receiptSha256}};
    }
    process.stderr.write(`consolidated validation: no reusable PASS (${cached.miss}); running in full\n`);
  }
  const [run, imageCheck] = await Promise.all([
    runPreflight(repository, baseCommit, log, onlyGroups),
    imageBuild ? imageBuildCheck(repository, buildImages) : null,
  ]);
  const {groups, checks} = parsePreflightOutput(run.output);
  const preflightRan = checks.length > 0;
  if (imageCheck) checks.push(imageCheck);
  const source_sha256 = {};
  for (const relative of SOURCE_FILES) {
    source_sha256[relative] = await sha256File(path.join(repository, relative));
  }
  const verdict = classifyConsolidatedChecks(run.code, groups, checks);
  const receipt = {
    schema: CONSOLIDATED_VALIDATION_SCHEMA,
    status: preflightRan && verdict.passed ? "pass" : "fail",
    started_at: startedAt,
    completed_at: new Date().toISOString(),
    wikijump_commit: commit,
    wikijump_tree: tree,
    base_commit: baseCommit,
    mode: "final",
    groups,
    checks,
    tool_versions: await toolVersions(),
    preflight: {
      exit: run.code,
      log: {path: log, sha256: await sha256File(log)},
      source_sha256,
    },
  };
  const sealed = await sealJsonNoReplace(output, receipt);
  if (receipt.status === "pass") {
    await recordPass({store, key: cacheKey.key, receiptPath: path.resolve(output), receiptSha256: sealed.sha256, environmentNames: cacheKey.environmentNames})
      .catch((error) => process.stderr.write(`consolidated validation: could not record the PASS for reuse: ${error?.message ?? error}\n`));
  }
  return {receipt, sealed};
}

export async function main(argv, {stdout = console.log} = {}) {
  const args = parseArgs(argv);
  const {receipt, sealed, reused} = await runConsolidatedValidation(args);
  stdout(JSON.stringify({
    schema: receipt.schema,
    status: receipt.status,
    failed: classifyConsolidatedChecks(receipt.preflight.exit, receipt.groups, receipt.checks).failed,
    inconclusive: classifyConsolidatedChecks(receipt.preflight.exit, receipt.groups, receipt.checks).inconclusive,
    output: sealed.path,
    sha256: sealed.sha256,
    ...(reused ? {reused_pass_from: reused.from} : {}),
  }));
  return receipt.status === "pass" ? 0 : 1;
}

await runCliIfMain(import.meta.url, main, {
  onError: (error) => {
    console.error(error?.stack ?? error?.message ?? String(error));
    return 1;
  },
});
