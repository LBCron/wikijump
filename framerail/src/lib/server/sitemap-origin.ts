import { client } from "$lib/server/deepwell"
import { canonicalSitemapOrigin } from "$lib/server/sitemap"

export async function siteSitemapOrigin(siteId: number): Promise<string> {
  const preferredDomain: string = await client.request("site_domain", [siteId], {
    siteId
  })
  return canonicalSitemapOrigin(preferredDomain)
}
