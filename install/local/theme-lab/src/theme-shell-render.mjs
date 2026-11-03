import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

function escapeRegExp(value){return value.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')}

function replayFrozenLocalAssets(root,html){
  const manifestPath=path.join(root,'sigma10-migration/fixture-manifest.json');
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  let body=html;
  const replayed=[];
  for(const row of manifest.transformations??[]){
    if(row.kind!=='local-static-asset')continue;
    const assetFile=row.asset_file;
    if(typeof assetFile!=='string'||path.basename(assetFile)!==assetFile)throw new Error('invalid frozen shell asset path');
    const assetPath=path.join(root,'ports/shared-replay-assets',assetFile);
    const bytes=fs.readFileSync(assetPath);
    const digest=sha(bytes);
    if(digest!==row.sha256||!assetFile.startsWith(`${digest}.`))throw new Error(`frozen shell asset changed: ${assetFile}`);
    const extension=path.extname(assetFile).toLowerCase();
    const mediaType=extension==='.png'?'image/png':extension==='.jpg'||extension==='.jpeg'?'image/jpeg':extension==='.gif'?'image/gif':extension==='.svg'?'image/svg+xml':null;
    if(!mediaType)throw new Error(`unsupported frozen shell asset type: ${assetFile}`);
    const dataUrl=`data:${mediaType};base64,${bytes.toString('base64')}`;
    const filename=escapeRegExp(assetFile);
    const sourcePattern=new RegExp(`(\\bsrc\\s*=\\s*)([\"'])[^\"']*\\/local--files\\/${filename}(?:[?#][^\"']*)?\\2`,'giu');
    let replacements=0;
    body=body.replace(sourcePattern,(_match,prefix,quote)=>{replacements++;return `${prefix}${quote}${dataUrl}${quote}`});
    if(replacements)replayed.push({asset_file:assetFile,source_url:row.source_url,asset_sha256:digest,media_type:mediaType,replacements});
  }
  return {body,replayed};
}

export function verifyRenderedShellAssetReplay(root,materialized,renderedShell){
  const summary=renderedShell?.summary;
  if(!summary||!Array.isArray(summary.local_static_asset_replay))throw new Error('rendered shell local asset replay is missing');
  for(const [name,row] of Object.entries(renderedShell.rendered??{})){
    if(typeof row.source_body!=='string'||sha(Buffer.from(row.source_body))!==row.source_body_sha256)throw new Error(`rendered shell source body hash is invalid: ${name}`);
    const replay=replayFrozenLocalAssets(root,row.source_body);
    if(replay.body!==row.body||sha(Buffer.from(replay.body))!==row.body_sha256||JSON.stringify(replay.replayed)!==JSON.stringify(row.local_static_asset_replay??[]))throw new Error(`rendered shell local asset replay is stale: ${name}`);
    const sourceStyles=Array.isArray(row.styles)?row.styles:[];
    if(sha(Buffer.from(JSON.stringify(sourceStyles)))!==row.styles_sha256)throw new Error(`rendered shell styles hash is invalid: ${name}`);
    const expected=summary.fragments?.[name];
    if(expected?.source_body_sha256!==row.source_body_sha256||expected?.body_sha256!==row.body_sha256||expected?.styles_sha256!==row.styles_sha256||expected?.styles_count!==sourceStyles.length)throw new Error(`rendered shell fragment summary is stale: ${name}`);
  }
  const replayRows=Object.values(renderedShell.rendered??{}).flatMap(row=>row.local_static_asset_replay??[]);
  if(JSON.stringify(replayRows)!==JSON.stringify(summary.local_static_asset_replay))throw new Error('rendered shell asset replay differs from its summary');
  for(const [slot,name] of Object.entries(materialized.bindings.shell_injection)){
    if(typeof renderedShell.injection?.[slot]!=='string'||renderedShell.injection[slot]!==renderedShell.rendered?.[name]?.body)throw new Error(`rendered shell injection differs from the verified fragment: ${slot}`);
  }
}

export async function renderThemeShellProfile({root,materialized,previewClient,siteId}){
  if(materialized?.scenario?.shell_profile?.format!=='wikidot-source')throw new Error('shell rendering requires a wikidot-source shell profile');
  if(!Number.isSafeInteger(siteId))throw new Error('siteId is required for shell rendering');
  if(typeof previewClient?.preview!=='function')throw new Error('Deepwell preview client is required for shell rendering');
  const rendered={};
  for(const [name,binding] of Object.entries(materialized.bindings.shell).sort(([a],[b])=>a.localeCompare(b))){
    const source=fs.readFileSync(new URL(binding.path,`file://${root.endsWith('/')?root:`${root}/`}`),'utf8');
    if(sha(Buffer.from(source))!==binding.sha256)throw new Error(`shell source changed after scenario materialization: ${name}`);
    const result=await previewClient.preview({siteId,title:`Theme Lab shell ${name}`,wikitext:source,syntaxOnly:false});
    const styles=Array.isArray(result.styles)?result.styles:[];
    const replay=replayFrozenLocalAssets(root,result.body);
    rendered[name]={body:replay.body,body_sha256:sha(Buffer.from(replay.body)),source_body:result.body,source_body_sha256:sha(Buffer.from(result.body)),styles,styles_sha256:sha(Buffer.from(JSON.stringify(styles))),local_static_asset_replay:replay.replayed};
  }
  const injection={};
  for(const [slot,name] of Object.entries(materialized.bindings.shell_injection))injection[slot]=rendered[name]?.body??null;
  const summary={schema:'theme_lab_rendered_shell.v1',scenario_sha256:materialized.scenario_sha256,runtime_implementation_sha256:materialized.scenario.runtime.implementation_sha256,source_shell_sha256:materialized.scenario.shell_profile.shell_sha256,injection_sha256:materialized.scenario.shell_profile.injection_sha256,site_state_sha256:materialized.scenario.branch_profile.site_state_sha256,site_id:siteId,local_static_asset_replay:Object.values(rendered).flatMap(row=>row.local_static_asset_replay),fragments:Object.fromEntries(Object.entries(rendered).map(([name,row])=>[name,{body_sha256:row.body_sha256,source_body_sha256:row.source_body_sha256,styles_sha256:row.styles_sha256,styles_count:row.styles.length}]))};
  return {summary,injection,rendered};
}
