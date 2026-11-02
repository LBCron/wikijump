import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCorpusImportManifest,
  buildCrossSiteDependencyManifest,
  buildManifestSummary,
  formatJsonl,
  summarizeCrossSiteCoverage,
} from "../src/corpus-import-manifest.mjs";
import {
  cryptoSha256,
  writePage,
  writePageAttachment,
} from "./support/corpus-import-manifest-fixture.mjs";

test('buildCorpusImportManifest emits deterministic rows and summary', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-manifest-'));
  writePage(root, 'en', 'scp-173', {
    entityId: '11111111-1111-4111-8111-111111111111',
    source: '[[module Rate]]\nSCP-173',
  });
  writePage(root, 'en', 'component:license-box', {
    entityId: '22222222-2222-4222-8222-222222222222',
    meta: {
      fullname: 'component:license-box',
      title: 'License Box',
      title_shown: 'License Box',
      parent_fullname: 'scp-173',
      rating: 0,
      revisions: 3,
      tags: ['component'],
    },
    source: 'license component',
  });

  const rows = buildCorpusImportManifest({
    corpusRoot: root,
    branch: 'en',
    sourceSite: 'scp-wiki',
    sourceBranch: 'en',
  });
  const jsonl = formatJsonl(rows);
  const summary = buildManifestSummary(rows, jsonl);

  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.fullname), ['component:license-box', 'scp-173']);
  assert.equal(rows[1].source_site, 'scp-wiki');
  assert.equal(rows[1].rating, 10634);
  assert.deepEqual(rows[1].tags, ['euclid', 'scp']);
  assert.match(rows[1].source_sha256, /^[0-9a-f]{64}$/);
  assert.equal(summary.row_count, 2);
  assert.equal(summary.parent_count, 1);
  assert.match(summary.manifest_sha256, /^[0-9a-f]{64}$/);
  assert.equal(formatJsonl(rows), jsonl, 'formatting should be deterministic');
});

test('buildCorpusImportManifest keeps the page-and-attachment scope separate from site settings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-manifest-'));
  const bytes = Buffer.from([1, 2, 3, 4]);
  writePage(root, 'en', 'scp-173', {
    entityId: '12121212-1212-4121-8121-121212121212',
    meta: {
      welcome_page: 'system:welcome',
      settings_revision: 17,
    },
    source: '[[image https://scp-wiki.wikidot.com/local--files/scp-173/pixel.png]]',
  });
  writePageAttachment(root, 'en', 'scp-173', {
    filename: 'pixel.png',
    bytes,
    originalUrl: 'https://scp-wiki.wikidot.com/local--files/scp-173/pixel.png',
    mimeDescription: 'PNG image data, 1 x 1, 8-bit/color RGBA, non-interlaced',
  });

  const rows = buildCorpusImportManifest({
    corpusRoot: root,
    branch: 'en',
    sourceSite: 'scp-wiki',
    sourceBranch: 'en',
  });
  const jsonl = formatJsonl(rows);
  const summary = buildManifestSummary(rows, jsonl);

  assert.equal(rows.length, 1);
  assert.equal(Object.hasOwn(rows[0], 'welcome_page'), false);
  assert.equal(Object.hasOwn(rows[0], 'settings_revision'), false);
  assert.doesNotMatch(jsonl, /welcome_page|settings_revision/u);
  assert.equal(rows[0].attachments.length, 1);
  assert.deepEqual(rows[0].attachments[0], {
    filename: 'pixel.png',
    original_url: 'https://scp-wiki.wikidot.com/local--files/scp-173/pixel.png',
    wikidot_path: '/local--files/scp-173/pixel.png',
    sha256: cryptoSha256(bytes),
    size: 4,
    mime: 'image/png',
    content_type_description: 'PNG image data, 1 x 1, 8-bit/color RGBA, non-interlaced',
    file_path: path.join(root, 'en', 'pages', 'scp-173', 'files', 'pixel.png'),
    corpus_path: 'en/pages/scp-173/files/pixel.png',
    metadata_path: path.join(root, 'en', 'pages', 'scp-173', 'files.json'),
  });
  assert.equal(summary.attachment_count, 1);
  assert.equal(summary.attachment_page_count, 1);
});

