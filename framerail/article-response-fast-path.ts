import {
  buildAnonymousArticleResponseCacheMetadata,
  buildAnonymousArticleResponseTokenKey,
  readAnonymousArticleResponseCacheEntry,
  readAnonymousArticleResponseToken
} from "./src/lib/server/cache/article-response/index.ts"
import {
  buildAnonymousArticleResponseCacheFences,
  readAnonymousArticleResponseCacheFences
} from "./src/lib/server/cache/article-response/fences.ts"
import { createLocalArticleResponseHotCache } from "./src/lib/server/cache/article-response/hot.ts"
import { hasSessionCookie } from "./src/lib/server/cache/article-response/shared.ts"
import {
  containsCspNonce,
  renewCspNonce
} from "./src/lib/server/cache/article-response/entry.ts"
import { applyStaticSecurityHeadersToNodeResponse } from "./src/lib/server/security-headers.ts"
import { parseAcceptLangHeader, withFallbackLocale } from "./src/lib/locales.ts"
import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http"
import { promisify } from "node:util"
import zlib from "node:zlib"
import { randomBytes } from "node:crypto"
import type { createMemoryArticleResponseFenceCache } from "./src/lib/server/cache/article-response/fences.ts"
import type { ArticleResponseFencePair } from "./src/lib/server/cache/article-response/fence-values.ts"
import type {
  CachedArticleResponseEntry,
  HeaderPair
} from "./src/lib/server/cache/article-response/entry.ts"
import type { ArticleResponseCacheStore } from "./src/lib/server/cache/article-response/storage.ts"
import type { ArticleResponseTokenStore } from "./src/lib/server/cache/article-response/stores.ts"
import type { ReplayInput } from "./src/lib/server/cache/article-response/replay.ts"

export type FastPathFallbackHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<void> | void

export type ArticleResponseFastPathHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<void>

export interface FastPathRequest {
  route: { slug: string; extra: string } | null
  pathname: string
  siteId: number
  siteSlug: string
  requestHost: string
  requestLocales: string[]
  backendLocales: string[]
  method: string | undefined
}

interface FastPathVariant {
  headers: readonly Readonly<HeaderPair>[]
  bodyBuffer?: Buffer
  nodeRawHeaders?: readonly string[]
}

interface FastPathEntry extends FastPathVariant {
  status: number
  body?: string
  variants?: { br?: FastPathVariant; gzip?: FastPathVariant }
  finalHeaders?: boolean
}

type FastPathFenceCache = ReturnType<typeof createMemoryArticleResponseFenceCache>
type FastPathLocalHotCache = ReturnType<typeof createLocalArticleResponseHotCache>

const FALLBACK_LOCALE = "en"
const SITE_ID_HEADER = "x-wikijump-site-id"
const SITE_SLUG_HEADER = "x-wikijump-site-slug"
const MIN_COMPRESSED_REPLAY_BODY_BYTES = 2048
const brotliCompress = promisify(zlib.brotliCompress)
const gzipCompress = promisify(zlib.gzip)
const STATIC_APP_ROUTE_SLUGS = new Set([
  "-",
  ".well-known",
  "about",
  "forum",
  "xml-rpc-api.php"
])
const singleHeaderValue = (headers: IncomingHttpHeaders, name: string): string | null => {
  const value = headers[name]
  if (typeof value === "string") return value
  if (Array.isArray(value) && value.length === 1) return value[0]
  return null
}

const toFetchHeaders = (headers: IncomingHttpHeaders): Headers => {
  const fetchHeaders = new Headers()
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") {
      fetchHeaders.set(name, value)
    } else if (Array.isArray(value)) {
      fetchHeaders.set(name, value.join(", "))
    }
  }
  return fetchHeaders
}

const articleRouteFromPathname = (
  pathname: string
): { slug: string; extra: string } | null | undefined => {
  if (pathname === "/") return null
  if (!pathname.startsWith("/") || pathname.endsWith("/")) return undefined

  const segments = pathname.split("/")
  if (segments.length !== 2 || !segments[1]) return undefined

  try {
    const slug = decodeURIComponent(segments[1])
    if (!slug || slug.includes("/")) return undefined
    if (STATIC_APP_ROUTE_SLUGS.has(slug)) return undefined
    return { slug, extra: "" }
  } catch {
    return undefined
  }
}

