// Canonical Theme Lab package descriptor/resolver (#2753).
//
// Every maintained theme package under ports/<name>/ is resolved through
// this one module instead of per-caller filename conventions and
// package-name branches. Three manifest shapes are normalized:
//   - legacy EN campaign manifests (no `schema` field);
//   - `theme_lab_retained_source_authority.v1` (retained foreign ports);
//   - `theme_lab_foreign_port.v1` (foreign ports with a surface contract).
import fs from 'node:fs';
import path from 'node:path';

import {resolveExistingPackageDirectory, resolveExistingPackageFile} from './package-path.mjs';

export const THEME_PACKAGE_KINDS = Object.freeze({
  LEGACY_EN: 'legacy-en',
  RETAINED_AUTHORITY: 'retained-authority',
  FOREIGN_PORT: 'foreign-port',
});

export const PACKAGE_PREVIEW_FILE = 'candidate.wikidot.txt';
export const PACKAGE_CANDIDATE_SOURCE_FILE = 'candidate.wikidot.source.txt';
export const PACKAGE_CSS_FILE = 'candidate.css';
export const PACKAGE_SELECTORS_FILE = 'acceptance-selectors.txt';
export const FOREIGN_SOURCE_INPUT_FILE = 'candidate-template.css';
export const DEFAULT_SOURCE_INPUT_FILE = 'candidate-input.css';
export const FOREIGN_PUBLICATION_SOURCE_FILES = Object.freeze(['publishable-theme.wikidot.txt']);

export function themePackageKind(manifest) {
  if (manifest === null || typeof manifest !== 'object') throw new Error('package manifest must be a JSON object');
  if (manifest.schema === undefined || manifest.schema === null) return THEME_PACKAGE_KINDS.LEGACY_EN;
  if (manifest.schema === 'theme_lab_retained_source_authority.v1') return THEME_PACKAGE_KINDS.RETAINED_AUTHORITY;
  if (manifest.schema === 'theme_lab_foreign_port.v1') return THEME_PACKAGE_KINDS.FOREIGN_PORT;
  throw new Error(`unsupported package manifest schema: ${manifest.schema}`);
}

