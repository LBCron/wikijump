#!/usr/bin/env node
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {mergeInteractiveAuditShards} from '../scripts/audit-shard-merge.mjs';
import {validateVisualGateRecord,visualGateNeedsScreenshot} from '../../src/visual-gate.mjs';
import {assertDeepwellRuntimeIdentity,deepwellRuntimeIdentityMatchesContract,parseCurlDeepwellRuntimeHeaders,requireDeepwellRuntimeIdentity} from '../../src/deepwell-runtime-identity.mjs';
import {assertRuntimeSourceSha,parseCurlRuntimeResponseHeaders,requireRuntimeSourceSha} from '../../src/runtime-source-identity.mjs';

const scriptDir=path.dirname(fileURLToPath(import.meta.url));
const portsDir=path.resolve(scriptDir,'..');
const themeLabDir=path.resolve(portsDir,'..');
const captureScript=path.join(scriptDir,'capture-interactive.mjs');
const ensureBuiltScript=path.join(scriptDir,'ensure-built-framerail.mjs');
const themeArg=process.argv.find(value=>value.startsWith('--theme='))?.slice(8);
const themesArg=process.argv.find(value=>value.startsWith('--themes='))?.slice(9);
const stateArg=process.argv.find(value=>value.startsWith('--state='))?.slice(8);
const runContractArg=process.argv.find(value=>value.startsWith('--run-contract='))?.slice(15);
const engineArg=process.argv.find(value=>value.startsWith('--engine='))?.slice(9);
const viewportArg=process.argv.find(value=>value.startsWith('--viewport='))?.slice(11);
// Current full-workload captures were stable at two browser jobs and three
// sessions per child. The older 120-row benchmark's 7/6 setting caused
// browser/context closes on the current workload.
const jobsArg=Number(process.argv.find(value=>value.startsWith('--jobs='))?.slice(7)??2);
const captureConcurrencyArg=Number(process.argv.find(value=>value.startsWith('--capture-concurrency='))?.slice(22)??3);
const transportArg=process.argv.find(value=>value.startsWith('--transport='))?.slice(12)??'built';
const runtimeRepoArg=process.argv.find(value=>value.startsWith('--runtime-repo='))?.slice(15);
const backendProjectArg=process.argv.find(value=>value.startsWith('--backend-project='))?.slice(18);
const transportOriginArg=process.argv.find(value=>value.startsWith('--transport-origin='))?.slice(19)??null;
const force=process.argv.includes('--force');
const anonymous=process.argv.includes('--anonymous');
const seenOptions=new Set();
for(const argument of process.argv.slice(2)){
 const name=argument.split('=')[0];
 if(seenOptions.has(name))throw new Error(`duplicate option: ${name}`);
 seenOptions.add(name);
}
const accepted=new Set(['--force','--anonymous','--help']);
for(const arg of process.argv.slice(2)){if(accepted.has(arg)||/^--(?:theme|themes|state|engine|viewport|jobs|capture-concurrency|transport|transport-origin|run-contract|runtime-repo|backend-project)=/u.test(arg))continue;throw new Error(`unknown argument: ${arg}`)}
if(process.argv.includes('--help')){console.log('Usage: capture-theme-matrix.mjs (--theme=slug|--themes=a,b) [--state=surface.state,...] [--engine=chromium|firefox|webkit] [--viewport=desktop|laptop|tablet|mobile|narrow-mobile] [--jobs=1..9] [--capture-concurrency=1..8] [--transport=built|dev] [--transport-origin=https://HOST:PORT] [--run-contract=/path/to/contract.json] [--runtime-repo=/abs/checkout --backend-project=wikijump-theme-lab-NAME] [--anonymous] [--force]');console.log('--transport-origin uses an existing task-owned transport without bootstrapping, then probes the fixture runtime-source header against the run contract; it must use the target Wikijump hostname over HTTPS.');console.log('--anonymous only captures states that work without the authenticated administrator; admin-only states (page.edit, page.rename, page.delete) fail closed. Pass --state for a public subset.');process.exit(0)}
if((!themeArg&&!themesArg)||(themeArg&&themesArg))throw new Error('exactly one of --theme or --themes is required');
if(!Number.isInteger(jobsArg)||jobsArg<1||jobsArg>9)throw new Error('--jobs must be an integer from 1 to 9');
if(!Number.isInteger(captureConcurrencyArg)||captureConcurrencyArg<1||captureConcurrencyArg>8)throw new Error('--capture-concurrency must be an integer from 1 to 8');
if(!['built','dev'].includes(transportArg))throw new Error('--transport must be built or dev');
if(transportOriginArg!==null){
 let parsed;try{parsed=new URL(transportOriginArg)}catch{throw new Error('--transport-origin must be an absolute HTTPS URL')}
 if(parsed.protocol!=='https:'||parsed.hostname!=='scpaiueouiuiuiui.wikijump.localhost'||parsed.username||parsed.password||parsed.pathname!=='/'||parsed.search||parsed.hash)throw new Error('--transport-origin must be an HTTPS origin for scpaiueouiuiuiui.wikijump.localhost');
}
const themes=themeArg?[themeArg]:themesArg.split(',');
if(themes.some(theme=>!theme.trim())||new Set(themes).size!==themes.length)throw new Error('themes must be non-empty and unique');
if(stateArg!==undefined&&stateArg.split(',').some(state=>!state.trim()))throw new Error('states must be non-empty');
const manifest=JSON.parse(await fs.readFile(path.join(portsDir,'en-theme-campaign.json'),'utf8'));
const registered=new Set(['dear-dictator',...manifest.themes.map(theme=>theme.slug.replace(/^theme:/u,''))]);
const runContractPath=runContractArg?path.resolve(runContractArg):null;
const runContract=runContractPath?JSON.parse(await fs.readFile(runContractPath,'utf8')):null;
for(const name of Object.keys(runContract?.additional_candidates??{})){
 if(!/^[a-z0-9-]+$/u.test(name)||registered.has(name)&&runContract?.schema!=='scp_jp_sigma10_migration_run.v1')throw new Error(`invalid or colliding additional candidate: ${name}`);
 registered.add(name);
}
if(runContract&&!runContract.artifact_namespace?.split('/').every(segment=>/^[a-z0-9-]+$/u.test(segment)))throw new Error('custom run contract needs a valid isolated artifact namespace');
if(themes.some(theme=>!registered.has(theme)))throw new Error('requested theme is not registered in the campaign or run contract');
const fullMatrix=[
 ['chromium','desktop'],['chromium','laptop'],['chromium','tablet'],['chromium','mobile'],['chromium','narrow-mobile'],
 ['firefox','desktop'],['firefox','mobile'],['webkit','desktop'],['webkit','mobile']
];
const matrix=fullMatrix.filter(([engine,viewport])=>(!engineArg||engine===engineArg)&&(!viewportArg||viewport===viewportArg));
if(engineArg&&!['chromium','firefox','webkit'].includes(engineArg))throw new Error('--engine must be chromium, firefox, or webkit');
if(viewportArg&&!['desktop','laptop','tablet','mobile','narrow-mobile'].includes(viewportArg))throw new Error('--viewport must be desktop, laptop, tablet, mobile, or narrow-mobile');
if(!matrix.length)throw new Error('requested engine and viewport have no matrix cell');
const auditPath=process.env.THEME_LAB_INTERACTIVE_AUDIT_PATH
 ? path.resolve(process.env.THEME_LAB_INTERACTIVE_AUDIT_PATH)
 : runContract?.audit_path
   ? path.resolve(path.dirname(runContractPath),runContract.audit_path)
   : path.join(portsDir,'interactive-visual-audit.json');
