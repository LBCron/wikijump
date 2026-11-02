import {
  DEFAULT_SETTLE_MS,
  STANDING_BROWSER_CANARIES,
} from "./standing-browser-canaries.mjs";
import { STANDING_BROWSER_EXECUTION_MODULES } from "./standing-browser-execution-identity.mjs";
import { candidateSitePageOrigin } from "./standing-browser-parity-receipt.mjs";
import {
  requirePlainObject,
  requireSha256,
  sha256Value,
} from "./standing-browser-parity-util.mjs";

export const OPEN43_B689_TABVIEW_INITIAL_CASE_ID = "B689_TABVIEW_INITIAL";
export const OPEN43_B689_TABVIEW_SETTLED_CASE_ID = "B689_TABVIEW_SETTLED";
export const OPEN43_B689_SCP8980_NAVIGATION_CASE_ID = "B689_SCP8980_AND_NAVIGATION_LIFECYCLE";
export const OPEN43_B689_CASE_IDS = Object.freeze([
  OPEN43_B689_TABVIEW_INITIAL_CASE_ID,
  OPEN43_B689_TABVIEW_SETTLED_CASE_ID,
  OPEN43_B689_SCP8980_NAVIGATION_CASE_ID,
]);

export const OPEN43_B689_TABVIEW_FIXTURE = Object.freeze({
  fixture_id: "open43-standing-browser-tabview-canaries",
  source_path: "install/local/wikidot-verification/src/standing-browser-canaries.mjs",
  source_sha256: "6c9ad3b406d2a6f0f089b38b8ac3f882b10f0e9c0e43462f54f19ded58203e83",
  canary_slugs: Object.freeze(["theme:basalt", "scp-8980"]),
});

const SCP8980_LIVE_TABVIEW_STYLES = Object.freeze({ display: "grid", position: "relative", visibility: "visible", font_family: "InterVariable, blinkmacsystemfont, \"Segoe UI\", Roboto, Oxygen, Ubuntu, Cantarell, \"Fira Sans\", \"Droid Sans\", \"Helvetica Neue\", sans-serif", font_size: "15.2705px" });
const LIVE_NAV_STYLES = Object.freeze({ display: "flex", position: "static", visibility: "visible", font_family: "\"JetBrains Mono\", menlo, consolas, monaco, \"liberation mono\", \"lucida console\", monospace", font_size: "14.507px" });
const LIVE_CONTENT_STYLES = Object.freeze({ display: "block", position: "static", visibility: "visible", font_family: "InterVariable, blinkmacsystemfont, \"Segoe UI\", Roboto, Oxygen, Ubuntu, Cantarell, \"Fira Sans\", \"Droid Sans\", \"Helvetica Neue\", sans-serif", font_size: "15.2705px" });

export const OPEN43_B689_TABVIEW_LIVE_ORACLE = Object.freeze({
  schema: "wikijump.open43.b689.tabview_live_oracle.v1",
  viewport: Object.freeze({ width: 1366, height: 900, device_scale_factor: 1 }),
  thresholds_px: Object.freeze({ position: 8, size: 12 }),
  provenance: Object.freeze([
    Object.freeze({
      path: "/home/roku/wjlab/evidence/standing-promotion-20260721-f0099338/host-live-reference-v1/standing-browser-live-reference.json",
      sha256: "1967c4de664f3b7535629cd6622152076a0320d18239c19e0716a0f69a7c7332",
      role: "theme:basalt initial and settled live geometry and DOM",
    }),
    Object.freeze({
      path: "/home/roku/wjlab/evidence/standing-browser-20260715/scp8980-local-live-structural-diff-20260715T061801Z/capture.json",
      sha256: "420a132795f52adb3ccae66b1e2fdaf80e099628d46e0a97263274751edebc7b",
      role: "scp-8980 initial live geometry and computed style",
    }),
    Object.freeze({
      path: "/home/roku/wjlab/evidence/20260808-open87-execution/pr2-ed5c5b353/browser-diagnostics/issue-690-scp8980-first-divergence-20260809.json",
      sha256: "f3755f5abaebb7b07c3a21d2eab3f9cfe89c1d4ffcccfb1ca4245c631067afe4",
      role: "scp-8980 settled live DOM, tabview position, panel identity, and diagnostic identity; absolute height was captured under Chrome 150 and remains diagnostic only",
    }),
    Object.freeze({
      path: "/home/roku/wjlab/evidence/compat-release-7acd2fe9fa1f-20260828/diagnostics/live-proxy-theme-basalt/observation.json",
      sha256: "fd64a7f4c0738a823604fa8af2a603df30ed956e9ac98de41364e10453c16b1b",
      role: "fresh Chromium 149 live proxy capture for the browser-bound theme:basalt settled geometry",
    }),
  ]),
  pages: Object.freeze({
    "theme:basalt": Object.freeze({
      live_url: "https://scp-wiki.wikidot.com/theme:basalt",
      tabview: Object.freeze({
        count: 1,
        id_present: true,
        class_name: "yui-navset",
        rectangle: Object.freeze({ x: 123, y: 3817.69, width: 1120, height: 137.44 }),
        selected_title: null,
        label_wrapper: "em",
        panel_ids_present: true,
      }),
      resource_state: Object.freeze({ document_ready_state: "interactive" }),
      settled: Object.freeze({
        tabview_rectangle: Object.freeze({ x: 123, y: 3954.65625, width: 1120, height: 188.69 }),
        class_name: "yui-navset yui-navset-top",
        selected_title: "active",
      }),
    }),
    "scp-8980": Object.freeze({
      live_url: "https://scp-wiki.wikidot.com/scp-8980",
      tabview: Object.freeze({
        count: 1,
        id_present: true,
        class_name: "yui-navset yui-navset-top",
        rectangle: Object.freeze({ x: 203, y: 168, width: 960, height: 58505.09 }),
        styles: SCP8980_LIVE_TABVIEW_STYLES,
        selected_title: "active",
        label_wrapper: "em",
        panel_ids_present: true,
      }),
      nav_styles: LIVE_NAV_STYLES,
      content_styles: LIVE_CONTENT_STYLES,
      panel_styles: LIVE_CONTENT_STYLES,
      resource_state: Object.freeze({ document_ready_state: "interactive" }),
      settled: Object.freeze({
        tabview_y: 168,
        first_panel_id: "wiki-tab-0-0",
      }),
    }),
  }),
});

