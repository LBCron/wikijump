import { normalizeFenceVersion } from "./fence-values.ts"

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

const messageSiteId = (value: unknown): number | null => {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : null
}

export const parseFenceInvalidationMessage = (
  payload: unknown
): FenceInvalidationMessage | null => {
  if (typeof payload !== "string") return null

  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const message = parsed as Record<string, unknown>
  const siteId = messageSiteId(message.site_id)

  if (message.type === "public-content") {
    const version = normalizeFenceVersion(message.version)
    return siteId && version !== null ? { type: "public-content", siteId, version } : null
  }

  if (message.type === "anonymous-permission") {
    const siteVersion = normalizeFenceVersion(message.site_version)
    const userVersion = normalizeFenceVersion(message.user_version)
    return siteId && siteVersion !== null && userVersion !== null
      ? { type: "anonymous-permission", siteId, siteVersion, userVersion }
      : null
  }

  if (message.type === "user-permission") {
    const version = normalizeFenceVersion(message.version)
    return siteId &&
      Number.isInteger(message.user_id) &&
      Number(message.user_id) > 0 &&
      version
      ? { type: "user-permission" }
      : null
  }

  return null
}
