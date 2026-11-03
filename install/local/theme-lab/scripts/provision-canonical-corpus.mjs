#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {deepwellRpcAuthorization} from '../../wikidot-verification/src/deepwell-rpc-auth.mjs';
import {fixtureRpcTarget} from '../src/fixture-rpc-target.mjs';
import {leasedPageEdit} from '../src/page-edit-lease.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const rpcUrl=fixtureRpcTarget().rpcUrl;
const siteSlug='scpaiueouiuiuiui';
const corpusSlug='run-owned:theme-lab-canonical-corpus-v1';
const existingSlug='run-owned:theme-lab-corpus-existing';
const missingSlug='run-owned:theme-lab-corpus-missing';
if(!/^[0-9a-f]{64}$/u.test(process.env.DEEPWELL_RPC_TOKEN??''))throw new Error('DEEPWELL_RPC_TOKEN is required');
if(!process.env.WIKIDOT_VERIFY_ADMIN_EMAIL||!process.env.WIKIDOT_VERIFY_ADMIN_PASS)throw new Error('local verification admin credentials are required');
const authorization=deepwellRpcAuthorization();let id=0;
async function rpc(method,params,context={}){const headers={authorization,'content-type':'application/json'};if(context.sessionToken)headers['X-Deepwell-Session-Token']=context.sessionToken;if(context.siteId)headers['X-Deepwell-Site-Id']=String(context.siteId);if(context.page)headers['X-Deepwell-Page']=context.page;const response=await fetch(rpcUrl,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});const body=await response.json();if(!response.ok||body.error)throw new Error(`${method} failed: ${JSON.stringify(body.error??response.status)}`);return body.result}
const site=await rpc('site_get',{site:siteSlug});if(!Number.isSafeInteger(site?.site_id))throw new Error('local Theme Lab site is unavailable');
if(site.site_id!==6000003)throw new Error('canonical Theme Lab fixture site ID differs from source-bound Caddy contract');
const login=await rpc('login',{name_or_email:process.env.WIKIDOT_VERIFY_ADMIN_EMAIL,password:process.env.WIKIDOT_VERIFY_ADMIN_PASS,ip_address:'127.0.0.1',user_agent:'theme-lab-canonical-corpus/1'});if(login?.needs_mfa!==false||typeof login.session_token!=='string')throw new Error('local admin login failed');
const session=await rpc('session_get',[login.session_token]);if(!Number.isSafeInteger(session?.user_id))throw new Error('local admin session is unavailable');
const context=slug=>({sessionToken:login.session_token,siteId:site.site_id,page:slug});
const get=slug=>rpc('page_get',{site_id:site.site_id,page:slug,details:{wikitext:true,compiled:false}},context(slug));
if(await get(missingSlug)!==null)throw new Error(`canonical missing-page sentinel unexpectedly exists: ${missingSlug}`);
async function ensure({slug,title,wikitext,tags}){
  let page=await get(slug);
  if(page===null){const created=await rpc('page_create',{site_id:site.site_id,wikitext,title,alt_title:null,slug,layout:'wikidot',revision_comments:'Create run-owned Theme Lab canonical corpus fixture',user_id:session.user_id,ip_address:'127.0.0.1',tags},context(slug));if(created?.parser_errors?.length)throw new Error(`${slug}: parser errors: ${JSON.stringify(created.parser_errors)}`);page=await get(slug)}
  else if(page.wikitext!==wikitext||JSON.stringify(page.tags)!==JSON.stringify(tags)){await leasedPageEdit((method,params)=>rpc(method,params,context(slug)),{site_id:site.site_id,page:page.page_id,last_revision_id:page.revision_id,revision_comments:'Refresh run-owned Theme Lab canonical corpus fixture',user_id:session.user_id,wikitext,tags,ip_address:'127.0.0.1'});page=await get(slug)}
  if(page===null||page.wikitext!==wikitext||JSON.stringify(page.tags)!==JSON.stringify(tags))throw new Error(`${slug}: round-trip verification failed`);
  return {slug,page_id:page.page_id,revision_id:page.revision_id,tags:page.tags,source_sha256:crypto.createHash('sha256').update(page.wikitext).digest('hex')};
}
const existing=await ensure({slug:existingSlug,title:'Theme Lab Existing Link Sentinel',wikitext:'This run-owned page intentionally exists for canonical theme link-state tests.\n',tags:['theme-lab-canonical-corpus']});
const corpusSource=await fs.readFile(path.join(root,'fixtures/theme-canonical-corpus-v1.wikidot.txt'),'utf8');
const corpus=await ensure({slug:corpusSlug,title:'Theme Lab Canonical Theme Corpus v1',wikitext:corpusSource,tags:['theme','theme-lab-canonical-corpus']});
if(await get(missingSlug)!==null)throw new Error(`canonical missing-page sentinel appeared during provisioning: ${missingSlug}`);
process.stdout.write(JSON.stringify({schema:'theme_lab_canonical_corpus_provision.v1',site_id:site.site_id,existing,corpus,missing:{slug:missingSlug,exists:false}},null,2)+'\n');
