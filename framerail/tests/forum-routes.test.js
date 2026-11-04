import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"

import { compile } from "svelte/compiler"

import {
  loadForumCategoryRoute,
  loadForumStartRoute,
  loadForumThreadRoute
} from "../src/lib/server/forum-routes.ts"

/** @param {Record<string, string | undefined>} params */
const routeEvent = (params) => ({
  params,
  request: new Request("http://scp-wiki.local/forum/start", {
    headers: {
      "x-wikijump-site-id": "6000006",
      "x-wikijump-site-slug": "scp-wiki"
    }
  }),
  cookies: { get: () => undefined }
})

/**
 * @typedef {[
 *   number,
 *   string,
 *   Record<string, string>,
 *   { siteId: number; sessionToken: string | undefined }
 * ]} ForumCall
 * @param {ForumCall[]} calls
 * @param {{ status: string; body: string; js_include?: string[] }} [response]
 */
const dependencies = (calls, response = { status: "ok", body: "<div>forum</div>" }) => ({
  loadSiteInfo: () => ({ siteId: 6000006 }),
  wikidotForumModule: async (siteId, moduleName, parameters, requestContext) => {
    calls.push([siteId, moduleName, parameters, requestContext])
    return response
  }
})

test("forum route loads use the exact sealed read-only module requests", async () => {
  /** @type {ForumCall[]} */
  const calls = []

  assert.deepEqual(
    await loadForumStartRoute(routeEvent({ extra: undefined }), dependencies(calls)),
    { body: "<div>forum</div>" }
  )
  assert.deepEqual(
    await loadForumStartRoute(routeEvent({ extra: "hidden/show" }), dependencies(calls)),
    { body: "<div>forum</div>" }
  )
  assert.deepEqual(
    await loadForumCategoryRoute(
      routeEvent({ category: "8503559", name: "open-topic" }),
      dependencies(calls)
    ),
    { body: "<div>forum</div>" }
  )

  const jsInclude = ["https://static.example/ForumViewThreadModule.js"]
  const threadBody =
    '<div class="forum-thread-box">complete</div><script type="text/javascript">WIKIDOT.forumThreadId = 18029831;</script>'
  assert.deepEqual(
    await loadForumThreadRoute(
      routeEvent({ thread: "18029831", name: "codex-smoke-thread" }),
      dependencies(calls, {
        status: "ok",
        body: threadBody,
        js_include: jsInclude
      })
    ),
    { body: '<div class="forum-thread-box">complete</div>', forumThreadId: 18029831 }
  )

  assert.deepEqual(
    calls.map(([, moduleName, parameters]) => [moduleName, parameters]),
    [
      ["forum/ForumStartModule", {}],
      ["forum/ForumStartModule", { hidden: "true" }],
      ["forum/ForumViewCategoryModule", { c: "8503559", p: "1" }],
      ["forum/ForumViewThreadModule", { t: "18029831" }]
    ]
  )
})

test("ForumStart suffixes select hidden mode from the first segment only", async () => {
  /** @type {ForumCall[]} */
  const calls = []
  const deps = dependencies(calls)
  const cases = [
    [undefined, {}],
    ["hidden/show", { hidden: "true" }],
    ["hidden/hide", { hidden: "true" }],
    ["hidden/false", { hidden: "true" }],
    ["hidden/show/extra", { hidden: "true" }],
    ["garbage", {}],
    ["garbage/extra", {}]
  ]

  for (const [extra] of cases) {
    assert.deepEqual(await loadForumStartRoute(routeEvent({ extra }), deps), {
      body: "<div>forum</div>"
    })
  }

  assert.deepEqual(
    calls.map(([, moduleName, parameters]) => [moduleName, parameters]),
    cases.map(([, parameters]) => ["forum/ForumStartModule", parameters])
  )
  assert.ok(
    calls.every(
      ([, , parameters]) =>
        JSON.stringify(parameters) === "{}" ||
        JSON.stringify(parameters) === '{"hidden":"true"}'
    )
  )
})

test("forum thread route refuses a mismatched legacy thread-id script", async () => {
  /** @type {ForumCall[]} */
  const calls = []
  await assert.rejects(
    loadForumThreadRoute(
      routeEvent({ thread: "18029831", name: "codex-smoke-thread" }),
      dependencies(calls, {
        status: "ok",
        body: '<div class="forum-thread-box">complete</div><script type="text/javascript">WIKIDOT.forumThreadId = 18029832;</script>'
      })
    ),
    /exact trusted thread ID script/u
  )
})

test("unobserved forum suffixes terminate at the public 404 boundary", async () => {
  /** @type {ForumCall[]} */
  const calls = []
  const deps = dependencies(calls)
  for (const run of [
    () =>
      loadForumCategoryRoute(
        routeEvent({ category: "8503559", name: "open-topic/sort/start" }),
        deps
      ),
    () =>
      loadForumThreadRoute(
        routeEvent({ thread: "18029831", name: "codex-smoke-thread/extra" }),
        deps
      )
  ]) {
    await assert.rejects(
      run,
      (error) =>
        typeof error === "object" &&
        error !== null &&
        Reflect.get(error, "status") === 404
    )
  }
  assert.deepEqual(calls, [])
})

test("the observed category pager suffix reaches the exact AMC page", async () => {
  /** @type {ForumCall[]} */
  const calls = []
  await loadForumCategoryRoute(
    routeEvent({ category: "1113520", name: "p/12" }),
    dependencies(calls)
  )
  assert.deepEqual(
    calls.map(([, moduleName, parameters]) => [moduleName, parameters]),
    [["forum/ForumViewCategoryModule", { c: "1113520", p: "12" }]]
  )
})

test("the public forum Svelte body boundary server-compiles", async () => {
  for (const relativePath of [
    "../src/lib/ForumModuleBody.svelte",
    "../src/routes/forum/start/[...extra]/+page.svelte",
    "../src/routes/forum/c-[category=id]/[...name]/+page.svelte",
    "../src/routes/forum/t-[thread=id]/[...name]/+page.svelte"
  ]) {
    const url = new URL(relativePath, import.meta.url)
    const source = await readFile(url, "utf8")
    assert.doesNotThrow(() =>
      compile(source, { filename: url.pathname, generate: "server" })
    )
    assert.doesNotMatch(source, /<script[^>]+src=/u)
  }
})
