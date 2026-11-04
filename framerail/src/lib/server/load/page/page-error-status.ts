export function pageErrorStatus(type: string, slug: string | null | undefined): number {
  if (
    type === "permissions" &&
    slug?.replace(/^\/+|\/+$/gu, "").toLowerCase() === "_admin"
  ) {
    return 401
  }
  return type === "missing" ? 404 : 403
}
