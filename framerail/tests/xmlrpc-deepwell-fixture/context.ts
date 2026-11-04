import type { IncomingMessage } from "node:http"

import { pages } from "./data.ts"

export type RpcParams = Record<string, any>

export type FixtureFile = {
  content: Buffer
  file_created_at: string
  file_id: number
  file_updated_at: string | null
  mime: string
  name: string
  revision_comments: string
  revision_created_at: string
  revision_id: number
  revision_type?: string
  revision_user_id: number
  size: number
  size_with_data?: number
}

export type RecordedRpcRequest = {
  headers: Record<string, string | string[] | undefined>
  params: unknown
}

export const createAuthenticatedUser = () => ({
  user_id: 6000008,
  user_type: "regular",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: null,
  deleted_at: null,
  from_wikidot: false,
  name: "Fixture Member",
  slug: "fixture-member",
  name_changes_left: 0,
  last_name_change_added_at: "2026-01-01T00:00:00Z",
  last_renamed_at: null,
  email: "fixture-member@example.test",
  email_verified_at: null,
  email_validation_info: null,
  email_validation_at: null,
  password: "",
  multi_factor_secret: null,
  multi_factor_recovery_codes: null,
  locales: ["en"],
  avatar_s3_hash: [17, 34, 51],
  forum_signature: null,
  real_name: null,
  gender: null,
  birthday: null,
  location: null,
  biography: null,
  website: null,
  user_page: null
})

export const fixtureState = {
  authenticatedUser: createAuthenticatedUser(),
  lastPageTagsSelectRequest: null as RecordedRpcRequest | null,
  lastPageSelectParams: null as RpcParams | null,
  pageReadRequests: {
    backlinksView: [],
    watchersView: [],
    forumPostSelect: [],
    forumPostPageSummary: [],
    forumPostGet: [],
    pageGet: [],
    pageGetDirect: [],
    pageLifecycleIdentity: [],
    pageRevisionDiff: [],
    pageRevisionGet: [],
    pageView: [],
    pageViewPermission: [],
    pageSelect: [],
    parentDirectMetadata: [],
    parentRelationshipsGet: [],
    siteGet: [],
    voteList: [],
    pageGetScore: []
  } as Record<string, unknown[]>,
  forumModuleRequests: [] as {
    headers: Record<string, string | string[] | undefined>
    params: RpcParams
  }[],
  pendingPageRevisionDiffResponse: null as
    null | ((outcome?: "success" | "failure") => void),
  articleReadRequests: {
    articleView: [],
    articleViewCacheMetadata: []
  } as Record<string, unknown[]>,
  pageWriteRequests: {
    login: [],
    pageCreate: [],
    pageEdit: [],
    pageEditLockAcquire: [],
    pageEditLockRelease: [],
    pageRollback: [],
    pageMove: [],
    parentGetAll: [],
    parentUpdate: [],
    sessionGet: [],
    userGet: [],
    userEdit: [],
    voteSet: [],
    voteRemove: []
  } as Record<string, (RecordedRpcRequest | { paramKeys: string[] })[]>,
  userCreateRequests: [] as Record<string, unknown>[],
  siteCreateRequests: [] as Record<string, unknown>[],
  lastCreatedSiteSlug: null as string | null,
  fileRequests: {
    blobUpload: [],
    fileCreate: [],
    fileEdit: [],
    fileGet: [],
    fileRestore: [],
    pageGetFiles: []
  } as Record<string, RecordedRpcRequest[]>,
  pendingUploads: {} as Record<string, Buffer>,
  filesByPageId: {} as Record<number, Record<string, FixtureFile>>,
  deletedFilesByPageId: {} as Record<number, Record<string, FixtureFile>>,
  counters: {
    nextPageId: 4000000,
    nextRevisionId: 9100000,
    nextFileId: 5000000,
    nextPendingBlobId: 1,
    nextEditLockId: 7000000
  },
  editLocks: {} as Record<
    string,
    {
      lock_id: number
      secret: string
      user_id: number
      mode: string
      section_index: number | null
    }
  >,
  ratingScores: {
    3000341: 3,
    3000342: 0
  } as Record<number, number>,
  voteValues: {} as Record<number, number>
}

export const isFixtureSiteId = (siteId: number) =>
  siteId === 6000005 || siteId === 6000006

const MIN_I64 = -(1n << 63n)
const MAX_I64 = (1n << 63n) - 1n

export const isSignedI64String = (value: string): boolean => {
  if (!/^-?\d+$/.test(value)) return false
  const parsed = BigInt(value)
  return parsed >= MIN_I64 && parsed <= MAX_I64
}

export const hasExactKeys = (value: unknown, keys: string[]) => {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join("\n") === keys.slice().sort().join("\n")
  )
}

export const pageById = (pageId: number) =>
  Object.values(pages).find((page) => page.page_id === pageId) ?? null

export const toFileResultWithoutData = (file: FixtureFile) => toFileResult(file, false)

export const toFileResult = (file: FixtureFile, includeData: boolean) => {
  const result: Record<string, unknown> = {
    file_id: file.file_id,
    file_created_at: file.file_created_at,
    file_updated_at: file.file_updated_at,
    revision_id: file.revision_id,
    revision_created_at: file.revision_created_at,
    revision_user_id: file.revision_user_id,
    name: file.name,
    mime: file.mime,
    size:
      includeData && file.size_with_data !== undefined ? file.size_with_data : file.size,
    revision_comments: file.revision_comments
  }
  if (file.revision_type !== undefined) result.revision_type = file.revision_type
  if (includeData) result.data = Array.from(file.content)
  return result
}

