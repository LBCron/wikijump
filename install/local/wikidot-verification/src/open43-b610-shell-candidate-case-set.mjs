import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  OPEN43_B610_SHELL_CASE_IDS,
  verifyOpen43B610ShellCase,
  verifyOpen43B610ShellCleanup,
} from "./open43-b610-shell-candidate-contract.mjs";
import {
  DEFAULT_SETTLE_MS,
  PAGE_CHROME_SKELETON,
  canaryForUrl,
} from "./standing-browser-canaries.mjs";
import { STANDING_BROWSER_EXECUTION_MODULES } from "./standing-browser-execution-identity.mjs";
import { candidateSitePageOrigin } from "./standing-browser-parity-receipt.mjs";
import { requestCandidateCaseHttp } from "./candidate-case-http.mjs";
import {
  readJsonObject,
  sha256File,
  sha256Value,
} from "./standing-browser-parity-util.mjs";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const FIXTURE_PATH = "docs/development/open43-s-browser-case-manifest.json";
const SITE_SLUG = "scp-wiki";
const PAGE_SLUG = "scp-9506";
const SITE_HOST = `${SITE_SLUG}.wikijump.localhost`;
const FIXTURE_ID = "B610_CURRENT_LIVE_CHROME";
const INITIAL_FIXTURE_ID = "B610_CHROME_INITIAL";
const SETTLED_FIXTURE_ID = "B610_CHROME_SETTLED";
const VIEWPORT = Object.freeze({ width: 1280, height: 900 });
const EXPECTED_HEADER_DIRECT_CHILD_IDS = Object.freeze([
  "search-top-box",
  "top-bar",
  "login-status",
  "header-extra-div-1",
  "header-extra-div-2",
  "header-extra-div-3",
]);
const EXPECTED_CONTAINER_EXTENSION_IDS = Object.freeze([
  "extrac-div-1",
  "extrac-div-2",
  "extrac-div-3",
]);

const SOURCE_FILES = Object.freeze([...new Set([
  ...STANDING_BROWSER_EXECUTION_MODULES,
  "install/local/wikidot-verification/scripts/run-candidate-cases.mjs",
  "install/local/wikidot-verification/src/candidate-case-command.mjs",
  "install/local/wikidot-verification/src/candidate-case-runner.mjs",
  "install/local/wikidot-verification/src/candidate-browser-contexts.mjs",
  "install/local/wikidot-verification/src/open43-b610-shell-candidate-case-set.mjs",
  "install/local/wikidot-verification/src/open43-b610-shell-candidate-contract.mjs",
  FIXTURE_PATH,
  "install/local/wikidot-verification/package.json",
  "install/local/wikidot-verification/pnpm-lock.yaml",
])]);

function liveFixture(manifest) {
  const fixture = manifest.live_corrections?.find(({ case_id }) => case_id === FIXTURE_ID);
  if (!fixture) throw new Error(`B610 fixture is missing ${FIXTURE_ID}`);
  if (
    fixture.url !== "https://scp-wiki.wikidot.com/scp-9506" ||
    JSON.stringify(fixture.header_direct_child_ids) !== JSON.stringify(EXPECTED_HEADER_DIRECT_CHILD_IDS) ||
    JSON.stringify(fixture.container_extension_ids) !== JSON.stringify(EXPECTED_CONTAINER_EXTENSION_IDS) ||
    fixture.sidebar_close_href_double_hash_count !== 1
  ) throw new Error("B610 fixture does not contain the fixed live shell evidence");
  return fixture;
}

function shellContract(fixture) {
  return Object.freeze({
    header_direct_child_ids: fixture.header_direct_child_ids,
    header_extension_ids: fixture.header_direct_child_ids.filter((id) => id.startsWith("header-extra-div-")),
    container_extension_ids: fixture.container_extension_ids,
    sidebar_close_href_double_hash_count: fixture.sidebar_close_href_double_hash_count,
    favicon_route_prefix: "/local--favicon/",
    favicon_route_status: 302,
  });
}

function browserContract(canary) {
  return Object.freeze({
    slug: canary.slug,
    theme_family: canary.theme_family,
    geometry_selectors: Object.freeze(["#header", "#side-bar"]),
    first_paint_geometry_selectors: Object.freeze(["#header"]),
    presence_probes: Object.freeze([
      Object.freeze({ id: "header", selector: "#header", minimum_count: 1, require_rendered: false }),
      Object.freeze({ id: "side_bar", selector: "#side-bar", minimum_count: 1, require_rendered: false }),
    ]),
    page_chrome_skeleton: PAGE_CHROME_SKELETON,
  });
}

