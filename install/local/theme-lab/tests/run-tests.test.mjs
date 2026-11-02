import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {assessFileResults, collectTestFiles, ensureFramerailDependencies, extractTestSummary, framerailPlaywrightMissing, runSuite, splitFailingSection, stripTestSummary} from '../scripts/run-tests.mjs';

function fakeFramerail(withPlaywright) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-framerail-'));
  if (withPlaywright) {
    const pkg = path.join(root, 'node_modules', '@playwright', 'test');
    fs.mkdirSync(pkg, {recursive: true});
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
  }
  return root;
}

test('playwright presence is detected from framerail node_modules', () => {
  assert.equal(framerailPlaywrightMissing(fakeFramerail(false)), true);
  assert.equal(framerailPlaywrightMissing(fakeFramerail(true)), false);
});

test('no install runs when playwright already resolves', () => {
  let calls = 0;
  const installed = ensureFramerailDependencies(fakeFramerail(true), () => {
    calls += 1;
    return {status: 0};
  });
  assert.equal(installed, false);
  assert.equal(calls, 0);
});

test('a missing playwright triggers one frozen install and re-verifies', () => {
  const root = fakeFramerail(false);
  let calls = 0;
  const run = (command, args, options) => {
    calls += 1;
    assert.equal(command, 'pnpm');
    assert.deepEqual(args, ['install', '--frozen-lockfile']);
    assert.equal(options.cwd, root);
    const pkg = path.join(root, 'node_modules', '@playwright', 'test');
    fs.mkdirSync(pkg, {recursive: true});
    fs.writeFileSync(path.join(pkg, 'package.json'), '{}');
    return {status: 0};
  };
  assert.equal(ensureFramerailDependencies(root, run), true);
  assert.equal(calls, 1);
});

test('a failed install is a loud error, not a silent skip', () => {
  assert.throws(
    () => ensureFramerailDependencies(fakeFramerail(false), () => ({status: 1})),
    /pnpm install in framerail exited 1/,
  );
});

test('test files default to the sorted tests directory and honor explicit args', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-lab-'));
  fs.mkdirSync(path.join(root, 'tests'));
  for (const name of ['b.test.mjs', 'a.test.mjs', 'not-a-test.mjs', 'c.test.mjs']) {
    fs.writeFileSync(path.join(root, 'tests', name), '');
  }
  assert.deepEqual(collectTestFiles([], root), ['tests/a.test.mjs', 'tests/b.test.mjs', 'tests/c.test.mjs']);
  assert.deepEqual(collectTestFiles(['tests/x.test.mjs'], root), ['tests/x.test.mjs']);
});

const SUMMARY_BLOCK = [
  'ℹ tests 3',
  'ℹ suites 1',
  'ℹ pass 2',
  'ℹ fail 1',
  'ℹ cancelled 0',
  'ℹ skipped 0',
  'ℹ todo 0',
  'ℹ duration_ms 12.5',
].join('\n');

test('extractTestSummary reads the counts a file process reported for itself', () => {
  const output = `✔ one (1ms)\n✖ two (2ms)\n${SUMMARY_BLOCK}\n\n✖ failing tests:\n\ndetails\n`;
  const summary = extractTestSummary(output);
  assert.deepEqual(summary.counts, {tests: 3, suites: 1, pass: 2, fail: 1, cancelled: 0, skipped: 0, todo: 0});
  assert.equal(summary.durationMs, 12.5);
  const stripped = stripTestSummary(output, summary);
  assert.equal(stripped.includes('ℹ tests'), false);
  assert.equal(stripped.includes('✖ failing tests:'), true);
});

test('extractTestSummary returns null for a truncated or absent summary', () => {
  assert.equal(extractTestSummary('✔ one (1ms)\n'), null);
  assert.equal(extractTestSummary('ℹ tests 3\nℹ suites 1\nℹ pass 2\n'), null);
});

test('assessFileResults sums per-file counts and names every untrusted file', () => {
  const ok = {counts: {tests: 2, suites: 0, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0}};
  const {totals, problems} = assessFileResults([
    {file: 'tests/ok.test.mjs', status: 0, signal: null, summary: ok},
    {file: 'tests/silent.test.mjs', status: 0, signal: null, summary: null},
    {file: 'tests/failed.test.mjs', status: 1, signal: null, summary: {counts: {...ok.counts, tests: 1, pass: 0, fail: 1}}},
    {file: 'tests/killed.test.mjs', status: null, signal: 'SIGKILL', summary: null},
    {file: 'tests/liar.test.mjs', status: 0, signal: null, summary: {counts: {...ok.counts, tests: 1, pass: 0, fail: 1}}},
  ]);
  assert.equal(totals.tests, 4);
  assert.deepEqual(problems.map((p) => p.file), [
    'tests/silent.test.mjs',
    'tests/failed.test.mjs',
    'tests/killed.test.mjs',
    'tests/liar.test.mjs',
  ]);
  assert.match(problems[0].reason, /no test summary/);
});

test('runSuite fails the run and names the file when a file reports nothing', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-suite-'));
  const write = (name, body) => {
    fs.writeFileSync(path.join(root, name), body);
    return path.join(root, name);
  };
  const passFile = write('pass.test.mjs', "import test from 'node:test';\ntest('p1', () => {});\ntest('p2', () => {});\n");
  const failFile = write('fail.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('f1', () => {});\ntest('f2', () => { assert.equal(1, 2); });\n");
  const silentFile = write('silent.test.mjs', 'process.exit(0);\n');
  const leakFile = write('leak.test.mjs', "import test from 'node:test';\nsetInterval(() => {}, 1000);\ntest('l1', () => {});\n");
  let outText = '';
  let errText = '';
  const code = await runSuite([passFile, failFile, silentFile, leakFile], {
    root,
    concurrency: 2,
    out: {write: (chunk) => { outText += chunk; }},
    err: {write: (chunk) => { errText += chunk; }},
  });
  assert.equal(code, 1);
  assert.match(outText, /ℹ tests 5\n/);
  assert.match(outText, /✖ f2/);
  assert.match(errText, new RegExp(failFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(errText, /silent\.test\.mjs: no test summary/);
  assert.ok(outText.indexOf('ℹ tests 5') < outText.indexOf('✖ failing tests:'), 'detail section follows the aggregate summary');
  assert.equal(errText.includes('leak.test.mjs'), false);
  assert.equal(errText.includes('pass.test.mjs'), false);
});

test('splitFailingSection moves the detail section after the aggregate summary', async () => {
  const {body, failing} = splitFailingSection('✔ one (1ms)\n✖ two (2ms)\n\n✖ failing tests:\n\ntest at x\n✖ two (2ms)\n');
  assert.equal(body, '✔ one (1ms)\n✖ two (2ms)\n\n');
  assert.match(failing, /^✖ failing tests:/);
  assert.deepEqual(splitFailingSection('✔ one (1ms)\n'), {body: '✔ one (1ms)\n', failing: ''});
});
