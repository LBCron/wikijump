import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {main, parseArgs} from "../scripts/run-identity-bound-differential.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY = fileURLToPath(new URL("../../../..", import.meta.url));
const NODE = process.execPath;
const GIT = "/usr/bin/git";
const DOCKER = "/usr/bin/docker";
const STACK = path.join(ROOT, "scripts/run-generic-runtime-differential-stack.mjs");
const EXISTING_CASES = path.join(ROOT, "fixtures/syntax-differential/listpages-error-precedence-cases.jsonl");
const WIKIJUMP_SHA = "1".repeat(40);
const FTML_SHA = "2".repeat(40);
const LOCK_SHA = "3".repeat(64);
const BINARY_SHA = "4".repeat(64);
const RUNTIME_CONFIG_SHA = "5".repeat(64);

async function identity(filePath) {
  return {path: filePath, sha256: createHash("sha256").update(await fs.readFile(filePath)).digest("hex")};
}

let executableIdentities = null;
async function executables() {
  executableIdentities ??= {
    node: await identity(NODE),
    git: await identity(GIT),
    docker: await identity(DOCKER),
  };
  return executableIdentities;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "identity-bound-differential-"));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const manifestPath = path.join(root, "case-manifest.json");
  const candidatePath = path.join(root, "candidate.json");
  const casesPath = path.join(root, "cases.jsonl");
  const capturesPath = path.join(root, "captures.jsonl");
  const statePath = path.join(root, "state.json");
  const runtimeOutput = path.join(root, "runtime-report.json");
  const output = path.join(root, "verdict.json");
  const runId = "candidate-run-abcdef123456";
  const syntaxCase = JSON.parse((await fs.readFile(EXISTING_CASES, "utf8")).split("\n").find((line) => line.trim()));
  assert.equal(syntaxCase.local_execution_tier, "wikijump-runtime");
  const liveCase = {
    schema: "wikijump_syntax_differential.live_case.v1",
    case_id: syntaxCase.case_id,
    execution_class: syntaxCase.local_execution_tier,
    source: syntaxCase.source,
    source_sha256: createHash("sha256").update(syntaxCase.source).digest("hex"),
    title: syntaxCase.title,
  };
  await fs.writeFile(candidatePath, `${JSON.stringify({schema: "roku.candidate_build_manifest.v1", source: {wikijump_sha: WIKIJUMP_SHA, ftml_sha: FTML_SHA}, build: {cargo_lock_sha256: LOCK_SHA, binary_sha256: BINARY_SHA}})}\n`);
  await fs.writeFile(casesPath, `${JSON.stringify(liveCase)}\n`);
  await fs.writeFile(capturesPath, "{}\n");
  await fs.writeFile(statePath, "{}\n");
  const manifest = {
    schema: "wikijump_syntax_differential.case_manifest.v1",
    adapter: "candidate_generic_runtime_stack_v1",
    case_id: syntaxCase.case_id,
    repository: REPOSITORY,
    candidate_manifest: await identity(candidatePath),
    source: await identity(casesPath),
    site_data: {state_fixtures: [await identity(statePath)]},
    actor: {kind: "seeded_administrator"},
    context: "saved",
    site: "sandbox-for-codex",
    url: "https://sandbox-for-codex.wikidot.com/run-owned:ftml-diff-20260815-001",
    wikidot_evidence: {captures: [await identity(capturesPath)], external_references: []},
    executables: structuredClone(await executables()),
    channels: {
      raw_html: {applies: true},
      parsed_dom: {applies: true},
      visible_text: {applies: true},
      browser_intervals: {applies: false, basis: "case_contract", reason: "this saved-page case has no interaction or temporal behavior"},
    },
    runtime_output: runtimeOutput,
    output,
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {root, manifestPath, candidatePath, casesPath, capturesPath, statePath, runtimeOutput, output, manifest, syntaxCase, liveCase, runId};
}

