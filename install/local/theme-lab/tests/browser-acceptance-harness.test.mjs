import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {horizontalViewportEscape,assetDependenciesAreCurrent} from '../ports/interactive-visual-fixture/browser-acceptance-geometry.mjs';

const root=new URL('../',import.meta.url);
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');

test('acceptance shell fixtures are the current hash-bound SCP-JP header, navigation, and sidebar DOM',async()=>{
 for(const name of ['header','navigation','sidebar']){
  const html=await fs.readFile(new URL(`fixtures/scp-jp-${name}.html`,root));
  const metadata=JSON.parse(await fs.readFile(new URL(`fixtures/scp-jp-${name}.json`,root),'utf8'));
  assert.equal(sha(html),metadata.sha256??metadata.fixture_sha256,name);
 }
 const nav=await fs.readFile(new URL('fixtures/scp-jp-navigation.html',root),'utf8');
 assert.match(nav,/<div class="top-bar">/u);assert.match(nav,/<div class="mobile-top-bar">/u);
});

test('geometry captures escape on either viewport edge and asset reuse fails closed on stale inputs',()=>{
 assert.deepEqual(horizontalViewportEscape({left:-8,right:20},320),{off_left_px:8,off_right_px:0,pass:false});
 assert.deepEqual(horizontalViewportEscape({left:300,right:328},320),{off_left_px:0,off_right_px:8,pass:false});
 assert.equal(horizontalViewportEscape({left:0,right:320},320).pass,true);
 assert.equal(assetDependenciesAreCurrent([{name:'a.png',sha256:'a'.repeat(64),status:'local-cache'}]),true);
 assert.equal(assetDependenciesAreCurrent([{name:'a.png',sha256:null,status:'missing'}]),false);
 assert.equal(assetDependenciesAreCurrent(undefined),false);
});

