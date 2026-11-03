import { Buffer } from "node:buffer"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"

import { client } from "$lib/server/deepwell"
import {
  isNotLatestRevisionIdError,
  isPageEditLockConflictError
} from "$lib/server/deepwell/public-error.js"
import {
  getXmlRpcWriteContext,
  getXmlRpcWritePrincipal,
  type XmlRpcWriteContext
} from "$lib/server/xmlrpc/authentication"
import {
  requestXmlRpcDeepwell as requestDeepwell,
  type DeepwellRequestContext
} from "$lib/server/xmlrpc/deepwell-client"
import {
  expectDeepwellCategories,
  expectDeepwellFiles,
  expectDeepwellForumPosts,
  expectDeepwellPageCreateOutput,
  expectDeepwellPageEditLockAcquireOutput,
  expectDeepwellPageMoveOutput,
  expectDeepwellStringArray,
  isDeepwellBlobUpload,
  isDeepwellDirectParentMetadata,
  isDeepwellFile,
  isDeepwellForumPostSummary,
  isDeepwellPage,
  isDeepwellPageLifecycleIdentity,
  isDeepwellPageView,
  type DeepwellDirectParentMetadata,
  type DeepwellFile,
  type DeepwellForumPostSummary,
  type DeepwellPage
} from "$lib/server/xmlrpc/deepwell-responses"
import {
  XmlRpcFault,
  type XmlRpcCall,
  type XmlRpcValue
} from "$lib/server/xmlrpc/protocol"
import { commitPendingBlobUpload } from "$lib/server/deepwell/pending-blob-upload"
import {
  getOptionalStructBoolean,
  getOptionalStructString,
  getOptionalStructStringArray,
  getOptionalStructStringOrInt,
  getRequiredStructString,
  getRequiredStructStringArray,
  getStructParam,
  isXmlRpcStruct
} from "$lib/server/xmlrpc/parameters"

type DeepwellStringParams = Record<string, string | string[] | undefined>
const MAX_XML_RPC_FILTER_VALUES = 100
const MAX_XML_RPC_TAG_PAGE_FILTER_VALUES = 10
const MAX_XML_RPC_FILE_READ_BYTES = 6_000_000
export const MAX_XML_RPC_FILE_BYTES = 50_000_000
const PAGE_SELECT_DECIMAL_RATING_PATTERN =
  /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/
export async function selectCategories(call: XmlRpcCall): Promise<string[]> {
  const params = getStructParam(call, 0, "params")
  const site = getRequiredStructString(params, "site")
  const categories = expectDeepwellCategories(
    await requestDeepwell("category_get_all", {
      site
    }),
    "category_get_all"
  )

  return categories.map((category) => category.slug)
}

export async function selectTags(call: XmlRpcCall, requestIp: string): Promise<string[]> {
  const params = getStructParam(call, 0, "params")
  const site = getRequiredStructString(params, "site")
  const categories = getOptionalStructStringArray(params, "categories")
  const pages = getOptionalStructStringArray(params, "pages")

  if (categories !== null && pages !== null) {
    throw new XmlRpcFault(-32602, "tags.select accepts categories or pages, not both")
  }
  if (categories && categories.length > MAX_XML_RPC_FILTER_VALUES) {
    throw new XmlRpcFault(
      -32602,
      `tags.select categories is limited to ${MAX_XML_RPC_FILTER_VALUES} entries`
    )
  }
  if (pages && pages.length > MAX_XML_RPC_TAG_PAGE_FILTER_VALUES) {
    throw new XmlRpcFault(
      -32602,
      `tags.select pages is limited to ${MAX_XML_RPC_TAG_PAGE_FILTER_VALUES} entries`
    )
  }

  const deepwellParams = {
    site,
    ...(categories ? { categories } : {}),
    ...(pages ? { pages } : {})
  }

  const principal = await getXmlRpcWritePrincipal(requestIp)

  return expectDeepwellStringArray(
    await requestDeepwell("page_tags_select", deepwellParams, {
      sessionToken: principal.sessionToken
    }),
    "page_tags_select"
  )
}

export async function selectPages(
  call: XmlRpcCall,
  requestIp: string
): Promise<string[]> {
  const params = getStructParam(call, 0, "params")
  const site = getRequiredStructString(params, "site")
  const deepwellParams: DeepwellStringParams & {
    site: string
    pagetype?: string
    categories?: string[]
    tags_any?: string[]
    tags_all?: string[]
    tags_none?: string[]
    parent?: string
    created_by?: string
    rating?: string
    order?: string
  } = { site }

  addOptionalValidatedStringField(
    deepwellParams,
    params,
    "pagetype",
    validatePageSelectType
  )
  addOptionalStringArrayField(deepwellParams, params, "categories", "pages.select")
  addOptionalStringArrayField(deepwellParams, params, "tags_any", "pages.select")
  addOptionalStringArrayField(deepwellParams, params, "tags_all", "pages.select")
  addOptionalStringArrayField(deepwellParams, params, "tags_none", "pages.select")
  addOptionalStringField(deepwellParams, params, "parent")
  addOptionalStringField(deepwellParams, params, "created_by")
  addOptionalValidatedStringField(
    deepwellParams,
    params,
    "rating",
    validatePageSelectRating
  )
  addOptionalValidatedStringField(
    deepwellParams,
    params,
    "order",
    validatePageSelectOrder
  )

  const principal = await getXmlRpcWritePrincipal(requestIp)

  return expectDeepwellStringArray(
    await requestDeepwell("page_select", deepwellParams, {
      sessionToken: principal.sessionToken
    }),
    "page_select"
  )
}

