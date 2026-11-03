#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {runCliIfMain} from '../src/cli-entry.mjs';
import {createSqlExecutor} from '../src/corpus-import-sql.mjs';
import {sqlQuote} from '../src/corpus-import-sql-values.mjs';
import {deepwellRpcAuthorization} from '../src/deepwell-rpc-auth.mjs';
import {validateRpcUrl} from '../src/import-page.mjs';
import {leasedPageEdit} from '../src/page-edit-lease.mjs';

const IMPORT_COMMENT_PREFIX = 'local scp-wiki mirror';
const BATCH_SESSION_EDITS = 100;

export function parseArgs(argv) {
  const args = {
    corpusRoot: null, branch: 'en', site: 'scp-wiki', siteId: 6000006,
    dbContainer: 'wikijump-standing-database-1', dbUrl: process.env.DEEPWELL_VERIFY_DB_URL ?? null,
    rpcUrl: 'http://127.0.0.1:2747/jsonrpc', slugs: [], apply: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[index];
    };
    if (arg === '--corpus-root') args.corpusRoot = next();
    else if (arg === '--branch') args.branch = next();
    else if (arg === '--site') args.site = next();
    else if (arg === '--site-id') args.siteId = Number.parseInt(next(), 10);
    else if (arg === '--db-container') args.dbContainer = next();
    else if (arg === '--db-url') args.dbUrl = next();
    else if (arg === '--rpc-url') args.rpcUrl = next();
    else if (arg === '--slug') args.slugs.push(next());
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--help' || arg === '-h') return {help: true};
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.corpusRoot) throw new Error('--corpus-root is required');
  if (!Number.isInteger(args.siteId)) throw new Error('--site-id must be an integer');
  validateRpcUrl(args.rpcUrl);
  return args;
}

export function usage() {
  return 'Usage: refresh-mirror-from-corpus.mjs --corpus-root <path> [--branch en] [--site scp-wiki] [--site-id <id>] [--db-container <name> | --db-url <url>] [--rpc-url <url>] [--slug <page>...] [--apply]';
}

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

export function planMirrorRefresh(pages, readCorpus) {
  const plan = [];
  const skipped = [];
  for (const page of pages) {
    const corpus = readCorpus(page.slug);
    if (!corpus) continue;
    const update = {};
    if (sha256(corpus.source) !== page.sourceSha256) update.wikitext = corpus.source;
    if (corpus.title && corpus.title !== page.title) update.title = corpus.title;
    const tags = [...corpus.tags].sort();
    if (JSON.stringify(tags) !== JSON.stringify([...page.tags].sort())) update.tags = tags;
    if (Object.keys(update).length === 0) continue;
    if (!page.importOnly) {
      skipped.push({slug: page.slug, reason: 'has-local-revisions', fields: Object.keys(update)});
      continue;
    }
    plan.push({slug: page.slug, run: corpus.run, ...update});
  }
  return {plan, skipped};
}

export function corpusReader(corpusRoot, branch) {
  return (slug) => {
    const directory = path.join(corpusRoot, branch, 'pages', slug);
    const sourcePath = path.join(directory, 'source.wikidot.txt');
    const metaPath = path.join(directory, 'meta.json');
    if (!fs.existsSync(sourcePath) || !fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    let run = 'corpus';
    try {
      run = JSON.parse(fs.readFileSync(path.join(directory, 'current.json'), 'utf8')).run_id ?? run;
    } catch {}
    return {source: fs.readFileSync(sourcePath, 'utf8'), title: meta.title ?? '', tags: meta.tags ?? [], run, entityId: readCorpusEntityId(directory)};
  };
}

export function readCorpusEntityId(directory) {
  try {
    const value = fs.readFileSync(path.join(directory, 'entity_id.txt'), 'utf8').trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value) ? value.toLowerCase() : null;
  } catch {
    return null;
  }
}

export function readCorpusEntities(corpusRoot, branch) {
  const pagesRoot = path.join(corpusRoot, branch, 'pages');
  const slugs = fs.readdirSync(pagesRoot, {withFileTypes: true}).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  const entities = [];
  let entityComplete = true;
  for (const slug of slugs) {
    const entityId = readCorpusEntityId(path.join(pagesRoot, slug));
    if (!entityId) {
      entityComplete = false;
      continue;
    }
    entities.push({entityId, slug});
  }
  return {slugs, entities, entityComplete};
}

