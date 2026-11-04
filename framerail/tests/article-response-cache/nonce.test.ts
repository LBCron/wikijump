import { strict as assert } from "node:assert"
import type { IncomingMessage } from "node:http"
import test from "node:test"

import {
  containsCspNonce,
  renewCspNonce
} from "../../src/lib/server/cache/article-response/entry.ts"
import type { CachedArticleResponseEntry } from "../../src/lib/server/cache/article-response/entry.ts"
import { renewArticleResponseFastPathNonce } from "../../article-response-fast-path.ts"

const STORED_NONCE = "QpQiIhnXH4Dlj6zeDbCNMg=="
const FRESH_NONCE = "1wzsxCSD7Z7iuHv09jC4Yg=="

const storedEntry = (): CachedArticleResponseEntry => ({
  status: 200,
  headers: [
    ["content-type", "text/html; charset=utf-8"],
    ["content-security-policy", `script-src 'self' 'nonce-${STORED_NONCE}'`]
  ],
  body: `<html><script nonce="${STORED_NONCE}">a()</script><style nonce="${STORED_NONCE}"></style></html>`
})

test("renewCspNonce replaces the header and every inline nonce with one fresh value", () => {
  const original = storedEntry()
  const renewed = renewCspNonce(original, FRESH_NONCE)

  assert.equal(renewed.headers[1][1], `script-src 'self' 'nonce-${FRESH_NONCE}'`)
  assert.equal(
    renewed.body,
    `<html><script nonce="${FRESH_NONCE}">a()</script><style nonce="${FRESH_NONCE}"></style></html>`
  )
  assert.equal(
    original.body.includes(STORED_NONCE),
    true,
    "input entry must not be mutated"
  )
})

test("renewCspNonce leaves an entry without a nonce unchanged", () => {
  const plain: CachedArticleResponseEntry = {
    status: 200,
    headers: [["content-type", "text/html"]],
    body: "<p>x</p>"
  }
  assert.equal(containsCspNonce(plain), false)
  assert.equal(renewCspNonce(plain, FRESH_NONCE), plain)
})

test("a fast-path hit serves a fresh nonce that matches its CSP header", async () => {
  const replay = await renewArticleResponseFastPathNonce(
    { url: "/scp-744", headers: {} } as unknown as IncomingMessage,
    { ...storedEntry(), bodyBuffer: Buffer.from(storedEntry().body, "utf8") }
  )

  const header = replay!.headers.find(([name]) => name === "content-security-policy")![1]
  const body = replay!.bodyBuffer!.toString("utf8")
  const headerNonce = /'nonce-([^']+)'/u.exec(header)![1]
  const bodyNonce = /nonce="([^"]+)"/u.exec(body)![1]

  assert.notEqual(headerNonce, STORED_NONCE)
  assert.equal(headerNonce, bodyNonce, "header and body must carry the same fresh nonce")
  assert.equal(
    body.includes(STORED_NONCE),
    false,
    "the stored nonce must not be replayed"
  )
})

test("a fast-path hit without a nonce keeps its entry unchanged", async () => {
  const entry: CachedArticleResponseEntry = {
    status: 200,
    headers: [["content-type", "text/css"]],
    body: "a{}"
  }
  assert.equal(
    await renewArticleResponseFastPathNonce(
      { url: "/a.css", headers: {} } as unknown as IncomingMessage,
      entry
    ),
    entry
  )
})
