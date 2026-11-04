import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { handleAjaxModuleConnectorRequest } from "../src/lib/server/ajax-module-connector.ts"
import {
  renderWikidotListDrafts,
  renderWikidotSiteTools,
  renderWikidotWantedPages
} from "../src/lib/server/wikidot-site-tools.ts"
import { requestWikidotSiteToolsModule } from "../src/lib/wikidot/wikidot-site-tools.ts"

/** @param {any} form */
const request = (form) =>
  new Request("http://scp-wiki.local/ajax-module-connector.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form)
  })

test("Site Tools AMC allows only the four observed read shapes", async () => {
  /** @type {any[]} */
  const received = []
  /** @type {any[]} */
  const shapes = [
    ["sitetools/SiteToolsModule", "1", {}],
    ["sitetools/WantedPagesModule", "2", {}],
    ["sitetools/OrphanedPagesModule", "3", {}],
    ["list/ListDraftsModule", "4", { location: "sitetools" }]
  ]

  for (const [moduleName, callbackIndex, parameters] of shapes) {
    const response = await handleAjaxModuleConnectorRequest(
      request({ moduleName, callbackIndex, ...parameters }),
      {
        siteId: 17,
        renderListPages: async () => assert.fail("must not render ListPages"),
        renderSiteToolsModule: async (input) => {
          received.push(input)
          return { status: "ok", body: `<div>${moduleName}</div>` }
        }
      }
    )
    const body = await response.json()
    assert.equal(body.status, "ok")
    assert.equal(body.callbackIndex, callbackIndex)
    assert.deepEqual(body.cssInclude, [])
    assert.deepEqual(body.jsInclude, [])
  }

  assert.deepEqual(received, [
    { siteId: 17, moduleName: "sitetools/SiteToolsModule", parameters: {} },
    { siteId: 17, moduleName: "sitetools/WantedPagesModule", parameters: {} },
    { siteId: 17, moduleName: "sitetools/OrphanedPagesModule", parameters: {} },
    {
      siteId: 17,
      moduleName: "list/ListDraftsModule",
      parameters: { location: "sitetools" }
    }
  ])
})

test("Site Tools AMC rejects unobserved parameters before Deepwell", async () => {
  let calls = 0
  for (const form of [
    { moduleName: "sitetools/SiteToolsModule", callbackIndex: "2" },
    { moduleName: "sitetools/WantedPagesModule" },
    { moduleName: "sitetools/SiteToolsModule", callbackIndex: "1", extra: "1" },
    { moduleName: "sitetools/WantedPagesModule", callbackIndex: "2", p: "2" },
    { moduleName: "sitetools/OrphanedPagesModule", callbackIndex: "3", module_body: "" },
    { moduleName: "list/ListDraftsModule", callbackIndex: "4" },
    {
      moduleName: "list/ListDraftsModule",
      callbackIndex: "4",
      location: "other"
    }
  ]) {
    const response = await handleAjaxModuleConnectorRequest(request(form), {
      siteId: 17,
      renderListPages: async () => assert.fail("must not render ListPages"),
      renderSiteToolsModule: async () => {
        calls += 1
        assert.fail("unsupported Site Tools shapes must fail before Deepwell")
      }
    })
    assert.equal((await response.json()).status, "not_ok")
  }
  assert.equal(calls, 0)
})

test("Site Tools browser requests preserve exact module names and callback indices", async () => {
  /** @type {any[]} */
  const calls = []
  /** @param {any} url @param {any} init */
  const fetcher = async (url, init) => {
    calls.push({ url, init, form: Object.fromEntries(new URLSearchParams(init.body)) })
    return new Response(JSON.stringify({ status: "ok", body: "<div>ok</div>" }))
  }

  await requestWikidotSiteToolsModule(fetcher, "sitetools/SiteToolsModule", 1)
  await requestWikidotSiteToolsModule(fetcher, "sitetools/WantedPagesModule", 2)
  await requestWikidotSiteToolsModule(fetcher, "sitetools/OrphanedPagesModule", 3)
  await requestWikidotSiteToolsModule(fetcher, "list/ListDraftsModule", 4)

  assert.deepEqual(
    calls.map(({ url, init, form }) => ({ url, method: init.method, form })),
    [
      {
        url: "/ajax-module-connector.php",
        method: "POST",
        form: { moduleName: "sitetools/SiteToolsModule", callbackIndex: "1" }
      },
      {
        url: "/ajax-module-connector.php",
        method: "POST",
        form: { moduleName: "sitetools/WantedPagesModule", callbackIndex: "2" }
      },
      {
        url: "/ajax-module-connector.php",
        method: "POST",
        form: { moduleName: "sitetools/OrphanedPagesModule", callbackIndex: "3" }
      },
      {
        url: "/ajax-module-connector.php",
        method: "POST",
        form: {
          moduleName: "list/ListDraftsModule",
          callbackIndex: "4",
          location: "sitetools"
        }
      }
    ]
  )
})

