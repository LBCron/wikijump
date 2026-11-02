#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {candidateIdentity} from '../ports/scripts/candidate-identity.mjs';
import {assertPublishablePackage} from '../src/adaptation-authority.mjs';
import {validatePublicationCandidateSet} from '../src/publication-candidate-freeze.mjs';
import {validateSigmaPreviewFinding} from './preview-authority.mjs';
import {loadHistoricalSigma10RunContract} from './historical-run-contract.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
if(process.argv.slice(2).some(arg=>arg!=='--historical-only')){
 console.log(JSON.stringify({command:'sigma10-migration-check',result:'INVALID COMMAND',failures:['Use --historical-only to inspect archived evidence, or no option for current campaign completion.']},null,2));
 process.exit(64);
}
const historicalOnly=process.argv.includes('--historical-only');
if(!historicalOnly){
 const {checkCampaignCompletion}=await import('../src/campaign-completion.mjs');
 const themeLabRoot=path.resolve(root,'..');
 const sigma10Contract=JSON.parse(await fs.readFile(path.join(root,'current-campaign/run-contract.json'),'utf8'));
 const publicationFailures=validatePublicationCandidateSet(themeLabRoot,{expectedCandidateSetSha256:sigma10Contract.candidate_set_sha256,contract:sigma10Contract,label:'Sigma-10 publication candidate set'});
 const result=checkCampaignCompletion(themeLabRoot);
 const failures=[...new Set([...(result.failures??[]),...publicationFailures])];
 const status=publicationFailures.length?'fail':result.status;
 console.log(JSON.stringify({command:'current-campaign-completion',result:status==='pass'?'CURRENT CAMPAIGN ACCEPTED':'CURRENT CAMPAIGN NOT ACCEPTED',overall_acceptance:{status},...result,status,failures,publication_candidate_set:{candidate_set_sha256:sigma10Contract.candidate_set_sha256,status:publicationFailures.length?'fail':'pass',failures:publicationFailures}},null,2));
 process.exit(status==='pass'?0:status==='inconclusive'?2:1);
}
const ports=path.resolve(root,'../ports');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=[];
const authorityLedger=JSON.parse(await fs.readFile(path.join(ports,'adaptation-authority.json'),'utf8'));
const read=async file=>JSON.parse(await fs.readFile(path.join(root,file),'utf8'));
const [audit,comparison,manifest,historicalContract,findings,campaign]=await Promise.all([
 read('evidence/interactive-visual-audit.json'),read('evidence/sigma9-comparison-audit.json'),read('fixture-manifest.json'),loadHistoricalSigma10RunContract(),read('findings.json'),
 JSON.parse(await fs.readFile(path.join(ports,'en-theme-campaign.json'),'utf8'))
]);
const {contract,sha256:contractSha}=historicalContract;
const candidates=['dear-dictator',...campaign.themes.map(x=>x.slug.replace(/^theme:/u,'')),'sigma10-baseline'];
if(candidates.length!==36||new Set(candidates).size!==36)fail.push('candidate inventory is not exactly 36 unique candidates');
const normal=audit.records.filter(r=>r.surface==='page.normal'&&r.state==='settled');
const cells=new Map(normal.map(r=>[`${r.theme}|${r.browser_engine}|${r.viewport}`,r]));
const matrix=[['chromium','desktop'],['chromium','laptop'],['chromium','tablet'],['chromium','mobile'],['chromium','narrow-mobile'],['firefox','desktop'],['firefox','mobile'],['webkit','desktop'],['webkit','mobile']];
for(const candidate of candidates)for(const [engine,viewport] of matrix)if(!cells.has(`${candidate}|${engine}|${viewport}`))fail.push(`missing page.normal cell ${candidate}/${engine}/${viewport}`);
const comparisonRows=comparison.records.filter(r=>r.surface==='page.normal'&&r.state==='settled');
const comparisonCells=new Map(comparisonRows.map(r=>[`${r.theme}|${r.browser_engine}|${r.viewport}`,r]));
for(const candidate of candidates)for(const [engine,viewport] of matrix)if(!comparisonCells.has(`${candidate}|${engine}|${viewport}`))fail.push(`missing Sigma-9 comparison cell ${candidate}/${engine}/${viewport}`);
const manifestSha=sha(await fs.readFile(path.join(root,'fixture-manifest.json')));
const fixturePackage=path.resolve(ports,'interactive-visual-fixture');
const themeFixtureHash=async row=>{
 const variant=row.fixture?.endsWith('credit-no-rate-20260924')?'fixture-no-rate.wikidot.txt':row.fixture?.endsWith('credit-heritage-20260924')?'fixture-heritage.wikidot.txt':null;
 const names=[variant??(row.surface==='page.history'?'history-fixture.wikidot.txt':'fixture.wikidot.txt'),'nav-top.wikidot.txt','nav-side.wikidot.txt','nav-interwiki.wikidot.txt'];
 if(row.surface==='page.backlinks')names.push('backlink-fixture.wikidot.txt');
 const h=crypto.createHash('sha256').update('theme-lab-fixture-state.v2\0');
 for(const name of [...new Set(names)].sort()){h.update(name);h.update('\0');h.update(sha(await fs.readFile(path.join(fixturePackage,name))))}
 h.update(manifestSha);
 for(const slug of [contract.migration_fixture.main_slug,contract.migration_fixture.top_slug,contract.migration_fixture.side_slug]){
  const fixture=manifest.fixtures.find(x=>x.slug===slug);
  if(!fixture)throw new Error(`migration fixture missing from manifest: ${slug}`);
  const bytes=await fs.readFile(path.join(root,fixture.file));
  if(sha(bytes)!==fixture.sha256)fail.push(`fixture hash mismatch: ${slug}`);
  h.update(slug);h.update('\0');h.update(sha(bytes));
 }
 return h.digest('hex');
};
const seenShots=new Set();
const localAcceptanceOnly=row=>row?.decision_authority==='SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY'&&row?.port_conclusion_eligible===false&&row?.finding_scope==='SCP_JP_TARGET_ACCEPTANCE';
for(const [label,document] of [['Sigma-10',audit],['Sigma-9 control',comparison]]){
 const policy=document.decision_authority_policy;
 if(policy?.schema!=='theme_lab_decision_authority.v1'||policy.decision_authority!=='SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY'||policy.port_conclusion_eligible!==false||policy.finding_scope!=='SCP_JP_TARGET_ACCEPTANCE')fail.push(`missing local-only authority policy in ${label} audit`);
}
for(const [label,records] of [['Sigma-10',audit.records],['Sigma-9 control',comparison.records]]) for(const r of records){
 if(!r.migration_review||r.migration_review.screenshot_sha256!==r.screenshot_sha256)fail.push(`missing/stale direct visual review in ${label} ${r.theme}/${r.browser_engine}/${r.viewport}/${r.surface}.${r.state}`);
 if(!localAcceptanceOnly(r)||!localAcceptanceOnly(r.migration_review))fail.push(`non-local or unscoped decision authority in ${label} ${r.theme}/${r.surface}.${r.state}`);
 if(r.visual_review&&(!localAcceptanceOnly(r.visual_review)))fail.push(`non-local or unscoped visual review authority in ${label} ${r.theme}/${r.surface}.${r.state}`);
 if(!['PASS_NATURAL','PASS_INTENTIONAL_DIVERGENCE','NEEDS_FIX','EXTERNAL_CONTRACT_UNVERIFIABLE','NOT_APPLICABLE'].includes(r.migration_review?.classification))fail.push(`invalid reviewed classification in ${label} ${r.theme}/${r.surface}.${r.state}`);
 if(r.unconfirmed_items?.length)fail.push(`unexplained unconfirmed item in ${label} ${r.theme}/${r.surface}.${r.state}: ${r.unconfirmed_items.join('; ')}`);
 if(r.external_requests_sent!==0)fail.push(`external request sent in ${label} ${r.theme}/${r.surface}.${r.state}`);
 if(r.asset_failures?.length||r.page_errors?.length)fail.push(`runtime failure in ${label} ${r.theme}/${r.surface}.${r.state}`);
 if(!r.screenshot||!r.screenshot_sha256)fail.push(`screenshot missing in ${label} ${r.theme}/${r.surface}.${r.state}`);
 else if(!seenShots.has(`${r.screenshot}|${r.screenshot_sha256}`)){
  seenShots.add(`${r.screenshot}|${r.screenshot_sha256}`);
  try{if(sha(await fs.readFile(path.join(ports,r.screenshot)))!==r.screenshot_sha256)fail.push(`screenshot hash mismatch: ${r.screenshot}`)}catch{fail.push(`screenshot not found: ${r.screenshot}`)}
 }
}
for(const r of audit.records){
 if(r.target_site!==contract.target_site.slug)fail.push(`wrong target site in ${r.theme}/${r.surface}.${r.state}`);
 if(r.run_contract_sha256!==contractSha)fail.push(`stale run contract in ${r.theme}/${r.surface}.${r.state}`);
 if(r.fixture_contract_sha256!==await themeFixtureHash(r))fail.push(`stale fixture contract in ${r.theme}/${r.surface}.${r.state}`);
 if(r.asset_failures?.length)fail.push(`asset failure in ${r.theme}/${r.surface}.${r.state}`);
 if(r.page_errors?.length)fail.push(`page error in ${r.theme}/${r.surface}.${r.state}`);
 if(r.unconfirmed_items?.some(x=>x.startsWith('action/capture failed')))fail.push(`action failed in ${r.theme}/${r.surface}.${r.state}`);
 if(!r.screenshot||!r.screenshot_sha256)fail.push(`screenshot missing in ${r.theme}/${r.surface}.${r.state}`);
 else if(!seenShots.has(`${r.screenshot}|${r.screenshot_sha256}`)){
  seenShots.add(`${r.screenshot}|${r.screenshot_sha256}`);
  try{if(sha(await fs.readFile(path.join(ports,r.screenshot)))!==r.screenshot_sha256)fail.push(`screenshot hash mismatch: ${r.screenshot}`)}catch{fail.push(`screenshot not found: ${r.screenshot}`)}
 }
 if(r.classification==='UNCONFIRMED')fail.push(`unclassified evidence ${r.theme}/${r.browser_engine}/${r.viewport}/${r.surface}.${r.state}`);
 if(!['PASS_NATURAL','PASS_INTENTIONAL_DIVERGENCE','NEEDS_FIX','EXTERNAL_CONTRACT_UNVERIFIABLE','NOT_APPLICABLE'].includes(r.classification))fail.push(`invalid classification ${r.theme}/${r.surface}.${r.state}: ${r.classification}`);
 const themeDir=r.theme==='sigma10-baseline'?path.join(root,'baseline-probe'):path.join(ports,r.theme);
 try{
  const archived=authorityLedger.packages[r.theme]?.historical_candidate;
  if(r.theme!=='sigma10-baseline'&&!archived)throw new Error('historical candidate identity missing');
  const css=await fs.readFile(path.join(themeDir,archived?.css??'candidate.css'));
  const base=archived?.base?await fs.readFile(path.join(themeDir,archived.base)):r.theme==='sigma10-baseline'?await fs.readFile(path.join(themeDir,'candidate-base.css')).catch(()=>Buffer.alloc(0)):Buffer.alloc(0);
  const source=await fs.readFile(path.join(themeDir,archived?.source??'candidate.wikidot.source.txt')).catch(()=>fs.readFile(path.join(themeDir,'candidate.wikidot.txt')));
  if(archived)for(const [key,hash] of Object.entries(archived.hashes))if(sha(await fs.readFile(path.join(themeDir,archived[key])))!==hash)fail.push(`corrupt historical candidate ${r.theme}/${key}`);
  const current=candidateIdentity(css,base,new Set([r.candidate_sha256]));
  if(current.candidateSha!==r.candidate_sha256||sha(source)!==r.candidate_source_sha256)fail.push(`unbound historical candidate ${r.theme}/${r.surface}.${r.state}`);
 }catch{fail.push(`candidate files missing for ${r.theme}`)}
}
const previewFinding=(findings.findings??[]).find(f=>f.id==='SIGMA10-MOB-001');
try{validateSigmaPreviewFinding(previewFinding,root)}catch(error){fail.push(error.message)}
const report=await fs.readFile(path.join(root,'REPORT.md'),'utf8');
if(previewFinding?.classification==='UNVERIFIED_PREVIEW_HYPOTHESIS'&&/Resolve `SIGMA10-MOB-001`.*before migration|Promotion remains contingent on the Technical Staff credit-rule change/iu.test(report))fail.push('report promotes an unverified preview hypothesis to a migration prerequisite');
for(const name of Object.keys(authorityLedger.packages))try{assertPublishablePackage(name,{checkOutputs:true,verifyAuthorityEvidence:process.env.THEME_LAB_AUTHORITY_EVIDENCE_VERIFIED!=='1'})}catch(error){fail.push(error.message)}
for(const f of findings.findings??[])if(f.blocker===true&&!String(f.owner??'').trim())fail.push(`ownerless blocker ${f.id}`);
for(const f of findings.findings??[])if(f.actionable===true&&!String(f.classification??'').trim())fail.push(`unclassified actionable finding ${f.id}`);
if(findings.decision_authority_policy?.schema!=='theme_lab_decision_authority.v1'||findings.decision_authority_policy.decision_authority!=='SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY'||findings.decision_authority_policy.port_conclusion_eligible!==false)fail.push('findings document lacks local-only decision-authority policy');
for(const f of findings.findings??[])if(!localAcceptanceOnly(f))fail.push(`finding lacks local-only authority: ${f.id}`);
const searchTargetRows=audit.records.filter(r=>r.surface==='shell.search'&&r.state==='typed-focused');
if(searchTargetRows.length!==3)fail.push(`expected 3 desktop/laptop/tablet local search target rows, got ${searchTargetRows.length}`);
for(const r of searchTargetRows){
 if(r.classification!=='PASS_INTENTIONAL_DIVERGENCE')fail.push(`local search target row is not intentionally classified: ${r.browser_engine}/${r.viewport}`);
 if(r.migration_review?.owner!=null)fail.push(`local search target row incorrectly has an owner: ${r.browser_engine}/${r.viewport}`);
 if(r.migration_review?.confirmed_finding_ids?.length)fail.push(`local search target row incorrectly references a migration finding: ${r.browser_engine}/${r.viewport}`);
 if(r.action_contract_observation?.control!=='#search-top-box-input'||r.action_contract_observation?.display!=='none'||!r.action_sequence?.some(action=>action.type==='target-hidden-search-control'))fail.push(`local search target observation changed: ${r.browser_engine}/${r.viewport}`);
 const searchDisposition=r.migration_review?.intentional_difference??'';
 if(!searchDisposition.includes('does not establish the Wikidot source contract')||/expected\s+(?:Wikidot\s+)?parity|(?:Wikidot\s+)?parity\s+(?:requires|confirms|certifies)/iu.test(searchDisposition))fail.push(`local search target row lacks a no-parity disposition: ${r.browser_engine}/${r.viewport}`);
}
const expectedCoverage=findings.coverage?.current_records;
if(expectedCoverage!=null&&expectedCoverage!==audit.records.length)fail.push(`findings current record count ${expectedCoverage} != audit ${audit.records.length}`);
if(findings.coverage?.comparison_records!=null&&findings.coverage.comparison_records!==comparison.records.length)fail.push(`findings comparison count ${findings.coverage.comparison_records} != audit ${comparison.records.length}`);
if(findings.fixture_manifest_sha256&&findings.fixture_manifest_sha256!==manifestSha)fail.push('findings fixture manifest hash is stale');
const {execFileSync}=await import('node:child_process');
const gitRoot=path.resolve(root,'../../../../');
const touched=execFileSync('git',['diff','--name-only','HEAD','--','install/local/theme-lab/ports/interactive-visual-audit.json'],{cwd:gitRoot,encoding:'utf8'});
if(touched.trim())fail.push('accepted Sigma-9 audit was modified / normal campaign evidence was contaminated');
if(fail.length){console.error(JSON.stringify({result:'FINAL-ZERO FAIL',failures:fail.length,details:fail.slice(0,100)},null,2));process.exitCode=1}
else console.log(JSON.stringify({result:'HISTORICAL AND SOURCE EVIDENCE VERIFIED',evidence_integrity:{status:'pass'},overall_acceptance:{status:'inconclusive',reason:'Historical local migration screenshots do not accept authority-cleaned candidates or an unverified Wikidot preview hypothesis'},sigma10_preview_authority:previewFinding.classification,candidates:candidates.length,page_normal_cells:candidates.length*matrix.length,current_records:audit.records.length,superseded_records:audit.superseded_history?.record_count??audit.superseded_records?.length??0,unique_screenshots:seenShots.size,fixture_manifest_sha256:manifestSha,run_contract_sha256:contractSha},null,2));
