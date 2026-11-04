import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

const read = (relativePath: string) =>
  readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")

test("Edit Meta is a lazy native pane and never mounts the legacy response HTML", async () => {
  const [page, content, pane] = await Promise.all([
    read("src/routes/[slug]/[...extra]/PageView.svelte"),
    read("src/routes/[slug]/[...extra]/PagePaneContent.svelte"),
    read("src/routes/[slug]/[...extra]/EditMetaPane.svelte")
  ])
  assert.match(page, /activatePagePane\(PagePane\.EditMeta\)/u)
  assert.match(content, /await import\("\.\/EditMetaPane\.svelte"\)/u)
  assert.doesNotMatch(pane, /\{@html/u)
  assert.match(pane, /await reloadPane\(\)/u)
  assert.match(pane, /Add to All Pages/u)
  assert.match(pane, /Add to This Page/u)
})

test("effective metadata is projected through escaped Svelte head attributes", async () => {
  const [page, head] = await Promise.all([
    read("src/routes/[slug]/[...extra]/PageView.svelte"),
    read("src/routes/[slug]/[...extra]/PageHead.svelte")
  ])
  assert.match(page, /metaTags=\{showRevision \? \[\] : \(data\.meta_tags \?\? \[\]\)\}/u)
  assert.match(head, /<meta name=\{metaTag\.name\} content=\{metaTag\.content\} \/>/u)
  assert.doesNotMatch(head, /\{@html meta/u)
})

test("the public AMC route maps Edit Meta to the fixed Deepwell RPC boundary", async () => {
  const [route, deepwell] = await Promise.all([
    read("src/routes/ajax-module-connector.php/+server.ts"),
    read("src/lib/server/deepwell/page.ts")
  ])
  assert.match(route, /renderEditMetaModule/u)
  assert.match(route, /pageMetaTagSet/u)
  assert.match(route, /pageMetaTagDelete/u)
  assert.match(deepwell, /"page_meta_tags"/u)
  assert.match(deepwell, /"page_meta_tag_set"/u)
  assert.match(deepwell, /"page_meta_tag_delete"/u)
})