export async function getPagesMeta(
  call: XmlRpcCall,
  requestIp: string
): Promise<Record<string, XmlRpcValue>> {
  const params = getStructParam(call, 0, "params")
  const site = getRequiredStructString(params, "site")
  const pages = getRequiredStructStringArray(params, "pages")

  if (pages.length > 10) {
    throw new XmlRpcFault(-32602, "pages.get_meta pages is limited to 10 entries")
  }

  const siteId = await getDeepwellSiteId(site)
  if (pages.length === 0) {
    return {}
  }

  const principal = await getXmlRpcWritePrincipal(requestIp)
  const entries: [string, XmlRpcValue][] = []
  for (const pageReference of pages) {
    const page = await getDeepwellPage(siteId, pageReference, false)
    if (!page || !(await canXmlRpcViewPage(siteId, page.slug, requestIp, principal))) {
      continue
    }

    const [parentPage, lifecycleIdentity] = await Promise.all([
      getDeepwellDirectParentMetadata(siteId, page.slug, principal),
      getDeepwellPageLifecycleIdentity(siteId, page.slug, principal)
    ])
    entries.push([
      page.slug,
      buildXmlRpcPageMeta(page, parentPage?.slug ?? null, lifecycleIdentity)
    ])
  }

  return Object.fromEntries(entries)
}

export async function getPageOne(
  call: XmlRpcCall,
  requestIp: string
): Promise<Record<string, XmlRpcValue>> {
  const params = getStructParam(call, 0, "params")
  const site = getRequiredStructString(params, "site")
  const pageReference = getRequiredStructString(params, "page")
  const siteId = await getDeepwellSiteId(site)

  return buildXmlRpcPage(site, siteId, pageReference, requestIp)
}

export async function savePageOne(
  call: XmlRpcCall,
  requestIp: string
): Promise<Record<string, XmlRpcValue>> {
  const params = getStructParam(call, 0, "params")
  const site = getRequiredStructString(params, "site")
  const pageReference = getRequiredStructString(params, "page")
  const title = getOptionalStructString(params, "title")
  const content = getOptionalStructString(params, "content")
  const tags = getOptionalStructStringArray(params, "tags")
  const parentFullname = getOptionalStructString(params, "parent_fullname")
  const saveMode = getOptionalStructString(params, "save_mode") ?? "create_or_update"
  const renameAs = getOptionalStructString(params, "rename_as")
  const revisionComment =
    getOptionalStructString(params, "revision_comment") ?? "XML-RPC page save"

  if (!["create", "update", "create_or_update"].includes(saveMode)) {
    throw new XmlRpcFault(-32602, `Unsupported pages.save_one save_mode: ${saveMode}`)
  }
  const notifyWatchers = getOptionalStructBoolean(params, "notify_watchers") ?? false
  if (notifyWatchers) {
    throw new XmlRpcFault(-32602, "pages.save_one notify_watchers is not implemented")
  }

  const siteId = await getDeepwellSiteId(site)
  let page = await getDeepwellPage(siteId, pageReference, true)

  if (saveMode === "create" && page) {
    throw new XmlRpcFault(409, "Argument page invalid: page already exists")
  }
  if (saveMode === "update" && !page) {
    throw new XmlRpcFault(406, "Argument page invalid: page does not exist")
  }

  const currentPageReference = page?.slug ?? pageReference
  if (parentFullname !== null && parentFullname !== "-") {
    const parentPage = await getDeepwellPage(siteId, parentFullname, false)
    if (!parentPage) {
      throw new XmlRpcFault(
        406,
        "Argument parent_fullname invalid: parent page does not exist"
      )
    }
  }
  if (renameAs !== null && renameAs !== currentPageReference) {
    const targetPage = await getDeepwellPage(siteId, renameAs, false)
    if (targetPage) {
      throw new XmlRpcFault(409, "Argument rename_as invalid: page already exists")
    }
  }

  const writeContext = await getXmlRpcWriteContext(
    siteId,
    currentPageReference,
    requestIp
  )

  const willCreateRevision =
    !page ||
    content !== null ||
    title !== null ||
    tags !== null ||
    (renameAs !== null && renameAs !== currentPageReference)
  let responseLifecycleIdentity: ResolvedPageLifecycleIdentity
  if (page) {
    const existingLifecycleIdentity = await preflightExistingPageLifecycleIdentity(
      siteId,
      page.slug,
      requestIp,
      writeContext
    )
    responseLifecycleIdentity = willCreateRevision
      ? {
          created_by: existingLifecycleIdentity.created_by,
          updated_by: await getDeepwellUserDisplayName(writeContext.userId, writeContext)
        }
      : existingLifecycleIdentity
  } else {
    const actorDisplayName = await getDeepwellUserDisplayName(
      writeContext.userId,
      writeContext
    )
    responseLifecycleIdentity = {
      created_by: actorDisplayName,
      updated_by: actorDisplayName
    }
  }

  const createdPage = !page
  if (!page) {
    const createOutput = expectDeepwellPageCreateOutput(
      await requestDeepwell(
        "page_create",
        {
          site_id: siteId,
          wikitext: content ?? "",
          title: title ?? pageReference,
          alt_title: null,
          slug: pageReference,
          layout: "wikidot",
          revision_comments: revisionComment,
          user_id: writeContext.userId,
          ip_address: writeContext.ipAddress
        },
        writeContext
      )
    )
    page = await requireDeepwellPage(siteId, createOutput.slug, true)
  }

  const editBody: { wikitext?: string; title?: string; tags?: string[] } = {}
  if (!createdPage && content !== null) {
    editBody.wikitext = content
  }
  if (!createdPage && title !== null) {
    editBody.title = title
  }
  if (tags !== null) {
    editBody.tags = tags
  }

  if (Object.keys(editBody).length > 0) {
    const editParams: XmlRpcPageEditParams = {
      site_id: siteId,
      page: page.slug,
      last_revision_id: page.revision_id,
      revision_comments: revisionComment,
      user_id: writeContext.userId,
      ip_address: writeContext.ipAddress,
      ...editBody
    }
    if (editBody.wikitext !== undefined) {
      await saveXmlRpcPageEditWithLease(editParams, writeContext)
    } else {
      await requestDeepwell("page_edit", editParams, {
        ...writeContext,
        page: page.slug
      })
    }
    page = await requireDeepwellPage(siteId, page.slug, true)
  }

  if (parentFullname !== null) {
    await replaceDeepwellParents(siteId, page.slug, parentFullname, writeContext)
  }

  let finalPageReference = page.slug
  if (renameAs !== null && renameAs !== page.slug) {
    const moveOutput = expectDeepwellPageMoveOutput(
      await requestDeepwell(
        "page_move",
        {
          site_id: siteId,
          page: page.slug,
          last_revision_id: page.revision_id,
          new_slug: renameAs,
          revision_comments: revisionComment,
          user_id: writeContext.userId,
          ip_address: writeContext.ipAddress
        },
        { ...writeContext, page: page.slug }
      )
    )
    finalPageReference = moveOutput.new_slug
  }

  return buildXmlRpcPage(
    site,
    siteId,
    finalPageReference,
    requestIp,
    writeContext,
    responseLifecycleIdentity
  )
}

