// @ts-nocheck
import assert from "node:assert/strict"
import { after, before, test } from "node:test"

import { pageActionEvent, startPageActionHarness } from "./page-action-test-harness.js"

const SITE_ID = 17
const SESSION_TOKEN = "deleted-session"
const TRUSTED_CONTEXT = {
  siteId: SITE_ID,
  page: "main",
  sessionToken: SESSION_TOKEN
}

let client
let actions
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
  pageActionEvent({
    action: "deletedGet",
    siteId: SITE_ID,
    sessionToken: SESSION_TOKEN,
    requestContext: { ...TRUSTED_CONTEXT },
    ...overrides
  })

test("deleted-page actions use the authenticated route context", async () => {
  const calls = []
  client.request = async (method, params, context) => {
    calls.push({ method, params, context })
    if (method === "session_get") {
      return {
        session_token: SESSION_TOKEN,
        user_id: 91,
        created_at: "2026-08-10T00:00:00Z",
        expires_at: "2026-08-11T00:00:00Z",
        ip_address: "192.0.2.91",
        user_agent: "deleted page test",
        restricted: false
      }
    }
    if (method === "page_get_deleted") {
      return [{ page_id: 42, slug: "main", site_id: SITE_ID }]
    }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const result = await actions.deletedGet(requestEvent())
  assert.deepEqual(result, {
    res: [{ page_id: 42, slug: "main", site_id: SITE_ID }]
  })
  assert.deepEqual(calls, [
    { method: "session_get", params: [SESSION_TOKEN], context: undefined },
    {
      method: "page_get_deleted",
      params: { site_id: SITE_ID, slug: "main" },
      context: TRUSTED_CONTEXT
    }
  ])

  calls.length = 0
  const unauthenticated = await actions.deletedGet(
    requestEvent({
      sessionToken: null,
      requestContext: { siteId: SITE_ID, page: "main" }
    })
  )
  assert.equal(unauthenticated.status, 401)
  assert.deepEqual(calls, [])

  const spoofed = await actions.deletedGet(requestEvent({ siteId: SITE_ID + 1 }))
  assert.equal(spoofed.status, 403)
  assert.deepEqual(calls, [])
})
