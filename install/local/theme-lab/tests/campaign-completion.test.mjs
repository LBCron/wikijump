import {runtimeFilesForObservation,runtimeSurfaceContractSha} from '../src/browser-runtime-contract.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {canonicalScreenshotPath,validateCombinedAcceptance,validateCurrentSigma10Contract,validateBrowserCoverage,checkCampaignCompletion} from '../src/campaign-completion.mjs';
test('canonical screenshot paths preserve the explicit source-owned navigation failure marker',()=>{
 const contract={artifact_namespace:'current-acceptance/sigma9'};
 const row={theme:'monotypical',browser_engine:'webkit',viewport:'mobile',surface:'nav.sidebar',state:'open',screenshot_sha256:'a'.repeat(64)};
 assert.equal(canonicalScreenshotPath(contract,row),'current-acceptance/sigma9/monotypical/artifacts/interactive/webkit/mobile/nav-sidebar-open-mobile-'+ 'a'.repeat(64)+'.png');
 row.action_contract_observation={mode:'source-navigation-replaces-sidebar'};
 assert.equal(canonicalScreenshotPath(contract,row),'current-acceptance/sigma9/monotypical/artifacts/interactive/webkit/mobile/nav-sidebar-open-mobile-failed-'+ 'a'.repeat(64)+'.png');
});
test('completion rejects target failure despite port pass',()=>assert.ok(validateCombinedAcceptance(result('pass','fail','pass'),'port').length));
test('completion rejects inconclusive port and migration results',()=>assert.ok(validateCombinedAcceptance(result('inconclusive','pass','inconclusive'),'port').length));
test('completion accepts consistent combined pass and warn dimensions',()=>{
 assert.deepEqual(validateCombinedAcceptance(result('pass','pass','pass'),'port'),[]);
 assert.deepEqual(validateCombinedAcceptance(result('pass','warn','warn'),'port'),[]);
});
test('historical integrity cannot substitute for missing current campaign acceptance',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'theme-lab-completion-'));
 try {const checked=checkCampaignCompletion(dir);assert.equal(checked.status,'inconclusive');assert.match(checked.failures[0],/historical integrity/)}
 finally {fs.rmSync(dir,{recursive:true,force:true})}
});
test('present but corrupt current campaign evidence is a FAIL, not missing-campaign INCONCLUSIVE',()=>{
 const mock=mockCampaign();try{
  fs.writeFileSync(path.join(mock.root,'current-campaign-acceptance.json'),'{not valid json');
  const checked=checkCampaignCompletion(mock.root);
  assert.equal(checked.status,'fail');
  assert.ok(checked.failures.some(value=>value.includes('receipt is invalid')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('current campaign acceptance cannot escape Theme Lab through a symlink',()=>{
 const mock=mockCampaign();try{
  const file=path.join(mock.root,'current-campaign-acceptance.json'),outside=path.join(mock.workspace,'outside-campaign.json');fs.copyFileSync(file,outside);fs.rmSync(file);fs.symlinkSync(outside,file);
  const checked=checkCampaignCompletion(mock.root);assert.equal(checked.status,'fail');assert.ok(checked.failures.some(value=>value.includes('escapes root')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});

import crypto from 'node:crypto';
import browserContract from '../fixtures/browser-acceptance-states.json' with {type:'json'};
import {candidateIdentity} from '../ports/scripts/candidate-identity.mjs';
import {SEMANTIC_BROWSER_MODEL,planBrowserAcceptance} from '../src/semantic-browser-acceptance.mjs';
import {BASELINE_DOCUMENT_CONTAINMENT_CONTRACT_SHA256,BASELINE_DOCUMENT_CONTAINMENT_SCHEMA} from '../src/baseline-document-containment.mjs';
import {TARGET_ACCEPTANCE_CONTRACT_SHA256} from '../src/target-acceptance-contract.mjs';
import {currentTargetRuntimeSourceSha} from '../src/target-runtime-identity.mjs';
import {frozenCandidateSetSha256} from '../src/publication-candidate-freeze.mjs';
import {currentPackageFullCheckInputBindings} from '../src/full-check-input-bindings.mjs';
import {browserEnvironmentContractHashes} from '../src/current-browser-contracts.mjs';
import {createDeepwellRuntimeIdentity} from '../src/deepwell-runtime-identity.mjs';
import {VISUAL_GATE_POLICY_SHA256,visualGatePolicyRow,visualGateSelectorsFor,buildVisualGateAssertion,visualGateGlobalRuntimeDrift,runContractWithoutRuntimeBindings} from '../src/visual-gate.mjs';
import {scopedRunContractSha} from '../src/scoped-run-contract.mjs';
import {candidateAssetDependencyState} from '../src/candidate-asset-dependencies.mjs';
import {CANONICAL_INTERACTION_STATES,CANONICAL_SEMANTIC_PROBES} from '../src/theme-canonical-execution.mjs';
import {materializeThemeTestScenario} from '../src/theme-test-scenario-config.mjs';
import {themeScenarioConfigForPackage} from '../src/theme-scenario-factory.mjs';
import {result,digest,matrix,mockBrowserVersions,mockRuntimeSourceSha,mockBackendRuntimeIdentity,mockTargetSite,packageResultPath,packageAuditPath,migrationResultPath,migrationAuditPath,core,mockCaptureContracts,mockCampaign} from './support/current-campaign-fixture.mjs';
test('promotion requires current identities, complete browser coverage and accepted migration',()=>{
 const mock=mockCampaign();try{
  assert.deepEqual(checkCampaignCompletion(mock.root).failures,[]);
  fs.appendFileSync(path.join(mock.root,'ports/testtheme/candidate.css'),' /* changed */');
  assert.equal(checkCampaignCompletion(mock.root).status,'fail');
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion rejects a browser run contract outside the current acceptance namespace',()=>{
 const mock=mockCampaign();try{
  const file=path.join(mock.root,'ports/current-acceptance/run-contract.json'),contract=JSON.parse(fs.readFileSync(file,'utf8'));
  contract.artifact_namespace='migration/sigma10';fs.writeFileSync(file,JSON.stringify(contract));
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('artifact namespace is not isolated below current-acceptance')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('current Sigma-10 contract rejects a historical artifact namespace',()=>{
 const mock=mockCampaign();try{
  const file=path.join(mock.root,'sigma10-migration/current-campaign/run-contract.json'),contract=JSON.parse(fs.readFileSync(file,'utf8'));
  contract.artifact_namespace='migration/sigma10';fs.writeFileSync(file,JSON.stringify(contract));
  assert.ok(validateCurrentSigma10Contract(mock.root).some(value=>value.includes('artifact namespace is not isolated from historical migration evidence')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion rejects exact current package artifacts rebound to noncanonical paths',()=>{
 const mock=mockCampaign();try{
  mock.document.packages[0].receipt=mock.write('evidence/copied-result.json',mock.full);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('current receipt path is not canonical')));
  mock.document.packages[0].receipt=mock.write(packageResultPath,mock.full);
  mock.document.packages[0].browser_audit=mock.write('evidence/copied-audit.json',mock.audit);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('current browser audit path is not canonical')));
  mock.document.packages[0].browser_audit=mock.write(packageAuditPath,mock.audit);
  mock.document.packages[0].inputs.css=mock.write('evidence/copied-candidate.css',fs.readFileSync(path.join(mock.root,'ports/testtheme/candidate.css')));mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('current css path is not canonical')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion rejects an accepted result detached from its current browser audit',()=>{
 const mock=mockCampaign();try{
  mock.full.browser_acceptance.sha256='0'.repeat(64);mock.document.packages[0].receipt=mock.write(packageResultPath,mock.full);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('not bound to the current browser audit')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion rejects a package browser audit without its canonical scenario matrix',()=>{
 const mock=mockCampaign();try{
  delete mock.audit.canonical_scenario;
  const browser=mock.write(packageAuditPath,mock.audit);mock.document.packages[0].browser_audit=browser;mock.full.browser_acceptance={...browser,records:mock.audit.records.length};mock.document.packages[0].receipt=mock.write(packageResultPath,mock.full);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('canonical scenario matrix is missing or stale')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion rejects package browser audits contaminated by another theme',()=>{
 const mock=mockCampaign();try{
  mock.audit.records.push({...mock.audit.records[0],theme:'other-theme'});
  const browser=mock.write(packageAuditPath,mock.audit);mock.document.packages[0].browser_audit=browser;mock.full.browser_acceptance={...browser,records:mock.audit.records.length};mock.document.packages[0].receipt=mock.write(packageResultPath,mock.full);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('contains records for another theme')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion rejects unexpected browser states outside the maintained denominator',()=>{
 const mock=mockCampaign();try{
  mock.audit.records.push({...mock.audit.records[0],state:'unexpected-state'});
  const browser=mock.write(packageAuditPath,mock.audit);mock.document.packages[0].browser_audit=browser;mock.full.browser_acceptance={...browser,records:mock.audit.records.length};mock.document.packages[0].receipt=mock.write(packageResultPath,mock.full);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('Unexpected current browser state')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('coverage permits only a replacement observation named by a source-owned navigation exception',()=>{
 const mock=mockCampaign();try{
  const replacement={theme:'testtheme',browser_engine:'webkit',viewport:'mobile',surface:'nav.mobile-top',state:'submenu-expanded'};
  const actionRow=mock.audit.records.find(row=>row.theme==='testtheme'&&row.browser_engine==='webkit'&&row.viewport==='mobile'&&row.surface==='nav.sidebar'&&row.state==='open');
  actionRow.action_contract_observation={mode:'source-navigation-replaces-sidebar',replacement:{key:JSON.stringify([replacement.theme,replacement.browser_engine,replacement.viewport,replacement.surface,replacement.state])}};
  mock.audit.records.push(replacement);
  assert.deepEqual(validateBrowserCoverage(mock.audit,['testtheme']),[]);
  mock.audit.records.at(-1).state='unreferenced-state';
  assert.ok(validateBrowserCoverage(mock.audit,['testtheme']).some(value=>value.includes('Unexpected current browser state')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion rejects exact Sigma-10 artifacts rebound to noncanonical paths',()=>{
 const mock=mockCampaign();try{
  mock.document.migration.receipt=mock.write('evidence/copied-migration-result.json',mock.migrationResult);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('migration receipt path is not canonical')));
  mock.document.migration.receipt=mock.write(migrationResultPath,mock.migrationResult);
  const auditBytes=fs.readFileSync(path.join(mock.root,migrationAuditPath));
  mock.document.migration.browser_audit=mock.write('evidence/copied-migration-audit.json',auditBytes);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('migration browser audit path is not canonical')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion rejects a Sigma-10 decision detached from its current run contract',()=>{
 const mock=mockCampaign();try{
  mock.migrationResult.run_contract_sha256='0'.repeat(64);mock.document.migration.receipt=mock.write(migrationResultPath,mock.migrationResult);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('not bound to the current Sigma-10 run contract')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion rejects Sigma-10 migration without maintained-package canonical matrices',()=>{
 const mock=mockCampaign();try{
  const file=path.join(mock.root,migrationAuditPath),audit=JSON.parse(fs.readFileSync(file,'utf8'));delete audit.canonical_scenarios;
  const binding=mock.write(migrationAuditPath,audit);mock.document.migration.browser_audit=binding;mock.migrationResult.browser_audit_sha256=binding.sha256;mock.document.migration.receipt=mock.write(migrationResultPath,mock.migrationResult);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('Sigma-10 canonical scenario evidence is missing or stale')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('compressed browser evidence retains both physical and native acceptance bindings',()=>{
 const mock=mockCampaign();try{
  const compress=binding=>{
   const bytes=fs.readFileSync(path.join(mock.root,binding.path));
   const stored=gzipSync(bytes),target=binding.path+'.gz';
   fs.writeFileSync(path.join(mock.root,target),stored);
   return {path:target,sha256:digest(stored),encoding:'gzip',uncompressed_sha256:binding.sha256};
  };
  mock.document.packages[0].browser_audit=compress(mock.document.packages[0].browser_audit);
  mock.document.migration.browser_audit=compress(mock.document.migration.browser_audit);mock.save();
  assert.deepEqual(checkCampaignCompletion(mock.root).failures,[]);
  mock.document.migration.browser_audit.uncompressed_sha256=digest('wrong native evidence');mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('stale expanded artifact')));
  mock.document.migration.browser_audit.sha256=digest('wrong compressed evidence');mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('stale artifact')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion rejects candidate base CSS symlinks escaping the package',()=>{
 const mock=mockCampaign();try{
  const outside=path.join(mock.workspace,'outside-base.css'),link=path.join(mock.root,'ports/testtheme/candidate-base.css');fs.writeFileSync(outside,'external base CSS');fs.symlinkSync(outside,link);
  const checked=checkCampaignCompletion(mock.root);assert.equal(checked.status,'fail');assert.ok(checked.failures.some(value=>value.includes('base CSS escapes package')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion rejects iteration checks and missing exact paired image review',()=>{
 const mock=mockCampaign();try{
  mock.full.verification_scope.mode='iteration';delete mock.full.visual.viewports.mobile.review;
  mock.document.packages[0].receipt=mock.write(packageResultPath,mock.full);mock.save();
  const failures=checkCampaignCompletion(mock.root).failures;
  assert.ok(failures.some(value=>value.includes('full, non-deferred')));
  assert.ok(failures.some(value=>value.includes('unbound paired image review')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion rejects an accepted package result produced by a superseded target-acceptance contract',()=>{
 const mock=mockCampaign();try{
  mock.full.target_acceptance_contract_sha256='0'.repeat(64);
  mock.document.packages[0].receipt=mock.write(packageResultPath,mock.full);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('superseded target acceptance contract')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion rejects an accepted package result after full-check selectors change',()=>{
 const mock=mockCampaign();try{
  fs.appendFileSync(path.join(mock.root,'ports/shared-acceptance-selectors.txt'),'.new-selector\n');
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('superseded package check inputs')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion rejects stale final image-review provenance',()=>{
 const mock=mockCampaign();try{
  mock.full.image_review_provenance.candidate_css_sha256='0'.repeat(64);mock.document.packages[0].receipt=mock.write(packageResultPath,mock.full);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('final image review provenance is missing or stale')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion binds the exact retained visual review document',()=>{
 const mock=mockCampaign();try{
  const changed={schema:'theme_lab_visual_acceptance.v1',candidate_css_sha256:mock.full.candidate_css_sha256,candidate_source_sha256:mock.full.candidate_source_sha256,candidate_preview_sha256:mock.full.candidate_preview_sha256,candidate_base_css_sha256:null,note:'changed retained review'};
  mock.document.packages[0].visual_review=mock.write('ports/current-acceptance/testtheme/visual-review.json',changed);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('final image review provenance is missing or stale')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion rejects an accepted package result with a stale base CSS identity',()=>{
 const mock=mockCampaign();try{
  mock.full.candidate_base_css_sha256='0'.repeat(64);
  mock.document.packages[0].receipt=mock.write(packageResultPath,mock.full);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('superseded base CSS')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('historical integrity cannot promote an unresolved current migration',()=>{
 const mock=mockCampaign();try{
  mock.migrationResult.overall_acceptance.status='inconclusive';mock.document.migration.receipt=mock.write(migrationResultPath,mock.migrationResult);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('migration acceptance is inconclusive')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('current Sigma-10 contract must enumerate maintained candidates and baseline',()=>{
 const mock=mockCampaign();try{
  const contract=JSON.parse(fs.readFileSync(path.join(mock.root,'sigma10-migration/current-campaign/run-contract.json'),'utf8'));
  contract.current_candidate_inventory.pop();mock.write('sigma10-migration/current-campaign/run-contract.json',contract);
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('Sigma-10 current candidate inventory')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('current Sigma-10 candidate directories cannot escape Theme Lab',()=>{
 const mock=mockCampaign();try{
  const contractPath=path.join(mock.root,'sigma10-migration/current-campaign/run-contract.json'),contract=JSON.parse(fs.readFileSync(contractPath,'utf8'));
  const row=contract.current_candidate_inventory.find(item=>item.package==='testtheme');
  row.directory='../../../../../../outside-candidate';contract.additional_candidates.testtheme.directory=row.directory;fs.writeFileSync(contractPath,JSON.stringify(contract));
  assert.ok(validateCurrentSigma10Contract(mock.root).some(value=>value.includes('does not resolve to an existing Theme Lab path')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('current Sigma-10 package names cannot be rebound to another contained directory',()=>{
 const mock=mockCampaign();try{
  const contractPath=path.join(mock.root,'sigma10-migration/current-campaign/run-contract.json'),contract=JSON.parse(fs.readFileSync(contractPath,'utf8'));
  const row=contract.current_candidate_inventory.find(item=>item.package==='testtheme');
  row.directory='../baseline-probe';contract.additional_candidates.testtheme.directory=row.directory;fs.writeFileSync(contractPath,JSON.stringify(contract));
  assert.ok(validateCurrentSigma10Contract(mock.root).some(value=>value.includes('wrong package directory')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('current Sigma-10 source authority cannot escape the Theme Lab root',()=>{
 const mock=mockCampaign();try{
  const outside=path.join(mock.workspace,'outside-source.txt');fs.writeFileSync(outside,'outside authority bytes');
  const manifestPath=path.join(mock.root,'sigma10-migration/source-manifest.json');
  const manifest={pages:{outside:{file:'../../../../outside-source.txt',sha256:digest(fs.readFileSync(outside))}}};
  fs.writeFileSync(manifestPath,JSON.stringify(manifest));
  const manifestSha=digest(fs.readFileSync(manifestPath));
  const contractPath=path.join(mock.root,'sigma10-migration/current-campaign/run-contract.json');
  const contract=JSON.parse(fs.readFileSync(contractPath,'utf8'));
  contract.frozen_sigma10_authority.source_manifest_sha256=manifestSha;
  contract.frozen_sigma10_authority.artifacts.manifest.sha256=manifestSha;
  fs.writeFileSync(contractPath,JSON.stringify(contract));
  assert.ok(validateCurrentSigma10Contract(mock.root).some(value=>value.includes('escapes root')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('current Sigma-10 source authority cannot escape through a symlink',()=>{
 const mock=mockCampaign();try{
  const outside=path.join(mock.workspace,'outside-symlink-source.txt');fs.writeFileSync(outside,'outside symlink authority bytes');
  const link=path.join(mock.root,'sigma10-migration/linked-source.txt');fs.symlinkSync(outside,link);
  const manifestPath=path.join(mock.root,'sigma10-migration/source-manifest.json');
  const manifest={pages:{outside:{file:'linked-source.txt',sha256:digest(fs.readFileSync(outside))}}};fs.writeFileSync(manifestPath,JSON.stringify(manifest));
  const manifestSha=digest(fs.readFileSync(manifestPath));
  const contractPath=path.join(mock.root,'sigma10-migration/current-campaign/run-contract.json'),contract=JSON.parse(fs.readFileSync(contractPath,'utf8'));
  contract.frozen_sigma10_authority.source_manifest_sha256=manifestSha;contract.frozen_sigma10_authority.artifacts.manifest.sha256=manifestSha;fs.writeFileSync(contractPath,JSON.stringify(contract));
  assert.ok(validateCurrentSigma10Contract(mock.root).some(value=>value.includes('escapes root')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('current Sigma-10 saved Credit source artifacts remain hash-bound',()=>{
 const mock=mockCampaign();try{
  fs.appendFileSync(path.join(mock.root,'ports/authority-evidence/mock-saved-credit-source.wikidot.txt'),' changed');
  assert.ok(validateCurrentSigma10Contract(mock.root).some(value=>value.includes('Saved-page Credit source changed')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('current Sigma-10 package source cannot escape its package',()=>{
 const mock=mockCampaign();try{
  const ledgerPath=path.join(mock.root,'ports/adaptation-authority.json');
  const ledger=JSON.parse(fs.readFileSync(ledgerPath,'utf8'));ledger.packages.testtheme.source_file='../other/source.txt';
  fs.writeFileSync(ledgerPath,JSON.stringify(ledger));fs.mkdirSync(path.join(mock.root,'ports/other'),{recursive:true});fs.writeFileSync(path.join(mock.root,'ports/other/source.txt'),'Theme source');
  assert.ok(validateCurrentSigma10Contract(mock.root).some(value=>value.includes('source file escapes package')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('current Sigma-10 completion rejects a capture without a bound current visual review',()=>{
 const mock=mockCampaign();try{
  delete mock.audit.records[0].migration_review.classification;
  const binding=mock.write(migrationAuditPath,mock.audit);
  mock.document.migration.browser_audit=binding;mock.migrationResult.browser_audit_sha256=binding.sha256;
  mock.document.migration.receipt=mock.write(migrationResultPath,mock.migrationResult);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('current accepted visual review')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test('promotion rejects a omitted state even when remaining screenshots have been reviewed',()=>{
 const mock=mockCampaign();try{
  mock.audit.records.pop();mock.document.packages[0].browser_audit=mock.write(packageAuditPath,mock.audit);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('Missing current browser state')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});

test('promotion rejects browser evidence captured with a superseded candidate structure',()=>{
 const mock=mockCampaign();try{
  mock.write('ports/testtheme/acceptance-structure.json',{schema:'theme_lab_source_owned_structure.v1'});
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('superseded browser candidate structure')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});

test('promotion rejects browser evidence captured with superseded asset dependencies',()=>{
 const mock=mockCampaign();try{
  mock.audit.records[0].asset_dependency_sha256='0'.repeat(64);
  mock.document.packages[0].browser_audit=mock.write(packageAuditPath,mock.audit);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('superseded browser asset dependency')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});

test('semantic completion accepts bound questions and measured M states without screenshot review',()=>{
 const mock=mockCampaign();try{
  const sync=()=>{const browser=mock.write(packageAuditPath,mock.audit);mock.document.packages[0].browser_audit=browser;mock.full.browser_acceptance={...browser,records:mock.audit.records.length};mock.document.packages[0].receipt=mock.write(packageResultPath,mock.full);mock.save()};
  mock.audit.acceptance_model=SEMANTIC_BROWSER_MODEL;
  for(const row of mock.audit.records){
   if(row.visual_gate?.class==='M'){row.classification='UNCONFIRMED';row.reviewed_after_last_change=false;}
   row.unconfirmed_items=['screenshot captured but awaiting image review'];
   Object.assign(row,{fixture_contract_sha256:digest('fixture'),
    capture_state_action_contract_sha256:digest('action'),runtime_surface_contract_sha256:runtimeSurfaceContractSha(mock.workspace,row.surface,row.viewport),
    visual_diagnostics:{viewport:{width:1440,documentWidth:1440},title_overlaps:[]}});
  }
  const referenceHtml=mock.write('source.html','<!doctype html><p>Frozen foreign theme</p>');
  const sourceViewports=[...new Set(mock.audit.records.filter(row=>row.surface==='page.normal').map(row=>row.viewport))];
  const referenceCapture=mock.write('source-rendering.json',{reference_identity:{source_url:'https://scp-wiki.wikidot.com/theme:testtheme',original_html_sha256:referenceHtml.sha256,replay_entry:'/o/'+referenceHtml.sha256,snapshot_sha256:digest('snapshot'),offline:true},visual:{viewports:Object.fromEntries(sourceViewports.map(viewport=>[viewport,{reference_screenshot_sha256:mock.audit.records[0].screenshot_sha256}]))}});
  mock.audit.semantic_reviews=Object.fromEntries(planBrowserAcceptance(mock.audit).visual_questions.map(q=>[q.id,
   {question:q.question,evidence_sha256:q.evidence_sha256,status:'pass',method:'direct-visual-question-review',
    note:'Frozen source imagery and typography were compared across the declared responsive evidence.',
    reviewer:'test',reviewed_at:'2026-10-01T00:00:00Z',source_url:'https://scp-wiki.wikidot.com/theme:testtheme',
    source_snapshot:mock.document.packages[0].inputs.source,source_renderings:Object.fromEntries(sourceViewports.map(viewport=>[viewport,{source_html:referenceHtml,source_rendering_receipt:referenceCapture,source_rendering:{path:`ports/${mock.audit.records[0].screenshot}`,sha256:mock.audit.records[0].screenshot_sha256}}])),
    decision_authority:'SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY',port_conclusion_eligible:false}]));
  mock.full.reference_identity={source_url:'https://scp-wiki.wikidot.com/theme:testtheme',original_html_sha256:referenceHtml.sha256,replay_entry:'/o/'+referenceHtml.sha256,snapshot_sha256:digest('snapshot'),offline:true};
  sync();
  assert.deepEqual(checkCampaignCompletion(mock.root,{captureContractReader:mockCaptureContracts}).failures,[]);
  const environmentSha=mock.audit.records[0].environment_contract_sha256;
  mock.audit.records[0].environment_contract_sha256='0'.repeat(64);sync();
  assert.ok(checkCampaignCompletion(mock.root,{captureContractReader:mockCaptureContracts}).failures.some(value=>value.includes('superseded browser environment contract')));
  mock.audit.records[0].environment_contract_sha256=environmentSha;sync();
  mock.full.reference_identity.original_html_sha256=digest('wrong frozen source html');
  sync();
  assert.ok(checkCampaignCompletion(mock.root,{captureContractReader:mockCaptureContracts}).failures.some(value=>value.includes('full package reference differs from current frozen source rendering')));
  mock.full.reference_identity.original_html_sha256=referenceHtml.sha256;
  sync();
  mock.audit.records[0].capture_state_action_contract_sha256=digest('superseded action');
  sync();
  assert.ok(checkCampaignCompletion(mock.root,{captureContractReader:mockCaptureContracts}).failures.some(value=>value.includes('superseded browser action/fixture')));
  mock.audit.records[0].capture_state_action_contract_sha256=digest('action');
  sync();
  const historyRuntime=path.join(mock.workspace,'framerail/src/lib/wikidot-history-contract.js');
  const previousRuntime=fs.readFileSync(historyRuntime);
  fs.appendFileSync(historyRuntime,' changed historical source primitive');
  const runtimeFailures=checkCampaignCompletion(mock.root,{captureContractReader:mockCaptureContracts}).failures;
  assert.ok(runtimeFailures.length>0);
  assert.ok(runtimeFailures.some(value=>value.includes('superseded browser runtime surface page.history')));
  assert.ok(runtimeFailures.some(value=>value.includes('superseded built target runtime source')));
  fs.writeFileSync(historyRuntime,previousRuntime);
  mock.audit.records[0].visual_diagnostics.viewport.documentWidth=1500;
  sync();
  assert.ok(checkCampaignCompletion(mock.root,{captureContractReader:mockCaptureContracts}).failures.some(value=>value.includes('missing structured evidence document_containment')));
  mock.audit.records[0].baseline_document_containment_contract_sha256=BASELINE_DOCUMENT_CONTAINMENT_CONTRACT_SHA256;
  mock.audit.records[0].baseline_document_containment_measurement={schema:BASELINE_DOCUMENT_CONTAINMENT_SCHEMA,complete:true,viewport_width:1440,document_width:1440,body_width:1440};
  sync();
  assert.ok(checkCampaignCompletion(mock.root,{captureContractReader:mockCaptureContracts}).failures.some(value=>value.includes('machine failure document_containment')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});

test('semantic completion rejects a candidate snapshot impersonating another upstream source',()=>{
 const mock=mockCampaign();try{
  mock.audit.acceptance_model=SEMANTIC_BROWSER_MODEL;
  const q=planBrowserAcceptance(mock.audit).visual_questions[0];
  mock.audit.semantic_reviews={[q.id]:{source_url:'https://scp-wiki.wikidot.com/theme:another',source_snapshot:mock.document.packages[0].inputs.source}};
  const browser=mock.write(packageAuditPath,mock.audit);mock.document.packages[0].browser_audit=browser;mock.full.browser_acceptance={...browser,records:mock.audit.records.length};mock.document.packages[0].receipt=mock.write(packageResultPath,mock.full);mock.save();
  assert.ok(checkCampaignCompletion(mock.root,{captureContractReader:mockCaptureContracts}).failures.some(value=>value.includes('maintained upstream source authority')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});

test('promotion rejects a maintained package directory symlink outside ports',()=>{
 const mock=mockCampaign();try{
  const packageDir=path.join(mock.root,'ports/testtheme'),outside=path.join(mock.workspace,'outside-testtheme');fs.renameSync(packageDir,outside);fs.symlinkSync(outside,packageDir);
  const checked=checkCampaignCompletion(mock.root);assert.equal(checked.status,'fail');assert.ok(checked.failures.some(value=>/escapes ports root|symlink/u.test(value)));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});

test('an explicit run contract that the receipt does not bind is rejected even when well formed',()=>{
 const mock=mockCampaign();try{
  const shared=JSON.parse(fs.readFileSync(path.join(mock.root,'ports/current-acceptance/run-contract.json'),'utf8'));
  const taskRelative=mock.write('ports/current-acceptance/run-contract-explicit-check.json',{...shared,schema:'scp_jp_interactive_acceptance_run.v1',artifact_namespace:'current-acceptance/sigma9/explicit-check'}).path;
  const checked=checkCampaignCompletion(mock.root,{sigma9RunContract:taskRelative});
  assert.notEqual(checked.status,'pass');
  assert.ok(checked.failures.some(value=>value.includes('not bound to the explicitly supplied run contract')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});

test('a missing explicit run contract is rejected instead of falling back to the shared contract',()=>{
 const mock=mockCampaign();try{
  assert.throws(()=>checkCampaignCompletion(mock.root,{sigma9RunContract:'ports/current-acceptance/run-contract-absent-check.json'}),/ENOENT|Task-owned|no such file|Current browser run contract/iu);
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});

test('a receipt bound to a task-owned run contract is rejected when no contract is named',()=>{
 const mock=mockCampaign();try{
  mock.document.run_contract={path:'ports/current-acceptance/run-contract-explicit-check.json',sha256:'a'.repeat(64)};
  mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('bound to a task-owned run contract')));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
test("promotion accepts Sigma-9 canonical evidence produced under a task run contract",()=>{
 const mock=mockCampaign();try{
  const contractPath="ports/current-acceptance/run-contract-task.json";
  const shared=JSON.parse(fs.readFileSync(path.join(mock.root,"ports/current-acceptance/run-contract.json"),"utf8"));
  const taskContract={...shared,schema:"scp_jp_interactive_acceptance_run.v1",artifact_namespace:"current-acceptance/sigma9/task",target_site:{...shared.target_site,origin:"https://scpaiueouiuiuiui.wikijump.localhost:3415"}};
  mock.write(contractPath,taskContract);
  const materialized=materializeThemeTestScenario(mock.root,themeScenarioConfigForPackage(mock.root,{generation:"sigma9",packageName:"testtheme",runContract:contractPath}));
  const engines=Object.fromEntries(["chromium","firefox","webkit"].map(engine=>[engine,Object.fromEntries(["anonymous","authenticated"].map(profile=>{const executionBase={schema:"theme_lab_canonical_execution.v1",backend_runtime_identity:mockBackendRuntimeIdentity,scenario_sha256:materialized.scenario_sha256,session_profile:profile,session_observation:{my_account_text:profile==="authenticated"?"Administrator":null,logout_link_present:profile==="authenticated",sign_in_link_present:profile!=="authenticated"},check_evidence:{verification_scope:"pass",target_acceptance:"pass",image_diagnostics:"pass",japanese_glyph_rendering:"pass"},interaction_states:CANONICAL_INTERACTION_STATES.map(id=>({id,status:"pass"})),semantic_probes:CANONICAL_SEMANTIC_PROBES.map(id=>({id,status:"pass"}))};const canonical_execution={...executionBase,canonical_execution_sha256:digest(JSON.stringify(executionBase))};const receiptBase={schema:"theme_lab_measurement_receipt.v1",scenario_sha256:materialized.scenario_sha256,measurement_contract_sha256:materialized.bindings.measurement_contract.sha256,engine,browser_version:mockBrowserVersions[engine],session_profile:profile,canonical_execution_sha256:canonical_execution.canonical_execution_sha256};return[profile,{canonical_execution,measurement_receipt:{...receiptBase,receipt_sha256:digest(JSON.stringify(receiptBase))}}]}))]));
  const matrixBase={schema:"theme_lab_scenario_matrix.v1",scenario_sha256:materialized.scenario_sha256,measurement_contract_sha256:materialized.bindings.measurement_contract.sha256,engines};
  const taskMatrix={...matrixBase,matrix_receipt_sha256:digest(JSON.stringify(matrixBase)),canonical_acceptance_eligible:false,blockers:["producer has no promotion authority"]};
  mock.audit.canonical_scenario=taskMatrix;const auditBinding=mock.write(packageAuditPath,mock.audit);mock.document.packages[0].browser_audit=auditBinding;mock.full.browser_acceptance={...auditBinding,records:mock.audit.records.length};
  mock.full.canonical_scenario_evidence={generation:"sigma9",scenario_sha256:materialized.scenario_sha256,matrix_receipt_sha256:taskMatrix.matrix_receipt_sha256,measurement_contract_sha256:materialized.bindings.measurement_contract.sha256};
  mock.document.packages[0].receipt=mock.write(packageResultPath,mock.full);mock.save();
  const checked=checkCampaignCompletion(mock.root,{sigma9RunContract:contractPath});
  assert.ok(!checked.failures.some(value=>value.includes("canonical scenario")),checked.failures.join("\n"));
  const checkedDefault=checkCampaignCompletion(mock.root);
  assert.ok(checkedDefault.failures.some(value=>value.includes("canonical scenario matrix is missing or stale")),checkedDefault.failures.join("\n"));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});

test('completion accepts a result recorded under an admitted predecessor instrument and rejects an unrecorded one',()=>{
 const mock=mockCampaign();try{
  // The closure instrument's digest, admitted in
  // src/target-acceptance-instruments.mjs as the live instrument's predecessor.
  mock.full.target_acceptance_contract_sha256='df8e0b532decad8636fc7d5488c44d6c08e0bdc525a02eae8330c19554487a0a';
  mock.document.packages[0].receipt=mock.write(packageResultPath,mock.full);mock.save();
  assert.ok(!checkCampaignCompletion(mock.root).failures.some(value=>value.includes('superseded target acceptance contract')),checkCampaignCompletion(mock.root).failures.join('\n'));
  mock.full.target_acceptance_contract_sha256='0'.repeat(64);
  mock.document.packages[0].receipt=mock.write(packageResultPath,mock.full);mock.save();
  assert.ok(checkCampaignCompletion(mock.root).failures.some(value=>value.includes('superseded target acceptance contract')),checkCampaignCompletion(mock.root).failures.join('\n'));
 }finally{fs.rmSync(mock.workspace,{recursive:true,force:true})}
});