interface XmlRpcPageEditParams {
  site_id: number
  page: string
  last_revision_id: number
  revision_comments: string
  user_id: number
  ip_address: string
  wikitext?: string
  title?: string
  tags?: string[]
}

interface XmlRpcPageEditLease {
  lockId: number
  lockSecret: string
}

async function acquireXmlRpcPageEditLease(
  slug: string,
  writeContext: XmlRpcWriteContext
): Promise<XmlRpcPageEditLease> {
  const output = expectDeepwellPageEditLockAcquireOutput(
    await requestDeepwell(
      "page_edit_lock_acquire",
      { page: slug, mode: "page" },
      { ...writeContext, page: slug }
    )
  )
  if (!output.grant) {
    const conflicts = output.conflicts
      .map(
        (conflict) =>
          `user_id ${conflict.user_id}, mode ${conflict.mode}${
            conflict.section_index === null
              ? ""
              : `, section ${conflict.section_index}`
          }, ${conflict.seconds_remaining} seconds remaining`
      )
      .join("; ")
    throw new XmlRpcFault(
      4304,
      `pages.save_one cannot edit ${slug}: edit lock conflict (${conflicts})`
    )
  }
  return {
    lockId: output.grant.lock_id,
    lockSecret: output.grant["lock_secret"]
  }
}

async function releaseXmlRpcPageEditLease(
  slug: string,
  lease: XmlRpcPageEditLease,
  writeContext: XmlRpcWriteContext
): Promise<void> {
  try {
    await requestDeepwell(
      "page_edit_lock_release",
      {
        page: slug,
        lock_id: lease.lockId,
        ["lock_secret"]: lease.lockSecret
      },
      { ...writeContext, page: slug }
    )
  } catch (error) {
    console.error(
      `Failed to release page edit lock ${lease.lockId} for ${slug}`,
      error
    )
  }
}

async function saveXmlRpcPageEditWithLease(
  editParams: XmlRpcPageEditParams,
  writeContext: XmlRpcWriteContext
): Promise<void> {
  const lease = await acquireXmlRpcPageEditLease(editParams.page, writeContext)
  try {
    await requestXmlRpcLeasedPageEdit(editParams, lease, writeContext)
  } finally {
    await releaseXmlRpcPageEditLease(editParams.page, lease, writeContext)
  }
}

async function requestXmlRpcLeasedPageEdit(
  editParams: XmlRpcPageEditParams,
  lease: XmlRpcPageEditLease,
  writeContext: XmlRpcWriteContext
): Promise<void> {
  try {
    await client.request(
      "page_edit",
      {
        ...editParams,
        lease: {
          lock_id: lease.lockId,
          ["lock_secret"]: lease.lockSecret,
          mode: "page"
        }
      },
      { ...writeContext, page: editParams.page }
    )
  } catch (error) {
    if (isPageEditLockConflictError(error)) {
      throw new XmlRpcFault(
        4304,
        "pages.save_one edit rejected: edit lock conflict (Deepwell 4304)"
      )
    }
    if (isNotLatestRevisionIdError(error)) {
      throw new XmlRpcFault(
        4303,
        "pages.save_one edit rejected: the page changed (Deepwell 4303)"
      )
    }
    console.error("Unexpected Deepwell XML-RPC bridge error for page_edit", error)
    throw new XmlRpcFault(-32603, "XML-RPC Deepwell request failed: page_edit")
  }
}

