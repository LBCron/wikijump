import assert from "node:assert/strict"
import { after, before, test } from "node:test"
import { fileURLToPath } from "node:url"

import { createTestViteServer } from "./vite-test-server.ts"

const root = fileURLToPath(new URL("..", import.meta.url))

let previousWorkingDirectory: any
let vite: any
let post: any
let client: any
let originalClientRequest: any

const SITE_HEADERS = {
  "X-Wikijump-Site-Id": "6000006",
  "X-Wikijump-Site-Slug": "scp-wiki"
}

const voter = {
  user: {
    "user-id": 19_000_001,
    "user-slug": "watcher-fixture",
    "user-name": "Watcher Fixture",
    "user-karma": 0,
    "user-avatar-data": "",
    "user-profile-url": "/-/user/watcher-fixture"
  },
  value: 1
}

const whoRatedForm = (pageId: any) => {
  const form = new URLSearchParams()
  form.set("moduleName", "pagerate/WhoRatedPageModule")
  form.set("pageId", String(pageId))
  form.set("callbackIndex", "client-who-rated")
  return form
}

const postWhoRated = (pageId: any) =>
  post({
    request: new Request("https://scp-wiki.wikijump.test/ajax-module-connector.php", {
      method: "POST",
      headers: {
        ...SITE_HEADERS,
        "content-type": "application/x-www-form-urlencoded"
      },
      body: whoRatedForm(pageId).toString()
    }),
    cookies: { get: () => undefined },
    getClientAddress: () => "127.0.0.1"
  })

before(async () => {
  previousWorkingDirectory = process.cwd()
  process.chdir(root)
  vite = await createTestViteServer()

  ;({ client } = await vite.ssrLoadModule("/src/lib/server/deepwell/index.ts"))
  originalClientRequest = client.request
  ;({ POST: post } = await vite.ssrLoadModule(
    "/src/routes/ajax-module-connector.php/+server.ts"
  ))
})

after(async () => {
  if (client && originalClientRequest) client.request = originalClientRequest
  if (vite) await vite.close()
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
})

test("imported page with a baseline but no local votes answers the honest unavailable roster", async () => {
  client.request = async (method: any) => {
    if (method === "page_who_rated") return []
    if (method === "page_get_score") {
      return { page_id: 3000000026, score: 461 }
    }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const response = await postWhoRated(3000000026)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.status, "ok")
  assert.match(
    body.body,
    /<p class="who-rated-unavailable">The voter list for this imported page is unavailable because its historical votes were not imported\.<\/p>/u
  )
  assert.doesNotMatch(body.body, /-moz-column-count/u)
})

test("page with no score and no votes answers the pinned empty roster", async () => {
  client.request = async (method: any) => {
    if (method === "page_who_rated") return []
    if (method === "page_get_score") {
      return { page_id: 3000000026, score: 0 }
    }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const response = await postWhoRated(3000000026)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.status, "ok")
  assert.match(body.body, /-moz-column-count/u)
  assert.doesNotMatch(body.body, /who-rated-unavailable/u)
})

test("page with local votes answers the printuser roster", async () => {
  client.request = async (method: any) => {
    if (method === "page_who_rated") return [voter]
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const response = await postWhoRated(3000000026)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.status, "ok")
  assert.match(body.body, /Watcher Fixture/u)
  assert.doesNotMatch(body.body, /who-rated-unavailable/u)
})
