import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import test from "node:test"

const repoRoot = fileURLToPath(new URL("../../", import.meta.url))

const allowlist = new Set([
  "framerail/eslint.config.mjs",
  "framerail/prettier.config.mjs",
  "framerail/stylelint.config.mjs",
  "framerail/static/wikidot/scripts/tabview-compat.js"
])

test("framerail has no first-party JavaScript outside the allowlist", () => {
  const listed = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "--", "framerail"],
    { cwd: repoRoot, encoding: "utf8" }
  )
  const offenders = listed
    .split("\n")
    .filter((path) => /\.(?:js|mjs|cjs)$/.test(path))
    .filter((path) => !allowlist.has(path))
  assert.deepEqual(
    offenders,
    [],
    `first-party JavaScript files are banned in framerail; convert or remove: ${offenders.join(", ")}`
  )
})
