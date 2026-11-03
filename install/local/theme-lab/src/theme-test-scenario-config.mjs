import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {resolveExistingContainedFile} from './package-path.mjs';
import {framerailSourceFingerprintSync} from './framerail-source-fingerprint.mjs';
import {ACCEPTANCE_VIEWPORTS} from './acceptance-viewports.mjs';
import {candidateAssetDependencyState} from './candidate-asset-dependencies.mjs';
import {validateCanonicalExecutionContract} from './theme-canonical-execution.mjs';
import {THEME_TEST_SCENARIO_SCHEMA,normalizeThemeTestScenario,themeTestScenarioSha} from './theme-test-scenario.mjs';

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

function binding(root,file,label){
  const resolved=resolveExistingContainedFile(root,file,label);
  return {path:file,sha256:sha(fs.readFileSync(resolved))};
}

function stringSet(value,label){
  if(!Array.isArray(value)||value.some(item=>typeof item!=='string'||!item))throw new Error(`${label} must be an array of strings`);
  return new Set(value);
}

function validateCorpusEnvironment(config,siteState,corpusManifest,corpusStates){
  if(siteState.schema!=='theme_lab_site_state.v1')throw new Error('unsupported branch site-state schema');
  if(corpusManifest.schema!=='theme_lab_canonical_corpus.v1')throw new Error('unsupported canonical corpus schema');
  if(corpusStates.schema!=='theme_lab_canonical_corpus_states.v1')throw new Error('unsupported canonical corpus state schema');
  if(siteState.branch_profile!==config.branch_profile.id||siteState.locale!==config.branch_profile.locale||siteState.site_slug!==config.branch_profile.site_slug)throw new Error('site state does not match branch profile identity');
  if(corpusManifest.id!==config.corpus.id||corpusStates.corpus!==config.corpus.id)throw new Error('corpus manifest/state identity does not match scenario corpus');
  if(corpusManifest.source!==path.basename(config.corpus.source))throw new Error('corpus manifest source does not match scenario corpus source');
  const existing=stringSet(siteState.existing_pages,'site_state.existing_pages'),missing=stringSet(siteState.missing_pages,'site_state.missing_pages');
  for(const page of existing)if(missing.has(page))throw new Error(`site state marks page as both existing and missing: ${page}`);
  const requirements=corpusManifest.site_state_requirements??{};
  if(requirements.corpus_page){
    if(siteState.corpus_page?.slug!==requirements.corpus_page.slug||JSON.stringify(siteState.corpus_page?.tags??[])!==JSON.stringify(requirements.corpus_page.tags??[]))throw new Error('site state corpus_page does not match canonical corpus requirement');
  }
  for(const [field,available] of [['existing_pages',existing],['missing_pages',missing],['page_tags',stringSet(siteState.page_tags,'site_state.page_tags')],['session_profiles',stringSet(siteState.session_profiles,'site_state.session_profiles')]]){
    for(const item of stringSet(requirements[field]??[],`corpus.${field}`))if(!available.has(item))throw new Error(`site state does not satisfy corpus ${field}: ${item}`);
  }
}

function validateMeasurement(config,corpusStates,measurement){
  if(measurement.schema!=='theme_lab_measurement_contract.v1')throw new Error('unsupported measurement contract schema');
  if(measurement.id!==config.measurement.id)throw new Error('measurement contract identity does not match scenario measurement');
  if(JSON.stringify(measurement.viewports)!==JSON.stringify(ACCEPTANCE_VIEWPORTS))throw new Error('measurement viewports do not match current acceptance viewports');
  const viewportIds=ACCEPTANCE_VIEWPORTS.map(({id})=>id);
  if(JSON.stringify(corpusStates.viewports??[])!==JSON.stringify(viewportIds))throw new Error('corpus viewport states do not match measurement viewports');
  if(JSON.stringify(measurement.session_profiles??[])!==JSON.stringify(corpusStates.session_profiles??[]))throw new Error('measurement session profiles do not match corpus states');
  if(JSON.stringify(measurement.browser_engines??[])!==JSON.stringify(['chromium','firefox','webkit']))throw new Error('measurement browser engines must match the current three-engine acceptance contract');
  if(measurement.browser_version_policy!=='exact-runtime-version')throw new Error('measurement browser version policy must require exact runtime receipts');
  if(measurement.network_policy!=='block-external-after-local-materialization')throw new Error('measurement network policy does not match canonical acceptance');
}

