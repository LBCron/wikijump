import {
  fieldValue,
  isCanonicalNonNegativeDecimal,
  isPositiveSafeDecimal
} from "./ajax-module-connector/request.js"
import { jsonResponse } from "./ajax-module-connector/response.js"

const WIKI_PAGE_ACTION = "WikiPageAction"

const PAGE_DRAFT_EVENTS = new Set([
  "synchronize",
  "checkDraftExists",
  "removePageEditLock"
])
const PAGE_DRAFT_SYNCHRONIZE_FIELDS = new Set([
  "action",
  "event",
  "moduleName",
  "wikidot_token7",
  "callbackIndex",
  "mode",
  "wiki_page",
  "lock_id",
  "lock_secret",
  "revision_id",
  "page_id",
  "source",
  "title",
  "comments",
  "since_last_input"
])
const PAGE_DRAFT_EXISTS_FIELDS = new Set([
  "action",
  "event",
  "moduleName",
  "wikidot_token7",
  "callbackIndex",
  "wiki_page",
  "lock_id",
  "page_id",
  "title",
  "source"
])
const PAGE_DRAFT_REMOVE_FIELDS = new Set([
  "action",
  "event",
  "moduleName",
  "wikidot_token7",
  "callbackIndex",
  "wiki_page",
  "lock_id",
  "lock_secret",
  "page_id",
  "leave_draft"
])

const PAGE_EDIT_MODULE = "edit/PageEditModule"
const PAGE_EDIT_MODULE_JS_INCLUDE =
  "https://d3g0gp89917ko0.cloudfront.net/v--7690939296dc/common--modules/js/edit/PageEditModule.js"
const PAGE_EDIT_OPEN_FIELDS = new Set([
  "moduleName",
  "page_id",
  "wiki_page",
  "mode",
  "section",
  "force_lock",
  "wikidot_token7",
  "callbackIndex"
])
const PAGE_EDIT_MODES = new Set(["page", "section", "append"])
const PAGE_SAVE_EVENT = "savePage"
const PAGE_SAVE_FIELDS = new Set([
  "action",
  "event",
  "moduleName",
  "wikidot_token7",
  "callbackIndex",
  "mode",
  "lock_id",
  "lock_secret",
  "revision_id",
  "wiki_page",
  "page_id",
  "title",
  "source",
  "comments",
  "section"
])

export const PAGE_EDIT_LOCKED_BODY = `<div class="owindow" style="width: 80%;">
    <div class="title modal-header">
        Page locked    </div>
    <div class="content modal-body">
        <h1>The page is being edited...</h1>
        <p>
            It seems that the page is currently being edited by another user(s):        </p>
    </div>
</div>`

/** @param {string} value */
const escapePageEditHtml = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")

/**
 * @param {{
 *   userId: number
 *   mode: string
 *   sectionIndex?: number | null
 *   secondsRemaining: number
 * }[]} conflicts
 */
const pageEditConflictBody = (conflicts) => {
  const entries = conflicts
    .map(
      (conflict) =>
        `<p>
            Locked by: user ${conflict.userId}<br/>
            Lock mode: ${conflict.mode}<br/>
            Lock will expire in: ${conflict.secondsRemaining} seconds (if user remains inactive)</br>
        </p>`
    )
    .join("\n        ")
  return `<div class="owindow" style="width: 80%;">
    <div class="title modal-header">
        Page locked    </div>
    <div class="content modal-body">
        <h1>Page lock conflict</h1>
        <p>
            The page is currently locked by another user. The details follow:        </p>
        ${entries}
    </div>
</div>`
}

/** @param {string} source */
const pageEditFormBody = (source) =>
  `            <h1>Edit the page</h1>

    <div>
        <textarea id="edit-page-textarea" name="source" rows="20" cols="80">${escapePageEditHtml(source)}</textarea>
    </div>`

/**
 * @param {{
 *   fields: Map<string, string>
 *   moduleName: string | undefined
 *   siteId: number
 *   savePage?: (input: {
 *     siteId: number
 *     pageId?: number
 *     slug: string
 *     mode: string
 *     sectionIndex?: number
 *     lockId?: number
 *     lockSecret?: string
 *     revisionId: string
 *     title: string
 *     wikitext: string
 *     comments: string
 *   }) => Promise<
 *     | { outcome: "commit"; revisionId: number; lockRecreated: boolean }
 *     | { outcome: "page_changed" }
 *     | { outcome: "other_locks" }
 *   >
 * }} input
 */
