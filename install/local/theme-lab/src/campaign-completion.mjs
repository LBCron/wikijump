import {DEFAULT_SIGMA10_RUN_CONTRACT,DEFAULT_SIGMA9_RUN_CONTRACT,resolveRunContractOption} from './current-run-contract-option.mjs';
import {runtimeSurfaceContractSha} from './browser-runtime-contract.mjs';
import {observationRuntimeSourceMatchesContract,requireRuntimeSourceSha} from './runtime-source-identity.mjs';
import {readCurrentBrowserContracts,observationHasCurrentActionAndFixture,observationHasCurrentEnvironment} from './current-browser-contracts.mjs';
import {semanticSourceReferenceHtmlSha,validateSemanticSourceAuthority} from './semantic-source-authority.mjs';
// Promotion is distinct from read-only inspection of historical evidence.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import browserContract from '../fixtures/browser-acceptance-states.json' with {type:'json'};
import {candidateIdentity} from '../ports/scripts/candidate-identity.mjs';
import {ACCEPTANCE_VIEWPORT_IDS} from './acceptance-viewports.mjs';
import {overallAcceptance} from './verdict.mjs';
import {SEMANTIC_BROWSER_MODEL, validateSemanticBrowserAcceptance, semanticReviewArtifactBindings} from './semantic-browser-acceptance.mjs';
import {captureRunContractIsCurrent,scopedRunContractSha} from './scoped-run-contract.mjs';
import {readBoundArtifact} from './artifact-binding.mjs';
import {TARGET_ACCEPTANCE_CONTRACT_SHA256} from './target-acceptance-contract.mjs';
import {isAdmittedTargetAcceptanceContract} from './target-acceptance-instruments.mjs';
import {candidateAssetDependencyState} from './candidate-asset-dependencies.mjs';
import {resolveRunContractPath} from './run-contract-path.mjs';
import {currentPackageFullCheckInputBindings} from './full-check-input-bindings.mjs';
import {verifyFaithfulDesignWaivers} from './finalize-visual-acceptance.mjs';
import {candidateSourceName, declaredCandidateSourceName} from './theme-package.mjs';
import {resolveExistingContainedDirectory,resolveExistingContainedFile,resolveExistingPackageDirectory,resolveExistingPackageFile} from './package-path.mjs';
import {currentPackageBaseCss} from './candidate-base-contract.mjs';
import {validateCanonicalScenarioMatrix} from './theme-test-matrix-evidence.mjs';
import {currentTargetRuntimeSourceSha,targetRuntimeIdentityFailures} from './target-runtime-identity.mjs';
import {runContractWithoutRuntimeBindings,validateVisualGateRecord,visualGateNeedsScreenshot,VISUAL_GATE_POLICY_SHA256} from './visual-gate.mjs';
import {validatePublicationCandidateSet} from './publication-candidate-freeze.mjs';
import {deepwellRuntimeIdentityMatchesContract,requireDeepwellRuntimeIdentity} from './deepwell-runtime-identity.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const accepted = value => ['pass', 'warn'].includes(value);
const canonicalAuditBinding = (binding, expected) => binding?.path === expected ||
  binding?.path === expected + '.gz' && binding.encoding === 'gzip' && /^[a-f0-9]{64}$/u.test(binding.uncompressed_sha256 ?? '');
const optionalPackageBytes=(directory,file,label)=>fs.existsSync(path.join(directory,file))
  ?fs.readFileSync(resolveExistingPackageFile(directory,file,label))
  :null;
const validateSavedComponentSources=(root,saved)=>{
  const sources=saved?.cascade?.sources;
  if(!Array.isArray(sources)||!sources.length)throw new Error('Saved-page Credit cascade lacks retained source artifacts');
  const identities=new Set(),paths=new Set();
  for(const source of sources){
    if(typeof source?.identity!=='string'||!source.identity||typeof source?.path!=='string'||!/^[0-9a-f]{64}$/u.test(source?.sha256??''))throw new Error('Saved-page Credit source binding is invalid');
    if(identities.has(source.identity)||paths.has(source.path))throw new Error('Saved-page Credit source binding is duplicated');
    identities.add(source.identity);paths.add(source.path);
    const bytes=fs.readFileSync(resolveExistingContainedFile(root,source.path,`Saved-page Credit source ${source.identity}`));
    if(sha(bytes)!==source.sha256)throw new Error(`Saved-page Credit source changed: ${source.identity}`);
  }
};
export const canonicalScreenshotPath=(contract,row)=>{
  const namespace=contract.artifact_namespace?`${contract.artifact_namespace}/`:'';
  const stateKey=`${row.surface.replaceAll('.','-')}-${row.state}-${row.viewport}`;
  // A source-owned navigation replacement intentionally records the failed
  // ordinary sidebar action. Keep that capture's explicit failure marker in
  // the canonical filename; semantic source authority validates the exact
  // replacement observation and screenshot before campaign acceptance.
  const failed=row.action_contract_observation?.mode==='source-navigation-replaces-sidebar'?'failed-':'';
  return `${namespace}${row.theme}/artifacts/interactive/${row.browser_engine}/${row.viewport}/${stateKey}-${failed}${row.screenshot_sha256}.png`;
};

