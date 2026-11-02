#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {deepwellRpcAuthorization} from '../../../wikidot-verification/src/deepwell-rpc-auth.mjs';
import {fixtureRpcTarget} from '../../src/fixture-rpc-target.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const rpcUrl=fixtureRpcTarget().rpcUrl;
const siteSlug='scpaiueouiuiuiui';
const primarySlug='run-owned:theme-lab-visual-acceptance-20260924';
const pages=[
  {slug:primarySlug,title:'SCP-JP Theme Lab Interactive Visual Fixture',file:'fixture.wikidot.txt',tags:['theme-lab-visual-acceptance','jp','日本語']},
  {slug:'nav:top',title:'Nav Top',file:'nav-top.wikidot.txt'},
  {slug:'nav:side',title:'Nav Side',file:'nav-side.wikidot.txt'},
  {slug:'nav:interwiki',title:'Nav Interwiki',file:'nav-interwiki.wikidot.txt'},
  {slug:'run-owned:theme-lab-visual-backlink-20260924',title:'SCP-JP Theme Lab Backlink Fixture',file:'backlink-fixture.wikidot.txt',tags:['theme-lab-visual-acceptance','jp','日本語']},
];
if(!/^[0-9a-f]{64}$/u.test(process.env.DEEPWELL_RPC_TOKEN??''))throw new Error('DEEPWELL_RPC_TOKEN is required from the local-only environment');
if(!process.env.WIKIDOT_VERIFY_ADMIN_EMAIL||!process.env.WIKIDOT_VERIFY_ADMIN_PASS)throw new Error('Use the established local verification admin environment');
const authorization=deepwellRpcAuthorization(process.env.DEEPWELL_RPC_TOKEN);
let id=0;
async function rpc(method,params,context={}){
  const headers={authorization,'content-type':'application/json'};
  if(context.sessionToken)headers['X-Deepwell-Session-Token']=context.sessionToken;
  if(context.siteId)headers['X-Deepwell-Site-Id']=String(context.siteId);
  if(context.page)headers['X-Deepwell-Page']=context.page;
  const response=await fetch(rpcUrl,{method:'POST',redirect:'error',headers,body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
  const body=await response.json();if(!response.ok||body.error)throw new Error(`${method} failed: ${JSON.stringify(body.error??response.status)}`);return body.result;
}
const site=await rpc('site_get',{site:siteSlug});if(!Number.isSafeInteger(site?.site_id))throw new Error('Local authoring site identity is unavailable');
if(site.site_id!==6000003)throw new Error('Theme Lab fixture site ID differs from source-bound Caddy contract');
const login=await rpc('login',{name_or_email:process.env.WIKIDOT_VERIFY_ADMIN_EMAIL,password:process.env.WIKIDOT_VERIFY_ADMIN_PASS,ip_address:'127.0.0.1',user_agent:'theme-lab-interactive-fixture/1'});
if(login?.needs_mfa!==false||typeof login.session_token!=='string')throw new Error('Local verification admin session was not established');
const session=await rpc('session_get',[login.session_token]);if(!Number.isSafeInteger(session?.user_id))throw new Error('Local session actor could not be verified');
const results=[];
for(const spec of pages){
  const source=await fs.readFile(path.join(root,spec.file),'utf8');
  const current=await rpc('page_get',{site_id:site.site_id,page:spec.slug,details:{wikitext:true,compiled:false}},{sessionToken:login.session_token,siteId:site.site_id,page:spec.slug});
  if(!current){
    if(spec.slug==='run-owned:theme-lab-visual-backlink-20260924'){
      const pageId=3_001_592_426;
      const createdAt=new Date().toISOString();
      await rpc('import_wikidot_page',{page_id:pageId,site_id:site.site_id,created_at:createdAt,slug:spec.slug,locked:false,discussion_thread_id:null,ip_address:'127.0.0.1'},{sessionToken:login.session_token,siteId:site.site_id,page:spec.slug});
      const revisionDate=`${createdAt.slice(0,10)} ${createdAt.slice(11,19)}.0 +00:00:00`;
      await rpc('import_wikidot_page_revision',{revision_id:2_100_000_000+crypto.randomInt(0,100_000_000),revision_type:'create',created_at:revisionDate,updated_at:null,revision_number:0,page_id:pageId,site_id:site.site_id,user_id:session.user_id,wikitext:source,comments:'Create run-owned backlink source fixture',title:spec.title,slug:spec.slug,tags:spec.tags??[]},{sessionToken:login.session_token,siteId:site.site_id,page:spec.slug});
    }else{
    // A fresh task backend has none of these pages. The primary fixture is
    // bootstrapped with the same page_create as the navigation pages; any other
    // missing page still fails closed.
    if(!spec.slug.startsWith('nav:')&&spec.slug!==primarySlug&&spec.slug!=='run-owned:theme-lab-visual-backlink-20260924')throw new Error(`Run-owned local fixture page is missing: ${spec.slug}`);
    const created=await rpc('page_create',{site_id:site.site_id,wikitext:source,title:spec.title,alt_title:null,slug:spec.slug,layout:'wikidot',revision_comments:spec.slug===primarySlug?'Create run-owned SCP-JP interactive visual fixture':'Create run-owned SCP-JP theme navigation fixture',user_id:session.user_id,ip_address:'127.0.0.1',tags:spec.tags??[]},{sessionToken:login.session_token,siteId:site.site_id,page:spec.slug});
    if(!Number.isSafeInteger(created?.page_id)||!Number.isSafeInteger(created?.revision_id))throw new Error(`Run-owned navigation fixture creation failed: ${spec.slug}`);
    }
  }
  const latest=await rpc('page_get',{site_id:site.site_id,page:spec.slug,details:{wikitext:true,compiled:false}},{sessionToken:login.session_token,siteId:site.site_id,page:spec.slug});
  if(!latest||!Number.isSafeInteger(latest.page_id)||!Number.isSafeInteger(latest.revision_id))throw new Error(`Run-owned local fixture page is missing: ${spec.slug}`);
  const hash=crypto.createHash('sha256').update(source).digest('hex');
  const tags=spec.tags??[];
  if(latest.wikitext!==source||JSON.stringify(latest.tags)!==JSON.stringify(tags)){
    await rpc('page_edit',{site_id:site.site_id,page:latest.page_id,last_revision_id:latest.revision_id,revision_comments:'Update run-owned interactive theme acceptance fixture',user_id:session.user_id,wikitext:source,tags,ip_address:'127.0.0.1'},{sessionToken:login.session_token,siteId:site.site_id,page:spec.slug});
  }
  const final=await rpc('page_get',{site_id:site.site_id,page:spec.slug,details:{wikitext:true,compiled:false}},{sessionToken:login.session_token,siteId:site.site_id,page:spec.slug});
  const actualHash=crypto.createHash('sha256').update(final.wikitext).digest('hex');
  if(actualHash!==hash)throw new Error(`Run-owned fixture source did not round-trip: ${spec.slug}`);
  results.push({slug:spec.slug,page_id:final.page_id,revision_id:final.revision_id,source_sha256:actualHash,updated:latest.wikitext!==source});
}
const importedSlug='run-owned:theme-lab-visual-acceptance-imported-20260924';
const importedTitle='SCP-JP Theme Lab Interactive Visual Fixture (imported surface)';
const importedSource=await fs.readFile(path.join(root,'fixture.wikidot.txt'),'utf8');
let imported=null;
let importedExistsWithoutRevision=false;
let importedPageId=3001592425;
try{
  imported=await rpc('page_get',{site_id:site.site_id,page:importedSlug,details:{wikitext:true,compiled:false}},{sessionToken:login.session_token,siteId:site.site_id,page:importedSlug});
  if(imported?.page_id)importedPageId=imported.page_id;
}catch(error){
  if(!error.message.includes('Page revision does not exist'))throw error;
  importedExistsWithoutRevision=true;
}
const createImportedRevision=async(pageId)=>{
  const date=new Date();
  const revisionDate=`${date.toISOString().slice(0,10)} ${date.toISOString().slice(11,19)}.0 +00:00:00`;
  await rpc('import_wikidot_page_revision',{revision_id:2_000_000_000+crypto.randomInt(0,100_000_000),revision_type:'create',created_at:revisionDate,updated_at:null,revision_number:0,page_id:pageId,site_id:site.site_id,user_id:session.user_id,wikitext:importedSource,comments:'Create run-owned imported-style SCP-JP visual fixture',title:importedTitle,slug:importedSlug,tags:['theme-lab-visual-acceptance','jp','日本語']},{sessionToken:login.session_token,siteId:site.site_id,page:importedSlug});
};
if(!imported&&!importedExistsWithoutRevision){
  const pageId=importedPageId;
  const now=new Date().toISOString();
  await rpc('import_wikidot_page',{page_id:pageId,site_id:site.site_id,created_at:now,slug:importedSlug,locked:false,discussion_thread_id:null,ip_address:'127.0.0.1'},{sessionToken:login.session_token,siteId:site.site_id,page:importedSlug});
}
if(!imported||importedExistsWithoutRevision||!Number.isSafeInteger(imported.revision_id)){
  await createImportedRevision(imported?.page_id??importedPageId);
  imported=await rpc('page_get',{site_id:site.site_id,page:importedSlug,details:{wikitext:true,compiled:false}},{sessionToken:login.session_token,siteId:site.site_id,page:importedSlug});
}else if(imported.wikitext!==importedSource||JSON.stringify(imported.tags)!==JSON.stringify(['theme-lab-visual-acceptance','jp','日本語'])){
  await rpc('page_edit',{site_id:site.site_id,page:imported.page_id,last_revision_id:imported.revision_id,revision_comments:'Refresh run-owned imported-style visual fixture',user_id:session.user_id,wikitext:importedSource,tags:['theme-lab-visual-acceptance','jp','日本語'],ip_address:'127.0.0.1'},{sessionToken:login.session_token,siteId:site.site_id,page:importedSlug});
  imported=await rpc('page_get',{site_id:site.site_id,page:importedSlug,details:{wikitext:true,compiled:false}},{sessionToken:login.session_token,siteId:site.site_id,page:importedSlug});
}
if(!imported||imported.wikitext!==importedSource||JSON.stringify(imported.tags)!==JSON.stringify(['theme-lab-visual-acceptance','jp','日本語']))throw new Error('Imported-style fixture did not round-trip');
if(imported.revision_number===0){
  const edit=async(wikitext,comments)=>rpc('page_edit',{site_id:site.site_id,page:imported.page_id,last_revision_id:imported.revision_id,revision_comments:comments,user_id:session.user_id,wikitext,tags:['theme-lab-visual-acceptance','jp','日本語'],ip_address:'127.0.0.1'},{sessionToken:login.session_token,siteId:site.site_id,page:importedSlug});
  await edit(`${importedSource}\n\n== 履歴差分の追加行 ==\n追加された日本語のrevisionです。\n`,'Add run-owned Japanese history difference');
  imported=await rpc('page_get',{site_id:site.site_id,page:importedSlug,details:{wikitext:true,compiled:false}},{sessionToken:login.session_token,siteId:site.site_id,page:importedSlug});
  await edit(importedSource,'Restore final visual fixture after revision-diff setup');
  imported=await rpc('page_get',{site_id:site.site_id,page:importedSlug,details:{wikitext:true,compiled:false}},{sessionToken:login.session_token,siteId:site.site_id,page:importedSlug});
}
results.push({slug:importedSlug,page_id:imported.page_id,revision_id:imported.revision_id,source_sha256:crypto.createHash('sha256').update(imported.wikitext).digest('hex'),tags:imported.tags,imported:true});
const historySlug='run-owned:theme-lab-visual-history-20260924';
const historyTitle='SCP-JP Theme Lab Revision History Fixture';
const historySource=await fs.readFile(path.join(root,'history-fixture.wikidot.txt'),'utf8');
let historyPage=null;let historyWithoutRevision=false;const historyPageId=2_800_000_000+crypto.randomInt(0,100_000_000);
try{historyPage=await rpc('page_get',{site_id:site.site_id,page:historySlug,details:{wikitext:true,compiled:false}},{sessionToken:login.session_token,siteId:site.site_id,page:historySlug});if(historyPage?.page_id){} }catch(error){if(!error.message.includes('Page revision does not exist'))throw error;historyWithoutRevision=true}
if(!historyPage&&!historyWithoutRevision)await rpc('import_wikidot_page',{page_id:historyPageId,site_id:site.site_id,created_at:new Date().toISOString(),slug:historySlug,locked:false,discussion_thread_id:null,ip_address:'127.0.0.1'},{sessionToken:login.session_token,siteId:site.site_id,page:historySlug});
if(!historyPage||historyWithoutRevision){
 const pageId=historyPage?.page_id??historyPageId;const initial=`[[module Rate]]\n\n${historySource}`;const revisionId=2_100_000_000+crypto.randomInt(0,100_000_000);const date=new Date();const revisionDate=`${date.toISOString().slice(0,10)} ${date.toISOString().slice(11,19)}.0 +00:00:00`;
 await rpc('import_wikidot_page_revision',{revision_id:revisionId,revision_type:'create',created_at:revisionDate,updated_at:null,revision_number:0,page_id:pageId,site_id:site.site_id,user_id:session.user_id,wikitext:initial,comments:'Create compact revision-diff fixture',title:historyTitle,slug:historySlug,tags:['theme-lab-visual-acceptance','history','日本語']},{sessionToken:login.session_token,siteId:site.site_id,page:historySlug});
 historyPage=await rpc('page_get',{site_id:site.site_id,page:historySlug,details:{wikitext:true,compiled:false}},{sessionToken:login.session_token,siteId:site.site_id,page:historySlug});
 const edit=async(wikitext,comments)=>rpc('page_edit',{site_id:site.site_id,page:historyPage.page_id,last_revision_id:historyPage.revision_id,revision_comments:comments,user_id:session.user_id,wikitext,tags:['theme-lab-visual-acceptance','history','日本語'],ip_address:'127.0.0.1'},{sessionToken:login.session_token,siteId:site.site_id,page:historySlug});
 await edit(`[[module Rate]]\n\n${historySource.replace('HISTORY_CHANGED_LINE','改訂前の長い日本語行')}`,'Create before-state for revision comparison');
 historyPage=await rpc('page_get',{site_id:site.site_id,page:historySlug,details:{wikitext:true,compiled:false}},{sessionToken:login.session_token,siteId:site.site_id,page:historySlug});
 await edit(`[[module Rate]]\n\n${historySource.replace('HISTORY_CHANGED_LINE','改訂後の長い日本語行')}`,'Create after-state for revision comparison');
 historyPage=await rpc('page_get',{site_id:site.site_id,page:historySlug,details:{wikitext:true,compiled:false}},{sessionToken:login.session_token,siteId:site.site_id,page:historySlug});
}
results.push({slug:historySlug,page_id:historyPage.page_id,revision_id:historyPage.revision_id,revision_number:historyPage.revision_number,source_sha256:crypto.createHash('sha256').update(historyPage.wikitext).digest('hex'),imported:true,history:true});
console.log(JSON.stringify({site:siteSlug,pages:results}));
