import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {classifySelectors, extractCssSelectors, splitSelectorList, triageThemePackage} from '../src/theme-triage.mjs';

const root = path.resolve(import.meta.dirname, '..');

test('selector lists split on top-level commas only', () => {
  assert.deepEqual(splitSelectorList('a, b:not(.x, .y), [href="a,b"]'), ['a', 'b:not(.x, .y)', '[href="a,b"]']);
});

test('extraction recurses into grouping at-rules and skips keyframes', () => {
  const css = `
    /* a comment with a fake .selector { } */
    #header h1 a { color: red; }
    @media (max-width: 600px) { #side-bar .side-block { display: none; } }
    @keyframes pulse { from { opacity: 0; } 50% { opacity: 1; } }
    @import url("https://example.test/imported.css");
    .local { background: url(./assets/bg.png); }
  `;
  const {selectors, atRules, externalReferences} = extractCssSelectors(css);
  assert.ok(selectors.includes('#header h1 a'));
  assert.ok(selectors.includes('#side-bar .side-block'));
  assert.ok(selectors.includes('.local'));
  assert.ok(!selectors.includes('from') && !selectors.includes('50%'));
  assert.deepEqual(atRules.map((row) => row.name), ['media', 'keyframes', 'import']);
  assert.ok(externalReferences.includes('https://example.test/imported.css'));
  assert.ok(externalReferences.includes('./assets/bg.png'));
});

test('classification maps selectors to known surfaces and reports the rest', () => {
  const {touched, unclassified} = classifySelectors(['#header h1 a', '.page-rate-widget-box .rate-points', '.theme-internal-thing']);
  assert.deepEqual(touched.get('shell.header'), ['#header h1 a']);
  assert.deepEqual(touched.get('content.rating'), ['.page-rate-widget-box .rate-points']);
  assert.deepEqual(unclassified, ['.theme-internal-thing']);
});

test('package surface-contract custom selectors classify exactly and by subject', () => {
  const custom = [{id: 'theme.flickering-heading', selector: 'h2 .flickering'}];
  const {touched, unclassified} = classifySelectors(['h2 .flickering', '.flickering', '.other'], {customSelectors: custom});
  assert.deepEqual(touched.get('theme.flickering-heading'), ['h2 .flickering', '.flickering']);
  assert.deepEqual(unclassified, ['.other']);
});

test('triage resolves a fixture package end to end without writing artifacts', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-triage-test-'));
  const ports = path.join(dir, 'ports');
  const pkgDir = path.join(ports, 'fixture-theme');
  fs.mkdirSync(pkgDir, {recursive: true});
  fs.writeFileSync(path.join(pkgDir, 'manifest.json'), JSON.stringify({slug: 'theme:fixture-theme', reference_url: 'https://example.test/theme:fixture-theme'}));
  fs.writeFileSync(path.join(pkgDir, 'candidate.wikidot.txt'), 'preview');
  fs.writeFileSync(path.join(pkgDir, 'candidate.wikidot.source.txt'), 'source');
  fs.writeFileSync(path.join(pkgDir, 'candidate.css'), '#header { color: red; }\n.mystery { color: blue; }\n');
  const before = fs.readdirSync(pkgDir).sort();
  const report = triageThemePackage(dir, 'fixture-theme');
  assert.equal(report.kind, 'legacy-en');
  assert.deepEqual(report.touched_surfaces.map((row) => row.surface), ['shell.header']);
  assert.deepEqual(report.unclassified_selectors, ['.mystery']);
  assert.ok(report.untouched_surfaces.includes('content.rating'));
  assert.deepEqual(fs.readdirSync(pkgDir).sort(), before);
});

test('triage of the FR package classifies its contract custom selector', () => {
  const report = triageThemePackage(root, 'quand-le-soleil-se-couche');
  const ids = report.touched_surfaces.map((row) => row.surface);
  assert.ok(ids.includes('theme.flickering-heading'));
  assert.ok(ids.includes('shell.header'));
  assert.ok(!report.unclassified_selectors.includes('.flickering'));
});