const fencesMatch = (
  currentFences: ArticleResponseFencePair | null | undefined,
  capturedFences: ArticleResponseFencePair | null | undefined
): boolean => {
  return (
    currentFences?.publicContentFence === capturedFences?.publicContentFence &&
    currentFences?.permissionFence === capturedFences?.permissionFence
  )
}

const revalidateCapturedFences = async ({
  store,
  fenceCache,
  siteId,
  fences
}: {
  store: ArticleResponseTokenStore | null
  fenceCache: FastPathFenceCache | null
  siteId: number
  fences: ArticleResponseFencePair | null | undefined
}): Promise<boolean> => {
  if (!fences) return false

  const localValidation = fenceCache?.areFencesCurrent?.({
    siteId,
    publicContentFence: fences.publicContentFence,
    permissionFence: fences.permissionFence
  })
  if (localValidation !== null && localValidation !== undefined) {
    return localValidation === true
  }

  return fencesMatch(
    await readAnonymousArticleResponseCacheFences({
      store,
      siteId
    }),
    fences
  )
}

export const getArticleResponseFastPathRequest = (
  request: IncomingMessage
): FastPathRequest | null => {
  if (request.method !== "GET" && request.method !== "HEAD") return null
  if (hasSessionCookie(singleHeaderValue(request.headers, "cookie"))) return null

  let url
  try {
    url = new URL(request.url ?? "", "http://localhost")
  } catch {
    return null
  }
  if (url.search !== "") return null

  const route = articleRouteFromPathname(url.pathname)
  if (route === undefined) return null

  const siteSlug = singleHeaderValue(request.headers, SITE_SLUG_HEADER)
  const requestHost = singleHeaderValue(request.headers, "host")?.toLowerCase()
  const siteId = Number.parseInt(
    singleHeaderValue(request.headers, SITE_ID_HEADER) ?? "",
    10
  )
  if (!siteSlug || !requestHost || !Number.isInteger(siteId) || siteId <= 0) return null

  const fetchHeaders = toFetchHeaders(request.headers)
  const requestLocales = parseAcceptLangHeader({ headers: fetchHeaders } as Request)
  const backendLocales = withFallbackLocale(requestLocales, FALLBACK_LOCALE)

  return {
    route,
    pathname: url.pathname,
    siteId,
    siteSlug,
    requestHost,
    requestLocales,
    backendLocales,
    method: request.method
  }
}

const finalArticleResponseFastPathHeaders = (
  entry: { headers: readonly HeaderPair[] },
  pathname: string
): HeaderPair[] => {
  const headers = new Map<string, string>(
    entry.headers.map(([name, value]): HeaderPair => [name.toLowerCase(), value])
  )
  const headerTarget = {
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), String(value))
    },
    removeHeader(name: string) {
      headers.delete(name.toLowerCase())
    }
  }

  applyStaticSecurityHeadersToNodeResponse(headerTarget, pathname)
  return [...headers.entries()].sort(([left], [right]) => left.localeCompare(right))
}

const mergeVaryAcceptEncoding = (value: string | undefined): string => {
  if (!value) return "Accept-Encoding"
  const parts = value.split(",").map((part) => part.trim())
  if (parts.some((part) => part.toLowerCase() === "accept-encoding")) return value
  return `${value}, Accept-Encoding`
}

const shouldPrepareCompressedReplayVariants = ({
  status,
  headers,
  bodyBuffer
}: {
  status: number
  headers: readonly HeaderPair[]
  bodyBuffer: Buffer
}): boolean => {
  if (status !== 200) return false
  if (bodyBuffer.byteLength < MIN_COMPRESSED_REPLAY_BODY_BYTES) return false

  const headerMap = new Map(headers)
  if (headerMap.has("set-cookie")) return false
  if (headerMap.has("content-encoding")) return false
  if (
    headerMap
      .get("cache-control")
      ?.split(",")
      .some((part) => part.trim().toLowerCase() === "no-transform")
  ) {
    return false
  }
  return headerMap.get("content-type")?.toLowerCase().startsWith("text/html") === true
}

