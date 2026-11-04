import { strict as assert } from "node:assert"
import test from "node:test"

import {
  buildWikidotInterwikiFrameHtml,
  extractWikidotInterwikiLinks
} from "../src/lib/wikidot/wikidot-interwiki.ts"
import { installWikidotInterwikiStyleRuntime } from "../src/lib/wikidot/wikidot-interwiki-style-runtime.ts"
import { localizeWikidotThemeUrl } from "../src/lib/wikidot/wikidot-styleframe-contract.ts"
import {
  WIKIDOT_STYLE_FRAME_SCRIPT,
  buildWikidotStyleFrameHtml
} from "../src/lib/wikidot/wikidot-styleframe.ts"

class FakeElement {
  tagName: string
  attributes: Map<string, string>
  textContent: string
  dataset: Record<string, string>
  classList: { add: (name: string) => void }
  listeners?: Map<string, (() => void)[]>
  sheet?: unknown

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase()
    this.attributes = new Map()
    this.textContent = ""
    const attributes = this.attributes
    this.dataset = new Proxy<Record<string, string>>(
      {},
      {
        get: (_target, key) => attributes.get(`data-${String(key)}`),
        set: (_target, key, value) => {
          attributes.set(`data-${String(key)}`, String(value))
          return true
        }
      }
    )
    this.classList = {
      add: (name: string) => {
        const names = new Set((attributes.get("class") ?? "").split(" ").filter(Boolean))
        names.add(name)
        attributes.set("class", [...names].join(" "))
      }
    }
  }

  getAttribute(name: string) {
    return this.attributes.has(name) ? this.attributes.get(name) : null
  }

  setAttribute(name: string, value: string) {
    this.attributes.set(name, String(value))
  }

  set rel(value: string) {
    this.setAttribute("rel", value)
  }

  set href(value: string) {
    this.setAttribute("href", value)
  }

  addEventListener(type: string, listener: () => void) {
    this.listeners = this.listeners ?? new Map()
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener])
  }

  fire(type: string) {
    for (const listener of this.listeners?.get(type) ?? []) listener()
  }
}

class FakeHead {
  children: FakeElement[]

  constructor(children: FakeElement[] = []) {
    this.children = children
  }

  querySelectorAll(selectors: string) {
    const matchers = selectors.split(",").map((selector) => {
      const [tagName, className] = selector.trim().split(".")
      return { tagName: tagName.toUpperCase(), className }
    })
    return this.children.filter((element) =>
      matchers.some(
        ({ tagName, className }) =>
          element.tagName === tagName &&
          (element.getAttribute("class") ?? "").split(" ").includes(className as string)
      )
    )
  }

  insertBefore(element: FakeElement, reference: FakeElement) {
    this.children.splice(this.children.indexOf(reference), 0, element)
  }

  appendChild(element: FakeElement) {
    this.children.push(element)
  }
}

type FakeFrameWindow = {
  document: {
    readyState: string
    head: FakeHead
    createElement: (tagName: string) => FakeElement
  }
  location: { origin: string }
  parent: Record<string, unknown>
  DOMException: typeof DOMException
  addEventListener: (type: string, listener: () => void) => void
  dispatch: (type: string) => void
  requestStyleChange: (search: string) => void
  isInterwikiFrame?: boolean
  dispatchEvent?: (event: { type: string }) => unknown
  Event?: unknown
  setTimeout?: (callback: () => void) => unknown
}

const baseStylesheet = () => {
  const link = new FakeElement("link")
  link.setAttribute("rel", "stylesheet")
  link.setAttribute("href", "/wikidot/styles/wikidot-base-165bc434fd1d.css")
  link.setAttribute("class", "custom-style")
  link.setAttribute("data-priority", "-1")
  return link
}

const styleFrame = (search: string) => ({ isStyleFrame: true, location: { search } })

