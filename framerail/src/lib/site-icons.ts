import type { Nullable, SiteModel } from "$lib/types"
import { siteIconRedirectLocation } from "./site-icon-source.ts"

export const FAVICON_ROUTE_PREFIX = "/local--favicon/"

export const SITE_ICON_CACHE_CONTROL = "no-store"

export const IOS_ICON_ROUTE_PREFIX = "/local--iosicon/"

export const WINDOWS_TILE_ROUTE_PREFIX = "/local--wp8icon/"

export const WINDOWS_TILE_FILENAME = "wp8icon.png"

export const IOS_ICON_DECLARATIONS: { filename: string; sizes: Nullable<string> }[] = [
  { filename: "iosicon_57.png", sizes: null },
  { filename: "iosicon_72.png", sizes: "72x72" },
  { filename: "iosicon.png", sizes: "114x114" }
]

const FAVICON_MIME_TYPES: Record<string, string> = {
  gif: "image/gif",
  ico: "image/x-icon",
  png: "image/png"
}

export interface FaviconDeclaration {
  href: string
  type: string
}

export function iconSiteForHead(
  site: Nullable<SiteModel>,
  isImportedView: boolean
): Nullable<SiteModel> {
  if (!site) return null
  if (site.from_wikidot || !isImportedView) return site
  return { ...site, from_wikidot: true }
}

function extensionOf(source: string): Nullable<string> {
  const withoutQuery = source.split(/[?#]/, 1)[0]
  const lastDot = withoutQuery.lastIndexOf(".")
  if (lastDot < 0 || lastDot === withoutQuery.length - 1) return null
  return withoutQuery.slice(lastDot + 1).toLowerCase()
}

export function faviconDeclaration(
  site: Nullable<SiteModel>
): Nullable<FaviconDeclaration> {
  if (!site) return null
  const source = siteIconRedirectLocation(site, site.favicon_source, "favicon")
  if (source === null) return null

  const extension = extensionOf(source)
  if (!extension) return null

  if (!FAVICON_MIME_TYPES[extension]) return null

  return { href: `${FAVICON_ROUTE_PREFIX}favicon.gif`, type: "image/gif" }
}

export function hasIosIcons(site: Nullable<SiteModel>): boolean {
  return (
    site !== null && siteIconRedirectLocation(site, site.ios_icon_source, "ios") !== null
  )
}

export interface WindowsTileDeclaration {
  href: string
}

export function windowsTileDeclaration(
  site: Nullable<SiteModel>
): Nullable<WindowsTileDeclaration> {
  if (!site) return null
  if (siteIconRedirectLocation(site, site.windows_tile_source, "windows") === null) {
    return null
  }
  return { href: `${WINDOWS_TILE_ROUTE_PREFIX}${WINDOWS_TILE_FILENAME}` }
}
