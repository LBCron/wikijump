import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.js"

const root = fileURLToPath(new URL("..", import.meta.url))
const clientAddress = "192.0.2.91"

/** @type {any} */
let previousWorkingDirectory
/** @type {any} */
let vite
/** @type {any} */
let client
/** @type {any} */
let originalClientRequest
/** @type {any} */
let rootActions
/** @type {any} */
let slugActions

before(async () => {
  previousWorkingDirectory = process.cwd()
  process.chdir(root)
  vite = await createTestViteServer()

  ;({ client } = await vite.ssrLoadModule("/src/lib/server/deepwell/index.ts"))
  originalClientRequest = client.request
  ;({ actions: rootActions } = await vite.ssrLoadModule("/src/routes/+page.server.ts"))
  ;({ actions: slugActions } = await vite.ssrLoadModule(
    "/src/routes/[slug]/[...extra]/+page.server.ts"
  ))
})

after(async () => {
  if (client && originalClientRequest) client.request = originalClientRequest
  if (vite) await vite.close()
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
})

const membershipEvent = () => ({
  request: new Request("https://wikijump.test/?/membershipJoin", {
    method: "POST",
    body: JSON.stringify({
      pageId: 42,
      lastRevisionId: 90,
      actionIndex: 3,
      actionFingerprint: "0123456789abcdef0123456789abcdef"
    }),
    headers: {
      "content-type": "application/json",
      "X-Wikijump-Site-Id": "17",
      "X-Wikijump-Site-Slug": "test"
    }
  }),
  getClientAddress: () => clientAddress,
  params: { slug: "main" },
  cookies: { get: () => "membership-session" },
  locals: {
    requestContext: {
      siteId: 17,
      page: "main",
      sessionToken: "membership-session"
    }
  }
})

