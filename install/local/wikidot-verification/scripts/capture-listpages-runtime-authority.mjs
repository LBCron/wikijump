#!/usr/bin/env node

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  DeepwellJsonRpcClient,
  LISTPAGES_REPLAY_RUNTIME_IDENTITY_SCHEMA,
  LISTPAGES_REPLAY_RUNTIME_PROOF_SCHEMA,
  validateListPagesRuntimeIdentity,
  validateListPagesRuntimeProof,
} from "../src/listpages-preview-differential.mjs";
import {
  exactListPagesFtmlSha,
  listPagesProcessStartTicks,
  listPagesRuntimeEnvironmentAuthority,
  observeListPagesRuntimeAuthority,
  sha256ListPagesFile,
} from "../src/listpages-runtime-authority.mjs";
import {
  publishListPagesJsonNoReplace,
} from "../src/listpages-evidence-publication.mjs";
import { sha256 } from "../src/syntax-differential.mjs";

const execFileAsync = promisify(execFile);
const TRUSTED_DOCKER = "/usr/bin/docker";
const TRUSTED_GIT = "/usr/bin/git";

function nextValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`missing value for ${option}`);
  }
  return value;
}

export function parseArgs(argv) {
  const args = {
    pid: null,
    runtimeConfig: null,
    buildManifest: null,
    rpcUrl: null,
    site: null,
    cacheContainer: null,
    databaseContainer: null,
    filesContainer: null,
    outputIdentity: null,
    outputProof: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const option = argv[index];
    const mappings = new Map([
      ["--runtime-config", "runtimeConfig"],
      ["--build-manifest", "buildManifest"],
      ["--rpc-url", "rpcUrl"],
      ["--site", "site"],
      ["--cache-container", "cacheContainer"],
      ["--database-container", "databaseContainer"],
      ["--files-container", "filesContainer"],
      ["--output-identity", "outputIdentity"],
      ["--output-proof", "outputProof"],
    ]);
    if (option === "--pid") {
      args.pid = Number(nextValue(argv, index, option));
      index += 1;
    } else if (mappings.has(option)) {
      const field = mappings.get(option);
      const value = nextValue(argv, index, option);
      args[field] = [
        "runtimeConfig",
        "buildManifest",
        "outputIdentity",
        "outputProof",
      ].includes(field)
        ? path.resolve(value)
        : value;
      index += 1;
    } else if (option === "--help" || option === "-h") {
      return { help: true };
    } else {
      throw new Error(`unknown argument: ${option}`);
    }
  }
  for (const [field, option] of [
    ["pid", "--pid"],
    ["runtimeConfig", "--runtime-config"],
    ["buildManifest", "--build-manifest"],
    ["rpcUrl", "--rpc-url"],
    ["site", "--site"],
    ["cacheContainer", "--cache-container"],
    ["databaseContainer", "--database-container"],
    ["filesContainer", "--files-container"],
    ["outputIdentity", "--output-identity"],
    ["outputProof", "--output-proof"],
  ]) {
    if (args[field] === null) throw new Error(`${option} is required`);
  }
  if (!Number.isSafeInteger(args.pid) || args.pid < 1) {
    throw new Error("--pid must be a positive integer");
  }
  return args;
}

