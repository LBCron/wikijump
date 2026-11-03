import { CandidateHttpSession } from "./candidate-case-http.mjs";
import { leasedPageEdit } from "./page-edit-lease.mjs";
import { STANDING_BROWSER_EXECUTION_MODULES } from "./standing-browser-execution-identity.mjs";
import { STANDING_BROWSER_CAPTURE_SCHEMA } from "./standing-browser-parity-contract.mjs";
import { candidatePageOrigin } from "./standing-browser-parity-receipt.mjs";
import {
  requirePlainObject,
  requireSha256,
  sha256Value,
} from "./standing-browser-parity-util.mjs";

export const OPEN43_AUTHORING_HISTORY_CASE_IDS = Object.freeze([
  "A1063_EXACT_PUBLIC_SOURCE_CANDIDATE",
  "A1063_DIFF_BROWSER_WORKFLOW",
  "A1063_SETTINGS_BROWSER_WORKFLOW",
]);

const SITE_SLUG = "scpaiueouiuiuiui";
const SITE_HOST = `${SITE_SLUG}.wikijump.localhost`;
const LONG_LINE = "L".repeat(8192);
const INITIAL_SOURCE = `first line\n${LONG_LINE}\n\n<script>old source only</script>\n`;
const EDITED_SOURCE = `second line\n${LONG_LINE}\n\nintermediate revision\n`;
const FINAL_SOURCE = `final line\n${LONG_LINE}\n\n<img src=x onerror=alert(1)>\n`;
const VIEWPORT = Object.freeze({ width: 1280, height: 900 });
const BROWSER_CONTRACTS = Object.freeze({
  history: Object.freeze({
    slug: "a1063-history",
    theme_family: "candidate",
    first_paint_geometry_selectors: ["#action-area", ".revision-diff-panel"],
    geometry_selectors: ["#action-area", ".revision-diff-panel"],
    presence_probes: [Object.freeze({ id: "revision-diff-panel", selector: ".revision-diff-panel", minimum_count: 1, require_rendered: true })],
  }),
  settings: Object.freeze({
    slug: "a1063-settings",
    theme_family: "candidate",
    first_paint_geometry_selectors: ["#user-settings-form"],
    geometry_selectors: ["#user-settings-form"],
    presence_probes: [Object.freeze({ id: "user-settings-form", selector: "#user-settings-form", minimum_count: 1, require_rendered: true })],
  }),
});

function pageSlug(runId) {
  return `open43-history-${runId.slice("candidate-run-".length)}`;
}

function servedUrl(origin, slug, hash = "") {
  const url = new URL(`/${encodeURIComponent(slug)}`, origin);
  url.hash = hash;
  return url.href;
}

function editorStorageState(session) {
  return {
    cookies: [{
      name: "wikijump_token",
      value: session.editorSessionToken,
      url: session.pageOrigin,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    }],
    origins: [],
  };
}

function requirePage(value, slug) {
  if (!Number.isSafeInteger(value?.page_id) || !Number.isSafeInteger(value.revision_id) || !Number.isSafeInteger(value.revision_number) || value.slug !== slug) {
    throw new Error(`history candidate page ${slug} is missing or malformed`);
  }
  return value;
}

function requireCreatedPage(value, slug) {
  if (!Number.isSafeInteger(value?.page_id) || !Number.isSafeInteger(value.revision_id) || value.slug !== slug) {
    throw new Error(`history candidate page ${slug} was not created`);
  }
  return value;
}

function requireDiff(value) {
  if (!value || !Array.isArray(value.lines) || value.lines.some((line) => !["added", "removed", "unchanged"].includes(line?.kind) || typeof line.text !== "string")) {
    throw new Error("history candidate revision diff is not a typed line list");
  }
  return value;
}

function requireAjax(value, moduleName) {
  if (value?.http_status !== 200 || value.payload?.status !== "ok" || typeof value.payload.body !== "string" || value.payload.body.length === 0) {
    throw new Error(`${moduleName} did not return a successful public response`);
  }
  return {
    http_status: value.http_status,
    status: value.payload.status,
    body_size: value.response_body_size,
    body_sha256: value.response_body_sha256,
  };
}

