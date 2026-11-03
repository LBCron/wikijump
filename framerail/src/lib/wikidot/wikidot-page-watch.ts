import { isJapaneseWikidotLocale } from "./wikidot-locale.ts"

export type WikidotPageWatchLabel = {
  label: string
  helpLabel: string
  helpHref: string
}

export const buildWikidotPageWatchLabel = ({
  sourceSite,
  hasSession = false,
  locale = "en"
}: {
  sourceSite?: string | null
  hasSession?: boolean
  locale?: string | null
}): WikidotPageWatchLabel | null => {
  if (!hasSession || !sourceSite) {
    return null
  }

  if (isJapaneseWikidotLocale(locale)) {
    return {
      label: "このサイトのウォッチングを終了",
      helpLabel: "?",
      helpHref: "http://www.wikidot.com/faq:watching"
    }
  }

  return {
    label: `Stop watching site ${sourceSite}.wikidot.com`,
    helpLabel: "?",
    helpHref: "http://www.wikidot.com/faq:watching"
  }
}
