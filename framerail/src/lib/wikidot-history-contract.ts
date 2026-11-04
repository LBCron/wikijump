const EN_HEADERS = ["rev.", "", "flags", "actions", "by", "date", "comments"]
const JA_HEADERS = ["rev.", "", "フラグ", "アクション", "by", "日付", "コメント"]

export const wikidotRevisionSourceHtml = (source: string): string =>
  `<div class="page-source">${source
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
    .replaceAll("\r\n", "\n")
    .replaceAll("\n", "<br />\n")}</div>`

const escapePageSourceHtml = (source: string): string =>
  source
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")

const SOURCE_INCLUDE_OPEN = /^(\[\[include[\t ]+)([^\t \r\n\]|<>&"'#?]+)/u
const SOURCE_INCLUDE_PAGE_CHARS = /^[A-Za-z0-9_.:-]*$/u
const SOURCE_INCLUDE_SITE = /^[a-z0-9][a-z0-9-]*$/iu

const parseSourceIncludeTarget = (
  target: string
): { text: string; href: string } | null => {
  if (target.startsWith(":")) {
    const separator = target.indexOf(":", 1)
    if (separator < 0) return null
    const site = target.slice(1, separator)
    const page = target.slice(separator + 1)
    if (!SOURCE_INCLUDE_SITE.test(site)) return null
    if (
      page.length === 0 ||
      page.endsWith(":") ||
      !SOURCE_INCLUDE_PAGE_CHARS.test(page)
    ) {
      return null
    }
    const href = `https://${site.toLowerCase()}.wikidot.com/${page
      .split(":")
      .map((segment) => encodeURIComponent(segment))
      .join(":")}`
    return { text: target, href }
  }
  if (
    target.endsWith(":") ||
    target.includes("::") ||
    !SOURCE_INCLUDE_PAGE_CHARS.test(target)
  ) {
    return null
  }
  return { text: target, href: `/${encodeURIComponent(target)}` }
}

const sourceLineContent = (line: string): string => line.replace(/\r?\n$/u, "")

const parameterBlockEnd = (lines: string[], start: number): number => {
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = sourceLineContent(lines[index])
    if (/^[\t ]*(\[\[|\[!--|@@)/u.test(line)) return -1
    if (/^[\t ]*\|[A-Za-z_][A-Za-z0-9_-]*[\t ]*=[^\n]*\]\][\t ]*$/u.test(line)) {
      return index
    }
    if (/^[\t ]*\|[A-Za-z_][A-Za-z0-9_-]*[\t ]*=[^\n]*$/u.test(line)) continue
    if (/^[\t ]*[A-Za-z_][A-Za-z0-9_-]*[\t ]*=[^\n]*\|[\t ]*$/u.test(line)) {
      continue
    }
    if (/^[\t ]*[A-Za-z_][A-Za-z0-9_-]*[\t ]*=[^\n]*\|[\t ]*\]\][\t ]*$/u.test(line)) {
      return index
    }
    if (/^[\t ]*\]\][\t ]*$/u.test(line)) return index
    return -1
  }
  return -1
}

export const wikidotPageSourceHtml = (source: string): string => {
  let inComment = false
  let inCode = false
  const lines = source.match(/[^\n]*\n|[^\n]+$/gu) ?? []

  return lines
    .map((line, index) => {
      const content = sourceLineContent(line)
      const openInclude = !inComment && !inCode && SOURCE_INCLUDE_OPEN.exec(content)
      const parsed = openInclude ? parseSourceIncludeTarget(openInclude[2]) : null
      const rest = openInclude ? content.slice(openInclude[0].length) : ""
      const closed =
        parsed !== null && (rest.includes("]]") || parameterBlockEnd(lines, index) >= 0)

      let rendered = escapePageSourceHtml(content)
      if (openInclude && closed && parsed !== null) {
        const before = openInclude[1]
        const target = openInclude[2]
        rendered = `${escapePageSourceHtml(before)}<a href="${escapePageSourceHtml(parsed.href)}">${escapePageSourceHtml(target)}</a>${escapePageSourceHtml(rest)}`
      }

      const commentOpen = content.indexOf("[!--")
      const commentClose = content.indexOf("--]")
      if (inComment) {
        if (commentClose >= 0) inComment = false
      } else if (commentOpen >= 0 && (commentClose < 0 || commentClose < commentOpen)) {
        inComment = true
      }

      const codeOpen = content.indexOf("[[code]]")
      const codeClose = content.indexOf("[[/code]]")
      if (inCode) {
        if (codeClose >= 0) inCode = false
      } else if (codeOpen >= 0 && (codeClose < 0 || codeClose < codeOpen)) {
        inCode = true
      }

      return rendered + line.slice(content.length)
    })
    .join("")
}

const FLAG_TITLES = {
  en: {
    create: "New page",
    move: "Page renamed",
    source: "content source text changed",
    tags: "tags changed",
    files: "file/attachment operations"
  },
  ja: {
    create: "新しいページ",
    move: "ページ名が変更されました",
    source: "コンテンツソースが変更されました",
    tags: "タグが変更されました",
    files: "ファイル/添付操作"
  }
}

const ACTION_TITLES = {
  en: {
    view: "View page revision",
    source: "View source of the revision",
    rollback: "Revert to revision"
  },
  ja: {
    view: "リビジョンを閲覧",
    source: "リビジョンのソースを閲覧",
    rollback: "リビジョンの差し戻し"
  }
}

const localeKey = (locale: string | null | undefined): "ja" | "en" =>
  String(locale ?? "")
    .toLowerCase()
    .startsWith("ja")
    ? "ja"
    : "en"

