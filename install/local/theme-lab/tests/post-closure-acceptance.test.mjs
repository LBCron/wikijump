import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {candidateIdentity} from '../ports/scripts/candidate-identity.mjs';
import {candidateAssetDependencyState} from '../src/candidate-asset-dependencies.mjs';
import {CLOSURE_ANCHORS} from '../src/campaign-record-integrity.mjs';
import {checkPostClosureAcceptance, computeInstrumentProperDigest, POST_CLOSURE_PATH, POST_CLOSURE_SCHEMA, V2_KEYS} from '../src/post-closure-acceptance.mjs';
import {TARGET_ACCEPTANCE_CONTRACT} from '../src/target-acceptance-contract.mjs';
import {ADMITTED_TARGET_ACCEPTANCE_CONTRACT_SHA256S} from '../src/target-acceptance-instruments.mjs';

const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const write = (root, relative, content) => {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
};
const readJson = (root, relative) => JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
const git = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8'});
const commit = (repo, message) => {
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '--allow-empty', '-m', message);
  return git(repo, 'rev-parse', 'HEAD').trim();
};
const CLOSURE_RECEIPT_SHA = '1'.repeat(64);

// Live and historical trees for the given packages, an empty v2 record, and
// the anchor roster overridden to match; production defaults otherwise.
function buildFixture({packages = ['testtheme']} = {}) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-lab-post-closure-'));
  const repo = path.join(workspace, 'repo');
  const root = path.join(repo, 'install/local/theme-lab');
  const historical = path.join(workspace, 'historical');
  for (const base of [root, historical]) {
    write(base, 'ports/adaptation-authority.json', {packages: Object.fromEntries(packages.map(name => [name, {}]))});
    for (const name of packages) {
      write(base, `ports/${name}/candidate.css`, 'body { color: black; }');
      write(base, `ports/${name}/candidate.wikidot.source.txt`, 'Theme source');
      write(base, `ports/${name}/candidate.wikidot.txt`, 'JP preview');
      write(base, `ports/${name}/manifest.json`, {reference_url: `https://scp-wiki.wikidot.com/theme:${name}`});
    }
    write(base, 'ports/interactive-visual-fixture/runtime-asset-replay.css', '');
    write(base, 'fixtures/scp-jp-sigma9-offline.css', 'baseline');
  }
  write(historical, 'current-campaign-acceptance.json', {
    schema: 'theme_lab_current_campaign_acceptance.v1',
    packages: packages.map(name => ({package: name, receipt: {path: `ports/current-acceptance/${name}/accepted-result.json`, sha256: CLOSURE_RECEIPT_SHA}})),
  });
  write(root, POST_CLOSURE_PATH, {schema: POST_CLOSURE_SCHEMA, entries: []});
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'user.name', 'test');
  const anchors = {...CLOSURE_ANCHORS, packages, browserVersions: {chromium: '1.0'}};
  const options = {historicalRoot: historical, anchors, liveBrowserVersions: {chromium: '1.0'}};
  const check = (overrides = {}) => checkPostClosureAcceptance(root, {...options, ...overrides});
  return {workspace, repo, root, check};
}

function withFixture(options, body) {
  const fixture = buildFixture(options);
  try { body(fixture); } finally { fs.rmSync(fixture.workspace, {recursive: true, force: true}); }
}

const candidateOf = (root, name) => {
  const dir = path.join(root, 'ports', name);
  const css = fs.readFileSync(path.join(dir, 'candidate.css'));
  const source = fs.readFileSync(path.join(dir, 'candidate.wikidot.source.txt'));
  const preview = fs.readFileSync(path.join(dir, 'candidate.wikidot.txt'));
  const asset = candidateAssetDependencyState({
    portsDir: path.join(root, 'ports'), themeDir: dir, runtimeSupportCss: '',
    baselineCss: 'baseline', baseCss: Buffer.alloc(0), candidateCss: css, candidateSource: source,
  }).asset_dependency_sha256;
  return {
    css_sha256: digest(css), source_sha256: digest(source), preview_sha256: digest(preview),
    base_css_sha256: null, structure_sha256: null, asset_dependency_sha256: asset,
    candidate_sha256: candidateIdentity(css, Buffer.alloc(0)).candidateSha,
  };
};

