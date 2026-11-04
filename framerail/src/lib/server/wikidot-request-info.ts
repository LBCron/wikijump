export const WIKIDOT_REQUEST_INFO_MARKER = "/*__WIKIDOT_REQUEST_INFO__*/"
const REQUEST_INFO_TEMPLATE_SCRIPT =
  /<script data-wikidot-request-info nonce="[^"]+">\s*\/\*__WIKIDOT_REQUEST_INFO__\*\/\s*<\/script>/u
const WIKIDOT_DOCUMENT_LANGUAGE_MARKER = "<meta data-wikidot-document-language />"

const SITE_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

const requireSafeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`)
  }
  return value
}

const requireString = (value: string, name: string, maximumLength = 1024): string => {
  const hasControlCharacter =
    typeof value === "string" &&
    [...value].some((character) => {
      const codePoint = character.codePointAt(0)
      return codePoint !== undefined && (codePoint < 32 || codePoint === 127)
    })
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    hasControlCharacter
  ) {
    throw new Error(`${name} must be a non-empty string without control characters`)
  }
  return value
}

const requireSiteSlug = (value: string): string => {
  if (typeof value !== "string" || !SITE_SLUG_PATTERN.test(value)) {
    throw new Error("site slug is outside the supported unix-name grammar")
  }
  return value
}

const requireRequestHost = (value: string): string => {
  const host = requireString(value, "request host", 261).toLowerCase()
  let parsed: URL
  try {
    parsed = new URL(`http://${host}`)
  } catch {
    throw new Error("request host is outside the supported host grammar")
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.host !== host
  ) {
    throw new Error("request host is outside the supported host grammar")
  }
  return host
}

export const requestHostFromRequest = (request: Request): string => {
  return requireRequestHost(request.headers.get("host") ?? new URL(request.url).host)
}

export const buildWikidotRequestInfo = ({
  domain,
  site,
  page
}: {
  domain: string
  site: {
    site_id: number
    slug: string
    locale: string
  }
  page: {
    page_id: number
    page_category_id: number
    slug: string
  }
}) => {
  const siteUnixName = requireSiteSlug(site.slug)
  const pageUnixName = requireString(page.slug, "page slug")
  return {
    domain: requireRequestHost(domain),
    siteId: requireSafeInteger(site.site_id, "site ID"),
    siteUnixName,
    categoryId: requireSafeInteger(page.page_category_id, "page category ID"),
    requestPageName: pageUnixName,
    lang: requireString(site.locale, "site locale", 64),
    pageUnixName,
    pageId: requireSafeInteger(page.page_id, "page ID")
  }
}

const scriptString = (value: string) =>
  JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029")

const htmlAttribute = (value: string) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")

export const serializeWikidotRequestInfo = (
  info: ReturnType<typeof buildWikidotRequestInfo> | undefined
) => {
  if (!info) return ""
  const validated = buildWikidotRequestInfo({
    domain: info.domain,
    site: {
      site_id: info.siteId,
      slug: info.siteUnixName,
      locale: info.lang
    },
    page: {
      page_id: info.pageId,
      page_category_id: info.categoryId,
      slug: info.pageUnixName
    }
  })
  if (validated.requestPageName !== info.requestPageName) {
    throw new Error("request page name must equal page unix name")
  }
  return [
    "var WIKIREQUEST = {};",
    "WIKIREQUEST.info = {};",
    `WIKIREQUEST.info.domain = ${scriptString(validated.domain)};`,
    `WIKIREQUEST.info.siteId = ${validated.siteId};`,
    `WIKIREQUEST.info.siteUnixName = ${scriptString(validated.siteUnixName)};`,
    `WIKIREQUEST.info.categoryId = ${validated.categoryId};`,
    `WIKIREQUEST.info.requestPageName = ${scriptString(validated.requestPageName)};`,
    `WIKIREQUEST.info.lang = ${scriptString(validated.lang)};`,
    `WIKIREQUEST.info.pageUnixName = ${scriptString(validated.pageUnixName)};`,
    `WIKIREQUEST.info.pageId = ${validated.pageId};`
  ].join("\n")
}

export const injectWikidotRequestInfo = (
  html: string,
  info: ReturnType<typeof buildWikidotRequestInfo> | undefined,
  siteLocale: string | undefined = undefined,
  wikidotDocument = false
) => {
  const locale = siteLocale
    ? htmlAttribute(requireString(siteLocale, "site locale", 64))
    : undefined
  const root = locale
    ? wikidotDocument
      ? `<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${locale}" lang="${locale}">`
      : `<html lang="${locale}">`
    : undefined
  const localizedHtml = root ? html.replace('<html lang="en">', root) : html
  const documentHtml = localizedHtml.replace(
    WIKIDOT_DOCUMENT_LANGUAGE_MARKER,
    wikidotDocument && locale
      ? `<meta http-equiv="content-language" content="${locale}"/>`
      : ""
  )
  const templateScript = REQUEST_INFO_TEMPLATE_SCRIPT.exec(documentHtml)
  if (!templateScript) return documentHtml
  const first =
    templateScript.index + templateScript[0].indexOf(WIKIDOT_REQUEST_INFO_MARKER)
  return `${documentHtml.slice(0, first)}${serializeWikidotRequestInfo(info)}${documentHtml.slice(first + WIKIDOT_REQUEST_INFO_MARKER.length)}`
}
