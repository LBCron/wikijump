import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { test } from "node:test"

import {
  REGISTER_HONEYPOT_FIELD,
  REGISTER_HONEYPOT_LABEL,
  isRegistrationHoneypotTripped
} from "../src/lib/server/load/register-honeypot.ts"

test("an untouched honeypot does not trip the gate", () => {
  for (const value of [undefined, null, "", "false", "off", "0", []]) {
    assert.equal(
      isRegistrationHoneypotTripped(value),
      false,
      `untripped: ${JSON.stringify(value)}`
    )
  }
})

test("a filled or checked honeypot trips the gate", () => {
  for (const value of ["on", "true", "1", "checked", "bot@example.com", ["on"]]) {
    assert.equal(
      isRegistrationHoneypotTripped(value),
      true,
      `tripped: ${JSON.stringify(value)}`
    )
  }
})

test("the register template renders the evidenced off-screen honeypot", async () => {
  const source = await readFile(
    new URL("../src/routes/[x+2d]/register/+page.svelte", import.meta.url),
    "utf8"
  )

  assert.ok(
    source.includes(`name="${REGISTER_HONEYPOT_FIELD}"`),
    "honeypot field name matches the server gate"
  )
  assert.ok(
    source.includes(REGISTER_HONEYPOT_LABEL),
    "honeypot carries the evidenced label"
  )

  const input = /<input[^>]*>/.exec(
    source.slice(
      source.indexOf(`name="${REGISTER_HONEYPOT_FIELD}"`) - 200,
      source.indexOf(`name="${REGISTER_HONEYPOT_FIELD}"`) + 200
    )
  )
  assert.ok(input, "honeypot input found")
  assert.match(input[0], /type="checkbox"/u, "honeypot is a checkbox")
  assert.match(input[0], /tabindex="-1"/u, "honeypot is outside keyboard order")
  assert.ok(!input[0].includes("bind:value"), "honeypot is uncontrolled")

  assert.ok(source.includes('class="register-honeypot"'), "honeypot wrapper class")
  assert.ok(source.includes('aria-hidden="true"'), "honeypot hidden from AT")
  assert.match(source, /left:\s*-10000px/u, "honeypot positioned off-screen")
})

test("the register action gates the honeypot before creating the user", async () => {
  const source = await readFile(
    new URL("../src/lib/server/load/register.ts", import.meta.url),
    "utf8"
  )

  assert.ok(
    source.includes("isRegistrationHoneypotTripped"),
    "action consults the honeypot gate"
  )
  assert.ok(
    source.includes(REGISTER_HONEYPOT_FIELD),
    "validation schema admits the honeypot field"
  )
  const gate = source.indexOf("isRegistrationHoneypotTripped(form.data")
  const create = source.indexOf("userCreate(")
  assert.ok(
    gate !== -1 && create !== -1 && gate < create,
    "honeypot rejection precedes userCreate"
  )
  const rejection = source.slice(gate, create)
  assert.ok(rejection.includes("fail("), "tripped honeypot fails the action")
  assert.ok(
    !/honeypot|bot|captcha|automated/i.test(
      rejection.replace("isRegistrationHoneypotTripped", "")
    ),
    "rejection discloses no classification detail"
  )
})
