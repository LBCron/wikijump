const STANDALONE_SELECTOR = 'a.wiki-standalone-button[href="javascript:;"]';
const VIEWPORT = Object.freeze({ width: 1280, height: 900 });
const TIMEOUT_MS = 15_000;
const CLOSE_TIMEOUT_MS = 2_000;
const PROBE_KEY = "__open43Issue1041Lifecycle";
const CAPTURE_CONTRACT = Object.freeze({
  slug: "issue1041-lifecycle",
  theme_family: "candidate",
  presence_probes: Object.freeze([
    Object.freeze({
      id: "standalone-actions",
      selector: STANDALONE_SELECTOR,
      minimum_count: 5,
      require_rendered: true,
    }),
  ]),
});

function installLifecycleProbe() {
  const probeKey = "__open43Issue1041Lifecycle";
  const probeStorageKey = "__open43Issue1041LifecycleState";
  const standaloneSelector = 'a.wiki-standalone-button[href="javascript:;"]';
  const probe = { busy_events: [], print_pending: 0, print_resolvers: [] };
  try {
    const prior = JSON.parse(sessionStorage.getItem(probeStorageKey) ?? "null");
    if (Array.isArray(prior?.busy_events)) probe.busy_events = prior.busy_events;
  } catch {
  }
  const persist = () => {
    try {
      sessionStorage.setItem(probeStorageKey, JSON.stringify({ busy_events: probe.busy_events }));
    } catch {
    }
  };
  Object.defineProperty(window, probeKey, {
    configurable: false,
    value: {
      get busy_events() { return probe.busy_events; },
      get print_pending() { return probe.print_pending; },
      interceptPrint() {
        return new Promise((resolve) => {
          probe.print_pending += 1;
          probe.print_resolvers.push(resolve);
          persist();
        });
      },
      releasePrint() {
        while (probe.print_resolvers.length > 0) {
          probe.print_resolvers.shift()?.();
          probe.print_pending -= 1;
        }
        persist();
      },
    },
  });
  Object.defineProperty(window, "print", {
    configurable: true,
    value: () => window[probeKey].interceptPrint(),
  });
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type !== "attributes" || mutation.attributeName !== "aria-busy") continue;
      const element = mutation.target;
      if (element instanceof Element && element.matches(standaloneSelector)) {
        probe.busy_events.push({
          label: (element.textContent ?? "").trim(),
          busy: element.getAttribute("aria-busy") === "true",
        });
        persist();
      }
    }
  });
  observer.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ["aria-busy"],
  });
}

async function publicState(page) {
  return await page.evaluate(({ selector, key }) => {
    const controls = [...document.querySelectorAll(selector)];
    const active = document.activeElement;
    const actionArea = document.querySelector("#action-area");
    const probe = window[key];
    return {
      url: location.href,
      path: location.pathname,
      history_length: history.length,
      standalone_button_count: controls.length,
      editor_count: document.querySelectorAll("#editor").length,
      action_area_visible: actionArea !== null && !actionArea.classList.contains("hidden"),
      source_pane_visible: document.querySelectorAll("h1.page-source-header").length > 0,
      history_pane_visible: document.querySelectorAll("table.page-history").length > 0,
      error_popup_visible: document.querySelectorAll("#odialog-container").length > 0,
      focused_control: controls.length > 0 && active instanceof Element && active.matches(selector),
      any_aria_busy: controls.some((element) => element.getAttribute("aria-busy") === "true"),
      busy_events: [...(probe?.busy_events ?? [])].map((event) => ({ label: event.label, busy: event.busy })),
      print_pending: probe?.print_pending ?? 0,
      source_disclosure: document.body?.innerText.includes("[[button") === true,
    };
  }, { selector: STANDALONE_SELECTOR, key: PROBE_KEY });
}

export function isIssue1041PageDataResponse(response, pagePath) {
  if (response.request().method() !== "GET") return false;
  try {
    return new URL(response.url()).pathname === `${pagePath}/__data.json`;
  } catch {
    return false;
  }
}