async function command(executable, args) {
  const { stdout } = await execFileAsync(executable, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout.trim();
}

async function containerIdentity(container, service, expectedHostPort) {
  const inspection = JSON.parse(
    await command(TRUSTED_DOCKER, ["inspect", container]),
  )[0];
  const internalPort = {
    cache: "6379/tcp",
    database: "5432/tcp",
    files: "9000/tcp",
  }[service];
  const bindings = inspection?.NetworkSettings?.Ports?.[internalPort];
  if (
    !/^[0-9a-f]{64}$/u.test(inspection?.Id ?? "") ||
    !/^sha256:[0-9a-f]{64}$/u.test(inspection?.Image ?? "") ||
    inspection?.State?.Running !== true ||
    !Array.isArray(bindings) ||
    !bindings.some(
      (binding) =>
        binding?.HostIp === "127.0.0.1" &&
        Number(binding?.HostPort) === expectedHostPort,
    )
  ) {
    throw new Error(
      `runtime service container does not own its candidate endpoint: ${container}`,
    );
  }
  return {
    id: inspection.Id,
    image_sha256: inspection.Image.slice("sha256:".length),
  };
}

export async function captureListPagesRuntimeAuthority(args) {
  const procRoot = `/proc/${args.pid}`;
  const [
    repository,
    statText,
    executableSha256,
    runtimeConfigSha256,
    runtimeEnvironment,
    manifestText,
  ] = await Promise.all([
    fs.readlink(path.join(procRoot, "cwd")),
    fs.readFile(path.join(procRoot, "stat"), "utf8"),
    sha256ListPagesFile(path.join(procRoot, "exe")),
    sha256ListPagesFile(args.runtimeConfig),
    fs.readFile(path.join(procRoot, "environ"))
      .then(listPagesRuntimeEnvironmentAuthority),
    fs.readFile(args.buildManifest, "utf8"),
  ]);
  const [cache, database, files] = await Promise.all([
    containerIdentity(
      args.cacheContainer,
      "cache",
      runtimeEnvironment.service_host_port.cache,
    ),
    containerIdentity(
      args.databaseContainer,
      "database",
      runtimeEnvironment.service_host_port.database,
    ),
    containerIdentity(
      args.filesContainer,
      "files",
      runtimeEnvironment.service_host_port.files,
    ),
  ]);
  const manifest = JSON.parse(manifestText);
  const lockText = await fs.readFile(
    path.join(repository, "deepwell", "Cargo.lock"),
    "utf8",
  );
  const [wikijumpSha, wikijumpTree] = await Promise.all([
    command(TRUSTED_GIT, ["-C", repository, "rev-parse", "HEAD"]),
    command(TRUSTED_GIT, ["-C", repository, "rev-parse", "HEAD^{tree}"]),
  ]);
  const site = await new DeepwellJsonRpcClient({
    rpcUrl: args.rpcUrl,
  }).call("site_get", { site: args.site });
  if (
    !Number.isSafeInteger(site?.site_id) ||
    site.site_id < 1 ||
    site.slug !== args.site
  ) {
    throw new Error("running endpoint did not return the exact requested site");
  }
  const identity = validateListPagesRuntimeIdentity({
    schema: LISTPAGES_REPLAY_RUNTIME_IDENTITY_SCHEMA,
    wikijump_sha: wikijumpSha,
    wikijump_tree: wikijumpTree,
    ftml_sha: exactListPagesFtmlSha(lockText),
    dependency_lock_sha256: sha256(lockText),
    build_manifest_sha256: sha256(manifestText),
    build_artifact_key: manifest.artifact_key?.key,
    executable_sha256: executableSha256,
    runtime_config_sha256: runtimeConfigSha256,
    runtime_environment_sha256: runtimeEnvironment.sha256,
    profile: manifest.build?.profile,
    rpc_url: args.rpcUrl,
    site_slug: site.slug,
    site_id: site.site_id,
    service_image_sha256: {
      deepwell: executableSha256,
      cache: cache.image_sha256,
      database: database.image_sha256,
      files: files.image_sha256,
    },
    service_host_port: { ...runtimeEnvironment.service_host_port },
  });
  const proof = validateListPagesRuntimeProof({
    schema: LISTPAGES_REPLAY_RUNTIME_PROOF_SCHEMA,
    observed_at: new Date().toISOString(),
    run_nonce: crypto.randomBytes(32).toString("hex"),
    candidate: {
      wikijump_sha: identity.wikijump_sha,
      wikijump_tree: identity.wikijump_tree,
      ftml_sha: identity.ftml_sha,
      dependency_lock_sha256: identity.dependency_lock_sha256,
      build_manifest_sha256: identity.build_manifest_sha256,
      build_artifact_key: identity.build_artifact_key,
      executable_sha256: identity.executable_sha256,
      runtime_config_sha256: identity.runtime_config_sha256,
      runtime_environment_sha256: identity.runtime_environment_sha256,
      profile: identity.profile,
    },
    rpc_url: identity.rpc_url,
    site_slug: identity.site_slug,
    site_id: identity.site_id,
    service_image_sha256: { ...identity.service_image_sha256 },
    service_host_port: { ...identity.service_host_port },
    process: {
      pid: args.pid,
      start_ticks: listPagesProcessStartTicks(statText, args.pid),
      config_path: args.runtimeConfig,
      build_manifest_path: args.buildManifest,
    },
    service_containers: {
      cache: cache.id,
      database: database.id,
      files: files.id,
    },
  }, identity);
  const observation = await observeListPagesRuntimeAuthority({
    identity,
    proof,
    phase: "capture",
  });
  await publishListPagesJsonNoReplace(args.outputIdentity, identity);
  await publishListPagesJsonNoReplace(args.outputProof, proof);
  return {
    identity,
    proof,
    observation,
  };
}

function printHelp() {
  console.log(
    "Usage: capture-listpages-runtime-authority.mjs --pid PID --runtime-config FILE --build-manifest FILE --rpc-url URL --site SLUG --cache-container ID --database-container ID --files-container ID --output-identity FILE --output-proof FILE",
  );
}

export async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  const result = await captureListPagesRuntimeAuthority(args);
  console.log(JSON.stringify({
    runtime_identity: args.outputIdentity,
    runtime_proof: args.outputProof,
    stable_sha256: result.observation.stable_sha256,
  }));
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
