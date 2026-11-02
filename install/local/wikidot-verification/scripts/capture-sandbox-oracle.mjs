#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {
  DeepwellThemePageAdapter,
} from "../src/theme-localization-deepwell-adapter.mjs";
import {
  WikidotThemePageAdapter,
} from "../src/theme-localization-wikidot-adapter.mjs";
import {
  oracleRunOwnedSlug,
  validateRunId,
} from "../src/theme-localization-e2e.mjs";
import {
  aggregateSandboxOracleVerdict,
  classifyBlockedResourceHosts,
  compareSandboxOracleFixture,
  validateSandboxOracleRegistry,
  validateSandboxOracleCapture,
  validateSandboxOracleSourceProvenance,
} from "../src/sandbox-oracle.mjs";
import {domSignature} from "../src/oracle-fixtures.mjs";
import {
  DEFAULT_THRESHOLDS,
  validateLiveCompletionPolicy,
} from "../src/standing-browser-parity-contract.mjs";
import {
  DEFAULT_PARITY_BROWSER_ROOT,
  createParityBrowserControls,
  launchParityBrowser,
} from "../src/standing-browser-parity-browser-session.mjs";
import { captureBrowserParityObservation } from "../src/standing-browser-parity-observation.mjs";
import { PAGE_CHROME_SKELETON } from "../src/standing-browser-canaries.mjs";
import {SANDBOX_ORACLE_LOCAL_ORIGINS} from "../src/sandbox-oracle-browser-policy.mjs";
import {readStableRegularFile} from "../src/standing-browser-parity-util.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const REGISTRY_PATH = path.join(REPO_ROOT, "install/local/wikidot-verification/fixtures/sandbox-oracle-fixture-registry.json");
const SOURCES_PATH = path.join(REPO_ROOT, "install/local/wikidot-verification/fixtures/sandbox-oracle/fixture-sources.json");
const LOCAL_ORIGIN = SANDBOX_ORACLE_LOCAL_ORIGINS[0];
const LIVE_ORIGIN = "https://sandbox-for-codex.wikidot.com";
const DEFAULT_RPC_URL = "http://127.0.0.1:12747/jsonrpc";

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function sha256File(filePath) {
  return sha256(await fs.readFile(filePath));
}