const fakeFrameWindow = ({
  siblings = [],
  readyState = "loading"
}: { siblings?: unknown[]; readyState?: string } = {}): FakeFrameWindow => {
  const listeners = new Map<string, () => void>()
  const parentTarget: Record<string, unknown> = { length: siblings.length }
  siblings.forEach((sibling, index) => {
    parentTarget[index] = sibling
  })
  const parent = new Proxy(parentTarget, {
    get: (target, key) => {
      if (key === "document") {
        throw new Error("the parent document must not be accessed")
      }
      return Reflect.get(target, key)
    }
  })
  return {
    document: {
      readyState,
      head: new FakeHead([baseStylesheet()]),
      createElement: (tagName: string) => new FakeElement(tagName)
    },
    location: { origin: "https://scp-wiki.wikijump.localhost" },
    parent,
    DOMException,
    addEventListener: (type: string, listener: () => void) =>
      listeners.set(type, listener),
    dispatch: (type: string) => listeners.get(type)?.()
  } as unknown as FakeFrameWindow
}

const install = (
  frameWindow: FakeFrameWindow,
  siteUrl = "https://scp-wiki.wikidot.com"
) =>
  installWikidotInterwikiStyleRuntime(
    frameWindow as unknown as Parameters<typeof installWikidotInterwikiStyleRuntime>[0],
    { siteUrl },
    localizeWikidotThemeUrl
  )

const headShape = (frameWindow: FakeFrameWindow) =>
  frameWindow.document.head.children
    .filter((element) => !element.dataset.wikijumpThemePending)
    .map((element) => [
      element.tagName,
      element.getAttribute("data-priority"),
      element.tagName === "LINK" ? element.getAttribute("href") : element.textContent
    ])

test("serves Wikidot's static styleFrame document without echoing its query", () => {
  const html = buildWikidotStyleFrameHtml()

  assert.ok(html.includes(`<script>${WIKIDOT_STYLE_FRAME_SCRIPT}</script>`))
  assert.match(WIKIDOT_STYLE_FRAME_SCRIPT, /window\.isStyleFrame = true;/u)
  assert.match(
    WIKIDOT_STYLE_FRAME_SCRIPT,
    /frame\.requestStyleChange\(location\.search\);/u
  )
  assert.doesNotMatch(html, /<style|<link|<ul|parent\.document|\{\$css\}/u)
})

test("styleFrame pushes its query only to initialized sibling interwiki frames", () => {
  const received: string[] = []
  const interwiki = {
    isInterwikiFrame: true,
    requestStyleChange: (search: string) => received.push(search)
  }
  const crossOrigin = {
    get isInterwikiFrame() {
      throw new DOMException("Blocked a frame", "SecurityError")
    }
  }
  const parent = {
    length: 3,
    0: crossOrigin,
    1: { isInterwikiFrame: false },
    2: interwiki
  }
  const frameWindow: { parent: typeof parent; isStyleFrame?: boolean } = { parent }
  new Function(
    "window",
    "parent",
    "location",
    "DOMException",
    WIKIDOT_STYLE_FRAME_SCRIPT
  )(frameWindow, parent, { search: "?priority=2&css=a" }, DOMException)

  assert.equal(frameWindow.isStyleFrame, true)
  assert.deepEqual(received, ["?priority=2&css=a"])
})

test("merges styleFrame declarations into the interwiki frame by Wikidot priority", () => {
  const frameWindow = fakeFrameWindow()
  install(frameWindow)
  frameWindow.dispatch("DOMContentLoaded")

  frameWindow.requestStyleChange(
    "?priority=3&theme=https://cdn.scpwiki.com/c.css&css=.c{}"
  )
  frameWindow.requestStyleChange(
    "?priority=1&css=.a{}&theme=https://cdn.scpwiki.com/a.css"
  )
  frameWindow.requestStyleChange("?priority=2&theme=https://cdn.scpwiki.com/b.css")

  assert.deepEqual(headShape(frameWindow), [
    ["LINK", "-1", "/wikidot/styles/wikidot-base-165bc434fd1d.css"],
    ["LINK", "1", "https://cdn.scpwiki.com/a.css"],
    ["STYLE", "1", ".a{}"],
    ["LINK", "2", "https://cdn.scpwiki.com/b.css"],
    ["LINK", "3", "https://cdn.scpwiki.com/c.css"],
    ["STYLE", "3", ".c{}"]
  ])
})

