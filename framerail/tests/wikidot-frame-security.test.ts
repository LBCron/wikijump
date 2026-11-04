import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"

import {
  WIKIDOT_STYLE_FRAME_SCRIPT,
  buildWikidotStyleFrameHtml
} from "../src/lib/wikidot/wikidot-styleframe.ts"
import { auditedExternalAssetOrigins } from "../src/lib/server/audited-external-asset-origins.ts"

const {
  applyStaticSecurityHeaders,
  applyStaticSecurityHeadersToNodeResponse,
  materializeSiteCsp
} = await import("../src/lib/server/security-headers.ts")

test("permits only the two same-origin Wikidot compatibility frames", () => {
  for (const pathname of [
    "/-/wikidot-interwiki/interwikiFrame.html",
    "/-/wikidot-interwiki/styleFrame.html"
  ]) {
    const response = new Response("")
    applyStaticSecurityHeaders(response, pathname, undefined, "local")
    assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN")
    assert.match(
      response.headers.get("content-security-policy") ?? "",
      /frame-ancestors 'self'/u
    )
  }
})

test("permits the interwiki frame's required inline presentation", () => {
  const interwiki = new Response("")
  applyStaticSecurityHeaders(
    interwiki,
    "/-/wikidot-interwiki/interwikiFrame.html",
    undefined,
    "local"
  )
  assert.match(
    interwiki.headers.get("content-security-policy") ?? "",
    /style-src(?: 'self')? 'unsafe-inline'/u
  )
  assert.match(
    interwiki.headers.get("content-security-policy") ?? "",
    /style-src 'self'/u
  )
  assert.match(interwiki.headers.get("content-security-policy") ?? "", /font-src 'self'/u)
})

test("interwiki frame uses only the audited external style and font origins", () => {
  const interwiki = new Response("")
  applyStaticSecurityHeaders(
    interwiki,
    "/-/wikidot-interwiki/interwikiFrame.html",
    "scp-wiki",
    "local",
    "https://scp-wiki.wikijump.localhost"
  )
  const policy = interwiki.headers.get("content-security-policy") ?? ""
  const directiveSources = (name: string) => {
    const directive = policy
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${name} `))
    return directive?.split(/\s+/u).slice(1) ?? []
  }

  for (const origin of auditedExternalAssetOrigins("styles")) {
    assert.ok(
      directiveSources("style-src").includes(origin),
      `style-src must include ${origin}`
    )
  }
  for (const origin of auditedExternalAssetOrigins("fonts")) {
    assert.ok(
      directiveSources("font-src").includes(origin),
      `font-src must include ${origin}`
    )
  }
  assert.deepEqual(directiveSources("script-src"), ["'unsafe-inline'"])
  assert.ok(!policy.includes("https://example.invalid"))
})

test("styleFrame permits its fixed script and inline-style compatibility", () => {
  const styleFrame = new Response("")
  applyStaticSecurityHeaders(
    styleFrame,
    "/-/wikidot-interwiki/styleFrame.html",
    undefined,
    "local"
  )
  const policy = styleFrame.headers.get("content-security-policy") ?? ""
  const scriptHash = createHash("sha256")
    .update(WIKIDOT_STYLE_FRAME_SCRIPT)
    .digest("base64")
  assert.equal(
    policy,
    `default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; frame-ancestors 'self'`
  )
  assert.ok(
    buildWikidotStyleFrameHtml().includes(
      `<script>${WIKIDOT_STYLE_FRAME_SCRIPT}</script>`
    )
  )
  assert.doesNotMatch(policy, /script-src[^;]*unsafe-inline/u)
  assert.doesNotMatch(policy, /style-src[^;]*https?:/u)
})

test("interwiki frame admits localized themes from the current site's file origin", () => {
  const interwiki = new Response("")
  applyStaticSecurityHeaders(
    interwiki,
    "/-/wikidot-interwiki/interwikiFrame.html",
    "scp-wiki",
    "local",
    "https://scp-wiki.wikijump.localhost"
  )
  const policy = interwiki.headers.get("content-security-policy") ?? ""
  for (const directive of ["style-src", "font-src", "img-src"]) {
    assert.match(
      policy,
      new RegExp(
        `${directive} [^;]*https://scp-wiki\\.wjfiles\\.localhost(?:[ ;]|$)`,
        "u"
      )
    )
  }
  assert.doesNotMatch(policy, /wikijump-current-site\.invalid/u)
  assert.doesNotMatch(policy, /https:\/\/[^ ;]*wikidot\.com/u)
})

