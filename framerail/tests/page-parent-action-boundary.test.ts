import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.ts"

const root = fileURLToPath(new URL("..", import.meta.url))

let previousWorkingDirectory: any
let vite: any
let client: any
let originalClientRequest: any
let rootActions: any
let slugActions: any
let buildPageForms: any

before(async () => {
  previousWorkingDirectory = process.cwd()
  process.chdir(root)
  vite = await createTestViteServer()

  ;({ client } = await vite.ssrLoadModule("/src/lib/server/deepwell/index.ts"))
  originalClientRequest = client.request
  ;({ actions: rootActions } = await vite.ssrLoadModule("/src/routes/+page.server.ts"))
  ;({ actions: slugActions } = await vite.ssrLoadModule(
    "/src/routes/[slug]/[...extra]/+page.server.ts"
  ))
  ;({ buildPageForms } = await vite.ssrLoadModule(
    "/src/lib/server/load/page/page-forms.ts"
  ))
})

after(async () => {
  if (client && originalClientRequest) client.request = originalClientRequest
  if (vite) await vite.close()
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
})

const parentSetEvent = (serializedPayload: any) => {
  const data = new FormData()
  data.set("__superform_json", serializedPayload)

  return {
    request: new Request("https://wikijump.test/example?/parentSet", {
      method: "POST",
      body: data,
      headers: {
        "X-Wikijump-Site-Id": "17",
        "X-Wikijump-Site-Slug": "test"
      }
    }),
    params: { slug: "example" },
    cookies: { get: () => "parent-session" },
    locals: {
      requestContext: {
        siteId: 17,
        page: "example",
        sessionToken: "parent-session"
      }
    }
  }
}

test("page form initialization gives ParentPane only its parents field", async () => {
  const forms = await buildPageForms(new Request("https://wikijump.test/example"))

  assert.deepEqual(forms.pageParentForm.data, { parents: "" })
  assert.equal(Object.hasOwn(forms.pageParentForm.data, "siteId"), false)
  assert.equal(Object.hasOwn(forms.pageParentForm.data, "pageId"), false)
  assert.equal(Object.hasOwn(forms.pageParentForm.data, "lastRevisionId"), false)
})

test("root and slug parentSet actions accept the parent pane JSON payload", async () => {
  const calls: any[] = []
  client.request = async (method: any, params: any, context: any) => {
    calls.push({ method, params, context })
    if (method === "session_get") {
      return {
        session_token: "parent-session",
        user_id: 91,
        created_at: "2026-08-10T00:00:00Z",
        expires_at: "2026-08-11T00:00:00Z",
        ip_address: "192.0.2.91",
        user_agent: "parent action test",
        restricted: false
      }
    }
    if (method === "parent_update") return { added: [101, 102], removed: [true] }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const serializedPayload =
    '[{"siteId":1,"pageId":2,"addParents":3,"removeParents":6},17,23,[4,5],"alpha","beta",[7],"old"]'

  for (const actions of [rootActions, slugActions]) {
    assert.equal(typeof actions.parentSet, "function")
    const result = await actions.parentSet(parentSetEvent(serializedPayload))
    assert.deepEqual(result.res, { added: [101, 102], removed: [true] })
  }

  assert.deepEqual(
    calls,
    [rootActions, slugActions].flatMap(() => [
      {
        method: "session_get",
        params: ["parent-session"],
        context: undefined
      },
      {
        method: "parent_update",
        params: {
          site_id: 17,
          child: 23,
          user_id: 91,
          add: ["alpha", "beta"],
          remove: ["old"]
        },
        context: {
          siteId: 17,
          page: "example",
          sessionToken: "parent-session"
        }
      }
    ])
  )
})

test("parentSet rejects a missing siteId before calling Deepwell", async () => {
  const calls: any[] = []
  client.request = async (...args: any[]) => {
    calls.push(args)
    throw new Error("Deepwell must not be called for an invalid parent payload")
  }

  const result = await slugActions.parentSet(
    parentSetEvent('[{"pageId":1,"addParents":2},23,[3],"alpha"]')
  )

  assert.equal(result.status, 400)
  assert.deepEqual(calls, [])
})

test("parentSet rejects a missing pageId before calling Deepwell", async () => {
  const calls: any[] = []
  client.request = async (...args: any[]) => {
    calls.push(args)
    throw new Error("Deepwell must not be called for an invalid parent payload")
  }

  const result = await slugActions.parentSet(
    parentSetEvent('[{"siteId":1,"removeParents":2},17,[3],"old"]')
  )

  assert.equal(result.status, 400)
  assert.deepEqual(calls, [])
})

test("parentSet rejects malformed parent arrays before calling Deepwell", async () => {
  const calls: any[] = []
  client.request = async (...args: any[]) => {
    calls.push(args)
    throw new Error("Deepwell must not be called for an invalid parent payload")
  }

  const malformedPayloads = [
    '[{"siteId":1,"pageId":2,"addParents":3},17,23,"alpha"]',
    '[{"siteId":1,"pageId":2,"removeParents":3},17,23,"old"]'
  ]

  for (const payload of malformedPayloads) {
    const result = await slugActions.parentSet(parentSetEvent(payload))
    assert.equal(result.status, 400)
  }
  assert.deepEqual(calls, [])
})
