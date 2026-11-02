import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {localPagesSql, parseArgs, planMirrorRefresh, planMirrorReconciliation, readCorpusEntityId, readCorpusEntities} from '../scripts/refresh-mirror-from-corpus.mjs';

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const corpus = {
  'same': {source: 'same body', title: 'Same', tags: ['b', 'a'], run: 'run-1'},
  'stale-source': {source: 'new body', title: 'Stale', tags: ['a'], run: 'run-2'},
  'stale-tags': {source: 'body', title: 'Tags', tags: ['_cc', 'scp'], run: 'run-2'},
  'empty-title': {source: 'body', title: '', tags: [], run: 'run-2'},
  'local-edit': {source: 'corpus body', title: 'Local', tags: [], run: 'run-2'},
};
const read = (slug) => corpus[slug] ?? null;

test('only import-only pages that differ from the corpus are refreshed', () => {
  const {plan, skipped} = planMirrorRefresh([
    {slug: 'same', sourceSha256: sha('same body'), title: 'Same', tags: ['a', 'b'], importOnly: true},
    {slug: 'stale-source', sourceSha256: sha('old body'), title: 'Stale', tags: ['a'], importOnly: true},
    {slug: 'stale-tags', sourceSha256: sha('body'), title: 'Tags', tags: ['scp'], importOnly: true},
    {slug: 'empty-title', sourceSha256: sha('body'), title: 'empty-title', tags: [], importOnly: true},
    {slug: 'local-edit', sourceSha256: sha('edited body'), title: 'Local', tags: [], importOnly: false},
    {slug: 'not-in-corpus', sourceSha256: sha('x'), title: 'X', tags: [], importOnly: true},
  ], read);

  assert.deepEqual(plan, [
    {slug: 'stale-source', run: 'run-2', wikitext: 'new body'},
    {slug: 'stale-tags', run: 'run-2', tags: ['_cc', 'scp']},
  ]);
  assert.deepEqual(skipped, [{slug: 'local-edit', reason: 'has-local-revisions', fields: ['wikitext']}]);
});

test('the refresh only writes with --apply', () => {
  assert.equal(parseArgs(['--corpus-root', '/corpus']).apply, false);
  assert.equal(parseArgs(['--corpus-root', '/corpus', '--apply']).apply, true);
  assert.throws(() => parseArgs([]), /--corpus-root is required/);
});

const ENTITIES = {
  kept: '11111111-1111-4111-8111-111111111111',
  renamed: '22222222-2222-4222-8222-222222222222',
  deleted: '33333333-3333-4333-8333-333333333333',
  created: '44444444-4444-4444-8444-444444444444',
};

function reconPages() {
  return [
    {slug: 'kept', importOnly: true, sourceEntityId: ENTITIES.kept},
    {slug: 'old-name', importOnly: true, sourceEntityId: ENTITIES.renamed},
    {slug: 'gone', importOnly: true, sourceEntityId: ENTITIES.deleted},
    {slug: 'no-snapshot', importOnly: true, sourceEntityId: null},
    {slug: 'local-work', importOnly: false, sourceEntityId: ENTITIES.deleted},
    {slug: 'declared', importOnly: true, sourceEntityId: '55555555-5555-4555-8555-555555555555'},
  ];
}

function reconCorpus() {
  return {
    slugs: ['kept', 'new-name', 'fresh'],
    entities: [
      {entityId: ENTITIES.kept, slug: 'kept'},
      {entityId: ENTITIES.renamed, slug: 'new-name'},
      {entityId: ENTITIES.created, slug: 'fresh'},
    ],
    entityComplete: true,
  };
}

test('reconciliation pairs renames by entity id and tombstones only conclusive deletes', () => {
  const {deletes, renames, creates, skipped} = planMirrorReconciliation(reconPages(), reconCorpus(), {declaredExtras: ['declared'], consumedSlugs: []});

  assert.deepEqual(renames, [{from: 'old-name', to: 'new-name', entityId: ENTITIES.renamed}]);
  assert.deepEqual(deletes, [{slug: 'gone', entityId: ENTITIES.deleted}]);
  assert.deepEqual(creates, [{slug: 'fresh', entityId: ENTITIES.created}]);
  assert.deepEqual(skipped, [
    {slug: 'no-snapshot', reason: 'ambiguous-absent-needs-entity'},
    {slug: 'local-work', reason: 'has-local-revisions'},
    {slug: 'declared', reason: 'declared-extra'},
  ]);
});

