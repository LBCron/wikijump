import { expect, test, waitForSvelteDelegatedHandler } from "./hermetic-playwright"
import {
  filterHistoryByTypes,
  paginateHistoryEntries
} from "../src/lib/wikidot-history-contract.ts"

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

const successBody = (value: unknown) =>
  JSON.stringify({ type: "success", status: 200, data: devalue(value) })

const pageEntry = (timeline: number) => ({
  revision_id: 1000 + timeline,
  history_row_id: `filter-row-${timeline}`,
  timeline_number: timeline,
  revision_number: timeline,
  page_revision_number: timeline,
  history_kind: "page",
  revision_type: "regular",
  changes: ["wikitext"],
  created_at: "2026-10-01T00:00:00Z",
  user_id: 123,
  author: null,
  comments: `revision ${timeline}`
})

const fileEntry = (timeline: number) => ({
  revision_id: 2000 + timeline,
  history_row_id: `filter-file-row-${timeline}`,
  timeline_number: timeline,
  revision_number: 0,
  page_revision_number: null,
  history_kind: "file",
  revision_type: "regular",
  changes: ["files"],
  created_at: "2026-10-01T00:00:00Z",
  user_id: 123,
  author: null,
  comments: `file event ${timeline}`
})

const ALL = [
  ...Array.from({ length: 21 }, (_, index) => pageEntry(24 - index)),
  ...[3, 2, 1, 0].map((timeline) => fileEntry(timeline))
]

const openHistory = async (page: import("@playwright/test").Page, posts: string[]) => {
  await page.setExtraHTTPHeaders(SITE_HEADERS)
  await page.route(
    (url) => url.search === "?/history",
    async (route) => {
      const body = route.request().postDataJSON() as {
        types?: string[]
        page?: number
        perPage?: number
      }
      posts.push(
        JSON.stringify({ types: body.types, page: body.page, perPage: body.perPage })
      )
      const filtered = filterHistoryByTypes(ALL, body.types ?? [])
      const paged = paginateHistoryEntries(filtered, body.page ?? 1, body.perPage ?? 20)
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: successBody({
          res: {
            entries: filtered,
            total: paged.total,
            page: paged.page,
            perPage: paged.perPage,
            totalPages: paged.totalPages
          }
        })
      })
    }
  )
  await page.goto("/page-workflow-probe", { waitUntil: "domcontentloaded" })
  await waitForSvelteDelegatedHandler(page, "#history-button")
  await page.locator("#history-button").click()
  await expect(page.locator("tr[id^='revision-row-']").first()).toBeVisible()
}

test("history filter controls and pager match the Wikidot surface", async ({ page }) => {
  const posts: string[] = []
  await openHistory(page, posts)

  await expect(page.locator("#history-form-1")).toBeVisible()
  for (const id of [
    "rev-type-all",
    "rev-type-source",
    "rev-type-title",
    "rev-type-move",
    "rev-type-tags",
    "rev-type-meta",
    "rev-type-files"
  ]) {
    await expect(page.locator(`#${id}`)).toHaveCount(1)
  }
  await expect(page.locator("#h-perpage")).toHaveValue("20")
  await expect(page.locator("#history-compare-button")).toBeVisible()

  const pager = page.locator("#revision-list .pager")
  await expect(pager.locator(".pager-no")).toHaveText("page 1 of 2")
  await expect(pager.locator(".current")).toHaveText("1")
  await expect(page.locator("tr[id^='revision-row-']").first()).toContainText("25.")
})

test("source filter narrows rows and update restarts at page one", async ({ page }) => {
  const posts: string[] = []
  await openHistory(page, posts)

  await page.locator("#rev-type-all").click()
  await page.locator("#rev-type-source").click()
  await page.locator('input[value="Update list"]').click()
  await expect(page.locator("tr[id^='revision-row-']")).toHaveCount(20)

  const update = JSON.parse(posts[posts.length - 1]) as { types: string[]; page: number }
  expect(update.types).toEqual(["source"])
  expect(update.page).toBe(1)
  await expect(page.locator("#revision-list .pager-no")).toHaveText("page 1 of 2")
})

test("files filter drops the pager when one page suffices", async ({ page }) => {
  const posts: string[] = []
  await openHistory(page, posts)

  await page.locator("#rev-type-all").click()
  await page.locator("#rev-type-files").click()
  await page.locator('input[value="Update list"]').click()
  await expect(page.locator("tr[id^='revision-row-']")).toHaveCount(4)
  await expect(page.locator("#revision-list .pager")).toHaveCount(0)
})

test("pager navigation keeps global numbering and resets comparison", async ({
  page
}) => {
  const posts: string[] = []
  await openHistory(page, posts)

  await page.locator('#revision-list .pager .target a:has-text("2")').click()
  await expect(page.locator("#revision-list .pager-no")).toHaveText("page 2 of 2")
  await expect(page.locator("tr[id^='revision-row-']").first()).toContainText("5.")

  const nav = JSON.parse(posts[posts.length - 1]) as { types: string[]; page: number }
  expect(nav.types).toEqual(["all"])
  expect(nav.page).toBe(2)

  const compare = page.locator("section.revision-diff-panel").getByRole("button", {
    name: /compare/i
  })
  await expect(compare).toBeDisabled()
  await expect(page.locator(".revision-diff-unavailable")).toBeVisible()
})
