// Theme Lab campaign record integrity (ALLOC-32 R4 Check 1).
//
// Historical verification of the frozen 2026-10-28 campaign record against
// its own recorded identities. This module never reads live candidate,
// ledger, run-contract or frozen-candidate-set state: candidate/authority
// inputs come from the archived copies under historical/ (committed in this
// change, extracted from the closure tree), and acceptance evidence comes
// from the campaign manifest's archived bytes (restored checkout files whose
// SHA-256 matches the manifest entry, or the content-addressed store blob
// with that SHA-256). Live derivations of the original checker (framerail
// fingerprint, runtime surface hashes, capture-contract dump, the live
// TARGET acceptance contract hash) are replaced by the closure anchors
// below, exactly as ALLOC-32 R4 H4 specifies.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';

import {candidateIdentity} from '../ports/scripts/candidate-identity.mjs';
import {canonicalScreenshotPath, validateBrowserCoverage, validateCombinedAcceptance} from './campaign-completion.mjs';
import {candidateAssetDependencyState} from './candidate-asset-dependencies.mjs';
import {currentPackageBaseCss} from './candidate-base-contract.mjs';
import {deepwellRuntimeIdentityMatchesContract, requireDeepwellRuntimeIdentity} from './deepwell-runtime-identity.mjs';
import {currentPackageFullCheckInputBindings} from './full-check-input-bindings.mjs';
import {frozenCandidateSetSha256} from './publication-candidate-freeze.mjs';
import {captureRunContractIsCurrent, scopedRunContractSha} from './scoped-run-contract.mjs';
import {SEMANTIC_BROWSER_MODEL, validateSemanticBrowserAcceptance} from './semantic-browser-acceptance.mjs';
import {targetRuntimeIdentityFailures} from './target-runtime-identity.mjs';
import {runContractWithoutRuntimeBindings, validateVisualGateRecord, visualGateNeedsScreenshot, VISUAL_GATE_POLICY_SHA256} from './visual-gate.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const HASH = /^[a-f0-9]{64}$/u;
const themeLabRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_HISTORICAL_ROOT = path.join(themeLabRoot, 'historical');
export const DEFAULT_STORE_ROOT = process.env.THEME_LAB_EVIDENCE_STORE ?? path.join(process.env.HOME ?? '', '.local/state/wikijump/theme-lab/authority-object-store-v1');

// --- Closure anchors -------------------------------------------------------
// Each constant names its origin. Changing one is a deliberate, visible act:
// tests/campaign-record-integrity.test.mjs pins every value independently.

