import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {isCurrentRawResult, prepareCurrentReviewDeltas} from '../scripts/prepare-current-review-deltas.mjs';
import {TARGET_ACCEPTANCE_CONTRACT_SHA256} from '../src/target-acceptance-contract.mjs';
import {
  ADMITTED_TARGET_ACCEPTANCE_CONTRACT_SHA256S,
  TARGET_ACCEPTANCE_INSTRUMENT_CLOSURE_SHA256,
} from '../src/target-acceptance-instruments.mjs';

const STRANDED = '76690fa4b7a8f778f2a719e7d7bdbf4c4f4a5f231c640c6b15a0f347fd1d5c94';

const stamped = (sha256, status = 200) => ({
  target_acceptance_contract_sha256: sha256,
  target_runtime_identity: {response_status: status},
});

test('current raw results are exactly the admitted-instrument HTTP-200 ones', () => {
  assert.ok(ADMITTED_TARGET_ACCEPTANCE_CONTRACT_SHA256S.includes(TARGET_ACCEPTANCE_CONTRACT_SHA256));
  for (const sha256 of ADMITTED_TARGET_ACCEPTANCE_CONTRACT_SHA256S) {
    assert.equal(isCurrentRawResult(stamped(sha256)), true, sha256);
  }
  assert.equal(isCurrentRawResult(stamped(TARGET_ACCEPTANCE_CONTRACT_SHA256)), true);
  assert.equal(isCurrentRawResult(stamped(STRANDED)), false);
  assert.equal(isCurrentRawResult(stamped(TARGET_ACCEPTANCE_CONTRACT_SHA256, 404)), false);
  assert.equal(isCurrentRawResult({target_acceptance_contract_sha256: TARGET_ACCEPTANCE_CONTRACT_SHA256}), false);
});

test('the script carries no pinned contract digest literal', () => {
  const source = fs.readFileSync(new URL('../scripts/prepare-current-review-deltas.mjs', import.meta.url), 'utf8');
  assert.equal(source.includes(STRANDED), false);
  assert.equal(source.includes('isAdmittedTargetAcceptanceContract'), true);
});

function makeLab(t, packages) {
  const lab = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-lab-review-deltas-'));
  t.after(() => fs.rmSync(lab, {recursive: true, force: true}));
  fs.mkdirSync(path.join(lab, 'ports/current-acceptance'), {recursive: true});
  fs.writeFileSync(
    path.join(lab, 'ports/adaptation-authority.json'),
    JSON.stringify({packages: Object.fromEntries(Object.keys(packages).map(pkg => [pkg, {}]))}) + '\n',
  );
  for (const [pkg, files] of Object.entries(packages)) {
    const dir = path.join(lab, 'ports/current-acceptance', pkg);
    fs.mkdirSync(dir, {recursive: true});
    for (const file of files) {
      const filePath = path.join(dir, file.name);
      fs.writeFileSync(filePath, JSON.stringify(file.doc) + '\n');
      if (file.mtime) fs.utimesSync(filePath, file.mtime, file.mtime);
    }
  }
  return lab;
}

const rawDoc = (sha256, viewports, status = 200) => ({
  result: {
    ...stamped(sha256, status),
    candidate_css_sha256: 'css-sha',
    candidate_source_sha256: 'source-sha',
    candidate_preview_sha256: 'preview-sha',
    visual: {viewports},
  },
});

const viewportRow = (candidate, reference) => ({
  candidate_path: `candidate-${candidate}.png`,
  reference_path: `reference-${reference}.png`,
  candidate_screenshot_sha256: candidate,
  reference_screenshot_sha256: reference,
});

test('newest admitted HTTP-200 raw result wins over newer unadmitted or older admitted ones', t => {
  const lab = makeLab(t, {
    'pkg-a': [
      {name: 'raw-result-old.json', mtime: new Date('2026-10-01T00:00:00Z'), doc: rawDoc(TARGET_ACCEPTANCE_INSTRUMENT_CLOSURE_SHA256, {desktop: viewportRow('old-candidate', 'old-reference')})},
      {name: 'raw-result-new.json', mtime: new Date('2026-10-02T00:00:00Z'), doc: rawDoc(TARGET_ACCEPTANCE_CONTRACT_SHA256, {desktop: viewportRow('shot-a', 'shot-b'), mobile: viewportRow('shot-c', 'shot-d')})},
      {name: 'raw-result-newer.json', mtime: new Date('2026-10-03T00:00:00Z'), doc: rawDoc(STRANDED, {desktop: viewportRow('stale-candidate', 'stale-reference')})},
      {name: 'visual-review.json', doc: {viewports: {desktop: {candidate_screenshot_sha256: 'shot-a', reference_screenshot_sha256: 'shot-b', decision: 'prior-review'}}}},
    ],
  });
  const summary = prepareCurrentReviewDeltas(lab);
  assert.deepEqual(summary, {
    output: path.join('ports/current-acceptance', 'current-visual-review-deltas-20261007.json'),
    total: 2,
    reused: 1,
    review_required: 1,
  });
  const draft = JSON.parse(fs.readFileSync(path.join(lab, 'ports/current-acceptance/pkg-a/visual-review-current-draft.json'), 'utf8'));
  assert.equal(draft.candidate_css_sha256, 'css-sha');
  assert.equal(draft.candidate_base_css_sha256, null);
  assert.deepEqual(draft.viewports, {desktop: {candidate_screenshot_sha256: 'shot-a', reference_screenshot_sha256: 'shot-b', decision: 'prior-review'}});
  const worklist = JSON.parse(fs.readFileSync(path.join(lab, summary.output), 'utf8'));
  assert.equal(worklist.schema, 'theme_lab_current_visual_review_delta_worklist.v1');
  assert.equal(worklist.rows.length, 1);
  assert.equal(worklist.rows[0].package, 'pkg-a');
  assert.equal(worklist.rows[0].viewport, 'mobile');
  assert.equal(worklist.rows[0].raw_result, path.join('ports/current-acceptance', 'pkg-a', 'raw-result-new.json'));
});

test('a package whose only raw results carry the stranded digest has no current result', t => {
  const lab = makeLab(t, {
    'pkg-b': [
      {name: 'raw-result-only.json', doc: rawDoc(STRANDED, {desktop: viewportRow('a', 'b')})},
    ],
  });
  assert.throws(() => prepareCurrentReviewDeltas(lab), /pkg-b: no current HTTP-200 raw result/u);
});

test('a package whose only admitted raw result is not HTTP 200 has no current result', t => {
  const lab = makeLab(t, {
    'pkg-c': [
      {name: 'raw-result-only.json', doc: rawDoc(TARGET_ACCEPTANCE_CONTRACT_SHA256, {desktop: viewportRow('a', 'b')}, 500)},
    ],
  });
  assert.throws(() => prepareCurrentReviewDeltas(lab), /pkg-c: no current HTTP-200 raw result/u);
});
