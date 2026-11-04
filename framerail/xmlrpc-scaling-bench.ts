// Run from any directory: node framerail/xmlrpc-scaling-bench.ts [baseline-ref]
//
// The default baseline fixture is an exact, hash-pinned pre-change Git blob.
// Pass a Git ref to compare another revision without changing the worktree.
//
// Two dimensions are exercised independently:
//   C = request bytes          (depth pinned, payload width scaled)
//   H = value nesting depth    (total bytes pinned, depth scaled)
//
// Tag dispatch reduces work per nested value, but closing-tag search still
// revisits descendants; both paths retain O(H * C) worst-case scan work.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"

type XmlRpcParser = (xml: string) => unknown

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url))
const baselineRef = process.argv[2] ?? null
const PROTOCOL_PATH = "framerail/src/lib/server/xmlrpc/protocol.ts"

const { createJiti } = await import("jiti")

async function loadParser(source: string | null, label: string): Promise<XmlRpcParser> {
  if (source) {
    const dir = mkdtempSync(join(tmpdir(), `xmlrpc-baseline-${label}-`))
    const file = join(dir, "protocol.ts")
    writeFileSync(file, source)
    const jiti = createJiti(import.meta.url)
    return ((await jiti.import(file)) as { parseXmlRpcCall: XmlRpcParser })
      .parseXmlRpcCall
  }
  const jiti = createJiti(import.meta.url)
  return (
    (await jiti.import(
      fileURLToPath(new URL("./src/lib/server/xmlrpc/protocol.ts", import.meta.url))
    )) as { parseXmlRpcCall: XmlRpcParser }
  ).parseXmlRpcCall
}

const baselineSource =
  baselineRef === null
    ? readFileSync(
        fileURLToPath(
          new URL("./tests/fixtures/xmlrpc-protocol-before-round2.ts", import.meta.url)
        ),
        "utf8"
      )
    : execFileSync("git", ["show", `${baselineRef}:${PROTOCOL_PATH}`], {
        cwd: REPO_ROOT,
        encoding: "utf8"
      })
if (baselineRef === null) {
  assert.equal(
    createHash("sha256").update(baselineSource).digest("hex"),
    "50749ee31035af72e9c0242e85a1fbd2eb793679abe6bde06866cc6ed012e1c9"
  )
}
const baselineParse = await loadParser(baselineSource, "old")
const currentParse = await loadParser(null, "new")

// ---------------------------------------------------------------------------
// Instrumented work counters.
//
// regexp      - RegExp compilations (the baseline compiles two per probe).
// exec        - RegExp.exec/test invocations.
// scanChars   - characters the regex engine actually had to consider. For a hit
//               that is match.index + match length - start; for a miss it is the
//               whole remaining input. This is the honest work metric and the
//               one that exposes superlinear growth.
// sliceChars  - characters produced by String.slice.
// ---------------------------------------------------------------------------
const counters = { regexp: 0, exec: 0, scanChars: 0, sliceChars: 0 }
const RealRegExp = globalThis.RegExp

function countScan(from: number, input: string, match: RegExpExecArray | null) {
  const hit = match ? match.index + match[0].length : input.length
  counters.scanChars += Math.max(0, hit - from)
}

class CountingRegExp extends RealRegExp {
  constructor(...args: [pattern: string | RegExp, flags?: string]) {
    counters.regexp += 1
    super(...args)
  }
  exec(input: string) {
    counters.exec += 1
    const from = this.lastIndex ?? 0
    const match = super.exec(input)
    countScan(from, input, match)
    return match
  }
  test(input: string) {
    counters.exec += 1
    const from = this.lastIndex ?? 0
    const match = RealRegExp.prototype.exec.call(this, input)
    countScan(from, input, match)
    return match !== null
  }
}
Object.setPrototypeOf(CountingRegExp, RealRegExp)