export function planMirrorReconciliation(pages, corpus, scope = {}) {
  const declaredExtras = new Set(scope.declaredExtras ?? []);
  const consumedSlugs = new Set(scope.consumedSlugs ?? []);
  const corpusSlugs = new Set(corpus.slugs);
  const corpusSlugByEntity = new Map(corpus.entities.map(({entityId, slug}) => [entityId, slug]));
  const localSlugs = new Set(pages.map((page) => page.slug));
  const localSlugByEntity = new Map();
  for (const page of pages) {
    if (page.sourceEntityId && !localSlugByEntity.has(page.sourceEntityId)) localSlugByEntity.set(page.sourceEntityId, page.slug);
  }
  const deletes = [];
  const renames = [];
  const creates = [];
  const skipped = [];
  for (const page of pages) {
    if (declaredExtras.has(page.slug)) {
      skipped.push({slug: page.slug, reason: 'declared-extra'});
      continue;
    }
    const corpusSlug = page.sourceEntityId ? corpusSlugByEntity.get(page.sourceEntityId) : undefined;
    if (corpusSlugs.has(page.slug)) {
      if (page.sourceEntityId && corpus.entityComplete && corpusSlug === undefined) {
        skipped.push({slug: page.slug, reason: 'slug-reassigned'});
      }
      continue;
    }
    if (!page.importOnly) {
      skipped.push({slug: page.slug, reason: 'has-local-revisions'});
      continue;
    }
    if (consumedSlugs.has(page.slug)) {
      skipped.push({slug: page.slug, reason: 'already-consumed'});
      continue;
    }
    if (corpusSlug && corpusSlug !== page.slug) {
      if (localSlugs.has(corpusSlug)) {
        skipped.push({slug: page.slug, reason: 'rename-target-occupied', target: corpusSlug});
        continue;
      }
      renames.push({from: page.slug, to: corpusSlug, entityId: page.sourceEntityId});
      continue;
    }
    if (page.sourceEntityId && corpus.entityComplete) {
      deletes.push({slug: page.slug, entityId: page.sourceEntityId});
      continue;
    }
    skipped.push({slug: page.slug, reason: 'ambiguous-absent-needs-entity'});
  }
  const localEntities = new Set(localSlugByEntity.keys());
  for (const {entityId, slug} of corpus.entities) {
    if (!localEntities.has(entityId)) creates.push({slug, entityId});
  }
  return {deletes, renames, creates, skipped};
}

export function localPagesSql(site, slugs) {
  const filter = slugs.length ? ` AND p.slug IN (${slugs.map(sqlQuote).join(',')})` : '';
  return `SELECT json_build_object('slug', p.slug, 'sha', encode(sha256(convert_to(t.contents, 'UTF8')), 'hex'),
      'title', r.title, 'tags', r.tags,
      'importOnly', bool_and(r2.user_id = -2 OR (r2.user_id = -1 AND coalesce(r2.comments, '') LIKE ${sqlQuote(`${IMPORT_COMMENT_PREFIX}%`)})),
      'entityId', snap.source_entity_id)
    FROM page p JOIN site s ON s.site_id = p.site_id
    JOIN page_revision r ON r.revision_id = p.latest_revision_id
    JOIN text t ON t.hash = r.wikitext_hash
    JOIN page_revision r2 ON r2.page_id = p.page_id
    LEFT JOIN wikidot_page_snapshot snap ON snap.page_id = p.page_id
    WHERE s.slug = ${sqlQuote(site)} AND p.deleted_at IS NULL${filter}
      AND NOT EXISTS (
        SELECT 1 FROM wikidot_page_snapshot foreign_snapshot
        WHERE foreign_snapshot.page_id = p.page_id
          AND foreign_snapshot.source_site <> s.slug
          AND foreign_snapshot.source_site NOT IN (
            SELECT source_branch FROM wikidot_corpus_import_run run WHERE run.site_id = s.site_id))
    GROUP BY p.slug, t.contents, r.title, r.tags, snap.source_entity_id;`;
}

function mirrorScopeSql(siteId) {
  return `SELECT COALESCE(json_build_object('scope', scope, 'sourcePin', source_pin,
    'inventoriedSourceCount', inventoried_source_count,
    'declaredExtras', declared_extras, 'consumedSlugs', consumed_slugs)::text, '')
    FROM mirror_scope WHERE site_id = ${siteId};`;
}

