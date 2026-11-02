import { strict as assert } from "node:assert"
import test from "node:test"

const previousFramerailEnvironment = process.env.FRAMERAIL_ENV
process.env.FRAMERAIL_ENV = "local"
const { default: config } = await import("../sveltekit-options.js")
if (previousFramerailEnvironment === undefined) {
  delete process.env.FRAMERAIL_ENV
} else {
  process.env.FRAMERAIL_ENV = previousFramerailEnvironment
}
const directives = config.csp?.directives
if (!directives) throw new Error("CSP directives are missing")

test("local included components can load styles and fonts from the reviewed mirrors", () => {
  for (const origin of [
    "https://scp-wiki.wjfiles.localhost",
    "https://scp-jp.wjfiles.localhost"
  ]) {
    for (const directive of ["style-src", "font-src"]) {
      assert(directives[directive]?.includes(origin), `${directive} needs ${origin}`)
    }
    for (const directive of ["script-src", "connect-src", "frame-src"]) {
      assert(!directives[directive]?.includes(origin), `${directive} excludes ${origin}`)
    }
  }
})

test("local mirror style and font grants do not reach other deployments", async () => {
  const previous = process.env.FRAMERAIL_ENV
  try {
    for (const environment of ["dev", "prod"]) {
      process.env.FRAMERAIL_ENV = environment
      const { default: other } = await import(
        `../sveltekit-options.js?mirror-assets=${environment}`
      )
      for (const directive of ["style-src", "font-src"]) {
        const sources = other.csp.directives[directive]
        assert(!sources.some((source) => source.includes(".wjfiles.localhost")))
      }
    }
  } finally {
    if (previous === undefined) delete process.env.FRAMERAIL_ENV
    else process.env.FRAMERAIL_ENV = previous
  }
})

test("allows captured Wikidot legacy asset origins in local CSP", () => {
  assert.equal(directives["upgrade-insecure-requests"], true)
  assert(directives["style-src"]?.some((source) => source === "https://cdn.jsdelivr.net"))
  assert(!directives["style-src"]?.some((source) => source === "https:"))
  assert(directives["font-src"]?.some((source) => source === "https://cdn.jsdelivr.net"))
  assert(
    directives["img-src"]?.some(
      (source) => source === "https://d3g0gp89917ko0.cloudfront.net"
    )
  )
  for (const origin of [
    "https://scp-wiki.wikidot.com",
    "https://www.wikidot.com",
    "https://scp-jp-storage.wikidot.com",
    "https://scpsandboxcn.wikidot.com"
  ]) {
    assert(directives["img-src"]?.some((source) => source === origin))
  }
  assert(
    directives["img-src"]?.some(
      (source) => source === "https://d2qhngyckgiutd.cloudfront.net"
    )
  )
  for (const origin of [
    "https://nu-scptheme.github.io",
    "https://scpwiki.github.io",
    "https://upload.wikimedia.org"
  ]) {
    assert(
      directives["img-src"]?.some((source) => source === origin),
      origin
    )
  }
  assert(directives["style-src"]?.includes("https://use.typekit.net"))
  assert(directives["font-src"]?.includes("https://use.typekit.net"))
  assert(directives["style-src"]?.includes("https://p.typekit.net"))
  assert(!directives["font-src"]?.includes("https://p.typekit.net"))
  for (const origin of [
    "https://scp-wiki.wjfiles.localhost",
    "https://scp-jp.wjfiles.localhost"
  ]) {
    assert(directives["img-src"]?.some((source) => source === origin))
  }
  assert(
    directives["style-src"]?.some((source) => source === "https://nu-scptheme.github.io")
  )
  assert(
    directives["style-src"]?.some((source) => source === "https://fonts.googleapis.com")
  )
  assert(
    !directives["script-src"]?.some(
      (source) => source === "https://d3g0gp89917ko0.cloudfront.net"
    )
  )
  for (const origin of ["https://fonts.gstatic.com", "https://nu-scptheme.github.io"]) {
    assert(directives["font-src"]?.some((source) => source === origin))
  }
  for (const origin of ["https://indestructibletype-fonthosting.github.io"]) {
    assert(directives["style-src"]?.some((source) => source === origin))
    assert(directives["font-src"]?.some((source) => source === origin))
  }
  for (const sources of [
    directives["img-src"],
    directives["script-src"],
    directives["connect-src"],
    directives["frame-src"],
    directives["style-src"],
    directives["font-src"]
  ]) {
    assert(!sources?.some((source) => source === "https://*.wikidot.com"))
  }
  assert(
    directives["img-src"]?.some(
      (source) => source === "https://wikijump-current-site.invalid"
    )
  )
  assert(
    directives["style-src"]?.some(
      (source) => source === "https://wikijump-current-site.invalid"
    )
  )
  assert(
    directives["font-src"]?.some(
      (source) => source === "https://wikijump-current-site.invalid"
    )
  )
  assert(
    !directives["img-src"]?.some((source) => source === "https://*.wjfiles.localhost")
  )
  assert(
    !directives["style-src"]?.some((source) => source === "https://*.wjfiles.localhost")
  )
  assert(
    !directives["font-src"]?.some((source) => source === "https://*.wjfiles.localhost")
  )
  assert.deepEqual(directives["frame-src"], [
    "self",
    "https://wikijump-current-site.invalid",
    "https://www.youtube.com",
    "https://embed.acast.com"
  ])
  assert(directives["script-src"]?.includes("self"))
})