const compressedVariantHeaders = (
  headers: readonly HeaderPair[],
  encoding: string,
  bodyBuffer: Buffer
): HeaderPair[] => {
  const mapped = new Map(headers)
  mapped.set("content-encoding", encoding)
  mapped.set("content-length", String(bodyBuffer.byteLength))
  mapped.set("vary", mergeVaryAcceptEncoding(mapped.get("vary")))
  mapped.delete("transfer-encoding")

  const etag = mapped.get("etag")
  if (etag && !etag.trim().startsWith("W/")) {
    mapped.delete("etag")
  }

  return [...mapped.entries()].sort(([left], [right]) => left.localeCompare(right))
}

const prepareCompressedReplayVariants = async (
  headers: readonly HeaderPair[],
  bodyBuffer: Buffer
) => {
  const [brBodyBuffer, gzipBodyBuffer] = await Promise.all([
    brotliCompress(bodyBuffer, {
      params: {
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: bodyBuffer.byteLength
      }
    }),
    gzipCompress(bodyBuffer, { level: 6 })
  ])

  return {
    br: {
      headers: compressedVariantHeaders(headers, "br", brBodyBuffer),
      bodyBuffer: brBodyBuffer
    },
    gzip: {
      headers: compressedVariantHeaders(headers, "gzip", gzipBodyBuffer),
      bodyBuffer: gzipBodyBuffer
    }
  }
}

const prepareArticleResponseFastPathReplay = async (
  entry: CachedArticleResponseEntry,
  pathname: string
): Promise<FastPathEntry> => {
  const headers = finalArticleResponseFastPathHeaders(entry, pathname)
  const bodyBuffer = Buffer.isBuffer(entry.bodyBuffer)
    ? entry.bodyBuffer
    : Buffer.from(entry.body, "utf8")
  const variants = shouldPrepareCompressedReplayVariants({
    status: entry.status,
    headers,
    bodyBuffer
  })
    ? await prepareCompressedReplayVariants(headers, bodyBuffer)
    : undefined
  const replayHeaders = variants
    ? headers
        .map(([name, value]): HeaderPair =>
          name === "vary" ? [name, mergeVaryAcceptEncoding(value)] : [name, value]
        )
        .concat(
          headers.some(([name]) => name === "vary")
            ? []
            : ([["vary", "Accept-Encoding"]] as HeaderPair[])
        )
        .sort(([left], [right]) => left.localeCompare(right))
    : headers

  return {
    status: entry.status,
    headers: replayHeaders,
    nodeRawHeaders: Object.freeze(
      replayHeaders.flatMap(([name, value]) => [name, value])
    ),
    bodyBuffer,
    variants,
    finalHeaders: true
  }
}

const parseEncodingQuality = (value: string): number => {
  const quality = Number.parseFloat(value)
  if (!Number.isFinite(quality)) return 0
  if (quality < 0) return 0
  if (quality > 1) return 1
  return quality
}

const parseAcceptEncoding = (
  header: string | null
): {
  br: number | null
  gzip: number | null
  identity: number | null
  wildcard: number | null
} => {
  const accepted: {
    br: number | null
    gzip: number | null
    identity: number | null
    wildcard: number | null
  } = { br: null, gzip: null, identity: null, wildcard: null }
  if (!header) return accepted

  for (const part of header.split(",")) {
    const [rawEncoding, ...parameters] = part.split(";")
    const encoding = rawEncoding.trim().toLowerCase()
    if (!encoding) continue
    let quality = 1
    for (const parameter of parameters) {
      const [name, value] = parameter.split("=")
      if (name?.trim().toLowerCase() === "q") {
        quality = parseEncodingQuality(value?.trim())
      }
    }
    if (encoding === "br" || encoding === "gzip" || encoding === "identity") {
      accepted[encoding] = quality
    } else if (encoding === "*") {
      accepted.wildcard = quality
    }
  }

  return accepted
}

