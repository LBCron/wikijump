import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.js"

import { loadWikidotUserInfo } from "../src/lib/server/wikidot-user-info.js"

const root = fileURLToPath(new URL("..", import.meta.url))

const retainedArtifact = new URL(
  "../../install/local/wikidot-verification/artifacts/userinfo-target-routes-live-20260810.json",
  import.meta.url
)

/** @type {any} */
let previousWorkingDirectory
/** @type {any} */
let vite
/** @type {any} */
let render
/** @type {any} */
let userInfoPage

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

/** @type {Record<string, unknown>} */
const publicUser = {
  user_id: 169306,
  user_type: "regular",
  created_at: "2008-07-19T21:26:10Z",
  updated_at: "2026-08-10T00:00:00Z",
  deleted_at: null,
  name: "The Administrator",
  slug: "the-administrator",
  avatar_s3_hash: null,
  email: "not-public-email-marker",
  email_verified_at: null,
  password: "not-public",
  real_name: "Not Public",
  biography: "Not Public",
  locales: ["en"]
}

const EXPECTED_TABS = [
  ["ui-profile-b", "Profile"],
  ["ui-member-b", "Member of"],
  ["ui-moderator-b", "Moderator of"],
  ["ui-admin-b", "Admin of"],
  ["ui-contrib-b", "Recent contributions"],
  ["ui-posts-b", "Recent posts and comments"]
]

const loadFoundProfile = () =>
  loadWikidotUserInfo({
    siteId: 7,
    locales: ["en"],
    target: "the-administrator",
    userView: async () =>
      /** @type {any} */ ({ type: "user_found", data: { user: publicUser } })
  })

/** @param {any} html */
const normalize = (html) =>
  html
    .replace(/<!--[\s\S]*?-->/gu, "")
    .replace(/>\s+</gu, "><")
    .trim()

/** @param {string} case_id */
const retainedBoundedBody = async (case_id) => {
  const artifact = JSON.parse(await readFile(retainedArtifact, "utf8"))
  const observation = artifact.observations.find(
    /** @param {any} item */ (item) => item.case_id === case_id
  )
  assert.ok(observation, `retained observation ${case_id} exists`)
  return normalize(observation.response.bounded_body)
}

const retainedTabStrip = async () => {
  const body = await retainedBoundedBody("userinfo-target-the-administrator-anonymous")
  const [strip] = body.match(/<ul id="ui-tabs"[\s\S]*?<\/ul>/u)
  return strip
}

test("the found profile renders the retained tab strip in a column before the profile", async () => {
  const body = normalize(
    render(userInfoPage, { props: { data: await loadFoundProfile() } }).body
  )
  const strip = await retainedTabStrip()

  assert.ok(
    body.startsWith('<div id="page-content"><div class="col-md-3">'),
    "tab column is the first child of page-content"
  )
  assert.ok(
    body.includes(`<div class="col-md-3">${strip}</div>`),
    "tab strip matches the retained live markup"
  )
  assert.ok(
    body.indexOf('<div class="col-md-3">') < body.indexOf('<div class="col-md-9"'),
    "tab column precedes the profile column"
  )
})

test("the tab strip is identical for anonymous and account-A viewers", async () => {
  const data = await loadFoundProfile()
  const anonymous = normalize(render(userInfoPage, { props: { data } }).body)
  const accountA = normalize(
    render(userInfoPage, {
      props: { data: { ...data, user_session: { user: { user_id: 42 } } } }
    }).body
  )
  const strip = /<ul id="ui-tabs"[\s\S]*?<\/ul>/u

  assert.equal(anonymous.match(strip)?.[0], accountA.match(strip)?.[0])
  assert.equal(anonymous.match(strip)?.[0], await retainedTabStrip())
})

test("the tabs are six in-place links in the retained order with Profile selected", async () => {
  const body = normalize(
    render(userInfoPage, { props: { data: await loadFoundProfile() } }).body
  )
  const strip = body.match(/<ul id="ui-tabs"[\s\S]*?<\/ul>/u)[0]
  const links = [...strip.matchAll(/<a id="([^"]+)" href="([^"]*)">([^<]*)<\/a>/gu)]

  assert.deepEqual(
    links.map(([, id, , label]) => [id, label]),
    EXPECTED_TABS
  )
  assert.equal(links.length, EXPECTED_TABS.length)
  assert.equal(
    links.every(([, , href]) => /^javascript:;$/u.test(href)),
    true,
    "every tab keeps the profile URL"
  )
  assert.deepEqual(strip.match(/<li class="active">/gu), ['<li class="active">'])
  assert.match(
    strip,
    /<li class="active"><a id="ui-profile-b" href="javascript:;">Profile<\/a><\/li>/u
  )
})

test("the missing-user body keeps the retained error inside page-content and no tab strip", async () => {
  const retained = await retainedBoundedBody(
    "userinfo-target-missing-numeric-zero-anonymous"
  )

  for (const target of ["0", "-1"]) {
    const data = await loadWikidotUserInfo({
      siteId: 7,
      locales: ["en"],
      target,
      userView: async () => ({ type: "user_missing", data: undefined })
    })
    const body = normalize(render(userInfoPage, { props: { data } }).body)

    assert.equal(body, `<div id="page-content">${retained}`)
    assert.equal(body.includes("ui-tabs"), false, `target ${target} has no tab strip`)
    assert.equal(body.includes("col-md-3"), false, `target ${target} has no tab column`)
  }
})
