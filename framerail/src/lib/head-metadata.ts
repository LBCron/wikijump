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

/**
 * The site-field fallbacks for the text/social head contract.
 *
 * The sealed live contract always pairs the site description with the site
 * name, so both entries stay gated on a configured description; a site
 * without one keeps the existing empty head rather than gaining a
 * half-derived tag. Blank values are omitted, never emitted.
 */
export function siteHeadFallbacks(site: Nullable<HeadFallbackSite>): HeadMetaTag[] {
  if (!site || typeof site.description !== "string" || site.description.trim() === "") {
    return []
  }
  return [
    { name: "description", content: site.description },
    { name: "og:site_name", content: site.name }
  ]
}

/**
 * The fallbacks that still apply once stored rows are projected.
 *
 * Stored effective rows (page-over-site precedence is applied upstream)
 * win over a same-named fallback, so the final head never carries
 * duplicate or conflicting entries for one name. The page head renders the
 * effective rows themselves unchanged.
 */
export function unsupersededHeadFallbacks(
  fallbacks: readonly HeadMetaTag[],
  effective: readonly Pick<EffectiveHeadMetaTag, "name">[]
): HeadMetaTag[] {
  const superseded = new Set(effective.map((tag) => tag.name))
  return fallbacks.filter((tag) => !superseded.has(tag.name))
}

const HEAD_IMAGE_TAG_NAMES: ReadonlySet<string> = new Set(["og:image", "twitter:image"])

/**
 * Resolve imported image references to the local file origin.
 *
 * An `og:image`/`twitter:image` entry that names the imported site's own
 * `/local--files/` asset (via the source `wdfiles.com` host or a local
 * path) is advertised as an absolute URL on the serving origin rather than
 * the source host. Anything else is left literal, so a non-imported or
 * foreign image is never rewritten. Other entries pass through unchanged.
 */
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
