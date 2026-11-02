// State-aware classification for `viewport_overflow` findings (issue #3381,
// GATE-IMPROVEMENT-DESIGN.md). The gate measures geometry without state
// context, so a faithful slide-in parked off-canvas (cosmonaut `.hovertip`,
// G2-47) arrives as a bare ERROR indistinguishable from visible content
// spilling out of the viewport. This module classifies each finding without
// changing its severity or dropping it:
//
// - hard:    overflow in a state where the element is presented as visible,
//            or overflow that persists in the element's reveal state.
// - parked:  overflow only in a parked (fully off-canvas) state, a captured
//            reveal state of the same element is in-viewport, and, where a
//            frozen reference rendering exists, it shows the same overflow
//            geometry. Evidence (parked rect, reveal rect/state, reference
//            match) is attached; a per-package/per-rule disposition in the
//            faithful-design exemption ledger remains what settles it.
// - unknown: parked overflow with no captured reveal state, or a reference
//            mismatch. Intent cannot be decided from geometry alone, so the
//            ERROR stays (hover/keyboard-only reveals land here).
//
// Nothing is auto-passed: classification only annotates the finding.

export const VIEWPORT_OVERFLOW_CLASSIFICATIONS = Object.freeze(["hard", "parked", "unknown"]);

function rectOf(row) {
  const rect = row?.rect;
  if (!rect || typeof rect.left !== "number" || typeof rect.right !== "number") return null;
  return rect;
}

// Viewport width for a parked source, derived from its own escape geometry
// when the capture did not record one explicitly.
function sourceViewportWidth(source) {
  if (typeof source?.viewport_width === "number") return source.viewport_width;
  const rect = rectOf(source);
  if (!rect) return null;
  if ((source.off_right_px ?? 0) > 0) return rect.right - source.off_right_px;
  return null;
}

function fullyOffCanvas(rect, viewportWidth, tolerancePx) {
  if (!rect) return false;
  if (rect.right <= 1) return true; // parked off the left edge
  return viewportWidth !== null && rect.left >= viewportWidth - 1;
}

function intersectsViewport(rect, viewportWidth) {
  if (!rect || rect.right <= 1) return false;
  return viewportWidth === null || rect.left < viewportWidth - 1;
}

function inViewport(rect, viewportWidth, tolerancePx) {
  if (!rect || viewportWidth === null) return false;
  return rect.left >= -tolerancePx && rect.right <= viewportWidth + tolerancePx;
}

function overflowsViewport(rect, viewportWidth, tolerancePx) {
  if (!rect || viewportWidth === null) return false;
  return rect.left < -tolerancePx || rect.right > viewportWidth + tolerancePx;
}

// Normalize one captured state into selector-keyed element observations.
// Captures may carry explicit `elements`, surface-contract probe `rows`
// (object keyed by probe key, or an array), and `overflow_sources`.
function observationsFromCapture(capture) {
  const observations = new Map();
  const add = (row, overflowing) => {
    const selector = row?.selector;
    const rect = rectOf(row);
    if (typeof selector !== "string" || !rect) return;
    const previous = observations.get(selector);
    observations.set(selector, {
      selector,
      rect,
      visible: row.visible !== false && previous?.visible !== false,
      overflowing: Boolean(overflowing || previous?.overflowing),
      state: capture.state ?? null,
      viewport_width: capture.viewport_width ?? capture.width ?? null,
      ...(row.transition ? {transition: row.transition} : {}),
      ...(previous?.transition && !row.transition ? {transition: previous.transition} : {}),
    });
  };
  for (const source of capture.overflow_sources ?? []) add(source, true);
  const rows = Array.isArray(capture.rows) ? capture.rows : Object.values(capture.rows ?? {});
  for (const row of rows) {
    if (row?.pseudo || (typeof row?.selector === "string" && row.selector.includes("::"))) continue;
    if (row?.present === false) continue;
    add(row, observations.get(row?.selector)?.overflowing ?? false);
  }
  for (const element of capture.elements ?? []) add(element, element.overflowing ?? observations.get(element?.selector)?.overflowing ?? false);
  return observations;
}

// Adapt surface-contract captures (baseline + theme pairs) to the candidate
// state captures the classifier consumes. Only themed captures can reveal
// candidate geometry; probe rows supply the element rects.
export function stateCapturesFromSurfaceCaptures(captures) {
  return (captures ?? [])
    .filter((capture) => !capture?.mode || capture.mode === "theme")
    .map((capture) => {
      const elements = [];
      const rows = Array.isArray(capture.rows) ? capture.rows : Object.values(capture.rows ?? {});
      for (const row of rows) {
        if (!row || row.pseudo || row.present === false || typeof row.selector !== "string" || row.selector.includes("::")) continue;
        const rect = rectOf(row);
        if (rect) elements.push({selector: row.selector, rect, visible: row.visible !== false});
      }
      for (const element of capture.elements ?? []) {
        const rect = rectOf(element);
        if (rect && typeof element.selector === "string") elements.push({selector: element.selector, rect, visible: element.visible !== false, ...(element.transition ? {transition: element.transition} : {})});
      }
      return {
        state: capture.state ?? null,
        surface: capture.surface ?? null,
        viewport: capture.viewport ?? null,
        viewport_width: capture.viewport_width ?? capture.width ?? null,
        elements,
        overflow_sources: capture.overflow_sources ?? [],
      };
    });
}

