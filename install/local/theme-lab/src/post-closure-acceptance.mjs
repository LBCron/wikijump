// Theme Lab post-closure changes (ALLOC-32 R4 Check 2).
//
// A candidate changed after campaign closure is admitted by one successor
// entry in publication/post-closure-acceptance.json (append-only, schema
// theme_lab_post_closure_acceptance.v2): {schema, entries: [{package,
// successor_id, predecessor: {kind: 'closure'|'successor', receipt_sha256},
// candidate: {...CANDIDATE_KEYS}, receipt, browser_audit, visual_review}]},
// where each evidence binding is {path, sha256}. The receipt and browser
// audit are the fresh capture set; the visual review is the review record.
//
// Only packages the change-set (--base against the working tree) touches are
// verified: their port files, shared replay inputs, resolved local assets,
// evidence files, ledger row or successor entries. For those, the entry chain,
// the tracked evidence bytes and their candidate bindings must hold, the live
// candidate must equal the latest entry, and a newly added entry requires the
// closure instrument. Untouched packages whose live candidate is unadmitted are
// reported as pending_admission, never as failures.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

import {collectViewportOverflow, inspectPlatformFonts} from './browser-lab.mjs';
import {
  buildVerdict, issuesFromInteractions, issuesFromPreview, issuesFromSelectorDiagnosis,
  issuesFromTorture, issuesFromViewports, nextActions, overallAcceptance,
  styleChangesFromComputed, summarizeVisual,
} from './verdict.mjs';
import {applyRuntimeSurfaceParityGate, RUNTIME_SURFACE_PARITY} from './runtime-surface-parity.mjs';
import {measureTargetBaselineViewportOverflow} from './target-baseline-viewport-probe.mjs';
import {TARGET_ACCEPTANCE_CONTRACT} from './target-acceptance-contract.mjs';
import {TARGET_ACCEPTANCE_INSTRUMENT_SUCCESSORS} from './target-acceptance-instruments.mjs';
import {candidateIdentity} from '../ports/scripts/candidate-identity.mjs';
import {validateCombinedAcceptance} from './campaign-completion.mjs';
import {CLOSURE_ANCHORS, DEFAULT_HISTORICAL_ROOT} from './campaign-record-integrity.mjs';
import {candidateAssetDependencyState} from './candidate-asset-dependencies.mjs';
import {currentPackageBaseCss} from './candidate-base-contract.mjs';
import {verifyFaithfulDesignWaivers} from './finalize-visual-acceptance.mjs';
import {playwrightBrowserVersions} from './playwright-browser-versions.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const POST_CLOSURE_PATH = 'publication/post-closure-acceptance.json';
export const POST_CLOSURE_SCHEMA = 'theme_lab_post_closure_acceptance.v2';
const BASE_SCHEMAS = new Set(['theme_lab_post_closure_acceptance.v1', POST_CLOSURE_SCHEMA]);
export const V2_KEYS = ['package', 'successor_id', 'predecessor', 'candidate', 'receipt', 'browser_audit', 'visual_review'];
const CANDIDATE_KEYS = ['css_sha256', 'source_sha256', 'preview_sha256', 'base_css_sha256', 'structure_sha256', 'asset_dependency_sha256', 'candidate_sha256'];
const SHARED_INPUTS = ['ports/interactive-visual-fixture/runtime-asset-replay.css', 'fixtures/scp-jp-sigma9-offline.css'];
const LEDGER_PATH = 'ports/adaptation-authority.json';

const readFileOrNull = file => { try { return fs.readFileSync(file); } catch { return null; } };
const parseOrNull = text => { if (text === null) return null; try { return JSON.parse(text); } catch { return null; } };
const readJsonOrNull = file => parseOrNull(readFileOrNull(file)?.toString('utf8') ?? null);
const canonical = value => JSON.stringify(sortValue(value));
function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortValue(value[key])]));
  return value;
}
const projectV2 = entry => Object.fromEntries(V2_KEYS.map(key => [key, entry?.[key]]));
const sameCandidate = (a, b) => CANDIDATE_KEYS.every(key => (a?.[key] ?? null) === (b?.[key] ?? null));

