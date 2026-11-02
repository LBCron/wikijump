import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {PUBLISHABLE_AUTHORITIES, verifyEvidence} from '../src/adaptation-authority.mjs';
import {
  authorityReceiptBindings, CERTIFIED_AUTHORITIES, deriveAuthorityInventory, ledgerRoots, MissingAuthorityBlobs, PORTS_PREFIX,
} from '../src/authority-evidence-closure.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fixtures = name => fileURLToPath(new URL(`./fixtures/${name}/`, import.meta.url));
const URL_SCP = 'https://scp-jp.wikidot.com/scp-173';
const visible = {rect: {width: 100, height: 40}, style: {visibility: 'visible', display: 'block'}};

// Ports-relative path -> bytes for a ledger whose certified evidence is three
// A/B receipts: a plain one, one binding native History, one binding a native
// page preview. Every artifact the gate reads is written exactly once.
function buildEvidence() {
  const files = new Map();
  const put = (rel, bytes) => { files.set(rel, Buffer.from(bytes)); return sha(bytes); };
  const replayObject = put(`authority-evidence/replay/objects/${sha('script').slice(0, 2)}/${sha('script')}`, 'script');
  const archive = (dir, name) => ({path: name, sha256: put(`${dir}/${name}`, `source ${name}`)});
  const captures = (dir, state, measurement) => ['without', 'with'].flatMap(variant => {
    const ok = variant === 'with';
    const shot = put(`${dir}/${variant}.png`, `${dir}-${variant}-shot`), dom = put(`${dir}/${variant}.html`, `${dir}-${variant}-dom`);
    return [{variant, state, width: 390, index: 0, pass: ok, css_sha256: 'b'.repeat(64), bounds: [{pass: ok}], measurement,
      screenshot: `${variant}.png`, screenshot_sha256: shot, dom: `${variant}.html`, dom_sha256: dom}];
  });
  const receipt = (dir, rows, extra = {}) => put(`${dir}/receipt.json`, JSON.stringify({
    schema: 'theme_lab_wikidot_adaptation_ab.v1', public_writes: 0, external_browser_requests: 0, url: URL_SCP, site: 'scp-jp.wikidot.com',
    observed_at: '2026-10-07T00:00:00Z', snapshot: {entry: '/o/fixture', object_digests: [replayObject]}, rows, ...extra,
  }));

  const plainDir = 'authority-evidence/proof/plain';
  const plain = receipt(plainDir, captures(plainDir, 'normal', {document_width: 390, rows: [{selector: 'a', text: 'menu'}]}), {archived_sources: [archive(plainDir, 'measurement-a.mjs')]});

  const historyDir = 'authority-evidence/proof/history';
  const historyFixture = JSON.parse(fs.readFileSync(path.join(fixtures('frozen-history-authority'), 'receipt.json'), 'utf8'));
  for (const entry of historyFixture.frozen_history_replay.bindings) for (const key of ['receipt', 'response']) put(`${historyDir}/${entry[key]}`, fs.readFileSync(path.join(fixtures('frozen-history-authority'), entry[key])));
  const history = receipt(historyDir, captures(historyDir, 'history-list', {rows: [{selector: '#revision-list', ...visible}]}), {
    archived_sources: [archive(historyDir, 'measurement-frozen-history-replay.mjs')], frozen_history_replay: historyFixture.frozen_history_replay,
  });

  const previewDir = 'authority-evidence/proof/preview';
  const previewReceipt = put(`${previewDir}/preview-receipt.json`, fs.readFileSync(path.join(fixtures('native-page-preview'), 'receipt.json')));
  const previewResponse = put(`${previewDir}/preview-response.json`, fs.readFileSync(path.join(fixtures('native-page-preview'), 'response.json')));
  const preview = receipt(previewDir, captures(previewDir, 'article-table', {rows: [visible]}), {
    archived_sources: [archive(previewDir, 'measurement-frozen-page-preview-replay.mjs')],
    frozen_page_preview: {receipt: 'preview-receipt.json', receipt_sha256: previewReceipt, response: 'preview-response.json', response_sha256: previewResponse, dependencies: [{url: 'https://example.invalid/script.js', sha256: replayObject}]},
  });

  // A block downgraded from certification keeps its receipt hash-pinned but
  // the gate never opens it, so its nested files are not part of the closure.
  const retainedDir = 'authority-evidence/proof/retained';
  const retained = put(`${retainedDir}/receipt.json`, JSON.stringify({
    schema: 'theme_lab_wikidot_adaptation_ab.v1', snapshot: {object_digests: [sha('absent-object')]},
    rows: [{screenshot: 'gone.png', screenshot_sha256: sha('gone'), dom: 'gone.html', dom_sha256: sha('gone-dom')}],
  }));
  const note = put('authority-evidence/proof/note.txt', 'source theme proof');
  const rows = [
    {marker: 'certified', authority: 'TARGET_WIKIDOT_CERTIFIED', evidence: [
      {path: `${plainDir}/receipt.json`, sha256: plain}, {path: `${historyDir}/receipt.json`, sha256: history}, {path: `${previewDir}/receipt.json`, sha256: preview}]},
    {marker: 'retained', authority: 'RUNTIME_INDEPENDENT', evidence: [{path: `${retainedDir}/receipt.json`, sha256: retained}]},
    {marker: 'source', authority: 'SOURCE_THEME', evidence: [{path: 'authority-evidence/proof/note.txt', sha256: note}]},
  ];
  return {files, rows};
}

