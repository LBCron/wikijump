import { CandidateHttpSession } from "./candidate-case-http.mjs";
import { STANDING_BROWSER_EXECUTION_MODULES } from "./standing-browser-execution-identity.mjs";
import { STANDING_BROWSER_CAPTURE_SCHEMA } from "./standing-browser-parity-contract.mjs";
import { candidatePageOrigin } from "./standing-browser-parity-receipt.mjs";
import {
  requirePlainObject,
  requireSha256,
  sha256Value,
} from "./standing-browser-parity-util.mjs";

export const OPEN43_AUTHORING_CASE_IDS = Object.freeze([
  "A1061_EXACT_PUBLIC_SLICE_CANDIDATE",
  "A1061_EXACT_POST_COMMIT_WORKER_CANDIDATE",
  "A1061_FIRST_RELOAD_INTERVALS",
]);

const SITE_SLUG = "scpaiueouiuiuiui";
const SITE_HOST = `${SITE_SLUG}.wikijump.localhost`;
const RED_CSS = "[[module CSS]]\n.authoring-color { color: red; }\n[[/module]]";
const BLUE_CSS = "[[module CSS]]\n.authoring-color { color: blue; }\n[[/module]]";
const RED_COMPUTED_COLOR = "rgb(255, 0, 0)";
const BLUE_COMPUTED_COLOR = "rgb(0, 0, 255)";
const BROWSER_FIXTURE_ID = "A1061_FIRST_RELOAD_INTERVALS";
const VIEWPORT = Object.freeze({ width: 1280, height: 900 });
const BROWSER_CONTRACT = Object.freeze({
  slug: "a1061-component-cascade",
  theme_family: "candidate",
  first_paint_geometry_selectors: ["#page-content", ".authoring-color"],
  geometry_selectors: ["#page-content", ".authoring-color"],
  presence_probes: [
    Object.freeze({ id: "page-content", selector: "#page-content", minimum_count: 1, require_rendered: true }),
    Object.freeze({ id: "authoring-color", selector: ".authoring-color", minimum_count: 1, require_rendered: true }),
  ],
});

function pageSlugs(runId) {
  const suffix = runId.slice("candidate-run-".length);
  return {
    component: `component:open43-authoring-${suffix}`,
    dependent: `open43-authoring-dependent-${suffix}`,
    unrelated: `open43-authoring-unrelated-${suffix}`,
  };
}

function styles(page, name) {
  if (!Array.isArray(page?.compiled_body_styles)) {
    throw new Error(`${name} public compiled styles are missing`);
  }
  return page.compiled_body_styles;
}

function foundArticle(value, name) {
  if (value?.page?.type !== "found" || value.page.data === null) {
    throw new Error(`${name} public article was not found`);
  }
  return value.page.data;
}

function hasStyle(stylesValue, color) {
  return stylesValue.some((style) => style.includes(`color: ${color}`));
}

async function browserStyle(page) {
  const observation = await page.evaluate(() => {
    const targets = [...document.querySelectorAll("#page-content .authoring-color")];
    const styleTexts = [...document.head.querySelectorAll("style")]
      .map((style) => style.textContent ?? "")
      .filter((text) => text.includes(".authoring-color"));
    return {
      element_count: targets.length,
      computed_color: targets.length === 1 ? getComputedStyle(targets[0]).color : null,
      style_texts: styleTexts,
    };
  });
  return {
    element_count: observation.element_count,
    computed_color: observation.computed_color,
    matching_style_count: observation.style_texts.length,
    style_texts_sha256: sha256Value(observation.style_texts),
  };
}

function browserUrl(origin, slug) {
  return new URL(`/${encodeURIComponent(slug)}`, origin).href;
}

class Open43AuthoringRun {
  #session;
  #browser;
  #resources;
  #slugs;
  #siteId = null;
  #ownedPages = [];

  constructor({ session, candidateBrowserContexts, resources, slugs }) {
    this.#session = session;
    this.#browser = candidateBrowserContexts;
    this.#resources = resources;
    this.#slugs = slugs;
  }