const candidateBound = (doc, candidate) => doc?.candidate_css_sha256 === candidate?.css_sha256
  && doc?.candidate_source_sha256 === candidate?.source_sha256
  && doc?.candidate_preview_sha256 === candidate?.preview_sha256;

// Each evidence binding of an entry, with what its bytes must say.
const EVIDENCE_KINDS = [
  {key: 'receipt', label: 'receipt', verify: (doc, entry, name, label) => [
    ...(candidateBound(doc, entry.candidate) && (doc.candidate_base_css_sha256 ?? null) === (entry.candidate?.base_css_sha256 ?? null)
      ? [] : [`${label}: receipt is not bound to the entry's candidate`]),
    ...validateCombinedAcceptance(doc, name).map(message => message.replace('current', 'successor')),
    ...verifyFaithfulDesignWaivers(doc, name),
  ]},
  {key: 'browser_audit', label: 'browser audit', verify: (doc, entry, name, label) => {
    const records = Array.isArray(doc?.records) ? doc.records : [];
    if (!records.length) return [`${label}: browser audit has no records`];
    return records.every(record => record?.candidate_sha256 === entry.candidate?.candidate_sha256)
      ? [] : [`${label}: browser audit records a candidate other than the entry's`];
  }},
  {key: 'visual_review', label: 'visual review', verify: (doc, entry, name, label) =>
    candidateBound(doc, entry.candidate) ? [] : [`${label}: visual review is not bound to the entry's candidate`]},
];

// C6: the instrument-proper digest. Same construction as
// TARGET_ACCEPTANCE_CONTRACT_SHA256 (src/target-acceptance-contract.mjs),
// with every runtime-derived field replaced by its recorded closure value
// before hashing. Per CLOSURE-ANCHORS (b) there is exactly one such field:
// static_inputs.target_page_runtime_sha256. Mirroring the codebase's own
// runContractWithoutRuntimeBindings precedent, the substitution is total:
// any live framerail value yields the same digest, and only an instrument
// change moves it.
export function computeInstrumentProperDigest({contract = TARGET_ACCEPTANCE_CONTRACT, recordedTargetPageRuntimeSha256 = CLOSURE_ANCHORS.recordedTargetPageRuntimeSha256} = {}) {
  const substituted = {
    ...contract,
    static_inputs: {...contract.static_inputs, target_page_runtime_sha256: recordedTargetPageRuntimeSha256},
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify(substituted)).update('\0')
    .update(JSON.stringify(RUNTIME_SURFACE_PARITY)).update('\0')
    .update([
      collectViewportOverflow, inspectPlatformFonts, measureTargetBaselineViewportOverflow,
      issuesFromSelectorDiagnosis, issuesFromTorture, issuesFromViewports, issuesFromPreview,
      issuesFromInteractions, styleChangesFromComputed, nextActions, summarizeVisual,
      overallAcceptance, applyRuntimeSurfaceParityGate, buildVerdict,
    ].map(fn => fn.toString()).join('\0'))
    .digest('hex');
}

function declaredSourceName(root, packageName) {
  const ledger = readJsonOrNull(path.join(root, LEDGER_PATH));
  const declared = ledger?.packages?.[packageName]?.source_file;
  if (typeof declared === 'string' && declared) return declared;
  return fs.existsSync(path.join(root, 'ports', packageName, 'candidate.wikidot.source.txt')) ? 'candidate.wikidot.source.txt' : 'candidate.wikidot.txt';
}

