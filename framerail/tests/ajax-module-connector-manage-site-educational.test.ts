import assert from "node:assert/strict"
import test from "node:test"

import {
  handleAjaxModuleConnectorRequest,
  type AjaxModuleConnectorOptions
} from "../src/lib/server/ajax-module-connector.ts"

const SITE_ID = 6000006
const MODULE_NAME = "managesite/ManageSiteUpgradeEduModule"

const request = (form: Record<string, string>) =>
  new Request("https://scp-wiki.wikijump.localhost/ajax-module-connector.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form)
  })

test("Educational upgrade module exposes the Master Administrator read model", async () => {
  const calls: { siteId: number }[] = []
  const response = await handleAjaxModuleConnectorRequest(
    request({ moduleName: MODULE_NAME }),
    {
      siteId: SITE_ID,
      renderManageSiteEducationalModule: async (input: { siteId: number }) => {
        calls.push(input)
        return {
          status: "ok",
          body: '<form id="sm-eduupgrade-form"></form>',
          js_include: [
            "http://d3g0gp89917ko0.cloudfront.net/v--7690939296dc/common--modules/js/managesite/ManageSiteUpgradeEduModule.js"
          ]
        }
      }
    } as unknown as AjaxModuleConnectorOptions
  )

  assert.deepEqual(calls, [{ siteId: SITE_ID }])
  const payload = await response.json()
  assert.equal(Number.isInteger(payload.CURRENT_TIMESTAMP), true)
  delete payload.CURRENT_TIMESTAMP
  assert.deepEqual(payload, {
    status: "ok",
    body: '<form id="sm-eduupgrade-form"></form>',
    callbackIndex: null,
    cssInclude: [],
    jsInclude: [
      "http://d3g0gp89917ko0.cloudfront.net/v--7690939296dc/common--modules/js/managesite/ManageSiteUpgradeEduModule.js"
    ]
  })
})

test("Educational upgrade module fails closed outside the Master Administrator boundary", async () => {
  const response = await handleAjaxModuleConnectorRequest(
    request({ moduleName: MODULE_NAME }),
    {
      siteId: SITE_ID,
      renderManageSiteEducationalModule: async () => null
    } as unknown as AjaxModuleConnectorOptions
  )
  const payload = await response.json()
  assert.equal(Number.isInteger(payload.CURRENT_TIMESTAMP), true)
  delete payload.CURRENT_TIMESTAMP
  assert.deepEqual(payload, {
    status: "not_ok",
    body: "",
    callbackIndex: null,
    cssInclude: [],
    jsInclude: []
  })
})

test("Educational upgrade action preserves the observed UpgradesAction wire shape", async () => {
  const calls: { siteId: number; organization: string; purpose: string }[] = []
  const response = await handleAjaxModuleConnectorRequest(
    request({
      moduleName: "Empty",
      action: "UpgradesAction",
      event: "upgradeEdu",
      organization: "Run Owned University",
      purpose: "Research and teaching"
    }),
    {
      siteId: SITE_ID,
      upgradeEducationalSite: async (input: {
        siteId: number
        organization: string
        purpose: string
      }) => {
        calls.push(input)
      }
    } as unknown as AjaxModuleConnectorOptions
  )

  assert.deepEqual(calls, [
    {
      siteId: SITE_ID,
      organization: "Run Owned University",
      purpose: "Research and teaching"
    }
  ])
  assert.deepEqual(await response.json(), { status: "ok" })
})

test("Educational upgrade action rejects incomplete and widened request shapes", async () => {
  for (const form of [
    {
      moduleName: "Empty",
      action: "UpgradesAction",
      event: "upgradeEdu",
      organization: "",
      purpose: "Research"
    },
    {
      moduleName: "Empty",
      action: "UpgradesAction",
      event: "upgradeEdu",
      organization: "University",
      purpose: ""
    },
    {
      moduleName: "Empty",
      action: "UpgradesAction",
      event: "upgradeEdu",
      organization: "University",
      purpose: "Research",
      extra: "unsupported"
    }
  ]) {
    const response = await handleAjaxModuleConnectorRequest(
      request(form as unknown as Record<string, string>),
      {
        siteId: SITE_ID,
        upgradeEducationalSite: async () => assert.fail("invalid shape must not mutate")
      } as unknown as AjaxModuleConnectorOptions
    )
    assert.deepEqual(await response.json(), { status: "not_ok" })
  }
})
