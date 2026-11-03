#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {
  buildPortMaintenanceAudit,
  buildUpstreamUpdatePlan,
  isEnCampaignMaintenanceManifest,
} from "../../src/port-maintenance.mjs";

const portsDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let maintenanceExceptions = {};
try {
  maintenanceExceptions = JSON.parse(await fs.readFile(path.join(portsDir, "maintenance-exceptions.json"), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const args = process.argv.slice(2);
const command = args[0] && !args[0].startsWith("--") ? args.shift() : "audit";
const value = (name) => {
  const direct = args.find((arg) => arg.startsWith(`${name}=`));
  if (direct) return direct.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const theme = value("--theme");
const full = args.includes("--json-full") || command === "plan" || Boolean(theme);

async function loadTheme(name) {
  const dir = path.join(portsDir, name);
  const manifest = JSON.parse(await fs.readFile(path.join(dir, "manifest.json"), "utf8"));
  if (!isEnCampaignMaintenanceManifest(manifest)) {
    throw new Error(`${name}: not an SCP-EN campaign maintenance package`);
  }
  const upstreamSource = await fs.readFile(path.join(dir, manifest.source_file ?? "upstream-en.wikidot.txt"), "utf8");
  const humanPortSource = await fs.readFile(path.join(dir, manifest.human_port_candidate ?? "human-port-candidate.wikidot.txt"), "utf8");
  let candidatePath = path.join(dir, "candidate.wikidot.source.txt");
  try {
    await fs.access(candidatePath);
  } catch {
    candidatePath = path.join(dir, manifest.candidate_source ?? "candidate.wikidot.txt");
  }
  const candidateSource = await fs.readFile(candidatePath, "utf8");
  let assetsManifest = {};
  try {
    assetsManifest = JSON.parse(await fs.readFile(path.join(dir, "assets.json"), "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  let maintenanceManifest = null;
  let maintenanceOverrideCss = "";
  let maintenanceFinalSource = "";
  let localizationTransformManifest = null;
  if (manifest.maintenance_source?.manifest) {
    maintenanceManifest = JSON.parse(await fs.readFile(path.join(dir, manifest.maintenance_source.manifest), "utf8"));
    maintenanceOverrideCss = await fs.readFile(path.join(dir, manifest.maintenance_source.jp_overrides), "utf8");
    if (manifest.maintenance_source.final_source) maintenanceFinalSource = await fs.readFile(path.join(dir, manifest.maintenance_source.final_source), "utf8");
  }
  if (manifest.flattened_css_transforms) localizationTransformManifest = JSON.parse(await fs.readFile(path.join(dir, manifest.flattened_css_transforms), "utf8"));
  const maintenanceException = maintenanceExceptions?.import_provenance?.[manifest.slug] ?? null;
  return {dir, manifest, upstreamSource, humanPortSource, candidateSource, assetsManifest, maintenanceException, maintenanceManifest, maintenanceOverrideCss, maintenanceFinalSource, localizationTransformManifest};
}

async function themeNames() {
  const entries = await fs.readdir(portsDir, {withFileTypes: true});
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(portsDir, entry.name, "manifest.json"), "utf8"),
      );
      if (isEnCampaignMaintenanceManifest(manifest)) {
        names.push(entry.name);
      }
    } catch {}
  }
  return names.sort();
}

if (command === "audit") {
  const names = theme ? [theme] : await themeNames();
  const audits = [];
  for (const name of names) {
    const loaded = await loadTheme(name);
    audits.push(buildPortMaintenanceAudit(loaded));
  }
  const result = full ? {themes: audits} : {
    theme_count: audits.length,
    upstream_hash_mismatches: audits.filter((item) => !item.upstream.matches_manifest).map((item) => item.theme),
    themes_with_localized_inline_css: audits.filter((item) => item.localization_baseline.inline_css_changed_rule_count > 0).length,
    localized_inline_css_changed_rules: audits.reduce((sum, item) => sum + item.localization_baseline.inline_css_changed_rule_count, 0),
    jp_adaptation_blocks: audits.reduce((sum, item) => sum + item.final_candidate.adaptation_block_count, 0),
    css_imports: audits.reduce((sum, item) => sum + item.upstream_dependencies.css_import_count, 0),
    css_imports_with_byte_provenance: audits.reduce((sum, item) => sum + item.upstream_dependencies.import_provenance_count, 0),
    themes_missing_import_provenance: audits.filter((item) => item.upstream_dependencies.missing_import_provenance.length > 0).map((item) => item.theme),
    themes_with_import_provenance_exceptions: audits.filter((item) => item.upstream_dependencies.maintenance_exception).map((item) => item.theme),
    themes_with_nonportable_metadata_paths: audits.filter((item) => item.metadata.nonportable_absolute_path_fields.length > 0).map((item) => item.theme),
    themes_with_maintenance_source: audits.filter((item) => item.maintenance_source.bound).length,
    maintenance_adaptation_blocks: audits.reduce((sum, item) => sum + (item.maintenance_source.adaptation_block_count ?? 0), 0),
    maintenance_exact_duplicate_rules_removed: audits.reduce((sum, item) => sum + (item.maintenance_source.exact_duplicate_rules_removed ?? 0), 0),
    maintenance_redundant_same_value_declarations_removed: audits.reduce((sum, item) => sum + (item.maintenance_source.redundant_same_value_declarations_removed ?? 0), 0),
    maintenance_empty_rules_removed: audits.reduce((sum, item) => sum + (item.maintenance_source.empty_rules_removed ?? 0), 0),
    maintenance_repeated_selector_contexts: audits.reduce((sum, item) => sum + (item.maintenance_source.override_cascade?.repeated_selector_context_count ?? 0), 0),
    maintenance_redundant_same_value_declarations: audits.reduce((sum, item) => sum + (item.maintenance_source.override_cascade?.redundant_same_value_declaration_count ?? 0), 0),
    maintenance_shadowed_conflicting_declarations: audits.reduce((sum, item) => sum + (item.maintenance_source.override_cascade?.shadowed_conflicting_declaration_count ?? 0), 0),
    maintenance_final_sources: audits.filter((item) => item.maintenance_source.final_source?.hash_matches).length,
    maintenance_final_source_hash_mismatches: audits.filter((item) => item.maintenance_source.final_source && !item.maintenance_source.final_source.hash_matches).map((item) => item.theme),
    maintenance_reviewed_findings: audits.reduce((sum, item) => sum + (item.maintenance_source.reviewed_finding_count ?? 0), 0),
    maintenance_review_status_counts: audits.reduce((counts, item) => {
      for (const [status, count] of Object.entries(item.maintenance_source.declaration_review_status_counts ?? {})) counts[status] = (counts[status] ?? 0) + count;
      return counts;
    }, {}),
    maintenance_unresolved_findings: audits.reduce((sum, item) => sum + (item.maintenance_source.unresolved_findings ?? 0), 0),
    themes_with_shadowed_conflicting_declarations: audits.filter((item) => (item.maintenance_source.override_cascade?.shadowed_conflicting_declaration_count ?? 0) > 0).map((item) => item.theme),
  };
  console.log(JSON.stringify(result, null, 2));
} else if (command === "plan") {
  if (!theme) throw new Error("plan requires --theme=<package-name>");
  const newUpstream = value("--new-upstream");
  if (!newUpstream) throw new Error("plan requires --new-upstream=<path>");
  const loaded = await loadTheme(theme);
  const audit = buildPortMaintenanceAudit(loaded);
  const newUpstreamSource = await fs.readFile(path.resolve(newUpstream), "utf8");
  console.log(JSON.stringify(buildUpstreamUpdatePlan({audit, manifest: loaded.manifest, oldUpstreamSource: loaded.upstreamSource, newUpstreamSource}), null, 2));
} else {
  throw new Error(`unknown command: ${command}`);
}