function runArgs(value) {
  return ["--case-manifest", value.manifestPath, "--run-id", value.runId];
}

function runtimeReport(value, overrides = {}) {
  const htmlHash = "6".repeat(64);
  return {
    schema: "wikijump_syntax_differential.generic_runtime_verdict.v1",
    status: "pass",
    runtime_identity: {schema: "wikijump_syntax_differential.wikijump_runtime_identity.v1", wikijump_sha: WIKIJUMP_SHA, ftml_sha: FTML_SHA, dependency_lock_sha256: LOCK_SHA, executable_sha256: BINARY_SHA, runtime_config_sha256: RUNTIME_CONFIG_SHA},
    input_identities: {cases: value.manifest.source, captures: value.manifest.wikidot_evidence.captures, external_references: [], state_fixtures: value.manifest.site_data.state_fixtures, runtime_identity: {path: "/deleted/run/runtime-identity.json", sha256: "7".repeat(64)}},
    comparisons: [{case_id: value.syntaxCase.case_id, status: "match", identities: {wikidot_html_sha256: htmlHash, wikijump_html_sha256: htmlHash, capture_file: value.capturesPath, page_identity: 42, wikidot_batch_slug: "run-owned:ftml-diff-20260815-001"}, checks: {dom_tree: {status: "match"}, visible_text: {status: "match"}}}],
    state_fixture_receipts: [],
    page_receipts: [{slug: "run-owned:fixture", cleanup: {status: "removed"}}],
    ...overrides,
  };
}

function cleanup(overrides = {}) {
  return {schema: "wikijump_syntax_differential.runtime_stack_cleanup.v1", run_id: "runtime-diff-test", project: "runtime-diff-test", status: "pass", compose_started: true, compose_down_exit_code: 0, compose_down_signal: null, run_root_removed: true, public_absence_verified: true, resources_released: true, vacant: true, browser_closed: true, ...overrides};
}

function stackMock(value, {report = runtimeReport(value), cleanupReceipt = cleanup(), stackLog = undefined, status = 0, mutate = null} = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({command, args, options});
    mutate?.();
    if (report !== null) fsSync.writeFileSync(value.runtimeOutput, `${JSON.stringify(report)}\n`);
    if (cleanupReceipt !== null) fsSync.writeFileSync(`${value.runtimeOutput}.cleanup.json`, `${JSON.stringify({...cleanupReceipt, run_id: args[args.indexOf("--run-id") + 1], candidate_receipt: cleanupReceipt.candidate_receipt ?? value.manifest.candidate_manifest})}\n`);
    const retainedLog = stackLog === undefined && cleanupReceipt?.compose_started === true ? "bound stack log\n" : stackLog;
    if (retainedLog != null) fsSync.writeFileSync(`${value.runtimeOutput}.stack.log`, retainedLog);
    return {status, signal: null, stdout: "runtime summary\n", stderr: ""};
  };
  return {calls, spawn};
}

