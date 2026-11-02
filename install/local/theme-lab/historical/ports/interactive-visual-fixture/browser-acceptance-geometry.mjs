export function horizontalViewportEscape(rect, viewportWidth, tolerance = 1) {
  const left = Number(rect?.left);
  const right = Number(rect?.right);
  if (!Number.isFinite(left) || !Number.isFinite(right) || !Number.isFinite(viewportWidth)) {
    return {off_left_px: null, off_right_px: null, pass: false};
  }
  return {off_left_px: Math.max(0, -left), off_right_px: Math.max(0, right - viewportWidth), pass: left >= -tolerance && right <= viewportWidth + tolerance};
}

export function hasCompleteVisualReview(row, candidateSha, referenceSha) {
  return !!row && !!referenceSha && row.candidate_screenshot_sha256 === candidateSha &&
    row.reference_screenshot_sha256 === referenceSha && ['pass', 'warn', 'fail'].includes(row.status) &&
    typeof row.reviewer === 'string' && row.reviewer.trim().length > 0 &&
    typeof row.reviewed_at === 'string' && Number.isFinite(Date.parse(row.reviewed_at)) &&
    typeof row.note === 'string' && row.note.trim().length >= 12;
}

export function assetDependenciesAreCurrent(assets) {
  return Array.isArray(assets) && assets.every(asset =>
    asset && asset.status === 'local-cache' && /^[0-9a-f]{64}$/u.test(asset.sha256 ?? ''));
}
