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
const { MAX_XML_RPC_BODY_BYTES, handleXmlRpcRequest } = await jiti.import(
  fileURLToPath(new URL("../src/lib/server/xmlrpc/index.ts", import.meta.url))
)
/** @type {any} */
const { MAX_XML_RPC_FILE_BYTES, decodeXmlRpcBase64 } = await jiti.import(
  fileURLToPath(new URL("../src/lib/server/xmlrpc/resource-methods.ts", import.meta.url))
)

const basicAuth = `Basic ${Buffer.from("size-app:size-key").toString("base64")}`

/** @param {any} content */
const xmlRpcFilesSaveOneRequest = (content) => `<?xml version="1.0"?>
<methodCall>
  <methodName>files.save_one</methodName>
  <params><param><value><struct>
    <member><name>site</name><value><string>size-site</string></value></member>
    <member><name>page</name><value><string>size-page</string></value></member>
    <member><name>file</name><value><string>size.bin</string></value></member>
    <member><name>content</name><value><string>${content}</string></value></member>
  </struct></value></param></params>
</methodCall>`

/** @param {any} body */
const xmlRpcRequest = (body) =>
  new Request("http://127.0.0.1/xml-rpc-api.php", {
    body,
    headers: { authorization: basicAuth, "content-type": "text/xml" },
    method: "POST"
  })

test("files.save_one rejects decoded content over its configured limit", () => {
  assert.equal(MAX_XML_RPC_FILE_BYTES, 50_000_000)

  const configuredLimit = 1024
  const content = Buffer.alloc(configuredLimit + 1).toString("base64")

  assert.throws(
    () => decodeXmlRpcBase64(content, configuredLimit),
    /** @param {any} error */ (error) =>
      error.faultCode === 413 &&
      error.httpStatus === 413 &&
      error.faultString === "files.save_one content is too large"
  )
})

test("files.save_one fitting the configured XML envelope reaches its fixture", async (t) => {
  assert.equal(MAX_XML_RPC_BODY_BYTES, 67_108_864)

  const originalRequest = client.request
  const originalEnv = {
    WIKIDOT_API_KEY: process.env.WIKIDOT_API_KEY,
    WIKIDOT_APP_NAME: process.env.WIKIDOT_APP_NAME,
    XML_RPC_WRITE_PASSWORD: process.env.XML_RPC_WRITE_PASSWORD,
    XML_RPC_WRITE_USERNAME: process.env.XML_RPC_WRITE_USERNAME
  }
  process.env.WIKIDOT_APP_NAME = "size-app"
  process.env.WIKIDOT_API_KEY = "size-key"
  process.env.XML_RPC_WRITE_USERNAME = "size-writer"
  process.env.XML_RPC_WRITE_PASSWORD = "size-password"
  t.after(() => {
    client.request = originalRequest
    for (const [name, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  let uploadedBytes = 0
  const server = http.createServer((request, response) => {
    request.on("data", (chunk) => {
      uploadedBytes += chunk.length
    })
    request.on("end", () => response.writeHead(200).end())
  })
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", /** @type {any} */ (resolve))
  )
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = /** @type {any} */ (server.address())
  assert.equal(typeof address, "object")

  const contentBytes = Buffer.alloc(2048, 0x61)
  let fileGetCount = 0
  /** @type {any[]} */
  const calls = []
  client.request = /** @param {any} method */ async (method) => {
    calls.push(method)
    if (method === "site_get") return { site_id: 17 }
    if (method === "page_get") {
      return {
        page_id: 23,
        revision_id: 29,
        page_created_at: "2026-08-13T00:00:00Z",
        page_updated_at: null,
        page_revision_count: 1,
        revision_created_at: "2026-08-13T00:00:00Z",
        revision_user_id: 31,
        title: "Size fixture",
        slug: "size-page",
        tags: [],
        rating: 0
      }
    }
    if (method === "file_get") {
      fileGetCount += 1
      return fileGetCount === 1
        ? null
        : {
            file_id: 41,
            file_created_at: "2026-08-13T00:00:00Z",
            file_updated_at: null,
            revision_id: 43,
            revision_created_at: "2026-08-13T00:00:00Z",
            revision_user_id: 37,
            name: "size.bin",
            mime: "application/octet-stream",
            size: contentBytes.length,
            revision_comments: "XML-RPC file save"
          }
    }
    if (method === "login") return { session_token: "size-session" }
    if (method === "session_get") return { user_id: 37 }
    if (method === "blob_upload") {
      return {
        pending_blob_id: "size-pending",
        presign_url: `http://127.0.0.1:${address.port}/pending`
      }
    }
    if (method === "file_create") return null
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const body = xmlRpcFilesSaveOneRequest(contentBytes.toString("base64"))
  const response = await handleXmlRpcRequest(
    xmlRpcRequest(body),
    "192.0.2.70",
    Buffer.byteLength(body)
  )

  assert.equal(response.status, 200)
  assert.match(await response.text(), /<name>filename<\/name><value><string>size\.bin/)
  assert.equal(uploadedBytes, contentBytes.length)
  assert.ok(calls.includes("file_create"))
})

test("files.save_one one base64 quantum over the configured XML envelope gets 413", async (t) => {
  const originalAppName = process.env.WIKIDOT_APP_NAME
  const originalApiKey = process.env.WIKIDOT_API_KEY
  process.env.WIKIDOT_APP_NAME = "size-app"
  process.env.WIKIDOT_API_KEY = "size-key"
  t.after(() => {
    if (originalAppName === undefined) delete process.env.WIKIDOT_APP_NAME
    else process.env.WIKIDOT_APP_NAME = originalAppName
    if (originalApiKey === undefined) delete process.env.WIKIDOT_API_KEY
    else process.env.WIKIDOT_API_KEY = originalApiKey
  })

  const fittingContent = Buffer.alloc(1023, 0x61).toString("base64")
  const fittingBody = xmlRpcFilesSaveOneRequest(fittingContent)
  const oversizedBody = xmlRpcFilesSaveOneRequest(`${fittingContent}AAAA`)
  assert.equal(Buffer.byteLength(oversizedBody), Buffer.byteLength(fittingBody) + 4)

  const response = await handleXmlRpcRequest(
    xmlRpcRequest(oversizedBody),
    "192.0.2.70",
    Buffer.byteLength(fittingBody)
  )

  assert.equal(response.status, 413)
  assert.match(
    await response.text(),
    /<name>faultCode<\/name><value><int>413<\/int><\/value>/
  )
})
