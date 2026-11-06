import {
  ARTICLE_RESPONSE_CACHE_TTL_SECONDS,
  hasSessionCookie,
  hasValidArticleResponseCacheIdentity,
  sha256Hex,
  utf8Hex
} from "./shared.ts"
import { readAnonymousArticleResponseCacheFences } from "./fences.ts"
import {
  readCachedArticleResponse,
  readCachedArticleResponseEntry,
  serializeArticleResponseForCache,
  writeCachedArticleResponse
} from "./storage.ts"
import { ARTICLE_ROUTES } from "../../load/article-route-registry.ts"
import type { ArticleResponseCacheStore } from "./storage.ts"

export interface AnonymousArticleResponseCacheMetadata {
  siteId: number
  siteSlug: string
  requestHost: string
  requestLocales: string[]
  backendLocales: string[]
  deepwellArticlePageCacheKey: string
  publicContentFence: string
  permissionFence: string
}

export interface AnonymousArticleResponseTokenMetadata {
  siteId: number
  siteSlug: string
  requestHost: string
  route: { slug?: string; extra?: string } | null
  requestLocales: string[]
  backendLocales: string[]
  publicContentFence: string
  permissionFence: string
}

const PERMISSION_FENCE = "anonymous-page-view-v1"
const RESPONSE_CACHE_PREFIX = "framerail:article-response:v1"
const RESPONSE_TOKEN_PREFIX = "framerail:article-response-token:v1"

const isEmptyExtra = (extra: string | null | undefined) => {
  return extra === undefined || extra === null || extra === ""
}

const reject = (reason: string) => {
  return { cacheable: false, reason }
}

export const canConsiderAnonymousArticleResponseCache = ({
  method,
  routeId,
  url,
  requestUrl = url,
  siteId,
  siteSlug,
  route,
  cookieHeader
}: {
  method: string
  routeId: string | null | undefined
  url: URL
  requestUrl?: URL
  siteId: number
  siteSlug: string
  route?: { slug?: string; extra?: string } | null
  cookieHeader: string | null | undefined
}) => {
  if (method !== "GET") return reject("method")
  if (requestUrl.pathname.endsWith("/__data.json")) return reject("data-request")
  if (!ARTICLE_ROUTES.has(routeId ?? "")) return reject("route")
  if (url.search !== "") return reject("query")
  if (!Number.isInteger(siteId) || siteId <= 0) return reject("site-id")
  if (!siteSlug) return reject("site-slug")
  if (hasSessionCookie(cookieHeader)) return reject("session-cookie")
  if (!isEmptyExtra(route?.extra)) return reject("extra")

  return { cacheable: true }
}

export const buildAnonymousArticleResponseCacheMetadata = ({
  siteId,
  siteSlug,
  requestHost,
  requestLocales,
  backendLocales,
  deepwellArticlePageCacheKey,
  publicContentFence = "0",
  permissionFence = PERMISSION_FENCE
}: {
  siteId: number
  siteSlug: string
  requestHost: string
  requestLocales: string[]
  backendLocales: string[]
  deepwellArticlePageCacheKey: string | null | undefined
  publicContentFence?: string
  permissionFence?: string
}): AnonymousArticleResponseCacheMetadata | null => {
  if (
    !hasValidArticleResponseCacheIdentity({
      siteId,
      siteSlug,
      requestHost,
      requestLocales,
      backendLocales
    })
  ) {
    return null
  }
  if (!deepwellArticlePageCacheKey) return null
  if (!publicContentFence || !permissionFence) return null

  return {
    siteId,
    siteSlug,
    requestHost,
    requestLocales,
    backendLocales,
    deepwellArticlePageCacheKey,
    publicContentFence,
    permissionFence
  }
}

export const buildAnonymousArticleResponseCacheKey = (
  metadata: AnonymousArticleResponseCacheMetadata
) => {
  return [
    RESPONSE_CACHE_PREFIX,
    `site=${metadata.siteId}`,
    `slug=${utf8Hex(metadata.siteSlug)}`,
    `host=${utf8Hex(metadata.requestHost)}`,
    `requestLocales=${utf8Hex(metadata.requestLocales.join(","))}`,
    `backendLocales=${utf8Hex(metadata.backendLocales.join(","))}`,
    `content=${metadata.publicContentFence}`,
    `permission=${metadata.permissionFence}`,
    `deepwell=${sha256Hex(metadata.deepwellArticlePageCacheKey)}`
  ].join(":")
}

const normalizeRouteForToken = (
  route: { slug?: string; extra?: string } | null | undefined
) => {
  if (!route) return { slug: "", extra: "" }
  return { slug: route.slug ?? "", extra: route.extra ?? "" }
}

export const buildAnonymousArticleResponseTokenKey = (
  metadata: AnonymousArticleResponseTokenMetadata
) => {
  const route = normalizeRouteForToken(metadata.route)

  return [
    RESPONSE_TOKEN_PREFIX,
    `site=${metadata.siteId}`,
    `slug=${utf8Hex(metadata.siteSlug)}`,
    `host=${utf8Hex(metadata.requestHost)}`,
    `route=${sha256Hex(JSON.stringify(route))}`,
    `requestLocales=${utf8Hex(metadata.requestLocales.join(","))}`,
    `backendLocales=${utf8Hex(metadata.backendLocales.join(","))}`,
    `content=${metadata.publicContentFence}`,
    `permission=${utf8Hex(metadata.permissionFence)}`
  ].join(":")
}

