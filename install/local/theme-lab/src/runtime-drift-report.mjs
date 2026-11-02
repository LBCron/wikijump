// Theme Lab runtime drift report (ALLOC-32 R4 Check 3).
//
// NON-FATAL comparison of the frozen record's recorded identities against
// the live tree, per package and per identity class (runtime, authority).
// It reports drift; it never re-accepts anything, and it never describes
// the live state with the word the ruling reserves for accepted records
// outside the one mandated summary sentence below.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {framerailSourceFingerprintSync} from './framerail-source-fingerprint.mjs';
import {runtimeSurfaceContractSha} from './browser-runtime-contract.mjs';
import {CLOSURE_PACKAGES, DEFAULT_HISTORICAL_ROOT} from './campaign-record-integrity.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const themeLabRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (root, relative) => {
  try { return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8')); } catch { return null; }
};
const fileSha = (root, relative) => {
  try { return sha(fs.readFileSync(path.join(root, relative))); } catch { return null; }
};

export function buildRuntimeDriftReport(root, {
  historicalRoot = DEFAULT_HISTORICAL_ROOT,
  anchors = null,
  liveFramerailFingerprint = null,
  liveTargetPageRuntimeSha256 = null,
} = {}) {
  const repoRoot = path.resolve(root, '../../..');
  const acceptance = readJson(historicalRoot, 'current-campaign-acceptance.json');
  if (!acceptance) throw new Error('archived acceptance document is unavailable in historical/');
  const recordedByPackage = new Map((acceptance.packages ?? []).map(row => [row.package, row]));
  const liveFingerprint = liveFramerailFingerprint ?? framerailSourceFingerprintSync(repoRoot);
  const livePageRuntime = liveTargetPageRuntimeSha256 ?? runtimeSurfaceContractSha(repoRoot, 'page.normal', 'mobile');
  const liveLedgerSha = fileSha(root, 'ports/adaptation-authority.json');
  const liveFrozen = readJson(root, 'publication/frozen-candidate-set.json');
  const liveBhlAuthoritySha = fileSha(root, 'ports/black-highlighter-theme/option-scenarios/authority.json');
  const frozenClosure = readJson(historicalRoot, 'publication/frozen-candidate-set.json');
  const recordedLedgerSha = fileSha(historicalRoot, 'ports/adaptation-authority.json');
  const recordedBhlAuthoritySha = frozenClosure?.authority?.bhl_option_authority_sha256 ?? null;
  // Recorded per-result runtime identities come from the archived results
  // only through their acceptance bindings; the uniform closure values are
  // read from the archived contracts in historical/.
  const sigma9 = readJson(historicalRoot, 'ports/current-acceptance/run-contract-campaign-20261028-s9.json');
  const recordedFingerprint = sigma9?.expected_runtime_source_sha256 ?? null;
  const recordedBackend = sigma9?.expected_backend_runtime_identity?.identity_sha256 ?? null;
  const recordedPageRuntime = anchors?.recordedTargetPageRuntimeSha256 ?? '8e02ddd62fe1c928b851fea38494ef79b1a0da198490b86a26526f6887d3d318';
  const liveBhl = readJson(root, 'ports/black-highlighter-theme/option-scenarios/authority.json');
  const liveBackend = liveBhl?.backend_runtime_identity?.identity_sha256 ?? null;
  const packages = [];
  let supersededRuntime = 0;
  for (const name of CLOSURE_PACKAGES) {
    const row = recordedByPackage.get(name);
    const runtimeDrift = recordedFingerprint !== liveFingerprint || recordedPageRuntime !== livePageRuntime;
    if (runtimeDrift) supersededRuntime++;
    packages.push({
      package: name,
      recorded_receipt_sha256: row?.receipt?.sha256 ?? null,
      runtime: {
        recorded_framerail_fingerprint: recordedFingerprint,
        live_framerail_fingerprint: liveFingerprint,
        recorded_target_page_runtime_sha256: recordedPageRuntime,
        live_target_page_runtime_sha256: livePageRuntime,
        recorded_backend_identity_sha256: recordedBackend,
        live_backend_identity_sha256: liveBackend,
        superseded: runtimeDrift,
      },
      authority: {
        recorded_adaptation_ledger_sha256: recordedLedgerSha,
        live_adaptation_ledger_sha256: liveLedgerSha,
        recorded_candidate_set_sha256: frozenClosure?.candidate_set_sha256 ?? null,
        live_candidate_set_sha256: liveFrozen?.candidate_set_sha256 ?? null,
        ...(name === 'black-highlighter-theme' ? {
          recorded_bhl_option_authority_sha256: recordedBhlAuthoritySha,
          live_bhl_option_authority_sha256: liveBhlAuthoritySha,
        } : {}),
      },
    });
  }
  return {
    schema: 'theme_lab_runtime_drift_report.v1',
    // Mandated summary wording (ALLOC-32 R4 Check 3). It describes the
    // recorded state, not the live one.
    summary: `${supersededRuntime} packages accepted under a superseded runtime; re-acceptance is next-campaign work.`,
    superseded_runtime_packages: supersededRuntime,
    packages,
  };
}