function requiredRuntimeBindings(privateInput) {
  if (!Array.isArray(privateInput.runtime_bindings) || privateInput.runtime_bindings.length === 0) {
    throw new Error("B610 private input must contain required runtime bindings");
  }
  const roles = new Set(privateInput.runtime_bindings.map((binding) => binding?.role));
  for (const role of ["caddy", "deepwell", "files"]) {
    if (!roles.has(role)) throw new Error(`B610 runtime bindings are missing ${role}`);
  }
  return privateInput.runtime_bindings;
}

async function observeShell(page, faviconRoutePrefix) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.evaluate(async (prefix) => {
    const header = document.querySelector("#header");
    const headerDirectChildIds = header === null
      ? []
      : [...header.children].map((element) => element.id).filter(Boolean);
    const headerExtensionIds = headerDirectChildIds.filter((id) => id.startsWith("header-extra-div-"));
    const containerExtensionIds = ["extrac-div-1", "extrac-div-2", "extrac-div-3"]
      .filter((id) => document.getElementById(id) !== null);
    const sidebarCloseHrefs = [...document.querySelectorAll("#side-bar a")]
      .map((anchor) => anchor.getAttribute("href"))
      .filter((href) => href === "##");
    const icon = [...document.querySelectorAll("link[rel~='icon']")]
      .find((link) => !link.getAttribute("href")?.startsWith("data:"));
    let favicon = {
      declaration_count: document.querySelectorAll("link[rel~='icon']").length,
      declared_href: icon?.getAttribute("href") ?? null,
      href_path: "",
      href_search: "",
      href_hash: "",
      route_request_path: "",
      route_status: 0,
      route_location: "",
    };
    if (icon !== undefined) {
      const href = new URL(icon.href, location.href);
      const response = await fetch(href.href, { method: "HEAD", redirect: "manual" });
      favicon = {
        declaration_count: favicon.declaration_count,
        declared_href: favicon.declared_href,
        href_path: href.pathname,
        href_search: href.search,
        href_hash: href.hash,
        route_request_path: href.pathname,
        route_status: response.status,
        route_location: response.headers.get("location") ?? "",
      };
    }
    return {
      header_direct_child_ids: headerDirectChildIds,
      header_extension_ids: headerExtensionIds,
      container_extension_ids: containerExtensionIds,
      sidebar_close_href_count: sidebarCloseHrefs.length,
      sidebar_close_hrefs: sidebarCloseHrefs,
      search_top_box_count: document.querySelectorAll("#search-top-box").length,
      search_form_count: document.querySelectorAll("#search-top-box-form").length,
      search_form_class: document.querySelector("#search-top-box-form")?.getAttribute("class") ?? null,
      search_query_input_count: document.querySelectorAll("#search-top-box-input").length,
      search_query_input_class: document.querySelector("#search-top-box-input")?.getAttribute("class") ?? null,
      search_submit_count: document.querySelectorAll("#search-top-box input[name='search']").length,
      search_submit_class: document.querySelector("#search-top-box input[name='search']")?.getAttribute("class") ?? null,
      favicon,
      favicon_route_prefix: prefix,
    };
      }, faviconRoutePrefix);
    } catch (error) {
      if (attempt === 2 || !/Execution context was destroyed|Cannot find context with specified id/iu.test(error?.message ?? "")) throw error;
      await page.waitForLoadState("domcontentloaded", { timeout: 30_000 });
    }
  }
  throw new Error("B610 shell observation did not reach a stable document");
}

