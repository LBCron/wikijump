export interface FenceSiteState {
  publicContentFence: string
  sitePermissionFence: string
  userPermissionFence: string
}

export interface PublicContentFenceMessage {
  type: "public-content"
  siteId: number
  version: string
}

export interface AnonymousPermissionFenceMessage {
  type: "anonymous-permission"
  siteId: number
  siteVersion: string
  userVersion: string
}

export interface UserPermissionFenceMessage {
  type: "user-permission"
}

export type FenceInvalidationMessage =
  PublicContentFenceMessage | AnonymousPermissionFenceMessage | UserPermissionFenceMessage

const applyPublicContentMessage = (
  sites: Map<number, FenceSiteState>,
  message: PublicContentFenceMessage,
  clearHotResponses: () => void
) => {
  const site = sites.get(message.siteId)
  if (!site) {
    clearHotResponses()
    return
  }
  if (BigInt(message.version) <= BigInt(site.publicContentFence)) return
  site.publicContentFence = message.version
  clearHotResponses()
}

const applyAnonymousPermissionMessage = (
  sites: Map<number, FenceSiteState>,
  message: AnonymousPermissionFenceMessage,
  clearHotResponses: () => void
) => {
  const site = sites.get(message.siteId)
  if (!site) {
    clearHotResponses()
    return
  }
  const siteAdvanced = BigInt(message.siteVersion) > BigInt(site.sitePermissionFence)
  const userAdvanced = BigInt(message.userVersion) > BigInt(site.userPermissionFence)
  if (!siteAdvanced && !userAdvanced) return
  site.sitePermissionFence = message.siteVersion
  site.userPermissionFence = message.userVersion
  clearHotResponses()
}

export const applyFenceInvalidationToSites = ({
  sites,
  message,
  clearHotResponses
}: {
  sites: Map<number, FenceSiteState>
  message: FenceInvalidationMessage
  clearHotResponses: () => void
}) => {
  if (message.type === "public-content") {
    applyPublicContentMessage(sites, message, clearHotResponses)
  } else if (message.type === "anonymous-permission") {
    applyAnonymousPermissionMessage(sites, message, clearHotResponses)
  }
}
