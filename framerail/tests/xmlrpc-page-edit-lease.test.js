import { strict as assert } from "node:assert"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { createJiti } from "jiti"

const libRoot = fileURLToPath(new URL("../src/lib/", import.meta.url))
const jiti = createJiti(import.meta.url, { alias: { $lib: libRoot } })
const { client } = /** @type {any} */ (
  await jiti.import(
    fileURLToPath(new URL("../src/lib/server/deepwell/index.ts", import.meta.url))
  )
)
const { savePageOne } = /** @type {any} */ (
  await jiti.import(
    fileURLToPath(
      new URL("../src/lib/server/xmlrpc/resource-methods.ts", import.meta.url)
    )
  )
)

const page = {
  page_id: 3000173,
  revision_id: 9000173,
  page_created_at: "2008-07-26T00:00:00Z",
  page_updated_at: null,
  page_revision_count: 3,
  revision_created_at: "2008-07-26T00:00:00Z",
  revision_user_id: 456,
  title: "SCP-173",
  slug: "scp-173",
  tags: ["scp", "euclid"],
  rating: 173
}

/** @param {any} t */
const installWriteCredentials = (t) => {
  const originalUsername = process.env.XML_RPC_WRITE_USERNAME
  const originalPassword = process.env.XML_RPC_WRITE_PASSWORD
  process.env.XML_RPC_WRITE_USERNAME = "xmlrpc-lease-user"
  process.env.XML_RPC_WRITE_PASSWORD = "xmlrpc-lease-password"
  t.after(() => {
    if (originalUsername === undefined) delete process.env.XML_RPC_WRITE_USERNAME
    else process.env.XML_RPC_WRITE_USERNAME = originalUsername
    if (originalPassword === undefined) delete process.env.XML_RPC_WRITE_PASSWORD
    else process.env.XML_RPC_WRITE_PASSWORD = originalPassword
  })
}

/**
 * @param {any} t
 * @param {any} [overrides]
 */
const installStub = (t, overrides = {}) => {
  installWriteCredentials(t)
  const originalRequest = client.request
  t.after(() => {
    client.request = originalRequest
  })

  /** @type {any[]} */
  const calls = []
  client.request = /** @param {any} method @param {any} params */ async (
    method,
    params
  ) => {
    calls.push({ method, params })
    if (overrides[method]) return overrides[method](params)
    if (method === "site_get") return { site_id: 6000005 }
    if (method === "page_get") {
      return params.details?.wikitext
        ? {
            ...page,
            wikitext: "updated body",
            compiled_body_html: "<p>updated body</p>",
            compiled_body_styles: []
          }
        : page
    }
    if (method === "login") return { session_token: "fixture-session-token" }
    if (method === "session_get") return { user_id: 123 }
    if (method === "page_edit_permission") return { can_edit: true }
    if (method === "page_view") {
      return { type: "found", data: { page: { slug: page.slug } } }
    }
    if (method === "page_lifecycle_identity") {
      return { created_by: "Snapshot Creator", updated_by: "Prior Updater" }
    }
    if (method === "user_get") {
      return { user_id: 123, name: "Actor Display", slug: "actor-account" }
    }
    if (method === "page_edit_lock_acquire") {
      return {
        grant: {
          lock_id: 7001,
          "lock_secret": "lease-fixture-secret",
          base_revision_id: page.revision_id,
          expires_at: "2999-01-01T00:00:00Z"
        },
        conflicts: []
      }
    }
    if (method === "page_edit_lock_release") return true
    if (method === "page_edit") return { revision_id: 9000174 }
    if (method === "parent_get_direct_metadata") return null
    if (method === "forum_post_page_summary") {
      return { comments: 0, commented_at: null, commented_by: null }
    }
    if (method === "page_select") return []
    throw new Error(`Unexpected Deepwell method ${method}`)
  }
  return calls
}

/** @param {any} params */
const saveCall = (params) => ({
  methodName: "pages.save_one",
  params: [{ site: "scp-wiki", page: page.slug, save_mode: "update", ...params }]
})

/** @param {any[]} calls */
const methodsOf = (calls) => calls.map((call) => call.method)

test("pages.save_one acquires, presents, and releases an edit lease for a content save", async (t) => {
  const calls = installStub(t)

  const result = await savePageOne(saveCall({ content: "updated body" }), "192.0.2.90")

  assert.equal(result.fullname, page.slug)
  const methods = methodsOf(calls)
  assert.ok(methods.indexOf("page_edit_lock_acquire") < methods.indexOf("page_edit"))
  assert.ok(methods.indexOf("page_edit") < methods.indexOf("page_edit_lock_release"))

  const acquire = calls.find((call) => call.method === "page_edit_lock_acquire")
  assert.deepEqual(acquire.params, { page: page.slug, mode: "page" })

  const edit = calls.find((call) => call.method === "page_edit")
  assert.deepEqual(edit.params.lease, {
    lock_id: 7001,
    "lock_secret": "lease-fixture-secret",
    mode: "page"
  })
  assert.equal(edit.params.wikitext, "updated body")

  const release = calls.find((call) => call.method === "page_edit_lock_release")
  assert.deepEqual(release.params, {
    page: page.slug,
    lock_id: 7001,
    "lock_secret": "lease-fixture-secret"
  })
})

test("pages.save_one faults with the conflict data and writes nothing when the lease is held", async (t) => {
  const calls = installStub(t, {
    page_edit_lock_acquire: async () => ({
      grant: null,
      conflicts: [
        { user_id: 456, mode: "page", section_index: null, seconds_remaining: 812 }
      ]
    })
  })

  await assert.rejects(
    savePageOne(saveCall({ content: "must not be written" }), "192.0.2.91"),
    /** @param {any} error */ (error) =>
      error.faultCode === 4304 &&
      error.faultString.includes("456") &&
      error.faultString.includes("812")
  )
  const methods = methodsOf(calls)
  assert.equal(methods.includes("page_edit"), false)
  assert.equal(methods.includes("page_edit_lock_release"), false)
})

test("pages.save_one propagates a 4304 save rejection as a fault and still releases", async (t) => {
  const calls = installStub(t, {
    page_edit: async () => {
      throw Object.assign(new Error("edit lock conflict"), { code: 4304 })
    }
  })

  await assert.rejects(
    savePageOne(saveCall({ content: "updated body" }), "192.0.2.92"),
    /** @param {any} error */ (error) => error.faultCode === 4304
  )
  const methods = methodsOf(calls)
  assert.ok(methods.indexOf("page_edit") < methods.indexOf("page_edit_lock_release"))
})

test("pages.save_one propagates a 4303 save rejection as a fault and still releases", async (t) => {
  const calls = installStub(t, {
    page_edit: async () => {
      throw Object.assign(new Error("not latest revision"), { code: 4303 })
    }
  })

  await assert.rejects(
    savePageOne(saveCall({ content: "updated body" }), "192.0.2.93"),
    /** @param {any} error */ (error) => error.faultCode === 4303
  )
  assert.equal(methodsOf(calls).includes("page_edit_lock_release"), true)
})

test("pages.save_one does not acquire a lease for a title-only save", async (t) => {
  const calls = installStub(t)

  await savePageOne(saveCall({ title: "SCP-173 Retitled" }), "192.0.2.94")

  const methods = methodsOf(calls)
  assert.equal(methods.includes("page_edit_lock_acquire"), false)
  assert.equal(methods.includes("page_edit_lock_release"), false)
  const edit = calls.find((call) => call.method === "page_edit")
  assert.equal(edit.params.lease, undefined)
  assert.equal(edit.params.title, "SCP-173 Retitled")
})
