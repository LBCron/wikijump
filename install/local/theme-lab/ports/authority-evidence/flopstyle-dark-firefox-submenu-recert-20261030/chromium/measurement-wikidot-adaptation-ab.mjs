#!/usr/bin/env node
// Explicit read-only acquisition, followed by offline browser-only A/B.
// No editing UI, module mutations, page saves, or browser-origin POSTs.
import fs from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {ReferenceCache, sha256Hex} from '../src/reference-cache.mjs';
import {startReferenceReplay} from '../src/reference-replay.mjs';
import {loadBrowser} from '../src/browser-lab.mjs';
import {loadFrozenPagePreview,applyFrozenPagePreview} from '../src/frozen-page-preview-replay.mjs';
import {loadFrozenHistoryReplay,applyFrozenHistoryReplay} from '../src/frozen-history-replay.mjs';
import {materializeCandidateCssAssets} from '../src/local-assets.mjs';
import {measureVisibleTextBounds} from '../src/visible-text-bounds.mjs';
import {measureGeneratedTextLines} from '../src/generated-text-lines.mjs';
import {openSigma10CreditView,openSigma10CreditOtherwise,returnSigma10CreditView} from '../src/sigma10-credit-actions.mjs';
import {viewportEscape, closedDrawerBounds} from '../src/viewport-bounds.mjs';
import {activateNavigationControl} from '../src/navigation-interaction.mjs';
import {dedupeCssLayers} from '../src/css-layers.mjs';

async function settleAnimations(page) {
  await page.evaluate(()=>{for(const animation of document.getAnimations())if(Number.isFinite(animation.effect?.getTiming().iterations))try{animation.finish()}catch{}});
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}

