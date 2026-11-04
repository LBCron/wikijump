import assert from "node:assert/strict"
import test from "node:test"

import { handleAjaxModuleConnectorRequest } from "../src/lib/server/ajax-module-connector.ts"

const request = (form, options = {}) =>
  new Request("http://scp-wiki.local/ajax-module-connector.php", {
    method: options.method ?? "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(form.wikidot_token7 !== undefined
        ? { cookie: `wikidot_token7=${form.wikidot_token7}` }
        : {}),
      ...(options.headers ?? {})
    },
    body: options.method === "GET" ? undefined : new URLSearchParams(form)
  })

const withoutTimestamp = (body) => {
  assert.equal(typeof body.CURRENT_TIMESTAMP, "number")
  const { CURRENT_TIMESTAMP, ...rest } = body
  return rest
}

test("edit open grants a lease with the acquisition base (probe P4 shape)", async () => {
  const calls = []
  const response = await handleAjaxModuleConnectorRequest(
    request({
      page_id: "1469768474",
      mode: "page",
      wiki_page: "tla-p4-main",
      moduleName: "edit/PageEditModule"
    }),
    {
      siteId: 6000006,
      openPageEdit: async (input) => {
        calls.push(input)
        return {
          granted: true,
          lockId: 85076288,
          lockSecret: "grant-secret",
          baseRevisionId: 1547973327,
          timeLeft: 900,
          source: "Probe page for edit-lock protocol tests."
        }
      }
    }
  )

  const body = withoutTimestamp(await response.json())
  assert.equal(body.status, "ok")
  assert.equal(body.mode, "page")
  assert.equal(body.lock_id, 85076288)
  assert.equal(body.lock_secret, "grant-secret")
  assert.equal(body.page_revision_id, 1547973327)
  assert.equal(body.timeLeft, 900)
  assert.equal(body.callbackIndex, null)
  assert.deepEqual(body.cssInclude, [])
  assert.equal(body.jsInclude.length, 1)
  assert.ok(body.jsInclude[0].endsWith("edit/PageEditModule.js"))
  assert.ok(body.body.includes("Probe page for edit-lock protocol tests."))
  assert.deepEqual(calls, [
    {
      siteId: 6000006,
      pageId: 1469768474,
      slug: "tla-p4-main",
      mode: "page",
      force: false
    }
  ])
})

test("edit open reports the conflict with holder, mode and remaining seconds", async () => {
  const response = await handleAjaxModuleConnectorRequest(
    request({
      page_id: "1469768474",
      mode: "page",
      wiki_page: "tla-p4-main",
      moduleName: "edit/PageEditModule"
    }),
    {
      siteId: 6000006,
      openPageEdit: async () => ({
        granted: false,
        timeLeft: 781,
        conflicts: [{ userId: 8955132, mode: "page", secondsRemaining: 781 }]
      })
    }
  )

  const body = withoutTimestamp(await response.json())
  assert.equal(body.status, "ok")
  assert.equal(body.mode, "page")
  assert.equal(body.locked, true)
  assert.equal(body.timeLeft, 781)
  assert.equal(body.lock_id, undefined)
  assert.ok(body.body.includes("Page lock conflict"))
  assert.ok(body.body.includes("8955132"))
  assert.ok(body.body.includes("Lock mode: page"))
  assert.ok(body.body.includes("781 seconds"))
})

test("edit open passes force_lock and section coordinates through", async () => {
  const calls = []
  const response = await handleAjaxModuleConnectorRequest(
    request({
      page_id: "1469768477",
      mode: "section",
      section: "1",
      wiki_page: "tla-p4-modes",
      moduleName: "edit/PageEditModule",
      force_lock: "yes"
    }),
    {
      siteId: 6000006,
      openPageEdit: async (input) => {
        calls.push(input)
        return {
          granted: true,
          lockId: 85076298,
          lockSecret: "section-secret",
          baseRevisionId: 1547973336,
          timeLeft: 900,
          rangeStart: 5,
          rangeEnd: 7,
          source: "+ Bravo heading\nbravo body v0"
        }
      }
    }
  )

  const body = withoutTimestamp(await response.json())
  assert.equal(body.status, "ok")
  assert.equal(body.mode, "section")
  assert.equal(body.section, 1)
  assert.equal(body.rangeStart, 5)
  assert.equal(body.rangeEnd, 7)
  assert.equal(body.lock_id, 85076298)
  assert.deepEqual(calls, [
    {
      siteId: 6000006,
      pageId: 1469768477,
      slug: "tla-p4-modes",
      mode: "section",
      sectionIndex: 1,
      force: true
    }
  ])
})

