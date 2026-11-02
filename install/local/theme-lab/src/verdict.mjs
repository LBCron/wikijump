// Compact, agent-facing verdict construction.
//
// The raw browser/selector/torture data is large. An LLM wants a small ranked
// list of "what broke and where" plus a short list of style changes, and only
// asks for raw detail explicitly.

import {applyRuntimeSurfaceParityGate, RUNTIME_SURFACE_PARITY} from "./runtime-surface-parity.mjs";
import {classifyViewportOverflowIssues} from "./viewport-overflow-classification.mjs";

export const DEFAULT_LIMITS = Object.freeze({
  topIssues: 12,
  styleChanges: 10,
  selectorRows: 30,
});

// Full-bleed content (for example a negative-margin <hr> divider) can land a
// fraction of a pixel past the viewport edge through sub-pixel layout
// rounding. `documentElement.scrollWidth - clientWidth` reports that as a
// whole 1px, so a 1px document overflow is rounding noise, not a defect. Real
// horizontal overflow (2px and above) still fails. This matches the 1px
// tolerance already used by `viewportEscape` and the surface contract.
export const DOCUMENT_OVERFLOW_TOLERANCE_PX = 1;

function severityRank(severity) {
  return {error: 0, warn: 1, info: 2}[severity] ?? 3;
}

export function issuesFromSelectorDiagnosis(diagnosis) {
  const issues = [];
  for (const row of diagnosis?.missing ?? []) {
    const mapping = row.semantic_mapping;
    issues.push({
      severity: "error",
      kind: "missing_selector",
      selector: row.selector,
      reference: row.reference,
      candidate: row.candidate,
      at_context: row.at_context ?? [],
      ...(mapping?.reference_role ? {reference_role: mapping.reference_role} : {}),
      ...(mapping?.candidate_candidates?.length
        ? {suggested_candidate: mapping.candidate_candidates[0]}
        : {}),
    });
  }
  for (const row of diagnosis?.collapsed ?? []) {
    issues.push({
      severity: "warn",
      kind: "collapsed_selector",
      selector: row.selector,
      reference: row.reference,
      candidate: row.candidate,
      at_context: row.at_context ?? [],
    });
  }
  for (const row of diagnosis?.expanded ?? []) {
    issues.push({
      severity: "warn",
      kind: "expanded_selector",
      selector: row.selector,
      reference: row.reference,
      candidate: row.candidate,
      at_context: row.at_context ?? [],
    });
  }
  return issues;
}

export function issuesFromTorture(torture) {
  if (!torture?.issues) return [];
  return torture.issues.map((issue) => ({
    severity: issue.severity ?? "error",
    kind: issue.kind,
    component: issue.component,
    viewport: issue.viewport,
    ...(issue.selector ? {selector: issue.selector} : {}),
    ...(issue.before_px !== undefined ? {before_px: issue.before_px} : {}),
    ...(issue.after_px !== undefined ? {after_px: issue.after_px} : {}),
    ...(issue.overflow_sources ? {overflow_sources: issue.overflow_sources} : {}),
    ...(issue.element_rect ? {element_rect: issue.element_rect} : {}),
    ...(issue.computed ? {computed: issue.computed} : {}),
    ...(issue.rationale ? {rationale: issue.rationale} : {}),
    ...(issue.content_viewport_overflow_px !== undefined ? {content_viewport_overflow_px: issue.content_viewport_overflow_px} : {}),
  }));
}

export function issuesFromViewports(viewports, baselineViewports = null, classificationContext = null) {
  const issues = [];
  for (const [id, viewport] of Object.entries(viewports ?? {})) {
    const documentOverflow = viewport?.document_overflow_px ?? 0;
    const viewportEscape = viewport?.viewport_escape_px ?? 0;
    const overflow = Math.max(documentOverflow, viewportEscape);
    const baseline = baselineViewports?.[id] ?? null;
    const baselineDocumentOverflow = baseline?.document_overflow_px ?? 0;
    const baselineViewportEscape = baseline?.viewport_escape_px ?? 0;
    const baselineOverflow = Math.max(baselineDocumentOverflow, baselineViewportEscape);
    // A viewport fails only for real overflow. Sub-pixel full-bleed rounding
    // (for example a negative-margin <hr> divider) surfaces as a whole 1px in
    // documentOverflow or a fractional px in viewportEscape and must not become
    // an actionable defect. Keep this boundary in sync with viewportStatus.
    if (overflow > baselineOverflow + DOCUMENT_OVERFLOW_TOLERANCE_PX) {
      issues.push({severity: "error", kind: "viewport_overflow", viewport: id, overflow_px: overflow, document_overflow_px: documentOverflow, viewport_escape_px: viewportEscape,
        baseline_overflow_px: baselineOverflow, baseline_document_overflow_px: baselineDocumentOverflow, baseline_viewport_escape_px: baselineViewportEscape,
        overflow_sources: viewport?.overflow_sources ?? []});
    }
  }
  // State-aware classification (issue #3381) only annotates findings: every
  // issue keeps its severity, kind, keys and measurements, so the recorded
  // per-package/per-rule exemptions remain the disposition channel.
  return classifyViewportOverflowIssues(issues, classificationContext ?? {});
}

