#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {isAdmittedTargetAcceptanceContract} from '../src/target-acceptance-instruments.mjs';

export function isCurrentRawResult(result) {
  return isAdmittedTargetAcceptanceContract(result.target_acceptance_contract_sha256)
    && result.target_runtime_identity?.response_status === 200;
}

function newestRaw(root, pkg) {
  const dir = path.join(root, pkg);
  let best = null;
  for (const name of fs.readdirSync(dir).filter(n => /^raw-result.*\.json$/u.test(n))) {
    const file = path.join(dir, name);
    let doc;
    try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    const result = doc.result ?? doc;
    if (!isCurrentRawResult(result)) continue;
    const mtime = fs.statSync(file).mtimeMs;
    if (!best || mtime > best.mtime) best = {file, result, mtime};
  }
  return best;
}

export function prepareCurrentReviewDeltas(lab) {
  const root = path.join(lab, 'ports/current-acceptance');
  const ledger = JSON.parse(fs.readFileSync(path.join(lab, 'ports/adaptation-authority.json'), 'utf8'));
  const worklist = [];
  let reused = 0, total = 0;
  for (const pkg of Object.keys(ledger.packages).sort()) {
    const current = newestRaw(root, pkg);
    if (!current) throw new Error(`${pkg}: no current HTTP-200 raw result`);
    const reviewFile = path.join(root, pkg, 'visual-review.json');
    const prior = fs.existsSync(reviewFile) ? JSON.parse(fs.readFileSync(reviewFile, 'utf8')) : {};
    const r = current.result;
    const draft = {schema: 'theme_lab_visual_acceptance.v1', candidate_css_sha256: r.candidate_css_sha256, candidate_source_sha256: r.candidate_source_sha256, candidate_preview_sha256: r.candidate_preview_sha256, candidate_base_css_sha256: r.candidate_base_css_sha256 ?? null, viewports: {}};
    for (const [viewport, row] of Object.entries(r.visual?.viewports ?? {})) {
      total++;
      const old = prior.viewports?.[viewport];
      const exact = old?.candidate_screenshot_sha256 === row.candidate_screenshot_sha256 && old?.reference_screenshot_sha256 === row.reference_screenshot_sha256;
      if (exact) { draft.viewports[viewport] = old; reused++; continue; }
      worklist.push({package: pkg, viewport, candidate_path: row.candidate_path, reference_path: row.reference_path, candidate_screenshot_sha256: row.candidate_screenshot_sha256, reference_screenshot_sha256: row.reference_screenshot_sha256, raw_result: path.relative(lab, current.file)});
    }
    fs.writeFileSync(path.join(root, pkg, 'visual-review-current-draft.json'), JSON.stringify(draft, null, 2) + '\n');
  }
  const out = {schema: 'theme_lab_current_visual_review_delta_worklist.v1', total_viewports: total, reused_exact_viewports: reused, review_required_viewports: worklist.length, rows: worklist};
  const output = path.join(root, 'current-visual-review-deltas-20261007.json');
  fs.writeFileSync(output, JSON.stringify(out, null, 2) + '\n');
  return {output: path.relative(lab, output), total, reused, review_required: worklist.length};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lab = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  console.log(JSON.stringify(prepareCurrentReviewDeltas(lab)));
}
