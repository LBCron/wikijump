// Canonical-runner OD-T1 containment waivers (branch L, TL-13).
//
// The canonical matrix runner measures document overflow live
// (theme-canonical-execution.mjs) but never consults the TL-05 ledger, so
// OD-T1-covered containment overflows throw at theme-test-matrix.mjs:28.
// This module waives exactly those failures, and nothing else.
//
// Same-code-path notes: the ledger loads through loadFaithfulDesignExemptions
// (the loader finalize uses); the observation key uses the
// semantic-browser-acceptance.mjs:26 [theme, engine, viewport, surface,
// state] shape; entry comparison repeats the
// matchFaithfulDesignContainment predicate
// narrowed to decision OD-T1;
// finding hashes use canonicalJson (same canonicalization finalize uses).
// One deliberate substitution, documented: the capture-row
// dependencies_sha256 cannot be minted on the canonical path (there is no
// capture row), so the TL-05 exact-binding invariant is carried instead by
// exact candidate/source sha anchors plus the scenario sha recorded in
// every waiver. Any drift re-fails the finding.
import {ACCEPTANCE_VIEWPORTS} from './acceptance-viewports.mjs';
import {canonicalJson,loadFaithfulDesignExemptions} from './faithful-design-exemptions.mjs';
import {observationKey} from './semantic-browser-acceptance.mjs';
import crypto from 'node:crypto';

const sha256hex=value=>crypto.createHash('sha256').update(value).digest('hex');

// Canonical interaction states whose failure is a document-overflow
// measurement, mapped to the ledger (surface, state) vocabulary. Both
// states measure the settled document: `settled` at the current viewport,
// `responsive-shell` at mobile width with no interaction applied, which is
// the settled document at the mobile viewport. No other state, probe, or
// check is waiver-eligible.
const WAIVER_ELIGIBLE_OVERFLOW_STATES=Object.freeze({settled:['page.normal','settled'],'responsive-shell':['page.normal','settled']});

export function viewportIdForWidth(width){
  return ACCEPTANCE_VIEWPORTS.find(row=>row.width===width)?.id??null;
}

export function loadCanonicalLedgerDocument(){
  return loadFaithfulDesignExemptions();
}

// failures: [{engine, sessionProfile, kind:'check'|'state'|'probe', id,
// viewportWidth, candidateOverflowPx, baselineOverflowPx}]. Returns waiver
// records; failures without a covering OD-T1 entry are simply absent.
export function matchCanonicalContainmentWaivers(document,{packageName,themeCssSha256,themeSourceSha256,scenarioSha256,failures}){
  const waivers=[];
  for(const failure of failures??[]){
    if(failure?.kind!=='state')continue;
    const mapped=WAIVER_ELIGIBLE_OVERFLOW_STATES[failure.id];
    const viewport=mapped?viewportIdForWidth(failure.viewportWidth):null;
    if(!mapped||!viewport)continue;
    const {candidateOverflowPx,baselineOverflowPx}=failure;
    if(!Number.isInteger(candidateOverflowPx)||!Number.isInteger(baselineOverflowPx))continue;
    const key=observationKey({theme:packageName,browser_engine:failure.engine,viewport,surface:mapped[0],state:mapped[1]});
    const entry=(document?.entries??[]).find(candidate=>
      candidate?.instrument==='semantic_document_containment'&&
      candidate?.decision==='OD-T1'&&
      candidate?.package===packageName&&
      candidate?.match?.observation_key===key&&
      candidate?.match?.candidate_overflow_px===candidateOverflowPx&&
      candidate?.match?.baseline_overflow_px===baselineOverflowPx&&
      candidate?.candidate_source_sha256===themeSourceSha256&&
      candidate?.candidate_sha256===themeCssSha256);
    if(!entry)continue;
    const record={state:failure.id,engine:failure.engine,session_profile:failure.sessionProfile,viewport,entry_id:entry.id,
      candidate_overflow_px:candidateOverflowPx,baseline_overflow_px:baselineOverflowPx,package:packageName,scenario_sha256:scenarioSha256};
    waivers.push({...record,finding_sha256:sha256hex(canonicalJson(record))});
  }
  return waivers;
}
