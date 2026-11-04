import { strict as assert } from "node:assert"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { createJiti } from "jiti"

const libRoot = fileURLToPath(new URL("../src/lib/", import.meta.url))
const jiti = createJiti(import.meta.url, { alias: { $lib: libRoot } })
const { dispatchXmlRpcCall } = await jiti.import<any>(
  fileURLToPath(new URL("../src/lib/server/xmlrpc/methods.ts", import.meta.url))
)
const { serializeMethodResponse } = await jiti.import<any>(
  fileURLToPath(new URL("../src/lib/server/xmlrpc/protocol.ts", import.meta.url))
)

test("system.multicall signature matches Wikidot", async () => {
  const signature = await dispatchXmlRpcCall(
    { methodName: "system.methodSignature", params: ["system.multicall"] },
    { allowMulticall: true, requestIp: "127.0.0.1" }
  )
  const xml = serializeMethodResponse(signature)

  assert.match(xml, /<name>returnType<\/name><value><string>void<\/string><\/value>/)
  assert.match(
    xml,
    /<name>parameters<\/name><value><array><data><value><string>array<\/string><\/value><\/data><\/array><\/value>/
  )
  assert.doesNotMatch(xml, /<string>struct<\/string>/)
})