export const wikidotHistoryHeaders = (locale: string | null | undefined): string[] =>
  localeKey(locale) === "ja" ? JA_HEADERS : EN_HEADERS

export const wikidotHistoryActionTitles = (locale: string | null | undefined) =>
  ACTION_TITLES[localeKey(locale)]

export type WikidotHistoryEntry = {
  history_kind?: string | null
  revision_type?: string | null
  changes?: Iterable<string> | null
}

export const wikidotRevisionFlags = (
  revision: WikidotHistoryEntry,
  locale: string | null | undefined
): { code: string; title: string }[] => {
  const titles = FLAG_TITLES[localeKey(locale)]
  if (revision.history_kind === "file") return [{ code: "F", title: titles.files }]
  if (revision.revision_type === "create") return [{ code: "N", title: titles.create }]
  if (revision.revision_type === "move") return [{ code: "R", title: titles.move }]

  const changes = new Set(revision.changes ?? [])
  return [
    ...(changes.has("wikitext") ? [{ code: "S", title: titles.source }] : []),
    ...(changes.has("tags") ? [{ code: "A", title: titles.tags }] : []),
    ...(changes.has("files") ? [{ code: "F", title: titles.files }] : [])
  ]
}

export const HISTORY_FILTER_TYPES = ["source", "title", "move", "tags", "meta", "files"]

export const HISTORY_PER_PAGE_OPTIONS = [20, 50, 100, 200]

export const historyEntryMatchesTypes = (
  entry: WikidotHistoryEntry | null | undefined,
  activeTypes: Iterable<string> | null | undefined
): boolean => {
  const active = new Set(activeTypes ?? [])
  if (active.size === 0 || active.has("all")) return true
  if (entry?.history_kind === "file") return active.has("files")
  if (entry?.revision_type === "move") return active.has("move")
  const changes = new Set(entry?.changes ?? [])
  return (
    (active.has("source") && changes.has("wikitext")) ||
    (active.has("title") && (changes.has("title") || changes.has("alt_title"))) ||
    (active.has("move") && changes.has("slug")) ||
    (active.has("tags") && changes.has("tags")) ||
    (active.has("meta") && changes.has("parent"))
  )
}

export const filterHistoryByTypes = <T>(
  entries: readonly T[] | null | undefined,
  activeTypes: Iterable<string> | null | undefined
): T[] =>
  (entries ?? []).filter((entry) =>
    historyEntryMatchesTypes(entry as WikidotHistoryEntry | null | undefined, activeTypes)
  )

export const paginateHistoryEntries = <T>(
  entries: readonly T[] | null | undefined,
  page: number | null | undefined,
  perPage: number | null | undefined
): {
  entries: T[]
  total: number
  page: number
  perPage: number
  totalPages: number
} => {
  const list = entries ?? []
  const size = Math.max(perPage ?? HISTORY_PER_PAGE_OPTIONS[0], 1)
  const totalPages = Math.max(1, Math.ceil(list.length / size))
  const current = Math.min(Math.max(page ?? 1, 1), totalPages)
  const start = (current - 1) * size
  return {
    entries: list.slice(start, start + size),
    total: list.length,
    page: current,
    perPage: size,
    totalPages
  }
}

export type HistoryPagerSegment =
  { kind: "page"; page: number; current: boolean } | { kind: "dots" }

export const historyPagerModel = (
  page: number,
  totalPages: number,
  words: { pageWord?: string; ofWord?: string } = {}
): {
  label: string
  prev: number | null
  next: number | null
  numbers: HistoryPagerSegment[]
  trailingDots: boolean
} => {
  const { pageWord = "page", ofWord = "of" } = words
  const total = Math.max(totalPages ?? 1, 1)
  const current = Math.min(Math.max(page ?? 1, 1), total)
  const label =
    current === 1 && total > 2
      ? `${pageWord} 1`
      : `${pageWord} ${current} ${ofWord} ${total}`
  const numbers: HistoryPagerSegment[] = []
  const pushNumber = (number: number) => {
    numbers.push({ kind: "page", page: number, current: number === current })
  }
  if (total <= 7) {
    for (let number = 1; number <= total; number += 1) pushNumber(number)
  } else {
    pushNumber(1)
    if (current - 2 > 2) numbers.push({ kind: "dots" })
    for (
      let number = Math.max(2, current - 2);
      number <= Math.min(total - 1, current + 2);
      number += 1
    ) {
      pushNumber(number)
    }
    if (current + 2 < total - 1) numbers.push({ kind: "dots" })
    pushNumber(total)
  }
  return {
    label,
    prev: current > 1 ? current - 1 : null,
    next: current < total ? current + 1 : null,
    numbers,
    trailingDots: current === 1 && total > 2 && total <= 7
  }
}

export const wikidotRevisionDate = (
  createdAt: string | number | Date
): { timestamp: number; text: string; className: string } | null => {
  const date = new Date(createdAt)
  if (!Number.isFinite(date.getTime())) return null
  const months = [
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
  ]
  const timestamp = Math.floor(date.getTime() / 1000)
  const day = String(date.getUTCDate()).padStart(2, "0")
  const hour = String(date.getUTCHours()).padStart(2, "0")
  const minute = String(date.getUTCMinutes()).padStart(2, "0")
  return {
    timestamp,
    text: `${day} ${months[date.getUTCMonth()]} ${date.getUTCFullYear()} ${hour}:${minute}`,
    className: `odate time_${timestamp} format_%25e%20%25b%20%25Y%7Cagohover`
  }
}
