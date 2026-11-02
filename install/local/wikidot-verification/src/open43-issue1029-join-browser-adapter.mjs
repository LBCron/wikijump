const JOIN_SELECTOR = 'div > a[href="javascript:;"][onclick="WIKIDOT.page.listeners.join(event, \'unified\')"]';
const VIEWPORT = Object.freeze({ width: 1280, height: 900 });
const TIMEOUT_MS = 30_000;
const PROBE_KEY = "__open43Issue1029Join";
const PROBE_STORAGE_KEY = "__open43Issue1029JoinState";
const CAPTURE_CONTRACT = Object.freeze({
  slug: "issue1029-join",
  theme_family: "candidate",
  presence_probes: Object.freeze([
    Object.freeze({
      id: "join-control",
      selector: JOIN_SELECTOR,
      minimum_count: 1,
      require_rendered: true,
    }),
  ]),
});

function installJoinProbe() {
  const probe = { busy_events: [], authored_join_calls: 0 };
  try {
    const prior = JSON.parse(sessionStorage.getItem(PROBE_STORAGE_KEY) ?? "null");
    if (Array.isArray(prior?.busy_events)) probe.busy_events = prior.busy_events;
    if (Number.isSafeInteger(prior?.authored_join_calls)) probe.authored_join_calls = prior.authored_join_calls;
  } catch {
  }
  const persist = () => {
    try {
      sessionStorage.setItem(PROBE_STORAGE_KEY, JSON.stringify(probe));
    } catch {
    }
  };
  Object.defineProperty(window, PROBE_KEY, { configurable: false, value: probe });
  Object.defineProperty(window, "WIKIDOT", {
    configurable: false,
    value: {
      page: {
        listeners: {
          join() {
            probe.authored_join_calls += 1;
            persist();
          },
        },
      },
    },
  });
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    setAttribute.call(this, name, value);
    if (name === "aria-busy" && this.matches(JOIN_SELECTOR)) {
      probe.busy_events.push({ busy: value === "true" });
      persist();
    }
  };
}

async function publicState(page) {
  return await page.evaluate(({ selector, key }) => {
    const control = document.querySelector(selector);
    const probe = window[key];
    return {
      url: location.href,
      path: location.pathname,
      history_length: history.length,
      join_control_count: document.querySelectorAll(selector).length,
      focused_control: control !== null && document.activeElement === control,
      aria_busy: control?.getAttribute("aria-busy") === "true",
      busy_events: [...(probe?.busy_events ?? [])].map((event) => event.busy),
      authored_join_calls: probe?.authored_join_calls ?? 0,
      source_disclosure: document.body?.innerText.includes("[[module Join") === true,
    };
  }, { selector: JOIN_SELECTOR, key: PROBE_KEY });
}

export class Open43Issue1029JoinBrowserAdapter {
  #browserContexts;
  #storageState;
  #actor;
  #actorUserId;
  #contexts = new Map();

  constructor({ browserContexts, storageState, actor = "eligible", actorUserId }) {
    if (actor !== "eligible" || !Number.isSafeInteger(actorUserId)) throw new Error("issue 1029 browser actor binding is invalid");
    this.#browserContexts = browserContexts;
    this.#storageState = storageState;
    this.#actor = actor;
    this.#actorUserId = actorUserId;
  }

