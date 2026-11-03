import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {fileURLToPath} from "node:url";

import {KNOWN_THEME_SURFACES, analyzeThemeSurfaceUsage} from "../src/theme-surface-contract.mjs";
import {
  RUNTIME_SURFACE_PARITY,
  annotateRuntimeSurfaceUsage,
  applyRuntimeSurfaceParityGate,
  parityReviewForSurfaceIds,
  reviewRuntimeSurfaceFinding,
} from "../src/runtime-surface-parity.mjs";
import {buildVerdict} from "../src/verdict.mjs";
import accounting from "../fixtures/runtime-surface-parity-accounting.json" with {type: "json"};

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const registryById = new Map(RUNTIME_SURFACE_PARITY.surfaces.map((surface) => [surface.surface_id, surface]));

test("registry classifies every discovered and interactive runtime surface explicitly", () => {
  for (const surface of KNOWN_THEME_SURFACES.map((row) => row.id)) {
    assert.ok(registryById.has(surface), `missing parity status for ${surface}`);
  }
  for (const surface of RUNTIME_SURFACE_PARITY.surfaces) {
    assert.ok([
      "PARITY_CERTIFIED",
      "PARITY_MISMATCH",
      "INSUFFICIENT_EVIDENCE",
      "THEME_LAB_ONLY_SYNTHETIC_SURFACE",
    ].includes(surface.status), surface.surface_id);
    assert.ok("evidence_reference" in surface, surface.surface_id);
    assert.ok(Array.isArray(surface.implementation_reference), surface.surface_id);
    assert.ok(Array.isArray(surface.test_reference), surface.surface_id);
    assert.equal(typeof surface.may_treat_differences_as_port_requirements, "boolean", surface.surface_id);
    assert.equal(typeof surface.port_conclusion_eligible, "boolean", surface.surface_id);
    assert.equal(typeof surface.blocks_port_conclusion, "boolean", surface.surface_id);
    assert.ok(typeof surface.conclusion_resolution === "string" && surface.conclusion_resolution.length > 0, surface.surface_id);
    assert.ok(typeof surface.decision_scope === "string" && surface.decision_scope.length > 0, surface.surface_id);
    assert.ok(typeof surface.resolution_reason === "string" && surface.resolution_reason.length > 0, surface.surface_id);
    assert.ok(Array.isArray(surface.intentional_differences), surface.surface_id);
    assert.ok(Array.isArray(surface.unresolved_evidence_gaps), surface.surface_id);
  }
});

test("derived active runtime surfaces retain local acceptance without parity authority", () => {
  const activeIds = RUNTIME_SURFACE_PARITY.surfaces.filter((row) => row.theme_lab_activity === "ACTIVE_CSS_OR_INTERACTION_SURFACE").map((row) => row.surface_id).sort();
  const activeRows = activeIds.map((id) => registryById.get(id));

  assert.equal(activeIds.length, 41);
  for (const row of activeRows) {
    assert.equal(row.theme_lab_activity, "ACTIVE_CSS_OR_INTERACTION_SURFACE", row.surface_id);
    assert.equal(row.conclusion_resolution, "LOCAL_TARGET_ACCEPTANCE_ONLY", row.surface_id);
    assert.equal(row.decision_authority, "SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY", row.surface_id);
    assert.equal(row.port_conclusion_eligible, false, row.surface_id);
    assert.equal(row.blocks_port_conclusion, false, row.surface_id);
  }

  assert.equal(accounting.counts.active_css_or_interaction_contracts, activeIds.length);
  assert.deepEqual(accounting.active_css_or_interaction_contracts, activeIds);
  assert.equal(accounting.counts.required_but_uncertified_or_mismatched, 0);
  assert.equal(accounting.completion_gate.status, "PASS");
  assert.equal(accounting.counts.active_dependencies_removed_from_parity_port_conclusions, activeIds.length);
});

