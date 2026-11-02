import { Buffer } from "node:buffer"

import {
  IOS_ICON_DECLARATIONS,
  SITE_ICON_CACHE_CONTROL,
  WINDOWS_TILE_FILENAME
} from "./site-icons.ts"
import {
  isSiteLocalFileSource,
  siteIconRedirectLocation,
  siteOwnedLocalFilePath,
  type SiteIconSourceKind
} from "./site-icon-source.ts"

import type { Nullable, SiteModel } from "$lib/types"

export interface StoredSiteIcon {
  mime: string
  sha256Hex: string
  data: Uint8Array
}

type IconRouteSite = Pick<SiteModel, "from_wikidot" | "slug">

const NOT_CONFIGURED_HEADERS = {
  "cache-control": SITE_ICON_CACHE_CONTROL,
  "content-type": "text/plain; charset=utf-8"
}

const CANONICAL_FILENAMES: Record<SiteIconSourceKind, readonly string[]> = {
  favicon: ["favicon.gif"],
  ios: IOS_ICON_DECLARATIONS.map((declaration) => declaration.filename),
  windows: [WINDOWS_TILE_FILENAME]
}

function notConfigured(): Response {
  return new Response("This site has no icon configured.\n", {
    status: 404,
    headers: NOT_CONFIGURED_HEADERS
  })
}

export function storedSiteIconResponse(stored: StoredSiteIcon): Response {
  return new Response(Buffer.from(stored.data), {
    status: 200,
    headers: {
      "cache-control": SITE_ICON_CACHE_CONTROL,
      "content-type": `${stored.mime}; charset=utf-8`,
      etag: `"${stored.sha256Hex}"`
    }
  })
}

export function selectSiteIconResponse(
  site: Nullable<IconRouteSite>,
  configuredSource: Nullable<string>,
  stored: Nullable<StoredSiteIcon>,
  kind: SiteIconSourceKind,
  filename: string
): Response {
  if (!CANONICAL_FILENAMES[kind].includes(filename)) return notConfigured()
  if (stored !== null) return storedSiteIconResponse(stored)

  const location =
    site !== null ? siteIconRedirectLocation(site, configuredSource, kind) : null
  if (location !== null && isSiteLocalFileSource(location)) {
    return new Response(null, {
      status: 302,
      headers: { "cache-control": SITE_ICON_CACHE_CONTROL, location }
    })
  }

  const ownedLocalPath =
    site !== null ? siteOwnedLocalFilePath(site, configuredSource) : null
  if (ownedLocalPath !== null) {
    return new Response(null, {
      status: 302,
      headers: { "cache-control": SITE_ICON_CACHE_CONTROL, location: ownedLocalPath }
    })
  }

  return notConfigured()
}
