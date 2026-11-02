#!/usr/bin/env node
import fs from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixtureRpcTarget} from '../../src/fixture-rpc-target.mjs';
import {requireDeepwellRuntimeIdentity} from '../../src/deepwell-runtime-identity.mjs';
import {requireRuntimeSourceSha} from '../../src/runtime-source-identity.mjs';

const dir=path.dirname(fileURLToPath(import.meta.url));
const require=createRequire(path.resolve(dir,'../../../../../framerail/package.json'));
const {chromium}=require('@playwright/test');
const taskProject=process.env.THEME_LAB_BACKEND_PROJECT;
const contractArg=process.argv.find(arg=>arg.startsWith('--run-contract='))?.slice(15);
let contract=null;
if(taskProject){
 fixtureRpcTarget(); // Enforce exact task-owned backend routing even for browser writes.
 if(!contractArg||!path.isAbsolute(contractArg))throw new Error('isolated attachment provisioning requires an absolute --run-contract');
 contract=JSON.parse(fs.readFileSync(contractArg,'utf8'));
 if(contract?.target_site?.slug!=='scpaiueouiuiuiui')throw new Error('attachment fixture site differs from run contract');
 requireRuntimeSourceSha(contract.expected_runtime_source_sha256,'attachment run contract');
 requireDeepwellRuntimeIdentity(contract.expected_backend_runtime_identity,'attachment run contract');
 const url=new URL(contract.target_site.origin);
 if(url.protocol!=='https:'||url.hostname!=='scpaiueouiuiuiui.wikijump.localhost'||
    !url.port||url.port==='18443'||url.pathname!=='/'||url.search||url.hash)
  throw new Error('attachment provisioning requires a private task-owned contract HTTPS origin');
}else if(process.env.THEME_LAB_FIXTURE_SCOPE!=='shared-development'||contractArg){
 throw new Error('attachment writes require explicit shared-development scope or a task-owned run contract');
}
const origin=contract?.target_site?.origin??'https://scpaiueouiuiuiui.wikijump.dev.localhost:18443';
const fixture=`${origin}/run-owned%3Atheme-lab-visual-acceptance-imported-20260924`;
const filename='theme-lab-visual-fixture_日本語長名_320px_readability_and_download_controls.txt';
if(!process.env.WIKIDOT_VERIFY_ADMIN_EMAIL||!process.env.WIKIDOT_VERIFY_ADMIN_PASS)throw new Error('Use the established local verification admin environment');
const browser=await chromium.launch({headless:true});
try{
 const context=await browser.newContext({viewport:{width:1440,height:1000},ignoreHTTPSErrors:true});
 await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
 const page=await context.newPage();page.setDefaultTimeout(12000);
 const loginResponse=await page.goto(`${origin}/-/login`,{waitUntil:'domcontentloaded'});
 if(contract){
  const headers=loginResponse?await loginResponse.allHeaders():{};
  if(headers['x-theme-lab-runtime-source-sha']!==contract.expected_runtime_source_sha256||
     headers['x-theme-lab-backend-identity-sha']!==contract.expected_backend_runtime_identity.identity_sha256)
   throw new Error('attachment fixture page is not served by the source-bound task runtime');
 }
 await page.locator('.auth-name-or-email').fill(process.env.WIKIDOT_VERIFY_ADMIN_EMAIL);
 await page.locator('.auth-password').fill(process.env.WIKIDOT_VERIFY_ADMIN_PASS);
 await page.locator('#login button[type=submit]').click();
 await page.waitForFunction(()=>!document.querySelector('#login'));
 await page.goto(fixture,{waitUntil:'domcontentloaded'});await page.waitForTimeout(1100);
 await page.locator('#files-button').click();await page.locator('.file-list, table.page-files').first().waitFor();
 const row=page.locator('tr[id^="file-row-"], .file-row').filter({hasText:filename});
 if(process.argv.includes('--remove')){
 if(await row.count()){
   await row.locator('a').last().click();
   await row.waitFor({state:'detached'});
  }
  console.log(JSON.stringify({fixture_file:filename,operation:'removed',remaining:await row.count()}));
 }else if(!(await row.count())){
  // Current Framerail exposes the form behind #show-upload-button; the legacy
  // selectors remain for older panels (they also match the Restore button, so
  // the explicit button must win).
  const showUpload=page.locator('#show-upload-button');
  const uploadAction=await showUpload.count()?showUpload:page.locator('.file-action button.upload-file, .file-action input[type=button], .file-panel .buttons input[type=button]').first();
  await uploadAction.waitFor({state:'visible'});await uploadAction.click();await page.locator('#file-upload input[type=file]').waitFor();
  await page.locator('#file-upload input[type=file]').setInputFiles({name:filename,mimeType:'text/plain',buffer:Buffer.from('日本語の長いファイル名と添付欄のcontrast、折返し、control幅を確認するrun-owned file fixtureです。\n')});
  await page.locator('#file-upload input[name=name]').fill(filename);
  await page.locator('#file-upload textarea[name=comments]').fill('Theme Lab visual acceptance run-owned attachment');
  await page.locator('#file-upload button.button-upload, #file-upload input[type=submit]').first().click();
  await row.waitFor({state:'visible'});
  console.log(JSON.stringify({fixture_file:filename,operation:'uploaded',row_visible:true}));
 }else console.log(JSON.stringify({fixture_file:filename,operation:'already-present',row_visible:true}));
 await context.close();
}finally{await browser.close()}
