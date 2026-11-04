import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  customThemeHeadHtml,
  extractCssAssetUrls,
  localizeSiteFileUrl,
  localizeSiteFileUrlsInCss,
  parseSiteFileReference,
  resolveExternalThemeHref,
  siteFilePresenceKey
} from "../src/lib/site-settings.ts"

const SITE = { slug: "scp-wiki", from_wikidot: true }
const FILES = "scp-wiki.wjfiles.localhost"

const PRESENT = () => true
const ABSENT = () => false

const presenceOf = (...keys) => {
  const present = new Set(keys)
  return (page, name) => present.has(siteFilePresenceKey(page, name))
}

describe("theme local file URL rewriting", () => {
  it("rewrites same-site wdfiles attachments with a positive presence answer", () => {
    assert.equal(
      localizeSiteFileUrl(
        "https://scp-wiki.wdfiles.com/local--files/docs/font-bauhaus.css",
        SITE,
        FILES,
        PRESENT
      ),
      "https://scp-wiki.wjfiles.localhost/local--files/docs/font-bauhaus.css"
    )
    assert.equal(
      localizeSiteFileUrl(
        "http://scp-wiki.wdfiles.com/local--files/a/b.png",
        SITE,
        FILES,
        PRESENT
      ),
      "https://scp-wiki.wjfiles.localhost/local--files/a/b.png"
    )
    assert.equal(
      localizeSiteFileUrl(
        "//scp-wiki.wdfiles.com/local--files/a/b.css",
        SITE,
        FILES,
        PRESENT
      ),
      "https://scp-wiki.wjfiles.localhost/local--files/a/b.css"
    )
    assert.equal(
      localizeSiteFileUrl(
        "//scp-wiki.wdfiles.com/local--files/a.css",
        SITE,
        FILES,
        PRESENT
      ),
      null
    )
  })

  it("preserves query, fragment, and encoding through the rewrite", () => {
    assert.equal(
      localizeSiteFileUrl(
        "https://SCP-WIKI.wdfiles.com/local--files/a%20b/c.css?download=true#full",
        SITE,
        FILES,
        PRESENT
      ),
      "https://scp-wiki.wjfiles.localhost/local--files/a%20b/c.css?download=true#full"
    )
  })

  it("keeps everything without same-site evidence literal", () => {
    const literal = [
      "https://cdn.scpwiki.com/foo/bar.css",
      "https://nu-scptheme.github.io/main.css",
      "https://www.wikidot.com/local--files/x/y.css",
      "https://www.wdfiles.com/local--files/x/y.css",
      "https://scp-wiki.wdfiles.com/local--code/theme/1",
      "https://scp-wiki.wdfiles.com/local--files/",
      "https://scp-jp.wdfiles.com/local--files/x/y.css",
      "https://other.wdfiles.com.evil.example.com/local--files/x.css",
      "https://user@scp-wiki.wdfiles.com/local--files/x.css",
      "https://scp-wiki.wdfiles.com:8443/local--files/x.css",
      "https://scp-wiki.wdfiles.com/not-files/x.css",
      "/local--files/relative.css",
      "data:text/css,body{}",
      "",
      null,
      undefined,
      42
    ]
    for (const url of literal) {
      assert.equal(localizeSiteFileUrl(url, SITE, FILES, PRESENT), null, String(url))
    }
    assert.equal(
      localizeSiteFileUrl(
        "https://scp-wiki.wdfiles.com/local--files/x.css",
        { slug: "scp-wiki", from_wikidot: false },
        FILES,
        PRESENT
      ),
      null
    )
    assert.equal(
      localizeSiteFileUrl(
        "https://scp-wiki.wdfiles.com/local--files/x.css",
        null,
        FILES,
        PRESENT
      ),
      null
    )
    assert.equal(
      localizeSiteFileUrl(
        "https://scp-wiki.wdfiles.com/local--files/x.css",
        SITE,
        "https://evil.example.com",
        PRESENT
      ),
      null
    )
    assert.equal(
      localizeSiteFileUrl(
        "https://scp-wiki.wdfiles.com/local--files/x.css",
        SITE,
        "",
        PRESENT
      ),
      null
    )
  })

  it("fails closed without a positive presence answer", () => {
    const url = "https://scp-wiki.wdfiles.com/local--files/docs/font-bauhaus.css"
    assert.equal(localizeSiteFileUrl(url, SITE, FILES, ABSENT), null)
    assert.equal(localizeSiteFileUrl(url, SITE, FILES), null)
    assert.equal(localizeSiteFileUrl(url, SITE, FILES, null), null)
    assert.equal(
      localizeSiteFileUrl(url, SITE, FILES, () => undefined),
      null
    )
    assert.equal(
      localizeSiteFileUrl(url, SITE, FILES, () => {
        throw new Error("lookup failed")
      }),
      null
    )
    assert.equal(localizeSiteFileUrl(url, SITE, FILES, "yes"), null)
  })

  it("splits exactly one page file per reference", () => {
    assert.deepEqual(
      parseSiteFileReference(
        "https://scp-wiki.wdfiles.com/local--files/component:theme/font-bauhaus.css",
        SITE
      ),
      {
        page: "component:theme",
        name: "font-bauhaus.css",
        rest: "/local--files/component:theme/font-bauhaus.css"
      }
    )
    assert.deepEqual(
      parseSiteFileReference(
        "https://scp-wiki.wdfiles.com/local--files/i/d.png?download=true#full",
        SITE
      ),
      {
        page: "i",
        name: "d.png",
        rest: "/local--files/i/d.png?download=true#full"
      }
    )
    for (const url of [
      "https://scp-wiki.wdfiles.com/local--files/onlypage",
      "https://scp-wiki.wdfiles.com/local--files/a/b/c.css",
      "https://scp-wiki.wdfiles.com/local--files/",
      "https://scp-jp.wdfiles.com/local--files/x/y.css",
      "https://www.wdfiles.com/local--files/x/y.css",
      "https://scp-wiki.wdfiles.com/local--code/theme/1",
      "/local--files/a/b.css",
      null,
      42
    ]) {
      assert.equal(parseSiteFileReference(url, SITE), null, String(url))
    }
  })

  it("collects distinct asset URLs from custom CSS", () => {
    assert.deepEqual(
      extractCssAssetUrls(
        [
          '@import url("https://scp-wiki.wdfiles.com/local--files/t/a.css");',
          "@import 'https://scp-wiki.wdfiles.com/local--files/t/a.css';",
          ".x{background:url(https://scp-wiki.wdfiles.com/local--files/i/d.png)}",
          ".y{background:url(data:image/png;base64,AAA)}"
        ].join("\n")
      ),
      [
        "https://scp-wiki.wdfiles.com/local--files/t/a.css",
        "https://scp-wiki.wdfiles.com/local--files/i/d.png",
        "data:image/png;base64,AAA"
      ]
    )
    assert.deepEqual(extractCssAssetUrls(null), [])
    assert.deepEqual(extractCssAssetUrls(42), [])
  })

  it("keys presence by page and name", () => {
    assert.equal(
      siteFilePresenceKey("component:theme", "font-bauhaus.css"),
      "component:theme\0font-bauhaus.css"
    )
    assert.equal(siteFilePresenceKey("", "a.css"), null)
    assert.equal(siteFilePresenceKey("a", ""), null)
    assert.equal(siteFilePresenceKey(null, "a.css"), null)
  })

  it("rewrites only present urls inside stored custom css", () => {
    const css = [
      '@import url("https://scp-wiki.wdfiles.com/local--files/t/a.css");',
      "@import 'https://scp-jp.wdfiles.com/local--files/t/b.css';",
      '@import "https://scp-wiki.wdfiles.com/local--files/t/c.css";',
      ".x{background:url(https://scp-wiki.wdfiles.com/local--files/i/d.png?download=true#full)}",
      ".y{background:url(https://cdn.scpwiki.com/e/f.png)}",
      ".z{background:url(data:image/png;base64,AAA)}"
    ].join("\n")
    assert.equal(
      localizeSiteFileUrlsInCss(css, SITE, FILES, PRESENT),
      [
        '@import url("https://scp-wiki.wjfiles.localhost/local--files/t/a.css");',
        "@import 'https://scp-jp.wdfiles.com/local--files/t/b.css';",
        '@import "https://scp-wiki.wjfiles.localhost/local--files/t/c.css";',
        ".x{background:url(https://scp-wiki.wjfiles.localhost/local--files/i/d.png?download=true#full)}",
        ".y{background:url(https://cdn.scpwiki.com/e/f.png)}",
        ".z{background:url(data:image/png;base64,AAA)}"
      ].join("\n")
    )
  })

  it("keeps stored custom css byte-identical for absent files", () => {
    const css = [
      '@import url("https://scp-wiki.wdfiles.com/local--files/t/a.css");',
      ".x{background:url(https://scp-wiki.wdfiles.com/local--files/i/d.png)}"
    ].join("\n")
    assert.equal(localizeSiteFileUrlsInCss(css, SITE, FILES, ABSENT), css)
    assert.equal(localizeSiteFileUrlsInCss(css, SITE, FILES), css)
  })

  it("rewrites only present urls inside stored custom css with a set-backed check", () => {
    const css = [
      '@import url("https://scp-wiki.wdfiles.com/local--files/t/a.css");',
      ".x{background:url(https://scp-wiki.wdfiles.com/local--files/i/d.png)}"
    ].join("\n")
    const isLocalFile = presenceOf(siteFilePresenceKey("t", "a.css"))
    assert.equal(
      localizeSiteFileUrlsInCss(css, SITE, FILES, isLocalFile),
      [
        '@import url("https://scp-wiki.wjfiles.localhost/local--files/t/a.css");',
        ".x{background:url(https://scp-wiki.wdfiles.com/local--files/i/d.png)}"
      ].join("\n")
    )
  })

  it("keeps custom css byte-identical without site evidence", () => {
    const css = '@import url("https://scp-wiki.wdfiles.com/local--files/t/a.css");'
    assert.equal(localizeSiteFileUrlsInCss(css, null, FILES, PRESENT), css)
    assert.equal(localizeSiteFileUrlsInCss(css, SITE, null, PRESENT), css)
  })

  it("resolves external theme hrefs with the same evidence rule", () => {
    assert.equal(
      resolveExternalThemeHref(
        {
          type: "external",
          url: "https://scp-wiki.wdfiles.com/local--files/component:theme/font-bauhaus.css"
        },
        SITE,
        FILES,
        PRESENT
      ),
      "https://scp-wiki.wjfiles.localhost/local--files/component:theme/font-bauhaus.css"
    )
    assert.equal(
      resolveExternalThemeHref(
        {
          type: "external",
          url: "https://scp-wiki.wdfiles.com/local--files/component:theme/font-bauhaus.css"
        },
        SITE,
        FILES,
        ABSENT
      ),
      "https://scp-wiki.wdfiles.com/local--files/component:theme/font-bauhaus.css"
    )
    assert.equal(
      resolveExternalThemeHref(
        { type: "external", url: "https://nu-scptheme.github.io/main.css" },
        SITE,
        FILES,
        PRESENT
      ),
      "https://nu-scptheme.github.io/main.css"
    )
    assert.equal(
      resolveExternalThemeHref({ type: "built_in", id: 1 }, SITE, FILES, PRESENT),
      null
    )
    assert.equal(
      resolveExternalThemeHref({ type: "custom", css: "x{}" }, SITE, FILES, PRESENT),
      null
    )
  })

  it("emits rewritten custom css in the head helper only with evidence", () => {
    const theme = {
      type: "custom",
      css: '.x{background:url("https://scp-wiki.wdfiles.com/local--files/i/a.png")}'
    }
    assert.equal(
      customThemeHeadHtml(theme, SITE, FILES, PRESENT),
      '<style data-wikidot-site-theme>.x{background:url("https://scp-wiki.wjfiles.localhost/local--files/i/a.png")}</style>'
    )
    assert.equal(
      customThemeHeadHtml(theme, SITE, FILES, ABSENT),
      '<style data-wikidot-site-theme>.x{background:url("https://scp-wiki.wdfiles.com/local--files/i/a.png")}</style>'
    )
    assert.equal(
      customThemeHeadHtml(theme),
      '<style data-wikidot-site-theme>.x{background:url("https://scp-wiki.wdfiles.com/local--files/i/a.png")}</style>'
    )
    assert.equal(
      customThemeHeadHtml({ type: "built_in", id: 1 }, SITE, FILES, PRESENT),
      ""
    )
  })
})