export function validateCurrentSigma10Contract(root,sigma10Contract=DEFAULT_SIGMA10_RUN_CONTRACT){
 const failures=[];const read=file=>fs.readFileSync(resolveExistingContainedFile(root,file,'Current Sigma-10 artifact'));
 try{
  const contractPath=path.join(root,sigma10Contract);
  const contract=JSON.parse(read(sigma10Contract));
  failures.push(...validatePublicationCandidateSet(root,{expectedCandidateSetSha256:contract.candidate_set_sha256,contract,label:'Sigma-10 publication candidate set'}));
  if(contract.visual_gate_policy?.sha256!==VISUAL_GATE_POLICY_SHA256)failures.push('Current Sigma-10 run contract is not bound to the maintained 145-state visual gate policy');
  if(!(sigma10Contract===DEFAULT_SIGMA10_RUN_CONTRACT?contract.artifact_namespace==='migration/sigma10-current':/^migration\/sigma10-[a-z0-9-]+$/u.test(contract.artifact_namespace??'')))failures.push('Current Sigma-10 artifact namespace is not isolated from historical migration evidence');
  const ledger=JSON.parse(read('ports/adaptation-authority.json'));
  const expected=[...Object.keys(ledger.packages),'sigma10-baseline'].sort();
  const inventory=contract.current_candidate_inventory??[];
  if(inventory.length!==expected.length||inventory.map(row=>row.package).sort().join('\0')!==expected.join('\0'))failures.push('Sigma-10 current candidate inventory does not enumerate every maintained candidate plus baseline');
  if(JSON.stringify(Object.keys(contract.additional_candidates??{}).sort())!==JSON.stringify(expected))failures.push('Sigma-10 capture candidates do not match the explicit current inventory');
  for(const row of inventory){
   const capture=contract.additional_candidates?.[row.package];
   if(!capture||capture.directory!==row.directory||capture.candidate_sha256!==row.candidate_sha256||capture.source_sha256!==row.source_sha256)failures.push(`${row.package}: capture identity differs from the declared current inventory`);
   const dir=resolveRunContractPath(root,path.dirname(contractPath),row.directory,`Current Sigma-10 candidate directory for ${row.package}`);
   const expectedDir=row.package==='sigma10-baseline'
    ?resolveExistingContainedDirectory(root,'sigma10-migration/baseline-probe','Sigma-10 baseline directory')
    :resolveExistingPackageDirectory(path.join(root,'ports'),row.package,`${row.package}: package directory`);
   if(dir!==expectedDir){failures.push(`${row.package}: current Sigma-10 inventory points at the wrong package directory`);continue;}
   const base=(row.package==='sigma10-baseline'?optionalPackageBytes(dir,'candidate-base.css',`${row.package}: Sigma-10 base CSS`):currentPackageBaseCss(dir,row.package))??Buffer.alloc(0);
   const css=fs.readFileSync(resolveExistingPackageFile(dir,'candidate.css',`${row.package}: Sigma-10 candidate CSS`));
   const sourceFile=candidateSourceName(dir,ledger.packages[row.package]);
   let source;
   try{source=fs.readFileSync(resolveExistingPackageFile(dir,sourceFile,`${row.package}: Sigma-10 source file`))}
   catch(error){
    if(ledger.packages[row.package]?.source_file)throw error;
    source=fs.readFileSync(resolveExistingPackageFile(dir,'candidate.wikidot.txt',`${row.package}: Sigma-10 preview source`));
   }
   if(candidateIdentity(css,base).candidateSha!==row.candidate_sha256||sha(source)!==row.source_sha256)failures.push(`${row.package}: current Sigma-10 contract candidate identity is stale`);
  }
  for(const binding of Object.values(contract.frozen_sigma10_authority?.artifacts??{}))if(sha(read(binding.path))!==binding.sha256)failures.push(`Frozen Sigma-10 authority changed: ${binding.path}`);
  const manifestBytes=read(contract.frozen_sigma10_authority.source_manifest);
  if(sha(manifestBytes)!==contract.frozen_sigma10_authority.source_manifest_sha256)failures.push('Frozen Sigma-10 source manifest changed');
  const manifest=JSON.parse(manifestBytes);
  for(const [identity,page] of Object.entries(manifest.pages??{}))if(sha(fs.readFileSync(resolveExistingContainedFile(root,page.file,`Frozen Sigma-10 source ${identity}`,path.join(root,'sigma10-migration'))))!==page.sha256)failures.push(`Frozen Sigma-10 source changed: ${identity}`);
  const saved=JSON.parse(read('sigma10-migration/current-campaign/saved-credit-component.json'));
  if(saved.schema!=='theme_lab_frozen_component_css.v1'||saved.css_sha256!==contract.saved_component_css?.sha256||JSON.stringify(saved.cascade)!==JSON.stringify(contract.saved_component_css?.cascade)||sha(read('sigma10-migration/current-campaign/saved-credit-component.css'))!==saved.css_sha256)failures.push('Saved-page Credit cascade or CSS binding is invalid');
  validateSavedComponentSources(root,saved);
 }catch(error){failures.push(`Current Sigma-10 contract invalid: ${error.message}`)}
 return failures;
}

export function validateCombinedAcceptance(result, label) {
  const overall = result?.overall_acceptance;
  const target = result?.target_acceptance ?? result?.local_target_acceptance;
  const port = result?.port_decision;
  const failures = [];
  if (!accepted(overall?.status)) failures.push(`${label}: current overall acceptance is ${overall?.status ?? 'missing'}`);
  if (!accepted(port?.verdict)) failures.push(`${label}: current port decision is ${port?.verdict ?? 'missing'}`);
  if (!accepted(target?.status)) failures.push(`${label}: current target acceptance is ${target?.status ?? 'missing'}`);
  if (overall?.port_verdict !== port?.verdict || overall?.target_status !== target?.status) failures.push(`${label}: combined acceptance dimensions disagree`);
  if(overall?.status!==overallAcceptance(port?.verdict,target?.status))failures.push(`${label}: overall result does not combine both acceptance dimensions`);
  if (result?.verdict !== overall?.status) failures.push(`${label}: public verdict disagrees with combined acceptance`);
  return failures;
}

const matrix=[['chromium','desktop'],['chromium','laptop'],['chromium','tablet'],['chromium','mobile'],['chromium','narrow-mobile'],['firefox','desktop'],['firefox','mobile'],['webkit','desktop'],['webkit','mobile']];
const crossEngineCore=new Set(['page.normal.settled','credit.view.open','page.history.list','page.source.open','nav.sidebar.open','nav.sidebar.open-submenu','shell.interwiki.visible']);

export function validateBrowserCoverage(audit,packages,{migration=false}={}) {
 const failures=[];
 const records=audit.records??[];
 const keys=new Set(records.map(row=>`${row.theme}|${row.browser_engine}|${row.viewport}|${row.surface}.${row.state}`));
 const expectedKeys=new Set();
 const states=audit.state_applicability??[];
 if(JSON.stringify(states)!==JSON.stringify(browserContract.states))failures.push('Browser state applicability differs from the maintained acceptance contract');
 for(const name of packages)for(const [engine,viewport] of matrix) {
  // Final Sigma-10 migration acceptance uses the full maintained browser contract.
  const required=browserContract.states;
  for(const state of required) {
   const id=`${state.surface}.${state.state}`;
   if(!state.applicable_viewports?.includes(viewport) || engine!=='chromium'&&!crossEngineCore.has(id))continue;
   const key=`${name}|${engine}|${viewport}|${id}`;
   expectedKeys.add(key);
   if(!keys.has(key))failures.push(`Missing current browser state ${key}`);
  }
 }
 // A source-owned navigation exception can require one exact replacement
 // action observation outside the ordinary state denominator. Permit only
 // rows explicitly named by that exception; semanticSourceAuthority validates
 // the source/candidate identities, replacement screenshot and dependency
 // receipt before a campaign can accept the evidence.
 const declaredSupplementaryKeys=new Set();
 for(const row of records){
  const action=row.action_contract_observation;
  if(action?.mode!=='source-navigation-replaces-sidebar'||typeof action.replacement?.key!=='string')continue;
  try{
   const tuple=JSON.parse(action.replacement.key);
   if(Array.isArray(tuple)&&tuple.length===5&&tuple[0]===row.theme&&tuple.every(value=>typeof value==='string'))
    declaredSupplementaryKeys.add(`${tuple[0]}|${tuple[1]}|${tuple[2]}|${tuple[3]}.${tuple[4]}`);
  }catch{}
 }
 for(const key of keys)if(!expectedKeys.has(key)&&!declaredSupplementaryKeys.has(key))failures.push(`Unexpected current browser state ${key}`);
 if(keys.size!==records.length)failures.push('Duplicate browser acceptance rows');
 return failures;
}

