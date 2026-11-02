import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadBrowserType, loadChromium} from '../src/browser-lab.mjs';
import {playwrightBrowserVersions} from '../src/playwright-browser-versions.mjs';

test('a missing browser root fails closed instead of resolving an ancestor Playwright', () => {
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'browser-root-')), 'framerail-does-not-exist');
  assert.throws(() => loadBrowserType('firefox', missing), /browser root has no package\.json/u);
  assert.throws(() => playwrightBrowserVersions(missing), /browser root has no package\.json/u);
});

test('a browser root without package.json fails closed', () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-root-bare-'));
  assert.throws(() => loadBrowserType('chromium', bare), /browser root has no package\.json/u);
  assert.throws(() => playwrightBrowserVersions(bare), /browser root has no package\.json/u);
});

// #3409: an ancestor node_modules/playwright must not be loaded for a
// browser root that lacks its own playwright. Before the fix, loadChromium
// tried bare 'playwright' first, so createRequire walked up to the ancestor
// copy (a stray ~/node_modules Playwright with the wrong browser build).
function writeFakePlaywright(dir, name, marker) {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name, version: '0.0.0', main: 'index.js', type: 'commonjs'}));
  fs.writeFileSync(path.join(dir, 'index.js'), `module.exports = {chromium: {marker: ${JSON.stringify(marker)}}};\n`);
}

test('loadChromium does not load an ancestor playwright for a root without its own (#3409)', () => {
  const ancestor = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-root-ancestor-'));
  writeFakePlaywright(path.join(ancestor, 'node_modules', 'playwright'), 'playwright', 'ancestor-playwright');
  const root = path.join(ancestor, 'framerail');
  fs.mkdirSync(root, {recursive: true});
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"framerail-like","private":true}\n');
  writeFakePlaywright(path.join(root, 'node_modules', '@playwright', 'test'), '@playwright/test', 'root-playwright-test');
  assert.equal(loadChromium(root).marker, 'root-playwright-test');
  // A root with neither package must fail closed, not fall through to the ancestor.
  const bareRoot = path.join(ancestor, 'bare-root');
  fs.mkdirSync(bareRoot, {recursive: true});
  fs.writeFileSync(path.join(bareRoot, 'package.json'), '{"name":"bare-root","private":true}\n');
  assert.throws(() => loadChromium(bareRoot), /could not load Playwright/u);
});

test('a browser root whose package has no Playwright still reports that failure', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-root-empty-'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"empty-browser-root","private":true}\n');
  assert.throws(() => loadBrowserType('webkit', root), /could not load Playwright/u);
});
