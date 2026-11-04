import {
  ARTICLE_RESPONSE_CACHE_MAX_BYTES,
  ARTICLE_RESPONSE_CACHE_MAX_ENTRIES,
  ARTICLE_RESPONSE_CACHE_MAX_SERIALIZED_BYTES,
  ARTICLE_RESPONSE_CACHE_TTL_SECONDS,
  serializedByteLength
} from "./shared.ts"
import { createByteLimitedCache } from "./byte-limited-cache.ts"
import { normalizeCachedArticleResponseEntry } from "./entry.ts"

export interface ArticleResponseCacheStore {
  get: (key: string) => Promise<unknown>
  set: (key: string, value: string, ttlSeconds?: number) => Promise<unknown>
}

export const serializeArticleResponseForCache = async (
  response: Response
): Promise<NonNullable<ReturnType<typeof normalizeCachedArticleResponseEntry>>> => {
  return {
    status: response.status,
    headers: [...response.headers.entries()]
      .filter(([name]) => name.toLowerCase() !== "set-cookie")
      .sort(([left], [right]) => left.localeCompare(right)),
    body: await response.clone().text()
  }
}

export const createMemoryArticleResponseCacheStore = ({
  now = () => Date.now(),
  maxEntries = ARTICLE_RESPONSE_CACHE_MAX_ENTRIES,
  maxBytes = ARTICLE_RESPONSE_CACHE_MAX_BYTES
}: {
  now?: () => number
  maxEntries?: number
  maxBytes?: number
} = {}): ArticleResponseCacheStore & { size: () => number } => {
  const maxEntryCount =
    Number.isInteger(maxEntries) && maxEntries > 0
      ? maxEntries
      : ARTICLE_RESPONSE_CACHE_MAX_ENTRIES
  const maxTotalBytes =
    Number.isInteger(maxBytes) && maxBytes > 0
      ? maxBytes
      : ARTICLE_RESPONSE_CACHE_MAX_BYTES
  const entries = createByteLimitedCache<string>({
    now,
    maxEntries: maxEntryCount,
    maxBytes: maxTotalBytes
  })

  return {
    async get(key: string) {
      return entries.get(key)
    },

    async set(key: string, value: string, ttlSeconds?: number) {
      const effectiveTtlSeconds = ttlSeconds ?? ARTICLE_RESPONSE_CACHE_TTL_SECONDS
      return entries.insert(
        key,
        value,
        serializedByteLength(value),
        now() + effectiveTtlSeconds * 1000
      )
    },

    size: entries.size
  }
}

export const deserializeCachedArticleResponse = (value: unknown) => {
  const entry = normalizeCachedArticleResponseEntry(value)
  if (!entry) return null

  return new Response(entry.body, {
    status: entry.status,
    headers: entry.headers
  })
}

export const readCachedArticleResponseEntry = async (
  store: ArticleResponseCacheStore,
  key: string
) => {
  try {
    const cached = await store.get(key)
    if (typeof cached !== "string") return null

    return normalizeCachedArticleResponseEntry(JSON.parse(cached))
  } catch {
    return null
  }
}

export const readCachedArticleResponse = async (
  store: ArticleResponseCacheStore,
  key: string
) => {
  return deserializeCachedArticleResponse(
    await readCachedArticleResponseEntry(store, key)
  )
}

export const writeCachedArticleResponse = async (
  store: ArticleResponseCacheStore,
  key: string,
  entry: NonNullable<ReturnType<typeof normalizeCachedArticleResponseEntry>>,
  ttlSeconds: number,
  {
    maxSerializedBytes = ARTICLE_RESPONSE_CACHE_MAX_SERIALIZED_BYTES
  }: { maxSerializedBytes?: number } = {}
): Promise<boolean> => {
  try {
    const serialized = JSON.stringify(entry)
    if (serializedByteLength(serialized) > maxSerializedBytes) return false

    return (await store.set(key, serialized, ttlSeconds)) !== false
  } catch {
    return false
  }
}
