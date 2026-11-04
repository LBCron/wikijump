import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { strict as assert } from "node:assert"
import test from "node:test"

import { createJiti } from "jiti"

const baselineFile = fileURLToPath(
  new URL("./fixtures/xmlrpc-protocol-before-round2.ts", import.meta.url)
)
assert.equal(
  createHash("sha256").update(readFileSync(baselineFile)).digest("hex"),
  "50749ee31035af72e9c0242e85a1fbd2eb793679abe6bde06866cc6ed012e1c9",
  "baseline fixture must match the pre-change blob at 6112a90d88"
)

const jiti = createJiti(import.meta.url)
const baseline = await jiti.import<any>(baselineFile)
const current = await jiti.import<any>(
  fileURLToPath(new URL("../src/lib/server/xmlrpc/protocol.ts", import.meta.url))
)

test("XML-RPC strips long interior whitespace in bounded time", () => {
  const xml = `<methodCall><methodName> ${" ".repeat(150_000)}accounts.getInfo</methodName><params></params></methodCall>`
  const start = performance.now()
  assert.equal(current.parseXmlRpcCall(xml).methodName, "accounts.getInfo")
  assert.ok(performance.now() - start < 2_000, "whitespace parsing must remain bounded")
})

test("XML-RPC rejects repeatedly unterminated nested tag openers without excessive work", () => {
  const malformedValue = "<string ".repeat(15_000)
  const xml = `<methodCall><methodName>accounts.getInfo</methodName><params><param><value>${malformedValue}</value></param></params></methodCall>`
  const start = performance.now()
  assert.throws(() => current.parseXmlRpcCall(xml))
  assert.ok(performance.now() - start < 2_000, "tag scanning must remain bounded")
})

const outcome = (fn: any, xml: string) => {
  try {
    return { ok: true, value: fn(xml) }
  } catch (error) {
    return {
      ok: false,
      name: (error as any)?.constructor?.name ?? null,
      code: (error as any)?.faultCode ?? null,
      message: (error as any)?.faultString ?? String((error as any)?.message ?? error)
    }
  }
}

const call = (methodName: string, paramsXml: string) =>
  `<?xml version="1.0"?><methodCall><methodName>${methodName}</methodName>` +
  `<params>${paramsXml}</params></methodCall>`

const VALUES = [
  "<string></string>",
  "<string>plain</string>",
  "<string>  spaced  </string>",
  "<string>&lt;&amp;&gt;&quot;&apos;</string>",
  "<string>&#65;&#x42;</string>",
  "<int>0</int>",
  "<int>-17</int>",
  "<int>+17</int>",
  "<int>2147483647</int>",
  "<int>-2147483648</int>",
  "<int>2147483648</int>",
  "<int>-2147483649</int>",
  "<int> 42 </int>",
  "<int>4 2</int>",
  "<int></int>",
  "<int>abc</int>",
  "<i4>9</i4>",
  "<i4>bad</i4>",
  "<boolean>1</boolean>",
  "<boolean>0</boolean>",
  "<boolean>2</boolean>",
  "<boolean></boolean>",
  "<double>1.5</double>",
  "<double>-0.25</double>",
  "<double>.5</double>",
  "<double>5.</double>",
  "<double>1e5</double>",
  "<double>abc</double>",
  "<double></double>",
  "<nil/>",
  "<nil />",
  "<nil></nil>",
  "<nil>x</nil>",
  "<base64>AAAA</base64>",
  "<base64/>",
  "<dateTime.iso8601>20260101T00:00:00</dateTime.iso8601>",
  "<unknown>x</unknown>",
  "<unknown/>",
  "<stringish>x</stringish>",
  "<strin>x</strin>",
  "<int >5</int >",
  "<int\n\t>5</int\n\t>",
  "<string attr='v'>x</string>",
  "bare text",
  "",
  "   ",
  "42",
  "<array><data></data></array>",
  "<array><data/></array>",
  "<array><data><value><int>1</int></value></data></array>",
  "<array><data><value><int>1</int></value><value><string>a</string></value></data></array>",
  "<array><data><value><int>1</int></value>  <value><int>2</int></value></data></array>",
  "<array><data>oops</data></array>",
  "<array><data><int>1</int></data></array>",
  "<array><value><int>1</int></value></array>",
  "<array><data><value><int>1</int></value>",
  "<array><data><value><array><data><value><int>1</int></value></data></array></value></data></array>",
  "<struct></struct>",
  "<struct/>",
  "<struct><member><name>a</name><value><int>1</int></value></member></struct>",
  "<struct><member><name>a</name><value><int>1</int></value></member><member><name>b</name><value><int>2</int></value></member></struct>",
  "<struct><member><name>a</name><value><int>1</int></value></member><member><name>a</name><value><int>2</int></value></member></struct>",
  "<struct><member><name></name><value><int>1</int></value></member></struct>",
  "<struct><member><name> a </name><value><int>1</int></value></member></struct>",
  "<struct><member><value><int>1</int></value></member></struct>",
  "<struct><member><name>a</name></member></struct>",
  "<struct><member><name>a</name><value><int>1</int></value></struct>",
  "<struct>text</struct>",
  "<struct><value><int>1</int></value></struct>",
  "<struct><member><name>a</name><value><string>x</string></value></member>trailing</struct>",
  "<struct><member><name>a</name><value><int>1</int></value></member>  <member><name>b</name><value><int>2</int></value></member></struct>",
  "<struct><member><name>a</name><value><struct><member><name>inner</name><value><int>1</int></value></member></struct></value></member></struct>",
  "<struct><member><name>a</name><value><value><int>1</int></value></value></member></struct>"
]

