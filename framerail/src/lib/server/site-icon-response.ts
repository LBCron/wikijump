import { getSiteIcon } from "$lib/server/deepwell/site-icon"
import { loadSiteInfo } from "$lib/server/load/site-info"
import { preloadView } from "$lib/server/deepwell/views"
import {
  getPreloadBackendLocales,
  getPreloadRequestLocales
} from "$lib/server/load/preload"
import { selectSiteIconResponse, type StoredSiteIcon } from "$lib/site-icon-response"
import type { SiteIconSourceKind } from "$lib/site-icon-source"
import type { Nullable, SiteModel } from "$lib/types"

export async function siteIconResponse(
  request: Request,
  select: (site: SiteModel) => Nullable<string>,
  kind: SiteIconSourceKind,
  filename: string
): Promise<Response> {
  const { siteId } = loadSiteInfo(request.headers)
  const locales = getPreloadBackendLocales(getPreloadRequestLocales(request))
  const preload = await preloadView(siteId, locales, undefined)
  const site = preload?.site ?? null

  let stored: Nullable<StoredSiteIcon> = null
  if (site !== null) {
    try {
      const icon = await getSiteIcon(siteId, kind)
      if (icon !== null) {
        stored = {
          mime: icon.mime,
          sha256Hex: icon.sha256_hex,
          data: new Uint8Array(icon.data)
        }
      }
    } catch {
      stored = null
    }
  }

  return selectSiteIconResponse(site, site ? select(site) : null, stored, kind, filename)
}