test("keeps ordinary pages unframeable", () => {
  const response = new Response("", {
    headers: { "content-security-policy": "frame-ancestors 'none'" }
  })
  applyStaticSecurityHeaders(response, "/scp-9506")
  assert.equal(response.headers.get("x-frame-options"), "DENY")
  assert.equal(response.headers.get("content-security-policy"), "frame-ancestors 'none'")
})

test("materializes an exact current-site file origin", () => {
  const response = new Response("", {
    headers: {
      "content-security-policy":
        "default-src 'self'; img-src 'self' https://wikijump-current-site.invalid; style-src 'self' https://wikijump-current-site.invalid"
    }
  })
  materializeSiteCsp(response, "scp-wiki", "local")
  const policy = response.headers.get("content-security-policy") ?? ""
  assert.match(policy, /https:\/\/scp-wiki\.wjfiles\.localhost/u)
  assert.doesNotMatch(policy, /wikijump-current-site\.invalid|\*\.wjfiles/u)
})

test("preserves the canonical and request-port forms of the current-site file CSP origin", () => {
  const response = new Response("", {
    headers: {
      "content-security-policy":
        "img-src 'self' https://wikijump-current-site.invalid; style-src 'self' https://wikijump-current-site.invalid"
    }
  })
  materializeSiteCsp(
    response,
    "scp-wiki",
    "local",
    "https://scp-wiki.wikijump.localhost:18443"
  )
  assert.equal(
    response.headers.get("content-security-policy"),
    "img-src 'self' https://scp-wiki.wjfiles.localhost https://scp-wiki.wjfiles.localhost:18443; style-src 'self' https://scp-wiki.wjfiles.localhost https://scp-wiki.wjfiles.localhost:18443"
  )
})

test("preserves the canonical and request-port forms of the local mirror file CSP origins", () => {
  const response = new Response("", {
    headers: {
      "content-security-policy":
        "style-src 'self' https://wikijump-current-site.invalid https://scp-wiki.wjfiles.localhost https://scp-jp.wjfiles.localhost"
    }
  })
  materializeSiteCsp(
    response,
    "scpaiueouiuiuiui",
    "local",
    "https://scpaiueouiuiuiui.wikijump.localhost:28443"
  )
  assert.equal(
    response.headers.get("content-security-policy"),
    "style-src 'self' https://scpaiueouiuiuiui.wjfiles.localhost https://scpaiueouiuiuiui.wjfiles.localhost:28443 https://scp-wiki.wjfiles.localhost https://scp-wiki.wjfiles.localhost:28443 https://scp-jp.wjfiles.localhost https://scp-jp.wjfiles.localhost:28443"
  )
})

test("keeps canonical file origins beside request-port forms at a rehearsal port", () => {
  const response = new Response("", {
    headers: {
      "content-security-policy":
        "img-src 'self' https://wikijump-current-site.invalid; style-src 'self' https://scp-wiki.wjfiles.localhost https://scp-jp.wjfiles.localhost"
    }
  })
  materializeSiteCsp(
    response,
    "scp-wiki",
    "local",
    "https://scp-wiki.wikijump.localhost:18560"
  )
  assert.equal(
    response.headers.get("content-security-policy"),
    "img-src 'self' https://scp-wiki.wjfiles.localhost https://scp-wiki.wjfiles.localhost:18560; style-src 'self' https://scp-wiki.wjfiles.localhost https://scp-wiki.wjfiles.localhost:18560 https://scp-jp.wjfiles.localhost https://scp-jp.wjfiles.localhost:18560"
  )
})

test("materializes the viewed site's own files origin in font-src (sigma-10)", () => {
  const response = new Response("", {
    headers: {
      "content-security-policy":
        "font-src 'self' data: https://wikijump-current-site.invalid; style-src 'self' https://wikijump-current-site.invalid; img-src 'self' https://wikijump-current-site.invalid"
    }
  })
  materializeSiteCsp(
    response,
    "scp-jp-sigma10",
    "local",
    "https://scp-jp-sigma10.wikijump.localhost:28443"
  )
  assert.equal(
    response.headers.get("content-security-policy"),
    "font-src 'self' data: https://scp-jp-sigma10.wjfiles.localhost https://scp-jp-sigma10.wjfiles.localhost:28443; style-src 'self' https://scp-jp-sigma10.wjfiles.localhost https://scp-jp-sigma10.wjfiles.localhost:28443; img-src 'self' https://scp-jp-sigma10.wjfiles.localhost https://scp-jp-sigma10.wjfiles.localhost:28443"
  )
})

