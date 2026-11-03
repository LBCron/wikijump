import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { after, before, test } from "node:test"

import { pageActionEvent, startPageActionHarness } from "./page-action-test-harness.js"

const votePaneSourceUrl = new URL(
  "../src/routes/[slug]/[...extra]/VotePane.svelte",
  import.meta.url
)

const SITE_ID = 17
const SESSION_TOKEN = "vote-session"
const TRUSTED_CONTEXT = {
  siteId: SITE_ID,
  page: "main",
  sessionToken: SESSION_TOKEN
}

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

const installedSession = () => ({
  session_token: SESSION_TOKEN,
  user_id: 91,
  created_at: "2026-08-10T00:00:00Z",
  expires_at: "2026-08-11T00:00:00Z",
  ip_address: "192.0.2.91",
  user_agent: "page request context test",
  restricted: false
})

/** @param {any} action @param {any} [overrides] */
const requestEvent = (action, overrides = {}) =>
  pageActionEvent(
    /** @type {any} */ ({
      action,
      siteId: SITE_ID,
      sessionToken: SESSION_TOKEN,
      requestContext: { ...TRUSTED_CONTEXT },
      ...overrides
    })
  )

test("vote mutation actions forward the trusted route request context", async () => {
  /** @type {any[]} */
  const calls = []
  client.request =
    /** @param {any} method @param {any} params @param {any} context */ async (
      method,
      params,
      context
    ) => {
      calls.push({ method, params, context })
      if (method === "session_get") return installedSession()
      if (method === "vote_set") return { page_id: 42, value: 1, score: 1 }
      if (method === "vote_remove") return { page_id: 42, value: null, score: 0 }
      throw new Error(`Unexpected Deepwell method ${method}`)
    }

  const cast = await actions.voteCast(
    requestEvent("voteCast", { body: { pageId: 42, value: 1, siteId: 999 } })
  )
  assert.deepEqual(cast, { res: { page_id: 42, value: 1, score: 1 } })

  const cancel = await actions.voteCancel(
    requestEvent("voteCancel", { body: { pageId: 42, siteId: 999 } })
  )
  assert.deepEqual(cancel, { res: { page_id: 42, value: null, score: 0 } })

  assert.deepEqual(
    calls.map(({ method }) => method),
    ["session_get", "vote_set", "session_get", "vote_remove"]
  )
  assert.deepEqual(calls[1].params, { page_id: 42, value: 1 })
  assert.deepEqual(calls[3].params, { page_id: 42 })
  for (const mutation of [calls[1], calls[3]]) {
    assert.deepEqual(mutation.context, TRUSTED_CONTEXT)
  }

  calls.length = 0
  const spoofed = await actions.voteCast(
    requestEvent("voteCast", {
      body: { pageId: 42, value: 1 },
      siteId: SITE_ID + 1
    })
  )
  assert.equal(spoofed.status, 403)
  assert.deepEqual(calls, [])
})

test("page score actions use only trusted route context", async () => {
  /** @type {any[]} */
  const calls = []
  client.request =
    /** @param {any} method @param {any} params @param {any} context */ async (
      method,
      params,
      context
    ) => {
      calls.push({ method, params, context })
      if (method === "page_get_score") return { page_id: 42, score: 7 }
      throw new Error(`Unexpected Deepwell method ${method}`)
    }

  const result = await actions.score(requestEvent("score"))
  assert.deepEqual(result, { res: { page_id: 42, score: 7 } })
  assert.deepEqual(calls, [
    {
      method: "page_get_score",
      params: { site_id: SITE_ID, page: "main" },
      context: TRUSTED_CONTEXT
    }
  ])

  calls.length = 0
  const bodySelected = await actions.score(
    requestEvent("score", { body: { pageId: 1, siteId: 1, page: "attacker" } })
  )
  assert.deepEqual(bodySelected, { res: { page_id: 42, score: 7 } })
  assert.deepEqual(calls[0].params, { site_id: SITE_ID, page: "main" })

  calls.length = 0
  const spoofed = await actions.score(requestEvent("score", { siteId: SITE_ID + 1 }))
  assert.equal(spoofed.status, 403)
  assert.deepEqual(calls, [])
})

test("Wikidot WhoRated pane uses the exact AMC pageId contract", async () => {
  const source = await readFile(votePaneSourceUrl, "utf8")
  const start = source.indexOf("async function getWikidotWhoRated")
  const end = source.indexOf("\n  async function getVoteList", start)
  assert.notEqual(start, -1)
  assert.notEqual(end, -1)
  const body = source.slice(start, end)

  assert.match(body, /fetch\("\/ajax-module-connector\.php"/u)
  assert.match(body, /moduleName: "pagerate\/WhoRatedPageModule"/u)
  assert.match(body, /pageId: String\(pageId\)/u)
  assert.doesNotMatch(body, /siteId|userId|vote_id|page_vote_id/u)
})

test("legacy wiki actions derive the actor, client address, and revision binding from the trusted route", async () => {
  /** @type {any[]} */
  const calls = []
  client.request =
    /** @param {any} method @param {any} params @param {any} context */ async (
      method,
      params,
      context
    ) => {
      calls.push({ method, params, context })
      if (method === "session_get") return installedSession()
      if (method === "wikidot_legacy_rate") return { page_id: 42, score: 1 }
      if (method === "wikidot_legacy_set_tags") return { revision_id: 91 }
      throw new Error(`Unexpected Deepwell method ${method}`)
    }

  const actionFingerprint = "0123456789abcdef0123456789abcdef"
  const rate = await actions.legacyRate(
    requestEvent("legacyRate", {
      body: {
        pageId: 42,
        lastRevisionId: 90,
        actionIndex: 3,
        actionFingerprint,
        value: 99,
        siteId: 999
      }
    })
  )
  assert.deepEqual(rate, { res: { page_id: 42, score: 1 } })

  const setTags = await actions.legacySetTags(
    requestEvent("legacySetTags", {
      body: {
        pageId: 42,
        lastRevisionId: 90,
        actionIndex: 3,
        actionFingerprint,
        tags: ["forged"],
        alterations: ["+forged"]
      }
    })
  )
  assert.deepEqual(setTags, { res: { revision_id: 91 } })

  assert.deepEqual(
    calls.map(({ method }) => method),
    ["session_get", "wikidot_legacy_rate", "session_get", "wikidot_legacy_set_tags"]
  )
  assert.deepEqual(calls[1].params, {
    page_id: 42,
    last_revision_id: 90,
    action_index: 3,
    action_fingerprint: actionFingerprint
  })
  assert.deepEqual(calls[3].params, {
    page_id: 42,
    last_revision_id: 90,
    action_index: 3,
    action_fingerprint: actionFingerprint,
    user_id: 91,
    ip_address: "192.0.2.91"
  })
  for (const mutation of [calls[1], calls[3]]) {
    assert.deepEqual(mutation.context, TRUSTED_CONTEXT)
  }

  calls.length = 0
  const spoofed = await actions.legacyRate(
    requestEvent("legacyRate", {
      body: { pageId: 42, lastRevisionId: 90, actionIndex: 3, actionFingerprint },
      siteId: SITE_ID + 1
    })
  )
  assert.equal(spoofed.status, 403)
  assert.deepEqual(calls, [])
})
