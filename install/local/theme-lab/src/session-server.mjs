// Long-lived theme-lab session.
//
// Keeps Chromium and the target pages alive so an agent can iterate on CSS
// without paying process/browser/navigation startup per edit. Communicates over
// a Unix socket with newline-delimited JSON.

import fs from "node:fs/promises";
import net from "node:net";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

import {
  assertSocketPath,
  prepareSocketForStart,
  removePidFile,
  writePidFile,
} from "./daemon.mjs";
import {errorPayload, fail} from "./errors.mjs";
import {
  applyPreview,
  applyStylesheet,
  capturePristineContent,
  clearStylesheet,
  closePage,
  collectCascadeDeclarations,
  collectElements,
  collectElementsBatch,
  collectSelectorMatches,
  collectSemanticAnchorElements,
  collectSnapshot,
  collectStyleSheetRules,
  collectViewportOverflow,
  exercisePreviewInteractions,
  inspectPlatformFonts,
  inspectBrokenImages,
  launchBrowser,
  navigate,
  openPage,
  restorePristineContent,
  screenshot,
  setViewport,
  waitForStylesheetsReady,
} from "./browser-lab.mjs";
import {cascadeDiagnosis} from "./cascade.mjs";
import {isLocalWikijumpHostname} from "./local-wikijump-host.mjs";
import {
  collectSelectorTexts,
  diffComputedStyles,
  firstRulesForSelectors,
  rankSelectorDiffs,
  selectorDiagnosis,
  summarizeComputedStyleDiffs,
} from "./css-probe.mjs";
import {startReferenceReplay} from "./reference-replay.mjs";
import {
  SEMANTIC_ANCHORS,
  classifyElement,
  suggestCandidateAnchors,
} from "./semantic-anchors.mjs";
import {TORTURE_VIEWPORTS, runTortureCorpus} from "./torture-corpus.mjs";
import {ACCEPTANCE_VIEWPORTS} from "./acceptance-viewports.mjs";
import {buildVerdict, expandVerdict} from "./verdict.mjs";
import {stateCapturesFromSurfaceCaptures} from "./viewport-overflow-classification.mjs";
import {annotateRuntimeSurfaceUsage, applyRuntimeSurfaceParityGate} from "./runtime-surface-parity.mjs";
import {captureVisualPair} from "./visual-diff.mjs";
import {bindVisualAcceptance} from "./visual-acceptance.mjs";
import {TARGET_ACCEPTANCE_CONTRACT, TARGET_ACCEPTANCE_CONTRACT_SHA256} from "./target-acceptance-contract.mjs";
import {measureTargetBaselineViewportOverflow} from "./target-baseline-viewport-probe.mjs";
import {fullCheckInputBindings} from "./full-check-input-bindings.mjs";
import {framerailSourceFingerprintSync} from "./framerail-source-fingerprint.mjs";
import {dedupeCssLayers} from "./css-layers.mjs";
import {inspectCandidateAssets, materializeCandidateCssAssets, materializeCandidatePageImages} from "./local-assets.mjs";
import {
  captureCustomSelectorCoverage,
  issuesFromCustomSelectorCoverage,
  normalizeSurfaceContract,
  runKnownSurfaceContract,
} from "./theme-surface-contract.mjs";

const SURFACE_CONTRACT_FIXTURE = new URL(
  "../ports/interactive-visual-fixture/fixture.wikidot.txt",
  import.meta.url,
);

const DEFAULT_PROPERTIES = [
  "display",
  "visibility",
  "position",
  "width",
  "height",
  "margin-top",
  "margin-left",
  "padding-top",
  "padding-left",
  "color",
  "background-color",
  "font-family",
  "font-size",
  "line-height",
  "font-weight",
  "text-transform",
  "border-top-width",
  "z-index",
];

const DEFAULT_VIEWPORTS = ACCEPTANCE_VIEWPORTS;

function verifyScenarioEvidence(evidence,{candidateUrl,siteId,css,baseCss,source}){
  if(evidence===null||evidence===undefined)return null;
  if(evidence.schema!=="theme_lab_scenario_execution_evidence.v1")fail("invalid_scenario_evidence","unsupported scenario execution evidence schema");
  const {execution_evidence_sha256:recorded,...unsigned}=evidence;
  const actual=crypto.createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
  if(recorded!==actual)fail("invalid_scenario_evidence","scenario execution evidence hash mismatch");
  for(const field of ["scenario_sha256","live_site_state_receipt_sha256","measurement_contract_sha256","theme_asset_dependency_sha256","theme_css_sha256","theme_source_sha256"]){
    if(!/^[0-9a-f]{64}$/u.test(evidence[field]??""))fail("invalid_scenario_evidence",`invalid ${field}`);
  }
  if(!['anonymous','authenticated'].includes(evidence.session_profile))fail("invalid_scenario_evidence","invalid scenario session profile");
  if(evidence.rendered_shell_sha256!==null&&!/^[0-9a-f]{64}$/u.test(evidence.rendered_shell_sha256??""))fail("invalid_scenario_evidence","invalid rendered_shell_sha256");
  if(evidence.theme_base_css_sha256!==null&&!/^[0-9a-f]{64}$/u.test(evidence.theme_base_css_sha256??""))fail("invalid_scenario_evidence","invalid theme_base_css_sha256");
  if(!Number.isSafeInteger(evidence.site_id)||evidence.site_id!==siteId)fail("invalid_scenario_evidence","scenario evidence site id does not match check");
  if(new URL(evidence.candidate_url).href!==new URL(candidateUrl).href)fail("invalid_scenario_evidence","scenario evidence candidate URL does not match opened page");
  if(typeof css!=="string"||crypto.createHash("sha256").update(css).digest("hex")!==evidence.theme_css_sha256)fail("invalid_scenario_evidence","scenario evidence theme CSS does not match check bytes");
  if(evidence.theme_base_css_sha256===null?(baseCss??'')!=='':typeof baseCss!=="string"||crypto.createHash("sha256").update(baseCss).digest("hex")!==evidence.theme_base_css_sha256)fail("invalid_scenario_evidence","scenario evidence theme base CSS does not match check bytes");
  if(typeof source!=="string"||crypto.createHash("sha256").update(source).digest("hex")!==evidence.theme_source_sha256)fail("invalid_scenario_evidence","scenario evidence theme source does not match check bytes");
  return evidence;
}

