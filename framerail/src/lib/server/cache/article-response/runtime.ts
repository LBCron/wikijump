import { createArticleResponseCacheStores } from "./stores.ts"
import type { ArticleResponseCacheStores } from "./stores.ts"

type GlobalArticleResponseCacheStores = typeof globalThis &
  Record<symbol, ArticleResponseCacheStores | undefined>

const RUNTIME_STORES_SYMBOL = Symbol.for(
  "wikijump.framerail.article-response-cache-runtime"
)
const DEVELOPMENT_STORES_SYMBOL = Symbol.for(
  "wikijump.framerail.article-response-cache-development"
)
const EMPTY_STORES: ArticleResponseCacheStores = Object.freeze({
  responseStore: null,
  tokenStore: null
}) as ArticleResponseCacheStores

export const configureArticleResponseCacheStores = (
  stores: ArticleResponseCacheStores
) => {
  ;(globalThis as GlobalArticleResponseCacheStores)[RUNTIME_STORES_SYMBOL] = stores

  return () => {
    if (
      (globalThis as GlobalArticleResponseCacheStores)[RUNTIME_STORES_SYMBOL] === stores
    ) {
      delete (globalThis as GlobalArticleResponseCacheStores)[RUNTIME_STORES_SYMBOL]
    }
  }
}

const getDevelopmentArticleResponseCacheStores = (): ArticleResponseCacheStores => {
  if (process.env.NODE_ENV !== "development") return EMPTY_STORES
  if (!(globalThis as GlobalArticleResponseCacheStores)[DEVELOPMENT_STORES_SYMBOL]) {
    ;(globalThis as GlobalArticleResponseCacheStores)[DEVELOPMENT_STORES_SYMBOL] =
      createArticleResponseCacheStores()
  }
  return (globalThis as GlobalArticleResponseCacheStores)[
    DEVELOPMENT_STORES_SYMBOL
  ] as ArticleResponseCacheStores
}

export const getArticleResponseCacheStores = (): ArticleResponseCacheStores =>
  (globalThis as GlobalArticleResponseCacheStores)[RUNTIME_STORES_SYMBOL] ??
  getDevelopmentArticleResponseCacheStores()

export const resetDevelopmentArticleResponseCacheStores = () => {
  const stores = (globalThis as GlobalArticleResponseCacheStores)[
    DEVELOPMENT_STORES_SYMBOL
  ]
  stores?.tokenStore?.reset?.()
  delete (globalThis as GlobalArticleResponseCacheStores)[DEVELOPMENT_STORES_SYMBOL]
}
