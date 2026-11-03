import crypto from 'node:crypto';
import fs from 'node:fs';

import {resolveExistingContainedDirectory,resolveExistingContainedFile} from './package-path.mjs';

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

function boundText(root,binding,label){
  if(!binding||typeof binding.path!=='string'||!/^[0-9a-f]{64}$/u.test(binding.sha256??''))throw new Error(`${label} binding is invalid`);
  const file=resolveExistingContainedFile(root,binding.path,label);
  const bytes=fs.readFileSync(file);
  if(sha(bytes)!==binding.sha256)throw new Error(`${label} changed after scenario materialization`);
  return bytes.toString('utf8');
}

export function materializeThemeSessionInputs(root,plan,{sessionProfile='anonymous'}={}){
  if(plan?.schema!=='theme_lab_test_execution_plan.v1'||plan.session_server_ready!==true)throw new Error('scenario execution plan is not ready');
  const shell={};
  for(const [slot,value] of Object.entries(plan.session_server_inputs?.shell_injection??{})){
    if(!['headerHtml','navigationHtml','sidebarHtml','interwikiHtml'].includes(slot))throw new Error(`unsupported session shell slot: ${slot}`);
    shell[slot]=typeof value==='string'?value:boundText(root,value,`session shell ${slot}`);
  }
  const siteId=plan.live_site_state?.site_id;
  if(!Number.isSafeInteger(siteId))throw new Error('ready plan lacks a verified live site id');
  const measurementContract=JSON.parse(fs.readFileSync(resolveExistingContainedFile(root,plan.bindings.measurement_contract.path,'measurement contract'),'utf8'));
  if(!measurementContract.session_profiles?.includes(sessionProfile))throw new Error(`session profile is outside measurement contract: ${sessionProfile}`);
  const assetDir=resolveExistingContainedDirectory(root,plan.bindings.theme_asset_dir.path,'session asset pool');
  for(const dependency of plan.bindings.theme_asset_dependencies?.asset_dependencies??[]){
    if(dependency.status!=='local-cache'||!/^[0-9a-f]{64}$/u.test(dependency.sha256??''))throw new Error(`invalid theme asset dependency: ${dependency.name}`);
    const file=resolveExistingContainedFile(assetDir,dependency.name,`session theme asset ${dependency.name}`);
    if(sha(fs.readFileSync(file))!==dependency.sha256)throw new Error(`theme asset dependency changed after scenario materialization: ${dependency.name}`);
  }
  const scenarioEvidenceBase={
    schema:'theme_lab_scenario_execution_evidence.v1',
    scenario_sha256:plan.scenario_sha256,
    measurement_contract_sha256:plan.bindings.measurement_contract.sha256,
    theme_asset_dependency_sha256:plan.bindings.theme_asset_dependencies.asset_dependency_sha256,
    theme_css_sha256:plan.bindings.theme_css.sha256,
    theme_base_css_sha256:plan.bindings.theme_base_css?.sha256??null,
    theme_source_sha256:plan.bindings.theme_source.sha256,
    candidate_url:plan.candidate_url,
    site_id:siteId,
    session_profile:sessionProfile,
  };
  const scenarioEvidence={...scenarioEvidenceBase,execution_evidence_sha256:sha(Buffer.from(JSON.stringify(scenarioEvidenceBase)))};
  return {
    server:{
      candidateUrl:plan.candidate_url,
      assetDir,
      scenarioEvidence,
      baselineCss:boundText(root,plan.session_server_inputs.baseline_css,'session baseline CSS'),
      headerHtml:shell.headerHtml??null,
      interwikiHtml:shell.interwikiHtml??null,
      navigationHtml:shell.navigationHtml??null,
      sidebarHtml:shell.sidebarHtml??null,
    },
    check:{
      siteId,
      css:boundText(root,plan.session_server_inputs.theme_css,'session theme CSS'),
      baseCss:plan.bindings.theme_base_css?boundText(root,plan.bindings.theme_base_css,'session theme base CSS'):'',
      source:boundText(root,plan.bindings.theme_source,'session theme source'),
      wikitext:null,
      savedCandidate:true,
    },
  };
}
