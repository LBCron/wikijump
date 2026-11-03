import { strict as assert } from "node:assert"
import test, { after, before } from "node:test"

import { createTestViteServer } from "./vite-test-server.js"

const OWN_ORIGIN = "https://scp-wiki.wikijump.test"
const FORBIDDEN_MESSAGE = "Cross-site POST form submissions are forbidden"
const siteHeaders = {
  "X-Wikijump-Site-Id": "17",
  "X-Wikijump-Site-Slug": "scp-wiki"
}

/** @type {any} */
const endpoints = {
  ajax: {
    path: "/ajax-module-connector.php",
    route: "/src/routes/ajax-module-connector.php/+server.ts",
    contentType: "application/x-www-form-urlencoded",
    body: "moduleName=list%2FListPagesModule&category=_default"
  },
  xmlRpc: {
    path: "/xml-rpc-api.php",
    route: "/src/routes/xml-rpc-api.php/+server.ts",
    contentType: "text/xml",
    body: '<?xml version="1.0"?><methodCall><methodName>system.listMethods</methodName></methodCall>'
  }
}

/** @type {any} */
const loaded = {}
/** @type {any} */
let previousSwitch
/** @type {any} */
let vite

before(async () => {
  previousSwitch = process.env.FRAMERAIL_CSRF_CHECK_ORIGIN
  process.env.FRAMERAIL_CSRF_CHECK_ORIGIN = "true"
  vite = await createTestViteServer()
  for (const [name, endpoint] of Object.entries(endpoints)) {
    loaded[name] = (await vite.ssrLoadModule(endpoint.route)).POST
  }
})

after(async () => {
  if (previousSwitch === undefined) delete process.env.FRAMERAIL_CSRF_CHECK_ORIGIN
  else process.env.FRAMERAIL_CSRF_CHECK_ORIGIN = previousSwitch
  if (vite) await vite.close()
})

/** @param {any} value @param {any} run */
const withSwitch = async (value, run) => {
  process.env.FRAMERAIL_CSRF_CHECK_ORIGIN = value
  try {
    return await run()
  } finally {
    process.env.FRAMERAIL_CSRF_CHECK_ORIGIN = "true"
  }
}

/** @param {any} name @param {any} headers */
const postTo = (name, headers = {}) => {
  const endpoint = endpoints[name]
  const request = new Request(`${OWN_ORIGIN}${endpoint.path}`, {
    method: "POST",
    headers: { "content-type": endpoint.contentType, ...siteHeaders, ...headers },
    body: endpoint.body
  })
  return loaded[name]({
    request,
    cookies: { get: () => undefined },
    getClientAddress: () => "192.0.2.10"
  })
}

/** @param {any} response */
const assertAllowed = async (response) => {
  assert.notEqual(response.status, 403)
  assert.notEqual(await response.text(), FORBIDDEN_MESSAGE)
}

for (const name of Object.keys(endpoints)) {
  test(`${name}: same-origin POST is allowed`, async () => {
    await assertAllowed(
      await postTo(name, { origin: OWN_ORIGIN, "sec-fetch-site": "same-origin" })
    )
  })

  test(`${name}: cross-origin Origin is refused with SvelteKit's message`, async () => {
    for (const origin of [
      "https://evil.example",
      "https://scp-jp.wikijump.test",
      "null"
    ]) {
      const response = await postTo(name, { origin })
      assert.equal(response.status, 403, origin)
      assert.equal(await response.text(), FORBIDDEN_MESSAGE, origin)
    }
  })

  test(`${name}: cross-site Sec-Fetch-Site is refused`, async () => {
    const response = await postTo(name, { "sec-fetch-site": "cross-site" })
    assert.equal(response.status, 403)
    assert.equal(await response.text(), FORBIDDEN_MESSAGE)
  })

  test(`${name}: missing Origin with same-origin Sec-Fetch-Site is allowed`, async () => {
    await assertAllowed(await postTo(name, { "sec-fetch-site": "same-origin" }))
  })

  test(`${name}: scripted POST with neither Origin nor Sec-Fetch-Site is allowed`, async () => {
    await assertAllowed(await postTo(name))
  })

  test(`${name}: refusal answers JSON when the client accepts application/json`, async () => {
    const response = await postTo(name, {
      origin: "https://evil.example",
      accept: "application/json"
    })
    assert.equal(response.status, 403)
    assert.equal(response.headers.get("content-type"), "application/json")
    assert.deepEqual(await response.json(), { message: FORBIDDEN_MESSAGE })
  })

  test(`${name}: FRAMERAIL_CSRF_CHECK_ORIGIN=false turns the guard off as for SvelteKit`, async () => {
    await withSwitch("false", async () => {
      await assertAllowed(
        await postTo(name, {
          origin: "https://evil.example",
          "sec-fetch-site": "cross-site"
        })
      )
    })
  })
}
