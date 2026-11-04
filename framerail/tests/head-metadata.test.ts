import assert from "node:assert/strict"
import test from "node:test"

import {
  resolveHeadImageUrls,
  siteHeadFallbacks,
  unsupersededHeadFallbacks
} from "../src/lib/head-metadata.ts"

const site = (fields = {}) => ({
  name: "Example Wiki",
  description: "An example wiki for head metadata.",
  ...fields
})

const row = (name: string, content: string, all_pages = true) => ({
  name,
  content,
  all_pages
})

test("site fallbacks pair the description with the site name", () => {
  assert.deepEqual(siteHeadFallbacks(site()), [
    { name: "description", content: "An example wiki for head metadata." },
    { name: "og:site_name", content: "Example Wiki" }
  ])
})

test("site fallbacks are omitted without a configured description", () => {
  assert.deepEqual(siteHeadFallbacks(null), [])
  assert.deepEqual(siteHeadFallbacks(site({ description: "" })), [])
  assert.deepEqual(siteHeadFallbacks(site({ description: "   " })), [])
})

test("stored rows supersede only the same-named fallbacks", () => {
  const fallbacks = siteHeadFallbacks(site())
  assert.deepEqual(
    unsupersededHeadFallbacks(fallbacks, [row("description", "Page override", false)]),
    [{ name: "og:site_name", content: "Example Wiki" }]
  )
  assert.deepEqual(
    unsupersededHeadFallbacks(fallbacks, [row("og:site_name", "Override")]),
    [{ name: "description", content: "An example wiki for head metadata." }]
  )
  assert.deepEqual(
    unsupersededHeadFallbacks(fallbacks, [
      row("og:type", "article"),
      row("twitter:card", "summary")
    ]),
    fallbacks
  )
  assert.deepEqual(unsupersededHeadFallbacks([], [row("og:type", "article")]), [])
})

test("fallbacks plus effective rows carry each entry exactly once", () => {
  const fallbacks = unsupersededHeadFallbacks(siteHeadFallbacks(site()), [
    row("description", "Stored site description"),
    row("og:type", "article"),
    row("og:image", "https://example.wdfiles.com/local--files/main/logo.png"),
    row("twitter:card", "summary")
  ])
  const effective = [
    row("description", "Stored site description"),
    row("og:type", "article"),
    row("og:image", "https://example.wdfiles.com/local--files/main/logo.png"),
    row("twitter:card", "summary")
  ]
  const names = [...fallbacks, ...effective].map((tag) => tag.name)
  assert.deepEqual(names, [
    "og:site_name",
    "description",
    "og:type",
    "og:image",
    "twitter:card"
  ])
  assert.equal(new Set(names).size, names.length)
})

test("imported social images resolve to the local file origin", () => {
  const imported = { from_wikidot: true, slug: "example" }
  const origin = "https://example.wikijump.test"
  const tags = [
    row("og:image", "https://example.wdfiles.com/local--files/main/logo.png"),
    row("twitter:image", "/local--files/main/logo.png"),
    row("twitter:card", "summary")
  ]
  assert.deepEqual(resolveHeadImageUrls(tags, imported, origin), [
    row("og:image", "https://example.wikijump.test/local--files/main/logo.png"),
    row("twitter:image", "https://example.wikijump.test/local--files/main/logo.png"),
    row("twitter:card", "summary")
  ])
})

test("foreign or non-imported images stay literal", () => {
  const origin = "https://example.wikijump.test"
  const foreign = [row("og:image", "https://other.wdfiles.com/local--files/a/b.png")]
  assert.deepEqual(
    resolveHeadImageUrls(foreign, { from_wikidot: true, slug: "example" }, origin),
    foreign
  )
  const own = [row("og:image", "https://example.wdfiles.com/local--files/a/b.png")]
  assert.deepEqual(
    resolveHeadImageUrls(own, { from_wikidot: false, slug: "example" }, origin),
    own
  )
  assert.deepEqual(resolveHeadImageUrls(own, null, origin), own)
})

test("hostile content stays inert data for the renderer to escape", () => {
  const hostile = [row("description", `"><script>alert(1)</script> 'q' &amp;`)]
  assert.deepEqual(
    resolveHeadImageUrls(hostile, { from_wikidot: true, slug: "example" }, "https://x"),
    hostile
  )
})
