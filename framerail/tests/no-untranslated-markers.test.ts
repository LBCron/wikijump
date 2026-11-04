import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import test from "node:test"

const SOURCE = new URL("../src/", import.meta.url).pathname

function templates(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) return templates(path)
    return name.endsWith(".svelte") ? [path] : []
  })
}

test("no served template carries an UNTRANSLATED or UT developer marker", () => {
  for (const file of templates(SOURCE)) {
    const source = readFileSync(file, "utf8")
    assert.doesNotMatch(source, /UNTRANSLATED:|>\s*UT:/u, file)
  }
})
