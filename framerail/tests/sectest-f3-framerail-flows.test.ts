import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const siteHeaders = {
  "X-Wikijump-Site-Id": "17",
  "X-Wikijump-Site-Slug": "test"
}
const wellFormedToken = "A".repeat(48)
const loginPassword = "correct horse battery"

let previousWorkingDirectory: any
let vite: any
let client: any
let originalClientRequest: any
let views: any
let getSession: any
let loginLoad: any
let resetRoute: any
let deleteRoute: any
let verifyRoute: any

before(async () => {
  previousWorkingDirectory = process.cwd()
  process.chdir(root)
  vite = await createTestViteServer()

  ;({ client } = await vite.ssrLoadModule("/src/lib/server/deepwell/index.ts"))
  originalClientRequest = client.request
  views = await vite.ssrLoadModule("/src/lib/server/deepwell/views.ts")
  getSession = await vite.ssrLoadModule("/src/lib/server/auth/get-session.ts")
  loginLoad = await vite.ssrLoadModule("/src/lib/server/load/login.ts")
  resetRoute = await vite.ssrLoadModule(
    "/src/routes/[x+2d]/reset/[token]/+page.server.ts"
  )
  deleteRoute = await vite.ssrLoadModule(
    "/src/routes/[x+2d]/delete-account/[token]/+page.server.ts"
  )
  verifyRoute = await vite.ssrLoadModule(
    "/src/routes/[x+2d]/verify-email/[token]/+page.server.ts"
  )
})

after(async () => {
  if (client && originalClientRequest) client.request = originalClientRequest
  if (vite) await vite.close()
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
})

const invalidSessionError = () => ({
  code: 3001,
  message: "Invalid session token, cannot be used for authentication"
})

function fakeCookies(cookieValue: string | undefined) {
  const setCalls: any[] = []
  const deleteCalls: any[] = []
  return {
    setCalls,
    deleteCalls,
    get: () => cookieValue,
    set: (...args: any[]) => setCalls.push(args),
    delete: (...args: any[]) => deleteCalls.push(args)
  }
}

function postRequest(url: string, fields: Record<string, string>) {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...siteHeaders },
    body: new URLSearchParams(fields)
  })
}

test("SEC-02: article view retries anonymously when the session token is invalid", async () => {
  const calls: any[] = []
  client.request = async (method: string, params: any) => {
    calls.push([method, params])
    if (method !== "article_view") throw new Error(`unexpected method ${method}`)
    if (params.session_token === "bogus-token") throw invalidSessionError()
    return { resolvedSession: params.session_token ?? null }
  }

  const result = await views.articleView(17, ["en"], null, "bogus-token")
  assert.equal(result.resolvedSession, null)
  assert.equal(calls.length, 2)
  assert.equal(calls[1][1].session_token, undefined)
})

test("SEC-02: a valid session token is used as-is, other errors are not retried", async () => {
  const calls: any[] = []
  client.request = async (method: string, params: any) => {
    calls.push([method, params])
    if (params.session_token === "valid-token") return { resolvedSession: "valid-token" }
    throw { code: 5000, message: "unrelated failure" }
  }

  const result = await views.articleView(17, ["en"], null, "valid-token")
  assert.equal(result.resolvedSession, "valid-token")
  assert.equal(calls.length, 1)

  await assert.rejects(
    () => views.articleView(17, ["en"], null, "other-token"),
    (error: any) => error.code === 5000
  )
  assert.equal(calls.length, 2)
})

test("SEC-02: cookie session resolution maps bogus and revoked tokens to anonymous", async () => {
  const sessionGetCalls: any[] = []
  client.request = async (method: string, params: any) => {
    assert.equal(method, "session_get")
    sessionGetCalls.push(params[0])
    if (params[0] === "valid-token") {
      return { user_id: 7, expires_at: "2030-01-01T00:00:00Z" }
    }
    throw invalidSessionError()
  }

  const url = "https://scp-wiki.wikijump.localhost/scp-001"

  const bogusCookies = fakeCookies("bogus-token")
  assert.equal(await getSession.resolveCookieSessionToken(bogusCookies, url), undefined)
  assert.ok(bogusCookies.deleteCalls.length >= 1)

  const revokedCookies = fakeCookies("revoked-token")
  assert.equal(await getSession.resolveCookieSessionToken(revokedCookies, url), undefined)
  assert.ok(revokedCookies.deleteCalls.length >= 1)

  const validCookies = fakeCookies("valid-token")
  assert.equal(
    await getSession.resolveCookieSessionToken(validCookies, url),
    "valid-token"
  )
  assert.equal(validCookies.deleteCalls.length, 0)

  const absentCookies = fakeCookies(undefined)
  assert.equal(await getSession.resolveCookieSessionToken(absentCookies, url), undefined)
  assert.deepEqual(sessionGetCalls, ["bogus-token", "revoked-token", "valid-token"])
})

test("SEC-17: reset and delete-account routes expose named actions only", () => {
  assert.deepEqual(Object.keys(resetRoute.actions).sort(), ["redeem", "setPassword"])
  assert.deepEqual(Object.keys(deleteRoute.actions).sort(), ["confirm", "redeem"])
  assert.deepEqual(Object.keys(verifyRoute.actions), ["default"])
})

