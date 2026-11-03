import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CandidateHttpSession } from "./candidate-case-http.mjs";
import { leasedPageEdit } from "./page-edit-lease.mjs";
import { candidatePageOrigin } from "./standing-browser-parity-receipt.mjs";
import { STANDING_BROWSER_EXECUTION_MODULES } from "./standing-browser-execution-identity.mjs";
import { sha256Value } from "./standing-browser-parity-util.mjs";
import { findWikijumpIdentifiers } from "./wikijump-identifier-leak.mjs";

export const OPEN43_Q1027_CASE_IDS = Object.freeze([
  "Q1027_RENAME_DELETE_RESTORE_CACHE_AND_SERVED_CANDIDATE",
]);

const SITE_SLUG = "scpaiueouiuiuiui";
const SITE_HOST = `${SITE_SLUG}.wikijump.localhost`;
const LIVE_EVIDENCE = Object.freeze({
  path: "install/local/wikidot-verification/artifacts/navigation-list-modules-live.json",
  sha256: "07228f5618e06dba6cf90779bcd0bd2bcd834c1bc4a3a141f4528135fe4da5b1",
  default_case: "backlinks-default-current-page",
  page_argument_case: "backlinks-page-argument-ignored",
});
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const LIVE_FIXTURE = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, LIVE_EVIDENCE.path), "utf8"));
const DEFAULT_CAPTURE = LIVE_FIXTURE.cases.find(({ case_id: caseId }) => caseId === LIVE_EVIDENCE.default_case);
const PAGE_ARGUMENT_CAPTURE = LIVE_FIXTURE.cases.find(({ case_id: caseId }) => caseId === LIVE_EVIDENCE.page_argument_case);
if (!DEFAULT_CAPTURE || !PAGE_ARGUMENT_CAPTURE) throw new Error("source-owned Backlinks live fixture is missing its default or page-argument case");
const INLINE_LITERAL = "\nstart-[[module Backlinks]]-middle\n";
const EMPTY_BOX = "\n<div class=\"backlinks-module-box\">\n</div>\n";

const CAPTURE_CONTRACT = Object.freeze({
  slug: "q1027-backlinks",
  theme_family: "wikidot",
  geometry_selectors: [],
  presence_probes: [],
});

function liveBox(snippet) {
  const contentStart = snippet.indexOf("</p>") + 4;
  const finish = snippet.indexOf("\n<p>", contentStart);
  if (contentStart < 4 || finish < 0) throw new Error("Backlinks live snippet does not delimit one module box");
  return snippet.slice(contentStart, finish);
}

function boxRows(box) {
  return [...box.matchAll(/<li>\s*<a href="\/?([^"]+)">([^<]+)<\/a>\s*<\/li>/gu)].map(([, slug, title]) => ({ slug, title }));
}

function populatedBoxHtml(rows) {
  const items = rows.map(({ slug, title }) => `\t\t\t\t\t\t\t<li>\n\t\t\t\t\t<a href="/${slug}">${title}</a>\n\t\t\t\t</li>`).join("\n");
  return `<div class="backlinks-module-box">\n\t\t\t<ul>\n${items}\n\t\t\t\t\t</ul>\n\t</div>`;
}

function expectedPopulatedBox(rows) {
  return `\n${populatedBoxHtml(rows)}`;
}

function normalizeIntertagWhitespace(value) {
  return value.replace(/>\s+</gu, "><").trim();
}

{
  const defaultBox = liveBox(DEFAULT_CAPTURE.html_snippet);
  const rows = boxRows(defaultBox);
  if (rows.length !== 2) throw new Error("Backlinks live default case must contain two rows");
  if (expectedPopulatedBox(rows) !== defaultBox) throw new Error("source-owned Backlinks live fixture no longer matches the candidate box template");
  if (liveBox(PAGE_ARGUMENT_CAPTURE.html_snippet) !== defaultBox) throw new Error("Backlinks live page-argument case no longer renders the same rows as the default case");
}

