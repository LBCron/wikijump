import { strict as assert } from "node:assert"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { createJiti } from "jiti"

const libRoot = fileURLToPath(new URL("../src/lib/", import.meta.url))
const jiti = createJiti(import.meta.url, { alias: { $lib: libRoot } })
const { handleXmlRpcRequest } = await jiti.import<any>(
  fileURLToPath(new URL("../src/lib/server/xmlrpc/index.ts", import.meta.url))
)

const methodListBody = `<?xml version="1.0"?>
<methodCall><methodName>system.listMethods</methodName><params /></methodCall>`

const requestWithBasicAuth = (username: string, password: string) =>
  new Request("http://127.0.0.1/xml-rpc-api.php", {
    body: methodListBody,
    headers: {
      authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
      "content-type": "text/xml"
    },
    method: "POST"
  })

test("XML-RPC Basic authentication preserves acceptance while comparing different lengths safely", async (t) => {
  const original = {
    XML_RPC_USERNAME: process.env.XML_RPC_USERNAME,
    XML_RPC_PASSWORD: process.env.XML_RPC_PASSWORD,
    WIKIDOT_APP_NAME: process.env.WIKIDOT_APP_NAME,
    WIKIDOT_API_KEY: process.env.WIKIDOT_API_KEY
  }
  process.env.XML_RPC_USERNAME = "audit-basic-user"
  process.env.XML_RPC_PASSWORD = "a-shared-secret-with-a-fixed-length"
  delete process.env.WIKIDOT_APP_NAME
  delete process.env.WIKIDOT_API_KEY
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  const valid = await handleXmlRpcRequest(
    requestWithBasicAuth("audit-basic-user", "a-shared-secret-with-a-fixed-length")
  )
  assert.equal(valid.status, 200)

  for (const [username, password] of [
    ["audit-basic-user", "short"],
    ["audit-basic-user", "a-shared-secret-with-a-fixed-length-extra"],
    ["x", "a-shared-secret-with-a-fixed-length"],
    ["audit-basic-user-longer", "a-shared-secret-with-a-fixed-length"]
  ]) {
    const rejected = await handleXmlRpcRequest(requestWithBasicAuth(username, password))
    assert.equal(rejected.status, 401)
    assert.match(await rejected.text(), /Missing or invalid HTTP Basic authentication/u)
  }
})
