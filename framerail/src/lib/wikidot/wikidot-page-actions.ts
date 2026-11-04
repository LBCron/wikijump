import { isJapaneseWikidotLocale } from "./wikidot-locale.ts"

const WIKIDOT_SITES_WITHOUT_STANDARD_PAGE_ACTIONS = new Set(["sandbox-for-codex"])

export type WikidotPageActionLabels = {
  rate: string
  ratePrefix: string
  ratingText: string | null
  discuss: string
  discussHref?: string | null
  showRate: boolean
  showDiscuss: boolean
  edit: string
  tags: string
  history: string
  files: string
  print: string
  siteTools: string
  options: string
  append: string
  backlinks: string
  viewSource: string
  parent: string
  rename: string
  editSections: string
  editMeta: string
  watchers: string
  lock: string
  delete: string
}

export const isWikidotFragmentPage = (
  tags: readonly string[] | null | undefined
): boolean => tags?.includes("fragment") ?? false

export const openWikidotPrinterFriendly = (
  pagePath: string,
  browser: { open: (url: string, target: string) => unknown } = window
) => browser.open(`/printer--friendly/${pagePath}`, "_blank")

export const sourceShowsStandardWikidotPageActions = (
  sourceSite: string | null | undefined
): boolean => {
  return !WIKIDOT_SITES_WITHOUT_STANDARD_PAGE_ACTIONS.has(sourceSite ?? "")
}

export const wikidotOpenPanePermissionKind = (
  pane: string
): "edit" | "move" | "delete" | null => {
  switch (pane) {
    case "append":
    case "parent":
    case "lock":
      return "edit"
    case "move":
      return "move"
    case "delete":
      return "delete"
    default:
      return null
  }
}

export type WikidotPageDiscussionResponse = {
  status?: string
  message?: string
  thread_id?: number
  thread_unix_title?: string
}

export const requestWikidotPageDiscussion = async (
  fetchImplementation: typeof fetch,
  pageId: number
): Promise<WikidotPageDiscussionResponse> => {
  if (!Number.isSafeInteger(pageId) || pageId <= 0) {
    throw new TypeError("A positive page ID is required to open its discussion.")
  }

  const form = new URLSearchParams({
    moduleName: "Empty",
    page_id: String(pageId),
    action: "ForumAction",
    event: "createPageDiscussionThread"
  })
  const response = await fetchImplementation("/ajax-module-connector.php", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: form.toString()
  })
  return response.json()
}

export const wikidotPageDiscussionPath = (response: WikidotPageDiscussionResponse) => {
  const threadId = response?.thread_id
  if (
    response?.status !== "ok" ||
    typeof threadId !== "number" ||
    !Number.isSafeInteger(threadId) ||
    threadId <= 0 ||
    typeof response.thread_unix_title !== "string" ||
    response.thread_unix_title.length === 0
  ) {
    return null
  }
  return `/forum/t-${threadId}/${response.thread_unix_title}`
}

export const wikidotPageDiscussHref = ({
  discussionThreadId,
  pageSlug
}: {
  discussionThreadId?: number | null
  pageSlug?: string | null
}): string | null => {
  if (
    typeof discussionThreadId !== "number" ||
    !Number.isSafeInteger(discussionThreadId) ||
    discussionThreadId <= 0 ||
    typeof pageSlug !== "string" ||
    !/^[a-z0-9_-]+(?::[a-z0-9_-]+)?$/u.test(pageSlug)
  ) {
    return null
  }
  return `/forum/t-${discussionThreadId}/${pageSlug}`
}

export const wikidotPageActionVisibility = ({
  sourceSite,
  ratingEnabled,
  discussionEnabled,
  sourceCommentCount
}: {
  sourceSite?: string | null
  ratingEnabled: boolean
  discussionEnabled: boolean
  discussionThreadId?: number | null
  sourceCommentCount?: number | null
}): { showRate: boolean; showDiscuss: boolean } => {
  const sourceShowsActions = sourceShowsStandardWikidotPageActions(sourceSite)
  return {
    showRate: sourceShowsActions && ratingEnabled,
    showDiscuss:
      sourceShowsActions && (discussionEnabled || (sourceCommentCount ?? 0) > 0)
  }
}

export const selectWikidotPageRating = ({
  combinedRating = null,
  importedRating = null
}: {
  combinedRating?: number | null
  importedRating?: number | null
} = {}): number | null => {
  if (typeof combinedRating === "number" && Number.isFinite(combinedRating)) {
    return combinedRating
  }
  if (typeof importedRating === "number" && Number.isFinite(importedRating)) {
    return importedRating
  }
  return null
}

export const buildWikidotPageActionLabels = ({
  rating,
  comments,
  locale = "en",
  showRate = true,
  showDiscuss = true
}: {
  rating?: number | null
  comments?: number | null
  locale?: string | null
  showRate?: boolean
  showDiscuss?: boolean
}): WikidotPageActionLabels => {
  const ratingText = rating === null || rating === undefined ? null : formatSigned(rating)
  const labels = isJapaneseWikidotLocale(locale)
    ? {
        edit: "編集",
        ratePrefix: "評価",
        tags: "タグ",
        discuss: "ディスカッション",
        history: "履歴",
        files: "ファイル",
        print: "印刷",
        siteTools: "サイトツール",
        options: "オプション",
        append: "追加",
        backlinks: "バックリンク",
        viewSource: "ページソース",
        parent: "親ページ",
        rename: "リネーム",
        editSections: "セクションを編集",
        editMeta: "メタを編集",
        watchers: "ウォッチャー",
        lock: "ページロック",
        delete: "削除"
      }
    : {
        edit: "Edit",
        ratePrefix: "Rate",
        tags: "Tags",
        discuss: "Discuss",
        history: "History",
        files: "Files",
        print: "Print",
        siteTools: "Site tools",
        options: "Options",
        append: "Append",
        backlinks: "Backlinks",
        viewSource: "Page Source",
        parent: "Parent",
        rename: "Rename",
        editSections: "Edit Sections",
        editMeta: "Edit Meta",
        watchers: "Watchers",
        lock: "Lock Page",
        delete: "Delete"
      }

  return {
    ratingText,
    showRate,
    showDiscuss,
    edit: labels.edit,
    ratePrefix: labels.ratePrefix,
    rate:
      ratingText === null ? labels.ratePrefix : `${labels.ratePrefix} (${ratingText})`,
    tags: labels.tags,
    discuss:
      comments === null || comments === undefined
        ? labels.discuss
        : `${labels.discuss} (${comments})`,
    history: labels.history,
    files: labels.files,
    print: labels.print,
    siteTools: labels.siteTools,
    options: labels.options,
    append: labels.append,
    backlinks: labels.backlinks,
    viewSource: labels.viewSource,
    parent: labels.parent,
    rename: labels.rename,
    editSections: labels.editSections,
    editMeta: labels.editMeta,
    watchers: labels.watchers,
    lock: labels.lock,
    delete: labels.delete
  }
}

export const formatSigned = (value: number): string => {
  return value > 0 ? `+${value}` : `${value}`
}
