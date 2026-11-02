export const authCancelDestination = () => "/"

/**
 * Where a completed native sign-in lands: the same-site path named by
 * `?return=`, or the site root. Anything that could leave the site (an
 * absolute or protocol-relative URL, a backslash, or another native route
 * such as /-/login itself) falls back to the root, so the parameter cannot
 * become an open redirect or a loop.
 *
 * @param {URL} url The /-/login page URL
 * @returns {string}
 */
export const authReturnDestination = (url) => {
  const target = url.searchParams.get("return")
  if (
    !target ||
    !target.startsWith("/") ||
    target.startsWith("//") ||
    target.includes("\\") ||
    target.startsWith("/-/") ||
    [...target].some((character) => character.charCodeAt(0) < 0x20)
  ) {
    return "/"
  }
  const resolved = new URL(target, url)
  return resolved.origin === url.origin
    ? resolved.pathname + resolved.search + resolved.hash
    : "/"
}
