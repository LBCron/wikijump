import { wikidotSitemap } from "$lib/server/deepwell/page"
import { loadSiteInfo } from "$lib/server/load/site-info"
import { siteSitemapOrigin } from "$lib/server/sitemap-origin"
import {
  buildSitemapUrlsetXml,
  InvalidSitemapShardPath,
  parseSitemapShardNumber,
  SITEMAP_ENTRIES_PER_SHARD,
  SITEMAP_XML_HEADERS
} from "$lib/server/sitemap"

import type { RequestHandler } from "./$types"

export const GET: RequestHandler = async ({ request, params }) => {
  let shard: number
  try {
    shard = parseSitemapShardNumber(params.n)
  } catch (error) {
    if (error instanceof InvalidSitemapShardPath) {
      return new Response("Not found", { status: 404 })
    }
    throw error
  }

  const { siteId } = loadSiteInfo(request.headers)
  const output = await wikidotSitemap(siteId, shard, { siteId })
  if (!output) return new Response("Not found", { status: 404 })

  if (output.entries.length === 0) return new Response("Not found", { status: 404 })
  if (output.entries.length > SITEMAP_ENTRIES_PER_SHARD) {
    return new Response("Invalid sitemap shard size", { status: 502 })
  }

  const origin = await siteSitemapOrigin(siteId)
  return new Response(buildSitemapUrlsetXml(origin, output.entries), {
    headers: SITEMAP_XML_HEADERS
  })
}
