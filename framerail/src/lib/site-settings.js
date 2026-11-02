const GOOGLE_ANALYTICS_PROFILE = /^UA-[0-9]+-[0-9]+$(?![\s\S])/u

export const isGoogleAnalyticsProfile = (value) =>
  typeof value === "string" && GOOGLE_ANALYTICS_PROFILE.test(value)

/** @typedef {import("./types").ThemeSetting} ThemeSetting */

export const normalizeGoogleAnalyticsSettings = (settings) => ({
  enabled: settings?.enabled === true,
  profile: isGoogleAnalyticsProfile(settings?.profile) ? settings.profile : null
})

export const googleAnalyticsQueueScript = (settings) => {
  const normalized = normalizeGoogleAnalyticsSettings(settings)
  if (!normalized.enabled || normalized.profile === null) return ""

  return [
    `_gaq.push(['userTracker._setAccount', '${normalized.profile}']);`,
    "_gaq.push(['userTracker._trackPageview']);"
  ].join("\n")
}

export const googleAnalyticsHeadHtml = (settings) => {
  const queue = googleAnalyticsQueueScript(settings)
  if (!queue) return ""
  return `<script>globalThis._gaq=globalThis._gaq||[];\n${queue}</script>`
}

/** @type {ThemeSetting} */
const BUILT_IN_THEME = { type: "built_in", id: 1 }
const WIKIDOT_THEME_ASSET_ORIGIN =
  "http://d3g0gp89917ko0.cloudfront.net/v--7690939296dc/common--theme"

/**
 * Ordered common--theme directories served for each persisted built-in
 * theme id, captured from the authenticated live appearance render. The
 * directory list is the authoritative asset set and ordering for the id.
 * Ids 8248876+ are site custom themes (bootstrap-base plus local--theme)
 * and are not built-in themes.
 *
 * @type {Readonly<Record<number, readonly string[]>>}
 */
export const BUILT_IN_THEME_ASSET_DIRS = Object.freeze({
  1: ["base"],
  162746: ["bootstrap-base"],
  6651: ["base", "basic"],
  6258: ["base", "bloo"],
  6650: ["base", "bloo", "bloo-no-side-bar"],
  25: ["base", "cappuccino"],
  26: ["base", "cappuccino", "cappuccino-right"],
  2: ["base", "clean"],
  3: ["base", "clean", "clean-no-side-bar"],
  56: ["base", "co"],
  121: ["base", "co", "co-no-side-bar"],
  5: ["base", "flannel"],
  9: ["base", "flannel-nature"],
  10: ["base", "flannel-nature", "flannel-nature-no-side-bar"],
  6: ["base", "flannel", "flannel-no-side-bar"],
  7: ["base", "flannel-ocean"],
  8: ["base", "flannel-ocean", "flannel-ocean-no-side-bar"],
  57: ["base", "flower-blossom"],
  75: ["base", "flower-blossom", "flower-blossom-no-side-bar"],
  54: ["base", "gila"],
  55: ["base", "gila", "gila-no-side-bar"],
  58: ["base", "localize"],
  59: ["base", "localize", "localize-no-side-bar"],
  2439: ["base", "shiny"],
  2440: ["base", "shiny", "shiny-no-side-bar"],
  2437: ["base", "webbish2"],
  2438: ["base", "webbish2", "webbish2-no-side-bar"],
  122: ["base", "webbish"],
  123: ["base", "webbish", "webbish-no-side-bar"]
})
const EXTERNAL_THEME_HOSTS = new Set([
  "cdn.scpwiki.com",
  "d3g0gp89917ko0.cloudfront.net",
  "fonts.bunny.net",
  "fonts.googleapis.com",
  "maxcdn.bootstrapcdn.com",
  "nu-scptheme.github.io",
  "rsms.me",
  "scp-jp.github.io",
  "scp-wiki-cdn.nyc3.cdn.digitaloceanspaces.com"
])

/**
 * Split a files authority (`host` or `host:port` — the form Deepwell's
 * DomainService::get_files_authority returns and the page view carries as
 * site_file_domain) into its hostname and port. Anything that is not
 * exactly that shape is not an authority and yields null, so the own-host
 * admission below fails closed.
 *
 * @param {unknown} filesAuthority
 * @returns {{ hostname: string; port: string } | null}
 */
