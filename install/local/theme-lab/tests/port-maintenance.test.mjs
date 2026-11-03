import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPortMaintenanceAudit,
  buildUpstreamUpdatePlan,
  analyzeOverrideCascade,
  diffCssRules,
  extractSCPJPAdaptationBlocks,
  isEnCampaignMaintenanceManifest,
  parseCssDeclarations,
  sha256Text,
} from "../src/port-maintenance.mjs";

test("EN maintenance discovery requires the EN campaign manifest contract", () => {
  assert.equal(isEnCampaignMaintenanceManifest({en_source_sha256: "abc"}), true);
  assert.equal(isEnCampaignMaintenanceManifest({en_source_sha256: ""}), false);
  assert.equal(isEnCampaignMaintenanceManifest({schema: "theme_lab_foreign_port.v1"}), false);
  assert.equal(isEnCampaignMaintenanceManifest(null), false);
});

test("parseCssDeclarations preserves semicolons inside functions and strings", () => {
  assert.deepEqual(parseCssDeclarations('color: red; background: url("data:image/svg+xml;a:b"); content: "x;y" !important;'), [
    {property: "color", value: "red", important: false},
    {property: "background", value: 'url("data:image/svg+xml;a:b")', important: false},
    {property: "content", value: '"x;y"', important: true},
  ]);
});

test("analyzeOverrideCascade distinguishes redundant and conflicting shadowed declarations", () => {
  const audit = analyzeOverrideCascade(`
    .a { color: red; padding: 1rem; }
    .b { color: blue; }
    .a { color: red; padding: 2rem !important; }
    .a { padding: 3rem; }
  `);
  assert.equal(audit.repeated_selector_context_count, 1);
  assert.equal(audit.redundant_same_value_declaration_count, 1);
  assert.equal(audit.shadowed_conflicting_declaration_count, 2);
  const padding = audit.conflicts.find((row) => row.property === "padding");
  assert.equal(padding.winner.value, "2rem");
  assert.equal(padding.winner.important, true);
  assert.equal(padding.review_class, "possible-historical-supersession-requires-manual-review");
});

test("diffCssRules notices declaration changes without selector changes", () => {
  assert.deepEqual(diffCssRules("#header { color: red; }", "#header { color: blue; }").map((row) => [row.selector, row.status]), [["#header", "changed"]]);
});

test("extractSCPJPAdaptationBlocks preserves marker, rationale and selectors", () => {
  const source = `before\n[[module CSS]]\n/* SCP-JP visual repair v2: sample */\n/* Long Japanese navigation labels must wrap. */\n@media (max-width: 600px) { #side-bar a { white-space: normal; } }\n[[/module]]`;
  const blocks = extractSCPJPAdaptationBlocks(source);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].marker, "SCP-JP visual repair v2: sample");
  assert.equal(blocks[0].rationale, "Long Japanese navigation labels must wrap.");
  assert.deepEqual(blocks[0].selectors, ["#side-bar a"]);
});

test("extractSCPJPAdaptationBlocks keeps a second SCP-JP comment as the rationale", () => {
  const source = `[[module CSS]]\n/* SCP-JP acceptance: sample */\n/* SCP-JP interaction adaptation: keep the account menu clickable. */\n#login-status { pointer-events: auto; }\n[[/module]]`;
  const [block] = extractSCPJPAdaptationBlocks(source);
  assert.equal(block.rationale, "SCP-JP interaction adaptation: keep the account menu clickable.");
});

test("maintenance audit separates baseline CSS localization from acceptance overrides", () => {
  const upstream = "[[module CSS]]#header { color: red; } #side-bar a { white-space: nowrap; }[[/module]]";
  const localized = "[[module CSS]]#header { color: red; } #side-bar a { white-space: normal; }[[/module]]";
  const candidate = `${localized}\n[[module CSS]]/* SCP-JP acceptance: account */ /* Keep the current JP account menu clickable. */ #login-status { pointer-events: auto; }[[/module]]`;
  const manifest = {slug: "theme:sample", reference_url: "https://example.invalid/theme:sample", source_file: "upstream-en.wikidot.txt", human_port_candidate: "human-port-candidate.wikidot.txt", en_source_sha256: sha256Text(upstream), source_identity: {en: {tags: []}}};
  const audit = buildPortMaintenanceAudit({manifest, upstreamSource: upstream, humanPortSource: localized, candidateSource: candidate, assetsManifest: {imports: ["https://cdn.invalid/base.css"]}});
  assert.equal(audit.upstream.matches_manifest, true);
  assert.deepEqual(audit.localization_baseline.inline_css_changed_selectors, ["#side-bar a"]);
  assert.equal(audit.final_candidate.adaptation_block_count, 1);
  assert.deepEqual(audit.upstream_dependencies.missing_import_provenance, ["https://cdn.invalid/base.css"]);
});

test("maintenance audit infers the localized Japanese theme tag when legacy manifests omit it", () => {
  const upstream = "[[iftags +theme]][[module CSS]].theme { color: red; }[[/module]][[/iftags]]";
  const localized = "[[iftags +テーマ]][[module CSS]].theme { color: blue; }[[/module]][[/iftags]]";
  const manifest = {slug: "theme:sample", en_source_sha256: sha256Text(upstream), source_identity: {en: {tags: ["theme"]}}};
  const audit = buildPortMaintenanceAudit({manifest, upstreamSource: upstream, humanPortSource: localized, candidateSource: localized});
  assert.deepEqual(audit.localization_baseline.active_tags, ["テーマ"]);
  assert.deepEqual(audit.localization_baseline.inline_css_changed_selectors, [".theme"]);
});

