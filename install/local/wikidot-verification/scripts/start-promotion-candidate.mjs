#!/usr/bin/env node

import {execFile as execFileCallback} from "node:child_process";
import {randomBytes} from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {promisify} from "node:util";

import {runCliIfMain} from "../src/cli-entry.mjs";
import {promotionSourceIdentity} from "./build-promotion-candidate-images.mjs";

const execFile = promisify(execFileCallback);
const DOCKER = "/usr/bin/docker";
const PYTHON = "/usr/bin/python3";
function fail(message) {
  throw new Error(message);
}

async function writeJson(filePath, value, mode = 0o600) {
  await fs.mkdir(path.dirname(filePath), {recursive: true, mode: 0o700});
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, {mode});
}

export function candidateDeepwellConfig(source, port, {seed = true} = {}) {
  let config = source;
  for (const [before, after] of [
    ["run-seeder = false", seed ? "run-seeder = true" : "run-seeder = false"],
    ['seeder-path = "seeder"', 'seeder-path = "/opt/deepwell/seeder"'],
    ['main = "wikijump.com"', 'main = "wikijump.localhost"'],
    ["https-port = 443", `https-port = ${port}`],
    ['files = "wjfiles.com"', 'files = "wjfiles.localhost"'],
    ["mock-mailcheck = false", "mock-mailcheck = true"],
  ]) {
    if (!config.includes(before)) fail(`candidate Deepwell config source does not contain ${before}`);
    config = config.replace(before, after);
  }
  return config;
}

function candidateCaddyRequest() {
  return {
    jsonrpc: "2.0",
    method: "caddyfile",
    id: 0,
    params: {
      debug: false,
      local: true,
      http_port: 80,
      https_port: 443,
      framerail_host: "framerail:3393",
      wws_host: "wws:3466",
    },
  };
}

function candidateCaddyGenerator(publicPort) {
  return `#!/bin/sh
set -eu
curl -fsS http://deepwell:2747/jsonrpc -X POST -H @/run/wikijump/deepwell-authorization-header --json @/etc/caddy-request.json > /tmp/deepwell.json
error="$(jq .error /tmp/deepwell.json)"
if [ "$error" != null ]; then cat /tmp/deepwell.json; exit 1; fi
jq -r .result /tmp/deepwell.json > /tmp/Caddyfile
rm /tmp/deepwell.json
# Public URLs retain :${publicPort}; the candidate container itself owns TLS on 443.
sed -E -i '/^[^[:space:]#].*:${publicPort}[[:space:]]*\\{$/ s/:${publicPort}([[:space:]]*\\{)$/\\:443\\1/' /tmp/Caddyfile
# Caddy host matchers compare host names without the external forwarding port.
sed -i '/^[[:space:]]*@.* host / s/:${publicPort}$//' /tmp/Caddyfile
`;
}

function runtimeLabels({source, expiry, role}) {
  return {
    "com.rokurolize.wikijump.owner": "compatibility-candidate",
    "com.rokurolize.wikijump.sha": source.wikijump_commit,
    "com.rokurolize.wikijump.expires_at": expiry,
    "com.rokurolize.wikijump.role": role,
  };
}

function healthcheck(test, startPeriod = "10s") {
  return {test, interval: "5s", timeout: "3s", retries: 120, start_period: startPeriod};
}

