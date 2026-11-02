import assert from "node:assert/strict"
import test from "node:test"

import {
  BUILT_IN_THEME_ASSET_DIRS,
  builtInThemeAssetDirs,
  builtInThemeAssetUrls,
  builtInThemeHeadHtml,
  customThemeHeadHtml,
  normalizeThemeSetting
} from "../src/lib/site-settings.js"

const ORIGIN = "http://d3g0gp89917ko0.cloudfront.net/v--7690939296dc/common--theme"
const THEME_URL = (dir) => `${ORIGIN}/${dir}/css/style.css`
const builtIn = (id) => ({ type: "built_in", id })

const EXPECTED_DIRS = {
  1: ["base"],
  162746: ["bootstrap-base"],
  6651: ["base", "basic"],
  6258: ["base", "bloo"],
  6650: ["base", "bloo", "bloo-no-side-bar"],
  25: ["base", "cappuccino"],
  26: ["base", "cappuccino", "cappuccino-right"],
  2: ["base", "clean"],
  3: ["base", "clean", "clean-no-side-bar"],
  56: ["base", "co"],
  121: ["base", "co", "co-no-side-bar"],
  5: ["base", "flannel"],
  9: ["base", "flannel-nature"],
  10: ["base", "flannel-nature", "flannel-nature-no-side-bar"],
  6: ["base", "flannel", "flannel-no-side-bar"],
  7: ["base", "flannel-ocean"],
  8: ["base", "flannel-ocean", "flannel-ocean-no-side-bar"],
  57: ["base", "flower-blossom"],
  75: ["base", "flower-blossom", "flower-blossom-no-side-bar"],
  54: ["base", "gila"],
  55: ["base", "gila", "gila-no-side-bar"],
  58: ["base", "localize"],
  59: ["base", "localize", "localize-no-side-bar"],
  2439: ["base", "shiny"],
  2440: ["base", "shiny", "shiny-no-side-bar"],
  2437: ["base", "webbish2"],
  2438: ["base", "webbish2", "webbish2-no-side-bar"],
  122: ["base", "webbish"],
  123: ["base", "webbish", "webbish-no-side-bar"]
}

test("the frozen built-in table holds exactly the evidenced id ordering", () => {
  assert.equal(Object.keys(BUILT_IN_THEME_ASSET_DIRS).length, 29)
  assert.deepEqual(BUILT_IN_THEME_ASSET_DIRS, EXPECTED_DIRS)
  for (const id of [8248876, 8248881, 8248888]) {
    assert.equal(Object.hasOwn(BUILT_IN_THEME_ASSET_DIRS, id), false)
  }
})

test("every mapped id resolves to its exact ordered evidenced stylesheet URLs", () => {
  for (const [id, dirs] of Object.entries(EXPECTED_DIRS)) {
    const theme = builtIn(Number(id))
    assert.deepEqual(builtInThemeAssetDirs(theme), dirs, `dirs for ${id}`)
    assert.deepEqual(builtInThemeAssetUrls(theme), dirs.map(THEME_URL), `urls for ${id}`)
  }

  assert.deepEqual(builtInThemeAssetUrls(builtIn(6651)), [
    "http://d3g0gp89917ko0.cloudfront.net/v--7690939296dc/common--theme/base/css/style.css",
    "http://d3g0gp89917ko0.cloudfront.net/v--7690939296dc/common--theme/basic/css/style.css"
  ])
})

test("unknown and site custom theme ids fall back to Base", () => {
  for (const id of [999999, 8248876, 8248888]) {
    assert.deepEqual(builtInThemeAssetDirs(builtIn(id)), ["base"])
    assert.deepEqual(builtInThemeAssetUrls(builtIn(id)), [THEME_URL("base")])
    assert.equal(builtInThemeHeadHtml(builtIn(id)), "")
  }
  assert.deepEqual(normalizeThemeSetting(builtIn(8248876)), builtIn(8248876))
})

test("built-in emission appends the extra dirs after the local Base assets in live order", () => {
  assert.equal(builtInThemeHeadHtml(builtIn(1)), "")
  assert.equal(
    builtInThemeHeadHtml(builtIn(162746)),
    [
      '<style type="text/css" id="internal-style">',
      `@import url(${THEME_URL("bootstrap-base")});`,
      "</style>"
    ].join("\n")
  )
  assert.equal(
    builtInThemeHeadHtml(builtIn(3)),
    [
      '<style type="text/css" id="internal-style">',
      `@import url(${THEME_URL("clean")});`,
      `@import url(${THEME_URL("clean-no-side-bar")});`,
      "</style>"
    ].join("\n")
  )
  assert.equal(
    builtInThemeHeadHtml(builtIn(6650)).includes(THEME_URL("base")),
    false,
    "the established local Base assets already serve common--theme/base"
  )
})

test("external and custom themes keep their own emission", () => {
  const external = { type: "external", url: "https://cdn.scpwiki.com/site.css" }
  const custom = { type: "custom", css: "body { color: red; }" }

  assert.deepEqual(builtInThemeAssetDirs(external), [])
  assert.deepEqual(builtInThemeAssetUrls(external), [])
  assert.equal(builtInThemeHeadHtml(external), "")
  assert.equal(builtInThemeHeadHtml(custom), "")
  assert.deepEqual(builtInThemeAssetUrls(custom), [])

  assert.equal(
    customThemeHeadHtml(custom),
    `<style data-wikidot-site-theme>${custom.css}</style>`
  )
  assert.equal(customThemeHeadHtml(external), "")
})
