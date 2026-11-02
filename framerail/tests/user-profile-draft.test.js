import assert from "node:assert/strict"
import test from "node:test"

import { acceptedSnapshot, partialPatch } from "../src/lib/user-profile-draft.js"

const persistedUser = {
  name: "Rokurokubi",
  real_name: "Roku",
  email: "roku@example.invalid",
  gender: "",
  birthday: "",
  location: "",
  website: "",
  user_page: "",
  biography: "",
  locales: ["en", "ja"]
}

test("accepted snapshot mirrors the persisted account, with locales as one string", () => {
  const accepted = acceptedSnapshot(persistedUser)

  assert.equal(accepted.name, "Rokurokubi")
  assert.equal(accepted.realName, "Roku")
  assert.equal(accepted.email, "roku@example.invalid")
  assert.equal(accepted.locales, "en ja")
  assert.equal(acceptedSnapshot(null).email, "")
})

test("partial patch sends only fields that differ from the accepted state", () => {
  const accepted = acceptedSnapshot(persistedUser)
  const draft = { ...accepted, name: "Renamed" }

  assert.deepEqual(partialPatch(draft, accepted, undefined), {
    avatar: undefined,
    name: "Renamed"
  })
})

test("a rejected draft never becomes the baseline for the next partial patch", () => {
  const accepted = acceptedSnapshot(persistedUser)

  const rejected = { ...accepted, email: "not-a-valid-email" }
  assert.deepEqual(partialPatch(rejected, accepted, undefined), {
    avatar: undefined,
    email: "not-a-valid-email"
  })

  const corrected = { ...accepted, name: "Renamed" }
  assert.deepEqual(partialPatch(corrected, accepted, undefined), {
    avatar: undefined,
    name: "Renamed"
  })
})

test("a retry after a rejected email still sends the corrected email", () => {
  const accepted = acceptedSnapshot(persistedUser)
  const retry = { ...accepted, email: "fixed@example.invalid" }

  assert.equal(partialPatch(retry, accepted, undefined).email, "fixed@example.invalid")
})

test("discarding a draft yields an empty patch against the accepted state", () => {
  const accepted = acceptedSnapshot(persistedUser)

  assert.deepEqual(partialPatch({ ...accepted }, accepted, undefined), {
    avatar: undefined
  })
})

test("reconciling after success adopts the server-normalized values", () => {
  const accepted = acceptedSnapshot({
    ...persistedUser,
    locales: ["en", "ja"],
    email: "normalized@example.invalid"
  })

  assert.equal(accepted.email, "normalized@example.invalid")
  assert.equal(accepted.locales, "en ja")
})
