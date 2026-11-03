import crypto from 'node:crypto';
import states from '../fixtures/browser-acceptance-states.json' with {type: 'json'};
import {measureTitleComposition} from './title-composition.mjs';
import {measureTitleTextIntersections} from './title-text-intersections.mjs';
import {BASELINE_DOCUMENT_CONTAINMENT_CONTRACT_SHA256,BASELINE_DOCUMENT_CONTAINMENT_SCHEMA} from './baseline-document-containment.mjs';
import {validateVisualGateRecord,visualGateNeedsScreenshot} from './visual-gate.mjs';
import {loadFaithfulDesignExemptions,matchFaithfulDesignContainment} from './faithful-design-exemptions.mjs';

export const SEMANTIC_BROWSER_MODEL = 'theme_lab_semantic_browser_acceptance.v1';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const validHash = value => /^[a-f0-9]{64}$/u.test(value ?? '');
export const TITLE_COMPOSITION_CONTRACT_SHA256 = crypto.createHash('sha256').update(measureTitleComposition.toString()).digest('hex');
export const TITLE_TEXT_CONTRACT_SHA256 = crypto.createHash('sha256').update(measureTitleTextIntersections.toString()).digest('hex');
const pendingImage = 'screenshot captured but awaiting image review';
const knownStates = new Set(states.states.map(row => `${row.surface}.${row.state}`));
const transientNavigationStates = new Set([
  'nav.desktop-top.submenu-hover',
  'nav.desktop-top.keyboard-focus',
  'nav.sidebar.open',
  'nav.sidebar.open-submenu',
  'nav.mobile-top.submenu-expanded',
  'nav.tablet-top.active-navigation-expanded'
]);
const failureResponse = response => !response || response.type === 'failure' || response.status >= 400 || response.error_message;
export const observationKey = row => JSON.stringify([row.theme, row.browser_engine, row.viewport, row.surface, row.state]);


// These dependencies belong to this observation, not the Git tree, complete
// campaign inventory, audit bytes, or the source of the acceptance evaluator.
// Unknown dependencies remain conservatively covered by the candidate/fixture
// and surface hashes. They must not be guessed away by a selector heuristic.
export function observationDependencies(row) {
  const dependencies = Object.fromEntries([
    'theme', 'candidate_sha256', 'candidate_source_sha256', 'base_css_sha256',
    'candidate_structure_sha256', 'baseline_theme_css_sha256', 'baseline_theme_mode',
    'asset_dependency_sha256', 'fixture_contract_sha256',
    'capture_state_action_contract_sha256', 'runtime_surface_contract_sha256', 'runtime_source_sha256',
    'backend_runtime_identity_sha256', 'run_contract_sha256', 'scoped_run_contract_sha256',
    'environment_contract_sha256',
    'title_composition_contract_sha256',
    'browser_engine', 'browser_version', 'viewport', 'viewport_size',
    'surface', 'state', 'session_state', 'target_site', 'locale', 'transport_origin'
  ].map(key => [key, row[key] ?? null]));
  dependencies.visual_gate_policy_sha256=row.visual_gate?.policy_sha256??null;
  dependencies.visual_gate_class=row.visual_gate?.class??null;
  dependencies.state_machine_assertion_sha256=row.state_machine_assertion?hash(row.state_machine_assertion):null;
  dependencies.functional_assertion_sha256=row.functional_assertion?hash(row.functional_assertion):null;
  if (row.title_text_contract_sha256) dependencies.title_text_contract_sha256 = row.title_text_contract_sha256;
  if (row.action_contract_observation?.source_authority) dependencies.source_action_authority = row.action_contract_observation.source_authority;
  return dependencies;
}

function safety(row) {
  if (row.failure || row.unconfirmed_items?.some(item => item !== pendingImage)) return 'fail';
  for (const key of ['asset_failures', 'page_errors', 'action_responses', 'unconfirmed_items']) {
    if (!Array.isArray(row[key])) return 'missing';
  }
  if (row.external_requests_sent !== 0 || row.asset_failures.length || row.page_errors.length || row.action_responses.some(failureResponse)) return 'fail';
  if (visualGateNeedsScreenshot(row,{failure:!!row.failure})&&(!validHash(row.screenshot_sha256)||!row.screenshot)) return 'missing';
  if(validateVisualGateRecord(row).length)return 'fail';
  return 'pass';
}

