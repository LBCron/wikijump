import { expect, test } from "./hermetic-playwright"
import type { Page } from "@playwright/test"

const SITE_HEADERS = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
}
const APP_URL = `http://localhost:${process.env.PLAYWRIGHT_APP_PORT ?? "4173"}`
const UNSAFE_WEBSITE = ["javascript", "alert(1)"].join(":")
const NORMALIZED_DESTINATION = "https://example.org/"

const collectConsoleErrors = (page: Page) => {
  const consoleErrors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text())
  })
  page.on("pageerror", (error) => consoleErrors.push(error.message))
  return consoleErrors
}

const cspViolations = (messages: string[]) =>
  messages.filter(
    (message) =>
      message.includes("Content Security Policy") ||
      message.includes("inline event handler") ||
      message.includes("Running the JavaScript URL")
  )

test("a schemeless website renders as a normalized focusable anchor", async ({
  page
}) => {
  const consoleErrors = collectConsoleErrors(page)
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.goto(`${APP_URL}/-/user/website-probe`)

  const website = page.locator(".user-attribute.website")
  await expect(website).toBeVisible()
  const link = website.locator("a.website-link")
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute("href", NORMALIZED_DESTINATION)
  await expect(link).toHaveText("example.org")

  await link.focus()
  await expect(link).toBeFocused()
  await expect(page.getByRole("link", { name: "example.org" })).toBeVisible()

  expect(cspViolations(consoleErrors)).toEqual([])
})

test("the frozen Wikidot website value normalizes to its frozen destination", async ({
  page
}) => {
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.goto(`${APP_URL}/-/user/website-frozen-probe`)
  const link = page.locator(".user-attribute.website a.website-link")
  await expect(link).toBeVisible()
  await expect(link).toHaveAttribute("href", "https://scp-wiki.wikidot.com/seekgull")
  await expect(link).toHaveText("scp-wiki.wikidot.com/seekgull")
})

test("activating the website link attempts only the normalized destination", async ({
  page,
  context
}) => {
  const consoleErrors = collectConsoleErrors(page)
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  const attemptedNavigations: string[] = []
  const blocked: string[] = []
  await page.route(NORMALIZED_DESTINATION, async (route) => {
    attemptedNavigations.push(route.request().url())
    await route.abort("blockedbyclient")
  })
  await context.route(NORMALIZED_DESTINATION, async (route) => {
    attemptedNavigations.push(route.request().url())
    await route.abort("blockedbyclient")
  })
  page.on("requestfailed", (request) => {
    if (request.url() === NORMALIZED_DESTINATION) {
      blocked.push(request.failure()?.errorText ?? "")
    }
  })
  const posts: string[] = []
  page.on("request", (request) => {
    if (request.method() === "POST") posts.push(request.url())
  })

  await page.goto(`${APP_URL}/-/user/website-probe`)
  const link = page.locator(".user-attribute.website a.website-link")
  await expect(link).toBeVisible()

  await link.click()
  await expect.poll(() => blocked).toEqual(["net::ERR_BLOCKED_BY_CLIENT"])
  expect(attemptedNavigations).toEqual([NORMALIZED_DESTINATION])
  expect(posts).toEqual([])

  await page.goto(`${APP_URL}/-/user/website-probe`)
  await link.focus()
  await page.keyboard.press("Enter")
  await expect
    .poll(() => blocked)
    .toEqual(["net::ERR_BLOCKED_BY_CLIENT", "net::ERR_BLOCKED_BY_CLIENT"])
  expect(attemptedNavigations).toEqual([NORMALIZED_DESTINATION, NORMALIZED_DESTINATION])
  expect(posts).toEqual([])

  await page.goto(`${APP_URL}/-/user/website-probe`)
  await expect(link).toBeVisible()
  const navigationsBeforePopup = attemptedNavigations.length
  const [popup] = await Promise.all([
    context.waitForEvent("page"),
    link.click({ modifiers: ["ControlOrMeta"] })
  ])
  await expect.poll(() => attemptedNavigations.length).toBe(navigationsBeforePopup + 1)
  expect(attemptedNavigations.at(-1)).toBe(NORMALIZED_DESTINATION)
  expect(posts).toEqual([])
  await popup.close()

  expect(cspViolations(consoleErrors)).toEqual([])
})

test("an unsafe website scheme stays inert text without a link or script", async ({
  page
}) => {
  const consoleErrors = collectConsoleErrors(page)
  const dialogs: string[] = []
  page.on("dialog", (dialog) => {
    dialogs.push(dialog.message())
    void dialog.dismiss()
  })
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.goto(`${APP_URL}/-/user/website-unsafe-probe`)

  const website = page.locator(".user-attribute.website")
  await expect(website).toBeVisible()
  await expect(website.locator("a")).toHaveCount(0)
  await expect(website.locator(".user-attribute-value")).toHaveText(UNSAFE_WEBSITE)

  await website.locator(".user-attribute-value").click()
  await expect(page).toHaveURL(/\/-\/user\/website-unsafe-probe$/u)
  expect(dialogs).toEqual([])
  expect(cspViolations(consoleErrors)).toEqual([])
})

test("a blank website renders no link and no empty anchor", async ({ page }) => {
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.goto(`${APP_URL}/-/user/guest`)
  await expect(page.locator("h1.user-attribute.name")).toHaveText("Guest")
  await expect(page.locator(".user-attribute.website")).toHaveCount(0)
  await expect(page.locator("a.website-link")).toHaveCount(0)
})
