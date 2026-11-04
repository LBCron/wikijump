import {
  membershipApplicationSubmit,
  membershipEmailInvitationAccept,
  membershipJoin,
  membershipPasswordSubmit
} from "$lib/server/deepwell/membership"
import {
  failForActionError,
  readActionJson
} from "$lib/server/load/page/page-action-shared"
import { executePageAction } from "$lib/server/load/page/page-action-execution"
import { resolvePageActionRequestContext } from "$lib/server/load/page/page-action-context"
import { integer, minValue, number, object, pipe, string } from "valibot"

import type { RequestEvent } from "@sveltejs/kit"

const membershipJoinSchema = object({
  pageId: number(),
  lastRevisionId: number(),
  actionIndex: pipe(number(), integer(), minValue(0)),
  actionFingerprint: string()
})

const membershipPasswordSchema = object({
  pageId: number(),
  lastRevisionId: number(),
  actionIndex: pipe(number(), integer(), minValue(0)),
  actionFingerprint: string(),
  password: string()
})

const membershipApplicationSchema = object({
  pageId: number(),
  lastRevisionId: number(),
  actionIndex: pipe(number(), integer(), minValue(0)),
  actionFingerprint: string(),
  comment: string()
})

const membershipEmailInvitationSchema = membershipJoinSchema

function routeArgument(extra: string | undefined, name: string): string {
  const segments = (extra ?? "").replace(/^\//u, "").split("/")
  let value = ""
  for (let index = 0; index + 1 < segments.length; index += 1) {
    if (segments[index]?.toLowerCase() === name.toLowerCase()) {
      value = segments[index + 1] ?? ""
    }
  }
  return value
}

export function membershipJoinAction(event: RequestEvent) {
  return executePageAction(async () => {
    const { pageId, lastRevisionId, actionIndex, actionFingerprint } =
      await readActionJson(event.request, membershipJoinSchema)
    const context = await resolvePageActionRequestContext(event, {
      session: "required"
    })
    return membershipJoin(
      pageId,
      lastRevisionId,
      actionIndex,
      actionFingerprint,
      event.getClientAddress(),
      context.requestContext
    )
  }, failForActionError)
}

export function membershipPasswordAction(event: RequestEvent) {
  return executePageAction(async () => {
    const { pageId, lastRevisionId, actionIndex, actionFingerprint, password } =
      await readActionJson(event.request, membershipPasswordSchema)
    const context = await resolvePageActionRequestContext(event, {
      session: "required"
    })
    return membershipPasswordSubmit(
      pageId,
      lastRevisionId,
      actionIndex,
      actionFingerprint,
      password,
      event.getClientAddress(),
      context.requestContext
    )
  }, failForActionError)
}

export function membershipApplicationAction(event: RequestEvent) {
  return executePageAction(async () => {
    const { pageId, lastRevisionId, actionIndex, actionFingerprint, comment } =
      await readActionJson(event.request, membershipApplicationSchema)
    const context = await resolvePageActionRequestContext(event, {
      session: "required"
    })
    return membershipApplicationSubmit(
      pageId,
      lastRevisionId,
      actionIndex,
      actionFingerprint,
      comment,
      context.requestContext
    )
  }, failForActionError)
}

export function membershipEmailInvitationAction(event: RequestEvent) {
  return executePageAction(async () => {
    const { pageId, lastRevisionId, actionIndex, actionFingerprint } =
      await readActionJson(event.request, membershipEmailInvitationSchema)
    const context = await resolvePageActionRequestContext(event, {
      session: "required"
    })
    return membershipEmailInvitationAccept(
      pageId,
      lastRevisionId,
      actionIndex,
      actionFingerprint,
      routeArgument(event.params.extra, "hash"),
      event.getClientAddress(),
      context.requestContext
    )
  }, failForActionError)
}
