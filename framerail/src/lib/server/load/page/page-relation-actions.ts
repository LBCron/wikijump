import {
  pageBacklinksView,
  pageChildrenGet,
  pageParentGet,
  pageParentTrace,
  pageParentUpdate,
  pageScore,
  pageWatchers,
  pageVoteCast,
  pageVoteList,
  pageVoteRemove,
  wikidotLegacyRate,
  wikidotLegacySetTags
} from "$lib/server/deepwell/page"
import { pageFileList } from "$lib/server/deepwell/page-file"
import {
  failForActionError,
  pageActionBaseSchema,
  readActionJson
} from "$lib/server/load/page/page-action-shared"
import { executePageAction } from "$lib/server/load/page/page-action-execution"
import { resolvePageActionRequestContext } from "$lib/server/load/page/page-action-context"
import { fail, superValidate } from "sveltekit-superforms"
import { valibot } from "sveltekit-superforms/adapters"
import { array, integer, minValue, number, object, optional, pipe, string } from "valibot"

import type { RequestEvent } from "@sveltejs/kit"

export async function pageParentSetAction(event: RequestEvent) {
  const { request } = event
  const form = await superValidate(request, valibot(pageParentSetSchema), {
    strict: true
  })
  if (!form.valid) {
    return fail(400, { form })
  }

  try {
    const { siteId, pageId, addParents, removeParents } = form.data
    const context = await resolvePageActionRequestContext(event, {
      submittedSiteId: siteId,
      session: "required"
    })
    const res = await pageParentUpdate(
      siteId,
      pageId,
      context.sessionUserId,
      addParents,
      removeParents,
      context.requestContext
    )
    return { form, res }
  } catch (error) {
    return failForActionError(error, { form })
  }
}

export const pageParentFormSchema = object({
  parents: string()
})

const pageParentSetSchema = object({
  ...pageActionBaseSchema,
  addParents: optional(array(string())),
  removeParents: optional(array(string()))
})

export async function pageParentGetAction(event: RequestEvent) {
  const { request } = event
  try {
    const requestData = await readActionJson(request, pageParentGetSchema)
    const { pageId, slug } = requestData
    const context = await resolvePageActionRequestContext(event)
    const res = await pageParentGet(context.siteId, pageId, slug, context.requestContext)
    return { res }
  } catch (error) {
    return failForActionError(error)
  }
}

export async function pageParentTraceAction(event: RequestEvent) {
  const { request } = event
  try {
    const requestData = await readActionJson(request, pageParentGetSchema)
    const { pageId, slug } = requestData
    const context = await resolvePageActionRequestContext(event)
    const res = await pageParentTrace(
      context.siteId,
      pageId,
      slug,
      context.requestContext
    )
    return { res }
  } catch (error) {
    return failForActionError(error)
  }
}

export async function pageChildrenGetAction(event: RequestEvent) {
  const { request } = event
  try {
    const requestData = await readActionJson(request, pageParentGetSchema)
    const { pageId, slug } = requestData
    const context = await resolvePageActionRequestContext(event)
    const res = await pageChildrenGet(
      context.siteId,
      pageId,
      slug,
      context.requestContext
    )
    return { res }
  } catch (error) {
    return failForActionError(error)
  }
}

export async function pageBacklinksAction(event: RequestEvent) {
  const { params } = event
  try {
    const context = await resolvePageActionRequestContext(event)
    const res = await pageBacklinksView(
      context.siteId,
      params.slug,
      context.requestContext
    )
    return { res }
  } catch (error) {
    return failForActionError(error)
  }
}

const pageParentGetSchema = object({
  pageId: optional(number()),
  slug: string()
})

export async function pageVoteListAction(event: RequestEvent) {
  const { request } = event
  try {
    const requestData = await readActionJson(request, pageIdActionSchema)
    const { siteId, pageId } = requestData
    const context = await resolvePageActionRequestContext(event, {
      submittedSiteId: siteId
    })
    await pageFileList(siteId, pageId, false, context.requestContext)
    const res = await pageVoteList(pageId, context.requestContext)
    return { res }
  } catch (error) {
    return failForActionError(error)
  }
}

export async function pageWatchersAction(event: RequestEvent) {
  const { request } = event
  try {
    const { pageId } = await readActionJson(request, pageWatchersSchema)
    const context = await resolvePageActionRequestContext(event)
    const res = await pageWatchers(context.siteId, pageId, context.requestContext)
    return { res }
  } catch (error) {
    return failForActionError(error)
  }
}

export async function pageVoteCastAction(event: RequestEvent) {
  const { request } = event
  return executePageAction(async () => {
    const requestData = await readActionJson(request, pageVoteCastSchema)
    const { pageId, value } = requestData
    const context = await resolvePageActionRequestContext(event, {
      session: "required"
    })
    const res = await pageVoteCast(pageId, value, context.requestContext)
    return res
  }, failForActionError)
}

export async function pageVoteRemoveAction(event: RequestEvent) {
  const { request } = event
  try {
    const requestData = await readActionJson(request, pageVoteRemoveSchema)
    const { pageId } = requestData
    const context = await resolvePageActionRequestContext(event, {
      session: "required"
    })
    const res = await pageVoteRemove(pageId, context.requestContext)
    return { res }
  } catch (error) {
    return failForActionError(error)
  }
}

export async function pageScoreAction(event: RequestEvent) {
  try {
    const context = await resolvePageActionRequestContext(event)
    const res = await pageScore(context.requestContext)
    return { res }
  } catch (error) {
    return failForActionError(error)
  }
}

const pageIdActionSchema = object(pageActionBaseSchema)

const pageWatchersSchema = object({
  pageId: number()
})

const pageVoteCastSchema = object({
  pageId: number(),
  value: number()
})

const pageVoteRemoveSchema = object({
  pageId: number()
})

const wikidotLegacySetTagsSchema = object({
  pageId: number(),
  lastRevisionId: number(),
  actionIndex: pipe(number(), integer(), minValue(0)),
  actionFingerprint: string()
})

const wikidotLegacyRateSchema = object({
  pageId: number(),
  lastRevisionId: number(),
  actionIndex: pipe(number(), integer(), minValue(0)),
  actionFingerprint: string()
})

export async function wikidotLegacyRateAction(event: RequestEvent) {
  const { request } = event
  return executePageAction(async () => {
    const { pageId, lastRevisionId, actionIndex, actionFingerprint } =
      await readActionJson(request, wikidotLegacyRateSchema)
    const context = await resolvePageActionRequestContext(event, {
      session: "required"
    })
    return wikidotLegacyRate(
      pageId,
      lastRevisionId,
      actionIndex,
      actionFingerprint,
      context.requestContext
    )
  }, failForActionError)
}

export async function wikidotLegacySetTagsAction(event: RequestEvent) {
  const { request, getClientAddress } = event
  return executePageAction(async () => {
    const { pageId, lastRevisionId, actionIndex, actionFingerprint } =
      await readActionJson(request, wikidotLegacySetTagsSchema)
    const context = await resolvePageActionRequestContext(event, {
      session: "required"
    })
    return wikidotLegacySetTags(
      pageId,
      lastRevisionId,
      actionIndex,
      actionFingerprint,
      context.sessionUserId,
      getClientAddress(),
      context.requestContext
    )
  }, failForActionError)
}
