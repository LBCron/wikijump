import { strict as assert } from "node:assert"
import test from "node:test"

import { readUrlEncodedForm } from "../src/lib/server/ajax-module-connector/request.ts"

test("AJAX form reader rejects unsupported content types and malformed lengths", async () => {
  await assert.rejects(
    readUrlEncodedForm(
      new Request("https://example.test/ajax", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}"
      })
    ),
    { name: "TypeError", message: "AJAX Module Connector requires URL-encoded form data" }
  )

  await assert.rejects(
    readUrlEncodedForm(
      new Request("https://example.test/ajax", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": "not-a-number"
        },
        body: "x=1"
      })
    ),
    { name: "TypeError", message: "AJAX Module Connector content length is invalid" }
  )
})

test("AJAX form reader enforces declared and streamed body size bounds", async () => {
  const oversizedLength = String(131_073)
  await assert.rejects(
    readUrlEncodedForm(
      new Request("https://example.test/ajax", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": oversizedLength
        },
        body: "x=1"
      })
    ),
    { name: "RangeError", message: "AJAX Module Connector request body is too large" }
  )

  await assert.rejects(
    readUrlEncodedForm(
      new Request("https://example.test/ajax", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `x=${"a".repeat(131_072)}`
      })
    ),
    { name: "RangeError", message: "AJAX Module Connector request body is too large" }
  )
})
