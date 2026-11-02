#!/usr/bin/env node


import {execFile} from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {fileURLToPath} from "node:url";
import {promisify} from "node:util";

import {
  acquireBrowserCaptureLock,
  createBrowserResponseCache,
  createPersistentBrowserRequestGate,
  defaultPublicEvidenceResponseCacheOptions,
  installBrowserRequestGate,
} from "../src/browser-request-gate.mjs";
import {startCaptureEgressProxy} from "../src/capture-egress-proxy.mjs";
import {browserContextOptions, defaultBrowserRoot, loadPlaywright} from "../src/browser-session.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const VERIFIER_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_OUTPUT = path.join(VERIFIER_ROOT, "artifacts/userinfo-tab-switching-live-20261022.json");
const DEFAULT_BROWSER_EXECUTABLE = "/usr/bin/google-chrome";
const PUBLIC_ORIGIN = "https://www.wikidot.com";
const REQUEST_INTERVAL_MS = 4000;
const SETTLE_MS = 2000;
const NETWORK_IDLE_TIMEOUT_MS = 20000;
const NAVIGATION_TIMEOUT_MS = 60000;
const TAB_IDS = Object.freeze(["ui-profile-b", "ui-member-b", "ui-moderator-b", "ui-admin-b", "ui-contrib-b", "ui-posts-b"]);
const TARGETS = Object.freeze([
  {target_id: "dr-clef", route_target: "dr-clef", public_user_id: 1698600},
  {target_id: "the-administrator", route_target: "the-administrator", public_user_id: 169306},
]);
const SECRET_PATTERN = /wikidot_token7|WIKIDOT_SESSION_ID|set-cookie|authorization|\bcsrf\b/iu;

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function normalize(value) {
  return value.replace(/([?&](?:amp;)?timestamp=)\d+/giu, "$1[TIMESTAMP]");
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseArgs(argv) {
  const args = {
    output: DEFAULT_OUTPUT,
    browserExecutable: DEFAULT_BROWSER_EXECUTABLE,
    runId: `userinfo-tab-switching-${Date.now()}`,
    target: null,
    tab: null,
  };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${key} requires a value`);
    if (key === "--output") args.output = path.resolve(value);
    else if (key === "--browser-executable") args.browserExecutable = path.resolve(value);
    else if (key === "--run-id") args.runId = value;
    else if (key === "--target") args.target = value;
    else if (key === "--tab") args.tab = value;
    else throw new Error(`Unknown argument: ${key}`);
  }
  if (args.target !== null && !TARGETS.some((item) => item.target_id === args.target)) throw new Error(`unknown --target ${args.target}`);
  if (args.tab !== null && !TAB_IDS.includes(args.tab)) throw new Error(`unknown --tab ${args.tab}`);
  return args;
}

const SNAPSHOT_SCRIPT = () => {
  const style = (element) => {
    if (!element) return {present: false};
    const computed = getComputedStyle(element);
    return {present: true, display: computed.display, visibility: computed.visibility};
  };
  const redactedHtml = (element) => {
    if (!element) return null;
    const clone = element.cloneNode(true);
    for (const script of clone.querySelectorAll("script")) {
      script.textContent = "";
      script.setAttribute("data-redacted", "script-body-not-retained");
    }
    return clone.outerHTML;
  };
  const root = document.querySelector("#page-content");
  const userInfoArea = document.querySelector("#user-info-area");
  return {
    url: location.href,
    history_length: history.length,
    page_content_html: redactedHtml(root),
    active_tab_ids: [...document.querySelectorAll("#ui-tabs > li.active > a")].map((anchor) => anchor.id),
    tabs: [...document.querySelectorAll("#ui-tabs > li")].map((item) => {
      const anchor = item.querySelector("a");
      return {
        li_class: item.getAttribute("class"),
        anchor_id: anchor ? anchor.id : null,
        anchor_href: anchor ? anchor.getAttribute("href") : null,
        anchor_label: anchor ? anchor.textContent.trim() : null,
      };
    }),
    col_md_3: style(document.querySelector("#page-content > .col-md-3")),
    col_md_9: style(document.querySelector("#page-content > .col-md-9")),
    user_info_area_html: redactedHtml(userInfoArea),
    body_html: redactedHtml(document.body),
    focused_element_id: document.activeElement ? document.activeElement.id || null : null,
  };
};

async function snapshot(page) {
  const raw = await page.evaluate(SNAPSHOT_SCRIPT);
  if (raw.page_content_html === null) throw new Error("page has no #page-content region");
  return {
    ...raw,
    page_content_sha256: sha256(raw.page_content_html),
    page_content_normalized_sha256: sha256(normalize(raw.page_content_html)),
    user_info_area_sha256: raw.user_info_area_html === null ? null : sha256(raw.user_info_area_html),
    body_sha256: raw.body_html === null ? null : sha256(raw.body_html),
  };
}

async function browserIdentity(executable) {
  const {stdout} = await execFileAsync(executable, ["--version"]);
  const resolved = await fs.realpath(executable);
  const bytes = await fs.readFile(resolved);
  return {
    executable,
    resolved_executable: resolved,
    resolved_executable_sha256: sha256(bytes),
    version: stdout.trim(),
  };
}

async function clickTab(page, tabId) {
  const anchor = page.locator(`#${tabId}`);
  await anchor.evaluate((element) => element.scrollIntoView({block: "center", inline: "nearest"}));
  const point = await anchor.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      x,
      y,
      hit_is_target: hit !== null && (hit === element || element.contains(hit)),
      hit_tag: hit ? hit.tagName.toLowerCase() : null,
      hit_id: hit ? hit.id || null : null,
      hit_class: hit && typeof hit.className === "string" ? hit.className : null,
    };
  });
  if (point.hit_is_target) {
    await page.mouse.click(point.x, point.y);
    return {selector: `#${tabId}`, method: "mouse-click", overlay: null};
  }
  await anchor.evaluate((element) => element.click());
  return {
    selector: `#${tabId}`,
    method: "dom-click",
    overlay: {hit_tag: point.hit_tag, hit_id: point.hit_id, hit_class: point.hit_class},
  };
}

