import assert from "node:assert/strict"
import test from "node:test"

import { resolveWikidotHashMagicPagePane } from "../src/lib/wikidot/wikidot-hash-magic.ts"

test("resolves the existing history and files panes case-insensitively", () => {
  assert.equal(
    resolveWikidotHashMagicPagePane("https://example.test/page#_HiStOrY"),
    "history"
  )
  assert.equal(
    resolveWikidotHashMagicPagePane("https://example.test/page#_FILES"),
    "files"
  )
})

test("matches Wikidot's word command and ignores a non-word suffix", () => {
  for (const href of [
    "https://example.test/page#_history/p/2",
    "https://example.test/page#_history?view=all",
    "https://example.test/page#_history%2Fp%2F2",
    "https://example.test/page#_history-extra"
  ]) {
    assert.equal(resolveWikidotHashMagicPagePane(href), "history", href)
  }

  assert.equal(
    resolveWikidotHashMagicPagePane("https://example.test/page#prefix#_files/ignored"),
    "files"
  )
})

test("resolves the verified edit-page and edit-tags commands case-insensitively", () => {
  for (const [hash, pane] of [
    ["#_editpage", "edit-page"],
    ["#_edittags", "edit-tags"],
    ["#_EditPage", "edit-page"],
    ["#_EDITPAGE", "edit-page"],
    ["#_EditTags", "edit-tags"]
  ] as const) {
    assert.equal(
      resolveWikidotHashMagicPagePane(`https://example.test/page${hash}`),
      pane,
      hash
    )
  }

  assert.equal(
    resolveWikidotHashMagicPagePane("https://example.test/page#_editpage/extra"),
    "edit-page"
  )
})

test("does not widen word continuations or unsupported Hash Magic commands", () => {
  for (const href of [
    "https://example.test/page",
    "https://example.test/page#history",
    "https://example.test/page#_historyextra",
    "https://example.test/page#_history_extra",
    "https://example.test/page#_sitetools",
    "https://example.test/page#_",
    "https://example.test/page#_nonexistent",
    "https://example.test/page#_backlinks",
    "https://example.test/page#_viewsource",
    "https://example.test/page#_edit-page",
    "https://example.test/page#_edittag"
  ]) {
    assert.equal(resolveWikidotHashMagicPagePane(href), null, href)
  }
})
