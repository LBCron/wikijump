import {requireDeepwellRuntimeIdentity} from './deepwell-runtime-identity.mjs';
import {observeThemeSession,themeSessionObservationIsValid} from './theme-test-session-observation.mjs';
import fs from 'node:fs';
import path from 'node:path';

import {startSessionServer} from './session-server.mjs';
import {createDeepwellPreviewClient} from './deepwell-preview.mjs';
import {themeTestExecutionPlan} from './theme-test-execution-plan.mjs';
import {materializeThemeSessionInputs} from './theme-test-session-inputs.mjs';
import {runCanonicalInteractionStates,runCanonicalSemanticProbes} from './theme-canonical-execution.mjs';

export async function runThemeScenarioSmoke({root,config,siteState,renderedShell=null,browserType,browserEngine='chromium',expectedBrowserVersions,socketPath,headless=true,sessionStorageStates={anonymous:null},startServer=startSessionServer,runInteractions=runCanonicalInteractionStates,runProbes=runCanonicalSemanticProbes,observeSession=observeThemeSession}){
  const plan=themeTestExecutionPlan(root,config,{siteState,renderedShell});
  const measurementContract=JSON.parse(fs.readFileSync(path.join(root,plan.bindings.measurement_contract.path),'utf8'));
  const corpusStates=JSON.parse(fs.readFileSync(path.join(root,plan.bindings.corpus_states.path),'utf8'));
  const corpusManifest=JSON.parse(fs.readFileSync(path.join(root,plan.bindings.corpus_manifest.path),'utf8'));
  const runs={};
  for(const sessionProfile of measurementContract.session_profiles){
    if(!(sessionProfile in sessionStorageStates))continue;
    const inputs=materializeThemeSessionInputs(root,plan,{sessionProfile});
    const previewClient=process.env.DEEPWELL_RPC_URL&&process.env.DEEPWELL_RPC_TOKEN?createDeepwellPreviewClient({rpcUrl:process.env.DEEPWELL_RPC_URL,rpcToken:process.env.DEEPWELL_RPC_TOKEN}):null;
    const server=await startServer({socketPath:`${socketPath}.${sessionProfile}`,chromium:browserType,browserEngine,headless,candidateStorageState:sessionStorageStates[sessionProfile],...inputs.server,...(previewClient?{previewClient}:{})});
    try{
      const sessionPage=server.session.pages?.candidate;
      if(!sessionPage)throw new Error('canonical session has no opened candidate page');
      const runtimeIdentity=sessionPage.__themeLabRuntimeIdentity;
      const expectedRuntimeOrigin=new URL(plan.runtime.origin).origin;
      if(runtimeIdentity?.schema!=='theme_lab_built_target_runtime.v1'||
          runtimeIdentity.transport_origin!==expectedRuntimeOrigin||
          runtimeIdentity.header_source_sha256!==plan.runtime.implementation_sha256||
          runtimeIdentity.response_status!==200){
        throw new Error(`canonical target runtime identity mismatch: expected ${expectedRuntimeOrigin} with Framerail source ${plan.runtime.implementation_sha256}`);
      }
      const backendRuntimeIdentity=requireDeepwellRuntimeIdentity(runtimeIdentity.backend_runtime_identity,'canonical target response');
      const sessionObservation=await observeSession(sessionPage,sessionProfile);
      if(!themeSessionObservationIsValid(sessionProfile,sessionObservation))throw new Error(`canonical session role mismatch: ${sessionProfile}`);
      const verdict=await server.session.check({...inputs.check,viewports:true,torture:false,visual:false});
      if(verdict.browser_runtime?.session_profile!==sessionProfile)throw new Error(`browser verdict session profile mismatch: expected ${sessionProfile}, observed ${verdict.browser_runtime?.session_profile}`);
      const page=server.session.pages?.candidate;if(!page)throw new Error('scenario runner has no opened candidate page for canonical execution');
      const interactionStates=await runInteractions(page,corpusStates.interaction_states,{baselineViewportStatus:verdict.viewport_status});
      const semanticProbes=await runProbes(page,corpusManifest.semantic_probes);
      const checkEvidence={
        verification_scope:verdict.verification_scope?.mode==='full'&&!(verdict.verification_scope?.deferred?.length)?'pass':'fail',
        target_acceptance:['pass','warn'].includes(verdict.target_acceptance?.status)?'pass':'fail',
        image_diagnostics:verdict.image_diagnostics?.status==='pass'?'pass':'fail',
        japanese_glyph_rendering:verdict.font_diagnostics?.portable_glyph_measurement?.status==='pass'?'pass':'fail',
      };
      const executionBase={schema:'theme_lab_canonical_execution.v1',scenario_sha256:plan.scenario_sha256,session_profile:sessionProfile,backend_runtime_identity:backendRuntimeIdentity,session_observation:sessionObservation,check_evidence:checkEvidence,interaction_states:interactionStates,semantic_probes:semanticProbes};
      const canonicalExecution=executionBase;
      const measurement={engine:verdict.browser_runtime?.engine,browser_version:verdict.browser_runtime?.browser_version,session_profile:sessionProfile};
      runs[sessionProfile]={measurement:measurement,canonical_execution:canonicalExecution,verdict};
    }finally{await server.close()}
  }
  const missingProfiles=measurementContract.session_profiles.filter(profile=>!(profile in runs));
  const failedCanonicalExecution=Object.entries(runs).filter(([,run])=>Object.values(run.canonical_execution.check_evidence??{}).some(status=>status!=='pass')||[...run.canonical_execution.interaction_states,...run.canonical_execution.semantic_probes].some(row=>row.status!=='pass')).map(([profile])=>profile);
  return {
      schema:'theme_lab_scenario_smoke.v1',
      scenario_sha256:plan.scenario_sha256,
      canonical_acceptance_eligible:false,
      blockers:[
        'single-engine smoke run does not satisfy the three-engine measurement matrix',
        ...(missingProfiles.length?[`required session profiles were not executed: ${missingProfiles.join(', ')}`]:[]),
        ...(failedCanonicalExecution.length?[`canonical interaction/probe execution has failures: ${failedCanonicalExecution.join(', ')}`]:[]),
      ],
      runs,
    };
}
