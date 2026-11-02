#!/usr/bin/env node

import {spawn} from "node:child_process";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {
  SEED_CAPTURE_ENV,
  deepwellNextestPartition,
  deepwellTestShards,
  deepwellTestThreads,
  prepareShardSeedCapture,
  runValidationCommand,
  withProvisionedDeepwellStack,
} from "../src/deepwell-integration-stack.mjs";

async function runShards(shards, argv) {
  const script = fileURLToPath(import.meta.url);
  const capture = await prepareShardSeedCapture(process.env);
  const results = await Promise.all(Array.from({length: shards}, (_, index) => new Promise((resolve, reject) => {
    const label = `[shard ${index + 1}/${shards}] `;
    const env = {...process.env, WIKIJUMP_DEEPWELL_NEXTEST_PARTITION: `hash:${index + 1}/${shards}`};
    delete env.WIKIJUMP_DEEPWELL_TEST_SHARDS;
    if (capture.directory) env[SEED_CAPTURE_ENV] = capture.directory;
    else delete env[SEED_CAPTURE_ENV];
    const child = spawn(process.execPath, [script, ...argv], {env, stdio: ["ignore", "pipe", "pipe"]});
    for (const [stream, sink] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
      let pending = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        const lines = (pending + chunk).split("\n");
        pending = lines.pop();
        for (const line of lines) sink.write(`${label}${line}\n`);
      });
      stream.on("end", () => { if (pending) sink.write(`${label}${pending}\n`); });
    }
    child.on("error", reject);
    child.on("exit", (code, signal) => resolve({shard: index + 1, code, signal}));
  }))).finally(() => capture.dispose());
  const failed = results.filter(({code}) => code !== 0);
  if (failed.length > 0) {
    throw new Error(`Deepwell test shards failed: ${failed.map(({shard, code, signal}) => `${shard} (${signal ?? code})`).join(", ")}`);
  }
}

async function run() {
  if (process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
    process.stdout.write(
      [
        "Usage: run-deepwell-integration-validation.mjs [cargo-test-args...] [-- harness-args...]",
        "",
        "Runs Deepwell tests against a task-owned PostgreSQL/Valkey/MinIO stack.",
        "Arguments before -- are forwarded to `cargo test`; arguments after -- are forwarded",
        "to the Rust test harness after the runner's bounded `--test-threads` argument.",
        "Set WIKIJUMP_DEEPWELL_TEST_THREADS=1..16 to select task-owned integration-test concurrency.",
        "Set WIKIJUMP_DEEPWELL_NEXTEST_PARTITION=hash:I/N to run one independently provisioned",
        "nextest shard; each shard still defaults to one active test so task-owned state is isolated.",
        "Set WIKIJUMP_DEEPWELL_TEST_SHARDS=N to run N such shards side by side. The shards then seed once and",
        "restore that capture into their own stacks; WIKIJUMP_DEEPWELL_SEED_CAPTURE=off makes each shard run the",
        "seeder instead, and WIKIJUMP_DEEPWELL_SEED_CAPTURE_ROOT=<dir> keeps captures between runs, keyed by their inputs.",
        "",
      ].join("\n"),
    );
    return;
  }

  const shards = deepwellTestShards(process.env);
  if (shards > 1 && !deepwellNextestPartition(process.env)) {
    await runShards(shards, process.argv.slice(2));
    return;
  }
  const separator = process.argv.indexOf("--", 2);
  const cargoTestArgs = process.argv.slice(2, separator === -1 ? undefined : separator);
  const harnessArgs = separator === -1 ? [] : process.argv.slice(separator + 1);

  await withProvisionedDeepwellStack(async ({env, cargo}) => {
    const partition = deepwellNextestPartition(env);
    if (partition) {
      await runValidationCommand(cargo, [
        "nextest", "run", "--offline", "--locked",
        "--manifest-path", "deepwell/Cargo.toml", ...cargoTestArgs,
        "--partition", partition, "--test-threads", deepwellTestThreads(env),
        ...(harnessArgs.length ? ["--", ...harnessArgs] : []),
      ], {env});
    } else {
      await runValidationCommand(cargo, [
        "test", "--offline", "--locked",
        "--manifest-path", "deepwell/Cargo.toml", ...cargoTestArgs,
        "--", "--test-threads", deepwellTestThreads(env), ...harnessArgs,
      ], {env});
    }
  });
}

run().catch((error) => {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
});
