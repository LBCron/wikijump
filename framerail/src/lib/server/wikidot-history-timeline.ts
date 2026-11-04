export const mergeWikidotHistoryTimeline = (
  pageRevisions: Record<string, any>[],
  fileRevisions: Record<string, any>[],
  totalRevisionCount: number
): Record<string, any>[] => {
  const pages: Record<string, any>[] = pageRevisions.map((revision) => ({
    ...revision,
    history_kind: "page",
    history_row_id: String(revision.revision_id),
    page_revision_number: revision.revision_number
  }))
  const files: Record<string, any>[] = fileRevisions.map((revision) => {
    const eventTime = Date.parse(revision.created_at)
    const pageRevisionAtEvent =
      [...pageRevisions]
        .filter((pageRevision) => Date.parse(pageRevision.created_at) <= eventTime)
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ??
      [...pageRevisions].sort(
        (a, b) => Date.parse(a.created_at) - Date.parse(b.created_at)
      )[0]

    return {
      ...revision,
      history_kind: "file",
      history_row_id: String(revision.revision_id),
      page_revision_number: pageRevisionAtEvent?.revision_number ?? null,
      history_action_revision_id: pageRevisionAtEvent?.revision_id ?? null,
      changes: ["files"],
      comments: revision.comments,
      wikitext: null,
      compiled_body_html: null,
      compiled_body_styles: null,
      compiled_top_bar_html: null,
      compiled_side_bar_html: null,
      compiled_at: null,
      compiled_generator: null
    }
  })

  const timeline = [...pages, ...files].sort((a, b) => {
    const timeDifference = Date.parse(b.created_at) - Date.parse(a.created_at)
    if (timeDifference !== 0) return timeDifference
    if (a.history_kind !== b.history_kind) {
      return a.history_kind === "page" ? -1 : 1
    }
    return b.revision_id - a.revision_id
  })

  const pageIds = new Set(pages.map((revision) => revision.history_row_id))
  const seenIds = new Set()
  return timeline.map((revision, index) => {
    let historyRowId = revision.history_row_id
    if (
      revision.history_kind === "file" &&
      (pageIds.has(historyRowId) || seenIds.has(historyRowId))
    ) {
      historyRowId = `file-${historyRowId}`
    }
    seenIds.add(historyRowId)
    return {
      ...revision,
      history_row_id: historyRowId,
      timeline_number: totalRevisionCount - index - 1
    }
  })
}