const selectReplayVariant = (
  request: IncomingMessage,
  entry: FastPathEntry
): FastPathEntry => {
  const variants = entry.variants
  if (!variants?.br && !variants?.gzip) return entry

  const acceptEncoding = singleHeaderValue(request.headers, "accept-encoding")
  if (!acceptEncoding) return entry

  const accepted = parseAcceptEncoding(acceptEncoding)
  const quality = (encoding: "br" | "gzip" | "identity"): number => {
    if (accepted[encoding] !== null) return accepted[encoding]
    if (accepted.wildcard !== null && encoding !== "identity") return accepted.wildcard
    return encoding === "identity" ? 1 : 0
  }
  const candidates = [
    variants.br ? { encoding: "br", variant: variants.br, priority: 3 } : null,
    variants.gzip ? { encoding: "gzip", variant: variants.gzip, priority: 2 } : null,
    { encoding: "identity", variant: entry, priority: 1 }
  ].filter(Boolean) as {
    encoding: "br" | "gzip" | "identity"
    variant: FastPathVariant
    priority: number
  }[]

  candidates.sort((left, right) => {
    const qualityDelta = quality(right.encoding) - quality(left.encoding)
    if (qualityDelta !== 0) return qualityDelta
    return right.priority - left.priority
  })

  const selected = candidates[0]
  if (quality(selected.encoding) <= 0) return entry
  if (selected.encoding === "identity") return entry

  return {
    status: entry.status,
    headers: selected.variant.headers,
    nodeRawHeaders: selected.variant.nodeRawHeaders,
    bodyBuffer: selected.variant.bodyBuffer,
    finalHeaders: entry.finalHeaders
  }
}

export const readArticleResponseFastPathEntry = async ({
  store,
  request,
  localHotCache,
  fenceCache = null
}: {
  store: (ArticleResponseCacheStore & ArticleResponseTokenStore) | null | undefined
  request: IncomingMessage
  localHotCache?: FastPathLocalHotCache | null
  fenceCache?: FastPathFenceCache | null
}): Promise<FastPathEntry | null> => {
  return readArticleResponseFastPathEntryFromStores({
    responseStore: store,
    tokenStore: store,
    request,
    localHotCache,
    fenceCache
  })
}

export const readArticleResponseFastPathEntryFromStores = async ({
  responseStore,
  tokenStore,
  request,
  localHotCache,
  fenceCache = null
}: {
  responseStore?: ArticleResponseCacheStore | null
  tokenStore?: ArticleResponseTokenStore | null
  request: IncomingMessage
  localHotCache?: FastPathLocalHotCache | null
  fenceCache?: FastPathFenceCache | null
}): Promise<FastPathEntry | null> => {
  if (!responseStore || !tokenStore || !request) return null

  try {
    const candidate = getArticleResponseFastPathRequest(request)
    if (!candidate) return null

    const fences = fenceCache
      ? await fenceCache.readFences({ siteId: candidate.siteId })
      : await readAnonymousArticleResponseCacheFences({
          store: tokenStore,
          siteId: candidate.siteId
        })
    const tokenMetadata = buildAnonymousArticleResponseCacheFences({
      siteId: candidate.siteId,
      siteSlug: candidate.siteSlug,
      requestHost: candidate.requestHost,
      route: candidate.route,
      requestLocales: candidate.requestLocales,
      backendLocales: candidate.backendLocales,
      publicContentFence: fences?.publicContentFence,
      permissionFence: fences?.permissionFence
    })
    if (!tokenMetadata) return null

    const shouldRevalidateLocalFences =
      fenceCache?.canValidateFencesLocally?.({ siteId: candidate.siteId }) === true
    const tokenKey = buildAnonymousArticleResponseTokenKey(tokenMetadata)
    const hotEntry =
      localHotCache?.getSharedReplayForInternalUse?.(tokenKey) ??
      localHotCache?.getReplay?.(tokenKey) ??
      localHotCache?.get(tokenKey)
    if (hotEntry?.status === 200) {
      if (
        shouldRevalidateLocalFences &&
        !(await revalidateCapturedFences({
          store: tokenStore,
          fenceCache,
          siteId: candidate.siteId,
          fences
        }))
      ) {
        return null
      }
      return hotEntry
    }

    const deepwellArticlePageCacheKey = await readAnonymousArticleResponseToken({
      store: tokenStore,
      tokenMetadata
    })
    const metadata = buildAnonymousArticleResponseCacheMetadata({
      siteId: candidate.siteId,
      siteSlug: candidate.siteSlug,
      requestHost: candidate.requestHost,
      requestLocales: candidate.requestLocales,
      backendLocales: candidate.backendLocales,
      deepwellArticlePageCacheKey,
      publicContentFence: fences?.publicContentFence,
      permissionFence: fences?.permissionFence
    })
    const cachedEntry = await readAnonymousArticleResponseCacheEntry({
      store: responseStore,
      metadata
    })

    if (cachedEntry?.status !== 200) return null
    if (
      shouldRevalidateLocalFences &&
      !(await revalidateCapturedFences({
        store: tokenStore,
        fenceCache,
        siteId: candidate.siteId,
        fences
      }))
    ) {
      return null
    }
    const replay = await prepareArticleResponseFastPathReplay(
      cachedEntry,
      candidate.pathname
    )
    localHotCache?.store(tokenKey, cachedEntry, {
      replay: replay as ReplayInput
    })
    return replay
  } catch {
    return null
  }
}

