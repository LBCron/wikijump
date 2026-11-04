import assert from "node:assert/strict"
import test from "node:test"

import { translateRequest } from "../src/lib/server/deepwell/translate-request.ts"

test("strips control characters only from requested messages", () => {
  assert.deepEqual(
    translateRequest(["en"], { "mfa-code": {} }, ["footer-license-unless"]),
    {
      locales: ["en"],
      messages: { "mfa-code": {} },
      strip_message_keys: [],
      allow_missing: true
    }
  )
})

test("keeps a strip key whose message is in the batch", () => {
  const keys = { "footer-license-unless": {}, "login": {} }
  assert.deepEqual(
    translateRequest(["ja", "en"], keys, ["footer-license-unless"]).strip_message_keys,
    ["footer-license-unless"]
  )
})
