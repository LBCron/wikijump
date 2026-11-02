import { expect, test, waitForSvelteDelegatedHandler } from "./hermetic-playwright"
import type { Page, Route } from "@playwright/test"

const SITE_HEADERS = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
}

const openWatchersPane = async (page: Page) => {
  await page.goto("/page-workflow-probe", { waitUntil: "domcontentloaded" })
  await waitForSvelteDelegatedHandler(page, "#more-options-button")
  await page.locator("#more-options-button").click()
  await waitForSvelteDelegatedHandler(page, "#watchers-button")
  await page.locator("#watchers-button").click()
}

test("anonymous Watchers opens the pane with the watcher roster", async ({ page }) => {
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  const watchRequests: Route[] = []
  const actionStatuses: number[] = []
  await page.route(
    (url) => url.search === "?/watchers",
    async (route) => {
      watchRequests.push(route)
      const response = await route.fetch()
      actionStatuses.push(response.status())
      await route.fulfill({ response })
    }
  )

  await openWatchersPane(page)

  const roster = page.locator(".page-watchers-list")
  await expect(roster).toBeVisible()
  await expect(roster.getByRole("link", { name: "Watcher Fixture" })).toHaveAttribute(
    "href",
    "/-/user/watcher-fixture"
  )
  await expect(roster.getByRole("link", { name: "Second Watcher" })).toHaveAttribute(
    "href",
    "/-/user/second-watcher"
  )

  expect(actionStatuses, "the route action must accept the lazy read").toEqual([200])
  expect(watchRequests, "opening the pane must start exactly one lazy read").toHaveLength(
    1
  )
  await expect(page.locator("#odialog-container")).toHaveCount(0)
  await expect(page.locator("#action-area")).not.toHaveClass(/hidden/u)
})
