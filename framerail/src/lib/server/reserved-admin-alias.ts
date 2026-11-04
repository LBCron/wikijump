export const isReservedAdminAliasSlug = (slug: unknown): boolean => {
  if (typeof slug !== "string") return false

  return slug.replace(/^\/+|\/+$/gu, "").toLowerCase() === "_admin"
}
