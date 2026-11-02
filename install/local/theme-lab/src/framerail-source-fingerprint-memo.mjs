import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import {framerailSourceFingerprint, framerailSourceFingerprintSync} from './framerail-source-fingerprint.mjs';

// Caller-side memo for the framerail source fingerprint. One suite run
// computes the fingerprint ~385 times and a computation over a real tree
// re-reads ~147 MB to reach the same digest, so repeat computations over an
// unchanged tree dominate the suite's work. The memo lives here, not in
// framerail-source-fingerprint.mjs: that file's bytes are bound by the
// target acceptance contract through the session-server module closure
// (program_module_closure_sha256 in src/target-acceptance-contract.mjs),
// so editing it invalidates the closure instrument digest. Callers outside
// that closure (the candidate freeze family) import these variants; every
// other caller keeps calling the original functions, and the frozen-record
// integrity instrument's path (src/target-runtime-identity.mjs) is
// untouched.
//
// The memo never changes a result: the key is rebuilt from a fresh stat of
// every input file on EVERY call (root, the file list, and each file's
// size, mtime in ns, ctime in ns and inode, enumerated with the same rules
// as the fingerprint itself), and a cached digest is returned only when
// that key matches exactly. The key is re-checked on every call, so an
// identity change between two passes of one operation (the readiness audit
// compares candidate-set identity across passes) is still seen. An edit
// changes the key even when it preserves size and mtime, because ctime
// cannot be restored through the file APIs. Racy guard: a result is stored
// only when the post-computation stat equals the pre-computation stat and
// every input mtime is strictly older than the moment hashing started, so
// a file written in the same instant as the computation is never cached.

const excludedDirectoryNames = ['node_modules', '.svelte-kit', 'build'];

function fingerprintInputs(repoRoot) {
  const framerailDir = path.join(repoRoot, 'framerail');
  return [
    path.join(framerailDir, 'src'),
    path.join(framerailDir, 'static'),
    path.join(framerailDir, 'package.json'),
    path.join(framerailDir, 'server.js'),
    path.join(framerailDir, 'svelte.config.js'),
    path.join(framerailDir, 'sveltekit-options.js'),
    path.join(framerailDir, 'tsconfig.json'),
    path.join(framerailDir, 'vite.config.ts'),
    path.join(repoRoot, 'pnpm-lock.yaml'),
  ];
}

async function filesBelow(entry) {
  const stat = await fs.lstat(entry);
  if (stat.isSymbolicLink()) throw new Error(`Framerail fingerprint input cannot be a symlink: ${entry}`);
  if (stat.isFile()) return [entry];
  if (!stat.isDirectory()) throw new Error(`Framerail fingerprint input is not a regular file or directory: ${entry}`);
  const output = [];
  for (const item of await fs.readdir(entry, {withFileTypes: true})) {
    if (excludedDirectoryNames.includes(item.name)) continue;
    const child = path.join(entry, item.name);
    if (item.isSymbolicLink()) throw new Error(`Framerail fingerprint input cannot be a symlink: ${child}`);
    if (item.isDirectory()) output.push(...await filesBelow(child));
    else if (item.isFile()) output.push(child);
  }
  return output;
}

function filesBelowSync(entry) {
  const stat = fsSync.lstatSync(entry);
  if (stat.isSymbolicLink()) throw new Error(`Framerail fingerprint input cannot be a symlink: ${entry}`);
  if (stat.isFile()) return [entry];
  if (!stat.isDirectory()) throw new Error(`Framerail fingerprint input is not a regular file or directory: ${entry}`);
  const output = [];
  for (const item of fsSync.readdirSync(entry, {withFileTypes: true})) {
    if (excludedDirectoryNames.includes(item.name)) continue;
    const child = path.join(entry, item.name);
    if (item.isSymbolicLink()) throw new Error(`Framerail fingerprint input cannot be a symlink: ${child}`);
    if (item.isDirectory()) output.push(...filesBelowSync(child));
    else if (item.isFile()) output.push(child);
  }
  return output;
}

const memoLimit = 128;
const memo = new Map();

function memoKey(repoRoot, entries) {
  return crypto.createHash('sha256').update(JSON.stringify([path.resolve(repoRoot), entries])).digest('hex');
}
function memoStore(key, value) {
  if (memo.size >= memoLimit) memo.delete(memo.keys().next().value);
  memo.set(key, value);
}
function nowNs() { return BigInt(Date.now()) * 1000000n; }
function isRacy(entries, startedAtNs) { return entries.some((entry) => BigInt(entry[2]) >= startedAtNs); }
function statEntry(repoRoot, file, stat) {
  return [path.relative(repoRoot, file), stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString(), stat.ino.toString()];
}

function statVectorSync(repoRoot) {
  const files = [];
  for (const entry of fingerprintInputs(repoRoot)) {
    try { files.push(...filesBelowSync(entry)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  files.sort();
  return files.map((file) => statEntry(repoRoot, file, fsSync.lstatSync(file, {bigint: true})));
}

async function statVector(repoRoot) {
  const files = [];
  for (const entry of fingerprintInputs(repoRoot)) {
    try { files.push(...await filesBelow(entry)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  files.sort();
  const entries = [];
  for (const file of files) entries.push(statEntry(repoRoot, file, await fs.lstat(file, {bigint: true})));
  return entries;
}

export function framerailSourceFingerprintSyncMemoized(repoRoot) {
  const entries = statVectorSync(repoRoot);
  const key = memoKey(repoRoot, entries);
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const startedAt = nowNs();
  const value = framerailSourceFingerprintSync(repoRoot);
  if (JSON.stringify(statVectorSync(repoRoot)) === JSON.stringify(entries) && !isRacy(entries, startedAt)) memoStore(key, value);
  return value;
}

export async function framerailSourceFingerprintMemoized(repoRoot) {
  const entries = await statVector(repoRoot);
  const key = memoKey(repoRoot, entries);
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const startedAt = nowNs();
  const value = await framerailSourceFingerprint(repoRoot);
  if (JSON.stringify(await statVector(repoRoot)) === JSON.stringify(entries) && !isRacy(entries, startedAt)) memoStore(key, value);
  return value;
}
