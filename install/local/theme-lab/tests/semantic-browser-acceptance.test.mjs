import test from 'node:test';
import assert from 'node:assert/strict';
import {measuredFacts, titleCompositionFact, planBrowserAcceptance, validateSemanticBrowserAcceptance, TITLE_COMPOSITION_CONTRACT_SHA256, TITLE_TEXT_CONTRACT_SHA256, observationKey} from '../src/semantic-browser-acceptance.mjs';
import {BASELINE_DOCUMENT_CONTAINMENT_CONTRACT_SHA256,BASELINE_DOCUMENT_CONTAINMENT_SCHEMA} from '../src/baseline-document-containment.mjs';
import {VISUAL_GATE_POLICY_SHA256,visualGatePolicyRow,visualGateSelectorsFor,buildVisualGateAssertion,visualGateGlobalRuntimeDrift} from '../src/visual-gate.mjs';
import {createDeepwellRuntimeIdentity} from '../src/deepwell-runtime-identity.mjs';
const sha = 'a'.repeat(64);
const backendRuntimeIdentity=createDeepwellRuntimeIdentity({source_sha256:'b'.repeat(64),ftml_git_revision:'c'.repeat(40),container_id:'d'.repeat(64),image_id:`sha256:${'e'.repeat(64)}`,binary_sha256:'f'.repeat(64),config_sha256:'1'.repeat(64)});
const row = (overrides={}) => {
  const record={theme:'example',browser_engine:'chromium',browser_version:'1',viewport:'desktop',viewport_size:{width:1440,height:1000},surface:'page.normal',state:'settled',
    candidate_sha256:sha,candidate_source_sha256:sha,baseline_theme_css_sha256:sha,capture_state_action_contract_sha256:sha,
    asset_dependency_sha256:sha,fixture_contract_sha256:sha,runtime_surface_contract_sha256:sha,runtime_source_sha256:sha,
    backend_runtime_identity:backendRuntimeIdentity,backend_runtime_identity_sha256:backendRuntimeIdentity.identity_sha256,
    run_contract_sha256:'2'.repeat(64),scoped_run_contract_sha256:'3'.repeat(64),environment_contract_sha256:'4'.repeat(64),
    external_requests_sent:0,asset_failures:[],page_errors:[],action_responses:[],unconfirmed_items:['screenshot captured but awaiting image review'],
    visual_diagnostics:{viewport:{width:1440,height:1000,client_width:1440,client_height:1000,document_width:1440,documentWidth:1440},title_overlaps:[]},...overrides};
  const policy=visualGatePolicyRow(record),size=record.viewport_size??{width:1440,height:1000};
  const suppliedViewport=record.visual_diagnostics?.viewport;
  const measuredViewport=Object.hasOwn(overrides??{},'visual_diagnostics')?{...suppliedViewport}:{width:size.width,height:size.height,...suppliedViewport};
  measuredViewport.height??=size.height;
  if(measuredViewport.width!==undefined)measuredViewport.client_width??=measuredViewport.width;
  if(measuredViewport.height!==undefined)measuredViewport.client_height??=measuredViewport.height;
  if(measuredViewport.document_width!==undefined)measuredViewport.documentWidth??=measuredViewport.document_width;
  if(measuredViewport.documentWidth!==undefined)measuredViewport.document_width??=measuredViewport.documentWidth;
  record.visual_diagnostics={...record.visual_diagnostics,viewport:measuredViewport,title_overlaps:record.visual_diagnostics?.title_overlaps??[],elements:{...record.visual_diagnostics?.elements}};
  record.visual_diagnostics_contract_sha256='5'.repeat(64);
  record.action_sequence=[...(record.action_sequence??[]),{type:'focusin'},{type:'pointerover'}];
  const riskTriggers=policy?.class==='C'?['no-comparable-prior-capture',...(record.visual_diagnostics.title_overlaps.some(item=>item.effectively_visible===true)?['visible-title-composition']:[])]:[];
  record.visual_gate={policy_sha256:VISUAL_GATE_POLICY_SHA256,class:policy?.class??null,risk_triggers:riskTriggers,
    ...(policy?.class==='C'?{risk_assessment:{scope:'same-theme-surface-state-engine-viewport',identity_comparison_schema:'theme_lab_visual_risk_identity.v3',previous_capture_found:false,global_runtime_drift:visualGateGlobalRuntimeDrift({},record,{hasPriorCapture:false})}}:{})};
  if(policy?.class==='C'){
    for(const selector of visualGateSelectorsFor(policy,record))record.visual_diagnostics.elements[selector]={visibility:'visible',display:'block',rect:{x:4,y:4,width:120,height:36}};
    const action=record.action_contract_observation;
    if(action?.control==='#search-top-box-input'&&action.display==='none')record.visual_diagnostics.elements['#search-top-box-input']={visibility:'hidden',display:'none',rect:{x:0,y:0,width:0,height:0}};
    if(policy.key==='credit.view.open'&&!record.baseline_theme)record.action_contract_observation={...action,location_hash:'#u-credit-view'};
    if(policy.key==='credit.otherwise.open'&&!record.baseline_theme)record.action_contract_observation={...action,location_hash:'#u-credit-otherwise'};
    record.state_machine_assertion=buildVisualGateAssertion(record);
    if(policy.key==='content.tabview.second-tab-selected')record.state_machine_assertion.selected=true;
  }
  if(policy?.class==='M'){
    delete record.screenshot;delete record.screenshot_sha256;delete record.visual_review;
    record.functional_assertion={schema:'theme_lab_functional_assertion.v1',policy_sha256:VISUAL_GATE_POLICY_SHA256,key:policy.key,
      action_contract_sha256:record.capture_state_action_contract_sha256,action_completed:true,action_sequence_count:record.action_sequence.length,
      candidate_sha256:record.candidate_sha256,candidate_source_sha256:record.candidate_source_sha256,asset_dependency_sha256:record.asset_dependency_sha256,
      runtime_source_sha256:record.runtime_source_sha256,backend_runtime_identity_sha256:record.backend_runtime_identity_sha256,run_contract_sha256:record.run_contract_sha256,
      browser_engine:record.browser_engine,browser_version:record.browser_version,viewport:record.viewport};
    delete record.visual_gate.risk_assessment;record.visual_gate.risk_triggers=[];
  }else{
    record.screenshot??='example.png';record.screenshot_sha256??=sha;record.classification??='PASS_NATURAL';
    record.visual_review={method:'direct-image-vision-review',screenshot_sha256:record.screenshot_sha256,candidate_sha256:record.candidate_sha256,
      candidate_source_sha256:record.candidate_source_sha256,reviewer:'test',note:'Exact screenshot checked against the current candidate and source.',reviewed_at:'2026-10-01T00:00:00Z'};
  }
  return record;
};
const withTextIntersections = record => ({...record, title_text_contract_sha256: TITLE_TEXT_CONTRACT_SHA256,
  title_text_measurement: {schema: 'theme_lab_title_text_intersections.v1', complete: true,
    title_text_rects: [{x: 0, y: 0, width: 100, height: 30}], intersections: record.visual_diagnostics.title_overlaps}});

