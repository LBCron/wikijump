import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const read = (relativePath) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")

test("the public AMC route wires ListDrafts to its persisted renderer", async () => {
  const [route, renderer, deepwellPage, connector, editLease] = await Promise.all([
    read("src/routes/ajax-module-connector.php/+server.ts"),
    read("src/lib/server/wikidot-site-tools.js"),
    read("src/lib/server/deepwell/page.ts"),
    read("src/lib/server/ajax-module-connector.js"),
    read("src/lib/server/ajax-module-connector-edit-lease.js")
  ])

  assert.match(route, /renderWikidotListDrafts/u)
  assert.match(
    route,
    /moduleName === "list\/ListDraftsModule"[\s\S]*siteToolsListDrafts\([\s\S]*renderWikidotListDrafts\(drafts\)/u
  )
  assert.match(renderer, /class="list-drafts-box"/u)
  assert.match(renderer, /class="list-drafts-item"/u)

  for (const name of ["pageDraftSave", "pageDraftExists", "pageDraftRemove"]) {
    assert.match(route, new RegExp(`\\b${name}\\b`, "u"), name)
    assert.match(deepwellPage, new RegExp(`export async function ${name}\\b`, "u"), name)
  }
  assert.match(connector, /handlePageDraftEvents/u)
  assert.match(editLease, /pageDraftEvent === "synchronize"/u)
  assert.match(editLease, /pageDraftEvent === "checkDraftExists"/u)
  assert.match(editLease, /leaveDraft === "false"/u)
})