export async function handlePageEditSaveAction({ fields, moduleName, siteId, savePage }) {
  if (
    fields.get("action") !== WIKI_PAGE_ACTION ||
    fields.get("event") !== PAGE_SAVE_EVENT
  ) {
    return null
  }
  const slug = fieldValue(fields, "wiki_page")
  const mode = fields.get("mode")
  const rawPageId = fields.get("page_id")
  const pageId =
    rawPageId === undefined
      ? undefined
      : isPositiveSafeDecimal(rawPageId)
        ? Number.parseInt(rawPageId, 10)
        : null
  const sectionValue = fields.get("section")
  const sectionIndex =
    sectionValue === undefined
      ? undefined
      : isCanonicalNonNegativeDecimal(sectionValue)
        ? Number.parseInt(sectionValue, 10)
        : null
  const hasLockId = fields.has("lock_id")
  const hasLockSecret = fields.has("lock_secret")
  const lockIdValue = fieldValue(fields, "lock_id")
  const revisionId = fieldValue(fields, "revision_id")
  const lockShapeSupported =
    hasLockId === hasLockSecret &&
    (!hasLockId ||
      (isPositiveSafeDecimal(lockIdValue) &&
        fieldValue(fields, "lock_secret").length > 0))
  const shapeSupported =
    moduleName === "Empty" &&
    [...fields.keys()].every((field) => PAGE_SAVE_FIELDS.has(field)) &&
    mode !== undefined &&
    PAGE_EDIT_MODES.has(mode) &&
    slug.length > 0 &&
    !slug.includes("\0") &&
    pageId !== null &&
    sectionIndex !== null &&
    (mode === "section" ? sectionIndex !== undefined : sectionIndex === undefined) &&
    lockShapeSupported &&
    (revisionId === "" || isPositiveSafeDecimal(revisionId)) &&
    fields.has("source") &&
    fields.has("title") &&
    fields.has("comments")
  if (!shapeSupported || !savePage) {
    return jsonResponse({ status: "not_ok" })
  }
  try {
    const outcome = await savePage({
      siteId,
      ...(pageId === undefined ? {} : { pageId }),
      slug,
      mode,
      ...(sectionIndex === undefined ? {} : { sectionIndex }),
      ...(hasLockId
        ? {
            lockId: Number.parseInt(lockIdValue, 10),
            "lockSecret": fieldValue(fields, "lock_secret")
          }
        : {}),
      revisionId,
      title: fieldValue(fields, "title"),
      wikitext: fieldValue(fields, "source"),
      comments: fieldValue(fields, "comments")
    })
    if (outcome.outcome === "page_changed") {
      return jsonResponse({
        status: "ok",
        noLockError: "page_changed",
        nonrecoverable: true
      })
    }
    if (outcome.outcome === "other_locks") {
      return jsonResponse({ status: "ok", noLockError: "other_locks" })
    }
    return jsonResponse({
      status: "ok",
      timeLeft: 900,
      revisionId: outcome.revisionId,
      ...(outcome.lockRecreated ? { lockRecreated: true } : {})
    })
  } catch (error) {
    console.error("AJAX savePage action failed", error)
    return jsonResponse({ status: "not_ok" })
  }
}

/**
 * @param {{
 *   fields: Map<string, string>
 *   moduleName: string | undefined
 *   siteId: number
 *   savePageDraft?: (input: {
 *     siteId: number
 *     pageId?: number
 *     slug: string
 *     title: string
 *     wikitext: string
 *   }) => Promise<void>
 *   pageDraftExists?: (input: {
 *     siteId: number
 *     pageId?: number
 *     slug: string
 *   }) => Promise<boolean>
 *   removePageDraft?: (input: {
 *     siteId: number
 *     pageId?: number
 *     slug: string
 *   }) => Promise<void>
 *   renewPageEditLock?: (input: {
 *     siteId: number
 *     pageId?: number
 *     slug: string
 *     lockId: number
 *     lockSecret: string
 *     mode: string
 *   }) => Promise<
 *     | { timeLeft: number; lockRecreated: false }
 *     | {
 *         timeLeft: number
 *         lockRecreated: true
 *         lockId: number
 *         lockSecret: string
 *       }
 *     | { noLockError: "other_locks" }
 *   >
 *   releasePageEditLock?: (input: {
 *     siteId: number
 *     pageId?: number
 *     slug: string
 *     lockId: number
 *     lockSecret: string
 *   }) => Promise<void>
 * }} input
 */