async function captureState(context, {target, actionTabId}) {
  const url = `${PUBLIC_ORIGIN}/user:info/${target.route_target}`;
  const page = await context.newPage();
  const requests = [];
  const responseSettlements = [];
  const consoleMessages = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleMessages.push({type: message.type(), text: message.text().slice(0, 300)});
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push({message: errorMessage(error).slice(0, 300)});
  });
  page.on("request", (request) => {
    const entry = {method: request.method(), url: request.url(), resource_type: request.resourceType(), status: null};
    requests.push(entry);
    responseSettlements.push(
      request.response().then(
        (response) => {
          entry.status = response ? response.status() : null;
        },
        () => {
          entry.status = "no-response";
        },
      ),
    );
  });
  const state = {
    target_id: target.target_id,
    state_id: actionTabId ?? "initial",
    action: actionTabId ? {kind: "click", selector: `#${actionTabId}`} : null,
    requested_url: url,
    navigation_status: null,
    capture_error: null,
  };
  try {
    const response = await page.goto(url, {waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS});
    state.navigation_status = response ? response.status() : null;
    await page.waitForSelector("#ui-tabs", {timeout: 30000});
    await page.waitForTimeout(SETTLE_MS);
    state.before = await snapshot(page);
    const loadMark = requests.length;
    const consoleMark = consoleMessages.length;
    const pageErrorMark = pageErrors.length;
    if (actionTabId) {
      state.click = await clickTab(page, actionTabId);
      await page.waitForTimeout(SETTLE_MS);
      state.settle_network_idle_timed_out = await page
        .waitForLoadState("networkidle", {timeout: NETWORK_IDLE_TIMEOUT_MS})
        .then(() => false, () => true);
      state.after = await snapshot(page);
    } else {
      state.click = null;
      state.after = null;
      state.settle_network_idle_timed_out = null;
    }
    state.requests_during_load = requests.slice(0, loadMark);
    state.requests_after_action = actionTabId ? requests.slice(loadMark) : [];
    state.console_during_load = consoleMessages.slice(0, consoleMark);
    state.console_after_action = actionTabId ? consoleMessages.slice(consoleMark) : [];
    state.page_errors_during_load = pageErrors.slice(0, pageErrorMark);
    state.page_errors_after_action = actionTabId ? pageErrors.slice(pageErrorMark) : [];
  } catch (error) {
    state.capture_error = errorMessage(error);
  } finally {
    await page.close().catch(() => {});
    await Promise.all(responseSettlements);
  }
  return state;
}

