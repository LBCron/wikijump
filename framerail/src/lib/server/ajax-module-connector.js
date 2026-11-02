import { createHash } from "node:crypto"

import {
  handleNewPageHelperRequest,
  resolveCanCreateNewPage,
  toWikidotUnixName
} from "./ajax-module-connector/new-page.js"
import {
  CONTROL_FIELDS,
  fieldValue,
  forumNumericParametersAreCanonical,
  isCanonicalNonNegativeDecimal,
  isPositiveSafeDecimal,
  isSupportedPageReadShape,
  readUrlEncodedForm,
  requestWikidotTokenCookie
} from "./ajax-module-connector/request.js"
import { handleMailFormAction } from "./ajax-module-connector/mail-form.js"
import { jsonResponse } from "./ajax-module-connector/response.js"

import { classifyWikidotSiteChangesRequest } from "./wikidot-site-changes.js"

const FORUM_READ_MODULE_PARAMETERS = new Map([
  ["forum/ForumStartModule", [new Set(), new Set(["hidden"])]],
  ["forum/ForumCommentsListModule", [new Set(["pageId"]), new Set(["pageId", "order"])]],
  ["forum/ForumViewCategoryModule", [new Set(["c", "p"])]],
  ["forum/ForumViewThreadModule", [new Set(["t"])]],
  ["forum/ForumViewThreadPostsModule", [new Set(["t", "pageNo"])]],
  ["forum/ForumRecentPostsListModule", [new Set(["page", "categoryId"])]]
])
const SITE_CHANGES_MODULE = "changes/SiteChangesListModule"
const MEMBERS_LIST_MODULE = "membership/MembersListModule"
const CATEGORIES_PAGE_LIST_MODULE = "list/WikiCategoriesPageListModule"
const USERINFO_MODULE = "profile/UserInfoModule"
const USERINFO_NO_USER_BODY = '<div class="error-block">No user specified.</div>'
const MANAGE_SITE_GENERAL_MODULE = "managesite/ManageSiteGeneralModule"
const MANAGE_SITE_EDUCATIONAL_MODULE = "managesite/ManageSiteUpgradeEduModule"
const EDUCATIONAL_UPGRADE_ACTION = "UpgradesAction"
const EDUCATIONAL_UPGRADE_EVENT = "upgradeEdu"
const EDUCATIONAL_UPGRADE_FIELDS = new Set([
  "moduleName",
  "action",
  "event",
  "organization",
  "purpose",
  "wikidot_token7",
  "callbackIndex"
])
const MEMBERS_LIST_PARAMETERS = new Set(["group", "order", "page"])
const MEMBERS_LIST_DEFAULT_PARAMETERS = new Set(["group", "page"])
const SITE_TOOLS_READ_MODULES = new Map([
  ["sitetools/SiteToolsModule", { callbackIndex: "1", parameters: new Set() }],
  ["sitetools/WantedPagesModule", { callbackIndex: "2", parameters: new Set() }],
  ["sitetools/OrphanedPagesModule", { callbackIndex: "3", parameters: new Set() }],
  ["list/ListDraftsModule", { callbackIndex: "4", parameters: new Set(["location"]) }]
])
const PAGE_READ_MODULE_PARAMETERS = new Map([
  ["pagerate/WhoRatedPageModule", new Set(["pageId"])],
  ["viewsource/ViewSourceModule", new Set(["page_id"])],
  ["files/PageFilesModule", new Set(["page_id"])],
  ["history/PageRevisionListModule", new Set(["page_id", "options", "perpage"])],
  ["history/PageSourceModule", new Set(["revision_id"])],
  ["history/PageVersionModule", new Set(["revision_id"])]
])
const LIST_PAGES_PARAMETERS = new Set([
  "p",
  "pagetype",
  "page_type",
  "page-type",
  "category",
  "tags",
  "tag",
  "parent",
  "created_at",
  "createdat",
  "updated_at",
  "updatedat",
  "created_by",
  "createdby",
  "rating",
  "score",
  "name",
  "fullname",
  "full_slug",
  "fullslug",
  "range",
  "order",
  "offset",
  "limit",
  "perpage",
  "per_page",
  "separate",
  "wrapper",
  "rss",
  "rsstitle",
  "rssdescription",
  "rsshome",
  "rsslimit",
  "rssonly"
])
const NEWPAGE_ACTION = "misc/NewPageHelperAction"
const NEWPAGE_EVENT = "createNewPage"
const DATA_FORM_ACTION = "DataFormAction"
const DATA_FORM_NEW_PAGE_EVENT = "newPage"
const DATA_FORM_NEW_PAGE_FIELDS = new Set([
  "action",
  "event",
  "category",
  "parent",
  "title",
  "moduleName",
  "wikidot_token7",
  "callbackIndex"
])
const PAGE_DISCUSSION_ACTION = "ForumAction"
const PAGE_DISCUSSION_EVENT = "createPageDiscussionThread"
const FORUM_POST_EVENT = "savePost"
const FORUM_POST_FIELDS = new Set([
  "action",
  "event",
  "moduleName",
  "wikidot_token7",
  "callbackIndex",
  "threadId",
  "parentId",
  "title",
  "source",
  "guestName",
  "guestEmail"
])
const EDIT_META_MODULE = "edit/EditMetaModule"
const EDIT_META_ACTION = "WikiPageAction"
const EDIT_META_EVENTS = new Set(["saveMetaTag", "deleteMetaTag"])
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
const PAGE_DELETE_EVENT = "deletePage"
const PAGE_DELETE_MODULE = "Empty"
const PAGE_DELETE_ACTION_FIELDS = new Set([
  "action",
  "event",
  "page_id",
  "moduleName",
  "wikidot_token7"
])
const EDIT_META_READ_FIELDS = new Set(["moduleName", "pageId", "wikidot_token7"])
const EDIT_META_ACTION_FIELDS = new Set([
  "action",
  "event",
  "pageId",
  "metaName",
  "metaContent",
  "allPages",
  "moduleName",
  "wikidot_token7"
])

