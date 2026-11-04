import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { describe, it } from "node:test"

import { parseUserLocalePreferences } from "../src/lib/user-settings.ts"

describe("authoring workflows", () => {
  it("normalizes ordered display-language preferences before persistence", () => {
    assert.deepEqual(parseUserLocalePreferences("ja_JP, en-US  ja_JP"), [
      "ja-JP",
      "en-US"
    ])
    assert.deepEqual(parseUserLocalePreferences("  "), [])
  })

  it("replaces the settings placeholder with an authenticated persisted form", async () => {
    const page = await readFile(
      new URL("../src/routes/[x+2d]/settings/+page.svelte", import.meta.url),
      "utf8"
    )
    const server = await readFile(
      new URL("../src/routes/[x+2d]/settings/+page.server.ts", import.meta.url),
      "utf8"
    )
    const loader = await readFile(
      new URL("../src/lib/server/load/user-settings.ts", import.meta.url),
      "utf8"
    )

    assert.doesNotMatch(page, /UNTRANSLATED:TODO/u)
    assert.match(page, /id="user-settings-form"/u)
    assert.match(page, /name="locales"/u)
    assert.match(page, /action="\?\/display"/u)
    assert.match(server, /loadUserSettings/u)
    assert.match(server, /display: userDisplaySettingsAction/u)
    assert.match(loader, /if \(!parentData\.user_session\?\.user\.user_id\)/u)
    assert.match(loader, /authGetSession\(sessionToken\)/u)
    assert.match(loader, /userEdit\(/u)
    assert.match(loader, /parseUserLocalePreferences/u)
  })

  it("connects a typed revision diff to the history pane without raw HTML", async () => {
    const client = await readFile(
      new URL("../src/lib/server/deepwell/page.ts", import.meta.url),
      "utf8"
    )
    const actions = await readFile(
      new URL("../src/lib/server/load/page/page-revision-actions.ts", import.meta.url),
      "utf8"
    )
    const actionRegistry = await readFile(
      new URL("../src/lib/server/load/page/page-actions.ts", import.meta.url),
      "utf8"
    )
    const pane = await readFile(
      new URL("../src/routes/[slug]/[...extra]/HistoryPane.svelte", import.meta.url),
      "utf8"
    )

    assert.match(client, /export interface PageRevisionDiffOutput/u)
    assert.match(client, /"page_revision_diff"/u)
    assert.match(actions, /export async function pageRevisionDiffAction/u)
    assert.match(actionRegistry, /revisionDiff: pageRevisionDiffAction/u)
    assert.match(pane, /class="revision-diff-controls"/u)
    assert.match(pane, /class="revision-diff"/u)
    assert.match(pane, /line\.kind/u)
    assert.match(pane, /\{line\.text\}/u)
    assert.doesNotMatch(pane, /@html\s+line\.text/u)
  })
})
