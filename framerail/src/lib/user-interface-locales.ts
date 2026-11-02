export const USER_INTERFACE_LOCALES = [
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "pl", label: "Polski" },
  { value: "vi", label: "Tiếng Việt" },
  { value: "zh-Hans", label: "简体中文" }
] as const

const supportedLocaleValues: ReadonlySet<string> = new Set(
  USER_INTERFACE_LOCALES.map(({ value }) => value)
)

export function isSupportedUserInterfaceLocale(locale: string): boolean {
  return supportedLocaleValues.has(locale)
}

export function areSupportedUserInterfaceLocales(locales: string[]): boolean {
  return locales.length > 0 && locales.every(isSupportedUserInterfaceLocale)
}
