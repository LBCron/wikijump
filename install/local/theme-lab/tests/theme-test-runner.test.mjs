import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {materializeThemeTestScenario} from '../src/theme-test-scenario-config.mjs';
import {runThemeScenarioSmoke} from '../src/theme-test-runner.mjs';
import {CANONICAL_INTERACTION_STATES,CANONICAL_SEMANTIC_PROBES} from '../src/theme-canonical-execution.mjs';
import {createDeepwellRuntimeIdentity} from '../src/deepwell-runtime-identity.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const config=JSON.parse(fs.readFileSync(path.join(root,'scenarios/jp-sigma9-extra-black-canonical.json'),'utf8'));
const liveSiteState=materialized=>{const base={schema:'theme_lab_live_site_state.v1',scenario_sha256:materialized.scenario_sha256,declared_site_state_sha256:materialized.scenario.branch_profile.site_state_sha256,site_id:17,site_slug:materialized.scenario.branch_profile.site_slug,observed:{}};return {...base,receipt_sha256:crypto.createHash('sha256').update(JSON.stringify(base)).digest('hex')}};
const observeSession=async(_page,profile)=>({my_account_text:profile==='authenticated'?'Administrator':null,logout_link_present:profile==='authenticated',sign_in_link_present:profile==='anonymous'});
const goodCheck=profile=>({browser_runtime:{engine:'chromium',version:'141.0',session_profile:profile},verification_scope:{mode:'full',deferred:[]},target_acceptance:{status:'pass'},image_diagnostics:{status:'pass'},font_diagnostics:{portable_glyph_measurement:{status:'pass'}}});
const backendRuntimeIdentity=createDeepwellRuntimeIdentity({source_sha256:'b'.repeat(64),ftml_git_revision:'c'.repeat(40),container_id:'d'.repeat(64),image_id:`sha256:${'e'.repeat(64)}`,binary_sha256:'f'.repeat(64),config_sha256:'1'.repeat(64)});
const runtimePage=materialized=>({__themeLabRuntimeIdentity:{schema:'theme_lab_built_target_runtime.v1',transport_origin:new URL(materialized.scenario.runtime.origin).origin,header_source_sha256:materialized.scenario.runtime.implementation_sha256,response_status:200,backend_runtime_identity:backendRuntimeIdentity}});

test('scenario smoke runner isolates both required session profiles without claiming canonical acceptance',async()=>{
  const materialized=materializeThemeTestScenario(root,config);let closes=0;const seen=[];
  const page=runtimePage(materialized);const startServer=async options=>({session:{pages:{candidate:page},check:async check=>{seen.push(options.scenarioEvidence.session_profile);assert.equal(options.scenarioEvidence.scenario_sha256,materialized.scenario_sha256);assert.equal(check.savedCandidate,true);return {...goodCheck(options.scenarioEvidence.session_profile),scenario_execution_evidence:options.scenarioEvidence}}},close:async()=>{closes++}});
  const runInteractions=async(value,ids)=>{assert.equal(value,page);assert.deepEqual(ids,CANONICAL_INTERACTION_STATES);return ids.map(id=>({id,status:'pass'}))};
  const runProbes=async(value,ids)=>{assert.equal(value,page);assert.deepEqual(ids,CANONICAL_SEMANTIC_PROBES);return ids.map(id=>({id,status:'pass'}))};
  const result=await runThemeScenarioSmoke({root,config,siteState:liveSiteState(materialized),browserType:{},browserEngine:'chromium',expectedBrowserVersions:{chromium:'141.0'},socketPath:'/tmp/theme-lab-scenario-test.sock',sessionStorageStates:{anonymous:null,authenticated:{cookies:[{name:'local-session'}]}},observeSession,startServer,runInteractions,runProbes});
  assert.equal(result.canonical_acceptance_eligible,false);
  assert.equal(result.runs.anonymous.measurement.session_profile,'anonymous');
  assert.equal(result.runs.authenticated.measurement.session_profile,'authenticated');
  assert.deepEqual(seen,['anonymous','authenticated']);
  assert.deepEqual(result.blockers,['single-engine smoke run does not satisfy the three-engine measurement matrix']);
  assert.equal(closes,2);
});

test('scenario smoke runner reports a missing required session profile',async()=>{
  const materialized=materializeThemeTestScenario(root,config);
  const startServer=async options=>({session:{pages:{candidate:runtimePage(materialized)},check:async()=>goodCheck(options.scenarioEvidence.session_profile)},close:async()=>{}});
  const passInteractions=async(_page,ids)=>ids.map(id=>({id,status:'pass'}));const passProbes=async(_page,ids)=>ids.map(id=>({id,status:'pass'}));
  const result=await runThemeScenarioSmoke({root,config,siteState:liveSiteState(materialized),browserType:{},browserEngine:'chromium',expectedBrowserVersions:{chromium:'141.0'},socketPath:'/tmp/theme-lab-scenario-test.sock',sessionStorageStates:{anonymous:null},observeSession,startServer,runInteractions:passInteractions,runProbes:passProbes});
  assert.ok(result.blockers.some(value=>value.includes('authenticated')));
});

test('scenario smoke runner fails closed when the built target runtime identity differs',async()=>{
  const materialized=materializeThemeTestScenario(root,config);
  const page={__themeLabRuntimeIdentity:{schema:'theme_lab_built_target_runtime.v1',transport_origin:new URL(materialized.scenario.runtime.origin).origin,header_source_sha256:'f'.repeat(64),response_status:200}};
  const startServer=async options=>({session:{pages:{candidate:page},check:async()=>goodCheck(options.scenarioEvidence.session_profile)},close:async()=>{}});
  const passInteractions=async(_page,ids)=>ids.map(id=>({id,status:'pass'}));const passProbes=async(_page,ids)=>ids.map(id=>({id,status:'pass'}));
  await assert.rejects(()=>runThemeScenarioSmoke({root,config,siteState:liveSiteState(materialized),browserType:{},browserEngine:'chromium',expectedBrowserVersions:{chromium:'141.0'},socketPath:'/tmp/theme-lab-scenario-test.sock',sessionStorageStates:{anonymous:null},observeSession,startServer,runInteractions:passInteractions,runProbes:passProbes}),/canonical target runtime identity mismatch/u);
});

test('scenario smoke runner preserves closed-set canonical failures as blockers',async()=>{
  const materialized=materializeThemeTestScenario(root,config);
  const startServer=async options=>({session:{pages:{candidate:runtimePage(materialized)},check:async()=>goodCheck(options.scenarioEvidence.session_profile)},close:async()=>{}});
  const runInteractions=async(_page,ids)=>ids.map((id,index)=>({id,status:index===0?'fail':'pass'}));const runProbes=async(_page,ids)=>ids.map(id=>({id,status:'pass'}));
  const result=await runThemeScenarioSmoke({root,config,siteState:liveSiteState(materialized),browserType:{},browserEngine:'chromium',expectedBrowserVersions:{chromium:'141.0'},socketPath:'/tmp/theme-lab-scenario-test.sock',sessionStorageStates:{anonymous:null,authenticated:{}},observeSession,startServer,runInteractions,runProbes});
  assert.ok(result.blockers.some(value=>value.includes('canonical interaction/probe execution has failures')));
});
