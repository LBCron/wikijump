import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const BUILD_MANIFEST_VERIFIER = fileURLToPath(
  new URL("../scripts/candidate-artifact-manifest.py", import.meta.url),
);
const TRUSTED_TOOLS = Object.freeze({
  docker: "/usr/bin/docker",
  git: "/usr/bin/git",
  python: "/usr/bin/python3",
  ss: "/usr/bin/ss",
});
const REQUIRED_CONTAINERS = ["cache", "database", "files"];
const SERVICE_INTERNAL_PORT = Object.freeze({
  cache: "6379/tcp",
  database: "5432/tcp",
  files: "9000/tcp",
});
const REQUIRED_RUNTIME_ENVIRONMENT = [
  "DATABASE_URL",
  "REDIS_URL",
  "S3_ACCESS_KEY_ID",
  "S3_CUSTOM_ENDPOINT",
  "S3_FILES_BUCKET",
  "S3_PATH_STYLE",
  "S3_REGION_NAME",
  "S3_SECRET_ACCESS_KEY",
  "S3_TEXT_BLOCKS_BUCKET",
];
const FORBIDDEN_RUNTIME_ENVIRONMENT = new Set([
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_WORK_TREE",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "PYTHONHOME",
  "PYTHONPATH",
]);
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const FIXTURE_SNAPSHOT_SQL = `
WITH
  site_pages AS (
    SELECT page_id FROM page WHERE site_id = $SITE_ID
  ),
  relevant_users AS (
    SELECT user_id FROM page_revision WHERE site_id = $SITE_ID
    UNION SELECT user_id FROM page_vote WHERE page_id IN (SELECT page_id FROM site_pages)
    UNION SELECT user_id FROM file_revision WHERE site_id = $SITE_ID
    UNION SELECT user_id FROM forum_post WHERE site_id = $SITE_ID
  ),
  relevant_text_hashes AS (
    SELECT unnest(ARRAY[
      wikitext_hash,
      compiled_body_html_hash,
      compiled_top_bar_html_hash,
      compiled_side_bar_html_hash,
      compiled_body_styles_hash
    ]) AS hash
    FROM page_revision
    WHERE site_id = $SITE_ID
  ),
  relevant_import_runs AS (
    SELECT import_run_id
    FROM wikidot_corpus_import_run
    WHERE site_id = $SITE_ID
  ),
  snapshot AS (
    SELECT 'site:' || to_jsonb(value)::text AS record FROM site value WHERE site_id = $SITE_ID
    UNION ALL SELECT 'site_domain:' || to_jsonb(value)::text FROM site_domain value WHERE site_id = $SITE_ID
    UNION ALL SELECT 'page_category:' || to_jsonb(value)::text FROM page_category value WHERE site_id = $SITE_ID
    UNION ALL SELECT 'page:' || to_jsonb(value)::text FROM page value WHERE site_id = $SITE_ID
    UNION ALL SELECT 'page_revision:' || to_jsonb(value)::text FROM page_revision value WHERE site_id = $SITE_ID
    UNION ALL SELECT 'page_parent:' || to_jsonb(value)::text FROM page_parent value
      WHERE parent_page_id IN (SELECT page_id FROM site_pages)
         OR child_page_id IN (SELECT page_id FROM site_pages)
    UNION ALL SELECT 'page_connection:' || to_jsonb(value)::text FROM page_connection value
      WHERE from_page_id IN (SELECT page_id FROM site_pages)
         OR to_page_id IN (SELECT page_id FROM site_pages)
    UNION ALL SELECT 'page_connection_missing:' || to_jsonb(value)::text
      FROM page_connection_missing value
      WHERE from_page_id IN (SELECT page_id FROM site_pages)
         OR to_site_id = $SITE_ID
    UNION ALL SELECT 'page_link:' || to_jsonb(value)::text FROM page_link value
      WHERE page_id IN (SELECT page_id FROM site_pages)
    UNION ALL SELECT 'page_vote:' || to_jsonb(value)::text FROM page_vote value
      WHERE page_id IN (SELECT page_id FROM site_pages)
    UNION ALL SELECT 'file:' || to_jsonb(value)::text FROM file value WHERE site_id = $SITE_ID
    UNION ALL SELECT 'file_revision:' || to_jsonb(value)::text FROM file_revision value WHERE site_id = $SITE_ID
    UNION ALL SELECT 'forum_thread:' || to_jsonb(value)::text FROM forum_thread value WHERE site_id = $SITE_ID
    UNION ALL SELECT 'forum_post:' || to_jsonb(value)::text FROM forum_post value WHERE site_id = $SITE_ID
    UNION ALL SELECT 'text:' || to_jsonb(value)::text FROM text value
      WHERE hash IN (SELECT hash FROM relevant_text_hashes WHERE hash IS NOT NULL)
    UNION ALL SELECT 'text_block:' || to_jsonb(value)::text FROM text_block value
      WHERE page_id IN (SELECT page_id FROM site_pages)
    UNION ALL SELECT 'role:' || to_jsonb(value)::text FROM role value
      WHERE site_id = $SITE_ID
    UNION ALL SELECT 'role_permission:' || to_jsonb(value)::text FROM role_permission value
      WHERE site_id = $SITE_ID
    UNION ALL SELECT 'user_role:' || to_jsonb(value)::text FROM user_role value
      WHERE site_id = $SITE_ID
    UNION ALL SELECT 'wikidot_corpus_import_run:' || to_jsonb(value)::text
      FROM wikidot_corpus_import_run value WHERE site_id = $SITE_ID
    UNION ALL SELECT 'wikidot_corpus_import_item:' || to_jsonb(value)::text
      FROM wikidot_corpus_import_item value
      WHERE import_run_id IN (SELECT import_run_id FROM relevant_import_runs)
         OR page_id IN (SELECT page_id FROM site_pages)
    UNION ALL SELECT 'wikidot_page_snapshot:' || to_jsonb(value)::text
      FROM wikidot_page_snapshot value
      WHERE page_id IN (SELECT page_id FROM site_pages)
    UNION ALL SELECT 'wikidot_corpus_render_observation:' || to_jsonb(value)::text
      FROM wikidot_corpus_render_observation value
      WHERE import_run_id IN (SELECT import_run_id FROM relevant_import_runs)
         OR page_id IN (SELECT page_id FROM site_pages)
    UNION ALL SELECT 'known_user:' || to_jsonb(value)::text FROM known_user value
      WHERE user_id IN (SELECT user_id FROM relevant_users)
    UNION ALL SELECT 'user:' || to_jsonb(value)::text FROM "user" value
      WHERE user_id IN (SELECT user_id FROM relevant_users)
  )
SELECT record FROM snapshot ORDER BY record;
`;