const parseFilesAuthority = (filesAuthority) => {
  if (typeof filesAuthority !== "string") return null
  const authority = filesAuthority.trim().toLowerCase()
  if (
    authority === "" ||
    authority.includes("/") ||
    authority.includes("://") ||
    authority.includes("@")
  ) {
    return null
  }
  const colon = authority.lastIndexOf(":")
  if (colon === -1) return { hostname: authority, port: "" }
  const hostname = authority.slice(0, colon)
  const port = authority.slice(colon + 1)
  if (hostname === "" || !/^[0-9]+$/u.test(port)) return null
  return { hostname, port }
}

/**
 * Whether an external theme URL is served from the viewed site's OWN files
 * host. A site may run a base theme it serves itself — the SCP-JP Sigma-10
 * migration shape, where the ported theme's code pages are published on
 * the site's own files host. The URL may name the host with or without the
 * serving port; any other port stays rejected, as does any other host.
 *
 * @param {URL} url
 * @param {unknown} ownFilesAuthority
 * @returns {boolean}
 */
const isOwnFilesThemeUrl = (url, ownFilesAuthority) => {
  const authority = parseFilesAuthority(ownFilesAuthority)
  if (authority === null) return false
  if (url.hostname !== authority.hostname) return false
  return url.port === "" || url.port === authority.port
}

const isAllowedExternalThemeUrl = (url, ownFilesAuthority = null) =>
  url.protocol === "https:" &&
  !url.username &&
  !url.password &&
  ((url.port === "" &&
    (EXTERNAL_THEME_HOSTS.has(url.hostname) || url.hostname.endsWith(".wdfiles.com"))) ||
    isOwnFilesThemeUrl(url, ownFilesAuthority))

/**
 * @param {{ type?: unknown; id?: unknown; url?: unknown; css?: unknown }
 *   | null
 *   | undefined} theme
 * @param {unknown} [ownFilesAuthority] The viewed site's own files
 *   authority (host or host:port); an external theme URL served from that
 *   host is admitted alongside the global allowlist. Callers without a
 *   viewed site (the ThemePreviewer) omit it and keep the global policy.
 * @returns {ThemeSetting}
 */
export const normalizeThemeSetting = (theme, ownFilesAuthority = null) => {
  if (
    theme?.type === "built_in" &&
    typeof theme.id === "number" &&
    Number.isSafeInteger(theme.id) &&
    theme.id > 0
  ) {
    return { type: "built_in", id: theme.id }
  }
  if (theme?.type === "external" && typeof theme.url === "string") {
    try {
      const url = new URL(theme.url)
      if (isAllowedExternalThemeUrl(url, ownFilesAuthority)) {
        return { type: "external", url: url.href }
      }
    } catch {
      return { ...BUILT_IN_THEME }
    }
  }
  if (
    theme?.type === "custom" &&
    typeof theme.css === "string" &&
    theme.css.length <= 65_535 &&
    !theme.css.toLowerCase().includes("</style")
  ) {
    return { type: "custom", css: theme.css }
  }
  return { ...BUILT_IN_THEME }
}

/**
 * Normalize a browser-requested ThemePreviewer stylesheet with the global
 * stored-theme policy (no viewed site, so no own-files-host admission).
 * Invalid values fail closed so the browser keeps the stored site theme
 * and no server-side stylesheet fetch is needed.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export const normalizeThemePreviewUrl = (value) => {
  const normalized = normalizeThemeSetting({ type: "external", url: value })
  return normalized.type === "external" ? normalized.url : null
}

/**
 * Resolve a browser-requested ThemePreviewer stylesheet only when
 * Deepwell's source-owned PageView sidecar recognizes an executable noUi
 * invocation. This boundary deliberately does not inspect wikitext or
 * compiled HTML.
 *
 * @param {unknown} themePreviewerNoUi
 * @param {unknown} value
 * @returns {string | null}
 */
