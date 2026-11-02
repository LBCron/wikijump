import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  ACCEPTANCE_DOCUMENT_SHA256, ADAPTATION_LEDGER_SHA256, CAMPAIGN_MANIFEST_SHA256,
  CANDIDATE_SET_SHA256, CLOSURE_BACKEND_IDENTITY_SIGMA10, CLOSURE_BACKEND_IDENTITY_SIGMA9,
  CLOSURE_BROWSER_VERSIONS, CLOSURE_FRAMERAIL_FINGERPRINT, CLOSURE_HEAD, CLOSURE_PACKAGES,
  EXEMPTION_LEDGER_SHA256, FROZEN_CANDIDATE_SET_FILE_SHA256, MEASUREMENT_CONTRACT_SHA256,
  RECORDED_TARGET_PAGE_RUNTIME_SHA256, SIGMA9_RUN_CONTRACT, SIGMA10_RUN_CONTRACT,
  TARGET_ACCEPTANCE_CONTRACT_CLOSURE_SHA256, VISUAL_GATE_POLICY_CLOSURE_SHA256, W17_MERGE,
  checkCampaignRecordIntegrity,
} from '../src/campaign-record-integrity.mjs';
import {TARGET_ACCEPTANCE_CONTRACT_SHA256} from '../src/target-acceptance-contract.mjs';
import {
  ADMITTED_TARGET_ACCEPTANCE_CONTRACT_SHA256S, TARGET_ACCEPTANCE_INSTRUMENT_CLOSURE_SHA256,
  TARGET_ACCEPTANCE_INSTRUMENT_SUCCESSORS,
} from '../src/target-acceptance-instruments.mjs';
import {currentTargetRuntimeSourceSha} from '../src/target-runtime-identity.mjs';
import {VISUAL_GATE_POLICY_SHA256} from '../src/visual-gate.mjs';
import {mockBrowserVersions, mockCampaign} from './support/current-campaign-fixture.mjs';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// R4: a test pins every anchor constant independently, so changing one is a
// visible two-file diff.
test('closure anchors are pinned to their recorded values', () => {
  assert.equal(CAMPAIGN_MANIFEST_SHA256, '51bfe7a808a96a02b0ef70aeeab345528cc7b2fc49f52fb4eb893b1e91a48abd');
  assert.equal(CLOSURE_HEAD, 'a72654b58e63e1c6beda5c0ff70ac9e9ef4db102');
  assert.equal(W17_MERGE, 'bf9fb6de1e7dad9082e020bf50c8d22851a80c37');
  assert.equal(ACCEPTANCE_DOCUMENT_SHA256, 'aa98a53760c1c88a5ef97b074113052c79045e7f1978cc455eb1860d6b7e59c1');
  assert.deepEqual(SIGMA9_RUN_CONTRACT, {path: 'ports/current-acceptance/run-contract-campaign-20261028-s9.json', sha256: '867991381e9981b791ba1464d9835580f396272d312f6683b4b81ada96e1675b'});
  assert.deepEqual(SIGMA10_RUN_CONTRACT, {path: 'sigma10-migration/current-campaign/run-contract-campaign-20261028-s10b.json', sha256: '5ac0ed99429c5fe12d5a82063ba30109a455aae87e06ddede0ebaf88d855b296'});
  assert.equal(TARGET_ACCEPTANCE_CONTRACT_CLOSURE_SHA256, 'df8e0b532decad8636fc7d5488c44d6c08e0bdc525a02eae8330c19554487a0a');
  assert.equal(RECORDED_TARGET_PAGE_RUNTIME_SHA256, '8e02ddd62fe1c928b851fea38494ef79b1a0da198490b86a26526f6887d3d318');
  assert.equal(CLOSURE_FRAMERAIL_FINGERPRINT, '73917c99b07d846cac41c92b7a0b9041b51f9578d275e05921d4eeb0c13e7ef1');
  assert.equal(CLOSURE_BACKEND_IDENTITY_SIGMA9.identity_sha256, '53c7476f81925cc5d3886606334fae4697c4ea413bc7e932a2762696d9a0baf8');
  assert.equal(CLOSURE_BACKEND_IDENTITY_SIGMA9.source_sha256, '2a84ce2e9905e6f1871f3d0732e61f3370500a92bf37cbb2d8825d08366bea4e');
  assert.equal(CLOSURE_BACKEND_IDENTITY_SIGMA9.ftml_git_revision, 'ef502b8af7cd9a58f7f1b1edf3639f35f48bd982');
  assert.equal(CLOSURE_BACKEND_IDENTITY_SIGMA10.identity_sha256, '772dd95a3aae1da505296b1bc0d0bd8732ed20a6bc43cbd9e54def61002b9b75');
  assert.equal(CANDIDATE_SET_SHA256, 'a9163f7adba5906bd49b4e19b7d8db78ee9478ae1543a4c34cbcad20d3348051');
  assert.equal(FROZEN_CANDIDATE_SET_FILE_SHA256, '642b8e441d67c56250ee5ce0488e71e5693a58524050af36e54b69490e546797');
  assert.equal(ADAPTATION_LEDGER_SHA256, '81940287b03b0e32dcf0114a127b9c0b4ccb97fcac2d678775c49904a0cfd941');
  assert.equal(EXEMPTION_LEDGER_SHA256, '045a42b4a447b03ce8cb0079e73ffdacfbb9343c564b2f915e8422988d74e979');
  assert.equal(VISUAL_GATE_POLICY_CLOSURE_SHA256, '3f26c321e2c510d08dc7cf85b1367d882b8f52e5a7b5fe1bc30a9ade6415d1af');
  assert.equal(MEASUREMENT_CONTRACT_SHA256, 'b60477a2fb2b39dac2fd1fee75c87d3eeb1354888495f7f86995f79b7a371e01');
  assert.deepEqual(CLOSURE_BROWSER_VERSIONS, {chromium: '156.0.8078.4', firefox: '157.0', webkit: '27.2'});
  assert.equal(CLOSURE_PACKAGES.length, 36);
  assert.equal(new Set(CLOSURE_PACKAGES).size, 36);
  assert.ok(CLOSURE_PACKAGES.includes('classic'));
});