export function assertListPagesCandidateLaunchEnvironment(environment = process.env) {
  for (const key of Object.keys(environment)) {
    if (FORBIDDEN_RUNTIME_ENVIRONMENT.has(key) || key.startsWith("GIT_")) {
      throw new Error(`candidate launch environment contains forbidden ${key}`);
    }
  }
  return environment;
}

export const LISTPAGES_RUNTIME_OBSERVATION_SCHEMA =
  "wikijump_listpages_compat.runtime_observation.v1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export async function sha256ListPagesFile(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function command(executable, args) {
  const { stdout } = await execFileAsync(executable, args, {
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout.trim();
}

export function exactListPagesFtmlSha(lockContents) {
  const section = lockContents.match(
    /\[\[package\]\]\nname = "ftml"\n[\s\S]*?(?=\n\[\[package\]\]|$)/u,
  )?.[0];
  const source = section?.match(/^source = "([^"]+)"$/mu)?.[1];
  const revision = source?.match(/#([0-9a-f]{40})$/u)?.[1];
  if (!revision) {
    throw new Error(
      "running candidate Cargo.lock has no exact Rokurolize/ftml revision",
    );
  }
  return revision;
}

export function listPagesProcessStartTicks(statText, pid) {
  const close = statText.lastIndexOf(")");
  const fields = close < 0
    ? []
    : statText.slice(close + 1).trim().split(/\s+/u);
  const observedPid = Number(statText.slice(0, statText.indexOf(" ")));
  const startTicks = fields[19];
  if (
    observedPid !== pid ||
    typeof startTicks !== "string" ||
    !/^[1-9][0-9]*$/u.test(startTicks)
  ) {
    throw new Error("running candidate process stat is invalid");
  }
  return startTicks;
}

export function listPagesRuntimeEnvironmentAuthority(environ) {
  const entries = Buffer.from(environ)
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  const values = new Map();
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator < 1) {
      throw new Error("running candidate environment is malformed");
    }
    const key = entry.slice(0, separator);
    if (values.has(key)) {
      throw new Error(`running candidate environment repeats ${key}`);
    }
    values.set(key, entry.slice(separator + 1));
  }
  assertListPagesCandidateLaunchEnvironment(Object.fromEntries(values));
  const authority = Object.fromEntries(
    REQUIRED_RUNTIME_ENVIRONMENT.map((key) => {
      const value = values.get(key);
      if (typeof value !== "string" || value === "") {
        throw new Error(`running candidate environment has no ${key}`);
      }
      return [key, value];
    }),
  );
  const endpoints = [
    ["database", "DATABASE_URL", new Set(["postgres:", "postgresql:"])],
    ["cache", "REDIS_URL", new Set(["redis:"])],
    ["files", "S3_CUSTOM_ENDPOINT", new Set(["http:"])],
  ];
  const serviceHostPort = Object.fromEntries(
    endpoints.map(([service, key, protocols]) => {
      let url;
      try {
        url = new URL(authority[key]);
      } catch {
        throw new Error(`running candidate ${key} is not a URL`);
      }
      if (
        !protocols.has(url.protocol) ||
        url.hostname !== "127.0.0.1" ||
        url.port === "" ||
        !/^[1-9][0-9]{0,4}$/u.test(url.port) ||
        Number(url.port) > 65535
      ) {
        throw new Error(
          `running candidate ${key} must use an explicit loopback service port`,
        );
      }
      return [service, Number(url.port)];
    }),
  );
  return {
    sha256: sha256(JSON.stringify(authority)),
    service_host_port: serviceHostPort,
  };
}