test("keeps Wikidot's duplicate, same-priority, and invalid-priority quirks", () => {
  const frameWindow = fakeFrameWindow()
  install(frameWindow)
  frameWindow.dispatch("DOMContentLoaded")

  frameWindow.requestStyleChange("?priority=1&theme=https://cdn.scpwiki.com/first.css")
  frameWindow.requestStyleChange("?priority=1&theme=https://cdn.scpwiki.com/second.css")
  frameWindow.requestStyleChange("?priority=1&theme=https://cdn.scpwiki.com/first.css")
  frameWindow.requestStyleChange("?priority=x&css=.rejected{}")
  frameWindow.requestStyleChange("?css=.empty-priority-is-zero{}")
  frameWindow.requestStyleChange("?priority=4&css=first&css=a%2Bb+c")
  frameWindow.requestStyleChange("?priority=5&css={$css}")

  assert.deepEqual(headShape(frameWindow), [
    ["LINK", "-1", "/wikidot/styles/wikidot-base-165bc434fd1d.css"],
    ["STYLE", "0", ".empty-priority-is-zero{}"],
    ["LINK", "1", "https://cdn.scpwiki.com/second.css"],
    ["LINK", "1", "https://cdn.scpwiki.com/first.css"],
    ["STYLE", "4", "a+b+c"],
    ["STYLE", "5", "{$css}"]
  ])
})

test("resolves Wikidot theme names on the community site and localizes page code", () => {
  const frameWindow = fakeFrameWindow()
  install(frameWindow)
  frameWindow.dispatch("DOMContentLoaded")

  frameWindow.requestStyleChange("?priority=1&theme=theme:basalt")
  frameWindow.requestStyleChange("?priority=2&theme=theme:black-highlighter/code/2")
  frameWindow.requestStyleChange("?priority=3&theme=theme/unknown")
  frameWindow.requestStyleChange(
    "?priority=4&theme=//cdn.scpwiki.com/protocol-relative.css"
  )
  frameWindow.requestStyleChange(
    "?priority=5&theme=https%3A%2F%2Fscp-wiki.wdfiles.com%2Flocal--code%2Ftheme%253Abasalt%2F1"
  )

  assert.deepEqual(headShape(frameWindow).slice(1), [
    ["LINK", "1", "https://scp-wiki.wjfiles.localhost/local--code/theme:basalt/1"],
    [
      "LINK",
      "2",
      "https://scp-wiki.wjfiles.localhost/local--code/theme:black-highlighter/2"
    ],
    ["LINK", "4", "//cdn.scpwiki.com/protocol-relative.css"],
    ["LINK", "5", "https://scp-wiki.wjfiles.localhost/local--code/theme%3Abasalt/1"]
  ])
})

test("pulls styleFrames that loaded before the interwiki frame initialized", () => {
  const crossOrigin = {
    get isStyleFrame() {
      throw new DOMException("Blocked a frame", "SecurityError")
    }
  }
  const frameWindow = fakeFrameWindow({
    siblings: [
      styleFrame("?priority=2&css=.late{}"),
      crossOrigin,
      { isStyleFrame: false },
      styleFrame("?priority=1&theme=https://cdn.scpwiki.com/early.css")
    ]
  })
  install(frameWindow)

  assert.equal(frameWindow.isInterwikiFrame, undefined)
  frameWindow.dispatch("DOMContentLoaded")
  assert.equal(frameWindow.isInterwikiFrame, true)
  assert.deepEqual(headShape(frameWindow).slice(1), [
    ["LINK", "1", "https://cdn.scpwiki.com/early.css"],
    ["STYLE", "2", ".late{}"]
  ])
})