// Asset dependency of one maintained or baseline Sigma-10 candidate. Shared by
// the completion gate and the Sigma-10 audit validator below.
const candidateAssetDependencySha=(root,ledger,name,dir,sourceName,baselineCss)=>{
  const runtimeSupportCss=fs.readFileSync(resolveExistingContainedFile(root,'ports/interactive-visual-fixture/runtime-asset-replay.css','Current runtime asset replay CSS'),'utf8');
  const base=ledger.packages[name]
    ?currentPackageBaseCss(dir,name)??Buffer.alloc(0)
    :optionalPackageBytes(dir,'candidate-base.css',`${name}: asset-dependency base CSS`)??Buffer.alloc(0);
  const css=fs.readFileSync(resolveExistingPackageFile(dir,'candidate.css',`${name}: asset-dependency candidate CSS`));
  let source;
  try{source=fs.readFileSync(resolveExistingPackageFile(dir,sourceName,`${name}: asset-dependency source file`))}
  catch(error){
    if(ledger.packages[name]?.source_file)throw error;
    source=fs.readFileSync(resolveExistingPackageFile(dir,'candidate.wikidot.txt',`${name}: asset-dependency preview source`));
  }
  return candidateAssetDependencyState({portsDir:path.join(root,'ports'),themeDir:dir,runtimeSupportCss,baselineCss,baseCss:base,candidateCss:css,candidateSource:source}).asset_dependency_sha256;
};