export function listPagesRuntimeEnvironmentSha256(environ) {
  return listPagesRuntimeEnvironmentAuthority(environ).sha256;
}

function requireExactProofLocators(proof) {
  const process = proof?.process;
  if (
    !Number.isSafeInteger(process?.pid) ||
    process.pid < 1 ||
    typeof process.start_ticks !== "string" ||
    !/^[1-9][0-9]*$/u.test(process.start_ticks) ||
    typeof process.config_path !== "string" ||
    !path.isAbsolute(process.config_path) ||
    typeof process.build_manifest_path !== "string" ||
    !path.isAbsolute(process.build_manifest_path)
  ) {
    throw new Error("runtime proof process locator is invalid");
  }
  const containers = proof.service_containers;
  if (
    containers === null ||
    typeof containers !== "object" ||
    Array.isArray(containers) ||
    JSON.stringify(Object.keys(containers).sort()) !==
      JSON.stringify(REQUIRED_CONTAINERS)
  ) {
    throw new Error(
      `runtime proof containers must be exactly ${REQUIRED_CONTAINERS.join(", ")}`,
    );
  }
  for (const service of REQUIRED_CONTAINERS) {
    if (!/^[0-9a-f]{64}$/u.test(containers[service] ?? "")) {
      throw new Error(`runtime proof ${service} container ID is invalid`);
    }
  }
  return { process, containers };
}

function requireBoundBuildManifest(
  manifest,
  identity,
  manifestSha256,
  verification,
) {
  if (
    manifestSha256 !== identity.build_manifest_sha256 ||
    manifest?.schema !== "roku.candidate_build_manifest.v1" ||
    manifest.source?.wikijump_sha !== identity.wikijump_sha ||
    manifest.source?.ftml_sha !== identity.ftml_sha ||
    manifest.build?.cargo_lock_sha256 !== identity.dependency_lock_sha256 ||
    manifest.build?.binary_sha256 !== identity.executable_sha256 ||
    manifest.build?.profile !== identity.profile ||
    manifest.artifact_key?.key !== identity.build_artifact_key ||
    manifest.build_attestation?.mode !== "wrapped_pre_post" ||
    verification?.status !== "bound" ||
    verification?.verified !== true ||
    verification?.manifest_sha256 !== manifestSha256
  ) {
    throw new Error(
      "running candidate build manifest does not bind the authoritative identity",
    );
  }
}

