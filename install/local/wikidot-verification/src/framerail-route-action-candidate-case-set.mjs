import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {
  buildTemporalCapturePlan,
  runTemporalCapture,
  validateTemporalRunContract,
} from "../scripts/capture-framerail-route-action-temporal.mjs";
import {defaultBrowserRoot} from "./browser-session.mjs";
import {STANDING_BROWSER_EXECUTION_MODULES} from "./standing-browser-execution-identity.mjs";
import {candidatePageOrigin} from "./standing-browser-parity-receipt.mjs";
import {requireNonEmptyString, requirePlainObject, requireSha256, sha256File} from "./standing-browser-parity-util.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const CONTRACT_PATH = path.join(REPOSITORY_ROOT, "install/local/wikidot-verification/fixtures/framerail-route-action-browser/run-contract.json");
const CONTRACT_RELATIVE_PATH = "install/local/wikidot-verification/fixtures/framerail-route-action-browser/run-contract.json";
const HISTORICAL_EVIDENCE_RELATIVE_PATH = "install/local/wikidot-verification/artifacts/page-pane-lazy-browser-20260713.json";
const TEMPORAL_OUTPUT_NAME = "framerail-route-action-temporal";
const SOURCE_FILES = Object.freeze([...new Set([
  ...STANDING_BROWSER_EXECUTION_MODULES,
  "install/local/wikidot-verification/scripts/run-candidate-cases.mjs",
  "install/local/wikidot-verification/src/candidate-case-command.mjs",
  "install/local/wikidot-verification/src/candidate-case-runner.mjs",
  "install/local/wikidot-verification/src/framerail-route-action-candidate-case-set.mjs",
  "install/local/wikidot-verification/scripts/capture-framerail-route-action-temporal.mjs",
  "install/local/wikidot-verification/src/browser-session.mjs",
  "install/local/wikidot-verification/src/browser-render-evidence.mjs",
  CONTRACT_RELATIVE_PATH,
  HISTORICAL_EVIDENCE_RELATIVE_PATH,
])]);

function absolutePath(value, label) {
  const result = requireNonEmptyString(value, label);
  if (!path.isAbsolute(result) || path.normalize(result) !== result) throw new Error(`${label} must be an exact absolute path`);
  return result;
}

function caseId(scenario, subject, interval) {
  return `${scenario}_${interval}_${subject}`.replace(/[^A-Za-z0-9_]/gu, "_").toUpperCase();
}

function caseDefinitions(contract) {
  const {subjects, scenarios} = validateTemporalRunContract(contract);
  const definitions = scenarios.flatMap((scenario) => subjects.flatMap((subject) => scenario.intervals.map((interval) => ({
    case_id: caseId(scenario.id, subject.id, interval),
    scenario: scenario.id,
    subject_id: subject.id,
    interval,
  }))));
  if (new Set(definitions.map(({case_id}) => case_id)).size !== definitions.length) throw new Error("temporal candidate case IDs are not unique");
  return definitions;
}

function captureInput(privateInput, contract, candidateIdentity, urls) {
  const input = requirePlainObject(privateInput, "private candidate input");
  const capture = requirePlainObject(input.temporal_capture, "private temporal capture input");
  const browser = requirePlainObject(capture.browser_identity, "private browser identity");
  const identities = {
    browser: {path: absolutePath(capture.browser_executable, "browser executable"), sha256: requireSha256(browser.sha256, "browser executable SHA-256"), version: requireNonEmptyString(browser.version, "browser version")},
    fixture: {path: absolutePath(capture.fixture_identity, "fixture identity"), sha256: requireSha256(capture.fixture_identity_sha256, "fixture identity SHA-256")},
    failureControl: {path: absolutePath(capture.failure_control_identity, "failure-control identity"), sha256: requireSha256(capture.failure_control_identity_sha256, "failure-control identity SHA-256")},
    runtime: {path: absolutePath(capture.runtime_identity, "runtime identity"), sha256: requireSha256(capture.runtime_identity_sha256, "runtime identity SHA-256")},
  };
  const actors = requirePlainObject(capture.actor_classes, "temporal actor classes");
  const storageStates = requirePlainObject(capture.storage_states, "temporal storage states");
  for (const scenario of ["denial", "failure", "success"]) {
    if (!contract.actor_classes.includes(actors[scenario])) throw new Error(`${scenario} actor class is not in the run contract`);
    storageStates[scenario] = absolutePath(storageStates[scenario], `${scenario} storage state`);
  }
  buildTemporalCapturePlan(contract, urls);
  const origin = candidatePageOrigin(candidateIdentity);
  for (const scenario of ["denial", "failure", "success"]) for (const kind of ["missing_page", "saved_page"]) {
    if (new URL(urls[scenario][kind]).origin !== origin) throw new Error(`${scenario} ${kind} URL is not bound to the candidate origin`);
  }
  const runtimeBindings = capture.runtime_bindings;
  if (!Array.isArray(runtimeBindings)) throw new Error("temporal runtime bindings must be an array");
  return {capture, identities, actors, storageStates, runtimeBindings};
}

