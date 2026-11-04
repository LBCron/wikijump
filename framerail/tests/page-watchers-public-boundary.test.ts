import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.ts"

const root = fileURLToPath(new URL("..", import.meta.url))

let previousWorkingDirectory: any
let vite: any
let render: any
let watchersList: any
let client: any
let originalClientRequest: any
let pageWatchersAction: any

before(async () => {
  previousWorkingDirectory = process.cwd()
  process.chdir(root)
  vite = await createTestViteServer()

  ;({ render } = await vite.ssrLoadModule("svelte/server"))
  ;({ client } = await vite.ssrLoadModule("/src/lib/server/deepwell/index.ts"))
  originalClientRequest = client.request
  ;({ pageWatchersAction } = await vite.ssrLoadModule(
    "/src/lib/server/load/page/page-relation-actions.ts"
  ))
  ;({ default: watchersList } = await vite.ssrLoadModule(
    "/src/routes/[slug]/[...extra]/WatchersList.svelte"
  ))
})

after(async () => {
  if (client && originalClientRequest) client.request = originalClientRequest
  if (vite) await vite.close()
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
})

test("Watchers renders typed public identities without exposing an untyped ID", () => {
  const body = render(watchersList, {
    props: {
      watchers: [
        {
          "user-id": 19_000_001,
          "user-slug": "watcher-fixture",
          "user-name": "Watcher Fixture",
          "user-karma": 0,
          "user-avatar-data": "",
          "user-profile-url": "/-/user/watcher-fixture"
        }
      ]
    }
  }).body

  assert.match(body, /<ul class="page-watchers-list">/u)
  assert.match(
    body,
    /<span class="printuser"><a href="\/-\/user\/watcher-fixture">Watcher Fixture<\/a><\/span>/u
  )
  assert.doesNotMatch(body, /19000001/u)
  assert.equal(
    body,
    '<!--[--><ul class="page-watchers-list"><!--[--><li><!--[0--><span class="printuser"><a href="/-/user/watcher-fixture">Watcher Fixture</a></span><!--]--><!----></li><!--]--></ul><!--]-->'
  )
})

test("Watchers action derives the site from trusted context and remains anonymous", async () => {
  const calls: any[] = []
  client.request = async (method: any, params: any, context: any) => {
    calls.push({ method, params, context })
    if (method === "page_watchers") {
      return [
        {
          "user-id": 19_000_001,
          "user-slug": "watcher-fixture",
          "user-name": "Watcher Fixture",
          "user-karma": 0,
          "user-avatar-data": "",
          "user-profile-url": "/-/user/watcher-fixture"
        }
      ]
    }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const result = await pageWatchersAction({
    request: new Request("https://wikijump.test/fixture?/watchers", {
      method: "POST",
      body: JSON.stringify({ pageId: 42 }),
      headers: {
        "content-type": "application/json",
        "X-Wikijump-Site-Id": "17",
        "X-Wikijump-Site-Slug": "test"
      }
    }),
    params: { slug: "fixture" },
    cookies: { get: () => undefined },
    locals: {
      requestContext: {
        siteId: 17,
        page: "fixture"
      }
    }
  })

  assert.equal(result.res[0]["user-name"], "Watcher Fixture")
  assert.deepEqual(calls, [
    {
      method: "page_watchers",
      params: { site_id: 17, page_id: 42 },
      context: { siteId: 17, page: "fixture" }
    }
  ])
})