test('measured facts are independent of a pending screenshot judgment', () => {
  assert.deepEqual(measuredFacts(row()), {observation_identity: 'pass', capture_safety: 'pass', maintained_action_execution: 'pass', state_specific_assertion:'pass', document_containment: 'pass'});
  const audit = {records: [row(), row({viewport: 'mobile'})]};
  const plan = planBrowserAcceptance(audit);
  assert.equal(plan.accounting.browser_records, 2);
  assert.equal(plan.accounting.distinct_visual_questions, 1);
  assert.equal(plan.visual_questions[0].observations.length, 2);
  assert.equal(audit.records[0].classification, 'PASS_NATURAL');
  assert.equal(audit.records[0].reviewed_after_last_change, undefined);
});

test('runtime source identity is mandatory observation evidence',()=>{
  assert.equal(measuredFacts(row({runtime_source_sha256:undefined})).observation_identity,'missing');
  assert.equal(measuredFacts(row({runtime_source_sha256:'invalid'})).observation_identity,'missing');
});

test('unknown safety and failed actions cannot be cleared by image review', () => {
  assert.equal(measuredFacts(row({action_responses: undefined})).capture_safety, 'missing');
  for (const override of [{external_requests_sent: 1}, {asset_failures: [{}]}, {page_errors: ['error']},
    {action_responses: [{status: 500}]}, {failure: 'failed'}, {unconfirmed_items: ['unknown actor']}]) {
    assert.equal(measuredFacts(row(override)).capture_safety, 'fail');
  }
  assert.equal(measuredFacts(row({surface: 'unrecognized.surface'})).maintained_action_execution, 'missing');
});

