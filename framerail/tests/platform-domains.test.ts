import assert from "node:assert/strict"
import test from "node:test"

import {
  platformDomains,
  platformHttpsOrigin
} from "../src/lib/server/platform-domains.ts"

test("each deployment environment has documented platform hosts on port 443", () => {
  assert.deepEqual(platformDomains({ deploymentEnvironment: "local", env: {} }), {
    main: "wikijump.localhost",
    files: "wjfiles.localhost",
    httpsPort: 443
  })
  assert.deepEqual(platformDomains({ deploymentEnvironment: "dev", env: {} }), {
    main: "wikijump.dev",
    files: "wjfiles.dev",
    httpsPort: 443
  })
  assert.deepEqual(platformDomains({ deploymentEnvironment: "prod", env: {} }), {
    main: "wikijump.com",
    files: "wjfiles.com",
    httpsPort: 443
  })
})

test("the local development stack names its own hosts and public port", () => {
  const domains = platformDomains({
    deploymentEnvironment: "local",
    env: {
      WIKIJUMP_MAIN_DOMAIN: "wikijump.dev.localhost",
      WIKIJUMP_FILES_DOMAIN: "wjfiles.dev.localhost",
      WIKIJUMP_HTTPS_PORT: "18443"
    }
  })
  assert.deepEqual(domains, {
    main: "wikijump.dev.localhost",
    files: "wjfiles.dev.localhost",
    httpsPort: 18443
  })
  assert.equal(
    platformHttpsOrigin(domains.main, domains),
    "https://wikijump.dev.localhost:18443"
  )
  assert.equal(
    platformHttpsOrigin("wikijump.localhost", { httpsPort: 443 }),
    "https://wikijump.localhost"
  )
})

test("a domain never carries the port; only WIKIJUMP_HTTPS_PORT does", () => {
  for (const [variable, value] of [
    ["WIKIJUMP_MAIN_DOMAIN", "wikijump.localhost:18443"],
    ["WIKIJUMP_FILES_DOMAIN", "https://wjfiles.localhost"],
    ["WIKIJUMP_MAIN_DOMAIN", "Wikijump.Localhost"],
    ["WIKIJUMP_MAIN_DOMAIN", ".wikijump.localhost"]
  ]) {
    assert.throws(
      () =>
        platformDomains({ deploymentEnvironment: "local", env: { [variable]: value } }),
      new RegExp(variable),
      `${variable}=${value}`
    )
  }
  for (const value of ["0", "65536", "18443x", "-1", " 443"]) {
    assert.throws(
      () =>
        platformDomains({
          deploymentEnvironment: "local",
          env: { WIKIJUMP_HTTPS_PORT: value }
        }),
      /WIKIJUMP_HTTPS_PORT/u,
      value
    )
  }
})