/**
 * @typedef {{
 *   slug: string
 *   title: string
 *   wikitext: string
 *   tags: string[]
 *   parentPage: string
 * }} NewPageCreateInput
 *
 *
 * @typedef {{
 *   siteId: number
 *   moduleBody: string
 *   parameters: Record<string, string>
 * }} ListPagesRenderInput
 *
 *
 * @typedef {{
 *   siteId: number
 *   moduleName: string
 *   parameters: Record<string, string>
 * }} ForumModuleRenderInput
 *
 *
 * @typedef {{
 *   siteId: number
 *   pageId?: string
 *   page: string
 *   perpage: string
 *   categoryId?: string
 *   options: string
 * }} SiteChangesRenderInput
 *
 *
 * @typedef {{
 *   siteId: number
 *   parameters: Record<string, string>
 * }} MembersListRenderInput
 *
 *
 * @typedef {{
 *   siteId: number
 *   renderListPages: (
 *     input: ListPagesRenderInput
 *   ) => Promise<{ body: string }>
 *   renderForumModule?: (input: ForumModuleRenderInput) => Promise<{
 *     status: string
 *     body: string
 *     thread_id?: number
 *     js_include?: string[]
 *   }>
 *   renderSiteChangesModule?: (
 *     input: SiteChangesRenderInput
 *   ) => Promise<{ status: string; body: string }>
 *   renderMembersList?: (
 *     input: MembersListRenderInput
 *   ) => Promise<{ status: string; body: string }>
 *   renderCategoriesPageList?: (input: {
 *     siteId: number
 *     categoryId: number
 *   }) => Promise<{ status: string; body: string }>
 *   renderManageSiteGeneralModule?: (input: {
 *     siteId: number
 *   }) => Promise<{
 *     status: string
 *     body: string
 *     js_include?: string[]
 *   } | null>
 *   renderManageSiteEducationalModule?: (input: {
 *     siteId: number
 *   }) => Promise<{
 *     status: string
 *     body: string
 *     js_include?: string[]
 *   } | null>
 *   upgradeEducationalSite?: (input: {
 *     siteId: number
 *     organization: string
 *     purpose: string
 *   }) => Promise<void>
 *   renderPageReadModule?: (input: ForumModuleRenderInput) => Promise<{
 *     status: string
 *     body: string
 *     js_include?: string[]
 *   }>
 *   renderSiteToolsModule?: (input: ForumModuleRenderInput) => Promise<{
 *     status: string
 *     body: string
 *   }>
 *   createNewPage?: (input: NewPageCreateInput) => Promise<void>
 *   canCreateNewPage?: boolean | (() => boolean | Promise<boolean>)
 *   pageExists?: (slug: string) => boolean | Promise<boolean>
 *   createPageDiscussion?: (input: {
 *     siteId: number
 *     pageId: number
 *   }) => Promise<{ thread_id: number; thread_unix_title: string } | null>
 *   createForumPost?: (input: {
 *     siteId: number
 *     threadId: number
 *     parentPostId: number | null
 *     title: string
 *     source: string
 *     guestName?: string
 *     guestEmailMd5?: string
 *   }) => Promise<{ forum_post_id: number }>
 *   submitMailForm?: (input: {
 *     siteId: number
 *     formdef: string
 *     values: Record<string, string>
 *   }) => Promise<{
 *     status: string
 *     errors?: { field: string; message: string }[]
 *     success_msg?: string | null
 *     success_page?: string | null
 *   }>
 *   renderEditMetaModule?: (input: {
 *     siteId: number
 *     pageId: number
 *   }) => Promise<{ status: string; body: string; js_include?: string[] }>
 *   saveMetaTag?: (input: {
 *     siteId: number
 *     pageId: number
 *     name: string
 *     content: string
 *     allPages: boolean
 *   }) => Promise<void>
 *   deleteMetaTag?: (input: {
 *     siteId: number
 *     pageId: number
 *     name: string
 *     allPages: boolean
 *   }) => Promise<void>
 *   deletePage?: (input: {
 *     siteId: number
 *     pageId: number
 *   }) => Promise<void>
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
 * }} AjaxModuleConnectorOptions
 */