function assertTemporalIdentity(result, contract, contractSha256, candidateIdentity, input, outputDir) {
  if (result?.status !== "captured" || result.source_revision !== candidateIdentity.candidate.wikijump_commit || result.source_tree !== candidateIdentity.candidate.wikijump_tree) throw new Error("temporal result is not bound to the sealed candidate source identity");
  if (JSON.stringify(result.capture?.source_identity) !== JSON.stringify({wikijump_commit: candidateIdentity.candidate.wikijump_commit, wikijump_tree: candidateIdentity.candidate.wikijump_tree})) throw new Error("temporal result source identity is not exact");
  if (JSON.stringify(result.capture?.runtime_source_identity) !== JSON.stringify({wikijump_commit: candidateIdentity.candidate.wikijump_commit, wikijump_tree: candidateIdentity.candidate.wikijump_tree})) throw new Error("temporal runtime identity is not bound to the candidate source identity");
  const browser = result.capture?.browser_identity;
  if (browser?.executable?.path !== input.identities.browser.path || browser.executable.sha256 !== input.identities.browser.sha256 || browser.version !== input.identities.browser.version) throw new Error("temporal result browser identity is not sealed");
  for (const [name, expected] of [["fixture_identity", input.identities.fixture], ["failure_control_identity", input.identities.failureControl], ["runtime_identity", input.identities.runtime]]) {
    if (result.capture?.[name]?.path !== expected.path || result.capture?.[name]?.sha256 !== expected.sha256) throw new Error(`temporal result ${name} is not sealed`);
  }
  if (result.capture?.run_contract_identity?.path !== CONTRACT_PATH || result.capture.run_contract_identity.sha256 !== contractSha256 || result.capture.capture_script_identity?.path !== path.join(REPOSITORY_ROOT, contract.capture.script) || result.capture.capture_script_identity.sha256 !== contract.capture.script_sha256) throw new Error("temporal result contract or script identity is not sealed");
  if (result.capture.request_gate_config !== path.join(outputDir, "request-gate-config.json")) throw new Error("temporal result request-gate path is not run-owned");
  if (result.capture.execution_mode !== "candidate" || result.capture.request_interval_ms !== 0) throw new Error("temporal result did not prove candidate execution mode without a fixed request throttle");
}

