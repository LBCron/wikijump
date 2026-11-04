import { strict as assert } from "node:assert"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { createJiti } from "jiti"

const libRoot = fileURLToPath(new URL("../src/lib/", import.meta.url))
const jiti = createJiti(import.meta.url, { alias: { $lib: libRoot } })
const { client } = await jiti.import<any>(
  fileURLToPath(new URL("../src/lib/server/deepwell/index.ts", import.meta.url))
)
const { POST } = await jiti.import<any>(
  fileURLToPath(new URL("../src/routes/xml-rpc-api.php/+server.ts", import.meta.url))
)

const basicAuth = `Basic ${Buffer.from("canonical-app:canonical-key").toString("base64")}`

test("pages.save_one returns and follows the canonical slug from page_create", async (t) => {
  const fixture = installCreateFixture(t, { slug: "canonical-created-page" })

  const response = await postSave({
    page: "Raw Create Page",
    saveMode: "create"
  })

  assert.equal(response.status, 200)
  assert.match(
    await response.text(),
    /<name>fullname<\/name><value><string>canonical-created-page<\/string><\/value>/u
  )
  assert.deepEqual(fixture.pageGetReferences, [
    "Raw Create Page",
    "canonical-created-page",
    "canonical-created-page",
    "canonical-created-page"
  ])
  assert.equal(fixture.mutations, 1)
})

for (const [description, output] of [
  ["malformed", null],
  ["missing slug", {}],
  ["non-string slug", { slug: 42 }],
  ["empty slug", { slug: "" }]
]) {
  test(`pages.save_one faults after one create when page_create returns ${description}`, async (t) => {
    const fixture = installCreateFixture(t, output)

    const response = await postSave({
      page: `Raw Create ${description}`,
      saveMode: "create"
    })
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.match(body, /<name>faultCode<\/name><value><int>-32603<\/int><\/value>/u)
    assert.match(body, /Malformed Deepwell response: page_create/u)
    assert.equal(fixture.mutations, 1)
    assert.equal(fixture.calls.at(-1), "page_create")
  })
}

test("pages.save_one returns and follows the canonical slug from page_move", async (t) => {
  const fixture = installMoveFixture(t, { new_slug: "canonical-renamed-page" })

  const response = await postSave({
    page: "Raw Existing Page",
    renameAs: "Raw Rename Destination",
    saveMode: "update"
  })

  assert.equal(response.status, 200)
  assert.match(
    await response.text(),
    /<name>fullname<\/name><value><string>canonical-renamed-page<\/string><\/value>/u
  )
  assert.deepEqual(fixture.pageGetReferences, [
    "Raw Existing Page",
    "Raw Rename Destination",
    "canonical-renamed-page",
    "canonical-renamed-page"
  ])
  assert.deepEqual(fixture.pageMoveParams, {
    new_slug: "Raw Rename Destination",
    page: "existing-page"
  })
  assert.equal(fixture.mutations, 1)
})

test("pages.save_one keeps raw update lookup and canonical rename no-op behavior", async (t) => {
  const fixture = installMoveFixture(t, { new_slug: "unused" })

  const response = await postSave({
    page: "Raw Existing Page",
    renameAs: "existing-page",
    saveMode: "update"
  })

  assert.equal(response.status, 200)
  assert.match(
    await response.text(),
    /<name>fullname<\/name><value><string>existing-page<\/string><\/value>/u
  )
  assert.equal(fixture.pageGetReferences[0], "Raw Existing Page")
  assert.equal(fixture.pageGetReferences.includes("unused"), false)
  assert.equal(fixture.pageMoveParams, null)
  assert.equal(fixture.mutations, 0)
})

for (const [description, output] of [
  ["malformed", null],
  ["missing new_slug", {}],
  ["non-string new_slug", { new_slug: 42 }],
  ["empty new_slug", { new_slug: "" }]
]) {
  test(`pages.save_one faults after one rename when page_move returns ${description}`, async (t) => {
    const fixture = installMoveFixture(t, output)

    const response = await postSave({
      page: "Raw Existing Page",
      renameAs: `Raw Rename ${description}`,
      saveMode: "update"
    })
    const body = await response.text()

    assert.equal(response.status, 200)
    assert.match(body, /<name>faultCode<\/name><value><int>-32603<\/int><\/value>/u)
    assert.match(body, /Malformed Deepwell response: page_move/u)
    assert.equal(fixture.mutations, 1)
    assert.equal(fixture.calls.at(-1), "page_move")
  })
}

