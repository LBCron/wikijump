import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const routedSiteId = 17
const sessionToken = "forum-nesting-session"

let previousWorkingDirectory: any
let vite: any
let client: any
let originalClientRequest: any
let discussionAction: any
let forumNestingAction: any
let ratingAction: any
let siteIconsAction: any

before(async () => {
  previousWorkingDirectory = process.cwd()
  process.chdir(root)
  vite = await createTestViteServer()

  ;({ client } = await vite.ssrLoadModule("/src/lib/server/deepwell/index.ts"))
  originalClientRequest = client.request
  ;({ discussionAction, forumNestingAction, ratingAction, siteIconsAction } =
    await vite.ssrLoadModule("/src/lib/server/load/admin.ts"))
})

after(async () => {
  if (client && originalClientRequest) client.request = originalClientRequest
  if (vite) await vite.close()
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
})

const actionEvent = (action: any, submittedSiteId: any, fields: any) => {
  const data = new FormData()
  data.set("siteId", String(submittedSiteId))
  for (const [name, value] of Object.entries(fields)) data.set(name, String(value))

  return {
    request: new Request(`https://wikijump.test/--/admin?/${action}`, {
      method: "POST",
      body: data,
      headers: {
        "X-Wikijump-Site-Id": String(routedSiteId),
        "X-Wikijump-Site-Slug": "test"
      }
    }),
    cookies: { get: () => sessionToken },
    getClientAddress: () => "192.0.2.63"
  }
}

test("forum nesting updates stay bound to the routed site", async () => {
  const calls: any[] = []
  client.request = async (method: any, params: any, context: any) => {
    calls.push({ method, params, context })
    if (method === "session_get") return { user_id: 41 }
    if (method === "site_update") return { settings_revision: 5 }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const fields = { expectedSettingsRevision: 4, maxNestLevel: 3 }
  const denied = await forumNestingAction(actionEvent("forumNesting", 999, fields))
  assert.equal(denied.status, 403)
  assert.deepEqual(calls, [])

  calls.length = 0
  const result = await forumNestingAction(
    actionEvent("forumNesting", routedSiteId, fields)
  )
  assert.equal(result.form.valid, true)
  assert.deepEqual(calls, [
    {
      method: "session_get",
      params: [sessionToken],
      context: undefined
    },
    {
      method: "site_update",
      params: {
        site: routedSiteId,
        expected_settings_revision: 4,
        user_id: 41,
        forum_max_nest_level: 3,
        ip_address: "192.0.2.63"
      },
      context: { sessionToken, siteId: routedSiteId }
    }
  ])
})

test("discussion updates stay bound to the routed site", async () => {
  const calls: any[] = []
  client.request = async (method: any, params: any, context: any) => {
    calls.push({ method, params, context })
    if (method === "session_get") return { user_id: 41 }
    if (method === "category_update") return { category_id: 23 }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const fields = { categoryId: 23, state: "enable" }
  const denied = await discussionAction(actionEvent("discussion", 999, fields))
  assert.equal(denied.status, 403)
  assert.deepEqual(calls, [])

  const result = await discussionAction(actionEvent("discussion", routedSiteId, fields))
  assert.equal(result.form.valid, true)
  assert.deepEqual(calls, [
    {
      method: "session_get",
      params: [sessionToken],
      context: undefined
    },
    {
      method: "category_update",
      params: {
        site: routedSiteId,
        category: 23,
        user_id: 41,
        per_page_discussion: true,
        ip_address: "192.0.2.63"
      },
      context: { sessionToken, siteId: routedSiteId }
    }
  ])
})

test("rating updates stay bound to the routed site", async () => {
  const calls: any[] = []
  client.request = async (method: any, params: any, context: any) => {
    calls.push({ method, params, context })
    if (method === "session_get") return { user_id: 41 }
    if (method === "category_update") return { category_id: 23 }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const fields = {
    categoryId: 23,
    inherit: false,
    enabled: true,
    permission: "members",
    visibility: "anonymous",
    ratingType: "plus_minus"
  }
  const denied = await ratingAction(actionEvent("rating", 999, fields))
  assert.equal(denied.status, 403)
  assert.deepEqual(calls, [])

  const result = await ratingAction(actionEvent("rating", routedSiteId, fields))
  assert.equal(result.form.valid, true)
  assert.deepEqual(calls, [
    {
      method: "session_get",
      params: [sessionToken],
      context: undefined
    },
    {
      method: "category_update",
      params: {
        site: routedSiteId,
        category: 23,
        user_id: 41,
        rating_enabled: true,
        rating_permission: "members",
        rating_visibility: "anonymous",
        rating_type: "plus_minus",
        ip_address: "192.0.2.63"
      },
      context: { sessionToken, siteId: routedSiteId }
    }
  ])
})

test("site icon updates stay bound to the routed site", async () => {
  const calls: any[] = []
  client.request = async (method: any, params: any, context: any) => {
    calls.push({ method, params, context })
    if (method === "session_get") return { user_id: 41 }
    if (method === "site_update") return { settings_revision: 5 }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const fields = {
    expectedSettingsRevision: 4,
    faviconSource: "https://static.example/favicon.ico",
    iosIconSource: "",
    windowsTileSource: "https://static.example/tile.png"
  }
  const denied = await siteIconsAction(actionEvent("siteIcons", 999, fields))
  assert.equal(denied.status, 403)
  assert.deepEqual(calls, [])

  const result = await siteIconsAction(actionEvent("siteIcons", routedSiteId, fields))
  assert.equal(result.form.valid, true)
  assert.deepEqual(calls, [
    {
      method: "session_get",
      params: [sessionToken],
      context: undefined
    },
    {
      method: "site_update",
      params: {
        site: routedSiteId,
        expected_settings_revision: 4,
        user_id: 41,
        favicon_source: "https://static.example/favicon.ico",
        ios_icon_source: null,
        windows_tile_source: "https://static.example/tile.png",
        ip_address: "192.0.2.63"
      },
      context: { sessionToken, siteId: routedSiteId }
    }
  ])
})
