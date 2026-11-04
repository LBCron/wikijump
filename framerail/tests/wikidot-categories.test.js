import assert from "node:assert/strict"
import test from "node:test"

import { installWikidotCategories } from "../src/lib/wikidot/wikidot-categories.ts"

test("Wikidot Categories loads once then toggles the retained page list locally", async () => {
  const elements = new Map([
    [
      "category-pages-17",
      {
        style: { display: "none" },
        innerHTML: ""
      }
    ],
    [
      "category-pages-toggler-17",
      {
        textContent: "+ list pages"
      }
    ]
  ])
  const requests = []
  const root = {
    document: {
      getElementById(id) {
        return elements.get(id) ?? null
      }
    },
    async fetch(url, init) {
      requests.push({ url, init })
      return {
        async json() {
          return {
            status: "ok",
            categoryId: 17,
            body: '<ul><li><a href="/alpha">Alpha</a></li></ul>'
          }
        }
      }
    }
  }
  let prevented = 0
  let stopped = 0
  const event = {
    preventDefault() {
      prevented += 1
    },
    stopPropagation() {
      stopped += 1
    }
  }

  const module = installWikidotCategories(root)
  assert.equal(module.listeners.toggleListPages(event, 17), false)
  assert.equal(elements.get("category-pages-17").style.display, "block")
  assert.equal(
    elements.get("category-pages-17").innerHTML,
    '<div class="wait-block">loading page list...</div>'
  )
  assert.equal(elements.get("category-pages-toggler-17").textContent, "- hide pages")
  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, "/ajax-module-connector.php")
  assert.equal(requests[0].init.method, "POST")
  assert.equal(
    requests[0].init.body.toString(),
    "moduleName=list%2FWikiCategoriesPageListModule&category_id=17"
  )

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    elements.get("category-pages-17").innerHTML,
    '<ul><li><a href="/alpha">Alpha</a></li></ul>'
  )

  assert.equal(module.listeners.toggleListPages(event, 17), false)
  assert.equal(elements.get("category-pages-17").style.display, "none")
  assert.equal(elements.get("category-pages-toggler-17").textContent, "+ list pages")
  assert.equal(requests.length, 1)

  assert.equal(module.listeners.toggleListPages(event, 17), false)
  assert.equal(elements.get("category-pages-17").style.display, "block")
  assert.equal(elements.get("category-pages-toggler-17").textContent, "- hide pages")
  assert.equal(requests.length, 1)
  assert.equal(prevented, 3)
  assert.equal(stopped, 3)
})

test("Wikidot Categories ignores malformed or detached controls without a request", () => {
  let requests = 0
  const root = {
    document: { getElementById: () => null },
    async fetch() {
      requests += 1
    }
  }
  const module = installWikidotCategories(root)

  assert.equal(module.listeners.toggleListPages(undefined, 0), false)
  assert.equal(module.listeners.toggleListPages(undefined, Number.NaN), false)
  assert.equal(module.listeners.toggleListPages(undefined, 17), false)
  assert.equal(requests, 0)
})

test("Wikidot Categories delegates retained inline controls under strict CSP", async () => {
  const listeners = []
  const list = { style: { display: "none" }, innerHTML: "" }
  const toggler = {
    id: "category-pages-toggler-17",
    textContent: "+ list pages",
    closest(selector) {
      return selector === 'a[id^="category-pages-toggler-"]' ? this : null
    },
    getAttribute(name) {
      return name === "onclick"
        ? "WIKIDOT.modules.WikiCategoriesModule.listeners.toggleListPages(event, 17)"
        : null
    }
  }
  const elements = new Map([
    ["category-pages-17", list],
    ["category-pages-toggler-17", toggler]
  ])
  const requests = []
  const root = {
    document: {
      addEventListener(type, listener, capture) {
        listeners.push({ type, listener, capture })
      },
      getElementById(id) {
        return elements.get(id) ?? null
      }
    },
    async fetch(url, init) {
      requests.push({ url, init })
      return {
        async json() {
          return { status: "ok", categoryId: 17, body: "<ul><li>Alpha</li></ul>" }
        }
      }
    }
  }
  let prevented = 0
  let stopped = 0
  const event = {
    target: toggler,
    preventDefault() {
      prevented += 1
    },
    stopPropagation() {
      stopped += 1
    }
  }

  installWikidotCategories(root)
  installWikidotCategories(root)
  assert.equal(listeners.length, 1)
  assert.deepEqual(
    { type: listeners[0].type, capture: listeners[0].capture },
    { type: "click", capture: true }
  )

  listeners[0].listener(event)
  assert.equal(prevented, 1)
  assert.equal(stopped, 1)
  assert.equal(list.style.display, "block")
  assert.equal(toggler.textContent, "- hide pages")
  assert.equal(requests.length, 1)

  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(list.innerHTML, "<ul><li>Alpha</li></ul>")
})