// Successor admission (2026-11-02): the admitted-instrument registry is
// pinned the same way as the closure anchors, and its closure entry must
// name the closure anchor itself, so the two records cannot drift apart.
test('admitted target-acceptance instruments are pinned to their recorded values', () => {
  assert.equal(TARGET_ACCEPTANCE_INSTRUMENT_CLOSURE_SHA256, 'df8e0b532decad8636fc7d5488c44d6c08e0bdc525a02eae8330c19554487a0a');
  assert.equal(TARGET_ACCEPTANCE_INSTRUMENT_CLOSURE_SHA256, TARGET_ACCEPTANCE_CONTRACT_CLOSURE_SHA256);
  assert.deepEqual(TARGET_ACCEPTANCE_INSTRUMENT_SUCCESSORS.map(entry => entry.sha256), [
    '1811b3b4bdb78d1d6a52584cd0f7c2bbaee39480498a9a017eb40498a4835131',
    '34e17dbac84038b1e9960a42ad7931b255baf3bd2e5ca219f6a2f62d79c8e2d4',
    'dc7fd55cf685154e60c2c8d482e594170be26563cd8ada16e468b3d08a9c74bb',
  ]);
  assert.deepEqual([...ADMITTED_TARGET_ACCEPTANCE_CONTRACT_SHA256S], [
    'df8e0b532decad8636fc7d5488c44d6c08e0bdc525a02eae8330c19554487a0a',
    '1811b3b4bdb78d1d6a52584cd0f7c2bbaee39480498a9a017eb40498a4835131',
    '34e17dbac84038b1e9960a42ad7931b255baf3bd2e5ca219f6a2f62d79c8e2d4',
    'dc7fd55cf685154e60c2c8d482e594170be26563cd8ada16e468b3d08a9c74bb',
  ]);
});

