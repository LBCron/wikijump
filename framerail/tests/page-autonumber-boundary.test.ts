import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { createTestViteServer } from "./vite-test-server.ts"

const root = fileURLToPath(new URL("..", import.meta.url))

test("page creation binds parent follow-up to the assigned autonumbered slug", async () => {
  const previousWorkingDirectory = process.cwd()
  let vite: any
  let client: any
  let originalRequest: any

  try {
    process.chdir(root)
    vite = await createTestViteServer()
    ;({ client } = await vite.ssrLoadModule("/src/lib/server/deepwell/index.ts"))
    const { pageEditAction } = await vite.ssrLoadModule(
      "/src/lib/server/load/page/page-edit-actions.ts"
    )
    originalRequest = client.request

    const calls: any[] = []
    client.request = async (method: any, params: any, context: any) => {
      calls.push({ method, params, context })
      if (method === "session_get") {
        return {
          session_token: "autonumber-session",
          user_id: 41,
          created_at: "2026-08-10T00:00:00Z",
          expires_at: "2026-08-11T00:00:00Z",
          ip_address: "192.0.2.63",
          user_agent: "autonumber test",
          restricted: false
        }
      }
      if (method === "page_create") {
        return { page_id: 73, revision_id: 91, slug: "104", parser_errors: [] }
      }
      if (method === "parent_update") return { added: [], removed: [] }
      throw new Error(`Unexpected Deepwell method ${method}`)
    }

    const data = new FormData()
    for (const [name, value] of Object.entries({
      siteId: 17,
      pageId: 0,
      lastRevisionId: 0,
      title: "Autonumber test",
      altTitle: "",
      wikitext: "Autonumber body",
      tags: "",
      parent: "parent-page",
      comments: "create"
    })) {
      data.set(name, String(value))
    }
    const result = await pageEditAction({
      request: new Request("https://wikijump.test/autonumber-requested?/edit", {
        method: "POST",
        body: data,
        headers: {
          "X-Wikijump-Site-Id": "17",
          "X-Wikijump-Site-Slug": "scpaiueouiuiuiui"
        }
      }),
      params: { slug: "autonumber-requested" },
      cookies: { get: () => "autonumber-session" },
      getClientAddress: () => "192.0.2.63",
      locals: {
        requestContext: {
          sessionToken: "autonumber-session",
          siteId: 17,
          page: "autonumber-requested"
        }
      }
    })

    assert.equal(result.res.slug, "104")
    assert.deepEqual(
      calls.map(({ method }) => method),
      ["session_get", "page_create", "parent_update"]
    )
    assert.equal(calls[2].params.child, "104")
    assert.equal(calls[2].context.page, "104")
  } finally {
    if (client && originalRequest) client.request = originalRequest
    if (vite) await vite.close()
    process.chdir(previousWorkingDirectory)
  }
})
