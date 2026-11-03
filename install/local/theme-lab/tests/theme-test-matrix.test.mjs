import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {materializeThemeTestScenario} from '../src/theme-test-scenario-config.mjs';
import {runThemeScenarioMatrix} from '../src/theme-test-matrix.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(fs.readFileSync(path.join(root,'scenarios/jp-sigma9-extra-black-canonical.json'),'utf8'));
const materialized=materializeThemeTestScenario(root,config);
const siteStateBase={schema:'theme_lab_live_site_state.v1',scenario_sha256:materialized.scenario_sha256,declared_site_state_sha256:materialized.scenario.branch_profile.site_state_sha256,site_id:17,site_slug:materialized.scenario.branch_profile.site_slug,observed:{}};
const siteState={...siteStateBase,receipt_sha256:crypto.createHash('sha256').update(JSON.stringify(siteStateBase)).digest('hex')};
const versions={chromium:'141',firefox:'142',webkit:'26'};
const fakeSingle=async({browserEngine,expectedBrowserVersions})=>({schema:'theme_lab_scenario_smoke.v1',scenario_sha256:materialized.scenario_sha256,runs:Object.fromEntries(['anonymous','authenticated'].map(profile=>[profile,{measurement:{engine:browserEngine,session_profile:profile,browser_version:expectedBrowserVersions[browserEngine],receipt_sha256:crypto.createHash('sha256').update(`${browserEngine}/${profile}`).digest('hex')},canonical_execution:{canonical_execution_sha256:crypto.createHash('sha256').update(`exec/${browserEngine}/${profile}`).digest('hex'),interaction_states:[{id:'settled',status:'pass'}],semantic_probes:[{id:'headings',status:'pass'}]}}]))});

test('canonical matrix binds all three engines and both session profiles into one result',async()=>{
  const result=await runThemeScenarioMatrix({root,config,siteState,browserRoot:'/fake',sessionStorageStates:{anonymous:null,authenticated:{}},runSingle:fakeSingle,loadType:engine=>({engine}),readVersions:()=>versions});
  assert.deepEqual(Object.keys(result.engines),['chromium','firefox','webkit']);
  for(const engine of Object.keys(versions))assert.deepEqual(Object.keys(result.engines[engine]),['anonymous','authenticated']);
});

test('canonical matrix fails closed when one required profile is absent',async()=>{
  const incomplete=async args=>{const result=await fakeSingle(args);delete result.runs.authenticated;return result};
  await assert.rejects(()=>runThemeScenarioMatrix({root,config,siteState,browserRoot:'/fake',sessionStorageStates:{anonymous:null},runSingle:incomplete,loadType:()=>({}),readVersions:()=>versions}),/missing chromium\/authenticated/u);
});