test("leaves local mirror file origins unchanged when no request port is known", () => {
  const response = new Response("", {
    headers: {
      "content-security-policy":
        "style-src 'self' https://wikijump-current-site.invalid https://scp-wiki.wjfiles.localhost"
    }
  })
  materializeSiteCsp(response, "scp-wiki", "local")
  assert.equal(
    response.headers.get("content-security-policy"),
    "style-src 'self' https://scp-wiki.wjfiles.localhost https://scp-wiki.wjfiles.localhost"
  )
})

test("the local development stack materializes its own files host", () => {
  const previous = process.env.WIKIJUMP_FILES_DOMAIN
  process.env.WIKIJUMP_FILES_DOMAIN = "wjfiles.dev.localhost"
  try {
    const response = new Response("", {
      headers: {
        "content-security-policy": "img-src 'self' https://wikijump-current-site.invalid"
      }
    })
    materializeSiteCsp(
      response,
      "scp-wiki",
      "local",
      "https://scp-wiki.wikijump.dev.localhost:18443"
    )
    assert.equal(
      response.headers.get("content-security-policy"),
      "img-src 'self' https://scp-wiki.wjfiles.dev.localhost https://scp-wiki.wjfiles.dev.localhost:18443"
    )
  } finally {
    if (previous === undefined) delete process.env.WIKIJUMP_FILES_DOMAIN
    else process.env.WIKIJUMP_FILES_DOMAIN = previous
  }
})

test("does not materialize untrusted site slugs", () => {
  const response = new Response("", {
    headers: {
      "content-security-policy": "img-src https://wikijump-current-site.invalid"
    }
  })
  materializeSiteCsp(response, "scp-wiki.evil", "local")
  assert.equal(
    response.headers.get("content-security-policy"),
    "img-src https://wikijump-current-site.invalid"
  )
})

test("replaces only an exact CSP source token", () => {
  const prefixed = `https://evil.example/https://wikijump-current-site.invalid`
  const suffixed = `https://wikijump-current-site.invalid.evil.example`
  const response = new Response("", {
    headers: {
      "content-security-policy": `img-src ${prefixed} https://wikijump-current-site.invalid ${suffixed}`
    }
  })
  materializeSiteCsp(response, "scp-wiki", "local")
  assert.equal(
    response.headers.get("content-security-policy"),
    `img-src ${prefixed} https://scp-wiki.wjfiles.localhost ${suffixed}`
  )
})

test("node compatibility responses receive the same local frame policy", () => {
  const headers = new Map()
  const response = {
    setHeader(name: string, value: string) {
      headers.set(name, value)
    },
    removeHeader(name: string) {
      headers.delete(name)
    }
  }
  applyStaticSecurityHeadersToNodeResponse(
    response,
    "/-/wikidot-interwiki/styleFrame.html",
    "local"
  )
  assert.equal(headers.get("x-frame-options"), "SAMEORIGIN")
  assert.match(headers.get("content-security-policy")!, /frame-ancestors 'self'/u)
})

test("reads the frame-policy environment at call time", () => {
  const previousFramerailEnvironment = process.env.FRAMERAIL_ENV
  try {
    process.env.FRAMERAIL_ENV = "local"
    const localResponse = new Response("")
    applyStaticSecurityHeaders(localResponse, "/-/wikidot-interwiki/styleFrame.html")
    assert.equal(localResponse.headers.get("x-frame-options"), "SAMEORIGIN")

    process.env.FRAMERAIL_ENV = "prod"
    const productionResponse = new Response("")
    applyStaticSecurityHeaders(productionResponse, "/-/wikidot-interwiki/styleFrame.html")
    assert.equal(productionResponse.headers.get("x-frame-options"), "DENY")
  } finally {
    if (previousFramerailEnvironment === undefined) delete process.env.FRAMERAIL_ENV
    else process.env.FRAMERAIL_ENV = previousFramerailEnvironment
  }
})

test("keeps styleFrame unframeable outside local deployments", () => {
  const response = new Response("")
  applyStaticSecurityHeaders(
    response,
    "/-/wikidot-interwiki/styleFrame.html",
    undefined,
    "prod"
  )
  assert.equal(response.headers.get("x-frame-options"), "DENY")
  assert.equal(response.headers.get("content-security-policy"), null)
})