test("serves an interwiki frame that is styled only by styleFrames", () => {
  const html = buildWikidotInterwikiFrameHtml({
    community: "scp",
    lang: "en",
    pagename: "scp-9506",
    page: null
  })

  assert.doesNotMatch(html, /sigma/u)
  assert.match(
    html,
    /<link rel="stylesheet" href="\/wikidot\/styles\/wikidot-base-165bc434fd1d\.css" class="custom-style" data-priority="-1">/u
  )
  assert.doesNotMatch(
    buildWikidotInterwikiFrameHtml({
      community: "scp",
      lang: "en",
      pagename: "scp-9506",
      page: null,
      preventWikidotBaseStyle: true
    }),
    /wikidot-base/u
  )
})

test("the served interwiki frame script installs the style runtime as serialized", () => {
  const html = buildWikidotInterwikiFrameHtml({
    community: "scp",
    lang: "en",
    pagename: "scp-9506",
    page: null
  })
  const scriptStart = html.indexOf("<script>") + "<script>".length
  const script = html.slice(scriptStart, html.indexOf("</script>", scriptStart))
  const frameWindow = fakeFrameWindow({
    siblings: [styleFrame("?priority=1&theme=theme:basalt&css=.panel{}")]
  })
  new Function("window", "document", "addEventListener", script)(
    frameWindow,
    frameWindow.document,
    frameWindow.addEventListener
  )
  frameWindow.dispatch("DOMContentLoaded")

  assert.match(script, /"siteUrl":"https:\/\/scp-wiki\.wikidot\.com"/u)
  assert.deepEqual(headShape(frameWindow).slice(1), [
    ["LINK", "1", "https://scp-wiki.wjfiles.localhost/local--code/theme:basalt/1"],
    ["STYLE", "1", ".panel{}"]
  ])
})

const cromPage = {
  translations: [
    { url: "http://scp-wiki-cn.wikidot.com/1231-warning" },
    { url: "https://fondationscp.wikidot.com/1231-warning" },
    { url: "https://scp-jp.wikidot.com/1231-warning" },
    { url: "https://scpko.wikidot.com/1231-warning" },
    { url: "https://scpfoundation.net/1231-warning" },
    { url: "https://scp-vn.wikidot.com/1231-warning" }
  ],
  translationOf: null
}

test("builds SCP interwiki language links from Crom translations", () => {
  assert.deepEqual(
    extractWikidotInterwikiLinks({
      community: "scp",
      lang: "en",
      sourcePath: "1231-warning",
      page: cromPage
    }).map((link) => link.label),
    ["中文", "Français", "日本語", "한국어", "Русский", "Tiếng Việt"]
  )
})

test("renders Wikidot-compatible interwiki visible text for translated SCP pages", () => {
  const html = buildWikidotInterwikiFrameHtml({
    community: "scp",
    lang: "en",
    pagename: "1231-warning",
    page: cromPage
  })

  assert.match(html, /In other languages/)
  assert.doesNotMatch(html, /IN OTHER LANGUAGES/)
  assert.match(html, /中文<\/a><\/div> <div class="menu-item" name="fr"/)
  assert.match(html, /中文/)
  assert.match(html, /Français/)
  assert.match(html, /日本語/)
  assert.match(html, /한국어/)
  assert.match(html, /Русский/)
  assert.match(html, /Tiếng Việt/)
  assert.doesNotMatch(html, /English/)
})

