import { strict as assert } from "node:assert"
import test from "node:test"
import type { IncomingMessage, ServerResponse } from "node:http"

import { writeArticleResponseFastPathHit } from "../../article-response-fast-path.ts"
import { createRecordingResponse } from "./helpers.ts"

test("article response fast path writes raw Node headers without per-header setHeader", () => {
  const response = createRecordingResponse()

  writeArticleResponseFastPathHit(
    { method: "GET", url: "http://localhost/scp-173" } as unknown as IncomingMessage,
    response as unknown as ServerResponse,
    {
      status: 200,
      headers: [["x-cache-fixture", "tuple"]],
      nodeRawHeaders: Object.freeze(["x-cache-fixture", "raw"]),
      bodyBuffer: Buffer.from("cached body"),
      finalHeaders: true
    }
  )

  assert.equal(response.statusCode, undefined)
  assert.deepEqual(response.calls, [
    ["writeHead", 200, ["x-cache-fixture", "raw"]],
    ["end", Buffer.from("cached body")]
  ])
})

test("article response fast path raw-header HEAD hit sends no body", () => {
  const response = createRecordingResponse()

  writeArticleResponseFastPathHit(
    { method: "HEAD", url: "http://localhost/scp-173" } as unknown as IncomingMessage,
    response as unknown as ServerResponse,
    {
      status: 200,
      headers: [["x-cache-fixture", "tuple"]],
      nodeRawHeaders: Object.freeze(["x-cache-fixture", "raw"]),
      bodyBuffer: Buffer.from("cached body"),
      finalHeaders: true
    }
  )

  assert.deepEqual(response.calls, [
    ["writeHead", 200, ["x-cache-fixture", "raw"]],
    ["end", undefined]
  ])
})

test("article response fast path falls back to setHeader and static security headers without raw headers", () => {
  const response = createRecordingResponse()

  writeArticleResponseFastPathHit(
    { method: "GET", url: "http://localhost/scp-173" } as unknown as IncomingMessage,
    response as unknown as ServerResponse,
    {
      status: 200,
      headers: [
        ["content-type", "text/html; charset=utf-8"],
        ["x-frame-options", "SAMEORIGIN"]
      ],
      bodyBuffer: Buffer.from("cached body"),
      finalHeaders: false
    }
  )

  assert.equal(response.statusCode, 200)
  assert.equal(
    response.calls.some(
      ([method, name, value]) =>
        method === "setHeader" && name === "x-frame-options" && value === "DENY"
    ),
    true
  )
  assert.equal(
    response.calls.some(([method]) => method === "writeHead"),
    false
  )
  assert.deepEqual(response.calls.at(-1), ["end", Buffer.from("cached body")])
})