test('reconciliation never deletes when the entity inventory is incomplete', () => {
  const corpus = {...reconCorpus(), entityComplete: false};
  const {deletes, renames, skipped} = planMirrorReconciliation(reconPages(), corpus, {});

  assert.deepEqual(renames, [{from: 'old-name', to: 'new-name', entityId: ENTITIES.renamed}]);
  assert.deepEqual(deletes, []);
  assert.ok(skipped.some((item) => item.slug === 'gone' && item.reason === 'ambiguous-absent-needs-entity'));
});

test('reconciliation reports occupied rename targets and consumed slugs instead of acting', () => {
  const pages = [
    ...reconPages(),
    {slug: 'new-name', importOnly: true, sourceEntityId: '66666666-6666-4666-8666-666666666666'},
    {slug: 'taken', importOnly: true, sourceEntityId: '77777777-7777-4777-8777-777777777777'},
  ];
  const corpus = {
    slugs: ['kept', 'new-name', 'fresh', 'taken'],
    entities: [
      {entityId: ENTITIES.kept, slug: 'kept'},
      {entityId: ENTITIES.renamed, slug: 'new-name'},
      {entityId: '66666666-6666-4666-8666-666666666666', slug: 'stale-occupant'},
      {entityId: ENTITIES.created, slug: 'fresh'},
      {entityId: '88888888-8888-4888-8888-888888888888', slug: 'taken'},
    ],
    entityComplete: true,
  };
  const {deletes, renames, skipped} = planMirrorReconciliation(pages, corpus, {declaredExtras: ['declared'], consumedSlugs: ['gone']});

  assert.deepEqual(renames, []);
  assert.deepEqual(deletes, []);
  assert.ok(skipped.some((item) => item.slug === 'old-name' && item.reason === 'rename-target-occupied'));
  assert.ok(skipped.some((item) => item.slug === 'gone' && item.reason === 'already-consumed'));
  assert.ok(skipped.some((item) => item.slug === 'taken' && item.reason === 'slug-reassigned'));
  assert.ok(!skipped.some((item) => item.slug === 'new-name'), 'in-corpus pages with a live entity stay silent');
});

test('reconciliation is idempotent once deletes and renames are applied', () => {
  const first = planMirrorReconciliation(reconPages(), reconCorpus(), {declaredExtras: ['declared']});
  assert.equal(first.deletes.length, 1);
  assert.equal(first.renames.length, 1);
  const after = reconPages()
    .filter((page) => !first.deletes.some((item) => item.slug === page.slug))
    .map((page) => {
      const rename = first.renames.find((item) => item.from === page.slug);
      return rename ? {...page, slug: rename.to} : page;
    });
  const second = planMirrorReconciliation(after, reconCorpus(), {declaredExtras: ['declared'], consumedSlugs: ['gone', 'old-name']});
  assert.deepEqual(second.deletes, []);
  assert.deepEqual(second.renames, []);
});

test('corpus entity inventory reads entity_id.txt and flags incomplete inventories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-entities-'));
  const branchPages = path.join(root, 'en', 'pages');
  fs.mkdirSync(path.join(branchPages, 'with-id'), {recursive: true});
  fs.writeFileSync(path.join(branchPages, 'with-id', 'entity_id.txt'), `${ENTITIES.kept}\n`);
  fs.mkdirSync(path.join(branchPages, 'without-id'), {recursive: true});
  fs.writeFileSync(path.join(branchPages, 'without-id', 'entity_id.txt'), 'not-a-uuid\n');

  const {slugs, entities, entityComplete} = readCorpusEntities(root, 'en');
  assert.deepEqual([...slugs].sort(), ['with-id', 'without-id']);
  assert.deepEqual(entities, [{entityId: ENTITIES.kept, slug: 'with-id'}]);
  assert.equal(entityComplete, false);
  assert.equal(readCorpusEntityId(path.join(branchPages, 'with-id')), ENTITIES.kept);
  assert.equal(readCorpusEntityId(path.join(branchPages, 'without-id')), null);
  assert.equal(readCorpusEntityId(path.join(branchPages, 'missing-dir')), null);
});

test('mirror refresh never lists foreign include-source storage as a mirror page', () => {
  const sql = localPagesSql('scp-wiki', []);
  assert.match(
    sql,
    /foreign_snapshot\.source_site <> s\.slug\n {10}AND foreign_snapshot\.source_site NOT IN \(\n {12}SELECT source_branch FROM wikidot_corpus_import_run run WHERE run\.site_id = s\.site_id\)\)/u,
    'the exclusion is the #2690 foreign-snapshot predicate',
  );
});
