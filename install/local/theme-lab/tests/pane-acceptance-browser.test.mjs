import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {loadChromium} from '../src/browser-lab.mjs';
import {FILES_PANE_SELECTOR,FILES_ROW_SELECTOR,applySurfaceState,cleanupSurfaceState,runKnownSurfaceContract} from '../src/theme-surface-contract.mjs';

test('surface acceptance opens History and Files independently and closes each pane',async()=>{
 const server=http.createServer((request,response)=>response.end(`<!doctype html><html><body>
 <button id="history-button">History</button><button id="files-button">Files</button><div id="action-area"></div>
 <script>
 const area=document.getElementById('action-area');window.opened=[];
 function show(kind,html){window.opened.push(kind);area.innerHTML='<button class="action-area-close">Close</button>'+html;area.querySelector('button').onclick=()=>area.innerHTML=''}
 document.getElementById('history-button').onclick=()=>show('history','<table class="page-history"><tr id="revision-row-27"><td>Revision 27</td></tr></table>');
 document.getElementById('files-button').onclick=()=>show('files','<div class="file-list"><span class="file-name">attachment.png</span></div>');
 </script></body></html>`));
 const browser=await loadChromium().launch({headless:true});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result=await runKnownSurfaceContract(page,{css:'.page-history,.file-list{color:black}',styleId:'pane-check',contractValue:'auto'});
  assert.equal(result.issues.filter(row=>row.severity==='error').length,0);
  assert.deepEqual(await page.evaluate(()=>window.opened),['history','history','history','history','files','files','files','files']);
  assert.equal(await page.locator('#action-area').textContent(),'');
  assert.ok(result.captures.every(capture=>Object.values(capture.rows).every(row=>row.present)));
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
});

test('surface cleanup closes History and Files when a mobile drawer covers the close button',async()=>{
 const server=http.createServer((request,response)=>response.end(`<!doctype html><html><head><style>#drawer-overlay{display:none;position:fixed;inset:80px 0 0;z-index:20;background:#eee}</style></head><body>
 <button id="history-button">History</button><button id="files-button">Files</button><div id="action-area" style="margin-top:100px"></div><div id="drawer-overlay"></div>
 <script>
 const area=document.getElementById('action-area');window.opened=[];
 function show(kind,html){window.opened.push(kind);area.innerHTML='<button class="action-area-close">Close</button>'+html;area.querySelector('button').onclick=()=>area.innerHTML='';document.getElementById('drawer-overlay').style.display='block'}
 document.getElementById('history-button').onclick=()=>show('history','<table class="page-history"><tr id="revision-row-27"><td>Revision 27</td></tr></table>');
 document.getElementById('files-button').onclick=()=>show('files','<div class="file-list"><span class="file-name">attachment.png</span></div>');
 </script></body></html>`));
 const browser=await loadChromium().launch({headless:true});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const page=await browser.newPage({viewport:{width:390,height:844}});await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for(const [surface,state] of [['page.history','history-list'],['page.files','attachment-list']]){
   await applySurfaceState(page,surface,state);
   await cleanupSurfaceState(page,surface,state);
   assert.equal(await page.locator('#action-area').textContent(),'');
  }
  assert.deepEqual(await page.evaluate(()=>window.opened),['history','files']);
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
});

test('Files surface accepts the maintained empty attachment list',async()=>{
 const server=http.createServer((request,response)=>response.end(`<!doctype html><html><body>
 <button id="history-button">History</button><button id="files-button">Files</button><div id="action-area"></div>
 <script>
 const area=document.getElementById('action-area');
 document.getElementById('files-button').onclick=()=>{area.innerHTML='<button class="action-area-close">Close</button><div class="file-list">No files attached to this page</div>';area.querySelector('.action-area-close').onclick=()=>area.innerHTML=''};
 </script></body></html>`));
 const browser=await loadChromium().launch({headless:true});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result=await runKnownSurfaceContract(page,{css:'.file-list,.file-name{color:black}',styleId:'empty-files-check',contractValue:'auto'});
  assert.equal(result.issues.filter(row=>row.severity==='error').length,0);
  const captures=result.captures.filter(capture=>capture.surface==='page.files');
  assert.equal(captures.length,4);
  assert.ok(captures.every(capture=>capture.rows[FILES_PANE_SELECTOR]?.present));
  assert.ok(captures.every(capture=>capture.rows[FILES_ROW_SELECTOR]?.optional===true));
  assert.ok(captures.every(capture=>capture.rows[FILES_ROW_SELECTOR]?.present===false));
  assert.equal(await page.locator('#action-area').textContent(),'');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
});

test('Files surface accepts the Wikidot PageFilesModule DOM (table.page-files, tr#file-row-N)',async()=>{
 const server=http.createServer((request,response)=>response.end(`<!doctype html><html><body>
 <button id="history-button">History</button><button id="files-button">Files</button><div id="action-area"></div>
 <script>
 const area=document.getElementById('action-area');
 document.getElementById('files-button').onclick=()=>{area.innerHTML='<button class="action-area-close">Close</button><h1>Files</h1><div class="file-list-scroll"><table class="table table-striped table-hover page-files"><tbody><tr id="file-row-32"><td>attachment.png</td></tr></tbody></table></div>';area.querySelector('.action-area-close').onclick=()=>area.innerHTML=''};
 </script></body></html>`));
 const browser=await loadChromium().launch({headless:true});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result=await runKnownSurfaceContract(page,{css:'.page-files,.file-list{color:black}',styleId:'wikidot-files-check',contractValue:'auto'});
  assert.equal(result.issues.filter(row=>row.severity==='error').length,0);
  const captures=result.captures.filter(capture=>capture.surface==='page.files');
  assert.equal(captures.length,4);
  assert.ok(captures.every(capture=>capture.rows[FILES_PANE_SELECTOR]?.present));
  assert.ok(captures.every(capture=>capture.rows[FILES_ROW_SELECTOR]?.present===true));
  assert.equal(await page.locator('#action-area').textContent(),'');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
});

test('Files surface fails closed when the pane never appears',async()=>{
 const server=http.createServer((request,response)=>response.end(`<!doctype html><html><body>
 <button id="history-button">History</button><button id="files-button">Files</button><div id="action-area"></div>
 <script>document.getElementById('files-button').onclick=()=>{document.getElementById('action-area').innerHTML='<h1>Files</h1><p>loading</p>'};</script></body></html>`));
 const browser=await loadChromium().launch({headless:true});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {
  const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result=await runKnownSurfaceContract(page,{css:'.page-files{color:black}',styleId:'absent-files-check',contractValue:'auto'});
  assert.ok(result.issues.some(row=>row.severity==='error'&&row.surface==='page.files'),'an absent Files pane must be an error finding');
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
});