function valueAfter(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  const args = {
    registry: REGISTRY_PATH,
    sources: SOURCES_PATH,
    outputDir: null,
    runId: null,
    rpcUrl: DEFAULT_RPC_URL,
    liveCompletionPolicy: null,
    browserRoot: DEFAULT_PARITY_BROWSER_ROOT,
    browserExecutable: null,
    timeoutMs: 120_000,
    settleMs: 1_000,
    viewport: {width: 1366, height: 900},
    runtimeIdentity: null,
    resume: false,
    forceFixtures: [],
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--registry") args.registry = path.resolve(valueAfter(argv, index++, flag));
    else if (flag === "--sources") args.sources = path.resolve(valueAfter(argv, index++, flag));
    else if (flag === "--output-dir") args.outputDir = path.resolve(valueAfter(argv, index++, flag));
    else if (flag === "--run-id") args.runId = valueAfter(argv, index++, flag);
    else if (flag === "--rpc-url") args.rpcUrl = valueAfter(argv, index++, flag);
    else if (flag === "--live-completion-policy") args.liveCompletionPolicy = path.resolve(valueAfter(argv, index++, flag));
    else if (flag === "--browser-root") args.browserRoot = path.resolve(valueAfter(argv, index++, flag));
    else if (flag === "--browser-executable") args.browserExecutable = path.resolve(valueAfter(argv, index++, flag));
    else if (flag === "--timeout-ms") args.timeoutMs = Number(valueAfter(argv, index++, flag));
    else if (flag === "--settle-ms") args.settleMs = Number(valueAfter(argv, index++, flag));
    else if (flag === "--runtime-identity") args.runtimeIdentity = path.resolve(valueAfter(argv, index++, flag));
    else if (flag === "--resume") args.resume = true;
    else if (flag === "--force-fixture") args.forceFixtures.push(valueAfter(argv, index++, flag));
    else if (flag === "--help") {
      console.log("Usage: capture-sandbox-oracle.mjs --output-dir DIR --live-completion-policy FILE [--run-id ID] [--registry FILE] [--sources FILE] [--runtime-identity FILE] [--resume] [--force-fixture FIXTURE_ID]");
      process.exit(0);
    } else throw new Error(`unknown option: ${flag}`);
  }
  if (!args.outputDir) throw new Error("--output-dir is required");
  if (!args.liveCompletionPolicy) throw new Error("--live-completion-policy is required");
  args.runId = validateRunId(args.runId ?? "20260805-c1");
  if (!Number.isSafeInteger(args.timeoutMs) || args.timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
  if (!Number.isSafeInteger(args.settleMs) || args.settleMs < 0) throw new Error("--settle-ms must be non-negative");
  if (args.forceFixtures.length > 0 && !args.resume) throw new Error("--force-fixture requires --resume");
  if (new Set(args.forceFixtures).size !== args.forceFixtures.length) throw new Error("--force-fixture values must be unique");
  return args;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read ${label}: ${error.message}`);
  }
}

async function prepareInputs(args) {
  const registry = validateSandboxOracleRegistry(await readJson(args.registry, "registry"));
  const sourceBundle = await readJson(args.sources, "fixture sources");
  if (sourceBundle.schema !== "wikijump_local_lab.sandbox_oracle_fixture_sources.v1") throw new Error("fixture source schema is unsupported");
  if (sourceBundle.site_slug !== "sandbox-for-codex" || sourceBundle.run_id !== args.runId) throw new Error("fixture source site or run identity does not match the capture");
  if (!Array.isArray(sourceBundle.fixtures) || sourceBundle.fixtures.length !== registry.fixtures.length) throw new Error("fixture sources do not cover the registry");
  const registryMap = new Map(registry.fixtures.map((fixture) => [fixture.fixture_id, fixture]));
  const sourceMap = new Map();
  const dependencies = [];
  for (const source of sourceBundle.fixtures) {
    if (sourceMap.has(source.fixture_id) || !registryMap.has(source.fixture_id)) throw new Error(`fixture source is not uniquely registered: ${source.fixture_id}`);
    if (typeof source.source !== "string" || !source.source) throw new Error(`fixture source is empty: ${source.fixture_id}`);
    if (sha256(source.source) !== registryMap.get(source.fixture_id).provenance.content_sha256) throw new Error(`fixture source hash does not match registry: ${source.fixture_id}`);
    const provenance = validateSandboxOracleSourceProvenance(source, `fixture source ${source.fixture_id}`);
    const verified = {
      includes: [],
      assets: [],
    };
    for (const include of provenance.includes) {
      const evidencePath = path.isAbsolute(include.evidence_path) ? include.evidence_path : path.resolve(REPO_ROOT, include.evidence_path);
      const evidence = await readStableRegularFile(evidencePath, `fixture include provenance ${source.fixture_id}:${include.page}`).catch(() => null);
      if (evidence?.sha256 !== include.source_sha256) throw new Error(`fixture include provenance does not match evidence: ${source.fixture_id}:${include.page}`);
      verified.includes.push({...include, evidence_path: evidencePath});
    }
    for (const asset of provenance.assets) {
      const evidencePath = path.isAbsolute(asset.evidence_path) ? asset.evidence_path : path.resolve(REPO_ROOT, asset.evidence_path);
      const evidence = await readStableRegularFile(evidencePath, `fixture asset provenance ${source.fixture_id}:${asset.wikidot_path}`).catch(() => null);
      if (evidence?.sha256 !== asset.sha256) throw new Error(`fixture asset provenance does not match evidence: ${source.fixture_id}:${asset.wikidot_path}`);
      verified.assets.push({...asset, evidence_path: evidencePath});
    }
    sourceMap.set(source.fixture_id, source);
    dependencies.push({fixture_id: source.fixture_id, ...verified});
  }
  for (const fixture of registry.fixtures) if (!sourceMap.has(fixture.fixture_id)) throw new Error(`registry fixture has no source: ${fixture.fixture_id}`);
  return {registry, sourceMap, dependencies};
}

function resourceFor(fixture, source, registry, runId, target) {
  const slug = oracleRunOwnedSlug(runId, fixture.fixture_id, registry);
  const origin = target === "wikidot" ? LIVE_ORIGIN : LOCAL_ORIGIN;
  return {
    resource_id: `${fixture.fixture_id}:${target}`,
    target,
    site_slug: "sandbox-for-codex",
    slug,
    url: `${origin}/${slug}`,
    source_sha256: sha256(source.source),
    title: source.title,
    tags: ["codex-oracle"],
  };
}

function browserContract(fixture) {
  const comparisonScope = fixture.comparison_scope;
  const pageChrome = comparisonScope === "page-chrome";
  return {
    comparison_scope: comparisonScope,
    geometry_selectors: pageChrome
      ? ["#main-content", "#page-content", "#header", "#side-bar", "#header h1 a"]
      : ["#page-content"],
    first_paint_geometry_selectors: pageChrome ? ["#header"] : [],
    presence_probes: [
      {id: "oracle_page_content", selector: "#page-content", minimum_count: 1, require_rendered: false},
      ...(pageChrome
        ? [{id: "oracle_header", selector: "#header", minimum_count: 1, require_rendered: false}]
        : []),
    ],
    first_paint_custom_properties: {},
    capture_page_chrome_skeleton: PAGE_CHROME_SKELETON,
    page_chrome_skeleton: pageChrome ? PAGE_CHROME_SKELETON : null,
  };
}

function validateProgressRow(row, registryIds, label) {
  if (!row || typeof row !== "object" || typeof row.fixture_id !== "string" || !registryIds.has(row.fixture_id)) throw new Error(`${label} has an unknown fixture id`);
  if (!row.live || !row.local || !row.resources?.live || !row.resources?.local) throw new Error(`${label} is missing both capture sides and resources`);
}

async function prepareCaptureState(args, registry) {
  await fs.mkdir(args.outputDir, {recursive: true});
  const entries = await fs.readdir(args.outputDir);
  const registryIds = new Set(registry.fixtures.map(({fixture_id}) => fixture_id));
  if (!args.resume) {
    if (entries.length > 0) throw new Error(`oracle output directory must be empty: ${args.outputDir}`);
    return {captures: [], contracts: [], captureIndexOffset: 0, resumeGeneration: 0};
  }
  const progress = await readJson(path.join(args.outputDir, "capture-progress.json"), "capture progress");
  if (progress.schema !== "wikijump_local_lab.sandbox_oracle_capture_progress.v1" || !Array.isArray(progress.captures) || !Array.isArray(progress.contracts)) throw new Error("capture progress has an unsupported schema");
  const captureIds = new Set();
  for (const [index, row] of progress.captures.entries()) {
    validateProgressRow(row, registryIds, `capture progress captures[${index}]`);
    if (captureIds.has(row.fixture_id)) throw new Error(`capture progress contains duplicate fixture: ${row.fixture_id}`);
    captureIds.add(row.fixture_id);
  }
  const contractIds = new Set();
  for (const [index, row] of progress.contracts.entries()) {
    if (!row || typeof row !== "object" || typeof row.fixture_id !== "string" || !registryIds.has(row.fixture_id) || !row.contract || typeof row.contract !== "object") throw new Error(`capture progress contracts[${index}] is malformed`);
    if (contractIds.has(row.fixture_id)) throw new Error(`capture progress contains duplicate contract: ${row.fixture_id}`);
    contractIds.add(row.fixture_id);
  }
  if (captureIds.size !== contractIds.size || [...captureIds].some((fixtureId) => !contractIds.has(fixtureId))) throw new Error("capture progress captures and contracts do not cover the same fixtures");
  for (const fixtureId of args.forceFixtures) if (!registryIds.has(fixtureId)) throw new Error(`--force-fixture is not registered: ${fixtureId}`);
  const resumeGeneration = Number.isSafeInteger(progress.resume_generation) && progress.resume_generation >= 0 ? progress.resume_generation + 1 : 1;
  return {
    captures: progress.captures.filter(({fixture_id}) => !args.forceFixtures.includes(fixture_id)),
    contracts: progress.contracts.filter(({fixture_id}) => !args.forceFixtures.includes(fixture_id)),
    captureIndexOffset: resumeGeneration * registry.fixtures.length,
    resumeGeneration,
  };
}

function upsertProgressRow(rows, row) {
  const index = rows.findIndex(({fixture_id}) => fixture_id === row.fixture_id);
  if (index < 0) rows.push(row);
  else rows[index] = row;
}

async function writeCaptureProgress(outputDir, captures, contracts, resumeGeneration) {
  await fs.writeFile(
    path.join(outputDir, "capture-progress.json"),
    `${JSON.stringify({
      schema: "wikijump_local_lab.sandbox_oracle_capture_progress.v1",
      resume_generation: resumeGeneration,
      captured_fixture_ids: captures.map(({fixture_id}) => fixture_id),
      captures,
      contracts,
    }, null, 2)}\n`,
    {flag: "w", mode: 0o600},
  );
}

function mergeRequestGateSnapshots(previous, current, replaceFixtures = []) {
  if (!previous) return current;
  if (!current) return previous;
  const replaced = new Set(replaceFixtures);
  const byFixture = new Map();
  for (const [fixtureId, hosts] of Object.entries(previous.blocked_hosts_by_fixture ?? {})) {
    if (!replaced.has(fixtureId)) {
      const target = byFixture.get(fixtureId) ?? new Map();
      for (const [hostname, count] of Object.entries(hosts)) {
        target.set(hostname, (target.get(hostname) ?? 0) + count);
      }
      byFixture.set(fixtureId, target);
    }
  }
  for (const [fixtureId, hosts] of Object.entries(current.blocked_hosts_by_fixture ?? {})) {
    const target = byFixture.get(fixtureId) ?? new Map();
    for (const [hostname, count] of Object.entries(hosts)) {
      target.set(hostname, (target.get(hostname) ?? 0) + count);
    }
    byFixture.set(fixtureId, target);
  }
  const blockedHosts = new Map();
  for (const hosts of byFixture.values()) {
    for (const [hostname, count] of hosts) {
      blockedHosts.set(hostname, (blockedHosts.get(hostname) ?? 0) + count);
    }
  }
  const sum = (field) => (previous[field] ?? 0) + (current[field] ?? 0);
  return {
    ...current,
    blocked_hosts: Object.fromEntries([...blockedHosts].sort(([left], [right]) => left.localeCompare(right))),
    blocked_hosts_by_fixture: Object.fromEntries(
      [...byFixture]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([fixtureId, hosts]) => [
          fixtureId,
          Object.fromEntries([...hosts].sort(([left], [right]) => left.localeCompare(right))),
        ]),
    ),
    public_requests: sum("public_requests"),
    local_exempt_requests: sum("local_exempt_requests"),
    unsupported_requests_blocked: sum("unsupported_requests_blocked"),
    websocket_connections_blocked: sum("websocket_connections_blocked"),
    retry_after_honored: sum("retry_after_honored"),
    retry_after_invalid: sum("retry_after_invalid"),
    grants: [...(previous.grants ?? []), ...(current.grants ?? [])],
  };
}

async function loadPolicy(filePath) {
  const value = validateLiveCompletionPolicy(await readJson(filePath, "live completion policy"));
  return {value, sha256: await sha256File(filePath), filePath};
}

async function cleanupPage(adapter, resource, expected, identity) {
  if (identity === null) return null;
  await adapter.remove(resource, {expected, identity});
  return {status: "removed", identity};
}

async function cleanupCreatedPage(adapter, resource, identity) {
  const actual = await adapter.inspect(resource);
  if (actual === null) return {status: "already-absent", identity};
  return await cleanupPage(adapter, resource, {
    title: actual.title,
    source_sha256: actual.source_sha256,
    tags: actual.tags,
  }, actual.identity);
}

function isDeepwellAuthenticationFailure(error) {
  return /permission|authentication|unauthori[sz]ed|session/iu.test(
    error?.message ?? String(error),
  );
}

async function withTimeout(operation, label, timeoutMs = 90_000) {
  let timer = null;
  try {
    return await Promise.race([
      Promise.resolve(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function captureFailure({url, error}) {
  return {
    input_url: url,
    final_url: null,
    navigation_status: 0,
    failures: [],
    capture_error: {
      name: error?.name ?? "Error",
      message: error?.message ?? String(error),
    },
    first_paint: null,
    document: {
      geometry: {},
      presence_probes: [],
      custom_properties: {},
      resource_completion: {status: "capture_error"},
    },
    geometry: {},
    page_chrome_skeleton: {schema: PAGE_CHROME_SKELETON.schema, links: []},
    dom_signature: null,
    dom_signatures: [],
    attribute_signatures: [],
    rendered_images: 0,
    broken_images: [],
  };
}

async function captureFixtureObservation({
  context,
  page,
  url,
  label,
  index,
  outputDir,
  contract,
  viewport,
  timeoutMs,
  settleMs,
  fixtureId,
}) {
  let raw;
  try {
    raw = await withTimeout(
      captureBrowserParityObservation({
        context,
        page,
        url,
        label,
        index,
        outputDir,
        contract,
        viewport,
        timeoutMs,
        settleMs,
      }),
      `${label} capture ${fixtureId}`,
      120_000,
    );
  } catch (error) {
    return {
      capture: captureFailure({url, error}),
      validation_error: {name: error?.name ?? "Error", message: error?.message ?? String(error)},
    };
  }
  try {
    return {
      capture: validateSandboxOracleCapture(raw, `${label} capture ${fixtureId}`),
      validation_error: null,
    };
  } catch (error) {
    return {
      capture: {
        ...raw,
        capture_validation_error: {
          name: error?.name ?? "Error",
          message: error?.message ?? String(error),
        },
      },
      validation_error: {name: error?.name ?? "Error", message: error?.message ?? String(error)},
    };
  }
}

function captureSyntaxObservation({url, source, body}) {
  return validateSandboxOracleCapture({
    capture_mode: "syntax-only",
    input_url: url,
    final_url: null,
    navigation_status: 200,
    failures: [],
    source_sha256: sha256(source),
    raw_html: body,
    html_sha256: sha256(body),
    document: {
      geometry: {},
      presence_probes: [],
      custom_properties: {},
      resource_completion: {status: "syntax_only"},
    },
    geometry: {},
    page_chrome_skeleton: {schema: PAGE_CHROME_SKELETON.schema, links: []},
    dom_signature: domSignature(body),
    dom_signatures: [],
    attribute_signatures: [],
    rendered_images: 0,
    broken_images: [],
  }, `syntax capture ${url}`);
}

async function main(argv) {
  const args = parseArgs(argv);
  const {registry, sourceMap, dependencies} = await prepareInputs(args);
  const captureState = await prepareCaptureState(args, registry);
  const policy = await loadPolicy(args.liveCompletionPolicy);
  const runtimeIdentity = args.runtimeIdentity ? await readJson(args.runtimeIdentity, "runtime identity") : null;
  if (!process.env.WIKIDOT_USERNAME || !process.env.WIKIDOT_PASSWORD) throw new Error("WIKIDOT_USERNAME and WIKIDOT_PASSWORD are required through the environment");
  if (!process.env.DEEPWELL_RPC_TOKEN) throw new Error("DEEPWELL_RPC_TOKEN is required through the environment");

  const wikidot = new WikidotThemePageAdapter({helperOptions: {env: process.env}, siteSlug: "sandbox-for-codex"});
  const deepwellOptions = {rpcUrl: args.rpcUrl, rpcToken: process.env.DEEPWELL_RPC_TOKEN, adminEmail: process.env.WIKIDOT_VERIFY_ADMIN_EMAIL ?? "admin@wikijump", adminPassword: process.env.WIKIDOT_VERIFY_ADMIN_PASS ?? "wikijumpadmin1", siteSlug: "sandbox-for-codex"};
  let wikijump = new DeepwellThemePageAdapter(deepwellOptions);
  await wikidot.connect();
  await wikijump.connect();
  const captures = captureState.captures;
  const contracts = captureState.contracts;
  const previousRequestGateSnapshot = args.resume
    ? (await readJson(path.join(args.outputDir, "capture-receipt.json"), "previous capture receipt")).request_gate ?? null
    : null;
  const cleanup = [];
  let controls = null;
  let browser = null;
  let liveBrowserPage = null;
  let localBrowserPage = null;
  const cleanupFailures = [];
  let cleanupSuccesses = 0;
  let requestGateSnapshot = null;
  let requestGateError = null;
  const cleanupLocalPage = async (resource, identity, fixtureId) => {
    try {
      const result = await withTimeout(cleanupCreatedPage(wikijump, resource, identity), `local cleanup ${fixtureId}`);
      cleanupSuccesses += 1;
      return result;
    } catch (error) {
      if (!isDeepwellAuthenticationFailure(error)) throw error;
      await Promise.resolve(wikijump.close()).catch(() => undefined);
      wikijump = new DeepwellThemePageAdapter(deepwellOptions);
      await wikijump.connect();
      const result = await withTimeout(cleanupCreatedPage(wikijump, resource, identity), `local cleanup ${fixtureId} after reconnect`);
      cleanupSuccesses += 1;
      return result;
    }
  };
  try {
    controls = await createParityBrowserControls({
      args: {mode: "candidate", outputDir: args.outputDir, viewport: args.viewport, timeoutMs: args.timeoutMs, settleMs: args.settleMs},
      outputDir: args.outputDir,
      policy,
      candidate: {candidate: {endpoint: {allowed_origin_set: SANDBOX_ORACLE_LOCAL_ORIGINS, local_connect_address: "127.0.0.1"}}},
      resume: args.resume,
    });
    browser = await launchParityBrowser({browserRoot: args.browserRoot, browserExecutable: args.browserExecutable, controls, local: true, viewport: args.viewport});
    liveBrowserPage = await browser.context.newPage();
    localBrowserPage = await browser.context.newPage();
    for (const [index, fixture] of registry.fixtures.entries()) {
      if (captures.some(({fixture_id}) => fixture_id === fixture.fixture_id)) {
        console.log(JSON.stringify({fixture_id: fixture.fixture_id, phase: "resume-skip"}));
        continue;
      }
      controls.setActiveFixture(fixture.fixture_id);
      const captureIndex = index + captureState.captureIndexOffset;
      const source = sourceMap.get(fixture.fixture_id);
      const liveResource = resourceFor(fixture, source, registry, args.runId, "wikidot");
      const localResource = resourceFor(fixture, source, registry, args.runId, "wikijump");
      const syntaxOnly = fixture.assertion_class === "match-frozen-preserved";
      let livePage = null;
      let localPage = null;
      let liveAttempted = false;
      let localAttempted = false;
      let liveCapture = null;
      let localCapture = null;
      let contract = null;
      let fixtureError = null;
      try {
        console.log(JSON.stringify({fixture_id: fixture.fixture_id, phase: "inspect"}));
        if (await withTimeout(wikidot.inspect(liveResource), `live inspect ${fixture.fixture_id}`) !== null) throw new Error(`live oracle page already exists: ${liveResource.slug}`);
        if (!syntaxOnly && await withTimeout(wikijump.inspect(localResource), `local inspect ${fixture.fixture_id}`) !== null) throw new Error(`local oracle page already exists: ${localResource.slug}`);
        liveAttempted = true;
        console.log(JSON.stringify({fixture_id: fixture.fixture_id, phase: "create-live"}));
        livePage = await withTimeout(wikidot.create(liveResource, {source: source.source}), `live create ${fixture.fixture_id}`);
        if (!syntaxOnly) {
          localAttempted = true;
          console.log(JSON.stringify({fixture_id: fixture.fixture_id, phase: "create-local"}));
          localPage = await withTimeout(
            wikijump.create(localResource, {source: source.source}),
            `local create ${fixture.fixture_id}`,
          );
        }
        contract = browserContract(fixture);
        console.log(JSON.stringify({fixture_id: fixture.fixture_id, phase: "capture-live"}));
        const liveResult = await captureFixtureObservation({context: browser.context, page: liveBrowserPage, url: liveResource.url, label: "live", index: captureIndex, outputDir: args.outputDir, contract, viewport: args.viewport, timeoutMs: args.timeoutMs, settleMs: args.settleMs, fixtureId: fixture.fixture_id});
        liveCapture = liveResult.capture;
        if (
          fixture.comparison_scope === "page-chrome" &&
          liveCapture.page_chrome_skeleton?.schema &&
          Array.isArray(liveCapture.page_chrome_skeleton.links)
        ) {
          contract = {
            ...contract,
            page_chrome_skeleton: {
              schema: liveCapture.page_chrome_skeleton.schema,
              links: liveCapture.page_chrome_skeleton.links.map(
                ({parent, child}) => ({parent, child}),
              ),
            },
          };
        }
        let localResult;
        if (syntaxOnly) {
          console.log(JSON.stringify({fixture_id: fixture.fixture_id, phase: "capture-local-syntax"}));
          const syntax = await withTimeout(wikijump.syntaxPreview(localResource, source.source), `local syntax preview ${fixture.fixture_id}`);
          localCapture = captureSyntaxObservation({url: localResource.url, source: source.source, body: syntax.body});
          localResult = {validation_error: null};
        } else {
          console.log(JSON.stringify({fixture_id: fixture.fixture_id, phase: "capture-local"}));
          localResult = await captureFixtureObservation({context: browser.context, page: localBrowserPage, url: localResource.url, label: "local", index: captureIndex, outputDir: args.outputDir, contract, viewport: args.viewport, timeoutMs: args.timeoutMs, settleMs: args.settleMs, fixtureId: fixture.fixture_id});
          localCapture = localResult.capture;
        }
        if (liveResult.validation_error || localResult.validation_error) console.log(JSON.stringify({fixture_id: fixture.fixture_id, phase: "capture-validation-failed", live: liveResult.validation_error, local: localResult.validation_error}));
        upsertProgressRow(captures, {fixture_id: fixture.fixture_id, live: liveCapture, local: localCapture, resources: {live: liveResource, local: localResource}});
        upsertProgressRow(contracts, {fixture_id: fixture.fixture_id, contract});
        cleanup.push({fixture_id: fixture.fixture_id, live: {resource: liveResource, expected: {title: source.title, source_sha256: liveResource.source_sha256, tags: liveResource.tags}, identity: livePage}, local: {resource: localResource, expected: {title: source.title, source_sha256: localResource.source_sha256, tags: localResource.tags}, identity: localPage}});
        console.log(JSON.stringify({fixture_id: fixture.fixture_id, index: index + 1, total: registry.fixtures.length}));
      } catch (error) {
        fixtureError = {name: error?.name ?? "Error", message: error?.message ?? String(error)};
        console.log(JSON.stringify({fixture_id: fixture.fixture_id, phase: "fixture-failed", error: fixtureError}));
      } finally {
        if (localPage !== null || localAttempted) {
          try {
            await cleanupLocalPage(localResource, localPage, fixture.fixture_id);
          } catch (error) {
            const failure = {fixture_id: fixture.fixture_id, target: "wikijump", resource: localResource, error: {name: error?.name ?? "Error", message: error?.message ?? String(error)}};
            cleanupFailures.push(failure);
            fixtureError ??= failure.error;
            console.log(JSON.stringify({fixture_id: fixture.fixture_id, phase: "cleanup-failed", target: "wikijump", error: failure.error}));
          }
          localPage = null;
        }
        if (livePage !== null || liveAttempted) {
          try {
            await withTimeout(cleanupCreatedPage(wikidot, liveResource, livePage), `live cleanup ${fixture.fixture_id}`);
            cleanupSuccesses += 1;
          } catch (error) {
            const failure = {fixture_id: fixture.fixture_id, target: "wikidot", resource: liveResource, error: {name: error?.name ?? "Error", message: error?.message ?? String(error)}};
            cleanupFailures.push(failure);
            fixtureError ??= failure.error;
            console.log(JSON.stringify({fixture_id: fixture.fixture_id, phase: "cleanup-failed", target: "wikidot", error: failure.error}));
          }
          livePage = null;
        }
      }
      if (liveCapture === null || localCapture === null) {
        const error = fixtureError === null ? new Error("fixture capture did not produce both observations") : new Error(fixtureError.message);
        liveCapture ??= captureFailure({url: liveResource.url, error});
        localCapture ??= captureFailure({url: localResource.url, error});
        contract ??= browserContract(fixture);
        upsertProgressRow(captures, {fixture_id: fixture.fixture_id, live: liveCapture, local: localCapture, resources: {live: liveResource, local: localResource}});
        upsertProgressRow(contracts, {fixture_id: fixture.fixture_id, contract});
        console.log(JSON.stringify({fixture_id: fixture.fixture_id, phase: "capture-recorded-failure"}));
      }
      await writeCaptureProgress(args.outputDir, captures, contracts, captureState.resumeGeneration);
    }
  } finally {
    await Promise.resolve(browser?.close?.()).catch(() => undefined);
    const currentRequestGateSnapshot = await Promise.resolve(controls?.close?.()).catch((error) => {
      requestGateError = {name: error?.name ?? "Error", message: error?.message ?? String(error)};
      return null;
    });
    requestGateSnapshot = requestGateError === null
      ? mergeRequestGateSnapshots(previousRequestGateSnapshot, currentRequestGateSnapshot, args.forceFixtures)
      : null;
    await Promise.resolve(wikijump.close()).catch(() => undefined);
    await Promise.resolve(wikidot.close()).catch(() => undefined);
  }

  const localRows = captures.map(({fixture_id, local}) => ({fixture_id, capture: local}));
  const frozenRows = captures.map(({fixture_id, live}) => ({fixture_id, capture: live}));
  const contractRows = contracts;
  const blockedHostsByFixture = requestGateSnapshot?.blocked_hosts_by_fixture ?? {};
  const blockedHostPolicyByFixture = {};
  const results = registry.fixtures.map((fixture) => {
    const frozen = frozenRows.find((row) => row.fixture_id === fixture.fixture_id)?.capture;
    const blockedHostPolicy = classifyBlockedResourceHosts({
      blockedHosts: Object.hasOwn(blockedHostsByFixture, fixture.fixture_id)
        ? blockedHostsByFixture[fixture.fixture_id]
        : null,
      live: frozen,
      policy: policy.value,
    });
    blockedHostPolicyByFixture[fixture.fixture_id] = blockedHostPolicy;
    return compareSandboxOracleFixture({
      fixture,
      local: localRows.find((row) => row.fixture_id === fixture.fixture_id)?.capture,
      frozen,
      thresholds: DEFAULT_THRESHOLDS,
      contract: contractRows.find((row) => row.fixture_id === fixture.fixture_id)?.contract ?? null,
      blockedHosts: blockedHostPolicy.blocking_hosts,
      allowedBlockedHosts: blockedHostPolicy.allowed_blocked_hosts,
    });
  });
  const aggregate = aggregateSandboxOracleVerdict({runId: args.runId, registry, results});
  const outputFlag = args.resume ? "w" : "wx";
  await fs.writeFile(path.join(args.outputDir, "local-captures.json"), `${JSON.stringify({schema: "wikijump_local_lab.sandbox_oracle_captures.v1", captures: localRows}, null, 2)}\n`, {flag: outputFlag});
  await fs.writeFile(path.join(args.outputDir, "frozen-captures.json"), `${JSON.stringify({schema: "wikijump_local_lab.sandbox_oracle_captures.v1", captures: frozenRows}, null, 2)}\n`, {flag: outputFlag});
  await fs.writeFile(path.join(args.outputDir, "contracts.json"), `${JSON.stringify({schema: "wikijump_local_lab.sandbox_oracle_contracts.v1", contracts: contractRows}, null, 2)}\n`, {flag: outputFlag});
  await fs.writeFile(path.join(args.outputDir, "oracle-verdict.json"), `${JSON.stringify(aggregate.verdict, null, 2)}\n`, {flag: outputFlag});
  const requestGatePassed = requestGateError === null && requestGateSnapshot !== null;
  await fs.writeFile(path.join(args.outputDir, "capture-receipt.json"), `${JSON.stringify({schema: "wikijump_local_lab.sandbox_oracle_capture_receipt.v1", status: aggregate.exitCode === 0 && cleanupFailures.length === 0 && requestGatePassed ? "pass" : "fail", run_id: args.runId, registry_path: args.registry, registry_sha256: await sha256File(args.registry), sources_path: args.sources, sources_sha256: await sha256File(args.sources), source_dependencies: dependencies, live_origin: LIVE_ORIGIN, local_origin: LOCAL_ORIGIN, runtime_identity: runtimeIdentity, request_gate: requestGateSnapshot, request_gate_error: requestGateError, blocked_host_policy: {policy_version: policy.value.policy_version, policy_sha256: policy.sha256, by_fixture: blockedHostPolicyByFixture}, cleanup: {created_and_removed_pages: cleanupSuccesses, residual_pages: cleanupFailures.map(({fixture_id, target, resource, error}) => ({fixture_id, target, resource, error})), failures: cleanupFailures}}, null, 2)}\n`, {flag: outputFlag});
  console.log(JSON.stringify({status: aggregate.verdict.aggregate.fail === 0 ? "pass" : "fail", fixtures: aggregate.verdict.fixture_count, failed: aggregate.verdict.aggregate.fail, output_dir: args.outputDir}));
  return aggregate.exitCode === 0 && cleanupFailures.length === 0 && requestGatePassed ? 0 : 1;
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error.stack ?? error);
  process.exitCode = 2;
}
