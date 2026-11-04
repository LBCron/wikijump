import { ARTICLE_RESPONSE_FENCE_INVALIDATION_CHANNEL } from "./shared.ts"
import { parseFenceInvalidationMessage } from "./fence-message.ts"
import { createArticleResponseFenceState } from "./fence-state.ts"
import { readAnonymousArticleResponseCacheFences } from "./fence-values.ts"

export interface FenceStore {
  get: (key: string) => Promise<unknown>
  mget?: (keys: string[]) => Promise<unknown[]>
}

export interface HotResponseCache {
  clear?: () => void
}

export interface FenceSubscription {
  close?: () => void
}

export interface FenceSubscriber {
  subscribe: (callbacks: {
    channel: string
    onSubscribed: () => void
    onMessage: (payload: string) => void
    onDisconnect: () => void
    onMalformed: () => void
  }) => FenceSubscription | null | undefined
}

export {
  buildAnonymousArticleResponseCacheFences,
  buildAnonymousPermissionFenceKeys,
  buildPublicContentFenceKey,
  readAnonymousArticleResponseCacheFences
} from "./fence-values.ts"

export const createMemoryArticleResponseFenceCache = ({
  store,
  subscriber
}: { store?: FenceStore | null; subscriber?: FenceSubscriber | null } = {}) => {
  const hotCaches = new Set<HotResponseCache>()
  const clearHotResponses = () => {
    for (const hotCache of hotCaches) hotCache.clear?.()
  }
  const state = createArticleResponseFenceState({ clearHotResponses })

  const seedSite = async (siteId: number) => {
    const seedRevision = state.revision()
    const fences = await readAnonymousArticleResponseCacheFences({ store, siteId })
    const seeded = state.seedSite({ siteId, fences, seedRevision })
    return seeded ? state.readFences(siteId) : null
  }

  const applyMessage = (payload: string) => {
    const message = parseFenceInvalidationMessage(payload)
    if (!message) {
      state.poison()
      return false
    }
    state.applyMessage(message)
    return true
  }

  let subscription: FenceSubscription | null = null
  const api = {
    attachHotCache(hotCache: HotResponseCache | null | undefined) {
      if (hotCache) hotCaches.add(hotCache)
    },

    async readFences({ siteId }: { siteId: number }) {
      if (!state.isTrusted()) {
        return readAnonymousArticleResponseCacheFences({ store, siteId })
      }
      return state.readFences(siteId) ?? (await seedSite(siteId))
    },

    areFencesCurrent(input: {
      siteId: number
      publicContentFence: string
      permissionFence: string
    }) {
      return state.areFencesCurrent(input)
    },

    canValidateFencesLocally({ siteId }: { siteId: number }) {
      return state.canValidateFencesLocally(siteId)
    },

    close() {
      subscription?.close?.()
    }
  }

  subscription =
    subscriber?.subscribe?.({
      channel: ARTICLE_RESPONSE_FENCE_INVALIDATION_CHANNEL,
      onSubscribed: () => state.markTrusted(),
      onMessage: applyMessage,
      onDisconnect: state.poison,
      onMalformed: state.poison
    }) ?? null

  return api
}
