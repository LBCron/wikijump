#!/usr/bin/env node
import {measureTitleTextIntersections} from '../../src/title-text-intersections.mjs';
import {measureBaselineDocumentContainment,BASELINE_DOCUMENT_CONTAINMENT_CONTRACT_SHA256} from '../../src/baseline-document-containment.mjs';
import {legacyEquivalentContractHashes} from '../../src/legacy-action-contracts.mjs';
import {exerciseHeaderSearch} from '../../src/search-control-action.mjs';
import {runtimeSurfaceContractSha} from '../../src/browser-runtime-contract.mjs';
import {assertDeepwellRuntimeIdentity,deepwellRuntimeIdentityFromHeaders,parseCurlDeepwellRuntimeHeaders,readRunningDeepwellRuntimeIdentity,requireDeepwellRuntimeIdentity} from '../../src/deepwell-runtime-identity.mjs';
import {assertRuntimeSourceSha,isThemeLabFixtureNavigationUrl,parseCurlRuntimeResponseHeaders,requireRuntimeSourceSha,runtimeSourceShaFromHeaders} from '../../src/runtime-source-identity.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {candidateIdentity} from '../scripts/candidate-identity.mjs';
import {measureTitleComposition} from '../../src/title-composition.mjs';
import {scopedRunContractSha,captureRunContractIsCurrent} from '../../src/scoped-run-contract.mjs';
import {storeContentAddressedScreenshot} from '../scripts/content-addressed-screenshot.mjs';
import {compactAuditRecord} from '../scripts/capture-audit-records.mjs';
import {mergeInteractiveAuditShards,writeInteractiveAuditDelta} from '../scripts/audit-shard-merge.mjs';
import {applyExactVisualReviewReuseToRows,verifyExactReviewSources} from '../scripts/visual-review-reuse.mjs';
import {topFixedNavigationInset} from './top-fixed-navigation-inset.mjs';
import {loadCandidateStructure} from '../../src/candidate-structure.mjs';
import {interactiveAcceptanceFixture} from '../../src/interactive-acceptance-fixture.mjs';
import {openSidebar,closeSidebar,sidebarIsClosed,sidebarOccupiesViewport} from '../../src/sidebar-interaction.mjs';
import {activateNavigationControl,expandMobileTopSubmenu,expandTabletTopNavigation,hasRenderedSubmenuGeometry} from '../../src/navigation-interaction.mjs';
import {dedupeCssLayers} from '../../src/css-layers.mjs';
import {resolveManifestRelativePath,resolveRunContractPath as resolveBoundRunContractPath} from '../../src/run-contract-path.mjs';
import {resolveFixtureOrigins} from '../../src/fixture-origin.mjs';
import {resolveCaptureBackendTarget} from '../../src/capture-backend-target.mjs';
import {FILES_PANE} from '../../src/files-pane-selectors.mjs';
import {candidateAssetDependencyState} from '../../src/candidate-asset-dependencies.mjs';
import {sigma10CreditActions} from '../../src/sigma10-credit-actions.mjs';
import {resolveExistingContainedDirectory,resolveExistingContainedFile,resolveExistingPackageDirectory,resolveExistingPackageFile} from '../../src/package-path.mjs';
import {VISUAL_GATE_POLICY_SHA256,buildVisualGateAssertion,collectVisualGateInteraction,legacyComparableScopedShas,runContractWithoutRuntimeBindings,sigma10CreditDisclosureSelector,visualGateGlobalRuntimeDrift,visualGateTitleCompositionNeedsImage,visualGateIdentityRiskSnapshot,visualGateIdentityRiskTriggers,visualGateNeedsScreenshot,visualGatePolicyRow,validateVisualGateRecord} from '../../src/visual-gate.mjs';

const packageDir=path.dirname(fileURLToPath(import.meta.url));
const portsDir=path.resolve(packageDir,'..');
const themeLabDir=path.resolve(portsDir,'..');
const browserRequire=createRequire(path.resolve(packageDir,'../../../../../framerail/package.json'));
const {chromium,firefox,webkit}=browserRequire('@playwright/test');
const themeArg=process.argv.find(x=>x.startsWith('--theme='))?.slice(8);
const themesArg=process.argv.find(x=>x.startsWith('--themes='))?.slice(9);
const engineArg=process.argv.find(x=>x.startsWith('--engine='))?.slice(9)??'chromium';
const viewportArg=process.argv.find(x=>x.startsWith('--viewport='))?.slice(11)??'desktop';
const stateArg=process.argv.find(x=>x.startsWith('--state='))?.slice(8);
const transportOriginArg=process.argv.find(x=>x.startsWith('--transport-origin='))?.slice(19);
const runContractArg=process.argv.find(x=>x.startsWith('--run-contract='))?.slice(15);
const runtimeRepoArg=process.argv.find(x=>x.startsWith('--runtime-repo='))?.slice(15);
const backendProjectArg=process.argv.find(x=>x.startsWith('--backend-project='))?.slice(18);
const stateArgs=stateArg!==undefined?new Set(stateArg.split(',')):null;
const forceCapture=process.argv.includes('--force');
const anonymousArg=process.argv.includes('--anonymous');
const defaultConcurrency={chromium:6,firefox:4,webkit:6}[engineArg]??4;
const concurrencyArg=Number(process.argv.find(x=>x.startsWith('--concurrency='))?.slice(14)??defaultConcurrency);
const acceptedArgs=new Set(['--force','--anonymous','--help','--dump-contracts']);
for(const arg of process.argv.slice(2)){if(acceptedArgs.has(arg)||/^--(?:theme|themes|engine|viewport|state|concurrency|transport-origin|run-contract|runtime-repo|backend-project)=/u.test(arg))continue;throw new Error(`unknown argument: ${arg}; use --help for usage`)}
if(process.argv.includes('--help')){console.log('Usage: capture-interactive.mjs [--engine=chromium|firefox|webkit] [--viewport=desktop|laptop|tablet|mobile|narrow-mobile] [--theme=slug|--themes=slug,slug] [--state=surface.state,...] [--concurrency=1..8] [--transport-origin=https://host:port] [--run-contract=/path/to/contract.json] [--runtime-repo=/abs/checkout --backend-project=wikijump-theme-lab-NAME] [--anonymous] [--force]');process.exit(0)}
if(!Number.isInteger(concurrencyArg)||concurrencyArg<1||concurrencyArg>8)throw new Error('--concurrency must be an integer from 1 to 8');
if(stateArgs&&[...stateArgs].some(state=>!state.trim()))throw new Error('states must be non-empty');
if(engineArg!=='chromium'&&!['desktop','mobile'].includes(viewportArg)){
 console.log(JSON.stringify({engine:engineArg,viewport:viewportArg,records:0,captured:0,skipped:true,reason:'Firefox/WebKit core acceptance is scoped to canonical desktop and mobile; the 320px policy-boundary matrix is Chromium-only.'}));
 process.exit(0);
}
// The task-owned acceptance origin is the seeded local development site, whose
// administrator defaults are also used by the existing verification import
// helpers. Keep operator-provided private inputs authoritative when present.
const verificationAdminEmail=process.env.WIKIDOT_VERIFY_ADMIN_EMAIL;
const verificationAdminPassword=process.env.WIKIDOT_VERIFY_ADMIN_PASS;
if(!anonymousArg&&(!verificationAdminEmail||!verificationAdminPassword))throw new Error('Authenticated visual capture requires WIKIDOT_VERIFY_ADMIN_EMAIL and WIKIDOT_VERIFY_ADMIN_PASS from a local-only environment file');
const defaultInteractionViewports=['desktop','mobile'];
const runContractPath=runContractArg?path.resolve(runContractArg):path.join(packageDir,'acceptance-run-contract.json');
const runContractBytes=await fs.readFile(runContractPath);
const runContract=JSON.parse(runContractBytes);
const expectedRuntimeSourceSha=requireRuntimeSourceSha(runContract.expected_runtime_source_sha256,'interactive capture run contract');
const expectedBackendRuntimeIdentity=requireDeepwellRuntimeIdentity(runContract.expected_backend_runtime_identity,'interactive capture run contract');
const runContractSha=crypto.createHash('sha256').update(runContractBytes).digest('hex');
const runContractDir=path.dirname(runContractPath);
const artifactNamespace=runContract.artifact_namespace??'';
const migrationFixture=runContract.migration_fixture??null;
if(migrationFixture&&['main_slug','top_slug','side_slug'].some(key=>!/^run-owned:sigma10-[a-z0-9-]+$/u.test(migrationFixture[key]??'')))throw new Error('invalid migration fixture slug');
if(runContractArg&&(!artifactNamespace||artifactNamespace.split('/').some(segment=>!/^[a-z0-9-]+$/u.test(segment))))throw new Error('custom run contract needs a valid isolated artifact namespace');
const resolveRunContractPath=(relative,label)=>{
 return resolveBoundRunContractPath(themeLabDir,runContractDir,relative,label);
};
const savedComponentCss=runContract.saved_component_css ? await fs.readFile(resolveRunContractPath(runContract.saved_component_css.path,'saved component CSS'),'utf8') : '';
if(savedComponentCss && crypto.createHash('sha256').update(savedComponentCss).digest('hex')!==runContract.saved_component_css.sha256)throw new Error('saved component CSS identity differs from run contract');
const headerFixture=runContract.header_fixture ? await fs.readFile(resolveRunContractPath(runContract.header_fixture.path,'header fixture'),'utf8') : null;
if(headerFixture && crypto.createHash('sha256').update(headerFixture).digest('hex')!==runContract.header_fixture.sha256)throw new Error('header fixture identity differs from run contract');
const sidebarFixture=runContract.sidebar_fixture ? await fs.readFile(resolveRunContractPath(runContract.sidebar_fixture.path,'sidebar fixture'),'utf8') : null;
if(sidebarFixture && crypto.createHash('sha256').update(sidebarFixture).digest('hex')!==runContract.sidebar_fixture.sha256)throw new Error('sidebar fixture identity differs from run contract');
const interwikiFixture=runContract.interwiki_fixture ? await fs.readFile(resolveRunContractPath(runContract.interwiki_fixture.path,'Interwiki fixture'),'utf8') : null;
if(interwikiFixture && crypto.createHash('sha256').update(interwikiFixture).digest('hex')!==runContract.interwiki_fixture.sha256)throw new Error('Interwiki fixture identity differs from run contract');
const navigationFixture=runContract.navigation_fixture ? await fs.readFile(resolveRunContractPath(runContract.navigation_fixture.path,'navigation fixture'),'utf8') : null;
if(navigationFixture && crypto.createHash('sha256').update(navigationFixture).digest('hex')!==runContract.navigation_fixture.sha256)throw new Error('navigation fixture identity differs from run contract');
const baselineReplacementPath=runContract.baseline_theme?.replacement_css_path
 ? resolveRunContractPath(runContract.baseline_theme.replacement_css_path,'baseline replacement CSS')
 : null;
const baselineReplacementCss=baselineReplacementPath?await fs.readFile(baselineReplacementPath,'utf8'):'';
const baselineReplacementSha=baselineReplacementCss
 ? crypto.createHash('sha256').update(baselineReplacementCss).digest('hex')
 : null;
