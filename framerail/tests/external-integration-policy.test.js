import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  normalizeThemeSetting,
  resolveThemePreviewUrl
} from "../src/lib/site-settings.ts"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const layoutSource = fs.readFileSync(path.join(root, "src/routes/+layout.svelte"), "utf8")
const svelteConfigSource = fs.readFileSync(
  path.join(root, "sveltekit-options.ts"),
  "utf8"
)
const serverSource = [
  "src/lib/server/deepwell/index.ts",
  "src/lib/server/deepwell/views.ts",
  "src/lib/server/load/admin.ts"
].map((relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8"))

const shippedSourceFiles = (directory) => {
  const output = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      output.push(...shippedSourceFiles(fullPath))
    } else if (/\.(?:js|ts|svelte|html|scss|css)$/.test(entry.name)) {
      output.push(fullPath)
    }
  }
  return output
}

test("the local emulator ships no Google Analytics beacon", () => {
  const forbidden = [
    /google-analytics\.com/i,
    /googletagmanager\.com\/gtag/i,
    /\bgtag\s*\(/i,
    /\bga\s*\(\s*["']create["']/i,
    /analytics\.js/i
  ]

  for (const file of shippedSourceFiles(path.join(root, "src"))) {
    const source = fs.readFileSync(file, "utf8")
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${file} must not enable tracking`)
    }
  }
})

test("external theme resources use browser-direct failure ownership", () => {
  assert.deepEqual(
    normalizeThemeSetting({ type: "external", url: "https://cdn.scpwiki.com/site.css" }),
    { type: "external", url: "https://cdn.scpwiki.com/site.css" }
  )
  for (const url of [
    "http://cdn.scpwiki.com/site.css",
    "https://themes.example/site.css",
    "https://cdn.scpwiki.com:444/site.css",
    "https://user:password@cdn.scpwiki.com/site.css"
  ]) {
    assert.deepEqual(normalizeThemeSetting({ type: "external", url }), {
      type: "built_in",
      id: 1
    })
  }

  assert.match(
    layoutSource,
    /<link\s+data-wikidot-site-theme\s+href=\{externalThemeHref \?\? effectiveTheme\.url\}\s+rel="stylesheet"\s*\/>/u
  )
  assert.match(
    layoutSource,
    /<link data-wikidot-theme-preview href=\{themePreviewUrl\} rel="stylesheet" \/>/u
  )
  assert.doesNotMatch(layoutSource, /\b(?:fetch|XMLHttpRequest)\b/u)
  assert.doesNotMatch(layoutSource, /\bon(?:error|load)=/u)
  for (const source of serverSource) {
    assert.doesNotMatch(
      source,
      /theme_url/u,
      "server source must not proxy ThemePreviewer URLs"
    )
  }
  assert.match(svelteConfigSource, /"style-src": styleSources\(\)/u)
  assert.doesNotMatch(svelteConfigSource, /["']https:["']/u)

  const previousTheme = normalizeThemeSetting({
    type: "external",
    url: "https://cdn.scpwiki.com/previous.css"
  })
  const currentTheme = normalizeThemeSetting({
    type: "external",
    url: "https://themes.example/current.css"
  })
  assert.notDeepEqual(currentTheme, previousTheme)
  assert.deepEqual(currentTheme, { type: "built_in", id: 1 })
  assert.equal(
    resolveThemePreviewUrl(true, "https://themes.example/current.css"),
    null,
    "an invalid current preview must not reuse the previous stylesheet"
  )
})