/** @param {any} action @param {any} body @param {any} [sessionToken] @param {any} [extra] */
const typedMembershipEvent = (
  action,
  body,
  sessionToken = "membership-session",
  extra = undefined
) => ({
  request: new Request(`https://wikijump.test/?/${action}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      "X-Wikijump-Site-Id": "17",
      "X-Wikijump-Site-Slug": "test"
    }
  }),
  getClientAddress: () => clientAddress,
  params: { slug: "main", extra },
  cookies: { get: () => sessionToken },
  locals: {
    requestContext: {
      siteId: 17,
      page: "main",
      sessionToken
    }
  }
})

test("root and slug page routes bind actor-verified membership Join", async () => {
  /** @type {any[]} */
  const calls = []
  client.request = /** @param {any} method @param {any} params @param {any} context */ async (method, params, context) => {
    calls.push({ method, params, context })
    if (method === "session_get") {
      return {
        session_token: "membership-session",
        user_id: 91,
        created_at: "2026-08-10T00:00:00Z",
        expires_at: "2026-08-11T00:00:00Z",
        ip_address: "192.0.2.91",
        user_agent: "membership route test",
        restricted: false
      }
    }
    if (method === "membership_join") return "joined"
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  for (const actions of [rootActions, slugActions]) {
    assert.equal(typeof actions.membershipJoin, "function")
    assert.deepEqual(await actions.membershipJoin(membershipEvent()), { res: "joined" })
  }

  assert.deepEqual(
    calls,
    [rootActions, slugActions].flatMap(() => [
      {
        method: "session_get",
        params: ["membership-session"],
        context: undefined
      },
      {
        method: "membership_join",
        params: {
          page_id: 42,
          last_revision_id: 90,
          action_index: 3,
          action_fingerprint: "0123456789abcdef0123456789abcdef",
          ip_address: clientAddress
        },
        context: {
          siteId: 17,
          page: "main",
          sessionToken: "membership-session"
        }
      }
    ])
  )
})

test("malformed and unauthenticated membership Join requests fail without mutation", async () => {
  /** @type {any[]} */
  const calls = []
  client.request = /** @param {any} method @param {any} params @param {any} context */ async (method, params, context) => {
    calls.push({ method, params, context })
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  /** @param {any} body @param {any} [sessionToken] */
  const joinEvent = (body, sessionToken = "membership-session") => ({
    request: new Request("https://wikijump.test/?/membershipJoin", {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        "content-type": "application/json",
        "X-Wikijump-Site-Id": "17",
        "X-Wikijump-Site-Slug": "test"
      }
    }),
    params: { slug: "main" },
    cookies: { get: () => sessionToken },
    locals: {
      requestContext: {
        siteId: 17,
        page: "main",
        sessionToken
      }
    }
  })

  const fingerprint = "0123456789abcdef0123456789abcdef"
  for (const body of [
    { pageId: 42, lastRevisionId: 90, actionIndex: -1, actionFingerprint: fingerprint },
    { pageId: 42, lastRevisionId: 90, actionIndex: 3 },
    { pageId: 42, lastRevisionId: 90, actionIndex: 1.5, actionFingerprint: fingerprint }
  ]) {
    const result = await rootActions.membershipJoin(joinEvent(body))
    assert.equal(result.status, 400)
  }

  const missingSession = await rootActions.membershipJoin(
    joinEvent(
      { pageId: 42, lastRevisionId: 90, actionIndex: 3, actionFingerprint: fingerprint },
      null
    )
  )
  assert.equal(missingSession.status, 401)

  assert.deepEqual(
    calls.filter(({ method }) => method === "membership_join"),
    [],
    "validation failures must not reach the mutation endpoint"
  )
})

test("application and password actions preserve actor-bound page context", async () => {
  /** @type {any[]} */
  const calls = []
  client.request = /** @param {any} method @param {any} params @param {any} context */ async (method, params, context) => {
    calls.push({ method, params, context })
    if (method === "session_get") {
      return {
        session_token: "membership-session",
        user_id: 91,
        created_at: "2026-08-10T00:00:00Z",
        expires_at: "2026-08-11T00:00:00Z",
        ip_address: "192.0.2.91",
        user_agent: "membership route test",
        restricted: false
      }
    }
    if (method === "membership_application_submit") return "submitted"
    if (method === "membership_password_submit") return "wrong_password"
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const fingerprint = "0123456789abcdef0123456789abcdef"
  for (const actions of [rootActions, slugActions]) {
    assert.equal(typeof actions.membershipApplication, "function")
    assert.equal(typeof actions.membershipPassword, "function")
    assert.deepEqual(
      await actions.membershipApplication(
        typedMembershipEvent("membershipApplication", {
          pageId: 42,
          lastRevisionId: 90,
          actionIndex: 1,
          actionFingerprint: fingerprint,
          comment: "application text"
        })
      ),
      { res: "submitted" }
    )
    assert.deepEqual(
      await actions.membershipPassword(
        typedMembershipEvent("membershipPassword", {
          pageId: 42,
          lastRevisionId: 90,
          actionIndex: 2,
          actionFingerprint: fingerprint,
          password: "wrong password"
        })
      ),
      { res: "wrong_password" }
    )
  }

  assert.equal(
    calls.filter(({ method }) => method === "membership_application_submit").length,
    2
  )
  assert.equal(
    calls.filter(({ method }) => method === "membership_password_submit").length,
    2
  )
  for (const call of calls.filter(({ method }) => method.startsWith("membership_"))) {
    assert.deepEqual(call.context, {
      siteId: 17,
      page: "main",
      sessionToken: "membership-session"
    })
  }
})

test("malformed application and password action bodies fail before Deepwell mutation", async () => {
  /** @type {any[]} */
  const calls = []
  client.request = /** @param {any} method @param {any} params @param {any} context */ async (method, params, context) => {
    calls.push({ method, params, context })
    throw new Error(`Unexpected Deepwell method ${method}`)
  }
  const fingerprint = "0123456789abcdef0123456789abcdef"
  /** @type {any[]} */
  const invalid = [
    [
      "membershipApplication",
      { pageId: 42, lastRevisionId: 90, actionIndex: 1, actionFingerprint: fingerprint }
    ],
    [
      "membershipPassword",
      { pageId: 42, lastRevisionId: 90, actionIndex: 2, actionFingerprint: fingerprint }
    ]
  ]
  for (const [action, body] of invalid) {
    const result = await rootActions[action](typedMembershipEvent(action, body))
    assert.equal(result.status, 400)
  }
  assert.deepEqual(
    calls.filter(({ method }) =>
      ["membership_application_submit", "membership_password_submit"].includes(method)
    ),
    []
  )
})

test("email invitation action derives the opaque hash from the trusted route, not the request body", async () => {
  /** @type {any[]} */
  const calls = []
  client.request = /** @param {any} method @param {any} params @param {any} context */ async (method, params, context) => {
    calls.push({ method, params, context })
    if (method === "session_get") return { user_id: 91 }
    if (method === "membership_email_invitation_accept") {
      return params.hash === ""
        ? { status: "unavailable" }
        : { status: "accepted", site_name: "Test Wiki", site_slug: "test" }
    }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }
  const fingerprint = "0123456789abcdef0123456789abcdef"
  const body = {
    pageId: 42,
    lastRevisionId: 90,
    actionIndex: 3,
    actionFingerprint: fingerprint,
    hash: "forged-body-hash"
  }

  const result = await slugActions.membershipEmailInvitation(
    typedMembershipEvent(
      "membershipEmailInvitation",
      body,
      "membership-session",
      "/hash/route-authority-hash"
    )
  )
  assert.deepEqual(result, {
    res: { status: "accepted", site_name: "Test Wiki", site_slug: "test" }
  })
  const mutation = calls.find(
    ({ method }) => method === "membership_email_invitation_accept"
  )
  assert.deepEqual(mutation.params, {
    page_id: 42,
    last_revision_id: 90,
    action_index: 3,
    action_fingerprint: fingerprint,
    hash: "route-authority-hash",
    ip_address: clientAddress
  })
  assert.equal(JSON.stringify(mutation.params).includes("forged-body-hash"), false)
  assert.deepEqual(mutation.context, {
    siteId: 17,
    page: "main",
    sessionToken: "membership-session"
  })

  calls.length = 0
  const rootResult = await rootActions.membershipEmailInvitation(
    typedMembershipEvent("membershipEmailInvitation", body)
  )
  assert.deepEqual(rootResult, { res: { status: "unavailable" } })
  const rootMutation = calls.find(
    ({ method }) => method === "membership_email_invitation_accept"
  )
  assert.equal(rootMutation.params.hash, "")
  assert.equal(JSON.stringify(rootMutation.params).includes("forged-body-hash"), false)
})
