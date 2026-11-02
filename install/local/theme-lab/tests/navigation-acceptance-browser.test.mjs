import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {loadChromium} from '../src/browser-lab.mjs';
import {runKnownSurfaceContract,applySurfaceState} from '../src/theme-surface-contract.mjs';

test('page action reset leaves hover-triggered sidebar and uses a trusted click',async()=>{
  const browser=await loadChromium().launch({headless:true});
  try {
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    await page.setContent(`<!doctype html><style>
      #side-bar{position:fixed;inset:0 auto 0 0;width:30px;z-index:100}
      #side-bar:hover~#main-content::before{content:'';position:fixed;inset:0;z-index:99}
      #main-content{margin-left:100px;position:relative;z-index:1}
    </style><div id="side-bar"></div><div id="main-content">
      <button id="history-button">History</button><div id="action-area"></div></div>`);
    await page.evaluate(()=>document.querySelector('#history-button').addEventListener('click',event=>{
      window.historyClickTrusted=event.isTrusted;
      document.querySelector('#action-area').innerHTML='<table class="page-history"><tr id="revision-row-1"><td>Revision</td></tr></table>';
    }));
    await page.mouse.move(10,10);
    await page.waitForFunction(()=>document.querySelector('#side-bar').matches(':hover'));
    assert.equal(await page.locator('#side-bar').evaluate(element=>element.matches(':hover')),true);
    await applySurfaceState(page,'page.history','history-list');
    assert.equal(await page.evaluate(()=>window.historyClickTrusted),true);
    assert.equal(await page.locator('#side-bar').evaluate(element=>element.matches(':hover')),false);
  } finally {await browser.close();}
});

test('navigation acceptance inspects later menus and detects off-left escape without scroll overflow',async()=>{
  const server=http.createServer((request,response)=>response.end(`<!doctype html><html><head><style>
    body{margin:0} .mobile-top-bar>ul{display:flex;margin:0;padding:0;list-style:none}
    .mobile-top-bar>ul>li{position:relative;width:100px}
    .mobile-top-bar>ul>li>ul{position:absolute;left:0;top:20px;width:120px;padding:0;margin:0;display:none}
    .mobile-top-bar>ul>li:hover>ul{display:block} #top-bar .top-bar{display:none}.mobile-top-bar{display:block}
    </style></head><body><div id="top-bar"><div class="top-bar"><ul><li>Desktop<ul><li><a href="#">Hidden desktop link</a></li></ul></li></ul></div><div class="mobile-top-bar"><ul>
    ${[1,2,3].map(i=>`<li><a href="javascript:;">Menu ${i}</a><ul><li><a href="#">Link ${i}</a></li></ul></li>`).join('')}
    </ul></div></div></body></html>`));
  const browser=await loadChromium().launch({headless:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const page=await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    for(const left of [-300,300]) {
      const css=`.mobile-top-bar>ul>li:nth-child(2)>ul{left:${left}px}`;
      const result=await runKnownSurfaceContract(page,{css,styleId:'navigation-bound-canary',contractValue:'auto'});
      const failures=result.issues.filter(issue=>issue.kind==='surface_navigation_viewport_escape');
      assert.ok(failures.length>0);
      assert.ok(failures.some(issue=>left<0?issue.bounds.off_left_px>0:issue.bounds.off_right_px>0));
      if(left<0) {
        const themed=result.captures.find(row=>row.mode==='theme'&&row.surface==='nav.mobile-top');
        assert.equal(themed.document_width,themed.viewport_width);
        assert.ok(themed.navigation_bounds.length>3);
        assert.ok(themed.navigation_bounds.every(row=>row.owner==='nav.mobile-top'));
      }
    }
    await page.evaluate(()=>{document.querySelector('#navigation-bound-canary')?.remove();const style=document.createElement('style');style.textContent='.mobile-top-bar>ul>li:nth-child(2)>ul{left:400px}';document.head.append(style)});
    const inherited=await runKnownSurfaceContract(page,{css:'.mobile-top-bar{color:rgb(1,2,3)}',styleId:'navigation-inherited',contractValue:'auto'});
    assert.ok(inherited.captures.some(row=>row.mode==='baseline'&&row.navigation_bounds.some(bound=>bound.rect.right>row.viewport_width+1)));
    assert.equal(inherited.issues.filter(issue=>/surface_(?:navigation_viewport_escape|(?:new_)?viewport_overflow)/u.test(issue.kind)).length,0);
    const worsened=await runKnownSurfaceContract(page,{css:'.mobile-top-bar>ul>li:nth-child(2)>ul{left:420px}',styleId:'navigation-inherited',contractValue:'auto'});
    assert.ok(worsened.issues.some(issue=>issue.kind==='surface_navigation_viewport_escape'&&issue.bounds.off_right_px>issue.baseline_bounds.off_right_px+1));
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
});