const VIEWPORT = Object.freeze({
  width: OPEN43_B689_TABVIEW_LIVE_ORACLE.viewport.width,
  height: OPEN43_B689_TABVIEW_LIVE_ORACLE.viewport.height,
});
const B689_SETTLE_MS = 0;
const CANARIES = Object.freeze(
  OPEN43_B689_TABVIEW_FIXTURE.canary_slugs.map((slug) =>
    STANDING_BROWSER_CANARIES.find((canary) => canary.slug === slug),
  ),
);
const FIXTURE_IDENTITY_SHA256 = sha256Value(OPEN43_B689_TABVIEW_FIXTURE);
const LIVE_ORACLE_IDENTITY_SHA256 = sha256Value(OPEN43_B689_TABVIEW_LIVE_ORACLE);

const SOURCE_FILES = Object.freeze([
  ...new Set([
    ...STANDING_BROWSER_EXECUTION_MODULES,
    "install/local/wikidot-verification/scripts/run-candidate-cases.mjs",
    "install/local/wikidot-verification/src/candidate-case-command.mjs",
    "install/local/wikidot-verification/src/candidate-case-runner.mjs",
    "install/local/wikidot-verification/src/candidate-browser-contexts.mjs",
    "install/local/wikidot-verification/src/open43-browser-689-candidate-case-set.mjs",
    "install/local/wikidot-verification/package.json",
    "install/local/wikidot-verification/pnpm-lock.yaml",
    "deepwell/src/services/render/service.rs",
    "framerail/src/lib/wikidot/wikidot-tabviews.ts",
    "framerail/package.json",
    "framerail/pnpm-lock.yaml",
  ]),
]);

function exactFixture(privateInput) {
  const fixture = requirePlainObject(privateInput.fixture, "private input fixture");
  if (sha256Value(fixture) !== FIXTURE_IDENTITY_SHA256) {
    throw new Error("private input fixture is not the sealed B689 canary fixture");
  }
  return fixture;
}

async function observeTabviews(page) {
  return await page.evaluate(() => {
    const rectangle = (element) => {
      const value = element.getBoundingClientRect();
      return { x: value.x + window.scrollX, y: value.y + window.scrollY, width: value.width, height: value.height };
    };
    const styles = (element) => {
      const value = getComputedStyle(element);
      return {
        display: value.display,
        position: value.position,
        visibility: value.visibility,
        font_family: value.fontFamily,
        font_size: value.fontSize,
      };
    };
    const roots = [...document.querySelectorAll("#page-content .yui-navset")];
    const images = [...document.images];
    return {
      tabview_count: roots.length,
      tabviews: roots.map((root) => {
        const nav = root.querySelector(":scope > .yui-nav");
        const content = root.querySelector(":scope > .yui-content");
        const tabs = nav ? [...nav.children].filter((item) => item.tagName === "LI") : [];
        const panels = content ? [...content.children] : [];
        const selected = tabs.find((tab) => tab.classList.contains("selected"));
        return {
          class_name: root.className,
          id_present: root.id.length > 0,
          styles: styles(root),
          rectangle: rectangle(root),
          tab_count: tabs.length,
          selected_count: tabs.filter((tab) => tab.classList.contains("selected")).length,
          visible_panel_count: panels.filter((panel) => getComputedStyle(panel).display !== "none").length,
          panel_count: panels.length,
          selected_title: selected?.getAttribute("title") ?? null,
          label_wrapper: selected?.querySelector("a em")?.tagName.toLowerCase() ?? null,
          panel_ids_present: panels.length > 0 && panels.every((panel) => panel.id.length > 0),
          first_panel_id: panels[0]?.id ?? null,
          nav_styles: nav ? styles(nav) : null,
          content_styles: content ? styles(content) : null,
          first_panel_styles: panels[0] ? styles(panels[0]) : null,
          first_panel_rectangle: panels[0] ? rectangle(panels[0]) : null,
        };
      }),
      resource_state: {
        document_ready_state: document.readyState,
        stylesheet_count: document.styleSheets.length,
        image_count: document.images.length,
        incomplete_image_count: [...document.images].filter((image) => !image.complete).length,
        rendered_image_count: images.filter((image) => {
          const style = getComputedStyle(image);
          const box = image.getBoundingClientRect();
          return image.complete && image.naturalWidth > 0 && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
        }).length,
        broken_image_count: images.filter((image) => !image.complete || image.naturalWidth === 0).length,
        font_status: document.fonts?.status ?? null,
        resource_entry_count: performance.getEntriesByType("resource").length,
      },
    };
  });
}

