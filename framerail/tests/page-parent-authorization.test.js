import assert from "node:assert/strict"
import { after, before, test } from "node:test"

import { pageActionEvent, startPageActionHarness } from "./page-action-test-harness.js"

const SITE_ID = 17
const TRUSTED_CONTEXT = { siteId: SITE_ID, page: "main" }

/** @type {any} */
let client
/** @type {any} */
let actions
/** @type {any} */
let closeHarness

before(async () => {
  const harness = await startPageActionHarness()
  client = harness.client
  actions = harness.actions
  closeHarness = () => harness.close()
})

after(async () => {
  await closeHarness?.()
})

const requestEvent = (overrides = {}) =>
  pageActionEvent(
    /** @type {any} */ ({
      action: "parentGet",
      siteId: SITE_ID,
      requestContext: { ...TRUSTED_CONTEXT },
      ...overrides
    })
  )

test("parent lookup forwards only the trusted site and page selector", async () => {
  /** @type {any[]} */
  const calls = []
  client.request = /** @param {any} method @param {any} params @param {any} context */ async (method, params, context) => {
    calls.push({ method, params, context })
    if (method === "parent_get_all") return ["parent-page"]
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const byId = await actions.parentGet(
    requestEvent({ body: { pageId: 42, slug: "main", siteId: 999 } })
  )
  assert.deepEqual(byId, { res: ["parent-page"] })
  assert.deepEqual(calls[0], {
    method: "parent_get_all",
    params: { site_id: SITE_ID, page: 42 },
    context: TRUSTED_CONTEXT
  })

  calls.length = 0
  const bySlug = await actions.parentGet(requestEvent({ body: { slug: "main" } }))
  assert.deepEqual(bySlug, { res: ["parent-page"] })
  assert.deepEqual(calls[0].params, { site_id: SITE_ID, page: "main" })

  calls.length = 0
  const spoofed = await actions.parentGet(
    requestEvent({ body: { slug: "main" }, siteId: SITE_ID + 1 })
  )
  assert.equal(spoofed.status, 403)
  assert.deepEqual(calls, [])
})
