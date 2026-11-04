import assert from "node:assert/strict"
import fs from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import vm from "node:vm"

import {
  WIKIDOT_REQUEST_INFO_MARKER,
  buildWikidotRequestInfo,
  injectWikidotRequestInfo,
  requestHostFromRequest,
  serializeWikidotRequestInfo
} from "../src/lib/server/wikidot-request-info.ts"

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const input = {
  domain: "scp-wiki.wikijump.localhost",
  site: {
    site_id: 6000006,
    slug: "scp-wiki",
    locale: "en",
    from_wikidot: true
  },
  page: {
    page_id: 3000011662,
    page_category_id: 100000053,
    slug: "scp-173"
  }
}

test("builds source-compatible Wikidot request metadata from local identities", () => {
  assert.deepEqual(buildWikidotRequestInfo(input), {
    domain: "scp-wiki.wikijump.localhost",
    siteId: 6000006,
    siteUnixName: "scp-wiki",
    categoryId: 100000053,
    requestPageName: "scp-173",
    lang: "en",
    pageUnixName: "scp-173",
    pageId: 3000011662
  })
})

test("binds a nonstandard local port into the client-visible request host", () => {
  assert.equal(
    buildWikidotRequestInfo({
      ...input,
      domain: "127.0.0.1:3405"
    }).domain,
    "127.0.0.1:3405"
  )
})

test("prefers the HTTP Host header over the adapter origin", () => {
  assert.equal(
    requestHostFromRequest(
      new Request("http://127.0.0.1:34091/scp-173", {
        headers: { host: "SCP-WIKI.WIKIDOT.COM" }
      })
    ),
    "scp-wiki.wikidot.com"
  )
  assert.equal(
    requestHostFromRequest(new Request("http://127.0.0.1:34091/scp-173")),
    "127.0.0.1:34091"
  )
})

test("serializes the exact raw statements consumed by wikidot.py", () => {
  const script = serializeWikidotRequestInfo(buildWikidotRequestInfo(input))
  assert.match(script, /^var WIKIREQUEST = \{\};/u)
  assert.match(script, /WIKIREQUEST\.info\.domain = "scp-wiki\.wikijump\.localhost";/u)
  assert.match(script, /WIKIREQUEST\.info\.siteId = 6000006;/u)
  assert.match(script, /WIKIREQUEST\.info\.siteUnixName = "scp-wiki";/u)
  assert.match(script, /WIKIREQUEST\.info\.pageId = 3000011662;/u)

  const context: {
    WIKIREQUEST?: { info: ReturnType<typeof buildWikidotRequestInfo> }
  } = {}
  vm.runInNewContext(script, context)
  assert.deepEqual({ ...context.WIKIREQUEST!.info }, buildWikidotRequestInfo(input))
})

test("escapes inline script terminators and rejects malformed identities", () => {
  const safe = buildWikidotRequestInfo({
    ...input,
    page: { ...input.page, slug: "category:</script><script>alert(1)</script>" }
  })
  const script = serializeWikidotRequestInfo(safe)
  assert.doesNotMatch(script, /<\/script/iu)
  assert.match(script, /\\u003c\/script/u)

  assert.throws(
    () => buildWikidotRequestInfo({ ...input, domain: "example.com/path" }),
    /host grammar/u
  )
  assert.throws(
    () =>
      buildWikidotRequestInfo({ ...input, site: { ...input.site, slug: "scp.wiki" } }),
    /unix-name grammar/u
  )
  assert.throws(
    () => buildWikidotRequestInfo({ ...input, page: { ...input.page, page_id: 1.5 } }),
    /safe integer/u
  )
})

test("injects one marker and leaves non-HTML chunks unchanged", () => {
  const info = buildWikidotRequestInfo(input)
  const html = `<html lang="en"><head><script data-wikidot-request-info nonce="test-csp-nonce">${WIKIDOT_REQUEST_INFO_MARKER}</script></head></html>`
  const injected = injectWikidotRequestInfo(html, info, input.site.locale)
  assert.doesNotMatch(injected, /__WIKIDOT_REQUEST_INFO__/u)
  assert.match(injected, /WIKIREQUEST\.info\.pageId/u)
  assert.match(injected, /<html lang="en">/u)
  assert.equal(injectWikidotRequestInfo("plain text", info), "plain text")
  assert.equal(
    injectWikidotRequestInfo(
      `${WIKIDOT_REQUEST_INFO_MARKER}${WIKIDOT_REQUEST_INFO_MARKER}`,
      info
    ),
    `${WIKIDOT_REQUEST_INFO_MARKER}${WIKIDOT_REQUEST_INFO_MARKER}`
  )
  const authored = `${html.slice(0, -7)}<title>${WIKIDOT_REQUEST_INFO_MARKER}</title><article>${WIKIDOT_REQUEST_INFO_MARKER}</article></html>`
  const authoredRendered = injectWikidotRequestInfo(authored, info)
  assert.equal(authoredRendered.split(WIKIDOT_REQUEST_INFO_MARKER).length - 1, 2)
  assert.match(authoredRendered, /WIKIREQUEST\.info\.pageId/u)
  assert.equal(
    injectWikidotRequestInfo(`<article>${WIKIDOT_REQUEST_INFO_MARKER}</article>`, info),
    `<article>${WIKIDOT_REQUEST_INFO_MARKER}</article>`
  )
})

