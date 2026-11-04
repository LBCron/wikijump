import assert from "node:assert/strict"
import test from "node:test"

import { mergeWikidotHistoryTimeline } from "../src/lib/server/wikidot-history-timeline.ts"
import { renderWikidotPageRevisionList } from "../src/lib/server/ajax-module-connector-page-reads.ts"

const author = {
  "user-id": 52,
  "user-slug": "file-editor",
  "user-name": "File Editor",
  "user-karma": 0,
  "user-avatar-data": "",
  "user-profile-url": "https://www.wikidot.com/user:info/file-editor"
}

test("places the captured file deletion between page rows 38 and 36", () => {
  const pageRevisions = [
    {
      revision_id: 100,
      revision_number: 40,
      created_at: "2026-09-25T03:24:31Z",
      page_id: 7,
      site_id: 1,
      user_id: 52,
      author,
      changes: ["wikitext"],
      comments: "Newer page edit"
    },
    {
      revision_id: 103,
      revision_number: 39,
      created_at: "2026-09-03T15:48:56Z",
      page_id: 7,
      site_id: 1,
      user_id: 52,
      author,
      changes: ["wikitext"],
      comments: "Newer page edit"
    },
    {
      revision_id: 102,
      revision_number: 38,
      created_at: "2026-08-11T13:33:07Z",
      page_id: 7,
      site_id: 1,
      user_id: 52,
      author,
      changes: ["wikitext"],
      comments: "Newer page edit"
    },
    {
      revision_id: 101,
      revision_number: 37,
      created_at: "2024-02-21T12:34:20Z",
      page_id: 7,
      site_id: 1,
      user_id: 52,
      author,
      changes: ["wikitext"],
      comments: "Newer page edit"
    },
    {
      revision_id: 99,
      revision_number: 35,
      created_at: "2022-04-12T05:14:31Z",
      page_id: 7,
      site_id: 1,
      user_id: 52,
      author,
      changes: ["wikitext"],
      comments: "Page revision 36"
    }
  ]
  const fileRevisions = [
    {
      revision_id: 100,
      revision_number: 0,
      revision_type: "delete",
      created_at: "2022-04-12T05:15:25Z",
      file_id: 3,
      page_id: 7,
      site_id: 1,
      user_id: 52,
      author,
      changes: ["blob"],
      comments: 'File "image.png" deleted'
    }
  ]

  const history = mergeWikidotHistoryTimeline(pageRevisions, fileRevisions, 41)
  assert.deepEqual(
    history.slice(3, 6).map((entry) => [entry.history_kind, entry.timeline_number + 1]),
    [
      ["page", 38],
      ["file", 37],
      ["page", 36]
    ]
  )
  assert.equal(history[4].page_revision_number, 35)
  assert.equal(history[4].history_action_revision_id, 99)
  assert.deepEqual(history[4].changes, ["files"])
  assert.equal(history[4].history_row_id, "file-100")
})

test("renders a file event as the observed seven-cell F row without page rollback", () => {
  const body = renderWikidotPageRevisionList([
    {
      revision_id: 101,
      revision_number: 36,
      timeline_number: 37,
      history_kind: "page",
      history_row_id: "101",
      created_at: "2022-04-12T05:16:00Z",
      user_id: 52,
      author,
      changes: ["wikitext"],
      comments: "Latest page edit"
    },
    {
      revision_id: 100,
      revision_number: 0,
      timeline_number: 36,
      history_kind: "file",
      history_row_id: "100",
      history_action_revision_id: 101,
      created_at: "2022-04-12T05:15:25Z",
      user_id: 52,
      author,
      changes: ["files"],
      comments: 'File "image.png" deleted'
    }
  ])

  const row = /<tr id="revision-row-100">([\s\S]*?)<\/tr>/u.exec(body)?.[1]
  assert.ok(row)
  assert.equal([...row.matchAll(/<td\b/gu)].length, 7)
  assert.match(row, /<td>37\.<\/td>/u)
  assert.match(
    row,
    /<span class="spantip" title="file\/attachment operations">F<\/span>/u
  )
  assert.match(
    row,
    /class="optionstd"><a title="View page revision" href="javascript:;" onclick="showVersion\(101\)">V<\/a> <a title="View source of the revision" href="javascript:;" onclick="showSource\(101\)">S<\/a><\/td>/u
  )
  assert.doesNotMatch(row, />R<\/a>/u)
  assert.match(row, /class="printuser avatarhover"/u)
  assert.match(row, /class="odate time_1649740525/u)
  assert.match(row, /File &quot;image\.png&quot; deleted/u)
})
