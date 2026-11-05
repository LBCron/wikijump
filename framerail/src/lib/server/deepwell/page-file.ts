import defaults from "$lib/defaults"

import { client } from "$lib/server/deepwell"
import {
  cancelBlobUpload,
  startBlobUpload,
  uploadToPresignUrl
} from "$lib/server/deepwell/file"
import { commitPendingBlobUpload } from "$lib/server/deepwell/pending-blob-upload"
import { pageEditPermission } from "$lib/server/deepwell/page"
import {
  buildPageFileCreatePayload,
  buildPageFileEditPayload,
  buildPageFileRestorePayload,
  buildPageFileRollbackPayload
} from "$lib/server/deepwell/page-file-mutation-payloads"
import { DEEPWELL_PERMISSION_DENIED } from "$lib/server/deepwell/public-error"

import type {
  FileRevisionModel,
  FileRevisionType,
  Nullable,
  Optional,
  UserInfo
} from "$lib/types"
import type { RequestContext } from "../request-context"

export interface PageFile {
  file_id: number
  file_created_at: string
  file_updated_at: Nullable<string>
  file_deleted_at: Nullable<string>
  page_id: number
  revision_id: number
  revision_type: FileRevisionType
  revision_created_at: string
  revision_number: number
  revision_user_id: number
  name: string
  data: Nullable<string>
  mime: string
  size: number
  s3_hash: string
  revision_comments: string
  hidden_fields: string[]
}

export async function pageFileList(
  siteId: number,
  pageId: number,
  deleted: Optional<boolean>,
  requestContext: RequestContext
): Promise<PageFile[]> {
  return client.request(
    "page_get_files",
    {
      site_id: siteId,
      page_id: pageId,
      deleted
    },
    requestContext
  )
}

export async function pageFileGet(
  siteId: number,
  pageId: number,
  userId: number,
  fileId: number,
  data: boolean
): Promise<Nullable<PageFile>> {
  return await client.request("file_get", {
    site_id: siteId,
    page_id: pageId,
    user_id: userId,
    file: fileId,
    data
  })
}

interface PageFileCreate {
  file_id: number
  file_revision_id: number
}
export interface PageFileCreateInput {
  siteId: number
  pageId: number
  userId: number
  name: Optional<string>
  file: File
  revisionComments: Optional<string>
  ipAddress: string
  bypassFilter?: boolean
}
export async function pageFileCreate(
  input: PageFileCreateInput,
  requestContext: RequestContext
): Promise<PageFileCreate> {
  const {
    siteId,
    pageId,
    userId,
    name,
    file,
    revisionComments,
    ipAddress,
    bypassFilter = false
  } = input
  await requireFileParentEditPermission(requestContext)
  return commitPendingBlobUpload({
    start: () => startBlobUpload(userId, file.size, "page", requestContext),
    upload: (presignUrl) => uploadToPresignUrl(presignUrl, file),
    commit: (pendingBlobId) =>
      client.request(
        "file_create",
        buildPageFileCreatePayload({
          siteId,
          pageId,
          userId,
          name: name ?? file.name,
          pendingBlobId,
          revisionComments: revisionComments ?? "",
          ipAddress,
          bypassFilter
        }),
        requestContext
      ),
    cancel: (pendingBlobId) => cancelBlobUpload(userId, pendingBlobId, requestContext)
  })
}

export interface PageFileDelete {
  file_id: number
  file_revision_id: number
  file_revision_number: number
}
export interface PageFileDeleteInput {
  siteId: number
  pageId: number
  userId: number
  fileId: number
  lastRevisionId: number
  revisionComments: string
}
export async function pageFileDelete(
  input: PageFileDeleteInput,
  requestContext: RequestContext
): Promise<PageFileDelete> {
  const { siteId, pageId, userId, fileId, lastRevisionId, revisionComments } = input
  return await client.request(
    "file_delete",
    {
      site_id: siteId,
      page_id: pageId,
      user_id: userId,
      file: fileId,
      last_revision_id: lastRevisionId,
      revision_comments: revisionComments
    },
    requestContext
  )
}

export interface PageFileEditInput {
  siteId: number
  pageId: number
  userId: number
  fileId: number
  name: Optional<string>
  file: Optional<File>
  lastRevisionId: number
  revisionComments: Optional<string>
  ipAddress: string
  bypassFilter?: boolean
}
export async function pageFileEdit(
  input: PageFileEditInput,
  requestContext: RequestContext
): Promise<PageFileCreate> {
  const {
    siteId,
    pageId,
    userId,
    fileId,
    name,
    file,
    lastRevisionId,
    revisionComments,
    ipAddress,
    bypassFilter = false
  } = input
  if (file && file instanceof File) {
    await requireFileParentEditPermission(requestContext)
    return commitPendingBlobUpload({
      start: () => startBlobUpload(userId, file.size, "page", requestContext),
      upload: (presignUrl) => uploadToPresignUrl(presignUrl, file),
      commit: (pendingBlobId) =>
        client.request(
          "file_edit",
          buildPageFileEditPayload({
            siteId,
            pageId,
            userId,
            fileId,
            lastRevisionId,
            name,
            pendingBlobId,
            revisionComments,
            ipAddress,
            bypassFilter
          }),
          requestContext
        ),
      cancel: (pendingBlobId) => cancelBlobUpload(userId, pendingBlobId, requestContext)
    })
  }

  return await client.request(
    "file_edit",
    buildPageFileEditPayload({
      siteId,
      pageId,
      userId,
      fileId,
      lastRevisionId,
      name,
      pendingBlobId: undefined,
      revisionComments,
      ipAddress,
      bypassFilter
    }),
    requestContext
  )
}