const changeCandidate = (root, name = 'testtheme', css = 'body { color: red; }') => write(root, `ports/${name}/candidate.css`, css);

// Append a v2 successor entry for the live candidate of `name`, with its
// capture set and visual review written and (unless track is false) staged.
function addSuccessor({repo, root}, {name = 'testtheme', candidateOverride = null, track = true} = {}) {
  const record = readJson(root, POST_CLOSURE_PATH);
  const previous = record.entries.filter(entry => entry.package === name).at(-1);
  const successorId = `${name}-successor-${record.entries.length + 1}`;
  const candidate = candidateOverride ?? candidateOf(root, name);
  const binding = (relative, content) => {
    write(root, relative, content);
    if (track) git(repo, 'add', path.join('install/local/theme-lab', relative));
    return {path: relative, sha256: digest(fs.readFileSync(path.join(root, relative)))};
  };
  const dir = `ports/current-acceptance/${name}`;
  const entry = {
    package: name, successor_id: successorId,
    predecessor: previous ? {kind: 'successor', receipt_sha256: previous.receipt.sha256} : {kind: 'closure', receipt_sha256: CLOSURE_RECEIPT_SHA},
    candidate,
    receipt: binding(`${dir}/accepted-result-${successorId}.json`, {
      verdict: 'pass',
      overall_acceptance: {status: 'pass', port_verdict: 'pass', target_status: 'pass'},
      port_decision: {verdict: 'pass'}, target_acceptance: {status: 'pass'},
      candidate_css_sha256: candidate.css_sha256, candidate_source_sha256: candidate.source_sha256,
      candidate_preview_sha256: candidate.preview_sha256, candidate_base_css_sha256: null,
    }),
    browser_audit: binding(`${dir}/browser-audit-${successorId}.json`, {records: [{candidate_sha256: candidate.candidate_sha256}]}),
    visual_review: binding(`${dir}/visual-review-${successorId}.json`, {
      schema: 'theme_lab_visual_acceptance.v1',
      candidate_css_sha256: candidate.css_sha256, candidate_source_sha256: candidate.source_sha256,
      candidate_preview_sha256: candidate.preview_sha256,
    }),
  };
  record.entries.push(entry);
  write(root, POST_CLOSURE_PATH, record);
  return entry;
}

const packageRow = (checked, name) => checked.packages.find(row => row.package === name);

test('Check 2 requires a --base that names a commit', () => withFixture({}, fixture => {
  commit(fixture.repo, 'base');
  const missing = fixture.check({base: null});
  assert.equal(missing.status, 'fail');
  assert.ok(missing.failures.some(failure => failure.includes('--base')), missing.failures.join('\n'));
  const invalid = fixture.check({base: 'no-such-ref'});
  assert.equal(invalid.status, 'fail');
  assert.ok(invalid.failures.some(failure => failure.includes('no-such-ref')), invalid.failures.join('\n'));
}));

test('a candidate change with no successor entry fails, attributed to its package', () => withFixture({}, fixture => {
  const base = commit(fixture.repo, 'base');
  changeCandidate(fixture.root);
  const checked = fixture.check({base});
  assert.equal(checked.status, 'fail');
  const row = packageRow(checked, 'testtheme');
  assert.equal(row.in_scope, true);
  assert.equal(row.state, 'unadmitted');
  assert.ok(row.failures.some(failure => failure.includes('without a successor entry naming it')), row.failures.join('\n'));
  assert.deepEqual(checked.failures, row.failures);
}));

