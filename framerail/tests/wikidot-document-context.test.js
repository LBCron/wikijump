// @ts-nocheck
import assert from "node:assert/strict"
import { createServer as createHttpServer } from "node:http"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.js"
import { resetDevelopmentArticleResponseCacheStores } from "../src/lib/server/cache/article-response/runtime.js"

const root = fileURLToPath(new URL("..", import.meta.url))
const siteHeaders = {
  "Accept-Language": "en",
  "X-Wikijump-Site-Id": "17",
  "X-Wikijump-Site-Slug": "test"
}
const xmlRpcBody = `<?xml version="1.0"?>
<methodCall>
  <methodName>system.listMethods</methodName>
  <params />
</methodCall>`

const viewer = (layout = "wikidot") => ({
  site: {
    site_id: 17,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: null,
    deleted_at: null,
    from_wikidot: true,
    slug: "test",
    name: "Test",
    tagline: "",
    description: "",
    locale: "ja-corrections",
    default_page: "start",
    top_bar_page: "nav:top",
    side_bar_page: "nav:side",
    preferred_domain: null,
    layout,
    license: "cc-by-sa-3.0"
  },
  site_settings: {},
  site_file_domain: "test.wjfiles.localhost",
  license_name: "CC BY-SA 3.0",
  license_url: "https://creativecommons.org/licenses/by-sa/3.0/",
  license_kind: "standard",
  license_html: null,
  user_session: null
})

const pageBase = {
  options: {},
  redirect_page: null,
  wikitext: "",
  compiled_body_html: "<p>start</p>",
  compiled_body_styles: [],
  compiled_top_bar_html: "<p>top</p>",
  compiled_side_bar_html: "<p>side</p>",
  theme: { type: "default" }
}

const foundPage = {
  type: "found",
  data: {
    ...pageBase,
    page: {
      page_id: 23,
      page_category_id: 5,
      slug: "start",
      from_wikidot: true,
      layout: null,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: null,
      discussion_thread_id: null
    },
    page_revision: { revision_number: 1, from_wikidot: true },
    wikidot_snapshot: null,
    wikidot_breadcrumbs: [],
    attributions: [],
    page_rating: { enabled: false },
    page_discussion: { enabled: false },
    data_form: null,
    legacy_actions: [],
    rate_actions: null,
    membership_actions: [],
    meta_tags: []
  }
}

const missingPage = {
  type: "missing",
  data: {
    ...pageBase,
    new_page_wikitext: null,
    page_templates: [],
    selected_template_page_id: null,
    data_form: null
  }
}

const permissionsPage = {
  type: "permissions",
  data: { ...pageBase, banned: false }
}

const articleView = (route) => {
  const slug = route?.slug
  const wikijumpLayout = [
    "wikijump-document",
    "wikijump-missing-document",
    "wikijump-permissions-document"
  ].includes(slug)
  const layout = wikijumpLayout ? "wikijump" : "wikidot"
  const page = ["missing-document", "wikijump-missing-document"].includes(slug)
    ? missingPage
    : ["permissions-document", "wikijump-permissions-document"].includes(slug)
      ? permissionsPage
      : foundPage

  return {
    ...viewer(layout),
    article_page_cache_key: null,
    public_content_cache_fence: null,
    anonymous_permission_cache_fence: null,
    page
  }
}

const deepwellInfo = {
  package: {
    name: "deepwell-fixture",
    description: "Deepwell fixture",
    license: "AGPL-3.0-or-later",
    repository: "https://example.test/deepwell",
    version: "0.0.0"
  },
  compile_info: { rustc_version: "rustc fixture" }
}

const rpcResult = (method, params) => {
  if (method === "article_view") return articleView(params.route)
  if (method === "article_view_cache_metadata") {
    return {
      article_page_cache_key: null,
      public_content_cache_fence: null,
      anonymous_permission_cache_fence: null
    }
  }
  if (method === "preload_view") return viewer()
  if (method === "translate") return {}
  if (method === "info") return deepwellInfo
  throw new Error(`Unexpected Deepwell method ${method}`)
}

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.equal(typeof address, "object")
  return address.port
}

const readBody = async (request) => {
  const chunks = []
  for await (const chunk of request) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString("utf8")
}

const deepwellHandler = async (request, response) => {
  let rpcRequest
  try {
    assert.equal(request.method, "POST")
    assert.equal(request.url, "/jsonrpc")
    rpcRequest = JSON.parse(await readBody(request))
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpcRequest.id,
        result: rpcResult(rpcRequest.method, rpcRequest.params)
      })
    )
  } catch (error) {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpcRequest?.id ?? null,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error)
        }
      })
    )
  }
}