test("edit open fails closed outside the probed request shape", async () => {
  const canonical = {
    page_id: "1469768474",
    mode: "page",
    wiki_page: "tla-p4-main",
    moduleName: "edit/PageEditModule"
  }
  const invalid = [
    { ...canonical, mode: "chapter" },
    { ...canonical, mode: "section" },
    { ...canonical, section: "1" },
    { ...canonical, force_lock: "please" },
    { ...canonical, extra: "unsupported" },
    { ...canonical, page_id: "0" }
  ]
  let calls = 0
  for (const form of invalid) {
    const response = await handleAjaxModuleConnectorRequest(request(form), {
      siteId: 6000006,
      openPageEdit: async () => {
        calls += 1
        assert.fail("invalid edit open shapes must fail before the lease")
      }
    })
    assert.equal((await response.json()).status, "not_ok")
  }
  assert.equal(calls, 0)

  const missingDependency = await handleAjaxModuleConnectorRequest(request(canonical), {
    siteId: 6000006
  })
  assert.equal((await missingDependency.json()).status, "not_ok")
})

const SAVE_FORM = {
  action: "WikiPageAction",
  event: "savePage",
  moduleName: "Empty",
  mode: "page",
  lock_id: "85077215",
  lock_secret: "p4-save-secret",
  revision_id: "1547974336",
  wiki_page: "tla-p4b-fmain",
  page_id: "1469768480",
  title: "TLA P4 tla-p4b-fmain",
  source: "Release probe page.\n\nmarker-f-v1",
  comments: "F1-A-second-save-same-lock",
  wikidot_token7: "client-token"
}

test("savePage commits and reports lockRecreated (probe F1 shape)", async () => {
  const calls = []
  const response = await handleAjaxModuleConnectorRequest(request(SAVE_FORM), {
    siteId: 6000006,
    savePage: async (input) => {
      calls.push(input)
      return { outcome: "commit", revisionId: 1547974341, lockRecreated: true }
    }
  })

  assert.deepEqual(await response.json(), {
    status: "ok",
    timeLeft: 900,
    revisionId: 1547974341,
    lockRecreated: true
  })
  assert.deepEqual(calls, [
    {
      siteId: 6000006,
      pageId: 1469768480,
      slug: "tla-p4b-fmain",
      mode: "page",
      lockId: 85077215,
      lockSecret: "p4-save-secret",
      revisionId: "1547974336",
      title: "TLA P4 tla-p4b-fmain",
      wikitext: "Release probe page.\n\nmarker-f-v1",
      comments: "F1-A-second-save-same-lock"
    }
  ])
})

test("savePage maps the typed outcomes onto the noLockError envelope", async () => {
  const changed = await handleAjaxModuleConnectorRequest(request(SAVE_FORM), {
    siteId: 6000006,
    savePage: async () => ({ outcome: "page_changed" })
  })
  assert.deepEqual(await changed.json(), {
    status: "ok",
    noLockError: "page_changed",
    nonrecoverable: true
  })

  const otherLocks = await handleAjaxModuleConnectorRequest(request(SAVE_FORM), {
    siteId: 6000006,
    savePage: async () => ({ outcome: "other_locks" })
  })
  assert.deepEqual(await otherLocks.json(), {
    status: "ok",
    noLockError: "other_locks"
  })
})

test("savePage without lock parameters takes the plain edit path", async () => {
  const { lock_id, lock_secret, ...form } = SAVE_FORM
  const calls = []
  const response = await handleAjaxModuleConnectorRequest(request(form), {
    siteId: 6000006,
    savePage: async (input) => {
      calls.push(input)
      return { outcome: "commit", revisionId: 1547974341, lockRecreated: false }
    }
  })

  assert.deepEqual(await response.json(), {
    status: "ok",
    timeLeft: 900,
    revisionId: 1547974341
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].lockId, undefined)
  assert.equal(calls[0].lockSecret, undefined)
})

test("savePage against a deleted page is a bare not_ok (probe H shape)", async () => {
  const originalConsoleError = console.error
  console.error = () => {}
  try {
    const response = await handleAjaxModuleConnectorRequest(request(SAVE_FORM), {
      siteId: 6000006,
      savePage: async () => {
        throw new Error("failed to edit page, page does not exist")
      }
    })
    assert.deepEqual(await response.json(), { status: "not_ok" })
  } finally {
    console.error = originalConsoleError
  }
})

test("savePage fails closed for half a lock and unknown fields", async () => {
  const { lock_secret, ...noSecret } = SAVE_FORM
  const { lock_id, ...noId } = SAVE_FORM
  const invalid = [
    noSecret,
    noId,
    { ...SAVE_FORM, lock_id: "0" },
    { ...SAVE_FORM, revision_id: "-1" },
    { ...SAVE_FORM, mode: "section" },
    { ...SAVE_FORM, extra: "unsupported" }
  ]
  let calls = 0
  for (const form of invalid) {
    const response = await handleAjaxModuleConnectorRequest(request(form), {
      siteId: 6000006,
      savePage: async () => {
        calls += 1
        assert.fail("invalid savePage shapes must fail before Deepwell")
      }
    })
    assert.equal((await response.json()).status, "not_ok")
  }
  assert.equal(calls, 0)
})

