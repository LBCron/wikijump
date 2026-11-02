import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyViewportOverflowIssue,
  stateCapturesFromSurfaceCaptures,
} from "../src/viewport-overflow-classification.mjs";
import {buildVerdict, issuesFromViewports} from "../src/verdict.mjs";

// Canonical G2-47 fixture (cosmonaut .hovertip): parked at right:-25rem on a
// 1440px desktop viewport, so the 200px tip sits fully off-canvas with a
// 400px right escape; in its shown state (right:1rem) it is in-viewport.
const PARKED_SOURCE = {
  selector: "#edit-button-hovertip",
  tag: "div",
  class_name: "hovertip",
  rect: {left: 1640, right: 1840, width: 200},
  overflow_px: 400,
  off_left_px: 0,
  off_right_px: 400,
  computed: {position: "fixed"},
};
const REVEAL_RECT = {left: 1224, right: 1424, width: 200};
const revealCapture = (overrides = {}) => ({
  state: "editor-shown",
  viewport: "desktop",
  viewport_width: 1440,
  elements: [{selector: "#edit-button-hovertip", rect: REVEAL_RECT, visible: true}],
  overflow_sources: [],
  ...overrides,
});
const parkedIssue = () => issuesFromViewports({
  desktop: {document_overflow_px: 0, viewport_escape_px: 400, overflow_sources: [PARKED_SOURCE]},
})[0];
const matchingReference = {desktop: {overflow_sources: [PARKED_SOURCE]}};

test("faithful parked slide-in with an in-viewport reveal classifies PARKED with evidence", () => {
  const issue = classifyViewportOverflowIssue(parkedIssue(), {
    stateCaptures: [revealCapture()],
    referenceViewports: matchingReference,
  });
  assert.equal(issue.classification, "parked");
  // PARKED is recorded for a named disposition, never auto-passed.
  assert.equal(issue.severity, "error");
  assert.equal(issue.kind, "viewport_overflow");
  assert.equal(issue.viewport, "desktop");
  assert.deepEqual(issue.parked_rect, PARKED_SOURCE.rect);
  assert.deepEqual(issue.reveal_rect, REVEAL_RECT);
  assert.equal(issue.reveal_state, "editor-shown");
  assert.equal(issue.reference_match, true);
});

test("parked slide-in without a frozen reference still classifies PARKED, reference_match null", () => {
  const issue = classifyViewportOverflowIssue(parkedIssue(), {stateCaptures: [revealCapture()]});
  assert.equal(issue.classification, "parked");
  assert.equal(issue.reference_match, null);
});

test("visible-content overflow classifies HARD even when other states were captured", () => {
  const visible = issuesFromViewports({
    desktop: {
      document_overflow_px: 60,
      viewport_escape_px: 60,
      overflow_sources: [{selector: "#page-content .article", rect: {left: 0, right: 1500, width: 1500}, overflow_px: 60, off_left_px: 0, off_right_px: 60}],
    },
  })[0];
  const issue = classifyViewportOverflowIssue(visible, {stateCaptures: [revealCapture()]});
  assert.equal(issue.classification, "hard");
  assert.equal(issue.severity, "error");
});

test("overflow that persists in the reveal state classifies HARD", () => {
  const issue = classifyViewportOverflowIssue(parkedIssue(), {
    stateCaptures: [revealCapture({
      elements: [{selector: "#edit-button-hovertip", rect: {left: 1300, right: 1500, width: 200}, visible: true}],
      overflow_sources: [{selector: "#edit-button-hovertip", rect: {left: 1300, right: 1500, width: 200}, overflow_px: 60, off_left_px: 0, off_right_px: 60}],
    })],
  });
  assert.equal(issue.classification, "hard");
  assert.equal(issue.severity, "error");
});

test("parked overflow with no captured reveal state classifies UNKNOWN and stays an error", () => {
  const issue = classifyViewportOverflowIssue(parkedIssue(), {stateCaptures: []});
  assert.equal(issue.classification, "unknown");
  assert.equal(issue.severity, "error");
  assert.equal(issue.reveal_rect, undefined);
});

test("parked overflow with a reference geometry mismatch classifies UNKNOWN", () => {
  const mismatched = {desktop: {overflow_sources: [{...PARKED_SOURCE, overflow_px: 40, off_right_px: 40}]}};
  const issue = classifyViewportOverflowIssue(parkedIssue(), {
    stateCaptures: [revealCapture()],
    referenceViewports: mismatched,
  });
  assert.equal(issue.classification, "unknown");
  assert.equal(issue.severity, "error");
  assert.equal(issue.reference_match, false);
});

test("transition evidence on the parked property is attached when a capture records it", () => {
  const issue = classifyViewportOverflowIssue(parkedIssue(), {
    stateCaptures: [revealCapture({
      elements: [{selector: "#edit-button-hovertip", rect: REVEAL_RECT, visible: true, transition: {property: "right", from: "-25rem", to: "1rem"}}],
    })],
  });
  assert.equal(issue.classification, "parked");
  assert.deepEqual(issue.transition_evidence, {property: "right", from: "-25rem", to: "1rem"});
});

test("overflow without attributable sources stays HARD", () => {
  const issue = classifyViewportOverflowIssue(
    issuesFromViewports({desktop: {document_overflow_px: 83}})[0],
    {stateCaptures: [revealCapture()]},
  );
  assert.equal(issue.classification, "hard");
});

test("surface captures adapt to candidate-only state captures with probe rects", () => {
  const captures = stateCapturesFromSurfaceCaptures([
    {mode: "baseline", surface: "page.actions", state: "normal", viewport: "desktop", viewport_width: 1440, rows: {}, overflow_sources: []},
    {
      mode: "theme", surface: "page.actions", state: "editor-shown", viewport: "desktop", viewport_width: 1440,
      rows: {"#edit-button-hovertip": {selector: "#edit-button-hovertip", present: true, visible: true, rect: REVEAL_RECT}},
      overflow_sources: [],
    },
  ]);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].state, "editor-shown");
  assert.deepEqual(captures[0].elements, [{selector: "#edit-button-hovertip", rect: REVEAL_RECT, visible: true}]);
  const issue = classifyViewportOverflowIssue(parkedIssue(), {stateCaptures: captures});
  assert.equal(issue.classification, "parked");
});

test("buildVerdict annotates viewport_overflow issues without changing severity or counts", () => {
  const verdict = buildVerdict({
    viewports: {desktop: {document_overflow_px: 0, viewport_escape_px: 400, overflow_sources: [PARKED_SOURCE]}},
    overflowStateCaptures: [revealCapture()],
    referenceViewports: matchingReference,
  });
  const issue = verdict.top_issues.find((row) => row.kind === "viewport_overflow");
  assert.equal(issue.classification, "parked");
  assert.equal(issue.reference_match, true);
  assert.equal(issue.severity, "error");
  assert.equal(verdict.target_acceptance.status, "fail");
  assert.equal(verdict.issue_count, 1);
});
