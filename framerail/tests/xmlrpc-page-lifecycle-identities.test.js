// @ts-nocheck
import { strict as assert } from "node:assert"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { createJiti } from "jiti"

const libRoot = fileURLToPath(new URL("../src/lib/", import.meta.url))
const jiti = createJiti(import.meta.url, { alias: { $lib: libRoot } })
const { client } = await jiti.import(
  fileURLToPath(new URL("../src/lib/server/deepwell/index.ts", import.meta.url))
)
const { getPageOne, getPagesMeta, savePageOne } = await jiti.import(
  fileURLToPath(new URL("../src/lib/server/xmlrpc/resource-methods.ts", import.meta.url))
)
const { serializeMethodResponse } = await jiti.import(
  fileURLToPath(new URL("../src/lib/server/xmlrpc/protocol.ts", import.meta.url))
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

test("pages.get_meta publishes authoritative display names only after view authorization", async (t) => {
  const originalRequest = client.request
  const originalUsername = process.env.XML_RPC_WRITE_USERNAME
  const originalPassword = process.env.XML_RPC_WRITE_PASSWORD
  process.env.XML_RPC_WRITE_USERNAME = "xmlrpc-lifecycle-user"
  process.env.XML_RPC_WRITE_PASSWORD = "xmlrpc-lifecycle-password"
  t.after(() => {
    client.request = originalRequest
    restoreEnvironment("XML_RPC_WRITE_USERNAME", originalUsername)
    restoreEnvironment("XML_RPC_WRITE_PASSWORD", originalPassword)
  })

  const calls = []
  client.request = async (method, params, context) => {
    calls.push({ method, params, context })
    if (method === "site_get") return { site_id: 6000005 }
    if (method === "login") return { session_token: "fixture-session-token" }
    if (method === "session_get") return { user_id: 123 }
    if (method === "page_get") return page
    if (method === "page_view") {
      return { type: "found", data: { page: { slug: page.slug } } }
    }
    if (method === "page_lifecycle_identity") {
      return { created_by: "Snapshot Creator", updated_by: "Native Updater" }
    }
    if (method === "parent_get_direct_metadata") return null
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const result = await getPagesMeta(
    {
      methodName: "pages.get_meta",
      params: [{ site: "scp-wiki", pages: [page.slug] }]
    },
    "192.0.2.73"
  )

  assert.equal(result[page.slug].created_by, "Snapshot Creator")
  assert.equal(result[page.slug].updated_by, "Native Updater")
  assert.notEqual(result[page.slug].created_by, page.slug)
  const xml = serializeMethodResponse(result)
  assert.doesNotMatch(
    xml,
    /<name>(?:created_by|updated_by)<\/name><value><string>\d+<\/string>/u
  )
  assert.ok(
    calls.findIndex(({ method }) => method === "page_view") <
      calls.findIndex(({ method }) => method === "page_lifecycle_identity")
  )
})

test("pages.get_meta faults the whole call when a required display name is unavailable", async (t) => {
  installWriteCredentials(t)
  const originalRequest = client.request
  t.after(() => {
    client.request = originalRequest
  })

  const secondPage = { ...page, page_id: 3000174, slug: "scp-174" }
  client.request = async (method, params) => {
    if (method === "site_get") return { site_id: 6000005 }
    if (method === "login") return { session_token: "fixture-session-token" }
    if (method === "session_get") return { user_id: 123 }
    if (method === "page_get") {
      return params.page === secondPage.slug ? secondPage : page
    }
    if (method === "page_view") {
      return { type: "found", data: { page: { slug: params.route.slug } } }
    }
    if (method === "page_lifecycle_identity") {
      return params.page === secondPage.slug
        ? { created_by: null, updated_by: "Native Updater" }
        : { created_by: "Snapshot Creator", updated_by: "Native Updater" }
    }
    if (method === "parent_get_direct_metadata") return null
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  await assert.rejects(
    getPagesMeta(
      {
        methodName: "pages.get_meta",
        params: [{ site: "scp-wiki", pages: [page.slug, secondPage.slug] }]
      },
      "192.0.2.74"
    ),
    (error) =>
      error.faultCode === -32603 &&
      error.faultString === "Page lifecycle identity unavailable"
  )
})

test("page lifecycle lookup is not attempted when view authorization fails", async (t) => {
  installWriteCredentials(t)
  const originalRequest = client.request
  t.after(() => {
    client.request = originalRequest
  })

  const calls = []
  client.request = async (method) => {
    calls.push(method)
    if (method === "site_get") return { site_id: 6000005 }
    if (method === "login") return { session_token: "fixture-session-token" }
    if (method === "session_get") return { user_id: 123 }
    if (method === "page_get") return page
    if (method === "page_view") return { type: "missing" }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const result = await getPagesMeta(
    {
      methodName: "pages.get_meta",
      params: [{ site: "scp-wiki", pages: [page.slug] }]
    },
    "192.0.2.78"
  )
  assert.deepEqual(result, {})
  assert.equal(calls.includes("page_lifecycle_identity"), false)
})

test("pages.get_one serializes display names instead of lifecycle user IDs", async (t) => {
  installWriteCredentials(t)
  const originalRequest = client.request
  t.after(() => {
    client.request = originalRequest
  })

  client.request = async (method, params) => {
    if (method === "site_get") return { site_id: 6000005 }
    if (method === "login") return { session_token: "fixture-session-token" }
    if (method === "session_get") return { user_id: 123 }
    if (method === "page_get") {
      return params.details.wikitext
        ? {
            ...page,
            wikitext: "**Item #:** SCP-173",
            compiled_body_html: "<p><strong>Item #:</strong> SCP-173</p>",
            compiled_body_styles: []
          }
        : page
    }
    if (method === "page_view") {
      return { type: "found", data: { page: { slug: page.slug } } }
    }
    if (method === "page_lifecycle_identity") {
      return { created_by: "Snapshot Creator", updated_by: "Native Updater" }
    }
    if (method === "parent_get_direct_metadata") return null
    if (method === "forum_post_page_summary") {
      return { comments: 0, commented_at: null, commented_by: null }
    }
    if (method === "page_select") return []
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const result = await getPageOne(
    {
      methodName: "pages.get_one",
      params: [{ site: "scp-wiki", page: page.slug }]
    },
    "192.0.2.75"
  )
  assert.equal(result.created_by, "Snapshot Creator")
  assert.equal(result.updated_by, "Native Updater")
  assert.doesNotMatch(
    serializeMethodResponse(result),
    /<name>(?:created_by|updated_by)<\/name><value><string>\d+<\/string>/u
  )
})

test("pages.save_one performs no write when lifecycle identity preflight is unavailable", async (t) => {
  installWriteCredentials(t)
  const originalRequest = client.request
  t.after(() => {
    client.request = originalRequest
  })

  const calls = []
  client.request = async (method, params) => {
    calls.push(method)
    if (method === "site_get") return { site_id: 6000005 }
    if (method === "page_get") {
      return params.details.wikitext
        ? {
            ...page,
            wikitext: "old body",
            compiled_body_html: "<p>old body</p>",
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
      return { created_by: "Snapshot Creator", updated_by: null }
    }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  await assert.rejects(
    savePageOne(
      {
        methodName: "pages.save_one",
        params: [
          {
            site: "scp-wiki",
            page: page.slug,
            content: "unsafe retry proof",
            save_mode: "update"
          }
        ]
      },
      "192.0.2.76"
    ),
    (error) =>
      error.faultCode === -32603 &&
      error.faultString === "Page lifecycle identity unavailable"
  )
  assert.equal(calls.includes("page_create"), false)
  assert.equal(calls.includes("page_edit"), false)
  assert.equal(calls.includes("parent_update"), false)
  assert.equal(calls.includes("page_move"), false)
  assert.ok(calls.indexOf("page_view") < calls.indexOf("page_lifecycle_identity"))
})

test("pages.save_one denies a view-only actor before lifecycle identity lookup", async (t) => {
  installWriteCredentials(t)
  const originalRequest = client.request
  t.after(() => {
    client.request = originalRequest
  })

  const calls = []
  client.request = async (method) => {
    calls.push(method)
    if (method === "site_get") return { site_id: 6000005 }
    if (method === "page_get") {
      return {
        ...page,
        wikitext: "old body",
        compiled_body_html: "<p>old body</p>",
        compiled_body_styles: []
      }
    }
    if (method === "login") return { session_token: "fixture-session-token" }
    if (method === "session_get") return { user_id: 123 }
    if (method === "page_edit_permission") return { can_edit: false }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  await assert.rejects(
    savePageOne(
      {
        methodName: "pages.save_one",
        params: [
          {
            site: "scp-wiki",
            page: page.slug,
            content: "must not be written",
            save_mode: "update"
          }
        ]
      },
      "192.0.2.80"
    ),
    (error) =>
      error.faultCode === 403 &&
      error.faultString === "XML-RPC user is not allowed to edit this page"
  )
  assert.equal(calls.includes("page_view"), false)
  assert.equal(calls.includes("page_lifecycle_identity"), false)
  assert.equal(calls.includes("page_edit"), false)
})

test("pages.save_one preflights a new page actor before page creation", async (t) => {
  installWriteCredentials(t)
  const originalRequest = client.request
  t.after(() => {
    client.request = originalRequest
  })

  const calls = []
  client.request = async (method) => {
    calls.push(method)
    if (method === "site_get") return { site_id: 6000005 }
    if (method === "page_get") return null
    if (method === "login") return { session_token: "fixture-session-token" }
    if (method === "session_get") return { user_id: 123 }
    if (method === "user_get") return null
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  await assert.rejects(
    savePageOne(
      {
        methodName: "pages.save_one",
        params: [
          {
            site: "scp-wiki",
            page: "new-page-with-unavailable-actor",
            content: "must not be written",
            save_mode: "create"
          }
        ]
      },
      "192.0.2.79"
    ),
    (error) =>
      error.faultCode === -32603 &&
      error.faultString === "Page lifecycle identity unavailable"
  )
  assert.equal(calls.includes("page_create"), false)
  assert.ok(calls.indexOf("user_get") > calls.indexOf("session_get"))
})

test("pages.save_one reuses preflight names after mutation", async (t) => {
  installWriteCredentials(t)
  const originalRequest = client.request
  t.after(() => {
    client.request = originalRequest
  })

  const calls = []
  client.request = async (method, params) => {
    calls.push(method)
    if (method === "site_get") return { site_id: 6000005 }
    if (method === "page_get") {
      return params.details.wikitext
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
          ["lock_secret"]: "lifecycle-fixture-secret",
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

  const result = await savePageOne(
    {
      methodName: "pages.save_one",
      params: [
        {
          site: "scp-wiki",
          page: page.slug,
          content: "updated body",
          save_mode: "update"
        }
      ]
    },
    "192.0.2.77"
  )
  assert.equal(result.created_by, "Snapshot Creator")
  assert.equal(result.updated_by, "Actor Display")
  assert.notEqual(result.updated_by, "actor-account")
  assert.equal(calls.filter((method) => method === "page_lifecycle_identity").length, 1)
  assert.ok(calls.indexOf("page_lifecycle_identity") < calls.indexOf("page_edit"))
  assert.ok(calls.indexOf("user_get") < calls.indexOf("page_edit"))
  assert.ok(calls.indexOf("page_edit_lock_acquire") < calls.indexOf("page_edit"))
  assert.ok(calls.indexOf("page_edit") < calls.indexOf("page_edit_lock_release"))
  assert.doesNotMatch(
    serializeMethodResponse(result),
    /<name>(?:created_by|updated_by)<\/name><value><string>\d+<\/string>/u
  )
})

const installWriteCredentials = (t) => {
  const originalUsername = process.env.XML_RPC_WRITE_USERNAME
  const originalPassword = process.env.XML_RPC_WRITE_PASSWORD
  process.env.XML_RPC_WRITE_USERNAME = "xmlrpc-lifecycle-user"
  process.env.XML_RPC_WRITE_PASSWORD = "xmlrpc-lifecycle-password"
  t.after(() => {
    restoreEnvironment("XML_RPC_WRITE_USERNAME", originalUsername)
    restoreEnvironment("XML_RPC_WRITE_PASSWORD", originalPassword)
  })
}

const restoreEnvironment = (name, value) => {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
