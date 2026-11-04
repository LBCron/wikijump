import assert from "node:assert/strict"
import test from "node:test"

import { deepwellRpcAuthorization } from "../src/lib/server/deepwell/rpc-auth.ts"

const TOKEN = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

test("DEEPWELL service authorization requires the exact token format", () => {
  assert.equal(deepwellRpcAuthorization({ DEEPWELL_RPC_TOKEN: TOKEN }), `Bearer ${TOKEN}`)
  for (const token of [undefined, "", "0".repeat(63), "A".repeat(64), `${TOKEN}0`]) {
    assert.throws(
      () => deepwellRpcAuthorization({ DEEPWELL_RPC_TOKEN: token }),
      /64 lowercase hexadecimal/
    )
  }
})