const SOURCE_FILES = Object.freeze([...new Set([
  ...STANDING_BROWSER_EXECUTION_MODULES,
  "deepwell/tests/page.rs",
  "docs/development/open43-q-page-query-closure-audit.json",
  "docs/wikidot-specifications/specifications/module/module-backlinks.md",
  LIVE_EVIDENCE.path,
  "install/local/wikidot-verification/scripts/run-candidate-cases.mjs",
  "install/local/wikidot-verification/src/browser-render-evidence.mjs",
  "install/local/wikidot-verification/src/candidate-browser-contexts.mjs",
  "install/local/wikidot-verification/src/candidate-case-command.mjs",
  "install/local/wikidot-verification/src/candidate-case-http.mjs",
  "install/local/wikidot-verification/src/candidate-case-runner.mjs",
  "install/local/wikidot-verification/src/deepwell-rpc-auth.mjs",
  "install/local/wikidot-verification/src/open43-q1027-candidate-case-set.mjs",
  "install/local/wikidot-verification/src/page-edit-lease.mjs",
  "install/local/wikidot-verification/src/wikijump-identifier-leak.mjs",
  "install/local/wikidot-verification/package.json",
  "install/local/wikidot-verification/pnpm-lock.yaml",
])]);

function pageSlug(runId, role) {
  return `open43-q1027-${runId.slice("candidate-run-".length)}-${role}`;
}

function requireCandidateSite(candidateIdentity) {
  if (candidateIdentity.candidate.endpoint.host !== SITE_HOST) throw new Error(`Q1027 candidate requires exact ${SITE_HOST}`);
}

function section(html, start, end) {
  const begin = html.indexOf(start);
  if (begin < 0) throw new Error(`Q1027 output is missing ${start}`);
  let contentStart = begin + start.length;
  for (const boundary of ["</p>", "<br>\n", "<br>"]) {
    if (html.startsWith(boundary, contentStart)) {
      contentStart += boundary.length;
      break;
    }
  }
  const finish = html.indexOf(end, contentStart);
  if (finish < 0) throw new Error(`Q1027 output is missing ${end}`);
  let contentEnd = finish;
  for (const boundary of ["<p>", "<br>\n", "<br>"]) {
    if (html.slice(contentStart, contentEnd).endsWith(boundary)) {
      contentEnd -= boundary.length;
      break;
    }
  }
  return html.slice(contentStart, contentEnd);
}

function foundHtml(value) {
  if (value?.type !== "found" || typeof value.data?.compiled_body_html !== "string") throw new Error("Q1027 page_view did not return a found compiled body");
  return value.data.compiled_body_html;
}

class Open43Q1027Run {
  #session;
  #browserContexts;
  #resources;
  #siteId = null;
  #pages;
  #pageResources = new Map();

