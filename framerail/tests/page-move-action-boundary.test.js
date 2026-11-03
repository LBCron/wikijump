import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.js"

const root = fileURLToPath(new URL("..", import.meta.url))

/** @type {any} */
let previousWorkingDirectory
/** @type {any} */
let vite
/** @type {any} */
let client
/** @type {any} */
let originalClientRequest
/** @type {any} */
let slugActions

before(async () => {
  previousWorkingDirectory = process.cwd()
  process.chdir(root)
  vite = await createTestViteServer()

  ;({ client } = await vite.ssrLoadModule("/src/lib/server/deepwell/index.ts"))
  originalClientRequest = client.request
  ;({ actions: slugActions } = await vite.ssrLoadModule(
    "/src/routes/[slug]/[...extra]/+page.server.ts"
  ))
})

after(async () => {
  if (client && originalClientRequest) client.request = originalClientRequest
  if (vite) await vite.close()
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
})

/** @param {any} body @param {any} [contentType] */
const moveEvent = (body, contentType = "application/x-www-form-urlencoded") => ({
  request: new Request("https://wikijump.test/source-page/move?/move", {
    method: "POST",
    body,
    headers: {
      ...(contentType ? { "Content-Type": contentType } : {}),
      "X-Wikijump-Site-Id": "17",
      "X-Wikijump-Site-Slug": "test"
    }
  }),
  params: { slug: "source-page", extra: "move" },
  cookies: { get: () => "move-session" },
  getClientAddress: () => "192.0.2.91",
  locals: {
    requestContext: {
      siteId: 17,
      page: "source-page",
      sessionToken: "move-session"
    }
  }
})

test("native page move resolves the routed page before moving it", async () => {
  /** @type {any[]} */
  const calls = []
  client.request =
    /** @param {any} method @param {any} params @param {any} context */ async (
      method,
      params,
      context
    ) => {
      calls.push({ method, params, context })
      if (method === "session_get") {
        return {
          session_token: "move-session",
          user_id: 91,
          created_at: "2026-08-13T00:00:00Z",
          expires_at: "2026-08-14T00:00:00Z",
          ip_address: "192.0.2.91",
          user_agent: "native move boundary test",
          restricted: false
        }
      }
      if (method === "page_view") {
        return {
          type: "found",
          data: {
            page: { page_id: 42, latest_revision_id: 9, slug: "source-page" },
            page_revision: { revision_id: 9 }
          }
        }
      }
      if (method === "page_move") {
        return { page_id: 42, revision_id: 10, revision_number: 5, new_slug: "next page" }
      }
      throw new Error(`Unexpected Deepwell method ${method}`)
    }

  const result = await slugActions.move(
    moveEvent("new-slug=next+page&comments=Renamed+%26+retained")
  )

  assert.equal(result.res.new_slug, "next page")
  assert.deepEqual(calls, [
    {
      method: "session_get",
      params: ["move-session"],
      context: undefined
    },
    {
      method: "page_view",
      params: {
        site_id: 17,
        locales: ["en"],
        session_token: "move-session",
        route: { slug: "source-page", extra: "move" }
      },
      context: undefined
    },
    {
      method: "page_move",
      params: {
        site_id: 17,
        page: 42,
        new_slug: "next page",
        user_id: 91,
        ip_address: "192.0.2.91",
        last_revision_id: 9,
        revision_comments: "Renamed & retained"
      },
      context: {
        siteId: 17,
        page: "source-page",
        sessionToken: "move-session"
      }
    }
  ])
})

test("enhanced page move keeps the existing Superforms payload schema", async () => {
  /** @type {any[]} */
  const calls = []
  client.request =
    /** @param {any} method @param {any} params @param {any} context */ async (
      method,
      params,
      context
    ) => {
      calls.push({ method, params, context })
      if (method === "session_get") return { user_id: 91 }
      if (method === "page_move") {
        return {
          page_id: 42,
          revision_id: 10,
          revision_number: 5,
          new_slug: "enhanced-destination"
        }
      }
      throw new Error(`Unexpected Deepwell method ${method}`)
    }

  const data = new FormData()
  data.set(
    "__superform_json",
    '[{"siteId":1,"pageId":2,"lastRevisionId":3,"newSlug":4,"comments":5},17,42,9,"enhanced-destination","Enhanced comments"]'
  )

  const result = await slugActions.move(moveEvent(data, null))

  assert.equal(result.res.new_slug, "enhanced-destination")
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["session_get", "page_move"]
  )
  assert.deepEqual(calls[1], {
    method: "page_move",
    params: {
      site_id: 17,
      page: 42,
      new_slug: "enhanced-destination",
      user_id: 91,
      ip_address: "192.0.2.91",
      last_revision_id: 9,
      revision_comments: "Enhanced comments"
    },
    context: {
      siteId: 17,
      page: "source-page",
      sessionToken: "move-session"
    }
  })
})

test("native page move rejects client-supplied identity fields before Deepwell", async () => {
  /** @type {any[]} */
  const calls = []
  client.request = /** @param {...any} args */ async (...args) => {
    calls.push(args)
    throw new Error("Deepwell must not be called for an invalid native move")
  }

  const result = await slugActions.move(
    moveEvent("new-slug=next-page&comments=invalid&pageId=999")
  )

  assert.equal(result.status, 400)
  assert.deepEqual(calls, [])
})

test("native page move stops when the routed page view is not found", async () => {
  /** @type {any[]} */
  const calls = []
  client.request = /** @param {any} method */ async (method) => {
    calls.push(method)
    if (method === "session_get") return { user_id: 91 }
    if (method === "page_view") return { type: "missing", data: {} }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const result = await slugActions.move(
    moveEvent("new-slug=next-page&comments=missing-page")
  )

  assert.equal(result.status, 500)
  assert.deepEqual(calls, ["session_get", "page_view"])
})