await fs.mkdir(path.dirname(auditPath),{recursive:true});
if(runContract?.audit_path&&auditPath!==themeLabDir&&!auditPath.startsWith(themeLabDir+path.sep))throw new Error('interactive audit path escapes Theme Lab');
if(runContract&&(auditPath===path.join(portsDir,'interactive-visual-audit.json')||!auditPath.startsWith(path.dirname(runContractPath)+path.sep)))throw new Error('custom run contract audit must stay below its contract directory and separate from accepted evidence');
if(anonymous&&!stateArg)process.stderr.write('warning: --anonymous cannot capture states that require the authenticated administrator (page.edit, page.rename, page.delete); targeted retries cannot fix them, so pass --state for a public subset or run authenticated\n');

const children=new Set();
let interrupted=null;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{
 interrupted=new Error(`matrix interrupted by ${signal}`);
 for(const child of children)child.kill(signal);
});

function run(command,args,{capture=false,env=process.env}={}){
 return new Promise((resolve,reject)=>{
  if(interrupted){reject(interrupted);return}
  const child=spawn(command,args,{stdio:capture?['ignore','pipe','pipe']:'inherit',env});
  children.add(child);
  child.once('close',()=>children.delete(child));
  let stdout='',stderr='';
  if(!capture){child.stderr?.on('data',chunk=>stderr+=chunk)}
  if(child.stdout)child.stdout.on('data',chunk=>stdout+=chunk);
  if(child.stderr)child.stderr.on('data',chunk=>stderr+=chunk);
  child.once('error',reject);
  child.once('close',code=>code===0?resolve({stdout,stderr}):reject(new Error(`${path.basename(command)} exited ${code}: ${stderr.slice(-4000)}`)));
 });
}

