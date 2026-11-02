export const isReservedAdminAliasSlug = (slug) => {
  if (typeof slug !== "string") return false

  return slug.replace(/^\/+|\/+$/gu, "").toLowerCase() === "_admin"
}