async function installDomContentLoadedTabviewCapture(page) {
  await page.addInitScript(() => {
    window.addEventListener(
      "DOMContentLoaded",
      () => {
        const rectangle = (element) => {
          const value = element.getBoundingClientRect();
          return { x: value.x, y: value.y, width: value.width, height: value.height };
        };
        const styles = (element) => {
          const value = getComputedStyle(element);
          return {
            display: value.display,
            position: value.position,
            visibility: value.visibility,
            font_family: value.fontFamily,
            font_size: value.fontSize,
          };
        };
        const roots = [...document.querySelectorAll("#page-content .yui-navset")];
        const images = [...document.images];
        window.__wikijumpB689DomContentLoadedObservation = {
          tabview_count: roots.length,
          tabviews: roots.map((root) => {
            const nav = root.querySelector(":scope > .yui-nav");
            const content = root.querySelector(":scope > .yui-content");
            const tabs = nav ? [...nav.children].filter((item) => item.tagName === "LI") : [];
            const panels = content ? [...content.children] : [];
            const selected = tabs.find((tab) => tab.classList.contains("selected"));
            return {
              class_name: root.className,
              id_present: root.id.length > 0,
              styles: styles(root),
              rectangle: rectangle(root),
              tab_count: tabs.length,
              selected_count: tabs.filter((tab) => tab.classList.contains("selected")).length,
              visible_panel_count: panels.filter((panel) => getComputedStyle(panel).display !== "none").length,
              panel_count: panels.length,
              selected_title: selected?.getAttribute("title") ?? null,
              label_wrapper: selected?.querySelector("a em")?.tagName.toLowerCase() ?? null,
              panel_ids_present: panels.length > 0 && panels.every((panel) => panel.id.length > 0),
              first_panel_id: panels[0]?.id ?? null,
              nav_styles: nav ? styles(nav) : null,
              content_styles: content ? styles(content) : null,
              first_panel_styles: panels[0] ? styles(panels[0]) : null,
              first_panel_rectangle: panels[0] ? rectangle(panels[0]) : null,
            };
          }),
          resource_state: {
            document_ready_state: document.readyState,
            stylesheet_count: document.styleSheets.length,
            image_count: document.images.length,
            incomplete_image_count: images.filter((image) => !image.complete).length,
            rendered_image_count: images.filter((image) => {
              const style = getComputedStyle(image);
              const box = image.getBoundingClientRect();
              return image.complete && image.naturalWidth > 0 && style.display !== "none" && style.visibility !== "hidden" && box.width > 0 && box.height > 0;
            }).length,
            broken_image_count: images.filter((image) => !image.complete || image.naturalWidth === 0).length,
            font_status: document.fonts?.status ?? null,
            resource_entry_count: performance.getEntriesByType("resource").length,
          },
        };
      },
      { once: true, capture: true },
    );
  });
}

async function readDomContentLoadedTabviewCapture(page) {
  return await page.evaluate(() => window.__wikijumpB689DomContentLoadedObservation ?? null);
}

function positiveRectangle(value, name) {
  const rectangleValue = requirePlainObject(value, name);
  for (const field of ["x", "y", "width", "height"]) {
    if (typeof rectangleValue[field] !== "number" || !Number.isFinite(rectangleValue[field])) {
      throw new Error(`${name}.${field} is not a finite number`);
    }
  }
  if (rectangleValue.width <= 0 || rectangleValue.height <= 0) {
    throw new Error(`${name} has no visible geometry`);
  }
  return rectangleValue;
}

function compareRectangle(actual, expected, name, fields = ["x", "y", "width", "height"]) {
  const value = positiveRectangle(actual, name);
  for (const field of fields.filter((field) => ["x", "y"].includes(field))) {
    if (Math.abs(value[field] - expected[field]) > OPEN43_B689_TABVIEW_LIVE_ORACLE.thresholds_px.position) throw new Error(`${name} geometry drift in ${field}`);
  }
  for (const field of fields.filter((field) => ["width", "height"].includes(field))) {
    if (Math.abs(value[field] - expected[field]) > OPEN43_B689_TABVIEW_LIVE_ORACLE.thresholds_px.size) throw new Error(`${name} geometry drift in ${field}`);
  }
  return value;
}

function compareStyles(actual, expected, name) {
  const value = requirePlainObject(actual, `${name} styles`);
  for (const field of ["display", "position", "visibility", "font_family", "font_size"]) {
    if (value[field] !== expected[field]) throw new Error(`${name} ${field} differs from live oracle`);
  }
}