  async #rpc(method, params = {}, options = {}) {
    return await this.#session.rpc(method, params, {
      actor: options.actor ?? "editor",
      siteId: this.#siteId ?? undefined,
      page: options.page,
      cleanup: options.cleanup === true,
    });
  }

  async #page(slugOrId, { cleanup = false } = {}) {
    return await this.#rpc(
      "page_get",
      {
        site_id: this.#siteId,
        page: slugOrId,
        details: { compiled_html: true },
      },
      { cleanup, page: typeof slugOrId === "string" ? slugOrId : undefined },
    );
  }

  async #article(slug) {
    return foundArticle(
      await this.#rpc(
        "article_view",
        {
          site_id: this.#siteId,
          session_token: null,
          route: { slug, extra: "" },
          locales: ["en-US", "en"],
        },
        { actor: "anonymous", page: slug },
      ),
      `article_view ${slug}`,
    );
  }

  async #create(slug, title, wikitext) {
    const page = await this.#rpc("page_create", {
      site_id: this.#siteId,
      slug,
      title,
      alt_title: null,
      wikitext,
      layout: "wikidot",
      revision_comments: "Open43 authoring candidate fixture",
      user_id: this.#session.editorUserId,
      ip_address: "192.0.2.61",
      tags: [],
    });
    if (
      !Number.isSafeInteger(page?.page_id) ||
      !Number.isSafeInteger(page.revision_id) ||
      page.slug !== slug
    ) {
      throw new Error(`page_create did not return the ${slug} public identity`);
    }
    const resource = this.#resources.register("page", {
      page_id: page.page_id,
      revision_id: page.revision_id,
      slug,
    });
    this.#ownedPages.push({ page, resource });
    return page;
  }

  async execute() {
    const site = await this.#session.rpc("site_get", { site: SITE_SLUG });
    if (
      !Number.isSafeInteger(site?.site_id) ||
      site.slug !== SITE_SLUG
    ) {
      throw new Error(`editable candidate site ${SITE_SLUG} is missing`);
    }
    this.#siteId = site.site_id;

    for (const slug of Object.values(this.#slugs)) {
      if (await this.#page(slug) !== null) {
        throw new Error(`run-owned authoring page already exists: ${slug}`);
      }
    }

    const component = await this.#create(
      this.#slugs.component,
      "Open43 authoring component",
      RED_CSS,
    );
    const dependent = await this.#create(
      this.#slugs.dependent,
      "Open43 authoring dependent",
      `[[include ${this.#slugs.component}]]\n[[div class="authoring-color"]]\nCascade target\n[[/div]]`,
    );
    const unrelated = await this.#create(
      this.#slugs.unrelated,
      "Open43 authoring unrelated",
      "Unrelated body",
    );

    const beforeDependent = await this.#page(dependent.page_id);
    const beforeUnrelated = await this.#page(unrelated.page_id);
    const beforeArticle = await this.#article(this.#slugs.dependent);
    if (!hasStyle(styles(beforeDependent, "before dependent"), "red")) {
      throw new Error("dependent page did not publicly expose the initial red CSS");
    }

    await this.#browser.setActiveFixture(BROWSER_FIXTURE_ID);
    const ownedBrowser = await this.#browser.newCandidateContext({ viewport: VIEWPORT });
    const browserPage = await ownedBrowser.context.newPage();
    const url = browserUrl(this.#session.pageOrigin, this.#slugs.dependent);
    try {
      const initialNavigation = await browserPage.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      const beforeBrowser = {
        navigation_status: initialNavigation?.status() ?? 0,
        final_url: browserPage.url(),
        style: await browserStyle(browserPage),
      };
      await browserPage.evaluate(() => window.stop());

      const editedComponent = await this.#rpc("page_edit", {
        site_id: this.#siteId,
        page: component.page_id,
        last_revision_id: component.revision_id,
        revision_comments: "Open43 authoring component blue revision",
        user_id: this.#session.editorUserId,
        wikitext: BLUE_CSS,
        ip_address: "192.0.2.61",
      });
      if (
        !Number.isSafeInteger(editedComponent?.revision_id) ||
        editedComponent.revision_id === component.revision_id
      ) {
        throw new Error("component page_edit did not return a new public revision");
      }

      let firstBrowserStyle = null;
      const capture = await this.#browser.captureCandidateObservation({
        context: ownedBrowser.context,
        page: browserPage,
        url,
        label: "A1061_FIRST_RELOAD_INTERVALS",
        index: 0,
        contract: BROWSER_CONTRACT,
        viewport: VIEWPORT,
        timeoutMs: 30_000,
        settleMs: 0,
        resetSuppliedPage: false,
        navigate: async ({ page, timeoutMs }) => {
          const response = await page.reload({
            waitUntil: "domcontentloaded",
            timeout: timeoutMs,
          });
          firstBrowserStyle = await browserStyle(page);
          return response;
        },
      });
      const settledBrowserStyle = await browserStyle(browserPage);
      const firstArticle = await this.#article(this.#slugs.dependent);
      const articleTransition = await this.#waitForBlueArticle(firstArticle);
      const afterDependent = await this.#page(dependent.page_id);
      const afterUnrelated = await this.#page(unrelated.page_id);
      const publicSlice = {
        before: {
          dependent: beforeDependent,
          unrelated: beforeUnrelated,
          article: beforeArticle,
        },
        after_component_edit: {
          first_article: firstArticle,
          settled_article: articleTransition.article,
          dependent: afterDependent,
          unrelated: afterUnrelated,
        },
      };
      const worker = {
        component: {
          page_id: component.page_id,
          before_revision_id: component.revision_id,
          after_revision_id: editedComponent.revision_id,
        },
        dependent: {
          page_id: dependent.page_id,
          revision_id: dependent.revision_id,
          first_article: firstArticle,
          settled_article: articleTransition.article,
          bounded_read_count: articleTransition.readCount,
        },
      };
      const browser = {
        url,
        navigation: "normal-reload",
        cache_bypass: false,
        article_edit: false,
        before: beforeBrowser,
        capture,
        first_reload_style: firstBrowserStyle,
        settled_style: settledBrowserStyle,
      };
      return [
        { case_id: "A1061_EXACT_PUBLIC_SLICE_CANDIDATE", observations: publicSlice },
        { case_id: "A1061_EXACT_POST_COMMIT_WORKER_CANDIDATE", observations: worker },
        { case_id: "A1061_FIRST_RELOAD_INTERVALS", observations: browser },
      ];
    } finally {
      await browserPage.close({ runBeforeUnload: false, timeout: 10_000 }).catch(() => undefined);
    }
  }

  async #waitForBlueArticle(firstArticle) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const article = attempt === 0
        ? firstArticle
        : await this.#article(this.#slugs.dependent);
      if (hasStyle(styles(article, "settled dependent article"), "blue")) {
        return { article, readCount: attempt + 1 };
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error("dependent article did not expose blue CSS after the component edit");
  }

  async cleanup() {
    const failures = [];
    for (const { page } of [...this.#ownedPages].reverse()) {
      try {
        const current = await this.#page(page.slug, { cleanup: true });
        if (current === null) continue;
        if (current.page_id !== page.page_id) {
          throw new Error(`cleanup page identity drifted for ${page.slug}`);
        }
        await this.#rpc(
          "page_delete",
          {
            site_id: this.#siteId,
            page: current.page_id,
            last_revision_id: current.revision_id,
            revision_comments: "Open43 authoring candidate cleanup",
            user_id: this.#session.editorUserId,
            ip_address: "192.0.2.61",
          },
          { cleanup: true },
        );
      } catch (error) {
        failures.push(error);
      }
    }

    const absent = [];
    for (const { page, resource } of this.#ownedPages) {
      try {
        const current = await this.#page(page.slug, { cleanup: true });
        if (current !== null) throw new Error(`cleanup left ${page.slug} publicly present`);
        this.#resources.release(resource, { page_get: null });
        absent.push(page.slug);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "authoring public cleanup failed");
    return { page_get: null, absent_pages: absent };
  }
}

