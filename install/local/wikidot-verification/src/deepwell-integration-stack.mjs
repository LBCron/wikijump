import {spawn} from "node:child_process";
import {mkdir, mkdtemp, rename, rm, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";

import {
  captureSeededStack,
  computeSeedCaptureKey,
  restoreSeedCapture,
  verifySeedCapture,
  withSeedCaptureFallback,
} from "./deepwell-seed-capture.mjs";
import {waitForPublishedPostgres} from "./postgres-published-readiness.mjs";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

export const DEFAULT_DEEPWELL_TEST_IMAGES = Object.freeze({
  database: "wikijump-local-development-database",
  cache: "wikijump-local-development-cache",
  files: "wikijump-local-development-files",
});

export const SEED_CAPTURE_ENV = "WIKIJUMP_DEEPWELL_SEED_CAPTURE";
export const SEED_CAPTURE_ROOT_ENV = "WIKIJUMP_DEEPWELL_SEED_CAPTURE_ROOT";

const SEED_ARGUMENTS = Object.freeze([
  "--disable-log",
  "--localizations", "locales",
  "--seed", "deepwell/seeder",
  "install/local/deepwell/config.toml",
]);

function fail(message) {
  throw new Error(message);
}

export function deepwellTestThreads(env = process.env) {
  const raw = env.WIKIJUMP_DEEPWELL_TEST_THREADS?.trim() || "1";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    fail("WIKIJUMP_DEEPWELL_TEST_THREADS must be an integer from 1 through 16");
  }
  return String(value);
}

export function deepwellTestShards(env = process.env) {
  const raw = env.WIKIJUMP_DEEPWELL_TEST_SHARDS?.trim() || "1";
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    fail("WIKIJUMP_DEEPWELL_TEST_SHARDS must be an integer from 1 through 16");
  }
  return value;
}

export function deepwellNextestPartition(env = process.env) {
  const value = env.WIKIJUMP_DEEPWELL_NEXTEST_PARTITION?.trim();
  if (!value) return null;
  if (!/^(?:hash|count|slice):[1-9][0-9]*\/[1-9][0-9]*$/u.test(value)) {
    fail("WIKIJUMP_DEEPWELL_NEXTEST_PARTITION must look like hash:1/4, count:2/4, or slice:3/4");
  }
  return value;
}

export function deepwellTestImageName(role, env = process.env) {
  const override = env[`WIKIJUMP_DEEPWELL_TEST_${role.toUpperCase()}_IMAGE`];
  return override?.trim() || DEFAULT_DEEPWELL_TEST_IMAGES[role];
}