function requireListener(listenerText, rpcUrl, pid) {
  const url = new URL(rpcUrl);
  const port = url.port || "80";
  const expectedAddress = url.hostname === "[::1]"
    ? `[::1]:${port}`
    : `127.0.0.1:${port}`;
  const lines = listenerText.split(/\r?\n/u).filter(Boolean);
  const matches = lines.filter(
    (line) =>
      line.includes(expectedAddress) &&
      new RegExp(`pid=${pid}(?:,|\\))`, "u").test(line),
  );
  if (matches.length !== 1 || lines.length !== 1) {
    throw new Error("runtime proof PID does not exclusively own the RPC listener");
  }
}

function requireContainerInspection(
  inspectionText,
  service,
  containerId,
  expectedImage,
  expectedHostPort,
) {
  const parsed = JSON.parse(inspectionText);
  const inspection = Array.isArray(parsed) ? parsed[0] : parsed;
  const health = inspection?.State?.Health?.Status;
  const bindings = inspection?.NetworkSettings?.Ports?.[
    SERVICE_INTERNAL_PORT[service]
  ];
  const hasExpectedBinding =
    Array.isArray(bindings) &&
    bindings.some(
      (binding) =>
        binding?.HostIp === "127.0.0.1" &&
        Number(binding?.HostPort) === expectedHostPort,
    );
  if (
    inspection?.Id !== containerId ||
    inspection?.Image !== `sha256:${expectedImage}` ||
    inspection?.State?.Running !== true ||
    (health !== undefined && health !== "healthy") ||
    !hasExpectedBinding
  ) {
    throw new Error(
      `running ${service} container does not bind the authoritative identity`,
    );
  }
  return {
    container_id: containerId,
    image_sha256: expectedImage,
    started_at: inspection.State.StartedAt,
    health: health ?? null,
    host_port: expectedHostPort,
  };
}

function requireCommandLine(commandLine, process, rpcUrl) {
  const args = commandLine.toString("utf8").split("\0").filter(Boolean);
  const port = new URL(rpcUrl).port || "80";
  const portIndex = args.indexOf("--port");
  if (
    args.filter((value) => value === process.config_path).length !== 1 ||
    portIndex < 0 ||
    args[portIndex + 1] !== port
  ) {
    throw new Error(
      "running candidate command line does not bind the runtime config and RPC port",
    );
  }
  return sha256(commandLine);
}

export async function observeListPagesFixtureState({
  databaseContainerId,
  siteId,
  run = command,
}) {
  const sql = FIXTURE_SNAPSHOT_SQL.replaceAll("$SITE_ID", String(siteId));
  const script = [
    'exec env PGPASSWORD="$POSTGRES_PASSWORD"',
    "psql -h 127.0.0.1",
    '-U "${POSTGRES_USER:-wikijump}"',
    '-d "${POSTGRES_DB:-wikijump}"',
    "--no-align --tuples-only --set ON_ERROR_STOP=1",
    '--command "$1"',
  ].join(" ");
  const rows = await run(TRUSTED_TOOLS.docker, [
    "exec",
    databaseContainerId,
    "sh",
    "-ec",
    script,
    "listpages-fixture-snapshot",
    sql,
  ]);
  return sha256(rows);
}

export async function observeListPagesRandomCacheState({
  cacheContainerId,
  run = command,
}) {
  const script = [
    "local keys=redis.call('KEYS',ARGV[1])",
    "table.sort(keys)",
    "local rows={}",
    "for _,key in ipairs(keys) do",
    "table.insert(rows,key..'='..(redis.call('GET',key) or '<missing>'))",
    "end",
    "return rows",
  ].join(";");
  const rows = await run(TRUSTED_TOOLS.docker, [
    "exec",
    cacheContainerId,
    "redis-cli",
    "--raw",
    "EVAL",
    script,
    "0",
    "listpages:random-order:v1:*",
  ]);
  return sha256(rows);
}

