import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.ts"

const root = fileURLToPath(new URL("..", import.meta.url))
const siteHeaders = {
  "Accept-Language": "en-US",
  "X-Wikijump-Site-Id": "17",
  "X-Wikijump-Site-Slug": "test"
}

const anonymousPreload = {
  site: { locale: "en" },
  site_settings: {},
  site_file_domain: "test.wjfiles.localhost",
  license_name: "CC BY-SA 4.0",
  license_url: "https://creativecommons.org/licenses/by-sa/4.0/",
  license_kind: "standard",
  license_html: null,
  user_session: null
}

let previousWorkingDirectory: any
let vite: any
let client: any
let originalClientRequest: any
let layout: any

before(async () => {
  previousWorkingDirectory = process.cwd()
  process.chdir(root)
  vite = await createTestViteServer()

  ;({ client } = await vite.ssrLoadModule("/src/lib/server/deepwell/index.ts"))
  originalClientRequest = client.request
  layout = await vite.ssrLoadModule("/src/routes/+layout.server.ts")
})

after(async () => {
  if (client && originalClientRequest) client.request = originalClientRequest
  if (vite) await vite.close()
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
})

const logoutRequest = () =>
  new Request("https://wikijump.test/-/logout", { headers: siteHeaders })

test("a stale session cookie recovers the root preload anonymously", async () => {
  const calls: any[] = []
  client.request = async (method: any, params: any) => {
    calls.push({ method, params })
    if (params.session_token === "stale-session") {
      throw Object.assign(new Error("Session token is invalid"), { code: 3001 })
    }
    return anonymousPreload
  }

  const deletedCookies: any[] = []
  const locals: any = {}
  const data = await layout.load({
    request: logoutRequest(),
    cookies: {
      get: () => "stale-session",
      delete: (name: any, options: any) => deletedCookies.push({ name, options })
    },
    route: { id: "/[x+2d]/logout" },
    locals
  })

  assert.equal(data.user_session, null)
  assert.equal(locals.siteLocale, "en")
  assert.deepEqual(deletedCookies, [
    {
      name: "wikijump_token",
      options: { path: "/", httpOnly: true, secure: true, sameSite: "lax" }
    }
  ])
  assert.deepEqual(
    calls.map(({ method, params }) => ({ method, sessionToken: params.session_token })),
    [
      { method: "preload_view", sessionToken: "stale-session" },
      { method: "preload_view", sessionToken: undefined }
    ]
  )
})

test("an active session cookie remains attached to the root preload", async () => {
  const calls: any[] = []
  client.request = async (method: any, params: any) => {
    calls.push({ method, params })
    return {
      ...anonymousPreload,
      user_session: { user: { user_id: 41, locales: ["ja"] } }
    }
  }

  const deletedCookies: any[] = []
  const data = await layout.load({
    request: logoutRequest(),
    cookies: {
      get: () => "active-session",
      delete: (name: any, options: any) => deletedCookies.push({ name, options })
    },
    route: { id: "/[x+2d]/logout" },
    locals: {}
  })

  assert.equal(data.user_session.user.user_id, 41)
  assert.deepEqual(deletedCookies, [])
  assert.deepEqual(
    calls.map(({ method, params }) => ({ method, sessionToken: params.session_token })),
    [{ method: "preload_view", sessionToken: "active-session" }]
  )
})

test("non-session preload failures remain terminal and retain the cookie", async () => {
  const errors = [
    new Error("Deepwell transport unavailable"),
    Object.assign(new Error("Database query failed"), { code: 1200 }),
    Object.assign(new Error("Permission denied"), { code: 3106 }),
    new Error("Session token is invalid"),
    Object.assign(new Error("Session token is invalid"), { code: "3001" })
  ]

  for (const expectedError of errors) {
    const calls: any[] = []
    client.request = async (method: any, params: any) => {
      calls.push({ method, params })
      throw expectedError
    }

    const deletedCookies: any[] = []
    await assert.rejects(
      layout.load({
        request: logoutRequest(),
        cookies: {
          get: () => "active-session",
          delete: (name: any, options: any) => deletedCookies.push({ name, options })
        },
        route: { id: "/[x+2d]/logout" },
        locals: {}
      }),
      (error) => error === expectedError
    )

    assert.deepEqual(deletedCookies, [])
    assert.deepEqual(
      calls.map(({ method, params }) => ({ method, sessionToken: params.session_token })),
      [{ method: "preload_view", sessionToken: "active-session" }]
    )
  }
})

test("an invalid anonymous preload is terminal without retrying", async () => {
  const calls: any[] = []
  const expectedError = Object.assign(new Error("Session token is invalid"), {
    code: 3001
  })
  client.request = async (method: any, params: any) => {
    calls.push({ method, params })
    throw expectedError
  }

  await assert.rejects(
    layout.load({
      request: logoutRequest(),
      cookies: {
        get: () => undefined,
        delete: () => assert.fail("an absent session cookie must not be deleted")
      },
      route: { id: "/[x+2d]/logout" },
      locals: {}
    }),
    (error) => error === expectedError
  )

  assert.deepEqual(
    calls.map(({ method, params }) => ({ method, sessionToken: params.session_token })),
    [{ method: "preload_view", sessionToken: undefined }]
  )
})