export const resolveThemePreviewUrl = (themePreviewerNoUi, value) =>
  themePreviewerNoUi === true ? normalizeThemePreviewUrl(value) : null

export const customThemeHeadHtml = (
  theme,
  site = null,
  filesAuthority = null,
  isLocalFile = null
) => {
  const normalized = normalizeThemeSetting(theme, filesAuthority)
  if (normalized.type !== "custom") return ""
  const css = localizeSiteFileUrlsInCss(normalized.css, site, filesAuthority, isLocalFile)
  return `<style data-wikidot-site-theme>${css}</style>`
}

/**
 * Site carried by the page view, the first half of the local-existence
 * evidence the head may use: an imported site's own files live on its own
 * WDFiles host. The second half is a per-file presence check
 * (isLocalFile): site identity alone cannot tell a materialized attachment
 * from one the import never fetched, so a same-site URL without a positive
 * presence answer stays literal.
 *
 * @typedef {object} LocalSiteEvidence
 * @property {unknown} slug
 * @property {unknown} from_wikidot
 */

export const SITE_FILE_PRESENCE_SEPARATOR = "\0"

/**
 * Join a referenced page and file name into its presence-set key.
 *
 * @param {unknown} page
 * @param {unknown} name
 * @returns {string | null}
 */
export const siteFilePresenceKey = (page, name) => {
  if (
    typeof page !== "string" ||
    page === "" ||
    typeof name !== "string" ||
    name === ""
  ) {
    return null
  }
  return `${page}${SITE_FILE_PRESENCE_SEPARATOR}${name}`
}

const WDFILES_HOST_SUFFIXES = [".wdfiles.com", ".wikidot.com"]
const SITE_SLUG_PATTERN = /^[a-z0-9-]+$/u
const WIKIDOT_WWW_HOSTS = new Set(["www.wikidot.com", "www.wdfiles.com"])

/**
 * Split an absolute http(s) URL into its lowercased host and the untouched
 * remainder (path, query, fragment), preserving the original encoding
 * byte-for-byte. Protocol-relative URLs are read as https. Returns null
 * for anything that is not a plain same-shape candidate.
 *
 * @param {unknown} rawUrl
 * @returns {{ host: string; rest: string } | null}
 */
const splitAbsoluteHttpUrl = (rawUrl) => {
  if (typeof rawUrl !== "string") return null
  const trimmed = rawUrl.trim()
  if (trimmed === "") return null
  const withoutProtocol = trimmed.startsWith("//")
    ? trimmed.slice(2)
    : trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u, "")
  if (withoutProtocol === trimmed && !trimmed.includes("://")) return null
  const scheme = trimmed.startsWith("//")
    ? "https:"
    : `${trimmed.slice(0, trimmed.indexOf("://")).toLowerCase()}:`
  if (scheme !== "http:" && scheme !== "https:") return null
  const authority = withoutProtocol.split("/", 1)[0]
  if (authority === "" || authority.includes("@") || authority.includes(":")) {
    return null
  }
  const host = authority.toLowerCase()
  const rest = withoutProtocol.slice(authority.length)
  if (!rest.startsWith("/")) return null
  return { host, rest }
}

/**
 * The viewed site's own WDFiles slug, or null when the host does not name
 * a site file host. Mirrors the renderer's host-to-slug reading without
 * duplicating its cross-site and lab-mirror branches, which need
 * server-side import topology the page does not carry.
 *
 * @param {string} host
 * @returns {string | null}
 */
const wdfilesAttachmentSiteSlug = (host) => {
  for (const suffix of WDFILES_HOST_SUFFIXES) {
    if (!host.endsWith(suffix)) continue
    const slug = host.slice(0, -suffix.length)
    if (slug !== "" && SITE_SLUG_PATTERN.test(slug)) return slug
  }
  return null
}

/**
 * Whether the viewed imported site is the evidence that a WDFiles
 * attachment URL names a local file: same-site slugs only (G06 www hosts
 * never match). Corpus aliases, translated-branch sharing, and lab mirrors
 * need server-side import topology and stay literal until Deepwell attests
 * them per asset.
 *
 * @param {string} slug
 * @param {LocalSiteEvidence | null | undefined} site
 * @returns {boolean}
 */