// Build a Check 1 fixture from the original checker's mock campaign: the
// mock root is both the restored checkout (root) and, copied, the archived
// historical tree. Anchors are re-derived from the fabricated files, the
// same way production anchors were derived from the real record.
function buildFixture() {
  const mock = mockCampaign();
  const {root, workspace} = mock;
  const exemption = {schema: 'theme_lab_faithful_design_exemptions.v1', entries: []};
  fs.mkdirSync(path.join(root, 'ports/current-acceptance'), {recursive: true});
  fs.writeFileSync(path.join(root, 'ports/current-acceptance/faithful-design-exemptions.json'), JSON.stringify(exemption));
  // Bind the acceptance document to the (fabricated) run contracts, as the
  // closure document binds the campaign contracts.
  const documentFile = path.join(root, 'current-campaign-acceptance.json');
  const document = readJson(documentFile);
  const contractBinding = relative => ({path: relative, sha256: digest(fs.readFileSync(path.join(root, relative)))});
  document.run_contract = contractBinding('ports/current-acceptance/run-contract.json');
  document.migration.run_contract = contractBinding('sigma10-migration/current-campaign/run-contract.json');
  fs.writeFileSync(documentFile, JSON.stringify(document));
  const historical = path.join(workspace, 'historical-copy');
  fs.cpSync(root, historical, {recursive: true});
  const store = path.join(workspace, 'empty-store');
  fs.mkdirSync(store, {recursive: true});
  const fixture = {mock, root, workspace, historical, store, anchors: null};
  finalizeFixture(fixture);
  return fixture;
}

// Recompute file-level bindings, the fabricated manifest and the anchor
// overrides from the current fixture files. Internal (predicate-level)
// mutations survive this; only path/SHA bindings are refreshed.
function finalizeFixture(fixture) {
  const {root, historical} = fixture;
  // Evidence files mutated on the live side are the archived bytes too:
  // sync them into the historical copy before rebinding.
  const currentDocument = readJson(path.join(root, 'current-campaign-acceptance.json'));
  for (const row of currentDocument.packages ?? []) {
    for (const key of ['receipt', 'browser_audit', 'visual_review']) {
      const source = path.join(root, row[key].path);
      const target = path.join(historical, row[key].path);
      fs.mkdirSync(path.dirname(target), {recursive: true});
      fs.cpSync(source, target);
    }
  }
  for (const base of [root, historical]) {
    const documentFile = path.join(base, 'current-campaign-acceptance.json');
    const document = readJson(documentFile);
    for (const row of document.packages ?? []) {
      for (const key of ['receipt', 'browser_audit', 'visual_review']) {
        const binding = row[key];
        binding.sha256 = digest(fs.readFileSync(path.join(base, binding.path)));
      }
    }
    fs.writeFileSync(documentFile, JSON.stringify(document));
  }
  const document = readJson(path.join(root, 'current-campaign-acceptance.json'));
  const entryPaths = new Set(['current-campaign-acceptance.json', document.run_contract.path, document.migration.run_contract.path]);
  for (const row of document.packages) for (const key of ['receipt', 'browser_audit', 'visual_review']) entryPaths.add(row[key].path);
  const files = [...entryPaths].sort().map(relative => {
    const bytes = fs.readFileSync(path.join(root, relative));
    return {relative_path: relative, sha256: digest(bytes), size_bytes: bytes.length};
  });
  const manifest = {schema: 'wikijump.theme_lab_current_campaign_evidence_inventory.v1', checker: {command: 'campaign-completion-probe', status: 'pass', failure_count: 0}, files};
  fs.writeFileSync(path.join(root, 'publication/current-campaign-evidence-manifest.json'), JSON.stringify(manifest));
  const frozenFile = path.join(historical, 'publication/frozen-candidate-set.json');
  const frozen = readJson(frozenFile);
  fixture.anchors = {
    manifestSha256: digest(fs.readFileSync(path.join(root, 'publication/current-campaign-evidence-manifest.json'))),
    acceptanceDocumentSha256: digest(fs.readFileSync(path.join(historical, 'current-campaign-acceptance.json'))),
    sigma9RunContract: document.run_contract,
    sigma10RunContract: document.migration.run_contract,
    targetAcceptanceContractSha256: TARGET_ACCEPTANCE_CONTRACT_SHA256,
    recordedTargetPageRuntimeSha256: RECORDED_TARGET_PAGE_RUNTIME_SHA256,
    framerailFingerprint: currentTargetRuntimeSourceSha(root),
    backendIdentitySigma9: readJson(path.join(root, document.run_contract.path)).expected_backend_runtime_identity,
    backendIdentitySigma10: readJson(path.join(root, document.migration.run_contract.path)).expected_backend_runtime_identity,
    candidateSetSha256: frozen.candidate_set_sha256,
    frozenCandidateSetFileSha256: digest(fs.readFileSync(frozenFile)),
    adaptationLedgerSha256: digest(fs.readFileSync(path.join(historical, 'ports/adaptation-authority.json'))),
    exemptionLedgerSha256: digest(fs.readFileSync(path.join(historical, 'ports/current-acceptance/faithful-design-exemptions.json'))),
    visualGatePolicySha256: VISUAL_GATE_POLICY_SHA256,
    measurementContractSha256: fixture.mock.audit.canonical_scenario.measurement_contract_sha256,
    browserVersions: mockBrowserVersions,
    packages: ['testtheme'],
  };
  return fixture;
}