test('buildCorpusImportManifest reads files/_state.json capture-state attachment manifests', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-manifest-'));
  const bytes = Buffer.from([5, 6, 7, 8, 9]);
  writePage(root, 'en', 'theme:pataphysics', {
    entityId: '14141414-1414-4141-8141-141414141414',
  });
  const pageDir = path.join(root, 'en', 'pages', 'theme:pataphysics');
  const filesDir = path.join(pageDir, 'files');
  fs.mkdirSync(filesDir, { recursive: true });
  fs.writeFileSync(path.join(filesDir, 'pata-logo.png'), bytes);
  fs.writeFileSync(
    path.join(filesDir, '_state.json'),
    `${JSON.stringify({
      files: {
        'pata-logo.png': {
          download_url: 'http://scp-wiki.wdfiles.com/local--files/theme%3Apataphysics/pata-logo.png',
          mime_type: 'image/png',
          mime_description: 'PNG image data, 600 x 100, 8-bit/color RGBA, non-interlaced',
          sha256: `sha256:${cryptoSha256(bytes)}`,
          size: bytes.length,
          uploaded_at: '2020-01-01T00:00:00+00:00',
        },
      },
    }, null, 2)}\n`,
  );

  const rows = buildCorpusImportManifest({
    corpusRoot: root,
    branch: 'en',
    sourceSite: 'scp-wiki',
    sourceBranch: 'en',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].attachments.length, 1);
  assert.deepEqual(rows[0].attachments[0], {
    filename: 'pata-logo.png',
    original_url: 'http://scp-wiki.wdfiles.com/local--files/theme%3Apataphysics/pata-logo.png',
    wikidot_path: '/local--files/theme%3Apataphysics/pata-logo.png',
    sha256: cryptoSha256(bytes),
    size: bytes.length,
    mime: 'image/png',
    content_type_description: 'PNG image data, 600 x 100, 8-bit/color RGBA, non-interlaced',
    file_path: path.join(filesDir, 'pata-logo.png'),
    corpus_path: 'en/pages/theme:pataphysics/files/pata-logo.png',
    metadata_path: path.join(filesDir, '_state.json'),
  });
});

test('buildCorpusImportManifest uses the byte-matched canonical file snapshot descriptor', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-manifest-'));
  const entityId = '16161616-1616-4161-8161-161616161616';
  const bytes = Buffer.from([9, 8, 7, 6]);
  writePage(root, 'en', 'scp-173', { entityId });
  writePageAttachment(root, 'en', 'scp-173', {
    filename: 'pixel.png',
    bytes,
    originalUrl: 'https://scp-wiki.wikidot.com/local--files/scp-173/pixel.png',
  });
  const snapshotDir = path.join(root, 'en', 'by-uuid', entityId, 'files', 'capture-pixel.png', 'snapshots');
  fs.mkdirSync(snapshotDir, { recursive: true });
  fs.writeFileSync(
    path.join(snapshotDir, 'snapshot.json'),
    `${JSON.stringify({
      filename: 'pixel.png',
      bytes_sha256: `sha256:${cryptoSha256(bytes)}`,
      metadata: {
        mime_description: 'PNG image data, 1 x 1, 8-bit/color RGB, non-interlaced',
      },
    }, null, 2)}\n`,
  );

  const rows = buildCorpusImportManifest({
    corpusRoot: root,
    branch: 'en',
    sourceSite: 'scp-wiki',
    sourceBranch: 'en',
  });

  assert.equal(
    rows[0].attachments[0].content_type_description,
    'PNG image data, 1 x 1, 8-bit/color RGB, non-interlaced',
  );
});

