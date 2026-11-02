import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {buildRuntimeDriftReport} from '../src/runtime-drift-report.mjs';

const RECORDED_FINGERPRINT = 'a'.repeat(64);
const RECORDED_PAGE_RUNTIME = 'b'.repeat(64);

function buildFixture() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-lab-drift-'));
  const root = path.join(workspace, 'theme-lab');
  const historical = path.join(workspace, 'historical');
  const write = (base, relative, content) => {
    const file = path.join(base, relative);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, JSON.stringify(content));
  };
  write(historical, 'current-campaign-acceptance.json', {
    packages: [{package: 'classic', receipt: {path: 'ports/current-acceptance/classic/accepted-result.json', sha256: 'c'.repeat(64)}}],
  });
  write(historical, 'ports/current-acceptance/run-contract-campaign-20261028-s9.json', {
    expected_runtime_source_sha256: RECORDED_FINGERPRINT,
    expected_backend_runtime_identity: {identity_sha256: 'd'.repeat(64)},
  });
  write(historical, 'publication/frozen-candidate-set.json', {
    candidate_set_sha256: 'e'.repeat(64),
    authority: {bhl_option_authority_sha256: 'f'.repeat(64)},
  });
  write(root, 'ports/adaptation-authority.json', {packages: {}});
  write(root, 'publication/frozen-candidate-set.json', {candidate_set_sha256: 'e'.repeat(64)});
  write(root, 'ports/black-highlighter-theme/option-scenarios/authority.json', {
    backend_runtime_identity: {identity_sha256: 'd'.repeat(64)},
  });
  return {workspace, root, historical};
}

test('drift report lists recorded and live runtime identities with the mandated summary', () => {
  const fixture = buildFixture();
  try {
    const report = buildRuntimeDriftReport(fixture.root, {
      historicalRoot: fixture.historical,
      anchors: {recordedTargetPageRuntimeSha256: RECORDED_PAGE_RUNTIME},
      liveFramerailFingerprint: '9'.repeat(64),
      liveTargetPageRuntimeSha256: RECORDED_PAGE_RUNTIME,
    });
    assert.equal(report.superseded_runtime_packages, 36);
    assert.equal(report.summary, '36 packages accepted under a superseded runtime; re-acceptance is next-campaign work.');
    const classic = report.packages.find(row => row.package === 'classic');
    assert.equal(classic.runtime.recorded_framerail_fingerprint, RECORDED_FINGERPRINT);
    assert.equal(classic.runtime.live_framerail_fingerprint, '9'.repeat(64));
    assert.equal(classic.runtime.superseded, true);
    assert.equal(report.packages.length, 36);
  } finally { fs.rmSync(fixture.workspace, {recursive: true, force: true}); }
});

test('drift report is empty of drift claims when the live runtime matches the record', () => {
  const fixture = buildFixture();
  try {
    const report = buildRuntimeDriftReport(fixture.root, {
      historicalRoot: fixture.historical,
      anchors: {recordedTargetPageRuntimeSha256: RECORDED_PAGE_RUNTIME},
      liveFramerailFingerprint: RECORDED_FINGERPRINT,
      liveTargetPageRuntimeSha256: RECORDED_PAGE_RUNTIME,
    });
    assert.equal(report.superseded_runtime_packages, 0);
    assert.equal(report.summary, '0 packages accepted under a superseded runtime; re-acceptance is next-campaign work.');
  } finally { fs.rmSync(fixture.workspace, {recursive: true, force: true}); }
});
