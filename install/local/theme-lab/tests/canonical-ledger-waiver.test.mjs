import test from 'node:test';
import assert from 'node:assert/strict';
import {matchCanonicalContainmentWaivers,viewportIdForWidth} from '../src/canonical-ledger-waiver.mjs';
import {canonicalJson} from '../src/faithful-design-exemptions.mjs';
import crypto from 'node:crypto';

const context={packageName:'classic',themeCssSha256:'c'.repeat(64),themeSourceSha256:'s'.repeat(64),scenarioSha256:'r'.repeat(64)};
const key=JSON.stringify(['classic','chromium','narrow-mobile','page.normal','settled']);
const coveringEntry=()=>({id:'OD-T1-classic-test',instrument:'semantic_document_containment',decision:'OD-T1',package:'classic',
  match:{observation_key:key,candidate_overflow_px:11,baseline_overflow_px:0},candidate_source_sha256:'s'.repeat(64),candidate_sha256:'c'.repeat(64)});
const document=(...entries)=>({entries});
const settledFail=(overrides={})=>({engine:'chromium',sessionProfile:'anonymous',kind:'state',id:'settled',viewportWidth:320,candidateOverflowPx:11,baselineOverflowPx:0,...overrides});

test('viewport widths resolve to acceptance ids, unknown widths do not',()=>{
  assert.equal(viewportIdForWidth(320),'narrow-mobile');
  assert.equal(viewportIdForWidth(390),'mobile');
  assert.equal(viewportIdForWidth(1280),null);
});

test('a covered overflow failure passes and is recorded with entry id and finding hash',()=>{
  const waivers=matchCanonicalContainmentWaivers(document(coveringEntry()),{...context,failures:[settledFail()]});
  assert.equal(waivers.length,1);
  const [waiver]=waivers;
  assert.equal(waiver.entry_id,'OD-T1-classic-test');
  assert.equal(waiver.state,'settled');
  assert.equal(waiver.engine,'chromium');
  assert.equal(waiver.viewport,'narrow-mobile');
  const {finding_sha256,...finding}=waiver;
  assert.match(finding_sha256,/^[0-9a-f]{64}$/u);
  assert.equal(finding_sha256,crypto.createHash('sha256').update(canonicalJson(finding)).digest('hex'));
});

test('drifted overflow re-fails the finding',()=>{
  assert.deepEqual(matchCanonicalContainmentWaivers(document(coveringEntry()),{...context,failures:[settledFail({candidateOverflowPx:12})]}),[]);
  assert.deepEqual(matchCanonicalContainmentWaivers(document(coveringEntry()),{...context,failures:[settledFail({baselineOverflowPx:1})]}),[]);
});

test('non-OD-T1 entries never waive (no new waivers)',()=>{
  const exemption={...coveringEntry(),id:'FD-classic-test',decision:'faithful-design'};
  assert.deepEqual(matchCanonicalContainmentWaivers(document(exemption),{...context,failures:[settledFail()]}),[]);
  const t3a={...coveringEntry(),id:'OD-T3-a-test',decision:'OD-T3-a'};
  assert.deepEqual(matchCanonicalContainmentWaivers(document(t3a),{...context,failures:[settledFail()]}),[]);
});

test('checks, probes and non-overflow states are never waiver-eligible',()=>{
  const doc=document(coveringEntry());
  assert.deepEqual(matchCanonicalContainmentWaivers(doc,{...context,failures:[{...settledFail(),kind:'check',id:'target_acceptance'}]}),[]);
  assert.deepEqual(matchCanonicalContainmentWaivers(doc,{...context,failures:[{...settledFail(),kind:'probe',id:'headings'}]}),[]);
  assert.deepEqual(matchCanonicalContainmentWaivers(doc,{...context,failures:[{...settledFail(),id:'tab-second'}]}),[]);
});

test('unmapped viewports, non-integer overflows and source drift never waive',()=>{
  const doc=document(coveringEntry());
  assert.deepEqual(matchCanonicalContainmentWaivers(doc,{...context,failures:[settledFail({viewportWidth:1280})]}),[]);
  assert.deepEqual(matchCanonicalContainmentWaivers(doc,{...context,failures:[settledFail({candidateOverflowPx:11.5})]}),[]);
  assert.deepEqual(matchCanonicalContainmentWaivers(doc,{...context,themeSourceSha256:'0'.repeat(64),failures:[settledFail()]}),[]);
  assert.deepEqual(matchCanonicalContainmentWaivers(doc,{...context,themeCssSha256:'0'.repeat(64),failures:[settledFail()]}),[]);
});

test('empty or absent ledgers waive nothing',()=>{
  assert.deepEqual(matchCanonicalContainmentWaivers({entries:[]},{...context,failures:[settledFail()]}),[]);
  assert.deepEqual(matchCanonicalContainmentWaivers(null,{...context,failures:[settledFail()]}),[]);
  assert.deepEqual(matchCanonicalContainmentWaivers(document(coveringEntry()),{...context,failures:[]}),[]);
});
