import assert from "node:assert/strict"
import test from "node:test"

import { authCancelDestination } from "../src/lib/auth-cancel.ts"

test("authentication cancellation always uses the safe platform root", () => {
  assert.equal(authCancelDestination(), "/")
})

test("sign-in returns to the same-site page it was started from", async () => {
  const { authReturnDestination } = await import("../src/lib/auth-cancel.ts")
  const at = (query: string) => new URL(`https://scp-wiki.example.test/-/login${query}`)

  assert.equal(authReturnDestination(at("")), "/")
  assert.equal(authReturnDestination(at("?return=/scp-9506")), "/scp-9506")
  assert.equal(
    authReturnDestination(at("?return=%2Fscp-9506%3Fx%3D1%23rate")),
    "/scp-9506?x=1#rate"
  )
  for (const unsafe of [
    "https://evil.example/",
    "//evil.example/x",
    "/\\evil.example",
    ["javascript", "alert(1)"].join(":"),
    "scp-9506",
    "/-/login",
    "/-/logout",
    "/\r\nLocation: x"
  ]) {
    assert.equal(
      authReturnDestination(at(`?return=${encodeURIComponent(unsafe)}`)),
      "/",
      unsafe
    )
  }
})