export async function selectFiles(call: XmlRpcCall): Promise<string[]> {
  const params = getStructParam(call, 0, "params")
  const site = getRequiredStructString(params, "site")
  const pageReference = getRequiredStructString(params, "page")
  const siteId = await getDeepwellSiteId(site)
  const page = await requireDeepwellPage(siteId, pageReference, false)
  const pageId = requireDeepwellPageId(page)
  const files = await getDeepwellPageFiles(siteId, pageId)

  return files.map((file) => file.name)
}

export async function getFilesMeta(
  call: XmlRpcCall
): Promise<Record<string, XmlRpcValue>> {
  const params = getStructParam(call, 0, "params")
  const site = getRequiredStructString(params, "site")
  const pageReference = getRequiredStructString(params, "page")
  const files = getRequiredStructStringArray(params, "files")

  if (files.length > 10) {
    throw new XmlRpcFault(-32602, "files.get_meta files is limited to 10 entries")
  }

  const siteId = await getDeepwellSiteId(site)
  const page = await requireDeepwellPage(siteId, pageReference, false)
  const pageId = requireDeepwellPageId(page)
  if (files.length === 0) {
    return {}
  }

  const entries = await Promise.all(
    files.map(async (fileName): Promise<[string, XmlRpcValue] | null> => {
      const file = await getDeepwellFile(siteId, pageId, fileName, false)
      return file ? [file.name, buildXmlRpcFileMeta(site, page.slug, file)] : null
    })
  )

  return Object.fromEntries(
    entries.filter((entry): entry is [string, XmlRpcValue] => entry !== null)
  )
}

export async function getFileOne(call: XmlRpcCall): Promise<Record<string, XmlRpcValue>> {
  const params = getStructParam(call, 0, "params")
  const site = getRequiredStructString(params, "site")
  const pageReference = getRequiredStructString(params, "page")
  const fileName = getRequiredStructString(params, "file")
  const siteId = await getDeepwellSiteId(site)
  const page = await requireDeepwellPage(siteId, pageReference, false)
  const pageId = requireDeepwellPageId(page)
  const metadata = await getDeepwellFile(siteId, pageId, fileName, false)
  if (!metadata) {
    throw new XmlRpcFault(406, "Argument file invalid: file does not exist")
  }
  enforceXmlRpcFileReadLimit(metadata)

  const file = await getDeepwellFile(siteId, pageId, fileName, true)
  if (!file) {
    throw new XmlRpcFault(406, "Argument file invalid: file does not exist")
  }
  enforceXmlRpcFileReadLimit(file)

  return {
    ...buildXmlRpcFileMeta(site, page.slug, file),
    content: deepwellFileContentBase64(file)
  }
}

function enforceXmlRpcFileReadLimit(file: DeepwellFile): void {
  if (file.size > MAX_XML_RPC_FILE_READ_BYTES) {
    throw new XmlRpcFault(413, "files.get_one file exceeds local 6 MB read limit", 413)
  }
}

export async function saveFileOne(
  call: XmlRpcCall,
  requestIp: string
): Promise<Record<string, XmlRpcValue>> {
  const params = getStructParam(call, 0, "params")
  const site = getRequiredStructString(params, "site")
  const pageReference = getRequiredStructString(params, "page")
  const fileName = getRequiredStructString(params, "file")
  const content = getRequiredStructString(params, "content")
  const comment = getOptionalStructString(params, "comment")
  const saveMode = getOptionalStructString(params, "save_mode") ?? "create_or_update"
  const revisionComment =
    getOptionalStructString(params, "revision_comment") ?? comment ?? "XML-RPC file save"

  if (!["create", "update", "create_or_update"].includes(saveMode)) {
    throw new XmlRpcFault(-32602, `Unsupported files.save_one save_mode: ${saveMode}`)
  }

  const siteId = await getDeepwellSiteId(site)
  const page = await requireDeepwellPage(siteId, pageReference, false)
  const pageId = requireDeepwellPageId(page)
  const existing = await getDeepwellFile(siteId, pageId, fileName, false)

  if (saveMode === "create" && existing) {
    throw new XmlRpcFault(409, "Argument file invalid: file already exists")
  }
  if (saveMode === "update" && !existing) {
    throw new XmlRpcFault(406, "Argument file invalid: file does not exist")
  }

  const writeContext = await getXmlRpcWriteContext(siteId, page.slug, requestIp)
  const contentBytes = decodeXmlRpcBase64(content)
  await commitXmlRpcFileContent(contentBytes, writeContext, (pendingBlobId) =>
    existing
      ? requestDeepwell(
          "file_edit",
          {
            site_id: siteId,
            page_id: pageId,
            file_id: existing.file_id,
            last_revision_id: existing.revision_id,
            uploaded_blob_id: pendingBlobId,
            revision_comments: revisionComment,
            user_id: writeContext.userId,
            ip_address: writeContext.ipAddress,
            bypass_filter: true
          },
          writeContext
        )
      : requestDeepwell(
          "file_create",
          {
            site_id: siteId,
            page_id: pageId,
            name: fileName,
            uploaded_blob_id: pendingBlobId,
            revision_comments: revisionComment,
            user_id: writeContext.userId,
            ip_address: writeContext.ipAddress,
            bypass_filter: true
          },
          writeContext
        )
  )

  const saved = await getDeepwellFile(siteId, pageId, fileName, false)
  if (!saved) {
    throw new XmlRpcFault(406, "Argument file invalid: file does not exist")
  }
  return buildXmlRpcFileMeta(site, page.slug, saved)
}

