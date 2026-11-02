import { expect, test, waitForSvelteDelegatedHandler } from "./hermetic-playwright"

const SITE_HEADERS = {
  "X-Wikijump-Site-Id": "6000005",
  "X-Wikijump-Site-Slug": "scp-wiki"
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

const pageEntry = (timeline: number, revision: number) => ({
  revision_id: revision * 10,
  history_row_id: `compare-row-${timeline}`,
  timeline_number: timeline,
  revision_number: revision,
  page_revision_number: revision,
  history_kind: "page",
  revision_type: "create",
  created_at: "2026-10-01T00:00:00Z",
  user_id: 123,
  comments: `compare revision ${timeline}`
})

const fileEntry = (timeline: number) => ({
  revision_id: timeline * 10,
  history_row_id: `compare-file-row-${timeline}`,
  timeline_number: timeline,
  revision_number: 0,
  page_revision_number: null,
  history_kind: "file",
  revision_type: "create",
  created_at: "2026-10-01T00:00:00Z",
  user_id: 123,
  name: `compare-file-${timeline}.txt`,
  comments: `compare file event ${timeline}`
})

const successBody = (value: unknown) =>
  JSON.stringify({ type: "success", status: 200, data: devalue(value) })

const openHistory = async (page: import("@playwright/test").Page, entries: unknown[]) => {
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.route(
    (url) => url.search === "?/history",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: successBody({
          res: {
            entries,
            total: entries.length,
            page: 1,
            perPage: 20,
            totalPages: 1
          }
        })
      })
    }
  )
  await page.goto("/page-workflow-probe", { waitUntil: "domcontentloaded" })
  await waitForSvelteDelegatedHandler(page, "#history-button")
  await page.locator("#history-button").click()
  await expect(
    page.locator(".revision-row, tr[id^='revision-row-']").first()
  ).toBeVisible()
}

test("compare stays disabled when only one revision can be compared", async ({
  page
}) => {
  const diffPosts: string[] = []
  page.on("request", (request) => {
    if (new URL(request.url()).search === "?/revisionDiff") {
      diffPosts.push(request.postData() ?? "")
    }
  })
  await openHistory(page, [pageEntry(2, 7), fileEntry(5), fileEntry(9)])

  const compare = page
    .locator("section.revision-diff-panel")
    .getByRole("button", { name: /compare/i })
  await expect(compare).toBeDisabled()
  await expect(page.locator(".revision-diff-unavailable")).toBeVisible()
  expect(diffPosts).toEqual([])
})

test("compare submits two distinct revisions when both exist", async ({ page }) => {
  const diffPosts: string[] = []
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).search === "?/revisionDiff"
    ) {
      diffPosts.push(request.postData() ?? "")
    }
  })
  await page.route(
    (url) => url.search === "?/revisionDiff",
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: successBody({ res: { lines: [] } })
      })
    }
  )
  await openHistory(page, [pageEntry(2, 7), pageEntry(4, 9), fileEntry(6)])

  const compare = page
    .locator("section.revision-diff-panel")
    .getByRole("button", { name: /compare/i })
  await expect(compare).toBeEnabled()
  await compare.click()
  await expect.poll(() => diffPosts.length, { timeout: 10000 }).toBe(1)
  const payload = JSON.parse(diffPosts[0]) as Record<string, unknown>
  expect(payload.fromRevisionNumber).not.toBe(payload.toRevisionNumber)
})