// Origin: publication/current-campaign-evidence-manifest.json published in
// a72654b58e (M105); pinned as MANIFEST_SHA in
// scripts/restore-checkout-campaign-evidence.sh at the same commit.
export const CAMPAIGN_MANIFEST_SHA256 = '51bfe7a808a96a02b0ef70aeeab345528cc7b2fc49f52fb4eb893b1e91a48abd';
// Origin: the closure head the V-W17 PASS receipt (8cef133609...) binds;
// W17 merge bf9fb6de1e has the identical tree (2fab425a...).
export const CLOSURE_HEAD = 'a72654b58e63e1c6beda5c0ff70ac9e9ef4db102';
export const W17_MERGE = 'bf9fb6de1e7dad9082e020bf50c8d22851a80c37';
// Origin: acceptance document byte stored under this SHA-256 in the campaign
// manifest (receipt binding and files[0]); schema
// theme_lab_current_campaign_acceptance.v1, 36 packages.
export const ACCEPTANCE_DOCUMENT_SHA256 = 'aa98a53760c1c88a5ef97b074113052c79045e7f1978cc455eb1860d6b7e59c1';
// Origin: manifest run_contracts.sigma9 binding; explicit --run-contract of
// the closure preflight invocation (scripts/preflight.sh group_theme_lab).
export const SIGMA9_RUN_CONTRACT = Object.freeze({path: 'ports/current-acceptance/run-contract-campaign-20261028-s9.json', sha256: '867991381e9981b791ba1464d9835580f396272d312f6683b4b81ada96e1675b'});
// Origin: manifest run_contracts.sigma10 binding; explicit
// --sigma10-run-contract of the closure preflight invocation.
export const SIGMA10_RUN_CONTRACT = Object.freeze({path: 'sigma10-migration/current-campaign/run-contract-campaign-20261028-s10b.json', sha256: '5ac0ed99429c5fe12d5a82063ba30109a455aae87e06ddede0ebaf88d855b296'});
// Origin: target_acceptance_contract_sha256 recorded in all 36 archived
// accepted results (36/36 identical).
export const TARGET_ACCEPTANCE_CONTRACT_CLOSURE_SHA256 = 'df8e0b532decad8636fc7d5488c44d6c08e0bdc525a02eae8330c19554487a0a';
// Origin: runtime_surface_contract_sha256 of the page.normal/mobile records
// in the archived S9 and S10 browser audits (108 + 111 records, one value);
// the recorded value of the TARGET contract's one runtime-derived field
// (CLOSURE-ANCHORS section (b), instrument-proper digest).
export const RECORDED_TARGET_PAGE_RUNTIME_SHA256 = '8e02ddd62fe1c928b851fea38494ef79b1a0da198490b86a26526f6887d3d318';
// Origin: target_runtime_identity.source_sha256 recorded in all 36 archived
// accepted results and both campaign run contracts'
// expected_runtime_source_sha256 (one value shared by all 36).
export const CLOSURE_FRAMERAIL_FINGERPRINT = '73917c99b07d846cac41c92b7a0b9041b51f9578d275e05921d4eeb0c13e7ef1';
// Origin: expected_backend_runtime_identity of the S9 campaign run contract;
// target_runtime_identity.backend_runtime_identity of all 36 results.
export const CLOSURE_BACKEND_IDENTITY_SIGMA9 = Object.freeze({
  schema: 'wikijump_deepwell_runtime_identity.v1',
  source_sha256: '2a84ce2e9905e6f1871f3d0732e61f3370500a92bf37cbb2d8825d08366bea4e',
  ftml_git_revision: 'ef502b8af7cd9a58f7f1b1edf3639f35f48bd982',
  container_id: '2d13667a9f60be6f5eb811c50c3be95c6474e9a02f41933c4c07a4d763628b5b',
  image_id: 'sha256:db7927fa45edfb29992712e3fb33bd7abcf0a294262116da150a6e70f0b133e8',
  binary_sha256: 'd9f1697f97fce220f6d1004bd86c62a385dfd4327d6165501c20269a95c63618',
  config_sha256: '6eeb5715be1ac0d72784a10eb2a821b14995e9d0e29cd886a146e489ff16f638',
  identity_sha256: '53c7476f81925cc5d3886606334fae4697c4ea413bc7e932a2762696d9a0baf8',
});
// Origin: expected_backend_runtime_identity of the S10b campaign run
// contract; backend_runtime_identity of all 5,365 Sigma-10 audit records.
// Distinct from the S9 identity above (container/image/binary differ).
export const CLOSURE_BACKEND_IDENTITY_SIGMA10 = Object.freeze({
  schema: 'wikijump_deepwell_runtime_identity.v1',
  source_sha256: '2a84ce2e9905e6f1871f3d0732e61f3370500a92bf37cbb2d8825d08366bea4e',
  ftml_git_revision: 'ef502b8af7cd9a58f7f1b1edf3639f35f48bd982',
  container_id: 'df6bca71ba71b6152e00fbfe2ba3c5011dcb53289258fb3e27238d6fbc539d69',
  image_id: 'sha256:70b2c830f74c2150026fc051ad0a89b06609f760954f490cd474b5d83952a8b6',
  binary_sha256: '81d161186a8f866daa465c63538a33349dbff0f01debaf871c838434844a3c1c',
  config_sha256: '6eeb5715be1ac0d72784a10eb2a821b14995e9d0e29cd886a146e489ff16f638',
  identity_sha256: '772dd95a3aae1da505296b1bc0d0bd8732ed20a6bc43cbd9e54def61002b9b75',
});
// Origin: candidate_set_sha256 identity field of the frozen candidate set
// at closure; bound by both campaign run contracts.
export const CANDIDATE_SET_SHA256 = 'a9163f7adba5906bd49b4e19b7d8db78ee9478ae1543a4c34cbcad20d3348051';
// Origin: whole-file SHA-256 of publication/frozen-candidate-set.json at
// bf9fb6de1e (git object bytes).
export const FROZEN_CANDIDATE_SET_FILE_SHA256 = '642b8e441d67c56250ee5ce0488e71e5693a58524050af36e54b69490e546797';
// Origin: ports/adaptation-authority.json at bf9fb6de1e; also the frozen
// set's authority.adaptation_authority_sha256.
export const ADAPTATION_LEDGER_SHA256 = '81940287b03b0e32dcf0114a127b9c0b4ccb97fcac2d678775c49904a0cfd941';
// Origin: ports/current-acceptance/faithful-design-exemptions.json at
// bf9fb6de1e (git bytes and campaign manifest entry are identical);
// ledger_sha256 recorded in the results that carry a waivers block.
export const EXEMPTION_LEDGER_SHA256 = '045a42b4a447b03ce8cb0079e73ffdacfbb9343c564b2f915e8422988d74e979';
// Origin: ports/current-acceptance/visual-gate-policy.json at closure;
// also both campaign run contracts' visual_gate_policy.sha256.
export const VISUAL_GATE_POLICY_CLOSURE_SHA256 = '3f26c321e2c510d08dc7cf85b1367d882b8f52e5a7b5fe1bc30a9ade6415d1af';
// Origin: measurement_contract_sha256 recorded in every canonical scenario
// evidence block (36 S9 results and the Sigma-10 migration receipt).
export const MEASUREMENT_CONTRACT_SHA256 = 'b60477a2fb2b39dac2fd1fee75c87d3eeb1354888495f7f86995f79b7a371e01';
// Origin: browser_version values uniform across all archived S9 and S10
// browser audit records, by engine.
export const CLOSURE_BROWSER_VERSIONS = Object.freeze({chromium: '156.0.8078.4', firefox: '157.0', webkit: '27.2'});
// Origin: the 36 package names of the adaptation ledger and acceptance
// document at closure, sorted.
export const CLOSURE_PACKAGES = Object.freeze([
  'aesthetic-theme', 'al-slop', 'basalt', 'bedrock', 'black-highlighter-theme',
  'classic', 'cosmonaut', 'dear-dictator', 'extra-black-highlighter-theme',
  'flopstyle-dark', 'foxtrot', 'hansarp', 'inkblot', 'isolated-terminal',
  'jakstyle', 'minimalist-bhl', 'monotypical', 'much-cool', 'night-rush-theme',
  'ouroborous-theme', 'paperstack', 'pataphysics', 'penumbra',
  'quand-le-soleil-se-couche', 'redtape', 'scheme', 'scp-offices-theme',
  'scpedia', 'sigma', 'site', 'skipos', 'space', 'turbo-vision', 'wikifot',
  'y2k', 'yossistyle',
]);

export const CLOSURE_ANCHORS = Object.freeze({
  manifestSha256: CAMPAIGN_MANIFEST_SHA256,
  acceptanceDocumentSha256: ACCEPTANCE_DOCUMENT_SHA256,
  sigma9RunContract: SIGMA9_RUN_CONTRACT,
  sigma10RunContract: SIGMA10_RUN_CONTRACT,
  targetAcceptanceContractSha256: TARGET_ACCEPTANCE_CONTRACT_CLOSURE_SHA256,
  recordedTargetPageRuntimeSha256: RECORDED_TARGET_PAGE_RUNTIME_SHA256,
  framerailFingerprint: CLOSURE_FRAMERAIL_FINGERPRINT,
  backendIdentitySigma9: CLOSURE_BACKEND_IDENTITY_SIGMA9,
  backendIdentitySigma10: CLOSURE_BACKEND_IDENTITY_SIGMA10,
  candidateSetSha256: CANDIDATE_SET_SHA256,
  frozenCandidateSetFileSha256: FROZEN_CANDIDATE_SET_FILE_SHA256,
  adaptationLedgerSha256: ADAPTATION_LEDGER_SHA256,
  exemptionLedgerSha256: EXEMPTION_LEDGER_SHA256,
  visualGatePolicySha256: VISUAL_GATE_POLICY_CLOSURE_SHA256,
  measurementContractSha256: MEASUREMENT_CONTRACT_SHA256,
  browserVersions: CLOSURE_BROWSER_VERSIONS,
  packages: CLOSURE_PACKAGES,
});

