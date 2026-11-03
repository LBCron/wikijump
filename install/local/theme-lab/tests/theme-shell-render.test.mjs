import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {materializeThemeTestScenario} from '../src/theme-test-scenario-config.mjs';
import {renderThemeShellProfile,verifyRenderedShellAssetReplay} from '../src/theme-shell-render.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

test('Sigma-10 shell renderer binds source/runtime/site identity and emits only configured injection slots',async()=>{
  const config=JSON.parse(fs.readFileSync(path.join(root,'scenarios/jp-sigma10-extra-black-canonical.json'),'utf8'));
  const materialized=materializeThemeTestScenario(root,config),calls=[];
  const previewClient={preview:async input=>{calls.push(input);return {body:`<div>${input.title}</div>`,styles:[`/* ${input.title} */`]}}};
  const output=await renderThemeShellProfile({root,materialized,previewClient,siteId:17});
  assert.equal(calls.length,4);
  assert.deepEqual(Object.keys(output.injection).sort(),['navigationHtml','sidebarHtml']);
  assert.match(output.injection.navigationHtml,/navigation_top/u);
  assert.match(output.injection.sidebarHtml,/navigation_side/u);
  assert.equal(output.summary.scenario_sha256,materialized.scenario_sha256);
  assert.equal(output.summary.runtime_implementation_sha256,materialized.scenario.runtime.implementation_sha256);
  assert.equal(output.summary.site_state_sha256,materialized.scenario.branch_profile.site_state_sha256);
});

test('rendered-html shell profile cannot be accidentally sent through the Wikidot-source renderer',async()=>{
  const config=JSON.parse(fs.readFileSync(path.join(root,'scenarios/jp-sigma9-extra-black-canonical.json'),'utf8'));
  const materialized=materializeThemeTestScenario(root,config);
  await assert.rejects(()=>renderThemeShellProfile({root,materialized,previewClient:{preview:async()=>({body:'x',styles:[]})},siteId:17}),/wikidot-source/u);
});

test('Sigma-10 shell replays only manifest-bound local static assets inline and verifies their bytes',async()=>{
  const config=JSON.parse(fs.readFileSync(path.join(root,'scenarios/jp-sigma10-extra-black-canonical.json'),'utf8'));
  const materialized=materializeThemeTestScenario(root,config);
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'sigma10-migration/fixture-manifest.json'),'utf8'));
  const asset=manifest.transformations.find(row=>row.kind==='local-static-asset');
  const sourceUrl=`https://scpaiueouiuiuiui.wjfiles.localhost:18443/local--files/${asset.asset_file}`;
  const output=await renderThemeShellProfile({root,materialized,previewClient:{preview:async({title})=>({body:title.includes('navigation_side')?`<img src="${sourceUrl}">`:'<div>fixture</div>',styles:[]})},siteId:17});
  const replay=output.rendered.navigation_side.local_static_asset_replay;
  assert.equal(replay.length,1);
  assert.equal(replay[0].asset_sha256,asset.sha256);
  assert.equal(replay[0].replacements,1);
  assert.match(output.injection.sidebarHtml,/src="data:image\/png;base64,/u);
  assert.doesNotMatch(output.injection.sidebarHtml,/wjfiles\.localhost/u);
  verifyRenderedShellAssetReplay(root,materialized,output);
  const changed=structuredClone(output);
  changed.rendered.navigation_side.body=changed.rendered.navigation_side.body.replace('data:image/png','data:image/jpeg');
  assert.throws(()=>verifyRenderedShellAssetReplay(root,materialized,changed),/replay is stale/u);
});
