import { expect, test } from "./hermetic-playwright"

const SITE_HEADERS = {
  "X-Wikijump-Site-Id": "6000006",
  "X-Wikijump-Site-Slug": "www"
}
const APP_URL = `http://localhost:${process.env.PLAYWRIGHT_APP_PORT ?? "4173"}`
const FIXTURE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_FIXTURE_PORT ?? "42747"}`
const NEW_SITE_SLUG = "newsite-journey"

async function siteCreateRequests(request: import("@playwright/test").APIRequestContext) {
  const response = await request.get(`${FIXTURE_URL}/last-site-create-requests`)
  expect(response.ok()).toBeTruthy()
  return response.json()
}

async function submitNewSiteForm(
  page: import("@playwright/test").Page,
  fields: Record<string, string> | null
) {
  // Submits the rendered form's live state the way use:enhance would: the
  // dev rig serves HTTP while the deployment CSP carries
  // upgrade-insecure-requests, so a native navigation POST is upgraded to
  // HTTPS and blocked by form-action 'self' — a dev-only artifact, since
  // production serves HTTPS throughout. fetch is governed by connect-src
  // 'self' instead, and SvelteKit serializes the action outcome (including
  // redirects) as JSON for fetch callers.
  return page.evaluate(async (submitted) => {
    const form = document.querySelector("#new-site-form")
    if (!(form instanceof HTMLFormElement)) throw new Error("missing new-site form")
    const data: Record<string, string> = {}
    new FormData(form).forEach((value, key) => {
      if (typeof value === "string") data[key] = value
    })
    const body = submitted ?? data
    const response = await fetch("/new-site?/newSite", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body)
    })
    return response.json()
  }, fields)
}

const validFields = () => ({
  name: "Journey Wiki",
  subtitle: "Created by the journey spec",
  unixname: NEW_SITE_SLUG,
  language: "en",
  template: "default",
  privacy: "open",
  tos: "1"
})

test("the www new-site page renders the creation form", async ({ page }) => {
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.context().addCookies([
    {
      name: "wikijump_token",
      value: "fixture-authenticated-session-token",
      url: APP_URL
    }
  ])

  const response = await page.goto(`${APP_URL}/new-site`)
  expect(response?.status()).toBe(200)
  await expect(page.locator("#new-site-form")).toBeVisible()
  for (const name of [
    "name",
    "subtitle",
    "unixname",
    "language",
    "template",
    "privacy",
    "tos"
  ]) {
    await expect(page.locator(`#new-site-form [name="${name}"]`)).toHaveCount(1)
  }
})

test("an authenticated submission creates the site and redirects to its origin", async ({
  page,
  request
}) => {
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.context().addCookies([
    {
      name: "wikijump_token",
      value: "fixture-authenticated-session-token",
      url: APP_URL
    }
  ])
  await page.goto(`${APP_URL}/new-site`)

  await page.locator('#new-site-form input[name="name"]').fill("Journey Wiki")
  await page
    .locator('#new-site-form input[name="subtitle"]')
    .fill("Created by the journey spec")
  await page.locator('#new-site-form input[name="unixname"]').fill(NEW_SITE_SLUG)
  await page.locator('#new-site-form input[name="tos"]').check()

  const result = await submitNewSiteForm(page, null)
  expect(result.type).toBe("redirect")
  expect(result.status).toBe(303)
  expect(result.location).toBe(`https://${NEW_SITE_SLUG}.localhost/`)

  expect(await siteCreateRequests(request)).toEqual([
    {
      slug: NEW_SITE_SLUG,
      name: "Journey Wiki",
      tagline: "Created by the journey spec",
      description: "",
      default_page: null,
      layout: null,
      license: "cc0",
      locale: "en",
      ip_address: "127.0.0.1"
    }
  ])
})

test("an anonymous submission is denied without creating anything", async ({
  page,
  request
}) => {
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.goto(`${APP_URL}/new-site`)

  const result = await submitNewSiteForm(page, validFields())
  expect(result.type).toBe("failure")
  expect(result.status).toBe(401)
  expect(await siteCreateRequests(request)).toEqual([])
})

test("a submission without ToS acceptance is rejected without creating anything", async ({
  page,
  request
}) => {
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.context().addCookies([
    {
      name: "wikijump_token",
      value: "fixture-authenticated-session-token",
      url: APP_URL
    }
  ])
  await page.goto(`${APP_URL}/new-site`)

  const fields = Object.fromEntries(
    Object.entries(validFields()).filter(([key]) => key !== "tos")
  )
  const result = await submitNewSiteForm(page, fields)
  expect(result.type).toBe("failure")
  expect(result.status).toBe(400)
  expect(await siteCreateRequests(request)).toEqual([])
})
