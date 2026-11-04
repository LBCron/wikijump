import { createMemoryArticleResponseCacheStore } from "./index.ts"
import { createRedisCacheStore } from "../redis-store.ts"
import type { ArticleResponseCacheStore } from "./storage.ts"

export interface ArticleResponseTokenStore {
  get: (key: string) => Promise<unknown>
  mget?: (keys: string[]) => Promise<unknown[]>
  set: (key: string, value: string, ttlSeconds?: number) => Promise<unknown>
  subscribe?: (callbacks: {
    channel: string
    onSubscribed: () => void
    onMessage: (payload: string) => void
    onDisconnect: () => void
    onMalformed: () => void
  }) => { close?: () => void } | null | undefined
  reset?: () => void
}

export interface ArticleResponseCacheStores {
  responseStore: ArticleResponseCacheStore | null
  tokenStore: ArticleResponseTokenStore | null
}

export const createArticleResponseCacheStores = ({
  responseStore = createMemoryArticleResponseCacheStore(),
  tokenStore = createRedisCacheStore() as ArticleResponseTokenStore | null
}: {
  responseStore?: ArticleResponseCacheStore
  tokenStore?: ArticleResponseTokenStore | null
} = {}): ArticleResponseCacheStores => ({ responseStore, tokenStore })
