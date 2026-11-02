import type { Route } from "@playwright/test"

import { expect, test, waitForSvelteDelegatedHandler } from "./hermetic-playwright"

const SITE_HEADERS = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
}

const REV_X = {
  timeline: 1,
  revision: 101,
  marker: "history-race-revision-x-marker"
}
const REV_Y = {
  timeline: 2,
  revision: 102,
  marker: "history-race-revision-y-marker"
}

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

const historyEntry = (rev: typeof REV_X) => ({
  revision_id: rev.revision * 10,
  history_row_id: `race-row-${rev.timeline}`,
  timeline_number: rev.timeline,
  revision_number: rev.revision,
  page_revision_number: rev.revision,
  history_kind: "page",
  revision_type: "create",
  created_at: "2026-10-01T00:00:00Z",
  user_id: 123,
  comments: `race revision ${rev.timeline}`
})

const revisionBody = (rev: typeof REV_X) => ({
  revision_id: rev.revision * 10,
  revision_number: rev.revision,
  compiled_body_html: `<p>${rev.marker}</p>`
})

const successBody = (value: unknown) =>
  JSON.stringify({ type: "success", status: 200, data: devalue(value) })

test("a superseded revision view cannot replace the selected revision", async ({
  page
}) => {
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  const heldRevisionForX: Route[] = []

  await page.route(
    (url) => url.search === "?/history",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: successBody({
          res: {
            entries: [historyEntry(REV_X), historyEntry(REV_Y)],
            total: 2,
            page: 1,
            perPage: 20,
            totalPages: 1
          }
        })
      })
    }
  )
  await page.route(
    (url) => url.search === "?/revision",
    async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as {
        revisionNumber?: number
      }
      if (body.revisionNumber === REV_X.revision) {
        heldRevisionForX.push(route)
        return
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: successBody({ res: revisionBody(REV_Y) })
      })
    }
  )

  await page.goto("/page-workflow-probe", { waitUntil: "domcontentloaded" })
  await waitForSvelteDelegatedHandler(page, "#history-button")
  await page.locator("#history-button").click()
  const rowFor = (rev: typeof REV_X) =>
    page.locator(`#revision-row-race-row-${rev.timeline}`)
  await expect(rowFor(REV_X)).toBeVisible()
  await expect(rowFor(REV_Y)).toBeVisible()

  const viewLink = (rev: typeof REV_X) =>
    rowFor(rev).getByRole("link", { name: "V", exact: true })
  await viewLink(REV_X).click()
  await expect.poll(() => heldRevisionForX.length).toBe(1)

  await viewLink(REV_Y).click()
  await expect(page.locator("#page-content")).toContainText(REV_Y.marker)

  const staleRevisionResponse = page.waitForResponse(
    (response) =>
      new URL(response.url()).search === "?/revision" &&
      (response.request().postData() ?? "").includes(`"revisionNumber":${REV_X.revision}`)
  )
  await heldRevisionForX[0].fulfill({
    status: 200,
    contentType: "application/json",
    body: successBody({ res: revisionBody(REV_X) })
  })
  await staleRevisionResponse
  await page.waitForTimeout(500)

  await expect(page.locator("#page-content")).toContainText(REV_Y.marker)
  await expect(page.locator("#page-content")).not.toContainText(REV_X.marker)
})
