#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {deepwellRpcAuthorization} from '../../wikidot-verification/src/deepwell-rpc-auth.mjs';
import {fixtureRpcTarget} from '../src/fixture-rpc-target.mjs';
import {leasedPageEdit} from '../src/page-edit-lease.mjs';

const root=path.dirname(fileURLToPath(import.meta.url));
const manifest=JSON.parse(await fs.readFile(path.join(root,'fixture-manifest.json'),'utf8'));
if(!/^[0-9a-f]{64}$/u.test(process.env.DEEPWELL_RPC_TOKEN??''))throw new Error('DEEPWELL_RPC_TOKEN is required');
if(process.env.THEME_LAB_BACKEND_PROJECT &&
   (!process.env.WIKIDOT_VERIFY_ADMIN_EMAIL||!process.env.WIKIDOT_VERIFY_ADMIN_PASS))
 throw new Error('task-owned Sigma-10 fixture provisioning requires explicit local-only admin credentials');
const adminEmail=process.env.WIKIDOT_VERIFY_ADMIN_EMAIL??'admin@wikijump';
const adminPassword=process.env.WIKIDOT_VERIFY_ADMIN_PASS??'wikijumpadmin1';
const authorization=deepwellRpcAuthorization(process.env.DEEPWELL_RPC_TOKEN);
const rpcUrl=fixtureRpcTarget().rpcUrl;
let id=0;
async function rpc(method,params,context={}){
 const headers={authorization,'content-type':'application/json'};
 if(context.sessionToken)headers['X-Deepwell-Session-Token']=context.sessionToken;
 if(context.siteId)headers['X-Deepwell-Site-Id']=String(context.siteId);
 if(context.page)headers['X-Deepwell-Page']=context.page;
 const response=await fetch(rpcUrl,{method:'POST',redirect:'error',headers,body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});
 const body=await response.json();
 if(!response.ok||body.error)throw new Error(`${method} failed: ${JSON.stringify(body.error??response.status)}`);
 return body.result;
}
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const site=await rpc('site_get',{site:'scpaiueouiuiuiui'});
if(site?.site_id!==6000003)throw new Error('Sigma-10 fixture site ID differs from source-bound Caddy contract');
if(!Number.isSafeInteger(site?.site_id))throw new Error('local authoring site is unavailable');
const login=await rpc('login',{name_or_email:adminEmail,password:adminPassword,ip_address:'127.0.0.1',user_agent:'theme-lab-sigma10-migration/1'});
if(login?.needs_mfa!==false||!login.session_token)throw new Error('local administrator session unavailable');
const session=await rpc('session_get',[login.session_token]);
if(!Number.isSafeInteger(session?.user_id))throw new Error('local administrator actor unavailable');
const context=slug=>({sessionToken:login.session_token,siteId:site.site_id,page:slug});
const results=[];
for(const fixture of manifest.fixtures){
 if(!fixture.slug.startsWith('run-owned:sigma10-'))throw new Error('fixture slug is outside migration ownership');
 const bytes=await fs.readFile(path.join(root,fixture.file));
 if(sha(bytes)!==fixture.sha256)throw new Error(`fixture hash mismatch: ${fixture.slug}`);
 const source=bytes.toString('utf8');
 const title=fixture.title;
 if(typeof title!=='string'||!title)throw new Error(`fixture title missing: ${fixture.slug}`);
 let page=await rpc('page_get',{site_id:site.site_id,page:fixture.slug,details:{wikitext:true,compiled:false}},context(fixture.slug));
 if(!page){
  await rpc('page_create',{site_id:site.site_id,wikitext:source,title,alt_title:null,slug:fixture.slug,layout:'wikidot',revision_comments:`Materialize frozen ${fixture.source_identity} into migration fixture`,user_id:session.user_id,ip_address:'127.0.0.1',tags:['theme-lab-sigma10-migration']},context(fixture.slug));
  page=await rpc('page_get',{site_id:site.site_id,page:fixture.slug,details:{wikitext:true,compiled:false}},context(fixture.slug));
 }else if(page.wikitext!==source||page.title!==title){
  await leasedPageEdit((method,params)=>rpc(method,params,context(fixture.slug)),{site_id:site.site_id,page:page.page_id,last_revision_id:page.revision_id,revision_comments:`Refresh frozen ${fixture.source_identity} migration fixture`,user_id:session.user_id,wikitext:source,title,tags:['theme-lab-sigma10-migration'],ip_address:'127.0.0.1'});
  page=await rpc('page_get',{site_id:site.site_id,page:fixture.slug,details:{wikitext:true,compiled:false}},context(fixture.slug));
 }
 if(!page||sha(page.wikitext)!==fixture.sha256)throw new Error(`fixture did not round-trip: ${fixture.slug}`);
 results.push({slug:fixture.slug,page_id:page.page_id,category_id:page.page_category_id,revision_id:page.revision_id,source_sha256:fixture.sha256});
}
// The dependent main/sidebar pages are first in the public source inventory.
// Rerender in reverse order once every local include exists.
for(const fixture of [...results].reverse())await rpc('page_rerender',{page_id:fixture.page_id,category_id:fixture.category_id,site_id:site.site_id},context(fixture.slug));
console.log(JSON.stringify({site:'scpaiueouiuiuiui',fixtures:results}));
