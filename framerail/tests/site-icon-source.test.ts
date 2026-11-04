import assert from "node:assert/strict"
import test from "node:test"

import {
  siteIconRedirectLocation,
  siteOwnedLocalFilePath
} from "../src/lib/site-icon-source.ts"

const importedSite = { slug: "scp-wiki", from_wikidot: true }
const localSite = { slug: "local-wiki", from_wikidot: false }

test("imported site icons redirect only to site-owned Wikidot resources", () => {
  assert.equal(
    siteIconRedirectLocation(
      importedSite,
      "https://scp-wiki.wikidot.com/local--favicon/favicon.gif",
      "favicon"
    ),
    "https://scp-wiki.wikidot.com/local--favicon/favicon.gif"
  )
  assert.equal(
    siteIconRedirectLocation(
      importedSite,
      "https://scp-wiki.wikidot.com/local--iosicon/iosicon.png",
      "ios"
    ),
    "https://scp-wiki.wikidot.com/local--iosicon/iosicon.png"
  )
  assert.equal(
    siteIconRedirectLocation(
      importedSite,
      "https://scp-wiki.wikidot.com/local--wp8icon/wp8icon.png",
      "windows"
    ),
    "https://scp-wiki.wikidot.com/local--wp8icon/wp8icon.png"
  )
  assert.equal(
    siteIconRedirectLocation(
      importedSite,
      "https://scp-wiki.wdfiles.com/local--files/site/favicon.gif",
      "favicon"
    ),
    "https://scp-wiki.wdfiles.com/local--files/site/favicon.gif"
  )

  for (const source of [
    "https://evil.example/favicon.png",
    "http://scp-wiki.wikidot.com/local--favicon/favicon.gif",
    "https://user@scp-wiki.wikidot.com/local--favicon/favicon.gif",
    "https://scp-wiki.wikidot.com/account/settings",
    "https://scp-wiki.wikidot.com/local--iosicon/iosicon.png",
    "https://scp-wiki.wikidot.com/local--favicon/favicon.gif?next=evil",
    "https://scp-wiki.wdfiles.com/not-local-files/favicon.png",
    "//evil.example/favicon.png",
    "/local--files/",
    "/local--files/../admin",
    "/local--files/%2e%2e/admin",
    "/local--files/site/../../admin",
    ["java", "script:alert(1)"].join(""),
    "data:image/png;base64,AAAA",
    "https://scp-wiki.wikidot.com/local--favicon/favicon.gif%0d%0aLocation:evil"
  ]) {
    assert.equal(siteIconRedirectLocation(importedSite, source, "favicon"), null, source)
  }

  assert.equal(
    siteIconRedirectLocation(
      importedSite,
      "https://scp-wiki.wikidot.com/local--favicon/favicon.gif",
      "ios"
    ),
    null
  )
  assert.equal(
    siteIconRedirectLocation(
      importedSite,
      "https://scp-wiki.wikidot.com/local--favicon/favicon.gif",
      "windows"
    ),
    null
  )
  assert.equal(
    siteIconRedirectLocation(
      importedSite,
      "https://scp-wiki.wikidot.com/local--wp8icon/wp8icon.png",
      "favicon"
    ),
    null,
    "a Windows tile route is not a favicon source"
  )
  assert.equal(
    siteIconRedirectLocation(
      importedSite,
      "https://scp-wiki.wikidot.com/local--wp8icon/wp8icon.png",
      "ios"
    ),
    null
  )
})

test("local site icons redirect only to same-origin file routes", () => {
  assert.equal(
    siteIconRedirectLocation(localSite, "/local--files/site/favicon.png", "favicon"),
    "/local--files/site/favicon.png"
  )

  for (const source of [
    "https://local-wiki.wikidot.com/local--favicon/favicon.gif",
    "/local--favicon/favicon.gif",
    "//evil.example/favicon.png",
    "/local--files/site/favicon.png?next=evil",
    "/local--files/site\\favicon.png",
    "/local--files/site/favicon.png\r\nLocation: https://evil.example"
  ]) {
    assert.equal(siteIconRedirectLocation(localSite, source, "favicon"), null, source)
  }
})

test("site-owned WDFiles attachments resolve to the local files path", () => {
  assert.equal(
    siteOwnedLocalFilePath(
      importedSite,
      "https://scp-wiki.wdfiles.com/local--files/site/favicon.gif"
    ),
    "/local--files/site/favicon.gif"
  )
  assert.equal(
    siteOwnedLocalFilePath(
      importedSite,
      "https://scp-wiki.wdfiles.com/local--files/site/iosicon.png"
    ),
    "/local--files/site/iosicon.png"
  )

  for (const source of [
    null,
    "",
    "https://scp-wiki.wdfiles.com/local--files/site/favicon.gif?next=evil",
    "https://scp-wiki.wdfiles.com/local--files/site/favicon.gif#frag",
    "http://scp-wiki.wdfiles.com/local--files/site/favicon.gif",
    "https://user@scp-wiki.wdfiles.com/local--files/site/favicon.gif",
    "https://scp-wiki.wdfiles.com/not-local-files/favicon.png",
    "https://scp-wiki.wdfiles.com/local--files/",
    "https://other-site.wdfiles.com/local--files/site/favicon.gif",
    "https://www.wdfiles.com/local--files/site/favicon.gif",
    "https://scp-wiki.wikidot.com/local--iosicon/iosicon.png",
    "https://scp-wiki.wikidot.com/local--files/site/favicon.gif",
    "/local--files/site/favicon.gif",
    "//scp-wiki.wdfiles.com/local--files/site/favicon.gif",
    "https://scp-wiki.wdfiles.com/local--files/site/favicon.png\r\nLocation: https://evil.example"
  ]) {
    assert.equal(siteOwnedLocalFilePath(importedSite, source), null, String(source))
  }

  assert.equal(
    siteOwnedLocalFilePath(
      localSite,
      "https://local-wiki.wdfiles.com/local--files/site/favicon.gif"
    ),
    null,
    "local sites keep the same-origin rule only"
  )
})