test('the same change with a complete v2 successor entry passes and is admitted', () => withFixture({}, fixture => {
  const base = commit(fixture.repo, 'base');
  changeCandidate(fixture.root);
  const entry = addSuccessor(fixture);
  assert.deepEqual(Object.keys(entry).sort(), [...V2_KEYS].sort());
  const checked = fixture.check({base});
  assert.equal(checked.status, 'pass', checked.failures.join('\n'));
  assert.deepEqual(packageRow(checked, 'testtheme'), {package: 'testtheme', in_scope: true, state: 'admitted', successor_id: entry.successor_id, failures: []});
  assert.equal(checked.changed_packages, 1);
  assert.equal(checked.admitted, 1);
}));

test('a second successor chains to the first and admits the newer candidate', () => withFixture({}, fixture => {
  changeCandidate(fixture.root);
  addSuccessor(fixture);
  const base = commit(fixture.repo, 'first successor');
  changeCandidate(fixture.root, 'testtheme', 'body { color: blue; }');
  const second = addSuccessor(fixture);
  const checked = fixture.check({base});
  assert.equal(checked.status, 'pass', checked.failures.join('\n'));
  assert.equal(packageRow(checked, 'testtheme').successor_id, second.successor_id);
}));

test('a successor whose predecessor skips the prior successor fails', () => withFixture({}, fixture => {
  changeCandidate(fixture.root);
  addSuccessor(fixture);
  const base = commit(fixture.repo, 'first successor');
  changeCandidate(fixture.root, 'testtheme', 'body { color: blue; }');
  addSuccessor(fixture);
  const record = readJson(fixture.root, POST_CLOSURE_PATH);
  record.entries[1].predecessor = {kind: 'closure', receipt_sha256: CLOSURE_RECEIPT_SHA};
  write(fixture.root, POST_CLOSURE_PATH, record);
  const checked = fixture.check({base});
  assert.equal(checked.status, 'fail');
  assert.ok(checked.failures.some(failure => failure.includes('predecessor')), checked.failures.join('\n'));
}));

test('a successor entry that admits the closure candidate unchanged fails', () => withFixture({}, fixture => {
  const base = commit(fixture.repo, 'base');
  addSuccessor(fixture);
  const checked = fixture.check({base});
  assert.equal(checked.status, 'fail');
  assert.ok(checked.failures.some(failure => failure.includes('admits nothing')), checked.failures.join('\n'));
}));

test('a successor entry bound to a stale candidate fails', () => withFixture({}, fixture => {
  const base = commit(fixture.repo, 'base');
  changeCandidate(fixture.root);
  addSuccessor(fixture, {candidateOverride: {...candidateOf(fixture.root, 'testtheme'), css_sha256: '6'.repeat(64)}});
  const checked = fixture.check({base});
  assert.equal(checked.status, 'fail');
  assert.equal(packageRow(checked, 'testtheme').state, 'unadmitted');
}));

test('successor evidence present only in the worktree fails until committed', () => withFixture({}, fixture => {
  const base = commit(fixture.repo, 'base');
  changeCandidate(fixture.root);
  addSuccessor(fixture, {track: false});
  const checked = fixture.check({base});
  assert.equal(checked.status, 'fail');
  const untracked = checked.failures.filter(failure => failure.includes('successor evidence must be committed'));
  assert.equal(untracked.length, 3, checked.failures.join('\n'));
}));

test('a successor entry rewritten after --base fails', () => withFixture({}, fixture => {
  changeCandidate(fixture.root);
  addSuccessor(fixture);
  const base = commit(fixture.repo, 'admit successor');
  const record = readJson(fixture.root, POST_CLOSURE_PATH);
  record.entries[0].visual_review = {...record.entries[0].visual_review, sha256: '7'.repeat(64)};
  write(fixture.root, POST_CLOSURE_PATH, record);
  const checked = fixture.check({base});
  assert.equal(checked.status, 'fail');
  assert.ok(packageRow(checked, 'testtheme').failures.some(failure => failure.includes('rewritten')), checked.failures.join('\n'));
}));