function candidateBindings(root, packageName, localAssetPathCache = new Map()) {
  const dir = path.join(root, 'ports', packageName);
  const read = name => readFileOrNull(path.join(dir, name));
  const css = read('candidate.css');
  const source = read(declaredSourceName(root, packageName));
  const preview = read('candidate.wikidot.txt');
  let base = null;
  try { base = currentPackageBaseCss(dir, packageName); } catch { base = read('candidate-base.css'); }
  const structure = read('acceptance-structure.json');
  const [runtimeSupportCss, baselineCss] = SHARED_INPUTS.map(relative => readFileOrNull(path.join(root, relative))?.toString('utf8') ?? '');
  const asset = (css && source) ? candidateAssetDependencyState({
    portsDir: path.join(root, 'ports'), themeDir: dir, runtimeSupportCss, baselineCss,
    baseCss: base ?? Buffer.alloc(0), candidateCss: css, candidateSource: source, localAssetPathCache,
  }).asset_dependency_sha256 : null;
  return {
    css_sha256: css ? sha(css) : null,
    source_sha256: source ? sha(source) : null,
    preview_sha256: preview ? sha(preview) : null,
    base_css_sha256: base ? sha(base) : null,
    structure_sha256: structure ? sha(structure) : null,
    asset_dependency_sha256: asset,
    candidate_sha256: css ? candidateIdentity(css, base ?? Buffer.alloc(0)).candidateSha : null,
  };
}

const runGit = (repoRoot, args) => execFileSync('git', ['--literal-pathspecs', ...args], {cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 << 20});
const gitOrNull = (repoRoot, args) => { try { return runGit(repoRoot, args); } catch { return null; } };
const nulList = output => (output ?? '').split('\0').filter(Boolean);

function instrumentDriftFailures(anchors, instrumentContract, liveBrowserVersions, repoRoot) {
  const failures = [];
  const digest = computeInstrumentProperDigest({contract: instrumentContract, recordedTargetPageRuntimeSha256: anchors.recordedTargetPageRuntimeSha256});
  // The live instrument must be the closure instrument or a successor
  // admitted in src/target-acceptance-instruments.mjs; anything else is drift.
  if (digest !== anchors.targetAcceptanceContractSha256 && !TARGET_ACCEPTANCE_INSTRUMENT_SUCCESSORS.some(entry => entry.sha256 === digest)) failures.push('instrument-proper digest differs from the closure anchor (instrument drift)');
  let versions = liveBrowserVersions;
  // An unreadable Playwright registry leaves the file-based digest as the pinned check.
  if (!versions) { try { versions = playwrightBrowserVersions(path.join(repoRoot, 'framerail')); } catch { versions = {}; } }
  for (const [engine, version] of Object.entries(versions)) {
    if (anchors.browserVersions[engine] && version !== anchors.browserVersions[engine]) failures.push(`capture-contract instrument drift: ${engine} browser version ${version} differs from the closure ${anchors.browserVersions[engine]}`);
  }
  return failures;
}

function stateOf(live, closure, entries) {
  if (!entries.length) return sameCandidate(live, closure) ? 'closure' : 'unadmitted';
  return sameCandidate(live, entries.at(-1).candidate) ? 'admitted' : 'unadmitted';
}