export async function selectPosts(call: XmlRpcCall): Promise<number[]> {
  const params = getStructParam(call, 0, "params")
  const site = getRequiredStructString(params, "site")
  if (params.thread !== undefined && params.thread !== null) {
    throw new XmlRpcFault(-32602, "posts.select thread is not implemented")
  }
  const page = getOptionalStructString(params, "page")
  const replyTo = getOptionalStructStringOrInt(params, "reply_to")
  const createdBy = getOptionalStructString(params, "created_by")
  const siteId = await getDeepwellSiteId(site)

  const posts = await requestDeepwell("forum_post_select", {
    site_id: siteId,
    page: page ?? undefined,
    reply_to: replyTo ?? undefined,
    created_by: createdBy ?? undefined
  })
  if (
    !Array.isArray(posts) ||
    posts.some((post) => typeof post !== "number" || !Number.isInteger(post))
  ) {
    throw new XmlRpcFault(-32603, "Malformed Deepwell response: forum_post_select")
  }

  return posts
}

export async function getPosts(call: XmlRpcCall): Promise<Record<string, XmlRpcValue>> {
  const params = getStructParam(call, 0, "params")
  const site = getRequiredStructString(params, "site")
  const posts = params.posts

  if (
    !Array.isArray(posts) ||
    posts.some(
      (post) =>
        typeof post !== "string" && (typeof post !== "number" || !Number.isInteger(post))
    )
  ) {
    throw new XmlRpcFault(
      -32602,
      "Argument posts should be a list of strings or integers"
    )
  }

  if (posts.length > 10) {
    throw new XmlRpcFault(-32602, "posts.get posts is limited to 10 entries")
  }

  const siteId = await getDeepwellSiteId(site)
  const postIds = posts.map(String)
  const result = expectDeepwellForumPosts(
    await requestDeepwell("forum_post_get", {
      site_id: siteId,
      posts: postIds
    }),
    "forum_post_get"
  )

  return Object.fromEntries(
    result.map((post) => [
      String(post.id),
      {
        id: post.id,
        fullname: post.fullname,
        reply_to: post.reply_to,
        title: post.title,
        content: post.content,
        html: post.html,
        created_by: post.created_by,
        created_at: post.created_at
      }
    ])
  )
}

export function decodeXmlRpcBase64(
  content: string,
  maximumBytes = MAX_XML_RPC_FILE_BYTES
): Buffer {
  const normalized = content.replace(/\s+/g, "")
  if (
    normalized.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(normalized)
  ) {
    throw new XmlRpcFault(-32602, "Argument content invalid: malformed base64")
  }
  const decoded = Buffer.from(normalized, "base64")
  if (decoded.length > maximumBytes) {
    throw new XmlRpcFault(413, "files.save_one content is too large", 413)
  }
  return decoded
}

async function commitXmlRpcFileContent(
  content: Buffer,
  context: XmlRpcWriteContext,
  commit: (pendingBlobId: string) => Promise<unknown>
): Promise<void> {
  await commitPendingBlobUpload({
    start: async () => {
      const upload = await requestDeepwell(
        "blob_upload",
        {
          user_id: context.userId,
          blob_size: content.length,
          scope: "page"
        },
        context
      )
      if (!isDeepwellBlobUpload(upload)) {
        throw new XmlRpcFault(-32603, "Malformed Deepwell response: blob_upload")
      }
      return upload
    },
    upload: (presignUrl) => putPresignedBlob(presignUrl, content),
    commit,
    cancel: async (pendingBlobId) => {
      await requestDeepwell(
        "blob_cancel",
        {
          user_id: context.userId,
          pending_blob_id: pendingBlobId
        },
        context
      )
    }
  })
}

async function putPresignedBlob(url: string, content: Buffer): Promise<void> {
  let signed: URL
  try {
    signed = new URL(url)
  } catch {
    throw new XmlRpcFault(-32603, "Malformed Deepwell response: blob_upload presign_url")
  }
  if (signed.protocol !== "http:" && signed.protocol !== "https:") {
    throw new XmlRpcFault(-32603, `Unsupported blob upload protocol: ${signed.protocol}`)
  }

  const target = localPresignConnectBase(signed) ?? signed
  const requestUrl = new URL(
    `${target.protocol}//${target.host}${signed.pathname}${signed.search}`
  )
  const transport = requestUrl.protocol === "https:" ? httpsRequest : httpRequest

  await new Promise<void>((resolve, reject) => {
    const request = transport(
      requestUrl,
      {
        method: "PUT",
        headers: {
          Host: signed.host,
          "Content-Length": String(content.length)
        }
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on("data", (chunk: Buffer) => chunks.push(chunk))
        response.on("end", () => {
          if (
            response.statusCode &&
            response.statusCode >= 200 &&
            response.statusCode < 300
          ) {
            resolve()
            return
          }

          const body = Buffer.concat(chunks).toString("utf8")
          reject(
            new Error(
              `Blob upload failed: HTTP ${response.statusCode} connect=${requestUrl.origin} signed_host=${signed.host} ${body.slice(0, 500)}`
            )
          )
        })
      }
    )

    request.setTimeout(30_000, () => {
      request.destroy(
        new Error(
          `Blob upload timed out: connect=${requestUrl.origin} signed_host=${signed.host}`
        )
      )
    })
    request.on("error", (error) => reject(error))
    request.end(content)
  }).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    throw new XmlRpcFault(-32603, message)
  })
}

