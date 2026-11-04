export type HistoryCompareEntry = {
  history_kind: string
  timeline_number: number
  page_revision_number: number | null
}

export const isComparableHistoryRevision = (entry: HistoryCompareEntry): boolean =>
  entry?.history_kind === "page" &&
  entry?.page_revision_number !== null &&
  entry?.page_revision_number !== undefined

export const comparableHistoryTimelineNumbers = (
  entries: HistoryCompareEntry[]
): number[] =>
  [...entries]
    .filter(isComparableHistoryRevision)
    .map((entry) => entry.timeline_number)
    .sort((a, b) => a - b)

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