function requireOnlyColor(stylesValue, color, name) {
  if (!hasStyle(stylesValue, color) || hasStyle(stylesValue, color === "blue" ? "red" : "blue")) {
    throw new Error(`${name} did not expose only ${color} CSS`);
  }
}

function verifyPublicSlice(observations) {
  const before = observations.before;
  const after = observations.after_component_edit;
  const beforeDependentStyles = styles(before.dependent, "before dependent");
  const beforeArticleStyles = styles(before.article, "before dependent article");
  const firstStyles = styles(after.first_article, "first dependent article");
  const settledStyles = styles(after.settled_article, "settled dependent article");
  const afterDependentStyles = styles(after.dependent, "after dependent page");
  styles(after.unrelated, "after unrelated");
  requireOnlyColor(beforeDependentStyles, "red", "initial dependent page");
  requireOnlyColor(beforeArticleStyles, "red", "initial dependent article");
  requireOnlyColor(afterDependentStyles, "blue", "dependent page after component save");
  requireOnlyColor(firstStyles, "blue", "first dependent article after component save");
  requireOnlyColor(settledStyles, "blue", "settled dependent article");
  if (
    after.dependent.revision_id !== before.dependent.revision_id ||
    after.unrelated.revision_id !== before.unrelated.revision_id ||
    sha256Value(after.unrelated.compiled_body_styles) !== sha256Value(before.unrelated.compiled_body_styles) ||
    after.unrelated.compiled_at !== before.unrelated.compiled_at
  ) {
    throw new Error("component save changed the unrelated or dependent page revision identity");
  }
  return {
    verified: true,
    initial_red: true,
    first_read_blue: true,
    settled_blue: true,
    first_article_styles_sha256: sha256Value(firstStyles),
    settled_article_styles_sha256: sha256Value(settledStyles),
    unrelated_styles_unchanged: true,
    unrelated_compiled_at_unchanged: true,
  };
}