test('geometry detects an actual failure even when the action succeeded', () => {
  const r = row({visual_diagnostics: {viewport: {width: 390, documentWidth: 424}, title_overlaps: []}});
  assert.equal(measuredFacts(r).document_containment, 'missing');
  assert.equal(measuredFacts(r).maintained_action_execution, 'pass');
  assert.ok(validateSemanticBrowserAcceptance({records: [r]}).failures.some(f => f.includes('missing structured evidence document_containment')));
  const baseline=value=>({...r,baseline_document_containment_contract_sha256:BASELINE_DOCUMENT_CONTAINMENT_CONTRACT_SHA256,
    baseline_document_containment_measurement:{schema:BASELINE_DOCUMENT_CONTAINMENT_SCHEMA,complete:true,viewport_width:390,document_width:value,body_width:value}});
  assert.equal(measuredFacts(baseline(424)).document_containment,'pass');
  assert.equal(measuredFacts(baseline(390)).document_containment,'fail');
  assert.equal(measuredFacts({...baseline(424),baseline_document_containment_contract_sha256:'b'.repeat(64)}).document_containment,'missing');
  assert.equal(measuredFacts(row({visual_diagnostics: {viewport: {width: 390}}})).document_containment, 'missing');
});

test('a hidden query observation is a source-authority gap, not completed typing', () => {
  const hidden = row({surface: 'shell.search', state: 'typed-focused', action_contract_observation: {control: '#search-top-box-input', display: 'none'}});
  const plan = planBrowserAcceptance({records: [hidden]});
  assert.equal(plan.accounting.additional_source_authority_records, 1);
  assert.ok(validateSemanticBrowserAcceptance({records: [hidden]}).failures.some(failure=>/requested action was not exercised/u.test(failure)));
});

test('source-hidden search execution needs a real matching route and bound source proof', () => {
  const action = {schema: 'theme_lab_search_action.v1', control: '#search-top-box-input', mode: 'source-hidden-submit',
    query: {display: 'none', value: 'サイト内検索'}, expected_path: '/search:site/q/' + encodeURIComponent('サイト内検索'),
    observed_path: '/search:site/q/' + encodeURIComponent('サイト内検索'), source_authority: {path: 'source.json', sha256: sha}};
  const input = value => row({surface: 'shell.search', state: 'typed-focused', action_contract_observation: value});
  assert.equal(measuredFacts(input(action)).maintained_action_execution, 'pass');
  assert.equal(measuredFacts(input({...action, source_authority: null})).maintained_action_execution, 'source-required');
  assert.equal(measuredFacts(input({...action, observed_path: '/search:site/q/wrong'})).maintained_action_execution, 'source-required');
});

test('source-replaced sidebar actions need both exact source authority and a successful alternate navigation observation', () => {
  const failure='No reachable ordinary or source-owned sidebar control';
  const authority={path:'authority.json',sha256:sha};
  const replacement={key:'["monotypical","webkit","mobile","nav.mobile-top","submenu-expanded"]',
    screenshot_sha256:sha,dependencies_sha256:sha};
  const sourceAction={schema:'theme_lab_source_action_applicability.v1',mode:'source-navigation-replaces-sidebar',
    surface:'nav.sidebar',state:'open',viewport:'mobile',expected_failure:failure,
    candidate_sha256:sha,candidate_source_sha256:sha,replacement,source_authority:authority};
  const record=row({theme:'monotypical',browser_engine:'webkit',viewport:'mobile',surface:'nav.sidebar',state:'open',
    failure,unconfirmed_items:[`action/capture failed: ${failure}`],action_contract_observation:sourceAction});
  assert.equal(measuredFacts(record).capture_safety,'pass');
  assert.equal(measuredFacts(record).maintained_action_execution,'pass');
  assert.equal(measuredFacts({...record,action_contract_observation:{...sourceAction,replacement:{...replacement,screenshot_sha256:'invalid'}}}).capture_safety,'fail');
  assert.equal(measuredFacts({...record,action_contract_observation:{...sourceAction,expected_failure:'different failure'}}).maintained_action_execution,'fail');
});

