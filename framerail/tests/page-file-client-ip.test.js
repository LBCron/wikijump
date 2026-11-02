// @ts-nocheck
import { strict as assert } from "node:assert"
import test from "node:test"

import { pageActionEvent, startPageActionHarness } from "./page-action-test-harness.js"

const CLIENT_IP = "192.0.2.14"
const SITE_ID = 17
const TRUSTED_CONTEXT = { siteId: SITE_ID, page: "main" }

const formEvent = (action, fields) => {
  const data = new FormData()
  for (const [name, value] of Object.entries(fields)) data.set(name, String(value))
  return {
    request: new Request(`https://wikijump.test/main?/${action}`, {
      method: "POST",
      body: data,
      headers: {
        "X-Wikijump-Site-Id": String(SITE_ID),
        "X-Wikijump-Site-Slug": "test"
      }
    }),
    getClientAddress: () => CLIENT_IP,
    params: { slug: "main" },
    cookies: { get: () => "file-session" },
    locals: {
      requestContext: {
        ...TRUSTED_CONTEXT,
        sessionToken: "file-session"
      }
    }
  }
}

test("file edit, restore, and rollback actions forward getClientAddress through Deepwell", async () => {
  const harness = await startPageActionHarness()
  const { client, actions } = harness
  try {
    const calls = []
    client.request = async (method, params, context) => {
      calls.push({ method, params, context })
      if (method === "session_get") return { user_id: 3 }
      if (["file_edit", "file_restore", "file_rollback"].includes(method)) {
        return { ok: true }
      }
      throw new Error(`Unexpected Deepwell method ${method}`)
    }

    await actions.fileEdit(
      formEvent("fileEdit", {
        siteId: SITE_ID,
        pageId: 42,
        lastRevisionId: 8,
        fileId: 5,
        name: "renamed.txt",
        comments: "edit"
      })
    )
    await actions.fileRestore(
      formEvent("fileRestore", {
        siteId: SITE_ID,
        pageId: 42,
        lastRevisionId: 8,
        fileId: 5,
        newPage: "",
        newName: "",
        comments: "restore"
      })
    )
    await actions.fileRollback(
      pageActionEvent({
        action: "fileRollback",
        body: {
          siteId: SITE_ID,
          pageId: 42,
          lastRevisionId: 8,
          fileId: 5,
          revisionNumber: 6,
          comments: "rollback"
        },
        siteId: SITE_ID,
        sessionToken: "file-session",
        requestContext: {
          ...TRUSTED_CONTEXT,
          sessionToken: "file-session"
        },
        clientAddress: CLIENT_IP
      })
    )

    const mutations = calls.filter(({ method }) =>
      ["file_edit", "file_restore", "file_rollback"].includes(method)
    )
    assert.deepEqual(
      mutations.map(({ method, params }) => [method, params.ip_address]),
      [
        ["file_edit", CLIENT_IP],
        ["file_restore", CLIENT_IP],
        ["file_rollback", CLIENT_IP]
      ]
    )
    assert.deepEqual(
      mutations.map(({ context }) => context),
      [
        { ...TRUSTED_CONTEXT, sessionToken: "file-session" },
        { ...TRUSTED_CONTEXT, sessionToken: "file-session" },
        { ...TRUSTED_CONTEXT, sessionToken: "file-session" }
      ]
    )
  } finally {
    await harness.close()
  }
})

test("file delete and move actions bind the actor and routed page context", async () => {
  const harness = await startPageActionHarness()
  const { client, actions } = harness
  try {
    const calls = []
    client.request = async (method, params, context) => {
      calls.push({ method, params, context })
      if (method === "session_get") return { user_id: 3 }
      if (method === "file_delete" || method === "file_move") return { ok: true }
      throw new Error(`Unexpected Deepwell method ${method}`)
    }

    await actions.fileDelete(
      pageActionEvent({
        action: "fileDelete",
        body: {
          siteId: SITE_ID,
          pageId: 42,
          lastRevisionId: 8,
          fileId: 5,
          comments: "delete"
        },
        siteId: SITE_ID,
        sessionToken: "file-session",
        requestContext: { ...TRUSTED_CONTEXT, sessionToken: "file-session" }
      })
    )
    await actions.fileMove(
      formEvent("fileMove", {
        siteId: SITE_ID,
        pageId: 42,
        lastRevisionId: 8,
        fileId: 5,
        destinationPage: "other-page",
        name: "",
        comments: "move"
      })
    )

    assert.deepEqual(
      calls.filter(({ method }) => method === "file_delete" || method === "file_move"),
      [
        {
          method: "file_delete",
          params: {
            site_id: SITE_ID,
            page_id: 42,
            user_id: 3,
            file: 5,
            last_revision_id: 8,
            revision_comments: "delete"
          },
          context: { ...TRUSTED_CONTEXT, sessionToken: "file-session" }
        },
        {
          method: "file_move",
          params: {
            site_id: SITE_ID,
            current_page_id: 42,
            destination_page: "other-page",
            user_id: 3,
            file_id: 5,
            last_revision_id: 8,
            name: undefined,
            revision_comments: "move"
          },
          context: { ...TRUSTED_CONTEXT, sessionToken: "file-session" }
        }
      ]
    )
  } finally {
    await harness.close()
  }
})

test("file revision reads forward the routed request context to Deepwell", async () => {
  const harness = await startPageActionHarness()
  const { client, actions } = harness
  try {
    const calls = []
    client.request = async (method, params, context) => {
      calls.push({ method, params, context })
      if (method === "file_revision_range") {
        return [{ revision_id: 5, revision_number: 2 }]
      }
      throw new Error(`Unexpected Deepwell method ${method}`)
    }

    const requestEvent = (body, siteId = SITE_ID) =>
      pageActionEvent({
        action: "fileHistory",
        body,
        siteId,
        requestContext: { ...TRUSTED_CONTEXT }
      })

    const result = await actions.fileHistory(
      requestEvent({ siteId: SITE_ID, pageId: 42, fileId: 5 })
    )
    assert.deepEqual(result, { res: [{ revision_id: 5, revision_number: 2 }] })
    assert.deepEqual(calls, [
      {
        method: "file_revision_range",
        params: {
          site_id: SITE_ID,
          page_id: 42,
          file_id: 5,
          revision_number: -1,
          revision_direction: "before",
          limit: 20
        },
        context: TRUSTED_CONTEXT
      }
    ])

    calls.length = 0
    const spoofed = await actions.fileHistory(
      requestEvent({ siteId: SITE_ID + 1, pageId: 42, fileId: 5 }, SITE_ID + 1)
    )
    assert.equal(spoofed.status, 403)
    assert.deepEqual(calls, [])
  } finally {
    await harness.close()
  }
})
