import { wikidotSitemap } from "$lib/server/deepwell/page"
import { loadSiteInfo } from "$lib/server/load/site-info"
import { siteSitemapOrigin } from "$lib/server/sitemap-origin"
import { buildSitemapIndexXml, SITEMAP_XML_HEADERS } from "$lib/server/sitemap"

import type { RequestHandler } from "./$types"

export const GET: RequestHandler = async ({ request }) => {
  const { siteId } = loadSiteInfo(request.headers)
  const output = await wikidotSitemap(siteId, 0, { siteId })
  if (!output) return new Response("Not found", { status: 404 })

  if (output.shard_count === null)
    return new Response("Invalid sitemap index", { status: 502 })
  const origin = await siteSitemapOrigin(siteId)
  return new Response(buildSitemapIndexXml(origin, output.shard_count), {
    headers: SITEMAP_XML_HEADERS
  })
}
