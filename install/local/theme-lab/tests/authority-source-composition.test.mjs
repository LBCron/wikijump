import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {composeAuthoritySource} from '../src/authority-source-composition.mjs';
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
import {extractSCPJPAdaptationBlocks} from '../src/port-maintenance.mjs';
test('independent authority corrections retain separately hash-bound CSS modules',()=>{
 const first='/* SCP-JP first correction */\n.a { color: red; }';
 const second='/* SCP-JP second correction */\n.b { color: blue; }';
 const blocks=extractSCPJPAdaptationBlocks(composeAuthoritySource('source\n',first+'\n\n/* THEME_LAB_AUTHORITY_BLOCK_BOUNDARY */\n\n'+second));
 assert.equal(blocks.length,2);
 assert.deepEqual(blocks.map(block=>block.sha256),[digest(first),digest(second)]);
 assert.throws(()=>composeAuthoritySource('source','/* THEME_LAB_AUTHORITY_BLOCK_BOUNDARY */'),/empty authority block/);
});