  constructor({ session, browserContexts, resources, runId }) {
    const fixtureId = runId.slice("candidate-run-".length);
    this.#session = session;
    this.#browserContexts = browserContexts;
    this.#resources = resources;
    this.#pages = [
      { role: "target", slug: pageSlug(runId, "target"), title: `AAA Q1027 ${fixtureId} target`, wikitext: targetSource() },
      { role: "linker-a", slug: pageSlug(runId, "linker-a"), title: `AAB Q1027 ${fixtureId} linker A`, wikitext: `[[[${pageSlug(runId, "target")}]]]` },
      { role: "linker-b", slug: pageSlug(runId, "linker-b"), title: `AAC Q1027 ${fixtureId} linker B`, wikitext: "Q1027 linker B has no target link yet." },
      { role: "control", slug: pageSlug(runId, "control"), title: `ZZZ Q1027 ${fixtureId} control`, wikitext: "Q1027_CONTROL_START\n[[module Backlinks]]\nQ1027_CONTROL_END" },
    ];
  }

  #target() { return this.#pages[0]; }
  #linkerA() { return this.#pages[1]; }
  #linkerB() { return this.#pages[2]; }
  #control() { return this.#pages[3]; }

  async #rpc(method, params = {}, { actor = "editor", page, cleanup = false } = {}) {
    return await this.#session.rpc(method, params, { actor, siteId: this.#siteId ?? undefined, page, cleanup });
  }

  async #getPage(entry, { cleanup = false } = {}) {
    return await this.#rpc("page_get", { site_id: this.#siteId, page: entry.slug, details: { wikitext: true, compiled: false } }, { cleanup, page: entry.slug });
  }

  #matches(entry, page) {
    return page?.page_id !== undefined && page.slug === entry.slug && page.title === entry.title && page.wikitext === entry.wikitext;
  }

  async #create(entry) {
    const page = await this.#rpc("page_create", {
      site_id: this.#siteId,
      slug: entry.slug,
      title: entry.title,
      alt_title: null,
      wikitext: entry.wikitext,
      layout: "wikidot",
      user_id: this.#session.editorUserId,
      ip_address: "127.0.0.1",
      tags: [],
      revision_comments: "Open43 Q1027 candidate fixture",
    }, { page: entry.slug });
    if (!Number.isSafeInteger(page?.page_id) || !Number.isSafeInteger(page.revision_id) || page.slug !== entry.slug) throw new Error(`Q1027 ${entry.role} page_create did not return its public identity`);
    const observed = await this.#getPage(entry);
    if (!this.#matches(entry, observed) || observed.page_id !== page.page_id || observed.revision_id !== page.revision_id) throw new Error(`Q1027 ${entry.role} page_get did not confirm its exact public identity`);
    entry.page_id = observed.page_id;
    entry.revision_id = observed.revision_id;
    this.#pageResources.set(entry.slug, this.#resources.register("page", { page_id: observed.page_id, revision_id: observed.revision_id, slug: entry.slug }));
  }

  async #view(actor) {
    const target = this.#target();
    const value = await this.#rpc("page_view", {
      site_id: this.#siteId,
      session_token: actor === "editor" ? this.#session.editorSessionToken : null,
      route: { slug: target.slug, extra: "" },
      locales: ["en-US", "en"],
    }, { actor, page: target.slug });
    const html = foundHtml(value);
    const defaultBox = section(html, "Q1027_DEFAULT_START", "Q1027_DEFAULT_END");
    return {
      default_box: defaultBox,
      page_arg_box: section(html, "Q1027_PAGE_ARG_START", "Q1027_PAGE_ARG_END"),
      inline: section(html, "Q1027_INLINE_START", "Q1027_INLINE_END"),
      rows: boxRows(defaultBox),
    };
  }

  async #controlBox(actor = "anonymous") {
    const control = this.#control();
    const value = await this.#rpc("page_view", {
      site_id: this.#siteId,
      session_token: actor === "editor" ? this.#session.editorSessionToken : null,
      route: { slug: control.slug, extra: "" },
      locales: ["en-US", "en"],
    }, { actor, page: control.slug });
    return section(foundHtml(value), "Q1027_CONTROL_START", "Q1027_CONTROL_END");
  }

  async #savedBodyHash() {
    const target = await this.#rpc("page_get", {
      site_id: this.#siteId,
      page: this.#target().slug,
      details: { wikitext: true, compiled: true },
    }, { actor: "anonymous", page: this.#target().slug });
    if (typeof target?.compiled_body_html !== "string") throw new Error("Q1027 saved compiled body is unavailable at the public seam");
    return sha256Value(target.compiled_body_html);
  }

  #assertView(view, rows, name) {
    if (JSON.stringify(view.rows) !== JSON.stringify(rows)) throw new Error(`Q1027 ${name} rows drifted`);
    if (normalizeIntertagWhitespace(view.default_box) !== normalizeIntertagWhitespace(expectedPopulatedBox(rows))) throw new Error(`Q1027 ${name} default box drifted`);
    if (normalizeIntertagWhitespace(view.page_arg_box) !== normalizeIntertagWhitespace(view.default_box)) throw new Error(`Q1027 ${name} page-argument module drifted`);
    if (view.inline.trim() !== INLINE_LITERAL.trim()) throw new Error(`Q1027 ${name} inline module crossed its literal boundary`);
  }

  async execute() {
    const site = await this.#session.rpc("site_get", { site: SITE_SLUG });
    if (!Number.isSafeInteger(site?.site_id)) throw new Error(`editable candidate site ${SITE_SLUG} is missing`);
    this.#siteId = site.site_id;
    for (const entry of this.#pages) if (await this.#getPage(entry) !== null) throw new Error(`Q1027 run-owned page already exists: ${entry.slug}`);
    for (const entry of this.#pages) await this.#create(entry);

    const target = this.#target();
    const linkerA = this.#linkerA();
    const linkerB = this.#linkerB();
    const savedBefore = await this.#savedBodyHash();
    const controlBefore = await this.#controlBox();

    const initial = await this.#view("anonymous");
    this.#assertView(initial, [{ slug: linkerA.slug, title: linkerA.title }], "initial anonymous");
    const editorInitial = await this.#view("editor");
    this.#assertView(editorInitial, [{ slug: linkerA.slug, title: linkerA.title }], "initial editor");
    if (JSON.stringify(editorInitial.rows) !== JSON.stringify(initial.rows)) throw new Error("Q1027 editor and anonymous rows diverged");

    const linkEdit = await leasedPageEdit(
      (method, params) => this.#rpc(method, params, { page: linkerB.slug }),
      {
        site_id: this.#siteId,
        page: linkerB.slug,
        last_revision_id: linkerB.revision_id,
        revision_comments: "Open43 Q1027 Backlinks link edit",
        user_id: this.#session.editorUserId,
        wikitext: `[[[${target.slug}]]]`,
        ip_address: "127.0.0.1",
      },
    );
    if (!Number.isSafeInteger(linkEdit?.revision_id)) throw new Error("Q1027 link edit did not return a public revision");
    linkerB.wikitext = `[[[${target.slug}]]]`;
    linkerB.revision_id = linkEdit.revision_id;
    const afterEdit = await this.#view("anonymous");
    this.#assertView(afterEdit, [{ slug: linkerA.slug, title: linkerA.title }, { slug: linkerB.slug, title: linkerB.title }], "after link edit");

    const renamedTitle = `AAA Q1027 renamed ${linkerA.title}`;
    const rename = await this.#rpc("page_edit", {
      site_id: this.#siteId,
      page: linkerA.slug,
      last_revision_id: linkerA.revision_id,
      revision_comments: "Open43 Q1027 Backlinks rename",
      user_id: this.#session.editorUserId,
      title: renamedTitle,
      ip_address: "127.0.0.1",
    }, { page: linkerA.slug });
    if (!Number.isSafeInteger(rename?.revision_id)) throw new Error("Q1027 rename did not return a public revision");
    linkerA.title = renamedTitle;
    linkerA.revision_id = rename.revision_id;
    const afterRename = await this.#view("anonymous");
    this.#assertView(afterRename, [{ slug: linkerA.slug, title: renamedTitle }, { slug: linkerB.slug, title: linkerB.title }], "after rename");

    const beforeDelete = await this.#getPage(linkerA);
    await this.#rpc("page_delete", {
      site_id: this.#siteId,
      page: beforeDelete.page_id,
      last_revision_id: beforeDelete.revision_id,
      revision_comments: "Open43 Q1027 Backlinks delete",
      user_id: this.#session.editorUserId,
      ip_address: "127.0.0.1",
    }, { page: linkerA.slug });
    const afterDelete = await this.#view("anonymous");
    this.#assertView(afterDelete, [{ slug: linkerB.slug, title: linkerB.title }], "after delete");
    if (afterDelete.default_box.includes(linkerA.slug) || afterDelete.default_box.includes(renamedTitle)) throw new Error("Q1027 deleted linker leaked a title or slug");

    await this.#rpc("page_restore", {
      site_id: this.#siteId,
      page_id: linkerA.page_id,
      revision_comments: "Open43 Q1027 Backlinks restore",
      user_id: this.#session.editorUserId,
      slug: linkerA.slug,
      ip_address: "127.0.0.1",
    }, { page: linkerA.slug });
    const restored = await this.#getPage(linkerA);
    if (!restored) throw new Error("Q1027 restore did not make the linker publicly readable");
    linkerA.revision_id = restored.revision_id;
    const afterRestore = await this.#view("anonymous");
    this.#assertView(afterRestore, [{ slug: linkerA.slug, title: renamedTitle }, { slug: linkerB.slug, title: linkerB.title }], "after restore");

    const controlAfter = await this.#controlBox();
    if (normalizeIntertagWhitespace(controlBefore) !== normalizeIntertagWhitespace(EMPTY_BOX) || normalizeIntertagWhitespace(controlAfter) !== normalizeIntertagWhitespace(EMPTY_BOX)) throw new Error("Q1027 cache-isolation control drifted across the mutation lifecycle");
    const savedAfter = await this.#savedBodyHash();
    if (savedAfter !== savedBefore) throw new Error("Q1027 public reads changed the saved target body");

    const browser = await this.#browserContexts.newCandidateContext();
    const page = await browser.context.newPage();
    const url = new URL(`/${encodeURIComponent(target.slug)}`, this.#session.pageOrigin).href;
    try {
      const capture = await this.#browserContexts.captureCandidateObservation({
        context: browser.context,
        page,
        url,
        label: CAPTURE_CONTRACT.slug,
        index: 1,
        contract: CAPTURE_CONTRACT,
        viewport: { width: 1280, height: 900 },
        timeoutMs: 30_000,
        settleMs: 0,
      });
      const served = await page.evaluate(() => {
        const content = document.querySelector("#page-content");
        const boxes = [...content.children].filter((node) => node.matches("div.backlinks-module-box"));
        const html = boxes.map((node) => node.outerHTML).join("");
        return {
          url: location.href,
          default_box: boxes[0]?.outerHTML ?? null,
          page_arg_box: boxes[1]?.outerHTML ?? null,
          default_box_count: boxes.length >= 1 ? 1 : 0,
          page_arg_box_count: boxes.length >= 2 ? 1 : 0,
          total_box_count: boxes.length,
          compat_markers: html.match(/data-wikijump-compat-[^= ]+/gu) ?? [],
        };
      });
      return [{
        case_id: OPEN43_Q1027_CASE_IDS[0],
        observations: {
          url,
          capture,
          served,
          lifecycle: { initial, editor_initial: editorInitial, after_edit: afterEdit, after_rename: afterRename, after_delete: afterDelete, after_restore: afterRestore, control_before: controlBefore, control_after: controlAfter },
          saved_body_sha256: { before: savedBefore, after: savedAfter },
          adapter_events: this.#session.events,
          event_scope: "adapter-issued-external-requests-only",
        },
      }];
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async cleanup() {
    const pages = [];
    const failures = [];
    for (const entry of [...this.#pages].reverse()) {
      try {
        const page = await this.#getPage(entry, { cleanup: true });
        if (page !== null && !this.#matches(entry, page)) throw new Error(`Q1027 cleanup refused an unowned page: ${entry.slug}`);
        if (page !== null) await this.#rpc("page_delete", { site_id: this.#siteId, page: page.page_id, last_revision_id: page.revision_id, revision_comments: "Open43 Q1027 candidate cleanup", user_id: this.#session.editorUserId, ip_address: "127.0.0.1" }, { cleanup: true });
        const pageAfter = await this.#getPage(entry, { cleanup: true });
        const publicAfter = await this.#session.pageRequest(entry.slug, { cleanup: true, operation: `q1027-cleanup-${entry.role}` });
        if (pageAfter !== null || publicAfter.status !== 404) throw new Error(`Q1027 cleanup did not prove public absence: ${entry.slug}`);
        const token = this.#pageResources.get(entry.slug);
        if (token) this.#resources.release(token, { page_get: null, public_status: publicAfter.status });
        pages.push({ role: entry.role, page_get: null, public_status: publicAfter.status });
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) throw new AggregateError(failures, "Q1027 public cleanup failed");
    return { pages: pages.reverse() };
  }

  verifyCase(caseId, observations) {
    if (caseId !== OPEN43_Q1027_CASE_IDS[0]) throw new Error(`unsupported Q1027 case: ${caseId}`);
    const capture = observations.capture;
    if (capture?.navigation_status !== 200 || capture.input_url !== observations.url || capture.final_url !== observations.url || !Array.isArray(capture.failures) || capture.failures.length !== 0 || Object.hasOwn(capture, "capture_error")) throw new Error("Q1027 served capture was not a clean HTTP 200");
    const served = observations.served;
    const expectedRows = [{ slug: this.#linkerA().slug, title: this.#linkerA().title }, { slug: this.#linkerB().slug, title: this.#linkerB().title }];
    const expectedBox = populatedBoxHtml(expectedRows);
    if (normalizeIntertagWhitespace(served.default_box) !== normalizeIntertagWhitespace(expectedBox) || normalizeIntertagWhitespace(served.page_arg_box) !== normalizeIntertagWhitespace(expectedBox) || served.default_box_count !== 1 || served.page_arg_box_count !== 1 || served.total_box_count !== 2) throw new Error("Q1027 served DOM did not expose the exact Backlinks boxes");
    if (served.compat_markers.length !== 0 || findWikijumpIdentifiers(`${served.default_box}${served.page_arg_box}`).length !== 0) throw new Error("Q1027 served DOM leaked internal identifiers");
    const lifecycle = observations.lifecycle;
    this.#assertView(lifecycle.initial, [{ slug: this.#linkerA().slug, title: lifecycle.initial.rows[0].title }], "verified initial");
    if (lifecycle.initial.inline.trim() !== INLINE_LITERAL.trim()) throw new Error("Q1027 verified initial inline module crossed its literal boundary");
    if (JSON.stringify(lifecycle.editor_initial.rows) !== JSON.stringify(lifecycle.initial.rows)) throw new Error("Q1027 verified editor rows diverged from anonymous rows");
    if (JSON.stringify(lifecycle.after_edit.rows) !== JSON.stringify([{ slug: this.#linkerA().slug, title: lifecycle.after_edit.rows[0].title }, { slug: this.#linkerB().slug, title: this.#linkerB().title }]) || normalizeIntertagWhitespace(lifecycle.after_edit.default_box) !== normalizeIntertagWhitespace(expectedPopulatedBox(lifecycle.after_edit.rows))) throw new Error("Q1027 link edit was not bound to the next public read");
    if (JSON.stringify(lifecycle.after_rename.rows) !== JSON.stringify(expectedRows) || normalizeIntertagWhitespace(lifecycle.after_rename.default_box) !== normalizeIntertagWhitespace(expectedPopulatedBox(expectedRows))) throw new Error("Q1027 rename was not bound to the next public read");
    if (JSON.stringify(lifecycle.after_delete.rows) !== JSON.stringify([{ slug: this.#linkerB().slug, title: this.#linkerB().title }]) || lifecycle.after_delete.default_box.includes(this.#linkerA().slug) || lifecycle.after_delete.default_box.includes(this.#linkerA().title)) throw new Error("Q1027 delete did not remove the linker row from the next public read");
    if (JSON.stringify(lifecycle.after_restore.rows) !== JSON.stringify(expectedRows) || normalizeIntertagWhitespace(lifecycle.after_restore.default_box) !== normalizeIntertagWhitespace(expectedPopulatedBox(expectedRows))) throw new Error("Q1027 restore was not bound to the next public read");
    if (normalizeIntertagWhitespace(lifecycle.control_before) !== normalizeIntertagWhitespace(EMPTY_BOX) || normalizeIntertagWhitespace(lifecycle.control_after) !== normalizeIntertagWhitespace(EMPTY_BOX)) throw new Error("Q1027 cache-isolation control drifted across the mutation lifecycle");
    if (observations.saved_body_sha256?.before !== observations.saved_body_sha256?.after) throw new Error("Q1027 public reads changed the saved target body");
    if (observations.event_scope !== "adapter-issued-external-requests-only" || !Array.isArray(observations.adapter_events) || observations.adapter_events.filter((event) => event.operation === "page_view" && event.method === "POST" && event.response_status === 200).length < 7) throw new Error("Q1027 evidence does not prove public page_view execution");
    return { verified: true, exact_served_dom: true, multiple_modules_identical: true, inline_literal_boundary: true, link_edit_next_read: true, rename_delete_restore_next_read: true, cache_isolation_control: true, actors_identical: true, internal_identifiers_absent: true, public_seam: "deepwell.page_view and served candidate page", live_evidence: LIVE_EVIDENCE };
  }

  verifyCleanup(proof, resources) {
    if (!proof || proof.pages?.length !== this.#pages.length || proof.pages.some((page) => page.page_get !== null || page.public_status !== 404) || resources.some((resource) => resource.released !== true)) throw new Error("Q1027 cleanup proof is incomplete");
    return { public_absence_verified: true, page_count: proof.pages.length };
  }
}

function targetSource() {
  return [
    "Q1027_DEFAULT_START",
    "[[module Backlinks]]",
    "Q1027_DEFAULT_END",
    "Q1027_PAGE_ARG_START",
    '[[module Backlinks page="ignored"]]',
    "Q1027_PAGE_ARG_END",
    "Q1027_INLINE_START",
    "start-[[module Backlinks]]-middle",
    "Q1027_INLINE_END",
  ].join("\n");
}

export function createOpen43Q1027CandidateCaseSet({ sessionFactory = (options) => new CandidateHttpSession(options) } = {}) {
  return Object.freeze({
    id: "open43-q1027",
    caseIds: OPEN43_Q1027_CASE_IDS,
    prepareRun({ runId, candidateIdentity, privateInput, signal, resources, candidateBrowserContexts }) {
      requireCandidateSite(candidateIdentity);
      const session = sessionFactory({ candidateIdentity, privateInput, signal });
      if (session.pageOrigin !== candidatePageOrigin(candidateIdentity)) throw new Error("Q1027 session did not bind the sealed candidate origin");
      const execution = new Open43Q1027Run({ session, browserContexts: candidateBrowserContexts, resources, runId });
      return Object.freeze({
        sourceFiles: SOURCE_FILES,
        runtimeBindings: session.requiredServiceBindings,
        privateInputIdentity: session.privateInputIdentity,
        browserCredentialPolicy: "none",
        plan: {
          schema: "wikijump.open43_q1027_candidate_plan.v1",
          site_slug: SITE_SLUG,
          case_ids: OPEN43_Q1027_CASE_IDS,
          evidence: LIVE_EVIDENCE,
          mutation_lifecycle: ["link-edit", "rename", "delete", "restore"],
          actor_views: ["anonymous", "editor"],
          event_scope: "adapter-issued-external-requests-only",
        },
        execute: () => execution.execute(),
        cleanup: () => execution.cleanup(),
        verifyCase: (caseId, observations) => execution.verifyCase(caseId, observations),
        verifyCleanup: (proof, resources) => execution.verifyCleanup(proof, resources),
      });
    },
  });
}
