import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCorpusImportRun,
  finishCorpusImportRun,
  recordCorpusImportItemSql,
} from '../src/corpus-import-run-state.mjs';

test('corpus import run state writes a single-source manifest lifecycle', async () => {
  const queries = [];
  const sqlExecutor = {
    async runSql(sql) {
      queries.push(sql);
      return queries.length === 1 ? '9' : '';
    },
  };
  const args = { siteId: 6000005, sourceSite: null, sourceBranch: null };
  const rows = [{ source_site: 'scp-wiki', source_branch: 'en' }];

  assert.equal(await createCorpusImportRun(args, sqlExecutor, 'fixture', rows, rows, true), 9);
  assert.match(queries[0], /source_branch/);
  assert.match(queries[0], /'scp-wiki'/);
  assert.match(recordCorpusImportItemSql({ source_entity_id: '00000000-0000-0000-0000-000000000001', fullname: 'scp-173', source_sha256: 'a'.repeat(64), meta_sha256: 'b'.repeat(64) }, 173, 9, 'done'), /ON CONFLICT/);
  await finishCorpusImportRun(args, sqlExecutor, 9, { created: 1 });
  assert.match(queries[1], /SET state = 'done'/);
});

test('corpus import run records operator foreign-source overrides in the run summary', async () => {
  const queries = [];
  const sqlExecutor = {
    async runSql(sql) {
      queries.push(sql);
      return '11';
    },
  };
  const rows = [{ source_site: '05command', source_branch: 'live:05command-acquisition-20261103' }];
  const args = { siteId: 6000006, sourceSite: null, sourceBranch: null, foreignSourceSites: ['05command', '05command'] };

  assert.equal(await createCorpusImportRun(args, sqlExecutor, 'fixture', rows, rows, false), 11);
  assert.match(queries[0], /"foreign_source_sites":\["05command"\]/);

  const plainQueries = [];
  const plainExecutor = {
    async runSql(sql) {
      plainQueries.push(sql);
      return '12';
    },
  };
  await createCorpusImportRun({ siteId: 6000006, sourceSite: null, sourceBranch: null }, plainExecutor, 'fixture', rows, rows, false);
  assert.doesNotMatch(plainQueries[0], /foreign_source_sites/);
});
