import { expect, test, waitForSvelteDelegatedHandler } from "./hermetic-playwright"

const FIXTURE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_FIXTURE_PORT ?? "42747"}`
const SITE_HEADERS = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
}

test.afterEach(async ({ request }) => {
  await request.post(`${FIXTURE_URL}/reset-authenticated-profile`)
})

test("ordered display languages persist Japanese-first above English", async ({
  page,
  request
}) => {
  await request.post(`${FIXTURE_URL}/reset-authenticated-profile`)
  await page.setExtraHTTPHeaders(SITE_HEADERS)

  await page.goto("/-/login")
  await page.locator("#login-name-or-email").fill("fixture-member")
  await page.locator("#login-password").fill("fixture-member-password")
  const loginResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/-/login" &&
      response.request().method() === "POST"
  )
  await page.locator("#login button[type='submit']").click()
  await loginResponse
  await expect
    .poll(async () =>
      (await page.context().cookies()).some((cookie) => cookie.name === "wikijump_token")
    )
    .toBe(true)

  await page.goto("/-/settings")
  await waitForSvelteDelegatedHandler(page, "#user-display-locales button")
  const preferenceLabels = page.locator("#user-display-locales li span")
  await expect(preferenceLabels).toHaveText(["Primary: English"])

  await page.locator("#user-display-locale-add").selectOption("ja")
  await page.locator(".locale-add-row button").click()
  await expect(preferenceLabels).toHaveText(["Primary: English", "Fallback 1: 日本語"])

  await page.getByRole("button", { name: "Move 日本語 up" }).focus()
  await page.keyboard.press("Enter")
  await expect(preferenceLabels).toHaveText(["Primary: 日本語", "Fallback 1: English"])

  const saveResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/-/settings" &&
      response.request().method() === "POST"
  )
  await page.locator(".user-settings-actions .button-save").click()
  await saveResponse

  await page.reload()
  await waitForSvelteDelegatedHandler(page, "#user-display-locales button")
  await expect(page.locator("#user-display-locales li span")).toHaveText([
    "Primary: 日本語",
    "Fallback 1: English"
  ])

  await page.getByRole("button", { name: "Move English up" }).click()
  await expect(page.locator("#user-display-locales li span")).toHaveText([
    "Primary: English",
    "Fallback 1: 日本語"
  ])
  const secondSaveResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/-/settings" &&
      response.request().method() === "POST"
  )
  await page.locator(".user-settings-actions .button-save").click()
  await secondSaveResponse
  await page.reload()
  await waitForSvelteDelegatedHandler(page, "#user-display-locales button")
  await expect(page.locator("#user-display-locales li span")).toHaveText([
    "Primary: English",
    "Fallback 1: 日本語"
  ])
})