export function candidateCompose({
  project,
  source,
  images,
  expiry,
  publicPort,
  rpcPort,
  objectStorePort,
  deepwellConfigPath,
  caddyRequestPath,
  caddyGeneratorPath,
  dataVolumes = {},
}) {
  const common = (role) => ({
    image: images[role],
    pull_policy: "never",
    restart: "unless-stopped",
    hostname: `${project}-${role}`,
    labels: runtimeLabels({source, expiry, role}),
  });
  const services = {
    database: {
      ...common("database"),
      environment: {
        POSTGRES_DB: "wikijump", POSTGRES_USER: "wikijump", POSTGRES_PASSWORD: "wikijump",
        POSTGRES_HOST_AUTH_METHOD: "md5", POSTGRES_INITDB_ARGS: "--locale en_US.UTF-8",
      },
      volumes: ["database-data:/var/lib/postgresql/data"],
      healthcheck: healthcheck(["CMD", "wikijump-health-check"]),
    },
    files: {
      ...common("files"),
      environment: {
        MINIO_ROOT_USER: "minio", MINIO_ROOT_PASSWORD: "defaultpassword", MINIO_REGION_NAME: "local",
        INITIAL_BUCKETS: "deepwell-files deepwell-text-blocks", DATA_DIR: "/data",
      },
      ports: [`127.0.0.1:${objectStorePort}:9000`],
      volumes: ["files-data:/data"],
      healthcheck: healthcheck(["CMD", "/healthcheck.sh"]),
    },
    cache: {
      ...common("cache"),
      volumes: ["cache-data:/data"],
      healthcheck: healthcheck(["CMD", "valkey-cli", "ping"]),
    },
    deepwell: {
      ...common("deepwell"),
      environment: {
        DATABASE_URL: "postgres://wikijump:wikijump@database/wikijump", REDIS_URL: "redis://cache",
        S3_FILES_BUCKET: "deepwell-files", S3_TEXT_BLOCKS_BUCKET: "deepwell-text-blocks", S3_REGION_NAME: "local",
        S3_PATH_STYLE: "true", S3_CUSTOM_ENDPOINT: "http://files:9000", S3_ACCESS_KEY_ID: "minio",
        S3_SECRET_ACCESS_KEY: "defaultpassword", DEEPWELL_RPC_TOKEN: "${DEEPWELL_RPC_TOKEN:?DEEPWELL_RPC_TOKEN is required}",
        DEEPWELL_BUILD_PROFILE: "release",
      },
      ports: [`127.0.0.1:${rpcPort}:2747`],
      volumes: [{type: "bind", source: deepwellConfigPath, target: "/etc/deepwell.toml", read_only: true}],
      tmpfs: ["/run:uid=1,gid=1,mode=755"],
      healthcheck: healthcheck(["CMD", "wikijump-health-check"], "30s"),
      depends_on: {database: {condition: "service_healthy"}, files: {condition: "service_healthy"}, cache: {condition: "service_healthy"}},
    },
    framerail: {
      ...common("framerail"),
      environment: {
        DEEPWELL_HOST: "deepwell", DEEPWELL_RPC_TOKEN: "${DEEPWELL_RPC_TOKEN:?DEEPWELL_RPC_TOKEN is required}",
        FRAMERAIL_MODE: "built", FRAMERAIL_ENV: "local", FRAMERAIL_CSRF_CHECK_ORIGIN: "true", REDIS_URL: "redis://cache",
      },
      healthcheck: healthcheck(["CMD", "node", "-e", "const net=require('node:net');const s=net.connect(3393,'127.0.0.1',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),1500)"]),
      depends_on: {deepwell: {condition: "service_healthy"}, cache: {condition: "service_healthy"}},
    },
    wws: {
      ...common("wws"),
      environment: {
        ADDRESS: "[::]:3466", DEEPWELL_URL: "http://deepwell:2747",
        DEEPWELL_RPC_TOKEN: "${DEEPWELL_RPC_TOKEN:?DEEPWELL_RPC_TOKEN is required}", REDIS_URL: "redis://cache",
        S3_FILES_BUCKET: "deepwell-files", S3_TEXT_BLOCKS_BUCKET: "deepwell-text-blocks", S3_REGION_NAME: "local",
        S3_PATH_STYLE: "true", S3_CUSTOM_ENDPOINT: "http://files:9000", S3_ACCESS_KEY_ID: "minio",
        S3_SECRET_ACCESS_KEY: "defaultpassword", WWS_BUILD_PROFILE: "release",
      },
      healthcheck: healthcheck(["CMD", "wikijump-health-check"], "30s"),
      depends_on: {deepwell: {condition: "service_healthy"}, files: {condition: "service_healthy"}, cache: {condition: "service_healthy"}},
    },
    caddy: {
      ...common("caddy"),
      environment: {DEEPWELL_RPC_TOKEN: "${DEEPWELL_RPC_TOKEN:?DEEPWELL_RPC_TOKEN is required}"},
      ports: [`127.0.0.1:${publicPort}:443`],
      volumes: [
        {type: "bind", source: caddyRequestPath, target: "/etc/caddy-request.json", read_only: true},
        {type: "bind", source: caddyGeneratorPath, target: "/opt/wikijump-candidate/generate-caddyfile.sh", read_only: true},
        "caddy-data:/data", "caddy-config:/config",
      ],
      command: ["sh", "-c", "cp /opt/wikijump-candidate/generate-caddyfile.sh /usr/local/bin/wikijump-generate-caddyfile && chmod +x /usr/local/bin/wikijump-generate-caddyfile && exec /usr/local/bin/wikijump-start-caddy"],
      healthcheck: healthcheck(["CMD-SHELL", "curl --insecure --fail --silent --show-error -I -H 'Host: scp-wiki.wikijump.localhost' https://localhost/-/health-check/caddy >/dev/null"]),
      depends_on: {framerail: {condition: "service_healthy"}, wws: {condition: "service_healthy"}},
    },
  };
  const volume = (name) => (name ? {external: true, name} : {});
  return {
    name: project,
    services,
    volumes: {
      "database-data": volume(dataVolumes.database),
      "files-data": volume(dataVolumes.files),
      "cache-data": {},
      "caddy-data": {},
      "caddy-config": {},
    },
  };
}