let transportOrigin=null;
const runtimeContract=runContract??JSON.parse(await fs.readFile(path.join(scriptDir,'acceptance-run-contract.json'),'utf8'));
const expectedRuntimeSourceSha=requireRuntimeSourceSha(runtimeContract.expected_runtime_source_sha256,'matrix run contract');
const expectedBackendRuntimeIdentity=requireDeepwellRuntimeIdentity(runtimeContract.expected_backend_runtime_identity,'matrix run contract');
if(transportArg==='built'&&!transportOriginArg){
 const ensured=await run(process.execPath,[ensureBuiltScript,`--run-contract=${runContractPath??path.join(scriptDir,'acceptance-run-contract.json')}`],{capture:true});
 const line=ensured.stdout.trim().split('\n').at(-1);
 const ensuredRuntime=JSON.parse(line);
 assertRuntimeSourceSha(expectedRuntimeSourceSha,ensuredRuntime.source_sha256,'ensure-built-framerail result');
 assertDeepwellRuntimeIdentity(expectedBackendRuntimeIdentity,ensuredRuntime.backend_runtime_identity,'ensure-built-framerail result');
 if(ensuredRuntime.backend_probe?.ok!==true)throw new Error('ensure-built-framerail did not verify current Deepwell from the built Framerail network');
 transportOrigin=transportOriginArg??ensuredRuntime.transport_origin;
}
if(!transportOrigin)transportOrigin=transportOriginArg??runtimeContract.target_site?.origin;
if(typeof transportOrigin!=='string')throw new Error('matrix run contract needs a target origin for runtime source verification');
const runtimeFixtureUrl=new URL('/run-owned%3Atheme-lab-visual-acceptance-imported-20260924',transportOrigin).href;
const runtimeProbe=await run('curl',['-ksSf','-D','-','-o','/dev/null','--max-time','5',runtimeFixtureUrl],{capture:true});
const runtimeResponse=parseCurlRuntimeResponseHeaders(runtimeProbe.stdout);
assertRuntimeSourceSha(expectedRuntimeSourceSha,runtimeResponse.runtimeSourceSha,`matrix fixture response from ${transportOrigin}`);
const backendResponse=parseCurlDeepwellRuntimeHeaders(runtimeProbe.stdout);
const measuredBackendIdentity=assertDeepwellRuntimeIdentity(expectedBackendRuntimeIdentity,backendResponse.backendRuntimeIdentity,`matrix fixture response from ${transportOrigin}`);

