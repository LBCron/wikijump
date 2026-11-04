import assert from "node:assert/strict"
import test from "node:test"

import { createByteLimitedCache } from "../src/lib/server/cache/article-response/byte-limited-cache.ts"
import { RedisRequestQueue } from "../src/lib/server/cache/redis-request-queue.ts"
import { RedisResponseDecoder } from "../src/lib/server/cache/redis-response-decoder.ts"
import { parseRedisResponse } from "../src/lib/server/cache/redis-protocol.ts"
import { createRedisCacheStore } from "../src/lib/server/cache/redis-store.ts"
import { RedisFenceInvalidationSubscriber } from "../src/lib/server/cache/redis-subscriber.ts"
import {
  createRedisCommandState,
  resetRedisCommandState,
  writeRedisCommand
} from "../src/lib/server/cache/redis-command-state.ts"

test("indexed expiry matches full-scan FIFO/LRU under replacement, eviction and clock changes", () => {
  for (const touchOnRead of [false, true]) {
    let now = 0
    const actual = createByteLimitedCache({
      now: () => now,
      maxEntries: 31,
      maxBytes: 99,
      touchOnRead
    })
    const expected = new Map<
      string,
      { value: number; bytes: number; expiresAt: number }
    >()
    let seed = 421
    const random = (limit: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % limit
    }
    const getExpected = (key: string) => {
      const entry = expected.get(key)
      if (!entry) return null
      if (entry.expiresAt <= now) {
        expected.delete(key)
        return null
      }
      if (touchOnRead) {
        expected.delete(key)
        expected.set(key, entry)
      }
      return entry.value
    }
    for (let i = 0; i < 20000; i += 1) {
      const key = `key-${random(71)}`
      const action = random(12)
      if (action < 7) {
        const bytes = random(120)
        const expiresAt = [now + random(100), now - 1, Infinity, NaN][random(4)]
        for (const [key, entry] of expected) {
          if (entry.expiresAt <= now) expected.delete(key)
        }
        expected.delete(key)
        let accepted = false
        if (!(expiresAt <= now || bytes > 99)) {
          expected.set(key, { value: i, bytes, expiresAt })
          let total = [...expected.values()].reduce((sum, row) => sum + row.bytes, 0)
          while (expected.size > 31 || total > 99) {
            const oldest = expected.keys().next().value!
            total -= expected.get(oldest)!.bytes
            expected.delete(oldest)
          }
          accepted = expected.has(key)
        }
        assert.equal(actual.insert(key, i, bytes, expiresAt), accepted)
      } else if (action === 7) {
        actual.delete(key)
        expected.delete(key)
      } else if (action === 8) now += random(20) - 5
      else if (action === 9 && i % 31 === 0) {
        actual.clear()
        expected.clear()
      } else assert.equal(actual.get(key), getExpected(key))
      assert.equal(actual.size(), expected.size)
      if (i % 50 === 0) {
        for (let k = 0; k < 71; k += 1) {
          assert.equal(actual.get(`key-${k}`), getExpected(`key-${k}`))
        }
      }
    }
  }
})

test("Redis FIFO supports middle/tail cancellation and inactive handles without reordering", () => {
  const queue = new RedisRequestQueue()
  const handles = Array.from({ length: 10000 }, (_, i) => queue.push(i))
  for (let i = 1; i < handles.length; i += 2) queue.remove(handles[i])
  for (let i = 0; i < handles.length; i += 2) assert.equal(queue.shift(), i)
  assert.equal(queue.length, 0)
  queue.push("next")
  for (const handle of handles) queue.remove(handle)
  assert.equal(queue.shift(), "next")
  assert.equal(queue.shift(), undefined)
  assert.equal(queue.head, null)
  assert.equal(queue.tail, null)
})

test("incremental RESP preserves complete-parser semantics at every split including UTF-8 and CRLF", () => {
  const wire = Buffer.from(
    "*5\r\n+OK\r\n:42\r\n$6\r\n日本\r\n*-1\r\n*2\r\n$0\r\n\r\n*0\r\n+tail\r\n"
  )
  const expected = parseRedisResponse(wire)!
  for (let split = 0; split <= wire.length; split += 1) {
    const decoder = new RedisResponseDecoder()
    const received = []
    for (const chunk of [wire.subarray(0, split), wire.subarray(split)]) {
      decoder.append(chunk)
      for (let row; (row = decoder.read());) received.push(row.value)
    }
    assert.deepEqual(received, [expected.value, "tail"], `split ${split}`)
  }
  const decoder = new RedisResponseDecoder()
  const received = []
  for (const byte of wire) {
    decoder.append(Buffer.from([byte]))
    for (let row; (row = decoder.read());) received.push(row.value)
  }
  assert.deepEqual(received, [expected.value, "tail"])
})