function sourceReplacedSidebarAction(row) {
  const action=row.action_contract_observation;
  return action?.schema==='theme_lab_source_action_applicability.v1'&&
    action.mode==='source-navigation-replaces-sidebar'&&action.surface===row.surface&&
    action.state===row.state&&action.viewport===row.viewport&&
    action.expected_failure===row.failure&&action.candidate_sha256===row.candidate_sha256&&
    action.candidate_source_sha256===row.candidate_source_sha256&&
    validHash(action.replacement?.screenshot_sha256)&&validHash(action.replacement?.dependencies_sha256)&&
    typeof action.replacement?.key==='string'&&action.replacement.key.length>0&&
    typeof action.source_authority?.path==='string'&&validHash(action.source_authority?.sha256);
}

function sourceReplacedSidebarSafety(row) {
  const allowedUnconfirmed=new Set([pendingImage,`action/capture failed: ${row.failure}`]);
  const cleanArrays=['asset_failures','page_errors','action_responses','unconfirmed_items'].every(key=>Array.isArray(row[key]));
  if(!sourceReplacedSidebarAction(row)||row.external_requests_sent!==0||!cleanArrays||
    row.asset_failures.length||row.page_errors.length||row.action_responses.some(failureResponse)||
    row.unconfirmed_items.some(item=>!allowedUnconfirmed.has(item))||!validHash(row.screenshot_sha256)||!row.screenshot)return null;
  return 'pass';
}

// No screenshot is needed to establish the observed action or document width.
// Successful action execution proves only the maintained harness execution,
// not complete usability, appearance, source intent or Wikidot parity.
export function documentContainmentOverflows(row) {
  const viewport = row.visual_diagnostics?.viewport;
  const documentWidth = viewport?.document_width ?? viewport?.documentWidth;
  const width = viewport?.client_width ?? viewport?.width;
  const candidateOverflow=Number.isFinite(documentWidth)&&Number.isFinite(width)&&width>0?Math.max(0,documentWidth-width):null;
  const baselineContainment=row.baseline_document_containment_measurement;
  const baselineComplete=baselineContainment?.schema===BASELINE_DOCUMENT_CONTAINMENT_SCHEMA&&baselineContainment.complete===true&&
    row.baseline_document_containment_contract_sha256===BASELINE_DOCUMENT_CONTAINMENT_CONTRACT_SHA256&&
    Number.isFinite(baselineContainment.document_width)&&Number.isFinite(baselineContainment.viewport_width)&&baselineContainment.viewport_width>0;
  const baselineOverflow=baselineComplete?Math.max(0,baselineContainment.document_width-baselineContainment.viewport_width):null;
  return {candidateOverflow, baselineOverflow};
}

export function measuredFacts(row) {
  const {candidateOverflow, baselineOverflow} = documentContainmentOverflows(row);
  const search = row.action_contract_observation;
  const exercisedSearch = search?.schema === 'theme_lab_search_action.v1' &&
    (search.mode === 'typed-focused' && search.typed_and_focused === true ||
      search.mode === 'source-hidden-submit' && search.expected_path === search.observed_path &&
      search.observed_path === '/search:site/q/' + encodeURIComponent(search.query?.value) &&
      (search.query?.display === 'none' || search.query?.visibility === 'hidden' || search.query?.width === 0 || search.query?.height === 0) &&
      typeof search.source_authority?.path === 'string' && validHash(search.source_authority?.sha256));
  const sourceReplacedAction=sourceReplacedSidebarAction(row);
  const action = sourceReplacedAction?'pass':search?.control === '#search-top-box-input' && !exercisedSearch ? 'source-required' : knownStates.has(`${row.surface}.${row.state}`) && validHash(row.capture_state_action_contract_sha256)
    ? safety(row) : 'missing';
  return {
    observation_identity: ['candidate_sha256', 'candidate_source_sha256', 'baseline_theme_css_sha256',
      'asset_dependency_sha256', 'fixture_contract_sha256', 'capture_state_action_contract_sha256',
      'runtime_surface_contract_sha256', 'runtime_source_sha256', 'backend_runtime_identity_sha256'].every(key => validHash(row[key])) ? 'pass' : 'missing',
    capture_safety: sourceReplacedSidebarSafety(row)??safety(row),
    maintained_action_execution: action,
    state_specific_assertion: validateVisualGateRecord(row).length?'fail':'pass',
    document_containment: candidateOverflow===null?'missing':candidateOverflow<=1?'pass':
      baselineOverflow===null?'missing':candidateOverflow<=baselineOverflow+1?'pass':'fail'
  };
}