test("maintenance audit recovers the active upstream theme tag for legacy sources", () => {
  const upstream = "[[iftags +theme]][[module CSS]].theme { color: red; }[[/module]][[/iftags]]";
  const localized = "[[iftags +theme]][[module CSS]].theme { color: blue; }[[/module]][[/iftags]]";
  const audit = buildPortMaintenanceAudit({manifest: {slug: "theme:sample"}, upstreamSource: upstream, humanPortSource: localized, candidateSource: localized});
  assert.deepEqual(audit.upstream.active_tags, ["theme"]);
  assert.deepEqual(audit.localization_baseline.active_tags, ["theme"]);
  assert.deepEqual(audit.localization_baseline.inline_css_changed_selectors, [".theme"]);
});

test("maintenance audit reports the bound canonical maintenance layer", () => {
  const source = "[[module CSS]].theme { color: red; }[[/module]]";
  const manifest = {
    slug: "theme:sample",
    en_source_sha256: sha256Text(source),
    source_identity: {en: {tags: []}},
    maintenance_source: {base: "maintenance/base.wikidot.txt", jp_overrides: "maintenance/jp-overrides.css", manifest: "maintenance/manifest.json"},
  };
  const audit = buildPortMaintenanceAudit({
    manifest,
    upstreamSource: source,
    humanPortSource: source,
    candidateSource: source,
    maintenanceManifest: {adaptation_block_count: 3, raw_override_rule_count: 8, canonical_override_rule_count: 6, exact_duplicate_rules_removed: 2, semantic_css_sha256: "a", canonical_override_sha256: "b", final_source: "maintenance/final.wikidot.txt", final_source_sha256: sha256Text("final"), declaration_reviews: {}},
    maintenanceOverrideCss: ".a { color: red; } .a { color: blue; }",
    maintenanceFinalSource: "final",
  });
  assert.equal(audit.maintenance_source.bound, true);
  assert.equal(audit.maintenance_source.adaptation_block_count, 3);
  assert.equal(audit.maintenance_source.exact_duplicate_rules_removed, 2);
  assert.equal(audit.maintenance_source.override_cascade.shadowed_conflicting_declaration_count, 1);
  assert.equal(audit.maintenance_source.override_cascade.conflicts[0].review_status, "unresolved");
  assert.deepEqual(audit.maintenance_source.canonical_override_selectors, [".a"]);
  assert.equal(audit.maintenance_source.final_source.hash_matches, true);
  assert.equal(audit.maintenance_source.unresolved_findings, 1);
});

test("maintenance conflict statuses require a non-empty rationale and appear in audit rows", () => {
  const source = "[[module CSS]].theme { color: red; }[[/module]]";
  const key = JSON.stringify([[], ".a", "color"]);
  const audit = buildPortMaintenanceAudit({
    manifest: {slug: "theme:sample", en_source_sha256: sha256Text(source)},
    upstreamSource: source,
    humanPortSource: source,
    candidateSource: source,
    maintenanceManifest: {declaration_reviews: {[key]: {status: "intentional-fallback", rationale: "Keep the established fallback before the newer value."}}},
    maintenanceOverrideCss: ".a { color: red; } .a { color: blue; }",
  });
  const [finding] = audit.maintenance_source.override_cascade.conflicts;
  assert.equal(finding.review_status, "intentional-fallback");
  assert.equal(finding.review_rationale, "Keep the established fallback before the newer value.");
  assert.equal(audit.maintenance_source.unresolved_findings, 0);
});

test("upstream update plan highlights selectors touched by JP localization", () => {
  const oldUpstream = "[[module CSS]]#side-bar a { white-space: nowrap; }[[/module]]";
  const newUpstream = "[[module CSS]]#side-bar a { white-space: break-spaces; }[[/module]]";
  const localized = "[[module CSS]]#side-bar a { white-space: normal; }[[/module]]";
  const candidate = `${localized}\n[[module CSS]]/* SCP-JP acceptance: nav */ /* Japanese labels wrap. */ #side-bar a { overflow-wrap: anywhere; }[[/module]]`;
  const manifest = {slug: "theme:sample", en_source_sha256: sha256Text(oldUpstream), source_identity: {en: {tags: []}}};
  const audit = buildPortMaintenanceAudit({manifest, upstreamSource: oldUpstream, humanPortSource: localized, candidateSource: candidate, assetsManifest: {imports: ["https://cdn.invalid/base.css"]}, maintenanceOverrideCss: "#side-bar a { color: #123; }"});
  const plan = buildUpstreamUpdatePlan({audit, manifest, oldUpstreamSource: oldUpstream, newUpstreamSource: newUpstream});
  assert.deepEqual(plan.localization_overlap_selectors, ["#side-bar a"]);
  assert.deepEqual(plan.localization_overlap_sources["#side-bar a"], ["jp-localization-baseline", "canonical-jp-overrides"]);
  assert.equal(plan.review_scope.recheck_jp_overrides, true);
  assert.equal(plan.transitive_css_dependency_refresh_required, true);
});
