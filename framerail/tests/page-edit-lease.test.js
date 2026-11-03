import { strict as assert } from "node:assert"
import test from "node:test"

import {
  WikidotEditLeaseSession,
  classifyEditLeaseSaveError,
  createEditLeaseTransport
} from "../src/lib/wikidot/wikidot-edit-lease.js"

const grantOutput = (overrides = {}) => ({
  grant: {
    lock_id: 85076288,
    lock_secret: "grant-secret",
    base_revision_id: 1547973327,
    expires_at: new Date(Date.now() + 900_000).toISOString(),
    ...overrides
  },
  conflicts: []
})

const conflictOutput = () => ({
  grant: null,
  conflicts: [
    {
      user_id: 8955132,
      mode: "page",
      section_index: null,
      seconds_remaining: 781
    }
  ]
})

/** @param {any} [handlers] */
const recordingTransport = (handlers = {}) => {
  /** @type {any[]} */
  const calls = []
  return {
    calls,
    acquire: /** @param {any} request */ async (request) => {
      calls.push({ kind: "acquire", request })
      return handlers.acquire ? handlers.acquire(request) : grantOutput()
    },
    renew: /** @param {any} credentials */ async (credentials) => {
      calls.push({ kind: "renew", credentials })
      return handlers.renew
        ? handlers.renew(credentials)
        : {
            lock_id: credentials.lockId,
            lock_secret: credentials.lockSecret,
            base_revision_id: 1547973327,
            lock_recreated: false,
            expires_at: new Date(Date.now() + 900_000).toISOString()
          }
    },
    release: /** @param {any} credentials */ async (credentials) => {
      calls.push({ kind: "release", credentials })
      return handlers.release ? handlers.release(credentials) : true
    }
  }
}

test("acquire on open stores the credentials, base and expiry", async () => {
  const transport = recordingTransport()
  const session = new WikidotEditLeaseSession(transport)

  const status = await session.open("page", undefined)

  assert.equal(status, "held")
  assert.equal(session.status, "held")
  assert.equal(session.lockId, 85076288)
  assert.equal(session.lockSecret, "grant-secret")
  assert.equal(session.baseRevisionId, 1547973327)
  assert.ok(session.secondsRemaining() > 890)
  assert.deepEqual(transport.calls, [
    { kind: "acquire", request: { force: false, mode: "page", sectionIndex: undefined } }
  ])
})

test("conflict on open carries holder, mode and remaining seconds; force path grants", async () => {
  let attempt = 0
  const transport = recordingTransport({
    acquire: async () => {
      attempt += 1
      return attempt === 1 ? conflictOutput() : grantOutput()
    }
  })
  const session = new WikidotEditLeaseSession(transport)

  const status = await session.open("page", undefined)

  assert.equal(status, "conflict")
  assert.equal(session.held, false)
  const rows = session.conflictRows(session.conflictsAt + 61_000)
  assert.deepEqual(rows, [
    { userId: 8955132, mode: "page", sectionIndex: null, secondsRemaining: 720 }
  ])
  assert.equal(session.secondsRemaining(session.conflictsAt + 61_000), 720)

  const forced = await session.forceOpen()

  assert.equal(forced, "held")
  assert.equal(session.lockId, 85076288)
  assert.deepEqual(transport.calls[1], {
    kind: "acquire",
    request: { force: true, mode: "page", sectionIndex: undefined }
  })
})

test("section open passes the section index through to acquisition", async () => {
  const transport = recordingTransport()
  const session = new WikidotEditLeaseSession(transport)

  await session.open("section", 3)

  assert.deepEqual(transport.calls[0].request, {
    force: false,
    mode: "section",
    sectionIndex: 3
  })
  assert.equal(/** @type {any} */ (session.saveFields()).sectionIndex, 3)
})

test("save fields are a snapshot of the session state at submit time", async () => {
  const transport = recordingTransport()
  const session = new WikidotEditLeaseSession(transport)
  await session.open("page", undefined)

  const fields = session.saveFields()
  session.baseRevisionId = 999999
  session.lockSecret = "rotated-elsewhere"

  assert.deepEqual(fields, {
    lockId: 85076288,
    lockSecret: "grant-secret",
    mode: "page",
    sectionIndex: undefined,
    lastRevisionId: 1547973327
  })
})

test("renew extends the expiry and adopts re-created credentials and base", async () => {
  const renewedExpiry = new Date(Date.now() + 800_000).toISOString()
  const transport = recordingTransport({
    renew: async () => ({
      lock_id: 85076300,
      lock_secret: "recreated-secret",
      base_revision_id: 1547973400,
      lock_recreated: true,
      expires_at: renewedExpiry
    })
  })
  const session = new WikidotEditLeaseSession(transport)
  await session.open("page", undefined)

  const ok = await session.renew()

  assert.equal(ok, true)
  assert.equal(session.status, "held")
  assert.equal(session.lockId, 85076300)
  assert.equal(session.lockSecret, "recreated-secret")
  assert.equal(session.baseRevisionId, 1547973400)
  assert.equal(session.expiresAt, renewedExpiry)
  assert.deepEqual(transport.calls[1].credentials, {
    lockId: 85076288,
    lockSecret: "grant-secret",
    mode: "page",
    sectionIndex: undefined
  })
})

