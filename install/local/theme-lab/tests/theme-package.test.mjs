import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  THEME_PACKAGE_KINDS,
  candidateSourceName,
  discoverThemePackages,
  loadThemePackage,
  themePackageKind,
} from '../src/theme-package.mjs';

const root = path.resolve(import.meta.dirname, '..');

function fixturePackage(portsDir, name, {manifest, files = {}, ledgerEntry = null}) {
  const dir = path.join(portsDir, name);
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  for (const [file, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), body);
  return ledgerEntry ? {packages: {[name]: ledgerEntry}} : null;
}

function tempPorts() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'theme-package-test-'));
}

const BASE_FILES = {
  'candidate.wikidot.txt': 'preview',
  'candidate.wikidot.source.txt': 'source',
  'candidate.css': 'css',
};

test('legacy EN manifest normalizes to the campaign conventions', () => {
  const ports = tempPorts();
  const ledger = fixturePackage(ports, 'basalt-like', {
    manifest: {slug: 'theme:basalt-like', reference_url: 'https://scp-wiki.wikidot.com/theme:basalt-like', candidate_css: 'candidate.css', source_file: 'upstream-en.wikidot.txt'},
    files: BASE_FILES,
    ledgerEntry: {source_file: 'candidate.wikidot.source.txt'},
  });
  const pkg = loadThemePackage(ports, 'basalt-like');
  assert.equal(pkg.kind, THEME_PACKAGE_KINDS.LEGACY_EN);
  assert.equal(pkg.slug, 'theme:basalt-like');
  assert.equal(pkg.sourceName, 'candidate.wikidot.source.txt');
  assert.equal(pkg.previewName, 'candidate.wikidot.txt');
  assert.equal(pkg.cssName, 'candidate.css');
  assert.equal(pkg.referenceUrl, 'https://scp-wiki.wikidot.com/theme:basalt-like');
  assert.equal(pkg.sourceInputName, 'candidate-input.css');
  assert.deepEqual(pkg.publicationSourceNames, []);
  assert.equal(pkg.selectorsFile, null);
  assert.equal(pkg.surfaceContractFile, null);
});

test('legacy package without a ledger entry falls back to the on-disk source convention', () => {
  const ports = tempPorts();
  fixturePackage(ports, 'unledgered', {
    manifest: {slug: 'theme:unledgered', reference_url: 'https://example.test/theme:unledgered'},
    files: BASE_FILES,
  });
  assert.equal(loadThemePackage(ports, 'unledgered').sourceName, 'candidate.wikidot.source.txt');
  assert.equal(candidateSourceName(path.join(ports, 'unledgered')), 'candidate.wikidot.source.txt');
});

test('retained-authority manifest resolves reference.json and the preview-as-source shape', () => {
  const ports = tempPorts();
  const ledger = fixturePackage(ports, 'dear-like', {
    manifest: {schema: 'theme_lab_retained_source_authority.v1', source_url: 'https://scpko.wikidot.com/theme:dear-like', retained_capture: {fullname: 'theme:dear-like'}},
    files: {'candidate.wikidot.txt': 'preview', 'candidate.css': 'css', 'reference.json': JSON.stringify({reference_url: 'https://scpko.wikidot.com/theme:dear-like'})},
    ledgerEntry: {source_file: 'candidate.wikidot.txt'},
  });
  const pkg = loadThemePackage(ports, 'dear-like');
  assert.equal(pkg.kind, THEME_PACKAGE_KINDS.RETAINED_AUTHORITY);
  assert.equal(pkg.slug, 'theme:dear-like');
  assert.equal(pkg.sourceName, 'candidate.wikidot.txt');
  assert.equal(pkg.referenceUrl, 'https://scpko.wikidot.com/theme:dear-like');
});

test('foreign-port manifest exposes the template input, publication sources and surface contract', () => {
  const ports = tempPorts();
  fixturePackage(ports, 'soleil-like', {
    manifest: {schema: 'theme_lab_foreign_port.v1', package: 'soleil-like', source_url: 'https://fondationscp.wikidot.com/theme:soleil-like', planned_jp_theme_page: 'theme:soleil-like', surface_contract: 'surface-contract.json'},
    files: {
      'candidate.wikidot.txt': 'preview',
      'candidate.css': 'css',
      'candidate-template.css': 'template',
      'publishable-theme.wikidot.txt': 'publishable',
      'surface-contract.json': '{}',
      'acceptance-selectors.txt': 'h1',
    },
  });
  const pkg = loadThemePackage(ports, 'soleil-like');
  assert.equal(pkg.kind, THEME_PACKAGE_KINDS.FOREIGN_PORT);
  assert.equal(pkg.slug, 'theme:soleil-like');
  assert.equal(pkg.sourceName, 'candidate.wikidot.txt');
  assert.equal(pkg.sourceInputName, 'candidate-template.css');
  assert.deepEqual(pkg.publicationSourceNames, ['publishable-theme.wikidot.txt']);
  assert.ok(pkg.surfaceContractFile.endsWith('surface-contract.json'));
  assert.ok(pkg.selectorsFile.endsWith('acceptance-selectors.txt'));
  assert.equal(pkg.referenceUrl, 'https://fondationscp.wikidot.com/theme:soleil-like');
});

test('resolution fails closed on missing or ambiguous package files', () => {
  const ports = tempPorts();
  fixturePackage(ports, 'broken', {
    manifest: {slug: 'theme:broken', reference_url: 'https://example.test/theme:broken'},
    files: {'candidate.wikidot.txt': 'preview'},
  });
  assert.throws(() => loadThemePackage(ports, 'broken'), /candidate CSS is missing/);
  assert.throws(() => loadThemePackage(ports, 'absent'), /package directory|ENOENT/);
  fixturePackage(ports, 'no-manifest', {manifest: {slug: 'theme:x', reference_url: 'https://example.test/x'}, files: BASE_FILES});
  fs.rmSync(path.join(ports, 'no-manifest', 'manifest.json'));
  assert.throws(() => loadThemePackage(ports, 'no-manifest'), /manifest is missing/);
  assert.throws(() => themePackageKind({schema: 'theme_lab_future.v9'}), /unsupported package manifest schema/);
});

test('discovery finds manifest packages and ignores other directories', () => {
  const ports = tempPorts();
  fixturePackage(ports, 'one', {manifest: {slug: 'theme:one', reference_url: 'https://example.test/theme:one'}, files: BASE_FILES});
  fixturePackage(ports, 'two', {manifest: {slug: 'theme:two', reference_url: 'https://example.test/theme:two'}, files: BASE_FILES});
  fs.mkdirSync(path.join(ports, 'not-a-package'));
  const found = discoverThemePackages(ports);
  assert.deepEqual(found.map((pkg) => pkg.name), ['one', 'two']);
});