export async function waitForIssue1041ActionPageStable(page, timeoutMs = TIMEOUT_MS) {
  await page.waitForFunction(
    async (selector) => {
      const ready = () =>
        document.querySelectorAll(selector).length === 5 &&
        document.querySelectorAll("#editor").length === 0 &&
        document.querySelectorAll("#page-options-bottom").length === 1;
      if (!ready()) return false;
      for (let index = 0; index < 3; index += 1) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        if (!ready()) return false;
      }
      return true;
    },
    STANDALONE_SELECTOR,
    { timeout: timeoutMs },
  );
}

export class Open43Issue1041LifecycleBrowserAdapter {
  #browserContexts;
  #pageOrigin;
  #storageState;
  #contexts = new Map();

  constructor({ browserContexts, pageOrigin, storageState }) {
    this.#browserContexts = browserContexts;
    this.#pageOrigin = pageOrigin;
    this.#storageState = storageState;
  }

  async #context(actor) {
    if (!this.#contexts.has(actor)) {
      this.#contexts.set(actor, (async () => {
        const owned = await this.#browserContexts.newCandidateContext({
          storageState: this.#storageState(actor),
          viewport: VIEWPORT,
        });
        await installIssue1041WdfilesRoute(owned.context);
        await owned.context.addInitScript(installLifecycleProbe);
        return owned.context;
      })());
    }
    return await this.#contexts.get(actor);
  }

  async #goto(context, pageUrl) {
    const page = await context.newPage();
    try {
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      await page.waitForFunction(
        (selector) => document.querySelectorAll(selector).length === 5,
        STANDALONE_SELECTOR,
        { timeout: TIMEOUT_MS },
      );
      return page;
    } catch (error) {
      await page.close({ runBeforeUnload: false, timeout: CLOSE_TIMEOUT_MS }).catch(() => undefined);
      throw error;
    }
  }

  #control(page, label) {
    return page.locator(STANDALONE_SELECTOR).filter({ hasText: label });
  }

  async #waitForResponse(page, predicate, label) {
    try {
      return await page.waitForResponse(predicate, { timeout: TIMEOUT_MS });
    } catch (error) {
      throw new Error(`issue 1041 ${label} response did not arrive before the deadline`, {
        cause: error,
      });
    }
  }

  async #activate(page, label, mode, { focused = false } = {}) {
    const control = this.#control(page, label);
    if (!focused) await control.focus();
    if (mode === "click") await control.click({ noWaitAfter: true });
    else if (mode === "enter") await control.press("Enter", { noWaitAfter: true });
    else if (mode === "double") {
      await page.evaluate(({ selector, label }) => {
        const element = [...document.querySelectorAll(selector)]
          .find((candidate) => (candidate.textContent ?? "").trim() === label);
        element?.click();
        element?.click();
      }, { selector: STANDALONE_SELECTOR, label });
    } else {
      throw new Error(`issue 1041 unsupported activation mode: ${mode}`);
    }
  }

  async #edit(context, pageUrl, pagePath, mode) {
    const page = await this.#goto(context, pageUrl);
    let mutationRequestCount = 0;
    const onRequest = (request) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) mutationRequestCount += 1;
    };
    page.on("request", onRequest);
    try {
      await this.#control(page, "Edit page here").focus();
      const before = await publicState(page);
      const permission = this.#waitForResponse(
        page,
        (response) => response.request().method() === "POST" && response.url().includes("?/editPermission"),
        `edit ${mode} permission`,
      );
      await this.#activate(page, "Edit page here", mode, { focused: true });
      const during = await publicState(page);
      await permission;
      await page.waitForURL(new URL(`${pagePath}/edit`, this.#pageOrigin).href, { timeout: TIMEOUT_MS });
      await page.locator("#editor").waitFor({ state: "visible", timeout: TIMEOUT_MS });
      const after = await publicState(page);
      return { before, during, after, mutation_request_count: mutationRequestCount };
    } finally {
      page.off("request", onRequest);
      await page.close({ runBeforeUnload: false, timeout: CLOSE_TIMEOUT_MS }).catch(() => undefined);
    }
  }

  async #backForward(context, pageUrl, pagePath) {
    const page = await this.#goto(context, pageUrl);
    try {
      await page.goto(new URL("/", this.#pageOrigin).href, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      const home = await page.evaluate(() => ({ path: location.pathname }));
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      const permission = this.#waitForResponse(
        page,
        (response) => response.request().method() === "POST" && response.url().includes("?/editPermission"),
        "back-forward edit permission",
      );
      await this.#activate(page, "Edit page here", "click");
      await permission;
      await page.waitForURL(new URL(`${pagePath}/edit`, this.#pageOrigin).href, { timeout: TIMEOUT_MS });
      const backDataResponse = this.#waitForResponse(
        page,
        (response) => isIssue1041PageDataResponse(response, pagePath),
        "back navigation page-data",
      );
      await page.goBack({ waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      const backData = await backDataResponse;
      if (backData.status() !== 200) throw new Error("issue 1041 back navigation page data failed");
      await waitForIssue1041ActionPageStable(page);
      const back = await publicState(page);
      await page.goForward({ waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      await page.locator("#editor").waitFor({ state: "visible", timeout: TIMEOUT_MS });
      const forward = await publicState(page);
      return { home, back, forward };
    } finally {
      await page.close({ runBeforeUnload: false, timeout: CLOSE_TIMEOUT_MS }).catch(() => undefined);
    }
  }

  async #pane(context, pageUrl, { label, kind }, mode) {
    const page = await this.#goto(context, pageUrl);
    let mutationRequestCount = 0;
    const onRequest = (request) => {
      if (request.method() === "POST" && !request.url().includes("?/history")) mutationRequestCount += 1;
    };
    page.on("request", onRequest);
    try {
      await this.#control(page, label).focus();
      const before = await publicState(page);
      await this.#activate(page, label, mode, { focused: true });
      if (kind === "history") {
        await page.locator("table.page-history").waitFor({ state: "visible", timeout: TIMEOUT_MS });
      } else {
        await page.locator("h1.page-source-header").waitFor({ state: "visible", timeout: TIMEOUT_MS });
      }
      const after = await publicState(page);
      return { before, after, mutation_request_count: mutationRequestCount };
    } finally {
      page.off("request", onRequest);
      await page.close({ runBeforeUnload: false, timeout: CLOSE_TIMEOUT_MS }).catch(() => undefined);
    }
  }

  async #print(context, pageUrl) {
    const page = await this.#goto(context, pageUrl);
    let mutationRequestCount = 0;
    const onRequest = (request) => {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) mutationRequestCount += 1;
    };
    page.on("request", onRequest);
    let popup = null;
    try {
      await this.#control(page, "Print this page").focus();
      const before = await publicState(page);
      const popupPromise = page.waitForEvent("popup", { timeout: TIMEOUT_MS });
      await this.#activate(page, "Print this page", "click", { focused: true });
      popup = await popupPromise;
      await popup.waitForLoadState("domcontentloaded", { timeout: TIMEOUT_MS });
      const popupState = await popup.evaluate(() => ({
        url: location.href,
        path: location.pathname,
        history_length: history.length,
      }));
      const during = await publicState(page);
      await this.#activate(page, "view source", "enter");
      await page.locator("h1.page-source-header").waitFor({ state: "visible", timeout: TIMEOUT_MS });
      const independent = await publicState(page);
      const after = await publicState(page);
      return {
        before,
        during,
        independent,
        after,
        popup: popupState,
        mutation_request_count: mutationRequestCount,
      };
    } finally {
      page.off("request", onRequest);
      await popup?.close({ runBeforeUnload: false, timeout: CLOSE_TIMEOUT_MS }).catch(() => undefined);
      await page.close({ runBeforeUnload: false, timeout: CLOSE_TIMEOUT_MS }).catch(() => undefined);
    }
  }

  async #setTags(context, pageUrl, mode, { expectError = false } = {}) {
    const page = await this.#goto(context, pageUrl);
    let mutationRequestCount = 0;
    let navigationCount = 0;
    const onRequest = (request) => {
      if (request.method() === "POST" && request.url().includes("?/legacySetTags")) mutationRequestCount += 1;
    };
    const onNavigation = () => {
      navigationCount += 1;
    };
    page.on("request", onRequest);
    page.on("framenavigated", onNavigation);
    try {
      await this.#control(page, "Apply tags").focus();
      const before = await publicState(page);
      if (expectError) {
        await this.#activate(page, "Apply tags", mode, { focused: true });
        await page.locator("#odialog-container").waitFor({ state: "visible", timeout: TIMEOUT_MS });
      } else {
        const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
        await this.#activate(page, "Apply tags", mode, { focused: true });
        await navigation;
        await page.waitForFunction(
          (selector) => {
            const controls = [...document.querySelectorAll(selector)];
            return controls.length === 5 && controls.every((element) => element.getAttribute("aria-busy") !== "true");
          },
          STANDALONE_SELECTOR,
          { timeout: TIMEOUT_MS },
        );
        await page.waitForFunction(
          () => document.querySelectorAll("#odialog-container").length === 0,
          null,
          { timeout: TIMEOUT_MS },
        );
      }
      const after = await publicState(page);
      return { before, after, mutation_request_count: mutationRequestCount, navigation_count: navigationCount };
    } finally {
      page.off("request", onRequest);
      page.off("framenavigated", onNavigation);
      await page.close({ runBeforeUnload: false, timeout: CLOSE_TIMEOUT_MS }).catch(() => undefined);
    }
  }

  async run({ pageUrl, pagePath }) {
    await this.#browserContexts.setActiveFixture("A1041_EXACT_BROWSER_LIFECYCLE");
    const editor = await this.#context("administrator");
    const page = await this.#goto(editor, pageUrl);
    let initial;
    try {
      const capture = await this.#browserContexts.captureCandidateObservation({
        context: editor,
        page,
        url: pageUrl,
        label: "A1041_EXACT_BROWSER_LIFECYCLE",
        index: 0,
        contract: CAPTURE_CONTRACT,
        viewport: VIEWPORT,
        timeoutMs: TIMEOUT_MS,
        settleMs: 0,
        onPhase: () => this.#browserContexts.setActiveFixture("A1041_EXACT_BROWSER_LIFECYCLE"),
      });
      initial = { capture, state: await publicState(page) };
    } finally {
      await page.close({ runBeforeUnload: false, timeout: CLOSE_TIMEOUT_MS }).catch(() => undefined);
    }
    const edit = {
      click: await this.#edit(editor, pageUrl, pagePath, "click"),
      keyboard: await this.#edit(editor, pageUrl, pagePath, "enter"),
      double: await this.#edit(editor, pageUrl, pagePath, "double"),
      back_forward: await this.#backForward(editor, pageUrl, pagePath),
    };
    const history = {
      click: await this.#pane(editor, pageUrl, { label: "history", kind: "history" }, "click"),
    };
    const source = {
      click: await this.#pane(editor, pageUrl, { label: "view source", kind: "source" }, "click"),
      keyboard: await this.#pane(editor, pageUrl, { label: "view source", kind: "source" }, "enter"),
    };
    const print = { hold: await this.#print(editor, pageUrl) };
    const setTags = {
      click: await this.#setTags(editor, pageUrl, "click"),
      keyboard: await this.#setTags(editor, pageUrl, "enter"),
      double: await this.#setTags(editor, pageUrl, "double"),
    };
    const nonEditor = await this.#context("non_admin");
    const setTagsError = {
      non_editable_member: await this.#setTags(nonEditor, pageUrl, "click", { expectError: true }),
    };
    return { initial, edit, history, source, print, set_tags: setTags, set_tags_error: setTagsError };
  }
}

export async function installIssue1041WdfilesRoute(context) {
  await context.route("https://*.wdfiles.com/**", (route) => {
    const resourceType = route.request().resourceType();
    if (["stylesheet", "font", "image"].includes(resourceType)) return route.abort();
    return route.fallback();
  });
}