export async function createFramerailRouteActionCandidateCaseSet({temporalRunner = runTemporalCapture} = {}) {
  const contractBytes = await fs.readFile(CONTRACT_PATH);
  const contract = JSON.parse(contractBytes.toString("utf8"));
  if (contract.historical_evidence?.path !== HISTORICAL_EVIDENCE_RELATIVE_PATH) throw new Error("temporal contract historical evidence is not bound to its source identity");
  const contractSha256 = await sha256File(CONTRACT_PATH);
  const definitions = caseDefinitions(contract);
  const definitionById = new Map(definitions.map((definition) => [definition.case_id, definition]));
  return Object.freeze({
    id: "framerail-route-action-browser",
    caseIds: Object.freeze(definitions.map(({case_id}) => case_id)),
    prepareRun({runId, candidateIdentity, privateInput, privateInputSha256, outputDir, signal, resources}) {
      const urls = requirePlainObject(privateInput?.temporal_capture?.urls, "temporal URLs");
      const input = captureInput(privateInput, contract, candidateIdentity, urls);
      let result = null;
      return Object.freeze({
        sourceFiles: SOURCE_FILES,
        runtimeBindings: input.runtimeBindings,
        privateInputIdentity: {temporal_capture_input_sha256: privateInputSha256},
        browserCredentialPolicy: "none",
        plan: {schema: "wikijump.framerail_route_action_candidate_plan.v1", run_id: runId, execution_mode: "candidate", request_interval_ms: 0, contract_path: CONTRACT_RELATIVE_PATH, contract_sha256: contractSha256, case_ids: definitions.map(({case_id}) => case_id)},
        async execute() {
          if (signal?.aborted) throw signal.reason ?? new Error("temporal candidate capture was aborted");
          const temporalOutputDir = path.join(outputDir, TEMPORAL_OUTPUT_NAME);
          const args = {
            contract: CONTRACT_PATH,
            outputDir: temporalOutputDir,
            browserRoot: input.capture.browser_root ? absolutePath(input.capture.browser_root, "browser root") : defaultBrowserRoot(),
            browserExecutable: input.identities.browser.path,
            fixtureIdentity: input.identities.fixture.path,
            failureControlIdentity: input.identities.failureControl.path,
            runtimeIdentity: input.identities.runtime.path,
            denial_storage_state: input.storageStates.denial,
            failure_storage_state: input.storageStates.failure,
            success_storage_state: input.storageStates.success,
            denial_actor_class: input.actors.denial,
            failure_actor_class: input.actors.failure,
            success_actor_class: input.actors.success,
            denial_missing_url: urls.denial.missing_page,
            denial_saved_url: urls.denial.saved_page,
            failure_missing_url: urls.failure.missing_page,
            failure_saved_url: urls.failure.saved_page,
            success_missing_url: urls.success.missing_page,
            success_saved_url: urls.success.saved_page,
            runId,
            executionMode: "candidate",
            requestIntervalMs: 0,
            timeoutMs: input.capture.timeout_ms ?? 30_000,
            ignoreHttpsErrors: input.capture.ignore_https_errors === true,
          };
          const code = await temporalRunner(args);
          result = JSON.parse((await fs.readFile(path.join(temporalOutputDir, "records.json"))).toString("utf8"));
          if (code !== 0) throw new Error(`temporal capture exited with status ${code}`);
          assertTemporalIdentity(result, contract, contractSha256, candidateIdentity, input, temporalOutputDir);
          if (!Array.isArray(result.evidence)) throw new Error("temporal result evidence must be an array");
          const rowKey = ({scenario, subject_id, interval}) => `${scenario}\u0000${subject_id}\u0000${interval}`;
          const recordsByKey = new Map();
          for (const record of result.evidence) {
            const key = rowKey(record);
            const matches = recordsByKey.get(key) ?? [];
            matches.push(record);
            recordsByKey.set(key, matches);
          }
          const definitionKeys = new Set(definitions.map((definition) => rowKey(definition)));
          for (const key of recordsByKey.keys()) {
            if (!definitionKeys.has(key)) throw new Error("temporal result contains an unregistered evidence row");
          }
          return definitions.map((definition) => {
            const matches = recordsByKey.get(rowKey(definition)) ?? [];
            if (matches.length === 0) throw new Error(`temporal result is missing ${definition.case_id}`);
            if (matches.length > 1) throw new Error(`temporal result duplicates ${definition.case_id}`);
            return {case_id: definition.case_id, observations: matches[0]};
          });
        },
        async cleanup() {
          return {public_absence_verified: result?.cleanup_observed?.browser_sessions_closed === 3 && result.cleanup_observed.egress_proxies_closed === true && result.cleanup_observed.request_gate_flushed === true && result.cleanup_observed.capture_lock_released === true && result.cleanup_observed.storage_states_removed === true};
        },
        verifyCase(caseIdValue, observations) {
          const definition = definitionById.get(caseIdValue);
          if (!definition || observations.scenario !== definition.scenario || observations.subject_id !== definition.subject_id || observations.interval !== definition.interval || observations.source_revision !== candidateIdentity.candidate.wikijump_commit || !/^[0-9a-f]{64}$/u.test(observations.dom_sha256 ?? "") || !/^[0-9a-f]{64}$/u.test(observations.screenshot_sha256 ?? "") || observations.capture_errors?.length !== 0) throw new Error(`${caseIdValue} temporal observation is not exact`);
          return {verified: true, source_revision: observations.source_revision, dom_sha256: observations.dom_sha256, screenshot_sha256: observations.screenshot_sha256};
        },
        verifyCleanup(proof) {
          if (proof?.public_absence_verified !== true) throw new Error("temporal capture did not prove owned-resource cleanup");
          return proof;
        },
      });
    },
  });
}