test("SEC-17: the reset redeem action executes and returns the grant", async () => {
  client.request = async (method: string) => {
    if (method === "password_reset_redeem") return { grant: "grant-reset" }
    throw new Error(`unexpected method ${method}`)
  }

  const result = await resetRoute.actions.redeem({
    request: postRequest("https://test.wikijump.localhost/-/reset/token", {
      token: wellFormedToken
    }),
    getClientAddress: () => "127.0.0.1"
  })
  assert.equal(result.grant, "grant-reset")
})

test("SEC-17: the delete-account redeem action executes and returns the grant", async () => {
  client.request = async (method: string) => {
    if (method === "session_get") return { user_id: 7 }
    if (method === "account_delete_redeem") return { grant: "grant-delete" }
    throw new Error(`unexpected method ${method}`)
  }

  const result = await deleteRoute.actions.redeem({
    request: postRequest("https://test.wikijump.localhost/-/delete-account/token", {
      token: wellFormedToken
    }),
    cookies: fakeCookies("valid-token"),
    getClientAddress: () => "127.0.0.1",
    locals: {}
  })
  assert.equal(result.grant, "grant-delete")
})

test("SEC-17: the verify-email default action still executes", async () => {
  client.request = async (method: string) => {
    if (method === "email_verify_redeem") return null
    throw new Error(`unexpected method ${method}`)
  }

  const result = await verifyRoute.actions.default({
    request: postRequest("https://test.wikijump.localhost/-/verify-email/token", {
      token: wellFormedToken
    }),
    getClientAddress: () => "127.0.0.1"
  })
  assert.equal(result.verified, true)
})

const unverifiedRegular = { user_type: "regular", email_verified_at: null }
const verifiedRegular = {
  user_type: "regular",
  email_verified_at: "2026-01-01T00:00:00Z"
}
const wikidotUser = { user_type: "wikidot" }

function stubLogin({ user, needsMfa = false }: { user: any; needsMfa?: boolean }) {
  const logoutCalls: any[] = []
  client.request = async (method: string, params: any) => {
    switch (method) {
      case "login":
        return { session_token: "login-token", needs_mfa: needsMfa }
      case "mfa_verify":
        return "mfa-token"
      case "user_view":
        return { type: "user_found", data: { user } }
      case "session_get":
        return { user_id: 7, expires_at: "2030-01-01T00:00:00Z" }
      case "logout":
        logoutCalls.push(params)
        return null
      default:
        throw new Error(`unexpected method ${method}`)
    }
  }
  return logoutCalls
}

function loginEvent(fields: Record<string, string>, cookies: any) {
  return {
    request: postRequest("https://test.wikijump.localhost/-/login", fields),
    getClientAddress: () => "127.0.0.1",
    cookies
  }
}

const passwordFields = { nameOrEmail: "sectest_user", password: loginPassword }

test("SEC-04: password login is refused for an unverified native account", async () => {
  const logoutCalls = stubLogin({ user: unverifiedRegular })
  const cookies = fakeCookies(undefined)

  const result = await loginLoad.loginAction(loginEvent(passwordFields, cookies))
  assert.equal(result.status, 403)
  assert.equal(result.data.emailVerificationRequired, true)
  assert.match(result.data.message, /not been verified/)
  assert.deepEqual(logoutCalls, [["login-token"]])
  assert.equal(cookies.setCalls.length, 0)
})

test("SEC-04: the refusal fires before an MFA challenge is handed out", async () => {
  const logoutCalls = stubLogin({ user: unverifiedRegular, needsMfa: true })
  const cookies = fakeCookies(undefined)

  const result = await loginLoad.loginAction(loginEvent(passwordFields, cookies))
  assert.equal(result.status, 403)
  assert.equal(result.data.emailVerificationRequired, true)
  assert.equal(result.data.session_token, undefined)
  assert.deepEqual(logoutCalls, [["login-token"]])
})

test("SEC-04: MFA completion is gated the same way", async () => {
  const logoutCalls = stubLogin({ user: unverifiedRegular })
  const cookies = fakeCookies(undefined)

  const result = await loginLoad.loginAction(
    loginEvent(
      { ...passwordFields, mfaSessionToken: "restricted-token", totpOrCode: "123456" },
      cookies
    )
  )
  assert.equal(result.status, 403)
  assert.equal(result.data.emailVerificationRequired, true)
  assert.deepEqual(logoutCalls, [["mfa-token"]])
  assert.equal(cookies.setCalls.length, 0)
})

test("SEC-04: verified native accounts and imported-variant users are not gated", async () => {
  stubLogin({ user: verifiedRegular })
  const verifiedCookies = fakeCookies(undefined)
  const verifiedResult = await loginLoad.loginAction(
    loginEvent(passwordFields, verifiedCookies)
  )
  assert.equal(verifiedResult.isLoggedIn, true)
  assert.equal(verifiedResult.needsMfa, false)
  assert.ok(verifiedCookies.setCalls.some(([name]: any[]) => name === "wikijump_token"))

  stubLogin({ user: wikidotUser })
  const wikidotCookies = fakeCookies(undefined)
  const wikidotResult = await loginLoad.loginAction(
    loginEvent(passwordFields, wikidotCookies)
  )
  assert.equal(wikidotResult.isLoggedIn, true)
  assert.ok(wikidotCookies.setCalls.some(([name]: any[]) => name === "wikijump_token"))
})
