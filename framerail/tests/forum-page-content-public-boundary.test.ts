import assert from "node:assert/strict"
import { createServer as createHttpServer } from "node:http"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const siteHeaders = {
  "Accept-Language": "en",
  "X-Wikijump-Site-Id": "6000006",
  "X-Wikijump-Site-Slug": "scp-wiki"
}

const viewer = {
  site: {
    site_id: 6000006,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: null,
    deleted_at: null,
    from_wikidot: true,
    slug: "scp-wiki",
    name: "Forum fixture",
    tagline: "",
    description: "",
    locale: "en",
    default_page: "start",
    top_bar_page: null,
    side_bar_page: null,
    preferred_domain: null,
    layout: "wikidot",
    license: "cc-by-sa-3.0"
  },
  site_settings: {},
  site_file_domain: "scp-wiki.wjfiles.localhost",
  license_name: "CC BY-SA 3.0",
  license_url: "https://creativecommons.org/licenses/by-sa/3.0/",
  license_kind: "standard",
  license_html: null,
  user_session: null
}

const forumBodies: any = {
  "forum/ForumStartModule": {
    status: "ok",
    body: '<section data-forum-fixture="populated"><!--forum-source-note-->forum</section>',
    js_include: []
  },
  "forum/ForumViewCategoryModule": {
    status: "ok",
    body: "",
    js_include: []
  },
  "forum/ForumViewThreadModule": {
    status: "no_thread",
    body: "",
    js_include: []
  }
}

const pageContentBody = (html: any) => {
  const opening = /<div\b[^>]*\bid="page-content"[^>]*>/gu.exec(html)
  assert.ok(opening)

  const tags = /<\/?div\b[^>]*>/gu
  tags.lastIndex = opening.index + opening[0].length
  let depth = 1
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[0].startsWith("</") ? -1 : 1
    if (depth === 0) {
      return html.slice(opening.index + opening[0].length, tag.index)
    }
  }
  assert.fail("page-content div is not closed")
}

let previousWorkingDirectory: any
let previousDeepwellHost: any
let previousDeepwellPort: any
let previousDeepwellToken: any
let vite: any
let deepwellServer: any
let server: any
let baseUrl: any

before(async () => {
  previousWorkingDirectory = process.cwd()
  process.chdir(root)
  previousDeepwellHost = process.env.DEEPWELL_HOST
  previousDeepwellPort = process.env.DEEPWELL_PORT
  previousDeepwellToken = process.env.DEEPWELL_RPC_TOKEN

  deepwellServer = createHttpServer((request, response) => {
    let body = ""
    request.on("data", (chunk) => {
      body += chunk
    })
    request.on("end", () => {
      const rpcRequest = JSON.parse(body)
      let result
      if (rpcRequest.method === "preload_view") {
        result = structuredClone(viewer)
      } else if (rpcRequest.method === "translate") {
        result = {}
      } else if (rpcRequest.method === "wikidot_forum_module") {
        result = forumBodies[rpcRequest.params.module_name]
      }
      assert.ok(result, `unexpected Deepwell method ${rpcRequest.method}`)
      response.setHeader("content-type", "application/json")
      response.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpcRequest.id,
          result: structuredClone(result)
        })
      )
    })
  })
  await new Promise((resolve) => deepwellServer.listen(0, "127.0.0.1", resolve))
  const deepwellAddress = deepwellServer.address()
  assert.equal(typeof deepwellAddress, "object")
  process.env.DEEPWELL_HOST = "127.0.0.1"
  process.env.DEEPWELL_PORT = String(deepwellAddress.port)
  process.env.DEEPWELL_RPC_TOKEN = "0".repeat(64)

  vite = await createTestViteServer()

  server = createHttpServer((request, response) => vite.middlewares(request, response))
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.equal(typeof address, "object")
  baseUrl = `http://127.0.0.1:${address.port}`
})

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve))
  if (deepwellServer) await new Promise((resolve) => deepwellServer.close(resolve))
  if (vite) await vite.close()
  if (previousDeepwellHost === undefined) delete process.env.DEEPWELL_HOST
  else process.env.DEEPWELL_HOST = previousDeepwellHost
  if (previousDeepwellPort === undefined) delete process.env.DEEPWELL_PORT
  else process.env.DEEPWELL_PORT = previousDeepwellPort
  if (previousDeepwellToken === undefined) delete process.env.DEEPWELL_RPC_TOKEN
  else process.env.DEEPWELL_RPC_TOKEN = previousDeepwellToken
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
})

test("forum GET routes enclose populated empty and error bodies in one page-content root", async () => {
  for (const [path, expectedMarker, expectedBody] of [
    ["/forum/start", "1qplnk3", forumBodies["forum/ForumStartModule"].body],
    ["/forum/c-8503559/open-topic", "45h", ""],
    [
      "/forum/t-18029831/deleted-thread",
      "1lnhxh9",
      '<div class="error-block">The thread you\'re trying to show seems to have been deleted</div>'
    ]
  ]) {
    const response = await fetch(`${baseUrl}${path}`, { headers: siteHeaders })
    const html = await response.text()
    const moduleBody = pageContentBody(html)

    assert.equal(response.status, 200)
    assert.equal(html.match(/id="page-content"/gu)?.length ?? 0, 1)
    assert.equal(moduleBody, `<!--${expectedMarker}-->${expectedBody}<!---->`)
  }
})