async function dockerCompose(composePath, project, token, args) {
  return execFile(DOCKER, ["compose", "-p", project, "-f", composePath, ...args], {
    env: {...process.env, DEEPWELL_RPC_TOKEN: token},
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

async function candidateContainerInspections(project) {
  const {stdout} = await execFile(DOCKER, ["ps", "--all", "--quiet", "--filter", `label=com.docker.compose.project=${project}`], {encoding: "utf8"});
  const ids = stdout.split("\n").map((value) => value.trim()).filter(Boolean);
  if (ids.length !== 7) fail(`candidate project must contain exactly seven containers, found ${ids.length}`);
  const inspections = [];
  for (const id of ids) {
    const {stdout: raw} = await execFile(DOCKER, ["inspect", id], {encoding: "utf8", maxBuffer: 16 * 1024 * 1024});
    const values = JSON.parse(raw);
    if (!Array.isArray(values) || values.length !== 1) fail("candidate container inspection is malformed");
    inspections.push(values[0]);
  }
  return inspections;
}

async function waitForCandidateHealth(project, timeoutMs = 20 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const inspections = await candidateContainerInspections(project);
    const unhealthy = inspections.filter((inspect) => inspect.State?.Running !== true || inspect.State?.Health?.Status !== "healthy");
    if (unhealthy.length === 0) return inspections;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  fail("candidate runtime did not become healthy before the deadline");
}

async function renderPromotionBase({sourceRoot, outputDir, source, images, token}) {
  const args = [
    path.join(sourceRoot, "install", "standing", "render.py"),
    "--source-root", sourceRoot,
    "--output-dir", outputDir,
    "--wikijump-sha", source.wikijump_commit,
    "--ftml-sha", source.ftml_sha,
    "--project-name", "wikijump-standing",
    "--database-image", images.database,
    "--files-image", images.files,
    "--cache-image", images.cache,
    "--deepwell-image", images.deepwell,
    "--framerail-image", images.framerail,
    "--wws-image", images.wws,
    "--caddy-image", images.caddy,
  ];
  await execFile(PYTHON, args, {env: {...process.env, DEEPWELL_RPC_TOKEN: token}, maxBuffer: 16 * 1024 * 1024});
}

async function builtImages(buildEvidencePath) {
  const finalImages = JSON.parse(await fs.readFile(path.join(buildEvidencePath, "images", "final-images.json"), "utf8"));
  return Object.fromEntries(finalImages.map((entry) => [entry.role, entry.image_id]));
}

export async function prepareCandidateFiles({sourceRoot, candidateRoot, publicPort, images, source, token, stagingHome, seed = true}) {
  await fs.mkdir(candidateRoot, {recursive: false, mode: 0o700});
  const deepwellConfigPath = path.join(candidateRoot, "deepwell", "config.toml");
  const caddyRequestPath = path.join(candidateRoot, "caddy", "request.json");
  const caddyGeneratorPath = path.join(candidateRoot, "caddy", "generate-caddyfile.sh");
  const prodDeepwellConfig = await fs.readFile(path.join(sourceRoot, "install", "prod", "deepwell", "config.toml"), "utf8");
  await renderPromotionBase({sourceRoot, outputDir: stagingHome, source, images, token});
  await fs.mkdir(path.dirname(deepwellConfigPath), {recursive: true, mode: 0o700});
  await fs.mkdir(path.dirname(caddyRequestPath), {recursive: true, mode: 0o700});
  await fs.writeFile(deepwellConfigPath, candidateDeepwellConfig(prodDeepwellConfig, publicPort, {seed}), {mode: 0o644});
  await writeJson(caddyRequestPath, candidateCaddyRequest(), 0o644);
  await fs.writeFile(caddyGeneratorPath, candidateCaddyGenerator(publicPort), {mode: 0o755});
  return {deepwellConfigPath, caddyRequestPath, caddyGeneratorPath};
}

export async function startPromotionCandidate({sourceRoot, buildEvidencePath, candidateRoot, stagingHome, publicPort, rpcPort, objectStorePort, project, expiry, dataVolumes = {}}) {
  const source = await promotionSourceIdentity(sourceRoot);
  const images = await builtImages(buildEvidencePath);
  const token = randomBytes(32).toString("hex");
  const seed = !dataVolumes.database;
  const files = await prepareCandidateFiles({sourceRoot, candidateRoot, publicPort, images, source, token, stagingHome, seed});
  const composePath = path.join(candidateRoot, "compose.json");
  await writeJson(composePath, candidateCompose({
    project, source, images, expiry, publicPort, rpcPort, objectStorePort,
    deepwellConfigPath: files.deepwellConfigPath, caddyRequestPath: files.caddyRequestPath, caddyGeneratorPath: files.caddyGeneratorPath,
    dataVolumes,
  }));
  try {
    await dockerCompose(composePath, project, token, ["up", "--detach", "--no-build"]);
    await waitForCandidateHealth(project);
    return {project, candidateRoot, stagingHome};
  } catch (error) {
    await dockerCompose(composePath, project, token, ["down", "--volumes", "--remove-orphans"]).catch(() => {});
    throw error;
  }
}

function parseInteger(value, name) {
  const number = Number.parseInt(value, 10);
  if (!Number.isInteger(number) || number <= 0 || number > 65535 || number === 443) fail(`${name} must be a non-443 TCP port`);
  return number;
}

function parseArgs(argv) {
  const required = ["source-root", "build-evidence", "candidate-root", "staging-home", "public-port", "rpc-port", "object-store-port", "project", "expires-at"];
  const allowed = new Set([...required, "database-volume", "files-volume"]);
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const name = flag?.startsWith("--") ? flag.slice(2) : "";
    const value = argv[index + 1];
    if (!allowed.has(name) || Object.hasOwn(args, name) || !value || value.startsWith("--")) fail(`unknown or duplicate option: ${flag}`);
    args[name] = value;
  }
  for (const name of required) if (!args[name]) fail(`--${name} is required`);
  if (Boolean(args["database-volume"]) !== Boolean(args["files-volume"])) fail("--database-volume and --files-volume go together");
  return args;
}

export async function main(argv, {stdout = console.log} = {}) {
  const args = parseArgs(argv);
  if (!Number.isFinite(Date.parse(args["expires-at"]))) fail("--expires-at must be an ISO timestamp");
  const result = await startPromotionCandidate({
    sourceRoot: path.resolve(args["source-root"]),
    buildEvidencePath: path.resolve(args["build-evidence"]),
    candidateRoot: path.resolve(args["candidate-root"]),
    stagingHome: path.resolve(args["staging-home"]),
    publicPort: parseInteger(args["public-port"], "--public-port"),
    rpcPort: parseInteger(args["rpc-port"], "--rpc-port"),
    objectStorePort: parseInteger(args["object-store-port"], "--object-store-port"),
    project: args.project,
    expiry: args["expires-at"],
    dataVolumes: args["database-volume"] ? {database: args["database-volume"], files: args["files-volume"]} : {},
  });
  stdout(JSON.stringify(result));
  return 0;
}

await runCliIfMain(import.meta.url, main, {onError: (error) => { console.error(error?.stack ?? String(error)); return 1; }});
