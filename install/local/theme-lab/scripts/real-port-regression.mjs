#!/usr/bin/env node

// Sequential, receipt-driven campaign runner. Each case uses the existing
// persistent Theme Lab daemon and an already acquired offline reference.
import fs from "node:fs";
import {assertPublishablePackage} from "../src/adaptation-authority.mjs";
import crypto from "node:crypto";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {resolveExistingContainedFile,resolveExistingPackageDirectory,resolveExistingPackageFile} from "../src/package-path.mjs";
import {currentPackageBaseCss} from "../src/candidate-base-contract.mjs";
import {discoverThemePackages, loadAuthorityLedger, THEME_PACKAGE_KINDS} from "../src/theme-package.mjs";
import {parseFailOn, runExitCode, summarizeRun} from "../src/run-summary.mjs";
import {defaultStorePath} from "../src/evidence-store.mjs";
import {storeRunArtifacts} from "../src/evidence-run.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../../..");
const ports = path.join(root, "install/local/theme-lab/ports");
const manifestPath = process.env.THEME_LAB_CAMPAIGN_MANIFEST ?? path.join(ports, "en-theme-campaign.json");
const socket = process.env.THEME_LAB_SOCKET ?? "/tmp/theme-lab-en34.sock";
const dearSocket = process.env.THEME_LAB_DEAR_SOCKET ?? socket;
const siteId = process.env.THEME_LAB_SITE_ID ?? "6000003";
const runArtifactRoot = process.env.THEME_LAB_RUN_ARTIFACT_DIR ? path.resolve(process.env.THEME_LAB_RUN_ARTIFACT_DIR) : null;
const sharedSelectors = resolveExistingContainedFile(ports, "shared-acceptance-selectors.txt", "shared acceptance selectors");
const lab = path.join(root, "install/local/theme-lab/scripts/theme-lab.mjs");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const assetRoot = fs.realpathSync(path.resolve(process.env.THEME_LAB_ASSET_DIR ?? path.join(ports, "shared-replay-assets")));
const assetByDigest = new Map();
for (const name of fs.readdirSync(assetRoot)) {
  const digest = name.match(/^([0-9a-f]{64})\./u)?.[1];
  if (digest && !assetByDigest.has(digest)) assetByDigest.set(digest, name);
}

// The daemon materializes candidate assets from its own --asset-dir, which is an
// unverified external input rather than the frozen pool this runner verifies. A
// daemon pool that predates the committed pool reports candidate_asset_missing
// for assets the package already declares, so the mismatch has to fail closed
// before it can be misread as a port-authoritative package finding.
const daemonAssetDirs = new Map();
function daemonAssetDir(socketPath) {
  if (daemonAssetDirs.has(socketPath)) return daemonAssetDirs.get(socketPath);
  const status = spawnSync(process.execPath, [lab, "status", "--socket", socketPath],
    {cwd: root, encoding: "utf8", timeout: 60_000, maxBuffer: 4 * 1024 * 1024});
  if (status.status !== 0) {
    const detail = (status.stderr || status.error?.message || "").trim().slice(0, 300);
    throw new Error(`Theme Lab daemon status unavailable on ${socketPath}: ${detail}`);
  }
  let response;
  try { response = JSON.parse(status.stdout); } catch {
    throw new Error(`Theme Lab daemon status returned invalid JSON on ${socketPath}`);
  }
  if (response.ok === false) throw new Error(`Theme Lab daemon status failed on ${socketPath}: ${response.error?.code ?? "unknown_error"}`);
  const dir = response.result?.asset_dir;
  if (!dir) throw new Error(`Theme Lab daemon on ${socketPath} has no --asset-dir; candidate asset findings would be unverifiable`);
  const resolved = fs.realpathSync(dir);
  daemonAssetDirs.set(socketPath, resolved);
  return resolved;
}
const shaCache = new Map();

