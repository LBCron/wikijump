import {
  pageDeletedGet,
  pageHistory,
  pageRestore,
  pageRevision,
  pageRevisionDiff,
  pageRollback
} from "$lib/server/deepwell/page"
import {
  failForActionError,
  pageActionBaseSchema,
  pageMutationBaseSchema,
  readActionJson
} from "$lib/server/load/page/page-action-shared"
import { resolvePageActionRequestContext } from "$lib/server/load/page/page-action-context"
import { fail, superValidate } from "sveltekit-superforms"
import { valibot } from "sveltekit-superforms/adapters"
import { array, boolean, number, object, optional, string } from "valibot"
import {
  filterHistoryByTypes,
  paginateHistoryEntries
} from "$lib/wikidot-history-contract"
import type { RequestEvent } from "@sveltejs/kit"

const HISTORY_WINDOW_LIMIT = 1_000

export async function pageHistoryAction(event: RequestEvent) {
  const { request } = event
  try {
    const requestData = await readActionJson(request, pageHistorySchema)

    const { siteId, pageId, revisionNumber, includeFileRevisions, types, page, perPage } =
      requestData
    const context = await resolvePageActionRequestContext(event, {
      submittedSiteId: siteId
    })
    const window = await pageHistory(
      siteId,
      pageId,
      revisionNumber,
      HISTORY_WINDOW_LIMIT,
      context.requestContext,
      includeFileRevisions ?? false
    )
    const normalized = window.map((rawRevision) => ({
      ...rawRevision,
      history_kind: rawRevision.history_kind ?? "page",
      history_row_id: rawRevision.history_row_id ?? String(rawRevision.revision_id),
      timeline_number: rawRevision.timeline_number ?? rawRevision.revision_number,
      page_revision_number:
        rawRevision.page_revision_number === undefined
          ? rawRevision.history_kind === "file"
            ? null
            : rawRevision.revision_number
          : rawRevision.page_revision_number
    }))
    const filtered = filterHistoryByTypes(normalized, types ?? [])
    const paged = paginateHistoryEntries(filtered, page ?? 1, perPage ?? 20)
    return {
      res: {
        entries: filtered,
        total: paged.total,
        page: paged.page,
        perPage: paged.perPage,
        totalPages: paged.totalPages
      }
    }
  } catch (error) {
    return failForActionError(error)
  }
}

const pageHistorySchema = object({
  ...pageActionBaseSchema,
  revisionNumber: optional(number()),
  limit: optional(number()),
  includeFileRevisions: optional(boolean()),
  types: optional(array(string())),
  page: optional(number()),
  perPage: optional(number())
})

export async function pageRevisionAction(event: RequestEvent) {
  const { request } = event
  try {
    const requestData = await readActionJson(request, pageRevisionSchema)

    const { siteId, pageId, revisionNumber, compiledHtml, wikitext } = requestData
    const context = await resolvePageActionRequestContext(event, {
      submittedSiteId: siteId
    })
    const res = await pageRevision(
      siteId,
      pageId,
      revisionNumber,
      compiledHtml ?? true,
      wikitext ?? true,
      context.requestContext
    )
    return { res }
  } catch (error) {
    return failForActionError(error)
  }
}

const pageRevisionSchema = object({
  ...pageActionBaseSchema,
  revisionNumber: number(),
  compiledHtml: optional(boolean()),
  wikitext: optional(boolean())
})

export async function pageRevisionDiffAction(event: RequestEvent) {
  const { request } = event
  try {
    const requestData = await readActionJson(request, pageRevisionDiffSchema)
    const { siteId, pageId, fromRevisionNumber, toRevisionNumber } = requestData
    const context = await resolvePageActionRequestContext(event, {
      submittedSiteId: siteId
    })
    const res = await pageRevisionDiff(
      siteId,
      pageId,
      fromRevisionNumber,
      toRevisionNumber,
      context.requestContext
    )
    return { res }
  } catch (error) {
    return failForActionError(error)
  }
}

const pageRevisionDiffSchema = object({
  ...pageActionBaseSchema,
  fromRevisionNumber: number(),
  toRevisionNumber: number()
})

export async function pageRollbackAction(event: RequestEvent) {
  const { request, params, getClientAddress } = event
  const { slug } = params
  const ipAddress = getClientAddress()
  try {
    const requestData = await readActionJson(request, pageRollbackSchema)

    const { siteId, pageId, revisionNumber, comments, lastRevisionId } = requestData
    const context = await resolvePageActionRequestContext(event, {
      submittedSiteId: siteId,
      session: "required"
    })
    const res = await pageRollback(
      {
        siteId,
        pageId,
        userId: context.sessionUserId,
        userIpAddr: ipAddress,
        slug,
        lastRevisionId,
        revisionNumber,
        revisionComments: comments ?? ""
      },
      context.requestContext
    )
    return { res }
  } catch (error) {
    return failForActionError(error)
  }
}

const pageRollbackSchema = object({
  ...pageMutationBaseSchema,
  revisionNumber: number(),
  comments: optional(string())
})

export async function pageDeletedGetAction(event: RequestEvent) {
  try {
    const context = await resolvePageActionRequestContext(event, {
      session: "required"
    })
    const res = await pageDeletedGet(context.requestContext)
    return { res }
  } catch (error) {
    return failForActionError(error)
  }
}

export async function pageRestoreAction(event: RequestEvent) {
  const { request, getClientAddress } = event
  const form = await superValidate(request, valibot(pageRestoreSchema))
  if (!form.valid) {
    return fail(400, { form })
  }

  const ipAddress = getClientAddress()

  try {
    const { siteId, pageId, comments } = form.data
    const context = await resolvePageActionRequestContext(event, {
      submittedSiteId: siteId,
      session: "required"
    })
    const res = await pageRestore(
      siteId,
      pageId,
      context.sessionUserId,
      ipAddress,
      comments,
      context.requestContext
    )
    return { form, res }
  } catch (error) {
    return failForActionError(error, { form })
  }
}

export const pageRestoreSchema = object({
  ...pageMutationBaseSchema,
  comments: string()
})