// Intersecting boxes alone do not establish visual damage: hidden navigation
// descendants can have nonzero rectangles. The historical collector omitted
// their effective visibility. That is missing machine evidence, not a demand
// to look at every screenshot. A visible overlap is an actual composition
// question, complementary to the full check's surface and contrast probes.
export function titleCompositionFact(row) {
  const diagnostics = row.visual_diagnostics;
  const measurement = row.title_composition_measurement;
  const complete = measurement?.schema === 'theme_lab_title_composition.v1' && measurement.complete === true;
  if ((measurement || row.title_composition_contract_sha256) && (!complete || row.title_composition_contract_sha256 !== TITLE_COMPOSITION_CONTRACT_SHA256)) return 'missing';
  const overlaps = complete ? measurement.overlaps : diagnostics?.title_overlaps ?? diagnostics?.titleOverlaps;
  if (!Array.isArray(overlaps) || !complete && overlaps.length >= 16) return 'missing';
  if (overlaps.some(item => typeof item.effectively_visible !== 'boolean')) return 'missing';
  if (!overlaps.some(item => item.effectively_visible)) return 'pass';
  const text = row.title_text_measurement;
  if (text?.schema !== 'theme_lab_title_text_intersections.v1' || text.complete !== true ||
      row.title_text_contract_sha256 !== TITLE_TEXT_CONTRACT_SHA256 || !text.title_text_rects?.length ||
      !Array.isArray(text.intersections)) return 'missing';
  return text.intersections.length ? 'visual' : 'pass';
}

const readingContext = row => Object.fromEntries([
  'theme', 'candidate_sha256', 'candidate_source_sha256', 'base_css_sha256',
  'candidate_structure_sha256', 'baseline_theme_css_sha256', 'baseline_theme_mode',
  'asset_dependency_sha256', 'fixture_contract_sha256',
  'runtime_source_sha256', 'backend_runtime_identity_sha256', 'browser_engine', 'browser_version', 'viewport', 'viewport_size', 'session_state',
  'target_site', 'locale'
].map(key => [key, row[key] ?? null]));

const titleReadingContext = row => Object.fromEntries([
  'theme', 'candidate_sha256', 'candidate_source_sha256', 'base_css_sha256',
  'candidate_structure_sha256', 'baseline_theme_css_sha256', 'baseline_theme_mode',
  'asset_dependency_sha256', 'runtime_source_sha256', 'backend_runtime_identity_sha256', 'browser_engine', 'browser_version', 'viewport', 'viewport_size',
  'session_state', 'target_site', 'locale'
].map(key => [key, row[key] ?? null]));

function sameMeasuredTitleComposition(row, normal) {
  if (!normal || row.title_text_contract_sha256 !== TITLE_TEXT_CONTRACT_SHA256 ||
      normal.title_text_contract_sha256 !== TITLE_TEXT_CONTRACT_SHA256 ||
      row.title_composition_contract_sha256 !== TITLE_COMPOSITION_CONTRACT_SHA256 ||
      normal.title_composition_contract_sha256 !== TITLE_COMPOSITION_CONTRACT_SHA256) return false;
  const text = value => value?.title_text_measurement?.schema === 'theme_lab_title_text_intersections.v1' &&
    value.title_text_measurement.complete === true ? value.title_text_measurement : null;
  const composition = value => value?.title_composition_measurement?.schema === 'theme_lab_title_composition.v1' &&
    value.title_composition_measurement.complete === true ? value.title_composition_measurement : null;
  return text(row) && text(normal) && composition(row) && composition(normal) &&
    JSON.stringify(text(row)) === JSON.stringify(text(normal)) &&
    JSON.stringify(composition(row)) === JSON.stringify(composition(normal));
}

const sameRect = (left,right) => left && right && ['x','y','width','height'].every(key =>
  Number.isFinite(left[key]) && Number.isFinite(right[key]) && Math.abs(left[key]-right[key]) <= 1);

function samePersistentTitleIntersection(left,right) {
  return sameRect(left?.rect,right?.rect) && ['tag','id','class','text','color','background','position','z','effectively_visible']
    .every(key => (left?.[key] ?? null) === (right?.[key] ?? null));
}

const identityQuestion = 'Does the JP rendering preserve the frozen source theme’s intentional imagery, typography, palette and information hierarchy across the evidenced responsive layouts, including page-title readability against persistent shell controls in normal reading states, allowing only documented localization differences?';

const identityQuestionId = row => hash({kind: 'source_visual_identity', theme: row.theme,
  candidate: row.candidate_sha256, source: row.candidate_source_sha256,
  base: row.base_css_sha256 ?? null, baseline: row.baseline_theme_css_sha256});

