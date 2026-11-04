import {
  hasValidArticleResponseCacheIdentity,
  PUBLIC_CONTENT_FENCE_PREFIX
} from "./shared.ts"

export interface FenceStore {
  get: (key: string) => Promise<unknown>
  mget?: (keys: string[]) => Promise<unknown[]>
}

export interface ArticleResponseFencePair {
  publicContentFence: string
  permissionFence: string
}

export interface PermissionFenceVersions {
  sitePermissionFence: string
  userPermissionFence: string
}

export const normalizeFenceVersion = (value: unknown): string | null => {
  if (value === undefined || value === null) return "0"
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null
  return value
}

export const parsePermissionFence = (value: unknown): PermissionFenceVersions | null => {
  if (typeof value !== "string") return null
  const match = /^site=(\d+),user=(\d+)$/.exec(value)
  if (!match) return null

  return {
    sitePermissionFence: match[1],
    userPermissionFence: match[2]
  }
}

export const buildPublicContentFenceKey = (siteId: number) => {
  return `${PUBLIC_CONTENT_FENCE_PREFIX}:${siteId}:version`
}

export const buildAnonymousPermissionFenceKeys = (siteId: number) => {
  return {
    siteKey: `permission:site:${siteId}:version`,
    userKey: `permission:site:${siteId}:user:anonymous:version`
  }
}

export const buildAnonymousArticleResponseCacheFences = ({
  siteId,
  siteSlug,
  requestHost,
  route,
  requestLocales,
  backendLocales,
  publicContentFence,
  permissionFence
}: {
  siteId: number
  siteSlug: string
  requestHost: string
  route?: { slug?: string; extra?: string } | null
  requestLocales: string[]
  backendLocales: string[]
  publicContentFence: string
  permissionFence: string
}) => {
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
  if (!publicContentFence || !permissionFence) return null

  return {
    siteId,
    siteSlug,
    requestHost,
    route: route ?? null,
    requestLocales,
    backendLocales,
    publicContentFence,
    permissionFence
  }
}

export const readAnonymousArticleResponseCacheFences = async ({
  store,
  siteId
}: {
  store?: FenceStore | null
  siteId: number
}): Promise<ArticleResponseFencePair | null> => {
  if (!store || !Number.isInteger(siteId) || siteId <= 0) return null

  try {
    const publicContentFenceKey = buildPublicContentFenceKey(siteId)
    const { siteKey, userKey } = buildAnonymousPermissionFenceKeys(siteId)
    const values =
      typeof store.mget === "function"
        ? await store.mget([publicContentFenceKey, siteKey, userKey])
        : [
            await store.get(publicContentFenceKey),
            await store.get(siteKey),
            await store.get(userKey)
          ]
    const publicContentFence = normalizeFenceVersion(values[0])
    const sitePermissionFence = normalizeFenceVersion(values[1])
    const userPermissionFence = normalizeFenceVersion(values[2])

    if (
      publicContentFence === null ||
      sitePermissionFence === null ||
      userPermissionFence === null
    ) {
      return null
    }

    return {
      publicContentFence,
      permissionFence: `site=${sitePermissionFence},user=${userPermissionFence}`
    }
  } catch {
    return null
  }
}