test("localizes Wikidot local file and code theme URLs to the local file host", () => {
  assert.equal(
    localizeWikidotThemeUrl(
      "https://scp-wiki.wdfiles.com/local--code/theme%3Abasalt/1",
      "https://scp-wiki.wikijump.localhost"
    ),
    "https://scp-wiki.wjfiles.localhost/local--code/theme%3Abasalt/1"
  )
  assert.equal(
    localizeWikidotThemeUrl(
      "https://scp-wiki.wdfiles.com/local--code/theme:basalt/1",
      "https://scp-wiki.wikijump.localhost"
    ),
    "https://scp-wiki.wjfiles.localhost/local--code/theme:basalt/1"
  )
  assert.equal(
    localizeWikidotThemeUrl(
      "https://scp-wiki.wdfiles.com/local--code/theme:basalt/1",
      "https://scp-wiki.wikijump.localhost:18443"
    ),
    "https://scp-wiki.wjfiles.localhost:18443/local--code/theme:basalt/1"
  )
  assert.equal(
    localizeWikidotThemeUrl(
      "https://scp-wiki.wdfiles.com/local--code/theme:basalt/1",
      "https://scp-wiki.wikijump.dev.localhost:18443"
    ),
    "https://scp-wiki.wjfiles.dev.localhost:18443/local--code/theme:basalt/1"
  )
  assert.equal(
    localizeWikidotThemeUrl(
      "https://cdn.scpwiki.com/theme/en/basalt/normalize-min.css",
      "https://scp-wiki.wikijump.localhost"
    ),
    "https://cdn.scpwiki.com/theme/en/basalt/normalize-min.css"
  )
})

test("holds the side block until pulled themes load, then releases it once", () => {
  const frameWindow = fakeFrameWindow({
    siblings: [styleFrame("?priority=2&theme=https://cdn.scpwiki.com/theme.css")]
  })
  const events: string[] = []
  frameWindow.dispatchEvent = (event: { type: string }) => events.push(event.type)
  frameWindow.Event = function Event(this: { type: string }, type: string) {
    this.type = type
  }
  frameWindow.document.head.children[0].sheet = {}
  install(frameWindow)
  frameWindow.dispatch("DOMContentLoaded")

  const pending = frameWindow.document.head.children.find(
    (element) => element.dataset.wikijumpThemePending
  )!
  const theme = frameWindow.document.head.children.find(
    (element) =>
      element.tagName === "LINK" &&
      element.getAttribute("href") === "https://cdn.scpwiki.com/theme.css"
  )!
  assert.equal(pending.textContent, ".side-block{display:none}")
  assert.deepEqual(events, [])

  theme.fire("load")

  assert.equal(pending.textContent, "")
  assert.deepEqual(events, ["wikijump-themes-settled"])
})

test("releases the side block at once when no theme was pulled", () => {
  const frameWindow = fakeFrameWindow({
    siblings: [styleFrame("?priority=2&css=.late{}")]
  })
  const events: string[] = []
  frameWindow.dispatchEvent = (event: { type: string }) => events.push(event.type)
  frameWindow.Event = function Event(this: { type: string }, type: string) {
    this.type = type
  }
  frameWindow.document.head.children[0].sheet = {}
  install(frameWindow)
  frameWindow.dispatch("DOMContentLoaded")

  const pending = frameWindow.document.head.children.find(
    (element) => element.dataset.wikijumpThemePending
  )!
  assert.equal(pending.textContent, "")
  assert.deepEqual(events, ["wikijump-themes-settled"])
})

test("releases a stalled theme after a timeout instead of hiding the frame forever", () => {
  const frameWindow = fakeFrameWindow({
    siblings: [styleFrame("?priority=3&theme=https://cdn.scpwiki.com/stalled.css")]
  })
  const timers: (() => void)[] = []
  frameWindow.setTimeout = (callback: () => void) => timers.push(callback)
  frameWindow.dispatchEvent = () => {}
  frameWindow.Event = function Event(this: { type: string }, type: string) {
    this.type = type
  }
  frameWindow.document.head.children[0].sheet = {}
  install(frameWindow)
  frameWindow.dispatch("DOMContentLoaded")

  const pending = frameWindow.document.head.children.find(
    (element) => element.dataset.wikijumpThemePending
  )!
  assert.equal(pending.textContent, ".side-block{display:none}")
  assert.equal(timers.length, 1)

  timers[0]()

  assert.equal(pending.textContent, "")
})