/**
 * @param {string} moduleName
 * @param {Record<string, string>} parameters
 */
/** @param {string} tags */
/**
 * @param {Request} request
 * @param {AjaxModuleConnectorOptions} options
 */
export const handleAjaxModuleConnectorRequest = async (
  request,
  {
    siteId,
    renderListPages,
    renderForumModule,
    renderSiteChangesModule,
    renderMembersList,
    renderCategoriesPageList,
    renderManageSiteGeneralModule,
    renderManageSiteEducationalModule,
    upgradeEducationalSite,
    renderPageReadModule,
    renderSiteToolsModule,
    createNewPage,
    canCreateNewPage = true,
    pageExists,
    createPageDiscussion,
    createForumPost,
    submitMailForm,
    renderEditMetaModule,
    saveMetaTag,
    deleteMetaTag,
    deletePage,
    savePageDraft,
    pageDraftExists,
    removePageDraft
  }
) => {
  if (request.method !== "POST") {
    return jsonResponse(
      { status: "not_ok", message: "AJAX Module Connector requires POST" },
      405,
      { allow: "POST" }
    )
  }

  /**
   * @type {{
   *   fields: Map<string, string>
   *   duplicateFields: Set<string>
   * }}
   */
  let parsedForm
  try {
    parsedForm = await readUrlEncodedForm(request)
  } catch (error) {
    const status = error instanceof RangeError ? 413 : 400
    return jsonResponse(
      {
        status: "not_ok",
        message:
          error instanceof Error
            ? error.message
            : "Malformed AJAX Module Connector request"
      },
      status
    )
  }

  const { fields, duplicateFields } = parsedForm
  const moduleName = fields.get("moduleName")
  if (moduleName !== "list/ListPagesModule" && duplicateFields.size > 0) {
    const duplicateField = duplicateFields.values().next().value
    return jsonResponse(
      {
        status: "not_ok",
        message: `AJAX Module Connector field is duplicated: ${duplicateField}`
      },
      400
    )
  }

  if (moduleName === MANAGE_SITE_GENERAL_MODULE) {
    if (fields.size !== 1) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module shape: ${moduleName}`
      })
    }

    if (!renderManageSiteGeneralModule) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module: ${moduleName}`
      })
    }

    try {
      const output = await renderManageSiteGeneralModule({ siteId })
      if (!output) {
        return jsonResponse({
          status: "not_ok",
          message: `Unsupported AJAX module: ${moduleName}`
        })
      }
      return jsonResponse({
        status: output.status,
        body: output.body,
        callbackIndex: null,
        CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000),
        cssInclude: [],
        jsInclude: output.js_include ?? []
      })
    } catch (error) {
      console.error("AJAX ManageSiteGeneral rendering failed", error)
      return jsonResponse({
        status: "not_ok",
        body: "",
        callbackIndex: null,
        CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000),
        cssInclude: [],
        jsInclude: []
      })
    }
  }

  if (moduleName === MANAGE_SITE_EDUCATIONAL_MODULE) {
    if (fields.size !== 1) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module shape: ${moduleName}`
      })
    }

    if (!renderManageSiteEducationalModule) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module: ${moduleName}`
      })
    }

    try {
      const output = await renderManageSiteEducationalModule({ siteId })
      if (!output) {
        return jsonResponse({
          status: "not_ok",
          body: "",
          callbackIndex: null,
          CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000),
          cssInclude: [],
          jsInclude: []
        })
      }
      return jsonResponse({
        status: output.status,
        body: output.body,
        callbackIndex: null,
        CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000),
        cssInclude: [],
        jsInclude: output.js_include ?? []
      })
    } catch (error) {
      console.error("AJAX ManageSite educational rendering failed", error)
      return jsonResponse({
        status: "not_ok",
        body: "",
        callbackIndex: null,
        CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000),
        cssInclude: [],
        jsInclude: []
      })
    }
  }

  if (
    fields.get("action") === EDUCATIONAL_UPGRADE_ACTION &&
    fields.get("event") === EDUCATIONAL_UPGRADE_EVENT
  ) {
    const organization = fieldValue(fields, "organization")
    const purpose = fieldValue(fields, "purpose")
    const validShape =
      [...fields.keys()].every((field) => EDUCATIONAL_UPGRADE_FIELDS.has(field)) &&
      fields.get("moduleName") === "Empty" &&
      organization.trim().length > 0 &&
      purpose.trim().length > 0
    if (!validShape || !upgradeEducationalSite) {
      return jsonResponse({ status: "not_ok" })
    }
    try {
      await upgradeEducationalSite({ siteId, organization, purpose })
      return jsonResponse({ status: "ok" })
    } catch (error) {
      console.error("AJAX educational site upgrade failed", error)
      return jsonResponse({ status: "not_ok" })
    }
  }

  if (
    fields.get("action") === EDIT_META_ACTION &&
    fields.get("event") === PAGE_DELETE_EVENT
  ) {
    const pageIdValue = fieldValue(fields, "page_id")
    const shapeIsSupported =
      fields.get("moduleName") === PAGE_DELETE_MODULE &&
      [...fields.keys()].every((field) => PAGE_DELETE_ACTION_FIELDS.has(field)) &&
      isPositiveSafeDecimal(pageIdValue)
    if (!shapeIsSupported) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module shape: ${fields.get("moduleName") ?? ""}`
      })
    }

    if (!deletePage) return jsonResponse({ status: "not_ok" })
    try {
      await deletePage({ siteId, pageId: Number.parseInt(pageIdValue, 10) })
      return jsonResponse({ status: "ok" })
    } catch (error) {
      console.error("AJAX deletePage action failed", error)
      return jsonResponse({ status: "not_ok" })
    }
  }

  const pageDraftEvent = fields.get("event")
  if (
    fields.get("action") === EDIT_META_ACTION &&
    pageDraftEvent !== undefined &&
    PAGE_DRAFT_EVENTS.has(pageDraftEvent)
  ) {
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
        return jsonResponse({ status: "ok", savedDraft: true })
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
      return jsonResponse({ status: "ok" })
    } catch (error) {
      console.error(`AJAX page draft ${pageDraftEvent} failed`, error)
      return jsonResponse({ status: "not_ok" })
    }
  }

  const editMetaEvent = fields.get("event")
  if (
    moduleName === EDIT_META_MODULE &&
    fields.get("action") === EDIT_META_ACTION &&
    editMetaEvent !== undefined
  ) {
    const allowedFields =
      editMetaEvent === "saveMetaTag"
        ? EDIT_META_ACTION_FIELDS
        : new Set([...EDIT_META_ACTION_FIELDS].filter((field) => field !== "metaContent"))
    const pageIdValue = fieldValue(fields, "pageId")
    const name = fieldValue(fields, "metaName")
    const allPagesValue = fields.get("allPages")
    const shapeIsSupported =
      EDIT_META_EVENTS.has(editMetaEvent) &&
      [...fields.keys()].every((field) => allowedFields.has(field)) &&
      isPositiveSafeDecimal(pageIdValue) &&
      name.length > 0 &&
      !name.includes("\0") &&
      (allPagesValue === undefined || allPagesValue === "true") &&
      (editMetaEvent !== "saveMetaTag" || fields.has("metaContent"))
    if (!shapeIsSupported) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module shape: ${moduleName}`
      })
    }

    const pageId = Number.parseInt(pageIdValue, 10)
    try {
      if (editMetaEvent === "saveMetaTag") {
        if (!saveMetaTag) {
          return jsonResponse({ status: "not_ok" })
        }
        await saveMetaTag({
          siteId,
          pageId,
          name,
          content: fieldValue(fields, "metaContent"),
          allPages: allPagesValue === "true"
        })
      } else {
        if (!deleteMetaTag) {
          return jsonResponse({ status: "not_ok" })
        }
        await deleteMetaTag({
          siteId,
          pageId,
          name,
          allPages: allPagesValue === "true"
        })
      }
      return jsonResponse({ status: "ok" })
    } catch (error) {
      console.error("AJAX EditMeta action failed", error)
      return jsonResponse({ status: "not_ok" })
    }
  }

  if (moduleName === EDIT_META_MODULE) {
    const pageIdValue = fieldValue(fields, "pageId")
    if (
      !renderEditMetaModule ||
      [...fields.keys()].some((field) => !EDIT_META_READ_FIELDS.has(field)) ||
      fields.has("action") ||
      fields.has("event") ||
      !isPositiveSafeDecimal(pageIdValue)
    ) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module shape: ${moduleName}`
      })
    }

    try {
      const output = await renderEditMetaModule({
        siteId,
        pageId: Number.parseInt(pageIdValue, 10)
      })
      return jsonResponse({
        status: output.status,
        body: output.body,
        callbackIndex: null,
        CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000),
        cssInclude: [],
        jsInclude: output.js_include ?? []
      })
    } catch (error) {
      console.error("AJAX EditMeta rendering failed", error)
      return jsonResponse({
        status: "not_ok",
        body: "",
        callbackIndex: null,
        CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000),
        cssInclude: [],
        jsInclude: []
      })
    }
  }

  if (
    fields.get("action") === DATA_FORM_ACTION &&
    fields.get("event") === DATA_FORM_NEW_PAGE_EVENT
  ) {
    const category = fieldValue(fields, "category")
    const parentPage = fieldValue(fields, "parent")
    const title = fieldValue(fields, "title")
    const callbackIndex = fields.has("callbackIndex")
      ? fieldValue(fields, "callbackIndex")
      : null
    const supportedShape =
      moduleName === "Empty" &&
      category.length > 0 &&
      title.length > 0 &&
      [...fields.keys()].every((field) => DATA_FORM_NEW_PAGE_FIELDS.has(field))
    if (
      !supportedShape ||
      !createNewPage ||
      !(await resolveCanCreateNewPage(canCreateNewPage))
    ) {
      return jsonResponse({
        status: "not_ok",
        callbackIndex,
        CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000)
      })
    }

    const fullname = toWikidotUnixName({
      pageName: title,
      categoryName: category
    })
    if (!fullname || (pageExists && (await pageExists(fullname)))) {
      return jsonResponse({
        status: "not_ok",
        callbackIndex,
        CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000)
      })
    }
    try {
      const rootFullname = `${category}:_root`
      if (parentPage === "" && (!pageExists || !(await pageExists(rootFullname)))) {
        await createNewPage({
          slug: rootFullname,
          title: category.charAt(0).toUpperCase() + category.slice(1),
          wikitext: "",
          tags: [],
          parentPage: null
        })
      }
      await createNewPage({
        slug: fullname,
        title,
        wikitext: "",
        tags: [],
        parentPage: parentPage || rootFullname
      })
      return jsonResponse({
        status: "ok",
        fullname,
        callbackIndex,
        CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000)
      })
    } catch (error) {
      console.error("AJAX DataForm pagepath creation failed", error)
      return jsonResponse({
        status: "not_ok",
        callbackIndex,
        CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000)
      })
    }
  }

  const mailFormResponse = await handleMailFormAction({
    fields,
    moduleName,
    siteId,
    submitMailForm
  })
  if (mailFormResponse) {
    return mailFormResponse
  }

  if (fields.get("action") === NEWPAGE_ACTION && fields.get("event") === NEWPAGE_EVENT) {
    try {
      return await handleNewPageHelperRequest(fields, {
        createNewPage,
        canCreateNewPage,
        pageExists
      })
    } catch (error) {
      console.error("AJAX NewPage helper action failed", error)
      return jsonResponse({
        status: "not_ok",
        message: "Unable to create NewPage target"
      })
    }
  }

  if (
    fields.get("action") === PAGE_DISCUSSION_ACTION &&
    fields.get("event") === FORUM_POST_EVENT
  ) {
    const threadIdValue = fieldValue(fields, "threadId")
    const parentIdValue = fieldValue(fields, "parentId")
    const guestNamePresent = fields.has("guestName")
    const guestEmailPresent = fields.has("guestEmail")
    const guestName = fieldValue(fields, "guestName")
    const guestEmail = fieldValue(fields, "guestEmail").trim()
    const parentPostId =
      parentIdValue === ""
        ? null
        : isPositiveSafeDecimal(parentIdValue)
          ? Number.parseInt(parentIdValue, 10)
          : undefined
    const guestIdentityValid =
      !guestNamePresent && !guestEmailPresent
        ? true
        : guestNamePresent &&
          guestEmailPresent &&
          guestName.trim().length > 0 &&
          guestEmail.length <= 50 &&
          /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(guestEmail)
    const shapeIsSupported =
      moduleName === "Empty" &&
      isPositiveSafeDecimal(threadIdValue) &&
      parentPostId !== undefined &&
      fields.has("source") &&
      [...fields.keys()].every((field) => FORUM_POST_FIELDS.has(field)) &&
      guestIdentityValid
    if (!shapeIsSupported || !createForumPost) {
      return jsonResponse({ status: "not_ok" })
    }

    try {
      const created = await createForumPost({
        siteId,
        threadId: Number.parseInt(threadIdValue, 10),
        parentPostId,
        title: fieldValue(fields, "title"),
        source: fieldValue(fields, "source"),
        ...(guestNamePresent
          ? {
              guestName,
              guestEmailMd5: createHash("md5").update(guestEmail).digest("hex")
            }
          : {})
      })
      return jsonResponse({ status: "ok", postId: created.forum_post_id })
    } catch (error) {
      console.error("AJAX forum savePost action failed", error)
      return jsonResponse({ status: "not_ok" })
    }
  }

  if (
    fields.get("action") === PAGE_DISCUSSION_ACTION &&
    fields.get("event") === PAGE_DISCUSSION_EVENT
  ) {
    const callbackIndex = fields.has("callbackIndex")
      ? fieldValue(fields, "callbackIndex")
      : null
    const responseMetadata = () => ({
      callbackIndex,
      CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000)
    })
    const rawPageId = fieldValue(fields, "page_id")
    if (!/^\d+$/u.test(rawPageId) || !createPageDiscussion) {
      return jsonResponse({
        status: "no_page",
        message: "The page does not exist",
        ...responseMetadata()
      })
    }
    const pageId = Number.parseInt(rawPageId, 10)
    if (!Number.isSafeInteger(pageId) || pageId <= 0) {
      return jsonResponse({
        status: "no_page",
        message: "The page does not exist",
        ...responseMetadata()
      })
    }

    try {
      const discussion = await createPageDiscussion({ siteId, pageId })
      if (!discussion) {
        return jsonResponse({
          status: "no_page",
          message: "The page does not exist",
          ...responseMetadata()
        })
      }
      return jsonResponse({
        status: "ok",
        thread_id: discussion.thread_id,
        thread_unix_title: discussion.thread_unix_title,
        ...responseMetadata()
      })
    } catch (error) {
      console.error("AJAX page discussion action failed", error)
      return jsonResponse({
        status: "not_ok",
        message: "Unable to create page discussion",
        ...responseMetadata()
      })
    }
  }

  if (moduleName === SITE_CHANGES_MODULE) {
    if (!renderSiteChangesModule) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module: ${moduleName}`
      })
    }

    const parameters = classifyWikidotSiteChangesRequest(fields)
    if (parameters === null) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module shape: ${moduleName}`
      })
    }

    const callbackIndex = fields.has("callbackIndex")
      ? fieldValue(fields, "callbackIndex")
      : null
    const responseMetadata = () => ({
      callbackIndex,
      CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000),
      cssInclude: [],
      jsInclude: []
    })
    try {
      const output = await renderSiteChangesModule({
        siteId,
        page: parameters.page,
        perpage: parameters.perpage,
        options: parameters.options,
        ...(parameters.pageId === undefined ? {} : { pageId: parameters.pageId }),
        ...(parameters.categoryId === undefined
          ? {}
          : { categoryId: parameters.categoryId })
      })
      return jsonResponse({
        status: output.status,
        body: output.body,
        ...responseMetadata()
      })
    } catch (error) {
      console.error("AJAX SiteChanges rendering failed", error)
      return jsonResponse({
        status: "not_ok",
        body: "",
        ...responseMetadata()
      })
    }
  }

  if (moduleName === MEMBERS_LIST_MODULE) {
    if (!renderMembersList) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module: ${moduleName}`
      })
    }

    /** @type {Record<string, string>} */
    const parameters = {}
    for (const [key, value] of fields) {
      if (MEMBERS_LIST_PARAMETERS.has(key)) {
        parameters[key] = value
        continue
      }
      if (key !== "moduleName" && key !== "wikidot_token7" && key !== "callbackIndex") {
        return jsonResponse({
          status: "not_ok",
          message: `Unsupported AJAX module shape: ${moduleName}`
        })
      }
    }
    const parameterNames = Object.keys(parameters)
    const isWikidotPyDefaultShape =
      parameterNames.length === MEMBERS_LIST_DEFAULT_PARAMETERS.size &&
      [...MEMBERS_LIST_DEFAULT_PARAMETERS].every((name) =>
        Object.hasOwn(parameters, name)
      )
    const isBrowserPagerShape =
      parameterNames.length === MEMBERS_LIST_PARAMETERS.size &&
      [...MEMBERS_LIST_PARAMETERS].every((name) => Object.hasOwn(parameters, name))
    if (
      (!isWikidotPyDefaultShape && !isBrowserPagerShape) ||
      parameters.group !== "" ||
      (parameters.order !== undefined && parameters.order !== "joined") ||
      !/^(?:0|[1-9]\d*)$/u.test(parameters.page)
    ) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module shape: ${moduleName}`
      })
    }
    parameters.order ??= "joined"

    const responseMetadata = () => ({
      callbackIndex: fields.has("callbackIndex")
        ? fieldValue(fields, "callbackIndex")
        : null,
      CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000),
      cssInclude: [],
      jsInclude: []
    })
    try {
      const output = await renderMembersList({ siteId, parameters })
      return jsonResponse({
        status: output.status,
        body: output.body,
        ...responseMetadata()
      })
    } catch (error) {
      console.error("AJAX MembersListModule rendering failed", error)
      return jsonResponse({
        status: "not_ok",
        body: "",
        ...responseMetadata()
      })
    }
  }

  if (moduleName === CATEGORIES_PAGE_LIST_MODULE) {
    const supportedFields = new Set([
      "moduleName",
      "category_id",
      "wikidot_token7",
      "callbackIndex"
    ])
    const categoryIdValue = fieldValue(fields, "category_id")
    if (
      !renderCategoriesPageList ||
      [...fields.keys()].some((field) => !supportedFields.has(field)) ||
      !isPositiveSafeDecimal(categoryIdValue)
    ) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module shape: ${moduleName}`
      })
    }
    const categoryId = Number.parseInt(categoryIdValue, 10)
    const responseMetadata = () => ({
      categoryId,
      callbackIndex: fields.has("callbackIndex")
        ? fieldValue(fields, "callbackIndex")
        : null,
      CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000),
      cssInclude: [],
      jsInclude: []
    })
    try {
      const output = await renderCategoriesPageList({ siteId, categoryId })
      return jsonResponse({
        status: output.status,
        body: output.body,
        ...responseMetadata()
      })
    } catch (error) {
      console.error("AJAX WikiCategoriesPageListModule rendering failed", error)
      return jsonResponse({
        status: "not_ok",
        body: "",
        ...responseMetadata()
      })
    }
  }

  if (moduleName === USERINFO_MODULE) {
    const supportedFields = new Set([
      "moduleName",
      "user_id",
      "wikidot_token7",
      "callbackIndex"
    ])
    if (
      [...fields.keys()].some((field) => !supportedFields.has(field)) ||
      fieldValue(fields, "user_id") !== ""
    ) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module shape: ${moduleName}`
      })
    }
    return jsonResponse({
      status: "ok",
      body: USERINFO_NO_USER_BODY,
      callbackIndex: null,
      CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000),
      cssInclude: [],
      jsInclude: []
    })
  }

  const siteToolsShape = moduleName ? SITE_TOOLS_READ_MODULES.get(moduleName) : undefined
  if (siteToolsShape && moduleName) {
    if (!renderSiteToolsModule) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module: ${moduleName}`
      })
    }

    /** @type {Record<string, string>} */
    const parameters = {}
    for (const [key, value] of fields) {
      if (siteToolsShape.parameters.has(key)) {
        parameters[key] = value
        continue
      }
      if (key !== "moduleName" && key !== "wikidot_token7" && key !== "callbackIndex") {
        return jsonResponse({
          status: "not_ok",
          message: `Unsupported AJAX module shape: ${moduleName}`
        })
      }
    }
    if (
      fieldValue(fields, "callbackIndex") !== siteToolsShape.callbackIndex ||
      Object.keys(parameters).length !== siteToolsShape.parameters.size ||
      ![...siteToolsShape.parameters].every((name) => Object.hasOwn(parameters, name)) ||
      (moduleName === "list/ListDraftsModule" && parameters.location !== "sitetools")
    ) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module shape: ${moduleName}`
      })
    }

    const responseMetadata = () => ({
      callbackIndex: siteToolsShape.callbackIndex,
      CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000),
      cssInclude: [],
      jsInclude: []
    })
    try {
      const output = await renderSiteToolsModule({ siteId, moduleName, parameters })
      return jsonResponse({
        status: output.status,
        body: output.body,
        ...responseMetadata()
      })
    } catch (error) {
      console.error("AJAX Site Tools rendering failed", error)
      return jsonResponse({ status: "not_ok", body: "", ...responseMetadata() })
    }
  }

  const pageReadParameters = moduleName
    ? PAGE_READ_MODULE_PARAMETERS.get(moduleName)
    : undefined
  if (pageReadParameters && moduleName) {
    if (!renderPageReadModule) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module: ${moduleName}`
      })
    }

    /** @type {Record<string, string>} */
    const parameters = {}
    for (const [key, value] of fields) {
      if (pageReadParameters.has(key)) {
        parameters[key] = value
        continue
      }
      if (key !== "moduleName" && key !== "wikidot_token7" && key !== "callbackIndex") {
        return jsonResponse({
          status: "not_ok",
          message: `Unsupported AJAX module shape: ${moduleName}`
        })
      }
    }
    if (moduleName === "viewsource/ViewSourceModule" && parameters.page_id === "0") {
      return jsonResponse({
        status: "no_page",
        message: "The page does not exist",
        callbackIndex: fields.has("callbackIndex")
          ? fieldValue(fields, "callbackIndex")
          : null,
        CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000)
      })
    }
    if (
      Object.keys(parameters).length !== pageReadParameters.size ||
      ![...pageReadParameters].every((name) => Object.hasOwn(parameters, name)) ||
      !isSupportedPageReadShape(moduleName, parameters)
    ) {
      return jsonResponse(
        {
          status: "not_ok",
          message: `Unsupported AJAX module shape: ${moduleName}`
        },
        moduleName === "pagerate/WhoRatedPageModule" ? 500 : 200
      )
    }

    const responseMetadata = () => ({
      callbackIndex: fields.has("callbackIndex")
        ? fieldValue(fields, "callbackIndex")
        : null,
      CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000),
      cssInclude: [],
      jsInclude: []
    })
    try {
      const output = await renderPageReadModule({ siteId, moduleName, parameters })
      return jsonResponse({
        status: output.status,
        body: output.body,
        ...responseMetadata(),
        jsInclude: output.js_include ?? []
      })
    } catch (error) {
      console.error("AJAX page read module rendering failed", error)
      return jsonResponse({
        status: "not_ok",
        body: "",
        ...responseMetadata()
      })
    }
  }

  const forumParameterShapes = moduleName
    ? FORUM_READ_MODULE_PARAMETERS.get(moduleName)
    : undefined
  if (forumParameterShapes) {
    if (!renderForumModule) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module: ${moduleName}`
      })
    }

    /** @type {Record<string, string>} */
    const parameters = {}
    for (const [key, value] of fields) {
      if (CONTROL_FIELDS.has(key)) {
        if (key === "module_body") {
          return jsonResponse({
            status: "not_ok",
            message: `Unsupported AJAX module shape: ${moduleName}`
          })
        }
        continue
      }
      if (!forumParameterShapes.some((shape) => shape.has(key))) {
        return jsonResponse({
          status: "not_ok",
          message: `Unsupported AJAX module shape: ${moduleName}`
        })
      }
      parameters[key] = value
    }
    if (
      !forumParameterShapes.some(
        (shape) =>
          shape.size === Object.keys(parameters).length &&
          Object.keys(parameters).every((parameter) => shape.has(parameter))
      )
    ) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module shape: ${moduleName}`
      })
    }
    if (
      moduleName === "forum/ForumCommentsListModule" &&
      parameters.order !== undefined &&
      parameters.order !== "reverse" &&
      parameters.order !== "forwards"
    ) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module shape: ${moduleName}`
      })
    }
    if (
      moduleName === "forum/ForumStartModule" &&
      parameters.hidden !== undefined &&
      parameters.hidden !== "true"
    ) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module shape: ${moduleName}`
      })
    }
    if (!forumNumericParametersAreCanonical(parameters)) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module shape: ${moduleName}`
      })
    }
    const callbackIndex = fields.has("callbackIndex")
      ? fieldValue(fields, "callbackIndex")
      : null
    const responseMetadata = () => ({
      callbackIndex,
      CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000),
      cssInclude: [],
      jsInclude: []
    })
    try {
      const output = await renderForumModule({ siteId, moduleName, parameters })
      const body = {
        status: output.status,
        body: output.body,
        ...responseMetadata(),
        jsInclude: output.js_include ?? [],
        ...(output.thread_id === undefined ? {} : { threadId: output.thread_id })
      }
      return jsonResponse(body)
    } catch (error) {
      console.error("AJAX forum rendering failed", error)
      return jsonResponse({
        status: "not_ok",
        body: "",
        ...responseMetadata()
      })
    }
  }

  if (moduleName !== "list/ListPagesModule") {
    return jsonResponse({
      status: "not_ok",
      message: `Unsupported AJAX module: ${moduleName ?? ""}`
    })
  }

  const moduleBody = fields.get("module_body") ?? ""

  /** @type {Record<string, string>} */
  const parameters = {}
  for (const [key, value] of fields) {
    if (CONTROL_FIELDS.has(key)) continue
    if (key.startsWith("_")) {
      return jsonResponse({
        status: "not_ok",
        message: `Unsupported AJAX module shape: ${moduleName}`
      })
    }
    if (!LIST_PAGES_PARAMETERS.has(key.toLowerCase())) {
      continue
    }
    parameters[key] = value
  }

  // Live Wikidot validates the selected (last) public token against the
  // presented cookie by exact echo before rendering ListPages rows: a
  // mismatch, including a missing form token or a missing cookie, fails
  // with `wrong_token7`, while equal present tokens are accepted.
  const formToken = fields.get("wikidot_token7")
  if (formToken === undefined || formToken !== requestWikidotTokenCookie(request)) {
    return jsonResponse({
      status: "wrong_token7",
      message: "no",
      CURRENT_TIMESTAMP: Math.floor(Date.now() / 1000),
      callbackIndex: fields.has("callbackIndex")
        ? fieldValue(fields, "callbackIndex")
        : null
    })
  }

  try {
    const output = await renderListPages({
      siteId,
      moduleBody,
      parameters
    })
    return jsonResponse({ status: "ok", body: output.body })
  } catch (error) {
    console.error("AJAX ListPages rendering failed", error)
    return jsonResponse({
      status: "not_ok",
      message: "Unable to render ListPages module"
    })
  }
}
