import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildCrossSiteCoverageQuery,
  buildIntegrityQuery,
  readIntegrityManifest,
  readMirrorScope,
  verifyCrossSiteCoverage,
  verifyIntegrityRows,
} from '../scripts/verify-corpus-import-integrity.mjs';

function manifestRow(root, fullname, source) {
  const sourcePath = path.join(root, `${fullname}.wikidot.txt`);
  const bytes = Buffer.from(source, 'utf8');
  fs.writeFileSync(sourcePath, bytes);
  return {
    fullname,
    source_path: sourcePath,
    source_sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    source_bytes: bytes.length,
  };
}

test('integrity manifest validates source bytes and exact slug selection', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-integrity-'));
  const rows = [manifestRow(root, 'scp-173', 'コンテンツ\n'), manifestRow(root, 'scp-174', 'Second')];
  const text = rows.map((row) => JSON.stringify(row)).join('\n');

  assert.deepEqual(readIntegrityManifest(text, ['scp-174']), [rows[1]]);
  assert.throws(() => readIntegrityManifest(text, ['scp-999']), /does not contain selected page scp-999/);
  fs.writeFileSync(rows[0].source_path, 'changed');
  assert.throws(() => readIntegrityManifest(text, ['scp-173']), /source_path hash mismatch/);
});

test('integrity query safely requests selected pages and retrieves provenance and body length', () => {
  const query = buildIntegrityQuery({siteId: 6000006}, [{fullname: "scp-'173", source_site: "scp-wiki"}]);
  assert.match(query, /named\.site_id = 6000006/);
  assert.match(query, /\('scp-''173', 'scp-wiki'\)/);
  assert.match(
    query,
    /held_snapshot\.source_site = requested\.source_site\n      AND held_snapshot\.source_fullname = requested\.slug/,
    'a foreign row resolves to the page holding its own snapshot before any page of the same name',
  );
  assert.match(query, /ORDER BY candidate\.priority, candidate\.page_id/);
  assert.match(query, /wikidot_page_snapshot/);
  assert.match(query, /wikidot_corpus_import_item/);
  assert.match(query, /translate\(encode\(convert_to\(source\.contents, 'UTF8'\), 'base64'\), E'\\n', ''\)/);
  assert.match(query, /scp-''173/);
});

test('integrity report passes matching source, provenance, import state, and required body', () => {
  const bytes = Buffer.from('SCP-173\n', 'utf8');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const rows = [{fullname: 'scp-173', source_sha256: sha}];
  const result = verifyIntegrityRows(rows, `scp-173|30000001|30000002|${bytes.toString('base64')}|${sha}|42|done`, {
    renderedBodySlugs: ['scp-173'],
  });

  assert.equal(result.status, 'pass');
  assert.deepEqual(result.failures, []);
  assert.equal(result.pages[0].current_source_matches_manifest, true);
  assert.equal(result.pages[0].provenance_matches_manifest, true);
  assert.equal(result.pages[0].rendered_body_characters, 42);
});

test('integrity report does not accept a shell-ready page as a completed import', () => {
  const bytes = Buffer.from('SCP-173\n', 'utf8');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  const result = verifyIntegrityRows(
    [{fullname: 'scp-173', source_sha256: sha}],
    `scp-173|30000001|30000002|${bytes.toString('base64')}|${sha}|42|shell_ready`,
    {renderedBodySlugs: ['scp-173']},
  );

  assert.equal(result.status, 'fail');
  assert.deepEqual(result.failures.map((failure) => failure.reason), ['import_not_done:shell_ready']);
});

test('integrity report fails closed for missing pages and source, provenance, import, or body mismatches', () => {
  const bytes = Buffer.from('\n', 'utf8');
  const sha = crypto.createHash('sha256').update('real source').digest('hex');
  const rows = [
    {fullname: 'blank-page', source_sha256: sha},
    {fullname: 'missing-page', source_sha256: sha},
  ];
  const result = verifyIntegrityRows(rows, `blank-page|30000003|30000004|${bytes.toString('base64')}|${'0'.repeat(64)}|0|failed`, {
    renderedBodySlugs: ['blank-page'],
  });

  assert.equal(result.status, 'fail');
  assert.deepEqual(result.failures.map((failure) => failure.reason), [
    'current_source_mismatch',
    'missing_or_mismatched_provenance',
    'import_not_done:failed',
    'rendered_body_empty',
    'missing_page',
  ]);
});

