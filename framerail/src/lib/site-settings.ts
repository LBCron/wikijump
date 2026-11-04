import type { ThemeSetting } from "./types"

const GOOGLE_ANALYTICS_PROFILE = /^UA-[0-9]+-[0-9]+$(?![\s\S])/u

export const isGoogleAnalyticsProfile = (value: unknown): value is string =>
  typeof value === "string" && GOOGLE_ANALYTICS_PROFILE.test(value)

type GoogleAnalyticsSettingsInput =
  { enabled?: unknown; profile?: unknown } | null | undefined

export const normalizeGoogleAnalyticsSettings = (
  settings: GoogleAnalyticsSettingsInput
): { enabled: boolean; profile: string | null } => {
  const profile = settings?.profile
  return {
    enabled: settings?.enabled === true,
    profile: isGoogleAnalyticsProfile(profile) ? profile : null
  }
}

export const googleAnalyticsQueueScript = (
  settings: GoogleAnalyticsSettingsInput
): string => {
  const normalized = normalizeGoogleAnalyticsSettings(settings)
  if (!normalized.enabled || normalized.profile === null) return ""

  return [
    `_gaq.push(['userTracker._setAccount', '${normalized.profile}']);`,
    "_gaq.push(['userTracker._trackPageview']);"
  ].join("\n")
}

export const googleAnalyticsHeadHtml = (
  settings: GoogleAnalyticsSettingsInput
): string => {
  const queue = googleAnalyticsQueueScript(settings)
  if (!queue) return ""
  return `<script>globalThis._gaq=globalThis._gaq||[];\n${queue}</script>`
}

const BUILT_IN_THEME: ThemeSetting = { type: "built_in", id: 1 }
const WIKIDOT_THEME_ASSET_ORIGIN =
  "http://d3g0gp89917ko0.cloudfront.net/v--7690939296dc/common--theme"

