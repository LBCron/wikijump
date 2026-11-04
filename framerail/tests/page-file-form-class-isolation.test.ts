import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

const components = [
  "src/routes/[slug]/[...extra]/FilePane.svelte",
  "src/routes/[slug]/[...extra]/FileUploadPanel.svelte"
]

test("Files form name controls do not expose the generic name theme hook", async () => {
  const violations = []

  for (const component of components) {
    const source = await readFile(new URL(`../${component}`, import.meta.url), "utf8")
    const nameControl =
      /<input\s+[\s\S]*?name="name"[\s\S]*?class="([^"]+)"[\s\S]*?>/u.exec(source)

    assert.ok(nameControl, `${component} renders the file name control`)
    const classes = nameControl[1].split(/\s+/u)
    if (classes.includes("name")) violations.push(`${component}: class name`)
    if (!classes.includes("file-name")) violations.push(`${component}: missing file-name`)
    if (/\.file-attribute\.name\b/u.test(source)) {
      violations.push(`${component}: selector .file-attribute.name`)
    }
  }

  assert.deepEqual(violations, [])
})