test('files.json takes precedence over files/_state.json when both exist', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-manifest-'));
  const bytes = Buffer.from([1, 2, 3, 4]);
  writePage(root, 'en', 'scp-173', {
    entityId: '15151515-1515-4151-8151-151515151515',
  });
  writePageAttachment(root, 'en', 'scp-173', {
    filename: 'pixel.png',
    bytes,
    originalUrl: 'https://scp-wiki.wikidot.com/local--files/scp-173/pixel.png',
  });
  fs.writeFileSync(
    path.join(root, 'en', 'pages', 'scp-173', 'files', '_state.json'),
    JSON.stringify({ files: { 'other.png': { download_url: 'not-a-url' } } }),
  );

  const rows = buildCorpusImportManifest({
    corpusRoot: root,
    branch: 'en',
    sourceSite: 'scp-wiki',
    sourceBranch: 'en',
  });
  assert.equal(rows[0].attachments.length, 1);
  assert.equal(rows[0].attachments[0].filename, 'pixel.png');
});

test('buildCorpusImportManifest rejects attachment byte hash mismatches', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-manifest-'));
  writePage(root, 'en', 'scp-173', {
    entityId: '13131313-1313-4131-8131-131313131313',
  });
  writePageAttachment(root, 'en', 'scp-173', {
    filename: 'pixel.png',
    bytes: Buffer.from([1]),
    originalUrl: 'https://scp-wiki.wikidot.com/local--files/scp-173/pixel.png',
  });
  const manifestPath = path.join(root, 'en', 'pages', 'scp-173', 'files.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest[0].sha256 = '0'.repeat(64);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  assert.throws(
    () => buildCorpusImportManifest({ corpusRoot: root, branch: 'en' }),
    /sha256 mismatch/,
  );
});

test('buildCorpusImportManifest rejects duplicate entity IDs before import', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-manifest-'));
  const entityId = '33333333-3333-4333-8333-333333333333';
  writePage(root, 'en', 'scp-173', { entityId });
  writePage(root, 'en', 'scp-174', {
    entityId,
    meta: {
      fullname: 'scp-174',
      title: 'SCP-174',
      title_shown: 'SCP-174',
    },
  });

  assert.throws(
    () => buildCorpusImportManifest({ corpusRoot: root, branch: 'en' }),
    /duplicate source_entity_id/,
  );
});

test('buildCorpusImportManifest rejects incomplete page records', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-manifest-'));
  const pageDir = path.join(root, 'en', 'pages', 'scp-173');
  fs.mkdirSync(pageDir, { recursive: true });
  fs.writeFileSync(path.join(pageDir, 'source.wikidot.txt'), 'content');
  fs.writeFileSync(path.join(pageDir, 'meta.json'), '{}\n');

  assert.throws(
    () => buildCorpusImportManifest({ corpusRoot: root, branch: 'en' }),
    /missing entity_id.txt/,
  );
});

test('buildCorpusImportManifest uses locale-independent code point ordering', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-manifest-'));
  writePage(root, 'en', '_404', {
    entityId: '77777777-7777-4777-8777-777777777777',
    meta: { fullname: '_404', title: '404', title_shown: '404' },
  });
  writePage(root, 'en', '0-texts-found', {
    entityId: '88888888-8888-4888-8888-888888888888',
    meta: { fullname: '0-texts-found', title: '0 Texts Found', title_shown: '0 Texts Found' },
  });

  const rows = buildCorpusImportManifest({ corpusRoot: root, branch: 'en' });

  assert.deepEqual(rows.map((row) => row.fullname), ['0-texts-found', '_404']);
});

test('buildCorpusImportManifest rejects negative counts before apply', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-manifest-'));
  writePage(root, 'en', 'scp-173', {
    entityId: '99999999-9999-4999-8999-999999999999',
    meta: { comments: -1 },
  });

  assert.throws(
    () => buildCorpusImportManifest({ corpusRoot: root, branch: 'en' }),
    /meta\.comments must be a non-negative integer/,
  );
});

test('buildCorpusImportManifest fullnames filter selects only the named pages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-manifest-'));
  writePage(root, 'en', 'scp-2000', { entityId: '16161616-1616-4161-8161-161616161616' });
  writePage(root, 'en', 'scp-173', { entityId: '17171717-1717-4171-8171-171717171717' });
  writePage(root, 'en', 'component:license-box', { entityId: '18181818-1818-4181-8181-181818181818' });

  const rows = buildCorpusImportManifest({
    corpusRoot: root,
    branch: 'en',
    sourceSite: 'scp-wiki',
    sourceBranch: 'en',
    fullnames: ['scp-2000', 'component:license-box'],
  });
  assert.deepEqual(rows.map((row) => row.fullname), ['component:license-box', 'scp-2000']);
});

