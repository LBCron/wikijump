import { applyFenceInvalidationToSites } from "./fence-reducer.ts"
import { parsePermissionFence } from "./fence-values.ts"

export interface FenceSiteState {
  publicContentFence: string
  sitePermissionFence: string
  userPermissionFence: string
}

export interface FencePair {
  publicContentFence: string
  permissionFence: string
}

export const createArticleResponseFenceState = ({
  clearHotResponses
}: {
  clearHotResponses: () => void
}) => {
  const sites = new Map<number, FenceSiteState>()
  let trusted = false
  let fenceRevision = 0

  const poison = () => {
    fenceRevision += 1
    trusted = false
    sites.clear()
    clearHotResponses()
  }

  const readFences = (siteId: number): FencePair | null => {
    const site = sites.get(siteId)
    if (!site) return null
    return {
      publicContentFence: site.publicContentFence,
      permissionFence: `site=${site.sitePermissionFence},user=${site.userPermissionFence}`
    }
  }

  const seedSite = ({
    siteId,
    fences,
    seedRevision
  }: {
    siteId: number
    fences: FencePair | null
    seedRevision: number
  }): FenceSiteState | null => {
    const permission = parsePermissionFence(fences?.permissionFence)
    if (!fences || !permission) return null
    if (seedRevision !== fenceRevision) return sites.get(siteId) ?? null

    const site: FenceSiteState = {
      publicContentFence: fences.publicContentFence,
      sitePermissionFence: permission.sitePermissionFence,
      userPermissionFence: permission.userPermissionFence
    }
    sites.set(siteId, site)
    return site
  }

  return {
    isTrusted: () => trusted,
    revision: () => fenceRevision,
    markTrusted() {
      trusted = true
    },
    poison,
    seedSite,
    readFences,

    areFencesCurrent({
      siteId,
      publicContentFence,
      permissionFence
    }: {
      siteId: number
      publicContentFence: string
      permissionFence: string
    }) {
      if (!trusted) return null
      const current = readFences(siteId)
      if (!current) return null
      return (
        current.publicContentFence === publicContentFence &&
        current.permissionFence === permissionFence
      )
    },

    canValidateFencesLocally(siteId: number) {
      return trusted && sites.has(siteId)
    },

    applyMessage(
      message: Parameters<typeof applyFenceInvalidationToSites>[0]["message"]
    ) {
      if (message.type !== "user-permission") fenceRevision += 1
      applyFenceInvalidationToSites({ sites, message, clearHotResponses })
    }
  }
}
