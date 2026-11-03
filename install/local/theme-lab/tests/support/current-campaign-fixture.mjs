import {runtimeFilesForObservation,runtimeSurfaceContractSha} from '../../src/browser-runtime-contract.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {canonicalScreenshotPath,validateCombinedAcceptance,validateCurrentSigma10Contract,validateBrowserCoverage,checkCampaignCompletion} from '../../src/campaign-completion.mjs';
import crypto from 'node:crypto';
import browserContract from '../../fixtures/browser-acceptance-states.json' with {type:'json'};
import {candidateIdentity} from '../../ports/scripts/candidate-identity.mjs';
import {SEMANTIC_BROWSER_MODEL,planBrowserAcceptance} from '../../src/semantic-browser-acceptance.mjs';
import {BASELINE_DOCUMENT_CONTAINMENT_CONTRACT_SHA256,BASELINE_DOCUMENT_CONTAINMENT_SCHEMA} from '../../src/baseline-document-containment.mjs';
import {TARGET_ACCEPTANCE_CONTRACT_SHA256} from '../../src/target-acceptance-contract.mjs';
import {currentTargetRuntimeSourceSha} from '../../src/target-runtime-identity.mjs';
import {frozenCandidateSetSha256} from '../../src/publication-candidate-freeze.mjs';
import {currentPackageFullCheckInputBindings} from '../../src/full-check-input-bindings.mjs';
import {browserEnvironmentContractHashes} from '../../src/current-browser-contracts.mjs';
import {createDeepwellRuntimeIdentity} from '../../src/deepwell-runtime-identity.mjs';
import {VISUAL_GATE_POLICY_SHA256,visualGatePolicyRow,visualGateSelectorsFor,buildVisualGateAssertion,visualGateGlobalRuntimeDrift,runContractWithoutRuntimeBindings} from '../../src/visual-gate.mjs';
import {scopedRunContractSha} from '../../src/scoped-run-contract.mjs';
import {candidateAssetDependencyState} from '../../src/candidate-asset-dependencies.mjs';
import {CANONICAL_INTERACTION_STATES,CANONICAL_SEMANTIC_PROBES} from '../../src/theme-canonical-execution.mjs';
import {themeScenarioConfigForPackage} from '../../src/theme-scenario-factory.mjs';
import {materializeThemeTestScenario} from '../../src/theme-test-scenario-config.mjs';
export const result=(port,target,overall)=>({verdict:overall,overall_acceptance:{status:overall,port_verdict:port,target_status:target},port_decision:{verdict:port},target_acceptance:{status:target}});
export const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export const matrix=[['chromium','desktop'],['chromium','laptop'],['chromium','tablet'],['chromium','mobile'],['chromium','narrow-mobile'],['firefox','desktop'],['firefox','mobile'],['webkit','desktop'],['webkit','mobile']];
export const mockBrowserVersions={chromium:'151.0',firefox:'155.0',webkit:'26.6'};
export const mockRuntimeSourceSha='e'.repeat(64);
export const mockBackendRuntimeIdentity=createDeepwellRuntimeIdentity({source_sha256:'d'.repeat(64),ftml_git_revision:'f'.repeat(40),container_id:'c'.repeat(64),image_id:`sha256:${'b'.repeat(64)}`,binary_sha256:'9'.repeat(64),config_sha256:'8'.repeat(64)});
export const mockTargetSite={slug:'scpaiueouiuiuiui',origin:'https://scpaiueouiuiuiui.wikijump.localhost:18443',locale:'ja'};
export const packageResultPath='ports/current-acceptance/testtheme/accepted-result.json';
export const packageAuditPath='ports/current-acceptance/testtheme/browser-audit.json';
export const migrationResultPath='sigma10-migration/current-campaign/accepted-result.json';
export const migrationAuditPath='sigma10-migration/current-campaign/browser-audit.json';
export const core=new Set(['page.normal.settled','credit.view.open','page.history.list','page.source.open','nav.sidebar.open','nav.sidebar.open-submenu','shell.interwiki.visible']);
export const mockCaptureContracts=()=>{
 const contracts=new Map(browserContract.states.map(state=>[`${state.surface}.${state.state}`,{action_contract_sha256:digest('action'),legacy_action_contract_sha256:digest('action'),fixture_contract_sha256:digest('fixture')}]))
 contracts.browser_versions=mockBrowserVersions;
 contracts.target_site=mockTargetSite;
 contracts.expected_runtime_source_sha256=mockRuntimeSourceSha;
 contracts.expected_backend_runtime_identity=mockBackendRuntimeIdentity;
 return contracts;
};
function buildCampaign(migrationSchema){
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'theme-lab-current-campaign-'));
 const root=path.join(workspace,'install/local/theme-lab');fs.mkdirSync(root,{recursive:true});
 for(const surface of new Set(browserContract.states.map(row=>row.surface)))for(const viewport of ['desktop','mobile'])for(const file of runtimeFilesForObservation(surface,viewport)){const target=path.join(workspace,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,'mock runtime input');}
 const write=(name,content)=>{const bytes=typeof content==='string'?content:JSON.stringify(content);const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return {path:name,sha256:digest(bytes)}};
 write('ports/adaptation-authority.json',{packages:{testtheme:{}}});
 write('ports/shared-acceptance-selectors.txt','#page-content\n');
 const css=write('ports/testtheme/candidate.css','body { color: black; }');
 const source=write('ports/testtheme/candidate.wikidot.source.txt','Theme source');
 const preview=write('ports/testtheme/candidate.wikidot.txt','JP preview');
 const frozenNode={id:'theme:testtheme',site:'scp-jp',action:'create',publication_source:'../ports/testtheme/candidate.wikidot.source.txt',source_sha256:source.sha256,candidate_css_sha256:css.sha256,upstream:null,current_jp_source:null,status:'candidate-ready'};
 const frozenBase={schema:'theme_lab_frozen_candidate_set_identity.v1',generated_at:'mock',inventory:{theme_nodes:1,shared_nodes:0,total_nodes:1,edges:0,attachments:0},nodes:[frozenNode],edges:[],attachments:[],targeted_scenarios:[],authority:{},state:'frozen-before-final-acceptance',readiness_audit:'evidence/audits/candidate-freeze-readiness.json',identity_contract:'sha256(JSON.stringify({inventory,nodes,edges,attachments,targeted_scenarios,authority}))'};
 const candidateSetSha=frozenCandidateSetSha256(frozenBase);
 frozenBase.candidate_set_sha256=candidateSetSha;
 const readiness=write('publication/evidence/audits/candidate-freeze-readiness.json',{freeze_record:{state:frozenBase.state,candidate_set_sha256:candidateSetSha}});
 frozenBase.readiness_audit_sha256=readiness.sha256;
 write('publication/frozen-candidate-set.json',frozenBase);
 write('publication/dependency-graph.json',{nodes:[frozenNode],edges:[],targeted_scenarios:[],candidate_freeze:{state:frozenBase.state,candidate_set_sha256:candidateSetSha}});
 const fixtureIdentity=Object.fromEntries(Object.entries({baseline:'fixtures/scp-jp-sigma9-offline.css',sidebar:'fixtures/scp-jp-sidebar.html',header:'fixtures/scp-jp-header.html',navigation:'fixtures/scp-jp-navigation.html'}).map(([name,file])=>[name,write(file,'frozen target '+name).sha256]));
 write('ports/interactive-visual-fixture/runtime-asset-replay.css','');
 const baselineCss=write('sigma10-migration/baseline-probe/candidate.css','body { color: black; }');
 const baselineSource=write('sigma10-migration/baseline-probe/candidate.wikidot.source.txt','Theme source');
 const savedCss=write('sigma10-migration/current-campaign/saved-credit-component.css','/* saved cascade */');
 const sourceManifest=write('sigma10-migration/source-manifest.json',{pages:{}});
 const savedCreditSource=write('ports/authority-evidence/mock-saved-credit-source.wikidot.txt','retained Credit source');
 const cascade={schema:'theme_lab_saved_credit_cascade.v1',order:['baseline','credit:style imports info:style','credit:start inline style'],semantics:'saved page',sources:[{identity:'mock:saved-credit',path:savedCreditSource.path,sha256:savedCreditSource.sha256}]};
 write('sigma10-migration/current-campaign/saved-credit-component.json',{schema:'theme_lab_frozen_component_css.v1',css_sha256:savedCss.sha256,cascade});
 const inventory=[{package:'testtheme',directory:'../../ports/testtheme',candidate_sha256:candidateIdentity(fs.readFileSync(path.join(root,css.path)),Buffer.alloc(0)).candidateSha,source_sha256:source.sha256},{package:'sigma10-baseline',directory:'../baseline-probe',candidate_sha256:candidateIdentity(fs.readFileSync(path.join(root,baselineCss.path)),Buffer.alloc(0)).candidateSha,source_sha256:baselineSource.sha256}];
 const contract={schema:'theme_lab_current_browser_run_contract.v1',target_site:mockTargetSite,expected_runtime_source_sha256:mockRuntimeSourceSha,expected_backend_runtime_identity:mockBackendRuntimeIdentity,
  artifact_namespace:'current-acceptance/mock',candidate_set_sha256:candidateSetSha,baseline_theme:{name:'Sigma-9',replacement_css_path:'../../fixtures/scp-jp-sigma9-offline.css',replacement_css_sha256:fixtureIdentity.baseline},
  viewports:{desktop:{width:1440,height:1000},laptop:{width:1024,height:900},tablet:{width:768,height:1024},mobile:{width:390,height:844},'narrow-mobile':{width:320,height:800}},browser_engines:['chromium','firefox','webkit'],visual_gate_policy:{path:'visual-gate-policy.json',sha256:VISUAL_GATE_POLICY_SHA256},
  current_candidate_inventory:inventory,additional_candidates:Object.fromEntries(inventory.map(row=>[row.package,{directory:row.package==='testtheme'?'../../ports/testtheme':'../baseline-probe',candidate_sha256:row.candidate_sha256,source_sha256:row.source_sha256}])),
  frozen_sigma10_authority:{schema:'theme_lab_frozen_sigma10_authority.v1',source_manifest:'sigma10-migration/source-manifest.json',source_manifest_sha256:sourceManifest.sha256,artifacts:{manifest:sourceManifest}},saved_component_css:{sha256:savedCss.sha256,cascade}};
 const migrationContractDocument={...contract,artifact_namespace:'migration/sigma10-current'};
 migrationContractDocument.baseline_theme={name:'Sigma-10',replacement_css_path:'../sigma10-offline.css',replacement_css_sha256:digest('mock Sigma-10 baseline')};
 migrationContractDocument.schema=migrationSchema;
 migrationContractDocument.visual_gate_policy={path:'../../ports/current-acceptance/visual-gate-policy.json',sha256:VISUAL_GATE_POLICY_SHA256};
 write('sigma10-migration/sigma10-offline.css','mock Sigma-10 baseline');
 const runContract=write('ports/current-acceptance/run-contract.json',contract),migrationContract=write('sigma10-migration/current-campaign/run-contract.json',migrationContractDocument);
 const shot=write('ports/captures/test.png','controlled mock screenshot');
 const auditShotText='controlled mock interactive screenshot',auditShotSha=digest(auditShotText);
 const assetDependencyFor=(theme,runSpec)=>{
  const isBaseline=theme==='sigma10-baseline',themeDir=isBaseline?path.join(root,'sigma10-migration/baseline-probe'):path.join(root,'ports',theme);
  const candidateCss=fs.readFileSync(path.join(themeDir,'candidate.css'));
  const candidateSource=fs.readFileSync(path.join(themeDir,'candidate.wikidot.source.txt'));
  const contractPath=runSpec.artifact_namespace==='current-acceptance/mock'?'ports/current-acceptance/run-contract.json':'sigma10-migration/current-campaign/run-contract.json';
  const baselinePath=path.resolve(root,path.dirname(contractPath),runSpec.baseline_theme.replacement_css_path);
  return candidateAssetDependencyState({portsDir:path.join(root,'ports'),themeDir,runtimeSupportCss:fs.readFileSync(path.join(root,'ports/interactive-visual-fixture/runtime-asset-replay.css'),'utf8'),
   baselineCss:fs.readFileSync(baselinePath,'utf8'),baseCss:Buffer.alloc(0),candidateCss,candidateSource}).asset_dependency_sha256;
 };
 const row=(theme,engine,viewport,state,runSha=runContract.sha256,runSpec=contract)=>{
  const stateKey=`${state.surface.replaceAll('.','-')}-${state.state}-${viewport}`,policy=visualGatePolicyRow({browser_engine:engine,viewport,surface:state.surface,state:state.state});
  const screenshotRequired=policy?.class==='V'||policy?.class==='C',screenshot=`${runSpec.artifact_namespace}/${theme}/artifacts/interactive/${engine}/${viewport}/${stateKey}-${auditShotSha}.png`;
  if(screenshotRequired)write(`ports/${screenshot}`,auditShotText);
  const candidate=runSpec.additional_candidates[theme],candidateDir=theme==='sigma10-baseline'?'sigma10-migration/baseline-probe':'ports/testtheme';
  const candidateSource=fs.readFileSync(path.join(root,candidateDir,'candidate.wikidot.source.txt'));
  const assetDependencySha=assetDependencyFor(theme,runSpec),actionContractSha=digest('action'),fixtureSha=digest('fixture');
  const width={desktop:1440,laptop:1024,tablet:768,mobile:390,'narrow-mobile':320}[viewport],height={desktop:1000,laptop:900,tablet:1024,mobile:844,'narrow-mobile':800}[viewport];
  const locationHash=state.surface==='credit.view'&&state.state==='open'?(runSpec.baseline_theme.name==='Sigma-10'?'':'#u-credit-view'):
   state.surface==='credit.otherwise'&&state.state==='open'?(runSpec.baseline_theme.name==='Sigma-10'?'':'#u-credit-otherwise'):null;
  const record={run_contract_sha256:runSha,baseline_theme_mode:'replacement',baseline_theme:runSpec.baseline_theme.name,baseline_theme_css_sha256:runSpec.baseline_theme.replacement_css_sha256,
   action_contract_observation:locationHash===null?{}:{location_hash:locationHash},action_sequence:[{type:'focusin'},{type:'pointerover'}],capture_state_action_contract_sha256:actionContractSha,fixture_contract_sha256:fixtureSha,
   theme,target_site:mockTargetSite.slug,locale:mockTargetSite.locale,transport_origin:'https://scpaiueouiuiuiui.wikijump.localhost:3395',runtime_source_sha256:mockRuntimeSourceSha,backend_runtime_identity:mockBackendRuntimeIdentity,
   backend_runtime_identity_sha256:mockBackendRuntimeIdentity.identity_sha256,browser_engine:engine,browser_version:mockBrowserVersions[engine],viewport,viewport_size:{width,height},session_state:state.guest?'logged_out':'administrator',surface:state.surface,state:state.state,
   candidate_sha256:candidate.candidate_sha256,candidate_source_sha256:candidate.source_sha256,asset_dependency_sha256:assetDependencySha,classification:'PASS_NATURAL',reviewed_after_last_change:screenshotRequired,
   unconfirmed_items:[],asset_failures:[],page_errors:[],action_responses:[],external_requests_sent:0,visual_diagnostics:{viewport:{width,height,client_width:width,client_height:height,document_width:width,documentWidth:width},title_overlaps:[],horizontalOverflow:[],elements:{}},visual_diagnostics_contract_sha256:digest('visual diagnostics'),
   ...(screenshotRequired?{screenshot,screenshot_sha256:auditShotSha,visual_review:{method:'direct-image-vision-review',screenshot_sha256:auditShotSha,candidate_sha256:candidate.candidate_sha256,candidate_source_sha256:candidate.source_sha256,reviewer:'test',note:'Exact screenshot reviewed for the current mock candidate.',reviewed_at:'2026-10-01T00:00:00Z'},migration_review:{classification:'PASS_NATURAL',screenshot_sha256:auditShotSha}}:{})};
  record.runtime_surface_contract_sha256=runtimeSurfaceContractSha(workspace,record.surface,record.viewport);
  record.scoped_run_contract_sha256=scopedRunContractSha(runSpec,record);
  record.scoped_authority_contract_sha256=scopedRunContractSha(runContractWithoutRuntimeBindings(runSpec),record);
  const environment=browserEnvironmentContractHashes(record,mockCaptureContracts(),runSpec,runSha,{assetDependencySha,candidateStructureSha:null});
  record.environment_contract_sha256=environment.scoped;
  if(policy?.class==='C'){
   for(const selector of visualGateSelectorsFor(policy,record))record.visual_diagnostics.elements[selector]={visibility:'visible',display:'block',rect:{x:4,y:4,width:120,height:36}};
   record.visual_gate={policy_sha256:VISUAL_GATE_POLICY_SHA256,class:policy.class,risk_triggers:['no-comparable-prior-capture'],risk_assessment:{scope:'same-theme-surface-state-engine-viewport',identity_comparison_schema:'theme_lab_visual_risk_identity.v3',previous_capture_found:false,global_runtime_drift:visualGateGlobalRuntimeDrift({},record,{hasPriorCapture:false})}};
   record.state_machine_assertion=buildVisualGateAssertion(record);
   if(policy.key==='content.tabview.second-tab-selected')record.state_machine_assertion.selected=true;
   const nativeDisclosure=runSpec.baseline_theme.name==='Sigma-10'&&(policy.key==='credit.view.open'||policy.key==='credit.otherwise.open');
   if(nativeDisclosure){record.state_machine_assertion.native_disclosure_selector=policy.key==='credit.view.open'?'.creditRate > .rateBox.unfolded':'.creditRateOtherwise > li.unfolded';record.state_machine_assertion.native_disclosure_open=true;}
  }else if(policy?.class==='M'){
   record.visual_gate={policy_sha256:VISUAL_GATE_POLICY_SHA256,class:policy.class,risk_triggers:[]};
   record.functional_assertion={schema:'theme_lab_functional_assertion.v1',policy_sha256:VISUAL_GATE_POLICY_SHA256,key:policy.key,action_contract_sha256:actionContractSha,action_completed:true,action_sequence_count:record.action_sequence.length,candidate_sha256:record.candidate_sha256,candidate_source_sha256:record.candidate_source_sha256,asset_dependency_sha256:record.asset_dependency_sha256,runtime_source_sha256:record.runtime_source_sha256,backend_runtime_identity_sha256:record.backend_runtime_identity_sha256,run_contract_sha256:record.run_contract_sha256,browser_engine:record.browser_engine,browser_version:record.browser_version,viewport:record.viewport};
  }else record.visual_gate={policy_sha256:VISUAL_GATE_POLICY_SHA256,class:policy?.class??null,risk_triggers:[]};
  return record;
 };
 const rows=(theme,normalOnly=false,runSha=runContract.sha256,runSpec=contract)=>matrix.flatMap(([engine,viewport])=>browserContract.states.filter(state=>state.applicable_viewports.includes(viewport)&&(engine==='chromium'||core.has(`${state.surface}.${state.state}`))&&(!normalOnly||state.surface==='page.normal')).map(state=>row(theme,engine,viewport,state,runSha,runSpec)));
 write('ports/testtheme/manifest.json',{reference_url:'https://scp-wiki.wikidot.com/theme:testtheme',en_source_sha256:source.sha256});
 const canonicalViewports=[{id:'desktop',width:1440,height:1000},{id:'laptop',width:1024,height:900},{id:'tablet',width:768,height:1024},{id:'mobile',width:390,height:844},{id:'narrow-mobile',width:320,height:800}];
 write('fixtures/mock-canonical-shell.html','<div id="header"></div>');
 write('fixtures/mock-canonical-baseline.css','body{}');
 write('fixtures/mock-canonical-component.txt','component');
 write('fixtures/theme-canonical-corpus-v1.wikidot.txt','canonical corpus');
 write('fixtures/scp-jp-canonical-site-state-v1.json',{schema:'theme_lab_site_state.v1',branch_profile:'scp-jp',locale:'ja',site_slug:mockTargetSite.slug,existing_pages:[],missing_pages:[],page_tags:['theme'],session_profiles:['anonymous','authenticated']});
 write('fixtures/theme-canonical-corpus-v1.json',{schema:'theme_lab_canonical_corpus.v1',id:'canonical-theme-corpus-v1',source:'theme-canonical-corpus-v1.wikidot.txt',site_state_requirements:{page_tags:['theme'],session_profiles:['anonymous','authenticated']},semantic_probes:[...CANONICAL_SEMANTIC_PROBES]});
 write('fixtures/theme-canonical-corpus-v1-states.json',{schema:'theme_lab_canonical_corpus_states.v1',corpus:'canonical-theme-corpus-v1',viewports:canonicalViewports.map(row=>row.id),session_profiles:['anonymous','authenticated'],interaction_states:[...CANONICAL_INTERACTION_STATES]});
 write('fixtures/theme-canonical-measurement-v1.json',{schema:'theme_lab_measurement_contract.v1',id:'canonical-browser-measurement-v1',viewports:canonicalViewports,browser_engines:['chromium','firefox','webkit'],browser_version_policy:'exact-runtime-version-receipt',session_profiles:['anonymous','authenticated'],network_policy:'block-external-after-local-materialization'});
 write('scenarios/jp-sigma9-extra-black-canonical.json',{schema:'theme_lab_test_scenario_config.v1',runtime:{platform:'wikijump',implementation:'mock-local',implementation_sha256:digest('mock runtime'),origin:mockTargetSite.origin},branch_profile:{id:'scp-jp',locale:'ja',site_slug:mockTargetSite.slug,site_state:'fixtures/scp-jp-canonical-site-state-v1.json'},shell_profile:{id:'scp-jp-sigma9-shell',format:'rendered-html',files:{header:'fixtures/mock-canonical-shell.html'},injection:{headerHtml:'header'}},baseline:{id:'sigma9',css:'fixtures/mock-canonical-baseline.css',components:{mock:'fixtures/mock-canonical-component.txt'}},theme:{id:'placeholder',css:'ports/testtheme/candidate.css',source:'ports/testtheme/candidate.wikidot.source.txt'},corpus:{id:'canonical-theme-corpus-v1',manifest:'fixtures/theme-canonical-corpus-v1.json',source:'fixtures/theme-canonical-corpus-v1.wikidot.txt',states:'fixtures/theme-canonical-corpus-v1-states.json'},measurement:{id:'canonical-browser-measurement-v1',contract:'fixtures/theme-canonical-measurement-v1.json'}});
 write('scenarios/jp-sigma10-extra-black-canonical.json',{schema:'theme_lab_test_scenario_config.v1',runtime:{platform:'wikijump',implementation:'mock-local',implementation_sha256:digest('mock runtime'),origin:mockTargetSite.origin},branch_profile:{id:'scp-jp',locale:'ja',site_slug:mockTargetSite.slug,site_state:'fixtures/scp-jp-canonical-site-state-v1.json'},shell_profile:{id:'scp-jp-sigma10-shell',format:'rendered-html',files:{header:'fixtures/mock-canonical-shell.html'},injection:{headerHtml:'header'}},baseline:{id:'sigma10',css:'fixtures/mock-canonical-baseline.css',components:{mock:'fixtures/mock-canonical-component.txt'}},theme:{id:'placeholder',css:'ports/testtheme/candidate.css',source:'ports/testtheme/candidate.wikidot.source.txt'},corpus:{id:'canonical-theme-corpus-v1',manifest:'fixtures/theme-canonical-corpus-v1.json',source:'fixtures/theme-canonical-corpus-v1.wikidot.txt',states:'fixtures/theme-canonical-corpus-v1-states.json'},measurement:{id:'canonical-browser-measurement-v1',contract:'fixtures/theme-canonical-measurement-v1.json'}});
 const canonicalConfig=themeScenarioConfigForPackage(root,{generation:'sigma9',packageName:'testtheme'}),canonicalMaterialized=materializeThemeTestScenario(root,canonicalConfig);
 const canonicalEngines=Object.fromEntries(['chromium','firefox','webkit'].map(engine=>[engine,Object.fromEntries(['anonymous','authenticated'].map(profile=>{const executionBase={schema:'theme_lab_canonical_execution.v1',backend_runtime_identity:mockBackendRuntimeIdentity,scenario_sha256:canonicalMaterialized.scenario_sha256,session_profile:profile,session_observation:{my_account_text:profile==='authenticated'?'Administrator':null,logout_link_present:profile==='authenticated',sign_in_link_present:profile==='anonymous'},check_evidence:{verification_scope:'pass',target_acceptance:'pass',image_diagnostics:'pass',japanese_glyph_rendering:'pass'},interaction_states:CANONICAL_INTERACTION_STATES.map(id=>({id,status:'pass'})),semantic_probes:CANONICAL_SEMANTIC_PROBES.map(id=>({id,status:'pass'}))};const canonical_execution={...executionBase,canonical_execution_sha256:digest(JSON.stringify(executionBase))};const receiptBase={schema:'theme_lab_measurement_receipt.v1',scenario_sha256:canonicalMaterialized.scenario_sha256,measurement_contract_sha256:canonicalMaterialized.bindings.measurement_contract.sha256,engine,browser_version:mockBrowserVersions[engine],session_profile:profile,canonical_execution_sha256:canonical_execution.canonical_execution_sha256};return[profile,{canonical_execution,measurement_receipt:{...receiptBase,receipt_sha256:digest(JSON.stringify(receiptBase))}}]}))]));
 const canonicalMatrixBase={schema:'theme_lab_scenario_matrix.v1',scenario_sha256:canonicalMaterialized.scenario_sha256,measurement_contract_sha256:canonicalMaterialized.bindings.measurement_contract.sha256,engines:canonicalEngines};
 const canonicalMatrix={...canonicalMatrixBase,matrix_receipt_sha256:digest(JSON.stringify(canonicalMatrixBase)),canonical_acceptance_eligible:false,blockers:['producer has no promotion authority']};
 const sigma10Config=themeScenarioConfigForPackage(root,{generation:'sigma10',packageName:'testtheme'}),sigma10Materialized=materializeThemeTestScenario(root,sigma10Config);
 const sigma10Engines=Object.fromEntries(['chromium','firefox','webkit'].map(engine=>[engine,Object.fromEntries(['anonymous','authenticated'].map(profile=>{const executionBase={schema:'theme_lab_canonical_execution.v1',backend_runtime_identity:mockBackendRuntimeIdentity,scenario_sha256:sigma10Materialized.scenario_sha256,session_profile:profile,session_observation:{my_account_text:profile==='authenticated'?'Administrator':null,logout_link_present:profile==='authenticated',sign_in_link_present:profile==='anonymous'},check_evidence:{verification_scope:'pass',target_acceptance:'pass',image_diagnostics:'pass',japanese_glyph_rendering:'pass'},interaction_states:CANONICAL_INTERACTION_STATES.map(id=>({id,status:'pass'})),semantic_probes:CANONICAL_SEMANTIC_PROBES.map(id=>({id,status:'pass'}))};const canonical_execution={...executionBase,canonical_execution_sha256:digest(JSON.stringify(executionBase))};const receiptBase={schema:'theme_lab_measurement_receipt.v1',scenario_sha256:sigma10Materialized.scenario_sha256,measurement_contract_sha256:sigma10Materialized.bindings.measurement_contract.sha256,engine,browser_version:mockBrowserVersions[engine],session_profile:profile,canonical_execution_sha256:canonical_execution.canonical_execution_sha256};return[profile,{canonical_execution,measurement_receipt:{...receiptBase,receipt_sha256:digest(JSON.stringify(receiptBase))}}]}))]));
 const sigma10MatrixBase={schema:'theme_lab_scenario_matrix.v1',scenario_sha256:sigma10Materialized.scenario_sha256,measurement_contract_sha256:sigma10Materialized.bindings.measurement_contract.sha256,engines:sigma10Engines};
 const sigma10Matrix={...sigma10MatrixBase,matrix_receipt_sha256:digest(JSON.stringify(sigma10MatrixBase)),canonical_acceptance_eligible:false,blockers:['producer has no promotion authority']};
 const audit={state_applicability:browserContract.states,canonical_scenario:canonicalMatrix,records:rows('testtheme')};
 const migrationAudit={state_applicability:browserContract.states,canonical_scenarios:{testtheme:sigma10Matrix},records:[...rows('testtheme',false,migrationContract.sha256,migrationContractDocument),...rows('sigma10-baseline',false,migrationContract.sha256,migrationContractDocument)]};
 const full={target_fixture_identity:fixtureIdentity,target_acceptance_contract_sha256:TARGET_ACCEPTANCE_CONTRACT_SHA256,full_check_input_bindings:currentPackageFullCheckInputBindings(root,'testtheme'),...result('pass','pass','pass'),candidate_css_sha256:css.sha256,candidate_source_sha256:source.sha256,candidate_preview_sha256:preview.sha256,verification_scope:{mode:'full',deferred:[]},viewport_status:Object.fromEntries(['desktop','laptop','tablet','mobile','narrow-mobile'].map(viewport=>[viewport,{status:'pass'}])),font_diagnostics:{status:'measured',fonts:[{glyph_count:20}]},visual:{viewports:Object.fromEntries(['desktop','laptop','tablet','mobile','narrow-mobile'].map(viewport=>[viewport,{status:'pass',candidate_path:shot.path,reference_path:shot.path,candidate_screenshot_sha256:shot.sha256,reference_screenshot_sha256:shot.sha256,review:{candidate_screenshot_sha256:shot.sha256,reference_screenshot_sha256:shot.sha256}}]))}};
 full.target_runtime_identity={schema:'theme_lab_built_target_runtime.v1',source_sha256:currentTargetRuntimeSourceSha(root),header_source_sha256:currentTargetRuntimeSourceSha(root),backend_runtime_identity:mockBackendRuntimeIdentity,transport_origin:'https://scpaiueouiuiuiui.wikijump.localhost:3398',response_url:'https://scpaiueouiuiuiui.wikijump.localhost:3398/boundary-check',response_status:200};
 full.canonical_scenario_evidence={generation:'sigma9',scenario_sha256:canonicalMaterialized.scenario_sha256,matrix_receipt_sha256:canonicalMatrix.matrix_receipt_sha256,measurement_contract_sha256:canonicalMaterialized.bindings.measurement_contract.sha256};
 const visualReview={schema:'theme_lab_visual_acceptance.v1',candidate_css_sha256:css.sha256,candidate_source_sha256:source.sha256,candidate_preview_sha256:preview.sha256,candidate_base_css_sha256:null};
 const visualReviewBinding=write('ports/current-acceptance/testtheme/visual-review.json',visualReview);
 full.image_review_provenance={schema:'theme_lab_visual_acceptance.v1',review_sha256:digest(JSON.stringify(visualReview)),raw_result_sha256:digest('raw result'),candidate_css_sha256:css.sha256,candidate_source_sha256:source.sha256,candidate_preview_sha256:preview.sha256,candidate_base_css_sha256:null};
 const browserBinding=write(packageAuditPath,audit);full.browser_acceptance={...browserBinding,records:audit.records.length};
 const receipt=write(packageResultPath,full);
 const migrationBinding=write(migrationAuditPath,migrationAudit);
 const migrationResult={schema:'theme_lab_current_sigma10_acceptance.v1',run_contract_sha256:migrationContract.sha256,overall_acceptance:{status:'pass'},browser_audit_sha256:migrationBinding.sha256,canonical_scenario_evidence:{testtheme:{generation:'sigma10',scenario_sha256:sigma10Materialized.scenario_sha256,matrix_receipt_sha256:sigma10Matrix.matrix_receipt_sha256,measurement_contract_sha256:sigma10Materialized.bindings.measurement_contract.sha256}}};
 const document={schema:'theme_lab_current_campaign_acceptance.v1',packages:[{package:'testtheme',inputs:{css,source,preview},receipt,browser_audit:browserBinding,visual_review:visualReviewBinding}],migration:{receipt:write(migrationResultPath,migrationResult),browser_audit:migrationBinding}};
 const save=()=>write('current-campaign-acceptance.json',document);save();return{root,workspace,document,write,save,audit,migrationResult,full,migrationAudit,sigma10Matrix,migrationContract};
}
const campaignTemplates=new Map();
let campaignTemplateCleanup=false;
function campaignTemplate(migrationSchema){
 let template=campaignTemplates.get(migrationSchema);
 if(!template){
  template=buildCampaign(migrationSchema);
  campaignTemplates.set(migrationSchema,template);
  if(!campaignTemplateCleanup){
   campaignTemplateCleanup=true;
   process.on('exit',()=>{for(const entry of campaignTemplates.values())fs.rmSync(entry.workspace,{recursive:true,force:true});});
  }
 }
 return template;
}
function campaignGraph(bundle){
 return {document:bundle.document,audit:bundle.audit,migrationResult:bundle.migrationResult,full:bundle.full,migrationAudit:bundle.migrationAudit,sigma10Matrix:bundle.sigma10Matrix,migrationContract:bundle.migrationContract};
}
function campaignTreeDigest(workspace){
 const rows=[];
 const walk=(dir)=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:1)){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else rows.push([path.relative(workspace,file),digest(fs.readFileSync(file))]);}};
 walk(workspace);
 return JSON.stringify(rows);
}
function cloneCampaign(template){
 const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'theme-lab-current-campaign-'));
 const root=path.join(workspace,'install/local/theme-lab');
 fs.cpSync(template.workspace,workspace,{recursive:true});
 const graph=structuredClone(campaignGraph(template));
 const write=(name,content)=>{const bytes=typeof content==='string'?content:JSON.stringify(content);const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return {path:name,sha256:digest(bytes)};};
 const save=()=>write('current-campaign-acceptance.json',graph.document);
 return {root,workspace,document:graph.document,write,save,audit:graph.audit,migrationResult:graph.migrationResult,full:graph.full,migrationAudit:graph.migrationAudit,sigma10Matrix:graph.sigma10Matrix,migrationContract:graph.migrationContract};
}
const shadowCampaignFixture=process.env.THEME_LAB_FIXTURE_SHADOW==='1';
export function mockCampaign({migrationSchema='theme_lab_current_browser_run_contract.v1'}={}){
 const clone=cloneCampaign(campaignTemplate(migrationSchema));
 if(shadowCampaignFixture){
  const fresh=buildCampaign(migrationSchema);
  try{
   if(campaignTreeDigest(fresh.workspace)!==campaignTreeDigest(clone.workspace))throw new Error('mockCampaign clone tree differs from a fresh build');
   if(JSON.stringify(campaignGraph(fresh))!==JSON.stringify(campaignGraph(clone)))throw new Error('mockCampaign clone graph differs from a fresh build');
  }finally{fs.rmSync(fresh.workspace,{recursive:true,force:true});}
 }
 return clone;
}