test('a successor entry removed after --base fails', () => withFixture({}, fixture => {
  changeCandidate(fixture.root);
  addSuccessor(fixture);
  const base = commit(fixture.repo, 'admit successor');
  write(fixture.root, POST_CLOSURE_PATH, {schema: POST_CLOSURE_SCHEMA, entries: []});
  const checked = fixture.check({base});
  assert.equal(checked.status, 'fail');
  assert.ok(packageRow(checked, 'testtheme').failures.some(failure => failure.includes('removed')), checked.failures.join('\n'));
}));

test('a v1 entry at --base and its v2 projection at HEAD pass', () => withFixture({}, fixture => {
  changeCandidate(fixture.root);
  const entry = addSuccessor(fixture);
  const v1 = {...entry, run_contract: {path: 'ports/current-acceptance/run-contract-successor.json', sha256: '3'.repeat(64)}, successor_manifest: {path: 'publication/post-closure-evidence-testtheme.json', sha256: '4'.repeat(64)}};
  write(fixture.root, POST_CLOSURE_PATH, {schema: 'theme_lab_post_closure_acceptance.v1', entries: [v1]});
  const base = commit(fixture.repo, 'v1 record');
  write(fixture.root, POST_CLOSURE_PATH, {schema: POST_CLOSURE_SCHEMA, entries: [entry]});
  // Touch the package so its entries are verified against --base.
  write(fixture.root, 'ports/testtheme/manifest.json', {reference_url: 'https://scp-wiki.wikidot.com/theme:testtheme', note: 'touched'});
  const checked = fixture.check({base});
  assert.equal(checked.status, 'pass', checked.failures.join('\n'));
  assert.equal(packageRow(checked, 'testtheme').in_scope, true);
  assert.equal(packageRow(checked, 'testtheme').state, 'admitted');
}));

test('an unadmitted package the change-set does not touch is pending, not a failure', () => withFixture({packages: ['othertheme', 'testtheme']}, fixture => {
  changeCandidate(fixture.root, 'testtheme');
  const base = commit(fixture.repo, 'unadmitted testtheme change');
  changeCandidate(fixture.root, 'othertheme');
  addSuccessor(fixture, {name: 'othertheme'});
  const checked = fixture.check({base});
  assert.equal(checked.status, 'pass', checked.failures.join('\n'));
  assert.deepEqual(checked.pending_admission, ['testtheme']);
  assert.deepEqual(packageRow(checked, 'testtheme'), {package: 'testtheme', in_scope: false, state: 'unadmitted', successor_id: null, failures: []});
  assert.equal(packageRow(checked, 'othertheme').state, 'admitted');
  assert.equal(packageRow(checked, 'othertheme').in_scope, true);
}));

test('an untracked new port file brings its package into scope', () => withFixture({}, fixture => {
  changeCandidate(fixture.root);
  const base = commit(fixture.repo, 'unadmitted change at base');
  write(fixture.root, 'ports/testtheme/acceptance-structure.json', {sections: []});
  const checked = fixture.check({base});
  assert.equal(checked.status, 'fail');
  assert.equal(packageRow(checked, 'testtheme').in_scope, true);
}));

test('a ledger row change brings its package into scope', () => withFixture({}, fixture => {
  changeCandidate(fixture.root);
  const base = commit(fixture.repo, 'unadmitted change at base');
  write(fixture.root, 'ports/adaptation-authority.json', {packages: {testtheme: {note: 'edited'}}});
  const checked = fixture.check({base});
  assert.equal(checked.status, 'fail');
  assert.equal(packageRow(checked, 'testtheme').in_scope, true);
}));

const driftedInstrument = {
  ...TARGET_ACCEPTANCE_CONTRACT,
  viewport_overflow: {...TARGET_ACCEPTANCE_CONTRACT.viewport_overflow, tolerance_px: 999},
};

