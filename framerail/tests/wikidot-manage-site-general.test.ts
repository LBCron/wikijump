import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import { renderWikidotManageSiteGeneral } from "../src/lib/server/wikidot-manage-site-general.ts"

const capturedSite = {
  slug: "sandbox-for-codex",
  name: "Sandbox For Codex",
  tagline: "",
  locale: "en",
  description: "",
  default_page: "home:home",
  welcome_page: "system:welcome"
}

test("ManageSiteGeneral renders the exact captured administrator read model", () => {
  const body = renderWikidotManageSiteGeneral(capturedSite)

  assert.equal(
    createHash("sha256").update(body).digest("hex"),
    "53905a4fc7463390da1e8adc74cc3f70b550db2617cd5cce1b9033a49eafc74e"
  )
  assert.match(body, /<form id="sm-general-form" class="form-horizontal">/u)
  assert.match(body, /<div class="btn btn-primary" id="sm-general-save">/u)
  assert.doesNotMatch(body, /<script|<button|<form[^>]+(?:action|method)=/iu)
})

test("ManageSiteGeneral escapes every site-owned value", () => {
  const body = renderWikidotManageSiteGeneral({
    slug: 'bad"><script>alert(1)</script>',
    name: 'name"><img src=x>',
    tagline: 'tag<&"',
    locale: 'en"><script>',
    description: "description</textarea><script>",
    default_page: 'start"><script>',
    welcome_page: 'welcome"><script>'
  })

  assert.doesNotMatch(body, /<script>|<img src=x>/iu)
  assert.match(body, /value="bad&quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/u)
  assert.match(body, /value="name&quot;&gt;&lt;img src=x&gt;"/u)
  assert.match(body, /value="tag&lt;&amp;&quot;"/u)
  assert.match(body, /description&lt;\/textarea&gt;&lt;script&gt;/u)
  assert.match(body, /value="start&quot;&gt;&lt;script&gt;"/u)
  assert.match(body, /value="welcome&quot;&gt;&lt;script&gt;"/u)
})
