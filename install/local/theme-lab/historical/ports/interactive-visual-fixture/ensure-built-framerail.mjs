#!/usr/bin/env node
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {framerailEnvLabel,parseFramerailEnvOption} from '../../src/framerail-env-option.mjs';
import {withAuditLock} from '../scripts/audit-lock.mjs';
import {framerailSourceFingerprint} from '../../src/framerail-source-fingerprint.mjs';
import {assertDeepwellRuntimeIdentity,parseCurlDeepwellRuntimeHeaders,readRunningDeepwellRuntimeIdentity,requireDeepwellRuntimeIdentity} from '../../src/deepwell-runtime-identity.mjs';
import {assertRuntimeSourceSha,parseCurlRuntimeResponseHeaders,requireRuntimeSourceSha} from '../../src/runtime-source-identity.mjs';

const scriptDir=path.dirname(fileURLToPath(import.meta.url));
const runtimeRepoArg=process.argv.find(arg=>arg.startsWith('--runtime-repo='))?.slice(15)??null;
const defaultRepoRoot=path.resolve(scriptDir,'../../../../../');
if(runtimeRepoArg!==null&&(!path.isAbsolute(runtimeRepoArg)||path.resolve(runtimeRepoArg)!==runtimeRepoArg))throw new Error('--runtime-repo must be a canonical absolute checkout path');
const repoRoot=runtimeRepoArg===null?defaultRepoRoot:await fs.realpath(runtimeRepoArg);
if(runtimeRepoArg!==null&&repoRoot!==runtimeRepoArg)throw new Error('source checkout path cannot contain symlinks');
const framerailDir=path.join(repoRoot,'framerail');
const namespace=process.argv.find(arg=>arg.startsWith('--namespace='))?.slice(12)??null;
const backendProject=process.argv.find(arg=>arg.startsWith('--backend-project='))?.slice(18)??null;
const framerailEnv=parseFramerailEnvOption({framerailEnv:process.argv.find(arg=>arg.startsWith('--framerail-env='))?.slice(16),backendProject});
const envLabel=framerailEnvLabel(framerailEnv);
const port=Number(process.argv.find(arg=>arg.startsWith('--port='))?.slice(7)??3395);
const runContractArg=process.argv.find(arg=>arg.startsWith('--run-contract='))?.slice(15)??null;
if(namespace!==null&&!/^[a-z][a-z0-9-]{0,40}$/u.test(namespace))throw new Error('invalid task-owned namespace');
if(runtimeRepoArg!==null&&namespace===null)throw new Error('--runtime-repo requires an explicit task-owned --namespace');
if(backendProject!==null&&(namespace===null||runtimeRepoArg===null||backendProject!==`wikijump-theme-lab-${namespace}`))
 throw new Error('isolated backend Compose project must match the task namespace and explicit source checkout');
if(!Number.isInteger(port)||port<1024||port>65535||namespace!==null&&port===3395)throw new Error('task-owned transport needs a distinct valid port');
const cacheBase=process.env.THEME_LAB_BUILT_CACHE??`/tmp/wikijump-theme-lab-${namespace??'built'}-framerail`;
const framerailContainer=`wikijump-theme-lab-${namespace??'built'}-framerail`;
const caddyContainer=`wikijump-theme-lab-${namespace??'built'}-caddy`;
const transportOrigin=`https://scpaiueouiuiuiui.wikijump.localhost:${port}`;
const devContainer='wikijump-local-development-framerail-1';
const deepwellContainer=`${backendProject??'wikijump-local-development'}-deepwell-1`;
const defaultRunContract=path.join(scriptDir,'acceptance-run-contract.json');
const runContractPath=runContractArg?path.resolve(runContractArg):defaultRunContract;
const runContract=JSON.parse(await fs.readFile(runContractPath,'utf8'));
const expectedRuntimeSourceSha=requireRuntimeSourceSha(runContract.expected_runtime_source_sha256,'matrix run contract');
const expectedBackendRuntimeIdentity=requireDeepwellRuntimeIdentity(runContract.expected_backend_runtime_identity,'matrix run contract');

