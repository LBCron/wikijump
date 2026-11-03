import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { after, before, test } from "node:test"

import { createTestViteServer } from "./vite-test-server.js"

const root = fileURLToPath(new URL("..", import.meta.url))

/** @type {any} */
let previousWorkingDirectory
/** @type {any} */
let vite
/** @type {any} */
let routes
/** @type {any} */
let owners

before(async () => {
  previousWorkingDirectory = process.cwd()
  process.chdir(root)
  vite = await createTestViteServer()
  routes = {
    wellKnown: await vite.ssrLoadModule("/src/routes/[x+2e]well-known/+server.ts"),
    raty: await vite.ssrLoadModule(
      "/src/routes/common--images/jquery-raty/[asset]/+server.ts"
    ),
    admin: await vite.ssrLoadModule("/src/routes/[x+2d]/admin/+page.server.ts"),
    login: await vite.ssrLoadModule("/src/routes/[x+2d]/login/+page.server.ts"),
    register: await vite.ssrLoadModule("/src/routes/[x+2d]/register/+page.server.ts"),
    rootPage: await vite.ssrLoadModule("/src/routes/+page.server.ts"),
    slugPage: await vite.ssrLoadModule("/src/routes/[slug]/[...extra]/+page.server.ts")
  }
  owners = {
    admin: await vite.ssrLoadModule("/src/lib/server/load/admin.ts"),
    login: await vite.ssrLoadModule("/src/lib/server/load/login.ts"),
    register: await vite.ssrLoadModule("/src/lib/server/load/register.ts"),
    page: await vite.ssrLoadModule("/src/lib/server/load/page/page-actions.ts")
  }
})

after(async () => {
  if (vite) await vite.close()
  if (previousWorkingDirectory) process.chdir(previousWorkingDirectory)
})

test("reserved compatibility routes expose their public fail-closed responses", async () => {
  const get = routes.wellKnown.GET({})
  assert.equal(get.status, 404)
  assert.equal(get.headers.get("content-type"), "text/plain; charset=utf-8")
  assert.equal(
    await get.text(),
    "No .well-known resource is configured for this Framerail target.\n"
  )

  const head = routes.wellKnown.HEAD({})
  assert.equal(head.status, 404)
  assert.equal(await head.text(), "")

  const image = routes.raty.GET({ params: { asset: "star-on.png" } })
  assert.equal(image.status, 200)
  assert.equal(image.headers.get("content-type"), "image/png")
  assert.equal(image.headers.get("cache-control"), "public, max-age=31536000, immutable")
  assert.ok((await image.arrayBuffer()).byteLength > 8)

  const missing = routes.raty.GET({ params: { asset: "not-a-wikidot-asset.png" } })
  assert.equal(missing.status, 404)

  const fallbackSource = await readFile(
    new URL("../src/routes/[...fallback]/+page.svelte", import.meta.url),
    "utf8"
  )
  assert.match(fallbackSource, /page\.params\.fallback/u)
  assert.match(fallbackSource, /\.split\("\/"\)/u)
  assert.match(fallbackSource, /\.filter\(\(v\) => v\.length\)/u)
  assert.match(fallbackSource, /<Redirect \{redirectPage\} \/>/u)
})

test("previously unattributed public route actions stay wired to their owning handlers", () => {
  assert.equal(routes.admin.actions.template, owners.admin.templateAction)
  assert.equal(routes.login.actions.default, owners.login.loginAction)
  assert.equal(routes.register.actions.default, owners.register.registerAction)

  for (const action of [
    "createPermission",
    "editPermission",
    "layout",
    "lockCreate",
    "lockHistory",
    "lockRemove"
  ]) {
    assert.equal(routes.rootPage.actions[action], owners.page.pageActions[action], action)
    assert.equal(routes.slugPage.actions[action], owners.page.pageActions[action], action)
  }
})