const ALLOWED_PUBLIC_PREFIXES = Object.freeze([
  {host: "d3g0gp89917ko0.cloudfront.net", pathPrefix: "/v--c5ce02208cf9/"},
  {host: "www.wdfiles.com", pathPrefix: "/local--theme/"},
  {host: "www.wdfiles.com", pathPrefix: "/common--theme/"},
]);

function allowedPublicRequest(url) {
  if (url.protocol !== "https:") return false;
  if (url.hostname === "wikidot.com" || url.hostname === "www.wikidot.com" || url.hostname.endsWith(".wikidot.com")) return true;
  return ALLOWED_PUBLIC_PREFIXES.some(({host, pathPrefix}) => url.hostname === host && url.pathname.startsWith(pathPrefix));
}

const SEQUENCE_TABS = Object.freeze(["ui-member-b", "ui-moderator-b", "ui-profile-b"]);

async function captureSequence(context, target) {
  const url = `${PUBLIC_ORIGIN}/user:info/${target.route_target}`;
  const page = await context.newPage();
  const requests = [];
  const responseSettlements = [];
  page.on("request", (request) => {
    const entry = {method: request.method(), url: request.url(), resource_type: request.resourceType(), status: null};
    requests.push(entry);
    responseSettlements.push(
      request.response().then(
        (response) => {
          entry.status = response ? response.status() : null;
        },
        () => {
          entry.status = "no-response";
        },
      ),
    );
  });
  const sequence = {
    target_id: target.target_id,
    requested_url: url,
    tabs: [...SEQUENCE_TABS],
    navigation_status: null,
    capture_error: null,
    initial: null,
    steps: [],
  };
  try {
    const response = await page.goto(url, {waitUntil: "load", timeout: NAVIGATION_TIMEOUT_MS});
    sequence.navigation_status = response ? response.status() : null;
    await page.waitForSelector("#ui-tabs", {timeout: 30000});
    await page.waitForTimeout(SETTLE_MS);
    sequence.initial = await snapshot(page);
    for (const tabId of SEQUENCE_TABS) {
      const mark = requests.length;
      const click = await clickTab(page, tabId);
      await page.waitForTimeout(SETTLE_MS);
      const idleTimedOut = await page
        .waitForLoadState("networkidle", {timeout: NETWORK_IDLE_TIMEOUT_MS})
        .then(() => false, () => true);
      sequence.steps.push({
        tab_id: tabId,
        click,
        settle_network_idle_timed_out: idleTimedOut,
        after: await snapshot(page),
        requests_after_action: requests.slice(mark),
      });
    }
  } catch (error) {
    sequence.capture_error = errorMessage(error);
  } finally {
    await page.close().catch(() => {});
    await Promise.all(responseSettlements);
  }
  return sequence;
}

function sortedBlocked(blocked) {
  return [...blocked.entries()]
    .map(([request, count]) => ({request, count}))
    .sort((left, right) => (left.request < right.request ? -1 : left.request > right.request ? 1 : 0));
}