function sha256(file) {
  let digest = shaCache.get(file);
  if (!digest) {
    digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    shaCache.set(file, digest);
  }
  return digest;
}

function verifyFrozenPackage(item, {requireDaemonAssets = true} = {}) {
  // dear-dictator and quand-le-soleil-se-couche keep their own packaged assets
  // and are served by dedicated daemons, so their frozen pool is the daemon's
  // asset dir by construction and there is no second pool to reconcile.
  if (item.package.kind === THEME_PACKAGE_KINDS.RETAINED_AUTHORITY) return;
  if (item.package.kind === THEME_PACKAGE_KINDS.FOREIGN_PORT) {
    const foreign = item.package.manifest;
    if (!item.package.upstreamSourceFile || sha256(item.package.upstreamSourceFile) !== foreign.source_sha256) throw new Error("FR frozen source identity mismatch");
    for (const asset of foreign.assets) if (sha256(resolveExistingPackageFile(item.directory,path.join("assets",asset.name),`FR frozen asset ${asset.name}`)) !== asset.sha256) throw new Error(`FR frozen asset mismatch: ${asset.name}`);
    return;
  }
  const packageManifest = JSON.parse(fs.readFileSync(resolveExistingPackageFile(item.directory,"manifest.json",`${item.slug}: manifest`), "utf8"));
  const identity = packageManifest.source_identity;
  for (const [key, file] of [["en", "upstream-en.wikidot.txt"], ["jp", "existing-jp.wikidot.txt"]]) {
    const source = identity?.[key];
    if (!source?.sha256) continue;
    let sourcePath;try{sourcePath=resolveExistingPackageFile(item.directory,file,`${item.slug}: frozen ${key.toUpperCase()} source`)}catch{sourcePath=null}
    if (!sourcePath || sha256(sourcePath) !== source.sha256) {
      throw new Error(`${item.slug}: frozen ${key.toUpperCase()} source identity mismatch`);
    }
  }
  const candidateSource = fs.readFileSync(resolveExistingPackageFile(item.directory,item.package.sourceName,`${item.slug}: candidate source`), "utf8");
  const allowlistPath = path.join(item.directory, "confirmed-jp-user-links.json");
  const confirmedJpUsers = new Set(fs.existsSync(allowlistPath)
    ? JSON.parse(fs.readFileSync(resolveExistingPackageFile(item.directory,"confirmed-jp-user-links.json",`${item.slug}: confirmed JP users`), "utf8")).users.map((name) => name.toLowerCase()) : []);
  const unresolvedSiteLocalCredits = [...candidateSource.matchAll(/\[\[\*user\s+([^\]]+)\]\]/giu)]
    .map((match) => match[1].trim()).filter((name) => !confirmedJpUsers.has(name.toLowerCase()));
  if (unresolvedSiteLocalCredits.length) {
    throw new Error(`${item.slug}: ${unresolvedSiteLocalCredits.length} unreviewed site-local author identity link(s); confirm on SCP-JP or preserve the credited name as text`);
  }
  const assetManifest = JSON.parse(fs.readFileSync(resolveExistingPackageFile(item.directory,"assets.json",`${item.slug}: asset manifest`), "utf8"));
  // --verify-only stays hermetic and daemon-free, so the daemon pool is only
  // reconciled when this run will actually ask the daemon to render the CSS.
  const served = requireDaemonAssets ? daemonAssetDir(item.socket ?? socket) : null;
  for (const asset of assetManifest.assets ?? []) {
    const filename = assetByDigest.get(asset.sha256);
    let frozenFile=null;try{if(filename)frozenFile=resolveExistingContainedFile(assetRoot,filename,`${item.slug}: frozen CSS asset`)}catch{}
    if (!frozenFile || sha256(frozenFile) !== asset.sha256) {
      throw new Error(`${item.slug}: frozen CSS asset missing or corrupt: ${asset.sha256}`);
    }
    let servedFile=null;try{if(served&&filename)servedFile=resolveExistingContainedFile(served,filename,`${item.slug}: daemon CSS asset`)}catch{}
    if (served && (!servedFile || sha256(servedFile) !== asset.sha256)) {
      throw new Error(
        `${item.slug}: Theme Lab daemon asset pool ${served} does not contain the frozen CSS asset ${filename}. `
        + `The package declares it, so a candidate_asset_missing finding here would be a daemon asset-pool `
        + `artifact and not a port finding. Restart the daemon with --asset-dir ${assetRoot}.`);
    }
  }
  const imports = new Set(assetManifest.imports ?? []);
  const importProvenance = assetManifest.import_provenance ?? [];
  const provenImports = new Set(importProvenance.map((row) => row.source_url));
  if (assetManifest.import_provenance_status === "complete") {
    for (const url of imports) {
      if (!provenImports.has(url)) throw new Error(`${item.slug}: frozen CSS import lacks byte provenance: ${url}`);
    }
  }
  for (const row of importProvenance) {
    let file=null;try{if(row.asset_file)file=resolveExistingContainedFile(assetRoot,row.asset_file,`${item.slug}: frozen CSS import`)}catch{}
    if (!file || sha256(file) !== row.sha256) {
      throw new Error(`${item.slug}: frozen CSS import missing or corrupt: ${row.source_url}`);
    }
  }
  if (packageManifest.flattened_css_transforms) {
    let transformPath;try{transformPath=resolveExistingPackageFile(item.directory,packageManifest.flattened_css_transforms,`${item.slug}: flattened CSS transform manifest`)}catch{}
    if (!transformPath) {
      throw new Error(`${item.slug}: flattened CSS transform manifest missing: ${packageManifest.flattened_css_transforms}`);
    }
    const transformManifest = JSON.parse(fs.readFileSync(transformPath, "utf8"));
    const recordedManifest = assetManifest.localization_transform_manifest;
    if (!recordedManifest || recordedManifest.sha256 !== sha256(transformPath)) {
      throw new Error(`${item.slug}: flattened CSS transform manifest provenance is stale`);
    }
    const expectedIds = new Set((transformManifest.transforms ?? []).map((row) => row.id));
    const appliedIds = new Set((assetManifest.localization_transforms ?? []).map((row) => row.id));
    if (expectedIds.size !== appliedIds.size || [...expectedIds].some((id) => !appliedIds.has(id))) {
      throw new Error(`${item.slug}: flattened CSS transforms were not all applied`);
    }
  }
  const pageAssetsPath = path.join(item.directory, "page-assets.json");
  if (fs.existsSync(pageAssetsPath)) {
    const pageAssets = JSON.parse(fs.readFileSync(resolveExistingPackageFile(item.directory,"page-assets.json",`${item.slug}: page asset manifest`), "utf8"));
    for (const asset of pageAssets.assets ?? []) {
      let file=null;try{file=resolveExistingContainedFile(assetRoot,asset.asset_file,`${item.slug}: frozen page attachment`)}catch{}
      if (!file || sha256(file) !== asset.sha256) {
        throw new Error(`${item.slug}: frozen page attachment missing or corrupt: ${asset.filename}`);
      }
    }
  }
}

