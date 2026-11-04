import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {framerailSourceFingerprint,framerailSourceFingerprintSync} from '../src/framerail-source-fingerprint.mjs';

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'theme-framerail-fingerprint-'));
  fs.mkdirSync(path.join(root,'framerail/src'),{recursive:true});
  fs.mkdirSync(path.join(root,'framerail/static'),{recursive:true});
  fs.writeFileSync(path.join(root,'framerail/src/app.js'),'export const app=true;\n');
  fs.writeFileSync(path.join(root,'framerail/static/site.txt'),'static\n');
  for(const file of ['package.json','server.ts','sveltekit-options.ts','tsconfig.json','vite.config.ts'])fs.writeFileSync(path.join(root,'framerail',file),file+'\n');
  fs.writeFileSync(path.join(root,'pnpm-lock.yaml'),'lockfileVersion: 9\n');
  return root;
}

test('Framerail source fingerprint agrees between async and sync readers',async t=>{
  const root=fixture();t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  assert.equal(await framerailSourceFingerprint(root),framerailSourceFingerprintSync(root));
});

test('Framerail source fingerprint rejects runtime-source symlinks',async t=>{
  const root=fixture(),outside=fs.mkdtempSync(path.join(os.tmpdir(),'theme-framerail-outside-'));t.after(()=>{fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true})});
  const external=path.join(outside,'external.js');fs.writeFileSync(external,'export const external=true;\n');
  fs.symlinkSync(external,path.join(root,'framerail/src/external.js'));
  await assert.rejects(framerailSourceFingerprint(root),/cannot be a symlink/u);
  assert.throws(()=>framerailSourceFingerprintSync(root),/cannot be a symlink/u);
});
