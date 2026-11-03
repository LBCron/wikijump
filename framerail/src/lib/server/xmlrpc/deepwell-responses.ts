import { isXmlRpcStruct } from "./parameters"
import { XmlRpcFault } from "./protocol"

const isInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value)
const isNullableString = (value: unknown): value is string | null =>
  typeof value === "string" || value === null
const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string")

function expectArray<T>(
  value: unknown,
  method: string,
  isItem: (item: unknown) => item is T
): T[] {
  if (!Array.isArray(value) || !value.every(isItem)) {
    throw new XmlRpcFault(-32603, `Malformed Deepwell response: ${method}`)
  }
  return value
}

export interface DeepwellPage {
  page_id?: number
  revision_id: number
  page_created_at: string
  page_updated_at: string | null
  page_revision_count: number
  revision_created_at: string
  revision_user_id: number
  title: string
  slug: string
  tags: string[]
  rating: number
  wikitext?: string | null
  compiled_body_html?: string | null
  compiled_body_styles?: string[] | null
}

export interface DeepwellFile {
  file_id: number
  file_created_at: string
  file_updated_at: string | null
  revision_id: number
  revision_created_at: string
  revision_user_id: number
  name: string
  data?: number[] | string | null
  mime: string
  size: number
  revision_comments: string
}

export interface DeepwellForumPostSummary {
  comments: number
  commented_at: string | null
  commented_by: string | null
}

export interface DeepwellDirectParentMetadata {
  slug: string
  title: string
}

export interface DeepwellPageView {
  type: string
  data?: {
    page?: { slug?: string }
  }
}

export interface DeepwellPageLifecycleIdentity {
  created_by: string | null
  updated_by: string | null
}

export interface DeepwellPageCreateOutput {
  slug: string
}

export interface DeepwellPageMoveOutput {
  new_slug: string
}

export interface DeepwellForumPost {
  id: number
  fullname: string
  reply_to: number | null
  title: string
  content: string
  html: string
  created_by: string
  created_at: string
}

export function expectDeepwellCategories(
  value: unknown,
  method: string
): { slug: string }[] {
  return expectArray(
    value,
    method,
    (category): category is { slug: string } =>
      isXmlRpcStruct(category) &&
      typeof category.slug === "string" &&
      category.slug.length > 0
  )
}

export function expectDeepwellStringArray(value: unknown, method: string): string[] {
  return expectArray(value, method, (entry): entry is string => typeof entry === "string")
}

export function isDeepwellPage(
  value: unknown,
  includeBody: boolean
): value is DeepwellPage {
  return (
    isXmlRpcStruct(value) &&
    isInteger(value.revision_id) &&
    typeof value.page_created_at === "string" &&
    isNullableString(value.page_updated_at) &&
    isInteger(value.page_revision_count) &&
    typeof value.revision_created_at === "string" &&
    isInteger(value.revision_user_id) &&
    typeof value.title === "string" &&
    typeof value.slug === "string" &&
    isStringArray(value.tags) &&
    typeof value.rating === "number" &&
    Number.isFinite(value.rating) &&
    (!includeBody ||
      ((typeof value.wikitext === "string" || value.wikitext === null) &&
        (typeof value.compiled_body_html === "string" ||
          value.compiled_body_html === null) &&
        Array.isArray(value.compiled_body_styles) &&
        value.compiled_body_styles.every((style) => typeof style === "string")))
  )
}

export function isDeepwellPageView(value: unknown): value is DeepwellPageView {
  return (
    isXmlRpcStruct(value) &&
    typeof value.type === "string" &&
    (value.type !== "found" ||
      (isXmlRpcStruct(value.data) &&
        isXmlRpcStruct(value.data.page) &&
        typeof value.data.page.slug === "string"))
  )
}

export function isDeepwellPageLifecycleIdentity(
  value: unknown
): value is DeepwellPageLifecycleIdentity {
  return (
    isXmlRpcStruct(value) &&
    (value.created_by === null ||
      (typeof value.created_by === "string" && value.created_by.trim().length > 0)) &&
    (value.updated_by === null ||
      (typeof value.updated_by === "string" && value.updated_by.trim().length > 0))
  )
}

export function expectDeepwellPageCreateOutput(value: unknown): DeepwellPageCreateOutput {
  if (
    !isXmlRpcStruct(value) ||
    typeof value.slug !== "string" ||
    value.slug.length === 0
  ) {
    throw new XmlRpcFault(-32603, "Malformed Deepwell response: page_create")
  }
  return { slug: value.slug }
}

export function expectDeepwellPageMoveOutput(value: unknown): DeepwellPageMoveOutput {
  if (
    !isXmlRpcStruct(value) ||
    typeof value.new_slug !== "string" ||
    value.new_slug.length === 0
  ) {
    throw new XmlRpcFault(-32603, "Malformed Deepwell response: page_move")
  }
  return { new_slug: value.new_slug }
}