// Audit-level Sigma-10 acceptance: the browser audit, its canonical scenario
// matrices and every record's identity against the current run contract. The
// completion gate and the Sigma-10 finalizer both call this, so a decision is
// refused by exactly the checks that later gate it. It reads no decision file
// and writes nothing; it returns failures (empty means the audit validates).
export function validateSigma10MigrationAudit(root,{sigma10Contract=DEFAULT_SIGMA10_RUN_CONTRACT,audit,evidence,nonblockingObservations=[],captureContractReader=readCurrentBrowserContracts}={}){
 const failures=[];
 try{
  const read=file=>JSON.parse(fs.readFileSync(resolveExistingContainedFile(root,file,`Current Sigma-10 input ${file}`),'utf8'));
  const ledger=read('ports/adaptation-authority.json');
  const names=Object.keys(ledger.packages).sort();
  const migrationNames=[...names,'sigma10-baseline'].sort();
  const contractPath=resolveExistingContainedFile(root,sigma10Contract,'Current Sigma-10 run contract');
  const contractSha=sha(fs.readFileSync(contractPath));
  const spec=JSON.parse(fs.readFileSync(contractPath,'utf8'));
  const baselineCss=fs.readFileSync(resolveRunContractPath(root,path.dirname(contractPath),spec.baseline_theme.replacement_css_path,'current Sigma-10 baseline replacement CSS'),'utf8');
  const inventoryByName=new Map((spec.current_candidate_inventory??[]).map(item=>[item.package,item]));
  const captureContracts=new Map();
  const runtimeHashes=new Map();
  const currentRuntime=row=>{
    const key=JSON.stringify([row.surface,row.viewport]);
    if(!runtimeHashes.has(key))runtimeHashes.set(key,runtimeSurfaceContractSha(path.resolve(root,'../../..'),row.surface,row.viewport));
    return row.runtime_surface_contract_sha256===runtimeHashes.get(key);
  };
  const currentCapture=(row,contract)=>{
    if(!captureContracts.has(contract))captureContracts.set(contract,captureContractReader(root,contract));
    return observationHasCurrentActionAndFixture(row,captureContracts.get(contract));
  };
  const assetDependencies=new Map(),structureShas=new Map();
  for(const name of migrationNames){
    const binding=spec.additional_candidates?.[name];
    if(!binding)continue;
    const relative=typeof binding==='string'?binding:binding.directory;
    const dir=resolveRunContractPath(root,path.dirname(contractPath),relative,`Sigma-10 candidate directory for ${name}`);
    const sourceName=candidateSourceName(dir,ledger.packages[name]);
    assetDependencies.set(name,candidateAssetDependencySha(root,ledger,name,dir,sourceName,baselineCss));
    let structureSha=null;try{structureSha=sha(fs.readFileSync(resolveExistingPackageFile(dir,'acceptance-structure.json',`${name}: acceptance structure`)))}catch{}
    structureShas.set(name,structureSha);
  }
  const browserVersions={};
  for(const record of audit.records??[]){
   const previous=browserVersions[record.browser_engine];
   if(previous&&previous!==record.browser_version)failures.push(`migration browser audit mixes ${record.browser_engine} versions`);
   browserVersions[record.browser_engine]=record.browser_version;
  }
  try{
   const scenarioNames=Object.keys(audit.canonical_scenarios??{}).sort();
   if(JSON.stringify(scenarioNames)!==JSON.stringify(names))throw new Error('Sigma-10 canonical scenario matrix inventory does not match maintained packages');
   if(JSON.stringify(Object.keys(evidence??{}).sort())!==JSON.stringify(names))throw new Error('Sigma-10 decision canonical scenario evidence inventory does not match maintained packages');
   for(const name of names){
    const canonical=validateCanonicalScenarioMatrix({root,packageName:name,generation:'sigma10',matrix:audit.canonical_scenarios[name],browserVersions,runContract:sigma10Contract});
    const bound=evidence[name];
    if(bound?.generation!=='sigma10'||bound?.scenario_sha256!==canonical.scenario_sha256||bound?.matrix_receipt_sha256!==canonical.matrix_receipt_sha256||bound?.measurement_contract_sha256!==canonical.measurement_contract_sha256)throw new Error(`${name}: Sigma-10 decision is not bound to current canonical scenario evidence`);
   }
  }catch(error){failures.push(`Sigma-10 canonical scenario evidence is missing or stale: ${error.message}`)}
  const semantic=audit.acceptance_model===SEMANTIC_BROWSER_MODEL;
  if(semantic){
    failures.push(...validateSemanticBrowserAcceptance(audit).failures,...validateSemanticSourceAuthority(root,audit,{sigma10RunContract:sigma10Contract}));
    for(const artifact of semanticReviewArtifactBindings(audit)){
      try{readBoundArtifact(root,artifact.binding,artifact.label)}catch(error){failures.push(error.message)}
    }
  }
  failures.push(...validateBrowserCoverage(audit,migrationNames,{migration:true}));
  for(const record of audit.records??[]){
    failures.push(...validateVisualGateRecord(record));
    const screenshotRequired=visualGateNeedsScreenshot(record,{failure:!!record.failure});
    if(!observationRuntimeSourceMatchesContract(record,spec))failures.push(`Sigma-10: browser runtime source SHA is missing or differs from the current run contract for ${record.theme}/${record.surface}`);
    if(!deepwellRuntimeIdentityMatchesContract(record,spec))failures.push(`Sigma-10: browser Deepwell backend identity is missing or differs from the current run contract for ${record.theme}/${record.surface}`);
    if(semantic&&!currentRuntime(record))failures.push(`Sigma-10: superseded browser runtime surface ${record.theme}/${record.surface}`);
    if(semantic&&!currentCapture(record,sigma10Contract))failures.push(`Sigma-10: superseded browser action/fixture ${record.theme}/${record.surface}.${record.state}`);
    const expected=inventoryByName.get(record.theme);
    if(!expected||record.candidate_sha256!==expected.candidate_sha256||record.candidate_source_sha256!==expected.source_sha256)failures.push(`Sigma-10 capture uses an undeclared or superseded candidate identity: ${record.theme}`);
    if(record.asset_dependency_sha256!==assetDependencies.get(record.theme))failures.push(`Sigma-10 capture uses a superseded asset dependency: ${record.theme}`);
    if(semantic&&!observationHasCurrentEnvironment(record,captureContracts.get(sigma10Contract),spec,contractSha,{assetDependencySha:assetDependencies.get(record.theme),candidateStructureSha:structureShas.get(record.theme)}))failures.push(`Sigma-10 capture uses a superseded environment contract: ${record.theme}/${record.surface}.${record.state}`);
    if(record.scoped_authority_contract_sha256!==scopedRunContractSha(runContractWithoutRuntimeBindings(spec),record))failures.push(`Sigma-10: browser capture lacks the current scoped authority contract identity for ${record.theme}/${record.surface}.${record.state}`);
    if(!captureRunContractIsCurrent(record,spec,contractSha)||record.baseline_theme_mode!=='replacement'||record.baseline_theme_css_sha256!==spec.baseline_theme.replacement_css_sha256)failures.push('Sigma-10 capture uses superseded baseline/contract');
    if(!Array.isArray(record.unconfirmed_items)||!Array.isArray(record.asset_failures)||!Array.isArray(record.page_errors)||!Array.isArray(record.action_responses)||record.action_responses.some(response=>response.type==='failure'||response.status>=400||response.error_message))failures.push('Sigma-10 capture lacks clean explicit safety results');
    if(!semantic && (record.unconfirmed_items?.length||record.asset_failures?.length||record.page_errors?.length||record.external_requests_sent!==0||screenshotRequired&&!record.reviewed_after_last_change||screenshotRequired&&record.migration_review?.screenshot_sha256!==record.screenshot_sha256))failures.push(`Unresolved Sigma-10 state ${record.theme}/${record.surface}.${record.state}`);
    if(!semantic && (!['PASS_NATURAL','PASS_INTENTIONAL_DIVERGENCE','EXTERNAL_CONTRACT_UNVERIFIABLE','NOT_APPLICABLE'].includes(record.classification)||screenshotRequired&&(record.migration_review?.classification!==record.classification||record.visual_review?.screenshot_sha256!==record.screenshot_sha256)))failures.push(`Sigma-10 state lacks a current accepted visual review: ${record.theme}/${record.surface}.${record.state}`);
    if(screenshotRequired){
      if(record.screenshot!==canonicalScreenshotPath(spec,record))failures.push(`Sigma-10 screenshot path is not canonical content-addressed evidence: ${record.theme}/${record.surface}.${record.state}`);
      try{readBoundArtifact(root,{path:`ports/${record.screenshot}`,sha256:record.screenshot_sha256},'Sigma-10 screenshot')}catch(error){failures.push(error.message)}
    }else if(record.screenshot||record.screenshot_sha256)failures.push(`successful machine-only Sigma-10 state retained a screenshot: ${record.theme}/${record.surface}.${record.state}`);
    if(!semantic && !['PASS_NATURAL','PASS_INTENTIONAL_DIVERGENCE','EXTERNAL_CONTRACT_UNVERIFIABLE','NOT_APPLICABLE'].includes(record.classification)&&!nonblockingObservations.some(item=>item.screenshot_sha256===record.screenshot_sha256&&item.blocker===false&&item.authority!=='WIKIDOT_RUNTIME_PARITY'))failures.push(`Unresolved Sigma-10 classification ${record.theme}/${record.surface}.${record.state}`);
  }
  for(const name of names){
    const records=audit.records?.filter(record=>record.theme===name)??[];
    if(!records.length)failures.push(`${name}: missing current Sigma-10 migration evidence`);
    const packageDir=resolveExistingPackageDirectory(path.join(root,'ports'),name,`${name}: package directory`);
    const sourceName=candidateSourceName(packageDir,ledger.packages[name]);
    const base=currentPackageBaseCss(packageDir,name)??Buffer.alloc(0);
    const currentCandidate=candidateIdentity(fs.readFileSync(resolveExistingPackageFile(packageDir,'candidate.css',`${name}: candidate CSS`)),base).candidateSha;
    const currentSource=sha(fs.readFileSync(resolveExistingPackageFile(packageDir,sourceName,`${name}: Sigma-10 source file`)));
    let currentStructureSha=null;try{currentStructureSha=sha(fs.readFileSync(resolveExistingPackageFile(packageDir,'acceptance-structure.json',`${name}: acceptance structure`)))}catch{}
    if(records.some(record=>record.candidate_sha256!==currentCandidate))failures.push(`${name}: Sigma-10 matrix uses superseded CSS`);
    if(records.some(record=>record.candidate_source_sha256!==currentSource))failures.push(`${name}: Sigma-10 matrix uses a superseded candidate`);
    if(records.some(record=>(record.candidate_structure_sha256??null)!==currentStructureSha))failures.push(`${name}: Sigma-10 matrix uses a superseded candidate structure`);
  }
 }catch(error){failures.push(error.message)}
 return failures;
}