test("one public command runs the candidate-bound generic runtime stack and proves all applicable channels and cleanup", async (t) => {
  const value = await fixture(t);
  const mock = stackMock(value);
  assert.equal(await main(runArgs(value), {spawn: mock.spawn}), 0);
  assert.equal(mock.calls.length, 1);
  assert.equal(mock.calls[0].command, NODE);
  assert.deepEqual(mock.calls[0].args.slice(0, -4), [STACK, "--repository", REPOSITORY, "--candidate-manifest", value.candidatePath, "--cases", value.casesPath, "--captures", value.capturesPath, "--state-fixture", value.statePath, "--site", "sandbox-for-codex"]);
  assert.match(mock.calls[0].args.at(-3), /^candidate-run-[0-9a-f]{12}$/u);
  assert.deepEqual(mock.calls[0].args.slice(-2), ["--output", value.runtimeOutput]);
  assert.equal(value.liveCase.case_id, "listpages-error-range-others-unsaved");
  assert.equal(value.liveCase.source, value.syntaxCase.source);
  assert.equal(value.liveCase.source_sha256, createHash("sha256").update(value.syntaxCase.source).digest("hex"));
  assert.equal("timeout" in mock.calls[0].options, false);
  assert.deepEqual(mock.calls[0].options.env, {LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin"});
  const verdict = JSON.parse(await fs.readFile(value.output, "utf8"));
  assert.equal(verdict.status, "pass");
  assert.equal(verdict.case_id, value.syntaxCase.case_id);
  assert.deepEqual(verdict.binding.source, {...value.manifest.source, bytes: (await fs.stat(value.casesPath)).size});
  assert.equal(verdict.command.path, NODE);
  assert.equal(verdict.command.arguments[0], STACK);
  assert.equal(verdict.binding.runtime_identity.wikijump_sha, WIKIJUMP_SHA);
  assert.equal(verdict.binding.runtime_identity.executable_sha256, BINARY_SHA);
  assert.equal(verdict.channels.raw_html.status, "pass");
  assert.equal(verdict.channels.parsed_dom.status, "pass");
  assert.equal(verdict.channels.visible_text.status, "pass");
  assert.deepEqual(verdict.channels.browser_intervals, {status: "not_applicable", basis: "case_contract", reason: "this saved-page case has no interaction or temporal behavior"});
  assert.equal(verdict.cleanup.status, "pass");
  assert.equal(verdict.artifacts.some((item) => item.path === `${value.runtimeOutput}.stack.log`), true);
  assert.ok(verdict.artifacts.every((item) => path.isAbsolute(item.path) && /^[0-9a-f]{64}$/u.test(item.sha256)));
});

test("the identity-bound differential requires the propagated candidate run ID", () => {
  assert.deepEqual(parseArgs(["--case-manifest", "/tmp/case.json", "--run-id", "candidate-run-abcdef123456"]), {
    manifestPath: "/tmp/case.json",
    runId: "candidate-run-abcdef123456",
  });
  assert.throws(() => parseArgs(["--case-manifest", "/tmp/case.json"]), /--run-id/u);
});

test("the public seam ignores poisoned Git, Docker, and PATH routing", async (t) => {
  const value = await fixture(t);
  const mock = stackMock(value);
  const saved = Object.fromEntries(["PATH", "GIT_DIR", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_TLS_VERIFY", "DOCKER_CONFIG"].map((name) => [name, process.env[name]]));
  Object.assign(process.env, {PATH: "/poison", GIT_DIR: "/poison", DOCKER_HOST: "tcp://poison:2376", DOCKER_CONTEXT: "poison", DOCKER_TLS_VERIFY: "1", DOCKER_CONFIG: "/poison"});
  try {
  assert.equal(await main(runArgs(value), {spawn: mock.spawn}), 0);
  } finally {
    for (const [name, previous] of Object.entries(saved)) {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
  assert.deepEqual(mock.calls[0].options.env, {LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin"});
  const stackSource = await fs.readFile(STACK, "utf8");
  assert.doesNotMatch(stackSource, /run\("(?:git|docker)"|spawnSync\("docker"/u);
  assert.match(stackSource, /DOCKER_HOST: "unix:\/\/\/var\/run\/docker\.sock"/u);
});

test("raw HTML, DOM, and visible text are mandatory fail-closed channels", async (t) => {
  for (const mutate of [
    (report) => { report.comparisons[0].identities.wikijump_html_sha256 = "8".repeat(64); },
    (report) => { report.comparisons[0].checks.dom_tree.status = "mismatch"; },
    (report) => { report.comparisons[0].checks.visible_text.status = "mismatch"; },
  ]) {
    const value = await fixture(t);
    const report = runtimeReport(value);
    mutate(report);
    assert.equal(await main(runArgs(value), {spawn: stackMock(value, {report}).spawn}), 1);
    const verdict = JSON.parse(await fs.readFile(value.output, "utf8"));
    assert.equal(verdict.status, "fail");
    assert.equal(Object.values(verdict.channels).some((channel) => channel.status === "fail"), true);
  }
});

test("the selected saved capture must match the manifest URL", async (t) => {
  const value = await fixture(t);
  const report = runtimeReport(value);
  report.comparisons[0].identities.wikidot_batch_slug = "run-owned:ftml-diff-20260815-999";
  assert.equal(await main(runArgs(value), {spawn: stackMock(value, {report}).spawn}), 1);
  const verdict = JSON.parse(await fs.readFile(value.output, "utf8"));
  assert.equal(verdict.status, "fail");
  assert.match(verdict.reason, /does not bind the declared saved-page URL/u);
});

test("missing or failed stack cleanup makes a partial runtime result fail closed", async (t) => {
  for (const cleanupReceipt of [null, cleanup({status: "fail", compose_down_exit_code: 1})]) {
    const value = await fixture(t);
    assert.equal(await main(runArgs(value), {spawn: stackMock(value, {cleanupReceipt}).spawn}), 1);
    const verdict = JSON.parse(await fs.readFile(value.output, "utf8"));
    assert.equal(verdict.status, "fail");
    assert.equal(verdict.cleanup.status, "fail");
  }
});

test("moving inputs and partial child output publish a failed no-replace verdict", async (t) => {
  const moved = await fixture(t);
  assert.equal(await main(runArgs(moved), {spawn: stackMock(moved, {mutate: () => fsSync.appendFileSync(moved.capturesPath, "{}\n")}).spawn}), 1);
  assert.match(JSON.parse(await fs.readFile(moved.output, "utf8")).reason, /capture identity moved/u);

  const partial = await fixture(t);
  assert.equal(await main(runArgs(partial), {spawn: stackMock(partial, {report: null, cleanupReceipt: null, stackLog: "partial crash log\n", status: 2}).spawn}), 1);
  const verdict = JSON.parse(await fs.readFile(partial.output, "utf8"));
  assert.equal(verdict.status, "fail");
  assert.match(verdict.reason, /runtime stack exited 2/u);
  assert.equal(verdict.artifacts.some((item) => item.path === `${partial.runtimeOutput}.stack.log`), true);
});

test("unknown interfaces and an existing verdict are rejected before the stack starts", async (t) => {
  for (const [mutate, error] of [
    [(manifest) => { manifest.adapter = "arbitrary_command_v1"; }, /adapter must be candidate_generic_runtime_stack_v1/u],
    [(manifest) => { manifest.args = ["--delete", "/protected/runtime"]; }, /case manifest has an unsupported field shape/u],
    [(manifest) => { manifest.executables.node = manifest.source; }, /executables\.node must be executable/u],
    [(manifest) => { manifest.channels.raw_html.applies = false; }, /raw_html must be applicable/u],
    [(manifest) => { manifest.channels.browser_intervals.basis = "tool_limit"; }, /case-contract reason/u],
  ]) {
    const value = await fixture(t);
    mutate(value.manifest);
    await fs.writeFile(value.manifestPath, `${JSON.stringify(value.manifest)}\n`);
    let calls = 0;
    await assert.rejects(main(runArgs(value), {spawn: () => { calls += 1; }}), error);
    assert.equal(calls, 0);
  }

  const value = await fixture(t);
  await fs.writeFile(value.output, "keep\n");
  let calls = 0;
  await assert.rejects(main(runArgs(value), {spawn: () => { calls += 1; }}), /output already exists/u);
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(value.output, "utf8"), "keep\n");

  const preexistingLog = await fixture(t);
  await fs.writeFile(`${preexistingLog.runtimeOutput}.stack.log`, "keep log\n");
  calls = 0;
  await assert.rejects(main(runArgs(preexistingLog), {spawn: () => { calls += 1; }}), /runtime stack log already exists/u);
  assert.equal(calls, 0);
  assert.equal(await fs.readFile(`${preexistingLog.runtimeOutput}.stack.log`, "utf8"), "keep log\n");
});
