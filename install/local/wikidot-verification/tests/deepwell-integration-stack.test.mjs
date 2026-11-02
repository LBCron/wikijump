import assert from "node:assert/strict";
import test from "node:test";

import {
  deepwellNextestPartition,
  deepwellTestImageName,
  deepwellTestShards,
  deepwellTestThreads,
  runValidationCommand,
  resolveDeepwellSeedBinary,
  withProvisionedDeepwellStack,
} from "../src/deepwell-integration-stack.mjs";

test("Deepwell stack validates test concurrency and nextest partitions", () => {
  assert.equal(deepwellTestThreads({}), "1");
  assert.equal(deepwellTestThreads({WIKIJUMP_DEEPWELL_TEST_THREADS: "4"}), "4");
  assert.throws(
    () => deepwellTestThreads({WIKIJUMP_DEEPWELL_TEST_THREADS: "0"}),
    /integer from 1 through 16/u,
  );
  assert.equal(deepwellNextestPartition({}), null);
  assert.equal(
    deepwellNextestPartition({WIKIJUMP_DEEPWELL_NEXTEST_PARTITION: "hash:2/4"}),
    "hash:2/4",
  );
  assert.throws(
    () => deepwellNextestPartition({WIKIJUMP_DEEPWELL_NEXTEST_PARTITION: "hash:0/4"}),
    /must look like/u,
  );
});

test("Deepwell stack validates side-by-side shard counts", () => {
  assert.equal(deepwellTestShards({}), 1);
  assert.equal(deepwellTestShards({WIKIJUMP_DEEPWELL_TEST_SHARDS: "4"}), 4);
  for (const value of ["0", "17", "two"]) {
    assert.throws(() => deepwellTestShards({WIKIJUMP_DEEPWELL_TEST_SHARDS: value}), /integer from 1 through 16/u);
  }
});

test("Deepwell stack honors local image overrides", () => {
  assert.equal(
    deepwellTestImageName("database", {WIKIJUMP_DEEPWELL_TEST_DATABASE_IMAGE: "custom-db"}),
    "custom-db",
  );
  assert.equal(deepwellTestImageName("cache", {}), "wikijump-local-development-cache");
});

test("Deepwell seed binary follows Cargo target-directory overrides", async () => {
  const targetDirectory = "/tmp/wikijump-test-quality-target-override";
  const path = await resolveDeepwellSeedBinary({
    env: {...process.env, CARGO_TARGET_DIR: targetDirectory},
  });
  assert.equal(path, `${targetDirectory}/debug/deepwell`);
});

test("validation command can explicitly accept a reviewed nonzero outcome", async () => {
  const result = await runValidationCommand(
    process.execPath,
    ["-e", "process.exit(2)"],
    {acceptableExitCodes: [0, 2]},
  );
  assert.equal(result.exitCode, 2);
});

test("a failed stack provisioning gets one fresh stack, a failed test none", async () => {
  const fakeStack = (outcomes) => {
    const calls = {provisions: 0};
    calls.stack = async (body) => {
      calls.provisions += 1;
      if (outcomes.shift() === "seed-fails") throw new Error("seeder timed out");
      return body({env: {}, cargo: "cargo"});
    };
    return calls;
  };
  const quiet = {log: () => {}};

  const recovered = fakeStack(["seed-fails", "ok"]);
  let runs = 0;
  assert.equal(
    await withProvisionedDeepwellStack(async () => { runs += 1; return "passed"; }, {}, {...quiet, stack: recovered.stack}),
    "passed",
  );
  assert.deepEqual([recovered.provisions, runs], [2, 1]);

  const failingTests = fakeStack(["ok", "ok"]);
  await assert.rejects(
    withProvisionedDeepwellStack(async () => { throw new Error("test failed"); }, {}, {...quiet, stack: failingTests.stack}),
    /test failed/u,
  );
  assert.equal(failingTests.provisions, 1);

  const broken = fakeStack(["seed-fails", "seed-fails", "ok"]);
  await assert.rejects(
    withProvisionedDeepwellStack(async () => "unreached", {}, {...quiet, stack: broken.stack}),
    /seeder timed out/u,
  );
  assert.equal(broken.provisions, 2);
});