const auditShardDir=path.join(path.dirname(auditPath),`${path.basename(auditPath)}.shards`,`run-${Date.now()}-${process.pid}`);
await fs.mkdir(auditShardDir,{recursive:true});
let cleanupShardsOnExit=true;
process.once('exit',()=>{if(cleanupShardsOnExit)fsSync.rmSync(auditShardDir,{recursive:true,force:true})});
const captureEnv={...process.env,THEME_LAB_AUDIT_SHARD_DIR:auditShardDir};
async function commitAuditShards(){
 try{
  const summary=await mergeInteractiveAuditShards({auditPath,shardDirectory:auditShardDir,portsDir});
  return summary.shards;
 }catch(error){cleanupShardsOnExit=false;throw error}
}

// Pin prior rows once per matrix invocation. Retries must compare against the
// same accepted prior, not an earlier failed attempt already merged this run.
let initialAuditSnapshotPromise=null;
async function readAuditSnapshot(){
 if(!initialAuditSnapshotPromise)initialAuditSnapshotPromise=(async()=>{
  try{return JSON.parse(await fs.readFile(auditPath,'utf8'))}
  catch(error){if(error.code!=='ENOENT')throw error;return{records:[]}}
 })();
 return initialAuditSnapshotPromise;
}
async function writeAuditSeed(filename,themeNames,engine,viewport){
 const snapshot=await readAuditSnapshot();
 const themeSet=new Set(themeNames);
 const records=(snapshot.records??[]).filter(row=>themeSet.has(row.theme)&&row.browser_engine===engine&&row.viewport===viewport);
 const seedPath=path.join(auditShardDir,'seeds',filename);
 await fs.mkdir(path.dirname(seedPath),{recursive:true});
 await fs.writeFile(seedPath,JSON.stringify({schema:snapshot.schema??'scp_jp_interactive_visual_audit.v1',records}));
 return seedPath;
}

const common=[themes.length===1?`--theme=${themes[0]}`:`--themes=${themes.join(',')}`];
common.push(`--concurrency=${captureConcurrencyArg}`);
if(runContractPath)common.push(`--run-contract=${runContractPath}`);
if(stateArg)common.push(`--state=${stateArg}`);
if(force)common.push('--force');
if(anonymous)common.push('--anonymous');
if(transportOrigin)common.push(`--transport-origin=${transportOrigin}`);
if(runtimeRepoArg!==undefined)common.push(`--runtime-repo=${runtimeRepoArg}`);
if(backendProjectArg!==undefined)common.push(`--backend-project=${backendProjectArg}`);

let next=0;
const results=[];
let firstWorkerError=null;
const started=Date.now();
await Promise.all(Array.from({length:Math.min(jobsArg,matrix.length)},async()=>{
 while(true){
  if(firstWorkerError)return;
  const index=next++;
  if(index>=matrix.length)return;
  const [engine,viewport]=matrix[index];
  const childStarted=Date.now();
  try{
   const seed=await writeAuditSeed(`${engine}__${viewport}.json`,themes,engine,viewport);
   await run(process.execPath,[captureScript,`--engine=${engine}`,`--viewport=${viewport}`,...common],{env:{...captureEnv,THEME_LAB_AUDIT_SEED_PATH:seed}});
   results.push({engine,viewport,elapsed_ms:Date.now()-childStarted});
  }catch(error){
   firstWorkerError??=error;
   return;
  }
 }
}));
await commitAuditShards();
if(firstWorkerError)throw firstWorkerError;
const requestedStates=stateArg?new Set(stateArg.split(',').filter(Boolean)):null;
const isRequestedRow=row=>
 themes.includes(row.theme) &&
 (!engineArg||row.browser_engine===engineArg) &&
 (!viewportArg||row.viewport===viewportArg) &&
 (!requestedStates||requestedStates.has(`${row.surface}.${row.state}`));