  async #context(actor) {
    if (actor !== "anonymous" && actor !== this.#actor) throw new Error("issue 1029 browser actor is outside the prepared binding");
    if (!this.#contexts.has(actor)) {
      this.#contexts.set(
        actor,
        this.#browserContexts.newCandidateContext({
          storageState: actor === "anonymous" ? { cookies: [], origins: [] } : this.#storageState(this.#actor, this.#actorUserId),
          viewport: VIEWPORT,
        }),
      );
    }
    return (await this.#contexts.get(actor)).context;
  }

  async #goto(context, pageUrl) {
    const page = await context.newPage();
    try {
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      await page.locator(JOIN_SELECTOR).waitFor({ state: "attached", timeout: TIMEOUT_MS });
      return page;
    } catch (error) {
      await page.close({ runBeforeUnload: false, timeout: 10_000 }).catch(() => undefined);
      throw error;
    }
  }

  async #joined(page) {
    await page.waitForFunction(
      (selector) => document.querySelectorAll(selector).length === 0,
      JOIN_SELECTOR,
      { timeout: TIMEOUT_MS },
    );
  }

  async #denial(pageUrl) {
    const context = await this.#context("anonymous");
    const page = await this.#goto(context, pageUrl);
    let mutationRequestCount = 0;
    const onRequest = (request) => {
      if (request.method() === "POST" && request.url().includes("?/membershipJoin")) mutationRequestCount += 1;
    };
    page.on("request", onRequest);
    try {
      const before = await publicState(page);
      const control = page.locator(JOIN_SELECTOR);
      await control.click();
      await page.waitForTimeout(500);
      const after = await publicState(page);
      return { before, after, mutation_request_count: mutationRequestCount };
    } finally {
      page.off("request", onRequest);
      await page.close({ runBeforeUnload: false, timeout: 10_000 }).catch(() => undefined);
    }
  }

  async #operation(pageUrl, mode) {
    const context = await this.#context("eligible");
    const page = await this.#goto(context, pageUrl);
    let mutationRequestCount = 0;
    const onRequest = (request) => {
      if (request.method() === "POST" && request.url().includes("?/membershipJoin")) mutationRequestCount += 1;
    };
    page.on("request", onRequest);
    const matcher = (url) => url.href.includes("?/membershipJoin");
    let release;
    let observed;
    const hold = new Promise((resolve) => { release = resolve; });
    const intercepted = new Promise((resolve) => { observed = resolve; });
    const handler = async (route) => {
      observed();
      await hold;
      await route.fallback();
    };
    await page.route(matcher, handler, { times: 1 });
    try {
      const control = page.locator(JOIN_SELECTOR);
      if ((await control.count()) !== 1) throw new Error("issue 1029 did not serve exactly one Join control");
      await control.focus();
      const before = await publicState(page);
      const activation = mode === "click" ? control.click()
        : mode === "enter" ? control.press("Enter")
        : mode === "space" ? control.press(" ")
        : page.evaluate((selector) => {
          const element = document.querySelector(selector);
          element?.click();
          element?.click();
        }, JOIN_SELECTOR);
      let observationTimer = null;
      try {
        await Promise.race([
          intercepted,
          new Promise((_, reject) => {
            observationTimer = setTimeout(
              () => reject(new Error("issue 1029 Join request was not observed")),
              TIMEOUT_MS,
            );
          }),
        ]);
      } finally {
        if (observationTimer !== null) clearTimeout(observationTimer);
      }
      const busy = await publicState(page);
      release();
      await activation;
      await this.#joined(page);
      const after = await publicState(page);
      if (busy.aria_busy && after.busy_events.length === 0) after.busy_events = [true];
      return { before, after, mutation_request_count: mutationRequestCount };
    } finally {
      release?.();
      await page.unroute(matcher, handler).catch(() => undefined);
      page.off("request", onRequest);
      await page.close({ runBeforeUnload: false, timeout: 10_000 }).catch(() => undefined);
    }
  }

  async #history(pageUrl) {
    const context = await this.#context("eligible");
    const page = await this.#goto(context, pageUrl);
    try {
      const pageOrigin = new URL(pageUrl).origin;
      await page.goto(new URL("/", pageOrigin).href, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      const home = await page.evaluate(() => ({ path: location.pathname }));
      await page.goto(pageUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      await page.evaluate(() => history.back());
      await page.waitForURL((url) => url.pathname === "/", { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      const back = await page.evaluate(() => ({ path: location.pathname }));
      await page.evaluate(() => history.forward());
      await page.waitForURL(pageUrl, { waitUntil: "domcontentloaded", timeout: TIMEOUT_MS });
      const forward = await publicState(page);
      return { home, back, forward };
    } finally {
      await page.close({ runBeforeUnload: false, timeout: 10_000 }).catch(() => undefined);
    }
  }

  async run({ pageUrl, pagePath, reset }) {
    await this.#browserContexts.setActiveFixture("A1029_EXACT_BROWSER_TRANSITIONS");
    const context = await this.#context("eligible");
    const page = await this.#goto(context, pageUrl);
    let initial;
    try {
      const capture = await this.#browserContexts.captureCandidateObservation({
        context,
        page,
        url: pageUrl,
        label: "A1029_EXACT_BROWSER_TRANSITIONS",
        index: 0,
        contract: CAPTURE_CONTRACT,
        viewport: VIEWPORT,
        timeoutMs: TIMEOUT_MS,
        settleMs: 0,
        onPhase: () => this.#browserContexts.setActiveFixture("A1029_EXACT_BROWSER_TRANSITIONS"),
      });
      initial = { capture, state: await publicState(page) };
    } finally {
      await page.close({ runBeforeUnload: false, timeout: 10_000 }).catch(() => undefined);
    }
    const denial = await this.#denial(pageUrl);
    await reset();
    const history = await this.#history(pageUrl);
    const operations = {};
    for (const mode of ["click", "enter", "space", "repeated"]) {
      await reset();
      operations[mode] = await this.#operation(pageUrl, mode);
    }
    return { initial, denial, history, operations, page_path: pagePath };
  }
}