function localPresignConnectBase(url: URL): URL | null {
  const localRewriteEnabled =
    process.env.WIKIJUMP_XMLRPC_LOCAL_FILE_UPLOAD === "1" ||
    process.env.FRAMERAIL_ENV === "local" ||
    process.env.NODE_ENV === "development"
  if (
    !localRewriteEnabled ||
    url.hostname !== "files" ||
    process.env.DEEPWELL_HOST === "deepwell"
  ) {
    return null
  }
  return new URL(`http://127.0.0.1:${url.port || "9000"}`)
}

async function buildXmlRpcPage(
  site: string,
  siteId: number,
  pageReference: string,
  requestIp: string,
  principal?: Pick<XmlRpcWriteContext, "sessionToken" | "userId">,
  lifecycleIdentity?: ResolvedPageLifecycleIdentity
): Promise<Record<string, XmlRpcValue>> {
  const pageMetadata = await getDeepwellPage(siteId, pageReference, false)
  if (!pageMetadata) {
    throw new XmlRpcFault(406, "Argument page invalid: page does not exist")
  }
  const resolvedPrincipal = principal ?? (await getXmlRpcWritePrincipal(requestIp))
  if (
    !(await canXmlRpcViewPage(siteId, pageMetadata.slug, requestIp, resolvedPrincipal))
  ) {
    throw new XmlRpcFault(403, "XML-RPC user is not allowed to view this page", 403)
  }

  const page = await requireDeepwellPage(siteId, pageMetadata.slug, true)
  const [parentPage, resolvedLifecycleIdentity, postSummary] = await Promise.all([
    getDeepwellDirectParentMetadata(siteId, page.slug, resolvedPrincipal),
    lifecycleIdentity ??
      getDeepwellPageLifecycleIdentity(siteId, page.slug, resolvedPrincipal),
    getDeepwellForumPostSummary(siteId, page.slug)
  ])
  const parentFullname = parentPage?.slug ?? null
  const parentTitle = parentPage?.title ?? null
  const children = expectDeepwellStringArray(
    await requestDeepwell(
      "page_select",
      {
        site,
        parent: page.slug
      },
      { sessionToken: resolvedPrincipal.sessionToken }
    ),
    "page_select"
  )

  return {
    ...buildXmlRpcPageDetails(
      page,
      parentFullname,
      resolvedLifecycleIdentity,
      postSummary
    ),
    parent_title: parentTitle,
    children: children.length,
    content: page.wikitext ?? "",
    html: page.compiled_body_html ?? ""
  }
}

async function canXmlRpcViewPage(
  siteId: number,
  page: string,
  requestIp: string,
  authenticatedPrincipal?: Pick<XmlRpcWriteContext, "sessionToken" | "userId">
): Promise<boolean> {
  const principal = authenticatedPrincipal ?? (await getXmlRpcWritePrincipal(requestIp))
  const view = await requestDeepwell(
    "page_view",
    {
      site_id: siteId,
      locales: [],
      session_token: principal.sessionToken,
      route: { slug: page, extra: "" }
    },
    {
      sessionToken: principal.sessionToken,
      siteId,
      page
    }
  )
  if (!isDeepwellPageView(view)) {
    throw new XmlRpcFault(-32603, "Malformed Deepwell response: page_view")
  }

  return view.type === "found" && view.data?.page?.slug === page
}

async function getDeepwellSiteId(site: string): Promise<number> {
  const deepwellSite = await requestDeepwell("site_get", { site })
  if (deepwellSite === null) {
    throw new XmlRpcFault(406, "Argument site invalid: site does not exist")
  }
  if (
    !isXmlRpcStruct(deepwellSite) ||
    typeof deepwellSite.site_id !== "number" ||
    !Number.isInteger(deepwellSite.site_id)
  ) {
    throw new XmlRpcFault(-32603, "Malformed Deepwell response: site_get")
  }

  return deepwellSite.site_id
}

async function getDeepwellPage(
  siteId: number,
  page: string,
  includeBody: boolean
): Promise<DeepwellPage | null> {
  const deepwellPage = await requestDeepwell("page_get", {
    site_id: siteId,
    page,
    details: {
      wikitext: includeBody,
      compiled_html: includeBody
    }
  })
  if (deepwellPage === null) {
    return null
  }
  if (!isDeepwellPage(deepwellPage, includeBody)) {
    throw new XmlRpcFault(-32603, "Malformed Deepwell response: page_get")
  }

  return deepwellPage
}

async function requireDeepwellPage(
  siteId: number,
  page: string,
  includeBody: boolean
): Promise<DeepwellPage> {
  const deepwellPage = await getDeepwellPage(siteId, page, includeBody)
  if (!deepwellPage) {
    throw new XmlRpcFault(406, "Argument page invalid: page does not exist")
  }
  return deepwellPage
}

function requireDeepwellPageId(page: DeepwellPage): number {
  if (typeof page.page_id !== "number" || !Number.isInteger(page.page_id)) {
    throw new XmlRpcFault(-32603, "Malformed Deepwell response: page_get")
  }
  return page.page_id
}