test("source records and accounting retain capture failures and narrow module limits", () => {
  const browser = JSON.parse(fs.readFileSync(path.join(root, "evidence/wikidot-runtime-surface-20260930.states-v3/records.json"), "utf8"));
  const modules = JSON.parse(fs.readFileSync(path.join(root, "evidence/wikidot-runtime-surface-modules-20260930.json"), "utf8"));
  const states = browser.evidence.flatMap((record) => record.source_states);
  assert.equal(browser.evidence.length, accounting.source_evidence.capture_counts.source_pages);
  assert.ok(browser.evidence.every((record) => record.source_only === true));
  assert.equal(states.length, accounting.source_evidence.capture_counts.browser_state_attempts);
  assert.equal(states.filter((state) => !state.capture_error).length, accounting.source_evidence.capture_counts.browser_states_captured);
  assert.equal(states.filter((state) => state.capture_error).length, accounting.source_evidence.capture_counts.browser_states_failed);
  assert.equal(browser.capture.request_gate.public_requests, 0);
  assert.equal(browser.capture.request_gate.external_network_requests, 0);
  assert.equal(browser.capture.source_response_cache.acquisition_barriers, accounting.source_evidence.capture_counts.existing_acquisition_barriers_retained);
  assert.equal(modules.actor.authenticated, false);
  assert.equal(modules.actor.mutations, 0);
  const summaries = modules.sites.flatMap((site) => Object.values(site.module_summaries));
  assert.equal(summaries.length, accounting.source_evidence.capture_counts.anonymous_module_responses);
  assert.ok(modules.sites.every((site) => site.page.file_count === 0 && site.files_collection.length === 0));
  assert.ok(modules.sites.every((site) => site.module_summaries["viewsource/ViewSourceModule"].page_source_count === 1));
});

test("surface CSS auto-discovery includes History and Files even when evidence is insufficient", () => {
  const result = analyzeThemeSurfaceUsage(`
    .page-history td.optionstd a { white-space: nowrap; }
    .file-list .file-name { overflow-wrap: anywhere; }
  `, "auto");
  assert.deepEqual(result.surfaces.map((row) => row.id), ["page.history", "page.files"]);
  const reviewed = annotateRuntimeSurfaceUsage(result);
  assert.equal(reviewed.surfaces.find((row) => row.id === "page.history").parity_review.status, "INSUFFICIENT_EVIDENCE");
  assert.equal(reviewed.surfaces.find((row) => row.id === "page.files").parity_review.may_treat_differences_as_port_requirements, false);
});

test("Inkblot picker tab selectors map to uncertified local tabview scope", () => {
  const review = reviewRuntimeSurfaceFinding({
    kind: "style_change",
    selector: ":root:has(.picker li:nth-child(8).selected), .picker li:nth-child(8) em",
  });
  assert.deepEqual(review.surface_ids, ["content.tabview"]);
  assert.equal(review.conclusion_resolution, "LOCAL_TARGET_ACCEPTANCE_ONLY");
  assert.equal(review.port_conclusion_eligible, false);
  assert.equal(review.blocks_port_conclusion, false);
});

test("uncertified and unclassified runtime findings cannot become port next-actions", () => {
  const verdict = buildVerdict({extraIssues: [
    {severity: "error", kind: "surface_fixture_missing", surface: "page.history", selector: ".page-history"},
    {severity: "warn", kind: "missing_selector", selector: ".new-unknown-runtime-selector", reference: 1, candidate: 0},
    {severity: "error", kind: "candidate_asset_missing", asset: "logo.svg"},
  ]});

  assert.equal(verdict.port_decision.verdict, "fail");
  assert.equal(verdict.next_actions.length, 1);
  assert.equal(verdict.next_actions[0].kind, "provide_asset");
  assert.equal(verdict.parity_gate.status, "required_runtime_dependency_unresolved");
  assert.equal(verdict.parity_gate.required_uncertified_count, 1);
  assert.equal(verdict.parity_gate.quarantined_count, 2);
  assert.ok(verdict.top_issues.every((issue) => issue.parity_review));
  assert.equal(verdict.top_issues.find((issue) => issue.surface === "page.history").parity_review.quarantined, true);
});

