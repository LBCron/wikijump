import { isJapaneseWikidotLocale } from "./wikidot-locale.ts"

const WIKIDOT_SOURCE_TIME_ZONE = "Asia/Tokyo"
const WIKIDOT_MONTHS = Object.freeze([
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec"
])

const wikidotDatePartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: WIKIDOT_SOURCE_TIME_ZONE,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false
})

const datePart = (parts: Intl.DateTimeFormatPart[], type: string) => {
  return parts.find((part) => part.type === type)?.value ?? ""
}

export const formatWikidotSourceDate = (timestampMs: number) => {
  const parts = wikidotDatePartsFormatter.formatToParts(new Date(timestampMs))
  const day = Number(datePart(parts, "day"))
  const month = Number(datePart(parts, "month"))
  const year = datePart(parts, "year")
  const hour = datePart(parts, "hour").replace(/^24$/, "00").padStart(2, "0")
  const minute = datePart(parts, "minute").padStart(2, "0")

  return `${day} ${WIKIDOT_MONTHS[month - 1]} ${year}, ${hour}:${minute}`
}

export const formatWikidotRelativeAge = (
  elapsedMs: number,
  locale: string | null | undefined = "en"
) => {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
  const suffix = isJapaneseWikidotLocale(locale) ? " 前" : " ago"

  if (totalSeconds < 60) {
    return isJapaneseWikidotLocale(locale)
      ? "less than a minute 前"
      : "less than a minute ago"
  }

  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}${suffix}`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}${suffix}`

  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? "" : "s"}${suffix}`
}

export const buildWikidotPageInfoText = ({
  revision,
  updatedAt,
  now = Date.now(),
  locale = "en"
}: {
  revision: number
  updatedAt: string
  now?: number
  locale?: string | null
}) => {
  const updatedAtMs = Date.parse(updatedAt)

  if (!Number.isFinite(updatedAtMs)) return null

  const date = formatWikidotSourceDate(updatedAtMs)
  const relative = formatWikidotRelativeAge(now - updatedAtMs, locale)

  if (isJapaneseWikidotLocale(locale)) {
    return `ページリビジョン: ${revision}, 最終更新: ${date} (${relative})`
  }

  return `page revision: ${revision}, last edited: ${date} (${relative})`
}
