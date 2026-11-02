import { loadPage } from "$lib/server/load/page/page"
import { isReservedAdminAliasSlug } from "$lib/server/reserved-admin-alias.js"
import { redirect } from "@sveltejs/kit"

export async function load({ params, request, cookies, locals }) {
  // This route is commonly requested with a second slash before the page
  // slug, for example `/printer--friendly//_admin`. Treat only leading
  // separators as route syntax so the resolved article slug matches the
  // canonical page route and its server-side authorization decision.
  const segments = params.path.replace(/^\/+/, "").split("/")
  const slug = segments.shift()
  const extra = segments.join("/")

  if (isReservedAdminAliasSlug(slug)) {
    redirect(303, "/_admin")
  }

  return loadPage(slug, extra, request, cookies, locals)
}
