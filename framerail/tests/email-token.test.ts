import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { after, before, describe, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.ts"
import {
  EMAIL_TOKEN_LENGTH,
  isEmailTokenWellFormed,
  normalizeLookupEmail
} from "../src/lib/server/load/email-token-validation.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const siteHeaders = {
  "X-Wikijump-Site-Id": "17",
  "X-Wikijump-Site-Slug": "test"
}
const parentData = {
  locales: ["en-US", "en"],
  license_name: "CC BY-SA 4.0",
  license_url: "https://creativecommons.org/licenses/by-sa/4.0/",
  user_session: null
}

const WELL_FORMED = "a".repeat(EMAIL_TOKEN_LENGTH)

const pageRequest = (path: any) =>
  new Request(`https://wikijump.test${path}`, { headers: siteHeaders })

const postRequest = (path: any, fields: Record<string, string>) => {
  const formData = new FormData()
  for (const [name, value] of Object.entries(fields)) formData.set(name, value)
  return new Request(`https://wikijump.test${path}`, {
    method: "POST",
    headers: siteHeaders,
    body: formData
  })
}

const actionEvent = (request: any) => ({
  request,
  getClientAddress: () => "192.0.2.77"
})

describe("email-token validation contract", () => {
  test("lookup trims surrounding whitespace and nothing else", () => {
    assert.equal(normalizeLookupEmail("  user@example.test\t\n"), "user@example.test")
    assert.equal(normalizeLookupEmail("user@example.test"), "user@example.test")
    assert.equal(normalizeLookupEmail("  USER@EXAMPLE.TEST  "), "USER@EXAMPLE.TEST")
    assert.equal(normalizeLookupEmail(""), "")
    assert.equal(normalizeLookupEmail(null), "")
  })

  test("well-formed means 48 URL-safe alphanumerics", () => {
    assert.equal(EMAIL_TOKEN_LENGTH, 48)
    assert.equal(isEmailTokenWellFormed(WELL_FORMED), true)
    assert.equal(isEmailTokenWellFormed("aB3x".repeat(12)), true)
    assert.equal(isEmailTokenWellFormed("a".repeat(47)), false)
    assert.equal(isEmailTokenWellFormed("a".repeat(49)), false)
    assert.equal(isEmailTokenWellFormed(""), false)
    assert.equal(isEmailTokenWellFormed(`${"a".repeat(47)}-`), false)
    assert.equal(isEmailTokenWellFormed(`${"a".repeat(47)} `), false)
    assert.equal(isEmailTokenWellFormed(null), false)
    assert.equal(isEmailTokenWellFormed(undefined), false)
  })
})

