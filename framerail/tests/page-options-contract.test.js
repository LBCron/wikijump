import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8")

const fields = (source, opening) => {
  const start = source.indexOf(opening)
  assert.notEqual(start, -1, opening)
  const body = source.slice(start + opening.length, source.indexOf("}", start))
  return [...body.matchAll(/^\s*(?:pub\s+)?([a-z_]+)\??:/gm)]
    .map((match) => match[1])
    .sort()
}

test("Framerail PageOptions names exactly Deepwell's page view option fields", () => {
  assert.deepEqual(
    fields(read("../src/lib/types.ts"), "export interface PageOptions {"),
    fields(
      read("../../deepwell/src/services/view/options.rs"),
      "pub struct PageOptions {"
    )
  )
})