export function planBrowserAcceptance(audit) {
  const questions = new Map();
  const observations = [];
  const normalRows = new Map((audit.records ?? []).filter(row => row.surface === 'page.normal' && row.state === 'settled')
    .map(row => [JSON.stringify(readingContext(row)), row]));
  const titleNormalRows = new Map((audit.records ?? []).filter(row => row.surface === 'page.normal' && row.state === 'settled')
    .map(row => [JSON.stringify(titleReadingContext(row)), row]));
  for (const row of audit.records ?? []) {
    const key = observationKey(row), dependencies = observationDependencies(row);
    const facts = measuredFacts(row);
    facts.title_composition = titleCompositionFact(row);
    const titleNormal = titleNormalRows.get(JSON.stringify(titleReadingContext(row)));
    const identityCompositionCovered = facts.title_composition === 'visual' &&
      (row.surface === 'page.normal' && row.state === 'settled' || sameMeasuredTitleComposition(row, titleNormal));
    if (identityCompositionCovered) facts.title_composition = 'visual-identity';
    const required = [];
    if (row.surface === 'page.normal') {
      // One source-identity question can cite several responsive observations.
      // It requires a review of the whole declared evidence set, never an
      // unexplained representative image or screenshot-hash deduplication.
      const id = identityQuestionId(row);
      const question = questions.get(id) ?? {id, kind: 'source_visual_identity', theme: row.theme,
        question: identityQuestion, reason: 'Computed layout cannot decide preservation of artistic source identity.', observations: []};
      const identityDependencies = {...dependencies};
      // A new geometry observer cannot change the painted artistic identity.
      // Its facts still gate completion separately and its producer remains a
      // dependency of a composition question that uses the measurement.
      delete identityDependencies.title_composition_contract_sha256;
      delete identityDependencies.title_text_contract_sha256;
      // The image binds the normal state's painted outcome. Current action
      // execution is a separate mandatory fact, not another artistic review.
      delete identityDependencies.capture_state_action_contract_sha256;
      question.observations.push({key, dependencies_sha256: hash(identityDependencies), screenshot_sha256: row.screenshot_sha256});
      questions.set(id, question); required.push(id);
    }
    if (identityCompositionCovered && row.surface !== 'page.normal' && titleNormal) required.push(identityQuestionId(titleNormal));
    if (facts.title_composition === 'visual') {
      const overlaps = row.title_text_measurement.intersections;
      // The obligation is the composition of these elements, not the action
      // that reached it. Geometry may vary responsively within one question;
      // every different state/image/dependency still enters its evidence set.
      // This does not declare the images equivalent or reuse a PASS by pixels.
      const elements = overlaps.map(item => Object.fromEntries(['tag','id','class','text','color','background','position','z'].map(key => [key,item[key]??null])))
        .sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const id = hash({kind: 'ambiguous_title_composition', theme:row.theme,
        candidate:row.candidate_sha256, source:row.candidate_source_sha256,
        base:row.base_css_sha256??null, baseline:row.baseline_theme_css_sha256,
        fixture:row.fixture_contract_sha256, elements});
      const labels = [...new Set(elements.map(item=>item.id?`#${item.id}`:item.class?`${item.tag}.${item.class}`:`${item.tag}: ${String(item.text??'').slice(0,80)}`))].join('; ');
      const question = questions.get(id) ?? {id, kind: 'ambiguous_composition', theme: row.theme, intersecting_elements: elements,
        question: `For ${labels}, is the measured layering over the page title an intentional source composition across the declared responsive/action states, with the title readable in its intended reading state and intersecting controls usable in their action states?`,
        reason: 'Visibility and geometry establish an intersection; its intended composition requires source and visual interpretation.',
        observations: []};
      question.observations.push({key, dependencies_sha256: hash(dependencies), screenshot_sha256: row.screenshot_sha256});
      questions.set(id,question);
      required.push(id);
    }
    const machineFailures = Object.keys(facts).filter(name => facts[name] === 'fail');
    // A document_containment failure moves to machine_explanations only when a
    // faithful-design exemption entry matches this observation exactly (theme,
    // observation key, both measured overflows and the observation dependency
    // hash). Any drift leaves the failure standing.
    let containmentExemption = null;
    if (facts.document_containment === 'fail') {
      const {candidateOverflow, baselineOverflow} = documentContainmentOverflows(row);
      containmentExemption = matchFaithfulDesignContainment(loadFaithfulDesignExemptions(), {
        theme: row.theme, observationKey: key, candidateOverflowPx: candidateOverflow,
        baselineOverflowPx: baselineOverflow, dependenciesSha256: hash(dependencies)});
      if (containmentExemption) machineFailures.splice(machineFailures.indexOf('document_containment'), 1);
    }
    observations.push({key, dependencies_sha256: hash(dependencies), facts, visual_questions: required,
      machine_explanations: [
        ...(identityCompositionCovered ? ['title_composition: exact measured composition is covered by the source-identity review of the corresponding normal reading state'] : []),
        ...(containmentExemption ? [`document_containment: faithful-design exemption ${containmentExemption.id} (decision ${containmentExemption.decision}); the measured candidate and baseline overflows remain recorded in the observation facts`] : []),
      ],
      machine_failures: machineFailures,
      additional_machine_evidence: Object.keys(facts).filter(name => facts[name] === 'missing')});
    observations.at(-1).additional_source_authority = Object.keys(facts).filter(name => facts[name] === 'source-required');
  }
  const visualQuestions = [...questions.values()].map(question => ({...question,
    evidence_sha256: hash(question.observations.slice().sort((a, b) => a.key.localeCompare(b.key)))}));
  return {schema: SEMANTIC_BROWSER_MODEL, decision_authority: 'SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY',
    port_conclusion_eligible: false, observations, visual_questions: visualQuestions,
    accounting: {browser_records: observations.length,
      machine_settled_facts: observations.reduce((sum, row) => sum + Object.values(row.facts).filter(value => value === 'pass').length, 0),
      machine_failure_records: observations.filter(row => row.machine_failures.length).length,
      additional_machine_evidence_records: observations.filter(row => row.additional_machine_evidence.length).length,
      additional_source_authority_records: observations.filter(row => row.additional_source_authority.length).length,
      distinct_visual_questions: visualQuestions.length}};
}