async function runHistoryDiffWorkflow(page, { fromRevisionNumber, toRevisionNumber }) {
  return await page.evaluate(async ({ operation, fromRevisionNumber: fromNumber, toRevisionNumber: toNumber }) => {
    if (operation !== "history-diff-workflow") throw new Error("unknown history observation");
    const waitFor = async (read, name) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const value = read();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`${name} did not appear`);
    };
    const controls = await waitFor(
      () => document.querySelector(".revision-diff-controls"),
      "revision diff controls",
    );
    const from = controls.querySelector("#revision-diff-from");
    const to = controls.querySelector("#revision-diff-to");
    const [swap, compare] = [...controls.querySelectorAll("button")];
    if (!(from instanceof HTMLSelectElement) || !(to instanceof HTMLSelectElement) || !(swap instanceof HTMLButtonElement) || !(compare instanceof HTMLButtonElement)) {
      throw new Error("revision diff controls are incomplete");
    }
    from.value = String(fromNumber);
    from.dispatchEvent(new Event("change", { bubbles: true }));
    to.value = String(toNumber);
    to.dispatchEvent(new Event("change", { bubbles: true }));
    const initialSelection = { from: from.value, to: to.value };
    compare.focus();
    const focusBefore = document.activeElement === compare;
    let loadingObserved = compare.disabled;
    const observer = new MutationObserver(() => {
      loadingObserved ||= compare.disabled;
    });
    observer.observe(compare, { attributes: true, childList: true, subtree: true });
    compare.click();
    const diff = await waitFor(() => document.querySelector(".revision-diff"), "revision diff");
    await new Promise((resolve) => setTimeout(resolve, 0));
    observer.disconnect();
    const lines = [...diff.querySelectorAll(".revision-diff-line")].map((line) => ({
      kind: ["added", "removed", "unchanged"].find((kind) => line.classList.contains(kind)) ?? null,
      text: (line.textContent ?? "").slice(1).replace(/\n$/u, ""),
    }));
    const focusAfter = document.activeElement === compare;
    swap.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return {
      initial_selection: initialSelection,
      swapped_selection: { from: from.value, to: to.value },
      loading_observed: loadingObserved,
      focus_before: focusBefore,
      focus_after: focusAfter,
      lines,
      unsafe_element_count: diff.querySelectorAll("script, img, iframe, object, embed").length,
    };
  }, { operation: "history-diff-workflow", fromRevisionNumber, toRevisionNumber });
}

async function probeMissingRevision(page, { siteId, pageId }) {
  return await page.evaluate(async ({ operation, siteId: site, pageId: selectedPage }) => {
    if (operation !== "missing-revision-probe") throw new Error("unknown revision probe");
    const response = await fetch("?/revisionDiff", {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "text/plain;charset=UTF-8",
        "x-sveltekit-action": "true",
      },
      body: JSON.stringify({
        siteId: site,
        pageId: selectedPage,
        fromRevisionNumber: 999_999,
        toRevisionNumber: 1,
      }),
    });
    const body = await response.text();
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
    return {
      status: response.status,
      body_size: new TextEncoder().encode(body).byteLength,
      body_sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      leaked_markup: body.includes("<script>old source only</script>") || body.includes("<img src=x onerror=alert(1)>") || body.includes("L".repeat(8192)),
    };
  }, { operation: "missing-revision-probe", siteId, pageId });
}

async function runHistoryFailClosedWorkflow(page) {
  return await page.evaluate(async ({ operation }) => {
    if (operation !== "history-fail-closed-workflow") throw new Error("unknown history failure observation");
    const controls = document.querySelector(".revision-diff-controls");
    const from = controls?.querySelector("#revision-diff-from");
    const buttons = controls === null ? [] : [...controls.querySelectorAll("button")];
    const compare = buttons[1];
    if (!(from instanceof HTMLSelectElement) || !(compare instanceof HTMLButtonElement)) throw new Error("revision diff controls are incomplete");
    const invalid = document.createElement("option");
    invalid.value = "999999";
    invalid.textContent = "999999";
    from.append(invalid);
    from.value = invalid.value;
    from.dispatchEvent(new Event("change", { bubbles: true }));
    let loadingObserved = compare.disabled;
    const observer = new MutationObserver(() => {
      loadingObserved ||= compare.disabled;
    });
    observer.observe(compare, { attributes: true, childList: true, subtree: true });
    compare.click();
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && (!loadingObserved || compare.disabled)) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    observer.disconnect();
    const error = document.querySelector("#odialog-container, .modal-container");
    const result = document.querySelector(".revision-diff");
    const visibleText = `${error?.textContent ?? ""}${result?.textContent ?? ""}`;
    return {
      loading_observed: loadingObserved,
      result_count: result === null ? 0 : 1,
      error_visible: error !== null,
      error_text_sha256_input: error?.textContent ?? "",
      hidden_source_present: visibleText.includes("<script>old source only</script>") || visibleText.includes("<img src=x onerror=alert(1)>") || visibleText.includes("L".repeat(8192)),
      unsafe_element_count: document.querySelectorAll(".revision-diff script, .revision-diff img, .revision-diff iframe, .revision-diff object, .revision-diff embed").length,
    };
  }, { operation: "history-fail-closed-workflow" });
}

async function settingsState(page) {
  return await page.evaluate(({ operation }) => {
    if (operation !== "settings-state") throw new Error("unknown settings observation");
    const input = document.querySelector("#user-display-locales");
    return {
      form_count: document.querySelectorAll("#user-settings-form").length,
      input_count: document.querySelectorAll("#user-display-locales").length,
      input_value: input instanceof HTMLInputElement ? input.value : null,
      save_count: document.querySelectorAll("#user-settings-form .button-save").length,
      cancel_count: document.querySelectorAll("#user-settings-form .button-cancel").length,
    };
  }, { operation: "settings-state" });
}

async function waitForSettingsInputValue(page, expectedLocales) {
  const expectedValue = expectedLocales.join(" ");
  await page.waitForFunction(({ selector, expected }) => {
    const input = document.querySelector(selector);
    return input instanceof HTMLInputElement && input.value === expected;
  }, {
    selector: "#user-display-locales",
    expected: expectedValue,
  }, {
    timeout: 10_000,
  });
}

