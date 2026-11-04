import { strict as assert } from "node:assert"
import { promisify } from "node:util"
import http from "node:http"
import type { IncomingHttpHeaders } from "node:http"
import zlib from "node:zlib"

import {
  buildAnonymousArticleResponseCacheFences,
  buildAnonymousArticleResponseCacheKey,
  buildAnonymousArticleResponseCacheMetadata,
  buildAnonymousArticleResponseTokenKey,
  buildPublicContentFenceKey,
  createMemoryArticleResponseFenceCache,
  createMemoryArticleResponseCacheStore
} from "../../src/lib/server/cache/article-response/index.ts"
import type { ArticleResponseCacheStore } from "../../src/lib/server/cache/article-response/storage.ts"
import type { ArticleResponseTokenStore } from "../../src/lib/server/cache/article-response/stores.ts"
import type { FenceStore } from "../../src/lib/server/cache/article-response/fences.ts"
import type { HeaderPair } from "../../src/lib/server/cache/article-response/entry.ts"
import { createArticleResponseFastPathHandler } from "../../article-response-fast-path.ts"
import type { FastPathFallbackHandler } from "../../article-response-fast-path.ts"

export interface CountingStore {
  get: (key: string) => Promise<unknown>
  mget: (keys: string[]) => Promise<unknown[]>
  set: (key: string, value: string, ttlSeconds?: number) => Promise<unknown>
  getCalls: () => number
  mgetCalls: () => number
}

export interface DeferredGetStore extends CountingStore {
  started: Promise<string>
  resume: () => void
}

export type FenceCallbacks = Parameters<
  NonNullable<ArticleResponseTokenStore["subscribe"]>
>[0]

export interface FenceSubscriberStub {
  callbacks: FenceCallbacks
  subscribe: (callbacks: FenceCallbacks) => { close: () => void }
}

export interface WithServerContext {
  baseUrl: string
  handlerCalls: () => number
}

export type FastPathOptions = Omit<
  Parameters<typeof createArticleResponseFastPathHandler>[0],
  "responseStore" | "tokenStore" | "handler"
>

export interface RawResponse {
  status: number | undefined
  headers: IncomingHttpHeaders
  body: Buffer
}

export interface RequestRawOptions {
  method?: string
  headers?: IncomingHttpHeaders
}

export interface RecordingResponse {
  calls: [string, ...unknown[]][]
  statusCode: number | undefined
  writeHead: (status: number, headers: unknown) => void
  setHeader: (name: string, value: unknown) => void
  removeHeader: (name: string) => void
  end: (body?: unknown) => void
}

export const SITE_ID = 6000005
export const SITE_SLUG = "scp-wiki"
export const REQUEST_HOST = "scp-wiki.example"
export const REQUEST_LOCALES = ["ja-JP", "en-US"]
export const BACKEND_LOCALES = ["ja-JP", "en-US", "en"]
export const PUBLIC_CONTENT_FENCE = "7"
export const PERMISSION_FENCE = "site=11,user=13"
export const DEEPWELL_ARTICLE_PAGE_CACHE_KEY =
  "deepwell:article-view:page:v1:site=6000005:page=173:rev=9:updated=123:permission=site=11,user=13:body=aa"
export const brotliDecompress = promisify(zlib.brotliDecompress)
export const gunzip = promisify(zlib.gunzip)

export const seedFastPathStoreEntry = async (
  {
    responseStore,
    tokenStore
  }: { responseStore: ArticleResponseCacheStore; tokenStore: ArticleResponseCacheStore },
  {
    route = { slug: "scp-173", extra: "" },
    deepwellArticlePageCacheKey = DEEPWELL_ARTICLE_PAGE_CACHE_KEY,
    headers = [
      ["content-type", "text/html; charset=utf-8"],
      ["x-cache-fixture", "hit"]
    ],
    body = "<!doctype html><html><body>cached article</body></html>"
  }: {
    route?: { slug: string; extra: string }
    deepwellArticlePageCacheKey?: string
    headers?: HeaderPair[]
    body?: string
  } = {}
) => {
  const tokenMetadata = buildAnonymousArticleResponseCacheFences({
    siteId: SITE_ID,
    siteSlug: SITE_SLUG,
    requestHost: REQUEST_HOST,
    route,
    requestLocales: REQUEST_LOCALES,
    backendLocales: BACKEND_LOCALES,
    publicContentFence: PUBLIC_CONTENT_FENCE,
    permissionFence: PERMISSION_FENCE
  })
  const tokenKey = buildAnonymousArticleResponseTokenKey(tokenMetadata!)
  await tokenStore.set(
    tokenKey,
    JSON.stringify({ articlePageCacheKey: deepwellArticlePageCacheKey })
  )

  const metadata = buildAnonymousArticleResponseCacheMetadata({
    siteId: SITE_ID,
    siteSlug: SITE_SLUG,
    requestHost: REQUEST_HOST,
    requestLocales: REQUEST_LOCALES,
    backendLocales: BACKEND_LOCALES,
    deepwellArticlePageCacheKey,
    publicContentFence: PUBLIC_CONTENT_FENCE,
    permissionFence: PERMISSION_FENCE
  })
  const cacheKey = buildAnonymousArticleResponseCacheKey(metadata!)
  await responseStore.set(
    cacheKey,
    JSON.stringify({
      status: 200,
      headers,
      body
    })
  )

  return { responseStore, tokenStore, cacheKey, tokenKey }
}