function verifyPage(page, expectedUrl) {
  if (
    page.navigation_status !== 200 ||
    page.input_url !== expectedUrl ||
    page.final_url !== expectedUrl ||
    page.http_error_count !== 0
  ) {
    throw new Error(`B689 initial browser page mismatched: ${page.slug}`);
  }
  const oracle = OPEN43_B689_TABVIEW_LIVE_ORACLE.pages[page.slug];
  if (!oracle) throw new Error(`B689 page has no retained live oracle: ${page.slug}`);
  const observation = requirePlainObject(page.observation, `${page.slug} tabview observation`);
  if (observation.tabview_count !== oracle.tabview.count || !Array.isArray(observation.tabviews) || observation.tabviews.length !== oracle.tabview.count) {
    throw new Error(`B689 tabview is missing: ${page.slug}`);
  }
  for (const [index, tabview] of observation.tabviews.entries()) {
    if (
      tabview.tab_count < 1 ||
      tabview.tab_count !== tabview.panel_count ||
      tabview.selected_count !== 1 ||
      tabview.visible_panel_count !== 1 ||
      tabview.styles?.visibility !== "visible" ||
      tabview.id_present !== true ||
      tabview.class_name !== oracle.tabview.class_name ||
      tabview.selected_title !== oracle.tabview.selected_title ||
      tabview.label_wrapper !== oracle.tabview.label_wrapper ||
      tabview.panel_ids_present !== oracle.tabview.panel_ids_present
    ) {
      throw new Error(`B689 tabview structure mismatched: ${page.slug} #${index}`);
    }
    compareRectangle(
      tabview.rectangle,
      oracle.tabview.rectangle,
      `${page.slug} tabview #${index}`,
      page.slug === "scp-8980" ? ["x", "y", "width"] : ["x", "width", "height"],
    );
    if (oracle.tabview.first_panel_rectangle !== undefined) {
      compareRectangle(tabview.first_panel_rectangle, oracle.tabview.first_panel_rectangle, `${page.slug} first panel #${index}`);
    }
    if (oracle.tabview.styles !== undefined) compareStyles(tabview.styles, oracle.tabview.styles, `${page.slug} tabview #${index}`);
    if (oracle.nav_styles !== undefined) compareStyles(tabview.nav_styles, oracle.nav_styles, `${page.slug} nav`);
    if (oracle.content_styles !== undefined) compareStyles(tabview.content_styles, oracle.content_styles, `${page.slug} content`);
    if (oracle.panel_styles !== undefined) compareStyles(tabview.first_panel_styles, oracle.panel_styles, `${page.slug} first panel`);
  }
  const resourceState = requirePlainObject(observation.resource_state, `${page.slug} resource state`);
  if (
    typeof resourceState.document_ready_state !== "string" ||
    typeof resourceState.stylesheet_count !== "number" ||
    typeof resourceState.image_count !== "number" ||
    typeof resourceState.incomplete_image_count !== "number" ||
    typeof resourceState.resource_entry_count !== "number" ||
    resourceState.document_ready_state !== oracle.resource_state.document_ready_state ||
    (oracle.resource_state.rendered_image_count !== undefined && resourceState.rendered_image_count !== oracle.resource_state.rendered_image_count) ||
    (oracle.resource_state.broken_image_count !== undefined && resourceState.broken_image_count !== oracle.resource_state.broken_image_count)
  ) {
    throw new Error(`B689 resource state is incomplete: ${page.slug}`);
  }
}

export function verifyOpen43B689TabviewInitial(observations, plan) {
  const value = requirePlainObject(observations, "B689_TABVIEW_INITIAL observations");
  if (
    value.fixture_identity_sha256 !== plan.fixture_identity_sha256 ||
    value.live_oracle_identity_sha256 !== plan.live_oracle_identity_sha256 ||
    value.phase !== "domcontentloaded_immediate_observation" ||
    value.sequence !== 1 ||
    !Array.isArray(value.pages) ||
    value.pages.length !== OPEN43_B689_TABVIEW_FIXTURE.canary_slugs.length
  ) {
    throw new Error("B689 initial tabview denominator or phase mismatched");
  }
  requireSha256(value.browser_environment.executable_sha256, "B689 browser executable SHA-256");
  const observedSlugs = value.pages.map((page) => page.slug);
  if (new Set(observedSlugs).size !== observedSlugs.length) throw new Error("B689 duplicate page rows");
  if (observedSlugs.some((slug) => !OPEN43_B689_TABVIEW_FIXTURE.canary_slugs.includes(slug))) throw new Error("B689 extra page row");
  const pages = new Map(value.pages.map((page) => [page.slug, page]));
  for (const slug of OPEN43_B689_TABVIEW_FIXTURE.canary_slugs) {
    const page = pages.get(slug);
    if (!page) throw new Error(`B689 page is missing: ${slug}`);
    verifyPage(page, new URL(`/${encodeURI(slug)}`, plan.page_origin).href);
  }
  return {
    verified: true,
    fixture_identity_sha256: plan.fixture_identity_sha256,
    canary_slugs: [...OPEN43_B689_TABVIEW_FIXTURE.canary_slugs],
    initial_phase: value.phase,
    geometry_checked: true,
    computed_styles_checked: true,
    resource_state_checked: true,
  };
}

const TAB_ANCHOR_SELECTOR = "#page-content .yui-navset > .yui-nav > li > a";

async function readSelectionState(page) {
  return await page.evaluate(() => {
    const view = document.querySelector("#page-content .yui-navset");
    const tabs = [...(view?.querySelector(":scope > .yui-nav")?.children ?? [])]
      .filter((item) => item.tagName === "LI");
    const panels = [...(view?.querySelector(":scope > .yui-content")?.children ?? [])];
    return {
      tabview_count: view === null ? 0 : 1,
      tab_count: tabs.length,
      selected_index: tabs.findIndex((tab) => tab.classList.contains("selected")),
      selected_title: tabs.find((tab) => tab.classList.contains("selected"))?.querySelector("a")?.getAttribute("title") ?? null,
      visible_panel_index: panels.findIndex((panel) => getComputedStyle(panel).display !== "none"),
    };
  });
}

