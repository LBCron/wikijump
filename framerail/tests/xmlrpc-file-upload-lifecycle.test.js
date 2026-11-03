import { strict as assert } from "node:assert"
import http from "node:http"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { createJiti } from "jiti"

const libRoot = fileURLToPath(new URL("../src/lib/", import.meta.url))
const jiti = createJiti(import.meta.url, { alias: { $lib: libRoot } })
/** @type {any} */
const { client } = await jiti.import(
  fileURLToPath(new URL("../src/lib/server/deepwell/index.ts", import.meta.url))
)
/** @type {any} */
const { saveFileOne } = await jiti.import(
  fileURLToPath(new URL("../src/lib/server/xmlrpc/resource-methods.ts", import.meta.url))
)

const page = {
  page_id: 23,
  revision_id: 29,
  page_created_at: "2026-08-09T00:00:00Z",
  page_updated_at: null,
  page_revision_count: 1,
  revision_created_at: "2026-08-09T00:00:00Z",
  revision_user_id: 31,
  title: "XML-RPC cleanup fixture",
  slug: "xmlrpc-cleanup",
  tags: [],
  rating: 0
}

test("XML-RPC file save preserves its commit fault when pending cleanup also fails", async (t) => {
  const originalRequest = client.request
  const originalUsername = process.env.XML_RPC_WRITE_USERNAME
  const originalPassword = process.env.XML_RPC_WRITE_PASSWORD
  process.env.XML_RPC_WRITE_USERNAME = "xmlrpc-cleanup-user"
  process.env.XML_RPC_WRITE_PASSWORD = "xmlrpc-cleanup-password"
  t.after(() => {
    client.request = originalRequest
    if (originalUsername === undefined) delete process.env.XML_RPC_WRITE_USERNAME
    else process.env.XML_RPC_WRITE_USERNAME = originalUsername
    if (originalPassword === undefined) delete process.env.XML_RPC_WRITE_PASSWORD
    else process.env.XML_RPC_WRITE_PASSWORD = originalPassword
  })

  const server = http.createServer((request, response) => {
    request.resume()
    request.on("end", () => response.writeHead(200).end())
  })
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", /** @type {any} */ (resolve))
  )
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = /** @type {any} */ (server.address())
  assert.equal(typeof address, "object")

  const commitSentinel = new Error("file_create commit sentinel")
  const cancelSentinel = new Error("blob_cancel cleanup sentinel")
  /** @type {any[]} */
  const calls = []
  let cancelCount = 0
  client.request =
    /** @param {any} method @param {any} params @param {any} context */ async (
      method,
      params,
      context
    ) => {
      calls.push({ method, params, context })
      if (method === "site_get") return { site_id: 17 }
      if (method === "page_get") return page
      if (method === "file_get") return null
      if (method === "login") return { session_token: "xmlrpc-cleanup-session" }
      if (method === "session_get") return { user_id: 37 }
      if (method === "blob_upload") {
        return {
          pending_blob_id: "xmlrpc-cleanup-pending",
          presign_url: `http://127.0.0.1:${address.port}/pending`
        }
      }
      if (method === "file_create") throw commitSentinel
      if (method === "blob_cancel") {
        cancelCount += 1
        throw cancelSentinel
      }
      throw new Error(`Unexpected Deepwell method ${method}`)
    }

  const content = Buffer.from("xmlrpc cleanup").toString("base64")
  await assert.rejects(
    saveFileOne(
      {
        methodName: "files.save_one",
        params: [
          {
            site: "scp-wiki",
            page: page.slug,
            file: "cleanup.txt",
            content,
            save_mode: "create"
          }
        ]
      },
      "192.0.2.62"
    ),
    /** @param {any} error */ (error) =>
      error.faultCode === -32603 &&
      error.faultString === "XML-RPC Deepwell request failed: file_create"
  )

  assert.equal(cancelCount, 1)
  assert.deepEqual(
    calls.map(({ method }) => method),
    [
      "site_get",
      "page_get",
      "file_get",
      "login",
      "session_get",
      "blob_upload",
      "file_create",
      "blob_cancel"
    ]
  )
  const writeContext = {
    sessionToken: "xmlrpc-cleanup-session",
    siteId: 17,
    page: page.slug,
    userId: 37,
    ipAddress: "192.0.2.62"
  }
  assert.deepEqual(calls[5], {
    method: "blob_upload",
    params: { user_id: 37, blob_size: 14, scope: "page" },
    context: writeContext
  })
  assert.deepEqual(calls[7], {
    method: "blob_cancel",
    params: {
      user_id: 37,
      pending_blob_id: "xmlrpc-cleanup-pending"
    },
    context: writeContext
  })
})
