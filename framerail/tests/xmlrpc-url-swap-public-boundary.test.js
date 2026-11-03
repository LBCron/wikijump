import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import http from "node:http"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { createJiti } from "jiti"

const libRoot = fileURLToPath(new URL("../src/lib/", import.meta.url))
const routePath = fileURLToPath(
  new URL("../src/routes/xml-rpc-api.php/+server.ts", import.meta.url)
)
const clientPath = fileURLToPath(
  new URL(
    "../../install/local/wikidot-verification/scripts/check-xmlrpc-url-swap.py",
    import.meta.url
  )
)

test("the standard Python XML-RPC client resolves the documented API through the public route", async (t) => {
  const previousUsername = process.env.XML_RPC_USERNAME
  const previousPassword = process.env.XML_RPC_PASSWORD
  process.env.XML_RPC_USERNAME = "url-swap-client"
  process.env.XML_RPC_PASSWORD = "url-swap-secret"
  t.after(() => {
    restoreEnvironment("XML_RPC_USERNAME", previousUsername)
    restoreEnvironment("XML_RPC_PASSWORD", previousPassword)
  })

  const jiti = createJiti(import.meta.url, { alias: { $lib: libRoot } })
  /** @type {any} */
  const { POST } = await jiti.import(routePath)
  const server = http.createServer(async (incoming, outgoing) => {
    if (incoming.method !== "POST" || incoming.url !== "/xml-rpc-api.php") {
      outgoing.writeHead(404).end()
      return
    }

    const chunks = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    const address = /** @type {any} */ (server.address())
    assert.equal(typeof address, "object")
    const request = new Request(`http://127.0.0.1:${address.port}/xml-rpc-api.php`, {
      body: Buffer.concat(chunks),
      headers: /** @type {any} */ (incoming.headers),
      method: "POST"
    })
    const response = await POST({
      getClientAddress: () => "192.0.2.87",
      request
    })
    outgoing.writeHead(response.status, Object.fromEntries(response.headers))
    outgoing.end(Buffer.from(await response.arrayBuffer()))
  })
  await new Promise((resolve) =>
    server.listen(0, "127.0.0.1", /** @type {any} */ (resolve))
  )
  t.after(() => new Promise((resolve) => server.close(resolve)))
  const address = /** @type {any} */ (server.address())
  assert.equal(typeof address, "object")

  const result = await runPythonClient({
    XMLRPC_CONFORMANCE_ENDPOINT: `http://127.0.0.1:${address.port}/xml-rpc-api.php`,
    XMLRPC_CONFORMANCE_PASSWORD: "url-swap-secret",
    XMLRPC_CONFORMANCE_USERNAME: "url-swap-client"
  })

  assert.equal(result.code, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    deleted_methods: [
      "page.files",
      "page.get",
      "page.save",
      "site.categories",
      "site.pages",
      "user.sites"
    ],
    documented_methods: [
      "categories.select",
      "files.get_meta",
      "files.get_one",
      "files.save_one",
      "files.select",
      "pages.get_meta",
      "pages.get_one",
      "pages.save_one",
      "pages.select",
      "posts.get",
      "posts.select",
      "tags.select",
      "users.get_me"
    ],
    endpoint_path: "/xml-rpc-api.php",
    unknown_method_fault: -32601
  })
})

/** @param {any} environment */
const runPythonClient = (environment) => {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [clientPath], {
      env: { ...process.env, ...environment },
      stdio: ["ignore", "pipe", "pipe"]
    })
    let stdout = ""
    let stderr = ""
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stderr, stdout }))
  })
}

/** @param {any} name @param {any} value */
const restoreEnvironment = (name, value) => {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
