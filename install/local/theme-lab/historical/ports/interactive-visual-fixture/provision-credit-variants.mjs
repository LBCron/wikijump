#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {deepwellRpcAuthorization} from '../../../wikidot-verification/src/deepwell-rpc-auth.mjs';
import {fixtureRpcTarget} from '../../src/fixture-rpc-target.mjs';

const dir=path.dirname(fileURLToPath(import.meta.url));
const origin=fixtureRpcTarget().rpcUrl;
const siteSlug='scpaiueouiuiuiui';
if(!/^[0-9a-f]{64}$/u.test(process.env.DEEPWELL_RPC_TOKEN??''))throw new Error('DEEPWELL_RPC_TOKEN is required from the local-only environment');
if(!process.env.WIKIDOT_VERIFY_ADMIN_EMAIL||!process.env.WIKIDOT_VERIFY_ADMIN_PASS)throw new Error('Use the established local verification admin environment');
const authorization=deepwellRpcAuthorization(process.env.DEEPWELL_RPC_TOKEN);
let requestId=0;
async function rpc(method,params,context={}){
 const headers={authorization,'content-type':'application/json'};
 if(context.sessionToken)headers['X-Deepwell-Session-Token']=context.sessionToken;
 if(context.siteId)headers['X-Deepwell-Site-Id']=String(context.siteId);
 if(context.page)headers['X-Deepwell-Page']=context.page;
 const response=await fetch(origin,{method:'POST',redirect:'error',headers,body:JSON.stringify({jsonrpc:'2.0',id:++requestId,method,params})});
 const body=await response.json();if(!response.ok||body.error)throw new Error(`${method} failed: ${JSON.stringify(body.error??response.status)}`);return body.result;
}
const site=await rpc('site_get',{site:siteSlug});
if(site?.site_id!==6000003)throw new Error('Theme Lab fixture site ID differs from source-bound Caddy contract');
const login=await rpc('login',{name_or_email:process.env.WIKIDOT_VERIFY_ADMIN_EMAIL,password:process.env.WIKIDOT_VERIFY_ADMIN_PASS,ip_address:'127.0.0.1',user_agent:'theme-lab-credit-variant-fixture/1'});
if(login?.needs_mfa!==false||typeof login.session_token!=='string')throw new Error('Local verification admin session was not established');
const session=await rpc('session_get',[login.session_token]);
const variants=[
 {slug:'run-owned:theme-lab-visual-credit-no-rate-20260924',title:'SCP-JP Theme Lab Credit Fixture (no Rate in credit)',file:'fixture-no-rate.wikidot.txt',page_id:3_001_592_427,tags:['theme-lab-visual-acceptance','jp','日本語']},
 {slug:'run-owned:theme-lab-visual-credit-heritage-20260924',title:'SCP-JP Theme Lab Credit Fixture (heritage)',file:'fixture-heritage.wikidot.txt',page_id:3_001_592_428,tags:['theme-lab-visual-acceptance','jp','日本語','殿堂入り']}
];
const result=[];
for(const item of variants){
 const source=await fs.readFile(path.join(dir,item.file),'utf8');
 let current=await rpc('page_get',{site_id:site.site_id,page:item.slug,details:{wikitext:true,compiled:false}},{sessionToken:login.session_token,siteId:site.site_id,page:item.slug});
 if(!current){
  const createdAt=new Date().toISOString();
  await rpc('import_wikidot_page',{page_id:item.page_id,site_id:site.site_id,created_at:createdAt,slug:item.slug,locked:false,discussion_thread_id:null,ip_address:'127.0.0.1'},{sessionToken:login.session_token,siteId:site.site_id,page:item.slug});
  const revisionDate=`${createdAt.slice(0,10)} ${createdAt.slice(11,19)}.0 +00:00:00`;
  await rpc('import_wikidot_page_revision',{revision_id:2_200_000_000+crypto.randomInt(0,100_000_000),revision_type:'create',created_at:revisionDate,updated_at:null,revision_number:0,page_id:item.page_id,site_id:site.site_id,user_id:session.user_id,wikitext:source,comments:'Create run-owned credit variant fixture',title:item.title,slug:item.slug,tags:item.tags},{sessionToken:login.session_token,siteId:site.site_id,page:item.slug});
  current=await rpc('page_get',{site_id:site.site_id,page:item.slug,details:{wikitext:true,compiled:false}},{sessionToken:login.session_token,siteId:site.site_id,page:item.slug});
 }else if(current.wikitext!==source||JSON.stringify(current.tags)!==JSON.stringify(item.tags)){
  await rpc('page_edit',{site_id:site.site_id,page:current.page_id,last_revision_id:current.revision_id,revision_comments:'Refresh run-owned credit acceptance variant',user_id:session.user_id,wikitext:source,tags:item.tags,ip_address:'127.0.0.1'},{sessionToken:login.session_token,siteId:site.site_id,page:item.slug});
  current=await rpc('page_get',{site_id:site.site_id,page:item.slug,details:{wikitext:true,compiled:false}},{sessionToken:login.session_token,siteId:site.site_id,page:item.slug});
 }
 if(!current||current.wikitext!==source||JSON.stringify(current.tags)!==JSON.stringify(item.tags))throw new Error(`Credit variant failed source/tag verification: ${item.slug}`);
 result.push({slug:item.slug,page_id:current.page_id,revision_id:current.revision_id,source_sha256:crypto.createHash('sha256').update(current.wikitext).digest('hex'),tags:current.tags});
}
console.log(JSON.stringify({site:siteSlug,variants:result}));
