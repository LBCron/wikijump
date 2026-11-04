import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.js"

const root = fileURLToPath(new URL("..", import.meta.url))

let previousWorkingDirectory: any
let vite: any
let render: any
let revisionAuthorComponent: any
let wikidotRevisionAuthorComponent: any

before(async () => {
  previousWorkingDirectory = process.cwd()
  process.chdir(root)
  vite = await createTestViteServer()

  ;({ render } = await vite.ssrLoadModule("svelte/server"))
  ;({ default: revisionAuthorComponent } = await vite.ssrLoadModule(
    "/src/routes/[slug]/[...extra]/RevisionAuthor.svelte"
  ))
  ;({ default: wikidotRevisionAuthorComponent } = await vite.ssrLoadModule(
    "/src/routes/[slug]/[...extra]/WikidotRevisionAuthor.svelte"
  ))
})

after(async () => {
  if (vite) await vite.close()
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
})

test("History renders the resolved author name without exposing its numeric ID", () => {
  const body = render(revisionAuthorComponent, {
    props: {
      author: {
        "user-id": -20,
        "user-slug": "history-importer",
        "user-name": "History Importer",
        "user-karma": 0,
        "user-avatar-data": "",
        "user-profile-url": "/-/user/history-importer"
      }
    }
  }).body

  assert.match(
    body,
    /<span class="printuser"><a href="\/-\/user\/history-importer">History Importer<\/a><\/span>/u
  )
  assert.doesNotMatch(body, />-20</u)
})

test("WIKIDOT History author keeps the avatarhover profile and avatar structure", () => {
  const body = render(wikidotRevisionAuthorComponent, {
    props: {
      author: {
        "user-id": 12345,
        "user-slug": "history-author",
        "user-name": "History Author",
        "user-karma": 5,
        "user-avatar-data":
          "http://www.wikidot.com/avatar.php?userid=12345&amp;size=small",
        "user-profile-url": "http://www.wikidot.com/user:info/history-author"
      }
    }
  }).body

  assert.match(body, /<span class="printuser avatarhover">/u)
  assert.match(body, /<img class="small"[^>]+alt="History Author"/u)
  assert.match(
    body,
    /src="https:\/\/www\.wikidot\.com\/avatar\.php\?userid=12345&amp;amp;size=small"/u
  )
  assert.match(
    body,
    /style="background-image:url\(https:\/\/www\.wikidot\.com\/userkarma\.php\?u=12345\)"/u
  )
  assert.match(
    body,
    /<a href="https:\/\/www\.wikidot\.com\/user:info\/history-author">History Author<\/a>/u
  )
})

test("History leaves a missing or deleted author identity neutral", () => {
  const body = render(revisionAuthorComponent, {
    props: { author: null }
  }).body

  assert.equal(body, "<!--[--><!--[-1--><!--]--><!--]-->")
})