test('buildCorpusImportManifest fullnames filter fails closed on unknown pages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-manifest-'));
  writePage(root, 'en', 'scp-2000', { entityId: '19191919-1919-4191-8191-191919191919' });

  assert.throws(
    () => buildCorpusImportManifest({
      corpusRoot: root,
      branch: 'en',
      sourceSite: 'scp-wiki',
      sourceBranch: 'en',
      fullnames: ['scp-2000', 'scp-404-not-there'],
    }),
    /fullnames not found in corpus .*scp-404-not-there/,
  );
  assert.throws(
    () => buildCorpusImportManifest({
      corpusRoot: root,
      branch: 'en',
      sourceSite: 'scp-wiki',
      sourceBranch: 'en',
      fullnames: [],
    }),
    /at least one page/,
  );
});

test('buildCrossSiteDependencyManifest emits foreign rows with corpus provenance and gap lists', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-xsite-'));
  writePage(root, 'en', 'scp-1', {
    entityId: '11111111-1111-4111-8111-111111111111',
    source: '[[include :snippets:comp]]\n[[include :nosuchsite:gone]]\n[[include component:local]]',
  });
  writePage(root, 'en', 'component:local', {
    entityId: '22222222-2222-4222-8222-222222222222',
    source: 'local component',
  });
  writePage(root, 'snippets', 'comp', {
    entityId: '33333333-3333-4333-8333-333333333333',
    meta: { fullname: 'comp', title: 'Comp', title_shown: 'Comp', tags: [] },
    source: 'shared component',
  });
  fs.writeFileSync(
    path.join(root, 'snippets', 'pages', 'comp', 'current.json'),
    '{"capture_id":"cap-1","entity_id":"33333333-3333-4333-8333-333333333333","fullname":"comp","payload_sha256":"abc","run_id":"run-9","schema_version":1,"status":"active"}\n',
  );

  const { rows, gaps, summary } = buildCrossSiteDependencyManifest({
    corpusRoot: root,
    targetBranch: 'en',
    targetSite: 'scp-wiki',
    roots: ['scp-1'],
    branches: ['en', 'snippets'],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].fullname, 'comp');
  assert.equal(rows[0].source_site, 'snippets');
  assert.equal(rows[0].source_branch, 'snippets');
  assert.equal(rows[0].closure_depth, 1);
  assert.equal(rows[0].closure_via, 'en:scp-1');
  assert.match(rows[0].source_path, /snippets\/pages\/comp\/source\.wikidot\.txt/u);
  assert.equal(rows[0].source_current_capture_id, 'cap-1');
  assert.equal(rows[0].source_current_run_id, 'run-9');
  assert.equal(rows[0].source_current_payload_sha256, 'abc');
  assert.equal(summary.cross_site_row_count, 1);
  assert.equal(summary.same_site_dependency_count, 1);
  assert.equal(summary.gap_count, 1);
  assert.deepEqual(summary.gaps_by_reason, { 'absent-from-corpus': 1 });
  assert.equal(gaps[0].identity, 'nosuchsite:gone');
  assert.equal(gaps[0].reason, 'absent-from-corpus');
});

