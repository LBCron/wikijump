import assert from "node:assert/strict"
import { test } from "node:test"

import {
  filterHistoryByTypes,
  HISTORY_FILTER_TYPES,
  HISTORY_PER_PAGE_OPTIONS,
  historyEntryMatchesTypes,
  historyPagerModel,
  paginateHistoryEntries
} from "../src/lib/wikidot-history-contract.ts"

const pageEntry = (changes: string[], revisionType = "regular") => ({
  history_kind: "page",
  revision_type: revisionType,
  changes
})
const fileEntry = () => ({ history_kind: "file", revision_type: "regular", changes: [] })

test("filter keys cover the frozen Wikidot control set", () => {
  assert.deepEqual(HISTORY_FILTER_TYPES, [
    "source",
    "title",
    "move",
    "tags",
    "meta",
    "files"
  ])
  assert.deepEqual(HISTORY_PER_PAGE_OPTIONS, [20, 50, 100, 200])
})

test("empty and all selections are unfiltered like live Wikidot", () => {
  const entries = [pageEntry(["title"]), fileEntry(), pageEntry([], "move")]
  assert.deepEqual(filterHistoryByTypes(entries, []), entries)
  assert.deepEqual(filterHistoryByTypes(entries, ["all"]), entries)
  assert.deepEqual(filterHistoryByTypes(entries, undefined), entries)
})

test("each filter key matches its revision kind", () => {
  assert.equal(historyEntryMatchesTypes(pageEntry(["wikitext"]), ["source"]), true)
  assert.equal(historyEntryMatchesTypes(pageEntry(["title"]), ["title"]), true)
  assert.equal(historyEntryMatchesTypes(pageEntry(["alt_title"]), ["title"]), true)
  assert.equal(historyEntryMatchesTypes(pageEntry(["slug"]), ["move"]), true)
  assert.equal(historyEntryMatchesTypes(pageEntry(["tags"]), ["tags"]), true)
  assert.equal(historyEntryMatchesTypes(pageEntry(["parent"]), ["meta"]), true)
  assert.equal(historyEntryMatchesTypes(fileEntry(), ["files"]), true)
  assert.equal(historyEntryMatchesTypes(pageEntry([], "move"), ["move"]), true)
})

test("filter keys reject other kinds", () => {
  assert.equal(historyEntryMatchesTypes(pageEntry(["wikitext"]), ["title"]), false)
  assert.equal(historyEntryMatchesTypes(pageEntry(["tags"]), ["meta"]), false)
  assert.equal(historyEntryMatchesTypes(fileEntry(), ["source"]), false)
  assert.equal(historyEntryMatchesTypes(pageEntry(["wikitext"]), ["files"]), false)
  assert.equal(historyEntryMatchesTypes(pageEntry([], "regular"), ["source"]), false)
})

test("combined selections union like the Wikidot options object", () => {
  const source = pageEntry(["wikitext"])
  const tagged = pageEntry(["tags"])
  const file = fileEntry()
  assert.deepEqual(filterHistoryByTypes([source, tagged, file], ["source", "files"]), [
    source,
    file
  ])
})

test("pagination slices and clamps with global continuity", () => {
  const entries = Array.from({ length: 50 }, (_, index) => ({
    timeline_number: 49 - index
  }))
  const first = paginateHistoryEntries(entries, 1, 20)
  assert.equal(first.entries.length, 20)
  assert.equal(first.entries[0].timeline_number, 49)
  assert.deepEqual(
    [first.total, first.page, first.perPage, first.totalPages],
    [50, 1, 20, 3]
  )
  const last = paginateHistoryEntries(entries, 3, 20)
  assert.equal(last.entries.length, 10)
  assert.equal(last.entries[9].timeline_number, 0)
  const clamped = paginateHistoryEntries(entries, 9, 20)
  assert.equal(clamped.page, 3)
  assert.equal(paginateHistoryEntries([], 1, 20).totalPages, 1)
})

test("pager label matches the frozen list-module chrome", () => {
  assert.equal(historyPagerModel(1, 2).label, "page 1 of 2")
  assert.equal(historyPagerModel(1, 3).label, "page 1")
  assert.equal(historyPagerModel(2, 3).label, "page 2 of 3")
  assert.equal(historyPagerModel(3, 3).label, "page 3 of 3")
  assert.equal(historyPagerModel(2, 2).label, "page 2 of 2")
})

test("pager navigation links match the frozen chrome", () => {
  const first = historyPagerModel(1, 3)
  assert.equal(first.prev, null)
  assert.equal(first.next, 2)
  assert.deepEqual(
    first.numbers.map((segment) => (segment as { page?: number }).page ?? "dots"),
    [1, 2, 3]
  )
  assert.equal(first.trailingDots, true)
  const second = historyPagerModel(2, 3)
  assert.deepEqual([second.prev, second.next], [1, 3])
  assert.equal(second.trailingDots, false)
  const last = historyPagerModel(3, 3)
  assert.deepEqual([last.prev, last.next], [2, null])
  const twoPage = historyPagerModel(1, 2)
  assert.equal(twoPage.trailingDots, false)
  assert.equal(twoPage.next, 2)
})

test("large pagers window around the current page", () => {
  const middle = historyPagerModel(5, 10)
  assert.deepEqual(
    middle.numbers.map((segment) => (segment.kind === "dots" ? "dots" : segment.page)),
    [1, "dots", 3, 4, 5, 6, 7, "dots", 10]
  )
  const start = historyPagerModel(1, 10)
  assert.deepEqual(
    start.numbers.map((segment) => (segment.kind === "dots" ? "dots" : segment.page)),
    [1, 2, 3, "dots", 10]
  )
})
