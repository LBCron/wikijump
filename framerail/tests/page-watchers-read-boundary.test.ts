import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"

import { createTestViteServer } from "./vite-test-server.ts"

const root = fileURLToPath(new URL("..", import.meta.url))

let previousWorkingDirectory: any
let vite: any
let render: any
let watchersPane: any
let watchersList: any
let client: any
let originalClientRequest: any
let pageWatchersAction: any

const fixtureWatchers = [
  {
    "user-id": 19_000_001,
    "user-slug": "watcher-fixture",
    "user-name": "Watcher Fixture",
    "user-karma": 0,
    "user-avatar-data": "",
    "user-profile-url": "/-/user/watcher-fixture"
  },
  {
    "user-id": 19_000_002,
    "user-slug": "second-watcher",
    "user-name": "Second Watcher",
    "user-karma": 0,
    "user-avatar-data": "",
    "user-profile-url": "/-/user/second-watcher"
  }
]

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
  ;({ default: watchersPane } = await vite.ssrLoadModule(
    "/src/routes/[slug]/[...extra]/WatchersPane.svelte"
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

test("WatchersList SSR renders the roster as public identities", () => {
  const body = render(watchersList, { props: { watchers: fixtureWatchers } }).body

  assert.match(body, /<ul[^>]*class="page-watchers-list"/u)
  assert.equal(body.match(/<li>/g)?.length ?? 0, 2)
  assert.match(body, /<a href="\/-\/user\/watcher-fixture">Watcher Fixture<\/a>/u)
  assert.match(body, /<a href="\/-\/user\/second-watcher">Second Watcher<\/a>/u)
})

test("WatchersList SSR renders an empty roster as an empty list", () => {
  const body = render(watchersList, { props: { watchers: [] } }).body

  assert.match(body, /<ul[^>]*class="page-watchers-list"/u)
  assert.doesNotMatch(body, /<li>/u)
})

test("WatchersPane SSR exposes a lazy read pane with no roster and no denial", () => {
  const body = render(watchersPane, {
    props: {
      data: {
        site: { site_id: 17 },
        page: { page_id: 42, slug: "fixture", from_wikidot: true },
        wikidot_page_actions: { watchers: "Watchers" }
      }
    }
  }).body

  assert.match(body, /<h1[^>]*class="page-watchers-header"[^>]*>Watchers<\/h1>/u)
  assert.match(body, /role="status"/u)
  assert.doesNotMatch(body, /page-watchers-list/u)
  assert.doesNotMatch(body, /subscriptions were not imported/u)
  assert.doesNotMatch(body, /Could not load watchers/u)
  assert.doesNotMatch(body, /page[_-]id/u)
})

test("Watchers handler delegates the posted page id to the typed Deepwell view", async () => {
  const calls: any[] = []
  client.request = async (method: any, params: any, context: any) => {
    calls.push({ method, params, context })
    if (method === "page_watchers") {
      return fixtureWatchers
    }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const request = new Request("https://wikijump.test/fixture?/watchers", {
    method: "POST",
    body: JSON.stringify({ pageId: 42 }),
    headers: {
      "X-Wikijump-Site-Id": "17",
      "X-Wikijump-Site-Slug": "test"
    }
  })

  const result = await pageWatchersAction({
    request,
    params: { slug: "fixture" },
    locals: {
      requestContext: {
        siteId: 17,
        page: "fixture"
      }
    }
  })

  assert.deepEqual(result.res, fixtureWatchers)
  assert.deepEqual(calls, [
    {
      method: "page_watchers",
      params: { site_id: 17, page_id: 42 },
      context: { siteId: 17, page: "fixture" }
    }
  ])
})
