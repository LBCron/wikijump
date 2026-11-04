import assert from "node:assert/strict"
import test from "node:test"

import {
  installWikidotSearchAll,
  submitWikidotTopSearch,
  wikidotSearchAllPath,
  wikidotSearchPath
} from "../src/lib/wikidot/wikidot-search.ts"

test("Wikidot top search preserves and path-encodes the submitted query", () => {
  assert.equal(
    wikidotSearchPath("codex search probe"),
    "/search:site/q/codex%20search%20probe"
  )
  assert.equal(wikidotSearchPath("  a/b? c  "), "/search:site/q/%20%20a%2Fb%3F%20c%20%20")
  assert.equal(
    wikidotSearchPath("Search this site"),
    "/search:site/q/Search%20this%20site"
  )
})

test("Wikidot top search intercepts the legacy dummy form action", () => {
  const window = { location: { href: "/dummy" } }
  let prevented = false
  const handled = submitWikidotTopSearch(
    {
      currentTarget: {
        elements: {
          namedItem: (name: string) => (name === "query" ? { value: "  a/b? c  " } : null)
        }
      },
      preventDefault() {
        prevented = true
      }
    } as unknown as SubmitEvent,
    window as unknown as Window
  )

  assert.equal(handled, true)
  assert.equal(prevented, true)
  assert.equal(window.location.href, "/search:site/q/%20%20a%2Fb%3F%20c%20%20")
})

test("Wikidot SearchAll preserves its area and path-encodes the submitted query", () => {
  assert.equal(wikidotSearchAllPath("wikidot", "pf"), "/search:all/a/pf/q/wikidot")
  assert.equal(wikidotSearchAllPath("wikidot", "p"), "/search:all/a/p/q/wikidot")
  assert.equal(wikidotSearchAllPath("wikidot", "f"), "/search:all/a/f/q/wikidot")
  assert.equal(
    wikidotSearchAllPath("  a/b? c  ", "pf"),
    "/search:all/a/pf/q/%20%20a%2Fb%3F%20c%20%20"
  )
})

test("Wikidot SearchAll submit listener navigates rendered module forms", () => {
  type SearchListener = (event: { target: unknown; preventDefault: () => void }) => void
  const listeners = new Map<string, { listener: SearchListener; capture: unknown }>()
  const document = {
    addEventListener(type: string, listener: SearchListener, capture: unknown) {
      listeners.set(type, { listener, capture })
    },
    removeEventListener(type: string, listener: SearchListener, capture: unknown) {
      const registration = listeners.get(type)
      if (registration?.listener === listener && registration.capture === capture) {
        listeners.delete(type)
      }
    }
  }
  const window = { document, location: { href: "http://example.test/current" } }
  const controls = new Map([
    ["query", { value: "  a/b? c  " }],
    ["area", { value: "f" }]
  ])
  const form = {
    id: "search-form-all",
    elements: { namedItem: (name: string) => controls.get(name) ?? null }
  }
  let prevented = false

  const dispose = installWikidotSearchAll(window as unknown as Window)
  const registration = listeners.get("submit")!
  assert.equal(registration.capture, true)
  registration.listener({
    target: form,
    preventDefault() {
      prevented = true
    }
  })

  assert.equal(prevented, true)
  assert.equal(window.location.href, "/search:all/a/f/q/%20%20a%2Fb%3F%20c%20%20")
  dispose()
  assert.equal(listeners.has("submit"), false)
})