const packageLedger = loadAuthorityLedger(path.join(root, "install/local/theme-lab"));
const packageByName = new Map(discoverThemePackages(ports, {ledger: packageLedger}).map((pkg) => [pkg.name, pkg]));
function packageFor(name, label) {
  const pkg = packageByName.get(name);
  if (!pkg) throw new Error(`${label}: package is not discoverable under ports/`);
  return pkg;
}
function caseFor(pkg, overrides = {}) {
  return {
    slug: pkg.slug,
    directory: pkg.directory,
    candidate: pkg.previewName,
    css: pkg.cssName,
    reference: pkg.referenceUrl,
    selectors: pkg.selectorsFile ?? sharedSelectors,
    title: pkg.slug,
    package: pkg,
    ...overrides,
  };
}

const cases = manifest.themes.map((theme) => {
  const pkg = packageFor(theme.slug.replace(/^theme:/u, ""), theme.slug);
  const declared = fs.realpathSync(path.resolve(root, theme.port_package_path));
  if (declared !== pkg.directory) throw new Error(`${theme.slug}: campaign package path does not match canonical maintained package`);
  return caseFor(pkg);
});

cases.push(caseFor(packageFor("dear-dictator", "dear-dictator"), {
  slug: "theme:dear-dictator (SCP-KO)",
  title: "敬愛する独裁者 テーマ",
  socket: dearSocket,
}));