export function createSession({
  chromium,
  browser,
  browserEngine = 'chromium',
  browserVersion = null,
  candidateStorageState = null,
  scenarioEvidence = null,
  previewClient = null,
  referenceAssets = null,
  localAssets = null,
  sidebarHtml = null,
  interwikiHtml = null,
  navigationHtml = null,
  baselineCss = null,
  headerHtml = null,
  pages = {candidate: null, reference: null},
}) {
  const session = {
    chromium,
    browser,
    browserEngine,
    browserVersion,
    candidateStorageState,
    scenarioEvidence,
    previewClient,
    referenceAssets,
    localAssets,
    sidebarHtml,
    replays: new Map(),
    pages,
    cssId: "theme-lab-live-css",
    pristine: null,
    referenceMeasurementCache: null,
    async ensureSidebarFixture() {
      if (!pages.candidate || (sidebarHtml===null&&interwikiHtml===null)) return;
      const applied = await pages.candidate.evaluate(({sidebarHtml,interwikiHtml}) => {
        const sidebar = document.querySelector("#side-bar");
        if (!sidebar) return false;
        if(sidebarHtml!==null)sidebar.innerHTML=sidebarHtml;
        if(interwikiHtml!==null){sidebar.querySelectorAll('.scpnet-interwiki-wrapper').forEach(node=>node.remove());sidebar.insertAdjacentHTML('beforeend',interwikiHtml)}
        return true;
      }, {sidebarHtml,interwikiHtml});
      if (!applied) fail("missing_candidate_sidebar", "candidate page has no #side-bar for sidebar fixture");
    },
    async open({target = "candidate", url, viewport = null}) {
      let page = pages[target];
      if (page && (page.isClosed() || page.__themeLabCrashed)) {
        url ??= page.url();
        await closePage(page);
        delete pages[target];
        page = null;
      }
      if (!page) {
        page = await openPage(browser, {url, viewport, localOnly: true,...(target==='candidate'&&session.candidateStorageState?{storageState:session.candidateStorageState}:{})});
        page.__themeLabCrashed = false;
        page.on("crash", () => {page.__themeLabCrashed = true;});
        pages[target] = page;
      } else if (url && page.url() !== url) {
        await navigate(page, url);
      }
      if (target === "candidate") {
        if (isLocalWikijumpHostname(new URL(page.url()).hostname)) {
          await page.waitForFunction(() => {
            const control = document.querySelector("#history-button");
            if (!control) return true;
            return Object.getOwnPropertySymbols(control).some(symbol => symbol.description === "events" && typeof control[symbol]?.click === "function");
          }, null, {timeout: 15000});
        }
        if (baselineCss !== null) {
          await page.locator('link[rel="stylesheet"][href^="/wikidot/styles/sigma-"]').evaluateAll(links => links.forEach(link => {link.disabled = true; link.media = "not all";}));
          await applyStylesheet(page, baselineCss, "theme-lab-target-baseline");
        }
        if (headerHtml !== null) {
          await page.locator("#header").evaluate((header, html) => {
            const source = document.createElement("template"); source.innerHTML = html;
            for (const tag of ["h1", "h2"]) header.querySelector(tag).replaceWith(source.content.querySelector(tag).cloneNode(true));
          }, headerHtml);
        }
        if (navigationHtml !== null) {
          await page.locator("#top-bar").evaluate((element, html) => { element.innerHTML = html; }, navigationHtml);
        }
        if (sidebarHtml !== null || interwikiHtml !== null) {
          await page.waitForLoadState("load");
          await session.ensureSidebarFixture();
        }
        session.pristine = await capturePristineContent(page);
      }
      return {target, url: page.url()};
    },
    async restoreCandidate() {
      if (!pages.candidate || !session.pristine) return {restored: false};
      const restored = await restorePristineContent(pages.candidate, session.pristine);
      return {restored};
    },
    // Acquire (cache-first) a foreign reference and point the reference tab at
    // its loopback replay. `offline: true` forbids any network access.
    async loadReference({url, offline = false}) {
      if (!session.referenceAssets) fail("no_reference_cache", "reference cache is not configured");
      const acquire = await session.referenceAssets.acquire(url, {offline});
      let replay = session.replays.get(url);
      if (!replay) {
        replay = await startReferenceReplay({cache: session.referenceAssets, rootUrl: url});
        session.replays.set(url, replay);
      }
      const navigated = await session.open({target: "reference", url: replay.entryUrl});
      return {
        root_url: url,
        entry_url: replay.entryUrl,
        entry: acquire.entry,
        asset_count: acquire.asset_count,
        external_requests: acquire.external_requests,
        cache_hits: acquire.cache_hits,
        failed_asset_count: acquire.failed_asset_count ?? 0,
        failed_assets: acquire.failed_assets ?? [],
        browser_blocked_external_attempts: pages.reference?.__themeLabNetwork?.blocked_external_attempts ?? 0,
        browser_blocked_urls: pages.reference?.__themeLabNetwork?.blocked_urls ?? [],
        offline,
        url: navigated.url,
      };
    },
    async setCss({css, tortureSiteId = null, tortureSyntaxOnly = false}) {
      if (!pages.candidate) fail("no_candidate_page", "no candidate page is open; run open --url <candidate>");
      const assets = localAssets ? await inspectCandidateAssets(css, localAssets.root) : null;
      const effectiveCss = localAssets ? await materializeCandidateCssAssets(css, localAssets.root) : css;
      await applyStylesheet(pages.candidate, effectiveCss, session.cssId);
      const result = {bytes: Buffer.byteLength(css, "utf8"), assets};
      if (Number.isInteger(tortureSiteId)) {
        result.torture = await session.torture({
          siteId: tortureSiteId,
          syntaxOnly: tortureSyntaxOnly,
        });
      }
      return result;
    },
    async clearCss() {
      if (pages.candidate) await clearStylesheet(pages.candidate, session.cssId);
      return {cleared: true};
    },
    async preview({siteId, title, wikitext, syntaxOnly = false, containerSelector = "#page-content"}) {
      if (!session.previewClient) fail("no_preview_client", "no Deepwell preview client; start serve with DEEPWELL_RPC_TOKEN");
      if (!pages.candidate) fail("no_candidate_page", "no candidate page is open; run open --url <candidate>");
      const started = performance.now();
      const rendered = await session.previewClient.preview({siteId, title, wikitext, syntaxOnly});
      const rpcMs = performance.now() - started;
      const applied = await applyPreview(pages.candidate, {
        body: rendered.body,
        styles: rendered.styles,
        title,
        containerSelector,
      });
      const unresolvedIncludes = await pages.candidate.locator(`${containerSelector} .error-block`).evaluateAll((nodes) => {
        const rows = [];
        for (const node of nodes) {
          const text = (node.textContent ?? "").trim();
          const match = /^Included page "(?<page>[^"]+)" does not exist \(/u.exec(text);
          if (match?.groups?.page) rows.push({page: match.groups.page, message: text});
        }
        return rows;
      });
      return {
        rpc_ms: Number(rpcMs.toFixed(1)),
        total_ms: Number((performance.now() - started).toFixed(1)),
        body_bytes: applied.body_bytes,
        styles: applied.styles,
        legacy_actions: rendered.legacy_actions.length,
        unresolved_includes: unresolvedIncludes,
      };
    },
    async torture({siteId, title = "Theme Lab Torture", syntaxOnly = false}) {
      if (!session.previewClient) fail("no_preview_client", "no Deepwell preview client; start serve with DEEPWELL_RPC_TOKEN");
      if (!pages.candidate) fail("no_candidate_page", "no candidate page is open; run open --url <candidate>");
      return runTortureCorpus({
        page: pages.candidate,
        previewClient: session.previewClient,
        siteId,
        title,
        syntaxOnly,
      });
    },
    async setViewport({target = "candidate", width, height}) {
      const page = pages[target];
      if (!page) fail(`no_${target}_page`, `no ${target} page is open`);
      await setViewport(page, {width, height});
      return {target, width, height};
    },
    async snapshot({target = "candidate", selectors = null, properties = DEFAULT_PROPERTIES, max = 25}) {
      const page = pages[target];
      if (!page) fail(`no_${target}_page`, `no ${target} page is open`);
      const rules = await collectStyleSheetRules(page);
      const list = selectors?.length ? selectors : collectSelectorTexts(rules).slice(0, 400);
      const {counts, errors} = await collectSelectorMatches(page, list);
      const elements = {};
      for (const selector of list.slice(0, max)) {
        elements[selector] = await collectElements(page, {selector, properties, max: 5});
      }
      return {target, url: page.url(), rules, selectors: list, selector_counts: counts, selector_errors: errors, elements};
    },
    async probe({target = "candidate", selector, property, viewport = null}) {
      const page = pages[target];
      if (!page) fail(`no_${target}_page`, `no ${target} page is open`);
      if (!selector || !property) fail("invalid_probe", "probe requires selector and property");
      if (viewport) await setViewport(page, viewport);
      const selected = await collectElements(page, {selector, properties: [property], max: 1});
      const element = selected.elements?.[0] ?? null;
      if (!element) return {selector, property, matched: 0, viewport, error: selected.error ?? null};
      const declarations = await collectCascadeDeclarations(page, {selector, property});
      return {
        selector,
        property,
        matched: 1,
        viewport,
        computed: element.style?.[property] ?? null,
        rect: element.rect,
        cascade: cascadeDiagnosis({
          selector,
          property,
          candidateValue: element.style?.[property] ?? null,
          declarations: declarations.declarations,
          mediaInactive: declarations.media_inactive,
          inline: declarations.inline,
          variables: declarations.variables,
        }),
      };
    },
    async diff({referenceUrl = null, selectors = null, properties = DEFAULT_PROPERTIES, max = 60}) {
      if (!pages.candidate) fail("no_candidate_page", "no candidate page is open; run open --url <candidate>");
      if (referenceUrl) {
        await session.open({target: "reference", url: referenceUrl});
      }
      if (!pages.reference) fail("no_reference_page", "no reference page is open; pass --reference-url or fetch a reference snapshot");
      // Compare at one viewport so geometry deltas are meaningful.
      const compareViewport = {width: 1440, height: 1000};
      await setViewport(pages.reference, compareViewport);
      await setViewport(pages.candidate, compareViewport);
      // Stylesheets load after domcontentloaded; measuring before they apply
      // silently drops deltas (an unstyled reference inherits, so values can
      // equal the candidate and produce no row at all). Fail closed instead.
      for (const [name, measured] of [["reference", pages.reference], ["candidate", pages.candidate]]) {
        try {
          await waitForStylesheetsReady(measured, {timeout: 30_000});
        } catch (error) {
          fail("stylesheets_not_ready", `${name} page stylesheets were not ready before measurement at ${measured.url()}`, {cause: String(error?.message ?? error)});
        }
      }
      const currentReferenceUrl = pages.reference.url();
      const selectorsKey = selectors?.length ? JSON.stringify(selectors) : null;
      const propertiesKey = properties.join(",");
      const cache = session.referenceMeasurementCache;
      if (
        !cache ||
        cache.url !== currentReferenceUrl ||
        cache.selectorsKey !== selectorsKey ||
        cache.propertiesKey !== propertiesKey
      ) {
        const rules = await collectStyleSheetRules(pages.reference);
        const list = selectors?.length ? selectors : collectSelectorTexts(rules).slice(0, 400);
        const counts = (await collectSelectorMatches(pages.reference, list)).counts;
        session.referenceMeasurementCache = {
          url: currentReferenceUrl,
          selectorsKey,
          propertiesKey,
          rules,
          list,
          counts,
          elements: new Map(),
        };
      }
      const referenceCache = session.referenceMeasurementCache;
      const list = referenceCache.list;
      const referenceMatches = referenceCache.counts;
      const candidateMatches = (await collectSelectorMatches(pages.candidate, list)).counts;
      const selectorRows = rankSelectorDiffs({
        referenceRules: selectors?.length
          ? firstRulesForSelectors(referenceCache.rules, list)
          : referenceCache.rules,
        referenceCounts: referenceMatches,
        candidateCounts: candidateMatches,
      });

      // Probe computed styles for selectors that are broken, collapsed, or that
      // match a single element on both sides. The last group is what catches
      // "this rule still matches, but the element is 32px wider" without the
      // agent having to ask for it.
      const probeSelectors = [
        ...selectorRows.filter((row) => row.status === "missing").map((row) => row.selector),
        ...selectorRows.filter((row) => row.status === "count_changed").map((row) => row.selector),
        ...selectorRows
          .filter((row) => row.status === "match" && row.reference === 1)
          .map((row) => row.selector),
      ].slice(0, max);
      const uncached = probeSelectors.filter((selector) => !referenceCache.elements.has(selector));
      if (uncached.length > 0) {
        const collected = await collectElementsBatch(pages.reference, {
          selectors: uncached,
          properties,
          max: 5,
        });
        for (const [selector, value] of Object.entries(collected)) {
          referenceCache.elements.set(selector, value);
        }
      }
      const referenceElements = Object.fromEntries(
        probeSelectors.map((selector) => [selector, referenceCache.elements.get(selector)]),
      );
      const candidateElements = await collectElementsBatch(pages.candidate, {
        selectors: probeSelectors,
        properties,
        max: 5,
      });
      const computedRows = diffComputedStyles({
        reference: Object.fromEntries(
          Object.entries(referenceElements).map(([key, value]) => [key, value.elements?.[0]]),
        ),
        candidate: Object.fromEntries(
          Object.entries(candidateElements).map(([key, value]) => [key, value.elements?.[0]]),
        ),
        properties,
      });

      // Explain the top computed-style deltas: which candidate declaration wins.
      const cascadeRows = computedRows.filter((row) => !row.property.startsWith("rect.")).slice(0, 8);
      for (const row of cascadeRows) {
        try {
          const raw = await collectCascadeDeclarations(pages.candidate, {
            selector: row.anchor,
            property: row.property,
          });
          if (raw.matched > 0) {
            row.cascade = cascadeDiagnosis({
              selector: row.anchor,
              property: row.property,
              referenceValue: row.reference,
              candidateValue: row.candidate,
              declarations: raw.declarations,
              mediaInactive: raw.media_inactive,
              inline: raw.inline,
              variables: raw.variables,
            });
          }
        } catch {
          // cascade diagnosis is best-effort; never fail the diff for it
        }
      }

      // For each foreign selector that matched nothing, say what the reference
      // element was and which SCP-JP element plays that role now.
      const missingRows = selectorRows.filter((row) => row.status === "missing");
      if (missingRows.length > 0) {
        const candidateAnchors = await collectSemanticAnchorElements(pages.candidate, {
          anchors: SEMANTIC_ANCHORS,
        });
        for (const row of missingRows) {
          const element = referenceCache.elements.get(row.selector)?.elements?.[0];
          if (!element) continue;
          const referenceInfo = {...element, role: classifyElement(element)};
          row.semantic_mapping = {
            reference_role: referenceInfo.role,
            reference_element: {tag: element.tag, id: element.id, class: element.class, text: element.text},
            candidate_candidates: suggestCandidateAnchors(referenceInfo, candidateAnchors),
          };
        }
      }

      return {
        reference_url: pages.reference.url(),
        candidate_url: pages.candidate.url(),
        reference_selector_count: selectorRows.length,
        selectors: selectorRows,
        diagnosis: selectorDiagnosis(selectorRows),
        computed_styles: summarizeComputedStyleDiffs(computedRows),
      };
    },
    async check({
      css = null,
      baseCss = "",
      wikitext = null,
      savedCandidate = false,
      source = null,
      title = "Preview",
      syntaxOnly = false,
      pageAssets = [],
      referenceUrl = null,
      referenceOffline = false,
      selectors = null,
      siteId = null,
      torture = false,
      viewports = true,
      visual = false,
      visualReview = null,
      iteration = false,
      artifactDir = null,
      surfaceContract = null,
      sourceStructure = null,
      properties = DEFAULT_PROPERTIES,
      max = 60,
      verbose = false,
    }) {
      if (pages.candidate?.isClosed() || pages.candidate?.__themeLabCrashed) await session.open({target:"candidate"});
      const candidate = pages.candidate;
      if (!candidate) fail("no_candidate_page", "no candidate page is open");
      const verifiedScenarioEvidence=verifyScenarioEvidence(session.scenarioEvidence,{candidateUrl:candidate.url(),siteId,css,baseCss,source});
      if(savedCandidate && wikitext !== null && wikitext !== undefined)fail("saved_candidate_with_preview","savedCandidate cannot be combined with preview wikitext");
      const inspectCandidateDocument=(wikitext !== null && wikitext !== undefined)||savedCandidate;
      if ((wikitext !== null && wikitext !== undefined) || torture) {
        if (!Number.isSafeInteger(siteId)) fail("invalid_site_id", "siteId is required for preview/torture");
      }
      const timing = {};
      const started = performance.now();
      const full = {};
      let candidateAssets = null;
      let preview = null;
      let fontDiagnostics = null;
      let imageDiagnostics = null;
      let pageImageAssets = null;
      let interactionDiagnostics = null;
      let effectiveCss = typeof css === "string" ? dedupeCssLayers([baseCss, css]).join("\n") : null;
      let surfaceContractDiagnostics = null;

      // Undo any destructive operation (torture fixture, previous preview)
      // before measuring, so the reference comparison sees the real page.
      await session.ensureSidebarFixture();
      // CSS-only fast iterations intentionally reuse the last preview DOM so
      // style edits do not pay Deepwell preview cost or lose theme components.
      if (!(iteration && (wikitext === null || wikitext === undefined))) {
        await session.restoreCandidate();
      }

      if (wikitext !== null && wikitext !== undefined) {
        const step = performance.now();
        preview = await session.preview({siteId, title, wikitext, syntaxOnly});
        full.preview = preview;
        pageImageAssets = {
          substituted: localAssets ? await materializeCandidatePageImages(candidate, pageAssets, localAssets.root) : 0,
          provided: pageAssets.length,
        };
        full.page_image_assets = pageImageAssets;
        timing.preview_ms = Number((performance.now() - step).toFixed(1));
      }
      if (typeof css === "string") {
        const step = performance.now();
        candidateAssets = localAssets ? await inspectCandidateAssets(effectiveCss, localAssets.root) : null;
        effectiveCss = localAssets ? await materializeCandidateCssAssets(effectiveCss, localAssets.root) : effectiveCss;
        await applyStylesheet(candidate, effectiveCss, session.cssId);
        timing.css_ms = Number((performance.now() - step).toFixed(1));
      }
      if (inspectCandidateDocument) {
        const specimenSelector = "#page-content .theme-lab-jp-font-probe";
        const specimenCount = await candidate.locator(specimenSelector).count();
        fontDiagnostics = await inspectPlatformFonts(candidate, specimenCount ? specimenSelector : "#page-content", {engine: session.browserEngine});
        fontDiagnostics.evidence = specimenCount ? "japanese-glyph-specimen" : "candidate-japanese-article-content";
        full.font_diagnostics = fontDiagnostics;
        imageDiagnostics = await inspectBrokenImages(candidate);
        full.image_diagnostics = imageDiagnostics;
      }

      let reference = null;
      let loadedReference = null;
      if (referenceUrl) {
        const step = performance.now();
        const loaded = await session.loadReference({url: referenceUrl, offline: referenceOffline});
        loadedReference = loaded;
        reference = await session.diff({referenceUrl: loaded.entry_url, selectors, properties, max});
        timing.reference_ms = Number((performance.now() - step).toFixed(1));
        timing.reference_acquire_ms = Number((performance.now() - step).toFixed(1));
        full.reference_load = loaded;
        full.selector_rows = reference.selectors;
        full.computed_style_rows = reference.computed_styles?.top ?? [];
      }

      let viewportOverflow = null;
      let baselineViewportOverflow = null;
      if (viewports && !iteration) {
        const step = performance.now();
        if (typeof css === "string") {
          const measured=await measureTargetBaselineViewportOverflow({page:candidate,styleId:session.cssId,effectiveCss,viewports:DEFAULT_VIEWPORTS});
          baselineViewportOverflow=measured.baseline;
          viewportOverflow=measured.candidate;
          full.baseline_viewports = baselineViewportOverflow;
        }
        if(viewportOverflow===null)viewportOverflow = await collectViewportOverflow(candidate, DEFAULT_VIEWPORTS);
        timing.viewports_ms = Number((performance.now() - step).toFixed(1));
        full.viewports = viewportOverflow;
      }

      let visualResult = null;
      if (visual && !iteration) {
        const step = performance.now();
        const outputDir = artifactDir ?? path.join(os.tmpdir(), `theme-lab-visual-${Date.now()}`);
        visualResult = await captureVisualPair({
          candidatePage: candidate,
          referencePage: pages.reference ?? null,
          viewports: TORTURE_VIEWPORTS,
          outputDir,
        });
        timing.visual_ms = Number((performance.now() - step).toFixed(1));
        full.visual = visualResult;
      }

      if (inspectCandidateDocument && !iteration) {
        interactionDiagnostics = await exercisePreviewInteractions(candidate);
        full.interaction_diagnostics = interactionDiagnostics;
      }

      if (surfaceContract !== null && !iteration) {
        if (typeof css !== "string" || typeof effectiveCss !== "string") {
          fail("surface_contract_requires_css", "surface contract requires candidate CSS");
        }
        if (!Number.isSafeInteger(siteId) || !session.previewClient) {
          fail("surface_contract_requires_preview", "surface contract requires a Deepwell preview client and --site-id");
        }
        const contract = normalizeSurfaceContract(surfaceContract);
        const step = performance.now();
        const customSelectors = await captureCustomSelectorCoverage(candidate, contract);
        const surfaceFixture = await fs.readFile(SURFACE_CONTRACT_FIXTURE, "utf8");
        // Anonymous preview omits both iftags bodies. Surface acceptance needs
        // the saved article context, including the native negative tag branch.
        const rendered = await session.previewClient.savedPage({
          siteId,
          page: "run-owned:theme-lab-visual-acceptance-20260924",
          wikitext: surfaceFixture,
          tags: ["theme-lab-visual-acceptance", "jp", "日本語"],
        });
        await applyPreview(candidate, {
          body: rendered.body,
          styles: rendered.styles,
          title: "Theme Lab SCP-JP Surface Contract",
          containerSelector: "#page-content",
          styleId: "theme-lab-surface-contract-fixture-styles",
        });
        let structureOriginal = null;
        if(sourceStructure) {
          structureOriginal = await candidate.locator('#page-content').innerHTML();
          await candidate.locator('#page-content').evaluate((element,html)=>element.insertAdjacentHTML('afterbegin',html),sourceStructure.html);
        }
        let known;
        try {
          known = await runKnownSurfaceContract(candidate, {
            css,
            effectiveCss,
            styleId: session.cssId,
            contractValue: contract,
          });
          known.fixture_identity = {...rendered.identity,
            source_sha256: crypto.createHash("sha256").update(surfaceFixture).digest("hex"),
            body_sha256: crypto.createHash("sha256").update(rendered.body).digest("hex")};
        } finally {
          // Source-owned structure is a contract probe fixture, not part of
          // the candidate page. Restore it before interaction/torture checks
          // so a probe cannot leak synthetic DOM into later dimensions.
          if(structureOriginal !== null) await candidate.locator('#page-content').evaluate((element,html)=>{element.innerHTML=html},structureOriginal);
        }
        const customIssues = issuesFromCustomSelectorCoverage(customSelectors, contract.strict);
        const surfaceIssues = applyRuntimeSurfaceParityGate([...known.issues, ...customIssues]);
        surfaceContractDiagnostics = {
          schema: known.schema,
          strict: contract.strict,
          usage: annotateRuntimeSurfaceUsage(known.usage),
          custom_selectors: customSelectors,
          captures: known.captures,
          reviewed_findings: known.reviewed_findings,
          issues: surfaceIssues.issues,
          parity_gate: surfaceIssues.summary,
        };
        full.surface_contract = surfaceContractDiagnostics;
        timing.surface_contract_ms = Number((performance.now() - step).toFixed(1));
      }

      // Torture mutates the article content, so it runs last.
      let tortureResult = null;
      if (torture && !iteration) {
        const step = performance.now();
        tortureResult = await session.torture({siteId, syntaxOnly});
        timing.torture_ms = Number((performance.now() - step).toFixed(1));
        full.torture = tortureResult;
      }

      if (visualResult) await bindVisualAcceptance(visualResult, visualReview, {css, baseCss, wikitext, source});
      timing.total = Number((performance.now() - started).toFixed(1));
      const verdict = buildVerdict({
        reference,
        torture: tortureResult,
        viewports: viewportOverflow,
        baselineViewports: baselineViewportOverflow,
        // Captured interactive (surface-contract) states are the reveal-state
        // evidence for the state-aware viewport_overflow classification. No
        // frozen-reference viewport diagnostics are captured in this run, so
        // reference geometry stays unasserted (null) rather than invented.
        overflowStateCaptures: stateCapturesFromSurfaceCaptures(surfaceContractDiagnostics?.captures ?? []),
        fontDiagnostics,
        interactionDiagnostics,
        imageDiagnostics,
        pageImageAssets,
        visual: visualResult,
        timing,
        preview,
        assets: loadedReference
          ? {
              external_requests: loadedReference.external_requests,
              cache_hits: loadedReference.cache_hits,
              failed: loadedReference.failed_assets.map(({url, code}) => ({url, code})),
              browser_blocked_external_attempts: pages.reference?.__themeLabNetwork?.blocked_external_attempts ?? 0,
              browser_blocked_urls: pages.reference?.__themeLabNetwork?.blocked_urls ?? [],
              candidate: candidateAssets,
              candidate_request_failures: candidate?.__themeLabNetwork?.failed_requests.filter((row) =>
                row.url.startsWith("data:") || row.url.includes("/assets/"),
              ) ?? [],
            }
          : candidateAssets
            ? {
                candidate: candidateAssets,
                candidate_request_failures: candidate?.__themeLabNetwork?.failed_requests.filter((row) =>
                  row.url.startsWith("data:") || row.url.includes("/assets/"),
                ) ?? [],
              }
            : null,
        extraIssues: [
          ...(candidateAssets?.missing.map((name) => ({severity: "error", kind: "candidate_asset_missing", asset: name})) ?? []),
          ...(surfaceContractDiagnostics?.issues ?? []),
        ],
      });
      if (surfaceContractDiagnostics) {
        verdict.surface_contract = {
          strict: surfaceContractDiagnostics.strict,
          touched_surfaces: surfaceContractDiagnostics.usage.surfaces.map((surface) => surface.id),
          custom_selectors: surfaceContractDiagnostics.custom_selectors,
          reviewed_findings: surfaceContractDiagnostics.reviewed_findings,
          issue_count: surfaceContractDiagnostics.issues.length,
          parity_gate: surfaceContractDiagnostics.parity_gate,
        };
      }
      verdict.target_fixture_identity = Object.fromEntries(Object.entries({baseline:baselineCss,sidebar:sidebarHtml,interwiki:interwikiHtml,header:headerHtml,navigation:navigationHtml}).map(([name,bytes])=>[name,bytes===null?null:crypto.createHash("sha256").update(bytes).digest("hex")]));
      verdict.target_acceptance_contract_sha256 = TARGET_ACCEPTANCE_CONTRACT_SHA256;
      verdict.target_page_runtime_sha256 = TARGET_ACCEPTANCE_CONTRACT.static_inputs.target_page_runtime_sha256;
      verdict.full_check_input_bindings = fullCheckInputBindings({selectors,surfaceContract,sourceStructure,pageAssets,referenceUrl});
      if (loadedReference) {
        const manifest = await session.referenceAssets.load();
        verdict.reference_identity = {source_url: loadedReference.root_url,
          original_html_sha256: manifest.urls[loadedReference.root_url]?.digest ?? null,
          replay_entry: loadedReference.entry, offline: loadedReference.offline,
          snapshot_sha256: crypto.createHash('sha256').update(JSON.stringify(manifest.snapshots[loadedReference.root_url])).digest('hex')};
      }
      for (const [key, bytes] of Object.entries({candidate_css_sha256: css, candidate_source_sha256: source, candidate_preview_sha256: wikitext, candidate_base_css_sha256: baseCss || null})) {
        verdict[key] = typeof bytes === "string" ? crypto.createHash("sha256").update(bytes).digest("hex") : null;
      }
      if (visualResult) {
        verdict.visual_pair_context = {
          schema: "theme_lab_visual_pair_context.v1",
          comparison_scope: "cross-document-theme-identity",
          pixel_metric_decision_authority: false,
          reference_source_url: loadedReference?.root_url ?? referenceUrl ?? null,
          candidate_source_sha256: verdict.candidate_source_sha256,
          candidate_preview_sha256: verdict.candidate_preview_sha256,
          note: "Reference and candidate may contain localized or otherwise different document content; pixel RMSE is diagnostic and exact image review must judge theme identity rather than page-text equality.",
        };
      }
      const candidateDocumentStep=savedCandidate?"saved candidate document":"preview";
      verdict.verification_scope = iteration
        ? {mode: "iteration", completed: ["reference comparison", "candidate stylesheet", "preview", "assets", "Japanese fonts", "page images"], deferred: ["all viewports", "torture", "widget interactions", "visual screenshots"]}
        : {mode: "full", completed: ["reference comparison", "candidate stylesheet", candidateDocumentStep, "assets", "Japanese fonts", "page images", "all viewports", "torture", "widget interactions", ...(visual ? ["visual screenshots"] : [])], deferred: []};
      if(savedCandidate)verdict.verification_scope.candidate_document_source="saved-page";
      if(verifiedScenarioEvidence)verdict.scenario_execution_evidence=verifiedScenarioEvidence;
      verdict.browser_runtime={engine:session.browserEngine,version:session.browserVersion,session_profile:verifiedScenarioEvidence?.session_profile??null};
      if (pages.candidate?.__themeLabRuntimeIdentity) verdict.target_runtime_identity = {
        ...structuredClone(pages.candidate.__themeLabRuntimeIdentity),
        source_sha256: framerailSourceFingerprintSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')),
        scope: 'Task-owned built Framerail source verified by the candidate response header',
      };
      return verbose ? expandVerdict(verdict, full) : verdict;
    },
    async screenshot({target = "candidate", path: outputPath, fullPage = true, viewport = null}) {
      const page = pages[target];
      if (!page) fail(`no_${target}_page`, `no ${target} page is open`);
      return screenshot(page, {path: outputPath, fullPage, viewport});
    },
    async status() {
      return {
        asset_dir: localAssets?.root ?? null,
        pages: Object.fromEntries(
          Object.entries(pages)
            .filter(([, page]) => Boolean(page))
            .map(([name, page]) => [name, page.url()]),
        ),
        failed_requests: Object.fromEntries(
          Object.entries(pages)
            .filter(([, page]) => Boolean(page))
            .map(([name, page]) => [name, page.__themeLabNetwork?.failed_requests ?? []]),
        ),
      };
    },
    async close() {
      for (const page of Object.values(pages)) {
        if (page) await closePage(page);
      }
      await browser.close().catch(() => {});
      for (const replay of session.replays.values()) {
        await replay.close().catch(() => {});
      }
      session.replays.clear();
    },
  };
  return session;
}