export interface DeepwellPageEditLockGrant {
  lock_id: number
  ["lock_secret"]: string
  base_revision_id: number | null
  expires_at: string
}

export interface DeepwellPageEditLockConflict {
  user_id: number
  mode: string
  section_index: number | null
  seconds_remaining: number
}

export interface DeepwellPageEditLockAcquireOutput {
  grant: DeepwellPageEditLockGrant | null
  conflicts: DeepwellPageEditLockConflict[]
}

const isDeepwellPageEditLockGrant = (
  value: unknown
): value is DeepwellPageEditLockGrant =>
  isXmlRpcStruct(value) &&
  isInteger(value.lock_id) &&
  typeof value["lock_secret"] === "string" &&
  value["lock_secret"].length > 0 &&
  (value.base_revision_id === null || isInteger(value.base_revision_id)) &&
  typeof value.expires_at === "string"

const isDeepwellPageEditLockConflict = (
  value: unknown
): value is DeepwellPageEditLockConflict =>
  isXmlRpcStruct(value) &&
  isInteger(value.user_id) &&
  typeof value.mode === "string" &&
  (value.section_index === null || isInteger(value.section_index)) &&
  typeof value.seconds_remaining === "number" &&
  Number.isFinite(value.seconds_remaining)

export function expectDeepwellPageEditLockAcquireOutput(
  value: unknown
): DeepwellPageEditLockAcquireOutput {
  if (
    !isXmlRpcStruct(value) ||
    (value.grant !== null && !isDeepwellPageEditLockGrant(value.grant)) ||
    !Array.isArray(value.conflicts) ||
    !value.conflicts.every(isDeepwellPageEditLockConflict)
  ) {
    throw new XmlRpcFault(-32603, "Malformed Deepwell response: page_edit_lock_acquire")
  }
  return {
    grant: value.grant as DeepwellPageEditLockGrant | null,
    conflicts: value.conflicts as unknown as DeepwellPageEditLockConflict[]
  }
}

export function isDeepwellBlobUpload(
  value: unknown
): value is { pending_blob_id: string; presign_url: string } {
  return (
    isXmlRpcStruct(value) &&
    typeof value.pending_blob_id === "string" &&
    value.pending_blob_id.length > 0 &&
    typeof value.presign_url === "string" &&
    value.presign_url.length > 0
  )
}

export function isDeepwellFile(
  value: unknown,
  includeData: boolean
): value is DeepwellFile {
  return (
    isXmlRpcStruct(value) &&
    isInteger(value.file_id) &&
    typeof value.file_created_at === "string" &&
    isNullableString(value.file_updated_at) &&
    isInteger(value.revision_id) &&
    typeof value.revision_created_at === "string" &&
    isInteger(value.revision_user_id) &&
    typeof value.name === "string" &&
    typeof value.mime === "string" &&
    isInteger(value.size) &&
    typeof value.revision_comments === "string" &&
    (!includeData ||
      value.data === null ||
      value.data === undefined ||
      typeof value.data === "string" ||
      (Array.isArray(value.data) &&
        value.data.every(
          (byte) =>
            typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255
        )))
  )
}

export function isDeepwellForumPostSummary(
  value: unknown
): value is DeepwellForumPostSummary {
  return (
    isXmlRpcStruct(value) &&
    isInteger(value.comments) &&
    isNullableString(value.commented_at) &&
    isNullableString(value.commented_by)
  )
}

export function isDeepwellDirectParentMetadata(
  value: unknown
): value is DeepwellDirectParentMetadata {
  return (
    isXmlRpcStruct(value) &&
    typeof value.slug === "string" &&
    typeof value.title === "string"
  )
}

export function isDeepwellForumPost(value: unknown): value is DeepwellForumPost {
  return (
    isXmlRpcStruct(value) &&
    isInteger(value.id) &&
    typeof value.fullname === "string" &&
    (isInteger(value.reply_to) || value.reply_to === null) &&
    typeof value.title === "string" &&
    typeof value.content === "string" &&
    typeof value.html === "string" &&
    typeof value.created_by === "string" &&
    typeof value.created_at === "string"
  )
}

export function isDeepwellPageRevision(
  value: unknown
): value is { revision_number: number; user_id: number } {
  return (
    isXmlRpcStruct(value) &&
    isInteger(value.revision_number) &&
    value.revision_number === 0 &&
    isInteger(value.user_id)
  )
}

export function expectDeepwellFiles(
  value: unknown,
  method: string,
  includeData: boolean
): DeepwellFile[] {
  return expectArray(value, method, (file): file is DeepwellFile =>
    isDeepwellFile(file, includeData)
  )
}

export function expectDeepwellForumPosts(
  value: unknown,
  method: string
): DeepwellForumPost[] {
  return expectArray(value, method, isDeepwellForumPost)
}