export function issuesFromPreview(preview) {
  return (preview?.unresolved_includes ?? []).map(({page, message}) => ({
    severity: "error",
    kind: "unresolved_include",
    include: page,
    evidence: message,
  }));
}

export function issuesFromInteractions(interactions) {
  if (!interactions) return [];
  return Object.entries(interactions)
    .filter(([, result]) => result?.status === "fail")
    .map(([interaction, result]) => ({severity: "error", kind: "interaction_failure", interaction, evidence: result}));
}

export function styleChangesFromComputed(computedStyles, limit = DEFAULT_LIMITS.styleChanges) {
  const priority = (property) => {
    if (/^(font-|color$|background-|border-|width$|margin-|padding-)/u.test(property)) return 0;
    if (property.startsWith("rect.") && property !== "rect.y" && property !== "rect.height") return 1;
    return 2;
  };
  return [...(computedStyles?.top ?? [])].sort((a, b) => priority(a.property) - priority(b.property)).slice(0, limit).map((row) => ({
    anchor: row.anchor,
    property: row.property,
    reference: row.reference,
    candidate: row.candidate,
    delta: row.delta,
    status: row.status,
    ...(row.cascade
      ? {
          cascade: {
            status: row.cascade.status,
            winner: row.cascade.winner,
            media_inactive: row.cascade.media_inactive,
            variables: row.cascade.variables,
          },
        }
      : {}),
  }));
}

export function nextActions(issues, styleChanges = [], limit = 5) {
  const actions = [];
  for (const issue of issues) {
    if (issue.parity_review?.may_treat_differences_as_port_requirements === false) continue;
    if (issue.kind === "missing_selector") {
      actions.push({
        kind: issue.suggested_candidate ? "rewrite_selector" : "supply_candidate_structure",
        selector: issue.selector,
        ...(issue.suggested_candidate ? {suggested_candidate: issue.suggested_candidate} : {}),
        evidence: {reference_count: issue.reference, candidate_count: issue.candidate},
      });
    } else if (issue.kind === "candidate_asset_missing") {
      actions.push({kind: "provide_asset", asset: issue.asset, evidence: {missing_from_asset_dir: true}});
    } else if (issue.kind === "candidate_image_missing") {
      actions.push({kind: "localize_image", asset: issue.asset, selector: issue.selector, evidence: issue.evidence});
    } else if (issue.kind === "unresolved_include") {
      actions.push({
        kind: "resolve_candidate_include",
        include: issue.include,
        evidence: {preview_error: issue.evidence},
      });
    } else if (issue.kind === "interaction_failure") {
      actions.push({kind: "repair_interaction", interaction: issue.interaction, evidence: issue.evidence});
    } else if (issue.kind === "surface_state_action_failed") {
      actions.push({
        kind: "repair_surface_contract_fixture",
        surface: issue.surface,
        state: issue.state,
        viewport: issue.viewport,
        evidence: issue.evidence,
      });
    } else if (issue.kind === "surface_fixture_missing") {
      actions.push({
        kind: "cover_theme_surface",
        surface: issue.surface,
        state: issue.state,
        viewport: issue.viewport,
        selector: issue.selector,
      });
    } else if (issue.kind === "custom_surface_selector_missing") {
      actions.push({
        kind: "exercise_theme_specific_selector",
        surface: issue.surface,
        viewport: issue.viewport,
        selector: issue.selector,
        evidence: issue.evidence,
      });
    } else if (issue.kind === "baseline_responsive_behavior_flattened") {
      actions.push({
        kind: "review_responsive_baseline_override",
        surface: issue.surface,
        selector: issue.selector,
        property: issue.property,
        evidence: {baseline: issue.baseline, theme: issue.theme},
      });
    } else if (issue.kind === "surface_low_text_contrast") {
      actions.push({
        kind: "review_surface_contrast",
        surface: issue.surface,
        state: issue.state,
        viewport: issue.viewport,
        selector: issue.selector,
        evidence: {
          contrast_ratio: issue.contrast_ratio ?? null,
          foreground: issue.foreground ?? issue.theme_color ?? null,
          background: issue.background ?? null,
          background_image: issue.background_image ?? null,
          baseline_color: issue.baseline_color ?? null,
        },
      });
    } else if (issue.kind?.includes("overflow")) {
      actions.push({
        kind: "reduce_overflow",
        ...(issue.component ? {component: issue.component} : {}),
        viewport: issue.viewport,
        ...(issue.selector ? {selector: issue.selector} : {}),
        evidence: {before_px: issue.before_px ?? 0, after_px: issue.after_px ?? issue.overflow_px ?? 0},
        ...(issue.overflow_sources?.length ? {overflow_sources: issue.overflow_sources} : {}),
      });
    }
    if (actions.length >= limit) return actions;
  }
  for (const change of styleChanges) {
    if (change.parity_review?.may_treat_differences_as_port_requirements === false) continue;
    // A different computed value is not, by itself, a repair action: theme
    // ports deliberately change fonts and colors. Surface only a concrete
    // cascade clue that could explain an unresolved difference.
    if (!change.cascade?.winner || !change.cascade.media_inactive?.length) continue;
    actions.push({
      kind: "inspect_inactive_media",
      selector: change.anchor,
      property: change.property,
      evidence: {
        reference: change.reference,
        candidate: change.candidate,
        winner: change.cascade.winner,
        media_inactive: change.cascade.media_inactive,
      },
    });
    if (actions.length >= limit) break;
  }
  return actions;
}