test('integrity report treats consumed slugs as reconciled instead of missing', () => {
  const sha = crypto.createHash('sha256').update('real source').digest('hex');
  const rows = [
    {fullname: 'tombstoned', source_sha256: sha},
    {fullname: 'renamed-away', source_sha256: sha},
    {fullname: 'truly-missing', source_sha256: sha},
  ];
  const scope = readMirrorScope(JSON.stringify({declared_extras: [], consumed_slugs: ['tombstoned', 'renamed-away']}));
  const result = verifyIntegrityRows(rows, '', {mirrorScope: scope});

  assert.equal(result.status, 'fail');
  assert.deepEqual(result.failures, [{slug: 'truly-missing', reason: 'missing_page'}]);
  assert.deepEqual(result.pages.map((page) => [page.slug, page.consumed === true]), [
    ['tombstoned', true],
    ['renamed-away', true],
    ['truly-missing', false],
  ]);
});

test('integrity report without a mirror scope still fails missing pages', () => {
  const sha = crypto.createHash('sha256').update('real source').digest('hex');
  const result = verifyIntegrityRows([{fullname: 'tombstoned', source_sha256: sha}], '');
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.failures, [{slug: 'tombstoned', reason: 'missing_page'}]);
});

test('mirror scope snapshot requires slug arrays', () => {
  assert.deepEqual(readMirrorScope('{"declaredExtras": ["a"], "consumedSlugs": ["b"]}'), {declaredExtras: ['a'], consumedSlugs: ['b']});
  assert.throws(() => readMirrorScope('{"declared_extras": "a"}'), /must carry declared_extras and consumed_slugs arrays/);
});

test('integrity report rejects malformed numeric fields instead of treating them as usable evidence', () => {
  const bytes = Buffer.from('source', 'utf8');
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  assert.throws(() => verifyIntegrityRows(
    [{fullname: 'scp-173', source_sha256: sha}],
    `scp-173|30000001|30000002|${bytes.toString('base64')}|${sha}|not-a-length|done`,
  ), /invalid numeric fields for scp-173/);
});

test('cross-site coverage verifies materialization per attributed row', () => {
  const rows = [
    { fullname: 'comp', source_site: 'snippets', source_branch: 'snippets', source_fullname: 'comp' },
    { fullname: 'theme:x', source_site: 'scpsandbox2', source_branch: 'sandbox', source_fullname: 'theme:x' },
  ];
  const attribution = {
    'scp-1': { rows: ['snippets:comp'], gaps: 0, truncated: [] },
    'scp-2': { rows: ['snippets:comp', 'sandbox:theme:x'], gaps: 0, truncated: [] },
    'scp-3': { rows: [], gaps: 1, truncated: [] },
  };
  const output = ['snippets|comp|1', 'scpsandbox2|theme:x|0'].join('\n');
  const report = verifyCrossSiteCoverage(rows, attribution, output);
  assert.equal(report.status, 'fail');
  assert.deepEqual(report.pages.map((page) => page.slug), ['scp-1', 'scp-2', 'scp-3']);
  assert.equal(report.pages[0].missing_dependency_count, 0);
  assert.equal(report.pages[1].missing_dependency_count, 1);
  assert.equal(report.pages[2].gap_count, 1);
  assert.deepEqual(
    report.failures.map((failure) => [failure.slug, failure.reason]),
    [['scp-2', 'unresolved_dependencies'], ['scp-3', 'dependency_gaps']],
  );
});

test('cross-site coverage passes when every attributed row is materialized', () => {
  const rows = [{ fullname: 'comp', source_site: 'snippets', source_branch: 'snippets' }];
  const attribution = { 'scp-1': { rows: ['snippets:comp'], gaps: 0, truncated: [] } };
  const report = verifyCrossSiteCoverage(rows, attribution, 'snippets|comp|2');
  assert.equal(report.status, 'pass');
  assert.deepEqual(report.failures, []);
});

test('cross-site coverage rejects malformed query output and unknown manifest rows', () => {
  const rows = [{ fullname: 'comp', source_site: 'snippets', source_branch: 'snippets' }];
  assert.throws(() => verifyCrossSiteCoverage(rows, {}, 'snippets|comp'), /malformed row/u);
  const report = verifyCrossSiteCoverage(rows, { 'scp-1': { rows: ['snippets:gone'], gaps: 0, truncated: [] } }, '');
  assert.equal(report.status, 'fail');
  assert.equal(report.failures[0].missing[0].reason, 'row_not_in_manifest');
});

test('cross-site coverage query matches foreign snapshot identities on the target site', () => {
  const sql = buildCrossSiteCoverageQuery(
    { siteId: 6000006 },
    [{ fullname: 'comp', source_site: 'snippets', source_branch: 'snippets', source_fullname: 'comp' }],
  );
  assert.match(sql, /wikidot_page_snapshot/u);
  assert.match(sql, /snapshot\.source_site = requested\.source_site/u);
  assert.match(sql, /snapshot\.source_fullname = requested\.source_fullname/u);
  assert.match(sql, /page\.site_id = 6000006/u);
});