export async function startSessionServer({
  socketPath,
  chromium,
  browserEngine = 'chromium',
  candidateStorageState = null,
  scenarioEvidence = null,
  cdpEndpoint = null,
  executablePath = null,
  headless = true,
  candidateUrl = null,
  previewClient = null,
  referenceAssets = null,
  assetDir = null,
  sidebarHtml = null,
  interwikiHtml = null,
  navigationHtml = null,
  baselineCss = null,
  headerHtml = null,
}) {
  assertSocketPath(socketPath);
  await prepareSocketForStart(socketPath);

  let browser = null;
  let session = null;
  let server = null;
  let localAssets = null;
  try {
    // WebKitGTK's default proxy resolver fails every request in the current
    // Linux runner. Give it a loopback-only bypass; openPage still aborts any
    // request outside the local Wikijump origins before it reaches a proxy.
    const proxy=browserEngine==='webkit'
      ?{server:'http://127.0.0.1:9',bypass:'localhost,127.0.0.1,.localhost'}
      :undefined;
    browser = await launchBrowser({chromium, cdpEndpoint, executablePath, headless, proxy});
    const browserVersion=typeof browser.version==='function'?browser.version():null;
    if (assetDir) localAssets = {root: await fs.realpath(assetDir)};
    session = createSession({chromium, browser, browserEngine, browserVersion, candidateStorageState, scenarioEvidence, previewClient, referenceAssets, localAssets, sidebarHtml, interwikiHtml, navigationHtml, baselineCss, headerHtml});
    if (candidateUrl) await session.open({target: "candidate", url: candidateUrl});
    server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          handleLine(session, line)
            .then((response) => socket.write(`${JSON.stringify(response)}\n`))
            .catch((error) => socket.write(`${JSON.stringify(errorPayload(error))}\n`));
        }
      });
    });
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, resolve);
    });
  } catch (error) {
    await session?.close().catch(() => {});
    if (!session) await browser?.close().catch(() => {});
    await fs.rm(socketPath, {force: true});
    throw error;
  }

  await writePidFile(socketPath);
  return {
    session,
    server,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await session.close();
      await fs.rm(socketPath, {force: true});
      await removePidFile(socketPath);
    },
  };
}