// The original method is intentionally detached while its prototype slot is instrumented.
// eslint-disable-next-line @typescript-eslint/unbound-method
const realSlice = String.prototype.slice
function installCounters() {
  counters.regexp = 0
  counters.exec = 0
  counters.scanChars = 0
  counters.sliceChars = 0
  globalThis.RegExp = CountingRegExp as typeof RegExp
  String.prototype.slice = function slice(
    start: number | undefined,
    end: number | undefined
  ) {
    const out = realSlice.call(this, start, end)
    counters.sliceChars += out.length
    return out
  }
}
function removeCounters() {
  globalThis.RegExp = RealRegExp
  String.prototype.slice = realSlice
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// Struct nested `depth` levels deep; the innermost member carries
// `leafName`/`leafValue`. Every level is a well-formed
// `<member><name>..</name><value><struct>..</struct></value></member>`.
function nestedStructRequest({
  depth,
  leafName,
  leafValue
}: {
  depth: number
  leafName: string
  leafValue: string
}) {
  let body = `<member><name>${leafName}</name><value><string>${leafValue}</string></value></member>`
  for (let level = 0; level < depth; level += 1) {
    body = `<member><name>level${level}</name><value><struct>${body}</struct></value></member>`
  }
  return (
    `<?xml version="1.0"?><methodCall><methodName>probe</methodName><params><param>` +
    `<value><struct>${body}</struct></value>` +
    `</param></params></methodCall>`
  )
}

// One struct with `memberCount` sibling members; no nesting.
function flatStructRequest({
  memberCount,
  leafBytes
}: {
  memberCount: number
  leafBytes: number
}) {
  const body = `<member><name>leaf</name><value><string>${"x".repeat(leafBytes)}</string></value></member>${Array.from(
    { length: memberCount - 1 },
    (_, i) => `<member><name>m${i}</name><value><int>${i}</int></value></member>`
  ).join("")}`
  return (
    `<?xml version="1.0"?><methodCall><methodName>probe</methodName><params><param>` +
    `<value><struct>${body}</struct></value>` +
    `</param></params></methodCall>`
  )
}

function measure(parse: XmlRpcParser, xml: string) {
  installCounters()
  let value: unknown
  try {
    value = parse(xml)
  } finally {
    removeCounters()
  }
  return value
}

const medianMs = (fn: () => void, samples = 5) => {
  fn()
  const times: number[] = []
  for (let i = 0; i < samples; i += 1) {
    const start = performance.now()
    fn()
    times.push(performance.now() - start)
  }
  times.sort((a, b) => a - b)
  return Number(times[Math.floor(times.length / 2)].toFixed(3))
}

const rows: Record<string, unknown>[] = []
const record = (path: string, dimensions: Record<string, number>, xml: string) => {
  // Correctness: both parsers must agree on the decoded structure.
  assert.deepEqual(
    measure(currentParse, xml),
    measure(baselineParse, xml),
    `structure drift: ${path}`
  )

  const before = medianMs(() => measure(baselineParse, xml))
  const after = medianMs(() => measure(currentParse, xml))

  measure(baselineParse, xml)
  const beforeWork = { ...counters }
  measure(currentParse, xml)
  const afterWork = { ...counters }

  const row: Record<string, unknown> = {
    path,
    ...dimensions,
    bytes: Buffer.byteLength(xml),
    before_ms: before,
    after_ms: after,
    before_regexp: beforeWork.regexp,
    after_regexp: afterWork.regexp,
    before_exec: beforeWork.exec,
    after_exec: afterWork.exec,
    before_scan_chars: beforeWork.scanChars,
    after_scan_chars: afterWork.scanChars,
    before_slice_chars: beforeWork.sliceChars,
    after_slice_chars: afterWork.sliceChars
  }
  rows.push(row)
  process.stderr.write(`${JSON.stringify(row)}\n`)
}

// Dimension C: request bytes scaled at pinned depth. Linear if ~2x per doubling.
for (const leafBytes of [256, 512, 1024, 2048]) {
  record(
    "bytes-scaled",
    { H: 32, leafBytes },
    nestedStructRequest({ depth: 32, leafName: "leaf", leafValue: "x".repeat(leafBytes) })
  )
}

// Dimension H: nesting depth scaled with a small leaf, so the document grows
// linearly in H and any H-dependence in the work metric is visible. H is capped
// below XML_RPC_MAX_VALUE_DEPTH so the fixture stays inside the accepted range.
for (const depth of [8, 16, 32, 56]) {
  record(
    "depth-scaled",
    { H: depth, leafBytes: 64 },
    nestedStructRequest({ depth, leafName: "leaf", leafValue: "x".repeat(64) })
  )
}

// Flat struct: many sibling members, no nesting. The baseline is already O(C)
// here, but pays the nine-probe constant per value; this isolates that factor
// from the H-dependence above.
for (const memberCount of [64, 128, 256, 512]) {
  record(
    "flat-members",
    { H: 1, memberCount },
    flatStructRequest({ memberCount, leafBytes: 64 })
  )
}

process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`)