const SYNC_FORM = {
  moduleName: "Empty",
  action: "WikiPageAction",
  event: "synchronize",
  mode: "page",
  wiki_page: "tla-p4-expiry-x",
  lock_id: "85076288",
  lock_secret: "sync-secret",
  revision_id: "1547973327",
  page_id: "1469768475",
  title: "TLA P4 tla-p4-expiry-x",
  source: "Expiry probe page.",
  comments: "",
  since_last_input: "30",
  wikidot_token7: "client-token"
}

test("synchronize renews the lease and reports timeLeft (probe P4-X shape)", async () => {
  const renewals = []
  const response = await handleAjaxModuleConnectorRequest(request(SYNC_FORM), {
    siteId: 6000006,
    savePageDraft: async () => {},
    renewPageEditLock: async (input) => {
      renewals.push(input)
      return { timeLeft: 870, lockRecreated: false }
    }
  })

  assert.deepEqual(await response.json(), {
    status: "ok",
    savedDraft: true,
    timeLeft: 870
  })
  assert.deepEqual(renewals, [
    {
      siteId: 6000006,
      pageId: 1469768475,
      slug: "tla-p4-expiry-x",
      lockId: 85076288,
      lockSecret: "sync-secret",
      mode: "page"
    }
  ])
})

test("synchronize on an expired lease reports the re-created credentials (probe E3 shape)", async () => {
  const response = await handleAjaxModuleConnectorRequest(request(SYNC_FORM), {
    siteId: 6000006,
    savePageDraft: async () => {},
    renewPageEditLock: async () => ({
      timeLeft: 870,
      lockRecreated: true,
      lockId: 85077398,
      lockSecret: "recreated-secret"
    })
  })

  assert.deepEqual(await response.json(), {
    status: "ok",
    lockRecreated: true,
    lockId: 85077398,
    lockSecret: "recreated-secret",
    timeLeft: 870
  })
})

test("synchronize on a superseded lease reports other_locks (probe E-sync shape)", async () => {
  const response = await handleAjaxModuleConnectorRequest(request(SYNC_FORM), {
    siteId: 6000006,
    savePageDraft: async () => {},
    renewPageEditLock: async () => ({ noLockError: "other_locks" })
  })

  assert.deepEqual(await response.json(), {
    status: "ok",
    noLockError: "other_locks"
  })
})

test("removePageEditLock releases the lease for both leave_draft values", async () => {
  const releases = []
  const removals = []
  const base = {
    moduleName: "Empty",
    action: "WikiPageAction",
    event: "removePageEditLock",
    wiki_page: "tla-p4b-fmain",
    lock_id: "85077215",
    lock_secret: "remove-secret",
    page_id: "1469768480",
    wikidot_token7: "client-token"
  }
  for (const leaveDraft of ["true", "false"]) {
    const response = await handleAjaxModuleConnectorRequest(
      request({ ...base, leave_draft: leaveDraft }),
      {
        siteId: 6000006,
        removePageDraft: async (input) => removals.push(input),
        releasePageEditLock: async (input) => releases.push(input)
      }
    )
    assert.deepEqual(await response.json(), { status: "ok" })
  }
  assert.equal(removals.length, 1)
  assert.deepEqual(releases, [
    {
      siteId: 6000006,
      pageId: 1469768480,
      slug: "tla-p4b-fmain",
      lockId: 85077215,
      lockSecret: "remove-secret"
    },
    {
      siteId: 6000006,
      pageId: 1469768480,
      slug: "tla-p4b-fmain",
      lockId: 85077215,
      lockSecret: "remove-secret"
    }
  ])
})

test("renamePage under a live lease is ok with locks: true and renames nothing (probe P8 shape)", async () => {
  const calls = []
  const form = {
    action: "WikiPageAction",
    event: "renamePage",
    moduleName: "Empty",
    page_id: "1469768483",
    new_name: "tla-p4-p8renamed",
    wikidot_token7: "client-token"
  }
  const blocked = await handleAjaxModuleConnectorRequest(request(form), {
    siteId: 6000006,
    renamePage: async (input) => {
      calls.push(input)
      return { locks: true }
    }
  })
  const blockedBody = await blocked.json()
  assert.equal(blockedBody.status, "ok")
  assert.equal(blockedBody.locks, true)
  assert.ok(blockedBody.body.includes("The page is being edited..."))
  assert.deepEqual(calls, [
    { siteId: 6000006, pageId: 1469768483, newName: "tla-p4-p8renamed" }
  ])

  const renamed = await handleAjaxModuleConnectorRequest(request(form), {
    siteId: 6000006,
    renamePage: async () => ({ locks: false })
  })
  assert.deepEqual(await renamed.json(), { status: "ok" })

  const invalid = await handleAjaxModuleConnectorRequest(
    request({ ...form, new_name: "" }),
    {
      siteId: 6000006,
      renamePage: async () => {
        assert.fail("invalid renamePage shapes must fail before Deepwell")
      }
    }
  )
  assert.equal((await invalid.json()).status, "not_ok")
})
