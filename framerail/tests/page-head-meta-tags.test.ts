import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"
import { parse } from "svelte/compiler"

import { createTestViteServer } from "./vite-test-server.js"

const root = fileURLToPath(new URL("..", import.meta.url))

let previousWorkingDirectory: any
let vite: any
let render: any
let pageHeadComponent: any

before(async () => {
  previousWorkingDirectory = process.cwd()
  process.chdir(root)
  vite = await createTestViteServer()

  ;({ render } = await vite.ssrLoadModule("svelte/server"))
  ;({ default: pageHeadComponent } = await vite.ssrLoadModule(
    "/src/routes/[slug]/[...extra]/PageHead.svelte"
  ))
})

after(async () => {
  if (vite) await vite.close()
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
})

const row = (name: any, content: any, all_pages: any) => ({ name, content, all_pages })

const renderHeadMetaTags = (metaTags: any) => {
  const { head } = render(pageHeadComponent, {
    props: { fontPreloadHrefs: [], compiledBodyStylesHead: "", metaTags }
  })
  return [...head.matchAll(/<meta name="([^"]+)" content="([^"]+)"\/>/gu)].map(
    (match) => ({ name: match[1], content: match[2] })
  )
}

test("page head emits two same-name page tags with different values, in stored order", () => {
  const metaTags = [
    row("og:locale:alternate", "fr_FR", false),
    row("description", "A page with two alternate locales.", false),
    row("og:locale:alternate", "de_DE", false)
  ]
  assert.deepEqual(renderHeadMetaTags(metaTags), [
    { name: "og:locale:alternate", content: "fr_FR" },
    { name: "description", content: "A page with two alternate locales." },
    { name: "og:locale:alternate", content: "de_DE" }
  ])
})

test("page head emits two same-name site tags with different values, in stored order", () => {
  const metaTags = [
    row("og:locale:alternate", "fr_FR", true),
    row("og:locale:alternate", "de_DE", true),
    row("og:locale:alternate", "ja_JP", false)
  ]
  assert.deepEqual(renderHeadMetaTags(metaTags), [
    { name: "og:locale:alternate", content: "fr_FR" },
    { name: "og:locale:alternate", content: "de_DE" },
    { name: "og:locale:alternate", content: "ja_JP" }
  ])
})

test("the meta tag each key is unique for every stored row", async () => {
  const source = await readFile(
    new URL("../src/routes/[slug]/[...extra]/PageHead.svelte", import.meta.url),
    "utf8"
  )
  const blocks: any[] = []
  const visit = (node: any) => {
    if (!node || typeof node !== "object") return
    if (node.type === "EachBlock") blocks.push(node)
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else visit(value)
    }
  }
  visit(parse(source))
  const block = blocks.find(
    (candidate) =>
      candidate.expression.type === "Identifier" &&
      candidate.expression.name === "metaTags"
  )
  assert.ok(block, "PageHead must iterate the stored meta tags")
  assert.ok(block.key, "the meta tag each block must be keyed")

  const keyOf = new Function(
    block.context.name,
    block.index ?? "__unused_index",
    `return (${source.slice(block.key.start, block.key.end)})`
  )
  const metaTags = [
    row("og:locale:alternate", "fr_FR", false),
    row("og:locale:alternate", "de_DE", false),
    row("og:locale:alternate", "fr_FR", true),
    row("og:locale:alternate", "de_DE", true),
    row("og:locale:alternate", "fr_FR", false)
  ]
  const keys = metaTags.map((metaTag, index) => keyOf(metaTag, index))
  assert.equal(new Set(keys).size, metaTags.length)
})
