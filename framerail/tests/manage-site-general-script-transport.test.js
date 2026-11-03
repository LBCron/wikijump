import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.js"

const root = fileURLToPath(new URL("..", import.meta.url))
const MODULE_NAME = "managesite/ManageSiteGeneralModule"
const EXPECTED_SCRIPT_URL =
  "https://d3g0gp89917ko0.cloudfront.net/v--7690939296dc/common--modules/js/managesite/ManageSiteGeneralModule.js"

const capturedSite = {
  slug: "sandbox-for-codex",
  name: "Sandbox For Codex",
  tagline: "",
  locale: "en",
  description: "",
  default_page: "home:home",
  welcome_page: "system:welcome"
}

/** @type {any} */
let previousWorkingDirectory
/** @type {any} */
let vite
/** @type {any} */
let client
/** @type {any} */
let originalClientRequest
/** @type {any} */
let route

before(async () => {
  previousWorkingDirectory = process.cwd()
  process.chdir(root)
  vite = await createTestViteServer()

  ;({ client } = await vite.ssrLoadModule("/src/lib/server/deepwell/index.ts"))
  originalClientRequest = client.request
  route = await vite.ssrLoadModule("/src/routes/ajax-module-connector.php/+server.ts")
})

after(async () => {
  if (client && originalClientRequest) client.request = originalClientRequest
  if (vite) await vite.close()
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
})

test("ManageSiteGeneral AMC route emits its active script over HTTPS", async () => {
  /** @type {any[]} */
  const calls = []
  client.request = /** @param {any} method @param {any} params */ async (
    method,
    params
  ) => {
    calls.push({ method, params })
    if (method === "admin_view") {
      return {
        type: "site_found",
        data: { categories: [], page_templates: [], is_master_admin: false }
      }
    }
    if (method === "preload_view") return { site: capturedSite }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const response = await route.POST({
    request: new Request(
      "https://scp-wiki.wikijump.localhost/ajax-module-connector.php",
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "X-Wikijump-Site-Id": "6000005",
          "X-Wikijump-Site-Slug": "scp-wiki"
        },
        body: new URLSearchParams({ moduleName: MODULE_NAME })
      }
    ),
    cookies: { get: () => undefined },
    getClientAddress: () => "192.0.2.1"
  })

  assert.equal(response.status, 200)
  const payload = await response.json()
  assert.equal(payload.status, "ok")
  assert.deepEqual(payload.jsInclude, [EXPECTED_SCRIPT_URL])
  assert.equal(
    payload.jsInclude.every(/** @param {any} url */ (url) => url.startsWith("https://")),
    true
  )
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["admin_view", "preload_view"]
  )
  assert.equal(calls[0].params.site_id, 6000005)
  assert.equal(calls[1].params.site_id, 6000005)
})
