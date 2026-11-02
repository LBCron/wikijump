import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {collectTestFiles, ensureFramerailDependencies, framerailPlaywrightMissing} from '../scripts/run-tests.mjs';

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

test('the concurrency default stays 4 and carries the scoped-exception note', () => {
  const source = fs.readFileSync(new URL('../scripts/run-tests.mjs', import.meta.url), 'utf8');
  // The default in code stays 4; the scoped exception arrives through
  // the environment from scripts/preflight.sh, never from a changed
  // default here.
  assert.match(source, /const concurrency = process\.env\.THEME_LAB_TEST_CONCURRENCY \?\? '4';/);
  assert.match(source, /Scoped exception \(2026-11-02, delegated authority/);
  assert.match(source, /THEME_LAB_TEST_CONCURRENCY=6 when theme_lab is the only selected/);
});
