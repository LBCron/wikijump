// Refs #2130. Registration owns the first verification email: after a
// successful userCreate the register action issues a verification token
// for the submitted address through the quiet (non-oracling) issue path,
// and shows a pending-verification state. A failed issue must not fail
// the registration itself; the resend page stays the recovery path.
// @ts-nocheck
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { after, before, describe, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.js"

const root = fileURLToPath(new URL("..", import.meta.url))

const FIXTURE_PASSWORD = "verification-fixture-password-28"

const postRequest = (fields) => {
  const formData = new FormData()
  for (const [name, value] of Object.entries(fields)) formData.set(name, value)
  return new Request("https://wikijump.test/-/register", {
    method: "POST",
    body: formData
  })
}

const validRegistration = () => ({
  username: "verify-newcomer",
  email: "newcomer@example.com",
  password: FIXTURE_PASSWORD,
  confirmPassword: FIXTURE_PASSWORD
})

const actionEvent = (request) => ({
  request,
  getClientAddress: () => "192.0.2.77"
})

describe("register verification issue", () => {
  let previousWorkingDirectory
  let vite
  let client
  let originalClientRequest
  let routes
  let calls
  let issueShouldThrow

  before(async () => {
    previousWorkingDirectory = process.cwd()
    process.chdir(root)
    vite = await createTestViteServer()

    ;({ client } = await vite.ssrLoadModule("/src/lib/server/deepwell/index.ts"))
    originalClientRequest = client.request
    calls = []
    issueShouldThrow = false
    client.request = async (method, params) => {
      calls.push({ method, params })
      if (method === "user_create") return { user_id: 41, slug: "verify-newcomer" }
      if (method === "email_verify_issue") {
        if (issueShouldThrow) throw new Error("mail queue unavailable")
        return undefined
      }
      throw new Error(`Unexpected Deepwell method ${method}`)
    }

    routes = {
      register: await vite.ssrLoadModule("/src/routes/[x+2d]/register/+page.server.ts")
    }
  })

  after(async () => {
    if (client && originalClientRequest) client.request = originalClientRequest
    if (vite) await vite.close()
    if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
  })

  test("registration issues the first verification email to the submitted address", async () => {
    calls.length = 0
    const result = await routes.register.actions.default(
      actionEvent(postRequest(validRegistration()))
    )
    assert.equal(result.isRegistered, true)

    const create = calls.find(({ method }) => method === "user_create")
    assert.deepEqual(create.params.email, "newcomer@example.com")

    // Quiet issue path: the submitted address plus audit IP only. Passwords
    // never travel beyond the creation call.
    const issue = calls.find(({ method }) => method === "email_verify_issue")
    assert.deepEqual(issue.params, {
      email: "newcomer@example.com",
      ip_address: "192.0.2.77"
    })
  })

  test("a failed verification issue still completes the registration", async () => {
    issueShouldThrow = true
    try {
      calls.length = 0
      const result = await routes.register.actions.default(
        actionEvent(postRequest(validRegistration()))
      )
      // The account already exists; the resend page is the recovery path,
      // so the action reports success rather than a server failure.
      assert.equal(result.isRegistered, true)
      assert.ok(calls.some(({ method }) => method === "email_verify_issue"))
    } finally {
      issueShouldThrow = false
    }
  })

  test("a tripped honeypot creates no user and no verification state", async () => {
    calls.length = 0
    const result = await routes.register.actions.default(
      actionEvent(postRequest({ ...validRegistration(), leaveBlank: "on" }))
    )
    assert.equal(result.status, 400)
    assert.ok(!calls.some(({ method }) => method === "user_create"))
    assert.ok(!calls.some(({ method }) => method === "email_verify_issue"))
  })

  test("the register template names the verification resend page", async () => {
    const source = await readFile(
      new URL("../src/routes/[x+2d]/register/+page.svelte", import.meta.url),
      "utf8"
    )
    assert.match(source, /\/-\/verify-email/u, "pending notice links the resend page")
    assert.match(source, /LOCAL DEFAULT/u, "pending copy is flagged as unevidenced")
  })
})