const runIntegrity = fixture => checkCampaignRecordIntegrity(fixture.root, {
  historicalRoot: fixture.historical, storeRoot: fixture.store, anchors: fixture.anchors,
});

test('Check 1 accepts a fabricated closure record (fixture PASS)', () => {
  const fixture = buildFixture();
  try {
    const result = runIntegrity(fixture);
    assert.equal(result.status, 'pass', result.failures.join('\n'));
  } finally { fs.rmSync(fixture.workspace, {recursive: true, force: true}); }
});

test('H7 (i): a one-byte change in an archived artifact fails Check 1', () => {
  const fixture = buildFixture();
  try {
    fs.appendFileSync(path.join(fixture.historical, 'ports/testtheme/candidate.css'), ' ');
    assert.equal(runIntegrity(fixture).status, 'fail');
  } finally { fs.rmSync(fixture.workspace, {recursive: true, force: true}); }
});

test('H7 (ii): one result whose runtime SHA differs from the record fails Check 1', () => {
  const fixture = buildFixture();
  try {
    const receiptFile = path.join(fixture.root, 'ports/current-acceptance/testtheme/accepted-result.json');
    const result = readJson(receiptFile);
    result.target_runtime_identity.source_sha256 = 'a'.repeat(64);
    result.target_runtime_identity.header_source_sha256 = 'a'.repeat(64);
    fs.writeFileSync(receiptFile, JSON.stringify(result));
    fs.cpSync(receiptFile, path.join(fixture.historical, 'ports/current-acceptance/testtheme/accepted-result.json'));
    finalizeFixture(fixture);
    const checked = runIntegrity(fixture);
    assert.equal(checked.status, 'fail');
    assert.ok(checked.failures.some(failure => failure.includes('superseded built target runtime')), checked.failures.join('\n'));
  } finally { fs.rmSync(fixture.workspace, {recursive: true, force: true}); }
});

test('H7 (iii): a matrix record whose candidate SHA differs from its result fails Check 1', () => {
  const fixture = buildFixture();
  try {
    const auditFile = path.join(fixture.root, 'ports/current-acceptance/testtheme/browser-audit.json');
    const audit = readJson(auditFile);
    audit.records[0].candidate_sha256 = 'b'.repeat(64);
    fs.writeFileSync(auditFile, JSON.stringify(audit));
    const receiptFile = path.join(fixture.root, 'ports/current-acceptance/testtheme/accepted-result.json');
    const result = readJson(receiptFile);
    result.browser_acceptance.sha256 = digest(fs.readFileSync(auditFile));
    fs.writeFileSync(receiptFile, JSON.stringify(result));
    finalizeFixture(fixture);
    const checked = runIntegrity(fixture);
    assert.equal(checked.status, 'fail');
    assert.ok(checked.failures.some(failure => failure.includes('superseded browser CSS identity')), checked.failures.join('\n'));
  } finally { fs.rmSync(fixture.workspace, {recursive: true, force: true}); }
});

test('H7 (iv): a dropped package fails Check 1', () => {
  const fixture = buildFixture();
  try {
    for (const base of [fixture.root, fixture.historical]) {
      const file = path.join(base, 'current-campaign-acceptance.json');
      const document = readJson(file);
      document.packages = [];
      fs.writeFileSync(file, JSON.stringify(document));
    }
    finalizeFixture(fixture);
    // finalize re-derives anchors from files; the roster anchor stays the
    // fabricated closure roster of one package.
    fixture.anchors.packages = ['testtheme'];
    assert.equal(runIntegrity(fixture).status, 'fail');
  } finally { fs.rmSync(fixture.workspace, {recursive: true, force: true}); }
});