export function runValidationCommand(commandName, args, {
  env = process.env,
  capture = false,
  cwd = REPOSITORY_ROOT,
  acceptableExitCodes = [0],
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(commandName, args, {
      cwd,
      env,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    let stdout = "";
    let stderr = "";
    if (capture) {
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
    }
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code !== null && acceptableExitCodes.includes(code)) return resolve({stdout, stderr, exitCode: code});
      const detail = signal ? `signal ${signal}` : `status ${code}`;
      reject(new Error(`${commandName} failed with ${detail}${capture && stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

async function requireLocalImage(image, role) {
  try {
    await runValidationCommand("docker", ["image", "inspect", image], {capture: true});
  } catch {
    fail(
      `Deepwell integration validation requires the already-built local ${role} image ${image}; ` +
      "refusing to pull an image during the hermetic final barrier",
    );
  }
}

async function containerPort(container, port) {
  const {stdout} = await runValidationCommand("docker", ["port", container, `${port}/tcp`], {capture: true});
  const line = stdout.trim().split("\n").find(Boolean);
  const match = line?.match(/:(\d+)$/u);
  if (!match) fail(`cannot resolve loopback port ${port} for ${container}`);
  return Number(match[1]);
}

async function waitFor(commandName, args, description, attempts = 60) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await runValidationCommand(commandName, args, {capture: true});
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`${description} did not become ready: ${lastError?.message ?? "unknown error"}`);
}

async function removeContainer(container) {
  await runValidationCommand("docker", ["rm", "-f", "-v", container], {capture: true}).catch(() => undefined);
}

function testEnvironment({databasePort, cachePort, filesPort}, baseEnv) {
  return {
    ...baseEnv,
    DATABASE_URL: `postgres://wikijump:wikijump@127.0.0.1:${databasePort}/wikijump`,
    REDIS_URL: `redis://127.0.0.1:${cachePort}`,
    DEEPWELL_RPC_TOKEN: "0".repeat(64),
    S3_FILES_BUCKET: "deepwell-files",
    S3_TEXT_BLOCKS_BUCKET: "deepwell-text-blocks",
    S3_REGION_NAME: "local",
    S3_PATH_STYLE: "true",
    S3_CUSTOM_ENDPOINT: `http://127.0.0.1:${filesPort}`,
    S3_ACCESS_KEY_ID: "minio",
    S3_SECRET_ACCESS_KEY: "defaultpassword",
    RUST_MIN_STACK: "8388608",
    CARGO_BUILD_JOBS: baseEnv.CARGO_BUILD_JOBS?.trim() || "1",
    WIKIJUMP_DEEPWELL_TEST_ENVIRONMENT: "task-owned",
  };
}

export async function resolveDeepwellSeedBinary({cargo = "cargo", env = process.env} = {}) {
  const {stdout} = await runValidationCommand(cargo, [
    "metadata", "--format-version", "1", "--no-deps", "--offline", "--locked",
    "--manifest-path", "deepwell/Cargo.toml",
  ], {env, capture: true});
  const metadata = JSON.parse(stdout);
  if (typeof metadata.target_directory !== "string" || metadata.target_directory.length === 0) {
    fail("cargo metadata did not report a target_directory for Deepwell");
  }
  return join(metadata.target_directory, "debug", process.platform === "win32" ? "deepwell.exe" : "deepwell");
}

export async function withProvisionedDeepwellStack(body, options = {}, {
  stack = withDeepwellIntegrationStack,
  log = (message) => console.error(message),
} = {}) {
  for (let attempt = 1; ; attempt += 1) {
    let provisioned = false;
    try {
      return await stack(async (context) => {
        provisioned = true;
        return await body(context);
      }, options);
    } catch (error) {
      if (provisioned || attempt >= 2) throw error;
      log(`Deepwell test stack provisioning failed; retrying once on a fresh stack: ${error?.message ?? error}`);
    }
  }
}

export async function withDeepwellIntegrationStack(callback, options = {}) {
  const baseEnv = options.env ?? process.env;
  const requested = options.seedCapture === undefined ? baseEnv[SEED_CAPTURE_ENV]?.trim() : options.seedCapture;
  const capture = options.seed === false || !requested || requested === "off" ? null : requested;
  return await withSeedCaptureFallback(
    (activeCapture, markBodyEntered) => provisionStack(
      async (context) => {
        markBodyEntered?.();
        return await callback(context);
      },
      options,
      activeCapture,
    ),
    capture,
  );
}

async function provisionStack(callback, {
  env: baseEnv = process.env,
  cargo = baseEnv.WIKIJUMP_OFFLINE_CARGO?.trim() || "cargo",
  seed = true,
} = {}, capture = null) {
  const images = Object.fromEntries(
    Object.keys(DEFAULT_DEEPWELL_TEST_IMAGES).map((role) => [role, deepwellTestImageName(role, baseEnv)]),
  );
  await Promise.all(Object.entries(images).map(([role, image]) => requireLocalImage(image, role)));

  const suffix = `${process.pid}-${Date.now()}`;
  const containers = {
    database: `wikijump-deepwell-test-db-${suffix}`,
    cache: `wikijump-deepwell-test-cache-${suffix}`,
    files: `wikijump-deepwell-test-files-${suffix}`,
  };
  let cleanupStarted = false;
  const cleanup = async () => {
    if (cleanupStarted) return;
    cleanupStarted = true;
    await Promise.all(Object.values(containers).map(removeContainer));
  };
  const onSignal = (signal) => {
    cleanup().finally(() => process.kill(process.pid, signal));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);

  try {
    await runValidationCommand("docker", [
      "run", "-d", "--name", containers.database,
      "-e", "POSTGRES_DB=wikijump",
      "-e", "POSTGRES_USER=wikijump",
      "-e", "POSTGRES_PASSWORD=wikijump",
      "-e", "POSTGRES_HOST_AUTH_METHOD=md5",
      "-e", "POSTGRES_INITDB_ARGS=--locale en_US.UTF-8",
      "-p", "127.0.0.1::5432",
      images.database,
    ], {capture: true});
    await runValidationCommand("docker", [
      "run", "-d", "--name", containers.cache,
      "-p", "127.0.0.1::6379",
      images.cache,
    ], {capture: true});
    await runValidationCommand("docker", [
      "run", "-d", "--name", containers.files,
      "--tmpfs", "/data:rw,size=2g",
      "-e", "MINIO_ROOT_USER=minio",
      "-e", "MINIO_ROOT_PASSWORD=defaultpassword",
      "-e", "MINIO_REGION_NAME=local",
      "-e", "INITIAL_BUCKETS=deepwell-files deepwell-text-blocks",
      "-e", "DATA_DIR=/data",
      "-p", "127.0.0.1::9000",
      images.files,
    ], {capture: true});

    await Promise.all([
      waitFor("docker", ["exec", containers.database, "pg_isready", "-U", "wikijump", "-d", "wikijump"], "task-owned PostgreSQL"),
      waitFor("docker", ["exec", containers.cache, "valkey-cli", "ping"], "task-owned Valkey"),
    ]);
    const [databasePort, cachePort, filesPort] = await Promise.all([
      containerPort(containers.database, 5432),
      containerPort(containers.cache, 6379),
      containerPort(containers.files, 9000),
    ]);
    const env = testEnvironment({databasePort, cachePort, filesPort}, baseEnv);
    await Promise.all([
      waitForPublishedPostgres({port: databasePort}),
      waitFor(
        process.execPath,
        ["-e", `fetch(${JSON.stringify(env.S3_CUSTOM_ENDPOINT + "/minio/health/live")}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))`],
        "task-owned MinIO",
      ),
    ]);

    if (capture) {
      const started = Date.now();
      await restoreSeedCapture({
        run: runValidationCommand,
        containers,
        ports: {database: databasePort, cache: cachePort, files: filesPort},
        buckets: [env.S3_FILES_BUCKET, env.S3_TEXT_BLOCKS_BUCKET],
        directory: capture,
        expectedKey: capture.split("/").filter(Boolean).at(-1),
      });
      console.error(`Deepwell test stack restored from seed capture ${capture.split("/").filter(Boolean).at(-1).slice(0, 12)} in ${Date.now() - started} ms`);
    } else {
      await runValidationCommand("sqlx", ["migrate", "run", "--source", "deepwell/migrations"], {env});
    }
    if (seed && !capture) {
      await runValidationCommand(cargo, [
        "build", "--offline", "--locked",
        "--manifest-path", "deepwell/Cargo.toml", "--bin", "deepwell",
      ], {env});
      const seedBinary = await resolveDeepwellSeedBinary({cargo, env});
      await runValidationCommand(seedBinary, [...SEED_ARGUMENTS], {env: {...env, DEEPWELL_RUNTIME_ACTION: "seeder"}});
    }

    return await callback({env, cargo, containers, ports: {database: databasePort, cache: cachePort, files: filesPort}});
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await cleanup();
  }
}

async function imageId(image) {
  const {stdout} = await runValidationCommand("docker", ["image", "inspect", "--format", "{{.Id}}", image], {capture: true});
  return stdout.trim();
}

function staticSeedEnvironment() {
  const {
    DATABASE_URL: _database,
    REDIS_URL: _cache,
    S3_CUSTOM_ENDPOINT: _files,
    CARGO_BUILD_JOBS: _jobs,
    ...rest
  } = testEnvironment({databasePort: 0, cachePort: 0, filesPort: 0}, {});
  return rest;
}

export async function ensureDeepwellSeedCapture({
  env: baseEnv = process.env,
  cargo = baseEnv.WIKIJUMP_OFFLINE_CARGO?.trim() || "cargo",
  root = REPOSITORY_ROOT,
  captureRoot,
  log = (message) => console.error(message),
} = {}) {
  const images = Object.fromEntries(
    Object.keys(DEFAULT_DEEPWELL_TEST_IMAGES).map((role) => [role, deepwellTestImageName(role, baseEnv)]),
  );
  await Promise.all(Object.entries(images).map(([role, image]) => requireLocalImage(image, role)));
  const imageIds = Object.fromEntries(await Promise.all(
    Object.entries(images).map(async ([role, image]) => [role, await imageId(image)]),
  ));

  const buildEnv = {...baseEnv, CARGO_BUILD_JOBS: baseEnv.CARGO_BUILD_JOBS?.trim() || "1"};
  await runValidationCommand(cargo, [
    "build", "--offline", "--locked", "--manifest-path", "deepwell/Cargo.toml", "--bin", "deepwell",
  ], {env: buildEnv, cwd: root});
  const binaryPath = await resolveDeepwellSeedBinary({cargo, env: buildEnv});
  const {key, inputs} = await computeSeedCaptureKey({
    root, binaryPath, imageIds, staticEnv: staticSeedEnvironment(), seedArguments: [...SEED_ARGUMENTS],
  });

  await mkdir(captureRoot, {recursive: true});
  const directory = join(captureRoot, key);
  if (await stat(directory).then(() => true, () => false)) {
    try {
      await verifySeedCapture(directory, key);
      log(`Deepwell seed capture ${key.slice(0, 12)} reused from ${captureRoot}`);
      return {directory, key, reused: true};
    } catch (error) {
      log(`Deepwell seed capture ${key.slice(0, 12)} is unusable and will be rebuilt: ${error.message}`);
    }
  }

  const staging = await mkdtemp(join(captureRoot, ".staging-"));
  try {
    const started = Date.now();
    await withProvisionedDeepwellStack(async ({env, containers, ports}) => {
      await captureSeededStack({
        run: runValidationCommand,
        containers,
        ports,
        buckets: [env.S3_FILES_BUCKET, env.S3_TEXT_BLOCKS_BUCKET],
        directory: staging,
        key,
        inputs,
      });
    }, {env: baseEnv, cargo, seedCapture: null});
    await verifySeedCapture(staging, key);
    await rm(directory, {recursive: true, force: true});
    await rename(staging, directory);
    log(`Deepwell seed capture ${key.slice(0, 12)} built in ${Date.now() - started} ms`);
    return {directory, key, reused: false};
  } finally {
    await rm(staging, {recursive: true, force: true});
  }
}

export async function temporarySeedCaptureRoot() {
  const directory = await mkdtemp(join(tmpdir(), "wikijump-deepwell-seed-"));
  return {directory, dispose: () => rm(directory, {recursive: true, force: true})};
}

export async function prepareShardSeedCapture(env = process.env, {
  ensure = ensureDeepwellSeedCapture,
  log = (message) => console.error(message),
} = {}) {
  const named = env[SEED_CAPTURE_ENV]?.trim();
  if (named) return {directory: named === "off" ? null : named, dispose: async () => {}};
  const persistent = env[SEED_CAPTURE_ROOT_ENV]?.trim();
  const temporary = persistent ? null : await temporarySeedCaptureRoot();
  const dispose = async () => { await temporary?.dispose(); };
  try {
    const {directory} = await ensure({env, captureRoot: persistent || temporary.directory, log});
    return {directory, dispose};
  } catch (error) {
    log(`Deepwell seed capture could not be prepared; every shard will seed its own stack: ${error?.message ?? error}`);
    await dispose();
    return {directory: null, dispose: async () => {}};
  }
}