export async function observeListPagesRuntimeAuthority({
  identity,
  proof,
  phase,
  system = {},
}) {
  const { process, containers } = requireExactProofLocators(proof);
  const readFile = system.readFile ?? fs.readFile;
  const readlink = system.readlink ?? fs.readlink;
  const hashFile = system.hashFile ?? sha256ListPagesFile;
  const run = system.command ?? command;
  const fixtureDigest = system.fixtureDigest ??
    (() => observeListPagesFixtureState({
      run,
      databaseContainerId: containers.database,
      siteId: identity.site_id,
    }));
  const randomCacheDigest = system.randomCacheDigest ??
    (() => observeListPagesRandomCacheState({
      run,
      cacheContainerId: containers.cache,
    }));
  const procRoot = `/proc/${process.pid}`;
  const [
    statText,
    commandLine,
    environment,
    executablePath,
    repository,
    executableSha256,
    configSha256,
    configContents,
    manifestContents,
  ] = await Promise.all([
    readFile(path.join(procRoot, "stat"), "utf8"),
    readFile(path.join(procRoot, "cmdline")),
    readFile(path.join(procRoot, "environ")),
    readlink(path.join(procRoot, "exe")),
    readlink(path.join(procRoot, "cwd")),
    hashFile(path.join(procRoot, "exe")),
    hashFile(process.config_path),
    readFile(process.config_path),
    readFile(process.build_manifest_path, "utf8"),
  ]);
  if (listPagesProcessStartTicks(statText, process.pid) !== process.start_ticks) {
    throw new Error("running candidate PID was reused or restarted");
  }
  if (
    executableSha256 !== identity.executable_sha256 ||
    configSha256 !== identity.runtime_config_sha256
  ) {
    throw new Error(
      "running candidate executable or configuration differs from authority",
    );
  }
  const commandLineSha256 = requireCommandLine(
    commandLine,
    process,
    identity.rpc_url,
  );
  const environmentAuthority =
    listPagesRuntimeEnvironmentAuthority(environment);
  const environmentSha256 = environmentAuthority.sha256;
  if (
    environmentSha256 !== identity.runtime_environment_sha256 ||
    REQUIRED_CONTAINERS.some(
      (service) =>
        environmentAuthority.service_host_port[service] !==
        identity.service_host_port[service],
    )
  ) {
    throw new Error(
      "running candidate environment differs from the authoritative identity",
    );
  }
  const lockPath = path.join(repository, "deepwell", "Cargo.lock");
  const [status, head, tree, lockContents, listenerText] = await Promise.all([
    run(TRUSTED_TOOLS.git, [
      "-C",
      repository,
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
    ]),
    run(TRUSTED_TOOLS.git, ["-C", repository, "rev-parse", "HEAD"]),
    run(TRUSTED_TOOLS.git, ["-C", repository, "rev-parse", "HEAD^{tree}"]),
    readFile(lockPath, "utf8"),
    run(TRUSTED_TOOLS.ss, [
      "-H",
      "-ltnp",
      "sport",
      "=",
      `:${new URL(identity.rpc_url).port || "80"}`,
    ]),
  ]);
  if (
    status !== "" ||
    head !== identity.wikijump_sha ||
    tree !== identity.wikijump_tree ||
    sha256(lockContents) !== identity.dependency_lock_sha256 ||
    exactListPagesFtmlSha(lockContents) !== identity.ftml_sha
  ) {
    throw new Error(
      "running candidate checkout differs from the authoritative source",
    );
  }
  requireListener(listenerText, identity.rpc_url, process.pid);

  const manifestSha256 = sha256(manifestContents);
  const verificationText = await run(TRUSTED_TOOLS.python, [
    BUILD_MANIFEST_VERIFIER,
    "verify",
    "--manifest",
    process.build_manifest_path,
    "--gate-mode",
    "acceptance",
    "--wikijump-sha",
    identity.wikijump_sha,
    "--ftml-sha",
    identity.ftml_sha,
    "--profile",
    identity.profile,
    "--cargo-lock-sha256",
    identity.dependency_lock_sha256,
    "--binary-sha256",
    identity.executable_sha256,
  ]);
  requireBoundBuildManifest(
    JSON.parse(manifestContents),
    identity,
    manifestSha256,
    JSON.parse(verificationText),
  );

  const serviceEntries = await Promise.all(
    REQUIRED_CONTAINERS.map(async (service) => [
      service,
      requireContainerInspection(
        await run(TRUSTED_TOOLS.docker, ["inspect", containers[service]]),
        service,
        containers[service],
        identity.service_image_sha256[service],
        identity.service_host_port[service],
      ),
    ]),
  );
  const [fixtureStateSha256, randomCacheStateSha256] = await Promise.all([
    fixtureDigest(),
    randomCacheDigest(),
  ]);
  if (
    !SHA256_PATTERN.test(fixtureStateSha256 ?? "") ||
    !SHA256_PATTERN.test(randomCacheStateSha256 ?? "")
  ) {
    throw new Error("running ListPages fixture or random-cache digest is invalid");
  }
  const stable = {
    run_nonce: proof.run_nonce,
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
    process: {
      pid: process.pid,
      start_ticks: process.start_ticks,
      executable_path: executablePath,
      executable_sha256: executableSha256,
      repository,
      command_line_sha256: commandLineSha256,
      environment_sha256: environmentSha256,
      config_path: process.config_path,
      config_sha256: configSha256,
      config_contents_sha256: sha256(configContents),
      build_manifest_path: process.build_manifest_path,
      build_manifest_sha256: manifestSha256,
    },
    rpc_url: identity.rpc_url,
    fixture_state_sha256: fixtureStateSha256,
    random_cache_state_sha256: randomCacheStateSha256,
    services: Object.fromEntries(serviceEntries),
  };
  return {
    schema: LISTPAGES_RUNTIME_OBSERVATION_SCHEMA,
    status: "bound",
    phase,
    observed_at: new Date().toISOString(),
    stable_sha256: sha256(JSON.stringify(stable)),
    stable,
  };
}