async function addSubmittedUserControl(page) {
  await page.evaluate(({ operation }) => {
    if (operation !== "add-submitted-user") throw new Error("unknown settings operation");
    const form = document.querySelector("#user-settings-form");
    if (!(form instanceof HTMLFormElement)) throw new Error("settings form is missing");
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = "user";
    input.value = "999";
    form.append(input);
  }, { operation: "add-submitted-user" });
}

function captureStatus(response) {
  return typeof response?.status === "function" ? response.status() : response?.status ?? 0;
}

async function responseObservation(response) {
  const body = typeof response?.text === "function" ? await response.text() : response?.body ?? "";
  const httpStatus = captureStatus(response);
  let status = httpStatus;
  try {
    const action = JSON.parse(body);
    if (
      ["success", "failure"].includes(action?.type) &&
      Number.isSafeInteger(action.status)
    ) {
      status = action.status;
    }
  } catch {
  }
  return {
    status,
    http_status: httpStatus,
    body_size: Buffer.byteLength(body),
    body_sha256: sha256Value(body),
  };
}

function requireUser(value, userId) {
  if (value?.user_id !== userId || value.user_type !== "regular" || !Array.isArray(value.locales) || value.locales.length === 0 || value.locales.some((locale) => typeof locale !== "string" || locale.length === 0)) {
    throw new Error("authoring settings user is missing or malformed");
  }
  return value;
}

function sameStrings(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}

class Open43AuthoringHistoryRun {
  #session;
  #browser;
  #resources;
  #slug;
  #siteId = null;
  #pages = [];
  #originalLocales = null;
  #settingsRestored = true;
  #settingsResource = null;

  constructor({ session, browser, resources, slug }) {
    this.#session = session;
    this.#browser = browser;
    this.#resources = resources;
    this.#slug = slug;
  }

