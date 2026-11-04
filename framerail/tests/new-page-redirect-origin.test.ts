import { strict as assert } from "node:assert"
import test from "node:test"

import { installWikidotNewPageHelper } from "../src/lib/wikidot/wikidot-new-page-helper.ts"
import type { WikidotNewPageRoot } from "../src/lib/wikidot/wikidot-new-page-helper.ts"

const makeRoot = (): WikidotNewPageRoot =>
  ({
    location: {
      href: "https://wiki.example.test/source-page",
      origin: "https://wiki.example.test",
      reload() {
        ;(this as { reloaded?: boolean }).reloaded = true
      }
    },
    document: undefined
  }) as unknown as WikidotNewPageRoot

test("NewPage redirects keep documented relative routes on the current origin", () => {
  const root = makeRoot()
  const helper = installWikidotNewPageHelper(root)

  helper.callbacks.create({ status: "ok", goToUrl: "run-owned:new-page" })

  assert.equal(root.location.href, "/run-owned:new-page")
})

test("NewPage goTo responses cannot navigate off-origin via slash or backslash", () => {
  for (const goToUrl of ["//attacker.example/path", "\\\\attacker.example/path"]) {
    const root = makeRoot()
    const helper = installWikidotNewPageHelper(root)
    const originalUrl = root.location.href

    helper.callbacks.create({ status: "ok", goToUrl })

    assert.equal(
      root.location.href,
      originalUrl,
      `unsafe goToUrl ${JSON.stringify(goToUrl)}`
    )
  }
})

test("NewPage edit routing rejects an off-origin unixName without rewriting valid routes", () => {
  const attackerRoot = makeRoot()
  installWikidotNewPageHelper(attackerRoot).callbacks.create({
    status: "ok",
    unixName: "//attacker.example"
  })
  assert.equal(attackerRoot.location.href, "https://wiki.example.test/source-page")

  const validRoot = makeRoot()
  installWikidotNewPageHelper(validRoot).callbacks.create({
    status: "ok",
    unixName: "run-owned:page",
    templateId: "17",
    pageTitle: "A page title",
    tags: "alpha beta",
    parentPage: "main"
  })
  assert.equal(
    validRoot.location.href,
    "/run-owned:page/edit/true/t/17/title/A%20page%20title/tags/alpha%20beta/parentPage/main"
  )
})