test("Site Tools browser request helper rejects unregistered module shapes", async () => {
  const fetcher = async () =>
    assert.fail("unsupported Site Tools shapes must fail before fetch")
  await assert.rejects(
    requestWikidotSiteToolsModule(fetcher, "sitetools/UnknownModule", 1),
    { name: "TypeError", message: "Unsupported Site Tools module request" }
  )
  await assert.rejects(
    requestWikidotSiteToolsModule(fetcher, "sitetools/SiteToolsModule", 2),
    { name: "TypeError", message: "Unsupported Site Tools module request" }
  )
})

test("Site Tools shell and wanted report preserve the observed read-only DOM", () => {
  const shell = renderWikidotSiteTools()
  assert.match(shell, /class="site-tools-box"/u)
  assert.match(shell, /class="page-options-bottom"/u)
  assert.match(shell, /class="nav nav-pills"/u)
  assert.match(shell, /id="st-wanted-pages-button"/u)
  assert.match(shell, /id="st-orphaned-pages-button"/u)
  assert.match(shell, /id="st-draft-pages-button"/u)

  const wanted = renderWikidotWantedPages(
    Array.from({ length: 51 }, (_, index) => ({
      slug: `missing-${String(index).padStart(2, "0")}`,
      sources: [{ slug: `source-${index}`, title: `Source ${index}` }]
    }))
  )
  assert.match(wanted, /class="wanted-pages-module"/u)
  assert.match(wanted, /class="form grid"/u)
  assert.equal(wanted.match(/class="pager"/gu)?.length, 2)
  assert.match(wanted, /class="newpage"/u)
  assert.doesNotMatch(wanted, /missing-50/u)
})

test("ListDrafts renders the bounded row hierarchy and escapes draft fields", () => {
  const empty = renderWikidotListDrafts()
  assert.equal(
    empty,
    `<div class="list-drafts-box">
            </div>`
  )

  const rendered = renderWikidotListDrafts([
    { slug: "run-owned:existing", title: "Existing <draft>" },
    { slug: "run-owned:absent", title: 'Absent "draft"' }
  ])
  assert.match(
    rendered,
    /<div class="list-drafts-item">\s*<p><a href="\/run-owned:existing">Existing &lt;draft&gt;<\/a><\/p>\s*<\/div>/u
  )
  assert.match(rendered, /href="\/run-owned:absent"/u)
  assert.match(rendered, /Absent &quot;draft&quot;/u)
})

test("saved Wikidot Site tools action lazily activates the compatibility pane", async () => {
  const pageSource = await readFile(
    new URL("../src/routes/[slug]/[...extra]/PageView.svelte", import.meta.url),
    "utf8"
  )
  const paneSource = await readFile(
    new URL("../src/routes/[slug]/[...extra]/PagePaneContent.svelte", import.meta.url),
    "utf8"
  )
  const siteToolsSource = await readFile(
    new URL("../src/routes/[slug]/[...extra]/SiteToolsPane.svelte", import.meta.url),
    "utf8"
  )

  assert.match(pageSource, /site-tools-button[\s\S]*PagePane\.SiteTools/u)
  assert.match(pageSource, /action-area-close[\s\S]*close/u)
  assert.match(
    paneSource,
    /PagePane\.SiteTools[\s\S]*import\("\.\/SiteToolsPane\.svelte"\)/u
  )
  assert.match(siteToolsSource, /sitetools\/SiteToolsModule[\s\S]*,\s*1/u)
  assert.match(siteToolsSource, /st-wanted-pages-button/u)
  assert.match(siteToolsSource, /st-orphaned-pages-button/u)
  assert.match(siteToolsSource, /st-draft-pages-button/u)
})
