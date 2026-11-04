import {
  ARTICLE_RESPONSE_LOCAL_HOT_CACHE_MAX_BYTES,
  ARTICLE_RESPONSE_LOCAL_HOT_CACHE_MAX_ENTRIES,
  ARTICLE_RESPONSE_LOCAL_HOT_CACHE_TTL_MS
} from "./shared.ts"
import {
  copyCachedArticleResponseEntry,
  normalizeCachedArticleResponseEntry
} from "./entry.ts"
import type { CachedArticleResponseEntry } from "./entry.ts"
import { createByteLimitedLru } from "./local-lru.ts"
import {
  cachedArticleResponseEntryByteLength,
  copyCachedArticleResponseReplay,
  normalizeCachedArticleResponseReplay
} from "./replay.ts"
import type { PreparedReplay, ReplayInput } from "./replay.ts"

type HotCachedEntry = CachedArticleResponseEntry & { replay: PreparedReplay }

const positiveIntegerOr = (value: number, fallback: number) => {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

const positiveNumberOr = (value: number, fallback: number) => {
  return Number.isFinite(value) && value > 0 ? value : fallback
}

export const createLocalArticleResponseHotCache = ({
  now = () => Date.now(),
  ttlMs = ARTICLE_RESPONSE_LOCAL_HOT_CACHE_TTL_MS,
  maxEntries = ARTICLE_RESPONSE_LOCAL_HOT_CACHE_MAX_ENTRIES,
  maxBytes = ARTICLE_RESPONSE_LOCAL_HOT_CACHE_MAX_BYTES
}: {
  now?: () => number
  ttlMs?: number
  maxEntries?: number
  maxBytes?: number
} = {}) => {
  const records = createByteLimitedLru<HotCachedEntry>({
    now,
    ttlMs: positiveNumberOr(ttlMs, ARTICLE_RESPONSE_LOCAL_HOT_CACHE_TTL_MS),
    maxEntries: positiveIntegerOr(
      maxEntries,
      ARTICLE_RESPONSE_LOCAL_HOT_CACHE_MAX_ENTRIES
    ),
    maxBytes: positiveIntegerOr(maxBytes, ARTICLE_RESPONSE_LOCAL_HOT_CACHE_MAX_BYTES)
  })

  return {
    get(key: string) {
      const value = records.get(key)
      return value ? copyCachedArticleResponseEntry(value) : null
    },

    getReplay(key: string) {
      const value = records.get(key)
      return value ? copyCachedArticleResponseReplay(value.replay) : null
    },

    getSharedReplayForInternalUse(key: string) {
      return records.get(key)?.replay ?? null
    },

    store(key: string, value: unknown, { replay }: { replay?: ReplayInput } = {}) {
      if (typeof key !== "string" || key.length === 0) return false

      const normalized = normalizeCachedArticleResponseEntry(value)
      if (!normalized) {
        records.delete(key)
        return false
      }
      const bodyBuffer = Buffer.from(normalized.body, "utf8")
      const preparedReplay = normalizeCachedArticleResponseReplay(
        { ...normalized, bodyBuffer },
        replay
      )
      if (!preparedReplay) {
        records.delete(key)
        return false
      }

      const cachedValue = copyCachedArticleResponseEntry({
        ...normalized,
        bodyBuffer
      }) as HotCachedEntry
      cachedValue.replay = preparedReplay
      return records.insert(
        key,
        cachedValue,
        cachedArticleResponseEntryByteLength(key, normalized, preparedReplay)
      )
    },

    size: () => records.size(),
    clear: () => records.clear()
  }
}