const assertWikidotLanguageDocument = (html, locale) => {
  assert.match(
    html,
    new RegExp(
      `<html xmlns="http://www\\.w3\\.org/1999/xhtml" xml:lang="${locale}" lang="${locale}">`,
      "u"
    )
  )
  assert.equal(
    html.match(
      new RegExp(`<meta http-equiv="content-language" content="${locale}"/>`, "gu")
    )?.length,
    1
  )
}

const assertWikijumpLanguageDocument = (html, locale) => {
  assert.match(html, new RegExp(`<html lang="${locale}">`, "u"))
  assert.doesNotMatch(
    html,
    /\bxmlns=|\bxml:lang=|content-language|data-wikidot-document-language/u
  )
}

let previousWorkingDirectory
let previousEnvironment
let deepwellServer
let vite
let framerailServer
let baseUrl

before(async () => {
  previousWorkingDirectory = process.cwd()
  previousEnvironment = {
    DEEPWELL_HOST: process.env.DEEPWELL_HOST,
    DEEPWELL_PORT: process.env.DEEPWELL_PORT,
    DEEPWELL_RPC_TOKEN: process.env.DEEPWELL_RPC_TOKEN,
    WIKIDOT_APP_NAME: process.env.WIKIDOT_APP_NAME,
    WIKIDOT_API_KEY: process.env.WIKIDOT_API_KEY
  }

  deepwellServer = createHttpServer((request, response) => {
    void deepwellHandler(request, response)
  })
  const deepwellPort = await listen(deepwellServer)
  process.env.DEEPWELL_HOST = "127.0.0.1"
  process.env.DEEPWELL_PORT = String(deepwellPort)
  process.env.DEEPWELL_RPC_TOKEN = "a".repeat(64)
  process.env.WIKIDOT_APP_NAME = "fixture-app"
  process.env.WIKIDOT_API_KEY = "fixture-key"

  process.chdir(root)
  vite = await createTestViteServer()
  framerailServer = createHttpServer((request, response) =>
    vite.middlewares(request, response)
  )
  const framerailPort = await listen(framerailServer)
  baseUrl = `http://127.0.0.1:${framerailPort}`
})

after(async () => {
  if (framerailServer) {
    await new Promise((resolve) => framerailServer.close(resolve))
  }
  if (vite) await vite.close()
  resetDevelopmentArticleResponseCacheStores()
  if (deepwellServer) {
    await new Promise((resolve) => deepwellServer.close(resolve))
  }
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
  for (const [name, value] of Object.entries(previousEnvironment ?? {})) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

test("Wikidot article SSR emits the raw locale in the exact legacy language fields", async () => {
  const response = await fetch(`${baseUrl}/wikidot-document`, { headers: siteHeaders })
  const html = await response.text()

  assert.equal(response.status, 200)
  assertWikidotLanguageDocument(html, "ja-corrections")
  assert.match(html, /WIKIREQUEST\.info\.lang = "ja-corrections";/u)
})

test("Wikidot 404 and 403 error shells emit the exact legacy language fields", async () => {
  for (const [slug, status] of [
    ["missing-document", 404],
    ["permissions-document", 403]
  ]) {
    const response = await fetch(`${baseUrl}/${slug}`, { headers: siteHeaders })
    const html = await response.text()

    assert.equal(response.status, status)
    assertWikidotLanguageDocument(html, "ja-corrections")
  }
})

test("Wikijump article and special-page SSR keep only the existing lang field", async () => {
  for (const path of ["/wikijump-document", "/-/about"]) {
    const response = await fetch(`${baseUrl}${path}`, { headers: siteHeaders })
    const html = await response.text()

    assert.equal(response.status, 200)
    assertWikijumpLanguageDocument(html, "ja-corrections")
  }
})

test("Wikijump 404 and 403 error shells keep only the existing lang field", async () => {
  for (const [slug, status] of [
    ["wikijump-missing-document", 404],
    ["wikijump-permissions-document", 403]
  ]) {
    const response = await fetch(`${baseUrl}/${slug}`, { headers: siteHeaders })
    const html = await response.text()

    assert.equal(response.status, status)
    assertWikijumpLanguageDocument(html, "ja-corrections")
  }
})

test("the XML-RPC endpoint remains an XML response without document-language rewriting", async () => {
  const authorization = Buffer.from("fixture-app:fixture-key").toString("base64")
  const response = await fetch(`${baseUrl}/xml-rpc-api.php`, {
    method: "POST",
    headers: {
      authorization: `Basic ${authorization}`,
      "content-type": "text/xml"
    },
    body: xmlRpcBody
  })
  const xml = await response.text()

  assert.equal(response.status, 200)
  assert.equal(response.headers.get("content-type"), "text/xml; charset=utf-8")
  assert.match(xml, /^<\?xml version="1\.0"\?><methodResponse>/u)
  assert.doesNotMatch(
    xml,
    /\bxmlns=|\bxml:lang=|content-language|data-wikidot-document-language/u
  )
})
