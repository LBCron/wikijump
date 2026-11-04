const PLATFORM_FOOTER_ORIGIN = "https://wikijump.com"

export const NATIVE_FOOTER_DESTINATION_KEYS = Object.freeze([
  "terms-conditions",
  "privacy",
  "docs",
  "security"
] as const)

export const NATIVE_FOOTER_DESTINATION_ENVIRONMENT_VARIABLES = Object.freeze({
  "terms-conditions": "PUBLIC_WIKIJUMP_FOOTER_TERMS_CONDITIONS_URL",
  privacy: "PUBLIC_WIKIJUMP_FOOTER_PRIVACY_URL",
  docs: "PUBLIC_WIKIJUMP_FOOTER_DOCS_URL",
  security: "PUBLIC_WIKIJUMP_FOOTER_SECURITY_URL"
})

export const DEFAULT_NATIVE_FOOTER_LINKS = Object.freeze([
  Object.freeze({
    key: "terms-conditions",
    href: `${PLATFORM_FOOTER_ORIGIN}/legal:terms-of-service`
  }),
  Object.freeze({
    key: "privacy",
    href: `${PLATFORM_FOOTER_ORIGIN}/legal:privacy-policy`
  }),
  Object.freeze({ key: "docs", href: `${PLATFORM_FOOTER_ORIGIN}/docs` }),
  Object.freeze({ key: "security", href: `${PLATFORM_FOOTER_ORIGIN}/legal:security` })
])

const MAX_DESTINATION_LENGTH = 2048
// Rejects NUL and every other control character on purpose.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARACTER = /[\u0000-\u0020\u007f\\]/u

export const normalizePlatformFooterDestination = (
  value: string | null | undefined
): string | null => {
  if (typeof value !== "string") return null

  const trimmed = value.trim()
  if (trimmed.length === 0 || trimmed.length > MAX_DESTINATION_LENGTH) return null
  if (UNSAFE_CHARACTER.test(trimmed)) return null

  try {
    const url = new URL(trimmed)
    if (url.protocol !== "https:") return null
    if (!url.hostname || url.username || url.password) return null
    return url.href
  } catch {
    return null
  }
}

export const resolveNativeFooterLinks = (
  configured?: Record<string, string | null | undefined> | null
): readonly { key: string; href: string }[] =>
  NATIVE_FOOTER_DESTINATION_KEYS.map((key) => ({
    key,
    href:
      normalizePlatformFooterDestination(configured?.[key]) ??
      DEFAULT_NATIVE_FOOTER_LINKS.find((link) => link.key === key)?.href ??
      PLATFORM_FOOTER_ORIGIN
  }))

export const readNativeFooterDestinationOverrides = (
  environment?: Record<string, string | undefined> | null
): Record<string, string | undefined> => {
  const source = environment ?? {}
  return Object.fromEntries(
    NATIVE_FOOTER_DESTINATION_KEYS.map((key) => [
      key,
      source[NATIVE_FOOTER_DESTINATION_ENVIRONMENT_VARIABLES[key]]
    ])
  )
}