export function checkCampaignCompletion(root, {captureContractReader = readCurrentBrowserContracts, sigma9RunContract, sigma10RunContract} = {}) {
  const sigma9Contract = resolveRunContractOption(root, sigma9RunContract, {generation:'sigma9'});
  const sigma10Contract = resolveRunContractOption(root, sigma10RunContract, {generation:'sigma10'});
  const failures = validateCurrentSigma10Contract(root, sigma10Contract);
  const runtimeHashes = new Map();
  const currentRuntime = row => {
    const key = JSON.stringify([row.surface,row.viewport]);
    if(!runtimeHashes.has(key))runtimeHashes.set(key,runtimeSurfaceContractSha(path.resolve(root,'../../..'),row.surface,row.viewport));
    return row.runtime_surface_contract_sha256===runtimeHashes.get(key);
  };
  const currentRuntimeSource = (row,runContract) => observationRuntimeSourceMatchesContract(row,runContract);
  const currentBackendRuntime = (row,runContract) => deepwellRuntimeIdentityMatchesContract(row,runContract);
  const captureContracts = new Map();
  const currentTargetRuntimeSha=currentTargetRuntimeSourceSha(root);
  const currentCapture = (row, contract) => {
    if(!captureContracts.has(contract))captureContracts.set(contract,captureContractReader(root,contract));
    return observationHasCurrentActionAndFixture(row,captureContracts.get(contract));
  };
  const read = file => JSON.parse(fs.readFileSync(resolveExistingContainedFile(root,file,`Current campaign input ${file}`), 'utf8'));
  const bind = (binding, label) => readBoundArtifact(root,binding,label);
  let document;
  try { document = read('current-campaign-acceptance.json'); }
  catch(error) {
    // INCONCLUSIVE means truly absent evidence only. A present but unreadable,
    // symlinked, corrupt or malformed receipt is a failing integrity check:
    // treating it as absence would allow source tampering to bypass the gate.
    const absent=error.code==='ENOENT' &&
      fs.lstatSync(path.join(root,'current-campaign-acceptance.json'),{throwIfNoEntry:false})===undefined;
    const message=absent
      ? 'Current campaign acceptance receipt is missing; historical integrity cannot authorize completion.'
      : `Current campaign acceptance receipt is invalid: ${error.message}; historical integrity cannot authorize completion.`;
    return {status:absent?'inconclusive':'fail',failures:[message,...failures]};
  }
  if (document.schema !== 'theme_lab_current_campaign_acceptance.v1') failures.push('Invalid current campaign receipt schema');
  const ledger = read('ports/adaptation-authority.json');
  const names = Object.keys(ledger.packages).sort();
  const portsRoot=path.join(root,'ports');
  const packageDirectory=name=>resolveExistingPackageDirectory(portsRoot,name,`${name}: package directory`);
  const expectedTargetFixtures=Object.fromEntries(Object.entries({baseline:'fixtures/scp-jp-sigma9-offline.css',sidebar:'fixtures/scp-jp-sidebar.html',header:'fixtures/scp-jp-header.html',navigation:'fixtures/scp-jp-navigation.html'}).map(([name,file])=>[name,sha(fs.readFileSync(resolveExistingContainedFile(root,file,`Current target fixture ${name}`)))]));
  const currentRunContractPath=resolveExistingContainedFile(root,sigma9Contract,'Current browser run contract');
  const currentRunContract=fs.readFileSync(currentRunContractPath);
  const currentRunContractSha=sha(currentRunContract),currentRunSpec=JSON.parse(currentRunContract);
  // The receipt names the run contract it was assembled against. A task-owned
  // contract is accepted only when named explicitly and bound by exact bytes;
  // the shared contract must not be satisfied by a task-owned receipt.
  {
    const bound=document.run_contract??null,explicit=sigma9Contract!==DEFAULT_SIGMA9_RUN_CONTRACT;
    if(explicit?(bound?.path!==sigma9Contract||bound?.sha256!==currentRunContractSha):bound!==null)
      failures.push(explicit?'Current campaign receipt is not bound to the explicitly supplied run contract':'Current campaign receipt is bound to a task-owned run contract; pass --run-contract to check it');
  }
  try{requireRuntimeSourceSha(currentRunSpec.expected_runtime_source_sha256,'Current Sigma-9 run contract')}catch(error){failures.push(error.message)}
  try{requireDeepwellRuntimeIdentity(currentRunSpec.expected_backend_runtime_identity,'Current Sigma-9 run contract')}catch(error){failures.push(error.message)}
  failures.push(...validatePublicationCandidateSet(root,{expectedCandidateSetSha256:currentRunSpec.candidate_set_sha256,contract:currentRunSpec,label:'Sigma-9 publication candidate set'}));
  if(currentRunSpec.visual_gate_policy?.sha256!==VISUAL_GATE_POLICY_SHA256)failures.push('Current Sigma-9 run contract is not bound to the maintained 145-state visual gate policy');
  if(!(sigma9Contract===DEFAULT_SIGMA9_RUN_CONTRACT?/^current-acceptance\/[a-z0-9-]+$/u:/^current-acceptance\/sigma9\/[a-z0-9-]+$/u).test(currentRunSpec.artifact_namespace??''))failures.push('Current browser artifact namespace is not isolated below current-acceptance');
  const currentMigrationContractPath=resolveExistingContainedFile(root,sigma10Contract,'Current Sigma-10 run contract');
  const currentMigrationContract=fs.readFileSync(currentMigrationContractPath);
  const currentMigrationContractSha=sha(currentMigrationContract),currentMigrationSpec=JSON.parse(currentMigrationContract);
  // A task-owned Sigma-10 contract is accepted only when named explicitly and
  // bound by exact bytes in the campaign receipt; the default must not carry one.
  {
    const bound=document.migration?.run_contract??null,explicit=sigma10Contract!==DEFAULT_SIGMA10_RUN_CONTRACT;
    if(explicit?(bound?.path!==sigma10Contract||bound?.sha256!==currentMigrationContractSha):bound!==null)
      failures.push(explicit?'Current campaign receipt is not bound to the explicitly supplied Sigma-10 run contract':'Current campaign receipt is bound to a task-owned Sigma-10 run contract; pass --sigma10-run-contract to check it');
  }
  try{requireRuntimeSourceSha(currentMigrationSpec.expected_runtime_source_sha256,'Current Sigma-10 run contract')}catch(error){failures.push(error.message)}
  try{requireDeepwellRuntimeIdentity(currentMigrationSpec.expected_backend_runtime_identity,'Current Sigma-10 run contract')}catch(error){failures.push(error.message)}
  const currentRunBaselineCss=fs.readFileSync(resolveRunContractPath(root,path.dirname(currentRunContractPath),currentRunSpec.baseline_theme.replacement_css_path,'current baseline replacement CSS'),'utf8');
  const assetDependency=(name,dir,sourceName,baselineCss)=>candidateAssetDependencySha(root,ledger,name,dir,sourceName,baselineCss);
  const currentInventory=currentMigrationSpec.current_candidate_inventory??[];
  const expectedMigrationNames=[...names,'sigma10-baseline'].sort();
  if(currentInventory.length!==expectedMigrationNames.length||currentInventory.map(item=>item.package).sort().join('\0')!==expectedMigrationNames.join('\0'))failures.push('Sigma-10 current candidate inventory does not enumerate every maintained candidate plus baseline');
  const inventoryByName=new Map(currentInventory.map(item=>[item.package,item]));
  for(const name of expectedMigrationNames){
    const item=inventoryByName.get(name);if(!item)continue;
    const sourceName=declaredCandidateSourceName(ledger.packages[name]);
    try{
      const dir=name==='sigma10-baseline'?resolveExistingContainedDirectory(root,'sigma10-migration/baseline-probe','Sigma-10 baseline directory'):packageDirectory(name);
      const base=(name==='sigma10-baseline'
        ?optionalPackageBytes(dir,'candidate-base.css',`${name}: Sigma-10 base CSS`)
        :currentPackageBaseCss(dir,name))??Buffer.alloc(0);
      const css=fs.readFileSync(resolveExistingPackageFile(dir,'candidate.css',`${name}: Sigma-10 candidate CSS`));
      let source;
      try{source=fs.readFileSync(resolveExistingPackageFile(dir,sourceName,`${name}: Sigma-10 source file`))}
      catch(error){
        if(ledger.packages[name]?.source_file)throw error;
        source=fs.readFileSync(resolveExistingPackageFile(dir,'candidate.wikidot.txt',`${name}: Sigma-10 preview source`));
      }
      if(candidateIdentity(css,base).candidateSha!==item.candidate_sha256||sha(source)!==item.source_sha256)failures.push(`${name}: current Sigma-10 contract candidate identity is stale`);
    }catch(error){failures.push(`${name}: cannot bind current Sigma-10 candidate: ${error.message}`)}
  }
  for(const binding of Object.values(currentMigrationSpec.frozen_sigma10_authority?.artifacts??[])){
    try{bind(binding,`Frozen Sigma-10 authority ${binding.path}`)}catch(error){failures.push(error.message)}
  }
  try{
    const sourceManifestBytes=bind({path:currentMigrationSpec.frozen_sigma10_authority.source_manifest,sha256:currentMigrationSpec.frozen_sigma10_authority.source_manifest_sha256},'Frozen Sigma-10 source manifest');
    const sourceManifest=JSON.parse(sourceManifestBytes);
    for(const [identity,page] of Object.entries(sourceManifest.pages??[])){
      const sourceBytes=fs.readFileSync(resolveExistingContainedFile(root,page.file,`Frozen Sigma-10 source ${identity}`,path.join(root,'sigma10-migration')));
      if(sha(sourceBytes)!==page.sha256)failures.push(`Frozen Sigma-10 source changed: ${identity}`);
    }
  }catch(error){failures.push(`Frozen Sigma-10 source authority invalid: ${error.message}`)}
  try{
    const saved=read('sigma10-migration/current-campaign/saved-credit-component.json');
    if(saved.schema!=='theme_lab_frozen_component_css.v1'||saved.css_sha256!==currentMigrationSpec.saved_component_css?.sha256||JSON.stringify(saved.cascade)!==JSON.stringify(currentMigrationSpec.saved_component_css?.cascade))failures.push('Saved-page Credit cascade differs from the reviewed frozen component contract');
    bind({path:'sigma10-migration/current-campaign/saved-credit-component.css',sha256:saved.css_sha256},'Saved-page Credit CSS');
    validateSavedComponentSources(root,saved);
  }catch(error){failures.push(`Saved-page Credit cascade contract invalid: ${error.message}`)}
  const rows = document.packages ?? [];
  if (rows.length !== names.length || new Set(rows.map(row => row.package)).size !== rows.length || rows.map(row => row.package).sort().join('\0') !== names.join('\0')) failures.push('Current package acceptance inventory does not match maintained packages');
  for (const row of rows) {
    try {
      const currentDirectory=`ports/current-acceptance/${row.package}`;
      const sourceName=declaredCandidateSourceName(ledger.packages[row.package]);
      const expectedBindings={
        receipt:`${currentDirectory}/accepted-result.json`,
        browser_audit:`${currentDirectory}/browser-audit.json`,
        visual_review:`${currentDirectory}/visual-review.json`,
        css:`ports/${row.package}/candidate.css`,
        source:`ports/${row.package}/${sourceName}`,
        preview:`ports/${row.package}/candidate.wikidot.txt`,
      };
      for(const [key,expected] of Object.entries(expectedBindings)){
        const binding=['receipt','browser_audit','visual_review'].includes(key)?row[key]:row.inputs?.[key];
        if(key==='browser_audit'?!canonicalAuditBinding(binding,expected):binding?.path!==expected)failures.push(`${row.package}: current ${key.replaceAll('_',' ')} path is not canonical`);
      }
      const result = JSON.parse(bind(row.receipt, row.package));
      failures.push(...targetRuntimeIdentityFailures(result,currentTargetRuntimeSha,currentRunSpec.expected_backend_runtime_identity).map(message=>`${row.package}: ${message}`));
      const visualReview=JSON.parse(bind(row.visual_review,`${row.package}/visual review`));
      const packageDir=packageDirectory(row.package);
      if(result.browser_acceptance?.path!==(row.browser_audit?.encoding==='gzip'?row.browser_audit.path.slice(0,-3):row.browser_audit?.path)||result.browser_acceptance?.sha256!==(row.browser_audit?.uncompressed_sha256??row.browser_audit?.sha256))failures.push(`${row.package}: accepted result is not bound to the current browser audit`);
      if(result.target_acceptance_contract_sha256!==TARGET_ACCEPTANCE_CONTRACT_SHA256&&!isAdmittedTargetAcceptanceContract(result.target_acceptance_contract_sha256))failures.push(`${row.package}: accepted result uses a superseded target acceptance contract`);
      const currentFullCheckBindings=currentPackageFullCheckInputBindings(root,row.package);
      if(result.full_check_input_bindings?.sha256!==currentFullCheckBindings.sha256)failures.push(`${row.package}: accepted result uses superseded package check inputs`);
      const imageProvenance=result.image_review_provenance;
      if(imageProvenance?.schema!=='theme_lab_visual_acceptance.v1'||
         imageProvenance?.review_sha256!==sha(JSON.stringify(visualReview))||!/^[0-9a-f]{64}$/u.test(imageProvenance?.raw_result_sha256??'')||
         imageProvenance?.candidate_css_sha256!==result.candidate_css_sha256||imageProvenance?.candidate_source_sha256!==result.candidate_source_sha256||
         imageProvenance?.candidate_preview_sha256!==result.candidate_preview_sha256||(imageProvenance?.candidate_base_css_sha256??null)!==(result.candidate_base_css_sha256??null))
        failures.push(`${row.package}: final image review provenance is missing or stale`);
      if(visualReview?.schema!=='theme_lab_visual_acceptance.v1'||visualReview?.candidate_css_sha256!==result.candidate_css_sha256||visualReview?.candidate_source_sha256!==result.candidate_source_sha256||visualReview?.candidate_preview_sha256!==result.candidate_preview_sha256||(visualReview?.candidate_base_css_sha256??null)!==(result.candidate_base_css_sha256??null))failures.push(`${row.package}: bound visual review uses superseded candidate inputs`);
      failures.push(...validateCombinedAcceptance(result, row.package));
      failures.push(...verifyFaithfulDesignWaivers(result, row.package));
      if(Object.entries(expectedTargetFixtures).some(([name,hash])=>result.target_fixture_identity?.[name]!==hash))failures.push(`${row.package}: paired check uses superseded target fixtures`);
      if(result.verification_scope?.mode!=='full'||result.verification_scope?.deferred?.length)failures.push(`${row.package}: completion requires a full, non-deferred check`);
      if(ACCEPTANCE_VIEWPORT_IDS.some(viewport=>result.viewport_status?.[viewport]?.status!=='pass'))failures.push(`${row.package}: current viewport acceptance is incomplete`);
      if(result.font_diagnostics?.status!=='measured'||!result.font_diagnostics?.fonts?.some(font=>font.glyph_count>0))failures.push(`${row.package}: Japanese glyph acceptance is incomplete`);
      const currentBase=currentPackageBaseCss(packageDir,row.package);
      const currentBaseSha=currentBase===null?null:sha(currentBase);
      if((result.candidate_base_css_sha256??null)!==currentBaseSha)failures.push(`${row.package}: accepted result uses superseded base CSS`);
      for (const [key, filename] of [['css', 'candidate.css'], ['source', sourceName], ['preview', 'candidate.wikidot.txt']]) {
        const bytes = bind(row.inputs?.[key], `${row.package}/${key}`);
        const expected = resolveExistingPackageFile(packageDir,filename,`${row.package}/${key}`);
        if (sha(fs.readFileSync(expected)) !== sha(bytes)) failures.push(`${row.package}: acceptance uses a superseded ${key}`);
        const resultKey={css:'candidate_css_sha256',source:'candidate_source_sha256',preview:'candidate_preview_sha256'}[key];
        if(result[resultKey]!==sha(bytes))failures.push(`${row.package}: accepted result is not bound to current ${key}`);
      }
      for(const viewport of ACCEPTANCE_VIEWPORT_IDS){
        const visual=result.visual?.viewports?.[viewport];
        if(!accepted(visual?.status)||visual?.review?.candidate_screenshot_sha256!==visual?.candidate_screenshot_sha256||visual?.review?.reference_screenshot_sha256!==visual?.reference_screenshot_sha256)failures.push(`${row.package}: unbound paired image review at ${viewport}`);
        for(const side of ['candidate','reference']){
          const file=visual?.[`${side}_path`];
          // Retained captures may use absolute checkout paths; the file must
          // still resolve within this checkout and match the reviewed bytes.
          if(typeof file!=='string')continue;
          const relative=path.relative(root,path.resolve(root,file));
          bind({path:relative,sha256:visual[`${side}_screenshot_sha256`]},`${row.package}/${viewport}/${side}`);
        }
      }
      const audit = JSON.parse(bind(row.browser_audit, `${row.package}/browser audit`));
      if((audit.records??[]).some(record=>record.theme!==row.package))failures.push(`${row.package}: package browser audit contains records for another theme`);
      if(result.browser_acceptance?.records!==audit.records?.length)failures.push(`${row.package}: accepted result browser record count is stale`);
      try{
        const browserVersions={};
        for(const record of audit.records??[]){
          const previous=browserVersions[record.browser_engine];
          if(previous&&previous!==record.browser_version)throw new Error(`browser audit mixes ${record.browser_engine} versions`);
          browserVersions[record.browser_engine]=record.browser_version;
        }
        const canonical=validateCanonicalScenarioMatrix({root,packageName:row.package,generation:'sigma9',matrix:audit.canonical_scenario,browserVersions,runContract:sigma9Contract});
        if(result.canonical_scenario_evidence?.generation!=='sigma9'||result.canonical_scenario_evidence?.scenario_sha256!==canonical.scenario_sha256||result.canonical_scenario_evidence?.matrix_receipt_sha256!==canonical.matrix_receipt_sha256||result.canonical_scenario_evidence?.measurement_contract_sha256!==canonical.measurement_contract_sha256)failures.push(`${row.package}: accepted result is not bound to current canonical scenario evidence`);
      }catch(error){failures.push(`${row.package}: canonical scenario matrix is missing or stale: ${error.message}`)}
      const semantic = audit.acceptance_model === SEMANTIC_BROWSER_MODEL;
      if (semantic) {
        failures.push(...validateSemanticBrowserAcceptance(audit).failures, ...validateSemanticSourceAuthority(root,audit,{sigma10RunContract:sigma10Contract}));
        try {
          const sourceHtmlSha=semanticSourceReferenceHtmlSha(root,audit,row.package);
          if(result.reference_identity?.original_html_sha256!==sourceHtmlSha)failures.push(`${row.package}: full package reference differs from current frozen source rendering`);
        } catch(error) { failures.push(error.message); }
        for (const artifact of semanticReviewArtifactBindings(audit)) bind(artifact.binding, artifact.label);
      }
      const records = audit.records?.filter(record => record.theme === row.package) ?? [];
      failures.push(...validateBrowserCoverage(audit,[row.package]));
      const base=currentPackageBaseCss(packageDir,row.package)??Buffer.alloc(0);
      const currentCandidate=candidateIdentity(fs.readFileSync(resolveExistingPackageFile(packageDir,'candidate.css',`${row.package}: candidate CSS`)),base).candidateSha;
      let currentStructureSha=null;try{currentStructureSha=sha(fs.readFileSync(resolveExistingPackageFile(packageDir,'acceptance-structure.json',`${row.package}: acceptance structure`)))}catch{}
      const currentAssetDependencySha=assetDependency(row.package,packageDir,candidateSourceName(packageDir,ledger.packages[row.package]),currentRunBaselineCss);
      for (const record of records) {
        failures.push(...validateVisualGateRecord(record));
        const screenshotRequired=visualGateNeedsScreenshot(record,{failure:!!record.failure});
        if(!currentRuntimeSource(record,currentRunSpec))failures.push(`${row.package}: browser runtime source SHA is missing or differs from the current run contract`);
        if(!currentBackendRuntime(record,currentRunSpec))failures.push(`${row.package}: browser Deepwell backend identity is missing or differs from the current run contract`);
        if(semantic&&!currentRuntime(record))failures.push(`${row.package}: superseded browser runtime surface ${record.surface}`);
        if(semantic&&!currentCapture(record,sigma9Contract))failures.push(`${row.package}: superseded browser action/fixture ${record.surface}.${record.state}`);
        if(record.scoped_authority_contract_sha256!==scopedRunContractSha(runContractWithoutRuntimeBindings(currentRunSpec),record))failures.push(`${row.package}: browser capture lacks the current scoped authority contract identity ${record.surface}.${record.state}`);
        if(!captureRunContractIsCurrent(record,currentRunSpec,currentRunContractSha)||record.baseline_theme_mode!=='replacement'||record.baseline_theme_css_sha256!==currentRunSpec.baseline_theme.replacement_css_sha256)failures.push(`${row.package}: browser capture uses superseded target baseline/contract`);
        if(!Array.isArray(record.unconfirmed_items)||!Array.isArray(record.asset_failures)||!Array.isArray(record.page_errors)||!Array.isArray(record.action_responses))failures.push(`${row.package}: browser capture lacks explicit safety results`);
        if (!semantic && (!['PASS_NATURAL', 'PASS_INTENTIONAL_DIVERGENCE'].includes(record.classification) || screenshotRequired&&!record.reviewed_after_last_change || record.unconfirmed_items?.length || record.asset_failures?.length || record.page_errors?.length || record.external_requests_sent !== 0 || record.failure || record.action_responses?.some(response=>response.type==='failure'||response.status>=400||response.error_message))) failures.push(`${row.package}: unresolved browser state ${record.surface}.${record.state}`);
        if(record.candidate_sha256!==currentCandidate)failures.push(`${row.package}: superseded browser CSS identity`);
        if (record.candidate_source_sha256 !== row.inputs.source.sha256) failures.push(`${row.package}: superseded browser source identity`);
        if((record.candidate_structure_sha256??null)!==currentStructureSha)failures.push(`${row.package}: superseded browser candidate structure`);
        if(record.asset_dependency_sha256!==currentAssetDependencySha)failures.push(`${row.package}: superseded browser asset dependency`);
        if(semantic&&!observationHasCurrentEnvironment(record,captureContracts.get(sigma9Contract),currentRunSpec,currentRunContractSha,{assetDependencySha:currentAssetDependencySha,candidateStructureSha:currentStructureSha}))failures.push(`${row.package}: superseded browser environment contract ${record.surface}.${record.state}`);
        if(screenshotRequired){
          if(record.screenshot!==canonicalScreenshotPath(currentRunSpec,record))failures.push(`${row.package}: browser screenshot path is not canonical content-addressed evidence`);
          const screenshot=bind({path:`ports/${record.screenshot}`,sha256:record.screenshot_sha256},row.package);
          if(!semantic&&sha(screenshot)!==record.visual_review?.screenshot_sha256)failures.push(`${row.package}: missing current image review`);
        }else if(record.screenshot||record.screenshot_sha256)failures.push(`${row.package}: successful machine-only state retained a screenshot`);
      }
    } catch (error) { failures.push(error.message); }
  }
  try {
    if(document.migration?.receipt?.path!=='sigma10-migration/current-campaign/accepted-result.json')failures.push('Sigma-10 migration receipt path is not canonical');
    if(!canonicalAuditBinding(document.migration?.browser_audit,'sigma10-migration/current-campaign/browser-audit.json'))failures.push('Sigma-10 migration browser audit path is not canonical');
    const migration = JSON.parse(bind(document.migration?.receipt, 'Sigma-10 migration'));
    if(migration.schema!=='theme_lab_current_sigma10_acceptance.v1')failures.push('Current Sigma-10 migration receipt schema is invalid');
    if(migration.run_contract_sha256!==currentMigrationContractSha)failures.push('Migration decision is not bound to the current Sigma-10 run contract');
    if (!accepted(migration.overall_acceptance?.status)) failures.push(`Current Sigma-10 migration acceptance is ${migration.overall_acceptance?.status ?? 'missing'}`);
    const audit = JSON.parse(bind(document.migration?.browser_audit, 'Sigma-10 migration audit'));
    failures.push(...validateSigma10MigrationAudit(root,{sigma10Contract,audit,evidence:migration.canonical_scenario_evidence,nonblockingObservations:migration.nonblocking_observations??[],captureContractReader}));
    if(migration.browser_audit_sha256!==(document.migration.browser_audit.uncompressed_sha256??document.migration.browser_audit.sha256))failures.push('Migration decision is not bound to current browser audit');
  } catch (error) { failures.push(error.message); }
  return {status: failures.length ? 'fail' : 'pass', packages: rows.length, failures};
}