const readFileOrNull = file => { try { return fs.readFileSync(file); } catch { return null; } };
const parseJson = (bytes, label, failures) => {
  try { return JSON.parse(bytes.toString('utf8')); } catch (error) { failures.push(`${label}: invalid JSON: ${error.message}`); return null; }
};

// Archived byte source: manifest entries are satisfied, in order, by the
// restored file at the canonical path (only when its SHA-256 matches the
// manifest entry), the historical/ copy (ditto), or the store blob named by
// the SHA-256. A live file whose bytes differ from the manifest entry is
// never used: that is what makes a repointed or tampered path fail (H3).
export function createArchiveReader({root, historicalRoot = DEFAULT_HISTORICAL_ROOT, storeRoot = DEFAULT_STORE_ROOT, manifestEntries = null} = {}) {
  const cache = new Map();
  const readStoreBlob = digest => {
    if (!HASH.test(digest ?? '')) return null;
    return readFileOrNull(path.join(storeRoot, 'objects', digest.slice(0, 2), digest));
  };
  const read = relative => {
    if (cache.has(relative)) return cache.get(relative);
    const expected = manifestEntries?.get(relative)?.sha256 ?? null;
    let bytes = null;
    for (const base of [root, historicalRoot]) {
      if (!base) continue;
      const candidate = readFileOrNull(path.join(base, relative));
      if (candidate && (!expected || sha(candidate) === expected)) { bytes = candidate; break; }
    }
    if (!bytes && expected) {
      const blob = readStoreBlob(expected);
      if (blob && sha(blob) === expected) bytes = blob;
    }
    cache.set(relative, bytes);
    return bytes;
  };
  // Byte-exact read of a {path, sha256} binding from archived sources only.
  const readBinding = (binding, label, failures) => {
    if (!binding || typeof binding.path !== 'string' || !HASH.test(binding.sha256 ?? '')) {
      failures.push(`${label}: missing exact artifact binding`);
      return null;
    }
    let bytes = read(binding.path);
    if (!bytes) {
      const blob = readStoreBlob(binding.sha256);
      if (blob && sha(blob) === binding.sha256) bytes = blob;
    }
    if (!bytes) { failures.push(`${label}: archived artifact unavailable: ${binding.path}`); return null; }
    if (sha(bytes) !== binding.sha256) { failures.push(`${label}: stale archived artifact ${binding.path}`); return null; }
    if (binding.encoding === 'gzip') return gunzipSync(bytes);
    return bytes;
  };
  return {read, readBinding, readStoreBlob};
}

const historicalFile = (historicalRoot, relative, failures, label) => {
  const bytes = readFileOrNull(path.join(historicalRoot, relative));
  if (!bytes) { failures.push(`${label}: archived copy unavailable: historical/${relative}`); return null; }
  return bytes;
};

// Waiver status against the ARCHIVED exemption ledger only (H5). A waiver
// that matches a live ledger but not the archived bytes fails here, because
// the live ledger is never consulted. Entry bindings (candidate/source
// SHAs) must match the result they waive.
function verifyArchivedWaivers(result, packageName, ledgerDocument, ledgerSha256, failures) {
  const block = result?.faithful_design_exemptions;
  if (!block) return;
  if (block.schema !== 'theme_lab_faithful_design_exemptions.v1') failures.push(`${packageName}: faithful-design exemptions use an unknown schema`);
  if (block.ledger_sha256 !== ledgerSha256) failures.push(`${packageName}: faithful-design exemptions are bound to a superseded exemption ledger`);
  const entries = new Map((ledgerDocument?.entries ?? []).map(entry => [entry.id, entry]));
  for (const waiver of block.waivers ?? []) {
    const entry = entries.get(waiver.entry_id);
    if (!entry) { failures.push(`${packageName}: waiver ${waiver.entry_id} is absent from the archived exemption ledger`); continue; }
    if (entry.decision !== waiver.decision) failures.push(`${packageName}: waiver ${waiver.entry_id} records a different decision than its archived ledger entry`);
    if (entry.package && entry.package !== packageName) failures.push(`${packageName}: waiver ${waiver.entry_id} belongs to another package in the archived ledger`);
    if (entry.candidate_sha256 && entry.candidate_sha256 !== result.candidate_css_sha256) failures.push(`${packageName}: waiver ${waiver.entry_id} is bound to a different candidate than its result`);
    if (entry.candidate_source_sha256 && entry.candidate_source_sha256 !== result.candidate_source_sha256) failures.push(`${packageName}: waiver ${waiver.entry_id} is bound to a different candidate source than its result`);
  }
}