export const createFixtureFile = (
  name: string,
  content: Buffer,
  revisionComments: string,
  userId: number,
  updated: boolean
): FixtureFile => ({
  file_id: fixtureState.counters.nextFileId++,
  file_created_at: "2026-06-29T00:02:00Z",
  file_updated_at: updated ? "2026-06-29T00:03:00Z" : null,
  revision_id: fixtureState.counters.nextRevisionId++,
  revision_created_at: updated ? "2026-06-29T00:03:00Z" : "2026-06-29T00:02:00Z",
  revision_user_id: userId,
  name,
  content,
  mime: "text/plain",
  size: content.length,
  revision_comments: revisionComments
})

export const updateFixtureFile = (
  file: FixtureFile,
  content: Buffer,
  revisionComments: string,
  userId: number
) => {
  file.content = content
  file.file_updated_at = "2026-06-29T00:03:00Z"
  file.revision_id = fixtureState.counters.nextRevisionId++
  file.revision_created_at = "2026-06-29T00:03:00Z"
  file.revision_user_id = userId
  file.size = content.length
  file.revision_comments = revisionComments
}

fixtureState.filesByPageId[3000173] = {
  "xmlrpc-read-limit-at-cap.txt": {
    file_id: 5_600_000,
    file_created_at: "2026-08-13T00:00:00Z",
    file_updated_at: null,
    revision_id: 9_600_000,
    revision_created_at: "2026-08-13T00:00:00Z",
    revision_user_id: 123,
    name: "xmlrpc-read-limit-at-cap.txt",
    content: Buffer.from("at cap"),
    mime: "text/plain",
    size: 6_000_000,
    revision_comments: "synthetic read-limit boundary metadata"
  },
  "xmlrpc-read-limit-over-cap.txt": {
    file_id: 5_600_001,
    file_created_at: "2026-08-13T00:00:00Z",
    file_updated_at: null,
    revision_id: 9_600_001,
    revision_created_at: "2026-08-13T00:00:00Z",
    revision_user_id: 123,
    name: "xmlrpc-read-limit-over-cap.txt",
    content: Buffer.from("over cap"),
    mime: "text/plain",
    size: 6_000_001,
    revision_comments: "synthetic read-limit boundary metadata"
  },
  "xmlrpc-read-limit-race.txt": {
    file_id: 5_600_002,
    file_created_at: "2026-08-13T00:00:00Z",
    file_updated_at: null,
    revision_id: 9_600_002,
    revision_created_at: "2026-08-13T00:00:00Z",
    revision_user_id: 123,
    name: "xmlrpc-read-limit-race.txt",
    content: Buffer.from("changed after metadata read"),
    mime: "text/plain",
    size: 6_000_000,
    size_with_data: 6_000_001,
    revision_comments: "synthetic read-limit race metadata"
  }
}

fixtureState.filesByPageId[3000340] = {
  "theme-lab-visual-fixture_日本語長名_320px_readability_and_download_controls.txt": {
    file_id: 5_600_003,
    file_created_at: "2026-09-24T00:00:00Z",
    file_updated_at: null,
    revision_id: 9_600_003,
    revision_created_at: "2026-09-24T00:00:00Z",
    revision_user_id: 123,
    name: "theme-lab-visual-fixture_日本語長名_320px_readability_and_download_controls.txt",
    content: Buffer.from("run-owned long Japanese filename visual fixture"),
    mime: "text/plain",
    size: 49,
    revision_comments: "responsive Files pane visual regression fixture"
  }
}

fixtureState.deletedFilesByPageId[3000340] = {
  "files-restore-race-deleted-a.txt": {
    file_id: 5_600_010,
    file_created_at: "2026-10-01T00:00:00Z",
    file_updated_at: null,
    revision_id: 9_600_010,
    revision_created_at: "2026-10-01T00:00:00Z",
    revision_user_id: 123,
    name: "files-restore-race-deleted-a.txt",
    revision_type: "delete",
    content: Buffer.from("deleted fixture a"),
    mime: "text/plain",
    size: 17,
    revision_comments: "files restore race deleted fixture"
  },
  "files-restore-race-deleted-b.txt": {
    file_id: 5_600_011,
    file_created_at: "2026-10-01T00:00:00Z",
    file_updated_at: null,
    revision_id: 9_600_011,
    revision_created_at: "2026-10-01T00:00:00Z",
    revision_user_id: 123,
    name: "files-restore-race-deleted-b.txt",
    revision_type: "delete",
    content: Buffer.from("deleted fixture b"),
    mime: "text/plain",
    size: 17,
    revision_comments: "files restore race deleted fixture"
  }
}

export const requestContextHeaders = (request: IncomingMessage) => ({
  page: request.headers["x-deepwell-page"],
  sessionToken: request.headers["x-deepwell-session-token"],
  siteId: request.headers["x-deepwell-site-id"]
})

export const resetRequestGroups = (requestGroups: Record<string, unknown[]>) => {
  for (const requests of Object.values(requestGroups)) requests.length = 0
}
