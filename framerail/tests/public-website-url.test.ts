import assert from "node:assert/strict"
import test from "node:test"

import { normalizePublicWebsiteUrl } from "../src/lib/public-website-url.ts"

test("normalizes public website values to HTTP(S) links", () => {
  assert.equal(normalizePublicWebsiteUrl("https://example.org"), "https://example.org/")
  assert.equal(
    normalizePublicWebsiteUrl("http://example.org/profile"),
    "http://example.org/profile"
  )
  assert.equal(
    normalizePublicWebsiteUrl("scp-wiki.wikidot.com/seekgull"),
    "https://scp-wiki.wikidot.com/seekgull"
  )
  assert.equal(
    normalizePublicWebsiteUrl("//example.org/profile"),
    "https://example.org/profile"
  )
})

test("does not produce links for unsafe, ambiguous, or oversized values", () => {
  for (const value of [
    "",
    ["javascript", "alert(1)"].join(":"),
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "ftp://example.org/file",
    "https://user:password@example.org/",
    "https://@example.org/",
    "https://example.org/\\\\evil.example",
    "https://example.org/\n@evil.example",
    "/relative/path",
    "?next=https://example.org",
    "#fragment",
    `https://example.org/${"a".repeat(2048)}`
  ]) {
    assert.equal(normalizePublicWebsiteUrl(value), null, value)
  }
})