if (process.argv.includes("--maintained")) {
  const pkg = packageFor("quand-le-soleil-se-couche", "SCP-FR");
  cases.push(caseFor(pkg, {
    slug: "theme:quand-le-soleil-se-couche (SCP-FR)",
    surfaceContract: pkg.surfaceContractFile,
    title: "Quand le Soleil se couche",
    socket: process.env.THEME_LAB_FR_SOCKET ?? socket,
  }));
}
const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : null;
const noVisual = process.argv.includes("--no-visual");
const iteration = process.argv.includes("--iteration");
const verifyOnly = process.argv.includes("--verify-only");
const failOn = parseFailOn(process.argv);
// Evidence storage (#2752): by default a run's artifacts land in a
// per-run directory inside the content-addressed evidence store and are
// ingested + hardlink-materialized after each case, so identical
// captures across runs cost no extra blobs and the package tree stays
// bounded. THEME_LAB_RUN_ARTIFACT_DIR keeps the operator-managed
// location (no store wiring); --no-store restores the historical
// in-package artifacts/ default; THEME_LAB_EVIDENCE_STORE relocates
// the store.
const noStore = process.argv.includes("--no-store");
const evidenceStoreDir = process.env.THEME_LAB_EVIDENCE_STORE ? path.resolve(process.env.THEME_LAB_EVIDENCE_STORE) : defaultStorePath();
const storeRunRoot = path.join(evidenceStoreDir, "runs", new Date().toISOString().replace(/[:.]/gu, "-"));
const useStore = !runArtifactRoot && !noStore && !verifyOnly;
const artifactDirFor = (item) => runArtifactRoot ? path.join(runArtifactRoot, path.basename(item.directory)) : noStore ? path.join(item.directory, "artifacts") : path.join(storeRunRoot, path.basename(item.directory));
let selectedCases = only ? cases.filter((item) => item.slug === only || item.package.name === only) : cases;
if (only && selectedCases.length !== 1) {
  // A package that discovery can see is runnable by --only even when it is
  // not part of the default campaign selection (#2753).
  const discovered = packageByName.get(only) ?? [...packageByName.values()].find((pkg) => pkg.slug === only);
  if (!discovered) throw new Error(`unknown --only theme: ${only}`);
  selectedCases = [caseFor(discovered)];
}

