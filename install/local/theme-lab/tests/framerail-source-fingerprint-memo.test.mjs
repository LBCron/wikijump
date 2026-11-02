import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  framerailSourceFingerprint,
  framerailSourceFingerprintSync,
} from '../src/framerail-source-fingerprint.mjs';
import {
  framerailSourceFingerprintMemoized,
  framerailSourceFingerprintSyncMemoized,
} from '../src/framerail-source-fingerprint-memo.mjs';

// Mutation set for the caller-side framerail fingerprint memo, written
// BEFORE the memo change (consult instruction, 2026-11-02). The memo lives
// in its own module, not in framerail-source-fingerprint.mjs: that file's
// bytes are bound by the target acceptance contract through the
// session-server module closure (program_module_closure_sha256), so
// editing it invalidates the closure instrument digest. Every mutation
// that changes the original fingerprint must also change the memoized
// result, and the memoized result must always equal the original one.

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-lab-fingerprint-memo-'));
  const write = (relative, text) => {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, text);
  };
  write('framerail/src/app.js', 'alpha\n');
  write('framerail/static/site.txt', 'static asset\n');
  write('framerail/package.json', '{}\n');
  write('framerail/server.js', 'server\n');
  write('framerail/svelte.config.js', 'config\n');
  write('framerail/sveltekit-options.js', 'options\n');
  write('framerail/tsconfig.json', '{}\n');
  write('framerail/vite.config.ts', 'vite\n');
  write('pnpm-lock.yaml', 'lock\n');
  return root;
}

function both(root) {
  const memoized = framerailSourceFingerprintSyncMemoized(root);
  const original = framerailSourceFingerprintSync(root);
  assert.equal(memoized, original, 'memoized result must equal the original result');
  return memoized;
}

test('memoized fingerprint: unchanged tree repeats the original value', () => {
  const root = fixture();
  const first = both(root);
  const second = both(root);
  assert.equal(second, first);
});

test('memoized fingerprint: same-size edit changes the result', () => {
  const root = fixture();
  const before = both(root);
  fs.writeFileSync(path.join(root, 'framerail/src/app.js'), 'bravo\n'); // same size as 'alpha\n'
  const after = both(root);
  assert.notEqual(after, before);
  assert.notEqual(framerailSourceFingerprintSync(root), before);
});

test('memoized fingerprint: same-size edit with restored mtime changes the result', () => {
  const root = fixture();
  const file = path.join(root, 'framerail/src/app.js');
  const before = both(root);
  const stat = fs.statSync(file);
  fs.writeFileSync(file, 'bravo\n');
  fs.utimesSync(file, stat.atime, stat.mtime);
  const after = both(root);
  assert.notEqual(after, before);
});

test('memoized fingerprint: timestamp-identical edit changes the result', () => {
  const root = fixture();
  const file = path.join(root, 'framerail/src/app.js');
  const fixed = new Date('2020-01-01T00:00:00.000Z');
  fs.utimesSync(file, fixed, fixed);
  const before = both(root);
  fs.writeFileSync(file, 'bravo\n');
  fs.utimesSync(file, fixed, fixed);
  const after = both(root);
  assert.notEqual(after, before);
});

test('memoized fingerprint: edit between passes changes the result', () => {
  const root = fixture();
  const passOne = both(root);
  fs.writeFileSync(path.join(root, 'framerail/static/site.txt'), 'static asset, edited\n');
  const passTwo = both(root);
  assert.notEqual(passTwo, passOne);
});

test('memoized fingerprint: added file changes the result, deleting it restores it', () => {
  const root = fixture();
  const before = both(root);
  const added = path.join(root, 'framerail/static/added.txt');
  fs.writeFileSync(added, 'added\n');
  assert.notEqual(both(root), before);
  fs.unlinkSync(added);
  assert.equal(both(root), before);
});

test('memoized fingerprint: renamed file changes the result', () => {
  const root = fixture();
  const before = both(root);
  fs.renameSync(
    path.join(root, 'framerail/static/site.txt'),
    path.join(root, 'framerail/static/site-renamed.txt'),
  );
  const after = both(root);
  assert.notEqual(after, before);
});

test('memoized fingerprint: file with a future mtime is never served stale', () => {
  const root = fixture();
  const file = path.join(root, 'framerail/src/app.js');
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(file, future, future);
  const before = both(root);
  fs.writeFileSync(file, 'bravo\n');
  fs.utimesSync(file, future, future);
  const after = both(root);
  assert.notEqual(after, before);
});

test('memoized fingerprint: excluded directories do not enter the key', () => {
  const root = fixture();
  const before = both(root);
  const excluded = path.join(root, 'framerail/src/node_modules/pkg');
  fs.mkdirSync(excluded, {recursive: true});
  fs.writeFileSync(path.join(excluded, 'index.js'), 'ignored\n');
  assert.equal(both(root), before);
});

test('memoized fingerprint: async result equals the original and sync results', async () => {
  const root = fixture();
  const asyncMemoized = await framerailSourceFingerprintMemoized(root);
  const asyncOriginal = await framerailSourceFingerprint(root);
  assert.equal(asyncMemoized, asyncOriginal);
  assert.equal(asyncMemoized, framerailSourceFingerprintSync(root));
  fs.writeFileSync(path.join(root, 'framerail/src/app.js'), 'bravo\n');
  assert.equal(await framerailSourceFingerprintMemoized(root), await framerailSourceFingerprint(root));
  assert.notEqual(await framerailSourceFingerprintMemoized(root), asyncMemoized);
});
