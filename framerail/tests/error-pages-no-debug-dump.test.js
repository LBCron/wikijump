import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

const ROUTES = new URL("../src/routes/", import.meta.url).pathname

function svelteFiles(directory) {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return svelteFiles(path)
    return name.endsWith(".svelte") ? [path] : []
  })
}

test("no route dumps its page state except the explicit wiki-page debug view", () => {
  for (const file of svelteFiles(ROUTES)) {
    const source = readFileSync(file, "utf8")
    const dumps = source.split('<textarea class="debug">').length - 1
    if (dumps === 0) continue
    assert.ok(file.endsWith("PageView.svelte"), `${file} renders a debug dump`)
    const guarded =
      source.split(
        /\{#if data\.options\?\.debug\}\s*(?:<div[^>]*>\s*)?<textarea class="debug">/
      ).length - 1
    assert.equal(guarded, dumps, `${file} renders an unguarded debug dump`)
  }
})
