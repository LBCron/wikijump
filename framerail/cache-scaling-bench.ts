// Run from any directory: node framerail/cache-scaling-bench.ts [baseline-ref]
// Baseline modules come from Git, never from a second hand-maintained algorithm.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import { createByteLimitedCache } from "./src/lib/server/cache/article-response/byte-limited-cache.ts"
import { RedisRequestQueue } from "./src/lib/server/cache/redis-request-queue.ts"
import { RedisResponseDecoder } from "./src/lib/server/cache/redis-response-decoder.ts"

const baseline = process.argv[2] ?? "e0e40e49d146f5d71c463f8e15fd3ddb616b0f18"
const cwd = fileURLToPath(new URL("../", import.meta.url))
const loadBaseline = async (path: string) => {
  const source = execFileSync("git", ["show", `${baseline}:${path}`], {
    cwd,
    encoding: "utf8"
  })
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
}
const oldCache = (
  await loadBaseline(
    "framerail/src/lib/server/cache/article-response/byte-limited-cache.js"
  )
).createByteLimitedCache
const oldParse = (await loadBaseline("framerail/src/lib/server/cache/redis-protocol.js"))
  .parseRedisResponse
const medianMs = (fn: () => void) => {
  fn() // warm-up outside measurement
  const samples: number[] = []
  for (let i = 0; i < 5; i += 1) {
    const start = performance.now()
    fn()
    samples.push(performance.now() - start)
  }
  samples.sort((a, b) => a - b)
  return Number(samples[2].toFixed(3))
}
const records: Record<string, unknown>[] = []
const compare = (
  path: string,
  dimensions: Record<string, number>,
  before: () => void,
  after: () => void,
  work: Record<string, unknown> = {}
) => {
  const before_ms = medianMs(before)
  const after_ms = medianMs(after)
  const row: Record<string, unknown> = {
    path,
    ...dimensions,
    before_ms,
    after_ms,
    ...work
  }
  records.push(row)
  process.stderr.write(`${JSON.stringify(row)}\n`)
}

for (const Q of [2000, 4000, 8000, 16000]) {
  const fill = (create: typeof createByteLimitedCache) => {
    const cache = create({ now: () => 0, maxEntries: Q, maxBytes: Q })
    for (let i = 0; i < Q; i += 1) cache.insert(String(i), i, 1, Q - i)
    assert.equal(cache.size(), Q)
  }
  compare(
    "cache-fill",
    { Q, R_max: Q },
    () => fill(oldCache),
    () => fill(createByteLimitedCache),
    {
      before_expiry_visits: (Q * (Q - 1)) / 2
    }
  )
}
for (const Q of [16000, 32000, 64000, 128000]) {
  compare(
    "pending-drain",
    { Q },
    () => {
      const queue = Array.from({ length: Q }, (_, i) => i)
      for (let i = 0; i < Q; i += 1) assert.equal(queue.shift(), i)
    },
    () => {
      const queue = new RedisRequestQueue()
      for (let i = 0; i < Q; i += 1) queue.push(i)
      for (let i = 0; i < Q; i += 1) assert.equal(queue.shift(), i)
    }
  )
}
for (const Q of [1000, 2000, 4000, 8000]) {
  const values = Array.from({ length: Q }, () => ({}))
  compare(
    "pending-cancel",
    { Q },
    () => {
      let queue = [...values]
      for (const value of values) queue = queue.filter((request) => request !== value)
      assert.equal(queue.length, 0)
    },
    () => {
      const queue = new RedisRequestQueue()
      const handles = values.map((value) => queue.push(value))
      for (const handle of handles) queue.remove(handle)
      assert.equal(queue.length, 0)
    }
  )
}

// Instrument actual Buffer operations in a separate, untimed pass. Count bytes
// copied and decoded (including repeated old-parser work), not heap allocation.
const measureBuffers = (fn: () => void) => {
  const counters = { copied_bytes: 0, decoded_bytes: 0, decode_calls: 0 }
  const concat = Reflect.get(Buffer, "concat")
  const copy = Buffer.prototype.copy
  const copyWithin = Buffer.prototype.copyWithin
  const toString = Buffer.prototype.toString
  Buffer.concat = function (
    list: readonly Uint8Array[],
    ...args: [totalLength?: number]
  ) {
    counters.copied_bytes += list.reduce((sum, row) => sum + row.length, 0)
    return concat.call(this, list, ...args)
  }
  Buffer.prototype.copy = function (
    this: Buffer,
    target: Uint8Array,
    targetStart = 0,
    start = 0,
    end = this.length
  ) {
    const copied = copy.call(this, target, targetStart, start, end)
    counters.copied_bytes += copied
    return copied
  }
  Buffer.prototype.copyWithin = function (
    this: Buffer,
    target: number,
    start: number,
    end = this.length
  ) {
    counters.copied_bytes += end - start
    return copyWithin.call(this, target, start, end)
  }
  Buffer.prototype.toString = function (
    this: Buffer,
    encoding: BufferEncoding | undefined,
    start = 0,
    end = this.length
  ) {
    counters.decode_calls += 1
    counters.decoded_bytes += end - start
    return toString.call(this, encoding, start, end)
  }
  try {
    fn()
  } finally {
    Buffer.concat = concat
    Buffer.prototype.copy = copy
    Buffer.prototype.copyWithin = copyWithin
    Buffer.prototype.toString = toString
  }
  return counters
}
for (const shape of ["array", "bulk", "line"]) {
  for (const n of [1000, 2000, 4000, 8000]) {
    const wire =
      shape === "array"
        ? Buffer.from(`*${n}\r\n${"$3\r\nabc\r\n".repeat(n)}`)
        : shape === "bulk"
          ? Buffer.from(`$${n * 256}\r\n${"x".repeat(n * 256)}\r\n`)
          : Buffer.from(`+${"x".repeat(n * 16)}\r\n`)
    const chunkBytes = shape === "bulk" ? 1024 : 64
    const chunks: Buffer[] = []
    for (let offset = 0; offset < wire.length; offset += chunkBytes) {
      chunks.push(wire.subarray(offset, offset + chunkBytes))
    }
    const before = () => {
      let buffer = Buffer.alloc(0)
      let parsed: unknown
      for (const chunk of chunks) {
        buffer = Buffer.concat([buffer, chunk])
        parsed = oldParse(buffer)
      }
      assert.ok(parsed)
    }
    const after = () => {
      const decoder = new RedisResponseDecoder()
      let parsed: unknown
      for (const chunk of chunks) {
        decoder.append(chunk)
        parsed = decoder.read()
      }
      assert.ok(parsed)
    }
    const before_work = measureBuffers(before)
    const after_work = measureBuffers(after)
    assert.ok(after_work.copied_bytes <= wire.length * 4)
    compare(
      `fragmented-${shape}`,
      { B: wire.length, K: chunks.length, R: shape === "array" ? n : 1 },
      before,
      after,
      { before_work, after_work }
    )
  }
}
console.log(
  JSON.stringify(
    { baseline, node: process.version, samples: 5, statistic: "median", records },
    null,
    2
  )
)
