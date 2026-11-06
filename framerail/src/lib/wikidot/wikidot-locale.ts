export const normalizeWikidotLocale = (locale: string | null | undefined): string =>
  `${locale ?? ""}`.toLowerCase().replaceAll("_", "-")

export const isJapaneseWikidotLocale = (locale: string | null | undefined): boolean => {
  const normalized = normalizeWikidotLocale(locale)
  return normalized === "ja" || normalized.startsWith("ja-") || normalized === "jp"
}

export const isEnglishWikidotLocale = (locale: string | null | undefined): boolean => {
  const normalized = normalizeWikidotLocale(locale)
  return normalized === "en" || normalized.startsWith("en-")
}

export const editPermissionDeniedDialog = (
  locale: string | null | undefined
): {
  title: string
  message: string
  extraMessage: string
  actionLink: { href: string; label: string }
  inlineActionLink: boolean
  closeLabel: string
} | null => {
  if (!isEnglishWikidotLocale(locale)) return null
  return {
    title: "Permission error",
    message: "Please note:",
    extraMessage:
      "Sorry, you can not edit this page. Only members of this site, owner (creator) of this page, site administrators and perhaps selected moderators are allowed to do it.",
    actionLink: { href: "#action:login", label: "Sign in as Wikidot user" },
    inlineActionLink: true,
    closeLabel: "close message"
  }
}

export const editPermissionDeniedMessage = (
  locale: string | null | undefined
): string => {
  const normalized = normalizeWikidotLocale(locale)
  if (isJapaneseWikidotLocale(normalized)) return "このページを編集する権限がありません。"

  const language = normalized.split("-", 1)[0]
  if (language === "ko") return "이 페이지를 편집할 권한이 없습니다."
  if (language === "zh") {
    return /^(zh-hant|zh-tw|zh-hk|zh-mo)(-|$)/u.test(normalized)
      ? "您沒有權限編輯此頁面。"
      : "您没有权限编辑此页面。"
  }

  return "You don't have permission to edit this page."
}

export const createPageDeniedMessage = (): string =>
  "Sorry, you can not create a new page in this category. Only members of this site, site administrators and perhaps selected moderators are allowed to do it."

export const movePermissionDeniedMessage = (): string =>
  "You don't have permission to move this page."

export const deletePermissionDeniedMessage = (): string =>
  "You don't have permission to delete this page."

/**
 * Wikidot exposes `ja-corrections` as a site language identifier, but it
 * is not a valid BCP 47 locale and JavaScript's Intl APIs reject it.
 * Preserve the raw identifier at the Wikidot compatibility boundary and
 * use Japanese only when passing locale preferences to Intl.
 */
export const toIntlLocales = (locales: string[]): string[] =>
  locales.map((locale) =>
    locale.toLowerCase().replaceAll("_", "-") === "ja-corrections" ? "ja" : locale
  )
