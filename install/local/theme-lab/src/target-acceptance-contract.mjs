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

export const TARGET_ACCEPTANCE_CONTRACT_SHA256 = crypto.createHash('sha256')
  .update(JSON.stringify(TARGET_ACCEPTANCE_CONTRACT)).update('\0')
  .update(JSON.stringify(RUNTIME_SURFACE_PARITY)).update('\0')
  .update([
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
  ].map(fn=>fn.toString()).join('\0'))
  .digest('hex');
