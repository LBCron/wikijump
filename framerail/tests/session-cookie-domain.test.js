import assert from "node:assert/strict"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.js"

let vite
let sessionCookieDomain

before(async () => {
  vite = await createTestViteServer()
  ;({ sessionCookieDomain } = await vite.ssrLoadModule(
    "/src/lib/server/auth/session-cookie.ts"
  ))
})

after(async () => {
  if (vite) await vite.close()
})

/** @param {Record<string, string>} values @param {() => void} body */
const withEnvironment = (values, body) => {
  const previous = Object.fromEntries(
    Object.keys(values).map((name) => [name, process.env[name]])
  )
  Object.assign(process.env, values)
  try {
    body()
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  }
}

test("standing shares its session cookie across wikijump.localhost", () => {
  assert.equal(
    sessionCookieDomain("https://scp-wiki.wikijump.localhost/scp-173", "local"),
    "wikijump.localhost"
  )
  assert.equal(sessionCookieDomain("https://scp-jp.localhost/", "local"), undefined)
})

test("the local development stack never shares a cookie with standing", () => {
  withEnvironment({ WIKIJUMP_MAIN_DOMAIN: "wikijump.dev.localhost" }, () => {
    assert.equal(
      sessionCookieDomain(
        "https://scpaiueouiuiuiui.wikijump.dev.localhost:18443/start",
        "local"
      ),
      "wikijump.dev.localhost"
    )
    assert.equal(
      sessionCookieDomain("https://scp-wiki.wikijump.localhost/scp-173", "local"),
      undefined
    )
  })
})

test("the session cookie is never scoped to a files host", () => {
  for (const [environment, files] of [
    ["local", "wjfiles.localhost"],
    ["dev", "wjfiles.dev"],
    ["prod", "wjfiles.com"]
  ]) {
    assert.equal(
      sessionCookieDomain(
        `https://scp-wiki.${files}/local--files/page/a.html`,
        environment
      ),
      undefined,
      `${environment} files host`
    )
  }
})

test("no deployment puts its files domain under the cookie's main domain", async () => {
  const { platformDomains } = await vite.ssrLoadModule(
    "/src/lib/server/platform-domains.js"
  )
  for (const deploymentEnvironment of ["local", "dev", "prod"]) {
    const { main, files } = platformDomains({ deploymentEnvironment })
    assert.notEqual(files, main, deploymentEnvironment)
    assert.ok(
      !files.endsWith(`.${main}`),
      `${deploymentEnvironment}: ${files} is under ${main}`
    )
  }
})
