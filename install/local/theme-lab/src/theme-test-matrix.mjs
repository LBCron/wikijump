import fs from 'node:fs';
import path from 'node:path';

import {loadBrowserType} from './browser-lab.mjs';
import {playwrightBrowserVersions} from './playwright-browser-versions.mjs';
import {materializeThemeTestScenario} from './theme-test-scenario-config.mjs';
import {runThemeScenarioSmoke} from './theme-test-runner.mjs';
import {loadCanonicalLedgerDocument,matchCanonicalContainmentWaivers} from './canonical-ledger-waiver.mjs';


export async function runThemeScenarioMatrix({root,config,siteState,renderedShell=null,browserRoot,pathPrefix='/tmp/theme-lab-canonical',sessionStorageStates,runSingle=runThemeScenarioSmoke,loadType=loadBrowserType,readVersions=playwrightBrowserVersions,ledgerDocument=null}){
  const materialized=materializeThemeTestScenario(root,config);
  const measurement=JSON.parse(fs.readFileSync(path.join(root,materialized.bindings.measurement_contract.path),'utf8'));
  const expectedVersions=readVersions(browserRoot);
  const expectedEngines=measurement.browser_engines;
  if(JSON.stringify(Object.keys(expectedVersions).sort())!==JSON.stringify([...expectedEngines].sort()))throw new Error('installed Playwright browser set does not match canonical measurement contract');
  const ledger=ledgerDocument??loadCanonicalLedgerDocument();
  const waiverContext={packageName:config?.theme?.id,themeCssSha256:materialized.bindings.theme_css.sha256,themeSourceSha256:materialized.bindings.theme_source.sha256,scenarioSha256:materialized.scenario_sha256};
  const engines={};
  const ledgerWaivers=[];
  for(const engine of expectedEngines){
    const browserType=loadType(engine,browserRoot);
    const result=await runSingle({root,config,siteState,renderedShell,browserType,browserEngine:engine,expectedBrowserVersions:expectedVersions,socketPath:`${pathPrefix}.${engine}.sock`,sessionStorageStates});
    if(result.scenario_sha256!==materialized.scenario_sha256)throw new Error(`scenario SHA drift in ${engine} run`);
    const profiles={};
    const engineFailures=[];
    for(const profile of measurement.session_profiles){
      const run=result.runs?.[profile];if(!run)throw new Error(`missing ${engine}/${profile} canonical run`);
      if(run.measurement?.engine!==engine||run.measurement?.session_profile!==profile)throw new Error(`mismatched measurement for ${engine}/${profile}`);
      if(run.measurement.browser_version!==expectedVersions[engine])throw new Error(`browser version drift in ${engine}/${profile}`);
      for(const [id,status] of Object.entries(run.canonical_execution.check_evidence??{}))if(status!=='pass')engineFailures.push({engine,sessionProfile:profile,kind:'check',id});
      for(const row of run.canonical_execution.interaction_states??[])if(row?.status!=='pass')engineFailures.push({engine,sessionProfile:profile,kind:'state',id:row?.id,viewportWidth:row?.observation?.viewport_width,candidateOverflowPx:row?.observation?.candidate_document_overflow_px,baselineOverflowPx:row?.observation?.baseline_document_overflow_px});
      for(const row of run.canonical_execution.semantic_probes??[])if(row?.status!=='pass')engineFailures.push({engine,sessionProfile:profile,kind:'probe',id:row?.id});
      profiles[profile]={measurement:run.measurement,canonical_execution:run.canonical_execution};
    }
    const waivers=matchCanonicalContainmentWaivers(ledger,{...waiverContext,failures:engineFailures});
    ledgerWaivers.push(...waivers);
    const directlyWaived=failure=>waivers.some(waiver=>waiver.session_profile===failure.sessionProfile&&waiver.state===failure.id);
    for(const profile of measurement.session_profiles){
      const states=engineFailures.filter(failure=>failure.sessionProfile===profile&&failure.kind==='state');
      const derivedCheckCovered=states.length>0&&states.every(directlyWaived);
      const excused=failure=>directlyWaived(failure)||(failure.kind==='check'&&failure.id==='target_acceptance'&&derivedCheckCovered);
      if(engineFailures.some(failure=>failure.sessionProfile===profile&&!excused(failure)))throw new Error(`canonical execution failed for ${engine}/${profile}`);
    }
    engines[engine]=profiles;
  }
  const base={schema:'theme_lab_scenario_matrix.v1',scenario_sha256:materialized.scenario_sha256,measurement_contract_sha256:materialized.bindings.measurement_contract.sha256,engines};
  return ledgerWaivers.length?{...base,ledger_waivers:ledgerWaivers}:base;
}