function run(command,args,{cwd=repoRoot,env=process.env,stdio='pipe'}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd,env,stdio});
  let stdout='',stderr='';
  if(child.stdout)child.stdout.on('data',chunk=>stdout+=chunk);
  if(child.stderr)child.stderr.on('data',chunk=>stderr+=chunk);
  child.once('error',reject);
  child.once('close',code=>code===0?resolve({stdout,stderr}):reject(new Error(`${command} exited ${code}: ${stderr.slice(-4000)}`)));
 });
}


async function inspectContainer(name){
 try{return JSON.parse((await run('docker',['inspect',name,'--format','{{json .}}'])).stdout.trim())}
 catch{return null}
}

async function isReady(expectedFingerprint){
 try{
  const response=await run('curl',['-ksSf','-D','-','-o','/dev/null','--max-time','3',`${transportOrigin}/run-owned%3Atheme-lab-visual-acceptance-imported-20260924`]);
  const runtime=parseCurlRuntimeResponseHeaders(response.stdout);
  const backend=parseCurlDeepwellRuntimeHeaders(response.stdout);
  return runtime.runtimeSourceSha===expectedFingerprint&&backend.backendRuntimeIdentity?.identity_sha256===expectedBackendRuntimeIdentity.identity_sha256;
 }catch{return false}
}

async function probeDeepwellFromFramerail(expected){
 const script='const dns=require("node:dns").promises; const identity=require("node:assert/strict"); (async()=>{const ip=(await dns.lookup("deepwell",{family:4})).address; const response=await fetch("http://deepwell:2747/jsonrpc",{method:"POST",headers:{authorization:"Bearer "+process.env.DEEPWELL_RPC_TOKEN,"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",method:"ping",id:1}),signal:AbortSignal.timeout(5000)}); const body=await response.json(); if(!response.ok||body.result!=="Pong!")throw new Error("Deepwell ping failed"); console.log(JSON.stringify({ip,status:response.status,ok:true}));})().catch(error=>{process.stderr.write(error.message);process.exit(1)})';
 const result=await run('docker',['exec',framerailContainer,'node','-e',script]);
 const probe=JSON.parse(result.stdout.trim());
 if(probe.ip!==expected.ip)throw new Error(`built Framerail deepwell alias resolves to ${probe.ip}, expected current Deepwell ${expected.ip}`);
 if(probe.ok!==true||probe.status!==200)throw new Error('built Framerail did not reach a healthy current Deepwell RPC endpoint');
 return probe;
}

async function buildSource(fingerprint){
 const buildDir=path.join(cacheBase,fingerprint);
 const ready=path.join(buildDir,'.theme-lab-built-ready');
 try{await fs.access(ready);await fs.access(path.join(buildDir,'build/handler.js'));return{buildDir,built:false}}catch{}
 await fs.rm(buildDir,{recursive:true,force:true});
 await fs.mkdir(buildDir,{recursive:true});
 await run('rsync',['-a','--delete','--exclude','node_modules','--exclude','.svelte-kit','--exclude','build',`${framerailDir}/`,`${buildDir}/`]);
 await fs.symlink(path.join(framerailDir,'node_modules'),path.join(buildDir,'node_modules'));
 const copiedFingerprint=await framerailSourceFingerprint(repoRoot);
 if(copiedFingerprint!==fingerprint)throw new Error('Framerail source changed while preparing the built capture runtime; retry after the current edit settles');
 await run(path.join(buildDir,'node_modules/.bin/vite'),['build'],{cwd:buildDir});
 const afterFingerprint=await framerailSourceFingerprint(repoRoot);
 if(afterFingerprint!==fingerprint)throw new Error('Framerail source changed during the built capture runtime build; retry so evidence cannot use a stale build');
 await fs.writeFile(ready,`${fingerprint}\n`);
 return{buildDir,built:true};
}