// Set by scripts/preflight.sh once the adaptation authority check has verified
// every package's evidence on this tree in the same run; the evidence is not
// re-hashed here, and a standalone run still verifies it.
const authorityEvidenceAlreadyVerified = process.env.THEME_LAB_AUTHORITY_EVIDENCE_VERIFIED === "1";
const failures = [];
const inconclusives = [];
const summaries = [];
for (const item of selectedCases) {
  assertPublishablePackage(path.basename(item.directory), {checkOutputs: true, verifyAuthorityEvidence: !authorityEvidenceAlreadyVerified});
  verifyFrozenPackage(item, {requireDaemonAssets: !verifyOnly});
  if (verifyOnly) {
    summaries.push({slug: item.slug, status: "verified"});
    process.stdout.write(`${JSON.stringify(summaries.at(-1))}\n`);
    continue;
  }
  const caseArtifactDir = artifactDirFor(item);
  const candidateFile=resolveExistingPackageFile(item.directory,item.candidate,`${item.slug}: candidate preview`);
  const sourceFile=resolveExistingPackageFile(item.directory,item.package.sourceName,`${item.slug}: candidate source identity`);
  const cssFile=resolveExistingPackageFile(item.directory,item.css,`${item.slug}: candidate CSS`);
  const args = [
    lab, "check", "--socket", item.socket ?? socket, "--site-id", String(siteId),
    "--wikitext", candidateFile,
    "--source", sourceFile,
    "--css", cssFile,
    "--reference", item.reference, "--offline", "--selectors", item.selectors,
    "--title", item.title, "--compact", ...(noVisual ? [] : ["--visual"]), "--artifact-dir", caseArtifactDir,
  ];
  if (item.surfaceContract) args.push("--surface-contract",item.surfaceContract);
  const structureFile=path.join(item.directory,"acceptance-structure.json");
  if(fs.existsSync(structureFile))args.push("--source-structure",resolveExistingPackageFile(item.directory,"acceptance-structure.json",`${item.slug}: acceptance structure`));
  const baseCssBytes=currentPackageBaseCss(item.directory,path.basename(item.directory));
  const resolvedBaseCssFile=baseCssBytes===null?null:resolveExistingPackageFile(item.directory,"candidate-base.css",`${item.slug}: candidate base CSS`);
  if (resolvedBaseCssFile) args.push("--css-base",resolvedBaseCssFile);
  if (iteration) args.push("--iteration");
  const pageAssetManifest = path.join(item.directory, "page-assets.json");
  if (fs.existsSync(pageAssetManifest)) args.push("--page-assets", resolveExistingPackageFile(item.directory,"page-assets.json",`${item.slug}: page asset manifest`));
  const result = spawnSync(process.execPath, args, {cwd: root, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024});
  let output;
  try { output = JSON.parse(result.stdout); } catch {
    failures.push({slug: item.slug, reason: result.error?.message ?? result.stderr ?? "invalid JSON output", exit_code: result.status});
    summaries.push({slug: item.slug, status: "error"});
    process.stdout.write(`${JSON.stringify(summaries.at(-1))}\n`);
    continue;
  }
  if (output.ok === false) {
    const row = {slug: item.slug, status: "error", error: output.error, exit_code: result.status};
    failures.push(row); summaries.push(row); process.stdout.write(`${JSON.stringify(row)}\n`); continue;
  }
  const verdict = output.result ?? output;
  if (runArtifactRoot || useStore) {
    const rawResultPath = path.join(caseArtifactDir, "raw-result.json");
    fs.mkdirSync(path.dirname(rawResultPath), {recursive: true});
    fs.writeFileSync(rawResultPath, `${JSON.stringify({schema: "theme_lab_full_check_result.v1", result: verdict})}\n`);
  }
  const external = verdict.assets?.external_requests ?? verdict.asset_summary?.external_requests ?? 0;
  const localAcceptanceStatus = verdict.target_acceptance?.status ?? "unknown";
  const decisionIssues = (verdict.top_issues ?? []).filter((issue) => issue.parity_review?.may_treat_differences_as_port_requirements === true);
  const warningIssues = decisionIssues.filter((issue) => issue.severity === "warn");
  const errorIssues = decisionIssues.filter((issue) => issue.severity === "error");
  const missingAssets = verdict.assets?.candidate?.missing?.length ?? 0;
  const row = {
    slug: item.slug,
    verdict: verdict.overall_acceptance?.status ?? "inconclusive",
    overall_acceptance: verdict.overall_acceptance ?? {status: "inconclusive"},
    verification_scope: verdict.verification_scope ?? null,
    target_fixture_identity: verdict.target_fixture_identity ?? null,
    target_acceptance_contract_sha256: verdict.target_acceptance_contract_sha256 ?? null,
    candidate_source_sha256: sha256(sourceFile),
    candidate_css_sha256: sha256(cssFile),
    candidate_base_css_sha256: baseCssBytes===null ? null : crypto.createHash("sha256").update(baseCssBytes).digest("hex"),
    candidate_preview_sha256: sha256(candidateFile),
    port_decision: verdict.port_decision ?? null,
    parity_gate: verdict.parity_gate ?? null,
    local_target_acceptance: verdict.target_acceptance ?? null,
    local_target_acceptance_status: localAcceptanceStatus,
    errors: errorIssues.length,
    next_actions: verdict.next_actions?.length ?? 0,
    torture: verdict.torture?.verdict ?? "unknown",
    external_requests: external,
    missing_candidate_assets: missingAssets,
    viewport_status: verdict.viewport_status ?? null,
    font_diagnostics: verdict.font_diagnostics ?? null,
    interaction_diagnostics: verdict.interaction_diagnostics ?? null,
    image_diagnostics: verdict.image_diagnostics ?? null,
    page_image_assets: verdict.page_image_assets ?? null,
    acceptance_selector_file: path.relative(root, item.selectors),
    warning_issues: warningIssues,
    style_changes: verdict.style_changes ?? [],
    candidate_assets: verdict.assets?.candidate ?? null,
    reference_asset_failures: verdict.assets?.failed ?? [],
    blocked_external_attempts: verdict.assets?.browser_blocked_external_attempts ?? 0,
    visual: verdict.visual ?? null,
    timing_ms: verdict.timing_ms ?? null,
  };
  const viewportFailed = !iteration && Object.values(row.viewport_status ?? {}).some((entry) => entry.status !== "pass");
  const fontFailed = row.font_diagnostics?.status !== "measured" || !row.font_diagnostics.fonts?.some((font) => font.glyph_count > 0);
  const interactionFailed = !iteration && Object.values(row.interaction_diagnostics ?? {}).some((entry) => entry.status === "fail");
  const imageFailed = (row.image_diagnostics?.broken?.length ?? 0) > 0;
  const failedHard = result.status !== 0 || row.verdict === "fail" || localAcceptanceStatus === "fail" || row.errors > 0 || row.next_actions > 0 || (!iteration && !["pass", "warn"].includes(row.torture)) || external !== 0 || missingAssets > 0 || viewportFailed || fontFailed || interactionFailed || imageFailed;
  const inconclusiveOnly = !failedHard && row.verdict === "inconclusive";
  row.status = failedHard ? "fail" : inconclusiveOnly ? "inconclusive" : iteration ? "iteration-verdict" : row.verdict === "warn" ? "warn-no-actionable-issues" : "pass";
  if (failedHard) failures.push({...row, exit_code: result.status, stderr: result.stderr?.slice(0, 500)});
  else if (inconclusiveOnly) inconclusives.push({...row, exit_code: result.status, stderr: result.stderr?.slice(0, 500)});
  if (useStore) {
    try {
      row.evidence_store = await storeRunArtifacts(caseArtifactDir, {
        store: evidenceStoreDir,
        manifestPath: path.join(storeRunRoot, `${path.basename(item.directory)}.manifest.json`),
      });
    } catch (error) {
      // Storage must never lose a run's evidence or fail its verdict:
      // the raw artifacts stay in place and the row records the error.
      row.evidence_store_error = error instanceof Error ? error.message : String(error);
    }
  }
  summaries.push(row);
  process.stdout.write(`${JSON.stringify(row)}\n`);
}

process.stdout.write(`${JSON.stringify({summary: summarizeRun(summaries, {
  mode: verifyOnly ? "verify-only" : iteration ? "iteration" : "full-acceptance",
  failures,
  inconclusives,
}), failures, inconclusives, ...(useStore ? {evidence_store: {store: evidenceStoreDir, run_root: storeRunRoot}} : {})})}\n`);
process.exitCode = runExitCode({failures, inconclusives}, failOn);