test("incremental RESP handles long lines, bulk strings, arrays and deep nesting", () => {
  for (const wire of [
    Buffer.from(`+${"a".repeat(10000)}\r\n`),
    Buffer.from(`$10000\r\n${"b".repeat(10000)}\r\n`),
    Buffer.from(`*10000\r\n${":1\r\n".repeat(10000)}`)
  ]) {
    const decoder = new RedisResponseDecoder()
    for (let offset = 0; offset < wire.length; offset += 13) {
      decoder.append(wire.subarray(offset, offset + 13))
      const row = decoder.read()
      if (offset + 13 < wire.length) assert.equal(row, null)
      else assert.deepEqual(row!.value, parseRedisResponse(wire)!.value)
    }
  }
  const decoder = new RedisResponseDecoder()
  decoder.append(Buffer.from(`${"*1\r\n".repeat(20000)}:7\r\n`))
  let value = decoder.read()!.value
  for (let i = 0; i < 20000; i += 1) {
    assert.equal((value as unknown[]).length, 1)
    value = (value as unknown[])[0] as typeof value
  }
  assert.equal(value, 7)
})

test("incremental RESP rejects the same errors, including errors after partial arrays", () => {
  for (const wire of [
    "-ERR broken\r\n",
    "$nope\r\n",
    "*-2\r\n",
    "?wat\r\n",
    "*2\r\n:1\r\n-ERR nested\r\n"
  ]) {
    let expected: string | undefined
    try {
      parseRedisResponse(Buffer.from(wire))
    } catch (error) {
      expected = (error as Error).message
    }
    const decoder = new RedisResponseDecoder()
    for (const byte of Buffer.from(wire).subarray(0, -1)) {
      decoder.append(Buffer.from([byte]))
      assert.equal(decoder.read(), null)
    }
    decoder.append(Buffer.from("\n"))
    assert.throws(() => decoder.read(), { message: expected })
  }
})

test("store drains fragmented pipelines in order and fails all pending commands on malformed RESP", async () => {
  const store = createRedisCacheStore("redis://localhost")!
  store.commandState.socket = {
    destroyed: false,
    write() {},
    destroy(this: { destroyed: boolean }) {
      this.destroyed = true
    }
  } as never
  const pending = Array.from({ length: 3000 }, (_, i) => store.writeCommand(["GET", i]))
  const wire = Buffer.from(Array.from({ length: 3000 }, (_, i) => `:${i}\r\n`).join(""))
  for (let offset = 0; offset < wire.length; offset += 37) {
    store.handleData(wire.subarray(offset, offset + 37))
  }
  assert.deepEqual(
    await Promise.all(pending),
    Array.from({ length: 3000 }, (_, i) => i)
  )
  const first = store.writeCommand(["GET", "one"])
  const second = store.writeCommand(["GET", "two"])
  store.handleData(Buffer.from("?bad\r\n"))
  await assert.rejects(first, /unsupported Redis response type/)
  await assert.rejects(second, /Redis connection closed/)
  assert.equal(store.pending.length, 0)
})

test("subscriber delivers fragmented messages and fails closed on parser errors", () => {
  const subscriber = new RedisFenceInvalidationSubscriber("redis://localhost", [])
  subscriber.channel = "channel"
  const received: string[] = []
  let malformed = 0
  let disconnected = 0
  subscriber.onMessage = (value) => received.push(value)
  subscriber.onMalformed = () => {
    malformed += 1
  }
  subscriber.onDisconnect = () => {
    disconnected += 1
  }
  const wire = Buffer.from("*3\r\n+message\r\n+channel\r\n+payload\r\n")
  for (const byte of wire) subscriber.handleData(Buffer.from([byte]))
  assert.deepEqual(received, ["payload"])
  subscriber.handleData(Buffer.from("$invalid\r\n"))
  assert.equal(malformed, 1)
  assert.equal(disconnected, 1)
})

test("late write failure on a reset connection cannot remove a new pending request", async () => {
  const state = createRedisCommandState()
  let callback: ((error: Error) => void) | undefined
  const socket = {
    destroyed: false,
    write(_command: string, _encoding: string, cb: (error: Error) => void) {
      callback = cb
    },
    destroy() {
      this.destroyed = true
    }
  }
  state.socket = socket as never
  const options = {
    state,
    parts: ["GET", "key"],
    timeoutMs: 1000,
    unavailableMessage: "unavailable",
    timeoutMessage: "timeout",
    onTimeout() {}
  }
  const first = writeRedisCommand(options)
  const oldCallback = callback
  resetRedisCommandState(state, "closed")
  await assert.rejects(first, /closed/)
  state.socket = { ...socket, destroyed: false } as never
  const second = writeRedisCommand(options)
  oldCallback!(new Error("late failure"))
  assert.equal(state.pending.length, 1)
  state.pending.shift()!.resolve("new value")
  assert.equal(await second, "new value")
  resetRedisCommandState(state, "closed")
})