// The candidate source file for a package follows the on-disk convention (EN packages
// keep a distinct candidate.wikidot.source.txt, foreign packages publish
// straight from the preview file). Callers resolve the returned name
// against the package directory, which fails closed when it is absent.
// The adaptation-authority input names for a package directory, derived
// from the manifest kind alone. Unlike loadThemePackage this performs no
// package-file validation, so callers whose own checks must fire first
// (and fixtures without a manifest) keep their historical error order.
export function adaptationInputNames(directory) {
  let kind = THEME_PACKAGE_KINDS.LEGACY_EN;
  const manifestFile = path.join(directory, 'manifest.json');
  if (fs.existsSync(manifestFile)) kind = themePackageKind(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
  return {
    sourceInputName: kind === THEME_PACKAGE_KINDS.FOREIGN_PORT ? FOREIGN_SOURCE_INPUT_FILE : DEFAULT_SOURCE_INPUT_FILE,
    publicationSourceNames: kind === THEME_PACKAGE_KINDS.FOREIGN_PORT
      ? FOREIGN_PUBLICATION_SOURCE_FILES.filter((file) => fs.existsSync(path.join(directory, file)))
      : [],
  };
}

export function candidateSourceName(directory) {
  return fs.existsSync(path.join(directory, PACKAGE_CANDIDATE_SOURCE_FILE))
    ? PACKAGE_CANDIDATE_SOURCE_FILE
    : PACKAGE_PREVIEW_FILE;
}

function slugFromSourceUrl(sourceUrl) {
  if (typeof sourceUrl !== 'string' || !sourceUrl) return null;
  try {
    const tail = new URL(sourceUrl).pathname.split('/').filter(Boolean).at(-1);
    return tail ? decodeURIComponent(tail) : null;
  } catch {
    return null;
  }
}

export function loadThemePackage(portsDirectory, name) {
  const directory = resolveExistingPackageDirectory(portsDirectory, name, `${name}: package directory`);
  const manifestFile = path.join(directory, 'manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Error(`${name}: package manifest is missing (manifest.json)`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const kind = themePackageKind(manifest);

  let slug = null;
  if (kind === THEME_PACKAGE_KINDS.LEGACY_EN) slug = manifest.slug ?? null;
  else if (kind === THEME_PACKAGE_KINDS.RETAINED_AUTHORITY) slug = manifest.retained_capture?.fullname ?? slugFromSourceUrl(manifest.source_url);
  else slug = manifest.planned_jp_theme_page ?? manifest.source_page ?? slugFromSourceUrl(manifest.source_url);
  if (typeof slug !== 'string' || !slug) throw new Error(`${name}: package manifest does not declare a theme slug`);

  let referenceUrl = manifest.reference_url ?? null;
  if (!referenceUrl && fs.existsSync(path.join(directory, 'reference.json'))) {
    referenceUrl = JSON.parse(fs.readFileSync(path.join(directory, 'reference.json'), 'utf8')).reference_url ?? null;
  }
  if (!referenceUrl) referenceUrl = manifest.source_url ?? null;
  if (typeof referenceUrl !== 'string' || !referenceUrl) throw new Error(`${name}: package does not declare a reference URL`);

  const required = (fileName, label) => {
    if (!fs.existsSync(path.join(directory, fileName))) throw new Error(`${name}: ${label} is missing (${fileName})`);
    return resolveExistingPackageFile(directory, fileName, `${name}: ${label}`);
  };
  const sourceName = candidateSourceName(directory);
  const previewName = PACKAGE_PREVIEW_FILE;
  const cssName = typeof manifest.candidate_css === 'string' && manifest.candidate_css ? manifest.candidate_css : PACKAGE_CSS_FILE;
  const selectorsPath = path.join(directory, PACKAGE_SELECTORS_FILE);
  const surfaceContractName = typeof manifest.surface_contract === 'string' && manifest.surface_contract ? manifest.surface_contract : null;

  const descriptor = {
    name,
    kind,
    slug,
    directory,
    manifest,
    previewName,
    previewFile: required(previewName, 'candidate preview'),
    sourceName,
    sourceFile: required(sourceName, 'candidate source'),
    cssName,
    cssFile: required(cssName, 'candidate CSS'),
    referenceUrl,
    selectorsFile: fs.existsSync(selectorsPath) ? resolveExistingPackageFile(directory, PACKAGE_SELECTORS_FILE, `${name}: acceptance selectors`) : null,
    surfaceContractFile: surfaceContractName ? required(surfaceContractName, 'surface contract') : null,
    // The frozen upstream source the package was ported from. Legacy and
    // retained manifests name it in `source_file`; foreign-port manifests
    // do not, so the kind convention applies there.
    upstreamSourceName: kind === THEME_PACKAGE_KINDS.FOREIGN_PORT
      ? 'upstream-fr.wikidot.txt'
      : (typeof manifest.source_file === 'string' && manifest.source_file ? manifest.source_file : null),
    // Adaptation-authority inputs that used to be chosen by package name:
    // foreign ports adapt from a CSS template, everyone else from the
    // candidate input sheet; only foreign ports carry an extra publishable
    // theme source whose adaptation blocks need authority dispositions.
    sourceInputName: adaptationInputNames(directory).sourceInputName,
    upstreamSourceFile: null,
    publicationSourceNames: Object.freeze(adaptationInputNames(directory).publicationSourceNames),
  };
  descriptor.upstreamSourceFile = descriptor.upstreamSourceName && fs.existsSync(path.join(directory, descriptor.upstreamSourceName))
    ? resolveExistingPackageFile(directory, descriptor.upstreamSourceName, `${name}: frozen upstream source`)
    : null;
  return Object.freeze(descriptor);
}

export function discoverThemePackages(portsDirectory) {
  const packages = [];
  for (const entry of fs.readdirSync(portsDirectory, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    if (!fs.existsSync(path.join(portsDirectory, entry.name, 'manifest.json'))) continue;
    packages.push(loadThemePackage(portsDirectory, entry.name));
  }
  return packages.sort((a, b) => a.name.localeCompare(b.name));
}
