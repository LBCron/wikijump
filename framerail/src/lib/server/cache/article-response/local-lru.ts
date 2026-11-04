import { createByteLimitedCache } from "./byte-limited-cache.ts"

export const createByteLimitedLru = <T>({
  now,
  ttlMs,
  maxEntries,
  maxBytes
}: {
  now: () => number
  ttlMs: number
  maxEntries: number
  maxBytes: number
}) => {
  const cache = createByteLimitedCache<T>({
    now,
    maxEntries,
    maxBytes,
    touchOnRead: true
  })

  return {
    get(key: string) {
      return cache.get(key)
    },
    insert(key: string, value: T, bytes: number) {
      return cache.insert(key, value, bytes, now() + ttlMs)
    },
    delete(key: string) {
      cache.delete(key)
    },
    size() {
      return cache.size()
    },
    clear() {
      cache.clear()
    }
  }
}
