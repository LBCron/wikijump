/**
 * Map Wikidot page-owned local files/code to the current local file host.
 * CDN theme URLs are intentionally preserved; offline mirroring is a later
 * policy slice, not hidden here.
 */
export const localizeWikidotThemeUrl = (
  themeUrl: string,
  origin: string | null | undefined
): string => {
  if (!origin) return themeUrl
  let parsed: URL
  let localOrigin: URL
  try {
    parsed = new URL(themeUrl)
    localOrigin = new URL(origin)
  } catch {
    return themeUrl
  }

  if (
    !["scp-wiki.wikidot.com", "scp-wiki.wdfiles.com"].includes(parsed.hostname) ||
    !parsed.pathname.startsWith("/local--")
  ) {
    return themeUrl
  }

  const localHost = localOrigin.hostname.replace(
    /\.wikijump\.((?:[a-z0-9-]+\.)*localhost)$/u,
    ".wjfiles.$1"
  )
  if (localHost === localOrigin.hostname) return themeUrl
  parsed.protocol = "https:"
  parsed.hostname = localHost
  parsed.port = localOrigin.port
  return parsed.toString()
}