  async #rpc(method, params = {}, { actor = "editor", cleanup = false, page = this.#slug } = {}) {
    return await this.#session.rpc(method, params, {
      actor,
      siteId: this.#siteId ?? undefined,
      page,
      cleanup,
    });
  }

  async #pageRead(slug = this.#slug, { cleanup = false } = {}) {
    return await this.#rpc("page_get", {
      site_id: this.#siteId,
      page: slug,
      details: { wikitext: true, compiled: false },
    }, { cleanup, page: slug });
  }

  async #createPage(slug, title, wikitext) {
    const page = requireCreatedPage(await this.#rpc("page_create", {
      site_id: this.#siteId,
      slug,
      title,
      alt_title: null,
      wikitext,
      layout: "wikidot",
      revision_comments: "Open43 history candidate initial revision",
      user_id: this.#session.editorUserId,
      ip_address: "192.0.2.61",
      tags: [],
    }, { page: slug }), slug);
    const resource = this.#resources.register("page", {
      page_id: page.page_id,
      slug: page.slug,
      revision_id: page.revision_id,
    });
    this.#pages.push({ page, resource });
    return page;
  }

  async #capture({ context, page, url, label, index, contract, navigate = null }) {
    return await this.#browser.captureCandidateObservation({
      context,
      page,
      url,
      label,
      index,
      contract,
      viewport: VIEWPORT,
      timeoutMs: 30_000,
      settleMs: 0,
      ...(navigate === null ? {} : { navigate }),
    });
  }

  async #user({ cleanup = false } = {}) {
    return requireUser(
      await this.#rpc("user_get", { user: this.#session.editorUserId }, { cleanup }),
      this.#session.editorUserId,
    );
  }

  async #restoreSettings({ cleanup = false } = {}) {
    if (this.#originalLocales === null || this.#settingsRestored) return;
    await this.#rpc("user_edit", {
      user: this.#session.editorUserId,
      locales: this.#originalLocales,
      ip_address: "192.0.2.61",
      bypass_filter: false,
    }, { cleanup });
    const restored = await this.#user({ cleanup });
    if (!sameStrings(restored.locales, this.#originalLocales)) throw new Error("settings cleanup did not restore the session actor locales");
    this.#settingsRestored = true;
  }

  async #historyBrowser(before, after) {
    await this.#browser.setActiveFixture("A1063_DIFF_BROWSER_WORKFLOW");
    const owned = await this.#browser.newCandidateContext({ storageState: { cookies: [], origins: [] }, viewport: VIEWPORT });
    const page = await owned.context.newPage();
    const url = servedUrl(this.#session.pageOrigin, this.#slug, "_history");
    let workflow = null;
    try {
      await page.goto(new URL("/", this.#session.pageOrigin).href, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const capture = await this.#capture({
        context: owned.context,
        page,
        url,
        label: "A1063_DIFF_BROWSER_WORKFLOW",
        index: 0,
        contract: BROWSER_CONTRACTS.history,
        navigate: async ({ page: target, url: targetUrl, timeoutMs }) => {
          const response = await target.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
          workflow = await runHistoryDiffWorkflow(target, {
            fromRevisionNumber: before.revision_number,
            toRevisionNumber: after.revision_number,
          });
          return response;
        },
      });
      const missing = await probeMissingRevision(page, { siteId: this.#siteId, pageId: after.page_id });
      const failClosed = await runHistoryFailClosedWorkflow(page);
      failClosed.error_text_sha256 = sha256Value(failClosed.error_text_sha256_input);
      delete failClosed.error_text_sha256_input;
      const back = await page.goBack({ waitUntil: "domcontentloaded", timeout: 30_000 });
      const backUrl = page.url();
      const forward = await page.goForward({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await page.waitForSelector(".revision-diff-controls", { timeout: 30_000 });
      const forwardUrl = page.url();
      return {
        actor: "anonymous",
        url,
        capture,
        workflow,
        fail_closed: { direct_action: missing, served_ui: failClosed },
        navigation: {
          back_status: captureStatus(back),
          back_url: backUrl,
          forward_status: captureStatus(forward),
          forward_url: forwardUrl,
          controls_restored: true,
        },
      };
    } finally {
      await page.close({ runBeforeUnload: false, timeout: 10_000 }).catch(() => undefined);
    }
  }

  async #settingsBrowser() {
    const original = await this.#user();
    this.#originalLocales = [...original.locales];
    this.#settingsResource = this.#resources.register("settings", {
      user_id: original.user_id,
      before_sha256: sha256Value(this.#originalLocales),
    });
    const settingsUrl = new URL("/-/settings", this.#session.pageOrigin).href;
    await this.#browser.setActiveFixture("A1063_SETTINGS_BROWSER_WORKFLOW");

    const anonymousOwned = await this.#browser.newCandidateContext({ storageState: { cookies: [], origins: [] }, viewport: VIEWPORT });
    const anonymousPage = await anonymousOwned.context.newPage();
    let anonymous;
    try {
      const response = await anonymousPage.goto(settingsUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      anonymous = {
        navigation_status: captureStatus(response),
        final_url: anonymousPage.url(),
        final_pathname: new URL(anonymousPage.url()).pathname,
      };
    } finally {
      await anonymousPage.close({ runBeforeUnload: false, timeout: 10_000 }).catch(() => undefined);
    }

    const owned = await this.#browser.newCandidateContext({ storageState: editorStorageState(this.#session), viewport: VIEWPORT });
    const page = await owned.context.newPage();
    let initial = null;
    let postCount = 0;
    const postBodies = [];
    const onRequest = (request) => {
      if (request.method() === "POST" && request.url().includes("?/display")) {
        postCount += 1;
        postBodies.push(request.postData() ?? "");
      }
    };
    page.on("request", onRequest);
    try {
      const capture = await this.#capture({
        context: owned.context,
        page,
        url: settingsUrl,
        label: "A1063_SETTINGS_BROWSER_WORKFLOW",
        index: 1,
        contract: BROWSER_CONTRACTS.settings,
        navigate: async ({ page: target, url: targetUrl, timeoutMs }) => {
          const response = await target.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
          initial = await settingsState(target);
          return response;
        },
      });

      const cancelBefore = postCount;
      await page.fill("#user-display-locales", "cancelled-locale");
      await page.click("#user-settings-form .button-cancel");
      const cancelled = await settingsState(page);
      const cancelAfter = postCount;

      await page.fill("#user-display-locales", "   ");
      const invalidResponse = await page.evaluate(async ({ operation }) => {
        if (operation !== "submit-settings-form") throw new Error("unknown settings operation");
        const form = document.querySelector("#user-settings-form");
        if (!(form instanceof HTMLFormElement)) throw new Error("settings form is missing");
        const response = await fetch(form.action, { method: "POST", body: new URLSearchParams(new FormData(form)), credentials: "same-origin" });
        return { status: response.status, body: await response.text() };
      }, { operation: "submit-settings-form" });
      const invalid = await responseObservation(invalidResponse);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      const afterInvalidReload = await settingsState(page);

      const desired = sameStrings(this.#originalLocales, ["ja-JP", "en-US"])
        ? ["fr", "en"]
        : ["ja-JP", "en-US"];
      const submitted = `${desired[0].replaceAll("-", "_")}, ${desired[1]} ${desired[0]}`;
      await page.fill("#user-display-locales", submitted);
      await addSubmittedUserControl(page);
      this.#settingsRestored = false;
      const saveResponse = await page.evaluate(async ({ operation }) => {
        if (operation !== "submit-settings-form") throw new Error("unknown settings operation");
        const form = document.querySelector("#user-settings-form");
        if (!(form instanceof HTMLFormElement)) throw new Error("settings form is missing");
        const requestBody = new URLSearchParams(new FormData(form));
        const response = await fetch(form.action, { method: "POST", body: requestBody, credentials: "same-origin" });
        return { status: response.status, body: await response.text(), request_body: requestBody.toString() };
      }, { operation: "submit-settings-form" });
      const saved = await responseObservation(saveResponse);
      const saveRequestBody = saveResponse.request_body ?? postBodies.at(-1) ?? "";
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitForSettingsInputValue(page, desired);
      const afterSaveReload = await settingsState(page);
      const persisted = await this.#user();

      const csrfResponse = await owned.context.request.post(new URL("/-/settings?/display", this.#session.pageOrigin).href, {
        headers: {
          origin: "https://csrf.invalid",
          "content-type": "application/x-www-form-urlencoded",
        },
        data: new URLSearchParams({ locales: desired.join(" ") }).toString(),
      });
      const csrf = await responseObservation(csrfResponse);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      const afterCsrfReload = await settingsState(page);

      await this.#restoreSettings();
      await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
      const restored = await settingsState(page);
      return {
        actor: { user_id: this.#session.editorUserId, submitted_user_id: 999 },
        url: settingsUrl,
        anonymous,
        capture,
        initial,
        cancel: { before_post_count: cancelBefore, after_post_count: cancelAfter, state: cancelled },
        invalid: { response: invalid, reloaded: afterInvalidReload },
        save: {
          submitted,
          submitted_user_control: /(?:^|&)user=999(?:&|$)/u.test(saveRequestBody),
          request_body_sha256: sha256Value(saveRequestBody),
          expected_locales: desired,
          response: saved,
          persisted_locales: persisted.locales,
          reloaded: afterSaveReload,
        },
        csrf: { origin: "https://csrf.invalid", response: csrf, reloaded: afterCsrfReload },
        restore: { expected_locales: this.#originalLocales, reloaded: restored },
      };
    } finally {
      page.off("request", onRequest);
      await page.close({ runBeforeUnload: false, timeout: 10_000 }).catch(() => undefined);
    }
  }

  async execute() {
    const site = await this.#session.rpc("site_get", { site: SITE_SLUG });
    if (!Number.isSafeInteger(site?.site_id) || site.slug !== SITE_SLUG) {
      throw new Error(`editable candidate site ${SITE_SLUG} is missing`);
    }
    this.#siteId = site.site_id;
    if (await this.#pageRead() !== null) throw new Error(`run-owned history page already exists: ${this.#slug}`);

    const initial = await this.#createPage(this.#slug, "Open43 history candidate", INITIAL_SOURCE);
    const before = requirePage(await this.#pageRead(), this.#slug);
    const edited = await leasedPageEdit((method, params) => this.#rpc(method, params), {
      site_id: this.#siteId,
      page: initial.page_id,
      last_revision_id: initial.revision_id,
      revision_comments: "Open43 history candidate edited revision",
      user_id: this.#session.editorUserId,
      wikitext: EDITED_SOURCE,
      ip_address: "192.0.2.61",
    });
    if (!Number.isSafeInteger(edited?.revision_id) || !Number.isSafeInteger(edited.revision_number)) throw new Error("first page_edit returned an invalid revision identity");
    const middle = requirePage(await this.#pageRead(), this.#slug);
    if (middle.revision_id !== edited.revision_id || middle.revision_number !== edited.revision_number) throw new Error("first page_edit was not publicly readable");
    const finalEdit = await leasedPageEdit((method, params) => this.#rpc(method, params), {
      site_id: this.#siteId,
      page: initial.page_id,
      last_revision_id: middle.revision_id,
      revision_comments: "Open43 history candidate final revision",
      user_id: this.#session.editorUserId,
      wikitext: FINAL_SOURCE,
      ip_address: "192.0.2.61",
    });
    if (!Number.isSafeInteger(finalEdit?.revision_id) || !Number.isSafeInteger(finalEdit.revision_number)) throw new Error("final page_edit returned an invalid revision identity");
    const after = requirePage(await this.#pageRead(), this.#slug);
    if (after.revision_id !== finalEdit.revision_id || after.revision_number !== finalEdit.revision_number || before.revision_number >= middle.revision_number || middle.revision_number >= after.revision_number) throw new Error("history candidate did not create three ordered revisions");

    const diff = requireDiff(await this.#rpc("page_revision_diff", {
      site_id: this.#siteId,
      page_id: after.page_id,
      from_revision_number: before.revision_number,
      to_revision_number: after.revision_number,
    }, { actor: "anonymous" }));
    const ajax = [
      ["history/PageRevisionListModule", {
        moduleName: "history/PageRevisionListModule",
        page_id: String(after.page_id),
        options: "{'all': True}",
        perpage: "100000000",
      }],
      ["history/PageSourceModule", {
        moduleName: "history/PageSourceModule",
        revision_id: String(before.revision_id),
      }],
      ["history/PageVersionModule", {
        moduleName: "history/PageVersionModule",
        revision_id: String(after.revision_id),
      }],
    ];
    const ajaxResponses = [];
    for (const [moduleName, fields] of ajax) {
      const response = await this.#session.ajaxModuleRequest(fields, {
        actor: "anonymous",
        page: this.#slug,
      });
      ajaxResponses.push({ module_name: moduleName, ...requireAjax(response, moduleName) });
    }

    const historyBrowser = await this.#historyBrowser(before, after);
    const settingsBrowser = await this.#settingsBrowser();
    return [
      {
        case_id: "A1063_EXACT_PUBLIC_SOURCE_CANDIDATE",
        observations: {
          page: {
            site_id: this.#siteId,
            page_id: after.page_id,
            initial_revision_id: before.revision_id,
            initial_revision_number: before.revision_number,
            intermediate_revision_id: middle.revision_id,
            intermediate_revision_number: middle.revision_number,
            final_revision_id: after.revision_id,
            final_revision_number: after.revision_number,
          },
          diff: {
            site_id: diff.site_id,
            page_id: diff.page_id,
            from_revision_number: diff.from_revision_number,
            to_revision_number: diff.to_revision_number,
            lines: diff.lines,
          },
          ajax: ajaxResponses,
        },
      },
      { case_id: "A1063_DIFF_BROWSER_WORKFLOW", observations: historyBrowser },
      { case_id: "A1063_SETTINGS_BROWSER_WORKFLOW", observations: settingsBrowser },
    ];
  }

  async cleanup() {
    const failures = [];
    await this.#restoreSettings({ cleanup: true }).catch((error) => failures.push(error));
    const absentPages = [];
    for (const { page, resource } of [...this.#pages].reverse()) {
      try {
        const current = await this.#pageRead(page.slug, { cleanup: true });
        if (current !== null) {
          await this.#rpc("page_delete", {
            site_id: this.#siteId,
            page: current.page_id,
            last_revision_id: current.revision_id,
            revision_comments: "Open43 history candidate cleanup",
            user_id: this.#session.editorUserId,
            ip_address: "192.0.2.61",
          }, { cleanup: true, page: page.slug });
        }
        if (await this.#pageRead(page.slug, { cleanup: true }) !== null) throw new Error(`cleanup left ${page.slug} publicly present`);
        this.#resources.release(resource, { page_get: null });
        absentPages.push(page.slug);
      } catch (error) {
        failures.push(error);
      }
    }
    let afterLocales = null;
    if (this.#settingsResource !== null) {
      try {
        afterLocales = (await this.#user({ cleanup: true })).locales;
        if (!sameStrings(afterLocales, this.#originalLocales)) throw new Error("cleanup left modified display locales");
        this.#resources.release(this.#settingsResource, {
          before_sha256: sha256Value(this.#originalLocales),
          after_sha256: sha256Value(afterLocales),
        });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "history candidate cleanup failed");
    return {
      page_get: null,
      absent_pages: absentPages.sort(),
      settings: { before: this.#originalLocales, after: afterLocales, restored: this.#settingsRestored },
    };
  }
}

function verifyCase(caseId, observations) {
  if (caseId === "A1063_EXACT_PUBLIC_SOURCE_CANDIDATE") {
    const page = observations.page;
    const diff = observations.diff;
    if (!Number.isSafeInteger(page?.site_id) || !Number.isSafeInteger(page?.page_id) || new Set([page.initial_revision_id, page.intermediate_revision_id, page.final_revision_id]).size !== 3 || new Set([page.initial_revision_number, page.intermediate_revision_number, page.final_revision_number]).size !== 3 || diff.site_id !== page.site_id || diff.page_id !== page.page_id || diff.from_revision_number !== page.initial_revision_number || diff.to_revision_number !== page.final_revision_number) throw new Error("history candidate revision identities are not bound to one three-revision page");
    const kinds = new Set(diff.lines.map((line) => line.kind));
    if (!kinds.has("added") || !kinds.has("removed") || !kinds.has("unchanged")) throw new Error("history candidate diff did not expose all typed line kinds");
    if (diff.lines.some((line) => Object.hasOwn(line, "wikitext") || Object.hasOwn(line, "compiled_body_html"))) throw new Error("history candidate diff exposed a raw source field");
    if (!Array.isArray(observations.ajax) || observations.ajax.length !== 3 || observations.ajax.some((response) => response.http_status !== 200 || response.status !== "ok" || !/^[0-9a-f]{64}$/u.test(response.body_sha256))) throw new Error("history candidate AMC responses are incomplete");
    return {
      verified: true,
      typed_diff_kinds: [...kinds].sort(),
      diff_lines_sha256: sha256Value(diff.lines),
      exact_ajax_modules: observations.ajax.map((response) => response.module_name),
    };
  }
  if (caseId === "A1063_DIFF_BROWSER_WORKFLOW") return verifyHistoryBrowser(observations);
  if (caseId === "A1063_SETTINGS_BROWSER_WORKFLOW") return verifySettingsBrowser(observations);
  throw new Error(`unsupported Open43 history case: ${caseId}`);
}

function candidateOwnedBrowserFailure(failure) {
  if (failure?.kind !== "request_failed") return true;
  let url;
  try { url = new URL(failure.url); } catch { return true; }
  if (!["http:", "https:"].includes(url.protocol)) return true;
  if (!url.hostname.endsWith(".wikijump.localhost")) return false;
  return !(
    failure.error === "net::ERR_ABORTED" &&
    url.pathname.startsWith("/_app/immutable/") &&
    ["script", "stylesheet", "font", "image"].includes(failure.resource_type)
  );
}

function verifyCapture(value, expectedUrl, name) {
  const capture = requirePlainObject(value, `${name} capture`);
  if (capture.schema !== STANDING_BROWSER_CAPTURE_SCHEMA || capture.input_url !== expectedUrl || capture.final_url !== expectedUrl || capture.navigation_status !== 200 || Object.hasOwn(capture, "capture_error")) throw new Error(`${name} capture did not bind one successful candidate navigation`);
  if (!Array.isArray(capture.failures) || capture.failures.some(candidateOwnedBrowserFailure) || !Array.isArray(capture.request_gate_aborts) || capture.request_gate_aborts.length !== 0) throw new Error(`${name} capture has failed or blocked candidate requests`);
  if (capture.first_paint?.document?.phase !== "domcontentloaded_immediate_observation" || capture.document?.phase !== "settled") throw new Error(`${name} capture is missing an initial or settled interval`);
  const artifacts = [capture.first_paint?.screenshot, capture.settled_viewport_screenshot, capture.screenshot];
  for (const [index, artifact] of artifacts.entries()) {
    if (typeof artifact?.path !== "string" || artifact.path.length === 0) throw new Error(`${name} screenshot ${index} has no durable path`);
    requireSha256(artifact.sha256, `${name} screenshot ${index} SHA-256`);
  }
  if (new Set(artifacts.map(({ path }) => path)).size !== artifacts.length) throw new Error(`${name} capture reused a screenshot artifact`);
  return artifacts.map(({ path }) => path);
}

function verifyHistoryBrowser(observations) {
  const screenshotPaths = verifyCapture(observations.capture, observations.url, "history browser");
  if (observations.actor !== "anonymous") throw new Error("history browser did not record the anonymous request actor");
  const workflow = requirePlainObject(observations.workflow, "history browser workflow");
  if (workflow.initial_selection?.from === workflow.initial_selection?.to || workflow.swapped_selection?.from !== workflow.initial_selection?.to || workflow.swapped_selection?.to !== workflow.initial_selection?.from) throw new Error("history browser swap did not reverse the selected revision pair");
  if (workflow.loading_observed !== true || workflow.focus_before !== true || workflow.focus_after !== true) throw new Error("history browser did not preserve loading and focus behavior");
  const kinds = new Set(workflow.lines?.map((line) => line.kind));
  if (!kinds.has("added") || !kinds.has("removed") || !kinds.has("unchanged") || !workflow.lines.some((line) => line.text === LONG_LINE) || !workflow.lines.some((line) => line.text === "")) throw new Error("history browser did not render the typed long and empty line matrix");
  if (workflow.unsafe_element_count !== 0) throw new Error("history browser rendered source text as an unsafe element");
  const direct = requirePlainObject(observations.fail_closed?.direct_action, "history missing-revision action");
  requireSha256(direct.body_sha256, "history missing-revision body SHA-256");
  const served = requirePlainObject(observations.fail_closed?.served_ui, "history fail-closed UI");
  requireSha256(served.error_text_sha256, "history error text SHA-256");
  if (direct.leaked_markup !== false || served.loading_observed !== true || served.result_count !== 0 || served.hidden_source_present !== false || served.unsafe_element_count !== 0) throw new Error("history denied or missing pair did not fail closed");
  if (observations.navigation?.back_url === observations.url || observations.navigation?.forward_url !== observations.url || observations.navigation?.controls_restored !== true) throw new Error("history browser back and forward navigation did not restore the served workflow");
  return {
    verified: true,
    typed_diff_kinds: [...kinds].sort(),
    screenshot_paths: screenshotPaths,
    fail_closed_body_sha256: direct.body_sha256,
  };
}

function verifySettingsState(value, name) {
  const state = requirePlainObject(value, name);
  if (state.form_count !== 1 || state.input_count !== 1 || state.save_count !== 1 || state.cancel_count !== 1 || typeof state.input_value !== "string") throw new Error(`${name} is not one served settings form`);
  return state;
}

function verifySettingsBrowser(observations) {
  const screenshotPaths = verifyCapture(observations.capture, observations.url, "settings browser");
  if (observations.actor?.user_id !== -1 || observations.actor.submitted_user_id !== 999) throw new Error("settings browser did not bind the fixed actor and cross-user control");
  if (observations.anonymous?.final_pathname !== "/-/login" || observations.anonymous.final_url !== new URL("/-/login", observations.url).href) throw new Error("anonymous settings load did not redirect to the candidate login route");
  const initial = verifySettingsState(observations.initial, "initial settings state");
  const cancelled = verifySettingsState(observations.cancel?.state, "cancelled settings state");
  if (observations.cancel.before_post_count !== observations.cancel.after_post_count || cancelled.input_value !== initial.input_value) throw new Error("settings cancel submitted or failed to restore the saved value");
  const invalidReload = verifySettingsState(observations.invalid?.reloaded, "invalid settings reload");
  if (observations.invalid?.response?.status !== 400 || invalidReload.input_value !== initial.input_value) throw new Error("invalid settings submission did not preserve the rejection and persisted-locale contract");
  requireSha256(observations.invalid.response.body_sha256, "invalid settings response SHA-256");
  const expected = observations.save?.expected_locales;
  const savedReload = verifySettingsState(observations.save?.reloaded, "saved settings reload");
  if (
    observations.save?.response?.status !== 200 ||
    observations.save.submitted_user_control !== true ||
    !sameStrings(observations.save.persisted_locales, expected) ||
    savedReload.input_value !== expected.join(" ")
  ) {
    throw new Error(
      `settings save did not persist normalized self locales through a fresh reload: ${JSON.stringify({
        response_status: observations.save?.response?.status ?? null,
        submitted_user_control: observations.save?.submitted_user_control ?? null,
        expected_locales: expected ?? null,
        persisted_locales: observations.save?.persisted_locales ?? null,
        reload_input_value: savedReload.input_value,
      })}`,
    );
  }
  requireSha256(observations.save.request_body_sha256, "saved settings request body SHA-256");
  requireSha256(observations.save.response.body_sha256, "saved settings response SHA-256");
  const csrfReload = verifySettingsState(observations.csrf?.reloaded, "CSRF settings reload");
  if (observations.csrf?.origin !== "https://csrf.invalid" || observations.csrf?.response?.status !== 403 || csrfReload.input_value !== expected.join(" ")) throw new Error("settings origin control did not reject without mutation");
  requireSha256(observations.csrf.response.body_sha256, "CSRF settings response SHA-256");
  const restored = verifySettingsState(observations.restore?.reloaded, "restored settings state");
  if (restored.input_value !== observations.restore.expected_locales.join(" ")) throw new Error("settings workflow did not restore its original locales");
  return {
    verified: true,
    actor_user_id: observations.actor.user_id,
    normalized_locales: expected,
    screenshot_paths: screenshotPaths,
  };
}

function verifyCleanup(proof, resources) {
  if (proof?.page_get !== null || proof.absent_pages?.length !== 1 || proof.settings?.restored !== true || !sameStrings(proof.settings.before, proof.settings.after) || resources.some((resource) => resource.released !== true)) throw new Error("history and settings candidate cleanup did not prove public restoration");
  return { public_absence_verified: true, page_count: proof.absent_pages.length, settings_restored: true };
}

export function createOpen43AuthoringHistoryCandidateCaseSet({ sessionFactory = (options) => new CandidateHttpSession(options) } = {}) {
  const sourceFiles = Object.freeze([...new Set([
    ...STANDING_BROWSER_EXECUTION_MODULES,
    "deepwell/Cargo.lock",
    "deepwell/src/api.rs",
    "deepwell/src/services/page_revision/service.rs",
    "deepwell/src/services/user/service.rs",
    "deepwell/tests/authoring_boundaries.rs",
    "deepwell/tests/page.rs",
    "deepwell/tests/user.rs",
    "docs/development/open43-a-authoring-closure-audit.json",
    "docs/wikidot-specifications/specifications/platform/collaborative-editing.md",
    "docs/wikidot-specifications/specifications/platform/page-editing-history.md",
    "framerail/src/lib/server/load/user-settings.ts",
    "framerail/src/lib/server/load/page/page-revision-actions.ts",
    "framerail/src/lib/user-settings.js",
    "framerail/src/routes/[slug]/[...extra]/HistoryPane.svelte",
    "framerail/src/routes/[x+2d]/settings/+page.server.ts",
    "framerail/src/routes/[x+2d]/settings/+page.svelte",
    "framerail/tests/authoring-workflows.test.js",
    "framerail/tests/user-settings-action-boundary.test.js",
    "install/local/wikidot-verification/scripts/run-candidate-cases.mjs",
    "install/local/wikidot-verification/src/candidate-browser-contexts.mjs",
    "install/local/wikidot-verification/src/candidate-case-command.mjs",
    "install/local/wikidot-verification/src/candidate-case-http.mjs",
    "install/local/wikidot-verification/src/candidate-case-runner.mjs",
    "install/local/wikidot-verification/src/candidate-source-execution-identity.mjs",
    "install/local/wikidot-verification/src/deepwell-rpc-auth.mjs",
    "install/local/wikidot-verification/src/open43-authoring-history-candidate-case-set.mjs",
    "install/local/wikidot-verification/src/page-edit-lease.mjs",
    "install/local/wikidot-verification/src/standing-browser-parity-receipt.mjs",
    "install/local/wikidot-verification/src/standing-browser-parity-util.mjs",
    "install/local/wikidot-verification/src/standing-browser-runtime-identity.mjs",
    "install/local/wikidot-verification/package.json",
    "install/local/wikidot-verification/pnpm-lock.yaml",
  ])]);
  return Object.freeze({
    id: "open43-authoring-history",
    caseIds: OPEN43_AUTHORING_HISTORY_CASE_IDS,
    prepareRun({ runId, candidateIdentity, privateInput, signal, resources, candidateBrowserContexts }) {
      if (candidateIdentity.candidate.endpoint.host !== SITE_HOST || candidateIdentity.candidate.endpoint.port === 443 || candidateIdentity.candidate.port_443_published !== false) throw new Error(`Open43 history cases require exact non-standing ${SITE_HOST}`);
      const session = sessionFactory({ candidateIdentity, privateInput, signal });
      if (session?.editorUserId !== -1) throw new Error("history candidate session must bind the fixed editor actor");
      if (session.pageOrigin !== candidatePageOrigin(candidateIdentity)) throw new Error("history candidate session did not bind the sealed candidate origin");
      const execution = new Open43AuthoringHistoryRun({ session, browser: candidateBrowserContexts, resources, slug: pageSlug(runId) });
      return Object.freeze({
        sourceFiles,
        runtimeBindings: session.requiredServiceBindings,
        privateInputIdentity: session.privateInputIdentity,
        browserCredentialPolicy: { mode: "private-actor-storage-states", storage_state_count: 3, private_input_identity_sha256: sha256Value(session.privateInputIdentity) },
        plan: {
          schema: "wikijump.open43_authoring_history_candidate_plan.v1",
          site_slug: SITE_SLUG,
          page_slug: pageSlug(runId),
          editor_user_id: -1,
          case_ids: OPEN43_AUTHORING_HISTORY_CASE_IDS,
          public_behavior: "one run-owned page proves typed source and served diff behavior while the session actor settings round-trip and are restored",
          browser: { viewport: VIEWPORT, intervals: ["domcontentloaded_immediate_observation", "settled"] },
          excluded_claims: ["A1063_LEGACY_AUTHORING_PRESENTATION", "A1063_FULL_BREADCRUMB_LIVE_BOUNDARY"],
        },
        execute: () => execution.execute(),
        cleanup: () => execution.cleanup(),
        verifyCase,
        verifyCleanup,
      });
    },
  });
}