if(runContract.baseline_theme?.replacement_css_sha256&&runContract.baseline_theme.replacement_css_sha256!==baselineReplacementSha)throw new Error('baseline replacement CSS hash differs from the run contract');
if(runContractArg&&baselineReplacementPath&&!/^[0-9a-f]{64}$/u.test(runContract.baseline_theme?.replacement_css_sha256??''))throw new Error('custom baseline replacement CSS needs a SHA-256 binding');
const runtimeBaselineStylesheetHref=runContract.baseline_theme?.runtime_stylesheet_href??runContract.baseline_theme?.stylesheet_href;
if(typeof runtimeBaselineStylesheetHref!=='string'||!runtimeBaselineStylesheetHref)throw new Error('run contract baseline theme needs a runtime stylesheet href');
const viewports=runContract.viewports;
if(!viewports[viewportArg])throw new Error(`unknown viewport ${viewportArg}`);
const {origin}=resolveFixtureOrigins({contractOrigin:runContract.target_site.origin,transportOrigin:transportOriginArg});
const repoRoot=path.resolve(packageDir,'../../../../../');
const backendTarget=resolveCaptureBackendTarget({runtimeRepo:runtimeRepoArg,backendProject:backendProjectArg,repoRoot});
const base=`${origin}/run-owned%3Atheme-lab-visual-acceptance-imported-20260924`;
const historyBase=`${origin}/run-owned%3Atheme-lab-visual-history-20260924`;
const registry={chromium,firefox,webkit};
if(!registry[engineArg])throw new Error(`unknown engine ${engineArg}`);
if(!runContract.browser_engines.includes(engineArg))throw new Error(`engine ${engineArg} is not in the acceptance run contract`);
const campaign=JSON.parse(await fs.readFile(resolveExistingContainedFile(themeLabDir,'ports/en-theme-campaign.json','EN theme campaign'),'utf8'));
const currentCampaign=runContract.schema==='scp_jp_sigma10_migration_run.v1';
let currentInventoryByName=null;
if(currentCampaign){
 const ledger=JSON.parse(await fs.readFile(resolveExistingContainedFile(themeLabDir,'ports/adaptation-authority.json','adaptation authority ledger'),'utf8'));
 const expected=[...Object.keys(ledger.packages).sort(),'sigma10-baseline'].sort();
 const inventory=runContract.current_candidate_inventory??[];
 currentInventoryByName=new Map(inventory.map(row=>[row.package,row]));
 if(inventory.length!==expected.length||inventory.map(row=>row.package).sort().join('\0')!==expected.join('\0'))throw new Error('Sigma-10 current contract must enumerate every maintained package and the baseline');
 if(JSON.stringify(Object.keys(runContract.additional_candidates??{}).sort())!==JSON.stringify(expected))throw new Error('Sigma-10 capture candidates differ from the explicit current inventory');
 if(runContract.frozen_sigma10_authority?.schema!=='theme_lab_frozen_sigma10_authority.v1'||!runContract.frozen_sigma10_authority.source_manifest_sha256)throw new Error('Sigma-10 capture needs frozen source authority bindings');
 for(const binding of Object.values(runContract.frozen_sigma10_authority.artifacts??{})){
  const bytes=await fs.readFile(resolveRunContractPath(binding.path,'frozen Sigma-10 authority'));
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==binding.sha256)throw new Error(`frozen Sigma-10 authority changed: ${binding.path}`);
 }
 const sourceManifestBytes=await fs.readFile(resolveRunContractPath(runContract.frozen_sigma10_authority.source_manifest,'Sigma-10 source manifest'));
 if(crypto.createHash('sha256').update(sourceManifestBytes).digest('hex')!==runContract.frozen_sigma10_authority.source_manifest_sha256)throw new Error('Sigma-10 source manifest differs from frozen authority');
 const sourceManifest=JSON.parse(sourceManifestBytes);
 for(const [identity,page] of Object.entries(sourceManifest.pages??{})){
  const bytes=await fs.readFile(resolveRunContractPath(`../${page.file}`,'frozen Sigma-10 source page'));
  if(crypto.createHash('sha256').update(bytes).digest('hex')!==page.sha256)throw new Error(`frozen Sigma-10 source changed: ${identity}`);
 }
 const saved=JSON.parse(await fs.readFile(resolveRunContractPath('saved-credit-component.json','saved Credit cascade')));
 if(JSON.stringify(saved.cascade)!==JSON.stringify(runContract.saved_component_css?.cascade))throw new Error('saved Credit cascade differs from the current run contract');
}
const extraCandidates=new Map(Object.entries(runContract.additional_candidates??{}).map(([name,value])=>{
 if(!/^[a-z0-9-]+$/u.test(name))throw new Error(`invalid additional candidate name: ${name}`);
 const relative=typeof value==='string'?value:value?.directory;
 if(typeof relative!=='string'||!relative)throw new Error(`additional candidate ${name} needs a directory`);
 const directory=resolveRunContractPath(relative,`additional candidate directory for ${name}`);
 if(currentCampaign){
  const inventory=currentInventoryByName?.get(name);
  if(!inventory||typeof value==='string'||inventory.directory!==value.directory||inventory.candidate_sha256!==value.candidate_sha256||inventory.source_sha256!==value.source_sha256)throw new Error(`${name}: Sigma-10 capture identity differs from the explicit current inventory`);
  const expectedDirectory=name==='sigma10-baseline'
   ?resolveExistingContainedDirectory(themeLabDir,'sigma10-migration/baseline-probe','Sigma-10 baseline directory')
   :resolveExistingPackageDirectory(portsDir,name,`${name}: maintained package directory`);
  if(directory!==expectedDirectory)throw new Error(`${name}: Sigma-10 capture points at the wrong package directory`);
 }
 return [name,directory];
}));
const allThemes=['dear-dictator',...campaign.themes.map(x=>x.slug.replace(/^theme:/u,'')),...extraCandidates.keys()];
if(!currentCampaign&&[...extraCandidates.keys()].some(name=>name==='dear-dictator'||campaign.themes.some(x=>x.slug===`theme:${name}`)))throw new Error('additional candidate collides with an accepted campaign theme');
const themes=themeArg?[themeArg]:themesArg?themesArg.split(',').filter(Boolean):allThemes;
if(themes.some(theme=>!allThemes.includes(theme)))throw new Error('requested theme is not registered in the campaign or run contract');
const themeDirectory=theme=>extraCandidates.get(theme)??resolveExistingPackageDirectory(portsDir,theme,`${theme}: maintained package directory`);
const fixtureHashCache=new Map();
async function fixtureContractSha(spec){
 const variant=spec.fixtureSlug?.endsWith('credit-no-rate-20260924')?'fixture-no-rate.wikidot.txt':spec.fixtureSlug?.endsWith('credit-heritage-20260924')?'fixture-heritage.wikidot.txt':null;
 const pageSource=variant??(spec.surface==='page.history'?'history-fixture.wikidot.txt':'fixture.wikidot.txt');
 // Key only the page and include documents that are rendered by this state.
 // The former package-wide hash let a credit fixture edit invalidate every
 // theme/state and cause blanket replays. Candidate, action, runtime, asset,
 // actor, engine and viewport contracts remain separately bound below.
 const names=[pageSource,'nav-top.wikidot.txt','nav-side.wikidot.txt','nav-interwiki.wikidot.txt'];
 if(spec.surface==='page.backlinks')names.push('backlink-fixture.wikidot.txt');
 const hash=crypto.createHash('sha256').update('theme-lab-fixture-state.v2\0');
 for(const name of [...new Set(names)].sort()){
  let digest=fixtureHashCache.get(name);
  if(!digest){digest=crypto.createHash('sha256').update(await fs.readFile(path.join(packageDir,name))).digest('hex');fixtureHashCache.set(name,digest)}
  hash.update(name);hash.update('\0');hash.update(digest);
 }
 if(migrationFixture){
  const identityManifestPath=resolveRunContractPath(runContract.fixture_contract.identity_manifest,'migration fixture manifest');
  const manifestBytes=await fs.readFile(identityManifestPath);
  hash.update(crypto.createHash('sha256').update(manifestBytes).digest('hex'));
  const manifest=JSON.parse(manifestBytes);
  for(const slug of [migrationFixture.main_slug,migrationFixture.top_slug,migrationFixture.side_slug]){
   const fixture=manifest.fixtures?.find(item=>item.slug===slug);
   if(!fixture)throw new Error(`migration fixture is absent from manifest: ${slug}`);
   // Fixture files are written relative to the identity manifest's directory
   // (sigma10-migration/), not to the run contract's directory (current-campaign/).
   const bytes=await fs.readFile(resolveManifestRelativePath(themeLabDir,identityManifestPath,fixture.file,`migration fixture ${slug}`));
   const actual=crypto.createHash('sha256').update(bytes).digest('hex');
   if(actual!==fixture.sha256)throw new Error(`migration fixture drift: ${slug}`);
   hash.update(slug);hash.update('\0');hash.update(actual);
  }
 }
 return hash.digest('hex');
}
async function expandMoreOptions(page){
 const more=page.locator('#more-options-button');
 if(!(await more.textContent())?.trim().startsWith('-'))await more.click();
 await page.waitForFunction(()=>document.querySelector('#more-options-button')?.textContent?.trim().startsWith('-'));
 await page.locator('#page-options-bottom-2').waitFor({state:'visible'});
}
async function revealPagePane(page){
 const fixedTop=await page.evaluate(topFixedNavigationInset);
 const firstToolbar=page.locator('#page-options-bottom');
 const target=await firstToolbar.count()?firstToolbar:page.locator('#action-area');
 const targetTop=await target.evaluate(element=>element.getBoundingClientRect().top+window.scrollY);
 // Keep the first page-options row visible together with the inline pane. The
 // shared mobile shell now lets its menu control scroll with the header, so
 // only retain an inset when a theme has an independently fixed control.
 const desiredTop=fixedTop>0?fixedTop+12:12;
 await page.evaluate(({top,desired})=>window.scrollTo({top:top-desired,behavior:'instant'}),{top:targetTop,desired:desiredTop});
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
// The credit control sits below the first screenful. Bring the real control into
// frame (below any fixed navigation) so the screenshot and the target
// measurement actually contain it.
async function revealCreditControl(page){
 const control=page.locator('.creditButton a:visible').first();
 await control.waitFor({state:'visible'});
 await control.scrollIntoViewIfNeeded();
 await revealBelowFixedMobileNavigation(page,control);
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
async function revealBelowFixedMobileNavigation(page,selectorOrLocator){
 const fixedTop=await page.evaluate(topFixedNavigationInset);
 const target=typeof selectorOrLocator==='string'?page.locator(selectorOrLocator):selectorOrLocator;
 const targetTop=await target.evaluate(element=>element.getBoundingClientRect().top+window.scrollY);
 const viewportHeight=page.viewportSize()?.height??0;
 const documentHeight=await page.evaluate(()=>document.documentElement.scrollHeight);
 const wanted=targetTop-fixedTop-12;
 const maxScroll=Math.max(0,documentHeight-viewportHeight-fixedTop-12);
 await page.evaluate(top=>window.scrollTo({top,behavior:'instant'}),Math.max(0,Math.min(wanted,maxScroll)));
 if(fixedTop>0){const top=await target.evaluate(element=>element.getBoundingClientRect().top);const correction=Math.max(0,fixedTop+12-top);if(correction)await page.evaluate(offset=>window.scrollBy({top:-offset,behavior:'instant'}),correction)}
 await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
async function settleFiniteVisualTransitions(page){return page.evaluate(async()=>{const running=document.getAnimations({subtree:true}).filter(animation=>animation.playState==='running'&&Number.isFinite(animation.effect?.getTiming().iterations));for(const animation of running){try{animation.finish()}catch{}}await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return running.length})}
// Read-only measurements must observe the settled state that the screenshot
// (animations disabled) paints. Injecting the acceptance stylesheet starts
// finite CSS transitions (left/font-size/flex-grow...) on every surface; this
// is a measurement-phase step, not part of any state's action contract.
async function settleFiniteMeasurementTransitions(page){return page.evaluate(async()=>{await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));let finished=0;for(const animation of document.getAnimations()){if(animation.playState==='running'&&Number.isFinite(animation.effect?.getTiming().iterations)){try{animation.finish();finished++}catch{}}}await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));return finished})}
import {movePointerToSafeArea} from '../../src/pointer-park.mjs';

