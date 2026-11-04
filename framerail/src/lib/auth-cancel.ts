export const authCancelDestination = () => "/"

export const authReturnDestination = (url: URL): string => {
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