test('hidden intersections are machine facts; unmeasured visibility requires a probe, not vision', () => {
  assert.equal(titleCompositionFact(row()), 'pass');
  assert.equal(titleCompositionFact(row({visual_diagnostics: {title_overlaps: [{effectively_visible: false}]}})), 'pass');
  const plan = planBrowserAcceptance({records: [row({visual_diagnostics: {title_overlaps: [{}]}})]});
  assert.deepEqual(plan.observations[0].additional_machine_evidence, ['document_containment', 'title_composition']);
  assert.equal(plan.accounting.distinct_visual_questions, 1);
  assert.equal(titleCompositionFact(row({visual_diagnostics: {title_overlaps: Array(16).fill({effectively_visible: false})}})), 'missing');
});

test('visible normal-state intersections are covered by the source identity question', () => {
  const visible = row({visual_diagnostics: {title_overlaps: [{effectively_visible: true, text: 'menu'}]}});
  assert.equal(titleCompositionFact(visible), 'missing');
  const plan = planBrowserAcceptance({records: [withTextIntersections(visible)]});
  assert.equal(plan.accounting.distinct_visual_questions, 1);
  assert.equal(plan.visual_questions[0].kind, 'source_visual_identity');
  assert.match(plan.visual_questions[0].question, /page-title readability/u);
  assert.equal(plan.observations[0].facts.title_composition, 'visual-identity');
});

test('an exact non-normal title composition reuses the normal source-identity review', () => {
  const overlap = {effectively_visible:true,tag:'A',id:'',class:'account',text:'Account',color:'white',background:'black',position:'relative',z:'40'};
  const normal = withTextIntersections(row({viewport:'mobile',viewport_size:{width:390,height:844},
    title_composition_contract_sha256: TITLE_COMPOSITION_CONTRACT_SHA256,
    title_composition_measurement:{schema:'theme_lab_title_composition.v1',complete:true,title_rect:{x:0,y:0,width:200,height:50},overlaps:[overlap]},
    visual_diagnostics:{viewport:{width:390,documentWidth:390},title_overlaps:[overlap]}}));
  const search = {...normal,surface:'shell.search',state:'typed-focused',screenshot:'search.png',screenshot_sha256:'b'.repeat(64),fixture_contract_sha256:'c'.repeat(64)};
  const plan = planBrowserAcceptance({records:[normal,search]});
  assert.equal(plan.visual_questions.filter(q=>q.kind==='ambiguous_composition').length,0);
  assert.equal(plan.visual_questions.filter(q=>q.kind==='source_visual_identity').length,1);
  const observation=plan.observations.find(item=>item.key===observationKey(search));
  assert.equal(observation.facts.title_composition,'visual-identity');
  assert.equal(observation.visual_questions.length,1);
  assert.match(observation.machine_explanations[0],/source-identity review/u);
});

test('non-navigation title intersections remain visual questions even with a clean reading state', () => {
  const overlap = {effectively_visible:true,tag:'A',id:'',class:'control',text:'Control',color:'black',background:'white',position:'absolute',z:'20'};
  const normal = row({viewport:'mobile',viewport_size:{width:390,height:844},visual_diagnostics:{viewport:{width:390,documentWidth:390},title_overlaps:[]}});
  const search = withTextIntersections(row({surface:'shell.search',state:'typed-focused',viewport:'mobile',viewport_size:{width:390,height:844},
    visual_diagnostics:{viewport:{width:390,documentWidth:390},title_overlaps:[{...overlap,rect:{x:0,y:50,width:100,height:60}}]}}));
  assert.equal(planBrowserAcceptance({records:[normal,search]}).visual_questions.filter(q=>q.kind==='ambiguous_composition').length,1);
});

