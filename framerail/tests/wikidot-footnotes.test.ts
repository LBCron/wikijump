import assert from "node:assert/strict"
import test from "node:test"

import { legacyReferenceTargetId } from "../src/lib/wikidot/wikidot-footnotes.ts"

test("accepts footnote and footnoteref scroll targets", () => {
  assert.equal(
    legacyReferenceTargetId("WIKIDOT.page.utils.scrollToReference('footnote-1')"),
    "footnote-1"
  )
  assert.equal(
    legacyReferenceTargetId('WIKIDOT.page.utils.scrollToReference("footnoteref-2")'),
    "footnoteref-2"
  )
})

test("accepts bibliography scroll targets from bibcite markers", () => {
  assert.equal(
    legacyReferenceTargetId("WIKIDOT.page.utils.scrollToReference('bibitem-1')"),
    "bibitem-1"
  )
  assert.equal(
    legacyReferenceTargetId("WIKIDOT.page.utils.scrollToReference('bibitem-12');"),
    "bibitem-12"
  )
})

test("accepts equation scroll targets from eref markers", () => {
  assert.equal(
    legacyReferenceTargetId("WIKIDOT.page.utils.scrollToReference('equation-1')"),
    "equation-1"
  )
  assert.equal(
    legacyReferenceTargetId(" WIKIDOT.page.utils.scrollToReference( 'equation-23' ) "),
    "equation-23"
  )
})

test("rejects handlers and targets outside the reference families", () => {
  assert.equal(legacyReferenceTargetId(null), null)
  assert.equal(legacyReferenceTargetId(""), null)
  assert.equal(
    legacyReferenceTargetId("WIKIDOT.page.utils.scrollToReference('toc-1')"),
    null
  )
  assert.equal(
    legacyReferenceTargetId("WIKIDOT.page.utils.scrollToReference('bibitem')"),
    null
  )
  assert.equal(
    legacyReferenceTargetId("WIKIDOT.page.utils.scrollToReference('equation-')"),
    null
  )
  assert.equal(legacyReferenceTargetId("alert('footnote-1')"), null)
  assert.equal(
    legacyReferenceTargetId(
      "WIKIDOT.page.utils.scrollToReference('footnote-1'); other()"
    ),
    null
  )
})