async function runCapture(args, lock) {
  const states = [];
  const sequences = [];
  const blockedThirdParty = new Map();
  const uncertainRefusals = new Map();
  let runError = null;
  let gate = null;
  let responseCache = null;
  let proxy = null;
  let browser = null;
  const onUnhandledRejection = (error) => {
    const match = /uncertain prior acquisition: (\S+)/u.exec(errorMessage(error));
    if (match === null) throw error;
    uncertainRefusals.set(match[1], (uncertainRefusals.get(match[1]) ?? 0) + 1);
  };
  process.on("unhandledRejection", onUnhandledRejection);
  try {
    gate = await createPersistentBrowserRequestGate({statePath: lock.statePath, intervalMs: REQUEST_INTERVAL_MS});
    responseCache = createBrowserResponseCache(defaultPublicEvidenceResponseCacheOptions());
    await responseCache.load();
    proxy = await startCaptureEgressProxy();
    const {chromium} = loadPlaywright(defaultBrowserRoot());
    browser = await chromium.launch({executablePath: args.browserExecutable, headless: true});
    const context = await browser.newContext(
      browserContextOptions({ignoreHttpsErrors: false, proxyServer: proxy.url, blockServiceWorkers: true}),
    );
    await installBrowserRequestGate(context, {gate, responseCache});
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.protocol === "data:" || url.protocol === "blob:" || allowedPublicRequest(url)) return route.fallback();
      const key = `${request.method()} ${url.origin}${url.pathname}`;
      blockedThirdParty.set(key, (blockedThirdParty.get(key) ?? 0) + 1);
      return route.abort("blockedbyclient");
    });
    const selectedTargets = TARGETS.filter((item) => args.target === null || item.target_id === args.target);
    const selectedTabs = args.tab === null ? TAB_IDS : [args.tab];
    for (const target of selectedTargets) {
      for (const actionTabId of [null, ...selectedTabs]) {
        const state = await captureState(context, {target, actionTabId});
        states.push(state);
        process.stderr.write(
          `${state.target_id} ${state.state_id}: status=${state.navigation_status} active=${JSON.stringify(state.after?.active_tab_ids ?? state.before?.active_tab_ids ?? null)} error=${state.capture_error ?? "none"}\n`,
        );
      }
    }
    if (args.tab === null) {
      for (const target of selectedTargets) {
        sequences.push(await captureSequence(context, target));
      }
    }
    await context.close();
  } catch (error) {
    runError = errorMessage(error);
  } finally {
    await browser?.close().catch(() => {});
    await proxy?.close().catch(() => {});
    process.off("unhandledRejection", onUnhandledRejection);
  }
  if (gate !== null) await gate.flush();
  if (responseCache !== null) await responseCache.flush();
  return {
    states,
    sequences,
    runError,
    blockedThirdParty: sortedBlocked(blockedThirdParty),
    uncertainRefusals: sortedBlocked(uncertainRefusals),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const identity = await browserIdentity(args.browserExecutable);
  const lock = await acquireBrowserCaptureLock({runId: args.runId});
  const {states, sequences, runError, blockedThirdParty, uncertainRefusals} = await runCapture(args, lock);
  await lock.confirmState();
  await lock.release();

  const artifact = {
    schema: "wikijump.userinfo_tab_switching.live_evidence.v1",
    captured_at: new Date().toISOString(),
    public_interface: `GET ${PUBLIC_ORIGIN}/user:info/<target>`,
    actor: {actor_id: "anonymous", authenticated: false},
    mutated: false,
    form_submissions: 0,
    interactions_allowed: TAB_IDS.map((id) => `#${id}`),
    browser: identity,
    policy: {
      request_interval_ms: REQUEST_INTERVAL_MS,
      settle_ms: SETTLE_MS,
      response_cache_identity: defaultPublicEvidenceResponseCacheOptions().persistentIdentity,
      cache_first: true,
      one_page_load_per_state: true,
      clicks_per_state: 1,
      body_html_retained: true,
      script_bodies_retained: false,
    },
    targets: TARGETS,
    selection: {target: args.target, tab: args.tab},
    third_party_policy: {
      rule: "requests outside allowed_public_prefixes are aborted before the request gate; data: and blob: pass through; allowed requests pass to the gate",
      allowed_public_prefixes: ALLOWED_PUBLIC_PREFIXES.map(({host, pathPrefix}) => `https://${host}${pathPrefix}`).concat(["https://*.wikidot.com/"]),
      blocked_requests: blockedThirdParty,
    },
    uncertain_acquisition_refusals: uncertainRefusals,
    run_error: runError,
    states,
    sequences,
  };
  const text = `${JSON.stringify(artifact, null, 2)}\n`;
  if (SECRET_PATTERN.test(text)) throw new Error("captured artifact matched a credential pattern; not written");
  await fs.mkdir(path.dirname(args.output), {recursive: true});
  await fs.writeFile(args.output, text, {flag: "wx"});
  const failed = states.filter((state) => state.capture_error !== null);
  process.stdout.write(
    `wrote ${states.length} states to ${args.output}; state errors: ${failed.length}; run error: ${runError ?? "none"}\n`,
  );
  const failedSequences = sequences.filter((sequence) => sequence.capture_error !== null);
  if (runError !== null || failed.length > 0 || failedSequences.length > 0) process.exitCode = 1;
}

await main();
