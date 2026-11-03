import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

export async function verifyThemeScenarioSiteState({root,materialized,rpcClient,siteSlug}){
  if(typeof rpcClient?.call!=='function')throw new Error('Deepwell RPC client is required for live site-state verification');
  if(siteSlug!==materialized.scenario.branch_profile.site_slug)throw new Error(`live site slug does not match scenario branch profile: ${siteSlug}`);
  const site=await rpcClient.call('site_get',{site:siteSlug});
  if(!Number.isSafeInteger(site?.site_id))throw new Error(`Theme Lab site is unavailable: ${siteSlug}`);
  const siteState=JSON.parse(fs.readFileSync(path.join(root,materialized.bindings.site_state.path),'utf8'));
  const manifest=JSON.parse(fs.readFileSync(path.join(root,materialized.bindings.corpus_manifest.path),'utf8'));
  const pageGet=page=>rpcClient.call('page_get',{site_id:site.site_id,page,details:{wikitext:true,compiled:false}});
  const observed={existing_pages:{},missing_pages:{},corpus_page:null};
  for(const slug of siteState.existing_pages??[]){const page=await pageGet(slug);if(page===null)throw new Error(`required existing page is absent: ${slug}`);observed.existing_pages[slug]={page_id:page.page_id,tags:page.tags??[]}}
  for(const slug of siteState.missing_pages??[]){const page=await pageGet(slug);if(page!==null)throw new Error(`required missing page unexpectedly exists: ${slug}`);observed.missing_pages[slug]={exists:false}}
  const required=manifest.site_state_requirements?.corpus_page;
  if(required){
    const page=await pageGet(required.slug);if(page===null)throw new Error(`canonical corpus saved page is absent: ${required.slug}`);
    const expectedSha=sha(fs.readFileSync(path.join(root,materialized.bindings.corpus_source.path)));
    const actualSha=sha(Buffer.from(page.wikitext??''));
    if(actualSha!==expectedSha)throw new Error('canonical corpus saved page source is stale');
    if(JSON.stringify(page.tags??[])!==JSON.stringify(required.tags??[]))throw new Error('canonical corpus saved page tags are stale');
    observed.corpus_page={slug:required.slug,page_id:page.page_id,revision_id:page.revision_id,source_sha256:actualSha,tags:page.tags};
  }
  return {schema:'theme_lab_live_site_state.v1',scenario_sha256:materialized.scenario_sha256,site_id:site.site_id,site_slug:siteSlug,declared_site_state_sha256:materialized.scenario.branch_profile.site_state_sha256,observed};
}
