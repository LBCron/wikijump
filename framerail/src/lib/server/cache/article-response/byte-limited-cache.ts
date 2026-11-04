import { ExpiryHeap } from "./expiry-heap.ts"

export interface ByteLimitedCacheEntry<T> {
  value: T
  expiresAt: number
  bytes: number
  key: string
  heapIndex: number
  previous: ByteLimitedCacheEntry<T> | null
  next: ByteLimitedCacheEntry<T> | null
}

export const createByteLimitedCache = <T>({
  now,
  maxEntries,
  maxBytes,
  touchOnRead = false
}: {
  now: () => number
  maxEntries: number
  maxBytes: number
  touchOnRead?: boolean
}) => {
  const entries = new Map<string, ByteLimitedCacheEntry<T>>()
  const expirations = new ExpiryHeap()
  let oldest: ByteLimitedCacheEntry<T> | null = null
  let newest: ByteLimitedCacheEntry<T> | null = null
  let totalBytes = 0

  const unlink = (entry: ByteLimitedCacheEntry<T>) => {
    if (entry.previous) entry.previous.next = entry.next
    else oldest = entry.next
    if (entry.next) entry.next.previous = entry.previous
    else newest = entry.previous
    entry.previous = null
    entry.next = null
  }

  const append = (entry: ByteLimitedCacheEntry<T>) => {
    entry.previous = newest
    if (newest) newest.next = entry
    else oldest = entry
    newest = entry
  }

  const deleteEntry = (key: string) => {
    const entry = entries.get(key)
    if (!entry) return
    totalBytes -= entry.bytes
    expirations.remove(entry)
    unlink(entry)
    entries.delete(key)
  }

  const pruneExpired = (nowMs: number) => {
    for (
      let entry = expirations.first();
      entry && entry.expiresAt <= nowMs;
      entry = expirations.first()
    ) {
      deleteEntry(entry.key)
    }
  }

  const pruneOverflow = () => {
    while (entries.size > maxEntries || totalBytes > maxBytes) {
      if (!oldest) return
      deleteEntry(oldest.key)
    }
  }

  const get = (key: string): T | null => {
    const entry = entries.get(key)
    if (!entry) return null
    if (entry.expiresAt <= now()) {
      deleteEntry(key)
      return null
    }
    if (touchOnRead) {
      unlink(entry)
      append(entry)
    }
    return entry.value
  }

  const insert = (key: string, value: T, bytes: number, expiresAt: number) => {
    const nowMs = now()
    pruneExpired(nowMs)
    deleteEntry(key)
    if (expiresAt <= nowMs || bytes > maxBytes) return false

    const entry: ByteLimitedCacheEntry<T> = {
      key,
      value,
      expiresAt,
      bytes,
      heapIndex: -1,
      previous: null,
      next: null
    }
    entries.set(key, entry)
    append(entry)
    expirations.insert(entry)
    totalBytes += bytes
    pruneOverflow()
    return entries.has(key)
  }

  return {
    get,
    insert,
    delete: deleteEntry,
    size: () => entries.size,
    clear() {
      entries.clear()
      expirations.clear()
      oldest = null
      newest = null
      totalBytes = 0
    }
  }
}