async function startContainers(fingerprint,buildDir,backend){
 const running=await inspectContainer(framerailContainer);
 const runningCaddy=await inspectContainer(caddyContainer);
 const currentFingerprint=running?.Config?.Labels?.['theme-lab.source-sha'];
 const currentCaddyFingerprint=runningCaddy?.Config?.Labels?.['theme-lab.source-sha'];
 const currentBackendIdentity=running?.Config?.Labels?.['theme-lab.backend-runtime-sha'];
 const currentEnvLabel=running?.Config?.Labels?.['theme-lab.framerail-env']??'image-default';
 const currentCaddyBackendIdentity=runningCaddy?.Config?.Labels?.['theme-lab.backend-runtime-sha'];
 if(currentFingerprint===fingerprint&&currentCaddyFingerprint===fingerprint&&currentBackendIdentity===backend.identity.identity_sha256&&currentCaddyBackendIdentity===backend.identity.identity_sha256&&currentEnvLabel===envLabel&&await isReady(fingerprint)){
  const probe=await probeDeepwellFromFramerail(backend);
  return{restarted:false,backendProbe:probe};
 }
 if(running||runningCaddy)throw new Error('task-owned built transport already exists with different provenance; choose a new namespace rather than replace it');

 const dev=await inspectContainer(devContainer);
 if(!dev)throw new Error(`required local-development container ${devContainer} is not running`);
 const network=backendProject?backend.network:Object.keys(dev.NetworkSettings?.Networks??{})[0];
 if(!network)throw new Error('could not determine the local-development Docker network');
 if(network!==backend.network)throw new Error('built Framerail and current Deepwell are not attached to the same Docker network');
 const created=[];
 try{

 const envFile=path.join(os.tmpdir(),`theme-lab-built-env-${process.pid}`);
 const safeTaskKeys=new Set(['DEEPWELL_HOST','FRAMERAIL_MODE','PORT','REDIS_URL','PNPM_HOME','PNPM_STORE_DIR']);
 const envLines=(dev.Config?.Env??[]).filter(value=>value.includes('=')&&(!backendProject||safeTaskKeys.has(value.split('=')[0]))).map(value=>{
  const [key,...rest]=value.split('=');
  if(key==='FRAMERAIL_MODE')return 'FRAMERAIL_MODE=built';
  if(key==='PORT')return 'PORT=3393';
  return `${key}=${rest.join('=')}`;
 });
 if(backendProject){
  const token=(backend.container.Config?.Env??[]).find(value=>value.startsWith('DEEPWELL_RPC_TOKEN='));
  if(!token||token.length<= 'DEEPWELL_RPC_TOKEN='.length)throw new Error('task backend lacks the RPC authentication token');
  const existing=envLines.findIndex(line=>line.startsWith('DEEPWELL_RPC_TOKEN='));
  if(existing>=0)envLines[existing]=token;
  else envLines.push(token);
 }
 if(framerailEnv){const at=envLines.findIndex(line=>line.startsWith('FRAMERAIL_ENV='));if(at>=0)envLines[at]=`FRAMERAIL_ENV=${framerailEnv}`;else envLines.push(`FRAMERAIL_ENV=${framerailEnv}`)}
 if(!envLines.some(line=>line.startsWith('FRAMERAIL_MODE=')))envLines.push('FRAMERAIL_MODE=built');
 if(!envLines.some(line=>line.startsWith('PORT=')))envLines.push('PORT=3393');
 await fs.writeFile(envFile,envLines.join('\n')+'\n',{mode:0o600});
 try{
  if(!envLines.some(line=>line==='DEEPWELL_HOST=deepwell'))throw new Error('built Framerail does not use the verified deepwell service alias');
  const args=['run','-d','--rm','--name',framerailContainer,'--network',network,'--label',`theme-lab.framerail-env=${envLabel}`,'--label',`theme-lab.source-sha=${fingerprint}`,'--label',`theme-lab.backend-runtime-sha=${backend.identity.identity_sha256}`,'--env-file',envFile,'-e','FRAMERAIL_MODE=built','-e','PORT=3393','-v',`${buildDir}:/app`];
  if(backendProject){
   await fs.access(path.join(framerailDir,'node_modules'));
   await fs.access(path.join(repoRoot,'assets'));
   args.push('-v',`${path.join(framerailDir,'node_modules')}:/app/node_modules:ro`);
   args.push('-v',`${path.join(repoRoot,'assets')}:/app/src/assets:ro`);
  }else for(const mount of dev.Mounts??[]){
   if(mount.Destination==='/app/node_modules'&&mount.Type==='volume')args.push('-v',`${mount.Name}:/app/node_modules`);
   if(mount.Destination==='/pnpm'&&mount.Type==='volume')args.push('-v',`${mount.Name}:/pnpm`);
   if(mount.Destination==='/app/src/assets'&&mount.Type==='bind')args.push('-v',`${mount.Source}:/app/src/assets:ro`);
  }
  // buildSource already produced the exact frozen bundle. The development
  // entrypoint installs dependencies and rebuilds it, racing the readiness
  // deadline and changing the material being measured.
  args.push('--entrypoint','/usr/bin/env',dev.Config.Image,'HOST=0.0.0.0','PORT=3393','node','server.js');
  await run('docker',args);
  created.push(framerailContainer);
 }finally{await fs.rm(envFile,{force:true})}

 const caddyFile=path.join(cacheBase,'Caddyfile');
 await fs.mkdir(cacheBase,{recursive:true});
 await fs.writeFile(caddyFile,`{
  auto_https disable_redirects
}
https://scpaiueouiuiuiui.wikijump.localhost {
  tls internal
  header X-Theme-Lab-Runtime-Source-Sha ${fingerprint}
  header X-Theme-Lab-Backend-Source-Sha ${backend.identity.source_sha256}
  header X-Theme-Lab-Backend-FTML-Git-Revision ${backend.identity.ftml_git_revision}
  header X-Theme-Lab-Backend-Container-Id ${backend.identity.container_id}
  header X-Theme-Lab-Backend-Image-Id ${backend.identity.image_id}
  header X-Theme-Lab-Backend-Binary-Sha ${backend.identity.binary_sha256}
  header X-Theme-Lab-Backend-Config-Sha ${backend.identity.config_sha256}
  header X-Theme-Lab-Backend-Identity-Sha ${backend.identity.identity_sha256}
  reverse_proxy ${framerailContainer}:3393 {
    header_up X-Wikijump-Site-Id 6000003
    header_up X-Wikijump-Site-Slug scpaiueouiuiuiui
  }
}
`);
 await run('docker',['run','-d','--rm','--name',caddyContainer,'--network',network,'--label',`theme-lab.source-sha=${fingerprint}`,'--label',`theme-lab.backend-runtime-sha=${backend.identity.identity_sha256}`,'-p',`127.0.0.1:${port}:443`,'-v',`${caddyFile}:/etc/caddy/Caddyfile:ro`,'caddy:alpine','caddy','run','--config','/etc/caddy/Caddyfile','--adapter','caddyfile']);
 created.push(caddyContainer);

 for(let attempt=0;attempt<60;attempt++){
  if(await isReady(fingerprint)){
   const probe=await probeDeepwellFromFramerail(backend);
   return{restarted:true,backendProbe:probe};
  }
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 throw new Error('built Framerail capture sidecar did not become ready');
 }catch(error){
  if(created.length)await run('docker',['rm','-f',...created.reverse()]).catch(()=>{});
  throw error;
 }
}

await fs.mkdir(cacheBase,{recursive:true});
await withAuditLock(path.join(cacheBase,'bootstrap'),async()=>{
const started=Date.now();
let attempts=0;
while(true){
 attempts++;
 const fingerprint=await framerailSourceFingerprint(repoRoot);
 try{
  assertRuntimeSourceSha(expectedRuntimeSourceSha,fingerprint,'current Framerail source');
  const backend=readRunningDeepwellRuntimeIdentity(repoRoot,{containerName:deepwellContainer,composeProject:backendProject??'wikijump-local-development'});
  assertDeepwellRuntimeIdentity(expectedBackendRuntimeIdentity,backend.identity,'current Deepwell runtime');
  const build=await buildSource(fingerprint);
  const containers=await startContainers(fingerprint,build.buildDir,backend);
  console.log(JSON.stringify({schema:'theme_lab_built_framerail.v2',transport_origin:transportOrigin,source_sha256:fingerprint,backend_runtime_identity:backend.identity,backend_probe:containers.backendProbe,built:build.built,restarted:containers.restarted,attempts,elapsed_ms:Date.now()-started}));
  break;
 }catch(error){
  if(/source changed/iu.test(error.message)&&attempts<3)continue;
  throw error;
 }
}

},{attempts:12000});
