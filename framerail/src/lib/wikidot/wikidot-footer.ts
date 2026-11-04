/* eslint-disable no-script-url -- Wikidot footer and fixture markup use javascript:; no-op links that parity requires */
import { showWikidotReadonlyDialog } from "./wikidot-readonly-dialog.ts"
import { isJapaneseWikidotLocale } from "./wikidot-locale.ts"

export type WikidotFooterLink = {
  label: string
  href: string
  id: string
  onclick?: string
}

export const WIKIDOT_FOOTER_LINKS: readonly WikidotFooterLink[] = Object.freeze([
  { label: "Help", href: "https://www.wikidot.com/doc", id: "wikidot-help-button" },
  {
    label: "Terms of Service",
    href: "https://www.wikidot.com/legal:terms-of-service",
    id: "wikidot-tos-button"
  },
  {
    label: "Privacy",
    href: "https://www.wikidot.com/legal:privacy-policy",
    id: "wikidot-privacy-button"
  },
  {
    label: "Report a bug",
    href: "javascript:;",
    id: "bug-report-button",
    onclick: "WIKIDOT.page.listeners.pageBugReport(event)"
  },
  {
    label: "Flag as objectionable",
    href: "javascript:;",
    id: "abuse-report-button",
    onclick: "WIKIDOT.page.listeners.flagPageObjectionable(event)"
  }
])

export const WIKIDOT_FOOTER_LINKS_JA: readonly WikidotFooterLink[] = Object.freeze([
  { label: "ヘルプ", href: "https://www.wikidot.com/doc", id: "wikidot-help-button" },
  {
    label: "利用規約",
    href: "https://www.wikidot.com/legal:terms-of-service",
    id: "wikidot-tos-button"
  },
  {
    label: "プライバシー",
    href: "https://www.wikidot.com/legal:privacy-policy",
    id: "wikidot-privacy-button"
  },
  {
    label: "バグを報告",
    href: "javascript:;",
    id: "bug-report-button",
    onclick: "WIKIDOT.page.listeners.pageBugReport(event)"
  },
  {
    label: "不快フラグを立てる",
    href: "javascript:;",
    id: "abuse-report-button",
    onclick: "WIKIDOT.page.listeners.flagPageObjectionable(event)"
  }
])

export const WIKIDOT_POWERED_BY = "Powered by Wikidot.com"

export const WIKIDOT_FOOTER_STYLE = "display: block; visibility: visible;"

export const buildWikidotFooterHtml = (locale: string | null | undefined): string => {
  const links = buildWikidotFooterLinks(locale)
    .map(
      ({ label, href, id, onclick }) =>
        `<a href="${href}" id="${id}"${onclick ? ` onclick="${onclick}"` : ""}>${label}</a>`
    )
    .join("\n    &nbsp;|\n    ")
  return (
    `\n                <div class="options" style="${WIKIDOT_FOOTER_STYLE}">\n    ${links}` +
    `\n    <span id="consent-box" style="display:none">\n        &nbsp;|` +
    `\n        <a href="javascript:;" onclick="window.__cmp('showModal');">Update cookie settings</a>` +
    `\n    </span>\n\n    \n</div>` +
    `\nPowered by <a href="https://www.wikidot.com">Wikidot.com</a>\n            `
  )
}

export const WIKIDOT_FOOTER_ONCLICKS = Object.freeze([
  "WIKIDOT.page.listeners.pageBugReport(event)",
  "WIKIDOT.page.listeners.flagPageObjectionable(event)",
  "window.__cmp('showModal');"
])

export const wikidotFooterControls = (
  root: HTMLElement,
  parameters: { locale?: string | null; anonymous?: boolean } = {}
) => {
  const bound: HTMLElement[] = []
  for (const element of root.querySelectorAll<HTMLElement>("a[onclick]")) {
    if (!WIKIDOT_FOOTER_ONCLICKS.includes(element.getAttribute("onclick") ?? "")) continue
    element.onclick = () => {
      const handler = element.getAttribute("onclick")
      if (handler === WIKIDOT_FOOTER_ONCLICKS[0]) {
        showWikidotReadonlyDialog(
          root.ownerDocument,
          buildWikidotBugReportDialogHtml(parameters.locale)
        )
      } else if (
        handler === WIKIDOT_FOOTER_ONCLICKS[1] &&
        parameters.anonymous === true &&
        !isJapaneseWikidotLocale(parameters.locale)
      ) {
        showWikidotReadonlyDialog(root.ownerDocument, WIKIDOT_ANONYMOUS_FLAG_DIALOG, true)
      }
      return false
    }
    bound.push(element)
  }
  return {
    destroy() {
      for (const element of bound) element.onclick = null
    }
  }
}

const BUG_REPORT_DIALOG = Object.freeze({
  "en": '<div class="title">Bug report</div>\n<div class="content">\n\t<h1>Report a problem with Wikidot.com</h1>\n\t\n\t<p>\n\t\tIf you think you have found a bug or simply something does not work as expected,       please fill a bug report.             <br/><br/>             Currently the list of bugs is maintained at:\t</p>\n\t<p style="font-weight: bold; font-size: 180%; text-align: center">\n\t\t<a href="https://feedback.wikidot.com/">feedback.wikidot.com</a>\n\t</p>\n</div>\n<div class="button-bar">\n\t<a href="javascript:;" onclick="OZONE.dialog.cleanAll()">Close window</a> \n</div>',
  "ja": '<div class="title">バグ報告</div>\n<div class="content">\n\t<h1>Wikidot.comに問題を報告</h1>\n\t\n\t<p>\n\t\tあなたがバグを発見したり、単に何かが期待どおりに動かない場合は、バグレポートを記入してください。<br/><br/>現在、バグリストは次の場所で管理されています:\t</p>\n\t<p style="font-weight: bold; font-size: 180%; text-align: center">\n\t\t<a href="https://feedback.wikidot.com/">feedback.wikidot.com</a>\n\t</p>\n</div>\n<div class="button-bar">\n\t<a href="javascript:;" onclick="OZONE.dialog.cleanAll()">ウィンドウを終了</a> \n</div>'
})
export const buildWikidotBugReportDialogHtml = (
  locale: string | null | undefined
): string => BUG_REPORT_DIALOG[isJapaneseWikidotLocale(locale) ? "ja" : "en"]