export function checkPostClosureAcceptance(root, {
  base = null,
  historicalRoot = DEFAULT_HISTORICAL_ROOT,
  anchors = CLOSURE_ANCHORS,
  instrumentContract = TARGET_ACCEPTANCE_CONTRACT,
  liveBrowserVersions = null,
} = {}) {
  const globalFailures = [];
  const failed = () => ({status: 'fail', base, changed_packages: 0, admitted: 0, packages: [], pending_admission: [], failures: globalFailures});
  if (!base) { globalFailures.push('post-closure check requires --base <commit>'); return failed(); }
  const repoRoot = path.resolve(root, '../../..');
  const themeLabRelative = path.relative(repoRoot, root).split(path.sep).join('/');
  const toRepo = relative => `${themeLabRelative}/${relative}`;
  const fromRepo = repoPath => repoPath.startsWith(`${themeLabRelative}/`) ? repoPath.slice(themeLabRelative.length + 1) : null;
  if (gitOrNull(repoRoot, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]) === null) { globalFailures.push(`--base ${base} does not name a commit`); return failed(); }

  const head = readJsonOrNull(path.join(root, POST_CLOSURE_PATH));
  if (head?.schema !== POST_CLOSURE_SCHEMA || !Array.isArray(head.entries)) { globalFailures.push(`post-closure acceptance record is missing, invalid, or not ${POST_CLOSURE_SCHEMA}`); return failed(); }
  const baseText = gitOrNull(repoRoot, ['show', `${base}:${toRepo(POST_CLOSURE_PATH)}`]);
  const baseDoc = baseText === null ? {entries: []} : parseOrNull(baseText);
  if (baseText !== null && (!BASE_SCHEMAS.has(baseDoc?.schema) || !Array.isArray(baseDoc.entries))) { globalFailures.push('post-closure acceptance record at --base is invalid'); return failed(); }

  const liveLedger = readJsonOrNull(path.join(root, LEDGER_PATH));
  const baseLedger = parseOrNull(gitOrNull(repoRoot, ['show', `${base}:${toRepo(LEDGER_PATH)}`]));
  const names = [...anchors.packages].sort();
  if (Object.keys(liveLedger?.packages ?? {}).sort().join('\0') !== names.join('\0')) globalFailures.push('package roster differs from the closure roster (adding, removing or renaming a package is campaign work)');
  const acceptance = readJsonOrNull(path.join(historicalRoot, 'current-campaign-acceptance.json'));
  if (!acceptance) globalFailures.push('archived acceptance document is unavailable in historical/');
  const closureReceiptSha = new Map((acceptance?.packages ?? []).map(row => [row.package, row.receipt?.sha256]));
  const seenIds = new Set();
  for (const entry of head.entries) {
    if (!names.includes(entry?.package)) globalFailures.push(`successor entry ${entry?.successor_id} names a package outside the closure roster`);
    if (seenIds.has(entry?.successor_id)) globalFailures.push(`successor id ${entry?.successor_id} appears more than once`);
    seenIds.add(entry?.successor_id);
  }

  const realRoot = fs.realpathSync(root);
  const packages = names.map(name => {
    const localAssetPathCache = new Map();
    const live = candidateBindings(root, name, localAssetPathCache);
    const closure = candidateBindings(historicalRoot, name);
    const entries = head.entries.filter(entry => entry?.package === name);
    const baseEntries = baseDoc.entries.filter(entry => entry?.package === name);
    const evidencePaths = [...entries, ...baseEntries].flatMap(entry => EVIDENCE_KINDS.map(kind => entry?.[kind.key]?.path)).filter(value => typeof value === 'string' && value);
    const assetPaths = [...localAssetPathCache.values()].filter(Boolean).map(file => path.relative(realRoot, file).split(path.sep).join('/')).filter(relative => !relative.startsWith('..'));
    return {
      name, live, closure, entries, baseEntries,
      pathspecs: [`ports/${name}`, ...SHARED_INPUTS, ...assetPaths, ...evidencePaths],
      ledgerChanged: canonical(liveLedger?.packages?.[name]) !== canonical(baseLedger?.packages?.[name]),
      entriesChanged: canonical(entries.map(projectV2)) !== canonical(baseEntries.map(projectV2)),
      state: stateOf(live, closure, entries),
      failures: [],
    };
  });

  const union = [...new Set(packages.flatMap(row => row.pathspecs))].map(toRepo);
  const touched = [
    ...nulList(runGit(repoRoot, ['diff', '--no-renames', '--name-only', '-z', base, '--', ...union])),
    ...nulList(runGit(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...union])),
  ].map(fromRepo).filter(Boolean);
  const touches = specs => touched.some(file => specs.some(spec => file === spec || file.startsWith(`${spec}/`)));
  for (const row of packages) row.inScope = row.ledgerChanged || row.entriesChanged || touches(row.pathspecs);

  const inScope = packages.filter(row => row.inScope);
  const evidenceToCheck = inScope.flatMap(row => row.entries.flatMap(entry => EVIDENCE_KINDS.map(kind => entry[kind.key]?.path))).filter(value => typeof value === 'string' && value);
  // With no pathspec, ls-files would list the whole index.
  const tracked = new Set(evidenceToCheck.length ? nulList(runGit(repoRoot, ['ls-files', '-z', '--', ...evidenceToCheck.map(toRepo)])).map(fromRepo) : []);
  let instrumentFailures = null;
  for (const row of inScope) {
    const fail = message => row.failures.push(message);
    const {name, entries} = row;
    const headById = new Map(entries.map(entry => [entry?.successor_id, entry]));
    for (const baseEntry of row.baseEntries) {
      const now = headById.get(baseEntry.successor_id);
      if (!now) fail(`${name}: successor entry ${baseEntry.successor_id} present at --base was removed`);
      else if (canonical(projectV2(baseEntry)) !== canonical(now)) fail(`${name}: successor entry ${baseEntry.successor_id} present at --base was rewritten`);
    }
    entries.forEach((entry, index) => {
      const label = `${name}: successor ${entry.successor_id}`;
      if (Object.keys(entry).sort().join('\0') !== [...V2_KEYS].sort().join('\0')) fail(`${label}: entry keys are not the v2 shape`);
      const previous = entries[index - 1];
      const expectedPredecessor = previous
        ? {kind: 'successor', receipt_sha256: previous.receipt?.sha256}
        : {kind: 'closure', receipt_sha256: closureReceiptSha.get(name)};
      if (canonical(entry.predecessor) !== canonical(expectedPredecessor)) fail(`${label}: predecessor does not bind the ${expectedPredecessor.kind} receipt`);
      if (sameCandidate(entry.candidate, previous ? previous.candidate : row.closure)) fail(`${label}: candidate equals its predecessor's, so the entry admits nothing`);
      for (const kind of EVIDENCE_KINDS) {
        const binding = entry[kind.key];
        const bytes = binding?.path ? readFileOrNull(path.join(root, binding.path)) : null;
        if (!bytes) { fail(`${label}: ${kind.label} ${binding?.path ?? '(no path)'} is unavailable`); continue; }
        if (sha(bytes) !== binding.sha256) { fail(`${label}: ${kind.label} ${binding.path} does not match its recorded sha256`); continue; }
        if (!tracked.has(binding.path)) fail(`${label}: ${kind.label} ${binding.path} is not tracked in Git; successor evidence must be committed`);
        const doc = parseOrNull(bytes.toString('utf8'));
        if (!doc) { fail(`${label}: ${kind.label} is invalid JSON`); continue; }
        row.failures.push(...kind.verify(doc, entry, name, label));
      }
    });
    if (row.state === 'unadmitted') fail(`${name}: candidate changed since its latest admitted identity without a successor entry naming it`);
    const baseIds = new Set(row.baseEntries.map(entry => entry.successor_id));
    if (entries.some(entry => !baseIds.has(entry.successor_id))) {
      instrumentFailures ??= instrumentDriftFailures(anchors, instrumentContract, liveBrowserVersions, repoRoot);
      for (const message of instrumentFailures) fail(`${name}: ${message}`);
    }
  }

  const failures = [...globalFailures, ...inScope.flatMap(row => row.failures)];
  return {
    status: failures.length ? 'fail' : 'pass',
    base,
    changed_packages: packages.filter(row => !sameCandidate(row.live, row.closure)).length,
    admitted: packages.filter(row => row.state === 'admitted').length,
    packages: packages.map(row => ({
      package: row.name, in_scope: row.inScope, state: row.state,
      successor_id: row.entries.at(-1)?.successor_id ?? null, failures: row.failures,
    })),
    pending_admission: packages.filter(row => !row.inScope && row.state === 'unadmitted').map(row => row.name),
    failures,
  };
}