const installCreateFixture = (t: any, createOutput: any) => {
  const fixture = installFixture(t)
  const page = fixturePage("canonical-created-page", "Created page")

  client.request = async (method: any, params: any) => {
    fixture.calls.push(method)
    if (method === "site_get") return { site_id: 17 }
    if (method === "page_get") {
      fixture.pageGetReferences.push(params.page)
      return params.page === page.slug ? page : null
    }
    if (method === "login") return { session_token: "canonical-session" }
    if (method === "session_get") return { user_id: 37 }
    if (method === "user_get") {
      return { user_id: 37, name: "Canonical Writer", slug: "canonical-writer" }
    }
    if (method === "page_create") {
      fixture.mutations += 1
      return createOutput
    }
    return readFixtureResponse(method, params, page)
  }

  return fixture
}

const installMoveFixture = (t: any, moveOutput: any) => {
  const fixture = installFixture(t)
  const sourcePage = fixturePage("existing-page", "Existing page")
  const destinationPage = fixturePage("canonical-renamed-page", "Existing page")

  client.request = async (method: any, params: any) => {
    fixture.calls.push(method)
    if (method === "site_get") return { site_id: 17 }
    if (method === "page_get") {
      fixture.pageGetReferences.push(params.page)
      if (params.page === "Raw Existing Page" || params.page === sourcePage.slug) {
        return sourcePage
      }
      if (params.page === destinationPage.slug) return destinationPage
      return null
    }
    if (method === "login") return { session_token: "canonical-session" }
    if (method === "session_get") return { user_id: 37 }
    if (method === "page_edit_permission") return { can_edit: true }
    if (method === "page_lifecycle_identity") {
      return { created_by: "Original Writer", updated_by: "Previous Writer" }
    }
    if (method === "user_get") {
      return { user_id: 37, name: "Canonical Writer", slug: "canonical-writer" }
    }
    if (method === "page_move") {
      fixture.mutations += 1
      fixture.pageMoveParams = { page: params.page, new_slug: params.new_slug }
      return moveOutput
    }
    if (method === "page_view") {
      return { type: "found", data: { page: { slug: params.route.slug } } }
    }
    return readFixtureResponse(method, params, destinationPage)
  }

  return fixture
}

const installFixture = (t: any) => {
  const originalRequest = client.request
  const originalEnvironment = {
    WIKIDOT_API_KEY: process.env.WIKIDOT_API_KEY,
    WIKIDOT_APP_NAME: process.env.WIKIDOT_APP_NAME,
    XML_RPC_WRITE_PASSWORD: process.env.XML_RPC_WRITE_PASSWORD,
    XML_RPC_WRITE_USERNAME: process.env.XML_RPC_WRITE_USERNAME
  }
  process.env.WIKIDOT_APP_NAME = "canonical-app"
  process.env.WIKIDOT_API_KEY = "canonical-key"
  process.env.XML_RPC_WRITE_USERNAME = "canonical-writer"
  process.env.XML_RPC_WRITE_PASSWORD = "canonical-password"
  t.after(() => {
    client.request = originalRequest
    for (const [name, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  return {
    calls: [],
    mutations: 0,
    pageGetReferences: [],
    pageMoveParams: null
  } as any
}

const fixturePage = (slug: any, title: any) => ({
  page_id: 23,
  revision_id: 29,
  page_created_at: "2026-08-13T00:00:00Z",
  page_updated_at: null,
  page_revision_count: 1,
  revision_created_at: "2026-08-13T00:00:00Z",
  revision_user_id: 37,
  title,
  slug,
  tags: [],
  rating: 0,
  wikitext: "Fixture body",
  compiled_body_html: "<p>Fixture body</p>",
  compiled_body_styles: []
})

const readFixtureResponse = (method: any, params: any, page: any) => {
  if (method === "page_view") {
    return { type: "found", data: { page: { slug: params.route.slug } } }
  }
  if (method === "parent_get_direct_metadata") return null
  if (method === "forum_post_page_summary") {
    return { comments: 0, commented_at: null, commented_by: null }
  }
  if (method === "page_select") return []
  throw new Error(`Unexpected Deepwell method ${method} for ${page.slug}`)
}

const postSave = ({ page, renameAs, saveMode }: any) => {
  const renameMember =
    renameAs === undefined
      ? ""
      : `<member><name>rename_as</name><value><string>${renameAs}</string></value></member>`
  const body = `<?xml version="1.0"?>
<methodCall>
  <methodName>pages.save_one</methodName>
  <params><param><value><struct>
    <member><name>site</name><value><string>canonical-site</string></value></member>
    <member><name>page</name><value><string>${page}</string></value></member>
    <member><name>save_mode</name><value><string>${saveMode}</string></value></member>
    ${renameMember}
  </struct></value></param></params>
</methodCall>`

  return POST({
    getClientAddress: () => "192.0.2.91",
    request: new Request("http://127.0.0.1/xml-rpc-api.php", {
      body,
      headers: { authorization: basicAuth, "content-type": "text/xml" },
      method: "POST"
    })
  })
}
