import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"
import { compile, parse } from "svelte/compiler"
import { render } from "svelte/server"

const root = fileURLToPath(new URL("..", import.meta.url))
const paneUrl = new URL(
  "../src/routes/[slug]/[...extra]/EditMetaPane.svelte",
  import.meta.url
)

let paneSource: any
let rowsBlock: any
let tempDirectory: any
let rowsComponent: any

const findRowsBlock = (source: any) => {
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
  return blocks.find(
    (candidate) =>
      candidate.expression.type === "Identifier" && candidate.expression.name === "rows"
  )
}

before(async () => {
  paneSource = await readFile(paneUrl, "utf8")
  rowsBlock = findRowsBlock(paneSource)
  assert.ok(rowsBlock, "EditMetaPane must iterate the stored meta tag rows")

  const wrapper = [
    "<script>",
    "  let { rows } = $props()",
    "  let busy = false",
    "  const remove = () => {}",
    "</script>",
    paneSource.slice(rowsBlock.start, rowsBlock.end)
  ].join("\n")
  const { js } = compile(wrapper, { generate: "server" })

  tempDirectory = await mkdtemp(join(tmpdir(), "edit-meta-pane-rows-"))
  await symlink(join(root, "node_modules"), join(tempDirectory, "node_modules"), "dir")
  const modulePath = join(tempDirectory, "EditMetaRows.mjs")
  await writeFile(modulePath, js.code)
  ;({ default: rowsComponent } = await import(modulePath))
})

after(async () => {
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true })
})

const row = (name: any, content: any, all_pages: any) => ({ name, content, all_pages })

const renderRows = (rows: any) => render(rowsComponent, { props: { rows } }).body

test("editor renders two same-name rows with different values as separate rows", () => {
  const body = renderRows([
    row("og:locale:alternate", "fr_FR", false),
    row("description", "A page with two alternate locales.", false),
    row("og:locale:alternate", "de_DE", false)
  ])

  const rendered = [
    ...body.matchAll(/&lt;meta name="([^"]+)" content="([^"]+)"\/>/gu)
  ].map((match) => ({ name: match[1], content: match[2] }))
  assert.deepEqual(rendered, [
    { name: "og:locale:alternate", content: "fr_FR" },
    { name: "description", content: "A page with two alternate locales." },
    { name: "og:locale:alternate", content: "de_DE" }
  ])
  assert.equal(body.match(/edit-meta-remove/gu)?.length, 3)
})

test("editor renders same-name site rows separately from page rows", () => {
  const body = renderRows([
    row("og:locale:alternate", "fr_FR", true),
    row("og:locale:alternate", "de_DE", true),
    row("og:locale:alternate", "ja_JP", false)
  ])

  const rendered = [
    ...body.matchAll(/&lt;meta name="([^"]+)" content="([^"]+)"\/>/gu)
  ].map((match) => ({ name: match[1], content: match[2] }))
  assert.deepEqual(rendered, [
    { name: "og:locale:alternate", content: "fr_FR" },
    { name: "og:locale:alternate", content: "de_DE" },
    { name: "og:locale:alternate", content: "ja_JP" }
  ])
  assert.equal(body.match(/edit-meta-remove/gu)?.length, 3)
  assert.equal(body.match(/\(all pages\)/gu)?.length, 2)
})

test("the editor row each key is unique for every stored row", () => {
  assert.ok(rowsBlock.key, "the editor row each block must be keyed")

  const keyOf = new Function(
    rowsBlock.context.name,
    rowsBlock.index ?? "__unused_index",
    `return (${paneSource.slice(rowsBlock.key.start, rowsBlock.key.end)})`
  )
  const rows = [
    row("og:locale:alternate", "fr_FR", false),
    row("og:locale:alternate", "de_DE", false),
    row("og:locale:alternate", "fr_FR", true),
    row("og:locale:alternate", "de_DE", true),
    row("og:locale:alternate", "fr_FR", false)
  ]
  const keys = rows.map((metaTag, index) => keyOf(metaTag, index))
  assert.equal(new Set(keys).size, rows.length)
})