const isViewedSiteWdfilesSlug = (slug, site) => {
  if (typeof slug !== "string" || slug === "") return false
  if (site?.from_wikidot !== true) return false
  if (typeof site.slug !== "string" || !SITE_SLUG_PATTERN.test(site.slug)) {
    return false
  }
  return site.slug.toLowerCase() === slug
}

/**
 * Split a same-site WDFiles attachment URL into the referenced page and
 * file name, or null when the URL does not name exactly one page file.
 *
 * The shape, host, and site checks mirror the rewrite rule below, so the
 * server can collect the same candidate references the head would rewrite
 * without duplicating the policy. A path that does not split into exactly
 * a page and a file is unresolvable and stays literal downstream.
 *
 * @param {unknown} rawUrl
 * @param {LocalSiteEvidence | null | undefined} site
 * @returns {{ page: string; name: string; rest: string } | null}
 */
export const parseSiteFileReference = (rawUrl, site) => {
  const split = splitAbsoluteHttpUrl(rawUrl)
  if (!split || WIKIDOT_WWW_HOSTS.has(split.host)) return null
  if (!split.rest.startsWith("/local--files/")) return null
  const slug = wdfilesAttachmentSiteSlug(split.host)
  if (!isViewedSiteWdfilesSlug(slug ?? "", site)) return null
  const barePath = split.rest.split(/[?#]/, 1)[0]
  const segments = barePath.slice("/local--files/".length).split("/")
  if (segments.length !== 2 || segments[0] === "" || segments[1] === "") return null
  return { page: segments[0], name: segments[1], rest: split.rest }
}

/**
 * Rewrite one WDFiles attachment URL to the local files authority only
 * when the site names the file AND the per-file presence check confirms it
 * exists locally, else null (the caller keeps the source URL literal). A
 * missing, non-function, or non-true presence answer — absent, unknown, or
 * unresolvable — fails closed to literal, so a partially imported mirror
 * never turns a working hotlink into a local 404. Query, fragment, and
 * encoding are preserved; only the origin is swapped.
 *
 * @param {unknown} rawUrl
 * @param {LocalSiteEvidence | null | undefined} site
 * @param {unknown} filesAuthority
 * @param {(page: string, name: string) => unknown} [isLocalFile]
 * @returns {string | null}
 */
export const localizeSiteFileUrl = (rawUrl, site, filesAuthority, isLocalFile) => {
  if (
    typeof filesAuthority !== "string" ||
    filesAuthority.trim() === "" ||
    filesAuthority.includes("/") ||
    filesAuthority.includes("://")
  ) {
    return null
  }
  const reference = parseSiteFileReference(rawUrl, site)
  if (!reference) return null
  let present
  try {
    present =
      typeof isLocalFile === "function" &&
      isLocalFile(reference.page, reference.name) === true
  } catch {
    present = false
  }
  if (!present) return null
  return `https://${filesAuthority.trim()}${reference.rest}`
}

const CSS_URL_PATTERN = /url\(\s*(['"]?)([^'")]+?)\1\s*\)/giu
const CSS_BARE_IMPORT_PATTERN = /@import\s+(?!url\()\s*(['"])([^'"]+?)\1/giu

/**
 * Collect the distinct raw asset URLs inside stored custom CSS (`url(...)`
 * and bare `@import "..."`), in first-seen order. The server resolves
 * per-file presence for these candidates; the rewrite below consumes the
 * answers.
 *
 * @param {unknown} css
 * @returns {string[]}
 */
export const extractCssAssetUrls = (css) => {
  if (typeof css !== "string") return []
  const urls = new Set()
  for (const pattern of [CSS_URL_PATTERN, CSS_BARE_IMPORT_PATTERN]) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(css)) !== null) {
      if (typeof match[2] === "string" && match[2] !== "") urls.add(match[2])
    }
  }
  return [...urls]
}

/**
 * Rewrite same-site WDFiles attachment URLs inside stored CSS (`url(...)`
 * and bare `@import "..."`), keeping every other byte literal. Only URLs
 * whose referenced file the presence check confirms are rewritten; every
 * absent, unknown, or unresolvable URL stays byte-identical.
 *
 * @param {unknown} css
 * @param {LocalSiteEvidence | null | undefined} site
 * @param {unknown} filesAuthority
 * @param {(page: string, name: string) => unknown} [isLocalFile]
 * @returns {string}
 */
export const localizeSiteFileUrlsInCss = (css, site, filesAuthority, isLocalFile) => {
  if (typeof css !== "string") return typeof css === "undefined" ? "" : css
  const rewriteMatch = (match, url) => {
    const rewritten = localizeSiteFileUrl(url, site, filesAuthority, isLocalFile)
    if (!rewritten || rewritten === url) return match
    const index = match.indexOf(url)
    return index < 0
      ? match
      : match.slice(0, index) + rewritten + match.slice(index + url.length)
  }
  return css
    .replace(CSS_URL_PATTERN, (match, _quote, url) => rewriteMatch(match, url))
    .replace(CSS_BARE_IMPORT_PATTERN, (match, _quote, url) => rewriteMatch(match, url))
}

/**
 * Resolve the head `<link>` href for an external theme: the normalized
 * source URL, rewritten to the local files authority only when the viewed
 * site names the file AND the presence check confirms it exists locally.
 * Absent or unknown files keep the source URL literal.
 *
 * @param {{ type?: unknown; id?: unknown; url?: unknown; css?: unknown }
 *   | null
 *   | undefined} theme
 * @param {LocalSiteEvidence | null | undefined} site
 * @param {unknown} filesAuthority
 * @param {(page: string, name: string) => unknown} [isLocalFile]
 * @returns {string | null}
 */
export const resolveExternalThemeHref = (theme, site, filesAuthority, isLocalFile) => {
  const normalized = normalizeThemeSetting(theme, filesAuthority)
  if (normalized.type !== "external") return null
  return (
    localizeSiteFileUrl(normalized.url, site, filesAuthority, isLocalFile) ??
    normalized.url
  )
}

/**
 * @param {{ type?: unknown; id?: unknown; url?: unknown; css?: unknown }
 *   | null
 *   | undefined} theme
 * @returns {readonly string[]}
 */
export const builtInThemeAssetDirs = (theme) => {
  const normalized = normalizeThemeSetting(theme)
  if (normalized.type !== "built_in") return []
  return (
    BUILT_IN_THEME_ASSET_DIRS[normalized.id] ??
    BUILT_IN_THEME_ASSET_DIRS[BUILT_IN_THEME.id]
  )
}

/**
 * Resolve the exact evidenced immutable stylesheet URLs for a built-in
 * theme id, in served order. Non-built-in themes resolve to no URLs; an
 * unmapped id resolves to Base. Missing-resource fallback was not observed
 * on live Wikidot, so unresolved ids keep the Base asset set rather than
 * inventing a substitute.
 *
 * @param {{ type?: unknown; id?: unknown; url?: unknown; css?: unknown }
 *   | null
 *   | undefined} theme
 * @returns {string[]}
 */
export const builtInThemeAssetUrls = (theme) =>
  builtInThemeAssetDirs(theme).map(
    (dir) => `${WIKIDOT_THEME_ASSET_ORIGIN}/${dir}/css/style.css`
  )

/**
 * Emit the live inline `@import` form for the theme directories beyond the
 * established local Base assets, in evidenced order. The local Wikidot
 * Base stylesheets already serve common--theme/base, so Base itself emits
 * nothing and id 1 stays byte-identical to the existing head.
 *
 * @param {{ type?: unknown; id?: unknown; url?: unknown; css?: unknown }
 *   | null
 *   | undefined} theme
 * @returns {string}
 */
export const builtInThemeHeadHtml = (theme) => {
  const dirs = builtInThemeAssetDirs(theme).filter((dir) => dir !== "base")
  if (dirs.length === 0) return ""
  const imports = dirs
    .map((dir) => `@import url(${WIKIDOT_THEME_ASSET_ORIGIN}/${dir}/css/style.css);`)
    .join("\n")
  return `<style type="text/css" id="internal-style">\n${imports}\n</style>`
}
