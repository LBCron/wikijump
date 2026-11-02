import assert from "node:assert/strict"
import test from "node:test"

import { resolvePageRedirect } from "../src/lib/server/page-redirect.ts"

test("Wikidot module redirects preserve relative query and fragment", () => {
  assert.deepEqual(
    resolvePageRedirect(
      {
        redirect_page: "/target?view=full#history",
        redirect_kind: "wikidot_module"
      },
      "source",
      undefined,
      "https://example.test/source"
    ),
    { status: 301, location: "/target?view=full#history" }
  )
})

test("Wikidot module redirects preserve evidenced absolute HTTP locations", () => {
  assert.deepEqual(
    resolvePageRedirect(
      {
        redirect_page: "http://www.scp-wiki.net/SCP-4000?view=1#part",
        redirect_kind: "wikidot_module"
      },
      "source",
      undefined,
      "https://scp-wiki.wikidot.com/source"
    ),
    {
      status: 301,
      location: "http://www.scp-wiki.net/SCP-4000?view=1#part"
    }
  )
})

test("Wikidot module redirects map route suffixes only below trailing-slash destinations", () => {
  for (const [location, extra, expected] of [
    ["/base/", "mapped-path/file1.html", "/base/mapped-path/file1.html"],
    [
      "http://www.example.com/base/",
      "mapped-path/file1.html",
      "http://www.example.com/base/mapped-path/file1.html"
    ],
    [
      "https://www.example.com/base/",
      "mapped-path",
      "https://www.example.com/base/mapped-path"
    ],
    ["/base", "mapped-path/file1.html", "/base"],
    ["/base/", undefined, "/base/"]
  ] as const) {
    assert.deepEqual(
      resolvePageRedirect(
        { redirect_page: location, redirect_kind: "wikidot_module" },
        "redir",
        extra,
        `https://example.test/redir${extra ? `/${extra}` : ""}`
      ),
      { status: 301, location: expected },
      `${location} + ${extra ?? "<root>"}`
    )
  }
})

test("GET and HEAD receive the same 301 and Location contract", () => {
  for (const method of ["GET", "HEAD"]) {
    const request = new Request("https://example.test/source", { method })
    assert.deepEqual(
      resolvePageRedirect(
        { redirect_page: "/target", redirect_kind: "wikidot_module" },
        "source",
        undefined,
        request.url
      ),
      { status: 301, location: "/target" },
      method
    )
  }
})

test("self redirects fail closed even when a fragment is present", () => {
  for (const location of [
    "/source",
    "/source#again",
    "/%73ource",
    "https://example.test/source",
    "https://example.test/source#again",
    "http://example.test/source",
    "https://example.test:8443/source"
  ]) {
    assert.equal(
      resolvePageRedirect(
        { redirect_page: location, redirect_kind: "wikidot_module" },
        "source",
        undefined,
        "https://example.test/source"
      ),
      null,
      location
    )
  }
})

test("unsupported runtime redirect locations fail closed", () => {
  // eslint-disable-next-line no-script-url -- this negative fixture must exercise script URL rejection
  for (const location of ["target", "//evil.test/path", "javascript:alert(1)"]) {
    assert.equal(
      resolvePageRedirect(
        { redirect_page: location, redirect_kind: "wikidot_module" },
        "source",
        undefined,
        "https://example.test/source"
      ),
      null,
      location
    )
  }
})

test("canonical slug redirects use a 301 and retain route options and query", () => {
  assert.deepEqual(
    resolvePageRedirect(
      { redirect_page: "normalized", redirect_kind: null },
      "source",
      "history",
      "https://example.test/source/history?view=history"
    ),
    { status: 301, location: "/normalized/history?view=history" }
  )
})

test("random helper redirects use a 302 to the selected slug and keep the query", () => {
  assert.deepEqual(
    resolvePageRedirect(
      { redirect_page: "scp-4890", redirect_kind: "random_helper" },
      "random:random-scp",
      undefined,
      "https://scp-wiki.wikijump.localhost/random:random-scp?utm_source=nav"
    ),
    { status: 302, location: "/scp-4890?utm_source=nav" }
  )
})

test("random helper redirects drop the helper suffix and allow category slugs", () => {
  assert.deepEqual(
    resolvePageRedirect(
      { redirect_page: "component:image-block", redirect_kind: "random_helper" },
      "random:random-page",
      "history",
      "https://scp-wiki.wikijump.localhost/random:random-page/history"
    ),
    { status: 302, location: "/component:image-block" }
  )
})

test("random helper redirects never bounce back to the helper itself", () => {
  assert.equal(
    resolvePageRedirect(
      { redirect_page: "random:random-page", redirect_kind: "random_helper" },
      "random:random-page",
      undefined,
      "https://scp-wiki.wikijump.localhost/random:random-page"
    ),
    null
  )
})

test("random helper redirects fail closed on non-slug locations", () => {
  for (const location of [
    "",
    "scp 4890",
    "/scp-4890",
    "scp-4890?view=1",
    "scp-4890#part",
    "https://example.test/scp-4890",
    "//example.test/scp-4890",
    "back\\slash"
  ]) {
    assert.equal(
      resolvePageRedirect(
        { redirect_page: location, redirect_kind: "random_helper" },
        "random:random-page",
        undefined,
        "https://scp-wiki.wikijump.localhost/random:random-page"
      ),
      null,
      location
    )
  }
})

test("verified Wikidot URL spelling aliases redirect to canonical pages with HTTP 301", () => {
  for (const source of ["scp---9506", "scp-9506_", "scp%209506", "scp-9506%09"]) {
    assert.deepEqual(
      resolvePageRedirect(
        { redirect_page: "scp-9506", redirect_kind: null },
        source,
        "history",
        `https://scp-wiki.wikijump.localhost/${source}/history?view=history`
      ),
      { status: 301, location: "/scp-9506/history?view=history" },
      source
    )
  }
})
