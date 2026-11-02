import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {loadChromium} from '../src/browser-lab.mjs';
import {confineReadOnlyReplay} from '../scripts/wikidot-adaptation-ab.mjs';

test('read-only replay blocks HTTP mutations, other origins and WebSocket write channels',async()=>{
  let writes=0,sockets=0;
  const server=http.createServer((request,response)=>{if(request.method!=='GET')writes++;response.end('<!doctype html><html><body>Replay</body></html>')});
  server.on('upgrade',(request,socket)=>{sockets++;socket.destroy()});
  const browser=await loadChromium().launch({headless:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  try {
    const context=await browser.newContext(),blocked=[];
    await confineReadOnlyReplay(context,origin,blocked);
    const page=await context.newPage();await page.goto(origin+'/');
    await page.evaluate(async origin=>{
      await fetch(origin+'/save',{method:'POST',body:'mutation'}).catch(()=>{});
      await fetch('http://example.invalid/').catch(()=>{});
      await new Promise(resolve=>{const socket=new WebSocket(origin.replace('http:','ws:')+'/write');socket.onopen=()=>socket.send('mutation');socket.onclose=resolve;socket.onerror=resolve});
    },origin);
    assert.equal(writes,0);assert.equal(sockets,0);
    assert.ok(blocked.some(row=>row.method==='POST'));
    assert.ok(blocked.some(row=>row.url==='http://example.invalid/'));
    assert.ok(blocked.some(row=>row.method==='WEBSOCKET'));
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
});