describe("email-token routes", () => {
  let previousWorkingDirectory: any
  let vite: any
  let client: any
  let originalClientRequest: any
  let routes: any
  let calls: any[]

  before(async () => {
    previousWorkingDirectory = process.cwd()
    process.chdir(root)
    vite = await createTestViteServer()

    ;({ client } = await vite.ssrLoadModule("/src/lib/server/deepwell/index.ts"))
    originalClientRequest = client.request
    calls = []
    client.request = async (method: any, params: any, context: any) => {
      calls.push({ method, params, context })
      if (method === "translate") return {}
      if (method === "session_get") {
        return { user_id: 7, session_token: "delete-session" }
      }
      if (
        method === "password_reset_issue" ||
        method === "email_verify_issue" ||
        method === "email_verify_redeem" ||
        method === "account_delete_issue"
      ) {
        return undefined
      }
      if (method === "password_reset_redeem") return { grant: "grant-token" }
      if (method === "password_reset_complete") return { sessions_revoked: 3 }
      if (method === "account_delete_redeem") return { grant: "delete-grant" }
      if (method === "account_delete_complete") return { sessions_revoked: 2 }
      throw new Error(`Unexpected Deepwell method ${method}`)
    }

    routes = {
      forgot: await vite.ssrLoadModule("/src/routes/[x+2d]/forgot/+page.server.ts"),
      verify: await vite.ssrLoadModule("/src/routes/[x+2d]/verify-email/+page.server.ts"),
      verifyToken: await vite.ssrLoadModule(
        "/src/routes/[x+2d]/verify-email/[token]/+page.server.ts"
      ),
      reset: await vite.ssrLoadModule("/src/routes/[x+2d]/reset/[token]/+page.server.ts"),
      deleteAccount: await vite.ssrLoadModule(
        "/src/routes/[x+2d]/delete-account/+page.server.ts"
      ),
      deleteToken: await vite.ssrLoadModule(
        "/src/routes/[x+2d]/delete-account/[token]/+page.server.ts"
      )
    }
  })

  after(async () => {
    if (client && originalClientRequest) client.request = originalClientRequest
    if (vite) await vite.close()
    if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
  })

  test("forgot load requests the recovery copy keys", async () => {
    calls.length = 0
    const data = await routes.forgot.load({
      request: pageRequest("/-/forgot"),
      parent: async () => parentData
    })
    assert.equal(data.sent, false)
    assert.equal(data.forgotForm.valid, false)
    const translateCall = calls.find(({ method }) => method === "translate")
    const messages = translateCall.params.messages
    for (const key of [
      "password-recovery",
      "password-recovery.email-sent",
      "email",
      "send"
    ]) {
      assert.ok(key in messages, `forgot page requests ${key}`)
    }
  })

  test("forgot issue trims the address and always reports success", async () => {
    calls.length = 0
    const result = await routes.forgot.actions.default(
      actionEvent(postRequest("/-/forgot", { email: "  user@example.test " }))
    )
    assert.equal(result.sent, true)
    const issue = calls.find(({ method }) => method === "password_reset_issue")
    assert.deepEqual(issue.params, {
      email: "user@example.test",
      ip_address: "192.0.2.77"
    })
    assert.ok(!("session" in issue.params || "user_id" in issue.params))
  })

  test("verify resend page requests the verification copy keys", async () => {
    calls.length = 0
    const data = await routes.verify.load({
      request: pageRequest("/-/verify-email"),
      parent: async () => parentData
    })
    assert.equal(data.sent, false)
    const translateCall = calls.find(({ method }) => method === "translate")
    const messages = translateCall.params.messages
    for (const key of [
      "wiki-auth-verify-email",
      "wiki-auth-verify-email.intro",
      "wiki-auth-verify-email.email-sent",
      "wiki-auth-verify-email.resend-email"
    ]) {
      assert.ok(key in messages, `verify page requests ${key}`)
    }
  })

  test("verify issue uses the verify RPC, never the reset RPC", async () => {
    calls.length = 0
    const result = await routes.verify.actions.default(
      actionEvent(postRequest("/-/verify-email", { email: "user@example.test" }))
    )
    assert.equal(result.sent, true)
    assert.ok(calls.some(({ method }) => method === "email_verify_issue"))
    assert.ok(!calls.some(({ method }) => method === "password_reset_issue"))
  })

  test("verify link load pre-fills the token form without calling Deepwell", async () => {
    calls.length = 0
    const data = await routes.verifyToken.load({
      request: pageRequest(`/-/verify-email/${WELL_FORMED}`),
      parent: async () => parentData,
      params: { token: WELL_FORMED }
    })
    assert.equal(data.verified, false)
    assert.equal(data.verifyTokenForm.data.token, WELL_FORMED)
    assert.ok(!calls.some(({ method }) => method !== "translate"))
    const translateCall = calls.find(({ method }) => method === "translate")
    const messages = translateCall.params.messages
    for (const key of [
      "wiki-auth-verify-email-link.waiting",
      "wiki-auth-verify-email-link.please-interact",
      "wiki-auth-verify-email-link.instructions",
      "wiki-auth-verify-email-link.success"
    ]) {
      assert.ok(key in messages, `verify link page requests ${key}`)
    }
  })

  test("verify redemption POSTs the token; malformed tokens never reach Deepwell", async () => {
    calls.length = 0
    const result = await routes.verifyToken.actions.default(
      actionEvent(postRequest(`/-/verify-email/${WELL_FORMED}`, { token: WELL_FORMED }))
    )
    assert.equal(result.verified, true)
    const redeem = calls.find(({ method }) => method === "email_verify_redeem")
    assert.deepEqual(redeem.params, {
      token: WELL_FORMED,
      ip_address: "192.0.2.77"
    })

    calls.length = 0
    const malformed = await routes.verifyToken.actions.default(
      actionEvent(postRequest("/-/verify-email/nope", { token: "nope" }))
    )
    assert.equal(malformed.status, 400)
    assert.ok(!calls.some(({ method }) => method === "email_verify_redeem"))
  })

  test("reset page exchanges the link for a grant only on POST", async () => {
    calls.length = 0
    const data = await routes.reset.load({
      request: pageRequest(`/-/reset/${WELL_FORMED}`),
      parent: async () => parentData,
      params: { token: WELL_FORMED }
    })
    assert.equal(data.grant, null)
    assert.equal(data.tokenForm.data.token, WELL_FORMED)
    assert.ok(!calls.some(({ method }) => method === "password_reset_redeem"))

    const redeemed = await routes.reset.actions.default(
      actionEvent(postRequest(`/-/reset/${WELL_FORMED}`, { token: WELL_FORMED }))
    )
    assert.equal(redeemed.grant, "grant-token")

    calls.length = 0
    const malformed = await routes.reset.actions.default(
      actionEvent(postRequest("/-/reset/nope", { token: "nope" }))
    )
    assert.equal(malformed.status, 400)
    assert.ok(!calls.some(({ method }) => method === "password_reset_redeem"))
  })

  test("reset completion sets the password, clears it, and reports revocation", async () => {
    calls.length = 0
    const grant = "b".repeat(EMAIL_TOKEN_LENGTH)
    const result = await routes.reset.actions.setPassword(
      actionEvent(
        postRequest(`/-/reset/${WELL_FORMED}?/setPassword`, {
          grant,
          password: "new-fixture-password",
          confirmPassword: "new-fixture-password"
        })
      )
    )
    assert.equal(result.done, true)
    assert.equal(result.sessions_revoked, 3)
    assert.equal(result.form.data.password, "")
    assert.equal(result.form.data.confirmPassword, "")
    const complete = calls.find(({ method }) => method === "password_reset_complete")
    assert.deepEqual(complete.params, {
      grant,
      new_password: "new-fixture-password",
      ip_address: "192.0.2.77"
    })
    assert.ok(!("password" in complete.params || "confirmPassword" in complete.params))

    const mismatch = await routes.reset.actions.setPassword(
      actionEvent(
        postRequest(`/-/reset/${WELL_FORMED}?/setPassword`, {
          grant,
          password: "new-fixture-password",
          confirmPassword: "different-password"
        })
      )
    )
    assert.equal(mismatch.status, 400)
  })

  test("login page links to the recovery flow", async () => {
    const template = await readFile(
      new URL("../src/routes/[x+2d]/login/+page.svelte", import.meta.url),
      "utf8"
    )
    assert.match(template, /"\/-\/forgot"/u)
    assert.match(template, /forgot-password\.question/u)
  })

  test("recovery issues resolve the address to real accounts only", async () => {
    const endpoints = await readFile(
      new URL("../../deepwell/src/endpoints/email.rs", import.meta.url),
      "utf8"
    )
    assert.match(endpoints, /get_real_optional_by_email/u)
    assert.doesNotMatch(endpoints, /get_optional_by_email|import_wikidot/u)
  })

  test("delete start page needs a session, then requests the copy keys", async () => {
    await assert.rejects(
      routes.deleteAccount.load({
        request: pageRequest("/-/delete-account"),
        parent: async () => parentData
      }),
      (error: any) => error?.status === 303 && error?.location === "/-/login"
    )

    calls.length = 0
    const signedIn = {
      ...parentData,
      user_session: { user: { user_id: 7 } }
    }
    const data = await routes.deleteAccount.load({
      request: pageRequest("/-/delete-account"),
      parent: async () => signedIn
    })
    assert.equal(data.sent, false)
    const translateCall = calls.find(({ method }) => method === "translate")
    const messages = translateCall.params.messages
    for (const key of ["password", "confirm-password", "login", "send", "email"]) {
      assert.ok(key in messages, `delete page requests ${key}`)
    }
  })

  test("delete issue binds the session actor and sends no identity", async () => {
    const sessionEvent = (request: any) => ({
      request,
      cookies: {
        get: (name: any) => (name === "wikijump_token" ? "delete-session" : undefined)
      },
      getClientAddress: () => "192.0.2.77",
      locals: { requestContext: { sessionToken: "delete-session" } }
    })

    calls.length = 0
    const noCookie = await routes.deleteAccount.actions.default({
      request: postRequest("/-/delete-account", {}),
      cookies: { get: () => undefined },
      getClientAddress: () => "192.0.2.77",
      locals: {}
    })
    assert.equal(noCookie.status, 401)
    assert.ok(!calls.some(({ method }) => method === "account_delete_issue"))

    const result = await routes.deleteAccount.actions.default(
      sessionEvent(postRequest("/-/delete-account", {}))
    )
    assert.equal(result.sent, true)
    const issue = calls.find(({ method }) => method === "account_delete_issue")
    assert.deepEqual(issue.params, { ip_address: "192.0.2.77" })
    assert.ok(!("email" in issue.params || "user_id" in issue.params))
    assert.equal(issue.context.sessionToken, "delete-session")
  })

  test("delete link load pre-fills the token form without calling Deepwell", async () => {
    calls.length = 0
    const data = await routes.deleteToken.load({
      request: pageRequest(`/-/delete-account/${WELL_FORMED}`),
      parent: async () => parentData,
      params: { token: WELL_FORMED }
    })
    assert.equal(data.grant, null)
    assert.equal(data.done, false)
    assert.equal(data.tokenForm.data.token, WELL_FORMED)
    assert.ok(!calls.some(({ method }) => method === "account_delete_redeem"))
  })

  test("delete redemption exchanges the link for a grant only on POST", async () => {
    const sessionEvent = (request: any) => ({
      request,
      cookies: {
        get: (name: any) => (name === "wikijump_token" ? "delete-session" : undefined)
      },
      getClientAddress: () => "192.0.2.77",
      locals: { requestContext: { sessionToken: "delete-session" } }
    })

    calls.length = 0
    const redeemed = await routes.deleteToken.actions.default(
      sessionEvent(
        postRequest(`/-/delete-account/${WELL_FORMED}`, { token: WELL_FORMED })
      )
    )
    assert.equal(redeemed.grant, "delete-grant")
    const redeem = calls.find(({ method }) => method === "account_delete_redeem")
    assert.deepEqual(redeem.params, {
      token: WELL_FORMED,
      ip_address: "192.0.2.77"
    })

    calls.length = 0
    const malformed = await routes.deleteToken.actions.default(
      sessionEvent(postRequest("/-/delete-account/nope", { token: "nope" }))
    )
    assert.equal(malformed.status, 400)
    assert.ok(!calls.some(({ method }) => method === "account_delete_redeem"))

    calls.length = 0
    const unsigned = await routes.deleteToken.actions.default({
      request: postRequest(`/-/delete-account/${WELL_FORMED}`, { token: WELL_FORMED }),
      cookies: { get: () => undefined },
      getClientAddress: () => "192.0.2.77",
      locals: {}
    })
    assert.equal(unsigned.status, 401)
    assert.ok(!calls.some(({ method }) => method === "account_delete_redeem"))
  })

  test("delete completion deletes on grant plus password and clears both", async () => {
    const sessionEvent = (request: any) => ({
      request,
      cookies: {
        get: (name: any) => (name === "wikijump_token" ? "delete-session" : undefined)
      },
      getClientAddress: () => "192.0.2.77",
      locals: { requestContext: { sessionToken: "delete-session" } }
    })
    const grant = "b".repeat(EMAIL_TOKEN_LENGTH)

    calls.length = 0
    const result = await routes.deleteToken.actions.confirm(
      sessionEvent(
        postRequest(`/-/delete-account/${WELL_FORMED}?/confirm`, {
          grant,
          password: "current-fixture-password",
          confirmPassword: "current-fixture-password"
        })
      )
    )
    assert.equal(result.done, true)
    assert.equal(result.sessions_revoked, 2)
    assert.equal(result.form.data.password, "")
    assert.equal(result.form.data.confirmPassword, "")
    const complete = calls.find(({ method }) => method === "account_delete_complete")
    assert.deepEqual(complete.params, {
      grant,
      password: "current-fixture-password",
      ip_address: "192.0.2.77"
    })
    assert.ok(!("confirmPassword" in complete.params))

    const mismatch = await routes.deleteToken.actions.confirm(
      sessionEvent(
        postRequest(`/-/delete-account/${WELL_FORMED}?/confirm`, {
          grant,
          password: "current-fixture-password",
          confirmPassword: "different-password"
        })
      )
    )
    assert.equal(mismatch.status, 400)
  })
})
