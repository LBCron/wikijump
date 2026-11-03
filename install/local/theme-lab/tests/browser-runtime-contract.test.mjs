import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runtimeDependencyFilesForObservation,runtimeSurfaceContractSha,runtimeFilesForObservation} from '../src/browser-runtime-contract.mjs';

test('normal page identity includes the rendered header and authenticated login shell',()=>{
  for(const viewport of ['desktop','mobile']){
    const files=runtimeFilesForObservation('page.normal',viewport);
    assert.ok(files.includes('framerail/src/lib/sigma-esque/wikidot.svelte'));
    assert.ok(files.includes('framerail/src/routes/+layout.svelte'));
    assert.ok(files.includes('framerail/src/routes/[slug]/[...extra]/PageView.svelte'));
    assert.equal(new Set(files).size,files.length);
  }
});

test('page-state identities bind the rendered tag wrapper and its escaped links',()=>{
  for(const surface of ['page.normal','page.history','page.source','page.tags']){
    const files=runtimeFilesForObservation(surface,'narrow-mobile');
    assert.ok(files.includes('framerail/src/routes/[slug]/[...extra]/WikidotFoundPageTags.svelte'));
    assert.ok(files.includes('framerail/src/lib/wikidot/wikidot-page-tags.ts'));
  }
});

test('every runtime surface identity includes the shared HTML, request and locale entrypoints',()=>{
  const common=['framerail/src/app.html','framerail/src/hooks.server.ts','framerail/src/routes/+layout.server.ts'];
  for(const surface of ['page.normal','page.history','page.files','nav.sidebar','shell.search','dialog.generic','content.tabview']){
    const files=runtimeFilesForObservation(surface,'desktop');
    for(const file of common)assert.ok(files.includes(file),`${surface}: ${file}`);
  }
});

test('runtime surface identity rejects symlinked Framerail inputs',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'theme-runtime-contract-')),outside=fs.mkdtempSync(path.join(os.tmpdir(),'theme-runtime-outside-'));t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true})});
  for(const file of runtimeFilesForObservation('page.normal','desktop')){
    const target=path.join(root,file);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,file+'\n');
  }
  assert.match(runtimeSurfaceContractSha(root,'page.normal','desktop'),/^[0-9a-f]{64}$/u);
  const linked='framerail/src/routes/[slug]/[...extra]/PageView.svelte',external=path.join(outside,'PageView.svelte');fs.writeFileSync(external,'external runtime');fs.rmSync(path.join(root,linked));fs.symlinkSync(external,path.join(root,linked));
  assert.throws(()=>runtimeSurfaceContractSha(root,'page.normal','desktop'),/cannot be a symlink/u);
});

test('runtime surface identity follows local static imports but scopes lazy panes to their surface',()=>{
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../../..');
  const normal=runtimeDependencyFilesForObservation(repo,'page.normal','desktop');
  const history=runtimeDependencyFilesForObservation(repo,'page.history','desktop');
  assert.ok(normal.includes('framerail/src/lib/server/wikidot-request-info.js'));
  assert.ok(normal.includes('framerail/src/routes/[slug]/[...extra]/PageView.svelte'));
  assert.equal(normal.includes('framerail/src/routes/[slug]/[...extra]/HistoryPane.svelte'),false);
  assert.ok(history.includes('framerail/src/routes/[slug]/[...extra]/HistoryPane.svelte'));
});