async function readSelectionStateAfterNavigation(page, expectedUrl) {
  await page.waitForURL(expectedUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
      return await readSelectionState(page);
    } catch (error) {
      if (!/Execution context was destroyed|most likely because of a navigation/u.test(String(error?.message ?? error))) throw error;
      await page.waitForTimeout(50);
    }
  }
  throw new Error(`B689 navigation did not stabilize at ${expectedUrl}`);
}

async function activateTabForInteraction(page, index) {
  await page.evaluate(({ selector, targetIndex }) => {
    const anchor = document.querySelectorAll(selector)[targetIndex];
    if (!(anchor instanceof HTMLAnchorElement)) {
      throw new Error("B689 interaction target anchor is missing");
    }
    anchor.focus();
    anchor.click();
  }, { selector: TAB_ANCHOR_SELECTOR, targetIndex: index });
}

async function runInteractionSequence(page) {
  const anchors = await page.$$(TAB_ANCHOR_SELECTOR);
  if (anchors.length < 2) throw new Error("B689 interaction fixture needs at least two tabs");
  const initial = await readSelectionState(page);
  await activateTabForInteraction(page, 1);
  const focusedClickedAnchor = await page.evaluate((selector) => {
    const anchor = document.querySelectorAll(selector)[1];
    return anchor !== undefined && document.activeElement === anchor;
  }, TAB_ANCHOR_SELECTOR);
  const afterClick = { ...(await readSelectionState(page)), focused_clicked_anchor: focusedClickedAnchor };
  await anchors[0].focus();
  await anchors[0].press("Enter");
  const afterEnter = await readSelectionState(page);
  await anchors[0].press("ArrowRight");
  const afterArrowRight = await readSelectionState(page);
  await anchors[0].press("Space");
  const afterSpace = await readSelectionState(page);
  return Object.freeze({ initial, after_click: afterClick, after_enter: afterEnter, after_arrow_right: afterArrowRight, after_space: afterSpace });
}

export function b689NavigationRequestIsLocal(requestUrl, pageOrigin) {
  let request;
  let candidate;
  try {
    request = new URL(requestUrl);
    candidate = new URL(pageOrigin);
  } catch {
    return false;
  }
  if (["data:", "blob:", "about:"].includes(request.protocol)) return true;
  return request.protocol === candidate.protocol
    && request.port === candidate.port
    && (request.hostname.endsWith(".wikijump.localhost") || request.hostname.endsWith(".wjfiles.localhost"));
}

