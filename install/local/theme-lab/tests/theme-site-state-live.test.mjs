import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {materializeThemeTestScenario} from '../src/theme-test-scenario-config.mjs';
import {verifyThemeScenarioSiteState} from '../src/theme-site-state-live.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(fs.readFileSync(path.join(root,'scenarios/jp-sigma9-extra-black-canonical.json'),'utf8'));
const materialized=materializeThemeTestScenario(root,config);
const corpus=fs.readFileSync(path.join(root,'fixtures/theme-canonical-corpus-v1.wikidot.txt'),'utf8');

test('live site-state verifier binds existing/missing pages and exact canonical corpus source/tags',async()=>{
  const pages=new Map([
    ['run-owned:theme-lab-corpus-existing',{page_id:1,revision_id:2,wikitext:'sentinel',tags:['theme-lab-canonical-corpus']}],
    ['run-owned:theme-lab-canonical-corpus-v1',{page_id:3,revision_id:4,wikitext:corpus,tags:['theme','theme-lab-canonical-corpus']}],
  ]);
  const rpcClient={call:async(method,params)=>method==='site_get'?{site_id:17}:pages.get(params.page)??null};
  const record=await verifyThemeScenarioSiteState({root,materialized,rpcClient,siteSlug:'scpaiueouiuiuiui'});
  assert.equal(record.site_id,17);
  assert.equal(record.observed.missing_pages['run-owned:theme-lab-corpus-missing'].exists,false);
  assert.equal(record.observed.corpus_page.tags[0],'theme');
  await assert.rejects(()=>verifyThemeScenarioSiteState({root,materialized,rpcClient,siteSlug:'different-site'}),/does not match scenario branch profile/u);
});

test('live site-state verifier rejects a stale saved canonical corpus page',async()=>{
  const rpcClient={call:async(method,params)=>method==='site_get'?{site_id:17}:params.page==='run-owned:theme-lab-corpus-existing'?{page_id:1,tags:[]}:params.page==='run-owned:theme-lab-canonical-corpus-v1'?{page_id:3,revision_id:4,wikitext:'stale',tags:['theme','theme-lab-canonical-corpus']}:null};
  await assert.rejects(()=>verifyThemeScenarioSiteState({root,materialized,rpcClient,siteSlug:'scpaiueouiuiuiui'}),/saved page source is stale/u);
});