test('one composition obligation binds responsive/action observations without declaring images equivalent', () => {
  const overlap = {effectively_visible:true,tag:'A',id:'',class:'menu-control',text:'Menu',color:'black',background:'white',position:'absolute',z:'20'};
  const first = withTextIntersections(row({surface:'shell.search',state:'typed-focused',visual_diagnostics:{viewport:{width:1440,documentWidth:1440},title_overlaps:[{...overlap,rect:{x:20,y:100,width:200,height:30}}]}}));
  const second = withTextIntersections(row({surface:'content.link',state:'focused',viewport:'mobile',screenshot_sha256:'b'.repeat(64),capture_state_action_contract_sha256:'c'.repeat(64),
    visual_diagnostics:{viewport:{width:390,documentWidth:390},title_overlaps:[{...overlap,rect:{x:0,y:50,width:100,height:60}}]}}));
  const before = planBrowserAcceptance({records:[first]}).visual_questions.find(q=>q.kind==='ambiguous_composition');
  const after = planBrowserAcceptance({records:[first,second]}).visual_questions.filter(q=>q.kind==='ambiguous_composition');
  assert.equal(after.length,1);assert.equal(after[0].id,before.id);
  assert.equal(after[0].observations.length,2);assert.notEqual(after[0].evidence_sha256,before.evidence_sha256);
  assert.match(after[0].question,/A.menu-control/u);
});

test('question identities and evidence depend on relevant observations, not unrelated audit changes', () => {
  const original = planBrowserAcceptance({records: [row()]});
  const changed = planBrowserAcceptance({records: [row(), row({theme: 'unrelated', screenshot_sha256: 'b'.repeat(64)})], updated_at: 'later'});
  assert.deepEqual(changed.visual_questions[0], original.visual_questions[0]);
  const scoped = planBrowserAcceptance({records: [row({candidate_sha256: 'b'.repeat(64)})]});
  assert.notEqual(scoped.visual_questions[0].id, original.visual_questions[0].id);
  const changedAction = planBrowserAcceptance({records: [row({capture_state_action_contract_sha256: 'b'.repeat(64)})]});
  assert.equal(changedAction.visual_questions[0].evidence_sha256, original.visual_questions[0].evidence_sha256);
  const additionalMeasurement = planBrowserAcceptance({records: [row({title_text_contract_sha256: 'c'.repeat(64),
    title_composition_contract_sha256: 'd'.repeat(64)})]});
  assert.equal(additionalMeasurement.visual_questions[0].evidence_sha256, original.visual_questions[0].evidence_sha256);
});

test('a concrete visual question review binds every declared evidence item and cannot clear missing facts', () => {
  const audit = {records: [row()]}, q = planBrowserAcceptance(audit).visual_questions[0];
  audit.semantic_reviews = {[q.id]: {question: q.question, evidence_sha256: q.evidence_sha256,
    method: 'direct-visual-question-review', status: 'pass', note: 'Source typography, palette and artwork compared across the listed evidence.',
    reviewer: 'test', reviewed_at: '2026-10-01T00:00:00Z', decision_authority: 'SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY', port_conclusion_eligible: false,
    source_url: 'https://scp-wiki.wikidot.com/theme:example', source_snapshot: {path: 'source.txt', sha256: sha}, source_html: {path: 'source.html', sha256: sha}, source_rendering: {path: 'source.png', sha256: sha}, source_rendering_receipt: {path: 'source-capture.json', sha256: sha}}};
  assert.equal(validateSemanticBrowserAcceptance(audit).status, 'pass');
  audit.records.push(row({viewport: 'mobile'}));
  assert.match(validateSemanticBrowserAcceptance(audit).failures.at(-1), /unanswered or stale/u);
  assert.notEqual(validateSemanticBrowserAcceptance({records: []}).status, 'pass');
});
