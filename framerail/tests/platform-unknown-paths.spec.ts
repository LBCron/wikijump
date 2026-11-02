import { expect, test } from "./hermetic-playwright"

const SITE_HEADERS = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
}
const APP_URL = `http://localhost:${process.env.PLAYWRIGHT_APP_PORT ?? "4173"}`

test("unknown /-/ platform paths answer 404 and stay on the requested URL", async ({
  page,
  request
}) => {
  for (const path of ["/-/nonexistent-xyz", "/-/pages", "/-/users", "/-/search"]) {
    const response = await request.get(`${APP_URL}${path}`, {
      headers: SITE_HEADERS,
      maxRedirects: 0
    })
    expect(response.status(), path).toBe(404)
  }

  await page.setExtraHTTPHeaders(SITE_HEADERS)
  const navigation = await page.goto(`${APP_URL}/-/pages`)
  expect(navigation?.status()).toBe(404)
  await expect(page).toHaveURL(`${APP_URL}/-/pages`)
})

test("the bare /-/ prefix redirects home with an HTTP 302", async ({ request }) => {
  const normalized = await request.get(`${APP_URL}/-/`, {
    headers: SITE_HEADERS,
    maxRedirects: 0
  })
  expect(normalized.status()).toBe(308)
  expect(normalized.headers()["location"]).toBe("/-")

  const response = await request.get(`${APP_URL}/-`, {
    headers: SITE_HEADERS,
    maxRedirects: 0
  })
  expect(response.status()).toBe(302)
  expect(response.headers()["location"]).toBe("/")
})