export function summarizeVisual(visual) {
  if (!visual) return null;
  const viewports = {};
  let worst = "pass";
  for (const [id, entry] of Object.entries(visual)) {
    const status = entry.acceptance?.status ?? "inconclusive";
    viewports[id] = {
      status,
      comparison_status: entry.comparison?.status ?? "unavailable",
      normalized_rmse: entry.comparison?.normalized_rmse ?? null,
      candidate_path: entry.candidate_path,
      reference_path: entry.reference_path,
      candidate_screenshot_sha256: entry.candidate_screenshot_sha256,
      reference_screenshot_sha256: entry.reference_screenshot_sha256,
      review: entry.acceptance?.review ?? null,
    };
    if (status === "fail") worst = "fail";
    else if (status === "inconclusive" && worst !== "fail") worst = "inconclusive";
    else if (status === "warn" && worst === "pass") worst = "warn";
  }
  return {status: worst, viewports};
}

// The public verdict combines acceptance without promoting local observations
// into authority for a port adaptation.
export function overallAcceptance(port, target) {
  if (target === "fail" || port === "fail") return "fail";
  if (port === "inconclusive" || target === "inconclusive") return "inconclusive";
  if (port === "warn" || target === "warn") return "warn";
  if (port === "pass" && target === "pass") return "pass";
  return "inconclusive";
}

