import fs from 'node:fs';
import path from 'node:path';

// What the adaptation-authority gate reads is fully determined by the tracked
// ledger (every {path, sha256} under authority-evidence/ or shared-fixtures/)
// plus the files each A/B receipt binds by hash, for the receipts that
// certified blocks cite. Evidence of other blocks (for example a block
// downgraded to RUNTIME_INDEPENDENT) is only hash-pinned, never opened. This module is the one
// enumeration of the second half; verifyEvidence in adaptation-authority.mjs
// hash-checks `nestedArtifactBindings`, and the restore inventory is derived
// from `authorityReceiptBindings`, so the two cannot drift.

export const AB_RECEIPT_SCHEMA = 'theme_lab_wikidot_adaptation_ab.v1';
export const INVENTORY_SCHEMA = 'wikijump.theme_lab_authority_archive_supplement_inventory.v1';
export const PORTS_PREFIX = 'install/local/theme-lab/ports/';
const REPLAY_OBJECTS = 'authority-evidence/replay/objects';
const LEDGER_PREFIXES = ['authority-evidence/', 'shared-fixtures/'];
const SHA = /^[a-f0-9]{64}$/u;

// The authorities whose evidence verifyEvidence opens as an A/B receipt.
export const CERTIFIED_AUTHORITIES = new Set(['SOURCE_AND_TARGET_CERTIFIED', 'TARGET_WIKIDOT_CERTIFIED']);

export const isAuthorityReceipt = value => value?.schema === AB_RECEIPT_SCHEMA;

// Paths are relative to the ports root, normalized, and never leave it.
function binding(baseDir, file, sha256, label) {
  if (typeof file !== 'string' || !file) throw new Error(`${label}: missing path`);
  if (path.posix.isAbsolute(file)) throw new Error(`${label} must be relative to its receipt: ${file}`);
  const relative_path = path.posix.normalize(path.posix.join(baseDir, file));
  if (relative_path === '.' || relative_path === '..' || relative_path.startsWith('../')) throw new Error(`${label} escapes root: ${file}`);
  if (!SHA.test(sha256 ?? '')) throw new Error(`unbound ${label}: ${file}`);
  return {relative_path, sha256};
}

const replayObject = (hash, label) => binding('', `${REPLAY_OBJECTS}/${String(hash).slice(0, 2)}/${hash}`, hash, label);
const receiptDirectory = receiptPath => path.posix.dirname(receiptPath);

// Hash-checked by verifyEvidence itself.
export function nestedArtifactBindings(receipt, receiptPath) {
  if (!isAuthorityReceipt(receipt)) return [];
  const dir = receiptDirectory(receiptPath), found = [];
  for (const capture of receipt.rows ?? []) {
    found.push(binding(dir, capture.screenshot, capture.screenshot_sha256, 'authority screenshot'));
    found.push(binding(dir, capture.dom, capture.dom_sha256, 'authority dom'));
  }
  for (const source of receipt.archived_sources ?? []) found.push(binding(dir, source.path, source.sha256, 'authority measurement source'));
  if (!Array.isArray(receipt.snapshot?.object_digests)) throw new Error('authority receipt lacks snapshot object digests');
  for (const hash of receipt.snapshot.object_digests) found.push(replayObject(hash, 'frozen Wikidot replay object'));
  return found;
}

// Content-validated (not just hashed) by verifyFrozenHistoryAuthority and
// verifyFrozenPagePreviewAuthority, which read these same paths.
export function replayArtifactBindings(receipt, receiptPath) {
  if (!isAuthorityReceipt(receipt)) return [];
  const dir = receiptDirectory(receiptPath), found = [];
  const artifactPair = (entry, label) => {
    found.push(binding(dir, entry.receipt, entry.receipt_sha256, `${label} receipt`));
    found.push(binding(dir, entry.response, entry.response_sha256, `${label} response`));
  };
  for (const entry of receipt.frozen_history_replay?.bindings ?? []) artifactPair(entry, 'native history');
  const preview = receipt.frozen_page_preview;
  if (preview) {
    artifactPair(preview, 'native preview');
    for (const dependency of preview.dependencies ?? []) found.push(replayObject(dependency.sha256, 'native preview script'));
  }
  return found;
}

function unique(bindings) {
  const byPath = new Map();
  for (const item of bindings) {
    const prior = byPath.get(item.relative_path);
    if (prior && prior.sha256 !== item.sha256) throw new Error(`conflicting hashes for authority artifact: ${item.relative_path}`);
    byPath.set(item.relative_path, item);
  }
  return [...byPath.values()];
}

