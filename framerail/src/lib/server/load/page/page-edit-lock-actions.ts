import {
  pageEditLockAcquire,
  pageEditLockForceAcquire,
  pageEditLockRelease,
  pageEditLockRenew
} from "$lib/server/deepwell/page-edit-lock"
import {
  failForActionError,
  readActionJson
} from "$lib/server/load/page/page-action-shared"
import {
  requirePageMutationUserId,
  resolvePageActionRequestContext
} from "$lib/server/load/page/page-action-context"
import { nullable, number, object, optional, picklist, string } from "valibot"

import type { RequestEvent } from "@sveltejs/kit"

const leaseModeSchema = picklist(["page", "append", "section"])

const acquireSchema = object({
  mode: leaseModeSchema,
  sectionIndex: optional(nullable(number()))
})

const renewSchema = object({
  lockId: number(),
  lockSecret: string(),
  mode: leaseModeSchema,
  sectionIndex: optional(nullable(number()))
})

const releaseSchema = object({
  lockId: number(),
  lockSecret: string()
})

async function pageEditLockAcquireImpl(event: RequestEvent, force: boolean) {
  const { request, params } = event
  try {
    const { mode, sectionIndex } = await readActionJson(request, acquireSchema)
    const context = await resolvePageActionRequestContext(event, {
      session: "optional"
    })
    requirePageMutationUserId(context, context.siteId)
    const input = {
      pageId: undefined,
      slug: params.slug ?? "",
      mode,
      sectionIndex: sectionIndex ?? undefined
    }
    const res = force
      ? await pageEditLockForceAcquire(input, context.requestContext)
      : await pageEditLockAcquire(input, context.requestContext)
    return { res }
  } catch (error) {
    return failForActionError(error)
  }
}

export async function pageEditLockAcquireAction(event: RequestEvent) {
  return pageEditLockAcquireImpl(event, false)
}

export async function pageEditLockForceAcquireAction(event: RequestEvent) {
  return pageEditLockAcquireImpl(event, true)
}

export async function pageEditLockRenewAction(event: RequestEvent) {
  const { request, params } = event
  try {
    const { lockId, lockSecret, mode, sectionIndex } = await readActionJson(
      request,
      renewSchema
    )
    const context = await resolvePageActionRequestContext(event, {
      session: "optional"
    })
    requirePageMutationUserId(context, context.siteId)
    const res = await pageEditLockRenew(
      {
        pageId: undefined,
        slug: params.slug ?? "",
        lockId,
        lockSecret,
        mode,
        sectionIndex: sectionIndex ?? undefined
      },
      context.requestContext
    )
    return { res }
  } catch (error) {
    return failForActionError(error)
  }
}

export async function pageEditLockReleaseAction(event: RequestEvent) {
  const { request, params } = event
  try {
    const { lockId, lockSecret } = await readActionJson(request, releaseSchema)
    const context = await resolvePageActionRequestContext(event, {
      session: "optional"
    })
    requirePageMutationUserId(context, context.siteId)
    const res = await pageEditLockRelease(
      {
        pageId: undefined,
        slug: params.slug ?? "",
        lockId,
        lockSecret
      },
      context.requestContext
    )
    return { res }
  } catch (error) {
    return failForActionError(error)
  }
}