let retries=0;
for(let pass=0;pass<2;pass++){
 const audit=JSON.parse(await fs.readFile(auditPath,'utf8'));
 const failures=(audit.records??[]).filter(row=>
  isRequestedRow(row) &&
  row.unconfirmed_items?.some(item=>String(item).startsWith('action/capture failed'))
 );
 if(!failures.length)break;
 const groups=new Map();
 for(const row of failures){
  const key=`${row.theme}|${row.browser_engine}|${row.viewport}`;
  const group=groups.get(key)??{theme:row.theme,engine:row.browser_engine,viewport:row.viewport,states:new Set()};
  group.states.add(`${row.surface}.${row.state}`);groups.set(key,group);
 }
 for(const group of groups.values()){
  retries+=group.states.size;
  const args=[captureScript,`--engine=${group.engine}`,`--viewport=${group.viewport}`,`--theme=${group.theme}`,`--state=${[...group.states].join(',')}`,'--concurrency=2','--force'];
  if(runContractPath)args.push(`--run-contract=${runContractPath}`);
  if(anonymous)args.push('--anonymous');
  if(transportOrigin)args.push(`--transport-origin=${transportOrigin}`);
  if(runtimeRepoArg!==undefined)args.push(`--runtime-repo=${runtimeRepoArg}`);
  if(backendProjectArg!==undefined)args.push(`--backend-project=${backendProjectArg}`);
  const seed=await writeAuditSeed(`${group.theme}__${group.engine}__${group.viewport}__retry-${pass}.json`,[group.theme],group.engine,group.viewport);
  await run(process.execPath,args,{env:{...captureEnv,THEME_LAB_AUDIT_SEED_PATH:seed}});
 }
 await commitAuditShards();
}

const finalAudit=JSON.parse(await fs.readFile(auditPath,'utf8'));
const runRows=(finalAudit.records??[]).filter(isRequestedRow);
const remainingFailures=runRows.filter(row=>row.unconfirmed_items?.some(item=>String(item).startsWith('action/capture failed')));
const invalidEvidence=runRows.flatMap(row=>{
 const failures=[];
 if(visualGateNeedsScreenshot(row,{failure:!!row.failure})&&(!row.screenshot||!/^[a-f0-9]{64}$/u.test(row.screenshot_sha256??'')))failures.push('required screenshot is missing');
 if(!Array.isArray(row.asset_failures)||row.asset_failures.length)failures.push('asset failure');
 if(!Array.isArray(row.page_errors)||row.page_errors.length)failures.push('page error');
 if(row.external_requests_sent!==0)failures.push('external request sent');
 failures.push(...validateVisualGateRecord(row,{requirePolicyBinding:true,requireVisualReview:false}));
 return failures.map(reason=>({theme:row.theme,engine:row.browser_engine,viewport:row.viewport,state:`${row.surface}.${row.state}`,reason}));
});
if(invalidEvidence.length){await fs.rm(auditShardDir,{recursive:true,force:true});throw new Error(`matrix capture has ${invalidEvidence.length} rows with policy or runtime evidence failures; first=${JSON.stringify(invalidEvidence.slice(0,5))}`)}
if(remainingFailures.length){await fs.rm(auditShardDir,{recursive:true,force:true});throw new Error(`matrix capture still has ${remainingFailures.length} action failures after targeted retries`)}
console.log(JSON.stringify({
 schema:'theme_lab_matrix_capture.v1',
 themes,
 transport:transportOriginArg?'explicit':transportArg,
 transport_origin:transportOrigin,
 runtime_source_sha256:runtimeResponse.runtimeSourceSha,
 backend_runtime_identity:measuredBackendIdentity,
 jobs:jobsArg,
 capture_concurrency:captureConcurrencyArg,
 elapsed_ms:Date.now()-started,
 successful_states:runRows.filter(row=>row.screenshot&&!row.unconfirmed_items?.some(item=>String(item).startsWith('action/capture failed'))).length,
 action_failures:remainingFailures.length,
 page_errors:runRows.reduce((sum,row)=>sum+(row.page_errors?.length??0),0),
 asset_failures:runRows.reduce((sum,row)=>sum+(row.asset_failures?.length??0),0),
 external_requests_sent:runRows.reduce((sum,row)=>sum+(row.external_requests_sent??0),0),
 retried_states:retries,
 job_results:results.sort((a,b)=>a.engine.localeCompare(b.engine)||a.viewport.localeCompare(b.viewport))
}));
await fs.rm(auditShardDir,{recursive:true,force:true});
cleanupShardsOnExit=false;
