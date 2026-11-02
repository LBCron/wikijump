import { expect, test, waitForSvelteDelegatedHandler } from "./hermetic-playwright"

const FIXTURE_URL = `http://127.0.0.1:${process.env.PLAYWRIGHT_FIXTURE_PORT ?? "42747"}`
const SITE_HEADERS = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
}
const CURRENT = "fixture-member-password"
const NEW_PASSWORD = "a-new-fixture-password-2026"

test.afterEach(async ({ request }) => {
  await request.post(`${FIXTURE_URL}/reset-authenticated-profile`)
})

test("account settings change the password with the current one", async ({ page }) => {
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.goto("/-/login")
  await page.locator("#login-name-or-email").fill("fixture-member")
  await page.locator("#login-password").fill(CURRENT)
  await page.locator("#login button[type='submit']").click()
  await expect
    .poll(async () =>
      (await page.context().cookies()).some((cookie) => cookie.name === "wikijump_token")
    )
    .toBe(true)

  await page.goto("/-/settings")
  await waitForSvelteDelegatedHandler(page, "#user-display-locales button")
  const form = page.locator("#user-password-form")
  await expect(page.getByLabel("Current password")).toHaveAttribute(
    "autocomplete",
    "current-password"
  )

  const submit = async () => {
    const response = page.waitForResponse(
      (candidate) =>
        new URL(candidate.url()).pathname === "/-/settings" &&
        candidate.request().method() === "POST"
    )
    await form.getByRole("button", { name: "Change password" }).click()
    const body = await (await response).text()
    for (const secret of [CURRENT, NEW_PASSWORD]) expect(body).not.toContain(secret)
  }

  await page.getByLabel("Current password").fill(CURRENT)
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD)
  await page.getByLabel("Confirm new password").fill(`${NEW_PASSWORD}-x`)
  await submit()
  await expect(page.getByLabel("Confirm new password")).toHaveAttribute(
    "aria-invalid",
    "true"
  )
  await expect(form).toContainText("The new passwords do not match.")

  await page.getByLabel("Current password").fill("not-the-current-password")
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD)
  await page.getByLabel("Confirm new password").fill(NEW_PASSWORD)
  await submit()
  await expect(page.locator("#modal-message")).toHaveText(
    "Invalid username, password, or TOTP code"
  )
  await page.keyboard.press("Escape")

  await page.getByLabel("Current password").fill(CURRENT)
  await page.getByLabel("New password", { exact: true }).fill(NEW_PASSWORD)
  await page.getByLabel("Confirm new password").fill(NEW_PASSWORD)
  await submit()
  await expect(form.getByRole("status")).toHaveText(
    "Password changed. 2 other sessions were signed out."
  )
  await expect(page.getByLabel("Current password")).toHaveValue("")
})
