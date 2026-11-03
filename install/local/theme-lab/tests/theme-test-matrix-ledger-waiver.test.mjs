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
const themeId=config.theme.id;
const siteStateBase={schema:'theme_lab_live_site_state.v1',scenario_sha256:materialized.scenario_sha256,declared_site_state_sha256:materialized.scenario.branch_profile.site_state_sha256,site_id:17,site_slug:materialized.scenario.branch_profile.site_slug,observed:{}};
const siteState={...siteStateBase,receipt_sha256:crypto.createHash('sha256').update(JSON.stringify(siteStateBase)).digest('hex')};
const versions={chromium:'141',firefox:'142',webkit:'26'};

const settledFailObservation={page_content:true,scroll_width:331,viewport_width:320,candidate_document_overflow_px:11,baseline_document_overflow_px:0,overflow_delta_px:11,overflow_attribution:'same-target-baseline'};
const passExecution=()=>({check_evidence:{verification_scope:'pass',target_acceptance:'pass',image_diagnostics:'pass',japanese_glyph_rendering:'pass'},
  interaction_states:[{id:'settled',status:'pass'},{id:'responsive-shell',status:'pass'}],semantic_probes:[{id:'headings',status:'pass'}]});
const runWith=executionFor=>async({browserEngine,expectedBrowserVersions})=>({schema:'theme_lab_scenario_smoke.v1',scenario_sha256:materialized.scenario_sha256,
  runs:Object.fromEntries(['anonymous','authenticated'].map(profile=>[profile,{measurement:{engine:browserEngine,session_profile:profile,browser_version:expectedBrowserVersions[browserEngine]},
    canonical_execution:executionFor(browserEngine,profile)}]))});
const baseArgs=runSingle=>({root,config,siteState,browserRoot:'/fake',sessionStorageStates:{anonymous:null,authenticated:{}},runSingle,loadType:engine=>({engine}),readVersions:()=>versions});
const coveringDocument=(candidatePx=11)=>({entries:[{id:'OD-T1-synthetic-test',instrument:'semantic_document_containment',decision:'OD-T1',package:themeId,
  match:{observation_key:JSON.stringify([themeId,'chromium','narrow-mobile','page.normal','settled']),candidate_overflow_px:candidatePx,baseline_overflow_px:0},
  candidate_source_sha256:materialized.bindings.theme_source.sha256,candidate_sha256:materialized.bindings.theme_css.sha256}]});

test('a covered overflow failure passes and is recorded with entry id and finding hash',async()=>{
  const failing=runWith((engine,profile)=>{
    const execution=passExecution();
    if(engine==='chromium'&&profile==='anonymous')execution.interaction_states=[{id:'settled',status:'fail',observation:settledFailObservation},{id:'responsive-shell',status:'pass'}];
    return execution;
  });
  const result=await runThemeScenarioMatrix({...baseArgs(failing),ledgerDocument:coveringDocument()});
  assert.equal(result.ledger_waivers.length,1);
  const [waiver]=result.ledger_waivers;
  assert.equal(waiver.entry_id,'OD-T1-synthetic-test');
  assert.equal(waiver.state,'settled');
  assert.equal(waiver.engine,'chromium');
  assert.equal(waiver.session_profile,'anonymous');
  assert.equal(waiver.viewport,'narrow-mobile');
  assert.match(waiver.finding_sha256,/^[0-9a-f]{64}$/u);
});

test('an uncovered overflow failure still throws the original message',async()=>{
  const failing=runWith((engine,profile)=>{
    const execution=passExecution();
    if(engine==='chromium'&&profile==='anonymous')execution.interaction_states=[{id:'settled',status:'fail',observation:{...settledFailObservation,candidate_document_overflow_px:12,overflow_delta_px:12}},{id:'responsive-shell',status:'pass'}];
    return execution;
  });
  try{
    await runThemeScenarioMatrix({...baseArgs(failing),ledgerDocument:coveringDocument()});
    assert.fail('covered nothing: expected the canonical throw');
  }catch(error){assert.equal(error.message,'canonical execution failed for chromium/anonymous');}
});

test('checks and probes are never waived even with a covering entry present',async()=>{
  const failing=runWith((engine,profile)=>{
    const execution=passExecution();
    if(engine==='firefox'&&profile==='anonymous')execution.semantic_probes=[{id:'headings',status:'fail'}];
    if(engine==='webkit'&&profile==='anonymous')execution.check_evidence={...execution.check_evidence,target_acceptance:'fail'};
    return execution;
  });
  try{
    await runThemeScenarioMatrix({...baseArgs(failing),ledgerDocument:coveringDocument()});
    assert.fail('unrelated failures must still throw');
  }catch(error){assert.equal(error.message,'canonical execution failed for firefox/anonymous');}
});

test('a clean run carries no waiver block (hash-neutral shape)',async()=>{
  const result=await runThemeScenarioMatrix(baseArgs(runWith(()=>passExecution())));
  assert.ok(!('ledger_waivers' in result));
  assert.deepEqual(Object.keys(result).sort(),['engines','measurement_contract_sha256','scenario_sha256','schema']);
});

test('a derived target_acceptance failure is excused when every failing state is waived',async()=>{
  const failing=runWith((engine,profile)=>{
    const execution=passExecution();
    if(engine==='chromium'&&profile==='anonymous'){
      execution.interaction_states=[{id:'settled',status:'fail',observation:settledFailObservation},{id:'responsive-shell',status:'pass'}];
      execution.check_evidence={...execution.check_evidence,target_acceptance:'fail'};
    }
    return execution;
  });
  const result=await runThemeScenarioMatrix({...baseArgs(failing),ledgerDocument:coveringDocument()});
  assert.equal(result.ledger_waivers.length,1);
  assert.equal(result.ledger_waivers[0].entry_id,'OD-T1-synthetic-test');
});

test('a derived target_acceptance failure still throws when any state is unwaived',async()=>{
  const failing=runWith((engine,profile)=>{
    const execution=passExecution();
    if(engine==='chromium'&&profile==='anonymous'){
      execution.interaction_states=[{id:'settled',status:'fail',observation:{...settledFailObservation,candidate_document_overflow_px:12,overflow_delta_px:12}},{id:'responsive-shell',status:'pass'}];
      execution.check_evidence={...execution.check_evidence,target_acceptance:'fail'};
    }
    return execution;
  });
  try{
    await runThemeScenarioMatrix({...baseArgs(failing),ledgerDocument:coveringDocument()});
    assert.fail('unwaived state must still throw');
  }catch(error){assert.equal(error.message,'canonical execution failed for chromium/anonymous');}
});
