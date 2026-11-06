import { isReservedAdminAliasSlug } from "../../reserved-admin-alias.ts"

export function pageErrorStatus(type: string, slug: string | null | undefined): number {
  if (type === "permissions" && isReservedAdminAliasSlug(slug)) {
    return 401
  }
  return type === "missing" ? 404 : 403
}
