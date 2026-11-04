import assert from "node:assert/strict"
import test from "node:test"

import { handleAjaxModuleConnectorRequest } from "../src/lib/server/ajax-module-connector.ts"

const request = (form) =>
  new Request("http://scp-wiki.local/ajax-module-connector.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form)
  })

const options = (calls) => ({
  siteId: 6000006,
  renderListPages: async () => assert.fail("must not render ListPages"),
  renderEditMetaModule: async (input) => {
    calls.push({ kind: "read", input })
    return { status: "ok", body: "<h1>Meta tags for the page</h1>" }
  },
  saveMetaTag: async (input) => calls.push({ kind: "save", input }),
  deleteMetaTag: async (input) => calls.push({ kind: "delete", input })
})

test("dispatches the canonical EditMeta read and action bodies", async () => {
  const calls = []
  const read = await handleAjaxModuleConnectorRequest(
    request({ moduleName: "edit/EditMetaModule", pageId: "1469127852" }),
    options(calls)
  )
  assert.equal((await read.json()).status, "ok")

  const save = await handleAjaxModuleConnectorRequest(
    request({
      action: "WikiPageAction",
      event: "saveMetaTag",
      pageId: "1469127852",
      metaName: "description",
      metaContent: "Alpha & <Beta>",
      allPages: "true",
      moduleName: "edit/EditMetaModule"
    }),
    options(calls)
  )
  assert.deepEqual(await save.json(), { status: "ok" })

  const remove = await handleAjaxModuleConnectorRequest(
    request({
      action: "WikiPageAction",
      event: "deleteMetaTag",
      pageId: "1469127852",
      metaName: "description",
      moduleName: "edit/EditMetaModule"
    }),
    options(calls)
  )
  assert.deepEqual(await remove.json(), { status: "ok" })
  assert.deepEqual(calls, [
    { kind: "read", input: { siteId: 6000006, pageId: 1469127852 } },
    {
      kind: "save",
      input: {
        siteId: 6000006,
        pageId: 1469127852,
        name: "description",
        content: "Alpha & <Beta>",
        allPages: true
      }
    },
    {
      kind: "delete",
      input: {
        siteId: 6000006,
        pageId: 1469127852,
        name: "description",
        allPages: false
      }
    }
  ])
})

test("EditMeta unknown, duplicate, and malformed fields fail before Deepwell", async () => {
  let calls = 0
  const guarded = {
    ...options([]),
    renderEditMetaModule: async () => {
      calls += 1
    },
    saveMetaTag: async () => {
      calls += 1
    },
    deleteMetaTag: async () => {
      calls += 1
    }
  }
  const forms = [
    { moduleName: "edit/EditMetaModule", pageId: "01" },
    { moduleName: "edit/EditMetaModule", pageId: "1469127852", unknown: "x" },
    {
      action: "WikiPageAction",
      event: "saveMetaTag",
      pageId: "1469127852",
      metaName: "",
      metaContent: "x",
      moduleName: "edit/EditMetaModule"
    },
    {
      action: "WikiPageAction",
      event: "saveMetaTag",
      pageId: "1469127852",
      metaName: "description",
      moduleName: "edit/EditMetaModule"
    },
    {
      action: "WikiPageAction",
      event: "deleteMetaTag",
      pageId: "1469127852",
      metaName: "description",
      metaContent: "unexpected",
      moduleName: "edit/EditMetaModule"
    },
    {
      action: "WikiPageAction",
      event: "deleteMetaTag",
      pageId: "1469127852",
      metaName: "description",
      allPages: "false",
      moduleName: "edit/EditMetaModule"
    }
  ]
  for (const form of forms) {
    const response = await handleAjaxModuleConnectorRequest(request(form), guarded)
    assert.equal((await response.json()).status, "not_ok")
  }

  const duplicate = await handleAjaxModuleConnectorRequest(
    new Request("http://scp-wiki.local/ajax-module-connector.php", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "moduleName=edit%2FEditMetaModule&pageId=1469127852&pageId=1469127852"
    }),
    guarded
  )
  assert.equal(duplicate.status, 400)
  assert.equal(calls, 0)
})