async function requireFileParentEditPermission(
  requestContext: RequestContext
): Promise<void> {
  const permission = await pageEditPermission(requestContext)
  if (!permission.can_edit) {
    const error = new Error("Permission denied.") as Error & { code: number }
    error.code = DEEPWELL_PERMISSION_DENIED
    throw error
  }
}

export interface PageFileMoveInput {
  siteId: number
  currentPageId: number
  destinationPage: string | number
  userId: number
  fileId: number
  lastRevisionId: number
  name: Optional<string>
  revisionComments: Optional<string>
}
export async function pageFileMove(
  input: PageFileMoveInput,
  requestContext: RequestContext
): Promise<PageFileCreate> {
  const {
    siteId,
    currentPageId,
    destinationPage,
    userId,
    fileId,
    lastRevisionId,
    name,
    revisionComments
  } = input
  return await client.request(
    "file_move",
    {
      site_id: siteId,
      current_page_id: currentPageId,
      destination_page: destinationPage,
      user_id: userId,
      file_id: fileId,
      last_revision_id: lastRevisionId,
      name,
      revision_comments: revisionComments
    },
    requestContext
  )
}

interface PageFileRestore {
  page_id: number
  file_id: number
  name: string
  file_revision_id: number
  file_revision_number: number
}
export interface PageFileRestoreInput {
  siteId: number
  pageId: number
  userId: number
  fileId: number
  newPage: Optional<string | number>
  newName: Optional<string>
  revisionComments: string
  ipAddress: string
  bypassFilter?: boolean
}
export async function pageFileRestore(
  input: PageFileRestoreInput,
  requestContext: RequestContext
): Promise<PageFileRestore> {
  const {
    siteId,
    pageId,
    userId,
    fileId,
    newPage,
    newName,
    revisionComments,
    ipAddress,
    bypassFilter = false
  } = input
  return client.request(
    "file_restore",
    buildPageFileRestorePayload({
      siteId,
      pageId,
      userId,
      fileId,
      newPage,
      newName,
      revisionComments,
      ipAddress,
      bypassFilter
    }),
    requestContext
  )
}

export async function pageFileHistory(
  siteId: number,
  pageId: Optional<number>,
  fileId: number,
  revisionNumber: Optional<number>,
  limit: Optional<number>,
  requestContext: RequestContext
): Promise<FileRevisionModel[]> {
  return client.request(
    "file_revision_range",
    {
      site_id: siteId,
      page_id: pageId,
      file_id: fileId,
      revision_number: revisionNumber ?? defaults.page.history.revisionNumber,
      revision_direction: "before",
      limit: limit ?? defaults.page.history.limit
    },
    requestContext
  )
}

export interface PageFileRevisionHistoryRecord extends FileRevisionModel {
  author: Nullable<UserInfo>
}

export interface PageFileRevisionHistoryOutput {
  revision_count: number
  revisions: PageFileRevisionHistoryRecord[]
}

export async function pageFileRevisionHistory(
  siteId: number,
  pageId: number,
  limit: number,
  requestContext: RequestContext
): Promise<PageFileRevisionHistoryOutput> {
  return client.request(
    "file_revision_page_history",
    {
      site_id: siteId,
      page_id: pageId,
      limit
    },
    requestContext
  )
}

export interface PageFileRollbackInput {
  siteId: number
  pageId: number
  userId: number
  fileId: number
  lastRevisionId: number
  revisionNumber: number
  revisionComments: Optional<string>
  ipAddress: string
  bypassFilter?: boolean
}
export async function pageFileRollback(
  input: PageFileRollbackInput,
  requestContext: RequestContext
): Promise<Nullable<PageFile>> {
  const {
    siteId,
    pageId,
    userId,
    fileId,
    lastRevisionId,
    revisionNumber,
    revisionComments,
    ipAddress,
    bypassFilter = false
  } = input
  return client.request(
    "file_rollback",
    buildPageFileRollbackPayload({
      siteId,
      pageId,
      userId,
      fileId,
      lastRevisionId,
      revisionNumber,
      revisionComments,
      ipAddress,
      bypassFilter
    }),
    requestContext
  )
}

export async function pageFileRevision(
  siteId: number,
  pageId: Optional<number>,
  fileId: number,
  revisionNumber: Optional<number>,
  requestContext: RequestContext
): Promise<Nullable<FileRevisionModel>> {
  return client.request(
    "file_revision_get",
    {
      site_id: siteId,
      page_id: pageId,
      file_id: fileId,
      revision_number: revisionNumber ?? defaults.page.history.revisionNumber
    },
    requestContext
  )
}