test("renew rejected with 4304 surfaces the superseded state", async () => {
  const transport = recordingTransport({
    renew: async () => {
      throw Object.assign(new Error("conflict"), { code: 4304 })
    }
  })
  const session = new WikidotEditLeaseSession(transport)
  await session.open("page", undefined)

  const ok = await session.renew()

  assert.equal(ok, false)
  assert.equal(session.status, "superseded")
  assert.equal(session.held, true)
})

test("renew without credentials is a no-op", async () => {
  const transport = recordingTransport()
  const session = new WikidotEditLeaseSession(transport)

  assert.equal(await session.renew(), false)
  assert.equal(transport.calls.length, 0)
})

test("save error classification selects the rejection dialog by code", () => {
  assert.equal(classifyEditLeaseSaveError(4303), "page_changed")
  assert.equal(classifyEditLeaseSaveError(4304), "other_locks")
  assert.equal(classifyEditLeaseSaveError(3106), null)
  assert.equal(classifyEditLeaseSaveError(undefined), null)
  assert.equal(classifyEditLeaseSaveError("4303"), null)
})

test("a successful save releases the lease; staying open re-acquires with the new base", async () => {
  let attempt = 0
  const transport = recordingTransport({
    acquire: async () => {
      attempt += 1
      return attempt === 1
        ? grantOutput()
        : grantOutput({ lock_id: 85076400, base_revision_id: 1547973350 })
    }
  })
  const session = new WikidotEditLeaseSession(transport)
  await session.open("page", undefined)

  const status = await session.afterSave(
    /** @type {any} */ ({
      revision_id: 1547973350,
      revision_number: 12,
      lock_recreated: false
    }),
    true
  )

  assert.equal(status, "held")
  assert.equal(session.lockId, 85076400)
  assert.equal(session.baseRevisionId, 1547973350)
  assert.equal(/** @type {any} */ (session.saveFields()).lastRevisionId, 1547973350)
  assert.equal(transport.calls.filter((call) => call.kind === "acquire").length, 2)
  assert.equal(transport.calls.filter((call) => call.kind === "release").length, 0)
})

test("a successful save without staying open does not re-acquire", async () => {
  const transport = recordingTransport()
  const session = new WikidotEditLeaseSession(transport)
  await session.open("page", undefined)

  const status = await session.afterSave({ revision_id: 1547973350 }, false)

  assert.equal(status, "released")
  assert.equal(session.held, false)
  assert.equal(session.baseRevisionId, 1547973350)
  assert.equal(transport.calls.filter((call) => call.kind === "acquire").length, 1)
})

test("close releases the held lease with its credentials", async () => {
  const transport = recordingTransport()
  const session = new WikidotEditLeaseSession(transport)
  await session.open("append", undefined)

  await session.close()

  assert.equal(session.status, "closed")
  assert.deepEqual(transport.calls[1], {
    kind: "release",
    credentials: {
      lockId: 85076288,
      lockSecret: "grant-secret",
      mode: "append",
      sectionIndex: undefined
    }
  })
})

test("close after a successful save does not release again", async () => {
  const transport = recordingTransport()
  const session = new WikidotEditLeaseSession(transport)
  await session.open("page", undefined)
  session.noteSaveSucceeded({ revision_id: 1547973350 })

  await session.close()

  assert.equal(transport.calls.filter((call) => call.kind === "release").length, 0)
})

test("a save rejected as other_locks marks the session superseded", async () => {
  const transport = recordingTransport()
  const session = new WikidotEditLeaseSession(transport)
  await session.open("page", undefined)

  session.noteSaveRejected(classifyEditLeaseSaveError(4304))

  assert.equal(session.status, "superseded")
})

test("transport posts to the lease actions with the held secret under its key", async () => {
  /** @type {any[]} */
  const posts = []
  const transport = createEditLeaseTransport(async (action, payload) => {
    posts.push({ action, payload })
    if (action === "editLockRenew") {
      return {
        lock_id: 85076288,
        lock_secret: "grant-secret",
        base_revision_id: 1547973327,
        lock_recreated: false,
        expires_at: new Date(Date.now() + 900_000).toISOString()
      }
    }
    if (action === "editLockRelease") return true
    return grantOutput()
  })
  const session = new WikidotEditLeaseSession(transport)

  await session.open("section", 2)
  await session.renew()
  await session.close()

  assert.deepEqual(posts, [
    { action: "editLockAcquire", payload: { mode: "section", sectionIndex: 2 } },
    {
      action: "editLockRenew",
      payload: {
        lockId: 85076288,
        lockSecret: "grant-secret",
        mode: "section",
        sectionIndex: 2
      }
    },
    {
      action: "editLockRelease",
      payload: { lockId: 85076288, lockSecret: "grant-secret" }
    }
  ])
})

test("transport force acquisition posts to the force action", async () => {
  /** @type {any[]} */
  const posts = []
  const transport = createEditLeaseTransport(async (action, payload) => {
    posts.push({ action, payload })
    return conflictOutput()
  })
  const session = new WikidotEditLeaseSession(transport)

  await session.open("page", undefined)
  await session.forceOpen()

  assert.deepEqual(
    posts.map((post) => post.action),
    ["editLockAcquire", "editLockForceAcquire"]
  )
})
