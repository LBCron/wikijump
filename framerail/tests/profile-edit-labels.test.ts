import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { fileURLToPath } from "node:url"

const profileEditorPath = fileURLToPath(
  new URL("../src/routes/[x+2d]/user/+page.svelte", import.meta.url)
)
const profileEditor = readFileSync(profileEditorPath, "utf8")

test("every profile editor field has a matching explicit label association", () => {
  const labels = [...profileEditor.matchAll(/<label\b[^>]*\bfor="([^"]+)"[^>]*>/gs)].map(
    (match) => match[1]
  )
  const inputs = [...profileEditor.matchAll(/<input\b[^>]*>/gs)].map((match) => match[0])
  const inputIds = inputs.map((input) => /\bid="([^"]+)"/u.exec(input)?.[1])

  assert.equal(labels.length, 12)
  assert.ok(labels.includes("current-password"))
  assert.equal(new Set(labels).size, labels.length, "label targets must be unique")
  assert.equal(new Set(inputIds).size, inputIds.length, "input ids must be unique")

  for (const labelFor of labels) {
    assert.ok(inputIds.includes(labelFor), `no editor input has id=${labelFor}`)
  }
})
