import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import test from "node:test"

import { buildPublicContentFenceKey } from "../src/lib/server/cache/article-response/index.ts"
import { getArticleResponseCacheStores } from "../src/lib/server/cache/article-response/runtime.ts"
import { createFramerailServerRuntime } from "../server.js"
import {
  createFastPathFixtureStore,
  createFenceSubscriber,
  fastPathHeaders,
  fetch as rawFetch
} from "./article-response-fast-path/helpers.js"

const readDockerfile = (tier) =>
  readFileSync(
    new URL(`../../install/${tier}/framerail/Dockerfile`, import.meta.url),
    "utf8"
  )

test("Framerail container entrypoints run server.js and retain runtime sources", () => {
  for (const tier of ["prod", "dev"]) {
    const dockerfile = readDockerfile(tier)

    assert.match(
      dockerfile,
      /^CMD \["\/usr\/local\/bin\/node", "server\.js"\]$/m,
      `${tier} image must start the cache-owning server`
    )
    assert.doesNotMatch(
      dockerfile,
      /rm -rf[^\n]*\bsrc\//,
      `${tier} image must retain server runtime sources`
    )
  }
})

const listen = async (server) => {
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.equal(typeof address, "object")
  return `http://127.0.0.1:${address.port}`
}

const closeRuntime = async (runtime) => {
  await new Promise((resolve, reject) => {
    runtime.server.once("close", resolve)
    runtime.closeServer()
    runtime.server.once("error", reject)
  })
}

test("production-like server construction wires cache stores through hit and invalidation", async () => {
  const previousNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = "production"
  const fixture = await createFastPathFixtureStore()
  const subscriber = createFenceSubscriber()
  const stores = {
    responseStore: fixture.responseStore,
    tokenStore: {
      get: (key) => fixture.tokenStore.get(key),
      set: (key, value, ttlSeconds) => fixture.tokenStore.set(key, value, ttlSeconds),
      subscribe: (callbacks) => subscriber.subscribe(callbacks)
    }
  }
  let handlerCalls = 0
  const runtime = createFramerailServerRuntime({
    cacheStores: stores,
    handler: (_request, response) => {
      handlerCalls += 1
      response.statusCode = 209
      response.end(`authoritative response ${handlerCalls}`)
    }
  })

  try {
    assert.equal(getArticleResponseCacheStores(), stores)
    subscriber.callbacks.onSubscribed()
    const baseUrl = await listen(runtime.server)

    const cached = await rawFetch(`${baseUrl}/scp-173`, { headers: fastPathHeaders })
    assert.equal(cached.status, 200)
    assert.equal(
      await cached.text(),
      "<!doctype html><html><body>cached article</body></html>"
    )
    assert.equal(handlerCalls, 0)

    for (const request of [
      { path: "/scp-173?draft=1" },
      {
        path: "/scp-173",
        headers: { ...fastPathHeaders, cookie: "wikijump_token=session" }
      },
      { path: "/scp-173", method: "POST" },
      { path: "/scp-173/comments" },
      { path: "/about" },
      { path: "/scp-173/__data.json?x-sveltekit-invalidated=01" }
    ]) {
      const response = await rawFetch(`${baseUrl}${request.path}`, {
        method: request.method,
        headers: { ...fastPathHeaders, ...request.headers }
      })
      assert.equal(response.status, 209, request.path)
      assert.equal(await response.text(), `authoritative response ${handlerCalls}`)
    }
    assert.equal(handlerCalls, 6)

    await stores.tokenStore.set(buildPublicContentFenceKey(6000005), "8")
    subscriber.callbacks.onMessage(
      JSON.stringify({ type: "public-content", site_id: 6000005, version: "8" })
    )
    const invalidated = await rawFetch(`${baseUrl}/scp-173`, { headers: fastPathHeaders })
    assert.equal(invalidated.status, 209)
    assert.equal(await invalidated.text(), "authoritative response 7")
    assert.equal(handlerCalls, 7)
  } finally {
    await closeRuntime(runtime)
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  }
})

test("cache store outages leave the authoritative production handler available", async () => {
  const previousNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = "production"
  const runtime = createFramerailServerRuntime({
    cacheStores: { responseStore: null, tokenStore: null },
    handler: (_request, response) => {
      response.statusCode = 200
      response.end("fresh authoritative response")
    }
  })

  try {
    assert.deepEqual(getArticleResponseCacheStores(), {
      responseStore: null,
      tokenStore: null
    })
    const baseUrl = await listen(runtime.server)
    const response = await rawFetch(`${baseUrl}/scp-173`, { headers: fastPathHeaders })
    assert.equal(response.status, 200)
    assert.equal(await response.text(), "fresh authoritative response")
  } finally {
    await closeRuntime(runtime)
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = previousNodeEnv
  }
})