export function createOpen43B610ShellCandidateCaseSet() {
  return Object.freeze({
    id: "open43-b610-shell",
    caseIds: OPEN43_B610_SHELL_CASE_IDS,
    async prepareRun({ candidateIdentity, privateInput, privateInputSha256, candidateBrowserContexts }) {
      if (
        candidateIdentity.candidate.endpoint.port === 443 ||
        candidateIdentity.candidate.port_443_published !== false
      ) throw new Error(`B610 shell case requires exact non-standing ${SITE_HOST}`);
      const pageOrigin = candidateSitePageOrigin(candidateIdentity, SITE_SLUG);
      if (
        privateInput.fixture_id !== FIXTURE_ID ||
        privateInput.site_slug !== SITE_SLUG ||
        privateInput.page_slug !== PAGE_SLUG
      ) throw new Error("B610 private input must select the fixed SCP-9506 fixture");
      const runtimeBindings = requiredRuntimeBindings(privateInput);
      const pageUrl = new URL(`/${PAGE_SLUG}`, pageOrigin).href;
      const canary = canaryForUrl(pageUrl);
      if (canary === null || canary.slug !== PAGE_SLUG) throw new Error("B610 page is not an existing browser canary");
      const fixturePath = path.join(REPOSITORY_ROOT, FIXTURE_PATH);
      const fixture = liveFixture(await readJsonObject(fixturePath, "B610 browser case manifest"));
      const fixtureSha256 = await sha256File(fixturePath);
      const plan = {
        schema: "wikijump.open43_b610_shell_candidate_plan.v1",
        fixture_id: FIXTURE_ID,
        fixture_manifest_path: FIXTURE_PATH,
        site_slug: SITE_SLUG,
        page_slug: PAGE_SLUG,
        page_url: pageUrl,
        expected: shellContract(fixture),
        browser: {
          canary_slug: canary.slug,
          theme_family: canary.theme_family,
          viewport: VIEWPORT,
          settle_ms: DEFAULT_SETTLE_MS,
          initial_fixture_id: INITIAL_FIXTURE_ID,
          settled_fixture_id: SETTLED_FIXTURE_ID,
        },
      };
      const execute = async () => {
        await candidateBrowserContexts.setActiveFixture(INITIAL_FIXTURE_ID);
        const { context, environment } = await candidateBrowserContexts.newCandidateContext({ viewport: VIEWPORT });
        const page = await context.newPage();
        try {
          const capture = await candidateBrowserContexts.captureCandidateObservation({
            context,
            page,
            url: pageUrl,
            label: "B610_SHELL",
            index: 0,
            contract: browserContract(canary),
            viewport: VIEWPORT,
            timeoutMs: 30_000,
            settleMs: DEFAULT_SETTLE_MS,
            onPhase: async (phase) => candidateBrowserContexts.setActiveFixture(
              phase === "settled" ? SETTLED_FIXTURE_ID : INITIAL_FIXTURE_ID,
            ),
          });
          capture.settled_interval = {
            policy: "standing-browser-canary",
            settle_ms: DEFAULT_SETTLE_MS,
            resource_completion_status: capture.document?.resource_completion?.status ?? null,
            initial_phase: capture.first_paint?.document?.phase ?? null,
            settled_phase: capture.document?.phase ?? null,
          };
          const shell = await observeShell(page, plan.expected.favicon_route_prefix);
          if (shell.favicon.declared_href !== null) {
            const faviconUrl = new URL(shell.favicon.declared_href, pageUrl);
            const response = await requestCandidateCaseHttp({
              url: faviconUrl,
              method: "HEAD",
              connectAddress: candidateIdentity.candidate.endpoint.local_connect_address,
              tlsCa: privateInput.tls_ca_pem,
            });
            shell.favicon.route_request_path = faviconUrl.pathname;
            shell.favicon.route_status = response.status;
            shell.favicon.route_location = response.headers.location ?? "";
          }
          return [{
            case_id: OPEN43_B610_SHELL_CASE_IDS[0],
            observations: {
              fixture_id: FIXTURE_ID,
              fixture_sha256: fixtureSha256,
              page_url: pageUrl,
              browser_environment: environment,
              browser_environment_sha256: sha256Value(environment),
              capture,
              shell,
            },
          }];
        } finally {
          await page.close({ runBeforeUnload: false, timeout: 10_000 }).catch(() => undefined);
        }
      };
      return {
        sourceFiles: SOURCE_FILES,
        runtimeBindings,
        privateInputIdentity: {
          fixture_id: FIXTURE_ID,
          site_slug: SITE_SLUG,
          page_slug: PAGE_SLUG,
          runtime_bindings_sha256: sha256Value(runtimeBindings),
          private_input_sha256: privateInputSha256,
        },
        plan: {
          ...plan,
          fixture_manifest_sha256: fixtureSha256,
        },
        browserCredentialPolicy: "none",
        execute,
        cleanup: async () => ({ public_absence_verified: true, run_owned_resource_count: 0 }),
        verifyCase: (caseId, observations) => verifyOpen43B610ShellCase(caseId, observations, {
          ...plan,
          fixture_sha256: fixtureSha256,
        }),
        verifyCleanup: verifyOpen43B610ShellCleanup,
      };
    },
  });
}