export function validateListPagesRuntimeObservation(
  observation,
  phase,
  identity = null,
  proof = null,
) {
  const stable = observation?.stable;
  if (
    observation?.schema !== LISTPAGES_RUNTIME_OBSERVATION_SCHEMA ||
    observation.status !== "bound" ||
    observation.phase !== phase ||
    typeof observation.observed_at !== "string" ||
    Number.isNaN(Date.parse(observation.observed_at)) ||
    !SHA256_PATTERN.test(observation.stable_sha256 ?? "") ||
    stable === null ||
    typeof stable !== "object" ||
    Array.isArray(stable) ||
    !SHA256_PATTERN.test(stable.run_nonce ?? "") ||
    !SHA256_PATTERN.test(stable.fixture_state_sha256 ?? "") ||
    !SHA256_PATTERN.test(stable.random_cache_state_sha256 ?? "") ||
    stable.candidate === null ||
    typeof stable.candidate !== "object" ||
    stable.process === null ||
    typeof stable.process !== "object" ||
    stable.services === null ||
    typeof stable.services !== "object" ||
    sha256(JSON.stringify(stable)) !== observation.stable_sha256
  ) {
    throw new Error(`authoritative runtime ${phase} observation is invalid`);
  }
  if (identity !== null || proof !== null) {
    const { process, containers } = requireExactProofLocators(proof);
    const expectedCandidate = {
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
    };
    if (
      stable.run_nonce !== proof.run_nonce ||
      JSON.stringify(stable.candidate) !== JSON.stringify(expectedCandidate) ||
      stable.rpc_url !== identity.rpc_url ||
      stable.process.pid !== process.pid ||
      stable.process.start_ticks !== process.start_ticks ||
      stable.process.executable_sha256 !== identity.executable_sha256 ||
      stable.process.config_path !== process.config_path ||
      stable.process.config_sha256 !== identity.runtime_config_sha256 ||
      stable.process.config_contents_sha256 !==
        identity.runtime_config_sha256 ||
      stable.process.environment_sha256 !==
        identity.runtime_environment_sha256 ||
      stable.process.build_manifest_path !== process.build_manifest_path ||
      stable.process.build_manifest_sha256 !==
        identity.build_manifest_sha256 ||
      JSON.stringify(Object.keys(stable.services).sort()) !==
      JSON.stringify(REQUIRED_CONTAINERS)
    ) {
      throw new Error(
        `authoritative runtime ${phase} observation differs from its identity or proof`,
      );
    }
    for (const service of REQUIRED_CONTAINERS) {
      if (
        stable.services[service]?.container_id !== containers[service] ||
        stable.services[service]?.image_sha256 !==
          identity.service_image_sha256[service] ||
        stable.services[service]?.host_port !==
          identity.service_host_port[service]
      ) {
        throw new Error(
          `authoritative runtime ${phase} ${service} observation differs from its identity or proof`,
        );
      }
    }
  }
  return observation;
}
