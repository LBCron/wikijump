const MAX_PUBLIC_WEBSITE_URL_LENGTH = 2048
const URL_SCHEME = /^[a-z][a-z\d+.-]*:/iu
const HOST_WITH_PORT = /^(?:[a-z\d.-]+|\[[\da-f:]+\]):\d+(?:[/?#].*)?$/iu

const hasUnsafeUrlCharacters = (value: string) => {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x20 || codePoint === 0x7f || character === "\\") return true
  }
  return false
}

/**
 * Turn a public profile website value into a safe absolute web URL.
 * Wikidot accepts ordinary domains without a scheme and resolves them as
 * HTTPS. Invalid or non-web values stay displayable as text but are not
 * link targets.
 */
export const normalizePublicWebsiteUrl = (
  value: string | null | undefined
): string | null => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PUBLIC_WEBSITE_URL_LENGTH ||
    hasUnsafeUrlCharacters(value)
  ) {
    return null
  }

  const hasWebScheme = /^https?:\/\//iu.test(value)
  if (URL_SCHEME.test(value) && !hasWebScheme && !HOST_WITH_PORT.test(value)) {
    return null
  }

  const candidate = value.startsWith("//")
    ? `https:${value}`
    : hasWebScheme
      ? value
      : value.startsWith("/") || value.startsWith("?") || value.startsWith("#")
        ? null
        : `https://${value}`

  if (!candidate) return null

  try {
    const url = new URL(candidate)
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return null
    }

    const authority = /^https?:\/\/([^/?#]*)/iu.exec(candidate)?.[1] ?? ""
    if (authority.includes("@")) return null

    return url.href
  } catch {
    return null
  }
}