function verifyWorker(observations) {
  const component = requirePlainObject(observations.component, "component worker transition");
  const dependent = requirePlainObject(observations.dependent, "dependent worker transition");
  if (
    !Number.isSafeInteger(component.page_id) ||
    !Number.isSafeInteger(component.before_revision_id) ||
    !Number.isSafeInteger(component.after_revision_id) ||
    component.after_revision_id === component.before_revision_id ||
    !Number.isSafeInteger(dependent.page_id) ||
    !Number.isSafeInteger(dependent.revision_id) ||
    !Number.isSafeInteger(dependent.bounded_read_count) ||
    dependent.bounded_read_count < 1 ||
    dependent.bounded_read_count > 40
  ) {
    throw new Error("post-commit worker candidate identity or bounded transition is invalid");
  }
  requireOnlyColor(styles(dependent.first_article, "first worker article"), "blue", "first worker article");
  requireOnlyColor(styles(dependent.settled_article, "settled worker article"), "blue", "settled worker article");
  return {
    verified: true,
    component_revision_transition: true,
    first_public_read_blue: true,
    bounded_read_count: dependent.bounded_read_count,
  };
}

function requireBrowserStyle(value, color, name) {
  const style = requirePlainObject(value, name);
  if (
    style.element_count !== 1 ||
    style.matching_style_count !== 1 ||
    style.computed_color !== color
  ) {
    throw new Error(`${name} did not expose the exact computed color`);
  }
  requireSha256(style.style_texts_sha256, `${name} style text SHA-256`);
  return style;
}

function requireScreenshot(value, name) {
  const screenshot = requirePlainObject(value, name);
  if (typeof screenshot.path !== "string" || screenshot.path.length === 0) {
    throw new Error(`${name} path is missing`);
  }
  requireSha256(screenshot.sha256, `${name} SHA-256`);
  return screenshot;
}

function candidateOwnedBrowserFailure(failure) {
  if (failure?.kind !== "request_failed") return true;
  let url;
  try { url = new URL(failure.url); } catch { return true; }
  return !["http:", "https:"].includes(url.protocol) || url.hostname.endsWith(".wikijump.localhost");
}

function verifyBrowser(observations) {
  const value = requirePlainObject(observations, "first reload browser observations");
  const before = requirePlainObject(value.before, "pre-edit browser observation");
  const capture = requirePlainObject(value.capture, "first reload browser capture");
  if (
    value.navigation !== "normal-reload" ||
    value.cache_bypass !== false ||
    value.article_edit !== false ||
    before.navigation_status !== 200 ||
    before.final_url !== value.url ||
    capture.schema !== STANDING_BROWSER_CAPTURE_SCHEMA ||
    capture.input_url !== value.url ||
    capture.final_url !== value.url ||
    capture.navigation_status !== 200 ||
    Object.hasOwn(capture, "capture_error") ||
    capture.first_paint?.document?.phase !== "domcontentloaded_immediate_observation" ||
    capture.document?.phase !== "settled" ||
    capture.document?.resource_completion?.status !== "complete" ||
    !Array.isArray(capture.failures) ||
    capture.failures.some(candidateOwnedBrowserFailure) ||
    !Array.isArray(capture.request_gate_aborts) ||
    capture.request_gate_aborts.length !== 0
  ) {
    throw new Error("first reload did not produce one clean exact candidate interval");
  }
  requireBrowserStyle(before.style, RED_COMPUTED_COLOR, "pre-edit browser style");
  requireBrowserStyle(value.first_reload_style, BLUE_COMPUTED_COLOR, "first normal reload style");
  requireBrowserStyle(value.settled_style, BLUE_COMPUTED_COLOR, "settled reload style");
  const screenshots = [
    requireScreenshot(capture.first_paint?.screenshot, "first reload screenshot"),
    requireScreenshot(capture.settled_viewport_screenshot, "settled viewport screenshot"),
    requireScreenshot(capture.screenshot, "settled full-page screenshot"),
  ];
  if (new Set(screenshots.map(({ path }) => path)).size !== screenshots.length) {
    throw new Error("first reload browser capture reused a screenshot artifact");
  }
  return {
    verified: true,
    navigation: value.navigation,
    cache_bypass: value.cache_bypass,
    initial_computed_color: value.first_reload_style.computed_color,
    settled_computed_color: value.settled_style.computed_color,
    external_request_failures: capture.failures.length,
  };
}