export function buildVerdict({
  reference = null,
  torture = null,
  viewports = null,
  baselineViewports = null,
  overflowStateCaptures = null,
  referenceViewports = null,
  fontDiagnostics = null,
  interactionDiagnostics = null,
  imageDiagnostics = null,
  pageImageAssets = null,
  visual = null,
  timing = {},
  artifacts = {},
  assets = null,
  preview = null,
  extraIssues = [],
  limits = DEFAULT_LIMITS,
} = {}) {
  const rawIssues = [
    ...issuesFromSelectorDiagnosis(reference?.diagnosis),
    ...issuesFromTorture(torture),
    ...issuesFromViewports(viewports, baselineViewports, {stateCaptures: overflowStateCaptures ?? [], referenceViewports}),
    ...issuesFromPreview(preview),
    ...issuesFromInteractions(interactionDiagnostics),
    ...(imageDiagnostics?.broken ?? []).map((image) => ({
      severity: "error",
      kind: "candidate_image_missing",
      asset: image.src,
      selector: image.selector,
      evidence: {alt: image.alt, natural_width: image.natural_width, natural_height: image.natural_height},
    })),
    ...extraIssues,
  ];
  const rawStyleChanges = styleChangesFromComputed(reference?.computed_styles, Number.POSITIVE_INFINITY);
  if ((torture?.changed_component_count ?? 0) > 0 && (torture?.issues?.length ?? 0) === 0) {
    const surfaces = {heading: "content.article", list: "content.article", blockquote: "content.blockquote", table: "content.table", code: "content.code", collapsible: "content.collapsible", tabview: "content.tabview", footnote: "content.footnotes", math: "content.article", toc: "content.toc", rating: "content.rating"};
    const changes = torture.changes ?? [];
    const components = [...new Set(changes.map(change => change.component))];
    if (components.length === torture.changed_component_count && components.every(component => surfaces[component])) {
      for (const component of components) rawIssues.push({severity: "warn", kind: "torture_component_style_change", surface: surfaces[component], component, evidence: changes.filter(change => change.component === component)});
    } else {
      rawIssues.push({severity: "warn", kind: "unscoped_torture_change_summary", changed_component_count: torture.changed_component_count});
    }
  }
  const parityReview = applyRuntimeSurfaceParityGate(rawIssues, rawStyleChanges);
  const issues = parityReview.issues;
  issues.sort((left, right) => severityRank(left.severity) - severityRank(right.severity));

  const decisionIssues = issues.filter((issue) => issue.parity_review.may_treat_differences_as_port_requirements);
  const decisionStyleChanges = parityReview.styleChanges.filter((change) => change.parity_review.may_treat_differences_as_port_requirements);
  const hasError = decisionIssues.some((issue) => issue.severity === "error");
  const hasWarn = decisionIssues.some((issue) => issue.severity === "warn");
  const unresolvedParity = parityReview.summary.required_uncertified_count > 0;

  // A local target-acceptance observation stays visible and can fail local
  // acceptance, but it cannot establish a Wikidot mismatch or recommend a
  // parity-based port adaptation. Unknown/unclassified runtime dependencies
  // remain fail-closed and make the port conclusion inconclusive.
  const verdict = hasError
    ? "fail"
    : hasWarn || decisionStyleChanges.length > 0
      ? "warn"
      : unresolvedParity
        ? "inconclusive"
        : "pass";
  const styleChanges = decisionStyleChanges.slice(0, limits.styleChanges);
  const viewportStatus = viewports
    ? Object.fromEntries(Object.entries(viewports).map(([name, result]) => [name, {
        status: Math.max(result.document_overflow_px ?? 0, result.viewport_escape_px ?? 0) >
          Math.max(baselineViewports?.[name]?.document_overflow_px ?? 0, baselineViewports?.[name]?.viewport_escape_px ?? 0) + DOCUMENT_OVERFLOW_TOLERANCE_PX ? "fail" : "pass",
        document_overflow_px: result.document_overflow_px ?? 0,
        ...(result.viewport_escape_px !== undefined ? {viewport_escape_px: result.viewport_escape_px} : {}),
        ...(baselineViewports?.[name] ? {
          baseline_document_overflow_px: baselineViewports[name].document_overflow_px ?? 0,
          ...(baselineViewports[name].viewport_escape_px !== undefined ? {baseline_viewport_escape_px: baselineViewports[name].viewport_escape_px} : {}),
        } : {}),
        decision_authority: "SCP_JP_TARGET_ACCEPTANCE_ONLY",
      }]))
    : null;
  const proposedActions = nextActions(issues, styleChanges);
  // Inactive media rules are useful leads before responsive evidence exists.
  // Once the complete viewport sweep has passed, those leads have been
  // exercised and should remain visible as style evidence rather than asking
  // for an edit with no failing viewport to reproduce.
  const resolvedActions = viewportStatus && Object.values(viewportStatus).length > 0 &&
    Object.values(viewportStatus).every((entry) => entry.status === "pass")
    ? proposedActions.filter((action) => action.kind === "inspect_inactive_media")
    : [];
  const actionableActions = resolvedActions.length
    ? proposedActions.filter((action) => action.kind !== "inspect_inactive_media")
    : proposedActions;

  const targetStatus = issues.some((issue) => issue.severity === "error") || (visual && Object.values(visual).some((entry) => entry?.acceptance?.status === "fail"))
    ? "fail"
    : visual && Object.values(visual).some((entry) => !["pass", "warn"].includes(entry?.acceptance?.status))
      ? "inconclusive"
    : issues.some((issue) => issue.severity === "warn") || rawStyleChanges.length > 0 || (torture?.changed_component_count ?? 0) > 0
      ? "warn" : "pass";
  const overall = overallAcceptance(verdict, targetStatus);
  return {
    verdict: overall,
    overall_acceptance: {status: overall, port_verdict: verdict, target_status: targetStatus},
    timing_ms: timing,
    issue_count: issues.length,
    actionable_issue_count: decisionIssues.length,
    top_issues: issues.slice(0, limits.topIssues),
    style_changes: styleChanges,
    next_actions: actionableActions,
    parity_gate: parityReview.summary,
    port_decision: {
      verdict,
      decision_authority: "WIKIDOT_RUNTIME_PARITY_AND_RUNTIME_INDEPENDENT_CHECKS",
      actionable_finding_count: decisionIssues.length + decisionStyleChanges.length,
      unresolved_finding_count: parityReview.summary.required_uncertified_count,
      unresolved_surface_ids: [...new Set(parityReview.summary.quarantined_findings
        .filter((row) => row.blocks_port_conclusion)
        .flatMap((row) => row.surface_ids))].sort(),
    },
    target_acceptance: {
      status: targetStatus,
      decision_authority: "SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY",
      issue_count: issues.length,
      style_change_count: rawStyleChanges.length,
      findings: issues.filter((issue) => issue.parity_review.decision_authority === "SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY"),
      style_changes: rawStyleChanges.slice(0, limits.styleChanges).map((change) => ({
        ...change,
        decision_authority: "SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY",
        port_conclusion_eligible: false,
      })),
      torture_changed_component_count: torture?.changed_component_count ?? 0,
      visual_status: summarizeVisual(visual)?.status ?? null,
      synthetic_diagnostic_count: parityReview.summary.quarantined_findings.filter((row) => row.surface_ids.some((id) =>
        RUNTIME_SURFACE_PARITY.surfaces.find((surface) => surface.surface_id === id)?.conclusion_resolution === "SYNTHETIC_DIAGNOSTIC_ONLY",
      )).length,
    },
    decision_authority: {
      port_conclusion: "certified runtime scopes and runtime-independent candidate checks only",
      local_target_acceptance: "SCP-JP local runtime observations; not Wikidot parity evidence",
      quarantined_findings: "diagnostic only; cannot establish a port requirement or a passing port conclusion",
    },
    ...(resolvedActions.length ? {resolved_actions: resolvedActions.map((action) => ({
      ...action,
      resolution: "all measured acceptance viewports pass; retain as a reviewed cascade difference",
    }))} : {}),
    reference: reference
      ? {
          url: reference.reference_url ?? reference.url ?? null,
          reference_selector_count: reference.reference_selector_count ?? null,
          missing: reference.diagnosis?.missing_count ?? 0,
          collapsed: reference.diagnosis?.collapsed_count ?? 0,
          expanded: reference.diagnosis?.expanded_count ?? 0,
        }
      : null,
    torture: torture
      ? {
          verdict: torture.verdict,
          issue_count: torture.issue_count ?? (torture.issues?.length ?? 0),
          changed_component_count: torture.changed_component_count ?? 0,
        }
      : null,
    viewport_status: viewportStatus,
    font_diagnostics: fontDiagnostics,
    interaction_diagnostics: interactionDiagnostics,
    image_diagnostics: imageDiagnostics,
    page_image_assets: pageImageAssets,
    visual: summarizeVisual(visual)
      ? {...summarizeVisual(visual), decision_authority: "SCP_JP_LOCAL_TARGET_ACCEPTANCE_ONLY"}
      : null,
    assets,
    artifacts,
  };
}

export function expandVerdict(verdict, full) {
  return {
    ...verdict,
    top_issues: full?.issues ?? verdict.top_issues,
    selector_rows: full?.selector_rows ?? undefined,
    computed_style_rows: full?.computed_style_rows ?? undefined,
    viewport_diagnostics: full?.viewports ?? undefined,
    torture_full: full?.torture ?? undefined,
    surface_contract_full: full?.surface_contract ?? undefined,
  };
}
