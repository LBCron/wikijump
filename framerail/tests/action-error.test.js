import { strict as assert } from "node:assert"
import test from "node:test"
import { number, object } from "valibot"

import {
  failForActionError,
  failForMissingSession,
  MissingActionSessionError,
  normalizeActionError,
  PageActionContextMismatchError,
  requireActionSession,
  readActionJson
} from "../src/lib/server/load/action-error.ts"
import { redactAuthActionPayload } from "../src/lib/server/load/auth-form-redaction.js"

test("action errors preserve validated public Deepwell details", () => {
  assert.deepEqual(
    normalizeActionError({
      message: "Permission denied",
      code: 3106,
      data: { resource: "page", allowed: false }
    }),
    {
      message: "Permission denied",
      code: 3106,
      data: { resource: "page", allowed: false }
    }
  )
})

test("action errors safely normalize arbitrary thrown values", () => {
  assert.deepEqual(normalizeActionError("network failed"), {
    message: "network failed"
  })
  assert.deepEqual(normalizeActionError({ code: "not-numeric", data: undefined }), {
    message: "An unexpected server error occurred."
  })
})

test("action failures classify permission errors and honor fallback statuses", () => {
  const denied = failForActionError({ message: "Permission denied", code: 3106 })
  assert.equal(denied.status, 403)
  assert.deepEqual(denied.data, {
    message: "Permission denied",
    code: 3106
  })

  const unavailable = failForActionError(new Error("Backend unavailable"), {}, 502)
  assert.equal(unavailable.status, 502)
  assert.deepEqual(unavailable.data, {
    message: "Backend unavailable"
  })
})

test("invalid authentication failures are client errors, not server errors", () => {
  const failure = failForActionError(
    { message: "Invalid username, password, or TOTP code", code: 3000 },
    { form: "preserved" },
    500
  )
  assert.equal(failure.status, 401)
  assert.deepEqual(failure.data, {
    form: "preserved",
    message: "Invalid username, password, or TOTP code",
    code: 3000
  })
})

test("action failures sanitize the final merged payload", () => {
  const password = "correct horse battery staple"
  const failure = failForActionError(
    {
      message: `Backend echoed ${password}`,
      code: 4001,
      data: { nested: [{ submitted: password }] }
    },
    {
      form: { data: { password } },
      diagnostic: `Form contained ${password}`
    },
    500,
    (payload) => redactAuthActionPayload(payload, [password])
  )

  assert.equal(failure.status, 500)
  assert.deepEqual(failure.data, {
    form: { data: { password: "" } },
    diagnostic: "Form contained ",
    message: "Backend echoed ",
    code: 4001,
    data: { nested: [{ submitted: "" }] }
  })
  assert.doesNotMatch(JSON.stringify(failure.data), new RegExp(password))
})

test("missing sessions remain an explicit authentication failure", () => {
  const failure = failForMissingSession({ form: "preserved" })
  assert.equal(failure.status, 401)
  assert.deepEqual(failure.data, {
    form: "preserved",
    message: "Authentication required."
  })
})

test("required action sessions reject invalid or expired tokens before use", () => {
  const session = { user_id: 42 }
  assert.equal(requireActionSession(session), session)
  assert.throws(() => requireActionSession(undefined), MissingActionSessionError)
  assert.throws(() => requireActionSession(null), MissingActionSessionError)
})

test("page action context failures retain authentication and authorization status", () => {
  const missingSession = failForActionError(
    new MissingActionSessionError("Authentication required.")
  )
  assert.equal(missingSession.status, 401)

  const mismatch = failForActionError(
    new PageActionContextMismatchError("Permission denied.")
  )
  assert.equal(mismatch.status, 403)
})

test("malformed action JSON is a client error", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    body: "{"
  })

  await assert.rejects(readActionJson(request, object({ pageId: number() })), (error) => {
    const failure = failForActionError(error)
    assert.equal(failure.status, 400)
    assert.deepEqual(failure.data, {
      message: "Invalid JSON request body."
    })
    return true
  })
})

test("action JSON fields are validated before use", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    body: JSON.stringify({ pageId: "not-a-number" })
  })

  await assert.rejects(readActionJson(request, object({ pageId: number() })), (error) => {
    const failure = failForActionError(error)
    assert.equal(failure.status, 400)
    assert.deepEqual(failure.data, {
      message: "Invalid JSON request body."
    })
    return true
  })
})