export const readAnonymousArticleResponseCache = async ({
  store,
  metadata
}: {
  store: ArticleResponseCacheStore | null
  metadata: AnonymousArticleResponseCacheMetadata | null
}) => {
  if (!metadata) return null
  return readCachedArticleResponse(
    store as ArticleResponseCacheStore,
    buildAnonymousArticleResponseCacheKey(metadata)
  )
}

export const readAnonymousArticleResponseCacheEntry = async ({
  store,
  metadata
}: {
  store: ArticleResponseCacheStore | null
  metadata: AnonymousArticleResponseCacheMetadata | null
}) => {
  if (!metadata) return null
  return readCachedArticleResponseEntry(
    store as ArticleResponseCacheStore,
    buildAnonymousArticleResponseCacheKey(metadata)
  )
}

const isTokenValue = (value: unknown): value is { articlePageCacheKey: string } => {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { articlePageCacheKey: unknown }).articlePageCacheKey === "string" &&
    (value as { articlePageCacheKey: string }).articlePageCacheKey.length > 0
  )
}

export const readAnonymousArticleResponseToken = async ({
  store,
  tokenMetadata
}: {
  store: ArticleResponseCacheStore | null
  tokenMetadata: AnonymousArticleResponseTokenMetadata | null
}) => {
  if (!tokenMetadata) return null

  try {
    const cached = await (store as ArticleResponseCacheStore).get(
      buildAnonymousArticleResponseTokenKey(tokenMetadata)
    )
    if (typeof cached !== "string") return null

    const value: unknown = JSON.parse(cached)
    if (!isTokenValue(value)) return null

    return value.articlePageCacheKey
  } catch {
    return null
  }
}

export const writeAnonymousArticleResponseToken = async ({
  store,
  tokenMetadata,
  deepwellArticlePageCacheKey,
  ttlSeconds = ARTICLE_RESPONSE_CACHE_TTL_SECONDS
}: {
  store: ArticleResponseCacheStore | null
  tokenMetadata: AnonymousArticleResponseTokenMetadata | null
  deepwellArticlePageCacheKey: string
  ttlSeconds?: number
}) => {
  if (!tokenMetadata || !deepwellArticlePageCacheKey) return false

  try {
    const currentFences = await readAnonymousArticleResponseCacheFences({
      store,
      siteId: tokenMetadata.siteId
    })
    if (
      currentFences?.publicContentFence !== tokenMetadata.publicContentFence ||
      currentFences?.permissionFence !== tokenMetadata.permissionFence
    ) {
      return false
    }

    const value = JSON.stringify({ articlePageCacheKey: deepwellArticlePageCacheKey })
    return (
      (await (store as ArticleResponseCacheStore).set(
        buildAnonymousArticleResponseTokenKey(tokenMetadata),
        value,
        ttlSeconds
      )) !== false
    )
  } catch {
    return false
  }
}

export const writeAnonymousArticleResponseCache = async ({
  store,
  metadata,
  response,
  ttlSeconds = ARTICLE_RESPONSE_CACHE_TTL_SECONDS
}: {
  store: ArticleResponseCacheStore | null
  metadata: AnonymousArticleResponseCacheMetadata | null
  response: Response
  ttlSeconds?: number
}) => {
  if (!metadata || response.status !== 200 || response.headers.has("set-cookie")) {
    return false
  }

  return writeCachedArticleResponse(
    store as ArticleResponseCacheStore,
    buildAnonymousArticleResponseCacheKey(metadata),
    await serializeArticleResponseForCache(response),
    ttlSeconds
  )
}

export {
  ARTICLE_RESPONSE_CACHE_MAX_BYTES,
  ARTICLE_RESPONSE_CACHE_MAX_ENTRIES,
  ARTICLE_RESPONSE_CACHE_MAX_SERIALIZED_BYTES,
  ARTICLE_RESPONSE_CACHE_TTL_SECONDS,
  ARTICLE_RESPONSE_FENCE_INVALIDATION_CHANNEL,
  ARTICLE_RESPONSE_LOCAL_HOT_CACHE_MAX_BYTES,
  ARTICLE_RESPONSE_LOCAL_HOT_CACHE_MAX_ENTRIES,
  ARTICLE_RESPONSE_LOCAL_HOT_CACHE_TTL_MS,
  PUBLIC_CONTENT_FENCE_PREFIX
} from "./shared.ts"
export {
  buildAnonymousArticleResponseCacheFences,
  buildAnonymousPermissionFenceKeys,
  buildPublicContentFenceKey,
  createMemoryArticleResponseFenceCache,
  readAnonymousArticleResponseCacheFences
} from "./fences.ts"
export { normalizeCachedArticleResponseEntry } from "./entry.ts"
export { createLocalArticleResponseHotCache } from "./hot.ts"
export {
  createMemoryArticleResponseCacheStore,
  deserializeCachedArticleResponse,
  readCachedArticleResponse,
  readCachedArticleResponseEntry,
  serializeArticleResponseForCache,
  writeCachedArticleResponse
} from "./storage.ts"