async function handleLine(session, line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (error) {
    return {ok: false, error: {code: "invalid_json", message: `invalid JSON request: ${error.message}`}};
  }
  switch (request.op) {
    case "ping":
      return {ok: true, result: {ok: true}};
    case "open":
      return {ok: true, result: await session.open(request)};
    case "set_css":
      return {ok: true, result: await session.setCss(request)};
    case "clear_css":
      return {ok: true, result: await session.clearCss()};
    case "preview":
      return {ok: true, result: await session.preview(request)};
    case "torture":
      return {ok: true, result: await session.torture(request)};
    case "check":
      return {ok: true, result: await session.check(request)};
    case "reference_load":
      return {ok: true, result: await session.loadReference(request)};
    case "viewport":
      return {ok: true, result: await session.setViewport(request)};
    case "snapshot":
      return {ok: true, result: await session.snapshot(request)};
    case "probe":
      return {ok: true, result: await session.probe(request)};
    case "diff":
      return {ok: true, result: await session.diff(request)};
    case "screenshot":
      return {ok: true, result: await session.screenshot(request)};
    case "status":
      return {ok: true, result: await session.status()};
    default:
      return {ok: false, error: {code: "unknown_operation", message: `unknown operation: ${String(request.op)}`}};
  }
}

export {DEFAULT_PROPERTIES, DEFAULT_VIEWPORTS};