async function getDeepwellPageFiles(
  siteId: number,
  pageId: number
): Promise<DeepwellFile[]> {
  return expectDeepwellFiles(
    await requestDeepwell("page_get_files", {
      site_id: siteId,
      page_id: pageId,
      deleted: false
    }),
    "page_get_files",
    false
  )
}

async function getDeepwellFile(
  siteId: number,
  pageId: number,
  file: string,
  includeData: boolean
): Promise<DeepwellFile | null> {
  const deepwellFile = await requestDeepwell("file_get", {
    site_id: siteId,
    page_id: pageId,
    file,
    details: {
      data: includeData
    }
  })
  if (deepwellFile === null) {
    return null
  }
  if (!isDeepwellFile(deepwellFile, includeData)) {
    throw new XmlRpcFault(-32603, "Malformed Deepwell response: file_get")
  }
  return deepwellFile
}

async function getDeepwellDirectParentMetadata(
  siteId: number,
  page: string,
  principal: Pick<XmlRpcWriteContext, "sessionToken">
): Promise<DeepwellDirectParentMetadata | null> {
  const metadata = await requestDeepwell(
    "parent_get_direct_metadata",
    {
      site_id: siteId,
      page
    },
    { sessionToken: principal.sessionToken }
  )
  if (metadata === null) {
    return null
  }
  if (!isDeepwellDirectParentMetadata(metadata)) {
    throw new XmlRpcFault(
      -32603,
      "Malformed Deepwell response: parent_get_direct_metadata"
    )
  }
  return metadata
}

async function getDeepwellForumPostSummary(
  siteId: number,
  page: string
): Promise<DeepwellForumPostSummary> {
  const summary = await requestDeepwell("forum_post_page_summary", {
    site_id: siteId,
    page
  })
  if (!isDeepwellForumPostSummary(summary)) {
    throw new XmlRpcFault(-32603, "Malformed Deepwell response: forum_post_page_summary")
  }

  return summary
}

async function getDeepwellParentFullnames(
  siteId: number,
  page: string,
  context: DeepwellRequestContext
): Promise<string[]> {
  return expectDeepwellStringArray(
    await requestDeepwell(
      "parent_get_all",
      {
        site_id: siteId,
        page
      },
      { ...context, page }
    ),
    "parent_get_all"
  )
}

async function replaceDeepwellParents(
  siteId: number,
  page: string,
  parentFullname: string,
  context: XmlRpcWriteContext
): Promise<void> {
  const parents = await getDeepwellParentFullnames(siteId, page, context)
  const remove =
    parentFullname === "-"
      ? parents
      : parents.filter((parent) => parent !== parentFullname)
  const add =
    parentFullname === "-" || parents.includes(parentFullname) ? [] : [parentFullname]

  if (add.length === 0 && remove.length === 0) {
    return
  }

  await requestDeepwell(
    "parent_update",
    {
      site_id: siteId,
      child: page,
      add: add.length > 0 ? add : undefined,
      remove: remove.length > 0 ? remove : undefined
    },
    { ...context, page }
  )
}

type ResolvedPageLifecycleIdentity = {
  created_by: string
  updated_by: string
}

async function getDeepwellPageLifecycleIdentity(
  siteId: number,
  page: string,
  principal: Pick<XmlRpcWriteContext, "sessionToken">
): Promise<ResolvedPageLifecycleIdentity> {
  let identity: unknown
  try {
    identity = await requestDeepwell(
      "page_lifecycle_identity",
      { site_id: siteId, page },
      { sessionToken: principal.sessionToken, siteId, page }
    )
  } catch {
    throw pageLifecycleIdentityUnavailable()
  }
  if (!isDeepwellPageLifecycleIdentity(identity)) {
    throw pageLifecycleIdentityUnavailable()
  }
  const { created_by, updated_by } = identity
  if (created_by === null || updated_by === null) {
    throw pageLifecycleIdentityUnavailable()
  }

  return { created_by, updated_by }
}

async function preflightExistingPageLifecycleIdentity(
  siteId: number,
  page: string,
  requestIp: string,
  principal: Pick<XmlRpcWriteContext, "sessionToken" | "userId">
): Promise<ResolvedPageLifecycleIdentity> {
  const editPermission = await requestDeepwell(
    "page_edit_permission",
    {},
    { sessionToken: principal.sessionToken, siteId, page }
  )
  if (!isXmlRpcStruct(editPermission) || typeof editPermission.can_edit !== "boolean") {
    throw new XmlRpcFault(-32603, "Malformed Deepwell response: page_edit_permission")
  }
  if (!editPermission.can_edit) {
    throw new XmlRpcFault(403, "XML-RPC user is not allowed to edit this page", 403)
  }
  if (!(await canXmlRpcViewPage(siteId, page, requestIp, principal))) {
    throw new XmlRpcFault(403, "XML-RPC user is not allowed to view this page", 403)
  }
  return getDeepwellPageLifecycleIdentity(siteId, page, principal)
}

