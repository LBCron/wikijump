import type { Page, Route } from "@playwright/test"

import { expect, test, waitForSvelteDelegatedHandler } from "./hermetic-playwright"

const SITE_HEADERS = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
}
const AUTHENTICATED_HEADERS = {
  ...SITE_HEADERS,
  cookie: "wikijump_token=fixture-session-token",
  origin: `http://localhost:${process.env.PLAYWRIGHT_APP_PORT ?? "4173"}`
}
const DENIAL_TITLE = "Permission error"
const DENIAL_HEADING = "Please note:"
const DENIAL_POLICY =
  "Sorry, you can not edit this page. Only members of this site, owner (creator) of this page, site administrators and perhaps selected moderators are allowed to do it."

const devalue = (value: unknown): string => {
  const flat: unknown[] = []
  const add = (item: unknown): number => {
    const index = flat.length
    flat.push(null)
    if (Array.isArray(item)) {
      flat[index] = item.map(add)
    } else if (item !== null && typeof item === "object") {
      const encoded: Record<string, number> = {}
      for (const [key, child] of Object.entries(item)) encoded[key] = add(child)
      flat[index] = encoded
    } else {
      flat[index] = item
    }
    return index
  }
  add(value)
  return JSON.stringify(flat)
}

const successBody = (value: unknown) =>
  JSON.stringify({ type: "success", status: 200, data: devalue(value) })

const openLockOption = async (
  page: Page,
  canEdit: boolean,
  permissionRequests: Route[],
  lockHistoryRequests: Route[],
  headers: Record<string, string>
) => {
  await page.setExtraHTTPHeaders(headers)
  await page.route(
    (url) => url.search === "?/editPermission",
    async (route) => {
      permissionRequests.push(route)
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: successBody({ res: { can_edit: canEdit } })
      })
    }
  )
  await page.route(
    (url) => url.search === "?/lockHistory",
    async (route) => {
      lockHistoryRequests.push(route)
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: successBody({ res: [] })
      })
    }
  )

  await page.goto("/wikidot-login-probe", { waitUntil: "domcontentloaded" })
  await waitForSvelteDelegatedHandler(page, "#more-options-button")
  await page.locator("#more-options-button").click()
  await waitForSvelteDelegatedHandler(page, "#page-block-button")
}

test.describe("anonymous existing-page Lock option", () => {
  test("Lock answers with the edit-permission dialog and reads no lock history", async ({
    page
  }) => {
    const permissionRequests: Route[] = []
    const lockHistoryRequests: Route[] = []
    await openLockOption(
      page,
      false,
      permissionRequests,
      lockHistoryRequests,
      SITE_HEADERS
    )

    await page.locator("#page-block-button").click()

    await expect(page.locator("#odialog-container .owindow.error")).toBeVisible()
    await expect(page.locator("#owindow-1 .title")).toHaveText(DENIAL_TITLE)
    await expect(page.locator("#modal-title")).toHaveText(DENIAL_HEADING)
    const policy = page.locator(".modal-message-extra")
    await expect(policy).toContainText(DENIAL_POLICY)
    await expect(policy.locator('a[href="#action:login"]')).toHaveText(
      "Sign in as Wikidot user"
    )
    await expect(page.locator("#odialog-container .button-close-message")).toBeVisible()

    await expect(page.locator("#page-lock")).toHaveCount(0)
    await expect(page.locator("#action-area")).toHaveClass(/hidden/u)
    expect(permissionRequests).toHaveLength(1)
    expect(lockHistoryRequests).toHaveLength(0)
  })
})

test.describe("authorized existing-page Lock option", () => {
  test("Lock opens the lock form without a permission dialog", async ({ page }) => {
    const permissionRequests: Route[] = []
    const lockHistoryRequests: Route[] = []
    await openLockOption(
      page,
      true,
      permissionRequests,
      lockHistoryRequests,
      AUTHENTICATED_HEADERS
    )

    await page.locator("#page-block-button").click()

    await expect(page.locator("#page-lock")).toBeVisible()
    await expect(page.locator("#odialog-container")).toHaveCount(0)
    expect(permissionRequests).toHaveLength(1)
    expect(lockHistoryRequests).toHaveLength(1)
  })
})
