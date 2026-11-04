import { strict as assert } from "node:assert"
import test from "node:test"

import {
  buildWikidotSectionEditSubmission,
  buildWikidotSectionEditSource,
  findWikidotEditSections,
  toggleWikidotEditSections
} from "../src/lib/wikidot/wikidot-edit-sections.ts"

/** @param {any} level @param {any} index @returns {any} */
const heading = (level, index) => ({ id: `toc${index}`, tagName: `H${level}` })

/** @param {any} directHeadings @param {any} [descendantHeadings] */
const pageContent = (directHeadings, descendantHeadings = directHeadings) => ({
  children: directHeadings,
  querySelectorAll() {
    return descendantHeadings
  }
})

test("Edit Sections maps top-level source headings to exact rendered sections", () => {
  const source =
    "+ Alpha heading\n\nAlpha body.\n\n++ Beta heading\n\nBeta body.\n\n+ Gamma heading\n\nGamma body."
  const sections = findWikidotEditSections(
    source,
    pageContent([heading(1, 0), heading(2, 1), heading(1, 2)])
  )

  assert.deepEqual(sections, [
    { index: 0, level: 1, start: 0, end: 59 },
    { index: 1, level: 2, start: 30, end: 59 },
    { index: 2, level: 1, start: 59, end: source.length }
  ])
  assert.equal(source.slice(sections[0].start, sections[0].end), source.slice(0, 59))
  assert.equal(
    source.slice(sections[1].start, sections[1].end),
    "++ Beta heading\n\nBeta body.\n\n"
  )
})

test("Edit Sections supports repeated tertiary headings through end of source", () => {
  const source =
    "+++ Tertiary heading\n\nTertiary body.\n\n+++ Second tertiary\n\nSecond body."
  const sections = findWikidotEditSections(
    source,
    pageContent([heading(3, 0), heading(3, 1)])
  )

  assert.equal(
    source.slice(sections[1].start, sections[1].end),
    "+++ Second tertiary\n\nSecond body."
  )
})

test("Edit Sections handles large heading sequences without copying suffixes", () => {
  const source = Array(30000).fill("+ Heading").join("\n")
  const sections = findWikidotEditSections(
    source,
    pageContent(Array.from({ length: 30000 }, (_, index) => heading(1, index)))
  )

  assert.equal(sections.length, 30000)
  assert.equal(sections[0].end, source.indexOf("\n") + 1)
  assert.equal(/** @type {any} */ (sections.at(-1)).end, source.length)
})

test("Edit Sections fails closed without a one-to-one direct heading match", () => {
  const source = "+ Direct\n\nBody"
  assert.deepEqual(findWikidotEditSections(source, pageContent([])), [])
  assert.deepEqual(
    findWikidotEditSections(source, pageContent([], [heading(1, 0), heading(2, 1)])),
    []
  )
  assert.deepEqual(
    findWikidotEditSections(
      source,
      pageContent([heading(1, 0)], [heading(1, 0), heading(2, 1)])
    ),
    []
  )
  assert.deepEqual(findWikidotEditSections(source, pageContent([heading(2, 0)])), [])
  assert.deepEqual(
    findWikidotEditSections(source, pageContent([{ id: "toc1", tagName: "H1" }])),
    []
  )
})

test("Edit Sections inserts evidenced controls and toggles them off", () => {
  /** @type {any[]} */
  const controls = []
  /** @type {any[]} */
  const edits = []
  const headings = [heading(1, 0), heading(2, 1)]
  for (const renderedHeading of headings) {
    renderedHeading.before = /** @param {any} control */ (control) =>
      controls.push(control)
  }
  const ownerDocument = {
    createElement() {
      const listeners = new Map()
      return {
        addEventListener: /** @param {any} name @param {any} listener */ (
          name,
          listener
        ) => listeners.set(name, listener),
        click() {
          listeners.get("click")({ preventDefault() {} })
        },
        remove() {
          controls.splice(controls.indexOf(this), 1)
        }
      }
    }
  }
  const root = {
    children: headings,
    ownerDocument,
    /** @param {any} selector */
    querySelectorAll(selector) {
      return selector === ".edit-section-button" ? [...controls] : headings
    }
  }

  assert.equal(
    toggleWikidotEditSections(
      /** @type {any} */ (root),
      "+ One\n\nBody\n\n++ Two\n\nBody",
      (section) => edits.push(section.index)
    ),
    true
  )
  assert.deepEqual(
    controls.map(({ className, href, id, textContent }) => ({
      className,
      href,
      id,
      textContent
    })),
    [
      {
        className: "edit-section-button",
        // eslint-disable-next-line no-script-url -- This fixture asserts Wikidot's observed inert href.
        href: "javascript:;",
        id: "edit-section-b-0",
        textContent: "edit"
      },
      {
        className: "edit-section-button",
        // eslint-disable-next-line no-script-url -- This fixture asserts Wikidot's observed inert href.
        href: "javascript:;",
        id: "edit-section-b-1",
        textContent: "edit"
      }
    ]
  )
  controls[1].click()
  assert.deepEqual(edits, [1])
  assert.equal(
    toggleWikidotEditSections(/** @type {any} */ (root), "ignored", () => {}),
    false
  )
  assert.deepEqual(controls, [])
})

test("section edit submission replaces only its revision-bound source range", () => {
  const source = "+ One\n\nOriginal.\n\n+ Two\n\nKeep."
  const section = { index: 0, level: 1, start: 0, end: 18 }
  assert.equal(
    buildWikidotSectionEditSource(source, section, "+ One\n\nChanged.\n\n"),
    "+ One\n\nChanged.\n\n+ Two\n\nKeep."
  )
  assert.deepEqual(
    buildWikidotSectionEditSubmission(
      { title: "changed", altTitle: "changed", tags: "changed", comments: "reason" },
      {
        siteId: 12,
        pageId: 34,
        revisionId: 56,
        title: "Original title",
        altTitle: "Original alt title",
        tags: "alpha beta",
        source
      },
      section,
      "+ One\n\nChanged.\n\n"
    ),
    {
      siteId: 12,
      pageId: 34,
      lastRevisionId: 56,
      title: "Original title",
      altTitle: "Original alt title",
      tags: "alpha beta",
      comments: "reason",
      wikitext: "+ One\n\nChanged.\n\n+ Two\n\nKeep."
    }
  )
})