test('instrument drift fails a change-set that adds a successor entry', () => {
  assert.notEqual(computeInstrumentProperDigest({contract: driftedInstrument}), CLOSURE_ANCHORS.targetAcceptanceContractSha256);
  withFixture({}, fixture => {
    const base = commit(fixture.repo, 'base');
    changeCandidate(fixture.root);
    addSuccessor(fixture);
    const checked = fixture.check({base, instrumentContract: driftedInstrument});
    assert.equal(checked.status, 'fail');
    assert.ok(packageRow(checked, 'testtheme').failures.some(failure => failure.includes('instrument drift')), checked.failures.join('\n'));
    const browserDrift = fixture.check({base, liveBrowserVersions: {chromium: '2.0'}});
    assert.ok(browserDrift.failures.some(failure => failure.includes('chromium browser version 2.0')), browserDrift.failures.join('\n'));
  });
});

test('instrument drift passes when the change-set adds no successor entry', () => withFixture({}, fixture => {
  changeCandidate(fixture.root);
  addSuccessor(fixture);
  const base = commit(fixture.repo, 'admitted before drift');
  write(fixture.root, 'ports/testtheme/manifest.json', {reference_url: 'https://scp-wiki.wikidot.com/theme:testtheme', note: 'touched'});
  const checked = fixture.check({base, instrumentContract: driftedInstrument, liveBrowserVersions: {chromium: '2.0'}});
  assert.equal(checked.status, 'pass', checked.failures.join('\n'));
  assert.equal(packageRow(checked, 'testtheme').in_scope, true);
}));

test('a runtime-only change passes', () => {
  const runtimeMovedContract = {
    ...TARGET_ACCEPTANCE_CONTRACT,
    static_inputs: {...TARGET_ACCEPTANCE_CONTRACT.static_inputs, target_page_runtime_sha256: 'a'.repeat(64)},
  };
  // Runtime substitution is total: moving the one runtime-derived field does
  // not move the instrument-proper digest (pinned to the recorded successor).
  assert.equal(computeInstrumentProperDigest({contract: runtimeMovedContract}), 'dc7fd55cf685154e60c2c8d482e594170be26563cd8ada16e468b3d08a9c74bb');
  withFixture({}, fixture => {
    const base = commit(fixture.repo, 'base');
    changeCandidate(fixture.root);
    addSuccessor(fixture);
    const checked = fixture.check({base, instrumentContract: runtimeMovedContract});
    assert.equal(checked.status, 'pass', checked.failures.join('\n'));
    assert.equal(checked.changed_packages, 1);
  });
});

test('C6: the live instrument-proper digest is the recorded successor of the closure anchor on this tree', () => {
  // The closure instrument (df8e0b53…, the Check 1 anchor) measured the frozen
  // campaign. This tree's instrument is its latest recorded successor: the
  // #3381 state-aware viewport_overflow gate, admitted in
  // src/target-acceptance-instruments.mjs on 2026-11-03 after the teardown
  // and #3409 browser-resolution successors. The admitted set is closed and pinned here, so an
  // unrecorded instrument change still fails this test.
  assert.deepEqual([...ADMITTED_TARGET_ACCEPTANCE_CONTRACT_SHA256S], [
    'df8e0b532decad8636fc7d5488c44d6c08e0bdc525a02eae8330c19554487a0a',
    '1811b3b4bdb78d1d6a52584cd0f7c2bbaee39480498a9a017eb40498a4835131',
    '34e17dbac84038b1e9960a42ad7931b255baf3bd2e5ca219f6a2f62d79c8e2d4',
    'dc7fd55cf685154e60c2c8d482e594170be26563cd8ada16e468b3d08a9c74bb',
  ]);
  assert.equal(computeInstrumentProperDigest(), 'dc7fd55cf685154e60c2c8d482e594170be26563cd8ada16e468b3d08a9c74bb',
    'this change edits the measurement instrument beyond its recorded successor (see src/target-acceptance-instruments.mjs); every later post-closure admission would fail Check 2 as incomparable with the closure. Revert the instrument change, or admit it as a further recorded successor with an equivalence basis.');
});
