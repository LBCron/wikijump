import fs from 'node:fs';
import path from 'node:path';
import {materializeThemeTestScenario} from './theme-test-scenario-config.mjs';
import {verifyRenderedShellAssetReplay} from './theme-shell-render.mjs';

function verifyRenderedShell(root,materialized,renderedShell){
  const summary=renderedShell?.summary;
  if(summary?.schema!=='theme_lab_rendered_shell.v1')throw new Error('rendered shell is missing or invalid');
  for(const [fragmentName,fragment] of Object.entries(summary.fragments??{}))if(fragment.styles_count!==0)throw new Error(`rendered shell fragment produced unsupported shell styles: ${fragmentName}`);
  for(const slot of Object.keys(materialized.bindings.shell_injection)){
    const html=renderedShell.injection?.[slot];
    if(typeof html!=='string')throw new Error(`rendered shell is missing injection slot: ${slot}`);
  }
  verifyRenderedShellAssetReplay(root,materialized,renderedShell);
}

function verifyLiveSiteState(materialized,siteState){
  if(siteState?.schema!=='theme_lab_live_site_state.v1')throw new Error('live site state is missing or invalid');
  if(siteState.site_slug!==materialized.scenario.branch_profile.site_slug)throw new Error('live site state uses the wrong site');
}

export function themeTestExecutionPlan(root,config,{renderedShell=null,siteState=null}={}){
  const materialized=materializeThemeTestScenario(root,config);
  const corpusManifest=JSON.parse(fs.readFileSync(path.join(root,materialized.bindings.corpus_manifest.path),'utf8'));
  const corpusPageSlug=corpusManifest.site_state_requirements?.corpus_page?.slug??null;
  const format=materialized.scenario.shell_profile.format;
  if(!['rendered-html','wikidot-source'].includes(format))throw new Error(`unsupported shell profile format: ${format}`);
  const shellRequiresRendering=format==='wikidot-source';
  if(shellRequiresRendering&&renderedShell)verifyRenderedShell(root,materialized,renderedShell);
  if(siteState)verifyLiveSiteState(materialized,siteState);
  if(renderedShell&&siteState&&renderedShell.summary.site_id!==siteState.site_id)throw new Error('rendered shell and live site state refer to different sites');
  const shellReady=!shellRequiresRendering||Boolean(renderedShell);
  const siteStateReady=Boolean(siteState);
  const candidateUrl=siteStateReady&&corpusPageSlug?`${materialized.scenario.runtime.origin}/${encodeURIComponent(corpusPageSlug)}`:null;
  const shellInjection=shellRequiresRendering
    ? (renderedShell?.injection??{})
    : Object.fromEntries(Object.entries(materialized.bindings.shell_injection).map(([slot,name])=>[slot,{path:materialized.bindings.shell[name].path,sha256:materialized.bindings.shell[name].sha256}]));
  return {
    schema:'theme_lab_test_execution_plan.v1',
    scenario_sha256:materialized.scenario_sha256,
    runtime:materialized.scenario.runtime,
    runtime_platform:materialized.scenario.runtime.platform,
    shell_profile:materialized.scenario.shell_profile,
    shell_requires_rendering:shellRequiresRendering,
    candidate_url:candidateUrl,
    session_server_inputs:{
      candidate_url:candidateUrl,
      baseline_css:materialized.bindings.baseline_css,
      theme_css:materialized.bindings.theme_css,
      shell_injection:shellInjection,
    },
    session_server_ready:materialized.scenario.runtime.platform==='wikijump'&&shellReady&&siteStateReady,
    blockers:[
      ...(materialized.scenario.runtime.platform==='wikidot'?['controlled Wikidot execution adapter is not configured']:[]),
      ...(shellRequiresRendering&&!renderedShell?['Wikidot-source shell must be rendered by the bound runtime before HTML injection']:[]),
      ...(!siteState?['live branch/site-state must be verified before scenario execution']:[]),
    ],
    rendered_shell:renderedShell?.summary??null,
    live_site_state:siteState??null,
    bindings:materialized.bindings,
  };
}
