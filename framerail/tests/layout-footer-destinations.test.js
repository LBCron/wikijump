import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const layout = readFileSync(
  new URL("../src/routes/+layout.svelte", import.meta.url),
  "utf8"
)

test("no layout footer sends Docs, Terms, Privacy or Security back to the wiki root", () => {
  for (const key of ["docs", "terms-conditions", "privacy", "security"]) {
    const rootLink = new RegExp(
      String.raw`href=\{resolve\("/", \{\}\)\}\s*>\s*\{viewData\?\.internationalization\?\.(?:\[")?${key}`
    )
    assert.doesNotMatch(layout, rootLink, key)
  }
  assert.match(layout, /nativeFooterLinks as link/)
  assert.match(layout, /href=\{nativeFooterHref\(key\)\}/)
})
