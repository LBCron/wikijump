import { uniqueLocales } from "./locales.ts"

export const addLocalePreference = (locales: string[], locale: string): string[] => {
  if (!locale) return uniqueLocales(locales)
  return uniqueLocales([...locales, locale])
}

export const removeLocalePreference = (locales: string[], locale: string): string[] => {
  return uniqueLocales(locales).filter((value) => value !== locale)
}

export const moveLocalePreference = (
  locales: string[],
  locale: string,
  offset: -1 | 1
): string[] => {
  const ordered = uniqueLocales(locales)
  const index = ordered.indexOf(locale)
  const target = index + offset
  if (index < 0 || target < 0 || target >= ordered.length) return ordered

  ;[ordered[index], ordered[target]] = [ordered[target], ordered[index]]
  return ordered
}