test("injects the raw Wikidot site locale as the document language independently of page metadata", () => {
  const info = buildWikidotRequestInfo({
    ...input,
    site: { ...input.site, locale: "ja-corrections" }
  })
  const html = `<html lang="en"><head><script data-wikidot-request-info nonce="test-csp-nonce">${WIKIDOT_REQUEST_INFO_MARKER}</script></head></html>`

  assert.match(
    injectWikidotRequestInfo(html, info, "ja-corrections"),
    /<html lang="ja-corrections">/u
  )
  assert.match(
    injectWikidotRequestInfo(html, undefined, "ja-corrections"),
    /<html lang="ja-corrections">/u
  )
  assert.doesNotMatch(
    injectWikidotRequestInfo(html, undefined, "ja-corrections"),
    /WIKIREQUEST\.info/u
  )
})

test("Wikidot documents emit the raw locale in the legacy root and content-language metadata", () => {
  const info = buildWikidotRequestInfo({
    ...input,
    site: { ...input.site, locale: "ja-corrections" }
  })
  const html = `<html lang="en"><head><meta data-wikidot-document-language /><script data-wikidot-request-info nonce="test-csp-nonce">${WIKIDOT_REQUEST_INFO_MARKER}</script></head></html>`

  const injected = injectWikidotRequestInfo(html, info, "ja-corrections", true)

  assert.match(
    injected,
    /<html xmlns="http:\/\/www\.w3\.org\/1999\/xhtml" xml:lang="ja-corrections" lang="ja-corrections">/u
  )
  assert.equal(
    injected.match(/<meta http-equiv="content-language" content="ja-corrections"\/>/gu)
      ?.length,
    1
  )
  assert.match(injected, /WIKIREQUEST\.info\.lang = "ja-corrections";/u)

  const reinjected = injectWikidotRequestInfo(injected, info, "ja-corrections", true)
  assert.equal(reinjected.match(/<meta http-equiv="content-language"/gu)?.length, 1)
})

test("English Wikidot documents emit the complete legacy language contract", () => {
  const html =
    '<html lang="en"><head><meta data-wikidot-document-language /></head></html>'

  assert.equal(
    injectWikidotRequestInfo(html, undefined, "en", true),
    '<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en"><head><meta http-equiv="content-language" content="en"/></head></html>'
  )
})

test("Wikijump and non-article shells keep locale substitution without legacy metadata", () => {
  const html =
    '<html lang="en"><head><meta data-wikidot-document-language /></head></html>'
  const injected = injectWikidotRequestInfo(html, undefined, "ja-corrections", false)

  assert.match(injected, /<html lang="ja-corrections">/u)
  assert.doesNotMatch(injected, /\bxmlns=|\bxml:lang=|content-language/u)
  assert.doesNotMatch(injected, /data-wikidot-document-language/u)
})

test("the app template binds the compatibility script to SvelteKit's CSP nonce", async () => {
  const template = await fs.readFile(path.join(ROOT, "src/app.html"), "utf8")
  assert.match(
    template,
    /<script data-wikidot-request-info nonce="%sveltekit\.nonce%">\s*\/\*__WIKIDOT_REQUEST_INFO__\*\/\s*<\/script>/u
  )
})

test("the app template preserves Wikidot's limited-quirks document mode", async () => {
  const template = await fs.readFile(path.join(ROOT, "src/app.html"), "utf8")
  assert.match(
    template,
    /^<!DOCTYPE html PUBLIC "-\/\/W3C\/\/DTD XHTML 1\.0 Transitional\/\/EN" "http:\/\/www\.w3\.org\/TR\/xhtml1\/DTD\/xhtml1-transitional\.dtd">\n/u
  )
})

test("the app template preserves Wikidot's body shell without an extra wrapper", async () => {
  const template = await fs.readFile(path.join(ROOT, "src/app.html"), "utf8")
  assert.match(template, /<body id="html-body">\s*%sveltekit\.body%\s*<\/body>/u)
  assert.doesNotMatch(template, /<body[^>]*>\s*<div>%sveltekit\.body%<\/div>/u)
})

test("the app template has one removable document-language marker and no global legacy metadata", async () => {
  const template = await fs.readFile(path.join(ROOT, "src/app.html"), "utf8")

  assert.equal(template.match(/<meta data-wikidot-document-language \/>/gu)?.length, 1)
  assert.doesNotMatch(template, /\bxmlns=|\bxml:lang=|content-language/u)
})