test("interwiki frame admits both local mirror file origins on the default port", () => {
  const interwiki = new Response("")
  applyStaticSecurityHeaders(
    interwiki,
    "/-/wikidot-interwiki/interwikiFrame.html",
    "scp-jp",
    "local",
    "https://scp-jp.wikijump.localhost"
  )
  const policy = interwiki.headers.get("content-security-policy") ?? ""
  const directiveSources = (name: string) => {
    const directive = policy
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${name} `))
    return directive?.split(/\s+/u).slice(1) ?? []
  }
  for (const directive of ["style-src", "font-src", "img-src"]) {
    for (const origin of [
      "https://scp-wiki.wjfiles.localhost",
      "https://scp-jp.wjfiles.localhost"
    ]) {
      assert.ok(
        directiveSources(directive).includes(origin),
        `${directive} must include ${origin}`
      )
    }
  }
})

test("interwiki frame carries both mirror forms at the stafflab port", () => {
  const interwiki = new Response("")
  applyStaticSecurityHeaders(
    interwiki,
    "/-/wikidot-interwiki/interwikiFrame.html",
    "scp-jp",
    "local",
    "https://scp-jp.wikijump.localhost:28443"
  )
  const policy = interwiki.headers.get("content-security-policy") ?? ""
  const directiveSources = (name: string) => {
    const directive = policy
      .split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${name} `))
    return directive?.split(/\s+/u).slice(1) ?? []
  }
  const mirrorForms = [
    "https://scp-wiki.wjfiles.localhost",
    "https://scp-wiki.wjfiles.localhost:28443",
    "https://scp-jp.wjfiles.localhost",
    "https://scp-jp.wjfiles.localhost:28443"
  ]
  for (const origin of mirrorForms) {
    assert.ok(
      directiveSources("style-src").includes(origin),
      `style-src must include ${origin}`
    )
  }
  for (const directive of ["font-src", "img-src"]) {
    for (const origin of [
      "https://scp-wiki.wjfiles.localhost",
      "https://scp-wiki.wjfiles.localhost:28443"
    ]) {
      assert.ok(
        directiveSources(directive).includes(origin),
        `${directive} must include ${origin}`
      )
    }
  }
})

test("interwiki frame carries both mirror forms at a rehearsal port", () => {
  const interwiki = new Response("")
  applyStaticSecurityHeaders(
    interwiki,
    "/-/wikidot-interwiki/interwikiFrame.html",
    "scp-wiki",
    "local",
    "https://scp-wiki.wikijump.localhost:18560"
  )
  const policy = interwiki.headers.get("content-security-policy") ?? ""
  assert.match(policy, /style-src [^;]*https:\/\/scp-jp\.wjfiles\.localhost(?:[ ;]|$)/u)
  assert.match(
    policy,
    /style-src [^;]*https:\/\/scp-jp\.wjfiles\.localhost:18560(?:[ ;]|$)/u
  )
  assert.match(
    policy,
    /img-src [^;]*https:\/\/scp-jp\.wjfiles\.localhost:18560(?:[ ;]|$)/u
  )
})

test("keeps the interwiki frame policy unchanged outside local deployments", () => {
  const styleSources = auditedExternalAssetOrigins("styles").join(" ")
  const fontSources = auditedExternalAssetOrigins("fonts").join(" ")
  const expected =
    `default-src 'none'; script-src 'unsafe-inline'; ` +
    `style-src 'self' 'unsafe-inline' https://wikijump-current-site.invalid ${styleSources}; ` +
    `font-src 'self' data: https://wikijump-current-site.invalid ${fontSources}; ` +
    `img-src 'self' data: https://wikijump-current-site.invalid https://*.wdfiles.com https://cdn.scpwiki.com https://d3g0gp89917ko0.cloudfront.net https://scp-jp.github.io; ` +
    `frame-ancestors 'self'`
  for (const deploymentEnvironment of ["dev", "prod"] as const) {
    const interwiki = new Response("")
    applyStaticSecurityHeaders(
      interwiki,
      "/-/wikidot-interwiki/interwikiFrame.html",
      undefined,
      deploymentEnvironment
    )
    assert.equal(interwiki.headers.get("content-security-policy"), expected)
  }
})