test('H7 (v): a waiver matching only the live ledger fails Check 1', () => {
  const fixture = buildFixture();
  try {
    // The live (root) ledger gains the entry; the archived ledger does not.
    const liveLedgerFile = path.join(fixture.root, 'ports/current-acceptance/faithful-design-exemptions.json');
    const liveLedger = readJson(liveLedgerFile);
    liveLedger.entries.push({id: 'live-only-entry', package: 'testtheme', decision: 'OD-T1'});
    fs.writeFileSync(liveLedgerFile, JSON.stringify(liveLedger));
    const receiptFile = path.join(fixture.root, 'ports/current-acceptance/testtheme/accepted-result.json');
    const result = readJson(receiptFile);
    result.faithful_design_exemptions = {
      schema: 'theme_lab_faithful_design_exemptions.v1',
      ledger_sha256: fixture.anchors.exemptionLedgerSha256,
      waivers: [{entry_id: 'live-only-entry', decision: 'OD-T1', kind: 'viewport_overflow', viewport: 'mobile'}],
    };
    fs.writeFileSync(receiptFile, JSON.stringify(result));
    finalizeFixture(fixture);
    const checked = runIntegrity(fixture);
    assert.equal(checked.status, 'fail');
    assert.ok(checked.failures.some(failure => failure.includes('absent from the archived exemption ledger')), checked.failures.join('\n'));
  } finally { fs.rmSync(fixture.workspace, {recursive: true, force: true}); }
});

test('H7 (vi): an anchor changed without matching bytes fails Check 1', () => {
  const fixture = buildFixture();
  try {
    const checked = checkCampaignRecordIntegrity(fixture.root, {
      historicalRoot: fixture.historical, storeRoot: fixture.store,
      anchors: {...fixture.anchors, targetAcceptanceContractSha256: '0'.repeat(64)},
    });
    assert.equal(checked.status, 'fail');
  } finally { fs.rmSync(fixture.workspace, {recursive: true, force: true}); }
});

test('H7 (vii): a receipt binding repointed to a live path fails Check 1', () => {
  const fixture = buildFixture();
  try {
    for (const base of [fixture.root, fixture.historical]) {
      const file = path.join(base, 'current-campaign-acceptance.json');
      const document = readJson(file);
      document.packages[0].receipt = {path: 'ports/testtheme/candidate.css', sha256: document.packages[0].receipt.sha256};
      fs.writeFileSync(file, JSON.stringify(document));
    }
    const checked = runIntegrity(fixture);
    assert.equal(checked.status, 'fail');
    assert.ok(checked.failures.some(failure => failure.includes('not canonical')), checked.failures.join('\n'));
  } finally { fs.rmSync(fixture.workspace, {recursive: true, force: true}); }
});

test('H7 (#3385 case): Check 1 passes after live framerail and candidate files move', () => {
  const fixture = buildFixture();
  try {
    // Live tree moves; the archived record does not.
    fs.appendFileSync(path.join(fixture.root, 'ports/testtheme/candidate.css'), ' /* live change */');
    const runtimeFile = path.join(fixture.workspace, 'framerail/src/app.html');
    if (fs.existsSync(runtimeFile)) fs.appendFileSync(runtimeFile, '<!-- live framerail change -->');
    const checked = runIntegrity(fixture);
    assert.equal(checked.status, 'pass', checked.failures.join('\n'));
  } finally { fs.rmSync(fixture.workspace, {recursive: true, force: true}); }
});

// Real-record equivalence is the wt-equiv fixture run (M117B): set
// THEME_LAB_CLOSURE_FIXTURE_ROOT to a restored closure checkout's Theme Lab
// root to exercise it; skipped in the ordinary suite.
test('H7 equivalence fixture (real closure record)', {skip: !process.env.THEME_LAB_CLOSURE_FIXTURE_ROOT}, () => {
  const result = checkCampaignRecordIntegrity(process.env.THEME_LAB_CLOSURE_FIXTURE_ROOT);
  assert.equal(result.status, 'pass', result.failures.slice(0, 10).join('\n'));
});