export function authorityReceiptBindings(receipt, receiptPath) {
  return unique([...nestedArtifactBindings(receipt, receiptPath), ...replayArtifactBindings(receipt, receiptPath)]);
}

// Same walk as ledger_roots() in scripts/restore-authority-evidence.py.
export function ledgerRoots(ledger) {
  const found = new Map();
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== 'object') return;
    const {path: file, sha256} = value;
    if (typeof file === 'string' && LEDGER_PREFIXES.some(prefix => file.startsWith(prefix)) && typeof sha256 === 'string' && SHA.test(sha256)) {
      if (found.has(file) && found.get(file) !== sha256) throw new Error(`conflicting ledger authority identity: ${file}`);
      found.set(file, sha256);
    }
    Object.values(value).forEach(walk);
  };
  walk(ledger);
  return found;
}

export function certifiedReceiptPaths(ledger) {
  const paths = new Set();
  for (const pkg of Object.values(ledger.packages ?? {})) {
    for (const block of pkg.blocks ?? []) {
      if (CERTIFIED_AUTHORITIES.has(block.authority)) for (const evidence of block.evidence ?? []) paths.add(evidence.path);
    }
  }
  return paths;
}

export class MissingAuthorityBlobs extends Error {
  constructor(missing) {
    super(`${missing.length} authority evidence file(s) are not in the store or checkout:\n${missing.map(item => `  ${item.relative_path} ${item.sha256}`).join('\n')}`);
    this.missing = missing;
  }
}

// readBlob(relative_path, sha256) -> verified bytes | null. It is used for the
// root files that may be A/B receipts. statBlob(relative_path, sha256) ->
// size | null is optional and used for every other file, where only existence
// and size matter: the restore step hashes every inventory object itself, so
// re-hashing gigabytes of screenshots here would only repeat that work.
export function deriveAuthorityInventory({portsRoot, readBlob, statBlob}) {
  const ledger = JSON.parse(fs.readFileSync(path.join(portsRoot, 'adaptation-authority.json'), 'utf8'));
  const roots = ledgerRoots(ledger), certified = certifiedReceiptPaths(ledger);
  for (const receipt of certified) if (!roots.has(receipt)) throw new Error(`certified authority evidence is not a ledger root: ${receipt}`);
  const claimed = new Map(), files = [], missing = [], pending = [];
  const claim = (relative_path, sha256) => {
    if (claimed.has(relative_path) && claimed.get(relative_path) !== sha256) throw new Error(`conflicting hashes for authority artifact: ${relative_path}`);
    const fresh = !claimed.has(relative_path);
    claimed.set(relative_path, sha256);
    return fresh;
  };
  const lost = (relative_path, sha256) => { missing.push({relative_path: PORTS_PREFIX + relative_path, sha256}); return null; };
  const sizeOf = (relative_path, sha256) => {
    const size = statBlob ? statBlob(PORTS_PREFIX + relative_path, sha256) : readBlob(PORTS_PREFIX + relative_path, sha256)?.length;
    return size ?? lost(relative_path, sha256);
  };
  const record = (relative_path, sha256, size_bytes, isRoot) => files.push({
    relative_path: PORTS_PREFIX + relative_path, sha256, size_bytes,
    ledger_root: isRoot, ledger_hash_verified: isRoot ? true : null,
  });

  for (const [relative_path, sha256] of roots) {
    claim(relative_path, sha256);
    let size;
    if (relative_path.endsWith('.json')) {
      const bytes = readBlob(PORTS_PREFIX + relative_path, sha256);
      if (!bytes) { lost(relative_path, sha256); continue; }
      size = bytes.length;
      let receipt = null;
      try { receipt = JSON.parse(bytes.toString('utf8')); } catch { /* a non-JSON root has no nested bindings */ }
      if (certified.has(relative_path)) pending.push(...authorityReceiptBindings(receipt, relative_path));
    } else {
      size = sizeOf(relative_path, sha256);
      if (size === null) continue;
    }
    record(relative_path, sha256, size, true);
  }

  for (const item of pending) {
    if (!claim(item.relative_path, item.sha256)) continue;
    const size = sizeOf(item.relative_path, item.sha256);
    if (size !== null) record(item.relative_path, item.sha256, size, false);
  }

  const byPath = (a, b) => a.relative_path < b.relative_path ? -1 : 1;
  if (missing.length) throw new MissingAuthorityBlobs(missing.sort(byPath));
  return {schema: INVENTORY_SCHEMA, files: files.sort(byPath)};
}
