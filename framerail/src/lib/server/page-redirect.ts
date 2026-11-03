export interface PageRedirectData {
  redirect_page: string | null
  redirect_kind?: "wikidot_module" | "random_helper" | null
}

export interface ResolvedPageRedirect {
  status: 301 | 302 | 308
  location: string
}

export function resolvePageRedirect(
  viewData: PageRedirectData,
  originalSlug: string | null | undefined,
  extra: string | null | undefined,
  requestUrl: string
): ResolvedPageRedirect | null {
  if (!viewData.redirect_page) {
    return null
  }

  if (viewData.redirect_kind === "wikidot_module") {
    return resolveWikidotModuleRedirect(viewData.redirect_page, extra, requestUrl)
  }
  if (viewData.redirect_kind === "random_helper") {
    return resolveRandomHelperRedirect(viewData.redirect_page, requestUrl)
  }
  if (viewData.redirect_kind !== null && viewData.redirect_kind !== undefined) {
    return null
  }

  let search = ""
  try {
    search = new URL(requestUrl).search
  } catch {}

  return {
    status: 301,
    location: `/${buildRoute(viewData.redirect_page || originalSlug, extra)}${search}`
  }
}

function resolveWikidotModuleRedirect(
  location: string,
  extra: string | null | undefined,
  requestUrl: string
): ResolvedPageRedirect | null {
  if (
    location.startsWith("//") ||
    (!location.startsWith("/") && !/^https?:\/\//i.test(location))
  ) {
    return null
  }

  let current: URL
  let target: URL
  try {
    current = new URL(requestUrl)
    target = new URL(location, current)
  } catch {
    return null
  }

  if (
    !["http:", "https:"].includes(target.protocol) ||
    target.username !== "" ||
    target.password !== ""
  ) {
    return null
  }

  const mappedLocation =
    !location.includes("?") &&
    !location.includes("#") &&
    location.endsWith("/") &&
    extra &&
    !extra.includes("?") &&
    !extra.includes("#")
      ? `${location}${extra}`
      : location

  if (mappedLocation !== location) {
    try {
      target = new URL(mappedLocation, current)
    } catch {
      return null
    }
  }

  let currentPath: string
  let targetPath: string
  try {
    currentPath = decodeURI(current.pathname)
    targetPath = decodeURI(target.pathname)
  } catch {
    return null
  }

  if (
    target.hostname === current.hostname &&
    targetPath === currentPath &&
    target.search === current.search
  ) {
    return null
  }

  return { status: 301, location: mappedLocation }
}

function resolveRandomHelperRedirect(
  slug: string,
  requestUrl: string
): ResolvedPageRedirect | null {
  if (
    slug === "" ||
    // eslint-disable-next-line no-control-regex -- redirect targets must not smuggle controls
    /[\x00-\x20\x7f?#\\]/.test(slug) ||
    slug.startsWith("/") ||
    slug.includes("://")
  ) {
    return null
  }

  let currentPath: string
  let search: string
  try {
    const current = new URL(requestUrl)
    currentPath = decodeURI(current.pathname)
    search = current.search
  } catch {
    return null
  }

  if (currentPath === `/${slug}`) {
    return null
  }

  return { status: 302, location: `/${slug}${search}` }
}

function buildRoute(
  slug: string | null | undefined,
  extra: string | null | undefined
): string {
  if (slug === null) {
    return ""
  } else if (!extra) {
    return slug ?? ""
  } else {
    return `${slug}/${extra}`
  }
}