function referenceMatchFor(source, issue, referenceViewports, tolerancePx) {
  const reference = referenceViewports?.[issue.viewport];
  if (!reference) return null;
  const match = (reference.overflow_sources ?? []).find((row) => row?.selector === source.selector);
  if (!match) return false;
  const close = (a, b) => Math.abs((a ?? 0) - (b ?? 0)) <= tolerancePx;
  return close(match.overflow_px, source.overflow_px) &&
    close(match.off_right_px, source.off_right_px) &&
    close(match.off_left_px, source.off_left_px);
}

function classifySource(source, issue, observationsByViewport, referenceViewports, tolerancePx) {
  const rect = rectOf(source);
  if (!rect) return {classification: "hard", reason: "unattributed_source"};
  const viewportWidth = sourceViewportWidth(source);
  if (intersectsViewport(rect, viewportWidth) && !fullyOffCanvas(rect, viewportWidth, tolerancePx)) {
    return {classification: "hard", reason: "visible_overflow"};
  }
  if (!fullyOffCanvas(rect, viewportWidth, tolerancePx)) {
    // Geometry cannot even establish that the element is parked.
    return {classification: "hard", reason: "visible_overflow"};
  }
  const observations = observationsByViewport.get(source.selector) ?? [];
  let reveal = null;
  for (const observation of observations) {
    const width = observation.viewport_width ?? viewportWidth;
    if (observation.visible && inViewport(observation.rect, width, tolerancePx) && !observation.overflowing) {
      reveal = observation;
      break;
    }
    if (observation.visible && intersectsViewport(observation.rect, width) && (observation.overflowing || overflowsViewport(observation.rect, width, tolerancePx))) {
      return {classification: "hard", reason: "overflow_persists_in_reveal_state"};
    }
  }
  const referenceMatch = referenceMatchFor(source, issue, referenceViewports, tolerancePx);
  if (!reveal) return {classification: "unknown", reason: "no_captured_reveal_state", referenceMatch};
  if (referenceMatch === false) return {classification: "unknown", reason: "reference_geometry_mismatch", referenceMatch, reveal};
  return {
    classification: "parked",
    reason: "parked_with_in_viewport_reveal",
    referenceMatch,
    reveal,
    parkedRect: rect,
    transition: reveal.transition ?? source.transition ?? null,
  };
}

// Annotate one `viewport_overflow` issue. Non-overflow issues and issues
// without a viewport pass through untouched. Severity is never changed.
export function classifyViewportOverflowIssue(issue, {stateCaptures = [], referenceViewports = null, tolerancePx = 1} = {}) {
  if (!issue || issue.kind !== "viewport_overflow" || !issue.viewport) return issue;
  const sources = issue.overflow_sources ?? [];
  if (!sources.length) return {...issue, classification: "hard", classification_reason: "no_overflow_sources"};
  const observationsByViewport = new Map();
  for (const capture of stateCaptures ?? []) {
    if (capture?.viewport && capture.viewport !== issue.viewport) continue;
    for (const observation of observationsFromCapture(capture ?? {}).values()) {
      const rows = observationsByViewport.get(observation.selector) ?? [];
      rows.push(observation);
      observationsByViewport.set(observation.selector, rows);
    }
  }
  const results = sources.map((source) => classifySource(source, issue, observationsByViewport, referenceViewports, tolerancePx));
  if (results.some((row) => row.classification === "hard")) {
    const hard = results.find((row) => row.classification === "hard");
    return {...issue, classification: "hard", classification_reason: hard.reason};
  }
  if (results.every((row) => row.classification === "parked")) {
    const parked = results[0];
    return {
      ...issue,
      classification: "parked",
      classification_reason: parked.reason,
      parked_rect: parked.parkedRect,
      reveal_rect: parked.reveal.rect,
      reveal_state: parked.reveal.state,
      reference_match: parked.referenceMatch,
      ...(parked.transition ? {transition_evidence: parked.transition} : {}),
    };
  }
  const unknown = results.find((row) => row.classification === "unknown");
  return {
    ...issue,
    classification: "unknown",
    classification_reason: unknown.reason,
    ...(unknown.referenceMatch !== undefined ? {reference_match: unknown.referenceMatch} : {}),
    ...(rectOf(sources[0]) ? {parked_rect: rectOf(sources[0])} : {}),
  };
}

export function classifyViewportOverflowIssues(issues, context = {}) {
  return (issues ?? []).map((issue) => classifyViewportOverflowIssue(issue, context));
}
