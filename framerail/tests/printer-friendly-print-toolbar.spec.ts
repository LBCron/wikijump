import { expect, test } from "./hermetic-playwright"
import type { Page } from "@playwright/test"

const headers = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
}

const printerFriendlyPath = "/printer--friendly//scp-173"

async function expectVisible(page: Page, selector: string, visible: boolean) {
  await expect
    .poll(() =>
      page.locator(selector).evaluate((element) => {
        const style = getComputedStyle(element)
        const rect = element.getBoundingClientRect()
        return style.display !== "none" && rect.height > 0
      })
    )
    .toBe(visible)
}

test("printer-friendly controls stay on screen and leave print output", async ({
  page
}) => {
  await page.setExtraHTTPHeaders(headers)
  await page.goto(printerFriendlyPath, { waitUntil: "domcontentloaded" })
  await expect(page.locator("#print-options")).toBeAttached()

  await page.emulateMedia({ media: "screen" })
  await expectVisible(page, "#print-options", true)
  await expect(page.getByRole("link", { name: "PRINT THE PAGE" })).toBeVisible()

  await page.emulateMedia({ media: "print" })
  await expectVisible(page, "#print-options", false)
  await expectVisible(page, "#container > hr", false)
  await expect(page.getByRole("link", { name: "PRINT THE PAGE" })).toBeHidden()
  await expect(page.getByRole("link", { name: "Close this window" })).toBeHidden()
  await expectVisible(page, "#print-source-info", true)
  await expect(page.locator("h1")).toBeVisible()
  await expectVisible(page, "#print-content", true)

  await page.emulateMedia({ media: "screen" })
  await expectVisible(page, "#print-options", true)
  await expect(page.getByRole("link", { name: "PRINT THE PAGE" })).toBeVisible()
})

test("font size chosen before printing keeps article formatting without controls", async ({
  page,
  browserName
}) => {
  // WebKit upgrades this http://localhost page's subresources to https
  // (Kit CSP upgrade-insecure-requests, no TLS in the dev server), so the
  // font-size handler is never attached there. Skip rather than set the
  // handler's style directly, which would pass without exercising it.
  test.skip(
    browserName === "webkit",
    "WebKit local http hydration does not attach the font-size handler; run on an https candidate"
  )
  await page.setExtraHTTPHeaders(headers)
  await page.goto(printerFriendlyPath, { waitUntil: "domcontentloaded" })
  const twelvePoint = page.getByRole("link", { name: "12pt", exact: true })
  await expect(async () => {
    await twelvePoint.click()
    await expect(page.locator("#print-content")).toHaveAttribute(
      "style",
      /font-size: 12pt/u
    )
  }).toPass()

  await page.emulateMedia({ media: "print" })
  await expectVisible(page, "#print-options", false)
  await expect(page.locator("#print-content")).toHaveAttribute("style", /font-size: 12pt/)
  await expect(page.locator("h1")).toBeVisible()
})