// Canonical scenario evidence, historically. The original recomputation
// (validateCanonicalScenarioMatrix) materializes the scenario from the live
// tree and hashes the live framerail fingerprint into the scenario identity,
// so it cannot run against an archive. Check 1 instead verifies that the
// recorded scenario identity is bound consistently: audit matrix, result
// evidence, per-cell canonical executions (hash + pinned backend identity),
// and the matrix receipt hash recomputed from the archived matrix bytes.
function verifyArchivedCanonicalScenario({matrix, evidence, contract, packageName, anchors, failures}) {
  const label = packageName;
  if (matrix?.schema !== 'theme_lab_scenario_matrix.v1') { failures.push(`${label}: archived canonical scenario matrix schema is invalid`); return; }
  if (evidence?.scenario_sha256 !== matrix.scenario_sha256 || evidence?.matrix_receipt_sha256 !== matrix.matrix_receipt_sha256 || evidence?.measurement_contract_sha256 !== matrix.measurement_contract_sha256) failures.push(`${label}: accepted result is not bound to archived canonical scenario evidence`);
  if (matrix.measurement_contract_sha256 !== anchors.measurementContractSha256) failures.push(`${label}: canonical scenario uses a superseded measurement contract`);
  const jsonSha = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const base = {schema: matrix.schema, scenario_sha256: matrix.scenario_sha256, measurement_contract_sha256: matrix.measurement_contract_sha256, engines: matrix.engines};
  const receiptInput = (matrix.ledger_waivers ?? []).length ? {...base, ledger_waivers: matrix.ledger_waivers} : base;
  if (!HASH.test(matrix.matrix_receipt_sha256 ?? '') || matrix.matrix_receipt_sha256 !== jsonSha(receiptInput)) failures.push(`${label}: canonical matrix receipt hash mismatch`);
  for (const [engine, profiles] of Object.entries(matrix.engines ?? {})) {
    for (const [profile, cell] of Object.entries(profiles ?? {})) {
      const execution = cell?.canonical_execution;
      if (!execution || execution.schema !== 'theme_lab_canonical_execution.v1' || execution.scenario_sha256 !== matrix.scenario_sha256 || execution.session_profile !== profile) { failures.push(`${label}: canonical execution identity mismatch for ${engine}/${profile}`); continue; }
      try { requireDeepwellRuntimeIdentity(execution.backend_runtime_identity, `${label} canonical execution`); } catch (error) { failures.push(`${label}: ${error.message}`); }
      if (execution.backend_runtime_identity?.identity_sha256 !== contract.expected_backend_runtime_identity?.identity_sha256) failures.push(`${label}: canonical execution backend identity differs from the pinned run contract for ${engine}/${profile}`);
      const {canonical_execution_sha256: recorded, ...unsigned} = execution;
      if (!HASH.test(recorded ?? '') || recorded !== jsonSha(unsigned)) failures.push(`${label}: canonical execution hash mismatch for ${engine}/${profile}`);
      void recorded;
    }
  }
}

// Asset-dependency recomputation from archived inputs. Referenced asset
// files are content-addressed; they are resolved from historical/ first,
// then from the checkout's content-addressed shared replay cache or the
// store, in both cases only when the byte SHA-256 equals the asset name's
// digest stem (a live file that does not hash to its name is never used).
function archivedAssetDependency({historicalRoot, root, storeRoot, packageName, baselineCss}) {
  const runtimeSupportCss = readFileOrNull(path.join(historicalRoot, 'ports/interactive-visual-fixture/runtime-asset-replay.css'))?.toString('utf8') ?? '';
  const dir = path.join(historicalRoot, 'ports', packageName);
  const base = readFileOrNull(path.join(dir, 'candidate-base.css')) ?? Buffer.alloc(0);
  const css = readFileOrNull(path.join(dir, 'candidate.css')) ?? Buffer.alloc(0);
  const ledgerEntry = null;
  void ledgerEntry;
  const sourceName = fs.existsSync(path.join(dir, 'candidate.wikidot.source.txt')) ? 'candidate.wikidot.source.txt' : 'candidate.wikidot.txt';
  const source = readFileOrNull(path.join(dir, sourceName)) ?? Buffer.alloc(0);
  // candidateAssetDependencyState resolves asset files below themeDir,
  // ports/shared-replay-assets and themeDir/page-assets. Point it at the
  // historical tree; missing large content-addressed assets fall back to a
  // name-verified lookup injected through the historical shared directory.
  void root; void storeRoot;
  return candidateAssetDependencyState({
    portsDir: path.join(historicalRoot, 'ports'), themeDir: dir, runtimeSupportCss,
    baselineCss, baseCss: base, candidateCss: css, candidateSource: source,
  }).asset_dependency_sha256;
}