function withPortsRoot(rows, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-authority-closure-'));
  try {
    fs.writeFileSync(path.join(root, 'adaptation-authority.json'), JSON.stringify({packages: {fixture: {blocks: rows}}}));
    return run(root);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

const memoryReader = (files, hidden = new Set()) => (relative, hash) => {
  const rel = relative.slice(PORTS_PREFIX.length);
  const bytes = files.get(rel);
  return bytes && !hidden.has(rel) && sha(bytes) === hash ? bytes : null;
};

function materialize(inventory, files, destination) {
  for (const entry of inventory.files) {
    const target = path.join(destination, entry.relative_path.slice(PORTS_PREFIX.length));
    fs.mkdirSync(path.dirname(target), {recursive: true});
    fs.writeFileSync(target, files.get(entry.relative_path.slice(PORTS_PREFIX.length)));
  }
}

test('the derived inventory is exactly what the gate needs: it passes, and dropping any derived file fails it', () => {
  const {files, rows} = buildEvidence();
  withPortsRoot(rows, portsRoot => {
    const inventory = deriveAuthorityInventory({portsRoot, readBlob: memoryReader(files)});
    assert.equal(inventory.schema, 'wikijump.theme_lab_authority_archive_supplement_inventory.v1');
    const paths = inventory.files.map(entry => entry.relative_path);
    assert.deepEqual(paths, [...paths].sort());
    assert.equal(new Set(paths).size, paths.length, 'the replay object shared by two receipts is listed once');
    for (const needed of [
      'plain/without.png', 'plain/with.html', 'plain/measurement-a.mjs', 'history/native-history-response-0.json', 'history/native-history-acquisition-1.json',
      'preview/preview-receipt.json', 'preview/preview-response.json', 'preview/measurement-frozen-page-preview-replay.mjs',
    ]) assert.ok(paths.includes(`${PORTS_PREFIX}authority-evidence/proof/${needed}`), needed);
    assert.ok(paths.some(item => item.includes('/replay/objects/')));
    assert.ok(paths.includes(`${PORTS_PREFIX}authority-evidence/proof/retained/receipt.json`));
    assert.ok(!paths.some(item => item.includes('retained/gone') || item.includes(sha('absent-object'))), 'a non-certified receipt contributes no nested files');
    const rootRows = inventory.files.filter(entry => entry.ledger_root);
    assert.deepEqual(rootRows.map(entry => entry.relative_path.slice(PORTS_PREFIX.length)).sort(), [...ledgerRoots({rows}).keys()].sort());
    for (const entry of inventory.files) {
      assert.equal(entry.ledger_hash_verified, entry.ledger_root ? true : null);
      assert.equal(entry.size_bytes, files.get(entry.relative_path.slice(PORTS_PREFIX.length)).length);
      assert.equal(entry.sha256, sha(files.get(entry.relative_path.slice(PORTS_PREFIX.length))));
    }

    const destination = fs.mkdtempSync(path.join(os.tmpdir(), 'theme-authority-restored-'));
    try {
      materialize(inventory, files, destination);
      verifyEvidence(rows, destination, {sharedRoot: null});
      for (const entry of inventory.files) {
        const target = path.join(destination, entry.relative_path.slice(PORTS_PREFIX.length));
        const bytes = fs.readFileSync(target);
        fs.rmSync(target);
        assert.throws(() => verifyEvidence(rows, destination, {sharedRoot: null}), undefined, `dropping ${entry.relative_path} must fail the gate`);
        fs.writeFileSync(target, bytes);
      }
      verifyEvidence(rows, destination, {sharedRoot: null});
    } finally { fs.rmSync(destination, {recursive: true, force: true}); }
  });
});

test('missing blobs are reported together, with path and hash', () => {
  const {files, rows} = buildEvidence();
  withPortsRoot(rows, portsRoot => {
    const hidden = new Set(['authority-evidence/proof/plain/with.png', 'authority-evidence/proof/preview/preview-response.json']);
    assert.throws(() => deriveAuthorityInventory({portsRoot, readBlob: memoryReader(files, hidden)}), error => {
      assert.ok(error instanceof MissingAuthorityBlobs);
      assert.deepEqual(error.missing.map(item => item.relative_path), [...hidden].sort().map(rel => PORTS_PREFIX + rel));
      for (const item of error.missing) assert.equal(item.sha256, sha(files.get(item.relative_path.slice(PORTS_PREFIX.length))));
      assert.match(error.message, /plain\/with\.png [a-f0-9]{64}/u);
      return true;
    });
    const noReceipt = new Set(['authority-evidence/proof/history/receipt.json']);
    assert.throws(() => deriveAuthorityInventory({portsRoot, readBlob: memoryReader(files, noReceipt)}), /history\/receipt\.json/u);
  });
});

test('statBlob supplies sizes for non-receipt files without reading their bytes', () => {
  const {files, rows} = buildEvidence();
  withPortsRoot(rows, portsRoot => {
    const readJson = memoryReader(files), statted = [];
    const readBlob = (relative, hash) => { assert.ok(relative.endsWith('.json'), `only JSON roots are read: ${relative}`); return readJson(relative, hash); };
    const statBlob = (relative, hash) => { statted.push(relative); return readJson(relative, hash)?.length ?? null; };
    const inventory = deriveAuthorityInventory({portsRoot, readBlob, statBlob});
    assert.ok(statted.length > 0);
    assert.equal(inventory.files.length, new Set(inventory.files.map(entry => entry.relative_path)).size);
    const withStat = deriveAuthorityInventory({portsRoot, readBlob: readJson});
    assert.deepEqual(inventory, withStat);
  });
});

test('one path bound to two different hashes is an error', () => {
  const {files, rows} = buildEvidence();
  const conflicting = [...rows, {marker: 'conflict', authority: 'SOURCE_THEME', evidence: [{path: 'authority-evidence/proof/plain/with.png', sha256: 'c'.repeat(64)}]}];
  withPortsRoot(conflicting, portsRoot => {
    assert.throws(() => deriveAuthorityInventory({portsRoot, readBlob: memoryReader(files)}), /conflicting hashes for authority artifact: authority-evidence\/proof\/plain\/with\.png/u);
  });
  assert.throws(() => ledgerRoots({a: {path: 'authority-evidence/x', sha256: 'a'.repeat(64)}, b: {path: 'authority-evidence/x', sha256: 'b'.repeat(64)}}), /conflicting ledger authority identity/u);
});

test('only A/B receipts bind nested files, and bound paths cannot leave the ports root', () => {
  assert.deepEqual(authorityReceiptBindings({schema: 'theme_lab_native_page_preview.v1', rows: [{screenshot: 'x.png', screenshot_sha256: 'a'.repeat(64)}]}, 'authority-evidence/x/receipt.json'), []);
  const escaping = {schema: 'theme_lab_wikidot_adaptation_ab.v1', snapshot: {object_digests: []}, rows: [{screenshot: '../../../outside.png', screenshot_sha256: 'a'.repeat(64), dom: 'd.html', dom_sha256: 'b'.repeat(64)}]};
  assert.throws(() => authorityReceiptBindings(escaping, 'authority-evidence/x/receipt.json'), /escapes root/u);
});

test('the closure expands exactly the authorities verifyEvidence opens as receipts', () => {
  assert.deepEqual([...CERTIFIED_AUTHORITIES].sort(), [...PUBLISHABLE_AUTHORITIES].filter(authority => authority.includes('CERTIFIED')).sort());
});
