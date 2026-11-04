import type { Nullable, SiteModel } from "$lib/types"
import { siteOwnedLocalFilePath } from "./site-icon-source.ts"

export interface HeadMetaTag {
  name: string
  content: string
}

export interface EffectiveHeadMetaTag extends HeadMetaTag {
  all_pages: boolean
}

type HeadFallbackSite = Pick<SiteModel, "description" | "name">

export function siteHeadFallbacks(site: Nullable<HeadFallbackSite>): HeadMetaTag[] {
  if (!site || typeof site.description !== "string" || site.description.trim() === "") {
    return []
  }
  return [
    { name: "description", content: site.description },
    { name: "og:site_name", content: site.name }
  ]
}

export function unsupersededHeadFallbacks(
  fallbacks: readonly HeadMetaTag[],
  effective: readonly Pick<EffectiveHeadMetaTag, "name">[]
): HeadMetaTag[] {
  const superseded = new Set(effective.map((tag) => tag.name))
  return fallbacks.filter((tag) => !superseded.has(tag.name))
}

const HEAD_IMAGE_TAG_NAMES: ReadonlySet<string> = new Set(["og:image", "twitter:image"])

export function resolveHeadImageUrls<T extends HeadMetaTag>(
  tags: readonly T[],
  site: Nullable<Pick<SiteModel, "from_wikidot" | "slug">>,
  origin: string
): T[] {
  if (!site) return [...tags]
  return tags.map((tag) => {
    if (!HEAD_IMAGE_TAG_NAMES.has(tag.name)) return tag
    const local =
      siteOwnedLocalFilePath(site, tag.content) ??
      (tag.content.startsWith("/local--files/")
        ? siteOwnedLocalFilePath(site, `https://${site.slug}.wdfiles.com${tag.content}`)
        : null)
    return local ? { ...tag, content: `${origin}${local}` } : tag
  })
}
