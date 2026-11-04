import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.js"

const root = fileURLToPath(new URL("..", import.meta.url))

let previousWorkingDirectory: any
let vite: any
let client: any
let originalClientRequest: any
let slugActions: any

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

const deleteEvent = (
  body: any,
  contentType: any = "application/x-www-form-urlencoded"
) => ({
  request: new Request("https://wikijump.test/source-page/delete?/delete", {
    method: "POST",
    body,
    headers: {
      ...(contentType ? { "Content-Type": contentType } : {}),
      "X-Wikijump-Site-Id": "17",
      "X-Wikijump-Site-Slug": "test"
    }
  }),
  params: { slug: "source-page", extra: "delete" },
  cookies: { get: () => "delete-session" },
  getClientAddress: () => "192.0.2.92",
  locals: {
    requestContext: {
      siteId: 17,
      page: "source-page",
      sessionToken: "delete-session"
    }
  }
})

const foundPage = {
  type: "found",
  data: {
    page: { page_id: 42, latest_revision_id: 9, slug: "source-page" },
    page_revision: { revision_id: 9 }
  }
}

test("native delete-pane move resolves the routed page before moving it", async () => {
  const calls: any[] = []
  client.request = async (method: any, params: any, context: any) => {
    calls.push({ method, params, context })
    if (method === "session_get") return { user_id: 91 }
    if (method === "page_view") return foundPage
    if (method === "page_move") {
      return { page_id: 42, revision_id: 10, revision_number: 5, new_slug: "next page" }
    }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const result = await slugActions.delete(
    deleteEvent("option=move&new-slug=next+page&comments=Renamed+%26+retained")
  )

  assert.equal(result.res.new_slug, "next page")
  assert.deepEqual(calls, [
    { method: "session_get", params: ["delete-session"], context: undefined },
    {
      method: "page_view",
      params: {
        site_id: 17,
        locales: ["en"],
        session_token: "delete-session",
        route: { slug: "source-page", extra: "delete" }
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
        ip_address: "192.0.2.92",
        last_revision_id: 9,
        revision_comments: "Renamed & retained"
      },
      context: {
        siteId: 17,
        page: "source-page",
        sessionToken: "delete-session"
      }
    }
  ])
})

test("native Wikidot delete accepts an omitted comment", async () => {
  const calls: any[] = []
  client.request = async (method: any, params: any, context: any) => {
    calls.push({ method, params, context })
    if (method === "session_get") return { user_id: 91 }
    if (method === "page_view") return foundPage
    if (method === "page_delete") {
      return { page_id: 42, revision_id: 10, revision_number: 5 }
    }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const result = await slugActions.delete(deleteEvent("option=delete"))

  assert.equal(result.option, "delete", JSON.stringify({ result, calls }))
  assert.deepEqual(calls.at(-1), {
    method: "page_delete",
    params: {
      site_id: 17,
      page: 42,
      user_id: 91,
      ip_address: "192.0.2.92",
      last_revision_id: 9,
      revision_comments: undefined
    },
    context: {
      siteId: 17,
      page: "source-page",
      sessionToken: "delete-session"
    }
  })
})

test("native Wikijump delete accepts an empty comment", async () => {
  const calls: any[] = []
  client.request = async (method: any, params: any) => {
    calls.push({ method, params })
    if (method === "session_get") return { user_id: 91 }
    if (method === "page_view") return foundPage
    if (method === "page_delete") {
      return { page_id: 42, revision_id: 10, revision_number: 5 }
    }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const result = await slugActions.delete(deleteEvent("option=delete&comments="))

  assert.equal(result.option, "delete")
  assert.equal(calls.at(-1).method, "page_delete")
  assert.equal(calls.at(-1).params.revision_comments, "")
})

test("native delete stops without mutation when the routed page is missing", async () => {
  const calls: any[] = []
  client.request = async (method: any) => {
    calls.push(method)
    if (method === "session_get") return { user_id: 91 }
    if (method === "page_view") return { type: "missing", data: {} }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const result = await slugActions.delete(deleteEvent("option=delete"))

  assert.equal(result.status, 500)
  assert.deepEqual(calls, ["session_get", "page_view"])
})

test("enhanced delete preserves supplied page identity without resolving the route", async () => {
  const calls: any[] = []
  client.request = async (method: any, params: any, context: any) => {
    calls.push({ method, params, context })
    if (method === "session_get") return { user_id: 91 }
    if (method === "page_delete") {
      return { page_id: 742, revision_id: 910, revision_number: 5 }
    }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const data = new FormData()
  data.set(
    "__superform_json",
    '[{"siteId":1,"pageId":2,"lastRevisionId":3,"option":4,"comments":5},17,742,909,"delete","Enhanced delete"]'
  )

  const result = await slugActions.delete(deleteEvent(data, null))

  assert.equal(result.option, "delete")
  assert.deepEqual(calls, [
    { method: "session_get", params: ["delete-session"], context: undefined },
    {
      method: "page_delete",
      params: {
        site_id: 17,
        page: 742,
        user_id: 91,
        ip_address: "192.0.2.92",
        last_revision_id: 909,
        revision_comments: "Enhanced delete"
      },
      context: {
        siteId: 17,
        page: "source-page",
        sessionToken: "delete-session"
      }
    }
  ])
})

test("enhanced delete-pane move preserves supplied page identity without resolving the route", async () => {
  const calls: any[] = []
  client.request = async (method: any, params: any, context: any) => {
    calls.push({ method, params, context })
    if (method === "session_get") return { user_id: 91 }
    if (method === "page_move") {
      return {
        page_id: 743,
        revision_id: 911,
        revision_number: 5,
        new_slug: "enhanced destination"
      }
    }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const data = new FormData()
  data.set(
    "__superform_json",
    '[{"siteId":1,"pageId":2,"lastRevisionId":3,"option":4,"newSlug":5,"comments":6},17,743,910,"move","enhanced destination","Enhanced move"]'
  )

  const result = await slugActions.delete(deleteEvent(data, null))

  assert.equal(result.option, "move")
  assert.deepEqual(calls, [
    { method: "session_get", params: ["delete-session"], context: undefined },
    {
      method: "page_move",
      params: {
        site_id: 17,
        page: 743,
        new_slug: "enhanced destination",
        user_id: 91,
        ip_address: "192.0.2.92",
        last_revision_id: 910,
        revision_comments: "Enhanced move"
      },
      context: {
        siteId: 17,
        page: "source-page",
        sessionToken: "delete-session"
      }
    }
  ])
})

test("native delete-pane move rejects supplied identity fields before Deepwell", async () => {
  const calls: any[] = []
  client.request = async (...args: any[]) => {
    calls.push(args)
    throw new Error("Deepwell must not be called for an invalid native move")
  }

  const result = await slugActions.delete(
    deleteEvent("option=move&new-slug=next-page&comments=invalid&pageId=999")
  )

  assert.equal(result.status, 400)
  assert.deepEqual(calls, [])
})

test("native delete rejects move-only fields before Deepwell", async () => {
  const calls: any[] = []
  client.request = async (...args: any[]) => {
    calls.push(args)
    throw new Error("Deepwell must not be called for an invalid native delete")
  }

  const result = await slugActions.delete(
    deleteEvent("option=delete&comments=&new-slug=foreign-field")
  )

  assert.equal(result.status, 400)
  assert.deepEqual(calls, [])
})
