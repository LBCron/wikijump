export type HistoryCompareEntry = {
  history_kind: string
  timeline_number: number
  page_revision_number: number | null
}

/**
 * A history entry is source-comparable only when it is a page-source
 * revision with a backing page revision number. File/attachment events are
 * timeline entries, not page source revisions, so the revision-diff
 * selector must never offer them as comparison endpoints. Refs #2143.
 */
export const isComparableHistoryRevision = (entry: HistoryCompareEntry): boolean =>
  entry?.history_kind === "page" &&
  entry?.page_revision_number !== null &&
  entry?.page_revision_number !== undefined

/** Timeline numbers the revision-diff selector may offer, oldest first. */
export const comparableHistoryTimelineNumbers = (
  entries: HistoryCompareEntry[]
): number[] =>
  [...entries]
    .filter(isComparableHistoryRevision)
    .map((entry) => entry.timeline_number)
    .sort((a, b) => a - b)

/**
 * Choose the newest two distinct page-source revisions from a mixed
 * history timeline. File events remain visible in the timeline, but they
 * are not page source revisions and cannot be sent to the revision-diff
 * action directly. Returns the older and newer timeline numbers.
 */
export const defaultHistoryComparePair = (
  entries: HistoryCompareEntry[]
): [number, number] | undefined => {
  const seenPageRevisions = new Set<number | null>()
  const timelineNumbers: number[] = []

  for (const entry of [...entries].sort(
    (a, b) => b.timeline_number - a.timeline_number
  )) {
    if (
      !isComparableHistoryRevision(entry) ||
      seenPageRevisions.has(entry.page_revision_number)
    ) {
      continue
    }

    seenPageRevisions.add(entry.page_revision_number)
    timelineNumbers.push(entry.timeline_number)
    if (timelineNumbers.length === 2) break
  }

  if (timelineNumbers.length < 2) return undefined
  return [timelineNumbers[1], timelineNumbers[0]] as [number, number]
}
