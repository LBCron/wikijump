import { strict as assert } from "node:assert"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { createJiti } from "jiti"

const libRoot = fileURLToPath(new URL("../src/lib/", import.meta.url))
const jiti = createJiti(import.meta.url, { alias: { $lib: libRoot } })
const { pageFileCreate, pageFileEdit } = /** @type {any} */ (
  await jiti.import(
    fileURLToPath(new URL("../src/lib/server/deepwell/page-file.ts", import.meta.url))
  )
)
const { client } = /** @type {any} */ (
  await jiti.import(
    fileURLToPath(new URL("../src/lib/server/deepwell/index.ts", import.meta.url))
  )
)

const requestContext = {
  sessionToken: "issue-1062-session",
  siteId: 17,
  page: 23
}

const createInput = () => ({
  siteId: 17,
  pageId: 23,
  userId: 29,
  name: "issue-1062.txt",
  file: new File(["issue 1062"], "issue-1062.txt"),
  revisionComments: "issue 1062 upload",
  ipAddress: "192.0.2.62"
})

/** @param {any} t @param {any} request @param {any} fetchImpl @param {any} operation */
const withUploadBoundaries = async (t, request, fetchImpl, operation) => {
  const originalRequest = client.request
  const originalFetch = globalThis.fetch
  t.after(() => {
    client.request = originalRequest
    globalThis.fetch = originalFetch
  })
  client.request = request
  globalThis.fetch = fetchImpl
  return operation()
}

test("page file create cancels its page-scoped pending blob when commit fails", async (t) => {
  /** @type {any[]} */
  const calls = []
  const commitError = new Error("file_create rejected")
  const request = /** @param {any} method @param {any} params @param {any} context */ async (method, params, context) => {
    calls.push({ method, params, context })
    if (method === "page_edit_permission") return { can_edit: true }
    if (method === "blob_upload") {
      return {
        pending_blob_id: "pending-create",
        presign_url: "https://uploads.example.test/pending-create"
      }
    }
    if (method === "file_create") throw commitError
    if (method === "blob_cancel") return null
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  await assert.rejects(
    withUploadBoundaries(
      t,
      request,
      async () => new Response(null, { status: 200 }),
      () => pageFileCreate(createInput(), requestContext)
    ),
    /** @param {any} error */ (error) => error === commitError
  )

  assert.deepEqual(
    calls.map(({ method }) => method),
    ["page_edit_permission", "blob_upload", "file_create", "blob_cancel"]
  )
  assert.deepEqual(calls[1].params, {
    user_id: 29,
    blob_size: 10,
    scope: "page"
  })
  assert.deepEqual(calls[1].context, requestContext)
  assert.deepEqual(calls[3].params, {
    user_id: 29,
    pending_blob_id: "pending-create"
  })
  assert.deepEqual(calls[3].context, requestContext)
})

test("page file create preserves the commit error when pending cleanup also fails", async (t) => {
  /** @type {any[]} */
  const calls = []
  const commitError = new Error("file_create commit sentinel")
  const cancelError = new Error("blob_cancel cleanup sentinel")
  let cancelCount = 0
  const request = /** @param {any} method @param {any} params @param {any} context */ async (method, params, context) => {
    calls.push({ method, params, context })
    if (method === "page_edit_permission") return { can_edit: true }
    if (method === "blob_upload") {
      return {
        pending_blob_id: "pending-double-failure",
        presign_url: "https://uploads.example.test/pending-double-failure"
      }
    }
    if (method === "file_create") throw commitError
    if (method === "blob_cancel") {
      cancelCount += 1
      throw cancelError
    }
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  await assert.rejects(
    withUploadBoundaries(
      t,
      request,
      async () => new Response(null, { status: 200 }),
      () => pageFileCreate(createInput(), requestContext)
    ),
    /** @param {any} error */ (error) => error === commitError
  )

  assert.equal(cancelCount, 1)
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["page_edit_permission", "blob_upload", "file_create", "blob_cancel"]
  )
  assert.deepEqual(calls[3], {
    method: "blob_cancel",
    params: {
      user_id: 29,
      pending_blob_id: "pending-double-failure"
    },
    context: requestContext
  })
})

test("page file create cancels after PUT failure but not before pending creation", async (t) => {
  /** @type {any[]} */
  const calls = []
  const request = /** @param {any} method @param {any} params @param {any} context */ async (method, params, context) => {
    calls.push({ method, params, context })
    if (method === "page_edit_permission") return { can_edit: true }
    if (method === "blob_upload") {
      return {
        pending_blob_id: "pending-put",
        presign_url: "https://uploads.example.test/pending-put"
      }
    }
    if (method === "blob_cancel") return null
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  await assert.rejects(
    withUploadBoundaries(
      t,
      request,
      async () => new Response(null, { status: 503 }),
      () => pageFileCreate(createInput(), requestContext)
    ),
    /HTTP status 503/
  )

  assert.deepEqual(
    calls.map(({ method }) => method),
    ["page_edit_permission", "blob_upload", "blob_cancel"]
  )
})

test("page file create leaves a successful committed upload alone", async (t) => {
  /** @type {any[]} */
  const calls = []
  const expected = { file_id: 31, file_revision_id: 37, blob_created: true }
  const request = /** @param {any} method @param {any} params @param {any} context */ async (method, params, context) => {
    calls.push({ method, params, context })
    if (method === "page_edit_permission") return { can_edit: true }
    if (method === "blob_upload") {
      return {
        pending_blob_id: "pending-success",
        presign_url: "https://uploads.example.test/pending-success"
      }
    }
    if (method === "file_create") return expected
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  const actual = await withUploadBoundaries(
    t,
    request,
    async () => new Response(null, { status: 200 }),
    () => pageFileCreate(createInput(), requestContext)
  )

  assert.equal(actual, expected)
  assert.deepEqual(
    calls.map(({ method }) => method),
    ["page_edit_permission", "blob_upload", "file_create"]
  )
})

test("page file edit uses the same cleanup lifecycle for replacement content", async (t) => {
  /** @type {any[]} */
  const calls = []
  const editError = new Error("file_edit rejected")
  const request = /** @param {any} method @param {any} params @param {any} context */ async (method, params, context) => {
    calls.push({ method, params, context })
    if (method === "page_edit_permission") return { can_edit: true }
    if (method === "blob_upload") {
      return {
        pending_blob_id: "pending-edit",
        presign_url: "https://uploads.example.test/pending-edit"
      }
    }
    if (method === "file_edit") throw editError
    if (method === "blob_cancel") return null
    throw new Error(`Unexpected Deepwell method ${method}`)
  }

  await assert.rejects(
    withUploadBoundaries(
      t,
      request,
      async () => new Response(null, { status: 200 }),
      () =>
        pageFileEdit(
          {
            ...createInput(),
            fileId: 41,
            lastRevisionId: 43
          },
          requestContext
        )
    ),
    /** @param {any} error */ (error) => error === editError
  )

  assert.deepEqual(
    calls.map(({ method }) => method),
    ["page_edit_permission", "blob_upload", "file_edit", "blob_cancel"]
  )
})