test("active uncertified surfaces stay in local acceptance and cannot alter port conclusions", () => {
  const activeIds = RUNTIME_SURFACE_PARITY.surfaces.filter((row) => row.theme_lab_activity === "ACTIVE_CSS_OR_INTERACTION_SURFACE").map((row) => row.surface_id);
  const verdict = buildVerdict({extraIssues: activeIds.map((surface) => ({
    severity: "error",
    kind: "surface_fixture_missing",
    surface,
  }))});

  assert.equal(activeIds.length, 41);
  assert.equal(verdict.parity_gate.port_requirement_eligible_count, 0);
  assert.equal(verdict.parity_gate.quarantined_count, activeIds.length);
  assert.equal(verdict.parity_gate.target_acceptance_only_count, activeIds.length);
  assert.equal(verdict.parity_gate.required_uncertified_count, 0);
  assert.equal(verdict.next_actions.length, 0);
  assert.equal(verdict.port_decision.verdict, "pass");
  assert.equal(verdict.verdict, "fail");
  assert.equal(verdict.port_decision.unresolved_finding_count, 0);
  assert.deepEqual(verdict.port_decision.unresolved_surface_ids, []);
  assert.equal(verdict.target_acceptance.status, "fail");
  assert.equal(parityReviewForSurfaceIds(["page.history"]).may_treat_differences_as_port_requirements, false);
  assert.equal(parityReviewForSurfaceIds(["page.history.file-revision-timeline"]).may_treat_differences_as_port_requirements, true);
});

test("an unclassified runtime surface still blocks the port conclusion", () => {
  const verdict = buildVerdict({extraIssues: [
    {severity: "error", kind: "missing_selector", selector: ".future-wikidot-widget", reference: 1, candidate: 0},
  ]});
  assert.equal(verdict.port_decision.verdict, "inconclusive");
  assert.equal(verdict.verdict, "fail");
  assert.equal(verdict.parity_gate.required_uncertified_count, 1);
  assert.deepEqual(verdict.port_decision.unresolved_surface_ids, ["unclassified-runtime-surface"]);
});

test("direct observation of an inactive registry row fails closed", () => {
  const review = parityReviewForSurfaceIds(["page.diff"]);
  assert.equal(review.blocks_port_conclusion, true);
  assert.equal(review.port_conclusion_eligible, false);
  assert.deepEqual(review.surface_ids, ["unclassified-runtime-surface"]);
});

test("an explicitly certified scoped contract remains actionable", () => {
  const review = parityReviewForSurfaceIds(["page.history.table-dom"]);
  assert.equal(review.status, "PARITY_CERTIFIED");
  assert.equal(review.may_treat_differences_as_port_requirements, true);

  const result = applyRuntimeSurfaceParityGate([
    {severity: "error", kind: "surface_fixture_missing", surface: "page.history.table-dom", selector: "tr#revision-row-1"},
  ]);
  assert.equal(result.issues[0].parity_review.quarantined, false);
  assert.equal(result.issues[0].parity_review.port_conclusion_eligible, true);
});

test("synthetic Theme Lab states stay identified as synthetic and never certify a runtime surface", () => {
  const row = registryById.get("nav.mobile-top.forced-submenu-state");
  assert.equal(row.status, "THEME_LAB_ONLY_SYNTHETIC_SURFACE");
  const review = parityReviewForSurfaceIds(["nav.mobile-top.forced-submenu-state"]);
  assert.equal(review.may_treat_differences_as_port_requirements, false);
  assert.equal(review.quarantined, true);
  assert.equal(review.decision_authority, "THEME_LAB_SYNTHETIC_DIAGNOSTIC_ONLY");
  assert.equal(review.blocks_port_conclusion, false);
});

test('observed decorative shell scaffolding stays local-only and unmatched scaffolding stays fail closed',()=>{
 for(const selector of ['#extra-div-1','#extra-div-4','#header-extra-div-1']){
  const review=reviewRuntimeSurfaceFinding({kind:'style_change',anchor:selector});
  assert.equal(review.decision_authority,'SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY');
  assert.equal(review.port_conclusion_eligible,false);assert.equal(review.blocks_port_conclusion,false);
 }
 assert.equal(reviewRuntimeSurfaceFinding({kind:'style_change',anchor:'#extra-div-7'}).blocks_port_conclusion,true);
});

test('the observed Sigma blink demonstration remains article styling without adaptation authority',()=>{
 const review=reviewRuntimeSurfaceFinding({kind:'style_change',selector:'.blink'});
 assert.equal(review.blocks_port_conclusion,false);
 assert.equal(review.port_conclusion_eligible,false);
 assert.equal(review.conclusion_resolution,'LOCAL_TARGET_ACCEPTANCE_ONLY');
 assert.equal(reviewRuntimeSurfaceFinding({kind:'style_change',selector:'.unobserved-animation'}).blocks_port_conclusion,true);
});
