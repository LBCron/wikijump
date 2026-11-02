import assert from "node:assert/strict"
import test from "node:test"

import {
  resolveLocalAuthoringMutationMarker,
  resolvePageMutationUserId
} from "../src/lib/server/load/local-authoring-actor.ts"

const LOCAL_SITE = "scpaiueouiuiuiui"

test("authenticated sessions retain their actor in every deployment environment", () => {
  assert.equal(resolvePageMutationUserId(42, LOCAL_SITE, 7, 7, "prod"), 42)
})

test("the local admin actor is available only for a bound local-site mutation", () => {
  assert.equal(resolvePageMutationUserId(undefined, LOCAL_SITE, 7, 7, "local"), -1)
  assert.equal(resolvePageMutationUserId(undefined, LOCAL_SITE, 7, 7, "prod"), undefined)
  assert.equal(resolvePageMutationUserId(undefined, LOCAL_SITE, 7, 8, "local"), undefined)
  assert.equal(resolvePageMutationUserId(undefined, "scp-wiki", 7, 7, "local"), undefined)
  assert.equal(resolvePageMutationUserId(undefined, "scp-jp", 7, 7, "local"), undefined)
})

test("the mutation marker is sent only for anonymous bound local-site reads", () => {
  assert.equal(
    resolveLocalAuthoringMutationMarker(undefined, LOCAL_SITE, 7, 7, "local"),
    true
  )
  assert.equal(resolveLocalAuthoringMutationMarker(42, LOCAL_SITE, 7, 7, "local"), false)
  assert.equal(
    resolveLocalAuthoringMutationMarker(undefined, LOCAL_SITE, 7, 7, "prod"),
    false
  )
  assert.equal(
    resolveLocalAuthoringMutationMarker(undefined, LOCAL_SITE, 7, 8, "local"),
    false
  )
  assert.equal(
    resolveLocalAuthoringMutationMarker(undefined, "scp-wiki", 7, 7, "local"),
    false
  )
})
