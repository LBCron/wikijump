import { client } from "$lib/server/deepwell"

import type { Nullable, Optional } from "$lib/types"
import type { RequestContext } from "../request-context"

export type PageEditLockMode = "page" | "append" | "section"

export interface PageEditLockGrant {
  lock_id: number
  lock_secret: string
  base_revision_id: Nullable<number>
  expires_at: string
}

export interface PageEditLockConflictInfo {
  user_id: number
  mode: PageEditLockMode
  section_index: Nullable<number>
  seconds_remaining: number
}

export interface PageEditLockAcquireOutput {
  grant: Nullable<PageEditLockGrant>
  conflicts: PageEditLockConflictInfo[]
}

export interface PageEditLockRenewOutput {
  lock_id: number
  lock_secret: string
  base_revision_id: Nullable<number>
  lock_recreated: boolean
  expires_at: string
}

export interface PageEditLockAcquireInput {
  pageId: Optional<number>
  slug: string
  mode: PageEditLockMode
  sectionIndex: Optional<number>
}

const acquireParams = (input: PageEditLockAcquireInput) => ({
  page: input.pageId ?? input.slug,
  mode: input.mode,
  section_index: input.sectionIndex
})

export async function pageEditLockAcquire(
  input: PageEditLockAcquireInput,
  requestContext: RequestContext
): Promise<PageEditLockAcquireOutput> {
  return client.request("page_edit_lock_acquire", acquireParams(input), requestContext)
}

export async function pageEditLockForceAcquire(
  input: PageEditLockAcquireInput,
  requestContext: RequestContext
): Promise<PageEditLockAcquireOutput> {
  return client.request(
    "page_edit_lock_force_acquire",
    acquireParams(input),
    requestContext
  )
}

export interface PageEditLockRenewInput {
  pageId: Optional<number>
  slug: string
  lockId: number
  lockSecret: string
  mode: PageEditLockMode
  sectionIndex: Optional<number>
}

export async function pageEditLockRenew(
  input: PageEditLockRenewInput,
  requestContext: RequestContext
): Promise<PageEditLockRenewOutput> {
  const params = {
    page: input.pageId ?? input.slug,
    lock_id: input.lockId,
    "lock_secret": input.lockSecret,
    mode: input.mode,
    section_index: input.sectionIndex
  }
  return client.request("page_edit_lock_renew", params, requestContext)
}

export interface PageEditLockReleaseInput {
  pageId: Optional<number>
  slug: string
  lockId: number
  lockSecret: string
}

export async function pageEditLockRelease(
  input: PageEditLockReleaseInput,
  requestContext: RequestContext
): Promise<boolean> {
  const params = {
    page: input.pageId ?? input.slug,
    lock_id: input.lockId,
    "lock_secret": input.lockSecret
  }
  return client.request("page_edit_lock_release", params, requestContext)
}

export interface LeaseSaveInput {
  siteId: number
  pageId: Optional<number>
  slug: string
  userId: number
  userIpAddr: string
  lastRevisionId: number
  revisionComments: string
  wikitext: string
  title: string
  altTitle?: Optional<string>
  tags?: string[]
  lease?: {
    lockId: number
    lockSecret: string
    mode: PageEditLockMode
    sectionIndex: Optional<number>
  }
}

export interface LeaseSaveOutput {
  revision_id: number
  revision_number: number
  lock_recreated: boolean
}

export async function pageSave(
  input: LeaseSaveInput,
  requestContext: RequestContext
): Promise<Nullable<LeaseSaveOutput>> {
  const lease = input.lease
    ? {
        lock_id: input.lease.lockId,
        "lock_secret": input.lease.lockSecret,
        mode: input.lease.mode,
        section_index: input.lease.sectionIndex
      }
    : undefined
  return client.request(
    "page_edit",
    {
      site_id: input.siteId,
      page: input.pageId ?? input.slug,
      last_revision_id: input.lastRevisionId,
      revision_comments: input.revisionComments,
      user_id: input.userId,
      ip_address: input.userIpAddr,
      wikitext: input.wikitext,
      title: input.title,
      alt_title: input.altTitle,
      tags: input.tags,
      lease
    },
    requestContext
  )
}

export const secondsUntil = (expiresAt: string): number =>
  Math.max(0, Math.round((Date.parse(expiresAt) - Date.now()) / 1000))

const headingLevel = (line: string): number | null => {
  let pluses = 0
  while (pluses < line.length && line[pluses] === "+") pluses += 1
  if (pluses === 0 || pluses > 6) return null
  let rest = line.slice(pluses)
  if (rest.startsWith("*")) rest = rest.slice(1)
  return rest === "" || rest.startsWith(" ") ? pluses : null
}

export interface WikidotSectionRange {
  rangeStart: number
  rangeEnd: number
  text: string
}

export const wikidotSectionRange = (
  wikitext: string,
  sectionIndex: number
): WikidotSectionRange | null => {
  if (sectionIndex < 0) return null
  const lines = wikitext.split("\n").map((line) => line.replace(/\r$/u, ""))
  const headings: { index: number; level: number }[] = []
  lines.forEach((line, index) => {
    const level = headingLevel(line)
    if (level !== null) headings.push({ index, level })
  })
  const heading = headings[sectionIndex]
  if (!heading) return null
  const next = headings
    .slice(sectionIndex + 1)
    .find((other) => other.level <= heading.level)
  const end = next ? next.index : lines.length
  return {
    rangeStart: heading.index,
    rangeEnd: end - 1,
    text: lines.slice(heading.index, end).join("\n")
  }
}
