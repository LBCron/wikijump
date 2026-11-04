import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.ts"

const root = fileURLToPath(new URL("..", import.meta.url))

let previousWorkingDirectory: any
let vite: any
let render: any
let tagsPane: any
let client: any
let originalClientRequest: any
let pageEditAction: any

before(async () => {
  previousWorkingDirectory = process.cwd()
  process.chdir(root)
  vite = await createTestViteServer()

  ;({ render } = await vite.ssrLoadModule("svelte/server"))
  ;({ client } = await vite.ssrLoadModule("/src/lib/server/deepwell/index.ts"))
  originalClientRequest = client.request
  ;({ pageEditAction } = await vite.ssrLoadModule(
    "/src/lib/server/load/page/page-edit-actions.ts"
  ))
  ;({ default: tagsPane } = await vite.ssrLoadModule(
    "/src/routes/[slug]/[...extra]/TagsPane.svelte"
  ))
})

after(async () => {
  if (client && originalClientRequest) client.request = originalClientRequest
  if (vite) await vite.close()
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
})

test("Tags SSR exposes the current space-separated tags through the trusted edit action", () => {
  const body = render(tagsPane, {
    props: {
      data: {
        site: { site_id: 17 },
        page: { page_id: 42 },
        page_revision: {
          revision_id: 9,
          title: "Fixture title",
          alt_title: "Fixture alternate title",
          tags: ["alpha", "_hidden"]
        },
        wikitext: "Fixture source",
        internationalization: {
          tags: "Tags",
          save: "Save",
          cancel: "Cancel"
        }
      },
      pagePaneState: "tags"
    }
  }).body

  assert.match(body, /<form id="page-tags"[^>]*action="\?\/edit"[^>]*method="POST"/u)
  assert.match(body, /<input[^>]*id="page-tags-input"[^>]*name="tags"/u)
  assert.match(body, /value="alpha _hidden"/u)
  assert.match(body, /value="Cancel"/u)
  assert.match(body, /value="Save"/u)
  assert.match(body, /name="siteId" type="hidden" value="17"/u)
  assert.match(body, /name="pageId" type="hidden" value="42"/u)
  assert.match(body, /name="lastRevisionId" type="hidden" value="9"/u)
  assert.match(body, /name="wikitext" type="hidden" value="Fixture source"/u)
})

test("Tags submission preserves page content and changes tags at the authenticated page action", async () => {
  const calls: any[] = []
  client.request = async (method: any, params: any, context: any) => {
    calls.push({ method, params, context })
    if (method === "session_get") {
      return {
        session_token: "tags-session",
        user_id: 23,
        created_at: "2026-08-10T00:00:00Z",
        expires_at: "2026-08-11T00:00:00Z",
        ip_address: "192.0.2.41",
        user_agent: "tags test",
        restricted: false
      }
    }
    if (method === "page_edit") {
      return {
        revision_id: 10,
        revision_number: 4,
        parser_errors: []
      }
    }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const fields = new FormData()
  for (const [name, value] of Object.entries({
    siteId: 17,
    pageId: 42,
    lastRevisionId: 9,
    title: "Fixture title",
    altTitle: "Fixture alternate title",
    wikitext: "Fixture source",
    tags: "alpha replacement",
    comments: ""
  })) {
    fields.set(name, String(value))
  }

  const result = await pageEditAction({
    request: new Request("https://wikijump.test/fixture?/edit", {
      method: "POST",
      body: fields,
      headers: {
        "X-Wikijump-Site-Id": "17",
        "X-Wikijump-Site-Slug": "test"
      }
    }),
    params: { slug: "fixture" },
    cookies: { get: () => "tags-session" },
    getClientAddress: () => "192.0.2.41",
    locals: {
      requestContext: {
        sessionToken: "tags-session",
        siteId: 17,
        page: "fixture"
      }
    }
  })

  assert.equal(result.res.revision_id, 10)
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["session_get", "page_edit"]
  )
  assert.deepEqual(calls[1].params.tags, ["alpha", "replacement"])
  assert.equal(calls[1].params.wikitext, "Fixture source")
  assert.equal(calls[1].params.title, "Fixture title")
  assert.equal(calls[1].params.alt_title, "Fixture alternate title")
  assert.equal(calls[1].params.page, 42)
  assert.equal(calls[1].params.last_revision_id, 9)
  assert.equal(calls[1].params.user_id, 23)
})