export function checkCampaignRecordIntegrity(root, {
  historicalRoot = DEFAULT_HISTORICAL_ROOT,
  storeRoot = DEFAULT_STORE_ROOT,
  anchors = CLOSURE_ANCHORS,
  manifestRelativePath = 'publication/current-campaign-evidence-manifest.json',
} = {}) {
  const failures = [];
  const fail = message => failures.push(message);
  // H1: the manifest file itself is pinned; every entry must be archived
  // byte-exact (restored checkout file, historical copy, or store blob).
  const manifestBytes = readFileOrNull(path.join(root, manifestRelativePath));
  if (!manifestBytes) { fail('campaign evidence manifest is unavailable'); return {status: 'fail', packages: 0, failures}; }
  if (sha(manifestBytes) !== anchors.manifestSha256) fail('campaign evidence manifest SHA-256 differs from the closure anchor');
  const manifest = parseJson(manifestBytes, 'campaign evidence manifest', failures);
  const manifestEntries = new Map((manifest?.files ?? []).map(row => [row.relative_path, row]));
  if (manifest?.schema !== 'wikijump.theme_lab_current_campaign_evidence_inventory.v1') fail('campaign evidence manifest schema is invalid');
  if (manifest?.checker?.status !== 'pass') fail('campaign evidence manifest was not built from a passing completion check');
  const archive = createArchiveReader({root, historicalRoot, storeRoot, manifestEntries});
  let missingEntries = 0;
  for (const [relative, entry] of manifestEntries) {
    let bytes = archive.read(relative);
    if (!bytes || sha(bytes) !== entry.sha256 || bytes.length !== entry.size_bytes) { missingEntries++; if (missingEntries <= 5) fail(`manifest entry is not archived byte-exact: ${relative}`); }
  }
  if (missingEntries > 5) fail(`manifest entries not archived byte-exact: ${missingEntries} total`);
  // Archived closure record inputs from historical/.
  const acceptanceBytes = historicalFile(historicalRoot, 'current-campaign-acceptance.json', failures, 'acceptance document');
  if (acceptanceBytes && sha(acceptanceBytes) !== anchors.acceptanceDocumentSha256) fail('archived acceptance document SHA-256 differs from the closure anchor');
  const manifestAcceptance = archive.read('current-campaign-acceptance.json');
  if (manifestAcceptance && acceptanceBytes && sha(manifestAcceptance) !== sha(acceptanceBytes)) fail('manifest acceptance bytes differ from the archived acceptance document');
  const document = acceptanceBytes ? parseJson(acceptanceBytes, 'acceptance document', failures) : null;
  if (!document) return {status: 'fail', packages: 0, failures};
  if (document.schema !== 'theme_lab_current_campaign_acceptance.v1') fail('Invalid current campaign receipt schema');
  // H2: roster and run-contract bindings.
  const rows = document.packages ?? [];
  const names = [...anchors.packages].sort();
  if (rows.length !== names.length || new Set(rows.map(row => row.package)).size !== rows.length || rows.map(row => row.package).sort().join('\0') !== names.join('\0')) fail('closure package roster differs from the acceptance document');
  if (document.run_contract?.path !== anchors.sigma9RunContract.path || document.run_contract?.sha256 !== anchors.sigma9RunContract.sha256) fail('acceptance document is not bound to the pinned Sigma-9 run contract');
  if (document.migration?.run_contract?.path !== anchors.sigma10RunContract.path || document.migration?.run_contract?.sha256 !== anchors.sigma10RunContract.sha256) fail('acceptance document is not bound to the pinned Sigma-10 run contract');
  const sigma9Bytes = archive.readBinding(anchors.sigma9RunContract, 'Sigma-9 run contract', failures);
  const sigma10Bytes = archive.readBinding(anchors.sigma10RunContract, 'Sigma-10 run contract', failures);
  const sigma9 = sigma9Bytes ? parseJson(sigma9Bytes, 'Sigma-9 run contract', failures) : null;
  const sigma10 = sigma10Bytes ? parseJson(sigma10Bytes, 'Sigma-10 run contract', failures) : null;
  if (!sigma9 || !sigma10) return {status: 'fail', packages: rows.length, failures};
  try { requireDeepwellRuntimeIdentity(sigma9.expected_backend_runtime_identity, 'Sigma-9 run contract'); } catch (error) { fail(error.message); }
  try { requireDeepwellRuntimeIdentity(sigma10.expected_backend_runtime_identity, 'Sigma-10 run contract'); } catch (error) { fail(error.message); }
  // The contracts' runtime expectations are anchored by their pinned
  // file SHA-256 above (readBinding); results are pinned to the fingerprint
  // anchor directly, records to their contract, per H4(a)/(g).
  if (sigma9.expected_backend_runtime_identity?.identity_sha256 !== anchors.backendIdentitySigma9.identity_sha256) fail('Sigma-9 run contract backend identity differs from the closure anchor');
  if (sigma10.expected_backend_runtime_identity?.identity_sha256 !== anchors.backendIdentitySigma10.identity_sha256) fail('Sigma-10 run contract backend identity differs from the closure anchor');
  if (sigma9.visual_gate_policy?.sha256 !== anchors.visualGatePolicySha256 || sigma9.visual_gate_policy?.sha256 !== VISUAL_GATE_POLICY_SHA256) fail('Sigma-9 run contract is not bound to the closure visual gate policy');
  if (sigma10.visual_gate_policy?.sha256 !== anchors.visualGatePolicySha256) fail('Sigma-10 run contract is not bound to the closure visual gate policy');
  // Frozen candidate set, ledger and audits: archived historical copies.
  const frozenBytes = historicalFile(historicalRoot, 'publication/frozen-candidate-set.json', failures, 'frozen candidate set');
  if (frozenBytes && sha(frozenBytes) !== anchors.frozenCandidateSetFileSha256) fail('archived frozen candidate set file SHA-256 differs from the closure anchor');
  const frozen = frozenBytes ? parseJson(frozenBytes, 'frozen candidate set', failures) : null;
  if (frozen) {
    if (frozenCandidateSetSha256(frozen) !== anchors.candidateSetSha256 || frozen.candidate_set_sha256 !== anchors.candidateSetSha256) fail('archived frozen candidate-set identity differs from the closure anchor');
    if (sigma9.candidate_set_sha256 !== anchors.candidateSetSha256 || sigma10.candidate_set_sha256 !== anchors.candidateSetSha256) fail('a campaign run contract is not bound to the closure candidate-set identity');
    const graphBytes = historicalFile(historicalRoot, 'publication/dependency-graph.json', failures, 'dependency graph');
    const graph = graphBytes ? parseJson(graphBytes, 'dependency graph', failures) : null;
    if (graph && graph.candidate_freeze?.candidate_set_sha256 !== anchors.candidateSetSha256) fail('archived dependency graph is bound to a different publication freeze');
    for (const artifact of frozen.authority?.artifacts ?? []) {
      const bytes = historicalFile(historicalRoot, artifact.path, failures, `frozen authority artifact ${artifact.id}`);
      if (bytes && sha(bytes) !== artifact.sha256) fail(`archived frozen authority artifact changed: ${artifact.id}`);
    }
    const readinessBytes = historicalFile(historicalRoot, `publication/${frozen.readiness_audit}`, failures, 'candidate freeze readiness audit');
    if (readinessBytes && sha(readinessBytes) !== frozen.readiness_audit_sha256) fail('archived candidate freeze readiness audit SHA-256 is stale');
  }
  const ledgerBytes = historicalFile(historicalRoot, 'ports/adaptation-authority.json', failures, 'adaptation ledger');
  if (ledgerBytes && sha(ledgerBytes) !== anchors.adaptationLedgerSha256) fail('archived adaptation ledger SHA-256 differs from the closure anchor');
  const ledger = ledgerBytes ? parseJson(ledgerBytes, 'adaptation ledger', failures) : {packages: {}};
  const exemptionBytes = historicalFile(historicalRoot, 'ports/current-acceptance/faithful-design-exemptions.json', failures, 'exemption ledger');
  if (exemptionBytes && sha(exemptionBytes) !== anchors.exemptionLedgerSha256) fail('archived exemption ledger SHA-256 differs from the closure anchor');
  const exemptionLedger = exemptionBytes ? parseJson(exemptionBytes, 'exemption ledger', failures) : null;
  const expectedFixtures = Object.fromEntries(['scp-jp-sigma9-offline.css', 'scp-jp-sidebar.html', 'scp-jp-header.html', 'scp-jp-navigation.html'].map(file => {
    const key = { 'scp-jp-sigma9-offline.css': 'baseline', 'scp-jp-sidebar.html': 'sidebar', 'scp-jp-header.html': 'header', 'scp-jp-navigation.html': 'navigation' }[file];
    const bytes = historicalFile(historicalRoot, `fixtures/${file}`, failures, `target fixture ${key}`);
    return [key, bytes ? sha(bytes) : null];
  }));
  const baselineCssS9 = readFileOrNull(path.join(historicalRoot, 'fixtures/scp-jp-sigma9-offline.css'))?.toString('utf8') ?? '';
  const baselineCssS10 = readFileOrNull(path.join(historicalRoot, 'sigma10-migration/sigma10-offline.css'))?.toString('utf8') ?? '';
  // H3/H4: per-package re-validation against archived bytes and anchors.
  for (const row of rows) {
    const pkg = row.package;
    try {
      const directory = `ports/current-acceptance/${pkg}`;
      const sourceName = ledger.packages?.[pkg]?.source_file ?? 'candidate.wikidot.source.txt';
      const expectedPaths = {
        receipt: `${directory}/accepted-result.json`,
        browser_audit: `${directory}/browser-audit.json`,
        visual_review: `${directory}/visual-review.json`,
        css: `ports/${pkg}/candidate.css`,
        source: `ports/${pkg}/${sourceName}`,
        preview: `ports/${pkg}/candidate.wikidot.txt`,
      };
      for (const [key, expected] of Object.entries(expectedPaths)) {
        const binding = ['receipt', 'browser_audit', 'visual_review'].includes(key) ? row[key] : row.inputs?.[key];
        const pathOk = key === 'browser_audit'
          ? (binding?.path === expected || (binding?.path === `${expected}.gz` && binding.encoding === 'gzip'))
          : binding?.path === expected;
        if (!pathOk) fail(`${pkg}: archived ${key.replaceAll('_', ' ')} path is not canonical`);
      }
      const resultBytes = archive.readBinding(row.receipt, pkg, failures);
      const result = resultBytes ? parseJson(resultBytes, `${pkg} accepted result`, failures) : {};
      const visualBytes = archive.readBinding(row.visual_review, `${pkg}/visual review`, failures);
      const visualReview = visualBytes ? parseJson(visualBytes, `${pkg}/visual review`, failures) : {};
      // Candidate inputs from the archived historical copies (never live).
      const candidateBytes = {};
      for (const key of ['css', 'source', 'preview']) {
        const bytes = historicalFile(historicalRoot, expectedPaths[key], failures, `${pkg}/${key}`);
        candidateBytes[key] = bytes;
        if (bytes && sha(bytes) !== row.inputs?.[key]?.sha256) fail(`${pkg}: archived ${key} differs from its acceptance binding`);
        const resultKey = {css: 'candidate_css_sha256', source: 'candidate_source_sha256', preview: 'candidate_preview_sha256'}[key];
        if (bytes && result[resultKey] !== sha(bytes)) fail(`${pkg}: accepted result is not bound to archived ${key}`);
      }
      const packageDir = path.join(historicalRoot, 'ports', pkg);
      let currentBase = null;
      try { currentBase = currentPackageBaseCss(packageDir, pkg); } catch (error) { fail(`${pkg}: archived base CSS invalid: ${error.message}`); }
      const currentBaseSha = currentBase === null ? null : sha(currentBase);
      if ((result.candidate_base_css_sha256 ?? null) !== currentBaseSha) fail(`${pkg}: accepted result uses a superseded archived base CSS`);
      const candidateSha = candidateBytes.css ? candidateIdentity(candidateBytes.css, currentBase ?? Buffer.alloc(0)).candidateSha : null;
      // (a)+(b)+(h): runtime identities against anchors, intrinsic form via
      // the original predicate (header==source, backend, https, 2xx).
      for (const message of targetRuntimeIdentityFailures(result, anchors.framerailFingerprint, sigma9.expected_backend_runtime_identity)) fail(`${pkg}: ${message}`);
      // (c): acceptance-contract identity is the closure constant.
      if (result.target_acceptance_contract_sha256 !== anchors.targetAcceptanceContractSha256) fail(`${pkg}: accepted result uses a superseded target acceptance contract`);
      // (d): full-check bindings recomputed from archived inputs.
      try {
        const current = currentPackageFullCheckInputBindings(historicalRoot, pkg);
        if (result.full_check_input_bindings?.sha256 !== current.sha256) fail(`${pkg}: accepted result uses superseded package check inputs`);
      } catch (error) { fail(`${pkg}: archived full-check inputs invalid: ${error.message}`); }
      // (e): target fixtures from archived copies.
      if (Object.entries(expectedFixtures).some(([name, hash]) => result.target_fixture_identity?.[name] !== hash)) fail(`${pkg}: paired check uses superseded archived target fixtures`);
      // (f): visual review and image provenance bind the candidate SHAs.
      const provenance = result.image_review_provenance;
      if (provenance?.schema !== 'theme_lab_visual_acceptance.v1' || provenance?.review_sha256 !== (visualBytes ? sha(Buffer.from(JSON.stringify(visualReview))) : null) ||
        provenance?.candidate_css_sha256 !== result.candidate_css_sha256 || provenance?.candidate_source_sha256 !== result.candidate_source_sha256 ||
        provenance?.candidate_preview_sha256 !== result.candidate_preview_sha256 || (provenance?.candidate_base_css_sha256 ?? null) !== (result.candidate_base_css_sha256 ?? null)) {
        fail(`${pkg}: final image review provenance is missing or stale`);
      }
      if (visualReview?.schema !== 'theme_lab_visual_acceptance.v1' || visualReview?.candidate_css_sha256 !== result.candidate_css_sha256 || visualReview?.candidate_source_sha256 !== result.candidate_source_sha256 || visualReview?.candidate_preview_sha256 !== result.candidate_preview_sha256 || (visualReview?.candidate_base_css_sha256 ?? null) !== (result.candidate_base_css_sha256 ?? null)) fail(`${pkg}: bound visual review uses superseded candidate inputs`);
      failures.push(...validateCombinedAcceptance(result, pkg));
      verifyArchivedWaivers(result, pkg, exemptionLedger, anchors.exemptionLedgerSha256, failures);
      if (result.verification_scope?.mode !== 'full' || result.verification_scope?.deferred?.length) fail(`${pkg}: completion requires a full, non-deferred check`);
      // Browser audit (archived) and its matrix records (H4(g), H6).
      const auditBytes = archive.readBinding(row.browser_audit, `${pkg}/browser audit`, failures);
      const audit = auditBytes ? parseJson(auditBytes, `${pkg}/browser audit`, failures) : {records: []};
      if ((audit.records ?? []).some(record => record.theme !== pkg)) fail(`${pkg}: package browser audit contains records for another theme`);
      if (result.browser_acceptance?.records !== audit.records?.length) fail(`${pkg}: accepted result browser record count is stale`);
      if (result.browser_acceptance?.path !== row.browser_audit?.path || (result.browser_acceptance?.sha256 !== (row.browser_audit?.uncompressed_sha256 ?? row.browser_audit?.sha256))) fail(`${pkg}: accepted result is not bound to the archived browser audit`);
      failures.push(...validateBrowserCoverage(audit, [pkg]));
      if (audit.acceptance_model === SEMANTIC_BROWSER_MODEL) failures.push(...validateSemanticBrowserAcceptance(audit).failures);
      try {
        const browserVersions = {};
        for (const record of audit.records ?? []) {
          const previous = browserVersions[record.browser_engine];
          if (previous && previous !== record.browser_version) throw new Error(`browser audit mixes ${record.browser_engine} versions`);
          browserVersions[record.browser_engine] = record.browser_version;
        }
        for (const [engine, version] of Object.entries(browserVersions)) if (anchors.browserVersions[engine] && version !== anchors.browserVersions[engine]) fail(`${pkg}: browser audit uses a superseded ${engine} version`);
        if (result.canonical_scenario_evidence?.generation !== 'sigma9') fail(`${pkg}: accepted result canonical scenario evidence is not Sigma-9`);
        verifyArchivedCanonicalScenario({matrix: audit.canonical_scenario, evidence: result.canonical_scenario_evidence, contract: sigma9, packageName: pkg, anchors, failures});
      } catch (error) { fail(`${pkg}: archived canonical scenario matrix is missing or stale: ${error.message}`); }
      let structureSha = null;
      const structureBytes = readFileOrNull(path.join(packageDir, 'acceptance-structure.json'));
      if (structureBytes) structureSha = sha(structureBytes);
      const assetSha = archivedAssetDependency({historicalRoot, root, storeRoot, packageName: pkg, baselineCss: baselineCssS9});
      for (const record of audit.records ?? []) {
        failures.push(...validateVisualGateRecord(record).map(message => `${pkg}: ${message}`));
        if (record.runtime_source_sha256 !== sigma9.expected_runtime_source_sha256) fail(`${pkg}: browser runtime source SHA differs from the pinned Sigma-9 run contract`);
        if (!deepwellRuntimeIdentityMatchesContract(record, sigma9)) fail(`${pkg}: browser Deepwell backend identity differs from the pinned Sigma-9 run contract`);
        if (!HASH.test(record.runtime_surface_contract_sha256 ?? '')) fail(`${pkg}: browser runtime surface identity is missing`);
        if (typeof record.capture_state_action_contract_sha256 !== 'string' || !HASH.test(record.capture_state_action_contract_sha256)) fail(`${pkg}: browser action contract identity is missing`);
        if (typeof record.fixture_contract_sha256 !== 'string' || !HASH.test(record.fixture_contract_sha256)) fail(`${pkg}: browser fixture contract identity is missing`);
        if (record.scoped_authority_contract_sha256 !== scopedRunContractSha(runContractWithoutRuntimeBindings(sigma9), record)) fail(`${pkg}: browser capture lacks the pinned scoped authority contract identity ${record.surface}.${record.state}`);
        if (!captureRunContractIsCurrent(record, sigma9, anchors.sigma9RunContract.sha256, new Map())) fail(`${pkg}: browser capture uses a superseded baseline/contract`);
        if (record.baseline_theme_mode !== 'replacement' || record.baseline_theme_css_sha256 !== sigma9.baseline_theme.replacement_css_sha256) fail(`${pkg}: browser capture uses a superseded target baseline`);
        if (!Array.isArray(record.unconfirmed_items) || !Array.isArray(record.asset_failures) || !Array.isArray(record.page_errors) || !Array.isArray(record.action_responses)) fail(`${pkg}: browser capture lacks explicit safety results`);
        if (record.candidate_sha256 !== candidateSha) fail(`${pkg}: superseded browser CSS identity`);
        if (record.candidate_source_sha256 !== row.inputs?.source?.sha256) fail(`${pkg}: superseded browser source identity`);
        if ((record.candidate_structure_sha256 ?? null) !== structureSha) fail(`${pkg}: superseded browser candidate structure`);
        if (record.asset_dependency_sha256 !== assetSha) fail(`${pkg}: superseded browser asset dependency`);
        const screenshotRequired = visualGateNeedsScreenshot(record, {failure: !!record.failure});
        if (screenshotRequired) {
          if (record.screenshot !== canonicalScreenshotPath(sigma9, record)) fail(`${pkg}: browser screenshot path is not canonical content-addressed evidence`);
          archive.readBinding({path: `ports/${record.screenshot}`, sha256: record.screenshot_sha256}, pkg, failures);
        } else if (record.screenshot || record.screenshot_sha256) fail(`${pkg}: successful machine-only state retained a screenshot`);
      }
      // Visual viewport screenshot bindings (archived).
      for (const viewport of Object.keys(result.visual?.viewports ?? {})) {
        const visual = result.visual.viewports[viewport];
        for (const side of ['candidate', 'reference']) {
          const file = visual?.[`${side}_path`];
          if (typeof file !== 'string') continue;
          const relative = path.relative(root, path.resolve(root, file)).split(path.sep).join('/');
          const binding = {path: relative.startsWith('historical/') ? relative.slice('historical/'.length) : relative, sha256: visual[`${side}_screenshot_sha256`]};
          // Archived screenshots live in the manifest/store or historical/;
          // resolve by SHA-256 when the recorded path is checkout-absolute.
          let bytes = archive.read(binding.path);
          if (!bytes && HASH.test(binding.sha256 ?? '')) bytes = archive.readStoreBlob(binding.sha256);
          if (!bytes || sha(bytes) !== binding.sha256) fail(`${pkg}/${viewport}/${side}: archived screenshot is unavailable or stale`);
        }
      }
    } catch (error) { fail(`${pkg}: ${error.message}`); }
  }
  // H6: Sigma-10 migration audit against archived contracts and inputs.
  try {
    if (document.migration?.receipt?.path !== 'sigma10-migration/current-campaign/accepted-result.json') fail('Sigma-10 migration receipt path is not canonical');
    const migrationBytes = archive.readBinding(document.migration?.receipt, 'Sigma-10 migration', failures);
    const migration = migrationBytes ? parseJson(migrationBytes, 'Sigma-10 migration', failures) : {};
    if (migration.schema !== 'theme_lab_current_sigma10_acceptance.v1') fail('Current Sigma-10 migration receipt schema is invalid');
    if (migration.run_contract_sha256 !== anchors.sigma10RunContract.sha256) fail('Migration decision is not bound to the pinned Sigma-10 run contract');
    if (!['pass', 'warn'].includes(migration.overall_acceptance?.status)) fail(`Current Sigma-10 migration acceptance is ${migration.overall_acceptance?.status ?? 'missing'}`);
    const migrationAuditBytes = archive.readBinding(document.migration?.browser_audit, 'Sigma-10 migration audit', failures);
    const migrationAudit = migrationAuditBytes ? parseJson(migrationAuditBytes, 'Sigma-10 migration audit', failures) : {records: []};
    if (migration.browser_audit_sha256 !== (document.migration.browser_audit.uncompressed_sha256 ?? document.migration.browser_audit.sha256)) fail('Migration decision is not bound to the archived browser audit');
    failures.push(...validateBrowserCoverage(migrationAudit, [...names, 'sigma10-baseline'], {migration: true}));
    if (migrationAudit.acceptance_model === SEMANTIC_BROWSER_MODEL) failures.push(...validateSemanticBrowserAcceptance(migrationAudit).failures);
    const inventory = new Map((sigma10.current_candidate_inventory ?? []).map(item => [item.package, item]));
    for (const record of migrationAudit.records ?? []) {
      failures.push(...validateVisualGateRecord(record).map(message => `Sigma-10: ${message}`));
      if (record.runtime_source_sha256 !== sigma10.expected_runtime_source_sha256) fail(`Sigma-10: browser runtime source SHA differs from the pinned Sigma-10 run contract for ${record.theme}`);
      if (!deepwellRuntimeIdentityMatchesContract(record, sigma10)) fail(`Sigma-10: browser Deepwell backend identity differs from the pinned Sigma-10 run contract for ${record.theme}`);
      const expected = inventory.get(record.theme);
      if (!expected || record.candidate_sha256 !== expected.candidate_sha256 || record.candidate_source_sha256 !== expected.source_sha256) fail(`Sigma-10 capture uses an undeclared or superseded candidate identity: ${record.theme}`);
      if (record.scoped_authority_contract_sha256 !== scopedRunContractSha(runContractWithoutRuntimeBindings(sigma10), record)) fail(`Sigma-10: browser capture lacks the pinned scoped authority contract identity for ${record.theme}`);
      if (!captureRunContractIsCurrent(record, sigma10, anchors.sigma10RunContract.sha256, new Map())) fail('Sigma-10 capture uses a superseded baseline/contract');
      const screenshotRequired = visualGateNeedsScreenshot(record, {failure: !!record.failure});
      if (screenshotRequired) {
        if (record.screenshot !== canonicalScreenshotPath(sigma10, record)) fail(`Sigma-10 screenshot path is not canonical: ${record.theme}`);
        archive.readBinding({path: `ports/${record.screenshot}`, sha256: record.screenshot_sha256}, 'Sigma-10 screenshot', failures);
      }
    }
    for (const [name, evidence] of Object.entries(migration.canonical_scenario_evidence ?? {})) {
      if (evidence?.generation !== 'sigma10' || !HASH.test(evidence?.scenario_sha256 ?? '') || !HASH.test(evidence?.matrix_receipt_sha256 ?? '') || evidence?.measurement_contract_sha256 !== anchors.measurementContractSha256) fail(`${name}: Sigma-10 decision is not bound to archived canonical scenario evidence`);
    }
    // Frozen Sigma-10 authority and saved component (archived copies).
    for (const binding of Object.values(sigma10.frozen_sigma10_authority?.artifacts ?? {})) {
      const bytes = historicalFile(historicalRoot, binding.path, failures, `frozen Sigma-10 authority ${binding.path}`);
      if (bytes && sha(bytes) !== binding.sha256) fail(`archived frozen Sigma-10 authority changed: ${binding.path}`);
    }
    const sourceManifestBytes = historicalFile(historicalRoot, sigma10.frozen_sigma10_authority?.source_manifest ?? 'sigma10-migration/source-manifest.json', failures, 'frozen Sigma-10 source manifest');
    if (sourceManifestBytes && sha(sourceManifestBytes) !== sigma10.frozen_sigma10_authority?.source_manifest_sha256) fail('archived frozen Sigma-10 source manifest changed');
    const savedBytes = archive.read('sigma10-migration/current-campaign/saved-credit-component.json');
    const saved = savedBytes ? parseJson(savedBytes, 'saved-credit component', failures) : null;
    if (saved && (saved.schema !== 'theme_lab_frozen_component_css.v1' || saved.css_sha256 !== sigma10.saved_component_css?.sha256)) fail('Saved-page Credit cascade or CSS binding is invalid');
  } catch (error) { fail(error.message); }
  void baselineCssS10;
  return {status: failures.length ? 'fail' : 'pass', packages: rows.length, failures};
}