async function rpc(rpcUrl, method, params, sessionToken, siteId = null) {
  const headers = {Authorization: deepwellRpcAuthorization(), 'Content-Type': 'application/json'};
  if (sessionToken) headers['X-Deepwell-Session-Token'] = sessionToken;
  if (siteId !== null) headers['X-Deepwell-Site-Id'] = String(siteId);
  const response = await fetch(rpcUrl, {method: 'POST', redirect: 'error', headers, body: JSON.stringify({jsonrpc: '2.0', id: 1, method, params})});
  if (!response.ok) throw new Error(`${method}: RPC HTTP ${response.status}`);
  const body = await response.json();
  if (body.error) throw new Error(`${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function session(rpcUrl) {
  if (process.env.DEEPWELL_SESSION_TOKEN) return process.env.DEEPWELL_SESSION_TOKEN;
  const result = await rpc(rpcUrl, 'login', {
    name_or_email: process.env.WIKIDOT_VERIFY_ADMIN_EMAIL ?? 'admin@wikijump',
    password: process.env.WIKIDOT_VERIFY_ADMIN_PASS ?? 'wikijumpadmin1',
    ip_address: '127.0.0.1',
    user_agent: 'refresh-mirror-from-corpus',
  });
  return result.session_token;
}

export function parseMirrorScopeRow(output) {
  const line = output.split('\n').map((value) => value.trim()).filter(Boolean)[0];
  if (!line) return null;
  const row = JSON.parse(line);
  return {
    scope: row.scope,
    sourcePin: row.sourcePin ?? null,
    inventoriedSourceCount: row.inventoriedSourceCount ?? 0,
    declaredExtras: row.declaredExtras ?? [],
    consumedSlugs: row.consumedSlugs ?? [],
  };
}

async function applyPageEdit(rpcUrl, siteId, item, token) {
  const page = await rpc(rpcUrl, 'page_get', {site_id: siteId, page: item.slug, details: {compiled_html: false, wikitext: false}}, token);
  const params = {
    site_id: siteId, page: page.page_id, last_revision_id: page.revision_id, slug: page.slug,
    user_id: -1, ip_address: '::1',
    revision_comments: `${IMPORT_COMMENT_PREFIX} refresh from corpus ${item.run}`,
  };
  for (const key of ['wikitext', 'title', 'tags']) if (item[key] !== undefined) params[key] = item[key];
  if (item.wikitext === undefined) return rpc(rpcUrl, 'page_edit', params, token);
  return leasedPageEdit((method, leaseParams) => rpc(rpcUrl, method, leaseParams, token, siteId), params);
}

async function applyPageDelete(rpcUrl, siteId, item, token) {
  const page = await rpc(rpcUrl, 'page_get', {site_id: siteId, page: item.slug, details: {compiled_html: false, wikitext: false}}, token);
  return rpc(rpcUrl, 'page_delete', {
    site_id: siteId, page: page.page_id, last_revision_id: page.revision_id,
    user_id: -1, ip_address: '::1',
    revision_comments: `${IMPORT_COMMENT_PREFIX} source page removed from corpus`,
  }, token);
}

async function applyPageMove(rpcUrl, siteId, item, token) {
  const page = await rpc(rpcUrl, 'page_get', {site_id: siteId, page: item.from, details: {compiled_html: false, wikitext: false}}, token);
  return rpc(rpcUrl, 'page_move', {
    site_id: siteId, page: page.page_id, last_revision_id: page.revision_id, new_slug: item.to,
    user_id: -1, ip_address: '::1',
    revision_comments: `${IMPORT_COMMENT_PREFIX} source page renamed to ${item.to}`,
  }, token);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(usage());
    return 0;
  }
  const sql = createSqlExecutor({dbUrl: args.dbUrl, dbContainer: args.dbContainer});
  const readCorpus = corpusReader(args.corpusRoot, args.branch);
  const corpus = readCorpusEntities(args.corpusRoot, args.branch);
  const scope = parseMirrorScopeRow(await sql.runSql(mirrorScopeSql(args.siteId), {capture: true}));
  const fetchPages = async () => {
    const output = await sql.runSql(localPagesSql(args.site, args.slugs), {capture: true});
    return output.split('\n').filter((line) => line.startsWith('{')).map((line) => {
      const row = JSON.parse(line);
      return {slug: row.slug, sourceSha256: row.sha, title: row.title ?? '', tags: row.tags ?? [], importOnly: row.importOnly === true, sourceEntityId: row.entityId ?? null};
    });
  };
  const pages = await fetchPages();
  const recon = planMirrorReconciliation(pages, corpus, {declaredExtras: scope?.declaredExtras, consumedSlugs: scope?.consumedSlugs});
  const {plan, skipped} = planMirrorRefresh(pages, readCorpus);
  for (const item of skipped) console.log(JSON.stringify({slug: item.slug, skipped: item.reason, fields: item.fields}));
  for (const item of recon.skipped) console.log(JSON.stringify({slug: item.slug, skipped: item.reason}));
  if (!scope) console.log(JSON.stringify({warning: 'mirror-scope-missing', detail: `no mirror_scope row for site_id ${args.siteId}; reconciliation still plans, but consumed slugs cannot be recorded`}));
  if (!args.apply) {
    for (const item of plan) console.log(JSON.stringify({slug: item.slug, plan: Object.keys(item).filter((key) => !['slug', 'run'].includes(key))}));
    for (const item of recon.deletes) console.log(JSON.stringify({slug: item.slug, plan: ['delete'], entityId: item.entityId}));
    for (const item of recon.renames) console.log(JSON.stringify({slug: item.from, plan: ['rename'], to: item.to, entityId: item.entityId}));
    for (const item of recon.creates) console.log(JSON.stringify({slug: item.slug, plan: ['create-pending'], entityId: item.entityId}));
    console.log(JSON.stringify({pages: pages.length, refresh: plan.length, deletes: recon.deletes.length, renames: recon.renames.length, creates: recon.creates.length, skipped: skipped.length + recon.skipped.length, applied: false}));
    return 0;
  }
  let failed = 0;
  let token = null;
  let opIndex = 0;
  const nextToken = async () => {
    if (opIndex % BATCH_SESSION_EDITS === 0) token = await session(args.rpcUrl);
    opIndex += 1;
    return token;
  };
  const consumed = [];
  for (const item of recon.deletes) {
    try {
      await applyPageDelete(args.rpcUrl, args.siteId, item, await nextToken());
      consumed.push(item.slug);
      console.log(JSON.stringify({slug: item.slug, ok: true, op: 'delete'}));
    } catch (error) {
      failed += 1;
      console.log(JSON.stringify({slug: item.slug, ok: false, op: 'delete', error: String(error.message).slice(0, 2000)}));
    }
  }
  for (const item of recon.renames) {
    try {
      const result = await applyPageMove(args.rpcUrl, args.siteId, item, await nextToken());
      consumed.push(item.from);
      console.log(JSON.stringify({slug: item.from, ok: true, op: 'rename', to: item.to, revision: result?.revision_number}));
    } catch (error) {
      failed += 1;
      console.log(JSON.stringify({slug: item.from, ok: false, op: 'rename', to: item.to, error: String(error.message).slice(0, 2000)}));
    }
  }
  if (consumed.length && scope) {
    try {
      const merged = [...new Set([...scope.consumedSlugs, ...consumed])];
      await rpc(args.rpcUrl, 'mirror_scope_set', {
        site_id: args.siteId, scope: scope.scope, source_pin: scope.sourcePin,
        inventoried_source_count: corpus.slugs.length, declared_extras: scope.declaredExtras, consumed_slugs: merged,
      }, await nextToken());
      console.log(JSON.stringify({mirrorScope: true, ok: true, consumed: merged.length}));
    } catch (error) {
      failed += 1;
      console.log(JSON.stringify({mirrorScope: true, ok: false, error: String(error.message).slice(0, 2000)}));
    }
  } else if (consumed.length) {
    console.log(JSON.stringify({mirrorScope: true, ok: false, error: 'mirror-scope-missing: consumed slugs not recorded; re-planning stays idempotent because tombstoned and moved slugs leave the inventory'}));
  }
  const {plan: refreshPlan} = planMirrorRefresh(await fetchPages(), readCorpus);
  for (const item of refreshPlan) {
    try {
      const result = await applyPageEdit(args.rpcUrl, args.siteId, item, await nextToken());
      console.log(JSON.stringify({slug: item.slug, ok: true, revision: result?.revision_number}));
    } catch (error) {
      failed += 1;
      console.log(JSON.stringify({slug: item.slug, ok: false, error: String(error.message).slice(0, 2000)}));
    }
  }
  console.log(JSON.stringify({pages: pages.length, refresh: refreshPlan.length, deletes: recon.deletes.length, renames: recon.renames.length, creates: recon.creates.length, skipped: skipped.length + recon.skipped.length, failed, applied: true}));
  return failed ? 1 : 0;
}

await runCliIfMain(import.meta.url, main);
