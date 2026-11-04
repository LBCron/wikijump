import { loadPage } from "$lib/server/load/page/page"
import { isReservedAdminAliasSlug } from "$lib/server/reserved-admin-alias"
import { redirect } from "@sveltejs/kit"

export async function load({ params, request, cookies, locals }) {
  const segments = params.path.replace(/^\/+/, "").split("/")
  const slug = segments.shift()
  const extra = segments.join("/")

  if (isReservedAdminAliasSlug(slug)) {
    redirect(303, "/_admin")
  }

  return loadPage(slug, extra, request, cookies, locals)
}