async function runNavigationLifecycle(page, awayUrl) {
  const anchors = await page.$$(TAB_ANCHOR_SELECTOR);
  if (anchors.length < 2) throw new Error("B689 navigation fixture needs at least two tabs");
  await activateTabForInteraction(page, 1);
  const selectedAfterClick = await readSelectionState(page);
  const originalUrl = page.url();
  const pageOrigin = new URL(originalUrl).origin;
  const lifecycleRoute = async (route) => b689NavigationRequestIsLocal(route.request().url(), pageOrigin)
    ? route.fallback()
    : route.abort("blockedbyclient");
  await page.route("**/*", lifecycleRoute);
  try {
    const away = await page.goto(awayUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const awayStatus = away?.status() ?? 0;
    const awayUrlAfter = page.url();
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
    const afterBack = await readSelectionStateAfterNavigation(page, originalUrl);
    const backUrl = page.url();
    await page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForURL(awayUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const forwardUrl = page.url();
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
    const afterSecondBack = await readSelectionStateAfterNavigation(page, originalUrl);
    return Object.freeze({
      selected_after_click: selectedAfterClick,
      away_navigation_status: awayStatus,
      away_url: awayUrlAfter,
      back_url: backUrl,
      after_back: afterBack,
      forward_url: forwardUrl,
      after_second_back: afterSecondBack,
    });
  } finally {
    await page.unroute("**/*", lifecycleRoute);
  }
}

function requireSettledResources(value, label) {
  const resource = requirePlainObject(value, `${label} resource completion`);
  if (
    resource.status !== "complete" ||
    resource.load_ready_state !== "complete" ||
    resource.font_status !== "loaded" ||
    resource.incomplete_image_count !== 0
  ) throw new Error(`${label} resources did not settle`);
  return resource;
}

function requireArtifacts(value, label) {
  const artifacts = requirePlainObject(value, `${label} artifacts`);
  const viewport = requirePlainObject(artifacts.settled_viewport, `${label} settled viewport artifact`);
  const fullPage = requirePlainObject(artifacts.full_page, `${label} full page artifact`);
  requireSha256(viewport.sha256, `${label} settled viewport SHA-256`);
  requireSha256(fullPage.sha256, `${label} full page SHA-256`);
  if (viewport.path === fullPage.path) throw new Error(`${label} reused one screenshot artifact`);
  return { viewport, fullPage };
}

function verifySettledPage(page) {
  if (
    page.navigation_status !== 200 ||
    page.input_url !== page.expected_url ||
    page.final_url !== page.expected_url ||
    page.http_error_count !== 0
  ) {
    throw new Error(`B689 settled browser page mismatched: ${page.slug}`);
  }
  requireSettledResources(page.resource_completion, `${page.slug} settled`);
  requireArtifacts(page.artifacts, `${page.slug} settled`);
  const oracle = OPEN43_B689_TABVIEW_LIVE_ORACLE.pages[page.slug];
  if (!oracle?.settled) throw new Error(`B689 page has no settled live oracle: ${page.slug}`);
  const observation = requirePlainObject(page.observation, `${page.slug} settled tabview observation`);
  if (observation.tabview_count !== oracle.tabview.count || !Array.isArray(observation.tabviews) || observation.tabviews.length !== oracle.tabview.count) {
    throw new Error(`B689 settled tabview is missing: ${page.slug}`);
  }
  for (const [index, tabview] of observation.tabviews.entries()) {
    if (
      tabview.tab_count < 1 ||
      tabview.tab_count !== tabview.panel_count ||
      tabview.selected_count !== 1 ||
      tabview.visible_panel_count !== 1 ||
      tabview.styles?.visibility !== "visible" ||
      tabview.id_present !== true ||
      tabview.class_name !== (oracle.settled.class_name ?? oracle.tabview.class_name) ||
      tabview.selected_title !== (oracle.settled.selected_title ?? oracle.tabview.selected_title) ||
      tabview.label_wrapper !== oracle.tabview.label_wrapper ||
      tabview.panel_ids_present !== oracle.tabview.panel_ids_present
    ) {
      throw new Error(`B689 settled tabview structure mismatched: ${page.slug} #${index}`);
    }
    if (page.slug === "theme:basalt") {
      compareRectangle(tabview.rectangle, oracle.settled.tabview_rectangle, `${page.slug} settled tabview #${index}`, ["x", "width", "height"]);
    } else {
      const rectangle = positiveRectangle(tabview.rectangle, `${page.slug} settled tabview #${index}`);
      if (Math.abs(rectangle.y - oracle.settled.tabview_y) > OPEN43_B689_TABVIEW_LIVE_ORACLE.thresholds_px.position) {
        throw new Error(`${page.slug} settled tabview y drift`);
      }
      // The retained SCP-8980 settled capture was taken under Chrome 150, while
      // the campaign browser and B690 sealed geometry reference use Chromium 149.
      // Absolute height differs between those browser generations even when the
      // current live page and candidate have identical DOM/CSS/font identity.
      // B690 owns browser-bound page geometry; B689 keeps the stable position,
      // DOM/style, panel identity, and interaction contract.
      if (tabview.first_panel_id !== oracle.settled.first_panel_id) {
        throw new Error(`${page.slug} settled first panel id mismatched`);
      }
    }
    if (oracle.tabview.styles !== undefined) compareStyles(tabview.styles, oracle.tabview.styles, `${page.slug} settled tabview #${index}`);
    if (oracle.nav_styles !== undefined) compareStyles(tabview.nav_styles, oracle.nav_styles, `${page.slug} settled nav`);
    if (oracle.content_styles !== undefined) compareStyles(tabview.content_styles, oracle.content_styles, `${page.slug} settled content`);
    if (oracle.panel_styles !== undefined) compareStyles(tabview.first_panel_styles, oracle.panel_styles, `${page.slug} settled first panel`);
  }
  if (page.slug === "scp-8980") {
    const interactions = requirePlainObject(page.interactions, "scp-8980 interaction observation");
    const requireSelected = (state, index, label) => {
      const value = requirePlainObject(state, label);
      if (value.tab_count < 2 || value.selected_index !== index || value.visible_panel_index !== index) {
        throw new Error(`B689 ${label} selected state mismatched`);
      }
    };
    requireSelected(interactions.initial, 0, "interaction initial");
    requireSelected(interactions.after_click, 1, "interaction after click");
    if (interactions.after_click.focused_clicked_anchor !== true) {
      throw new Error("B689 interaction click did not preserve focus on the clicked anchor");
    }
    // Wikidot's javascript:; tab anchors do not implement keyboard tab
    // activation: after the click, these keys leave the selected tab unchanged.
    requireSelected(interactions.after_enter, 1, "interaction after Enter");
    requireSelected(interactions.after_arrow_right, 1, "interaction after ArrowRight");
    requireSelected(interactions.after_space, 1, "interaction after Space");
  }
}

export function verifyOpen43B689TabviewSettled(observations, plan) {
  const value = requirePlainObject(observations, "B689_TABVIEW_SETTLED observations");
  if (
    value.fixture_identity_sha256 !== plan.fixture_identity_sha256 ||
    value.live_oracle_identity_sha256 !== plan.live_oracle_identity_sha256 ||
    value.phase !== "settled" ||
    value.sequence !== 2 ||
    !Array.isArray(value.pages) ||
    value.pages.length !== OPEN43_B689_TABVIEW_FIXTURE.canary_slugs.length
  ) {
    throw new Error("B689 settled tabview denominator or phase mismatched");
  }
  requireSha256(value.browser_environment.executable_sha256, "B689 browser executable SHA-256");
  const observedSlugs = value.pages.map((page) => page.slug);
  if (new Set(observedSlugs).size !== observedSlugs.length) throw new Error("B689 duplicate settled page rows");
  if (observedSlugs.some((slug) => !OPEN43_B689_TABVIEW_FIXTURE.canary_slugs.includes(slug))) throw new Error("B689 extra settled page row");
  const pages = new Map(value.pages.map((page) => [page.slug, page]));
  for (const slug of OPEN43_B689_TABVIEW_FIXTURE.canary_slugs) {
    const page = pages.get(slug);
    if (!page) throw new Error(`B689 settled page is missing: ${slug}`);
    verifySettledPage({ ...page, expected_url: new URL(`/${encodeURI(slug)}`, plan.page_origin).href });
  }
  return { verified: true, phase: value.phase, settled_pages: value.pages.length, interactions_checked: true, screenshots_checked: true };
}

export function verifyOpen43B689Scp8980Navigation(observations, plan) {
  const value = requirePlainObject(observations, "B689_SCP8980_AND_NAVIGATION_LIFECYCLE observations");
  if (
    value.fixture_identity_sha256 !== plan.fixture_identity_sha256 ||
    value.live_oracle_identity_sha256 !== plan.live_oracle_identity_sha256 ||
    value.phase !== "navigation_lifecycle" ||
    value.sequence !== 3
  ) {
    throw new Error("B689 navigation denominator or phase mismatched");
  }
  requireSha256(value.browser_environment.executable_sha256, "B689 browser executable SHA-256");
  const scp8980Url = new URL("/scp-8980", plan.page_origin).href;
  const basaltUrl = new URL("/theme%3Abasalt", plan.page_origin).href;
  const page = requirePlainObject(value.page, "scp-8980 navigation page");
  verifyPage(page, scp8980Url);
  const navigation = requirePlainObject(value.navigation, "scp-8980 navigation lifecycle");
  const requireState = (state, selectedIndex, label) => {
    const stateValue = requirePlainObject(state, label);
    if (stateValue.tabview_count !== 1 || stateValue.tab_count < 2 || stateValue.selected_index !== selectedIndex || stateValue.visible_panel_index !== selectedIndex) {
      throw new Error(`B689 ${label} navigation tab state mismatched`);
    }
  };
  requireState(navigation.selected_after_click, 1, "selected after click");
  if (navigation.away_navigation_status !== 200 || navigation.away_url !== basaltUrl) {
    throw new Error("B689 navigation away did not bind the other canary");
  }
  if (navigation.back_url !== scp8980Url) throw new Error("B689 back navigation did not return to SCP-8980");
  requireState(navigation.after_back, 0, "after back");
  if (navigation.forward_url !== basaltUrl) throw new Error("B689 forward navigation did not return to the other canary");
  requireState(navigation.after_second_back, 0, "after second back");
  return { verified: true, phase: value.phase, return_to_first_tab_proven: true, back_forward_proven: true };
}

function verifyCleanup(proof, resources) {
  const value = requirePlainObject(proof, "B689 cleanup proof");
  if (
    value.public_absence_verified !== true ||
    value.fixture_identity_sha256 !== FIXTURE_IDENTITY_SHA256 ||
    !Array.isArray(resources) ||
    resources.length !== 0
  ) {
    throw new Error("B689 cleanup did not prove unchanged public state");
  }
  return {
    public_absence_verified: true,
    public_state_unchanged: true,
    fixture_identity_sha256: FIXTURE_IDENTITY_SHA256,
  };
}

export function createOpen43B689TabviewCandidateCaseSet() {
  return Object.freeze({
    id: "open43-689-tabview",
    caseIds: OPEN43_B689_CASE_IDS,
    prepareRun({ candidateIdentity, privateInput, candidateBrowserContexts }) {
      const fixture = exactFixture(privateInput);
      const pageOrigin = candidateSitePageOrigin(candidateIdentity, "scp-wiki");
      return {
        sourceFiles: SOURCE_FILES,
        runtimeBindings: [],
        privateInputIdentity: {
          fixture_id: fixture.fixture_id,
          fixture_source_path: fixture.source_path,
          fixture_source_sha256: fixture.source_sha256,
          fixture_identity_sha256: FIXTURE_IDENTITY_SHA256,
          live_oracle_identity_sha256: LIVE_ORACLE_IDENTITY_SHA256,
        },
        browserCredentialPolicy: "none",
        plan: {
          schema: "wikijump.open43_b689_tabview_candidate_plan.v2",
          case_ids: [...OPEN43_B689_CASE_IDS],
          page_origin: pageOrigin,
          viewport: VIEWPORT,
          fixture,
          fixture_identity_sha256: FIXTURE_IDENTITY_SHA256,
          live_oracle_identity_sha256: LIVE_ORACLE_IDENTITY_SHA256,
          live_oracle_provenance: OPEN43_B689_TABVIEW_LIVE_ORACLE.provenance,
          geometry_thresholds_px: OPEN43_B689_TABVIEW_LIVE_ORACLE.thresholds_px,
          observation_phase: "domcontentloaded_immediate_observation",
        },
        async execute() {
          await candidateBrowserContexts.setActiveFixture(OPEN43_B689_TABVIEW_INITIAL_CASE_ID);
          const browser = await candidateBrowserContexts.newCandidateContext({ viewport: VIEWPORT });
          const attachErrors = (page) => {
            const consoleErrors = [];
            let requestFailureCount = 0;
            let httpErrorCount = 0;
            page.on("console", (message) => {
              if (message.type() === "error") consoleErrors.push(message.text());
            });
            page.on("pageerror", (error) => consoleErrors.push(error.message));
            page.on("requestfailed", () => { requestFailureCount += 1; });
            page.on("response", (response) => { if (response.status() >= 400) httpErrorCount += 1; });
            return { consoleErrors, counts: () => ({ console_error_count: consoleErrors.length, console_error_sha256: sha256Value(consoleErrors), request_failure_count: requestFailureCount, http_error_count: httpErrorCount }) };
          };
          const initialPages = [];
          const settledPages = [];
          for (const [index, canary] of CANARIES.entries()) {
            const slug = canary.slug;
            const url = new URL(`/${encodeURI(slug)}`, pageOrigin).href;
            const page = await browser.context.newPage();
            const errors = attachErrors(page);
            try {
              await candidateBrowserContexts.setActiveFixture(OPEN43_B689_TABVIEW_SETTLED_CASE_ID);
              const capture = await candidateBrowserContexts.captureCandidateObservation({
                context: browser.context,
                page,
                url,
                label: "b689-settled",
                index,
                contract: canary,
                viewport: VIEWPORT,
                timeoutMs: 30_000,
                settleMs: B689_SETTLE_MS,
                navigate: async ({ page: capturePage, url: captureUrl, timeoutMs }) => {
                  await installDomContentLoadedTabviewCapture(capturePage);
                  const response = await capturePage.goto(captureUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
                  const initialObservation = await readDomContentLoadedTabviewCapture(capturePage);
                  if (initialObservation === null) throw new Error(`B689 DOMContentLoaded observation was not captured: ${slug}`);
                  initialPages.push({
                    slug,
                    input_url: captureUrl,
                    final_url: capturePage.url(),
                    navigation_status: response?.status() ?? 0,
                    ...errors.counts(),
                    observation: initialObservation,
                  });
                  return response;
                },
              });
              const settledRow = {
                slug,
                input_url: capture.input_url,
                final_url: capture.final_url,
                navigation_status: capture.navigation_status,
                ...errors.counts(),
                resource_completion: capture.document?.resource_completion ?? null,
                artifacts: {
                  settled_viewport: { path: capture.settled_viewport_screenshot?.path ?? "", sha256: capture.settled_viewport_screenshot?.sha256 ?? null },
                  full_page: { path: capture.screenshot?.path ?? "", sha256: capture.screenshot?.sha256 ?? null },
                },
                observation: await observeTabviews(page),
              };
              if (slug === "scp-8980") {
                settledRow.interactions = await runInteractionSequence(page);
              }
              settledPages.push(settledRow);
            } finally {
              await page.close();
            }
          }
          const scp8980Url = new URL("/scp-8980", pageOrigin).href;
          const basaltUrl = new URL("/theme%3Abasalt", pageOrigin).href;
          const navigationPage = await browser.context.newPage();
          const navigationErrors = attachErrors(navigationPage);
          let navigationRow;
          try {
            const response = await navigationPage.goto(scp8980Url, { waitUntil: "domcontentloaded", timeout: 30_000 });
            navigationRow = {
              slug: "scp-8980",
              input_url: scp8980Url,
              final_url: navigationPage.url(),
              navigation_status: response?.status() ?? 0,
              ...navigationErrors.counts(),
              observation: await observeTabviews(navigationPage),
            };
            const navigation = await runNavigationLifecycle(navigationPage, basaltUrl);
            return [
              {
                case_id: OPEN43_B689_TABVIEW_INITIAL_CASE_ID,
                observations: {
                  fixture_identity_sha256: FIXTURE_IDENTITY_SHA256,
                  live_oracle_identity_sha256: LIVE_ORACLE_IDENTITY_SHA256,
                  phase: "domcontentloaded_immediate_observation",
                  sequence: 1,
                  browser_environment: browser.environment,
                  pages: initialPages,
                },
              },
              {
                case_id: OPEN43_B689_TABVIEW_SETTLED_CASE_ID,
                observations: {
                  fixture_identity_sha256: FIXTURE_IDENTITY_SHA256,
                  live_oracle_identity_sha256: LIVE_ORACLE_IDENTITY_SHA256,
                  phase: "settled",
                  sequence: 2,
                  browser_environment: browser.environment,
                  pages: settledPages,
                },
              },
              {
                case_id: OPEN43_B689_SCP8980_NAVIGATION_CASE_ID,
                observations: {
                  fixture_identity_sha256: FIXTURE_IDENTITY_SHA256,
                  live_oracle_identity_sha256: LIVE_ORACLE_IDENTITY_SHA256,
                  phase: "navigation_lifecycle",
                  sequence: 3,
                  browser_environment: browser.environment,
                  page: navigationRow,
                  navigation,
                },
              },
            ];
          } finally {
            await navigationPage.close();
          }
        },
        async cleanup() {
          return {
            public_absence_verified: true,
            fixture_identity_sha256: FIXTURE_IDENTITY_SHA256,
          };
        },
        verifyCase(caseId, observations) {
          if (caseId === OPEN43_B689_TABVIEW_INITIAL_CASE_ID) {
            return verifyOpen43B689TabviewInitial(observations, this.plan);
          }
          if (caseId === OPEN43_B689_TABVIEW_SETTLED_CASE_ID) {
            return verifyOpen43B689TabviewSettled(observations, this.plan);
          }
          if (caseId === OPEN43_B689_SCP8980_NAVIGATION_CASE_ID) {
            return verifyOpen43B689Scp8980Navigation(observations, this.plan);
          }
          throw new Error(`unknown B689 case: ${caseId}`);
        },
        verifyCleanup,
      };
    },
  });
}
