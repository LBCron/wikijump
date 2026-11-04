import assert from "node:assert/strict"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.ts"

let vite: any
let legalDestinations: typeof import("../src/lib/server/legal-links.ts").legalDestinations

before(async () => {
  vite = await createTestViteServer()
  ;({ legalDestinations } = await vite.ssrLoadModule("/src/lib/server/legal-links.ts"))
})

after(async () => {
  if (vite) await vite.close()
})

test("legal destinations default to the platform host for the deployment", () => {
  assert.deepEqual(legalDestinations({ deploymentEnvironment: "local" }), {
    termsOfService: "https://wikijump.localhost/legal:terms-of-service",
    privacyPolicy: "https://wikijump.localhost/legal:privacy-policy"
  })
  assert.deepEqual(legalDestinations({ deploymentEnvironment: "dev" }), {
    termsOfService: "https://wikijump.dev/legal:terms-of-service",
    privacyPolicy: "https://wikijump.dev/legal:privacy-policy"
  })
  assert.deepEqual(legalDestinations({ deploymentEnvironment: "prod" }), {
    termsOfService: "https://wikijump.com/legal:terms-of-service",
    privacyPolicy: "https://wikijump.com/legal:privacy-policy"
  })
})

test("the local development stack links to its own platform host and port", () => {
  assert.deepEqual(
    legalDestinations({
      deploymentEnvironment: "local",
      env: {
        WIKIJUMP_MAIN_DOMAIN: "wikijump.dev.localhost",
        WIKIJUMP_HTTPS_PORT: "18443"
      }
    }),
    {
      termsOfService: "https://wikijump.dev.localhost:18443/legal:terms-of-service",
      privacyPolicy: "https://wikijump.dev.localhost:18443/legal:privacy-policy"
    }
  )
})

test("a self-hosted instance configures its own legal destinations", () => {
  const destinations = legalDestinations({
    deploymentEnvironment: "prod",
    env: {
      WIKIJUMP_TERMS_OF_SERVICE_URL: "https://legal.example.invalid/terms",
      WIKIJUMP_PRIVACY_POLICY_URL: "https://legal.example.invalid/privacy"
    }
  })
  assert.equal(destinations.termsOfService, "https://legal.example.invalid/terms")
  assert.equal(destinations.privacyPolicy, "https://legal.example.invalid/privacy")
})

test("legal destinations never resolve against the viewed wiki", () => {
  assert.deepEqual(legalDestinations({ env: {} }), {
    termsOfService: "https://wikijump.localhost/legal:terms-of-service",
    privacyPolicy: "https://wikijump.localhost/legal:privacy-policy"
  })
  assert.deepEqual(legalDestinations({ env: { WIKIJUMP_TERMS_OF_SERVICE_URL: "  " } }), {
    termsOfService: "https://wikijump.localhost/legal:terms-of-service",
    privacyPolicy: "https://wikijump.localhost/legal:privacy-policy"
  })
  const destinationVariables = [
    ["termsOfService", "WIKIJUMP_TERMS_OF_SERVICE_URL"],
    ["privacyPolicy", "WIKIJUMP_PRIVACY_POLICY_URL"]
  ]
  const scriptUrl = ["javascript", "alert(1)"].join(":")
  for (const [key, variable] of destinationVariables) {
    for (const value of [
      `/legal/${key}`,
      "legal.example.invalid/terms",
      scriptUrl,
      "http://legal.example.invalid/terms"
    ]) {
      assert.throws(
        () => legalDestinations({ env: { [variable]: value } }),
        new RegExp(variable),
        `${variable}=${value}`
      )
    }
  }
})

test("footer destinations name the platform wiki's own pages for the deployment", async () => {
  const { platformFooterDestinations } = await import("../src/lib/server/legal-links.ts")
  assert.deepEqual(
    platformFooterDestinations({ deploymentEnvironment: "local", env: {} }),
    {
      "terms-conditions": "https://wikijump.localhost/legal:terms-of-service",
      privacy: "https://wikijump.localhost/legal:privacy-policy",
      docs: "https://wikijump.localhost/docs",
      security: "https://wikijump.localhost/legal:security"
    }
  )
  const configured = platformFooterDestinations({
    deploymentEnvironment: "prod",
    env: { WIKIJUMP_TERMS_OF_SERVICE_URL: "https://policies.example.org/terms" }
  })
  assert.equal(configured["terms-conditions"], "https://policies.example.org/terms")
  assert.equal(configured.docs, "https://wikijump.com/docs")
})