export function validateSemanticBrowserAcceptance(audit) {
  const plan = planBrowserAcceptance(audit), failures = [];
  if (!plan.observations.length) failures.push('Semantic acceptance has no browser observations');
  for (const row of plan.observations) {
    for (const fact of row.machine_failures) failures.push(`${row.key}: machine failure ${fact}`);
    for (const fact of row.additional_machine_evidence) failures.push(`${row.key}: missing structured evidence ${fact}`);
    for (const fact of row.additional_source_authority) failures.push(`${row.key}: source authority required for ${fact}; the requested action was not exercised`);
  }
  for (const question of plan.visual_questions) {
    const review = audit.semantic_reviews?.[question.id];
    if (review?.question !== question.question || review?.evidence_sha256 !== question.evidence_sha256 ||
        review?.method !== 'direct-visual-question-review' || !['pass', 'warn'].includes(review?.status) ||
        typeof review?.note !== 'string' || review.note.trim().length < 12 ||
        typeof review?.reviewer !== 'string' || !review.reviewer.trim() || !Number.isFinite(Date.parse(review?.reviewed_at)) ||
        review?.decision_authority !== 'SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY' || review.port_conclusion_eligible !== false ||
        !/^https:\/\/[a-z0-9-]+\.wikidot\.com\//u.test(review?.source_url ?? '') ||
        typeof review?.source_snapshot?.path !== 'string' || !validHash(review?.source_snapshot?.sha256) ||
        !semanticSourceRenderings(question, review).every(rendering =>
          ['source_html', 'source_rendering', 'source_rendering_receipt'].every(key =>
            typeof rendering?.[key]?.path === 'string' && validHash(rendering[key].sha256)))) {
      failures.push(`${question.theme}: unanswered or stale visual question ${question.id}`);
    }
  }
  return {status: failures.length ? 'inconclusive' : 'pass', failures, accounting: plan.accounting};
}

// A responsive question needs an upstream rendering for each declared viewport.
// The singular legacy form can bind only a question with one viewport.
export function semanticSourceRenderings(question, review) {
  const viewports = [...new Set(question.observations.map(row => JSON.parse(row.key)[2]))];
  return viewports.map(viewport => ({
    ...(review?.source_renderings?.[viewport] ?? (viewports.length === 1 ? review : {})), viewport}));
}

// Question reviews do not become source authority merely by naming a digest.
// Completion independently opens every source snapshot and source rendering.
export function semanticReviewArtifactBindings(audit) {
  return planBrowserAcceptance(audit).visual_questions.flatMap(question => {
    const review = audit.semantic_reviews?.[question.id];
    return [{binding: review?.source_snapshot, label: `${question.theme}/${question.kind}/source_snapshot`},
      ...semanticSourceRenderings(question, review).flatMap(rendering =>
        ['source_html', 'source_rendering', 'source_rendering_receipt'].map(key =>
          ({binding: rendering[key], label: `${question.theme}/${question.kind}/${rendering.viewport}/${key}`})))];
  });
}