export const createFastPathFixtureStore = async ({
  route = { slug: "scp-173", extra: "" },
  headers = [
    ["content-type", "text/html; charset=utf-8"],
    ["x-cache-fixture", "hit"]
  ],
  body = "<!doctype html><html><body>cached article</body></html>"
}: {
  route?: { slug: string; extra: string }
  headers?: HeaderPair[]
  body?: string
} = {}) => {
  const tokenStore = createMemoryArticleResponseCacheStore()
  const responseStore = createMemoryArticleResponseCacheStore()
  await tokenStore.set(buildPublicContentFenceKey(SITE_ID), PUBLIC_CONTENT_FENCE)
  await tokenStore.set(`permission:site:${SITE_ID}:version`, "11")
  await tokenStore.set(`permission:site:${SITE_ID}:user:anonymous:version`, "13")

  const { cacheKey, tokenKey } = await seedFastPathStoreEntry(
    { responseStore, tokenStore },
    { route, headers, body }
  )

  return { responseStore, tokenStore, cacheKey, tokenKey }
}

export const createCountingStore = (store: ArticleResponseCacheStore): CountingStore => {
  let getCalls = 0
  let mgetCalls = 0

  return {
    async get(key: string) {
      getCalls += 1
      return store.get(key)
    },
    async mget(keys: string[]) {
      mgetCalls += 1
      return Promise.all(keys.map((key) => store.get(key)))
    },
    async set(key: string, value: string, ttlSeconds?: number) {
      return store.set(key, value, ttlSeconds)
    },
    getCalls() {
      return getCalls
    },
    mgetCalls() {
      return mgetCalls
    }
  }
}

export const createDeferredGetStore = (
  store: CountingStore,
  shouldDefer: (key: string) => boolean
): DeferredGetStore => {
  let resolveStarted!: (key: string) => void
  let resume!: () => void
  const started = new Promise<string>((resolve) => {
    resolveStarted = resolve
  })
  const ready = new Promise<void>((resolve) => {
    resume = resolve
  })
  let deferred = false

  return {
    async get(key: string) {
      if (!deferred && shouldDefer(key)) {
        deferred = true
        resolveStarted(key)
        await ready
      }
      return store.get(key)
    },
    async mget(keys: string[]) {
      return store.mget(keys)
    },
    async set(key: string, value: string, ttlSeconds?: number) {
      return store.set(key, value, ttlSeconds)
    },
    getCalls() {
      return store.getCalls?.() ?? 0
    },
    mgetCalls() {
      return store.mgetCalls?.() ?? 0
    },
    started,
    resume
  }
}

export const createFenceSubscriber = (): FenceSubscriberStub => {
  const subscriber: FenceSubscriberStub = {
    callbacks: null!,
    subscribe(callbacks: FenceCallbacks) {
      subscriber.callbacks = callbacks
      return { close() {} }
    }
  }
  return subscriber
}

export const createTrustedFenceCache = async (
  store: FenceStore | null,
  options: Record<string, unknown> = {}
) => {
  const subscriber = createFenceSubscriber()
  const fenceCache = createMemoryArticleResponseFenceCache({
    store,
    subscriber,
    ...options
  })
  subscriber.callbacks.onSubscribed()
  return { fenceCache, subscriber }
}

export const withServer = async (
  {
    responseStore,
    tokenStore
  }: { responseStore: ArticleResponseCacheStore; tokenStore: ArticleResponseTokenStore },
  run: (context: WithServerContext) => Promise<unknown>,
  fastPathOptions: FastPathOptions = {}
) => {
  let handlerCalls = 0
  const handler: FastPathFallbackHandler = (request, response) => {
    handlerCalls += 1
    response.statusCode = 209
    response.setHeader("content-type", "text/plain")
    response.end("fallback handler")
  }
  const fastPathHandler = createArticleResponseFastPathHandler({
    responseStore,
    tokenStore,
    handler,
    ...fastPathOptions
  })
  const server = http.createServer((request, response) => {
    void fastPathHandler(request, response)
  })

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address() as { port: number }
  assert.equal(typeof address, "object")
  try {
    return await run({
      baseUrl: `http://127.0.0.1:${address.port}`,
      handlerCalls: () => handlerCalls
    })
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

export const requestRaw = (
  url: string,
  { method = "GET", headers = {} }: RequestRawOptions = {}
) => {
  return new Promise<RawResponse>((resolve, reject) => {
    const request = http.request(url, { method, headers }, (response) => {
      const chunks: Buffer[] = []
      response.on("data", (chunk) => chunks.push(chunk))
      response.on("end", () => {
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks)
        })
      })
    })
    request.on("error", reject)
    request.end()
  })
}

// Node's built-in fetch rewrites Host, so these tests use http.request instead.
export const fetch = async (
  url: string,
  { method = "GET", headers = {} }: RequestRawOptions = {}
) => {
  const response = await requestRaw(url, { method, headers })
  const responseHeaders = new Headers()
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) responseHeaders.append(name, item)
    } else if (value !== undefined) {
      responseHeaders.append(name, value)
    }
  }
  return new Response(response.body as unknown as BodyInit, {
    status: response.status,
    headers: responseHeaders
  })
}

export const largeHtmlBody = () => {
  return `<!doctype html><html><body>${"<p>cached article paragraph</p>".repeat(120)}</body></html>`
}

export const fastPathHeaders = {
  host: REQUEST_HOST.toUpperCase(),
  "accept-language": "ja-JP,en-US;q=0.8",
  "x-wikijump-site-id": String(SITE_ID),
  "x-wikijump-site-slug": SITE_SLUG
}

export const createRecordingResponse = (): RecordingResponse => {
  const calls: [string, ...unknown[]][] = []
  return {
    calls,
    statusCode: undefined,
    writeHead(status, headers) {
      calls.push(["writeHead", status, headers])
    },
    setHeader(name, value) {
      calls.push(["setHeader", name, value])
    },
    removeHeader(name) {
      calls.push(["removeHeader", name])
    },
    end(body) {
      calls.push(["end", body])
    }
  }
}