export function removeNamedBlock(css, name) {
  const comments = [...css.matchAll(/\/\*([\s\S]*?)\*\//gu)];
  const start = comments.findIndex(row => row[1].replace(/\s+/gu, ' ').trim() === name);
  if (start < 0) throw new Error(`adaptation block missing: ${name}`);
  // Each named block is delimited by an authority marker, not an internal
  // rationale comment. Never match selectors or theme names as exceptions.
  const next = comments.slice(start + 1).find(row => /^(?:SCP-JP|Campaign JP|JP runtime)\b/u.test(row[1].trim()));
  return css.slice(0, comments[start].index) + css.slice(next?.index ?? css.length);
}

export async function confineReadOnlyReplay(context, origin, blocked) {
  // WebSockets bypass HTTP route handlers. Close their page-side route before
  // connecting to a server so frozen scripts have no alternate write channel.
  await context.routeWebSocket('**/*', socket => {
    blocked.push({method:'WEBSOCKET',url:socket.url().split('?')[0]});
    socket.close();
  });
  await context.route('**/*', async route => {
    const request=route.request();
    if(request.method()!=='GET' || !request.url().startsWith(origin+'/')) {
      blocked.push({method:request.method(),url:request.url().split('?')[0]});
      return route.abort();
    }
    return route.continue();
  });
}

export async function runAdaptationAB({url, cacheDir, css = '', withoutCss = '', baseCss = '',
  removeBlock = null, assetDir, outputDir, acquire = false, widths = [320,390],
  state = 'navigation', computedContract = [], selectors = ['#header'], browserEngine = 'chromium', executablePath = null, frozenHistory = null, frozenPagePreview = null, creditScrollToBottom = false}) {
  if(creditScrollToBottom&&state!=='credit-fold-return')throw new Error('scrolled credit return requires the native return state');
  if(frozenPagePreview&&!['article-table','second-tab-selected','credit-fold-view','credit-fold-otherwise','credit-fold-return'].includes(state))throw new Error('frozen page preview is scoped to native tables/tabs');
  const previewEntry=frozenPagePreview?await loadFrozenPagePreview(frozenPagePreview,url):null;
  let previewDependencies=[];
  if(frozenHistory&&state!=='history-list')throw new Error('frozen history is scoped to history-list');
  if(state==='history-list'&&!frozenHistory)throw new Error('history-list requires bound native responses');
  const historyEntries=frozenHistory?await loadFrozenHistoryReplay(frozenHistory,url):null;
  if (state === 'sidebar-closed' && (selectors.length !== 1 || selectors[0] !== '#side-bar')) throw new Error('sidebar-closed requires exactly #side-bar');
  const measurementSources=await Promise.all([fileURLToPath(import.meta.url),fileURLToPath(new URL('../src/viewport-bounds.mjs',import.meta.url)),fileURLToPath(new URL('../src/navigation-interaction.mjs',import.meta.url)),fileURLToPath(new URL('../src/css-layers.mjs',import.meta.url)),...(historyEntries?[fileURLToPath(new URL('../src/frozen-history-replay.mjs',import.meta.url))]:[]),...(previewEntry?[fileURLToPath(new URL('../src/frozen-page-preview-replay.mjs',import.meta.url))]:[]),...(state==='header-line-layout'?[fileURLToPath(new URL('../src/generated-text-lines.mjs',import.meta.url))]:[]),...(state.startsWith('credit-fold-')?[fileURLToPath(new URL('../src/sigma10-credit-actions.mjs',import.meta.url))]:[])].map(async source=>({source,bytes:await fs.readFile(source)})));
  const cache = new ReferenceCache({cacheDir});
  const barrier=path.join(cache.cacheDir,`adaptation-ab-${sha256Hex(url)}.acquiring`);
  await fs.mkdir(cache.cacheDir,{recursive:true});
  try { await fs.access(barrier); throw new Error(`unfinished reference acquisition: ${barrier}`); }
  catch(error) { if(error.code!=='ENOENT')throw error; }
  const retained=await cache.snapshot(url);
  if(acquire && !retained) await fs.writeFile(barrier,JSON.stringify({url,started_at:new Date().toISOString(),method:'GET',public_writes:0})+'\n',{flag:'wx'});
  const acquisition = await cache.acquire(url, {offline: !acquire});
  const snapshot = await cache.snapshot(url);
  if(acquire && !retained) await fs.unlink(barrier);
  const replay = await startReferenceReplay({cache, rootUrl: url});
  const browserType = loadBrowser(browserEngine,path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../framerail'));
  executablePath??=browserEngine==='chromium'?'/usr/bin/google-chrome':browserType.executablePath();
  // An explicit rejecting proxy avoids WebKit inheriting workstation proxy
  // lookup settings while keeping this replay's loopback traffic direct.
  const webkitProxy=browserEngine==='webkit'?http.createServer((_request,response)=>{response.writeHead(403);response.end()}):null;
  if(webkitProxy){
    webkitProxy.on('connect',(_request,socket)=>socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'));
    await new Promise((resolve,reject)=>{webkitProxy.once('error',reject);webkitProxy.listen(0,'127.0.0.1',resolve)});
  }
  let browser;
  await fs.mkdir(outputDir, {recursive: true});
  const rows = [], blocked = [];
  const variants = {without: removeBlock ? removeNamedBlock(css, removeBlock) : withoutCss, with: css};
  try {
    browser=await browserType.launch({headless:true,executablePath,...(webkitProxy?{proxy:{server:`http://127.0.0.1:${webkitProxy.address().port}`,bypass:'127.0.0.1,localhost'}}:{})});
    for (const width of widths) for (const [variant, sourceCss] of Object.entries(variants)) {
      const context = await browser.newContext({viewport: {width, height:844}, serviceWorkers:'block'});
      // Only loopback replay GETs are admitted. Original scripts cannot write
      // to any site or acquire an edit lock, even if a frozen script executes.
      await confineReadOnlyReplay(context,replay.origin,blocked);
      const page = await context.newPage();
      await page.goto(replay.entryUrl, {waitUntil:'load'});
      if(historyEntries)await applyFrozenHistoryReplay(page,historyEntries);
      if(previewEntry)previewDependencies=await applyFrozenPagePreview(page,previewEntry,{cache,replay,state});
      const effectiveCss = dedupeCssLayers([baseCss, sourceCss]).join('\n');
      if (effectiveCss) await page.addStyleTag({content: assetDir ? await materializeCandidateCssAssets(effectiveCss, assetDir) : effectiveCss});
      await page.evaluate(() => {document.documentElement.getBoundingClientRect();return document.fonts.ready;});
      await settleAnimations(page);
      const initialHash=await page.evaluate(()=>location.hash);
      let interactionError=null;
      try {
        if(state==='credit-fold-view')await openSigma10CreditView(page);
        if(['credit-fold-otherwise','credit-fold-return'].includes(state))await openSigma10CreditOtherwise(page);
        if(state==='credit-fold-return'){
          if(creditScrollToBottom)await page.locator('#u-credit-otherwise .credit.otherwise').evaluate(element=>element.scrollTop=element.scrollHeight);
          await returnSigma10CreditView(page);
        }
      } catch(error) { interactionError=error.message; }
      if(state.startsWith('credit-fold-'))await settleAnimations(page);
      if(['credit-license','credit-otherwise'].includes(state)){
        await page.evaluate(state=>{location.hash=state==='credit-otherwise'?'u-credit-otherwise':'u-credit-view'},state);
        await page.waitForFunction(id=>document.querySelector(id)?.matches(':target'),'#'+(state==='credit-otherwise'?'u-credit-otherwise':'u-credit-view'));
        await page.evaluate(()=>{for(const animation of document.getAnimations()){if(Number.isFinite(animation.effect?.getTiming().iterations))try{animation.finish()}catch{}}});
        await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      }
      if(state==='sidebar-open'){try{await page.locator('.mobile-top-bar .open-menu a').click({timeout:3000});await page.waitForFunction(()=>location.hash==='#side-bar',null,{timeout:3000});await page.evaluate(()=>{for(const a of document.getAnimations())if(Number.isFinite(a.effect?.getTiming().iterations))try{a.finish()}catch{}});await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))))}catch(error){interactionError=error.message}}
      if (state === 'search-hover') await page.locator('#search-top-box-form').hover();
      const count = ['navigation','navigation-action'].includes(state)
        ? await page.locator('.mobile-top-bar > ul > li').evaluateAll(nodes => nodes.filter(n => n.querySelector(':scope > ul')).length)
        : state === 'desktop-navigation'
          ? await page.locator('#top-bar .top-bar > ul > li').evaluateAll(nodes => nodes.filter(n => n.querySelector(':scope > ul')).length)
          : 1;
      if (!count) throw new Error(`real Wikidot ${state} submenu contract missing`);
      for (let index=0; index<count; index++) {
        if (state === 'navigation-action') {
          await page.mouse.move(0, 0);
          const item = page.locator('.mobile-top-bar > ul > li:has(> ul)').nth(index);
          interactionError = null;
          try { await activateNavigationControl(page, item.locator(':scope > a').first(), item.locator(':scope > ul')); }
          catch (error) { interactionError = error.message; }
          await settleAnimations(page);
        }
        if(state==='desktop-navigation'){
          interactionError=null;
          try {
          const item=page.locator('#top-bar .top-bar > ul > li:has(> ul)').nth(index);
          await item.hover({timeout:2000});
          await page.waitForFunction(index=>{
            const items=[...document.querySelectorAll('#top-bar .top-bar > ul > li')].filter(row=>row.querySelector(':scope > ul'));
            const submenu=items[index]?.querySelector(':scope > ul');if(!submenu)return false;
            const style=getComputedStyle(submenu),rect=submenu.getBoundingClientRect();
            return style.display!=='none'&&style.visibility!=='hidden'&&Number(style.opacity)>0.99&&rect.width>0&&rect.height>0;
          },index,{timeout:5000});
          await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
          } catch(error) { interactionError=error.message; }
        }
        const headerInk = state==='header-title-search' ? await measureVisibleTextBounds(page,['#header h1','#header h2']) : null;
        const generatedLines = state==='header-line-layout' ? await measureGeneratedTextLines(page,selectors) : null;
        const measurement = await page.evaluate(({state,index,selectors,headerInk,computedContract,initialHash}) => {
          let submenu = null;
          if (state === 'navigation') {
            const parents = [...document.querySelectorAll('.mobile-top-bar > ul > li')].filter(n=>n.querySelector(':scope > ul'));
            submenu = parents[index].querySelector(':scope > ul');
            for (const node of parents.map(n=>n.querySelector(':scope > ul'))) node.style.removeProperty('display');
            // Visibility only: preserves the real menu's sizing/positioning.
            submenu.style.setProperty('display','block','important');
            submenu.style.setProperty('visibility','visible','important');
            submenu.style.setProperty('opacity','1','important');
          } else if (state === 'navigation-action') {
            const parents = [...document.querySelectorAll('.mobile-top-bar > ul > li')].filter(n=>n.querySelector(':scope > ul'));
            submenu = parents[index]?.querySelector(':scope > ul') ?? null;
          } else if (state === 'desktop-navigation') {
            const parents=[...document.querySelectorAll('#top-bar .top-bar > ul > li')].filter(node=>node.querySelector(':scope > ul'));
            submenu=parents[index]?.querySelector(':scope > ul')??null;
          }
          const input = document.querySelector('#search-top-box-input');
          if (state === 'search-focus' && input) { input.focus(); input.value='Theme Lab'; }
          const probes = submenu ? [submenu,...submenu.querySelectorAll('li, a')].map(el=>({el,selector:el===submenu?'submenu':el.tagName.toLowerCase(),pseudo:null})) : selectors.flatMap(selector=>{
            const match=selector.match(/^(.*?)(::before|::after)$/u),base=match?.[1]??selector,pseudo=match?.[2]??null;
            const elements=[...document.querySelectorAll(base)];
            return (state.startsWith('credit-fold-')&&selector==='#u-credit-view .modalbox'?elements.slice(0,1):elements).map(el=>({el,selector,pseudo}));
          });
          const overlaps=[];
          const navigation_row_layout=state==='navigation-row-layout'?(()=>{const bar=document.querySelector('#top-bar').getBoundingClientRect();return [...document.querySelectorAll('#top-bar :is(.mobile-top-bar,.top-bar) > ul > li > a')].filter(el=>getComputedStyle(el).display!=='none'&&el.getBoundingClientRect().width>0).map(el=>{const range=document.createRange();range.selectNodeContents(el);return{label:el.textContent,bar:bar.toJSON(),ink:[...range.getClientRects()].filter(r=>r.width>0&&r.height>0).map(r=>r.toJSON())}})})():null;
          const controlOcclusion=state==='credit-license'?[...document.querySelectorAll('#u-credit-view a[href="#u-credit-otherwise"]')].map(control=>{
            const rect=control.getBoundingClientRect();
            const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
            return{selector:'#u-credit-view a[href="#u-credit-otherwise"]',visible:rect.width>0&&rect.height>0,clickable:hit===control||control.contains(hit),hit:hit?`${hit.tagName}.${hit.className}`:null};
          }):[];
          if(state==='header-title-search') {
            // The form wrapper can include empty positioning space. Compare
            // visible controls, rather than treating transparent space as ink.
            const searches=[...document.querySelectorAll('#search-top-box-form input')]
              .filter(el=>getComputedStyle(el).display!=='none')
              .map(el=>el.getBoundingClientRect());
            for(const selector of ['#header h1','#header h2']) {
              for (const title of headerInk[selector]??[]) for (const search of searches) {
                const width=Math.min(search.right,title.right)-Math.max(search.left,title.left);
                const height=Math.min(search.bottom,title.bottom)-Math.max(search.top,title.top);
                if(width>1&&height>1)overlaps.push({title:selector,control:'#search-top-box',width,height});
              }
            }
          }
          const computed_checks=computedContract.map(check=>{const match=check.selector.match(/^(.*?)(::before|::after)$/u),el=document.querySelector(match?.[1]??check.selector),actual=el?getComputedStyle(el,match?.[2]??null).getPropertyValue(check.property).trim():null;return{...check,actual,pass:actual===check.expected}});
          const scroll_overflow_sources=[...document.querySelectorAll('body *')].filter(element=>element.scrollWidth>element.clientWidth+1).slice(0,30).map(element=>({tag:element.tagName,id:element.id,class_name:typeof element.className==='string'?element.className:'',scroll_width:element.scrollWidth,client_width:element.clientWidth,rect:element.getBoundingClientRect().toJSON(),overflow_x:getComputedStyle(element).overflowX}));
          const credit_fold=state.startsWith('credit-fold-')?{initial_hash:initialHash,hash:location.hash,outer_unfolded:document.querySelector('.creditRate > .rateBox')?.classList.contains('unfolded')===true,inner_unfolded:document.querySelector('.creditRateOtherwise > li')?.classList.contains('unfolded')===true,view_visibility:getComputedStyle(document.querySelector('#u-credit-view')).visibility,otherwise_visibility:getComputedStyle(document.querySelector('#u-credit-otherwise')).visibility}:null;
          return {navigation_row_layout,credit_fold,computed_checks,document_width:document.documentElement.scrollWidth, viewport_width:document.documentElement.clientWidth,overlaps,control_occlusion:controlOcclusion,header_ink_rects:headerInk,scroll_overflow_sources,
            overflow_sources:[...document.querySelectorAll('body *')].map(element=>({element,rect:element.getBoundingClientRect()})).filter(({element,rect})=>rect.width>0&&getComputedStyle(element).display!=='none'&&(rect.left < -1||rect.right>innerWidth+1)).slice(0,24).map(({element,rect})=>({tag:element.tagName,id:element.id,class_name:typeof element.className==='string'?element.className:'',rect:rect.toJSON(),parent_id:element.parentElement?.id,box_sizing:getComputedStyle(element).boxSizing,min_width:getComputedStyle(element).minWidth,padding:getComputedStyle(element).padding})),
            selector_coverage:submenu?null:Object.fromEntries(selectors.map(selector=>[selector,probes.filter(p=>p.selector===selector).length])),
            rows:probes.map(({el,selector,pseudo})=>({selector,pseudo,text:el.textContent.trim(),rect:el.getBoundingClientRect().toJSON(),parent_rect:el.parentElement?.getBoundingClientRect().toJSON()??null,scroll_width:el.scrollWidth,client_width:el.clientWidth,
              style:Object.fromEntries(['font-size','font-family','line-height','display','visibility','opacity','position','box-sizing','transform','margin-left','margin-right','padding-left','padding-right','content','background-size','width','min-width','left','right','inset-inline-start','inset-inline-end','white-space'].map(p=>[p,getComputedStyle(el,pseudo).getPropertyValue(p)]))})),
            search:input?{display:getComputedStyle(input).display,focused:document.activeElement===input}:null};
        }, {state,index,selectors,headerInk,computedContract,initialHash});
        // Compare against the browser's measured layout viewport. The requested
        // emulation width is only an input; Chromium may report a fractional
        // client box after scrollbar/layout rounding.
        const bounds = measurement.rows.map(row=>state==='sidebar-closed'
          ? closedDrawerBounds(row.rect, measurement.viewport_width)
          : viewportEscape(row.rect, measurement.viewport_width));
        const stem = `${variant}-${width}-${state}-${index}`;
        const screenshot = `${stem}.png`, dom = `${stem}.html.gz`;
        await page.screenshot({path:path.join(outputDir,screenshot),animations:'disabled'});
        await fs.writeFile(path.join(outputDir,dom),gzipSync(await page.content(),{level:9}));
        const requiresVisibleProbes=['heritage-rating','image-block','tags','history-list','article-table','second-tab-selected','credit-fold-view','credit-fold-otherwise','credit-fold-return'].includes(state);
        const visibleProbes=!requiresVisibleProbes||selectors.every(selector=>measurement.rows.some(row=>row.selector===selector&&row.rect.width>0&&row.rect.height>0&&row.style.display!=='none'&&row.style.visibility==='visible'));
        if(generatedLines)measurement.generated_text_lines=generatedLines;
        rows.push({variant,width,state,index,css_sha256:sha256Hex(sourceCss),base_css_sha256:baseCss?sha256Hex(baseCss):null,effective_css_sha256:sha256Hex(effectiveCss),measurement,bounds,
          interaction_error:interactionError,pass:(!measurement.navigation_row_layout||measurement.navigation_row_layout.length>0&&measurement.navigation_row_layout.every(row=>row.ink.length>0&&row.ink.every(ink=>ink.top>=row.bar.top-1&&ink.bottom<=row.bar.bottom+1&&ink.left>=row.bar.left-1&&ink.right<=row.bar.right+1))) && (!measurement.credit_fold||measurement.credit_fold.initial_hash===measurement.credit_fold.hash&&measurement.credit_fold.outer_unfolded&&measurement.credit_fold.inner_unfolded===(state==='credit-fold-otherwise')&&measurement.credit_fold.view_visibility==='visible'&&measurement.credit_fold.otherwise_visibility===(state==='credit-fold-otherwise'?'visible':'hidden')) && (!generatedLines||generatedLines.length>0&&generatedLines.every(row=>row.lines.length>0&&row.overlaps.length===0)) && visibleProbes && !interactionError && measurement.computed_checks.every(check=>check.pass) && measurement.document_width<=width+1 && bounds.every(row=>row.pass) && measurement.overlaps.length===0 && (state!=='credit-license'||measurement.control_occlusion.length>0&&measurement.control_occlusion.every(control=>control.visible&&control.clickable)) && (!measurement.selector_coverage || Object.values(measurement.selector_coverage).every(count=>count>0)),
          screenshot, screenshot_sha256:sha256Hex(await fs.readFile(path.join(outputDir,screenshot))),
          dom, dom_sha256:sha256Hex(await fs.readFile(path.join(outputDir,dom)))});
      }
      await context.close();
    }
    const archivedSources=[];
    for(const {source,bytes} of measurementSources){
      const file=`measurement-${path.basename(source)}`;
      await fs.writeFile(path.join(outputDir,file),bytes);
      archivedSources.push({path:file,sha256:sha256Hex(bytes)});
    }
    const historyBindings=[];
    for(const [index,entry]of(historyEntries??[]).entries()){
      const response=`native-history-response-${index}.json`,receipt=`native-history-acquisition-${index}.json`;
      await fs.writeFile(path.join(outputDir,response),entry.responseBytes);
      await fs.writeFile(path.join(outputDir,receipt),entry.receiptBytes);
      historyBindings.push({response,response_sha256:entry.response_sha256,receipt,receipt_sha256:entry.receipt_sha256,request_id:entry.request_id,page_id:entry.pageId,module:entry.moduleName});
    }
    if(previewEntry){await fs.writeFile(path.join(outputDir,'native-preview-response.json'),previewEntry.responseBytes);await fs.writeFile(path.join(outputDir,'native-preview-acquisition.json'),previewEntry.receiptBytes);}
    const receipt = {schema:'theme_lab_wikidot_adaptation_ab.v1',url,site:new URL(url).hostname,
      measurement_contract:state==='sidebar-closed'?'existing-drawer-wholly-off-canvas.v1':state==='navigation-action'?'production-navigation-action-and-contained-submenu.v1':'contained-probes.v1',
      measurement_program_sha256:sha256Hex(measurementSources[0].bytes),
      archived_sources:archivedSources,
      observed_at:snapshot.created_at, measured_at:new Date().toISOString(),snapshot,
      browser_engine:browserEngine,browser_version:browser.version(),browser_sha256:sha256Hex(await fs.readFile(executablePath)),
      ...(historyEntries?{frozen_history_replay:{bindings:historyBindings,scope:'Native list CSS geometry and standard radio DOM only; filtering and revision diff/source interaction are not established.'}}:{}),
      ...(previewEntry?{frozen_page_preview:{response:'native-preview-response.json',response_sha256:previewEntry.response_sha256,receipt:'native-preview-acquisition.json',receipt_sha256:previewEntry.receipt_sha256,dependencies:previewDependencies,scope:'Native anonymous preview components in frozen SCP-JP shell; saved-page and editing behavior are not established.'}}:{}),
      acquisition,credit_scroll_to_bottom:creditScrollToBottom,computed_contract:computedContract,public_writes:0,external_browser_requests:0,blocked_requests:blocked,rows};
    await fs.writeFile(path.join(outputDir,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');
    return receipt;
  } finally { await browser?.close(); await replay.close(); if(webkitProxy)await new Promise(resolve=>webkitProxy.close(resolve)); }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = key => args[args.indexOf(key)+1];
  if (!args.includes('--url') || !args.includes('--output')) throw new Error('requires --url and --output; --acquire only for explicit read-only acquisition');
  const result = await runAdaptationAB({url:value('--url'), outputDir:path.resolve(value('--output')),
    cacheDir:args.includes('--cache')?path.resolve(value('--cache')):undefined,
    acquire:args.includes('--acquire'),css:args.includes('--css')?await fs.readFile(value('--css'),'utf8'):'',
    withoutCss:args.includes('--without-css')?await fs.readFile(value('--without-css'),'utf8'):'',
    removeBlock:args.includes('--remove-block')?value('--remove-block'):null,
    assetDir:args.includes('--assets')?path.resolve(value('--assets')):undefined,
    state:args.includes('--state')?value('--state'):'navigation',
    computedContract:args.includes('--computed-contract')?JSON.parse(await fs.readFile(value('--computed-contract'),'utf8')):[],
    selectors:args.includes('--selectors')?value('--selectors').split(','):undefined,
    widths:args.includes('--widths')?value('--widths').split(',').map(Number):undefined});
  console.log(JSON.stringify({rows:result.rows.length,with_pass:result.rows.filter(r=>r.variant==='with').every(r=>r.pass),public_writes:0}));
}