export function materializeThemeTestScenario(root,config){
  if(config?.schema!=='theme_lab_test_scenario_config.v1')throw new Error(`unknown theme-test scenario config schema: ${config?.schema}`);
  const shellEntries=Object.entries(config.shell_profile?.files??{}).sort(([a],[b])=>a.localeCompare(b));
  if(!shellEntries.length)throw new Error('shell_profile.files must bind at least one artifact');
  const shell=Object.fromEntries(shellEntries.map(([name,file])=>[name,binding(root,file,`branch shell ${name}`)]));
  const shellSha=sha(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(shell).map(([name,row])=>[name,row.sha256])))));
  const injection=config.shell_profile?.injection??{};
  const allowedSlots=new Set(['headerHtml','navigationHtml','sidebarHtml','interwikiHtml']);
  for(const [slot,name] of Object.entries(injection)){
    if(!allowedSlots.has(slot))throw new Error(`unsupported shell injection slot: ${slot}`);
    if(!shell[name])throw new Error(`shell injection references unknown fragment: ${name}`);
  }
  const injectionSha=sha(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(injection).sort(([a],[b])=>a.localeCompare(b))))));
  const siteState=binding(root,config.branch_profile.site_state,'branch site state');
  const baseline=binding(root,config.baseline.css,'baseline CSS');
  const baselineComponentEntries=Object.entries(config.baseline?.components??{}).sort(([a],[b])=>a.localeCompare(b));
  if(!baselineComponentEntries.length)throw new Error('baseline.components must bind at least one generation-specific component');
  const baselineComponents=Object.fromEntries(baselineComponentEntries.map(([name,file])=>[name,binding(root,file,`baseline component ${name}`)]));
  const baselineComponentSha=sha(Buffer.from(JSON.stringify(Object.fromEntries(Object.entries(baselineComponents).map(([name,row])=>[name,row.sha256])))));
  const themeCss=binding(root,config.theme.css,'theme CSS');
  const themeBaseCss=config.theme.base_css?binding(root,config.theme.base_css,'theme base CSS'):null;
  const themeSource=binding(root,config.theme.source,'theme source');
  const themeCssPath=resolveExistingContainedFile(root,config.theme.css,'theme CSS');
  const themeDir=path.dirname(themeCssPath),portsDir=path.join(root,'ports');
  const themeCssBytes=fs.readFileSync(themeCssPath,'utf8');
  const assetState=candidateAssetDependencyState({portsDir,themeDir,candidateCss:themeCssBytes,baseCss:themeBaseCss?fs.readFileSync(resolveExistingContainedFile(root,themeBaseCss.path,'theme base CSS')):Buffer.alloc(0)});
  const missingAssets=assetState.asset_dependencies.filter(row=>row.status!=='local-cache');
  if(missingAssets.length)throw new Error(`theme asset dependencies are missing: ${missingAssets.map(row=>row.name).join(', ')}`);
  const usesLegacyAssetDirectory=/url\(\s*["']?\.\/assets\//u.test(themeCssBytes);
  const themeAssetDir=usesLegacyAssetDirectory?path.join(themeDir,'assets'):path.join(portsDir,'shared-replay-assets');
  if(usesLegacyAssetDirectory&&!fs.existsSync(themeAssetDir))throw new Error('theme CSS references ./assets but the package asset directory is missing');
  const corpusManifest=binding(root,config.corpus.manifest,'corpus manifest');
  const corpusSource=binding(root,config.corpus.source,'corpus source');
  const corpusStates=binding(root,config.corpus.states,'corpus states');
  const measurement=binding(root,config.measurement.contract,'measurement contract');
  const siteStateJson=JSON.parse(fs.readFileSync(resolveExistingContainedFile(root,config.branch_profile.site_state,'branch site state'),'utf8'));
  const corpusManifestJson=JSON.parse(fs.readFileSync(resolveExistingContainedFile(root,config.corpus.manifest,'corpus manifest'),'utf8'));
  const corpusStatesJson=JSON.parse(fs.readFileSync(resolveExistingContainedFile(root,config.corpus.states,'corpus states'),'utf8'));
  const measurementJson=JSON.parse(fs.readFileSync(resolveExistingContainedFile(root,config.measurement.contract,'measurement contract'),'utf8'));
  validateCorpusEnvironment(config,siteStateJson,corpusManifestJson,corpusStatesJson);
  validateCanonicalExecutionContract(corpusManifestJson,corpusStatesJson);
  validateMeasurement(config,corpusStatesJson,measurementJson);
  let runtimeSha=config.runtime?.implementation_sha256??null;
  if(config.runtime?.implementation_source==='framerail')runtimeSha=framerailSourceFingerprintSync(path.resolve(root,'../../..'));
  const scenario=normalizeThemeTestScenario({
    schema:THEME_TEST_SCENARIO_SCHEMA,
    runtime:{platform:config.runtime?.platform,implementation:config.runtime?.implementation,implementation_sha256:runtimeSha,origin:config.runtime?.origin},
    branch_profile:{id:config.branch_profile.id,locale:config.branch_profile.locale,site_slug:config.branch_profile.site_slug,site_state_sha256:siteState.sha256},
    shell_profile:{id:config.shell_profile.id,format:config.shell_profile.format,shell_sha256:shellSha,injection_sha256:injectionSha},
    baseline:{id:config.baseline.id,css_sha256:baseline.sha256,component_contract_sha256:baselineComponentSha},
    theme:{id:config.theme.id,css_sha256:themeCss.sha256,base_css_sha256:themeBaseCss?.sha256??null,source_sha256:themeSource.sha256,asset_dependency_sha256:assetState.asset_dependency_sha256},
    corpus:{id:config.corpus.id,manifest_sha256:corpusManifest.sha256,source_sha256:corpusSource.sha256,state_set_sha256:corpusStates.sha256},
    measurement:{id:config.measurement.id,contract_sha256:measurement.sha256},
  });
  return {scenario,scenario_sha256:themeTestScenarioSha(scenario),bindings:{shell,shell_injection:injection,site_state:siteState,baseline_css:baseline,baseline_components:baselineComponents,theme_css:themeCss,theme_base_css:themeBaseCss,theme_source:themeSource,theme_asset_dependencies:assetState,theme_asset_dir:{path:path.relative(root,themeAssetDir)},corpus_manifest:corpusManifest,corpus_source:corpusSource,corpus_states:corpusStates,measurement_contract:measurement}};
}
