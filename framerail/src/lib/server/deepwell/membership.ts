import { client } from "$lib/server/deepwell"

import type { RequestContext } from "$lib/server/request-context"

export type MembershipJoinOutcome = "joined" | "already_member"
export type MembershipPasswordOutcome = "joined" | "already_member" | "wrong_password"
export type MembershipApplicationOutcome =
  "submitted" | "already_applied" | "already_member" | "no_text"

export type MembershipEmailInvitationOutcome =
  | { status: "accepted"; site_name: string; site_slug: string }
  | { status: "already_member" }
  | { status: "unavailable" }
export type MembershipApplicationStatus = "pending" | "accepted" | "declined"

export interface MembershipApplicationView {
  user_id: number
  user_name: string
  status: MembershipApplicationStatus
  comment: string
}

export interface WikidotMembersListModuleOutput {
  status: string
  body: string
}

export async function wikidotMembersListModule(
  siteId: number,
  parameters: Record<string, string>,
  context: RequestContext = {}
): Promise<WikidotMembersListModuleOutput> {
  return client.request(
    "wikidot_members_list_module",
    { site_id: siteId, parameters },
    context
  )
}

export async function membershipJoin(
  pageId: number,
  lastRevisionId: number,
  actionIndex: number,
  actionFingerprint: string,
  ipAddress: string,
  context: Exclude<RequestContext, void>
): Promise<MembershipJoinOutcome> {
  return await client.request(
    "membership_join",
    {
      page_id: pageId,
      last_revision_id: lastRevisionId,
      action_index: actionIndex,
      action_fingerprint: actionFingerprint,
      ip_address: ipAddress
    },
    context
  )
}

export async function membershipPasswordSubmit(
  pageId: number,
  lastRevisionId: number,
  actionIndex: number,
  actionFingerprint: string,
  password: string,
  ipAddress: string,
  context: Exclude<RequestContext, void>
): Promise<MembershipPasswordOutcome> {
  return client.request(
    "membership_password_submit",
    {
      page_id: pageId,
      last_revision_id: lastRevisionId,
      action_index: actionIndex,
      action_fingerprint: actionFingerprint,
      password,
      ip_address: ipAddress
    },
    context
  )
}

export async function membershipApplicationSubmit(
  pageId: number,
  lastRevisionId: number,
  actionIndex: number,
  actionFingerprint: string,
  comment: string,
  context: Exclude<RequestContext, void>
): Promise<MembershipApplicationOutcome> {
  return client.request(
    "membership_application_submit",
    {
      page_id: pageId,
      last_revision_id: lastRevisionId,
      action_index: actionIndex,
      action_fingerprint: actionFingerprint,
      comment
    },
    context
  )
}

export async function membershipEmailInvitationAccept(
  pageId: number,
  lastRevisionId: number,
  actionIndex: number,
  actionFingerprint: string,
  hash: string,
  ipAddress: string,
  context: Exclude<RequestContext, void>
): Promise<MembershipEmailInvitationOutcome> {
  return client.request(
    "membership_email_invitation_accept",
    {
      page_id: pageId,
      last_revision_id: lastRevisionId,
      action_index: actionIndex,
      action_fingerprint: actionFingerprint,
      hash,
      ip_address: ipAddress
    },
    context
  )
}

export async function membershipApplicationList(
  siteId: number,
  context: Exclude<RequestContext, void>
): Promise<MembershipApplicationView[]> {
  return client.request("membership_application_list", { site_id: siteId }, context)
}

export async function membershipApplicationReview(
  siteId: number,
  userId: number,
  decision: "accept" | "decline",
  reply: string,
  ipAddress: string,
  context: Exclude<RequestContext, void>
): Promise<MembershipApplicationStatus> {
  return client.request(
    "membership_application_review",
    {
      site_id: siteId,
      user_id: userId,
      decision,
      reply,
      ip_address: ipAddress
    },
    context
  )
}
