import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  WIKIDOT_SITE_LANGUAGES,
  isWikidotSiteLanguage
} from "../src/lib/admin/wikidot-site-languages.js"
import {
  googleAnalyticsQueueScript,
  googleAnalyticsHeadHtml,
  normalizeGoogleAnalyticsSettings,
  normalizeThemePreviewUrl,
  normalizeThemeSetting,
  resolveExternalThemeHref,
  resolveThemePreviewUrl
} from "../src/lib/site-settings.ts"

describe("Wikidot site settings foundation", () => {
  it("uses the captured Wiki Settings language values in source order", () => {
    assert.equal(WIKIDOT_SITE_LANGUAGES.length, 121)
    assert.deepEqual(WIKIDOT_SITE_LANGUAGES.slice(0, 4), [
      { group: "Stable", value: "en", label: "English" },
      {
        group: "Stable",
        value: "en-au-mate",
        label: "↳English Australian Mate"
      },
      {
        group: "Stable",
        value: "en-corrections",
        label: "↳English (Corrections)"
      },
      {
        group: "Stable",
        value: "en-pirate",
        label: "↳English (Pirate Speak)"
      }
    ])
    assert.deepEqual(WIKIDOT_SITE_LANGUAGES.at(-1), {
      group: "Experimental",
      value: "zy-tr",
      label: "↳Zhuyin Fuhao (Traditional)"
    })
    assert.equal(isWikidotSiteLanguage("ja-corrections"), true)
    assert.equal(isWikidotSiteLanguage("en-US"), false)
  })

  it("keeps analytics disabled by default and emits only the observed queue entries", () => {
    assert.deepEqual(normalizeGoogleAnalyticsSettings(undefined), {
      enabled: false,
      profile: null
    })
    assert.equal(
      googleAnalyticsQueueScript({ enabled: false, profile: "UA-00000000-2" }),
      ""
    )
    assert.equal(googleAnalyticsQueueScript({ enabled: true, profile: "G-ABC123" }), "")
    assert.equal(
      googleAnalyticsQueueScript({ enabled: true, profile: "UA-00000000-2" }),
      "_gaq.push(['userTracker._setAccount', 'UA-00000000-2']);\n_gaq.push(['userTracker._trackPageview']);"
    )
    assert.equal(googleAnalyticsHeadHtml(undefined), "")
    assert.equal(
      googleAnalyticsHeadHtml({
        enabled: true,
        profile: "UA-1-2</script><script>alert(1)</script>"
      }),
      ""
    )
    const head = googleAnalyticsHeadHtml({ enabled: true, profile: "UA-1-2" })
    assert.equal(head.startsWith("<script>"), true)
    assert.doesNotMatch(head, /https?:|\.src\s*=|google-analytics\.com/u)
  })

  it("keeps effective theme variants separate for initial head rendering", () => {
    assert.deepEqual(normalizeThemeSetting({ type: "built_in", id: 1 }), {
      type: "built_in",
      id: 1
    })
    assert.deepEqual(
      normalizeThemeSetting({ type: "external", url: "https://cdn.scpwiki.com/a.css" }),
      { type: "external", url: "https://cdn.scpwiki.com/a.css" }
    )
    assert.deepEqual(
      normalizeThemeSetting({
        type: "external",
        url: "https://scp-jp.github.io/files/util/main/styles/sigma-9.min.css"
      }),
      {
        type: "external",
        url: "https://scp-jp.github.io/files/util/main/styles/sigma-9.min.css"
      }
    )
    assert.deepEqual(
      normalizeThemeSetting({ type: "external", url: "http://themes.example/a.css" }),
      { type: "built_in", id: 1 }
    )
    assert.deepEqual(
      normalizeThemeSetting({ type: "external", url: "https://themes.example/a.css" }),
      { type: "built_in", id: 1 }
    )
    assert.deepEqual(
      normalizeThemeSetting({ type: "custom", css: "</style><script>x</script>" }),
      { type: "built_in", id: 1 }
    )
  })

  it("admits an external theme served from the site's own files host", () => {
    const authority = "scp-jp-sigma10.wjfiles.localhost:28443"
    const ported =
      "https://scp-jp-sigma10.wjfiles.localhost:28443/local--code/component:theme/1"
    const portless =
      "https://scp-jp-sigma10.wjfiles.localhost/local--code/component:theme/1"
    assert.deepEqual(
      normalizeThemeSetting({ type: "external", url: ported }, authority),
      { type: "external", url: ported }
    )
    assert.deepEqual(
      normalizeThemeSetting({ type: "external", url: portless }, authority),
      { type: "external", url: portless }
    )
    assert.deepEqual(
      normalizeThemeSetting(
        { type: "external", url: portless },
        "scp-jp-sigma10.wjfiles.localhost"
      ),
      { type: "external", url: portless }
    )
    assert.equal(
      resolveExternalThemeHref(
        { type: "external", url: ported },
        null,
        authority,
        () => false
      ),
      ported
    )
  })

  it("keeps every other external theme rejection intact beside an own host", () => {
    const authority = "scp-jp-sigma10.wjfiles.localhost:28443"
    const builtIn = { type: "built_in", id: 1 }
    for (const url of [
      "https://themes.example/a.css",
      "https://scp-wiki.wjfiles.localhost:28443/local--code/component:theme/1",
      "https://scp-jp-sigma10.wjfiles.localhost:9999/local--code/component:theme/1",
      "https://user:password@scp-jp-sigma10.wjfiles.localhost:28443/a.css",
      "http://scp-jp-sigma10.wjfiles.localhost:28443/a.css"
    ]) {
      assert.deepEqual(
        normalizeThemeSetting({ type: "external", url }, authority),
        builtIn,
        url
      )
    }
    assert.deepEqual(
      normalizeThemeSetting({
        type: "external",
        url: "https://scp-jp-sigma10.wjfiles.localhost:28443/a.css"
      }),
      builtIn
    )
    assert.deepEqual(
      normalizeThemeSetting(
        {
          type: "external",
          url: "https://scp-jp-sigma10.wjfiles.localhost:28443/a.css"
        },
        "https://scp-jp-sigma10.wjfiles.localhost:28443"
      ),
      builtIn
    )
    assert.equal(
      normalizeThemePreviewUrl("https://scp-jp-sigma10.wjfiles.localhost:28443/a.css"),
      null
    )
  })

  it("normalizes ThemePreviewer URLs with the stored-theme policy", () => {
    assert.equal(
      normalizeThemePreviewUrl("https://cdn.scpwiki.com/theme/preview.css"),
      "https://cdn.scpwiki.com/theme/preview.css"
    )
    assert.equal(
      normalizeThemePreviewUrl(
        "https://sandbox-for-codex.wdfiles.com/local--code/theme/1"
      ),
      "https://sandbox-for-codex.wdfiles.com/local--code/theme/1"
    )
    for (const value of [
      null,
      "",
      "http://cdn.scpwiki.com/theme/preview.css",
      "data:text/css,body{}",
      "https://evil.example/theme.css",
      "https://user:password@cdn.scpwiki.com/theme.css",
      "https://cdn.scpwiki.com:8443/theme.css"
    ]) {
      assert.equal(normalizeThemePreviewUrl(value), null, String(value))
    }
  })

  it("requires the source-owned ThemePreviewer noUi sidecar", () => {
    const allowed = "https://cdn.scpwiki.com/theme/preview.css"
    assert.equal(resolveThemePreviewUrl(true, allowed), allowed)
    assert.equal(resolveThemePreviewUrl(false, allowed), null, "bare ThemePreviewer")
    assert.equal(resolveThemePreviewUrl(undefined, allowed), null, "literal/code source")
    assert.equal(
      resolveThemePreviewUrl(true, "https://evil.example/theme.css"),
      null,
      "disallowed URL"
    )
  })
})
