// Static triage for a theme package (#2753): answer "which JP surfaces
// does this candidate CSS touch, and which of its selectors are not
// classified by any known surface?" in seconds, without a browser, a
// daemon, or any artifact writes. Triage never mints or skips an
// acceptance result; it only informs the next action.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const THEME_LAB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

import {KNOWN_THEME_SURFACES} from './theme-surface-contract.mjs';
import {loadThemePackage} from './theme-package.mjs';

function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//gu, '');
}

// Split a selector list on top-level commas (commas inside (), [] or
// strings do not split).
export function splitSelectorList(list) {
  const selectors = [];
  let depth = 0;
  let quote = null;
  let current = '';
  for (const ch of list) {
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      if (current.trim()) selectors.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) selectors.push(current.trim());
  return selectors;
}

const GROUPING_AT_RULES = new Set(['media', 'supports', 'layer', 'document', 'scope']);

// Extract style-rule selectors, at-rule inventory and external references
// from a stylesheet. Keyframes blocks are skipped (their preludes are
// timeline offsets, not selectors); grouping at-rules are recursed into.
export function extractCssSelectors(css) {
  const text = stripComments(css);
  const selectors = [];
  const atRules = [];
  const externalReferences = [];
  for (const match of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\)/gu)) {
    const url = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (url) externalReferences.push(url);
  }
  const walk = (chunk) => {
    let index = 0;
    while (index < chunk.length) {
      const open = chunk.indexOf('{', index);
      const semi = chunk.indexOf(';', index);
      if (semi !== -1 && (open === -1 || semi < open)) {
        const statement = chunk.slice(index, semi).trim();
        if (statement.startsWith('@')) {
          const name = statement.slice(1).split(/[\s(]/u)[0].toLowerCase();
          atRules.push({name, prelude: statement.slice(1 + name.length).trim()});
          if (name === 'import') {
            const target = statement.match(/"([^"]*)"|'([^']*)'/u);
            if (target) externalReferences.push((target[1] ?? target[2]).trim());
          }
        }
        index = semi + 1;
        continue;
      }
      if (open === -1) break;
      const prelude = chunk.slice(index, open).trim();
      let depth = 1;
      let cursor = open + 1;
      while (cursor < chunk.length && depth > 0) {
        if (chunk[cursor] === '{') depth += 1;
        else if (chunk[cursor] === '}') depth -= 1;
        cursor += 1;
      }
      const block = chunk.slice(open + 1, cursor - 1);
      if (prelude.startsWith('@')) {
        const name = prelude.slice(1).split(/[\s(]/u)[0].toLowerCase();
        atRules.push({name, prelude: prelude.slice(1 + name.length).trim()});
        if (GROUPING_AT_RULES.has(name)) walk(block);
      } else if (prelude) {
        selectors.push(...splitSelectorList(prelude));
      }
      index = cursor;
    }
  };
  walk(text);
  return {
    selectors: [...new Set(selectors)],
    atRules,
    externalReferences: [...new Set(externalReferences)],
  };
}

// Classify candidate selectors against the known JP surfaces (the same
// selector_patterns the surface contract probes with) plus any custom
// selectors the package's own surface contract declares.
export function classifySelectors(selectors, {surfaces = KNOWN_THEME_SURFACES, customSelectors = []} = {}) {
  const touched = new Map();
  const unclassified = [];
  const custom = new Map(customSelectors.map((row) => [row.selector, row.id]));
  // A custom selector also classifies a candidate rule whose selector is
  // exactly its subject compound (e.g. contract `h2 .flickering` covers a
  // candidate rule written as bare `.flickering`).
  const subjectOf = (value) => value.split(/\s*[>+~]\s*|\s+/u).at(-1);
  const customBySubject = new Map(customSelectors.map((row) => [subjectOf(row.selector), row.id]));
  for (const selector of selectors) {
    const hits = [];
    if (custom.has(selector)) hits.push(custom.get(selector));
    else if (customBySubject.has(subjectOf(selector))) hits.push(customBySubject.get(subjectOf(selector)));
    for (const surface of surfaces) {
      if (surface.selector_patterns.some((pattern) => pattern.test(selector))) hits.push(surface.id);
    }
    if (!hits.length) {
      unclassified.push(selector);
      continue;
    }
    for (const id of hits) {
      if (!touched.has(id)) touched.set(id, []);
      touched.get(id).push(selector);
    }
  }
  return {touched, unclassified};
}

export function triageThemePackage(themeLabRoot, nameOrSlug) {
  const ports = path.join(themeLabRoot, 'ports');
  const byName = fs.existsSync(path.join(ports, nameOrSlug, 'manifest.json'));
  const pkg = loadThemePackage(ports, byName ? nameOrSlug : nameOrSlug.replace(/^theme:/u, ''));
  const css = fs.readFileSync(pkg.cssFile, 'utf8');
  const {selectors, atRules, externalReferences} = extractCssSelectors(css);
  let customSelectors = [];
  if (pkg.surfaceContractFile) {
    const contract = JSON.parse(fs.readFileSync(pkg.surfaceContractFile, 'utf8'));
    customSelectors = contract.custom_selectors ?? [];
  }
  const {touched, unclassified} = classifySelectors(selectors, {customSelectors});
  const touchedIds = [...touched.keys()].sort();
  return {
    package: pkg.name,
    slug: pkg.slug,
    kind: pkg.kind,
    css_file: path.relative(themeLabRoot, pkg.cssFile),
    selector_count: selectors.length,
    touched_surfaces: touchedIds.map((id) => ({surface: id, selectors: touched.get(id)})),
    unclassified_selectors: unclassified,
    untouched_surfaces: KNOWN_THEME_SURFACES.map((surface) => surface.id).filter((id) => !touched.has(id)).sort(),
    at_rules: atRules,
    external_references: externalReferences,
  };
}

export function triageThemePackageByName(nameOrSlug) {
  return triageThemePackage(THEME_LAB_ROOT, nameOrSlug);
}

export function formatTriageSummary(report) {
  const lines = [
    `triage ${report.package} (${report.kind}, ${report.slug})`,
    `  css: ${report.css_file} — ${report.selector_count} selectors`,
    `  touched surfaces (${report.touched_surfaces.length}): ${report.touched_surfaces.map((row) => row.surface).join(', ') || 'none'}`,
    `  unclassified selectors: ${report.unclassified_selectors.length}`,
    ...report.unclassified_selectors.slice(0, 10).map((selector) => `    - ${selector}`),
    ...(report.unclassified_selectors.length > 10 ? [`    … and ${report.unclassified_selectors.length - 10} more`] : []),
    `  untouched known surfaces (${report.untouched_surfaces.length}): ${report.untouched_surfaces.join(', ') || 'none'}`,
    `  external references: ${report.external_references.length ? report.external_references.join(', ') : 'none'}`,
  ];
  return lines.join('\n');
}
