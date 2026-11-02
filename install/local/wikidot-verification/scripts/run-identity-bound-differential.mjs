#!/usr/bin/env node

import {spawnSync} from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {publishBytesNoReplace} from "../src/atomic-no-replace.mjs";
import {sha256Hex} from "../src/canonical-json.mjs";
import {runCliIfMain} from "../src/cli-entry.mjs";

const MANIFEST_SCHEMA = "wikijump_syntax_differential.case_manifest.v1";
const VERDICT_SCHEMA = "wikijump_syntax_differential.identity_bound_verdict.v1";
const REPORT_SCHEMA = "wikijump_syntax_differential.generic_runtime_verdict.v1";
const CLEANUP_SCHEMA = "wikijump_syntax_differential.runtime_stack_cleanup.v1";
const CANDIDATE_SCHEMA = "roku.candidate_build_manifest.v1";
const ADAPTER = "candidate_generic_runtime_stack_v1";
const NODE = process.execPath;
const GIT = "/usr/bin/git";
const DOCKER = "/usr/bin/docker";
const REPOSITORY = fileURLToPath(new URL("../../../..", import.meta.url));
const STACK = path.join(REPOSITORY, "install/local/wikidot-verification/scripts/run-generic-runtime-differential-stack.mjs");
const SHA1 = /^[0-9a-f]{40}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const COMMAND_ENV = Object.freeze({LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin"});
const MANIFEST_FIELDS = ["actor", "adapter", "candidate_manifest", "case_id", "channels", "context", "executables", "output", "repository", "runtime_output", "schema", "site", "site_data", "source", "url", "wikidot_evidence"];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactFields(value, fields, label) {
  requireValue(isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...fields].sort()), `${label} has an unsupported field shape`);
}

function absolutePath(value, label) {
  requireValue(typeof value === "string" && path.isAbsolute(value) && !value.includes("\0"), `${label} must be an absolute path`);
  return value;
}