async function getDeepwellUserDisplayName(
  userId: number,
  principal: Pick<XmlRpcWriteContext, "sessionToken">
): Promise<string> {
  let user: unknown
  try {
    user = await requestDeepwell(
      "user_get",
      { user: userId },
      { sessionToken: principal.sessionToken }
    )
  } catch {
    throw pageLifecycleIdentityUnavailable()
  }
  if (
    !isXmlRpcStruct(user) ||
    user.user_id !== userId ||
    typeof user.name !== "string" ||
    user.name.trim().length === 0
  ) {
    throw pageLifecycleIdentityUnavailable()
  }

  return user.name.trim()
}

function pageLifecycleIdentityUnavailable(): XmlRpcFault {
  return new XmlRpcFault(-32603, "Page lifecycle identity unavailable")
}

function buildXmlRpcPageMeta(
  page: DeepwellPage,
  parentFullname: string | null,
  lifecycleIdentity: ResolvedPageLifecycleIdentity
): Record<string, XmlRpcValue> {
  return {
    fullname: page.slug,
    title: page.title,
    created_at: page.page_created_at,
    created_by: lifecycleIdentity.created_by,
    updated_at: page.page_updated_at ?? page.revision_created_at ?? page.page_created_at,
    updated_by: lifecycleIdentity.updated_by,
    parent_fullname: parentFullname,
    tags: page.tags,
    rating: Math.round(page.rating),
    revisions: page.page_revision_count
  }
}

function buildXmlRpcPageDetails(
  page: DeepwellPage,
  parentFullname: string | null,
  lifecycleIdentity: ResolvedPageLifecycleIdentity,
  postSummary: DeepwellForumPostSummary
): Record<string, XmlRpcValue> {
  return {
    ...buildXmlRpcPageMeta(page, parentFullname, lifecycleIdentity),
    comments: postSummary.comments,
    commented_at: postSummary.commented_at,
    commented_by: postSummary.commented_by
  }
}

function buildXmlRpcFileMeta(
  site: string,
  page: string,
  file: DeepwellFile
): Record<string, XmlRpcValue> {
  return {
    filename: file.name,
    size: file.size,
    comment: file.revision_comments,
    mime_type: file.mime,
    mime_description: file.mime,
    uploaded_by: String(file.revision_user_id),
    uploaded_at: file.revision_created_at,
    download_url: `/local--files/${site}/${page}/${encodeURIComponent(file.name)}`
  }
}

function deepwellFileContentBase64(file: DeepwellFile): string {
  if (file.data === null || file.data === undefined) {
    return ""
  }
  if (typeof file.data === "string") {
    return Buffer.from(file.data, "hex").toString("base64")
  }
  return Buffer.from(file.data).toString("base64")
}

function addOptionalStringField(
  target: DeepwellStringParams,
  params: Record<string, XmlRpcValue>,
  name: string
): void {
  const value = getOptionalStructString(params, name)
  if (value !== null) {
    target[name] = value
  }
}

function addOptionalValidatedStringField(
  target: DeepwellStringParams,
  params: Record<string, XmlRpcValue>,
  name: string,
  validate: (value: string) => void
): void {
  const value = getOptionalStructString(params, name)
  if (value !== null) {
    validate(value)
    target[name] = value
  }
}

function addOptionalStringArrayField(
  target: DeepwellStringParams,
  params: Record<string, XmlRpcValue>,
  name: string,
  methodName: string
): void {
  const value = getOptionalStructStringArray(params, name)
  if (value !== null) {
    if (value.length > MAX_XML_RPC_FILTER_VALUES) {
      throw new XmlRpcFault(
        -32602,
        `${methodName} ${name} is limited to ${MAX_XML_RPC_FILTER_VALUES} entries`
      )
    }
    target[name] = value
  }
}

function validatePageSelectType(value: string): void {
  switch (value.trim().toLowerCase()) {
    case "":
    case "*":
    case "all":
    case "normal":
    case "page":
    case "pages":
    case "hidden":
      return
    default:
      throw new XmlRpcFault(-32602, `Unsupported pages.select pagetype: ${value}`)
  }
}

function validatePageSelectRating(value: string): void {
  const trimmed = value.trim()
  if (trimmed === "") {
    return
  }
  const number = trimmed.replace(/^(>=|<=|!=|==|>|<|=)/, "").trim()
  if (
    number === "" ||
    !PAGE_SELECT_DECIMAL_RATING_PATTERN.test(number) ||
    !Number.isFinite(Number(number))
  ) {
    throw new XmlRpcFault(-32602, `Invalid pages.select rating filter: ${value}`)
  }
}

function validatePageSelectOrder(value: string): void {
  const trimmed = value.trim()
  if (trimmed === "") {
    return
  }

  const parts = trimmed.split(/\s+/)
  if (parts.length > 2) {
    throw new XmlRpcFault(-32602, `Invalid pages.select order expression: ${value}`)
  }

  const field = parts[0]?.toLowerCase()
  switch (field) {
    case "created_at":
    case "created":
    case "updated_at":
    case "updated":
    case "fullname":
    case "full_name":
    case "slug":
    case "name":
    case "title":
    case "rating":
    case "score":
      break
    default:
      throw new XmlRpcFault(-32602, `Unsupported pages.select order field: ${field}`)
  }

  const direction = parts[1]?.toLowerCase()
  if (
    direction !== undefined &&
    direction !== "asc" &&
    direction !== "ascending" &&
    direction !== "desc" &&
    direction !== "descending"
  ) {
    throw new XmlRpcFault(
      -32602,
      `Unsupported pages.select order direction: ${direction}`
    )
  }
}
