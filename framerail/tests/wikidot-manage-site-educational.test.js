import assert from "node:assert/strict"
import test from "node:test"

import { renderWikidotManageSiteEducational } from "../src/lib/server/wikidot-manage-site-educational.ts"

test("Educational upgrade renders the observed application and benefits", () => {
  const body = renderWikidotManageSiteEducational()
  assert.match(body, /<h1>Edu upgrade<small><\/small><\/h1>/u)
  assert.match(body, /Wikidot for educational purposes/u)
  assert.match(body, /unlimited number of members in private sites/u)
  assert.match(body, /25 GB/u)
  assert.match(body, /100MB/u)
  assert.match(body, /SSL/u)
  assert.match(body, /unlimited revisions/u)
  assert.match(body, /absolutely free/u)
  assert.match(body, /<form id="sm-eduupgrade-form">/u)
  assert.match(body, /name="organization"/u)
  assert.match(body, /name="purpose"/u)
  assert.match(body, /Please upgrade my site now/u)
})