const nestedStruct = (depth: number, leaf = "x") => {
  let body = `<member><name>leaf</name><value><string>${leaf}</string></value></member>`
  for (let level = 0; level < depth; level += 1) {
    body = `<member><name>l${level}</name><value><struct>${body}</struct></value></member>`
  }
  return `<struct>${body}</struct>`
}

const nestedArray = (depth: number, leaf = "x") => {
  let body = `<value><string>${leaf}</string></value>`
  for (let level = 0; level < depth; level += 1) {
    body = `<value><array><data>${body}</data></array></value>`
  }
  return `<array><data>${body}</data></array>`
}

const flatStruct = (count: number) => {
  const members = Array.from(
    { length: count },
    (_, i) => `<member><name>m${i}</name><value><int>${i}</int></value></member>`
  ).join("")
  return `<struct>${members}</struct>`
}

const flatArray = (count: number) => {
  const items = Array.from(
    { length: count },
    (_, i) => `<value><int>${i}</int></value>`
  ).join("")
  return `<array><data>${items}</data></array>`
}

const SHAPES = [
  ...[1, 2, 8, 32, 60, 63, 64, 65, 80].map((d) => [`depth-struct-${d}`, nestedStruct(d)]),
  ...[1, 8, 32, 60, 63, 64, 65, 80].map((d) => [`depth-array-${d}`, nestedArray(d)]),
  ...[1, 2, 17, 64].map((c) => [`width-struct-${c}`, flatStruct(c)]),
  ...[1, 2, 17, 64].map((c) => [`width-array-${c}`, flatArray(c)]),
  ["deep-width", nestedStruct(12, "y".repeat(300))],
  [
    "whitespace-heavy",
    `<struct>  <member>  <name>  a  </name>  <value>  <int>  1  </int>  </value>  </member>  </struct>`
  ],
  [
    "crlf",
    "<struct>\r\n<member><name>a</name><value><int>1</int></value></member>\r\n</struct>"
  ],
  [
    "self-closing-value",
    "<struct><member><name>a</name><value><nil/></value></member></struct>"
  ],
  [
    "attr-everywhere",
    "<struct><member><name>a</name><value><string b='c'>t</string></value></member></struct>"
  ]
]