export async function handlePageDraftEvents({
  fields,
  moduleName,
  siteId,
  savePageDraft,
  pageDraftExists,
  removePageDraft,
  renewPageEditLock,
  releasePageEditLock
}) {
  const pageDraftEvent = fields.get("event")
  if (
    fields.get("action") !== WIKI_PAGE_ACTION ||
    pageDraftEvent === undefined ||
    !PAGE_DRAFT_EVENTS.has(pageDraftEvent)
  ) {
    return null
  }
  const allowedFields =
    pageDraftEvent === "synchronize"
      ? PAGE_DRAFT_SYNCHRONIZE_FIELDS
      : pageDraftEvent === "checkDraftExists"
        ? PAGE_DRAFT_EXISTS_FIELDS
        : PAGE_DRAFT_REMOVE_FIELDS
  const slug = fieldValue(fields, "wiki_page")
  const lockId = fieldValue(fields, "lock_id")
  const rawPageId = fields.get("page_id")
  const pageId =
    rawPageId === undefined
      ? undefined
      : isPositiveSafeDecimal(rawPageId)
        ? Number.parseInt(rawPageId, 10)
        : null
  const commonShapeSupported =
    moduleName === "Empty" &&
    [...fields.keys()].every((field) => allowedFields.has(field)) &&
    slug.length > 0 &&
    !slug.includes("\0") &&
    isPositiveSafeDecimal(lockId) &&
    pageId !== null

  if (!commonShapeSupported) {
    return jsonResponse({ status: "not_ok" })
  }

  try {
    if (pageDraftEvent === "synchronize") {
      const revisionId = fieldValue(fields, "revision_id")
      const shapeSupported =
        fields.get("mode") === "page" &&
        fieldValue(fields, "lock_secret").length > 0 &&
        (revisionId === "" || isPositiveSafeDecimal(revisionId)) &&
        fields.has("source") &&
        fields.has("title") &&
        fields.has("comments") &&
        isCanonicalNonNegativeDecimal(fieldValue(fields, "since_last_input"))
      if (!shapeSupported || !savePageDraft) {
        return jsonResponse({ status: "not_ok" })
      }
      await savePageDraft({
        siteId,
        ...(pageId === undefined ? {} : { pageId }),
        slug,
        title: fieldValue(fields, "title"),
        wikitext: fieldValue(fields, "source")
      })
      if (!renewPageEditLock) {
        return jsonResponse({ status: "ok", savedDraft: true })
      }
      const renewed = await renewPageEditLock({
        siteId,
        ...(pageId === undefined ? {} : { pageId }),
        slug,
        lockId: Number.parseInt(lockId, 10),
        "lockSecret": fieldValue(fields, "lock_secret"),
        mode: "page"
      })
      if (renewed.noLockError) {
        return jsonResponse({
          status: "ok",
          noLockError: renewed.noLockError
        })
      }
      if (renewed.lockRecreated) {
        return jsonResponse({
          status: "ok",
          lockRecreated: true,
          lockId: renewed.lockId,
          "lockSecret": renewed.lockSecret,
          timeLeft: renewed.timeLeft
        })
      }
      return jsonResponse({
        status: "ok",
        savedDraft: true,
        timeLeft: renewed.timeLeft
      })
    }

    if (pageDraftEvent === "checkDraftExists") {
      if (!fields.has("title") || !fields.has("source") || !pageDraftExists) {
        return jsonResponse({ status: "not_ok" })
      }
      const draftExists = await pageDraftExists({
        siteId,
        ...(pageId === undefined ? {} : { pageId }),
        slug
      })
      return jsonResponse({ status: "ok", draftExists })
    }

    const leaveDraft = fields.get("leave_draft")
    if (
      fieldValue(fields, "lock_secret").length === 0 ||
      (leaveDraft !== "true" && leaveDraft !== "false")
    ) {
      return jsonResponse({ status: "not_ok" })
    }
    if (leaveDraft === "false") {
      if (!removePageDraft) return jsonResponse({ status: "not_ok" })
      await removePageDraft({
        siteId,
        ...(pageId === undefined ? {} : { pageId }),
        slug
      })
    }
    if (releasePageEditLock) {
      await releasePageEditLock({
        siteId,
        ...(pageId === undefined ? {} : { pageId }),
        slug,
        lockId: Number.parseInt(lockId, 10),
        "lockSecret": fieldValue(fields, "lock_secret")
      })
    }
    return jsonResponse({ status: "ok" })
  } catch (error) {
    console.error(`AJAX page draft ${pageDraftEvent} failed`, error)
    return jsonResponse({ status: "not_ok" })
  }
}

