import assert from "node:assert/strict"
import test from "node:test"

import { handleAjaxModuleConnectorRequest } from "../src/lib/server/ajax-module-connector.ts"

const MODULE_NAME = "managesite/ManageSiteGeneralModule"

/** @param {any} body */
const request = (body) =>
  new Request("http://sandbox.local/ajax-module-connector.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  })

test("ManageSiteGeneral accepts the exact parameter-free administrator read", async () => {
  const response = await handleAjaxModuleConnectorRequest(
    request(new URLSearchParams({ moduleName: MODULE_NAME })),
    {
      siteId: 17,
      renderListPages: async () => assert.fail("must not render ListPages"),
      renderManageSiteGeneralModule: async () => ({
        status: "ok",
        body: '<form id="sm-general-form"></form>',
        js_include: [
          "http://d3g0gp89917ko0.cloudfront.net/v--7690939296dc/common--modules/js/managesite/ManageSiteGeneralModule.js"
        ]
      })
    }
  )
  const body = await response.json()

  assert.equal(body.status, "ok")
  assert.equal(body.body, '<form id="sm-general-form"></form>')
  assert.equal(body.callbackIndex, null)
  assert.deepEqual(body.cssInclude, [])
  assert.deepEqual(body.jsInclude, [
    "http://d3g0gp89917ko0.cloudfront.net/v--7690939296dc/common--modules/js/managesite/ManageSiteGeneralModule.js"
  ])
  assert.equal(Number.isInteger(body.CURRENT_TIMESTAMP), true)
})

test("ManageSiteGeneral preserves the fail-closed envelope for non-administrators", async () => {
  for (const actor of ["anonymous", "member", "moderator", "expired-session"]) {
    const response = await handleAjaxModuleConnectorRequest(
      request(new URLSearchParams({ moduleName: MODULE_NAME })),
      {
        siteId: 17,
        renderListPages: async () => assert.fail("must not render ListPages"),
        renderManageSiteGeneralModule: async () => null
      }
    )
    assert.deepEqual(
      await response.json(),
      {
        status: "not_ok",
        message: `Unsupported AJAX module: ${MODULE_NAME}`
      },
      actor
    )
  }
})

test("ManageSiteGeneral rejects unobserved fields and duplicates before rendering", async () => {
  let renders = 0
  const options = {
    siteId: 17,
    renderListPages: async () => assert.fail("must not render ListPages"),
    renderManageSiteGeneralModule: async () => {
      renders += 1
      assert.fail("unsupported shapes must fail before rendering")
    }
  }

  for (const fields of [
    { moduleName: MODULE_NAME, wikidot_token7: "token" },
    { moduleName: MODULE_NAME, callbackIndex: "0" },
    { moduleName: MODULE_NAME, module_body: "" },
    { moduleName: MODULE_NAME, extra: "1" }
  ]) {
    const response = await handleAjaxModuleConnectorRequest(
      request(new URLSearchParams(/** @type {any} */ (fields))),
      options
    )
    assert.deepEqual(await response.json(), {
      status: "not_ok",
      message: `Unsupported AJAX module shape: ${MODULE_NAME}`
    })
  }

  const duplicate = await handleAjaxModuleConnectorRequest(
    request(
      `moduleName=${encodeURIComponent(MODULE_NAME)}&moduleName=${encodeURIComponent(MODULE_NAME)}`
    ),
    options
  )
  assert.equal(duplicate.status, 400)
  assert.deepEqual(await duplicate.json(), {
    status: "not_ok",
    message: "AJAX Module Connector field is duplicated: moduleName"
  })
  assert.equal(renders, 0)
})