async function artifact(filePath, label, {executable = false} = {}) {
  const stat = await fs.lstat(filePath);
  requireValue(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file`);
  if (executable) requireValue((stat.mode & 0o111) !== 0, `${label} must be executable`);
  return {path: filePath, bytes: stat.size, sha256: sha256Hex(await fs.readFile(filePath))};
}

async function inOrder(thunks) {
  const results = await Promise.allSettled(thunks.map((thunk) => thunk()));
  for (const result of results) if (result.status === "rejected") throw result.reason;
  return results.map((result) => result.value);
}

async function boundArtifact(value, label, options) {
  exactFields(value, ["path", "sha256"], label);
  const filePath = absolutePath(value.path, `${label}.path`);
  requireValue(SHA256.test(value.sha256), `${label}.sha256 must be a lowercase SHA-256`);
  const actual = await artifact(filePath, label, options);
  requireValue(actual.sha256 === value.sha256, `${label} identity moved`);
  return actual;
}

async function unchanged(value, label, options) {
  const actual = await artifact(value.path, label, options);
  requireValue(actual.sha256 === value.sha256, `${label} identity moved`);
}

async function assertAbsent(target, label) {
  try {
    await fs.lstat(target);
    throw new Error(`${label} already exists`);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

async function publishNoReplace(filePath, value) {
  await publishBytesNoReplace(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function readJsonLines(bytes, label) {
  try {
    return bytes.split("\n").filter((line) => line.trim()).map(JSON.parse);
  } catch (error) {
    throw new Error(`${label} is not valid JSONL: ${error.message}`);
  }
}

async function artifactList(values, label) {
  requireValue(Array.isArray(values), `${label} must be an array`);
  return Promise.all(values.map((value, index) => boundArtifact(value, `${label}[${index}]`)));
}

function sameIdentity(left, right) {
  return left?.path === right.path && left?.sha256 === right.sha256;
}

async function validateManifest(value, manifestPath) {
  exactFields(value, MANIFEST_FIELDS, "case manifest");
  requireValue(value.schema === MANIFEST_SCHEMA, `manifest must use schema ${MANIFEST_SCHEMA}`);
  requireValue(value.adapter === ADAPTER, `adapter must be ${ADAPTER}`);
  requireValue(SAFE_ID.test(value.case_id ?? ""), "case_id is invalid");
  requireValue(value.repository === REPOSITORY, "repository must bind this checkout");
  requireValue(value.site === "sandbox-for-codex", "site must be sandbox-for-codex");
  exactFields(value.actor, ["kind"], "actor");
  requireValue(value.actor.kind === "seeded_administrator", "actor must be seeded_administrator");
  requireValue(value.context === "saved", "context must be saved");
  requireValue(typeof value.url === "string", "url must be a string");
  const url = new URL(value.url);
  requireValue(url.protocol === "https:" && url.hostname === "sandbox-for-codex.wikidot.com" && url.username === "" && url.password === "" && url.port === "" && url.search === "" && url.hash === "" && /^\/[A-Za-z0-9][A-Za-z0-9_.:-]*$/u.test(url.pathname), "url must bind one saved sandbox-for-codex Wikidot page");

  const candidateManifest = await boundArtifact(value.candidate_manifest, "candidate_manifest");
  const candidate = JSON.parse(await fs.readFile(candidateManifest.path, "utf8"));
  requireValue(candidate.schema === CANDIDATE_SCHEMA, "candidate_manifest has an unsupported schema");
  requireValue(SHA1.test(candidate.source?.wikijump_sha) && SHA1.test(candidate.source?.ftml_sha), "candidate_manifest has invalid source revisions");
  requireValue(SHA256.test(candidate.build?.cargo_lock_sha256) && SHA256.test(candidate.build?.binary_sha256), "candidate_manifest has invalid build identities");

  const source = await boundArtifact(value.source, "source");
  const cases = readJsonLines(await fs.readFile(source.path, "utf8"), "source");
  requireValue(cases.length === 1 && cases[0]?.case_id === value.case_id && cases[0]?.execution_class === "wikijump-runtime", "source must contain exactly the requested runtime case");

  exactFields(value.site_data, ["state_fixtures"], "site_data");
  const stateFixtures = await artifactList(value.site_data.state_fixtures, "site_data.state_fixtures");
  exactFields(value.wikidot_evidence, ["captures", "external_references"], "wikidot_evidence");
  const captures = await artifactList(value.wikidot_evidence.captures, "wikidot_evidence.captures");
  const externalReferences = await artifactList(value.wikidot_evidence.external_references, "wikidot_evidence.external_references");
  requireValue(captures.length > 0, "wikidot_evidence.captures must bind at least one saved-page capture");

  exactFields(value.executables, ["docker", "git", "node"], "executables");
  const [node, git, docker] = await inOrder([
    () => boundArtifact(value.executables.node, "executables.node", {executable: true}),
    () => boundArtifact(value.executables.git, "executables.git", {executable: true}),
    () => boundArtifact(value.executables.docker, "executables.docker", {executable: true}),
  ]);
  requireValue(node.path === NODE && git.path === GIT && docker.path === DOCKER, "executables do not bind the closed stack interface");
  exactFields(value.channels, ["browser_intervals", "parsed_dom", "raw_html", "visible_text"], "channels");
  for (const name of ["raw_html", "parsed_dom", "visible_text"]) {
    exactFields(value.channels[name], ["applies"], `channels.${name}`);
    requireValue(value.channels[name].applies === true, `${name} must be applicable`);
  }
  exactFields(value.channels.browser_intervals, ["applies", "basis", "reason"], "channels.browser_intervals");
  requireValue(value.channels.browser_intervals.applies === false && value.channels.browser_intervals.basis === "case_contract" && typeof value.channels.browser_intervals.reason === "string" && value.channels.browser_intervals.reason.trim() !== "", "browser_intervals must be not applicable for a stated case-contract reason");

  const runtimeOutput = absolutePath(value.runtime_output, "runtime_output");
  const output = absolutePath(value.output, "output");
  const stackLog = `${runtimeOutput}.stack.log`;
  requireValue(path.dirname(runtimeOutput) === path.dirname(manifestPath) && path.dirname(output) === path.dirname(manifestPath), "runtime_output and output must be run-owned siblings of the case manifest");
  requireValue(new Set([manifestPath, runtimeOutput, output, `${runtimeOutput}.cleanup.json`, stackLog]).size === 5, "runner paths collide");
  return {caseId: value.case_id, candidateManifest, candidate, source, stateFixtures, captures, externalReferences, actor: value.actor, context: value.context, site: value.site, url: url.href, executables: {node, git, docker}, channels: value.channels, runtimeOutput, stackLog, output, cleanupReceipt: `${runtimeOutput}.cleanup.json`};
}

function evaluateReport(run, report, cleanup, runId) {
  requireValue(report?.schema === REPORT_SCHEMA, "runtime differential returned an unsupported report");
  requireValue(report.comparisons?.length === 1 && report.comparisons[0]?.case_id === run.caseId, "runtime differential returned an incomplete case result");
  const expectedInputs = {cases: run.source, captures: run.captures, external_references: run.externalReferences, state_fixtures: run.stateFixtures};
  requireValue(sameIdentity(report.input_identities?.cases, expectedInputs.cases), "runtime report does not bind the case source");
  for (const [name, expected] of Object.entries(expectedInputs).filter(([name]) => name !== "cases")) {
    requireValue(Array.isArray(report.input_identities?.[name]) && report.input_identities[name].length === expected.length && report.input_identities[name].every((identity, index) => sameIdentity(identity, expected[index])), `runtime report does not bind ${name}`);
  }
  const identity = report.runtime_identity;
  requireValue(identity?.wikijump_sha === run.candidate.source.wikijump_sha && identity?.ftml_sha === run.candidate.source.ftml_sha && identity?.dependency_lock_sha256 === run.candidate.build.cargo_lock_sha256 && identity?.executable_sha256 === run.candidate.build.binary_sha256 && SHA256.test(identity?.runtime_config_sha256), "runtime identity does not match the candidate build");
  requireValue(cleanup?.schema === CLEANUP_SCHEMA && cleanup.status === "pass" && cleanup.run_id === runId && cleanup.run_root_removed === true && cleanup.public_absence_verified === true && cleanup.resources_released === true && cleanup.vacant === true && cleanup.browser_closed === true && (!cleanup.compose_started || (cleanup.compose_down_exit_code === 0 && cleanup.compose_down_signal === null)), "runtime stack cleanup did not pass");
  requireValue(sameIdentity(cleanup.candidate_receipt, run.candidateManifest), "runtime stack cleanup is not bound to the candidate receipt");
  requireValue(Array.isArray(report.page_receipts) && report.page_receipts.length === 1 && report.page_receipts[0]?.cleanup?.status === "removed", "saved runtime page cleanup is incomplete");
  const comparison = report.comparisons[0];
  requireValue(run.captures.some((capture) => capture.path === comparison.identities?.capture_file) && Number.isSafeInteger(comparison.identities?.page_identity), "runtime result is not bound to saved Wikidot capture evidence");
  requireValue(new URL(run.url).pathname.slice(1) === comparison.identities?.wikidot_batch_slug, "runtime result does not bind the declared saved-page URL");
  const wikidotHtml = comparison.identities?.wikidot_html_sha256;
  const wikijumpHtml = comparison.identities?.wikijump_html_sha256;
  const channels = {
    raw_html: {status: SHA256.test(wikidotHtml) && wikidotHtml === wikijumpHtml ? "pass" : "fail", wikidot_sha256: wikidotHtml ?? null, wikijump_sha256: wikijumpHtml ?? null},
    parsed_dom: {status: comparison.checks?.dom_tree?.status === "match" ? "pass" : "fail", comparison: comparison.checks?.dom_tree?.status ?? null},
    visible_text: {status: comparison.checks?.visible_text?.status === "match" ? "pass" : "fail", comparison: comparison.checks?.visible_text?.status ?? null},
    browser_intervals: {status: "not_applicable", basis: run.channels.browser_intervals.basis, reason: run.channels.browser_intervals.reason},
  };
  const passed = report.status === "pass" && Object.values(channels).filter((channel) => channel.status !== "not_applicable").every((channel) => channel.status === "pass");
  return {passed, channels, comparisonStatus: comparison.status};
}

export function parseArgs(argv) {
  requireValue(argv.length === 4 && argv[0] === "--case-manifest" && argv[1] && argv[2] === "--run-id" && argv[3], "Usage: run-identity-bound-differential.mjs --case-manifest /absolute/case-manifest.json --run-id candidate-run-<12 hex>");
  requireValue(/^candidate-run-[0-9a-f]{12}$/u.test(argv[3]), "--run-id must be a candidate run ID");
  return {manifestPath: absolutePath(argv[1], "--case-manifest"), runId: argv[3]};
}

export async function main(argv, {spawn = spawnSync} = {}) {
  const {manifestPath, runId} = parseArgs(argv);
  const manifestIdentity = await artifact(manifestPath, "case manifest");
  const run = await validateManifest(JSON.parse(await fs.readFile(manifestPath, "utf8")), manifestPath);
  const globalLockPath = path.join(os.tmpdir(), "wikijump-candidate-run.lock");
  const globalLock = await fs.open(globalLockPath, "wx", 0o600);
  await globalLock.writeFile(`${JSON.stringify({schema: "wikijump.candidate_global_lock.v1", run_id: runId, evidence_directory: path.dirname(manifestPath)})}\n`);
  await globalLock.sync();
  await globalLock.close();
  const lockPath = path.join(path.dirname(manifestPath), ".candidate-run.lock");
  let lock = null;
  try {
    lock = await fs.open(lockPath, "wx", 0o600);
    await lock.writeFile(`${JSON.stringify({schema: "wikijump.candidate_run_lock.v1", run_id: runId, case_id: run.caseId})}\n`);
    await lock.sync();
    await lock.close();
  } catch (error) {
    await lock?.close().catch(() => {});
    await fs.unlink(globalLockPath).catch(() => {});
    throw error;
  }
  try {
  for (const [target, label] of [[run.runtimeOutput, "runtime_output"], [run.cleanupReceipt, "runtime cleanup receipt"], [run.stackLog, "runtime stack log"], [run.output, "output"]]) await assertAbsent(target, label);
  const startedAt = new Date().toISOString();
  const stackArgs = [STACK, "--repository", REPOSITORY, "--candidate-manifest", run.candidateManifest.path, "--cases", run.source.path, ...run.captures.flatMap((value) => ["--captures", value.path]), ...run.externalReferences.flatMap((value) => ["--external-reference", value.path]), ...run.stateFixtures.flatMap((value) => ["--state-fixture", value.path]), "--site", run.site, "--run-id", runId, "--output", run.runtimeOutput];
  const command = spawn(NODE, stackArgs, {cwd: REPOSITORY, encoding: "utf8", env: COMMAND_ENV, maxBuffer: 16 * 1024 * 1024});
  let report = null;
  let cleanup = null;
  let reportArtifact = null;
  let cleanupArtifact = null;
  let stackLogArtifact = null;
  let reason = command.error?.message ?? (command.status === 0 ? null : `runtime stack exited ${command.status}${command.signal ? ` on ${command.signal}` : ""}`);
  try {
    reportArtifact = await artifact(run.runtimeOutput, "runtime report");
    report = JSON.parse(await fs.readFile(run.runtimeOutput, "utf8"));
  } catch (error) {
    reason ??= error.message;
  }
  try {
    cleanupArtifact = await artifact(run.cleanupReceipt, "runtime cleanup receipt");
    cleanup = JSON.parse(await fs.readFile(cleanupArtifact.path, "utf8"));
  } catch (error) {
    reason ??= error.message;
  }
  try {
    stackLogArtifact = await artifact(run.stackLog, "runtime stack log");
  } catch (error) {
    if (error.code !== "ENOENT") reason ??= error.message;
  }
  if (cleanup?.compose_started === true && stackLogArtifact === null) reason ??= "runtime stack log is missing although Compose started";
  if (cleanup?.compose_started === false && stackLogArtifact !== null) reason ??= "runtime stack log exists although Compose never started";
  try {
    const stableInputs = [["case manifest", manifestIdentity], ["candidate_manifest", run.candidateManifest], ["source", run.source], ...run.stateFixtures.map((item) => ["state fixture", item]), ...run.captures.map((item) => ["capture", item]), ...run.externalReferences.map((item) => ["external reference", item]), ...Object.entries(run.executables).map(([name, item]) => [`executables.${name}`, item])];
    const executablePaths = new Set(Object.values(run.executables).map((item) => item.path));
    await inOrder(stableInputs.map(([label, value]) => () => unchanged(value, label, {executable: executablePaths.has(value.path)})));
  } catch (error) {
    reason ??= error.message;
  }
  let evaluation = null;
  try {
    evaluation = evaluateReport(run, report, cleanup, runId);
  } catch (error) {
    reason ??= error.message;
  }
  const passed = command.status === 0 && evaluation?.passed === true && reason === null;
  if (!passed && reason === null) reason = `runtime comparison is ${evaluation?.comparisonStatus ?? "incomplete"}`;
  const artifacts = [manifestIdentity, run.candidateManifest, run.source, ...run.stateFixtures, ...run.captures, ...run.externalReferences, ...Object.values(run.executables), ...(reportArtifact ? [reportArtifact] : []), ...(cleanupArtifact ? [cleanupArtifact] : []), ...(stackLogArtifact ? [stackLogArtifact] : [])];
  const verdict = {
    schema: VERDICT_SCHEMA,
    adapter: ADAPTER,
    run_id: runId,
    case_id: run.caseId,
    status: passed ? "pass" : "fail",
    reason,
    binding: {candidate_manifest: run.candidateManifest, artifact_key: run.candidate.artifact_key?.key?.replace(/^candidate-v3-/u, "") ?? null, runtime_identity: report?.runtime_identity ?? null, source: run.source, site_data: {state_fixtures: run.stateFixtures}, wikidot_evidence: {captures: run.captures, external_references: run.externalReferences}, actor: run.actor, context: run.context, site: run.site, url: run.url, executables: run.executables},
    channels: evaluation?.channels ?? {raw_html: {status: "fail"}, parsed_dom: {status: "fail"}, visible_text: {status: "fail"}, browser_intervals: {status: "not_applicable", basis: run.channels.browser_intervals.basis, reason: run.channels.browser_intervals.reason}},
    cleanup: cleanup ?? {schema: CLEANUP_SCHEMA, status: "fail", run_id: runId, public_absence_verified: false, resources_released: false, vacant: false, browser_closed: false, reason: "the runtime stack published no cleanup receipt"},
    command: {path: NODE, arguments: stackArgs, exit_code: command.status, signal: command.signal, stdout_sha256: sha256Hex(command.stdout ?? ""), stderr_sha256: sha256Hex(command.stderr ?? "")},
    artifacts: [...new Map(artifacts.map((value) => [value.path, value])).values()],
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  };
  await publishNoReplace(run.output, verdict);
  console.log(JSON.stringify({case_id: verdict.case_id, status: verdict.status, output: run.output}));
  return passed ? 0 : 1;
  } finally {
    await fs.unlink(lockPath).catch(() => {});
    await fs.unlink(globalLockPath).catch(() => {});
  }
}

await runCliIfMain(import.meta.url, main, {onError: (error) => {
  console.error(error.message);
  return 2;
}});