export const WIKIDOT_ANONYMOUS_FLAG_DIALOG =
  '<div class="title modal-header">Permission error</div><div class="content modal-body"><h1>Please note:</h1><p>Please create a Wikidot account and/or sign in first</p></div><div class="button-bar modal-footer"><a href="javascript:;" class="btn btn-default button button-close-message">close message</a></div>'

export const WIKIDOT_LOGIN_LABELS = Object.freeze({
  createAccount: "Create account",
  or: "or",
  signIn: "Sign in"
})

export const WIKIDOT_LOGIN_LABELS_JA = Object.freeze({
  createAccount: "アカウントを作成",
  or: "または",
  signIn: "サインイン"
})

export const WIKIDOT_ACCOUNT_LABELS = Object.freeze({
  myAccount: "My account",
  settings: "Settings",
  signOut: "Sign out"
})

export const WIKIDOT_ACCOUNT_LABELS_JA = Object.freeze({
  myAccount: "マイアカウント",
  settings: "設定",
  signOut: "サインアウト"
})

export const buildWikidotFooterLinks = (locale: string | null | undefined) => {
  return isJapaneseWikidotLocale(locale) ? WIKIDOT_FOOTER_LINKS_JA : WIKIDOT_FOOTER_LINKS
}

export const buildWikidotLoginLabels = (locale: string | null | undefined) => {
  return isJapaneseWikidotLocale(locale) ? WIKIDOT_LOGIN_LABELS_JA : WIKIDOT_LOGIN_LABELS
}

export const buildWikidotAccountLabels = (locale: string | null | undefined) => {
  return isJapaneseWikidotLocale(locale)
    ? WIKIDOT_ACCOUNT_LABELS_JA
    : WIKIDOT_ACCOUNT_LABELS
}

const escapeHtml = (value: string | null | undefined): string => {
  return `${value ?? ""}`
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
}

export const formatWikidotLicenseName = (
  licenseName: string | null | undefined,
  locale: string | null | undefined = "en"
): string => {
  const name = `${licenseName ?? ""}`.replace(/\.$/, "").trim()

  if (!name) return "License"

  if (isJapaneseWikidotLocale(locale)) {
    if (/^creative commons attribution-sharealike 3\.0$/i.test(name)) {
      return "クリエイティブ・コモンズ 表示 - 継承3.0ライセンス"
    }
  }

  return /license$/i.test(name) ? name : `${name} License`
}

export const buildWikidotLicenseHtml = ({
  licenseName,
  licenseUrl,
  licenseKind = "standard",
  licenseHtml = null,
  locale = "en",
  sourceSite = null
}: {
  licenseName?: string | null
  licenseUrl?: string | null
  licenseKind?: string | null
  licenseHtml?: string | null
  locale?: string | null
  sourceSite?: string | null
}): string => {
  if (licenseKind === "copyright") return ""
  if (licenseKind === "other") return licenseHtml ?? ""

  const effectiveLocale = locale ?? "en"
  const name = escapeHtml(formatWikidotLicenseName(licenseName, effectiveLocale))
  const englishName = escapeHtml(formatWikidotLicenseName(licenseName, "en"))
  const url = escapeHtml(licenseUrl || "/")

  if (isJapaneseWikidotLocale(effectiveLocale)) {
    if (sourceSite && sourceSite !== "scp-jp") {
      return `特に明記しない限り、このページのコンテンツは次のライセンスの下にあります: <a href="${url}">${englishName}</a>`
    }

    const jaUrl = escapeHtml(wikidotLicenseUrl(licenseUrl, "ja"))
    return `\n                    \n\n特に指定がない限り、このサイトのすべてのコンテンツは<a rel="license" href="${jaUrl}">${name}</a> の元で利用可能です。\n                `
  }

  const enUrl = escapeHtml(wikidotLicenseUrl(licenseUrl, "en"))
  return `\n                    Unless otherwise stated, the content of this page is licensed under\n\n <a rel="license" href="${enUrl}">${name}</a>\n                `
}

const wikidotLicenseUrl = (
  licenseUrl: string | null | undefined,
  language: "en" | "ja"
): string => {
  const url = licenseUrl || "/"
  if (!/^https?:\/\/creativecommons\.org\/licenses\/[^?#]*\/$/u.test(url)) return url
  const deed = url.replace(/^https:/u, "http:")
  return language === "ja" ? `${deed}deed.ja` : deed
}

export const shouldUseWikidotLicenseHtml = (
  importedWikidotLayout: boolean,
  licenseKind: string | null | undefined
): boolean =>
  importedWikidotLayout || licenseKind === "other" || licenseKind === "copyright"

export const isImportedWikidotView = (
  data:
    | {
        site?: { from_wikidot?: boolean | null } | null
        page?: { from_wikidot?: boolean | null } | null
        page_revision?: { from_wikidot?: boolean | null } | null
      }
    | null
    | undefined
): boolean => {
  return !!(
    data?.site?.from_wikidot ||
    data?.page?.from_wikidot ||
    data?.page_revision?.from_wikidot
  )
}