/**
 * @param {{
 *   fields: Map<string, string>
 *   moduleName: string | undefined
 *   siteId: number
 *   openPageEdit?: (input: {
 *     siteId: number
 *     pageId: number
 *     slug: string
 *     mode: string
 *     sectionIndex?: number
 *     force: boolean
 *   }) => Promise<{
 *     granted: boolean
 *     sectionIndex?: number
 *     rangeStart?: number
 *     rangeEnd?: number
 *     lockId?: number
 *     lockSecret?: string
 *     baseRevisionId?: number | null
 *     timeLeft: number
 *     source?: string
 *     conflicts?: {
 *       userId: number
 *       mode: string
 *       sectionIndex?: number | null
 *       secondsRemaining: number
 *     }[]
 *   }>
 * }} input
 */
export async function handlePageEditOpenModule({
  fields,
  moduleName,
  siteId,
  openPageEdit
}) {
  if (moduleName !== PAGE_EDIT_MODULE) {
    return null
  }
  if (!openPageEdit) {
    return jsonResponse({
      status: "not_ok",
      message: `Unsupported AJAX module: ${moduleName}`
    })
  }
  const pageIdValue = fields.get("page_id")
  const slug = fieldValue(fields, "wiki_page")
  const mode = fields.get("mode")
  const sectionValue = fields.get("section")
  const sectionIndex =
    sectionValue === undefined
      ? undefined
      : isCanonicalNonNegativeDecimal(sectionValue)
        ? Number.parseInt(sectionValue, 10)
        : null
  const forceValue = fields.get("force_lock")
  const callbackIndex = fields.has("callbackIndex")
    ? fieldValue(fields, "callbackIndex")
    : null
  const shapeSupported =
    ![...fields.keys()].some((field) => !PAGE_EDIT_OPEN_FIELDS.has(field)) &&
    pageIdValue !== undefined &&
    isPositiveSafeDecimal(pageIdValue) &&
    slug.length > 0 &&
    !slug.includes("\0") &&
    mode !== undefined &&
    PAGE_EDIT_MODES.has(mode) &&
    sectionIndex !== null &&
    (mode === "section" ? sectionIndex !== undefined : sectionIndex === undefined) &&
    (forceValue === undefined || forceValue === "yes")
  if (!shapeSupported) {
    return jsonResponse({
      status: "not_ok",
      message: `Unsupported AJAX module shape: ${moduleName}`
    })
  }
  const responseMetadata = () => ({
    callbackIndex,
    CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000),
    cssInclude: [],
    jsInclude: [PAGE_EDIT_MODULE_JS_INCLUDE]
  })
  try {
    const outcome = await openPageEdit({
      siteId,
      pageId: Number.parseInt(pageIdValue, 10),
      slug,
      mode,
      ...(sectionIndex === undefined ? {} : { sectionIndex }),
      force: forceValue === "yes"
    })
    const sectionFields =
      mode === "section"
        ? {
            section: sectionIndex,
            rangeStart: outcome.rangeStart,
            rangeEnd: outcome.rangeEnd
          }
        : {}
    if (!outcome.granted) {
      return jsonResponse({
        status: "ok",
        mode,
        ...sectionFields,
        locked: true,
        timeLeft: outcome.timeLeft,
        body: pageEditConflictBody(outcome.conflicts ?? []),
        ...responseMetadata()
      })
    }
    return jsonResponse({
      status: "ok",
      mode,
      ...sectionFields,
      lock_id: outcome.lockId,
      "lock_secret": outcome.lockSecret,
      page_revision_id: outcome.baseRevisionId ?? null,
      timeLeft: outcome.timeLeft,
      body: pageEditFormBody(outcome.source ?? ""),
      ...responseMetadata()
    })
  } catch (error) {
    console.error("AJAX PageEditModule rendering failed", error)
    return jsonResponse({
      status: "not_ok",
      body: "",
      ...responseMetadata()
    })
  }
}