function verifyCase(caseId, observations) {
  if (caseId === "A1061_EXACT_PUBLIC_SLICE_CANDIDATE") return verifyPublicSlice(observations);
  if (caseId === "A1061_EXACT_POST_COMMIT_WORKER_CANDIDATE") return verifyWorker(observations);
  if (caseId === "A1061_FIRST_RELOAD_INTERVALS") return verifyBrowser(observations);
  throw new Error(`unsupported Open43 authoring case: ${caseId}`);
}

function verifyCleanup(proof, resources) {
  if (
    proof?.page_get !== null ||
    !Array.isArray(proof?.absent_pages) ||
    proof.absent_pages.length !== 3 ||
    !Array.isArray(resources) ||
    resources.some((resource) => resource.released !== true)
  ) {
    throw new Error("authoring cleanup did not prove all run-owned pages absent");
  }
  return {
    public_absence_verified: true,
    page_count: proof.absent_pages.length,
  };
}

export function createOpen43AuthoringCandidateCaseSet({
  sessionFactory = (options) => new CandidateHttpSession(options),
} = {}) {
  const sourceFiles = Object.freeze([...new Set([
    ...STANDING_BROWSER_EXECUTION_MODULES,
    "deepwell/Cargo.lock",
    "deepwell/src/api.rs",
    "deepwell/src/services/context.rs",
    "deepwell/src/services/outdate.rs",
    "deepwell/src/services/page_revision/service.rs",
    "deepwell/tests/job_queue.rs",
    "deepwell/tests/page.rs",
    "docs/development/open43-a-authoring-closure-audit.json",
    "docs/wikidot-specifications/specifications/module/module-css.md",
    "install/local/wikidot-verification/scripts/run-candidate-cases.mjs",
    "install/local/wikidot-verification/src/candidate-case-command.mjs",
    "install/local/wikidot-verification/src/candidate-browser-contexts.mjs",
    "install/local/wikidot-verification/src/candidate-case-http.mjs",
    "install/local/wikidot-verification/src/candidate-case-runner.mjs",
    "install/local/wikidot-verification/src/deepwell-rpc-auth.mjs",
    "install/local/wikidot-verification/src/open43-authoring-candidate-case-set.mjs",
    "install/local/wikidot-verification/package.json",
    "install/local/wikidot-verification/pnpm-lock.yaml",
  ])]);
  return Object.freeze({
    id: "open43-authoring",
    caseIds: OPEN43_AUTHORING_CASE_IDS,
    prepareRun({ runId, candidateIdentity, privateInput, signal, resources, candidateBrowserContexts }) {
      if (
        candidateIdentity.candidate.endpoint.host !== SITE_HOST ||
        candidateIdentity.candidate.endpoint.port === 443 ||
        candidateIdentity.candidate.port_443_published !== false
      ) {
        throw new Error(`Open43 authoring cases require the exact non-standing ${SITE_HOST} candidate`);
      }
      const session = sessionFactory({ candidateIdentity, privateInput, signal });
      if (session?.editorUserId !== -1) {
        throw new Error("authoring candidate session must bind the fixed editor actor");
      }
      if (session.pageOrigin !== candidatePageOrigin(candidateIdentity)) {
        throw new Error("authoring candidate session did not bind the sealed candidate origin");
      }
      const execution = new Open43AuthoringRun({
        session,
        candidateBrowserContexts,
        resources,
        slugs: pageSlugs(runId),
      });
      return Object.freeze({
        sourceFiles,
        runtimeBindings: session.requiredServiceBindings,
        privateInputIdentity: session.privateInputIdentity,
        browserCredentialPolicy: "none",
        plan: {
          schema: "wikijump.open43_authoring_candidate_plan.v1",
          site_slug: SITE_SLUG,
          page_slugs: pageSlugs(runId),
          editor_user_id: -1,
          case_ids: OPEN43_AUTHORING_CASE_IDS,
          public_behavior: "component CSS save updates the first normal dependent reload and public read without changing the unrelated page",
          browser: {
            navigation: "normal-reload",
            cache_bypass: false,
            article_edit: false,
            viewport: VIEWPORT,
            intervals: ["domcontentloaded_immediate_observation", "settled"],
          },
          excluded_claims: [
            "A1061_PRIVATE_DENIED_CROSS_SITE_MATRIX",
            "A1061_PAGE_LOCAL_CACHE_IDENTITY",
            "A1061_EXACT_CYCLE_CASCADE_SEMANTICS",
          ],
        },
        execute: () => execution.execute(),
        cleanup: () => execution.cleanup(),
        verifyCase,
        verifyCleanup,
      });
    },
  });
}
