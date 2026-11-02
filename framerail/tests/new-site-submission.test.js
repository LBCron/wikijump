import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import {
  NEW_SITE_DEFAULT_PRIVACY,
  NEW_SITE_DEFAULT_TEMPLATE,
  NEW_SITE_PAGE_SLUG,
  NEW_SITE_PLATFORM_SLUG,
  newSiteRedirectTarget,
  parseNewSiteSubmission
} from "../src/lib/server/load/page/page-newsite-validation.js"

const validFields = () => ({
  name: "My Wiki",
  subtitle: "A test wiki",
  unixname: "my-wiki",
  language: "en",
  template: "default",
  privacy: "open",
  tos: "1"
})

test("a valid default submission maps to the site-create dimensions", () => {
  assert.deepEqual(parseNewSiteSubmission(validFields()), {
    slug: "my-wiki",
    name: "My Wiki",
    tagline: "A test wiki",
    locale: "en"
  })
})

test("ToS acceptance is required and cannot be smuggled in other fields", () => {
  for (const fields of [
    { ...validFields(), tos: undefined },
    { ...validFields(), tos: "" },
    { ...validFields(), tos: "0" },
    { ...validFields(), tos: undefined, template: "default tos" }
  ]) {
    assert.throws(() => parseNewSiteSubmission(fields), /Terms of Service/u)
  }
})

test("missing title or web address is rejected before any service call", () => {
  assert.throws(() => parseNewSiteSubmission({ ...validFields(), name: "  " }), /Title/u)
  assert.throws(
    () => parseNewSiteSubmission({ ...validFields(), unixname: "" }),
    /Web address/u
  )
})

test("non-default template or access policy is rejected fail-closed", () => {
  assert.throws(
    () => parseNewSiteSubmission({ ...validFields(), template: "blog" }),
    /template/u
  )
  assert.throws(
    () => parseNewSiteSubmission({ ...validFields(), privacy: "private" }),
    /access/u
  )
})

test("client-supplied actor identity never crosses the boundary", () => {
  const parsed = parseNewSiteSubmission({
    ...validFields(),
    user_id: 1,
    owner_id: 1,
    master_admin_user_id: 1,
    is_admin: "true"
  })
  assert.deepEqual(Object.keys(parsed).sort(), ["locale", "name", "slug", "tagline"])
})

test("the special-page contract constants match the www runtime", () => {
  assert.equal(NEW_SITE_PLATFORM_SLUG, "www")
  assert.equal(NEW_SITE_PAGE_SLUG, "new-site")
  assert.equal(NEW_SITE_DEFAULT_TEMPLATE, "default")
  assert.equal(NEW_SITE_DEFAULT_PRIVACY, "open")
})

test("pageActions exposes newSite for the compat form post", async () => {
  const source = await readFile(
    new URL("../src/lib/server/load/page/page-actions.ts", import.meta.url),
    "utf8"
  )
  assert.match(source, /newSite:\s*\S+/u, "newSite action registered")
})

test("the newSite action is session-gated and special-page scoped", async () => {
  const source = await readFile(
    new URL("../src/lib/server/load/page/page-newsite-actions.ts", import.meta.url),
    "utf8"
  )
  assert.match(source, /session:\s*"required"/u, "anonymous denied pre-mutation")
  assert.ok(
    source.includes("NEW_SITE_PLATFORM_SLUG") && source.includes("NEW_SITE_PAGE_SLUG"),
    "guarded to the www/new-site special page, not every wiki page"
  )
  assert.match(source, /formData\(\)/u, "reads the urlencoded compat form")
})

test("a created site redirects to its canonical origin", async () => {
  const source = await readFile(
    new URL("../src/lib/server/load/page/page-newsite-actions.ts", import.meta.url),
    "utf8"
  )
  assert.match(
    source,
    /throw redirect\(303, target\)/u,
    "success navigates with POST redirect semantics"
  )
  assert.match(
    source,
    /newSiteRedirectTarget\(await siteOrigin\(/u,
    "landing target comes from the canonical domain source"
  )
  assert.match(
    source,
    /catch \{\s*return result\s*\}/u,
    "origin failure falls back to the success payload, not a broken create"
  )
})

test("origin resolution reuses the sitemap domain source", async () => {
  const source = await readFile(
    new URL("../src/lib/server/deepwell/site.ts", import.meta.url),
    "utf8"
  )
  assert.match(source, /"site_domain"/u, "no new RPC registration")
  assert.match(
    source,
    /canonicalSitemapOrigin\(authority\)/u,
    "no duplicated host-assembly rules"
  )
})

test("the success target is the canonical origin's default page", () => {
  assert.equal(
    newSiteRedirectTarget("https://my-wiki.wikijump.localhost:18443"),
    "https://my-wiki.wikijump.localhost:18443/"
  )
  assert.equal(
    newSiteRedirectTarget("https://my-wiki.wikijump.com"),
    "https://my-wiki.wikijump.com/"
  )
})

test("the success target rejects non-origin values", () => {
  for (const origin of [
    ["java", "script:alert(1)"].join(""),
    "/my-wiki",
    "my-wiki.wikijump.localhost",
    "https://my-wiki.wikijump.com/start",
    "https://my-wiki.wikijump.com?x=1",
    "",
    undefined,
    null,
    42
  ]) {
    assert.throws(
      () => newSiteRedirectTarget(origin),
      /new address is invalid/u,
      `rejected: ${JSON.stringify(origin)}`
    )
  }
})

test("the site adapter reuses site_create and adds no actor fields", async () => {
  const source = await readFile(
    new URL("../src/lib/server/deepwell/site.ts", import.meta.url),
    "utf8"
  )
  assert.match(source, /"site_create"/u, "no new RPC registration")
  const params = /client\.request\(\s*"site_create",\s*\{([^}]*)\}/u.exec(source)
  assert.ok(params, "site_create request payload found")
  assert.doesNotMatch(params[1], /user_id|owner|privilege|admin/u)
})
