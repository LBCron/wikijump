import { strict as assert } from "node:assert"
import { readFile } from "node:fs/promises"
import test from "node:test"

import {
  ACCOUNT_PASSWORD_MIN_CODE_POINTS,
  accountPasswordMeetsMinimum
} from "../src/lib/account-password-policy.ts"

test("account passwords require fifteen Unicode code points", () => {
  assert.equal(ACCOUNT_PASSWORD_MIN_CODE_POINTS, 15)
  assert.equal(accountPasswordMeetsMinimum("a"), false)
  assert.equal(accountPasswordMeetsMinimum("fourteen-chars"), false)
  assert.equal(accountPasswordMeetsMinimum("fifteen-chars!!"), true)
  assert.equal(accountPasswordMeetsMinimum("💥".repeat(14)), false)
  assert.equal(accountPasswordMeetsMinimum("💥".repeat(15)), true)
})

test("registration schema applies the account password policy", async () => {
  const source = await readFile(
    new URL("../src/lib/server/load/register.ts", import.meta.url),
    "utf8"
  )

  assert.match(
    source,
    /password:\s*pipe\(\s*string\(\),\s*check\(\s*accountPasswordMeetsMinimum,\s*ACCOUNT_PASSWORD_TOO_SHORT\s*\)\s*\)/
  )
})