export const BUILT_IN_THEME_ASSET_DIRS: Readonly<Record<number, readonly string[]>> =
  Object.freeze({
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

const parseFilesAuthority = (
  filesAuthority: unknown
): { hostname: string; port: string } | null => {
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

const isOwnFilesThemeUrl = (url: URL, ownFilesAuthority: unknown): boolean => {
  const authority = parseFilesAuthority(ownFilesAuthority)
  if (authority === null) return false
  if (url.hostname !== authority.hostname) return false
  return url.port === "" || url.port === authority.port
}

const isAllowedExternalThemeUrl = (url: URL, ownFilesAuthority: unknown = null) =>
  url.protocol === "https:" &&
  !url.username &&
  !url.password &&
  ((url.port === "" &&
    (EXTERNAL_THEME_HOSTS.has(url.hostname) || url.hostname.endsWith(".wdfiles.com"))) ||
    isOwnFilesThemeUrl(url, ownFilesAuthority))

type ThemeSettingInput =
  { type?: unknown; id?: unknown; url?: unknown; css?: unknown } | null | undefined

export const normalizeThemeSetting = (
  theme: ThemeSettingInput,
  ownFilesAuthority: unknown = null
): ThemeSetting => {
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

export const normalizeThemePreviewUrl = (value: unknown): string | null => {
  const normalized = normalizeThemeSetting({ type: "external", url: value })
  return normalized.type === "external" ? normalized.url : null
}

export const resolveThemePreviewUrl = (
  themePreviewerNoUi: unknown,
  value: unknown
): string | null => (themePreviewerNoUi === true ? normalizeThemePreviewUrl(value) : null)

type LocalFileCheck = (page: string, name: string) => unknown

export const customThemeHeadHtml = (
  theme: ThemeSettingInput,
  site: LocalSiteEvidence | null = null,
  filesAuthority: unknown = null,
  isLocalFile: LocalFileCheck | null = null
): string => {
  const normalized = normalizeThemeSetting(theme, filesAuthority)
  if (normalized.type !== "custom") return ""
  const css = localizeSiteFileUrlsInCss(normalized.css, site, filesAuthority, isLocalFile)
  return `<style data-wikidot-site-theme>${css}</style>`
}

export type LocalSiteEvidence = {
  slug: unknown
  from_wikidot: unknown
}

export const SITE_FILE_PRESENCE_SEPARATOR = "\0"

export const siteFilePresenceKey = (page: unknown, name: unknown): string | null => {
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

const splitAbsoluteHttpUrl = (rawUrl: unknown): { host: string; rest: string } | null => {
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

const wdfilesAttachmentSiteSlug = (host: string): string | null => {
  for (const suffix of WDFILES_HOST_SUFFIXES) {
    if (!host.endsWith(suffix)) continue
    const slug = host.slice(0, -suffix.length)
    if (slug !== "" && SITE_SLUG_PATTERN.test(slug)) return slug
  }
  return null
}

const isViewedSiteWdfilesSlug = (
  slug: string,
  site: LocalSiteEvidence | null | undefined
): boolean => {
  if (typeof slug !== "string" || slug === "") return false
  if (site?.from_wikidot !== true) return false
  if (typeof site.slug !== "string" || !SITE_SLUG_PATTERN.test(site.slug)) {
    return false
  }
  return site.slug.toLowerCase() === slug
}

export const parseSiteFileReference = (
  rawUrl: unknown,
  site: LocalSiteEvidence | null | undefined
): { page: string; name: string; rest: string } | null => {
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

export const localizeSiteFileUrl = (
  rawUrl: unknown,
  site: LocalSiteEvidence | null | undefined,
  filesAuthority: unknown,
  isLocalFile?: LocalFileCheck | null
): string | null => {
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

export const extractCssAssetUrls = (css: unknown): string[] => {
  if (typeof css !== "string") return []
  const urls = new Set<string>()
  for (const pattern of [CSS_URL_PATTERN, CSS_BARE_IMPORT_PATTERN]) {
    pattern.lastIndex = 0
    let match
    while ((match = pattern.exec(css)) !== null) {
      if (typeof match[2] === "string" && match[2] !== "") urls.add(match[2])
    }
  }
  return [...urls]
}

export const localizeSiteFileUrlsInCss = (
  css: unknown,
  site: LocalSiteEvidence | null | undefined,
  filesAuthority: unknown,
  isLocalFile?: LocalFileCheck | null
): string => {
  if (typeof css !== "string") return typeof css === "undefined" ? "" : (css as string)
  const rewriteMatch = (match: string, url: string): string => {
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

export const resolveExternalThemeHref = (
  theme: ThemeSettingInput,
  site: LocalSiteEvidence | null | undefined,
  filesAuthority: unknown,
  isLocalFile?: LocalFileCheck | null
): string | null => {
  const normalized = normalizeThemeSetting(theme, filesAuthority)
  if (normalized.type !== "external") return null
  return (
    localizeSiteFileUrl(normalized.url, site, filesAuthority, isLocalFile) ??
    normalized.url
  )
}

export const builtInThemeAssetDirs = (theme: ThemeSettingInput): readonly string[] => {
  const normalized = normalizeThemeSetting(theme)
  if (normalized.type !== "built_in") return []
  return (
    BUILT_IN_THEME_ASSET_DIRS[normalized.id] ??
    BUILT_IN_THEME_ASSET_DIRS[BUILT_IN_THEME.id]
  )
}

export const builtInThemeAssetUrls = (theme: ThemeSettingInput): string[] =>
  builtInThemeAssetDirs(theme).map(
    (dir) => `${WIKIDOT_THEME_ASSET_ORIGIN}/${dir}/css/style.css`
  )

export const builtInThemeHeadHtml = (theme: ThemeSettingInput): string => {
  const dirs = builtInThemeAssetDirs(theme).filter((dir) => dir !== "base")
  if (dirs.length === 0) return ""
  const imports = dirs
    .map((dir) => `@import url(${WIKIDOT_THEME_ASSET_ORIGIN}/${dir}/css/style.css);`)
    .join("\n")
  return `<style type="text/css" id="internal-style">\n${imports}\n</style>`
}
