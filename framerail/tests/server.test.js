import { strict as assert } from "node:assert"
import test from "node:test"

import { createFramerailHttpServer } from "../server.ts"
import { createStartupReadiness } from "../startup-readiness.ts"

const listen = async (server) => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.equal(typeof address, "object")
  return `http://127.0.0.1:${address.port}`
}

test("Framerail HTTP server delegates requests and closes its fence cache", async () => {
  let fenceCacheCloseCount = 0
  let resourceCloseCount = 0
  const lifecycle = createFramerailHttpServer({
    fastPathHandler: async (_request, response) => {
      response.statusCode = 204
      response.end()
    },
    fenceCache: {
      close: () => {
        fenceCacheCloseCount += 1
      }
    },
    closeResources: () => {
      resourceCloseCount += 1
    }
  })
  const baseUrl = await listen(lifecycle.server)

  const response = await fetch(baseUrl)
  assert.equal(response.status, 204)

  lifecycle.closeServer()
  assert.equal(fenceCacheCloseCount, 1)
  assert.equal(resourceCloseCount, 1)
})

test("Framerail HTTP server turns handler failures into 500 responses", async (t) => {
  const lifecycle = createFramerailHttpServer({
    fastPathHandler: async () => {
      throw new Error("fast path failed")
    },
    fenceCache: { close: () => {} }
  })
  t.after(lifecycle.closeServer)
  const baseUrl = await listen(lifecycle.server)

  const response = await fetch(baseUrl)
  assert.equal(response.status, 500)
  assert.equal(await response.text(), "fast path failed")
})

test("startup blocks even a warm response cache until the dependency is ready", async (t) => {
  let allow = false
  let calls = 0
  const readiness = createStartupReadiness({ probe: async () => allow })
  const lifecycle = createFramerailHttpServer({
    readiness,
    fenceCache: { close: () => {} },
    fastPathHandler: async (_request, response) => {
      calls += 1
      response.end("application")
    }
  })
  t.after(lifecycle.closeServer)
  const url = await listen(lifecycle.server)
  for (const path of ["/", "/-/startup-ready"]) {
    const response = await fetch(url + path)
    assert.equal(response.status, 503)
    assert.equal(response.headers.get("cache-control"), "no-store")
    assert.equal(await response.text(), "Wikijump is starting\n")
  }
  assert.equal(calls, 0)
  allow = true
  await readiness.start()
  assert.equal((await fetch(`${url}/-/startup-ready`)).status, 200)
  assert.equal(calls, 0)
  assert.equal(await (await fetch(url)).text(), "application")
  assert.equal(calls, 1)
})

test("startup retries unavailable dependencies with capped backoff without exiting", async () => {
  let attempts = 0
  const delays = []
  const readiness = createStartupReadiness({
    probe: async () => {
      attempts += 1
      if (attempts < 8) throw new Error("unavailable")
      return true
    },
    sleep: async (duration) => delays.push(duration),
    random: () => 0
  })
  await readiness.start()
  assert.equal(readiness.isReady(), true)
  assert.deepEqual(delays, [50, 100, 200, 400, 500, 500, 500])
  readiness.close()
})

test("shutdown cannot promote a pending startup probe to ready", async () => {
  let release
  const readiness = createStartupReadiness({
    probe: () =>
      new Promise((resolve) => {
        release = resolve
      })
  })
  const pending = readiness.start()
  readiness.close()
  release(true)
  await pending
  assert.equal(readiness.isReady(), false)
})
