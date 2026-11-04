import { parse } from "accept-language-parser"

const FALLBACK_LOCALE = "en"

export const MAX_LOCALE_PREFERENCES = 16
export const MAX_LOCALE_LENGTH = 64

export const uniqueLocales = (locales: string[]): string[] => {
  const seen = new Set<string>()
  const unique: string[] = []

  for (const locale of locales) {
    if (!locale || seen.has(locale)) continue
    seen.add(locale)
    unique.push(locale)
  }

  return unique
}

/**
 * Returns a bounded, deduplicated locale preference list for request-time
 * translation and persisted user preferences. Locale syntax is still
 * validated by Deepwell; this guard prevents oversized valid lists from
 * amplifying work.
 */
export const limitLocalePreferences = (
  locales: string[],
  requiredLocales: string[] = []
): string[] => {
  const limited: string[] = []
  const seen = new Set<string>()
  const required = new Set(
    requiredLocales
      .map((locale) => locale?.trim())
      .filter((locale) => locale && locale.length <= MAX_LOCALE_LENGTH)
  )
  const remainingRequired = new Set(required)

  for (const locale of locales) {
    const value = locale?.trim()
    if (!value || value.length > MAX_LOCALE_LENGTH || seen.has(value)) continue

    if (
      !required.has(value) &&
      limited.length >= MAX_LOCALE_PREFERENCES - remainingRequired.size
    ) {
      continue
    }

    seen.add(value)
    limited.push(value)
    remainingRequired.delete(value)
    if (limited.length >= MAX_LOCALE_PREFERENCES) break
  }

  return limited
}

export const withFallbackLocale = (
  locales: string[],
  fallbackLocale: string = FALLBACK_LOCALE
): string[] => {
  return uniqueLocales([...locales, fallbackLocale])
}

const formatParsedLocale = (lang: ReturnType<typeof parse>[number]): string => {
  const parts = [lang.code]
  if (lang.script) parts.push(lang.script)
  if (lang.region) parts.push(lang.region)
  return parts.join("-")
}

export const parseAcceptLangHeader = (req: Request): string[] => {
  const language = req.headers.get("Accept-Language")
  if (language === null) return []

  const locales = parse(language)
    .sort((a, b) => b.quality - a.quality)
    .map(formatParsedLocale)
    .filter((locale) => locale !== "*" && !locale.includes("*"))

  return limitLocalePreferences(locales)
}
