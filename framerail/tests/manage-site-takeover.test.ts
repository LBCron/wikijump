import assert from "node:assert/strict"
import { test } from "node:test"

import { shouldRenderManageSiteTakeover } from "../src/lib/wikidot/manage-site-takeover.ts"

test("renders the manager document for a Wikidot-layout save takeover", () => {
  assert.equal(
    shouldRenderManageSiteTakeover("wikidot", {
      view: "found",
      manage_site_takeover: true
    }),
    true
  )
})

test("leaves ordinary and non-Wikidot page views on the site shell", () => {
  for (const [layout, view] of [
    ["wikijump", { view: "found", manage_site_takeover: true }],
    ["wikidot", { view: "found", manage_site_takeover: false }],
    ["wikidot", { view: "found" }],
    ["wikidot", { view: "missing", manage_site_takeover: true }],
    ["wikidot", null],
    ["wikidot", undefined]
  ] as const) {
    assert.equal(
      shouldRenderManageSiteTakeover(layout, view as never),
      false,
      `${layout} ${JSON.stringify(view)}`
    )
  }
})