async function parkPointer(page,_viewport){await movePointerToSafeArea(page)}
function shouldParkPointer(spec){return !/(?:hover|pointerover|expanded)/iu.test(spec.state)&&spec.surface!=='nav.mobile-top'&&spec.surface!=='shell.footer-license'}
let observedBackendRuntimeIdentity=null;
function assertNavigationRuntimeIdentity(response,url,label){
 const runtime=assertRuntimeSourceSha(expectedRuntimeSourceSha,runtimeSourceShaFromHeaders(response.headers()),label);
 const backend=assertDeepwellRuntimeIdentity(expectedBackendRuntimeIdentity,deepwellRuntimeIdentityFromHeaders(response.headers()),label);
 if(observedBackendRuntimeIdentity&&observedBackendRuntimeIdentity.identity_sha256!==backend.identity_sha256)throw new Error(`${label} Deepwell identity changed during this capture`);
 observedBackendRuntimeIdentity=backend;
 return {runtime,backend};
}
async function waitForSvelteClickHandler(page,selector){
 await page.waitForFunction(selector=>{
  const element=document.querySelector(selector);if(!element)return false;
  const eventsSymbol=Object.getOwnPropertySymbols(element).find(symbol=>symbol.description==='events');
  const handlers=eventsSymbol?element[eventsSymbol]:null;return typeof handlers?.click==='function';
 },selector,{timeout:10000});
}
async function gotoFixture(page,url){
 let lastError;
 for(let attempt=0;attempt<3;attempt++){
  try{
   const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:30000});
   if(!response)throw new Error(`fixture navigation returned no main-resource response: ${url}`);
   return assertNavigationRuntimeIdentity(response,url,`fixture navigation ${url}`);
  }
  catch(error){
   lastError=error;
   const transient=/interrupted by another navigation|NS_BINDING_ABORTED|net::ERR_ABORTED/iu.test(error.message);
   if(!transient||attempt===2)throw error;
   await page.waitForTimeout(50*(attempt+1)).catch(()=>{});
  }
 }
 throw lastError;
}
// The migration shell (#top-bar/#side-bar) is rendered by the Svelte layout from
// view data, so a single post-load innerHTML mutation races hydration and can be
// silently clobbered back to the site's own navigation. Fetch the source-derived
// fixtures and keep re-applying the substitution until it survives a quiet
// window; a substitution that never stabilizes is a hard failure rather than a
// capture that quietly measures the wrong shell.
async function injectMigrationShell(page,fixture){
 // Svelte finishes hydrating the shell roughly a second after DOMContentLoaded.
 // Waiting for a delegated Svelte handler proves hydration is complete; when a
 // surface has no such control, a settled document is the fallback barrier.
 const hydrated=await page.waitForFunction(()=>{
  for(const selector of ['#history-button','#page-options-bottom','#search-top-box-form input[type="submit"]','#side-bar .collapsible-block-link']){
   const element=document.querySelector(selector);if(!element)continue;
   const symbol=Object.getOwnPropertySymbols(element).find(candidate=>candidate.description==='events');
   if(symbol&&typeof element[symbol]?.click==='function')return true;
  }
  return false;
 },null,{timeout:12000}).then(()=>true).catch(()=>false);
 if(!hydrated)await page.waitForFunction(()=>document.readyState==='complete',null,{timeout:12000}).catch(()=>{});
 await page.evaluate(async fixture=>{
  // The local development runtime can restart mid-run; retry transient non-OK
  // responses rather than recording an environment flap as a migration finding.
  const fetchFixture=async slug=>{
   let lastStatus=0;
   for(let attempt=0;attempt<5;attempt++){
    const response=await fetch(`/${encodeURIComponent(slug)}`,{cache:'no-store'});
    if(response.ok)return response;
    lastStatus=response.status;
    await new Promise(resolve=>setTimeout(resolve,600*(attempt+1)));
   }
   throw new Error(`migration navigation fixture ${slug} returned ${lastStatus}`);
  };
  const payloads=[];
  for(const [slug,selector] of [[fixture.top_slug,'#top-bar'],[fixture.side_slug,'#side-bar']]){
   const response=await fetchFixture(slug);
   const html=new DOMParser().parseFromString(await response.text(),'text/html');
   const source=html.querySelector('#page-content');
   if(!source)throw new Error(`migration navigation fixture lacks ${selector}`);
   payloads.push([selector,source.innerHTML]);
  }
  const apply=()=>{for(const [selector,html] of payloads){const target=document.querySelector(selector);if(!target)throw new Error(`migration shell target absent: ${selector}`);if(target.innerHTML!==html)target.innerHTML=html}};
  apply();
  await new Promise((resolve,reject)=>{
   let lastMutation=performance.now();
   const observer=new MutationObserver(()=>{lastMutation=performance.now();apply()});
   for(const [selector] of payloads)observer.observe(document.querySelector(selector),{childList:true,subtree:true,characterData:true});
   const deadline=performance.now()+2000;
   const tick=()=>{
    if(performance.now()-lastMutation>=400){observer.disconnect();resolve();return}
    if(performance.now()>deadline){observer.disconnect();reject(new Error('migration shell injection did not stabilize'));return}
    requestAnimationFrame(tick);
   };
   requestAnimationFrame(tick);
  });
 },fixture);
}
const hydrationIndependentStates=new Set([
 'page.normal|settled',
 'shell.search|typed-focused','shell.search|compact-submit',
 'nav.desktop-top|submenu-hover','nav.desktop-top|keyboard-focus',
 'nav.mobile-top|submenu-expanded','nav.sidebar|open','nav.sidebar|closed-after-open','shell.search|compact-submit',
 'page.options|default',
 'shell.footer-license|scrolled-bottom','shell.interwiki|visible','shell.login|account-hover',
 'content.link|hovered','content.link|focused','content.rating|focused',
 'credit.default|normal','credit.view|open','credit.view|scrolled-bottom',
 'credit.otherwise|open','credit.otherwise|scrolled-bottom','credit.otherwise|back-control-click','credit.otherwise|back-to-view',
 'credit.close-back|restored'
]);
const requiresSvelteHydration=spec=>!spec.surface.startsWith('credit.variant.')&&!hydrationIndependentStates.has(`${spec.surface}|${spec.state}`);
async function setMigrationCreditTarget(page,target){
 await page.evaluate(hash=>{location.hash=hash},`#${target}`);
 await page.waitForFunction(id=>document.querySelector(id)?.matches(':target'),`#${target}`);
}
async function openCreditView(page){
 if(migrationFixture){await setMigrationCreditTarget(page,'u-credit-view');return}
 await page.locator('.creditButton a').first().click();
 await page.waitForFunction(()=>location.hash==='#u-credit-view');
}
async function openCreditOtherwise(page){
 if(migrationFixture){await setMigrationCreditTarget(page,'u-credit-otherwise');return}
 await page.locator('.creditButton a').first().click();
 await page.getByText('その他のライセンス',{exact:true}).first().click();
 await page.waitForFunction(()=>location.hash==='#u-credit-otherwise');
}
async function visualDiagnostics(page,surface){
 const selectors=surface==='dialog.generic'?['#odialog-shader','#odialog-container','#odialog-container .owindow.error','#odialog-container .owindow.error .content','#odialog-container .owindow.error #modal-title','.button-bar','.button-close-message','.page-rate-widget-box','#u-credit-view']:surface.startsWith('credit.')?['#content-wrap','#main-content','#page-content','#action-area','#side-bar','.mobile-top-bar','#u-credit-view .modalcontainer','#u-credit-view .modalbox','#u-credit-view .page-rate-widget-box','#u-credit-view .page-rate-widget-box .rate-points','#u-credit-view .page-rate-widget-box .rateup','#u-credit-view .page-rate-widget-box .ratedown','#u-credit-view .page-rate-widget-box .cancel','#u-credit-otherwise .modalcontainer','#u-credit-otherwise .modalbox','#u-credit-otherwise .modalbox .credit.otherwise','#u-credit-otherwise .modalbox .credit-back','#u-credit-otherwise .modalbox .credit-back a[href="#u-credit-view"]','.page-rate-widget-box','.creditRate','.rate-box-with-credit-button','.creditButton','.creditButton a']:surface.startsWith('page.history')?['.revision-list','.page-history','.page-history tbody tr.revision-header','.page-history tbody tr.revision-row','.page-history .revision-diff','.revision-diff','.revision-diff .revision-diff-line','.page-source']:surface.startsWith('page.source')?['#action-area','#page-options-bottom','#page-options-bottom-2','.page-source','.action-area-close','.mobile-top-bar .open-menu a']:surface.startsWith('page.files')?['.file-list-scroll','.file-list','.file-row']:surface.startsWith('nav.')?['#top-bar','#top-bar .top-bar','#top-bar .top-bar a','.mobile-top-bar','.mobile-top-bar a','#side-bar','#side-bar .close-menu','#side-bar .side-block','#side-bar .collapsible-block-link','#side-bar .collapsible-block-unfolded']:surface.startsWith('shell.')?['#login-status','#footer','#license-area','.scpnet-interwiki-frame']:surface.startsWith('page.edit')?['#action-area','textarea.editor-wikitext','textarea[name="wikitext"]','#edit-page-comments']:surface==='page.normal'?['#content-wrap','#main-content','#page-title','#page-content','#action-area','#side-bar','#header','#header h1','#header h2','#extra-div-1','#extra-div-2','#search-top-box','#search-top-box-form','#search-top-box-input','#login-status','.mobile-top-bar','.yui-navset','.yui-navset .yui-nav a','.yui-navset .yui-nav a em','.yui-navset .yui-content']:['#action-area','#page-title','#page-content','.page-rate-widget-box'];
 if(surface.startsWith('credit.'))selectors.push('.creditRate > .rateBox.unfolded','.creditRateOtherwise > li.unfolded','.creditRateOtherwise > li.folded');
 if(surface==='shell.search')selectors.push('#search-top-box','#search-top-box-form','#search-top-box-input','#search-top-box-form input[type="submit"]');
 if(surface==='shell.login')selectors.push('#login-status','#account-options','#account-topbutton');
 if(surface==='shell.footer-license')selectors.push('#footer','#license-area');
 if(surface==='page.options')selectors.push('#page-options-bottom','#page-options-bottom-2');
 if(surface==='page.tags')selectors.push('#tags-button','#action-area input[type="text"]');
 if(surface==='page.edit')selectors.push('textarea.editor-wikitext','textarea[name="wikitext"]','#edit-page-comments');
 if(surface==='page.delete')selectors.push('#page-delete','#page-delete .buttons','#page-delete .page-delete-actions');
 if(surface==='page.rename')selectors.push('#page-move','#page-move .buttons','#page-move .page-move-actions');
 if(surface==='content.collapsible')selectors.push('#page-content .collapsible-block-unfolded');
 if(surface==='content.tabview')selectors.push('.yui-navset .selected','.yui-navset .yui-content');
 if(surface==='content.link')selectors.push('a[href="#fixture-link"]');
 if(surface==='content.rating')selectors.push('.page-rate-widget-box a');
 if(surface==='page.history')selectors.push('.revision-diff','.page-history');
 if(surface==='page.source')selectors.push('.page-source','#action-area');
 if(surface==='shell.interwiki')selectors.push('.scpnet-interwiki-wrapper','iframe.html-block-iframe');
 const result=await page.evaluate(selectors=>{
  const rectOf=e=>{const r=e.getBoundingClientRect();return{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)}};
  const describe=selector=>{const e=document.querySelector(selector);if(!e)return null;const r=e.getBoundingClientRect(),s=getComputedStyle(e);const pseudo=which=>{const p=getComputedStyle(e,which);return{content:p.content,display:p.display,position:p.position,color:p.color,background_color:p.backgroundColor,font_size:p.fontSize,line_height:p.lineHeight,text_shadow:p.textShadow,transform:p.transform,top:p.top,left:p.left,width:p.width,height:p.height}};return{text:(e.innerText??'').trim().replace(/\s+/gu,' ').slice(0,180),value:typeof e.value==='string'?e.value.slice(0,240):null,children:[...e.children].slice(0,8).map(child=>({tag:child.tagName,id:child.id,class:typeof child.className==='string'?child.className:'',text:(child.innerText??'').trim().replace(/\s+/gu,' ').slice(0,90),rect:rectOf(child),font:getComputedStyle(child).fontFamily,position:getComputedStyle(child).position,transform:getComputedStyle(child).transform,before:getComputedStyle(child,'::before').content,after:getComputedStyle(child,'::after').content})),rect:rectOf(e),display:s.display,visibility:s.visibility,opacity:s.opacity,position:s.position,z_index:s.zIndex,pointer_events:s.pointerEvents,position:s.position,color:s.color,background_color:s.backgroundColor,background_image:s.backgroundImage,background_position:s.backgroundPosition,background_size:s.backgroundSize,font_family:s.fontFamily,font_size:s.fontSize,font_weight:s.fontWeight,line_height:s.lineHeight,letter_spacing:s.letterSpacing,text_shadow:s.textShadow,text_stroke:`${s.webkitTextStrokeWidth} ${s.webkitTextStrokeColor}`,text_fill:s.webkitTextFillColor,filter:s.filter,white_space:s.whiteSpace,overflow_wrap:s.overflowWrap,word_break:s.wordBreak,overflow_x:s.overflowX,grid_template_columns:s.gridTemplateColumns,grid_column:`${s.gridColumnStart} / ${s.gridColumnEnd}`,scroll_width:e.scrollWidth,client_width:e.clientWidth,scroll_height:e.scrollHeight,client_height:e.clientHeight,before:pseudo('::before'),after:pseudo('::after')}};
  const historyInstances=[...document.querySelectorAll('.page-history')].map(table=>({rect:rectOf(table),rows:[...table.querySelectorAll('tbody tr')].map(row=>{const style=getComputedStyle(row);return{class_name:row.className,text:(row.innerText??'').trim().replace(/\s+/gu,' ').slice(0,120),rect:rectOf(row),display:style.display,visibility:style.visibility,opacity:style.opacity,position:style.position,cells:[...row.children].map(cell=>{const cs=getComputedStyle(cell),before=getComputedStyle(cell,'::before');return{class_name:cell.className,text:(cell.innerText??'').trim().replace(/\s+/gu,' ').slice(0,80),rect:rectOf(cell),color:cs.color,background_color:cs.backgroundColor,font_size:cs.fontSize,line_height:cs.lineHeight,display:cs.display,grid_area:cs.gridArea,grid_columns:cs.gridTemplateColumns,before:{content:before.content,color:before.color,background_color:before.backgroundColor,display:before.display,font_size:before.fontSize}}})}})}));
  const headerChildren=[...document.querySelector('#header')?.children??[]].map(element=>{const style=getComputedStyle(element);return{tag:element.tagName,id:element.id,class_name:typeof element.className==='string'?element.className:'',text:(element.innerText??'').trim().replace(/\s+/gu,' ').slice(0,80),rect:rectOf(element),display:style.display,position:style.position,float:style.float,order:style.order,margin:style.margin}});
  const title=document.querySelector('#page-title')?.getBoundingClientRect();const titleOverlaps=title?[...document.querySelectorAll('body *')].filter(e=>e.id!=='page-title'&&e.children.length===0&&(e.innerText??e.textContent??'').trim()).map(e=>({e,r:e.getBoundingClientRect(),s:getComputedStyle(e)})).filter(({r})=>r.width>0&&r.height>0&&r.left<title.right&&r.right>title.left&&r.top<title.bottom&&r.bottom>title.top).slice(0,16).map(({e,r,s})=>({tag:e.tagName,id:e.id,class:typeof e.className==='string'?e.className:'',text:(e.innerText??e.textContent??'').trim().replace(/\s+/gu,' ').slice(0,80),rect:rectOf(e),position:s.position,z:s.zIndex,color:s.color,background:s.backgroundColor,ancestors:[e.parentElement,e.parentElement?.parentElement,e.parentElement?.parentElement?.parentElement].filter(Boolean).map(p=>({tag:p.tagName,id:p.id,class:typeof p.className==='string'?p.className:'',rect:rectOf(p),position:getComputedStyle(p).position,z:getComputedStyle(p).zIndex}))})):[];
  const headerText=[...document.querySelectorAll('#header *')].filter(e=>e.children.length===0&&(e.innerText??e.textContent??'').trim()).slice(0,20).map(e=>({tag:e.tagName,id:e.id,class:typeof e.className==='string'?e.className:'',text:(e.innerText??e.textContent??'').trim().replace(/\s+/gu,' ').slice(0,80),rect:rectOf(e),color:getComputedStyle(e).color,background:getComputedStyle(e).backgroundColor,ancestors:[e.parentElement,e.parentElement?.parentElement].filter(Boolean).map(p=>({tag:p.tagName,id:p.id,class:typeof p.className==='string'?p.className:'',rect:rectOf(p)}))}));
  // Horizontal-overflow evidence must catch two distinct failure modes: an
  // element whose border box crosses the viewport (box overflow) and an
  // element whose content overflows its own box while the box itself stays
  // inside the viewport (content overflow, often caused by unbreakable text or
  // a min-width child). Only checking rect.right misses the second mode even
  // though it is what expands document.scrollWidth. Rank by the furthest
  // reachable edge so the culprit appears first.
  const documentClientWidth=document.documentElement.clientWidth;
  const horizontalOverflow=[...document.querySelectorAll('body *')].map(element=>{const rect=element.getBoundingClientRect();return{element,rect,selfOverflow:Math.max(0,element.scrollWidth-element.clientWidth),reachableRight:Math.max(rect.right,rect.left+element.scrollWidth)}}).filter(({element,rect,selfOverflow})=>{if(rect.width<=0&&rect.height<=0)return false;if(getComputedStyle(element).display==='none')return false;return rect.right>documentClientWidth+1||selfOverflow>1}).sort((a,b)=>b.reachableRight-a.reachableRight).slice(0,24).map(({element,rect,selfOverflow,reachableRight})=>{const style=getComputedStyle(element);return{tag:element.tagName,id:element.id,class:typeof element.className==='string'?element.className:'',rect:rectOf(element),right_overflow:Math.round(rect.right-documentClientWidth),self_overflow:selfOverflow,reachable_right:Math.round(reachableRight),position:style.position,display:style.display,visibility:style.visibility,white_space:style.whiteSpace,overflow_x:style.overflowX,min_width:style.minWidth,width:style.width,text:(element.innerText??'').trim().replace(/\s+/gu,' ').slice(0,80)}});
  return{viewport:{width:innerWidth,client_width:documentClientWidth,height:innerHeight,scroll_x:window.scrollX,scroll_y:window.scrollY,document_width:document.documentElement.scrollWidth,body_width:document.body.scrollWidth},elements:Object.fromEntries(selectors.map(selector=>[selector,describe(selector)])),historyInstances,titleOverlaps,headerText,headerChildren,horizontalOverflow}
 },selectors);return{...result,topFixedNavigationInset:await page.evaluate(topFixedNavigationInset)}
}
const states=[
  {surface:'page.normal',state:'settled',viewports:Object.keys(viewports),action:async()=>{}},
  {surface:'content.tabview',state:'second-tab-selected',viewports:['desktop','mobile','narrow-mobile'],action:async p=>{const tab=p.getByText('詳細',{exact:true}).first();await tab.scrollIntoViewIfNeeded();await tab.click();await p.getByText('別のタブへ移動できます。',{exact:true}).waitFor({state:'visible'});await revealBelowFixedMobileNavigation(p,'.yui-navset')}} ,
  {surface:'content.collapsible',state:'expanded',viewports:['desktop','mobile','narrow-mobile'],action:async p=>{const toggle=p.locator('#page-content .collapsible-block-link').first();await toggle.scrollIntoViewIfNeeded();const parent=toggle.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " collapsible-block ")][1]');const unfolded=parent.locator(':scope > .collapsible-block-unfolded');if(await unfolded.evaluate(e=>getComputedStyle(e).display==='none')){await toggle.focus();await toggle.press('Enter')}await unfolded.waitFor({state:'visible'});if(await p.evaluate(()=>innerWidth<=600))await revealBelowFixedMobileNavigation(p,unfolded);await movePointerToSafeArea(p);await settleFiniteVisualTransitions(p)}},
  {surface:'shell.search',state:'typed-focused',viewports:['desktop','laptop','tablet'],action:async p=>{await waitForSvelteClickHandler(p,'#history-button');await exerciseHeaderSearch(p,p.__themeLabSearchSourceAuthority)}},
  {surface:'shell.search',state:'compact-submit',viewports:['mobile','narrow-mobile'],action:async p=>{await exerciseHeaderSearch(p,p.__themeLabSearchSourceAuthority)}},
  {surface:'nav.desktop-top',state:'submenu-hover',viewports:['desktop'],action:async p=>{const item=p.locator('#top-bar li').filter({has:p.locator('ul')}).first();await item.scrollIntoViewIfNeeded();await item.locator('a').first().hover()}},
  {surface:'nav.tablet-top',state:'active-navigation-expanded',viewports:['tablet'],action:expandTabletTopNavigation},
  {surface:'nav.mobile-top',state:'submenu-expanded',viewports:['mobile','narrow-mobile'],action:expandMobileTopSubmenu},
  {surface:'nav.sidebar',state:'open',viewports:['mobile','narrow-mobile'],action:async p=>{await openSidebar(p);await p.locator('#side-bar').scrollIntoViewIfNeeded()}},
  {surface:'nav.sidebar',state:'closed-after-open',viewports:['mobile','narrow-mobile'],action:async p=>{const openHash=await openSidebar(p);await closeSidebar(p,openHash)}},
  {surface:'nav.sidebar',state:'open-submenu',viewports:['mobile','narrow-mobile'],action:async p=>{
    await openSidebar(p);
    let toggle=p.locator('#side-bar .collapsible-block-link').first();
    let syntheticFixture=false;
    if(!(await toggle.count())){
      syntheticFixture=true;
      await p.locator('#side-bar').evaluate(sidebar=>{
        const block=document.createElement('div');
        block.className='side-block';
        block.dataset.themeLabActionFixture='sidebar-open-submenu';
        block.innerHTML='<div class="heading">テーマ確認用の折りたたみ</div><div class="collapsible-block"><div class="collapsible-block-folded"><a class="collapsible-block-link" href="javascript:;">サブメニューを開く</a></div><div class="collapsible-block-unfolded" style="display:none"><div class="collapsible-block-unfolded-link"><a class="collapsible-block-link" href="javascript:;">サブメニューを閉じる</a></div><div class="menu-item"><a href="#fixture-link">サブメニュー項目</a></div></div></div>';
        sidebar.append(block);
      });
      toggle=p.locator('#side-bar [data-theme-lab-action-fixture="sidebar-open-submenu"] .collapsible-block-folded .collapsible-block-link').first();
    }
    if(!(await toggle.count()))throw new Error('sidebar open-submenu action has no native collapsible control');
    await toggle.scrollIntoViewIfNeeded();
    await toggle.click();
    const block=toggle.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " collapsible-block ")][1]');
    const unfolded=block.locator(':scope > .collapsible-block-unfolded');
    await unfolded.waitFor({state:'visible'});
    const child=unfolded.locator('.menu-item a').first();
    await child.scrollIntoViewIfNeeded();
    const observation=await p.evaluate(()=>{
      const block=document.querySelector('#side-bar [data-theme-lab-action-fixture="sidebar-open-submenu"] .collapsible-block')??document.querySelector('#side-bar .collapsible-block');
      const sidebar=document.querySelector('#side-bar');
      if(!block||!sidebar)return null;
      const folded=block.querySelector(':scope > .collapsible-block-folded');
      const unfolded=block.querySelector(':scope > .collapsible-block-unfolded');
      const child=unfolded?.querySelector('.menu-item a');
      const sidebarRect=sidebar.getBoundingClientRect();
      const childRect=child?.getBoundingClientRect();
      const childStyle=child?getComputedStyle(child):null;
      const sidebarStyle=getComputedStyle(sidebar);
      return{
        mode:'native-wikidot-collapsible-click',
        synthetic_fixture:!!document.querySelector('#side-bar [data-theme-lab-action-fixture="sidebar-open-submenu"]'),
        folded_hidden:!!folded&&folded.style.display==='none',
        expanded_visible:!!unfolded&&unfolded.style.display==='block'&&getComputedStyle(unfolded).display!=='none'&&unfolded.getBoundingClientRect().width>0&&unfolded.getBoundingClientRect().height>0,
        child_visible:!!child&&childStyle?.display!=='none'&&childStyle?.visibility==='visible'&&childRect.width>0&&childRect.height>0&&childRect.top>=sidebarRect.top-1&&childRect.bottom<=sidebarRect.bottom+1,
        sidebar_open:sidebarStyle.display!=='none'&&sidebarStyle.visibility==='visible'&&sidebarRect.width>0&&sidebarRect.right>0&&sidebarRect.left<innerWidth,
        location_hash:location.hash
      };
    });
    await p.evaluate(value=>{
      window.__themeLabActionContractObservation=value;
      window.__themeLabActionTrace??=[];
      window.__themeLabActionTrace.push({type:'native-collapsible-expanded',synthetic_fixture:value?.synthetic_fixture??false,folded_hidden:value?.folded_hidden??false,expanded_visible:value?.expanded_visible??false,child_visible:value?.child_visible??false,sidebar_open:value?.sidebar_open??false});
    },observation);
    if(!observation?.expanded_visible||!observation?.folded_hidden||!observation?.child_visible||!observation?.sidebar_open)throw new Error(`sidebar open-submenu action did not expand the native collapsible state: ${JSON.stringify(observation)}`);
  }},
  {surface:'credit.default',state:'normal',viewports:['desktop','mobile','narrow-mobile'],action:async p=>{await revealCreditControl(p)}},
   {surface:'credit.view',state:'open',viewports:['desktop','mobile','narrow-mobile'],action:openCreditView},
   {surface:'credit.otherwise',state:'open',viewports:['desktop','mobile','narrow-mobile'],action:openCreditOtherwise},
   {surface:'credit.close-back',state:'restored',viewports:['desktop','mobile','narrow-mobile'],action:async p=>{if(migrationFixture)await setMigrationCreditTarget(p,'u-credit-view');else{await p.locator('.creditButton a').first().click();await p.waitForFunction(()=>location.hash==='#u-credit-view')}await p.goBack();await p.waitForFunction(()=>location.hash!=='#u-credit-view')}},
  {surface:'page.options',state:'default',viewports:['desktop','mobile','narrow-mobile'],action:async p=>{await p.locator('#page-options-bottom').scrollIntoViewIfNeeded();if(await p.evaluate(()=>innerWidth<=600))await revealBelowFixedMobileNavigation(p,'#page-options-bottom')}},
  {surface:'page.options',state:'more-expanded',viewports:['desktop','mobile','narrow-mobile'],action:async p=>{await expandMoreOptions(p);await p.locator('#page-options-bottom-2').scrollIntoViewIfNeeded();if(await p.evaluate(()=>innerWidth<=600))await revealBelowFixedMobileNavigation(p,'#page-options-bottom-2')}},
  {surface:'page.tags',state:'open',viewports:['desktop','mobile','narrow-mobile'],action:async p=>{await p.locator('#tags-button').click();await revealPagePane(p);await p.locator('#action-area input[type="text"]').first().waitFor({state:'visible'})}},
  {surface:'page.history',state:'list',viewports:['desktop','mobile','narrow-mobile'],action:async p=>{await p.locator('#history-button').click();await p.locator('.page-history tr[id^="revision-row-"]').first().waitFor();await revealPagePane(p)}},
  {surface:'page.history',state:'revision-row-hovered',viewports:['desktop','mobile','narrow-mobile'],action:async p=>{await p.locator('#history-button').click();const row=p.locator('.page-history tr[id^="revision-row-"]').first();await row.waitFor();await revealPagePane(p);await row.hover()}},
  {surface:'page.history',state:'diff',viewports:['desktop','mobile','narrow-mobile'],action:async p=>{await p.locator('#history-button').click();await p.locator('#revision-diff-from').waitFor();await p.locator('.revision-diff-controls button').last().click();await p.waitForFunction(()=>!!document.querySelector('.revision-diff')||!!document.querySelector('.revision-diff-panel p')||!!document.querySelector('#odialog-container .owindow'));await revealPagePane(p);const diff=p.locator('.revision-diff');if(await diff.count()){if(await p.evaluate(()=>innerWidth<=600))await revealBelowFixedMobileNavigation(p,'.revision-diff');else await diff.scrollIntoViewIfNeeded()}}},
  {surface:'page.source',state:'open',viewports:['desktop','mobile','narrow-mobile'],action:async p=>{await expandMoreOptions(p);await p.locator('#view-source-button').click();await p.locator('.page-source').waitFor();await revealPagePane(p)}},
  {surface:'page.files',state:'list',viewports:['desktop','mobile','narrow-mobile'],action:async p=>{await p.locator('#files-button').click();await p.locator(FILES_PANE.table).waitFor();await p.locator(FILES_PANE.row).filter({hasText:'theme-lab-visual-fixture_日本語長名'}).waitFor({state:'visible'});await revealPagePane(p)}},
  {surface:'page.files',state:'horizontal-actions',viewports:['mobile','narrow-mobile'],action:async p=>{await p.locator('#files-button').click();await p.locator(FILES_PANE.table).waitFor();await p.locator(FILES_PANE.row).filter({hasText:'theme-lab-visual-fixture_日本語長名'}).waitFor({state:'visible'});await revealPagePane(p);await p.locator(FILES_PANE.scroller).evaluate(e=>e.scrollLeft=e.scrollWidth)}},
  {surface:'shell.footer-license',state:'scrolled-bottom',viewports:['desktop','mobile','narrow-mobile'],action:async p=>{const license=p.locator('#license-area');await license.waitFor({state:'visible'});await license.evaluate(e=>e.scrollIntoView({block:'end',behavior:'instant'}));await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));await p.locator('#footer').waitFor({state:'visible'});await movePointerToSafeArea(p);await settleFiniteVisualTransitions(p)}},
  {surface:'shell.interwiki',state:'visible',viewports:['desktop','mobile','narrow-mobile'],action:async p=>{const wrapper=p.locator('.scpnet-interwiki-wrapper').first();await wrapper.waitFor({state:'attached'});const frame=wrapper.locator('iframe.html-block-iframe').first();await frame.waitFor({state:'attached'});const contract=await p.evaluate(()=>{const wrapper=document.querySelector('.scpnet-interwiki-wrapper');const frame=wrapper?.querySelector('iframe.html-block-iframe');if(!wrapper||!frame)return null;const box=frame.getBoundingClientRect();return{wrapper_present:true,wrapper_display:getComputedStyle(wrapper).display,wrapper_rect:(()=>{const r=wrapper.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}})(),frame_present:true,frame_display:getComputedStyle(frame).display,frame_rect:{x:box.x,y:box.y,width:box.width,height:box.height},document_width:document.documentElement.scrollWidth,viewport_width:innerWidth}});if(!contract)throw new Error('local Interwiki wrapper/frame contract is absent');await p.evaluate(value=>{window.__themeLabActionContractObservation=value;window.__themeLabActionTrace??=[];window.__themeLabActionTrace.push({type:'local-interwiki-contract'})},contract);await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}},
  {surface:'page.backlinks',state:'list',viewports:['desktop','mobile'],action:async p=>{await expandMoreOptions(p);await p.locator('#backlinks-button').click();await p.getByText('SCP-JP Theme Lab Backlink Fixture',{exact:true}).waitFor();await revealPagePane(p)}},
  {surface:'page.parent',state:'pane',viewports:['desktop','mobile'],action:async p=>{await expandMoreOptions(p);const parentsResponse=p.waitForResponse(response=>response.url().includes('?/parentGet')&&response.request().method()==='POST',{timeout:10000});await p.locator('#parent-page-button').click();await p.locator('#page-parent .page-parent-new-parents').waitFor({state:'visible'});const response=await parentsResponse;if(!response.ok())throw new Error(`parent lookup returned HTTP ${response.status()}`);await p.locator('#page-parent .page-parent-actions, #page-parent .buttons').first().waitFor({state:'visible'});await revealPagePane(p);await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}},
  {surface:'page.edit',state:'editor',viewports:['desktop','mobile'],action:async p=>{await expandMoreOptions(p);await revealPagePane(p);const edit=p.locator('#edit-button');await edit.scrollIntoViewIfNeeded();await edit.click();await p.locator('textarea').first().waitFor({state:'visible'});await revealPagePane(p)}},
  {surface:'page.rename',state:'confirm-pane',viewports:['desktop','mobile'],action:async p=>{await expandMoreOptions(p);await p.locator('#rename-move-button').click();const pane=p.locator('#page-move');await pane.waitFor({state:'visible'});await pane.locator('.buttons, .page-move-actions').first().waitFor({state:'visible'});await revealBelowFixedMobileNavigation(p,'.page-move-header')}},
  {surface:'page.delete',state:'confirm-pane',viewports:['desktop','mobile'],action:async p=>{await expandMoreOptions(p);await p.locator('#delete-button').click();const pane=p.locator('#page-delete');await pane.waitFor({state:'visible'});await pane.locator('.buttons, .page-delete-actions').first().waitFor({state:'visible'});await revealBelowFixedMobileNavigation(p,'.page-delete-header')}},
];
for(const variant of [
 {id:'no-rate',slug:'run-owned:theme-lab-visual-credit-no-rate-20260924'},
 {id:'heritage',slug:'run-owned:theme-lab-visual-credit-heritage-20260924'}
]){
 states.push(
  {surface:`credit.variant.${variant.id}`,state:'default',fixtureSlug:variant.slug,viewports:['desktop','mobile'],action:async p=>{await revealCreditControl(p)}},
  {surface:`credit.variant.${variant.id}`,state:'view',fixtureSlug:variant.slug,viewports:['desktop','mobile'],action:async p=>{const entry=p.locator('.creditButton a:visible').first();await entry.click();await p.waitForFunction(()=>location.hash==='#u-credit-view')}}
 );
}
states.push(
 {surface:'shell.login',state:'account-hover',viewports:['desktop'],action:async p=>{const wrapper=p.locator('#login-status');const status=await wrapper.isVisible()?wrapper:p.locator('#account-topbutton');await status.waitFor({state:'visible'});const box=await status.boundingBox();await status.hover({position:{x:Math.min(8,Math.max(1,box?.width??8)),y:Math.min(5,Math.max(1,box?.height??5))}});const menu=wrapper.locator('#account-options');if(await menu.count())await menu.waitFor({state:'visible'})}},
 {surface:'nav.desktop-top',state:'keyboard-focus',viewports:['desktop'],action:async p=>{await p.locator('#top-bar a').first().focus()}},
 {surface:'content.link',state:'hovered',viewports:['desktop','mobile'],action:async p=>{await movePointerToSafeArea(p);await settleFiniteVisualTransitions(p);const link=p.locator('a[href="#fixture-link"]');await link.scrollIntoViewIfNeeded();await link.hover();if(await p.evaluate(()=>innerWidth<=600))await revealBelowFixedMobileNavigation(p,'a[href="#fixture-link"]')}},
 {surface:'content.link',state:'focused',viewports:['desktop','mobile'],action:async p=>{const link=p.locator('a[href="#fixture-link"]');await link.scrollIntoViewIfNeeded();await link.focus();if(await p.evaluate(()=>innerWidth<=600))await revealBelowFixedMobileNavigation(p,'a[href="#fixture-link"]')}},
 {surface:'content.rating',state:'focused',viewports:['desktop','mobile'],action:async p=>{await p.locator('.page-rate-widget-box a').first().focus()}},
 {surface:'page.tags',state:'input-focused',viewports:['desktop','mobile'],action:async p=>{await p.locator('#tags-button').click();await revealPagePane(p);await p.locator('#action-area input[type="text"]').first().focus()}},
  {surface:'credit.view',state:'scrolled-bottom',viewports:['desktop','mobile'],action:async p=>{await openCreditView(p);await p.locator('#u-credit-view .modalbox:visible').last().evaluate(e=>e.scrollTop=e.scrollHeight)}},
  {surface:'credit.otherwise',state:'scrolled-bottom',viewports:['desktop','mobile','narrow-mobile'],action:async p=>{await openCreditOtherwise(p);const copy=p.locator('#u-credit-otherwise .modalbox .credit.otherwise');await copy.evaluate(e=>e.scrollTop=e.scrollHeight);await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}},
 {surface:'credit.otherwise',state:'back-control-click',viewports:['desktop','mobile','narrow-mobile'],action:async p=>{await p.locator('.creditButton a').first().click();await p.getByText('その他のライセンス',{exact:true}).first().click();await p.waitForFunction(()=>location.hash==='#u-credit-otherwise');const copy=p.locator('#u-credit-otherwise .modalbox .credit.otherwise');await copy.evaluate(e=>e.scrollTop=e.scrollHeight);const back=p.locator('#u-credit-otherwise .modalbox .credit-back a[href="#u-credit-view"]');if(await back.isVisible())await back.click();else await p.goBack();await p.waitForFunction(()=>location.hash==='#u-credit-view')}},
  {surface:'credit.otherwise',state:'back-to-view',viewports:['desktop','mobile'],action:async p=>{await openCreditOtherwise(p);await p.goBack();await p.waitForFunction(()=>location.hash==='#u-credit-view')}},
 {surface:'page.source',state:'closed',viewports:['desktop','mobile'],action:async p=>{await expandMoreOptions(p);await p.locator('#view-source-button').click();await p.locator('.page-source').waitFor();await revealPagePane(p);await p.locator('.action-area-close').click();await p.locator('.page-source').waitFor({state:'detached'})}},
 {surface:'page.history',state:'historical-source',action:async p=>{await p.locator('#history-button').click();await p.locator('.page-history tr[id^="revision-row-"] .optionstd a').filter({hasText:/^S$/u}).first().click();await p.locator('#history-subarea .page-source').waitFor();await revealPagePane(p)}}
);
states.push(
 {surface:'dialog.generic',state:'edit-permission-error',viewports:['desktop','mobile','narrow-mobile'],guest:true,action:async p=>{await expandMoreOptions(p);await p.locator('#edit-button').click();await p.locator('#odialog-container .owindow.error').waitFor({state:'visible'})}},
 {surface:'dialog.generic',state:'close-button',viewports:['desktop','mobile','narrow-mobile'],guest:true,action:async p=>{await expandMoreOptions(p);await p.locator('#edit-button').click();await p.locator('#odialog-container .owindow.error').waitFor({state:'visible'});await p.locator('.button-close-message').click();await p.locator('#odialog-container .owindow.error').waitFor({state:'detached'})}},
 {surface:'dialog.generic',state:'escape-close',viewports:['desktop','mobile','narrow-mobile'],guest:true,action:async p=>{await expandMoreOptions(p);await p.locator('#edit-button').click();await p.locator('#odialog-container .owindow.error').waitFor({state:'visible'});await p.keyboard.press('Escape');await p.locator('#odialog-container .owindow.error').waitFor({state:'detached'})}}
);
// Chromium owns the full interaction matrix. Cross-engine work is a stable
// core-state smoke contract; running every pane in every engine multiplies
// fixture navigation and timeout exposure without expanding the required
// compatibility evidence.
const crossEngineCoreStates=new Set(['page.normal|settled','credit.view|open','page.history|list','page.source|open','nav.sidebar|open','nav.sidebar|open-submenu','shell.interwiki|visible']);
if(migrationFixture)for(const spec of states){const action=sigma10CreditActions[`${spec.surface}.${spec.state}`];if(action)spec.action=action;}
const sigma10CreditActionsSha=crypto.createHash('sha256').update(await fs.readFile(new URL('../../src/sigma10-credit-actions.mjs',import.meta.url))).digest('hex');
let engineStates=engineArg==='chromium'?states:states.filter(spec=>crossEngineCoreStates.has(`${spec.surface}|${spec.state}`));
if(stateArgs){
 const knownStates=new Set(states.map(spec=>`${spec.surface}.${spec.state}`));
 for(const state of stateArgs){
  if(!state.trim())throw new Error('states must be non-empty');
  if(!knownStates.has(state))throw new Error(`unknown capture state: ${state}`);
 }
 // An explicit targeted request may exercise a state outside the routine
 // cross-engine core. Keep that state scoped to this capture; ordinary matrix
 // runs retain the smaller engine-specific contract.
 const requested=states.filter(spec=>stateArgs.has(`${spec.surface}.${spec.state}`)&&
  (spec.viewports??defaultInteractionViewports).includes(viewportArg));
 engineStates=[...new Map([...engineStates,...requested].map(spec=>[`${spec.surface}|${spec.state}`,spec])).values()];
}
// Reject invalid state selections before touching either runtime. Contract
// dumping opens no page and measures no runtime; only captures preflight the
// live Deepwell and served transport identities.
let preflightBackendRuntimeIdentity=null;
if(!process.argv.includes('--dump-contracts')){
 const hostBackendRuntime=readRunningDeepwellRuntimeIdentity(backendTarget.root,backendTarget.identityOptions);
 assertDeepwellRuntimeIdentity(expectedBackendRuntimeIdentity,hostBackendRuntime.identity,'current running Deepwell backend');
 const runtimePreflightHeaders=execFileSync('curl',['-ksSf','-D','-','-o','/dev/null','--max-time','5',`${origin}/run-owned%3Atheme-lab-visual-acceptance-imported-20260924`],{encoding:'utf8',timeout:10000});
 assertRuntimeSourceSha(expectedRuntimeSourceSha,parseCurlRuntimeResponseHeaders(runtimePreflightHeaders).runtimeSourceSha,`capture preflight response from ${origin}`);
 preflightBackendRuntimeIdentity=assertDeepwellRuntimeIdentity(expectedBackendRuntimeIdentity,parseCurlDeepwellRuntimeHeaders(runtimePreflightHeaders).backendRuntimeIdentity,`capture preflight response from ${origin}`);
}
observedBackendRuntimeIdentity=preflightBackendRuntimeIdentity;
let webkitProxyBlocked=0;let webkitProxy=null;
if(engineArg==='webkit'){
 // Playwright's WebKit request routing cancels SvelteKit's Vite module loads
 // even when the route matcher excludes the local origin. A loopback-only
 // rejecting proxy keeps localhost direct and refuses every public CONNECT
 // before the browser can send an external request.
 webkitProxy=http.createServer((_request,response)=>{webkitProxyBlocked++;response.writeHead(403);response.end()});
 webkitProxy.on('connect',(_request,socket)=>{webkitProxyBlocked++;socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')});
 await new Promise((resolve,reject)=>{webkitProxy.once('error',reject);webkitProxy.listen(0,'127.0.0.1',resolve)});
}
const engine=registry[engineArg];let browser=null;
const records=[];
let authenticatedStorage=null;let authBootstrapMs=0;let authBootstrapBlocked=0;let authBrowser=null;
try{
browser=await engine.launch({headless:true,...(webkitProxy?{proxy:{server:`http://127.0.0.1:${webkitProxy.address().port}`,bypass:'*.localhost,localhost,127.0.0.1'}}:{})});
if(!anonymousArg){const authStartedAt=performance.now();if(engineArg==='webkit')authBrowser=await chromium.launch({headless:true});const authContext=await (authBrowser??browser).newContext({ignoreHTTPSErrors:true});await authContext.route('**/*',async route=>{if(new URL(route.request().url()).origin===origin){await route.continue();return}authBootstrapBlocked++;await route.abort('blockedbyclient')});const authPage=await authContext.newPage();const authResponse=await authPage.goto(`${origin}/-/login`,{waitUntil:'domcontentloaded'});if(!authResponse)throw new Error('session bootstrap navigation returned no main-resource response');assertNavigationRuntimeIdentity(authResponse,`${origin}/-/login`,'session bootstrap navigation');await authPage.locator('.auth-name-or-email').fill(verificationAdminEmail);await authPage.locator('.auth-password').fill(verificationAdminPassword);await authPage.locator('#login button[type=submit]').click();await authPage.waitForFunction(()=>!document.querySelector('#login'),null,{timeout:15000});authenticatedStorage=await authContext.storageState();await authContext.close();if(authBrowser)await authBrowser.close();authBootstrapMs=Math.round(performance.now()-authStartedAt)}
const auditPath=process.env.THEME_LAB_INTERACTIVE_AUDIT_PATH
 ? path.resolve(process.env.THEME_LAB_INTERACTIVE_AUDIT_PATH)
 : runContract.audit_path
   ? resolveRunContractPath(runContract.audit_path,'interactive audit path')
   : path.join(portsDir,'interactive-visual-audit.json');
if(runContractArg&&(auditPath===path.join(portsDir,'interactive-visual-audit.json')||!auditPath.startsWith(runContractDir+path.sep)))throw new Error('custom run contract audit must stay below its contract directory and separate from accepted evidence');
await fs.mkdir(path.dirname(auditPath),{recursive:true});
const auditShardDir=process.env.THEME_LAB_AUDIT_SHARD_DIR
 ? path.resolve(process.env.THEME_LAB_AUDIT_SHARD_DIR)
 : null;
const auditSeedPath=process.env.THEME_LAB_AUDIT_SEED_PATH
 ? path.resolve(process.env.THEME_LAB_AUDIT_SEED_PATH)
 : null;
if(!auditShardDir&&auditSeedPath)throw new Error('THEME_LAB_AUDIT_SEED_PATH is only valid when writing an audit delta shard');
if(!auditShardDir&&!process.argv.includes('--dump-contracts')){
 const stat=await fs.stat(auditPath).catch(error=>error.code==='ENOENT'?null:Promise.reject(error));
 if(stat?.size>64*1024*1024)throw new Error(`refusing direct capture against a ${Math.round(stat.size/1024/1024)} MiB audit; use capture-theme-matrix.mjs so captures write delta shards and merge once per batch`);
}
const localInterwikiStubHtml='<!doctype html><html lang="ja"><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;min-width:0;min-height:1px}</style></head><body><div class="side-block" data-theme-lab-empty-interwiki-replay></div><div id="resizer-container"></div></body></html>';
async function fulfillInterwikiReplay(route,url){
 if(url.origin!==origin||!/^\/-\/wikidot-interwiki\/(?:interwikiFrame|styleFrame)\.html$/u.test(url.pathname))return false;
 const body=url.pathname.endsWith('/interwikiFrame.html')?localInterwikiStubHtml:'<!doctype html><html lang="ja"><head><meta charset="utf-8"></head><body></body></html>';
 await route.fulfill({status:200,contentType:'text/html; charset=utf-8',headers:{'cache-control':'no-store'},body});
 return true;
}
const runtimeSurfaceContracts=Object.fromEntries([...new Set(engineStates.map(spec=>spec.surface))].map(surface=>[surface,runtimeSurfaceContractSha(repoRoot,surface,viewportArg)]));
const applicabilityContract=states.map(spec=>{const applicable=spec.viewports??defaultInteractionViewports;const reason=spec.surface==='page.normal'?'Baseline appearance is required at all five defined form factors.':applicable.includes('narrow-mobile')?'This state exercises a phone-only interaction and the SCP-JP 320px boundary; the wide shell has a separate desktop state.':applicable.includes('mobile')&&applicable.includes('desktop')?'Detailed interaction is checked at canonical desktop and representative mobile; laptop/tablet use the normal-page baseline and controls explicitly scoped to their breakpoint.':applicable.includes('tablet')?'This is a breakpoint-specific desktop navigation state; other pointer states are covered at the canonical desktop width.':'This state belongs to the listed shell form factor; alternate form factors have a distinct state or normal-page baseline.';return{surface:spec.surface,state:spec.state,applicable_viewports:applicable,not_applicable_reason:reason}}).concat([{surface:'page.history',state:'comments-column-scroll',applicable_viewports:[],not_applicable_reason:'The retained Wikidot History evidence is an AMC fragment and does not establish whether mobile History scrolls or reflows; this layout remains unclassified.'}]);
const maintainedBrowserContract=JSON.parse(await fs.readFile(path.join(themeLabDir,'fixtures/browser-acceptance-states.json'),'utf8'));
if(JSON.stringify(applicabilityContract)!==JSON.stringify(maintainedBrowserContract.states))throw new Error('Browser state applicability differs from maintained acceptance contract');
function actionContractDependencies(spec){
 const actionSource=spec.action.toString();
 const retainsPointer=/(?:hover|pointerover|expanded)/iu.test(spec.state)||spec.surface==='nav.mobile-top';
 return{
  waitForSvelteClickHandler:actionSource.includes('waitForSvelteClickHandler'),
  revealPagePane:actionSource.includes('revealPagePane'),
  revealBelowFixedMobileNavigation:actionSource.includes('revealBelowFixedMobileNavigation')||actionSource.includes('revealCreditControl'),
  topFixedNavigationInset:actionSource.includes('revealPagePane')||actionSource.includes('revealBelowFixedMobileNavigation')||actionSource.includes('revealCreditControl'),
  expandMoreOptions:actionSource.includes('expandMoreOptions'),
  settleFiniteVisualTransitions:spec.surface.startsWith('nav.')||actionSource.includes('settleFiniteVisualTransitions'),
  movePointerToSafeArea:actionSource.includes('movePointerToSafeArea')||(!retainsPointer&&spec.surface!=='shell.footer-license'),
  visualDiagnostics:true
 };
}
function buildActionContract(spec){
 const retainPointer=/(?:hover|pointerover|expanded)/iu.test(spec.state)||spec.surface==='nav.mobile-top';
 const actionSource=spec.action.toString();
 const dependencies=actionContractDependencies(spec);
 const contract={
  action:{surface:spec.surface,state:spec.state,fixture:spec.fixtureSlug??null,guest:!!spec.guest,source:actionSource},
  expandMobileTopSubmenu:actionSource.includes('expandMobileTopSubmenu')?expandMobileTopSubmenu.toString():null,
  expandTabletTopNavigation:actionSource.includes('expandTabletTopNavigation')?expandTabletTopNavigation.toString():null,
  navigationActivation:actionSource.includes('expandMobileTopSubmenu')||actionSource.includes('expandTabletTopNavigation')?activateNavigationControl.toString():null,
  renderedSubmenuGeometry:actionSource.includes('expandMobileTopSubmenu')||actionSource.includes('expandTabletTopNavigation')?hasRenderedSubmenuGeometry.toString():null,
  waitForSvelteClickHandler:dependencies.waitForSvelteClickHandler?waitForSvelteClickHandler.toString():null,
  revealPagePane:dependencies.revealPagePane?revealPagePane.toString():null,
  revealBelowFixedMobileNavigation:dependencies.revealBelowFixedMobileNavigation?revealBelowFixedMobileNavigation.toString():null,
  expandMoreOptions:dependencies.expandMoreOptions?expandMoreOptions.toString():null,
  settleFiniteVisualTransitions:dependencies.settleFiniteVisualTransitions?settleFiniteVisualTransitions.toString():null,
  movePointerToSafeArea:dependencies.movePointerToSafeArea?movePointerToSafeArea.toString():null,
  parkPointer:retainPointer?null:spec.surface==='shell.footer-license'?'leave-pointer-unmoved-for-bottom-links':parkPointer.toString(),
  visualDiagnostics:visualDiagnostics.toString()
 };
 if(dependencies.topFixedNavigationInset)contract.topFixedNavigationInset=topFixedNavigationInset.toString();
 if(actionSource.includes('openSidebar')){contract.openSidebar=openSidebar.toString();contract.sidebarOccupiesViewport=sidebarOccupiesViewport.toString()}
 if(actionSource.includes('closeSidebar')){contract.closeSidebar=closeSidebar.toString();contract.sidebarIsClosed=sidebarIsClosed.toString();contract.sidebarOccupiesViewport=sidebarOccupiesViewport.toString()}
 if(actionSource.includes('exerciseHeaderSearch'))contract.exerciseHeaderSearch=exerciseHeaderSearch.toString();
 if(actionSource.includes('revealCreditControl'))contract.revealCreditControl=revealCreditControl.toString();
 if(actionSource.includes('openCreditView'))contract.openCreditView=openCreditView.toString();
 if(actionSource.includes('openCreditOtherwise'))contract.openCreditOtherwise=openCreditOtherwise.toString();
 if(migrationFixture&&sigma10CreditActions[`${spec.surface}.${spec.state}`])contract.sigma10CreditActions=sigma10CreditActionsSha;
 return contract;
}
function actionContractFor(spec,{legacy=false}={}){
 const contract=buildActionContract(spec);
 if(!legacy)delete contract.visualDiagnostics;
 return crypto.createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}
if(process.argv.includes('--dump-contracts')){console.log(JSON.stringify({schema:'scp_jp_interactive_capture_contracts.v2',browser_engine:engineArg,browser_version:browser.version(),run_contract_sha256:runContractSha,expected_runtime_source_sha256:expectedRuntimeSourceSha,expected_backend_runtime_identity:expectedBackendRuntimeIdentity,target_site:runContract.target_site,runtime_surface_contracts:runtimeSurfaceContracts,states:await Promise.all(states.map(async spec=>({surface:spec.surface,state:spec.state,fixture_slug:interactiveAcceptanceFixture(spec,migrationFixture),fixture_contract_sha256:await fixtureContractSha(spec),guest:!!spec.guest,applicable_viewports:spec.viewports??defaultInteractionViewports,action_contract_sha256:actionContractFor(spec),legacy_action_contract_sha256:actionContractFor(spec,{legacy:true}),legacy_action_contract_alternatives:legacyEquivalentContractHashes(buildActionContract(spec)),action_contract_dependencies:actionContractDependencies(spec)})))},null,2));await browser.close();if(authBrowser)await authBrowser.close();process.exit(0)}
async function mapLimit(items,limit,mapper){let next=0;const workers=Array.from({length:Math.min(limit,items.length)},(_,workerIndex)=>async()=>{while(true){const index=next++;if(index>=items.length)return;await mapper(items[index],index,workerIndex)}});await Promise.all(workers.map(worker=>worker()))}
let initialAuditDocument={};
try{
 if(auditSeedPath)initialAuditDocument=JSON.parse(await fs.readFile(auditSeedPath,'utf8'));
 else if(!auditShardDir)initialAuditDocument=JSON.parse(await fs.readFile(auditPath,'utf8'));
}catch(error){if(error.code!=='ENOENT')throw error}
const priorRows=initialAuditDocument.records??[];
const priorRowsByKey=new Map(priorRows.map(row=>[`${row.theme}|${row.browser_engine}|${row.viewport}|${row.surface}|${row.state}`,row]));
const priorRowsByTheme=new Map();
const priorRowsByScope=new Map();
for(const row of priorRows){
 const byTheme=priorRowsByTheme.get(row.theme)??[];byTheme.push(row);priorRowsByTheme.set(row.theme,byTheme);
 const scope=`${row.theme}|${row.browser_engine}|${row.viewport}`;
 const rows=priorRowsByScope.get(scope)??[];rows.push(row);priorRowsByScope.set(scope,rows);
}
const priorReviewRows=[...priorRows];
const priorReviewRowsByTheme=new Map();
for(const row of priorReviewRows){const rows=priorReviewRowsByTheme.get(row.theme)??[];rows.push(row);priorReviewRowsByTheme.set(row.theme,rows)}
const rowKey=row=>`${row.theme}|${row.browser_engine}|${row.viewport}|${row.surface}|${row.state}`;
async function writeAuditShard(batch,theme,directory){
 const reviewReuseCount=applyExactVisualReviewReuseToRows(batch,await verifyExactReviewSources(priorReviewRowsByTheme.get(theme)??[],batch,portsDir));
 const validStates=new Set(
  engineStates
   .filter(spec=>(spec.viewports??defaultInteractionViewports).includes(viewportArg))
   .map(spec=>`${spec.surface}|${spec.state}`)
 );
 const removeKeys=new Set(batch.map(rowKey));
 if(!stateArgs){
  for(const row of priorRowsByScope.get(`${theme}|${engineArg}|${viewportArg}`)??[]){
   if(!validStates.has(`${row.surface}|${row.state}`))removeKeys.add(rowKey(row));
  }
 }
 const shard={
  schema:'theme_lab_interactive_audit_delta.v1',
  theme,engine:engineArg,viewport:viewportArg,
  remove_keys:[...removeKeys],
  records:batch.map(compactAuditRecord),
  visual_review_reuse_updates:reviewReuseCount,
  document_patch:{
   schema:'scp_jp_interactive_visual_audit.v1',fixture_url:base,viewport:viewports[viewportArg],
   auth_bootstrap_blocked:authBootstrapBlocked,
   engine_scope:{chromium:'full interaction state inventory',firefox:'core states: normal page, credit view, History list, Source, and mobile sidebar open/expanded',webkit:'core states: normal page, credit view, History list, Source, and mobile sidebar open/expanded; Safari compatibility proxy, not Safari'},
   state_applicability:applicabilityContract
  }
 };
 await writeInteractiveAuditDelta(directory,shard);
 return {reviewReuseCount,auditLockWaitMs:0};
}
async function persistBatch(batch,theme){
 if(auditShardDir)return writeAuditShard(batch,theme,auditShardDir);
 const directShardDir=await fs.mkdtemp(path.join(os.tmpdir(),'theme-lab-direct-audit-shard-'));
 try{
  const result=await writeAuditShard(batch,theme,directShardDir);
  await mergeInteractiveAuditShards({auditPath,shardDirectory:directShardDir,portsDir});
  return result;
 }finally{await fs.rm(directShardDir,{recursive:true,force:true})}
}
 const localAssetPathCache=new Map();const fileShaCache=new Map();const dataUrlCache=new Map();
 for(const theme of themes){
 const themeRecords=[];
  const dir=themeDirectory(theme);const cssPath=resolveExistingPackageFile(dir,'candidate.css',`${theme}: candidate CSS`);
  // Mobile and narrow-mobile source search behaviour is measured by a sibling receipt (search-controls-20261022);
  // the 20261001 receipt covers desktop, laptop and tablet only. The sibling is used only for those viewports and only when present.
  const mobileSearchAuthorityPath=`evidence/search-controls-20261022/${theme}.json`;
  let useMobileSearchAuthority=false;
  if(!migrationFixture&&['mobile','narrow-mobile'].includes(viewportArg)){try{resolveExistingContainedFile(themeLabDir,mobileSearchAuthorityPath,`${theme}: mobile search source authority`);useMobileSearchAuthority=true}catch(error){if(error.code!=='ENOENT')throw error}}
  const searchAuthorityPath=useMobileSearchAuthority?mobileSearchAuthorityPath:migrationFixture?'evidence/sigma10-baseline-search-controls-20261002/receipt.json':`evidence/search-controls-20261001/${theme}.json`;
  let searchAuthorityBytes=null;try{searchAuthorityBytes=await fs.readFile(resolveExistingContainedFile(themeLabDir,searchAuthorityPath,`${theme}: search source authority`))}catch(error){if(error.code!=='ENOENT')throw error}
  const searchSourceAuthority=searchAuthorityBytes?{path:searchAuthorityPath,sha256:crypto.createHash('sha256').update(searchAuthorityBytes).digest('hex')}:null;
  const candidateStructure=await loadCandidateStructure(dir);
  let css;try{css=await fs.readFile(cssPath,'utf8')}catch(error){throw new Error(`cannot read candidate.css for ${theme}`,{cause:error})}
  let baseCss='';try{baseCss=await fs.readFile(resolveExistingPackageFile(dir,'candidate-base.css',`${theme}: candidate base CSS`),'utf8')}catch(error){if(error.code!=='ENOENT')throw error}
  const runtimeSupportCss=await fs.readFile(resolveExistingPackageFile(packageDir,'runtime-asset-replay.css','interactive runtime asset replay CSS'),'utf8');
  const baseCssSha=baseCss?crypto.createHash('sha256').update(baseCss).digest('hex'):null;
  // Preserve the historical CSS-only identity for ordinary candidates. Themes
  // with an additional frozen base stylesheet bind both inputs into the key.
  // This avoids invalidating every pre-base capture merely because the key
  // representation changed, while still invalidating the Site base replay.
  const knownThemeIdentities=new Set((priorRowsByTheme.get(theme)??[]).map(row=>row.candidate_sha256));
  const {candidateSha}=candidateIdentity(css,baseCss,knownThemeIdentities);
  const readOptionalPackageFile=async name=>{try{return await fs.readFile(resolveExistingPackageFile(dir,name,`${theme}: ${name}`))}catch(error){if(error.code==='ENOENT')return null;throw error}};
  const candidateSourceBytes=await readOptionalPackageFile('candidate.wikidot.source.txt')??await readOptionalPackageFile('candidate.wikidot.txt')??Buffer.alloc(0);
  const candidateSourceSha=crypto.createHash('sha256').update(candidateSourceBytes).digest('hex');
  const expectedIdentity=runContract.additional_candidates?.[theme];
  if(currentCampaign&&(!expectedIdentity||expectedIdentity.candidate_sha256!==candidateSha||expectedIdentity.source_sha256!==candidateSourceSha))throw new Error(`${theme}: candidate identity differs from the frozen Sigma-10 campaign contract`);
  const localAssetPath=async name=>{const cacheKey=`${theme}\0${name}`;if(localAssetPathCache.has(cacheKey))return localAssetPathCache.get(cacheKey);let resolved=null;for(const candidate of [path.join(portsDir,'shared-replay-assets',name),path.join(dir,'page-assets',name)]){try{await fs.access(candidate);resolved=candidate;break}catch{}}localAssetPathCache.set(cacheKey,resolved);return resolved};
  const assetState=candidateAssetDependencyState({portsDir,themeDir:dir,runtimeSupportCss,baselineCss:baselineReplacementCss,baseCss,candidateCss:css,candidateSource:candidateSourceBytes,localAssetPathCache,fileShaCache});
  const referencedAssetNames=new Set(assetState.referenced_asset_names),assetDependencies=assetState.asset_dependencies,assetDependencySha=assetState.asset_dependency_sha256;
  const assetMimeType=ext=>({'.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.woff':'font/woff','.woff2':'font/woff2','.ttf':'font/ttf','.otf':'font/otf','.eot':'application/vnd.ms-fontobject'})[ext.toLowerCase()]??'application/octet-stream';
  const dataUrlFor=async file=>{if(dataUrlCache.has(file))return dataUrlCache.get(file);const value=`data:${assetMimeType(path.extname(file))};base64,${(await fs.readFile(file)).toString('base64')}`;dataUrlCache.set(file,value);return value};
  const applicable=engineStates.filter(spec=>(spec.viewports??defaultInteractionViewports).includes(viewportArg)&&(!stateArgs||stateArgs.has(`${spec.surface}.${spec.state}`)));
  const preflight=new Map();
  for(const spec of applicable){
   const key=`${theme}|${engineArg}|${viewportArg}|${spec.surface}|${spec.state}`;const old=priorRowsByKey.get(key);const fixtureSha=await fixtureContractSha(spec);const stateActionContract=actionContractFor(spec);const scopedContractSha=scopedRunContractSha(runContract,{theme,viewport:viewportArg,browser_engine:engineArg});const environmentInputs={fixtureSha,site:runContract.target_site,transportOrigin:origin,baselineTheme:runContract.baseline_theme,browserEngine:engineArg,browserVersion:browser.version(),viewportName:viewportArg,viewportSize:viewports[viewportArg],assetDependencySha,runtimeSourceSha:expectedRuntimeSourceSha,backendRuntimeIdentitySha:expectedBackendRuntimeIdentity.identity_sha256,...(candidateStructure?{candidate_structure_sha256:candidateStructure.sha256}:{})};const environmentContractSha=crypto.createHash('sha256').update(JSON.stringify({scopedContractSha,...environmentInputs})).digest('hex');const legacyEnvironmentSha=crypto.createHash('sha256').update(JSON.stringify({runContractSha,...environmentInputs})).digest('hex');let reusable=false;
   const expectedGateClass=visualGatePolicyRow({browser_engine:engineArg,viewport:viewportArg,surface:spec.surface,state:spec.state})?.class;
   if(!forceCapture&&old&&old.runtime_source_sha256===expectedRuntimeSourceSha&&old.backend_runtime_identity?.identity_sha256===expectedBackendRuntimeIdentity.identity_sha256&&old.candidate_sha256===candidateSha&&old.candidate_source_sha256===candidateSourceSha&&old.asset_dependency_sha256===assetDependencySha&&old.fixture_contract_sha256===fixtureSha&&captureRunContractIsCurrent(old,runContract,runContractSha)&&(old.environment_contract_sha256===environmentContractSha||old.run_contract_sha256===runContractSha&&old.environment_contract_sha256===legacyEnvironmentSha)&&(old.action_contract_observation?.mode!=='source-hidden-submit'||JSON.stringify(old.action_contract_observation.source_authority)===JSON.stringify(searchSourceAuthority))&&old.capture_state_action_contract_sha256===(old.capture_action_model==='theme_lab_action_contract.v3'?stateActionContract:legacyEquivalentContractHashes(buildActionContract(spec)).find(hash=>hash===old.capture_state_action_contract_sha256))&&old.runtime_surface_contract_sha256===runtimeSurfaceContracts[spec.surface]&&old.browser_version===browser.version()&&old.session_state===(anonymousArg||spec.guest?'logged_out':'administrator')&&old.visual_gate?.policy_sha256===VISUAL_GATE_POLICY_SHA256&&old.visual_gate?.class===expectedGateClass&&(!visualGateNeedsScreenshot(old)||old.screenshot&&!old.failure)&&!old.failure&&old.external_requests_sent===0&&Array.isArray(old.asset_failures)&&old.asset_failures.length===0&&Array.isArray(old.page_errors)&&old.page_errors.length===0&&!old.unconfirmed_items?.some(x=>x.startsWith('action/capture failed'))){try{if(!old.screenshot)reusable=true;else{const oldBytes=await fs.readFile(path.join(portsDir,old.screenshot));reusable=crypto.createHash('sha256').update(oldBytes).digest('hex')===old.screenshot_sha256}}catch{}}
   preflight.set(`${spec.surface}|${spec.state}`,{old,reusable,fixtureSha,stateActionContract,environmentContractSha,scopedContractSha});
  }
  const freshStates=applicable.filter(spec=>!preflight.get(`${spec.surface}|${spec.state}`).reusable);
  if(freshStates.length===0){for(const spec of applicable){const old=preflight.get(`${spec.surface}|${spec.state}`).old;records.push(old);themeRecords.push(old)}console.log(JSON.stringify({progress:`${themes.indexOf(theme)+1}/${themes.length}`,theme,records:themeRecords.length,captured:themeRecords.filter(r=>r.screenshot).length,reused:themeRecords.length,failed_actions:0,asset_setup:'skipped-all-states-reused',audit_write:'skipped-no-changes'}));continue}
  const externalPageAssetData=new Map();
  if(engineArg==='webkit')for(const manifestName of ['assets.json','page-assets.json']){
   let manifest;try{manifest=JSON.parse(await fs.readFile(resolveExistingPackageFile(dir,manifestName,`${theme}: ${manifestName}`),'utf8'))}catch(error){if(error.code==='ENOENT')continue;throw error}
   for(const item of manifest.assets??[]){const name=item.asset_file??`${item.sha256}${path.extname(item.original_url??item.filename??'')||'.bin'}`;const file=await localAssetPath(name);if(!file)continue;const value=await dataUrlFor(file);for(const url of [item.original_url,item.final_url,item.acquired_from,...(item.source_urls??[])])if(url){try{externalPageAssetData.set(new URL(url).href,value)}catch{}}}
  }
  let browserCss=css;let browserBaseCss=baseCss;let browserBaselineCss=baselineReplacementCss;let browserSupportCss=runtimeSupportCss;const assetRequests=[];
  if(engineArg==='webkit'){
   for(const name of referencedAssetNames){if(name.endsWith('.css'))continue;const file=await localAssetPath(name);if(!file)continue;const value=await dataUrlFor(file);const escaped=name.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&');const expression=new RegExp(`url\\((\\s*)(["']?)/?${escaped}\\2(\\s*)\\)`,'giu');browserCss=browserCss.replace(expression,`url("${value}")`);browserBaseCss=browserBaseCss.replace(expression,`url("${value}")`);browserBaselineCss=browserBaselineCss.replace(expression,`url("${value}")`);browserSupportCss=browserSupportCss.replace(expression,`url("${value}")`);assetRequests.push({name,status:'embedded-local'})}
  }
  const context=await browser.newContext({viewport:viewports[viewportArg],ignoreHTTPSErrors:true,...(authenticatedStorage?{storageState:authenticatedStorage}:{})});
  if(engineArg==='webkit')await context.route('**/-/wikidot-interwiki/*.html*',async route=>{if(!await fulfillInterwikiReplay(route,new URL(route.request().url())))await route.continue()});
  if(engineArg==='webkit')await context.route(/\/[0-9a-f]{64}\.[a-z0-9]+(?:[?#]|$)/iu,async route=>{const name=decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1)??'');const file=await localAssetPath(name);if(!file){assetRequests.push({name,status:'missing'});await route.abort('blockedbyclient');return}assetRequests.push({name,status:'replayed-local'});await route.fulfill({path:file,contentType:assetMimeType(path.extname(name))})});
  let externalCount=0;if(engineArg!=='webkit'){await context.route('**/*',async route=>{const url=new URL(route.request().url());if(await fulfillInterwikiReplay(route,url))return;if(url.origin!==origin){externalCount++;await route.abort('blockedbyclient');return}const name=decodeURIComponent(url.pathname.split('/').at(-1)??'');if(/^[0-9a-f]{64}\.[a-z0-9]+$/iu.test(name)){const assetPath=await localAssetPath(name);if(assetPath){assetRequests.push({name,status:'replayed-local'});await route.fulfill({path:assetPath,contentType:assetMimeType(path.extname(name))});return}assetRequests.push({name,status:'missing'})}await route.continue()})}
  // Reuse one browser page per capture worker in Chromium/Firefox. WebKit is
  // intentionally fresh-page-per-state: measured reuse can race a late
  // SvelteKit navigation with the next page.goto(), while fresh pages remove
  // that failure and are also faster at the tested 6-way concurrency.
  const reuseWorkerPages=engineArg!=='webkit';
  const workerPages=new Map();const guestWorkerPages=new Map();let guestContextPromise=null;let pagesCreated=0;
  const installActionTrace=async page=>{page.setDefaultTimeout(5000);page.setDefaultNavigationTimeout(12000);await page.addInitScript(()=>{window.__themeLabActionTrace=[];const record=event=>{const target=event.target instanceof Element?event.target:null;if(!target)return;const label=(target.innerText||target.getAttribute('aria-label')||target.getAttribute('value')||'').trim().replace(/\s+/gu,' ').slice(0,96);window.__themeLabActionTrace.push({type:event.type,target:target.id?`#${target.id}`:target.tagName.toLowerCase()+(target.classList.length?'.'+[...target.classList].slice(0,3).join('.'):''),label})};for(const type of ['click','focusin','input','change','pointerover','mouseover','pointerdown'])document.addEventListener(type,record,true);document.addEventListener('scroll',event=>{const target=event.target instanceof Element?event.target:null;if(target)window.__themeLabActionTrace.push({type:'scroll',target:target.id?`#${target.id}`:target.className?.toString?.().split(' ')[0]||target.tagName.toLowerCase()})},true)})};
  const guestContext=async()=>{if(!guestContextPromise)guestContextPromise=(async()=>{const value=await browser.newContext({viewport:viewports[viewportArg],ignoreHTTPSErrors:true});await value.route('**/*',async route=>{const url=new URL(route.request().url());if(await fulfillInterwikiReplay(route,url))return;if(url.origin!==origin){externalCount++;await route.abort('blockedbyclient');return}const name=decodeURIComponent(url.pathname.split('/').at(-1)??'');if(/^[0-9a-f]{64}\.[a-z0-9]+$/iu.test(name)){const assetPath=await localAssetPath(name);if(assetPath){assetRequests.push({name,status:'replayed-local'});await route.fulfill({path:assetPath,contentType:assetMimeType(path.extname(name))});return}assetRequests.push({name,status:'missing'});}await route.continue()});return value})();return guestContextPromise};
  const workerPage=async(workerIndex,guest)=>{const pool=guest?guestWorkerPages:workerPages;if(reuseWorkerPages){const existing=pool.get(workerIndex);if(existing&&!existing.isClosed())return existing}const pageContext=guest?await guestContext():context;const page=await pageContext.newPage();await installActionTrace(page);if(reuseWorkerPages)pool.set(workerIndex,page);pagesCreated++;return page};
  
  const captureState=async(spec,_index,workerIndex)=>{
   const {old,reusable,fixtureSha,stateActionContract,environmentContractSha,scopedContractSha}=preflight.get(`${spec.surface}|${spec.state}`);
   if(reusable){records.push(old);themeRecords.push(old);return}
    // Migration shell and base-credit states exercise Sigma-10's saved page
    // markup. Keep explicitly named variant fixtures separate: those are
    // historical diagnostics, not substitutes for the current credit source.
    const effectiveFixtureSlug=interactiveAcceptanceFixture(spec,migrationFixture);
   const externalBefore=engineArg==='webkit'?webkitProxyBlocked:externalCount;const page=await workerPage(workerIndex,!!spec.guest);page.__themeLabSearchSourceAuthority=searchSourceAuthority;const stateStartedAt=performance.now();const phaseDurations={navigation:0,hydration:0,action:0,visual_settle:0,paint_and_capture:0};const errors=[];const pageErrorHandler=e=>errors.push(e.message);page.on('pageerror',pageErrorHandler);
   let shot=null,actionError=null,settledAnimationsFinished=0,baselineThemeHref=null,runtimeSourceSha=null,backendRuntimeIdentity=null,recordEnvironmentContractSha=null;const runtimeIdentityFailures=[];const actionResponses=[];const runtimeEnvironmentInputs=(sourceSha,backendIdentitySha)=>({fixtureSha,site:runContract.target_site,transportOrigin:origin,baselineTheme:runContract.baseline_theme,browserEngine:engineArg,browserVersion:browser.version(),viewportName:viewportArg,viewportSize:viewports[viewportArg],assetDependencySha,runtimeSourceSha:sourceSha,backendRuntimeIdentitySha:backendIdentitySha,...(candidateStructure?{candidate_structure_sha256:candidateStructure.sha256}:{})});const runtimeEnvironmentContract=(sourceSha,backendIdentitySha)=>crypto.createHash('sha256').update(JSON.stringify({scopedContractSha,...runtimeEnvironmentInputs(sourceSha,backendIdentitySha)})).digest('hex');const responseHandler=async response=>{if(response.request().isNavigationRequest()&&isThemeLabFixtureNavigationUrl(response.url(),origin)){try{const measured=assertNavigationRuntimeIdentity(response,response.url(),`browser fixture navigation ${response.url()}`);runtimeSourceSha=measured.runtime;backendRuntimeIdentity=measured.backend}catch(error){runtimeIdentityFailures.push(error.message)}}if(response.url().includes('?/revisionDiff')){let body='';try{body=await response.text()}catch{}let type='unknown',errorMessage=null;try{const envelope=JSON.parse(body);type=envelope.type??type;if(type==='failure'){const detail=JSON.parse(envelope.data);errorMessage=Array.isArray(detail)?detail[1]??null:null}}catch{}actionResponses.push({status:response.status(),type,error_message:errorMessage})}};page.on('response',responseHandler);
   try{
    const fixtureUrl=`${origin}/${encodeURIComponent(effectiveFixtureSlug)}`;
    let phaseStartedAt=performance.now();await page.goto('about:blank');const navigationIdentity=await gotoFixture(page,fixtureUrl);runtimeSourceSha=navigationIdentity.runtime;backendRuntimeIdentity=navigationIdentity.backend;recordEnvironmentContractSha=runtimeEnvironmentContract(runtimeSourceSha,backendRuntimeIdentity.identity_sha256);if(recordEnvironmentContractSha!==environmentContractSha)throw new Error('measured runtime environment contract differs from capture preflight');if(candidateStructure)await page.locator('#page-content').evaluate((element,html)=>element.insertAdjacentHTML('afterbegin',html),candidateStructure.html);phaseDurations.navigation=Math.round(performance.now()-phaseStartedAt);if(migrationFixture)await injectMigrationShell(page,migrationFixture);if(navigationFixture){await page.waitForFunction(()=>{const e=document.querySelector('#history-button');return e&&Object.getOwnPropertySymbols(e).some(s=>s.description==='events'&&typeof e[s]?.click==='function')},null,{timeout:15000});await page.locator('#top-bar').evaluate((e,html)=>{e.innerHTML=html},navigationFixture)}if(headerFixture)await page.locator('#header').evaluate((e,html)=>{const t=document.createElement('template');t.innerHTML=html;for(const tag of ['h1','h2'])e.querySelector(tag).replaceWith(t.content.querySelector(tag).cloneNode(true))},headerFixture);if(sidebarFixture)await page.locator('#side-bar').evaluate((e,html)=>{e.innerHTML=html},sidebarFixture);if(interwikiFixture)await page.locator('#side-bar').evaluate((e,html)=>{e.querySelectorAll('.scpnet-interwiki-wrapper').forEach(node=>node.remove());e.insertAdjacentHTML('beforeend',html)},interwikiFixture);if(engineArg==='webkit'&&externalPageAssetData.size){const imageResults=await page.evaluate(async mappings=>{const lookup=new Map(mappings);const results=[];for(const image of document.images){let source;try{source=new URL(image.currentSrc||image.src,location.href).href}catch{continue}if(new URL(source).origin===location.origin)continue;const data=lookup.get(source);if(!data)continue;image.src=data;try{await image.decode();results.push({source,status:'embedded-local'})}catch{results.push({source,status:'decode-failed'})}}return results},[...externalPageAssetData]);assetRequests.push(...imageResults.map(result=>({name:result.source,status:result.status})))}baselineThemeHref=await page.locator(`link[rel="stylesheet"][href="${runtimeBaselineStylesheetHref}"]`).getAttribute('href').catch(()=>null);if(!baselineThemeHref)throw new Error(`runtime base-theme stylesheet differs from the acceptance contract (${runContract.baseline_theme.name})`);if(baselineReplacementCss)await page.locator('link[rel="stylesheet"][href="'+runtimeBaselineStylesheetHref+'"]').evaluate(link=>{link.disabled=true;link.media='not all'});const styleNonce=await page.locator('script[nonce],style[nonce]').first().getAttribute('nonce').catch(()=>null);await page.evaluate(({css,nonce})=>{if(document.querySelector('[data-theme-lab-acceptance-styles]'))throw new Error('acceptance CSS already applied');const style=document.createElement('style');style.setAttribute('data-theme-lab-acceptance-styles','');if(nonce)style.nonce=nonce;style.textContent=css;document.head.append(style)},{css:dedupeCssLayers([browserSupportCss,browserBaselineCss,browserBaseCss,browserCss,savedComponentCss]).join('\n'),nonce:styleNonce});
    // Only states that exercise Svelte-owned controls need the delegated
    // click-handler barrier. Static/anchor/CSS states are server-rendered and
    // can proceed after DOMContentLoaded + candidate CSS injection; forcing
    // them to wait for an unrelated History button made high-concurrency runs
    // contend on hydration and erased most of the parallel speedup.
    phaseStartedAt=performance.now();if(requiresSvelteHydration(spec))await waitForSvelteClickHandler(page,'#history-button');else await page.locator('#page-content').waitFor({state:'attached'});phaseDurations.hydration=Math.round(performance.now()-phaseStartedAt);
    // The acceptance harness injects theme CSS after load, which starts finite
    // CSS transitions (font-size/left/...) that never run when a real page
    // loads its CSS first. Finish them before the action so scroll-into-view
    // and anchor jumps measure the settled layout (setup, not action contract).
    await settleFiniteMeasurementTransitions(page).catch(()=>null);
    // W13/G2-43: the source-owned acceptance structure is inserted into
    // #page-content during navigation, but under WebKit the node is gone by
    // action time (the page-content region is re-rendered after insertion;
    // Chromium/Firefox settle before it). Re-assert the structure here when
    // its root element was wiped, so source-owned controls (e.g.
    // monotypical's sidebar toggle) exist for the action in every engine.
    if(candidateStructure)await page.evaluate(html=>{
     const rootId=html.match(/<\w+[^>]*\bid="([^"]+)"/u)?.[1]??null;
     if(rootId&&!document.getElementById(rootId))document.querySelector('#page-content')?.insertAdjacentHTML('afterbegin',html);
    },candidateStructure.html);
    phaseStartedAt=performance.now();await spec.action(page);if(runtimeIdentityFailures.length)throw new Error(runtimeIdentityFailures[0]);if(shouldParkPointer(spec))await parkPointer(page,viewports[viewportArg]);phaseDurations.action=Math.round(performance.now()-phaseStartedAt);
    // Hash/DOM assertions can become true before theme CSS transitions settle.
    phaseStartedAt=performance.now();settledAnimationsFinished=spec.surface.startsWith('nav.')?await settleFiniteVisualTransitions(page):0;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));phaseDurations.visual_settle=Math.round(performance.now()-phaseStartedAt);
    phaseDurations.paint_and_capture=Math.round(performance.now()-phaseStartedAt);
   }catch(error){
    actionError=error.message;
    // Preserve the actual failed/partially-open interaction state. A missing
    // screenshot made previous failures impossible to visually diagnose.
    try{
     await page.waitForTimeout(200);
     const stateKey=`${spec.surface.replaceAll('.','-')}-${spec.state}-${viewportArg}-failed`;
     const screenshotBytes=await page.screenshot({fullPage:false,animations:'disabled'});
     shot=await storeContentAddressedScreenshot({portsDir,theme,engine:engineArg,viewport:viewportArg,stateKey,bytes:screenshotBytes,artifactNamespace});
    }catch{}
   }
   if(runtimeIdentityFailures.length)actionError??=runtimeIdentityFailures[0];
   if(runtimeSourceSha)recordEnvironmentContractSha=runtimeEnvironmentContract(runtimeSourceSha,backendRuntimeIdentity?.identity_sha256);
   const actionSequence=await page.evaluate(()=>window.__themeLabActionTrace??[]).catch(()=>[]);const actionContractObservation=await page.evaluate(()=>window.__themeLabActionContractObservation??null).catch(()=>null);const measurementTransitionsSettled=await settleFiniteMeasurementTransitions(page).catch(()=>null);const diagnostics=await visualDiagnostics(page,spec.surface).catch(()=>null);
   const titleCompositionMeasurement=await page.evaluate(measureTitleComposition).catch(()=>null);
   const titleTextMeasurement=titleCompositionMeasurement?.overlaps.some(item=>item.effectively_visible)?await page.evaluate(measureTitleTextIntersections,titleCompositionMeasurement.overlaps).catch(()=>null):null;
   let baselineDocumentContainmentMeasurement=null;
   const candidateViewport=diagnostics?.viewport;const candidateDocumentWidth=candidateViewport?.document_width??candidateViewport?.documentWidth;const candidateViewportWidth=candidateViewport?.client_width??candidateViewport?.width;
   if(!actionError&&Number.isFinite(candidateDocumentWidth)&&Number.isFinite(candidateViewportWidth)&&candidateDocumentWidth>candidateViewportWidth+1){
    const targetBaselineCss=dedupeCssLayers([browserSupportCss,browserBaselineCss,savedComponentCss]).join('\n');
    baselineDocumentContainmentMeasurement=await measureBaselineDocumentContainment(page,{styleSelector:'style[data-theme-lab-acceptance-styles]',baselineCss:targetBaselineCss}).catch(()=>null);
   }
   if(!actionError&&actionResponses.some(response=>response.type==='failure'||response.status>=400||response.error_message))actionError='action response reported failure';
   const diagnosticsContractSha=crypto.createHash('sha256').update(visualDiagnostics.toString()).digest('hex');
   const record={theme,...(candidateStructure?{candidate_structure_sha256:candidateStructure.sha256}:{}),session_state:anonymousArg||spec.guest?'logged_out':'administrator',target_site:runContract.target_site.slug,transport_origin:origin,locale:runContract.target_site.locale,baseline_theme:runContract.baseline_theme.name,baseline_theme_css_href:baselineReplacementPath?runContract.baseline_theme.replacement_css_path:baselineThemeHref,baseline_theme_css_sha256:baselineReplacementSha,runtime_baseline_theme_css_href:baselineThemeHref,baseline_theme_mode:baselineReplacementCss?'replacement':'runtime',browser_engine:engineArg,browser_version:browser.version(),viewport:viewportArg,viewport_size:viewports[viewportArg],surface:spec.surface,state:spec.state,fixture:effectiveFixtureSlug??'run-owned:theme-lab-visual-acceptance-imported-20260924',candidate_source_sha256:candidateSourceSha,base_css_path:baseCss?'candidate-base.css':null,base_css_sha256:baseCssSha,asset_dependency_sha256:assetDependencySha,asset_dependencies:assetDependencies,fixture_contract_sha256:fixtureSha,run_contract_sha256:runContractSha,scoped_run_contract_sha256:scopedContractSha,scoped_authority_contract_sha256:scopedRunContractSha(runContractWithoutRuntimeBindings(runContract),{theme,viewport:viewportArg,browser_engine:engineArg}),environment_contract_sha256:recordEnvironmentContractSha,runtime_source_sha256:runtimeSourceSha,backend_runtime_identity:backendRuntimeIdentity,backend_runtime_identity_sha256:backendRuntimeIdentity?.identity_sha256??null,capture_state_action_contract_sha256:stateActionContract,settled_animations_finished:settledAnimationsFinished,runtime_surface_contract_sha256:runtimeSurfaceContracts[spec.surface],duration_ms:Math.round(performance.now()-stateStartedAt),phase_durations_ms:phaseDurations,action_sequence:actionSequence,action_contract_observation:actionContractObservation,screenshot:null,screenshot_sha256:null,candidate_sha256:candidateSha,visual_diagnostics:diagnostics,visual_diagnostics_contract_sha256:diagnosticsContractSha,classification:'UNCONFIRMED',visual_findings:[],intentional_differences:[],unconfirmed_items:actionError?[`action/capture failed: ${actionError}`]:[],reviewed_after_last_change:false,external_requests_sent:0,external_requests_blocked:(engineArg==='webkit'?webkitProxyBlocked:externalCount)-externalBefore,asset_failures:assetRequests.filter(x=>['missing','decode-failed'].includes(x.status)),page_errors:errors,action_responses:actionResponses};
   const policy=visualGatePolicyRow(record);
   const previousIdentity=visualGateIdentityRiskSnapshot(old,{currentScopedAuthoritySha:record.scoped_authority_contract_sha256,legacyComparableScopedShas:legacyComparableScopedShas(runContract,{theme,viewport:viewportArg,browser_engine:engineArg},scopedRunContractSha)});
   const hasPriorCapture=!!old;
   record.visual_gate={policy_sha256:VISUAL_GATE_POLICY_SHA256,class:policy?.class??null,risk_triggers:[],risk_assessment:{scope:'same-theme-surface-state-engine-viewport',identity_comparison_schema:'theme_lab_visual_risk_identity.v3',previous_capture_found:hasPriorCapture,...previousIdentity,global_runtime_drift:visualGateGlobalRuntimeDrift(previousIdentity,record,{hasPriorCapture})}};
   if(policy?.class==='C'){
    record.visual_gate.risk_triggers.push(...visualGateIdentityRiskTriggers(previousIdentity,record,{hasPriorCapture}));
    const measured=buildVisualGateAssertion(record),interaction=await collectVisualGateInteraction(page,record).catch(()=>null);
    record.state_machine_assertion={...measured,...(interaction??{}),diagnostics_contract_sha256:diagnosticsContractSha};
    const assertion=record.state_machine_assertion;
    const nativeCreditDisclosure=sigma10CreditDisclosureSelector(record,policy.key);
    const nativeCreditModal=policy.key==='credit.view.open'?'#u-credit-view .modalbox':'#u-credit-otherwise .modalbox';
    const nativeModalVisible=nativeCreditDisclosure&&assertion.measured?.some(item=>item.selector===nativeCreditModal&&item.observation?.visibility==='visible'&&item.observation?.display!=='none'&&item.observation?.rect?.width>0&&item.observation?.rect?.height>0);
    const nativeDisclosureOpen=nativeCreditDisclosure&&assertion.native_disclosure_selector===nativeCreditDisclosure&&assertion.native_disclosure_open===true;
    const creditStateMismatch=nativeCreditDisclosure?(!nativeDisclosureOpen||!nativeModalVisible||assertion.location_hash!==''):
     policy.key==='credit.view.open'&&assertion.location_hash!=='#u-credit-view'||
     policy.key==='credit.otherwise.open'&&assertion.location_hash!=='#u-credit-otherwise';
    const interactionMismatch=!interaction||assertion.visible_target_count<1||/focus/u.test(policy.key)&&!assertion.focused||/hovered/u.test(policy.key)&&!assertion.hovered||policy.key==='content.tabview.second-tab-selected'&&!assertion.selected||creditStateMismatch;
    if(interactionMismatch)record.visual_gate.risk_triggers.push('missing-or-divergent-state-assertion');
    const documentScrollableTarget=policy.key==='shell.footer-license.scrolled-bottom'||policy.key==='credit.default.normal'||policy.key==='page.history.list'||policy.key==='page.files.list';
    const allowedHorizontalScroll=policy.key==='page.files.horizontal-actions'||policy.key==='page.files.list'&&interaction?.horizontal_scroller_targets?.some(item=>item.contained);
    const boundsMismatch=documentScrollableTarget?!interaction?.document_contained&&!allowedHorizontalScroll:!interaction?.geometry_within_viewport&&!allowedHorizontalScroll;
    if(boundsMismatch)record.visual_gate.risk_triggers.push('state-target-outside-allowed-bounds');
    if(record.state_machine_assertion.title_overlap_count>0)record.visual_gate.risk_triggers.push('measured-title-overlap');
    const measuredWidth=record.visual_diagnostics?.viewport?.document_width??record.visual_diagnostics?.viewport?.documentWidth;
    const measuredViewport=record.visual_diagnostics?.viewport?.client_width??record.visual_diagnostics?.viewport?.width;
    const baselineWidth=baselineDocumentContainmentMeasurement?.document_width;
    if(Number.isFinite(measuredWidth)&&Number.isFinite(measuredViewport)&&measuredWidth>measuredViewport+1&&(!Number.isFinite(baselineWidth)||measuredWidth>baselineWidth+1))record.visual_gate.risk_triggers.push('unexpected-document-overflow');
    if(record.state_machine_assertion.visible_target_count<1)record.unconfirmed_items.push('state-specific machine assertion has no visible target');
   }
   if(policy?.class==='M'&&!actionError)record.functional_assertion={schema:'theme_lab_functional_assertion.v1',policy_sha256:VISUAL_GATE_POLICY_SHA256,key:policy.key,action_contract_sha256:stateActionContract,action_completed:true,action_sequence_count:actionSequence.length,candidate_sha256:candidateSha,candidate_source_sha256:candidateSourceSha,asset_dependency_sha256:assetDependencySha,runtime_source_sha256:runtimeSourceSha,backend_runtime_identity_sha256:backendRuntimeIdentity?.identity_sha256??null,run_contract_sha256:runContractSha,browser_engine:engineArg,browser_version:browser.version(),viewport:viewportArg};
   record.title_composition_measurement=titleCompositionMeasurement;record.title_composition_contract_sha256=crypto.createHash('sha256').update(measureTitleComposition.toString()).digest('hex');if(titleTextMeasurement){record.title_text_measurement=titleTextMeasurement;record.title_text_contract_sha256=crypto.createHash('sha256').update(measureTitleTextIntersections.toString()).digest('hex')}
   // A visible title-text intersection promotes conditional-review rows only.
   // M rows remain machine-only on success by the canonical 145-state policy.
   if(policy?.class==='C'&&visualGateTitleCompositionNeedsImage(record)&&!record.visual_gate.risk_triggers.includes('visible-title-composition'))record.visual_gate.risk_triggers.push('visible-title-composition');
   const wantsScreenshot=visualGateNeedsScreenshot(record,{failure:!!actionError});
   if(wantsScreenshot&&!shot){const stateKey=`${spec.surface.replaceAll('.','-')}-${spec.state}-${viewportArg}`;const screenshotBytes=await page.screenshot({fullPage:false,animations:'disabled'});shot=await storeContentAddressedScreenshot({portsDir,theme,engine:engineArg,viewport:viewportArg,stateKey,bytes:screenshotBytes,artifactNamespace})}
   if(shot){record.screenshot=shot.path;record.screenshot_sha256=shot.sha256;if(!record.unconfirmed_items.includes('screenshot captured but awaiting image review')&&wantsScreenshot)record.unconfirmed_items.push('screenshot captured but awaiting image review')}
   record.measurement_transitions_settled=measurementTransitionsSettled;record.decision_authority='SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY';record.port_conclusion_eligible=false;
   if(baselineDocumentContainmentMeasurement){record.baseline_document_containment_measurement=baselineDocumentContainmentMeasurement;record.baseline_document_containment_contract_sha256=BASELINE_DOCUMENT_CONTAINMENT_CONTRACT_SHA256}
   record.capture_action_model='theme_lab_action_contract.v3';
   if(actionError)record.failure=actionError;
   records.push(record);themeRecords.push(record);
   page.off('pageerror',pageErrorHandler);page.off('response',responseHandler);if(reuseWorkerPages)await page.goto('about:blank').catch(()=>{});if(!reuseWorkerPages)await page.close();
  };
  await mapLimit(applicable,concurrencyArg,captureState);
  await context.close();if(guestContextPromise)await (await guestContextPromise).close();
  // Cached rows are an unlocked startup snapshot. Only newly captured rows
  // may replace the latest audit; a concurrent reviewer owns cached rows.
  const freshKeys=new Set(freshStates.map(spec=>`${spec.surface}|${spec.state}`));
  const {reviewReuseCount,auditLockWaitMs}=await persistBatch(themeRecords.filter(row=>freshKeys.has(`${row.surface}|${row.state}`)),theme);console.log(JSON.stringify({progress:`${themes.indexOf(theme)+1}/${themes.length}`,theme,records:themeRecords.length,captured:themeRecords.filter(r=>r.screenshot).length,review_reused:reviewReuseCount,audit_lock_wait_ms:auditLockWaitMs,failed_actions:themeRecords.filter(r=>r.unconfirmed_items?.some(x=>x.startsWith('action/capture failed'))).length,pages_created:pagesCreated}));
 }
}finally{await browser?.close();if(authBrowser)await authBrowser.close();if(webkitProxy){webkitProxy.closeAllConnections();await new Promise(resolve=>webkitProxy.close(resolve))}}
console.log(JSON.stringify({engine:engineArg,viewport:viewportArg,themes:themes.length,records:records.length,captured:records.filter(r=>r.screenshot).length,unconfirmed:records.filter(r=>r.classification==='UNCONFIRMED').length,blocked_external:records.reduce((n,r)=>n+(r.external_requests_blocked??0),0),asset_failures:records.reduce((n,r)=>n+(r.asset_failures?.length??0),0),auth_bootstrap_ms:authBootstrapMs,auth_external_blocked:authBootstrapBlocked,concurrency:concurrencyArg}));
