import assert from "node:assert/strict"
import test from "node:test"

import { handleAuthRpc } from "./xmlrpc-deepwell-fixture/auth-handler.ts"

const translate = (locales: string[], keys: string[]) =>
  handleAuthRpc({
    rpcRequest: {
      method: "translate",
      params: {
        locales,
        messages: Object.fromEntries(keys.map((key) => [key, {}])),
        strip_message_keys: [],
        allow_missing: true
      }
    }
  } as any)!.result

test("a mixed profile translation batch keeps shared avatar labels", () => {
  assert.deepEqual(
    translate(["en"], ["user-profile-info", "user-profile-info.remove-avatar"]),
    {
      "user-profile-info": "User profile information",
      "user-profile-info.remove-avatar": "Remove profile image"
    }
  )
})

test("page labels compose with English and Japanese action and vote labels", () => {
  for (const [locale, heading, files, rating] of [
    ["en", "Page layout", "Files", "Rating"],
    ["ja", "ページレイアウト", "ファイル", "評価"]
  ]) {
    assert.deepEqual(
      translate([locale], ["wiki-page-layout", "files", "wiki-page-vote.score"]),
      { "wiki-page-layout": heading, files, "wiki-page-vote.score": rating }
    )
  }
})

test("unrelated translation batches still reach the shared translator", () => {
  assert.deepEqual(translate(["en"], ["files", "unknown-label"]), {
    files: "Files",
    "unknown-label": "unknown-label"
  })
})
