import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.ts"

import {
  loadWikidotUserInfo,
  type UserInfoFound
} from "../src/lib/server/wikidot-user-info.ts"

const root = fileURLToPath(new URL("..", import.meta.url))

let previousWorkingDirectory: any
let vite: any
let render: any
let userInfoPage: any

before(async () => {
  previousWorkingDirectory = process.cwd()
  process.chdir(root)
  vite = await createTestViteServer()

  ;({ render } = await vite.ssrLoadModule("svelte/server"))
  ;({ default: userInfoPage } = await vite.ssrLoadModule(
    "/src/routes/user[x+3a]info/[target]/+page.svelte"
  ))
})

after(async () => {
  if (vite) await vite.close()
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
})

const foundTargets = [
  {
    user_id: 169306,
    user_type: "regular",
    created_at: "2008-07-19T21:26:10Z",
    name: "The Administrator",
    slug: "the-administrator",
    avatar_s3_hash: null
  },
  {
    user_id: 1698600,
    user_type: "regular",
    created_at: "2013-08-16T13:07:00Z",
    name: "Dr Clef",
    slug: "dr-clef",
    avatar_s3_hash: null
  }
]

const importedTargets = [
  {
    user_id: 1698600,
    user_type: "wikidot",
    created_at: "2013-08-16T13:07:00Z",
    fetched_at: "2026-08-13T00:00:00Z",
    is_deleted: false,
    name: "Dr Clef",
    slug: "dr-clef",
    avatar_s3_hash: null,
    real_name: null,
    gender: null,
    birthday: null,
    location: null,
    biography: null,
    website: null,
    karma: 0,
    is_pro: false
  },
  {
    user_id: 169306,
    user_type: "wikidot",
    created_at: "2008-07-19T21:26:10Z",
    fetched_at: "2026-08-13T00:00:00Z",
    is_deleted: false,
    name: "The Administrator",
    slug: "the-administrator",
    avatar_s3_hash: null,
    real_name: null,
    gender: null,
    birthday: null,
    location: null,
    biography: null,
    website: null,
    karma: 3,
    is_pro: false
  }
]

test("UserInfo SSR presents evidenced regular accounts as Wikidot free accounts and omits the field for missing targets", async () => {
  for (const user of foundTargets) {
    const data = await loadWikidotUserInfo({
      siteId: 7,
      locales: ["en"],
      target: user.slug,
      userView: async () => ({ type: "user_found", data: { user } }) as any
    })
    const body = render(userInfoPage, { props: { data } }).body

    assert.match(body, /<dt>Account type:<\/dt>\s*<dd>free<\/dd>/u)
    assert.doesNotMatch(body, /<dd>regular<\/dd>/u)
  }

  for (const target of ["0", "-1"]) {
    const data = await loadWikidotUserInfo({
      siteId: 7,
      locales: ["en"],
      target,
      userView: async () => ({ type: "user_missing", data: undefined })
    })
    const body = render(userInfoPage, { props: { data } }).body

    assert.doesNotMatch(body, /Account type:/u)
  }
})

test("UserInfo projects imported free accounts and the observed none/high karma labels", async () => {
  for (const [user, karmaLabel] of importedTargets.map((user: any, index: any) => [
    user,
    ["none", "high"][index]
  ])) {
    const data = (await loadWikidotUserInfo({
      siteId: 7,
      locales: ["en"],
      target: user.slug,
      userView: async () => ({ type: "user_found", data: { user } }) as any
    })) as UserInfoFound
    const body = render(userInfoPage, { props: { data } }).body

    assert.equal(data.view, "user_found")
    assert.equal(data.user.accountType, "free")
    assert.equal(data.user.karmaLevel, karmaLabel)
    assert.match(body, /<dt>Account type:<\/dt>\s*<dd>free<\/dd>/u)
    assert.match(body, new RegExp(`<dt>Karma level:</dt>\\s*<dd>${karmaLabel}</dd>`, "u"))
  }
})

test("UserInfo keeps an imported Pro profile without inventing an account-type label", async () => {
  const user = { ...importedTargets[1], is_pro: true }
  const data = (await loadWikidotUserInfo({
    siteId: 7,
    locales: ["en"],
    target: user.slug,
    userView: async () => ({ type: "user_found", data: { user } }) as any
  })) as UserInfoFound
  const body = render(userInfoPage, { props: { data } }).body

  assert.equal(data.view, "user_found")
  assert.equal("accountType" in data.user, false)
  assert.equal(data.user.karmaLevel, "high")
  assert.match(body, /The Administrator/u)
  assert.doesNotMatch(body, /Account type:|<dd>pro<\/dd>/u)
})

test("UserInfo omits unobserved imported karma labels", async () => {
  for (const karma of [1, 2, 4, 5]) {
    const user = { ...importedTargets[0], karma }
    const data = (await loadWikidotUserInfo({
      siteId: 7,
      locales: ["en"],
      target: user.slug,
      userView: async () => ({ type: "user_found", data: { user } }) as any
    })) as UserInfoFound
    const body = render(userInfoPage, { props: { data } }).body

    assert.equal(data.view, "user_found")
    assert.equal("karmaLevel" in data.user, false)
    assert.doesNotMatch(body, /Karma level:/u)
  }
})
