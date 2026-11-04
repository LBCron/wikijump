import { strict as assert } from "node:assert"
import { readFile } from "node:fs/promises"
import test from "node:test"

const SPECIALS = new Set(".*+?^${}()|[]\\")

function referenceEscape(str: string) {
  return [...str].map((char) => (SPECIALS.has(char) ? `\\${char}` : char)).join("")
}

async function shippedEscapeRegExp() {
  const source = await readFile(
    new URL("../src/lib/util/index.ts", import.meta.url),
    "utf8"
  )
  const fnStart = source.indexOf("export function escapeRegExp")
  assert.notEqual(fnStart, -1)
  const statement = /return str\.replace\(.*\)/.exec(source.slice(fnStart))
  assert.ok(statement)
  const literal = /str\.replace\(\/(.+)\/g,/.exec(statement[0])
  assert.ok(literal)
  assert.ok(statement[0].includes('"\\\\$&"'))
  const pattern = literal[1]
  return (str: string) => str.replace(new RegExp(pattern, "g"), "\\$&")
}

test("escapeRegExp matches the special-character reference for every ASCII character", async () => {
  const escapeRegExp = await shippedEscapeRegExp()
  for (let code = 0; code < 128; code++) {
    const char = String.fromCharCode(code)
    assert.equal(escapeRegExp(char), referenceEscape(char), `char code ${code}`)
  }
})

test("escapeRegExp matches the reference on mixed inputs", async () => {
  const escapeRegExp = await shippedEscapeRegExp()
  const inputs = [
    "",
    "plain text",
    ".*+?^${}()|[]\\",
    "[a-z]+(x|y){2,3}$",
    "a[b]c\\d(e)f|g^h$i.j*k+l?m",
    "[[[((()))]]]",
    "no specials at all, just words and spaces"
  ]
  for (const input of inputs) {
    assert.equal(escapeRegExp(input), referenceEscape(input), input)
  }
})

test("escapeRegExp escapes exactly the special set", async () => {
  const escapeRegExp = await shippedEscapeRegExp()
  assert.equal(
    escapeRegExp(".*+?^${}()|[]\\"),
    "\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\"
  )
  assert.equal(escapeRegExp("abc XYZ 019 -_=,;:!#%&"), "abc XYZ 019 -_=,;:!#%&")
})

test("escaped output matches only the literal input", async () => {
  const escapeRegExp = await shippedEscapeRegExp()
  const input = "a.c[e]f\\g(h)i|j^k$l{m}n+o*p?q"
  const pattern = new RegExp(`^${escapeRegExp(input)}$`)
  assert.equal(pattern.test(input), true)
  assert.equal(pattern.test("aXc[e]f\\g(h)i|j^k$l{m}n+o*p?q"), false)
})