export const writeArticleResponseFastPathHit = (
  request: IncomingMessage,
  response: ServerResponse,
  entry: FastPathEntry
): void => {
  entry = selectReplayVariant(request, entry)
  if (entry.finalHeaders === true && Array.isArray(entry.nodeRawHeaders)) {
    response.writeHead(entry.status, entry.nodeRawHeaders)
    response.end(request.method === "HEAD" ? undefined : (entry.bodyBuffer ?? entry.body))
    return
  }

  response.statusCode = entry.status
  for (const [name, value] of entry.headers) {
    response.setHeader(name, value)
  }
  if (entry.finalHeaders !== true) {
    const pathname = new URL(request.url ?? "", "http://localhost").pathname
    applyStaticSecurityHeadersToNodeResponse(response, pathname)
  }

  if (request.method === "HEAD") {
    response.end()
  } else {
    response.end(entry.bodyBuffer ?? entry.body)
  }
}

/**
 * A cached response replays the CSP nonce of the request that stored it.
 * Renew the nonce for every serve, and rebuild the replay so compressed
 * variants match the renewed body.
 */
export const renewArticleResponseFastPathNonce = async (
  request: IncomingMessage,
  entry: FastPathEntry | null | undefined
): Promise<FastPathEntry | null | undefined> => {
  if (!entry || typeof entry.status !== "number" || !Array.isArray(entry.headers)) {
    return entry
  }
  const bodyBuffer = Buffer.isBuffer(entry.bodyBuffer)
    ? entry.bodyBuffer
    : Buffer.from(entry.body ?? "", "utf8")
  const view = {
    status: entry.status,
    headers: entry.headers as HeaderPair[],
    body: bodyBuffer.toString("utf8")
  }
  if (!containsCspNonce(view)) return entry

  const renewed = renewCspNonce(view, randomBytes(16).toString("base64"))
  const pathname = new URL(request.url ?? "", "http://localhost").pathname
  return prepareArticleResponseFastPathReplay(renewed, pathname)
}

export const createArticleResponseFastPathHandler = ({
  responseStore,
  tokenStore,
  store,
  handler,
  localHotCache,
  localHotCacheOptions,
  fenceCache
}: {
  responseStore?: ArticleResponseCacheStore | null
  tokenStore?: ArticleResponseTokenStore | null
  store?: (ArticleResponseCacheStore & ArticleResponseTokenStore) | null
  handler: FastPathFallbackHandler
  localHotCache?: FastPathLocalHotCache | null
  localHotCacheOptions?: Parameters<typeof createLocalArticleResponseHotCache>[0]
  fenceCache?: FastPathFenceCache | null
}): ArticleResponseFastPathHandler => {
  const resolvedResponseStore = responseStore ?? store
  const resolvedTokenStore = tokenStore ?? store
  const hotCache =
    localHotCache ??
    (localHotCacheOptions
      ? createLocalArticleResponseHotCache(localHotCacheOptions)
      : createLocalArticleResponseHotCache())
  fenceCache?.attachHotCache?.(hotCache)

  return async (request, response) => {
    const cachedEntry = await readArticleResponseFastPathEntryFromStores({
      responseStore: resolvedResponseStore,
      tokenStore: resolvedTokenStore,
      request,
      localHotCache: hotCache,
      fenceCache
    })
    if (cachedEntry) {
      const renewedEntry = await renewArticleResponseFastPathNonce(request, cachedEntry)
      writeArticleResponseFastPathHit(request, response, renewedEntry ?? cachedEntry)
      return
    }

    return handler(request, response)
  }
}
