import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {collectViewportOverflow,inspectPlatformFonts} from './browser-lab.mjs';
import {
  buildVerdict,
  DOCUMENT_OVERFLOW_TOLERANCE_PX,
  issuesFromInteractions,
  issuesFromPreview,
  issuesFromSelectorDiagnosis,
  issuesFromTorture,
  issuesFromViewports,
  nextActions,
  overallAcceptance,
  styleChangesFromComputed,
  summarizeVisual,
} from './verdict.mjs';
import {applyRuntimeSurfaceParityGate,RUNTIME_SURFACE_PARITY} from './runtime-surface-parity.mjs';
import {measureTargetBaselineViewportOverflow} from './target-baseline-viewport-probe.mjs';
import {classifyViewportOverflowIssue,classifyViewportOverflowIssues,stateCapturesFromSurfaceCaptures} from './viewport-overflow-classification.mjs';
import {localModuleClosureSha256} from './local-module-closure.mjs';
import {runtimeSurfaceContractSha} from './browser-runtime-contract.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const themeLabRoot=path.resolve(here,'..');
const shaFile=relative=>crypto.createHash('sha256').update(fs.readFileSync(path.join(themeLabRoot,relative))).digest('hex');

// Semantic identity for one full package target-acceptance check. Keep this
// narrower than a whole-source-tree hash so unrelated Theme Lab refactors do
// not invalidate every accepted package, while changes to the viewport
// measurement/verdict primitives or the declared attribution model do.
export const TARGET_ACCEPTANCE_CONTRACT = Object.freeze({
  schema: 'theme_lab_target_acceptance_contract.v1',
  viewport_overflow: {
    attribution: 'candidate-minus-same-preview-target-baseline',
    candidate_layer_probe: 'blank-in-place-and-restore-in-finally',
    tolerance_px: DOCUMENT_OVERFLOW_TOLERANCE_PX,
    // Issue #3381: findings carry a hard/parked/unknown state classification
    // with parked/reveal/reference evidence. Severity is unchanged and the
    // recorded per-package/per-rule exemptions remain the disposition.
    state_classification: 'hard-parked-unknown-v1',
  },
  target_fixture_binding: ['baseline', 'sidebar', 'header', 'navigation'],
  program_module_closure_sha256: localModuleClosureSha256(new URL('./session-server.mjs',import.meta.url),{root:themeLabRoot}),
  static_inputs: {
    runtime_surface_parity_sha256: shaFile('fixtures/runtime-surface-parity.json'),
    surface_contract_fixture_sha256: shaFile('ports/interactive-visual-fixture/fixture.wikidot.txt'),
    torture_fixture_sha256: shaFile('fixtures/theme-torture.wikidot.txt'),
    torture_native_rating_sha256:shaFile('fixtures/wikidot-rate-widget.html'),
    torture_native_rating_provenance_sha256:shaFile('fixtures/wikidot-rate-widget.provenance.json'),
    // Full acceptance replaces article content with source, surface and
    // torture previews. Their native tab initialization is runtime behavior.
    target_page_runtime_sha256:runtimeSurfaceContractSha(path.resolve(themeLabRoot,'../../..'),'page.normal','mobile'),
  },
});

// The recorded closure value of the one runtime-derived contract field,
// static_inputs.target_page_runtime_sha256 (CLOSURE_ANCHORS (b) in
// src/campaign-record-integrity.mjs). The instrument digest below is
// computed with this value substituted for the live runtime surface, so a
// runtime-only move never moves the instrument identity; the live value is
// recorded on each verdict as target_page_runtime_sha256 instead. This
// literal must equal CLOSURE_ANCHORS.recordedTargetPageRuntimeSha256; a
// test pins the equality. It is not imported from campaign-record-integrity:
// that module sits outside the session-server program closure, and an
// import would widen the closure and create a cycle.
export const RECORDED_TARGET_PAGE_RUNTIME_SHA256 = '8e02ddd62fe1c928b851fea38494ef79b1a0da198490b86a26526f6887d3d318';

// The measurement functions whose sources the instrument digest binds.
export const TARGET_ACCEPTANCE_CONTRACT_FUNCTIONS = Object.freeze([
  collectViewportOverflow,
  inspectPlatformFonts,
  measureTargetBaselineViewportOverflow,
  issuesFromSelectorDiagnosis,
  issuesFromTorture,
  issuesFromViewports,
  issuesFromPreview,
  issuesFromInteractions,
  styleChangesFromComputed,
  nextActions,
  summarizeVisual,
  overallAcceptance,
  applyRuntimeSurfaceParityGate,
  buildVerdict,
  classifyViewportOverflowIssue,
  classifyViewportOverflowIssues,
  stateCapturesFromSurfaceCaptures,
]);

// The instrument-proper digest: the single derivation of the target
// acceptance contract identity. The contract is hashed with the recorded
// runtime value substituted for the live one, so the digest names the
// measurement instrument and nothing else. There is deliberately no
// second, runtime-binding digest: admission and comparability decisions
// (Check 2, campaign completion, visual finalization) are made against
// this value and the admitted-instrument registry
// (src/target-acceptance-instruments.mjs) only.
export function targetAcceptanceContractSha256(contract = TARGET_ACCEPTANCE_CONTRACT, functions = TARGET_ACCEPTANCE_CONTRACT_FUNCTIONS) {
  const substituted = {
    ...contract,
    static_inputs: {...contract.static_inputs, target_page_runtime_sha256: RECORDED_TARGET_PAGE_RUNTIME_SHA256},
  };
  return crypto.createHash('sha256')
    .update(JSON.stringify(substituted)).update('\0')
    .update(JSON.stringify(RUNTIME_SURFACE_PARITY)).update('\0')
    .update(functions.map(fn => fn.toString()).join('\0'))
    .digest('hex');
}

export const TARGET_ACCEPTANCE_CONTRACT_SHA256 = targetAcceptanceContractSha256();