test('buildCrossSiteDependencyManifest emits foreign pages that share a target fullname and reports bad records as gaps', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-xsite-'));
  writePage(root, 'en', 'scp-1', {
    entityId: '11111111-1111-4111-8111-111111111111',
    source: '[[include :snippets:clash]]\n[[include :snippets:broken]]',
  });
  writePage(root, 'en', 'clash', {
    entityId: '22222222-2222-4222-8222-222222222222',
    source: 'same-site page keeps its own fullname',
  });
  writePage(root, 'snippets', 'clash', {
    entityId: '33333333-3333-4333-8333-333333333333',
    meta: { fullname: 'clash', title: 'C', title_shown: 'C', tags: [] },
    source: 'foreign page of the same fullname',
  });
  writePage(root, 'snippets', 'broken', {
    entityId: '44444444-4444-4444-8444-444444444444',
    meta: { fullname: 'WRONG', title: 'B', title_shown: 'B', tags: [] },
    source: 'mismatched meta',
  });

  const { rows, gaps } = buildCrossSiteDependencyManifest({
    corpusRoot: root,
    targetBranch: 'en',
    targetSite: 'scp-wiki',
    roots: ['scp-1'],
    branches: ['en', 'snippets'],
  });
  assert.deepEqual(rows.map((row) => `${row.source_site}:${row.fullname}`), ['snippets:clash']);
  assert.deepEqual(gaps.map((gap) => gap.reason), ['invalid-corpus-record']);
});

test('summarizeCrossSiteCoverage counts fixed pages from per-root verdicts', () => {
  const summary = summarizeCrossSiteCoverage({
    affectedSlugs: ['scp-1', 'scp-2'],
    verdicts: {
      'scp-1': { fixed: true, gaps: [], truncated: [] },
      'scp-2': { fixed: false, gaps: [{ identity: 'x:y' }], truncated: [] },
    },
    manifest: { rows: [{ fullname: 'comp' }], gaps: [{ identity: 'x:y' }], summary: { gaps_by_reason: { 'absent-from-corpus': 1 }, truncated: [] } },
  });
  assert.equal(summary.affected_count, 2);
  assert.equal(summary.would_fix_count, 1);
  assert.deepEqual(summary.still_broken, ['scp-2']);
  assert.equal(summary.manifest_row_count, 1);
});

test('buildCrossSiteDependencyManifest honors caller-configured branch preferences with audit trail', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-xsite-'));
  writePage(root, 'en', 'scp-1', {
    entityId: '11111111-1111-4111-8111-111111111111',
    source: '[[include :shared:both]]',
  });
  for (const [branch, text] of [['aaa', 'leaf aaa'], ['zzz', 'leaf zzz']]) {
    writePage(root, branch, 'both', {
      entityId: branch === 'aaa' ? '33333333-3333-4333-8333-333333333333' : '44444444-4444-4444-8444-444444444444',
      meta: { fullname: 'both', title: 'B', title_shown: 'B', tags: [] },
      source: text,
    });
  }
  const { rows, gaps } = buildCrossSiteDependencyManifest({
    corpusRoot: root,
    targetBranch: 'en',
    targetSite: 'scp-wiki',
    roots: ['scp-1'],
    branches: ['en', 'aaa', 'zzz'],
    includeClosure: { preferredBranches: { shared: 'zzz' } },
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source_branch, 'zzz');
  assert.equal(rows[0].closure_resolution, 'preferred-branch');
  assert.deepEqual(rows[0].source_also_in_branches, ['aaa']);
  assert.deepEqual(gaps, []);
});

test('buildCrossSiteDependencyManifest emits one fullname from two source sites as two rows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-xsite-'));
  writePage(root, 'en', 'scp-1', {
    entityId: '11111111-1111-4111-8111-111111111111',
    source: '[[include :aaa:shared]]\n[[include :zzz:shared]]',
  });
  for (const branch of ['aaa', 'zzz']) {
    writePage(root, branch, 'shared', {
      entityId: branch === 'aaa' ? '33333333-3333-4333-8333-333333333333' : '44444444-4444-4444-8444-444444444444',
      meta: { fullname: 'shared', title: 'S', title_shown: 'S', tags: [] },
      source: `shared from ${branch}`,
    });
  }
  const { rows, gaps } = buildCrossSiteDependencyManifest({
    corpusRoot: root,
    targetBranch: 'en',
    targetSite: 'scp-wiki',
    roots: ['scp-1'],
    branches: ['en', 'aaa', 'zzz'],
    includeClosure: { preferredBranches: { aaa: 'aaa', zzz: 'zzz' } },
  });
  assert.deepEqual(
    rows.map((row) => `${row.source_site}:${row.fullname}`),
    ['aaa:shared', 'zzz:shared'],
  );
  assert.deepEqual(gaps, []);
});