const DOCUMENTS = [
  ...VALUES.map((value) => ({
    label: `value:${value.slice(0, 48)}`,
    xml: call("probe", `<param><value>${value}</value></param>`)
  })),
  ...SHAPES.map(([label, value]) => ({
    label: `shape:${label}`,
    xml: call("probe", `<param><value>${value}</value></param>`)
  })),
  {
    label: "no-params",
    xml: '<?xml version="1.0"?><methodCall><methodName>probe</methodName></methodCall>'
  },
  { label: "empty-params", xml: call("probe", "") },
  { label: "empty-method", xml: call("", "<param><value><int>1</int></value></param>") },
  { label: "no-methodcall", xml: "<nope/>" },
  {
    label: "comments-rejected",
    xml: '<?xml version="1.0"?><!-- hi --><methodCall><methodName>p</methodName></methodCall>'
  },
  {
    label: "bom-prefixed",
    xml: `\uFEFF<?xml version="1.0"?>${call("probe", "<param><value><int>1</int></value></param>")}`
  },
  { label: "param-without-value", xml: call("probe", "<param></param>") },
  { label: "param-text", xml: call("probe", "<param>text</param>") }
]

test("XML-RPC parser dispatch matches the previous probe chain on every shape", () => {
  let compared = 0
  for (const { label, xml } of DOCUMENTS) {
    const before = outcome(baseline.parseXmlRpcCall, xml)
    const after = outcome(current.parseXmlRpcCall, xml)
    assert.deepEqual(
      after,
      before,
      `divergence for ${label}\n  input: ${xml.slice(0, 200)}`
    )
    compared += 1
  }
  assert.ok(compared >= 60, `expected broad coverage, compared ${compared}`)
})

test("unknown tag names compile no tag patterns, so input cannot grow the cache", () => {
  const RealRegExp = globalThis.RegExp
  let compiled = 0
  class CountingRegExp extends RealRegExp {
    constructor(pattern: string | RegExp, flags?: string) {
      compiled += 1
      super(pattern, flags)
    }
  }
  Object.setPrototypeOf(CountingRegExp, RealRegExp)
  globalThis.RegExp = CountingRegExp as unknown as RegExpConstructor
  try {
    for (let i = 0; i < 500; i += 1) {
      const tag = `hostile${i}`
      const result = outcome(
        current.parseXmlRpcCall,
        call("probe", `<param><value><${tag}>x</${tag}></value></param>`)
      )
      assert.equal(result.ok, false, `unknown tag ${tag} must be rejected`)
      assert.equal(result.code, -32602)
    }
  } finally {
    globalThis.RegExp = RealRegExp
  }
  assert.ok(
    compiled <= 8,
    `unknown tag names must not compile patterns, saw ${compiled} for 500 requests`
  )
})

test("repeated supported values reuse cached patterns instead of recompiling", () => {
  const RealRegExp = globalThis.RegExp
  let compiled = 0
  class CountingRegExp extends RealRegExp {
    constructor(pattern: string | RegExp, flags?: string) {
      compiled += 1
      super(pattern, flags)
    }
  }
  Object.setPrototypeOf(CountingRegExp, RealRegExp)
  globalThis.RegExp = CountingRegExp as unknown as RegExpConstructor
  try {
    for (let i = 0; i < 5; i += 1) {
      current.parseXmlRpcCall(
        call("probe", `<param><value>${flatStruct(12)}</value></param>`)
      )
    }
    const warm = compiled
    compiled = 0
    for (let i = 0; i < 50; i += 1) {
      current.parseXmlRpcCall(
        call("probe", `<param><value>${flatStruct(12)}</value></param>`)
      )
    }
    const steady = compiled
    assert.equal(warm, steady, "pattern compilation must not recur once cached")
  } finally {
    globalThis.RegExp = RealRegExp
  }
})

test("deep and wide documents decode to identical structures", () => {
  for (const value of [
    nestedStruct(40),
    nestedArray(40),
    flatStruct(40),
    flatArray(40)
  ]) {
    const xml = call("probe", `<param><value>${value}</value></param>`)
    assert.deepEqual(current.parseXmlRpcCall(xml), baseline.parseXmlRpcCall(xml))
  }
})
